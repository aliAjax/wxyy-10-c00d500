const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const config = require('./project.config');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

function stamp(action, note) {
  return {
    at: new Date().toISOString(),
    action,
    note: note || ''
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

function writeAuditLog(db, options) {
  const { actionType, collection, targetId, targetItem, beforeItem, changes, note, operator } = options;
  if (!db[AUDIT_COLLECTION]) db[AUDIT_COLLECTION] = [];
  const item = targetItem || beforeItem;
  const log = {
    id: `${AUDIT_COLLECTION}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    actionType,
    targetCollection: collection,
    targetId,
    targetLabel: getTargetLabel(item, collection),
    changes: changes || computeChanges(beforeItem, targetItem),
    note: note || '',
    operator: operator || '',
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

app.post('/api/:collection', async (req, res) => {
  const db = await readDb();
  const { collection } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });

  const now = new Date().toISOString();
  let item;

  if (collection === 'wastes') {
    const batch = db.batches.find((b) => b.id === req.body.batchId);
    if (!batch) return res.status(409).json({ error: '批次不存在' });
    if (batch.status === '已报废') return res.status(409).json({ error: '该批次已报废，无法创建报废单' });
    const wasteQty = Number(req.body.quantity || 0);
    const stockQty = Number(batch.quantity || 0);
    if (wasteQty <= 0) return res.status(409).json({ error: '报废数量必须大于0' });
    if (wasteQty > stockQty) return res.status(409).json({ error: `报废数量(${wasteQty})超过当前库存(${stockQty})` });
    item = {
      id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      ...req.body,
      status: '待审批',
      actualQuantity: 0,
      createdAt: now,
      updatedAt: now,
      history: [stamp('创建申请', `批次：${batch.name} / ${batch.batchNo}，申请报废：${req.body.quantity}${batch.unit || ''}，原因：${req.body.reason || '未填写'}`)]
    };
  } else {
    item = {
      id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      ...req.body,
      createdAt: now,
      updatedAt: now,
      history: [stamp('创建', req.body.note || req.body.memo || '')]
    };
  }

  db[collection].push(item);
  writeAuditLog(db, {
    actionType: '创建',
    collection,
    targetId: item.id,
    targetItem: item,
    note: req.body.note || req.body.memo || ''
  });
  await writeDb(db);
  res.status(201).json(item);
});

app.patch('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });

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
      if (newQty <= 0) return res.status(409).json({ error: '报废数量必须大于0' });
      if (newQty > stockQty) return res.status(409).json({ error: `报废数量(${newQty})超过当前库存(${stockQty})` });
    }
  }

  const beforeItem = { ...item };
  const historyAction = req.body.historyAction;
  delete req.body.historyAction;
  Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
  item.history = item.history || [];
  if (historyAction || req.body.note || req.body.memo || req.body.status) {
    item.history.unshift(stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || ''));
  }
  const trackedFields = ['status', 'quantity', 'note', 'memo', 'name', 'code', 'title'];
  writeAuditLog(db, {
    actionType: historyAction || '更新',
    collection,
    targetId: id,
    targetItem: item,
    beforeItem,
    changes: computeChanges(beforeItem, item, trackedFields),
    note: req.body.note || req.body.memo || ''
  });
  await writeDb(db);
  res.json(item);
});

app.delete('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });

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
    note: '删除记录'
  });
  db[collection] = db[collection].filter((entry) => entry.id !== id);
  await writeDb(db);
  res.status(204).end();
});

app.post('/api/action/:actionId/:id', async (req, res) => {
  const db = await readDb();
  const action = config.actions.find((entry) => entry.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'unknown action' });
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

  const result = runAction(db, action, item);
  if (result.error) return res.status(409).json({ error: result.error });

  writeAuditLog(db, {
    actionType: action.label,
    collection: action.collection,
    targetId: item.id,
    targetItem: item,
    beforeItem,
    note: action.note || '状态流转'
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
        note: `由 ${collectionLabel(action.collection)} 操作触发：${action.label}`
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

function runAction(db, action, item) {
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
    target.history.unshift(stamp(action.label, action.note || '状态流转'));
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
    target.history.unshift(stamp(action.label, action.note || '数量调整'));
  }
  return { item };
}

app.post('/api/stocktakes/:id/confirm', async (req, res) => {
  const db = await readDb();
  const { id } = req.params;
  const stocktake = db.stocktakes?.find((entry) => entry.id === id);
  if (!stocktake) return res.status(404).json({ error: '盘点单不存在' });
  if (stocktake.status === '已确认') return res.status(409).json({ error: '该盘点单已确认，不可重复确认' });
  if (!Array.isArray(stocktake.items) || stocktake.items.length === 0) {
    return res.status(409).json({ error: '盘点单还没有录入任何批次，请先完成录入' });
  }

  const now = new Date().toISOString();
  const confirmedBy = req.body.confirmedBy || stocktake.operator || '系统';

  let surplusCount = 0;
  let deficitCount = 0;
  let surplusQty = 0;
  let deficitQty = 0;

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
      batch.history.unshift(stamp('盘点调整', `${diffText}，盘点单：${stocktake.code || stocktake.id}${remarkText}`));

      if (diff > 0) {
        surplusCount++;
        surplusQty += diff;
      } else {
        deficitCount++;
        deficitQty += Math.abs(diff);
      }
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
  stocktake.status = '已确认';
  stocktake.confirmedAt = now;
  stocktake.confirmedBy = confirmedBy;
  stocktake.updatedAt = now;
  stocktake.history = stocktake.history || [];

  const noteParts = [];
  noteParts.push(`差异项${diffCount}项`);
  if (surplusCount) noteParts.push(`盘盈${surplusCount}项(+${surplusQty})`);
  if (deficitCount) noteParts.push(`盘亏${deficitCount}项(-${deficitQty})`);
  noteParts.push('已同步更新批次库存');
  stocktake.history.unshift(stamp('确认', noteParts.join('，')));

  writeAuditLog(db, {
    actionType: '盘点确认',
    collection: 'stocktakes',
    targetId: stocktake.id,
    targetItem: stocktake,
    note: noteParts.join('，'),
    operator: confirmedBy
  });

  await writeDb(db);
  res.json(stocktake);
});

app.post('/api/wastes/:id/approve', async (req, res) => {
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
  if (wasteQty <= 0) return res.status(409).json({ error: '报废数量必须大于0' });
  if (wasteQty > stockQty) return res.status(409).json({ error: `报废数量(${wasteQty})超过当前库存(${stockQty})` });

  const now = new Date().toISOString();
  const approver = req.body.approver || '系统';

  const beforeWaste = { ...waste };
  const beforeBatch = { ...batch };

  waste.status = '待处置';
  waste.approver = approver;
  waste.approvedAt = now;
  waste.updatedAt = now;
  waste.history = waste.history || [];
  waste.history.unshift(stamp('审批通过', `审批人：${approver}，报废数量：${wasteQty}${batch.unit || ''}`));

  batch.updatedAt = now;
  batch.history = batch.history || [];
  batch.history.unshift(stamp('报废审批通过', `报废单：${waste.code || waste.id}，申请报废：${wasteQty}${batch.unit || ''}`));

  writeAuditLog(db, {
    actionType: '审批通过',
    collection: 'wastes',
    targetId: waste.id,
    targetItem: waste,
    beforeItem: beforeWaste,
    note: `审批人：${approver}，报废数量：${wasteQty}${batch.unit || ''}`,
    operator: approver
  });

  writeAuditLog(db, {
    actionType: '报废审批(关联)',
    collection: 'batches',
    targetId: batch.id,
    targetItem: batch,
    beforeItem: beforeBatch,
    note: `报废单：${waste.code || waste.id}，申请报废：${wasteQty}${batch.unit || ''}`
  });

  await writeDb(db);
  res.json(waste);
});

app.post('/api/wastes/:id/dispose', async (req, res) => {
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
  const operator = req.body.operator || '系统';

  const wasteQty = Number(waste.quantity || 0);
  const stockQty = Number(batch.quantity || 0);
  if (actualQty <= 0) return res.status(409).json({ error: '实际处置数量必须大于0' });
  if (actualQty > wasteQty) return res.status(409).json({ error: `实际处置数量(${actualQty})超过申请数量(${wasteQty})` });
  if (actualQty > stockQty) return res.status(409).json({ error: `实际处置数量(${actualQty})超过当前库存(${stockQty})` });

  const now = new Date().toISOString();

  const beforeWaste = { ...waste };
  const beforeBatch = { ...batch };

  waste.actualQuantity = actualQty;
  waste.disposalMethod = disposalMethod;
  waste.witness = witness;
  waste.status = '已处置';
  waste.disposedAt = now;
  waste.disposedBy = operator;
  waste.updatedAt = now;
  waste.history = waste.history || [];
  waste.history.unshift(stamp('确认处置', `实际处置：${actualQty}${batch.unit || ''}，处置方式：${disposalMethod || '未指定'}，见证人：${witness || '未记录'}`));

  const newQty = stockQty - actualQty;
  batch.quantity = newQty;
  batch.updatedAt = now;
  batch.history = batch.history || [];

  const noteParts = [`报废单：${waste.code || waste.id}`, `报废数量：-${actualQty}${batch.unit || ''}`, `剩余库存：${newQty}${batch.unit || ''}`];
  if (newQty <= 0) {
    batch.status = '已报废';
    noteParts.push('库存清零，批次状态更新为已报废');
  }
  batch.history.unshift(stamp('报废扣减', noteParts.join('，')));

  writeAuditLog(db, {
    actionType: '确认处置',
    collection: 'wastes',
    targetId: waste.id,
    targetItem: waste,
    beforeItem: beforeWaste,
    note: `实际处置：${actualQty}${batch.unit || ''}，处置方式：${disposalMethod || '未指定'}，见证人：${witness || '未记录'}`,
    operator
  });

  writeAuditLog(db, {
    actionType: '报废扣减(关联)',
    collection: 'batches',
    targetId: batch.id,
    targetItem: batch,
    beforeItem: beforeBatch,
    note: noteParts.join('，')
  });

  await writeDb(db);
  res.json(waste);
});

app.patch('/api/stocktakes/:id/items', async (req, res) => {
  const db = await readDb();
  const { id } = req.params;
  const stocktake = db.stocktakes?.find((entry) => entry.id === id);
  if (!stocktake) return res.status(404).json({ error: '盘点单不存在' });
  if (stocktake.status === '已确认') return res.status(409).json({ error: '已确认的盘点单不能修改录入' });

  const { items, operator } = req.body;
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
  stocktake.history.unshift(stamp('录入', `录入${stocktake.items.length}个批次，差异${diffItems}项`));

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
    operator: operator || stocktake.operator
  });

  await writeDb(db);
  res.json(stocktake);
});

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
