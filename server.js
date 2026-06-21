const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const config = require('./project.config');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const USER_HEADER = 'x-current-user-id';
const SYSTEM_IMPORT_LABEL = '系统导入';

function getUserById(userId) {
  return config.users?.find((u) => u.id === userId) || null;
}

function extractCurrentUser(req) {
  const userId = req.headers[USER_HEADER] || req.body?.currentUserId;
  if (!userId) return null;
  return getUserById(userId);
}

function requireUser(req, res, next) {
  const user = extractCurrentUser(req);
  if (!user) return res.status(401).json({ error: '未登录或用户不存在，请先选择当前用户' });
  req.currentUser = user;
  next();
}

function hasPermission(user, permType, key) {
  if (!user || !config.permissions) return false;
  const allowed = config.permissions[permType]?.[key];
  if (!allowed) return true;
  return allowed.includes(user.role);
}

function checkPermission(user, permType, key, res) {
  if (!hasPermission(user, permType, key)) {
    const roleLabel = config.roles?.[user?.role]?.label || user?.role || '未知角色';
    const permLabel = {
      create: '创建',
      update: '编辑',
      delete: '删除',
      action: '操作',
      special: '执行'
    }[permType] || permType;
    res.status(403).json({ error: `权限不足：${roleLabel}无权${permLabel}该内容` });
    return false;
  }
  return true;
}

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

function stamp(action, note, operator) {
  const opLabel = operator ? `${operator.name}（${operator.roleLabel}）` : SYSTEM_IMPORT_LABEL;
  return {
    at: new Date().toISOString(),
    action,
    note: note || '',
    operator: operator ? { id: operator.id, name: operator.name, role: operator.role, roleLabel: operator.roleLabel } : null,
    operatorLabel: opLabel
  };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

const AUDIT_COLLECTION = 'auditLogs';

function computeChanges(before, after, fields) {
  const changes = {};
  const keys = fields || [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
  for (const key of keys) {
    const bVal = before?.[key];
    const aVal = after?.[key];
    if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
      changes[key] = { before: bVal, after: aVal };
    }
  }
  return Object.keys(changes).length ? changes : undefined;
}

function getTargetLabel(item, collection) {
  const labelMap = {
    batches: ['name', 'batchNo'],
    requests: ['showName', 'venue'],
    wastes: ['code', 'title'],
    stocktakes: ['code', 'title'],
    suppliers: ['name'],
    cabinets: ['code', 'area'],
    projects: ['name', 'venue']
  };
  const fields = labelMap[collection] || ['id'];
  return fields.map((f) => item?.[f]).filter(Boolean).join(' / ') || item?.id || '';
}

function operatorDisplayName(operator) {
  if (!operator) return SYSTEM_IMPORT_LABEL;
  if (typeof operator === 'string') return operator || SYSTEM_IMPORT_LABEL;
  if (operator.name && operator.roleLabel) return `${operator.name}（${operator.roleLabel}）`;
  return operator.name || operator.id || SYSTEM_IMPORT_LABEL;
}

function writeAuditLog(db, options) {
  const { actionType, collection, targetId, targetItem, beforeItem, changes, note, operator } = options;
  if (!db[AUDIT_COLLECTION]) db[AUDIT_COLLECTION] = [];
  const item = targetItem || beforeItem;
  const opLabel = operatorDisplayName(operator);
  const log = {
    id: `${AUDIT_COLLECTION}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    actionType,
    targetCollection: collection,
    targetId,
    targetLabel: getTargetLabel(item, collection),
    changes: changes || computeChanges(beforeItem, targetItem),
    note: note || '',
    operator: opLabel,
    operatorInfo: operator && typeof operator === 'object' && operator.id ? operator : null,
    createdAt: new Date().toISOString()
  };
  db[AUDIT_COLLECTION].unshift(log);
  return log;
}

function collectionLabel(collection) {
  return config.collections?.[collection]?.label || collection;
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res) => {
  const db = await readDb();
  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key].sort(sortNewest);
  }
  res.json(db);
});

app.post('/api/:collection', requireUser, async (req, res, next) => {
  const { collection } = req.params;
  if (collection === 'schedules') return next();
  const db = await readDb();
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });

  if (!checkPermission(req.currentUser, 'create', collection, res)) return;

  const now = new Date().toISOString();
  const operator = req.currentUser;
  let item;

  if (collection === 'wastes') {
    const batch = db.batches.find((b) => b.id === req.body.batchId);
    if (!batch) return res.status(409).json({ error: '批次不存在' });
    if (batch.status === '已报废') return res.status(409).json({ error: '该批次已报废，无法创建报废单' });
    const wasteQty = Number(req.body.quantity || 0);
    const stockQty = Number(batch.quantity || 0);
    const reservedQty = Number(batch.reservedQuantity || 0);
    const availableQty = Math.max(0, stockQty - reservedQty);
    const stocktakeId = req.body.stocktakeId || null;

    if (wasteQty <= 0) return res.status(409).json({ error: '报废数量必须大于0' });

    let maxAllowedQty = availableQty;
    let isStocktakeInitiated = false;
    let stocktakeDeficitQty = 0;
    let stocktakeDiffItem = null;

    if (stocktakeId) {
      const stocktake = db.stocktakes?.find((s) => s.id === stocktakeId);
      if (!stocktake) return res.status(404).json({ error: '关联盘点单不存在' });
      if (stocktake.status !== '已确认') return res.status(409).json({ error: '只有已确认的盘点单可以发起报废' });

      stocktakeDiffItem = (stocktake.diffSuggestions || []).find((d) => d.batchId === req.body.batchId);
      if (!stocktakeDiffItem) return res.status(409).json({ error: '该批次在盘点单中不存在差异项' });
      if (stocktakeDiffItem.diffType !== 'deficit') return res.status(409).json({ error: '只有盘亏项可以发起报废' });
      if (stocktakeDiffItem.actionStatus === 'registered' && stocktakeDiffItem.wasteId) {
        const existingWaste = (db.wastes || []).find((w) => w.id === stocktakeDiffItem.wasteId && w.status !== '已驳回' && w.status !== '已撤销');
        if (existingWaste) {
          return res.status(409).json({ error: `该盘亏项已创建报废单：${existingWaste.code || existingWaste.id}（${existingWaste.status}），不可重复创建` });
        }
      }
      if (stocktakeDiffItem.actionStatus === 'completed') {
        return res.status(409).json({ error: '该盘亏项已处理完成，不可重复创建报废单' });
      }

      isStocktakeInitiated = true;
      stocktakeDeficitQty = Math.abs(stocktakeDiffItem.difference || 0);

      if (wasteQty > stocktakeDeficitQty) {
        return res.status(409).json({ error: `从盘点发起的报废数量(${wasteQty})不可超过盘亏数量(${stocktakeDeficitQty})` });
      }
      if (wasteQty > availableQty + stocktakeDeficitQty) {
        return res.status(409).json({ error: `报废数量(${wasteQty})超过可报废上限（库存${availableQty} + 盘亏已扣减${stocktakeDeficitQty}）` });
      }
      maxAllowedQty = Math.min(stocktakeDeficitQty, availableQty + stocktakeDeficitQty);
    } else {
      if (wasteQty > stockQty) return res.status(409).json({ error: `报废数量(${wasteQty})超过当前库存(${stockQty})` });
      if (wasteQty > availableQty) return res.status(409).json({ error: `报废数量(${wasteQty})超过可用库存(${availableQty})，有${reservedQty}已被调度预占，请先关闭相关调度单` });
    }

    const sourceLabel = stocktakeId ? '（盘点盘亏发起）' : '';
    item = {
      id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      ...req.body,
      status: '待审批',
      actualQuantity: 0,
      stocktakeId: stocktakeId,
      isStocktakeInitiated: isStocktakeInitiated,
      stocktakeDeficitQty: stocktakeDeficitQty,
      stockAdjusted: isStocktakeInitiated,
      maxAllowedQty: maxAllowedQty,
      createdAt: now,
      updatedAt: now,
      createdBy: { id: operator.id, name: operator.name, role: operator.role, roleLabel: operator.roleLabel },
      history: [stamp('创建申请' + sourceLabel, `批次：${batch.name} / ${batch.batchNo}，申请报废：${req.body.quantity}${batch.unit || ''}，原因：${req.body.reason || '未填写'}${isStocktakeInitiated ? `，盘亏数量：${stocktakeDeficitQty}${batch.unit || ''}（库存已同步扣减）` : ''}`, operator)]
    };

    if (stocktakeId) {
      const stocktake = db.stocktakes?.find((s) => s.id === stocktakeId);
      if (stocktake) {
        if (stocktake.diffSuggestions && stocktakeDiffItem) {
          stocktakeDiffItem.actionStatus = 'registered';
          stocktakeDiffItem.wasteId = item.id;
          stocktakeDiffItem.wasteQty = wasteQty;
        }
        if (stocktake.items) {
          const stocktakeItem = stocktake.items.find((i) => i.batchId === req.body.batchId);
          if (stocktakeItem) {
            stocktakeItem.actionStatus = 'registered';
            stocktakeItem.wasteId = item.id;
            stocktakeItem.wasteQty = wasteQty;
          }
        }
        if (stocktake.suggestionSummary) {
          stocktake.suggestionSummary.wasteRegisteredCount = (stocktake.suggestionSummary.wasteRegisteredCount || 0) + 1;
          stocktake.suggestionSummary.pendingCount = Math.max(0, (stocktake.suggestionSummary.pendingCount || 0) - 1);
        }
        stocktake.updatedAt = now;
        stocktake.history = stocktake.history || [];
        stocktake.history.unshift(stamp('差异处理', `盘亏批次「${batch.name} / ${batch.batchNo}」已创建报废单草稿，报废单：${item.code || item.id}，申请报废：${wasteQty}${batch.unit || ''}`, operator));
        writeAuditLog(db, {
          actionType: '盘点差异处理',
          collection: 'stocktakes',
          targetId: stocktake.id,
          targetItem: stocktake,
          note: `盘亏批次「${batch.name} / ${batch.batchNo}」已创建报废单草稿，申请报废：${wasteQty}${batch.unit || ''}`,
          operator
        });
      }
    }
  } else if (collection === 'requests') {
    const batch = db.batches.find((b) => b.id === req.body.batchId);
    if (!batch) return res.status(409).json({ error: '批次不存在' });
    if (batch.status !== '可用') return res.status(409).json({ error: `批次「${batch.name}/${batch.batchNo}」状态为「${batch.status}」，不可领用` });
    const reqQty = Number(req.body.quantity || 0);
    const stockQty = Number(batch.quantity || 0);
    const reservedQty = Number(batch.reservedQuantity || 0);
    const availableQty = Math.max(0, stockQty - reservedQty);
    if (reqQty <= 0) return res.status(409).json({ error: '领用数量必须大于0' });
    if (reqQty > availableQty) return res.status(409).json({ error: `批次「${batch.name}/${batch.batchNo}」可用${availableQty}${batch.unit || ''}（库存${stockQty}，调度预占${reservedQty}），本次申请${reqQty}${batch.unit || ''}，请先关闭相关调度单` });
    if (reqQty > stockQty) return res.status(409).json({ error: `领用数量(${reqQty}${batch.unit || ''})超过当前库存(${stockQty}${batch.unit || ''})` });
    item = {
      id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      ...req.body,
      status: '待审批',
      createdAt: now,
      updatedAt: now,
      createdBy: { id: operator.id, name: operator.name, role: operator.role, roleLabel: operator.roleLabel },
      history: [stamp('创建申请', `批次：${batch.name} / ${batch.batchNo}，申请领用：${req.body.quantity}${batch.unit || ''}`, operator)]
    };
  } else if (collection === 'batches') {
    const defaultNote = req.body.note || req.body.memo || '';
    const cabinetId = req.body.cabinetId;
    const addQty = Number(req.body.quantity || 0);
    if (cabinetId) {
      const capCheck = checkCabinetCapacity(db, cabinetId, addQty);
      if (!capCheck.ok) return res.status(409).json({ error: capCheck.error, capacityInfo: capCheck.occupancy });
    }
    item = {
      id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      ...req.body,
      createdAt: now,
      updatedAt: now,
      createdBy: { id: operator.id, name: operator.name, role: operator.role, roleLabel: operator.roleLabel },
      history: [stamp('创建', defaultNote, operator)]
    };
  } else {
    const defaultNote = req.body.note || req.body.memo || '';
    item = {
      id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      ...req.body,
      createdAt: now,
      updatedAt: now,
      createdBy: { id: operator.id, name: operator.name, role: operator.role, roleLabel: operator.roleLabel },
      history: [stamp('创建', defaultNote, operator)]
    };
  }

  db[collection].push(item);
  writeAuditLog(db, {
    actionType: '创建',
    collection,
    targetId: item.id,
    targetItem: item,
    note: req.body.note || req.body.memo || '',
    operator
  });
  await writeDb(db);
  res.status(201).json(item);
});

app.patch('/api/:collection/:id', requireUser, async (req, res, next) => {
  const { collection, id } = req.params;
  if (collection === 'schedules') return next();
  const db = await readDb();
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });

  if (!checkPermission(req.currentUser, 'update', collection, res)) return;

  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });

  const operator = req.currentUser;

  if (collection === 'wastes') {
    const protectedFields = ['status', 'actualQuantity', 'approver', 'approvedAt', 'disposedBy', 'disposedAt', 'disposalMethod', 'witness'];
    const hasProtected = protectedFields.some(f => f in req.body);
    if (hasProtected) {
      return res.status(409).json({ error: '报废单状态和处置信息不能直接修改，请走正规审批流程' });
    }
    if (item.status !== '待审批' && item.status !== '已驳回') {
      return res.status(409).json({ error: '只有待审批或已驳回状态的报废单可以编辑' });
    }
    if (req.body.quantity !== undefined) {
      const batch = db.batches.find((b) => b.id === (req.body.batchId || item.batchId));
      if (!batch) return res.status(409).json({ error: '批次不存在' });
      const newQty = Number(req.body.quantity || 0);
      const stockQty = Number(batch.quantity || 0);
      const reservedQty = Number(batch.reservedQuantity || 0);
      const availableQty = Math.max(0, stockQty - reservedQty);
      if (newQty <= 0) return res.status(409).json({ error: '报废数量必须大于0' });
      if (newQty > stockQty) return res.status(409).json({ error: `报废数量(${newQty})超过当前库存(${stockQty})` });
      if (newQty > availableQty) return res.status(409).json({ error: `报废数量(${newQty})超过可用库存(${availableQty})，有${reservedQty}已被调度预占，请先关闭相关调度单` });
    }
  } else if (collection === 'requests') {
    const protectedFields = ['status', 'approver', 'approvedAt', 'issuedBy', 'issuedAt', 'returned', 'returnedAt'];
    const hasProtected = protectedFields.some(f => f in req.body);
    if (hasProtected) {
      return res.status(409).json({ error: '领用申请状态和审批信息不能直接修改，请走正规审批流程' });
    }
    if (item.status !== '待审批' && item.status !== '已驳回') {
      return res.status(409).json({ error: '只有待审批或已驳回状态的领用申请可以编辑' });
    }
    if (req.body.quantity !== undefined || req.body.batchId !== undefined) {
      const batch = db.batches.find((b) => b.id === (req.body.batchId || item.batchId));
      if (!batch) return res.status(409).json({ error: '批次不存在' });
      if (batch.status !== '可用') return res.status(409).json({ error: `批次「${batch.name}/${batch.batchNo}」状态为「${batch.status}」，不可领用` });
      const newQty = Number((req.body.quantity !== undefined ? req.body.quantity : item.quantity) || 0);
      const stockQty = Number(batch.quantity || 0);
      const reservedQty = Number(batch.reservedQuantity || 0);
      const availableQty = Math.max(0, stockQty - reservedQty);
      if (newQty <= 0) return res.status(409).json({ error: '领用数量必须大于0' });
      if (newQty > availableQty) return res.status(409).json({ error: `批次「${batch.name}/${batch.batchNo}」可用${availableQty}${batch.unit || ''}（库存${stockQty}，调度预占${reservedQty}），本次申请${newQty}${batch.unit || ''}，请先关闭相关调度单` });
      if (newQty > stockQty) return res.status(409).json({ error: `领用数量(${newQty}${batch.unit || ''})超过当前库存(${stockQty}${batch.unit || ''})` });
    }
  }

  const beforeItem = { ...item };
  const historyAction = req.body.historyAction;
  delete req.body.historyAction;

  if (collection === 'batches') {
    const newCabinetId = req.body.cabinetId !== undefined ? req.body.cabinetId : item.cabinetId;
    const newQty = req.body.quantity !== undefined ? Number(req.body.quantity || 0) : Number(item.quantity || 0);

    if (newCabinetId) {
      const capCheck = checkCabinetCapacity(db, newCabinetId, newQty, item.id);
      if (!capCheck.ok) return res.status(409).json({ error: capCheck.error, capacityInfo: capCheck.occupancy });
    }
  }

  Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
  item.history = item.history || [];
  if (historyAction || req.body.note || req.body.memo || req.body.status) {
    item.history.unshift(stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || '', operator));
  }
  const trackedFields = ['status', 'quantity', 'note', 'memo', 'name', 'code', 'title'];
  writeAuditLog(db, {
    actionType: historyAction || '更新',
    collection,
    targetId: id,
    targetItem: item,
    beforeItem,
    changes: computeChanges(beforeItem, item, trackedFields),
    note: req.body.note || req.body.memo || '',
    operator
  });
  await writeDb(db);
  res.json(item);
});

app.delete('/api/:collection/:id', requireUser, async (req, res, next) => {
  const { collection } = req.params;
  if (collection === 'schedules') return next();
  const db = await readDb();
  const { id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });

  if (!checkPermission(req.currentUser, 'delete', collection, res)) return;

  const operator = req.currentUser;

  if (collection === 'wastes') {
    const item = db[collection].find((entry) => entry.id === id);
    if (!item) return res.status(404).json({ error: 'not found' });
    if (item.status === '待处置' || item.status === '已处置') {
      return res.status(409).json({ error: '待处置或已处置的报废单不能删除' });
    }
  }

  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  writeAuditLog(db, {
    actionType: '删除',
    collection,
    targetId: id,
    beforeItem: item,
    note: '删除记录',
    operator
  });
  db[collection] = db[collection].filter((entry) => entry.id !== id);
  await writeDb(db);
  res.status(204).end();
});

app.post('/api/action/:actionId/:id', requireUser, async (req, res) => {
  const db = await readDb();
  const action = config.actions.find((entry) => entry.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'unknown action' });

  if (!checkPermission(req.currentUser, 'action', action.id, res)) return;

  const operator = req.currentUser;
  const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const preCheck = preActionCheck(db, action, item);
  if (preCheck.error) return res.status(409).json({ error: preCheck.error });

  const beforeItem = { ...item };
  let beforeRelated = null;
  let relatedItem = null;
  if (action.relation) {
    relatedItem = findRelated(db, action.relation, item);
    if (relatedItem) beforeRelated = { ...relatedItem };
  }

  const result = runAction(db, action, item, operator);
  if (result.error) return res.status(409).json({ error: result.error });

  let extraBatchSnapshots = {};
  if (action.id === 'schedule-reject' && action.collection === 'schedules') {
    const nowStr = new Date().toISOString();
    extraBatchSnapshots = releaseScheduleBatches(db, item, operator, nowStr, '调度驳回');
    item.history = item.history || [];
    const released = Object.values(extraBatchSnapshots).length;
    if (released > 0) {
      item.history.unshift(stamp('释放预占', `调度驳回，释放相关批次预占库存`, operator));
    }
  }

  writeAuditLog(db, {
    actionType: action.label,
    collection: action.collection,
    targetId: item.id,
    targetItem: item,
    beforeItem,
    note: action.note || '状态流转',
    operator
  });

  Object.entries(extraBatchSnapshots).forEach(([batchId, beforeBatch]) => {
    const batch = db.batches.find((b) => b.id === batchId);
    if (!batch) return;
    writeAuditLog(db, {
      actionType: '释放预占',
      collection: 'batches',
      targetId: batch.id,
      targetItem: batch,
      beforeItem: beforeBatch,
      note: `调度单：${item.code || item.id}，原因：调度驳回`,
      operator
    });
  });

  if (action.relation && relatedItem && beforeRelated) {
    const relChanged = JSON.stringify(relatedItem) !== JSON.stringify(beforeRelated);
    if (relChanged) {
      writeAuditLog(db, {
        actionType: action.label + '(关联)',
        collection: action.relation.collection,
        targetId: relatedItem.id,
        targetItem: relatedItem,
        beforeItem: beforeRelated,
        note: `由 ${collectionLabel(action.collection)} 操作触发：${action.label}`,
        operator
      });
    }
  }

  await writeDb(db);
  res.json(result.item);
});

function preActionCheck(db, action, item) {
  const openStatuses = config.alerts?.openRequestStatuses || ['待审批', '已审批', '已出库'];
  if (action.collection === 'batches') {
    const openRequests = (db.requests || []).filter((r) => r.batchId === item.id && openStatuses.includes(r.status));
    if (action.id === 'batch-waste' && openRequests.length > 0) {
      return { error: `该批次存在 ${openRequests.length} 个未闭环申请，无法直接报废，请先处理申请` };
    }
    if (action.id === 'batch-waste' && Number(item.quantity || 0) > 0) {
      return { error: '该批次还有库存，请通过报废单流程完成报废处置' };
    }
  }
  if ((action.id === 'request-approve' || action.id === 'request-issue') && action.collection === 'requests') {
    const batch = db.batches?.find((b) => b.id === item.batchId);
    if (batch) {
      const stockQty = Number(batch.quantity || 0);
      const reservedQty = Number(batch.reservedQuantity || 0);
      const available = Math.max(0, stockQty - reservedQty);
      const reqQty = Number(item.quantity || 0);
      if (reqQty > available) {
        const opName = action.id === 'request-approve' ? '审批' : '出库';
        return { error: `批次「${batch.name}/${batch.batchNo}」可用${available}${batch.unit || ''}（库存${stockQty}，调度预占${reservedQty}），本次申请${reqQty}${batch.unit || ''}，无法${opName}，请先关闭相关调度单` };
      }
    }
  }
  return {};
}

function getValue(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function setValue(target, pathName, value) {
  const keys = pathName.split('.');
  let cursor = target;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function findRelated(db, relation, item) {
  return db[relation.collection]?.find((entry) => entry.id === item[relation.localKey]);
}

function runAction(db, action, item, operator) {
  const related = action.relation ? findRelated(db, action.relation, item) : null;
  const context = { item, related };
  const levelRank = { '低': 1, '中': 2, '高': 3 };
  for (const guard of action.guards || []) {
    const left = getValue(context, guard.left);
    const right = guard.rightPath ? getValue(context, guard.rightPath) : guard.right;
    if (guard.op === 'missing' && left) continue;
    if (guard.op === 'missing' && !left) return { error: guard.message };
    if (guard.op === 'eq' && left !== right) return { error: guard.message };
    if (guard.op === 'neq' && left === right) return { error: guard.message };
    if (guard.op === 'gte' && Number(left) < Number(right)) return { error: guard.message };
    if (guard.op === 'levelGte' && (levelRank[left] || 0) < (levelRank[right] || 0)) return { error: guard.message };
    if (guard.op === 'notIn' && guard.values.includes(left)) return { error: guard.message };
  }
  for (const patch of action.patches || []) {
    const target = patch.target === 'related' ? related : item;
    if (!target) continue;
    const next = patch.valuePath ? getValue(context, patch.valuePath) : patch.value;
    setValue(target, patch.field, next);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '状态流转', operator));
  }
  for (const delta of action.deltas || []) {
    const target = delta.target === 'related' ? related : item;
    if (!target) continue;
    const sourceAmount = delta.amountPath ? Number(getValue(context, delta.amountPath)) : 1;
    const multiplier = delta.amount === undefined ? 1 : Number(delta.amount);
    const amount = sourceAmount * multiplier;
    const current = Number(getValue({ target }, `target.${delta.field}`) || 0);
    setValue(target, delta.field, current + amount);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '数量调整', operator));
  }
  return { item };
}

app.post('/api/stocktakes/:id/confirm', requireUser, async (req, res) => {
  if (!checkPermission(req.currentUser, 'special', 'stocktakes-confirm', res)) return;

  const db = await readDb();
  const { id } = req.params;
  const stocktake = db.stocktakes?.find((entry) => entry.id === id);
  if (!stocktake) return res.status(404).json({ error: '盘点单不存在' });
  if (stocktake.status === '已确认') return res.status(409).json({ error: '该盘点单已确认，不可重复确认' });
  if (!Array.isArray(stocktake.items) || stocktake.items.length === 0) {
    return res.status(409).json({ error: '盘点单还没有录入任何批次，请先完成录入' });
  }

  const operator = req.currentUser;
  const now = new Date().toISOString();
  const confirmedBy = `${operator.name}（${operator.roleLabel}）`;
  const confirmedByInfo = { id: operator.id, name: operator.name, role: operator.role, roleLabel: operator.roleLabel };

  let surplusCount = 0;
  let deficitCount = 0;
  let surplusQty = 0;
  let deficitQty = 0;
  const diffItems = [];

  for (const item of stocktake.items) {
    const batch = db.batches.find((b) => b.id === item.batchId);
    if (!batch) continue;

    const book = Number(item.bookQuantity ?? batch.quantity ?? 0);
    const actual = Number(item.actualQuantity ?? 0);
    const diff = actual - book;
    item.difference = diff;
    item.bookQuantity = book;
    item.actualQuantity = actual;

    if (diff !== 0) {
      batch.quantity = actual;
      batch.updatedAt = now;
      batch.history = batch.history || [];
      const diffText = diff > 0 ? `盘盈+${diff}${batch.unit || ''}` : `盘亏${diff}${batch.unit || ''}`;
      const remarkText = item.remark ? `，原因：${item.remark}` : '';
      batch.history.unshift(stamp('盘点调整', `${diffText}，盘点单：${stocktake.code || stocktake.id}${remarkText}`, operator));

      const diffType = diff > 0 ? 'surplus' : 'deficit';
      const suggestion = diff > 0
        ? { type: 'surplus', label: '盘盈', suggestion: '建议补入库备注', needAction: 'stockInNote', actionStatus: 'pending' }
        : { type: 'deficit', label: '盘亏', suggestion: '建议补登记报废', needAction: 'wasteRegistration', actionStatus: 'pending' };

      const diffItem = {
        batchId: item.batchId,
        batchName: batch.name,
        batchNo: batch.batchNo,
        unit: batch.unit || '',
        bookQuantity: book,
        actualQuantity: actual,
        difference: diff,
        diffType,
        suggestion: suggestion.suggestion,
        needAction: suggestion.needAction,
        actionStatus: suggestion.actionStatus,
        remark: item.remark || '',
        wasteId: null,
        stockAdjusted: true,
        adjustedQuantity: Math.abs(diff)
      };
      diffItems.push(diffItem);
      item.suggestion = suggestion.suggestion;
      item.needAction = suggestion.needAction;
      item.actionStatus = suggestion.actionStatus;
      item.stockAdjusted = true;
      item.adjustedQuantity = Math.abs(diff);

      if (diff > 0) {
        surplusCount++;
        surplusQty += diff;
      } else {
        deficitCount++;
        deficitQty += Math.abs(diff);
      }
    } else {
      item.actionStatus = 'consistent';
    }
  }

  const diffCount = surplusCount + deficitCount;
  stocktake.diffSummary = {
    diffCount,
    surplusCount,
    deficitCount,
    surplusQty,
    deficitQty
  };

  const suggestionSummary = {
    needWasteRegistration: deficitCount,
    needStockInNote: surplusCount,
    pendingCount: diffCount,
    completedCount: 0,
    wasteRegisteredCount: 0,
    stockInNotedCount: 0
  };
  stocktake.diffSuggestions = diffItems;
  stocktake.suggestionSummary = suggestionSummary;

  stocktake.status = '已确认';
  stocktake.confirmedAt = now;
  stocktake.confirmedBy = confirmedBy;
  stocktake.confirmedByInfo = confirmedByInfo;
  stocktake.updatedAt = now;
  stocktake.history = stocktake.history || [];

  const noteParts = [];
  noteParts.push(`差异项${diffCount}项`);
  if (surplusCount) noteParts.push(`盘盈${surplusCount}项(+${surplusQty})，建议补入库备注`);
  if (deficitCount) noteParts.push(`盘亏${deficitCount}项(-${deficitQty})，建议补登记报废`);
  noteParts.push('已同步更新批次库存');
  stocktake.history.unshift(stamp('确认', noteParts.join('，'), operator));

  writeAuditLog(db, {
    actionType: '盘点确认',
    collection: 'stocktakes',
    targetId: stocktake.id,
    targetItem: stocktake,
    note: noteParts.join('，'),
    operator
  });

  await writeDb(db);
  res.json(stocktake);
});

app.post('/api/wastes/:id/approve', requireUser, async (req, res) => {
  if (!checkPermission(req.currentUser, 'special', 'wastes-approve', res)) return;

  const db = await readDb();
  const { id } = req.params;
  const waste = db.wastes?.find((entry) => entry.id === id);
  if (!waste) return res.status(404).json({ error: '报废单不存在' });
  if (waste.status !== '待审批') return res.status(409).json({ error: '只有待审批状态的报废单可以审批' });

  const batch = db.batches.find((b) => b.id === waste.batchId);
  if (!batch) return res.status(409).json({ error: '关联批次不存在' });
  if (batch.status === '已报废') return res.status(409).json({ error: '批次已报废，无法审批' });

  const wasteQty = Number(waste.quantity || 0);
  const stockQty = Number(batch.quantity || 0);
  const reservedQty = Number(batch.reservedQuantity || 0);
  const availableQty = Math.max(0, stockQty - reservedQty);
  const isStocktakeInitiated = !!waste.isStocktakeInitiated;
  const stocktakeDeficitQty = Number(waste.stocktakeDeficitQty || 0);

  if (wasteQty <= 0) return res.status(409).json({ error: '报废数量必须大于0' });

  if (isStocktakeInitiated) {
    const maxAllowed = Math.min(stocktakeDeficitQty, availableQty + stocktakeDeficitQty);
    if (wasteQty > maxAllowed) {
      return res.status(409).json({ error: `盘点发起的报废数量(${wasteQty})超过可报废上限${maxAllowed}${batch.unit || ''}（盘亏已扣减${stocktakeDeficitQty}${batch.unit || ''}，当前可用${availableQty}${batch.unit || ''}）` });
    }
    if (wasteQty > stocktakeDeficitQty) {
      return res.status(409).json({ error: `盘点发起的报废数量(${wasteQty})不可超过盘亏数量(${stocktakeDeficitQty}${batch.unit || ''})` });
    }
  } else {
    if (wasteQty > stockQty) return res.status(409).json({ error: `报废数量(${wasteQty})超过当前库存(${stockQty})` });
    if (wasteQty > availableQty) return res.status(409).json({ error: `报废数量(${wasteQty})超过可用库存(${availableQty})，有${reservedQty}已被调度预占，请先关闭相关调度单` });
  }

  const operator = req.currentUser;
  const now = new Date().toISOString();
  const approver = `${operator.name}（${operator.roleLabel}）`;

  const beforeWaste = { ...waste };
  const beforeBatch = { ...batch };

  waste.status = '待处置';
  waste.approver = approver;
  waste.approverInfo = { id: operator.id, name: operator.name, role: operator.role, roleLabel: operator.roleLabel };
  waste.approvedAt = now;
  waste.updatedAt = now;
  waste.history = waste.history || [];
  waste.history.unshift(stamp('审批通过', `审批人：${approver}，报废数量：${wasteQty}${batch.unit || ''}`, operator));

  batch.updatedAt = now;
  batch.history = batch.history || [];
  batch.history.unshift(stamp('报废审批通过', `报废单：${waste.code || waste.id}，申请报废：${wasteQty}${batch.unit || ''}`, operator));

  writeAuditLog(db, {
    actionType: '审批通过',
    collection: 'wastes',
    targetId: waste.id,
    targetItem: waste,
    beforeItem: beforeWaste,
    note: `审批人：${approver}，报废数量：${wasteQty}${batch.unit || ''}`,
    operator
  });

  writeAuditLog(db, {
    actionType: '报废审批(关联)',
    collection: 'batches',
    targetId: batch.id,
    targetItem: batch,
    beforeItem: beforeBatch,
    note: `报废单：${waste.code || waste.id}，申请报废：${wasteQty}${batch.unit || ''}`,
    operator
  });

  await writeDb(db);
  res.json(waste);
});

app.post('/api/wastes/:id/dispose', requireUser, async (req, res) => {
  if (!checkPermission(req.currentUser, 'special', 'wastes-dispose', res)) return;

  const db = await readDb();
  const { id } = req.params;
  const waste = db.wastes?.find((entry) => entry.id === id);
  if (!waste) return res.status(404).json({ error: '报废单不存在' });
  if (waste.status !== '待处置') return res.status(409).json({ error: '只有待处置状态的报废单可以确认处置' });

  const batch = db.batches.find((b) => b.id === waste.batchId);
  if (!batch) return res.status(409).json({ error: '关联批次不存在' });
  if (batch.status === '已报废') return res.status(409).json({ error: '批次已报废' });

  const actualQty = Number(req.body.actualQuantity ?? waste.quantity);
  const disposalMethod = req.body.disposalMethod || waste.disposalMethod || '';
  const witness = req.body.witness || waste.witness || '';
  const operator = req.currentUser;
  const disposedBy = `${operator.name}（${operator.roleLabel}）`;

  const wasteQty = Number(waste.quantity || 0);
  const stockQty = Number(batch.quantity || 0);
  const reservedQty = Number(batch.reservedQuantity || 0);
  const availableQty = Math.max(0, stockQty - reservedQty);
  const isStocktakeInitiated = !!waste.isStocktakeInitiated;
  const stocktakeDeficitQty = Number(waste.stocktakeDeficitQty || 0);
  const stockAdjusted = !!waste.stockAdjusted;

  if (actualQty <= 0) return res.status(409).json({ error: '实际处置数量必须大于0' });
  if (actualQty > wasteQty) return res.status(409).json({ error: `实际处置数量(${actualQty})超过申请数量(${wasteQty})` });

  if (isStocktakeInitiated) {
    const maxAllowed = Math.min(stocktakeDeficitQty, availableQty + stocktakeDeficitQty);
    if (actualQty > maxAllowed) {
      return res.status(409).json({ error: `盘点发起的报废处置数量(${actualQty})超过可报废上限${maxAllowed}${batch.unit || ''}（盘亏已扣减${stocktakeDeficitQty}${batch.unit || ''}，当前可用${availableQty}${batch.unit || ''}）` });
    }
    if (actualQty > stocktakeDeficitQty) {
      return res.status(409).json({ error: `盘点发起的报废处置数量(${actualQty})不可超过盘亏数量(${stocktakeDeficitQty}${batch.unit || ''})` });
    }
  } else {
    if (actualQty > stockQty) return res.status(409).json({ error: `实际处置数量(${actualQty})超过当前库存(${stockQty})` });
    if (actualQty > availableQty) return res.status(409).json({ error: `实际处置数量(${actualQty})超过可用库存(${availableQty})，有${reservedQty}已被调度预占` });
  }

  const now = new Date().toISOString();

  const beforeWaste = { ...waste };
  const beforeBatch = { ...batch };

  waste.actualQuantity = actualQty;
  waste.disposalMethod = disposalMethod;
  waste.witness = witness;
  waste.status = '已处置';
  waste.disposedAt = now;
  waste.disposedBy = disposedBy;
  waste.disposedByInfo = { id: operator.id, name: operator.name, role: operator.role, roleLabel: operator.roleLabel };
  waste.updatedAt = now;
  waste.history = waste.history || [];

  let newQty = stockQty;
  let deductQty = 0;
  const noteParts = [`报废单：${waste.code || waste.id}`, `实际处置：${actualQty}${batch.unit || ''}`];

  if (isStocktakeInitiated && stockAdjusted) {
    const deductFromStock = Math.max(0, actualQty - stocktakeDeficitQty);
    deductQty = deductFromStock;
    newQty = stockQty - deductFromStock;
    if (deductFromStock > 0) {
      noteParts.push(`从库存扣减：-${deductFromStock}${batch.unit || ''}`);
      noteParts.push(`盘亏已扣减抵充：${Math.min(actualQty, stocktakeDeficitQty)}${batch.unit || ''}`);
    } else {
      noteParts.push('全部由盘点盘亏已扣减抵充，不扣减当前库存');
    }
    noteParts.push(`剩余库存：${newQty}${batch.unit || ''}`);
    waste.history.unshift(stamp('确认处置(盘点发起)', `实际处置：${actualQty}${batch.unit || ''}，其中盘亏已扣减抵充：${Math.min(actualQty, stocktakeDeficitQty)}${batch.unit || ''}，从库存扣减：${deductFromStock}${batch.unit || ''}，处置方式：${disposalMethod || '未指定'}，见证人：${witness || '未记录'}`, operator));
  } else {
    deductQty = actualQty;
    newQty = stockQty - actualQty;
    noteParts.push(`报废数量：-${actualQty}${batch.unit || ''}`);
    noteParts.push(`剩余库存：${newQty}${batch.unit || ''}`);
    waste.history.unshift(stamp('确认处置', `实际处置：${actualQty}${batch.unit || ''}，处置方式：${disposalMethod || '未指定'}，见证人：${witness || '未记录'}`, operator));
  }

  batch.quantity = newQty;
  batch.updatedAt = now;
  batch.history = batch.history || [];

  if (newQty <= 0 && stocktakeDeficitQty <= 0) {
    batch.status = '已报废';
    noteParts.push('库存清零，批次状态更新为已报废');
  }

  const batchAction = isStocktakeInitiated ? '报废扣减(盘点发起)' : '报废扣减';
  batch.history.unshift(stamp(batchAction, noteParts.join('，'), operator));

  if (waste.stocktakeId) {
    const stocktake = db.stocktakes?.find((s) => s.id === waste.stocktakeId);
    if (stocktake) {
      if (stocktake.diffSuggestions) {
        const diffItem = stocktake.diffSuggestions.find((d) => d.batchId === waste.batchId);
        if (diffItem) {
          diffItem.actionStatus = 'completed';
          diffItem.actualWasteQty = actualQty;
          diffItem.deductedFromStock = deductQty;
        }
      }
      if (stocktake.items) {
        const stocktakeItem = stocktake.items.find((i) => i.batchId === waste.batchId);
        if (stocktakeItem) {
          stocktakeItem.actionStatus = 'completed';
          stocktakeItem.actualWasteQty = actualQty;
          stocktakeItem.deductedFromStock = deductQty;
        }
      }
      if (stocktake.suggestionSummary) {
        stocktake.suggestionSummary.completedCount = (stocktake.suggestionSummary.completedCount || 0) + 1;
      }
      stocktake.updatedAt = now;
      stocktake.history = stocktake.history || [];
      stocktake.history.unshift(stamp('差异处理完成', `盘亏批次「${batch.name} / ${batch.batchNo}」已完成报废处置，实际报废：${actualQty}${batch.unit || ''}，扣减库存：${deductQty}${batch.unit || ''}，盘亏抵充：${actualQty - deductQty}${batch.unit || ''}`, operator));
      writeAuditLog(db, {
        actionType: '盘点差异处理完成',
        collection: 'stocktakes',
        targetId: stocktake.id,
        targetItem: stocktake,
        note: `盘亏批次「${batch.name} / ${batch.batchNo}」已完成报废处置，实际报废：${actualQty}${batch.unit || ''}`,
        operator
      });
    }
  }

  writeAuditLog(db, {
    actionType: '确认处置',
    collection: 'wastes',
    targetId: waste.id,
    targetItem: waste,
    beforeItem: beforeWaste,
    note: `实际处置：${actualQty}${batch.unit || ''}，处置方式：${disposalMethod || '未指定'}，见证人：${witness || '未记录'}${isStocktakeInitiated ? '（盘点发起）' : ''}`,
    operator
  });

  writeAuditLog(db, {
    actionType: batchAction + '(关联)',
    collection: 'batches',
    targetId: batch.id,
    targetItem: batch,
    beforeItem: beforeBatch,
    note: noteParts.join('，'),
    operator
  });

  await writeDb(db);
  res.json(waste);
});

app.patch('/api/stocktakes/:id/items', requireUser, async (req, res) => {
  if (!checkPermission(req.currentUser, 'special', 'stocktakes-items', res)) return;

  const db = await readDb();
  const { id } = req.params;
  const stocktake = db.stocktakes?.find((entry) => entry.id === id);
  if (!stocktake) return res.status(404).json({ error: '盘点单不存在' });
  if (stocktake.status === '已确认') return res.status(409).json({ error: '已确认的盘点单不能修改录入' });

  const operator = req.currentUser;
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items 必须是数组' });

  const now = new Date().toISOString();
  const beforeItems = JSON.parse(JSON.stringify(stocktake.items || []));
  const beforeStatus = stocktake.status;

  stocktake.items = items.map((item) => {
    const batch = db.batches.find((b) => b.id === item.batchId);
    const book = Number(item.bookQuantity ?? batch?.quantity ?? 0);
    const actual = Number(item.actualQuantity ?? book);
    return {
      batchId: item.batchId,
      bookQuantity: book,
      actualQuantity: actual,
      difference: actual - book,
      remark: item.remark || ''
    };
  });

  const afterStatus = stocktake.items.length > 0 ? '录入中' : '草稿';
  stocktake.status = afterStatus;
  stocktake.updatedAt = now;
  stocktake.history = stocktake.history || [];

  const diffItems = stocktake.items.filter((i) => i.difference !== 0).length;
  stocktake.history.unshift(stamp('录入', `录入${stocktake.items.length}个批次，差异${diffItems}项`, operator));

  const itemChanges = {};
  const beforeIds = new Set(beforeItems.map((i) => i.batchId));
  const afterIds = new Set(stocktake.items.map((i) => i.batchId));
  const allIds = [...new Set([...beforeIds, ...afterIds])];
  let changedCount = 0;
  for (const bid of allIds) {
    const before = beforeItems.find((i) => i.batchId === bid);
    const after = stocktake.items.find((i) => i.batchId === bid);
    const b = db.batches.find((bb) => bb.id === bid);
    const bLabel = b ? getTargetLabel(b, 'batches') : bid;
    if (!before && after) {
      itemChanges[`[新增] ${bLabel}`] = { before: null, after: `实际${after.actualQuantity} / 账面${after.bookQuantity}${after.difference !== 0 ? ' / 差异' + after.difference : ''}` };
      changedCount++;
    } else if (before && !after) {
      itemChanges[`[移除] ${bLabel}`] = { before: `实际${before.actualQuantity} / 账面${before.bookQuantity}${before.difference !== 0 ? ' / 差异' + before.difference : ''}`, after: null };
      changedCount++;
    } else if (before && after && JSON.stringify(before) !== JSON.stringify(after)) {
      const fields = [];
      if (before.actualQuantity !== after.actualQuantity) fields.push(`实际${before.actualQuantity}→${after.actualQuantity}`);
      if (before.bookQuantity !== after.bookQuantity) fields.push(`账面${before.bookQuantity}→${after.bookQuantity}`);
      if (before.difference !== after.difference) fields.push(`差异${before.difference}→${after.difference}`);
      if (before.remark !== after.remark) fields.push(`备注变化`);
      itemChanges[`[变更] ${bLabel}`] = { before: '原数据', after: fields.join('，') || '字段调整' };
      changedCount++;
    }
    if (changedCount >= 20) break;
  }
  if (beforeStatus !== afterStatus) itemChanges['status'] = { before: beforeStatus, after: afterStatus };
  itemChanges['items'] = { before: `${beforeItems.length}个批次`, after: `${stocktake.items.length}个批次` };

  writeAuditLog(db, {
    actionType: '盘点录入',
    collection: 'stocktakes',
    targetId: stocktake.id,
    targetItem: stocktake,
    changes: itemChanges,
    note: `录入${stocktake.items.length}个批次，差异${diffItems}项`,
    operator
  });

  await writeDb(db);
  res.json(stocktake);
});

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return values;
  });
  return { headers, rows };
}

const BATCH_REQUIRED_FIELDS = ['name', 'category', 'batchNo', 'supplier', 'cabinet', 'quantity', 'unit', 'expiresAt'];
const BATCH_FIELD_LABELS = {
  name: '药剂名称',
  category: '品类',
  batchNo: '批次号',
  supplier: '供应商',
  cabinet: '存放柜位',
  safetyLevel: '安全等级',
  quantity: '库存数量',
  unit: '单位',
  expiresAt: '有效期',
  status: '状态'
};

function normalizeHeader(header) {
  const map = {
    '药剂名称': 'name',
    '名称': 'name',
    '品名': 'name',
    '品类': 'category',
    '类别': 'category',
    '分类': 'category',
    '批次号': 'batchNo',
    '批次': 'batchNo',
    '批号': 'batchNo',
    '供应商': 'supplier',
    '供应商名称': 'supplier',
    '存放柜位': 'cabinet',
    '柜位': 'cabinet',
    '防爆柜': 'cabinet',
    '安全等级': 'safetyLevel',
    '等级': 'safetyLevel',
    '库存数量': 'quantity',
    '数量': 'quantity',
    '库存': 'quantity',
    '单位': 'unit',
    '计量单位': 'unit',
    '有效期': 'expiresAt',
    '有效期至': 'expiresAt',
    '到期日': 'expiresAt',
    '状态': 'status'
  };
  return map[header] || header;
}

function validateBatchRow(row, headers, db, rowIndex) {
  const errors = [];
  const data = {};
  const missing = [];

  headers.forEach((header, idx) => {
    const field = normalizeHeader(header);
    data[field] = row[idx] || '';
  });

  for (const field of BATCH_REQUIRED_FIELDS) {
    if (!data[field] || String(data[field]).trim() === '') {
      missing.push(BATCH_FIELD_LABELS[field] || field);
    }
  }
  if (missing.length) {
    errors.push(`缺失必填项：${missing.join('、')}`);
  }

  if (data.quantity !== undefined && data.quantity !== '') {
    const qty = Number(data.quantity);
    if (isNaN(qty) || qty < 0) {
      errors.push('数量格式错误');
    }
  }

  if (data.expiresAt) {
    const date = new Date(data.expiresAt);
    if (isNaN(date.getTime())) {
      errors.push('有效期格式错误');
    }
  }

  let supplierId = null;
  if (data.supplier) {
    const supplier = db.suppliers?.find((s) => s.name === data.supplier);
    if (supplier) {
      supplierId = supplier.id;
    } else {
      errors.push(`供应商「${data.supplier}」不存在`);
    }
  }

  let cabinetId = null;
  if (data.cabinet) {
    const cabinet = db.cabinets?.find((c) => c.code === data.cabinet);
    if (cabinet) {
      cabinetId = cabinet.id;
    } else {
      errors.push(`柜位「${data.cabinet}」不存在`);
    }
  }

  const batchData = {
    name: data.name || '',
    category: data.category || '',
    batchNo: data.batchNo || '',
    supplierId: supplierId || '',
    cabinetId: cabinetId || '',
    safetyLevel: data.safetyLevel || '低',
    quantity: data.quantity ? Number(data.quantity) : 0,
    unit: data.unit || '罐',
    expiresAt: data.expiresAt || '',
    status: data.status || '可用'
  };

  let capacityError = null;
  if (batchData.cabinetId && batchData.quantity > 0 && errors.length === 0) {
    const capCheck = checkCabinetCapacity(db, batchData.cabinetId, batchData.quantity);
    if (!capCheck.ok) {
      capacityError = capCheck.error;
      errors.push(capacityError);
    }
  }

  return {
    rowIndex,
    data: batchData,
    raw: row,
    errors,
    isValid: errors.length === 0
  };
}

app.post('/api/batches/import-preview', requireUser, async (req, res) => {
  if (!checkPermission(req.currentUser, 'special', 'batches-import', res)) return;

  try {
    const { csvText } = req.body;
    if (!csvText || !csvText.trim()) {
      return res.status(400).json({ error: 'CSV内容不能为空' });
    }

    const db = await readDb();
    const { headers, rows } = parseCsv(csvText);

    if (!headers.length) {
      return res.status(400).json({ error: '无法解析CSV表头' });
    }

    const normalizedHeaders = headers.map(normalizeHeader);
    const results = rows.map((row, idx) => validateBatchRow(row, headers, db, idx + 2));

    const validRows = results.filter((r) => r.isValid);
    const errorRows = results.filter((r) => !r.isValid);

    const batchNos = validRows.map((r) => r.data.batchNo).filter(Boolean);
    const duplicateInCsv = [];
    const seen = new Set();
    for (const no of batchNos) {
      if (seen.has(no)) {
        if (!duplicateInCsv.includes(no)) duplicateInCsv.push(no);
      } else {
        seen.add(no);
      }
    }

    const duplicateInDb = [];
    for (const no of batchNos) {
      const exists = db.batches?.some((b) => b.batchNo === no);
      if (exists) duplicateInDb.push(no);
    }

    const allDuplicates = [...new Set([...duplicateInCsv, ...duplicateInDb])];

    validRows.forEach((r) => {
      if (allDuplicates.includes(r.data.batchNo)) {
        r.isValid = false;
        const dupType = [];
        if (duplicateInCsv.includes(r.data.batchNo)) dupType.push('CSV内重复');
        if (duplicateInDb.includes(r.data.batchNo)) dupType.push('系统已存在');
        r.errors.push(`批次号重复（${dupType.join('、')}）`);
      }
    });

    const finalValidRows = results.filter((r) => r.isValid);
    const finalErrorRows = results.filter((r) => !r.isValid);

    const missingCount = finalErrorRows.filter((r) =>
      r.errors.some((e) => e.includes('缺失必填项'))
    ).length;
    const quantityErrorCount = finalErrorRows.filter((r) =>
      r.errors.some((e) => e.includes('数量格式错误'))
    ).length;

    res.json({
      headers: normalizedHeaders,
      rawHeaders: headers,
      totalRows: rows.length,
      validCount: finalValidRows.length,
      errorCount: finalErrorRows.length,
      duplicateBatchNos: allDuplicates,
      missingCount,
      quantityErrorCount,
      validRows: finalValidRows,
      errorRows: finalErrorRows
    });
  } catch (err) {
    res.status(500).json({ error: '解析失败：' + err.message });
  }
});

app.post('/api/batches/import-confirm', requireUser, async (req, res) => {
  if (!checkPermission(req.currentUser, 'special', 'batches-import', res)) return;

  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: '没有可导入的数据' });
    }

    const operator = req.currentUser;
    const db = await readDb();
    const now = new Date().toISOString();
    const imported = [];
    const failed = [];

    for (const rowData of rows) {
      const batchNo = rowData.batchNo;
      if (db.batches.some((b) => b.batchNo === batchNo)) {
        failed.push({ batchNo, error: '批次号已存在' });
        continue;
      }

      const cabinetId = rowData.cabinetId;
      const addQty = Number(rowData.quantity || 0);
      if (cabinetId) {
        const capCheck = checkCabinetCapacity(db, cabinetId, addQty);
        if (!capCheck.ok) {
          failed.push({ batchNo, error: capCheck.error });
          continue;
        }
      }

      const item = {
        id: `batches-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
        name: rowData.name,
        category: rowData.category,
        batchNo: rowData.batchNo,
        supplierId: rowData.supplierId || '',
        cabinetId: rowData.cabinetId || '',
        safetyLevel: rowData.safetyLevel || '低',
        quantity: Number(rowData.quantity || 0),
        unit: rowData.unit || '罐',
        expiresAt: rowData.expiresAt,
        status: rowData.status || '可用',
        createdAt: now,
        updatedAt: now,
        createdBy: { id: operator.id, name: operator.name, role: operator.role, roleLabel: operator.roleLabel },
        history: [stamp('批量导入', `导入${rowData.quantity || 0}${rowData.unit || '罐'}`, operator)]
      };

      db.batches.push(item);
      imported.push(item);

      writeAuditLog(db, {
        actionType: '批量导入',
        collection: 'batches',
        targetId: item.id,
        targetItem: item,
        note: `批量导入批次，数量：${rowData.quantity || 0}${rowData.unit || '罐'}`,
        operator
      });
    }

    await writeDb(db);
    res.json({
      importedCount: imported.length,
      failedCount: failed.length,
      imported,
      failed
    });
  } catch (err) {
    res.status(500).json({ error: '导入失败：' + err.message });
  }
});

function computeCabinetOccupancy(db, cabinetId, excludeBatchId = null) {
  const cabinet = db.cabinets?.find((c) => c.id === cabinetId);
  if (!cabinet) return null;
  const capacity = Number(cabinet.capacity || 0);
  const occupiedQuantity = (db.batches || [])
    .filter((b) => b.cabinetId === cabinetId && b.id !== excludeBatchId && b.status !== '已报废')
    .reduce((sum, b) => sum + Number(b.quantity || 0), 0);
  return {
    cabinetId,
    cabinetCode: cabinet.code,
    cabinetArea: cabinet.area,
    capacity,
    occupiedQuantity,
    remainingQuantity: capacity - occupiedQuantity,
    occupancyRate: capacity > 0 ? Math.round((occupiedQuantity / capacity) * 100) : 0
  };
}

function checkCabinetCapacity(db, cabinetId, addQuantity, excludeBatchId = null) {
  const occ = computeCabinetOccupancy(db, cabinetId, excludeBatchId);
  if (!occ) return { ok: true };
  const qty = Number(addQuantity || 0);
  const newOccupied = occ.occupiedQuantity + qty;
  const finalOccupancy = {
    ...occ,
    occupiedQuantity: newOccupied,
    remainingQuantity: occ.capacity - newOccupied,
    occupancyRate: occ.capacity > 0 ? Math.round((newOccupied / occ.capacity) * 100) : 0
  };
  if (newOccupied > occ.capacity) {
    const diff = qty >= 0 ? `本次新增${qty}` : `本次调整${qty}`;
    return {
      ok: false,
      error: `柜位「${occ.cabinetCode}（${occ.cabinetArea}）」容量不足：容量${occ.capacity}，已占用${occ.occupiedQuantity}，${diff}，合计将占用${newOccupied}，超出${newOccupied - occ.capacity}`,
      occupancy: finalOccupancy
    };
  }
  return { ok: true, occupancy: finalOccupancy };
}

app.get('/api/cabinets/occupancy', async (req, res) => {
  const db = await readDb();
  const result = (db.cabinets || []).map((c) => computeCabinetOccupancy(db, c.id));
  res.json(result);
});

app.get('/api/cabinets/:id/occupancy', async (req, res) => {
  const db = await readDb();
  const occ = computeCabinetOccupancy(db, req.params.id);
  if (!occ) return res.status(404).json({ error: '柜位不存在' });
  res.json(occ);
});

const LEVEL_RANK = { '低': 1, '中': 2, '高': 3 };

function getBatchAvailableQuantity(batch) {
  const qty = Number(batch.quantity || 0);
  const reserved = Number(batch.reservedQuantity || 0);
  return Math.max(0, qty - reserved);
}

function aggregateBatchReservedByOthers(db, batchId, excludeScheduleId) {
  let reservedByOthers = 0;
  (db.schedules || []).forEach(s => {
    if (s.id === excludeScheduleId) return;
    if (!['调度已审批', '调度已出库'].includes(s.status)) return;
    (s.items || []).forEach(it => {
      if (it.batchId === batchId) {
        reservedByOthers += Number(it.reservedQuantity || 0);
      }
    });
  });
  return reservedByOthers;
}

function reserveScheduleBatches(db, schedule, operator, nowStr) {
  const results = { success: true, errors: [], batchSnapshots: {} };
  const batchReqMap = {};
  (schedule.items || []).forEach(item => {
    batchReqMap[item.batchId] = (batchReqMap[item.batchId] || 0) + Number(item.quantity || 0);
  });
  for (const [batchId, reqQty] of Object.entries(batchReqMap)) {
    const batch = db.batches.find(b => b.id === batchId);
    if (!batch) { results.errors.push(`批次[${batchId}]不存在`); continue; }
    results.batchSnapshots[batchId] = JSON.parse(JSON.stringify(batch));
    const reservedByOthers = aggregateBatchReservedByOthers(db, batchId, schedule.id);
    const theoreticalReserved = reservedByOthers + reqQty;
    const stockQty = Number(batch.quantity || 0);
    if (theoreticalReserved > stockQty) {
      const avail = Math.max(0, stockQty - reservedByOthers);
      results.errors.push(`批次「${batch.name}/${batch.batchNo}」可用库存${avail}${batch.unit || ''}（库存${stockQty}，其他调度单已预占${reservedByOthers}），本次申请${reqQty}，超出${reqQty - avail}`);
    }
  }
  if (results.errors.length) { results.success = false; return results; }
  (schedule.items || []).forEach(item => {
    const batch = db.batches.find(b => b.id === item.batchId);
    if (!batch) return;
    const qty = Number(item.quantity || 0);
    item.reservedQuantity = qty;
    batch.reservedQuantity = Number(batch.reservedQuantity || 0) + qty;
    batch.updatedAt = nowStr;
    batch.history = batch.history || [];
    batch.history.unshift(stamp('预占库存', `调度单：${schedule.code}，预占：+${qty}${batch.unit || ''}，累计预占：${batch.reservedQuantity}${batch.unit || ''}，可用：${getBatchAvailableQuantity(batch)}${batch.unit || ''}`, operator));
  });
  return results;
}

function releaseScheduleBatches(db, schedule, operator, nowStr, reason) {
  const batchSnapshots = {};
  (schedule.items || []).forEach(item => {
    const batch = db.batches.find(b => b.id === item.batchId);
    if (!batch) return;
    const toRelease = Number(item.reservedQuantity || 0);
    if (toRelease <= 0) return;
    batchSnapshots[batch.id] = batchSnapshots[batch.id] || JSON.parse(JSON.stringify(batch));
    batch.reservedQuantity = Math.max(0, Number(batch.reservedQuantity || 0) - toRelease);
    item.reservedQuantity = 0;
    batch.updatedAt = nowStr;
    batch.history = batch.history || [];
    batch.history.unshift(stamp('释放预占', `调度单：${schedule.code}，释放：-${toRelease}${batch.unit || ''}${reason ? '，原因：' + reason : ''}，剩余预占：${batch.reservedQuantity}${batch.unit || ''}，可用：${getBatchAvailableQuantity(batch)}${batch.unit || ''}`, operator));
  });
  return batchSnapshots;
}


function validateScheduleItems(db, items, currentScheduleId) {
  const errors = [];
  if (!Array.isArray(items) || items.length === 0) {
    errors.push('至少需要一条用药明细');
    return { errors, validated: [] };
  }
  const validated = [];
  const batchReqAggregate = {};
  items.forEach((item, idx) => {
    const lineNo = idx + 1;
    if (!item.batchId) {
      errors.push(`第${lineNo}行：请选择药剂批次`);
      return;
    }
    const batch = db.batches.find((b) => b.id === item.batchId);
    if (!batch) {
      errors.push(`第${lineNo}行：药剂批次不存在`);
      return;
    }
    const qty = Number(item.quantity || 0);
    if (qty <= 0) {
      errors.push(`第${lineNo}行：领用数量必须大于0`);
      return;
    }
    if (!item.sprayPoint || String(item.sprayPoint).trim() === '') {
      errors.push(`第${lineNo}行：请填写喷点/使用位置`);
      return;
    }
    const reqLevel = item.safetyLevel || '低';
    if (LEVEL_RANK[batch.safetyLevel] < LEVEL_RANK[reqLevel]) {
      errors.push(`第${lineNo}行：批次安全等级(${batch.safetyLevel})低于所需等级(${reqLevel})`);
    }
    batchReqAggregate[item.batchId] = (batchReqAggregate[item.batchId] || 0) + qty;
    validated.push({
      batchId: item.batchId,
      batch,
      sprayPoint: String(item.sprayPoint || '').trim(),
      safetyLevel: reqLevel,
      quantity: qty,
      returned: 0,
      wasted: 0,
      reservedQuantity: 0
    });
  });
  for (const [batchId, totalReq] of Object.entries(batchReqAggregate)) {
    const batch = db.batches.find((b) => b.id === batchId);
    if (!batch) continue;
    const reservedByOthers = aggregateBatchReservedByOthers(db, batchId, currentScheduleId);
    const stockQty = Number(batch.quantity || 0);
    const available = Math.max(0, stockQty - reservedByOthers);
    if (totalReq > available) {
      errors.push(`批次「${batch.name}/${batch.batchNo}」可用${available}${batch.unit || ''}（库存${stockQty}，已预占${reservedByOthers}），本次申请${totalReq}${batch.unit || ''}，超出${totalReq - available}${batch.unit || ''}`);
    }
  }
  return { errors, validated };
}

app.post('/api/schedules', requireUser, async (req, res) => {
  if (!checkPermission(req.currentUser, 'create', 'schedules', res)) return;

  const db = await readDb();
  if (!db.schedules) db.schedules = [];

  const { code, projectId, useWindow, operator, note, items } = req.body;
  if (!code || String(code).trim() === '') return res.status(409).json({ error: '调度单号不能为空' });
  if (!projectId) return res.status(409).json({ error: '请选择演出项目' });
  if (!useWindow || String(useWindow).trim() === '') return res.status(409).json({ error: '使用时段不能为空' });
  if (!operator || String(operator).trim() === '') return res.status(409).json({ error: '操作人员不能为空' });

  const project = db.projects.find((p) => p.id === projectId);
  if (!project) return res.status(409).json({ error: '演出项目不存在' });

  const { errors, validated } = validateScheduleItems(db, items);
  if (errors.length) return res.status(409).json({ error: errors.join('；') });

  const existing = db.schedules.find((s) => s.code === code);
  if (existing) return res.status(409).json({ error: '调度单号已存在' });

  const now = new Date().toISOString();
  const op = req.currentUser;
  const totalQty = validated.reduce((sum, it) => sum + it.quantity, 0);

  const schedule = {
    id: `schedules-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    code: String(code).trim(),
    projectId,
    showName: project.name || '',
    venue: project.venue || '',
    useWindow: String(useWindow).trim(),
    operator: String(operator).trim(),
    note: note || '',
    status: '调度待审批',
    totalQuantity: totalQty,
    totalReturned: 0,
    totalWasted: 0,
    items: validated.map((v) => ({
      batchId: v.batchId,
      sprayPoint: v.sprayPoint,
      safetyLevel: v.safetyLevel,
      quantity: v.quantity,
      returned: 0,
      wasted: 0,
      reservedQuantity: 0
    })),
    createdAt: now,
    updatedAt: now,
    createdBy: { id: op.id, name: op.name, role: op.role, roleLabel: op.roleLabel },
    history: [stamp('调度创建', `调度单：${code}，演出：${project.name || ''}，共${validated.length}条明细，合计${totalQty}单位`, op)]
  };

  db.schedules.push(schedule);
  writeAuditLog(db, {
    actionType: '调度创建',
    collection: 'schedules',
    targetId: schedule.id,
    targetItem: schedule,
    note: `演出：${project.name || ''}，明细${validated.length}条，合计${totalQty}单位`,
    operator: op
  });
  await writeDb(db);
  res.status(201).json(schedule);
});

app.post('/api/schedules/:id/approve', requireUser, async (req, res) => {
  if (!checkPermission(req.currentUser, 'special', 'schedules-approve', res)) return;

  const db = await readDb();
  const { id } = req.params;
  const schedule = db.schedules?.find((s) => s.id === id);
  if (!schedule) return res.status(404).json({ error: '调度单不存在' });
  if (schedule.status !== '调度待审批') return res.status(409).json({ error: '只有调度待审批状态可以审批' });

  const now = new Date();
  const errors = [];
  (schedule.items || []).forEach((item, idx) => {
    const lineNo = idx + 1;
    const batch = db.batches.find((b) => b.id === item.batchId);
    if (!batch) {
      errors.push(`第${lineNo}行：关联批次不存在`);
      return;
    }
    if (batch.status !== '可用') {
      errors.push(`第${lineNo}行：批次「${batch.name}/${batch.batchNo}」状态为「${batch.status}」，不可出库`);
    }
    if (batch.expiresAt) {
      const expire = new Date(batch.expiresAt);
      if (expire < now) {
        errors.push(`第${lineNo}行：批次「${batch.name}/${batch.batchNo}」已过期`);
      }
    }
    if (LEVEL_RANK[batch.safetyLevel] < LEVEL_RANK[item.safetyLevel]) {
      errors.push(`第${lineNo}行：批次安全等级(${batch.safetyLevel})低于所需等级(${item.safetyLevel})`);
    }
  });

  if (errors.length) return res.status(409).json({ error: errors.join('；') });

  const op = req.currentUser;
  const nowStr = now.toISOString();
  const approverLabel = `${op.name}（${op.roleLabel}）`;
  const beforeSchedule = JSON.parse(JSON.stringify(schedule));

  const reserveResult = reserveScheduleBatches(db, schedule, op, nowStr);
  if (!reserveResult.success) {
    return res.status(409).json({ error: reserveResult.errors.join('；') });
  }

  schedule.status = '调度已审批';
  schedule.approver = approverLabel;
  schedule.approverInfo = { id: op.id, name: op.name, role: op.role, roleLabel: op.roleLabel };
  schedule.approvedAt = nowStr;
  schedule.updatedAt = nowStr;
  schedule.history = schedule.history || [];
  const totalReserved = (schedule.items || []).reduce((s, it) => s + Number(it.reservedQuantity || 0), 0);
  schedule.history.unshift(stamp('调度审批通过', `审批人：${approverLabel}，共${schedule.items.length}条明细，预占库存合计${totalReserved}单位`, op));

  writeAuditLog(db, {
    actionType: '调度审批通过',
    collection: 'schedules',
    targetId: schedule.id,
    targetItem: schedule,
    beforeItem: beforeSchedule,
    note: `审批人：${approverLabel}，共${schedule.items.length}条明细，预占${totalReserved}单位`,
    operator: op
  });

  Object.entries(reserveResult.batchSnapshots).forEach(([batchId, beforeBatch]) => {
    const batch = db.batches.find((b) => b.id === batchId);
    if (!batch) return;
    writeAuditLog(db, {
      actionType: '预占库存',
      collection: 'batches',
      targetId: batch.id,
      targetItem: batch,
      beforeItem: beforeBatch,
      note: `调度单：${schedule.code}，预占库存：${schedule.items.filter(i => i.batchId === batchId).reduce((s,i)=>s+Number(i.reservedQuantity||0),0)}${batch.unit || ''}，累计预占：${batch.reservedQuantity}${batch.unit || ''}，可用：${getBatchAvailableQuantity(batch)}${batch.unit || ''}`,
      operator: op
    });
  });

  await writeDb(db);
  res.json(schedule);
});

app.post('/api/schedules/:id/issue', requireUser, async (req, res) => {
  if (!checkPermission(req.currentUser, 'special', 'schedules-issue', res)) return;

  const db = await readDb();
  const { id } = req.params;
  const schedule = db.schedules?.find((s) => s.id === id);
  if (!schedule) return res.status(404).json({ error: '调度单不存在' });
  if (schedule.status !== '调度已审批') return res.status(409).json({ error: '只有调度已审批状态可以出库' });

  const now = new Date();
  const errors = [];
  const batchQtyMap = {};
  (schedule.items || []).forEach((item, idx) => {
    const lineNo = idx + 1;
    const batch = db.batches.find((b) => b.id === item.batchId);
    if (!batch) {
      errors.push(`第${lineNo}行：关联批次不存在`);
      return;
    }
    if (batch.status !== '可用') {
      errors.push(`第${lineNo}行：批次「${batch.name}/${batch.batchNo}」状态为「${batch.status}」，不可出库`);
    }
    batchQtyMap[item.batchId] = (batchQtyMap[item.batchId] || 0) + Number(item.quantity || 0);
  });

  Object.entries(batchQtyMap).forEach(([batchId, totalQty]) => {
    const batch = db.batches.find((b) => b.id === batchId);
    if (!batch) return;
    const reservedByOthers = aggregateBatchReservedByOthers(db, batchId, schedule.id);
    const stockQty = Number(batch.quantity || 0);
    const availableForThis = stockQty - reservedByOthers;
    if (totalQty > stockQty) {
      errors.push(`批次「${batch.name}/${batch.batchNo}」调度申请合计${totalQty}${batch.unit || ''}，超过当前库存${stockQty}${batch.unit || ''}`);
    } else if (totalQty > availableForThis) {
      errors.push(`批次「${batch.name}/${batch.batchNo}」扣除其他预占后可用${availableForThis}${batch.unit || ''}（库存${stockQty}，其他预占${reservedByOthers}），本次申请${totalQty}${batch.unit || ''}，请先关闭其他调度单`);
    }
  });

  if (errors.length) return res.status(409).json({ error: errors.join('；') });

  const op = req.currentUser;
  const nowStr = now.toISOString();
  const issuerLabel = `${op.name}（${op.roleLabel}）`;
  const beforeSchedule = JSON.parse(JSON.stringify(schedule));
  const batchSnapshots = {};
  (schedule.items || []).forEach((item) => {
    const b = db.batches.find((x) => x.id === item.batchId);
    if (b) batchSnapshots[b.id] = JSON.parse(JSON.stringify(b));
  });

  releaseScheduleBatches(db, schedule, op, nowStr, '调度出库，转为实际扣减');

  (schedule.items || []).forEach((item) => {
    const batch = db.batches.find((b) => b.id === item.batchId);
    if (batch) {
      const currentQty = Number(batch.quantity || 0);
      batch.quantity = currentQty - item.quantity;
      batch.updatedAt = nowStr;
      batch.history = batch.history || [];
      batch.history.unshift(stamp('调度出库', `调度单：${schedule.code}，出库：-${item.quantity}${batch.unit || ''}，剩余：${batch.quantity}${batch.unit || ''}`, op));
    }
  });

  schedule.status = '调度已出库';
  schedule.issuer = issuerLabel;
  schedule.issuerInfo = { id: op.id, name: op.name, role: op.role, roleLabel: op.roleLabel };
  schedule.issuedAt = nowStr;
  schedule.updatedAt = nowStr;
  schedule.history = schedule.history || [];
  const issuedQty = (schedule.items || []).reduce((s, it) => s + it.quantity, 0);
  schedule.history.unshift(stamp('调度出库', `出库人：${issuerLabel}，共${schedule.items.length}条明细，合计出库${issuedQty}单位`, op));

  writeAuditLog(db, {
    actionType: '调度出库',
    collection: 'schedules',
    targetId: schedule.id,
    targetItem: schedule,
    beforeItem: beforeSchedule,
    note: `出库人：${issuerLabel}，共${schedule.items.length}条明细，合计${issuedQty}单位`,
    operator: op
  });

  Object.entries(batchSnapshots).forEach(([batchId, beforeBatch]) => {
    const batch = db.batches.find((b) => b.id === batchId);
    if (!batch) return;
    const schedQty = (schedule.items || []).filter(i => i.batchId === batchId).reduce((s, i) => s + Number(i.quantity || 0), 0);
    writeAuditLog(db, {
      actionType: '调度出库(关联)',
      collection: 'batches',
      targetId: batch.id,
      targetItem: batch,
      beforeItem: beforeBatch,
      note: `调度单：${schedule.code}，出库：-${schedQty}${batch.unit || ''}，已同步释放预占`,
      operator: op
    });
  });

  await writeDb(db);
  res.json(schedule);
});

app.post('/api/schedules/:id/return', requireUser, async (req, res) => {
  if (!checkPermission(req.currentUser, 'special', 'schedules-return', res)) return;

  const db = await readDb();
  const { id } = req.params;
  const schedule = db.schedules?.find((s) => s.id === id);
  if (!schedule) return res.status(404).json({ error: '调度单不存在' });
  if (schedule.status !== '调度已出库') return res.status(409).json({ error: '只有调度已出库状态可以回库' });

  const { items: returnItems } = req.body;
  if (!Array.isArray(returnItems) || returnItems.length === 0) {
    return res.status(409).json({ error: '请填写回库明细' });
  }

  const errors = [];
  const returnMap = {};
  returnItems.forEach((ri, idx) => {
    const lineNo = idx + 1;
    if (!ri.batchId) { errors.push(`第${lineNo}行：缺少batchId`); return; }
    const returned = Number(ri.returned || 0);
    const wasted = Number(ri.wasted || 0);
    if (returned < 0 || wasted < 0) {
      errors.push(`第${lineNo}行：回库/报废数量不能为负数`);
      return;
    }
    const schedItem = (schedule.items || []).find((it) => it.batchId === ri.batchId);
    if (!schedItem) {
      errors.push(`第${lineNo}行：批次不在该调度单明细中`);
      return;
    }
    if (returned + wasted > schedItem.quantity) {
      errors.push(`第${lineNo}行：回库(${returned})+报废(${wasted})不能超过出库数量(${schedItem.quantity})`);
      return;
    }
    returnMap[ri.batchId] = { returned, wasted };
  });

  if (errors.length) return res.status(409).json({ error: errors.join('；') });

  const op = req.currentUser;
  const nowStr = new Date().toISOString();
  const returnerLabel = `${op.name}（${op.roleLabel}）`;
  const beforeSchedule = JSON.parse(JSON.stringify(schedule));
  const batchSnapshots = {};

  let totalReturned = 0;
  let totalWasted = 0;

  (schedule.items || []).forEach((item) => {
    const rm = returnMap[item.batchId];
    if (rm) {
      item.returned = rm.returned;
      item.wasted = rm.wasted;
      totalReturned += rm.returned;
      totalWasted += rm.wasted;
      const batch = db.batches.find((b) => b.id === item.batchId);
      if (batch) {
        batchSnapshots[batch.id] = JSON.parse(JSON.stringify(batch));
        const currentQty = Number(batch.quantity || 0);
        batch.quantity = currentQty + rm.returned;
        batch.updatedAt = nowStr;
        batch.history = batch.history || [];
        batch.history.unshift(stamp('调度回库', `调度单：${schedule.code}，回库：+${rm.returned}${batch.unit || ''}，报废：${rm.wasted}${batch.unit || ''}，现有：${batch.quantity}${batch.unit || ''}`, op));
      }
    }
  });

  schedule.totalReturned = totalReturned;
  schedule.totalWasted = totalWasted;
  schedule.status = '调度已回库';
  schedule.returner = returnerLabel;
  schedule.returnerInfo = { id: op.id, name: op.name, role: op.role, roleLabel: op.roleLabel };
  schedule.returnedAt = nowStr;
  schedule.updatedAt = nowStr;
  schedule.history = schedule.history || [];
  releaseScheduleBatches(db, schedule, op, nowStr, '调度回库闭环');
  schedule.history.unshift(stamp('调度回库', `回库人：${returnerLabel}，回库合计：${totalReturned}，报废合计：${totalWasted}`, op));

  writeAuditLog(db, {
    actionType: '调度回库',
    collection: 'schedules',
    targetId: schedule.id,
    targetItem: schedule,
    beforeItem: beforeSchedule,
    note: `回库合计：${totalReturned}，报废合计：${totalWasted}`,
    operator: op
  });

  Object.keys(batchSnapshots).forEach((bid) => {
    const batch = db.batches.find((b) => b.id === bid);
    if (batch) {
      writeAuditLog(db, {
        actionType: '调度回库(关联)',
        collection: 'batches',
        targetId: batch.id,
        targetItem: batch,
        beforeItem: batchSnapshots[bid],
        note: `调度单：${schedule.code}`,
        operator: op
      });
    }
  });

  await writeDb(db);
  res.json(schedule);
});

app.delete('/api/schedules/:id', requireUser, async (req, res) => {
  const db = await readDb();
  const { id } = req.params;
  if (!db.schedules) return res.status(404).json({ error: 'unknown collection' });
  if (!checkPermission(req.currentUser, 'delete', 'schedules', res)) return;
  const schedule = db.schedules.find((s) => s.id === id);
  if (!schedule) return res.status(404).json({ error: 'not found' });
  if (['调度已出库', '调度已回库'].includes(schedule.status)) {
    return res.status(409).json({ error: '已出库或已回库的调度单不能删除' });
  }
  const operator = req.currentUser;
  const nowStr = new Date().toISOString();
  const extraBatchSnapshots = {};
  if (schedule.status === '调度已审批') {
    Object.assign(extraBatchSnapshots, releaseScheduleBatches(db, schedule, operator, nowStr, '删除调度单'));
  }
  writeAuditLog(db, {
    actionType: '删除',
    collection: 'schedules',
    targetId: id,
    beforeItem: schedule,
    note: '删除调度单',
    operator
  });
  Object.entries(extraBatchSnapshots).forEach(([batchId, beforeBatch]) => {
    const batch = db.batches.find((b) => b.id === batchId);
    if (!batch) return;
    writeAuditLog(db, {
      actionType: '释放预占',
      collection: 'batches',
      targetId: batch.id,
      targetItem: batch,
      beforeItem: beforeBatch,
      note: `调度单：${schedule.code || schedule.id}，原因：删除调度单`,
      operator
    });
  });
  db.schedules = db.schedules.filter((s) => s.id !== id);
  await writeDb(db);
  res.status(204).end();
});

app.get('/api/batches/:id/waste-prefill', requireUser, async (req, res) => {
  const db = await readDb();
  const batch = db.batches?.find((b) => b.id === req.params.id);
  if (!batch) return res.status(404).json({ error: '批次不存在' });
  if (batch.status === '已报废') return res.status(409).json({ error: '该批次已报废' });

  const stocktakeId = req.query.stocktakeId || null;
  let stocktakeInfo = null;
  let deficitQty = 0;
  let alertType = 'normal';
  let reasonPrefix = '';

  if (stocktakeId) {
    const stocktake = db.stocktakes?.find((s) => s.id === stocktakeId);
    if (stocktake) {
      const diffItem = (stocktake.diffSuggestions || []).find((d) => d.batchId === batch.id);
      if (diffItem) {
        deficitQty = Math.abs(diffItem.difference || 0);
        stocktakeInfo = {
          stocktakeId: stocktake.id,
          stocktakeCode: stocktake.code || '',
          stocktakeTitle: stocktake.title || '',
          deficitQty
        };
        alertType = 'stocktake-deficit';
        reasonPrefix = `盘点盘亏${deficitQty}${batch.unit || ''}`;
      }
    }
  }

  if (!stocktakeInfo) {
    const now = new Date();
    const expiringDays = config.alerts?.expiringDays || 30;
    const expireDate = batch.expiresAt ? new Date(batch.expiresAt) : null;

    if (expireDate) {
      if (expireDate < now) {
        alertType = 'expired';
        const daysExpired = Math.ceil((now - expireDate) / (1000 * 60 * 60 * 24));
        reasonPrefix = `已过期${daysExpired}天`;
      } else {
        const daysLeft = Math.ceil((expireDate - now) / (1000 * 60 * 60 * 24));
        if (daysLeft <= expiringDays) {
          alertType = 'expiring';
          reasonPrefix = `临期（还有${daysLeft}天过期）`;
        } else {
          reasonPrefix = '库存批次';
        }
      }
    } else {
      reasonPrefix = '库存批次';
    }
  }

  const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const existingCount = (db.wastes || []).filter((w) => w.code && w.code.includes(todayStr)).length;
  const seqNum = String(existingCount + 1).padStart(3, '0');
  const suggestedCode = `BF${todayStr}${seqNum}`;

  const batchTitle = [batch.name, batch.batchNo].filter(Boolean).join(' / ');
  const suggestedTitle = stocktakeInfo
    ? `【盘点盘亏】${stocktakeInfo.stocktakeCode || stocktake.id} - ${batchTitle}报废申请`
    : `【${reasonPrefix}】${batchTitle}报废申请`;
  const stocktakeNote = stocktakeInfo
    ? `盘点单：${stocktakeInfo.stocktakeCode || stocktakeInfo.stocktakeId}${stocktakeInfo.stocktakeTitle ? '（' + stocktakeInfo.stocktakeTitle + '）' : ''}，盘亏数量：${deficitQty}${batch.unit || ''}。`
    : '';
  const suggestedReason = stocktakeInfo
    ? `${reasonPrefix}，建议补登记报废。${stocktakeNote}批次：${batch.batchNo}，品名：${batch.name}，当前库存：${batch.quantity || 0}${batch.unit || ''}，有效期：${batch.expiresAt || '未设置'}。`
    : `${reasonPrefix}，建议报废。批次：${batch.batchNo}，品名：${batch.name}，规格：${batch.quantity || 0}${batch.unit || ''}，有效期：${batch.expiresAt || '未设置'}。`;

  const supplier = db.suppliers?.find((s) => s.id === batch.supplierId);
  const cabinet = db.cabinets?.find((c) => c.id === batch.cabinetId);

  const prefQty = deficitQty > 0 ? deficitQty : getBatchAvailableQuantity(batch);

  res.json({
    batchId: batch.id,
    batchName: batch.name,
    batchNo: batch.batchNo,
    category: batch.category || '',
    safetyLevel: batch.safetyLevel || '',
    quantity: prefQty,
    unit: batch.unit || '',
    expiresAt: batch.expiresAt || '',
    status: batch.status || '',
    supplierId: batch.supplierId || '',
    supplierName: supplier?.name || '',
    cabinetId: batch.cabinetId || '',
    cabinetCode: cabinet?.code || '',
    cabinetArea: cabinet?.area || '',
    alertType,
    suggestedCode,
    suggestedTitle,
    suggestedReason,
    stocktakeId: stocktakeId,
    stocktakeInfo,
    reservedQuantity: Number(batch.reservedQuantity || 0),
    availableQuantity: getBatchAvailableQuantity(batch),
    maxQuantity: getBatchAvailableQuantity(batch)
  });
});

app.post('/api/stocktakes/:stocktakeId/mark-note/:batchId', requireUser, async (req, res) => {
  if (!checkPermission(req.currentUser, 'special', 'stocktakes-items', res)) return;

  const db = await readDb();
  const { stocktakeId, batchId } = req.params;
  const stocktake = db.stocktakes?.find((s) => s.id === stocktakeId);
  if (!stocktake) return res.status(404).json({ error: '盘点单不存在' });
  if (stocktake.status !== '已确认') return res.status(409).json({ error: '只有已确认的盘点单可以标记差异处理' });

  const operator = req.currentUser;
  const now = new Date().toISOString();
  const batch = db.batches?.find((b) => b.id === batchId);
  if (!batch) return res.status(404).json({ error: '批次不存在' });

  let updated = false;
  if (stocktake.diffSuggestions) {
    const diffItem = stocktake.diffSuggestions.find((d) => d.batchId === batchId);
    if (diffItem && diffItem.needAction === 'stockInNote' && diffItem.actionStatus === 'pending') {
      diffItem.actionStatus = 'completed';
      updated = true;
    }
  }
  if (stocktake.items) {
    const stocktakeItem = stocktake.items.find((i) => i.batchId === batchId);
    if (stocktakeItem && stocktakeItem.needAction === 'stockInNote' && stocktakeItem.actionStatus === 'pending') {
      stocktakeItem.actionStatus = 'completed';
      updated = true;
    }
  }

  if (!updated) {
    return res.status(409).json({ error: '该批次无需标记或已处理' });
  }

  if (stocktake.suggestionSummary) {
    stocktake.suggestionSummary.stockInNotedCount = (stocktake.suggestionSummary.stockInNotedCount || 0) + 1;
    stocktake.suggestionSummary.pendingCount = Math.max(0, (stocktake.suggestionSummary.pendingCount || 0) - 1);
    stocktake.suggestionSummary.completedCount = (stocktake.suggestionSummary.completedCount || 0) + 1;
  }

  stocktake.updatedAt = now;
  stocktake.history = stocktake.history || [];
  stocktake.history.unshift(stamp('差异处理', `盘盈批次「${batch.name} / ${batch.batchNo}」已补入库备注`, operator));

  writeAuditLog(db, {
    actionType: '盘点差异处理',
    collection: 'stocktakes',
    targetId: stocktake.id,
    targetItem: stocktake,
    note: `盘盈批次「${batch.name} / ${batch.batchNo}」已补入库备注`,
    operator
  });

  await writeDb(db);
  res.json(stocktake);
});

app.get('/api/batches/availability', async (req, res) => {
  const db = await readDb();
  const result = (db.batches || []).map(batch => {
    const reservedQty = Number(batch.reservedQuantity || 0);
    const stockQty = Number(batch.quantity || 0);
    return {
      id: batch.id,
      name: batch.name,
      batchNo: batch.batchNo,
      status: batch.status,
      quantity: stockQty,
      reservedQuantity: reservedQty,
      availableQuantity: Math.max(0, stockQty - reservedQty),
      unit: batch.unit || '',
      safetyLevel: batch.safetyLevel,
      expiresAt: batch.expiresAt
    };
  });
  res.json(result);
});

function escapeCsvField(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function summarizeChanges(changes) {
  if (!changes || typeof changes !== 'object') return '';
  const keys = Object.keys(changes);
  if (!keys.length) return '';
  return keys.map((key) => {
    const c = changes[key];
    const before = c?.before === undefined || c?.before === null || c?.before === '' ? '(空)' : String(c.before);
    const after = c?.after === undefined || c?.after === null || c?.after === '' ? '(空)' : String(c.after);
    return `${key}: ${before} → ${after}`;
  }).join('；');
}

app.get('/api/audit-logs/export', requireUser, async (req, res) => {
  const db = await readDb();
  let logs = [...(db.auditLogs || [])];

  const actionType = req.query.actionType || '';
  const targetCollection = req.query.targetCollection || '';
  const keyword = (req.query.search || '').trim();

  if (actionType) {
    logs = logs.filter((log) => log.actionType === actionType);
  }
  if (targetCollection) {
    logs = logs.filter((log) => log.targetCollection === targetCollection);
  }
  if (keyword) {
    logs = logs.filter((log) => {
      const inLabel = (log.targetLabel || '').includes(keyword);
      const inNote = (log.note || '').includes(keyword);
      const inOperator = (log.operator || '').includes(keyword);
      const inId = (log.targetId || '').includes(keyword);
      const inAction = (log.actionType || '').includes(keyword);
      return inLabel || inNote || inOperator || inId || inAction;
    });
  }

  const headers = ['操作时间', '操作类型', '目标集合', '目标标题', '操作人', '备注', '字段变化摘要'];
  const rows = logs.map((log) => [
    log.createdAt ? new Date(log.createdAt).toLocaleString('zh-CN', { hour12: false }) : '',
    log.actionType || '',
    collectionLabel(log.targetCollection) || log.targetCollection || '',
    log.targetLabel || log.targetId || '',
    log.operator && log.operator !== SYSTEM_IMPORT_LABEL ? log.operator : SYSTEM_IMPORT_LABEL,
    log.note || '',
    summarizeChanges(log.changes)
  ]);

  const csvContent = [headers, ...rows]
    .map((row) => row.map(escapeCsvField).join(','))
    .join('\r\n');

  const bom = '\uFEFF';
  const filename = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(bom + csvContent);
});

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
