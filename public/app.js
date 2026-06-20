const state = {
  config: null,
  db: {},
  activeTab: '',
  expandedStocktake: null,
  stocktakeEdits: {},
  expandedWaste: null,
  wasteEdits: {},
  highlightRequestId: null,
  preselectedBatchId: null,
  importPreview: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '请求失败');
  }
  if (res.status === 204) return null;
  return res.json();
}

function valueByPath(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function displayField(item, field) {
  const value = item[field.name] ?? '';
  if (field.type === 'select' && field.options) return value || field.options[0];
  return value;
}

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function computedFieldValue(field, item) {
  const sourceItems = state.db[field.source] || [];
  const matched = sourceItems.filter((entry) => entry[field.matchField] === item.id);
  if (field.compute === 'count') return matched.length;
  if (field.compute === 'sum') return matched.reduce((sum, entry) => sum + Number(entry[field.sumField] || 0), 0);
  return '-';
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const value = field.default ? `value="${escapeHtml(field.default)}"` : '';
  if (field.type === 'display') {
    const dataAttr = field.autoFillSource ? `data-auto-fill-target="${field.name}"` : '';
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="text" name="${field.name}" ${dataAttr} ${required} readonly></label>`;
  }
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    const autoFillAttr = field.autoFill ? `data-auto-fill='${JSON.stringify(field.autoFill)}' data-collection="${field.collection}"` : '';
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required} ${autoFillAttr}><option value="">请选择</option>${optionList(items, field.labelFields)}</select></label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 5).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function values(form, view) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  return { ...view.defaults, ...payload };
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    let value;
    if (field.type === 'computed') {
      value = computedFieldValue(field, item);
    } else if (field.type === 'relation') {
      value = relationLabel(field, item[field.name]);
    } else {
      value = item[field.name];
    }
    const displayValue = value === null || value === undefined || value === '' ? '-' : value;
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(displayValue)}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  let actions = state.config.actions
    .filter((action) => action.collection === collection);
  if (collection === 'batches' && Number(item.quantity || 0) > 0) {
    actions = actions.filter((action) => action.id !== 'batch-waste');
  }
  actions = actions
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  const extraActions = collection === 'batches' && item.status !== '已报废'
    ? `<button class="ghost" data-create-waste-from-batch="${item.id}">发起报废</button>`
    : '';
  const allActions = actions || extraActions
    ? `<div class="actions">${actions}${extraActions}</div>`
    : '';
  return `<article class="card" data-collection="${collection}" data-id="${item.id}">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${allActions}
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])];
  if (query) {
    const relationFields = (view.fields || []).filter((f) => f.type === 'relation');
    items = items.filter((item) => view.searchFields.some((field) => {
      const raw = String(item[field] || '');
      if (raw.includes(query)) return true;
      const relField = relationFields.find((f) => f.name === field);
      if (relField) {
        const label = relationLabel(relField, item[field]);
        if (label.includes(query)) return true;
      }
      return false;
    }));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length ? items.map((item) => renderCard(item, collection, view)).join('') : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

function computeAlertData() {
  const alerts = state.config.alerts || {};
  const expiringDays = alerts.expiringDays || 30;
  const lowStockThreshold = alerts.lowStockThreshold || 10;
  const openStatuses = alerts.openRequestStatuses || ['待审批', '已审批', '已出库'];
  const now = new Date();
  const expiringCutoff = new Date(now.getTime() + expiringDays * 24 * 60 * 60 * 1000);

  const batches = state.db.batches || [];
  const requests = state.db.requests || [];

  const expiringSoon = [];
  const expiredNotWasted = [];
  const lowStock = [];
  const lockedWithOpenRequests = [];

  const openRequestsByBatch = {};
  requests.forEach((r) => {
    if (openStatuses.includes(r.status)) {
      if (!openRequestsByBatch[r.batchId]) openRequestsByBatch[r.batchId] = [];
      openRequestsByBatch[r.batchId].push(r);
    }
  });

  batches.forEach((batch) => {
    const expireDate = batch.expiresAt ? new Date(batch.expiresAt) : null;
    if (expireDate) {
      if (expireDate < now && batch.status !== '已报废') {
        expiredNotWasted.push({ ...batch, _daysLeft: -1, _openRequests: openRequestsByBatch[batch.id] || [] });
      } else if (expireDate <= expiringCutoff && expireDate >= now && batch.status !== '已报废') {
        const daysLeft = Math.ceil((expireDate - now) / (1000 * 60 * 60 * 24));
        expiringSoon.push({ ...batch, _daysLeft: daysLeft, _openRequests: openRequestsByBatch[batch.id] || [] });
      }
    }

    const qty = Number(batch.quantity || 0);
    if (qty < lowStockThreshold && batch.status !== '已报废') {
      lowStock.push({ ...batch, _openRequests: openRequestsByBatch[batch.id] || [] });
    }

    if (batch.status === '锁定' && (openRequestsByBatch[batch.id] || []).length > 0) {
      lockedWithOpenRequests.push({ ...batch, _openRequests: openRequestsByBatch[batch.id] || [] });
    }
  });

  expiringSoon.sort((a, b) => a._daysLeft - b._daysLeft);

  return { expiringSoon, expiredNotWasted, lowStock, lockedWithOpenRequests, openStatuses };
}

function renderAlertCard(batch, view, alertType, extraInfo = '') {
  const title = view.titleFields.map((field) => batch[field]).filter(Boolean).join(' / ') || batch.id;
  const statusValue = batch[view.statusField];
  const details = (view.detailFields || []).map((field) => {
    let value;
    if (field.type === 'computed') {
      value = computedFieldValue(field, batch);
    } else if (field.type === 'relation') {
      value = relationLabel(field, batch[field.name]);
    } else {
      value = batch[field.name];
    }
    const displayValue = value === null || value === undefined || value === '' ? '-' : value;
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(displayValue)}</strong></div>`;
  }).join('');

  const openRequests = batch._openRequests || [];
  const requestBadge = openRequests.length > 0
    ? `<span class="pill warn" style="margin-top:6px;">关联${openRequests.length}个未闭环申请</span>`
    : '';

  const extraBadge = extraInfo ? `<span class="pill bad" style="margin-top:6px;">${escapeHtml(extraInfo)}</span>` : '';

  let actions = state.config.actions
    .filter((action) => action.collection === 'batches');
  if (Number(batch.quantity || 0) > 0) {
    actions = actions.filter((action) => action.id !== 'batch-waste');
  }
  actions = actions
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${batch.id}">${escapeHtml(action.label)}</button>`)
    .join('');

  const viewRequestsBtn = openRequests.length > 0
    ? `<button class="ghost" data-view-requests="${batch.id}">查看关联申请</button>`
    : '';

  const wasteFromBatchBtn = batch.status !== '已报废'
    ? `<button class="ghost" data-create-waste-from-batch="${batch.id}">发起报废</button>`
    : '';

  return `<article class="card alert-card alert-${alertType}">
    <div class="card-head">
      <div>
        <h3>${escapeHtml(title)}</h3>
        <div class="alert-badges">
          ${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}
          ${extraBadge}
          ${requestBadge}
        </div>
      </div>
    </div>
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${actions || viewRequestsBtn || wasteFromBatchBtn ? `<div class="actions">${actions}${viewRequestsBtn}${wasteFromBatchBtn}</div>` : ''}
  </article>`;
}

function renderRiskAlertsView(view) {
  const alertData = computeAlertData();
  const { expiringSoon, expiredNotWasted, lowStock, lockedWithOpenRequests } = alertData;
  const totalCount = expiringSoon.length + expiredNotWasted.length + lowStock.length + lockedWithOpenRequests.length;

  return `<section class="view" id="${view.id}">
    <div class="alert-stats">
      <div class="alert-stat alert-stat-expiring">
        <span class="alert-stat-label">30天内过期</span>
        <strong>${expiringSoon.length}</strong>
      </div>
      <div class="alert-stat alert-stat-expired">
        <span class="alert-stat-label">已过期未报废</span>
        <strong>${expiredNotWasted.length}</strong>
      </div>
      <div class="alert-stat alert-stat-lowstock">
        <span class="alert-stat-label">库存低于阈值</span>
        <strong>${lowStock.length}</strong>
      </div>
      <div class="alert-stat alert-stat-locked">
        <span class="alert-stat-label">锁定待闭环</span>
        <strong>${lockedWithOpenRequests.length}</strong>
      </div>
    </div>

    <div class="alert-groups">
      <div class="alert-group">
        <div class="alert-group-header">
          <h3><span class="alert-group-icon warn">⏰</span> 30天内过期</h3>
          <span class="pill warn">${expiringSoon.length} 项</span>
        </div>
        <div class="alert-group-body">
          ${expiringSoon.length
            ? expiringSoon.map((b) => renderAlertCard(b, view, 'expiring', `还有${b._daysLeft}天过期`)).join('')
            : '<div class="empty">暂无即将过期批次</div>'}
        </div>
      </div>

      <div class="alert-group">
        <div class="alert-group-header">
          <h3><span class="alert-group-icon bad">⚠️</span> 已过期未报废</h3>
          <span class="pill bad">${expiredNotWasted.length} 项</span>
        </div>
        <div class="alert-group-body">
          ${expiredNotWasted.length
            ? expiredNotWasted.map((b) => renderAlertCard(b, view, 'expired', '已过期')).join('')
            : '<div class="empty">暂无已过期未报废批次</div>'}
        </div>
      </div>

      <div class="alert-group">
        <div class="alert-group-header">
          <h3><span class="alert-group-icon warn">📦</span> 库存低于阈值</h3>
          <span class="pill warn">${lowStock.length} 项</span>
        </div>
        <div class="alert-group-body">
          ${lowStock.length
            ? lowStock.map((b) => renderAlertCard(b, view, 'lowstock', `库存${b.quantity}${b.unit || ''}`)).join('')
            : '<div class="empty">暂无低库存批次</div>'}
        </div>
      </div>

      <div class="alert-group">
        <div class="alert-group-header">
          <h3><span class="alert-group-icon bad">🔒</span> 锁定且有未闭环申请</h3>
          <span class="pill bad">${lockedWithOpenRequests.length} 项</span>
        </div>
        <div class="alert-group-body">
          ${lockedWithOpenRequests.length
            ? lockedWithOpenRequests.map((b) => renderAlertCard(b, view, 'locked', `关联${b._openRequests.length}个申请`)).join('')
            : '<div class="empty">暂无锁定待闭环批次</div>'}
        </div>
      </div>
    </div>

    <div id="request-modal" class="modal hidden">
      <div class="modal-content">
        <div class="modal-header">
          <h3>关联申请列表</h3>
          <button class="ghost" id="close-modal">关闭</button>
        </div>
        <div class="modal-body" id="modal-body"></div>
      </div>
    </div>
  </section>`;
}

function renderDashboardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 8);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无重点事项</div>'}</div></div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

function diffTone(diff) {
  if (diff > 0) return 'surplus';
  if (diff < 0) return 'deficit';
  return '';
}

function diffLabel(diff) {
  if (diff > 0) return `盘盈 +${diff}`;
  if (diff < 0) return `盘亏 ${diff}`;
  return '一致';
}

function computeStocktakeDiff(stocktake) {
  const items = state.stocktakeEdits[stocktake.id] || stocktake.items || [];
  let surplusCount = 0;
  let deficitCount = 0;
  let surplusQty = 0;
  let deficitQty = 0;
  let totalBook = 0;
  let totalActual = 0;
  items.forEach((it) => {
    const book = Number(it.bookQuantity ?? 0);
    const actual = Number(it.actualQuantity ?? 0);
    const diff = actual - book;
    totalBook += book;
    totalActual += actual;
    if (diff > 0) {
      surplusCount++;
      surplusQty += diff;
    } else if (diff < 0) {
      deficitCount++;
      deficitQty += Math.abs(diff);
    }
  });
  return { surplusCount, deficitCount, surplusQty, deficitQty, totalBook, totalActual, totalDiff: totalActual - totalBook };
}

function renderStocktakeDiffSummary(stocktake) {
  const computed = computeStocktakeDiff(stocktake);
  const summary = stocktake.diffSummary ? { ...computed, ...stocktake.diffSummary } : computed;
  const hasDiff = summary.surplusCount + summary.deficitCount > 0;
  const diffPart = hasDiff ? `
    <div class="diff-summary">
      <span class="diff-stat surplus">盘盈：${summary.surplusCount}项（+${summary.surplusQty || 0}）</span>
      <span class="diff-stat deficit">盘亏：${summary.deficitCount}项（-${summary.deficitQty || 0}）</span>
    </div>
  ` : `<div class="diff-summary"><span class="diff-stat consistent">所有批次账实一致</span></div>`;
  const netDiff = summary.totalDiff ?? summary.surplusQty - summary.deficitQty;
  return `
    <div class="stocktake-summary">
      <div class="diff-stat">账面合计：${summary.totalBook ?? '-'}　实盘合计：${summary.totalActual ?? '-'}　净差异：${netDiff >= 0 ? '+' : ''}${netDiff}</div>
      ${diffPart}
    </div>
  `;
}

function renderStocktakeItemRows(stocktake) {
  const confirmed = stocktake.status === '已确认';
  const edits = state.stocktakeEdits[stocktake.id] || stocktake.items || [];
  const savedMap = {};
  (stocktake.items || []).forEach((it) => { savedMap[it.batchId] = it; });

  let targetBatches = state.db.batches || [];
  if (stocktake.cabinetId) {
    targetBatches = targetBatches.filter((b) => b.cabinetId === stocktake.cabinetId);
  }

  const existingIds = new Set(edits.map((e) => e.batchId));
  targetBatches.forEach((b) => {
    if (!existingIds.has(b.id)) {
      edits.push({
        batchId: b.id,
        bookQuantity: b.quantity,
        actualQuantity: b.quantity,
        difference: 0,
        remark: ''
      });
      existingIds.add(b.id);
    }
  });

  state.stocktakeEdits[stocktake.id] = edits;

  if (!edits.length) return '<div class="empty">暂无待盘点批次</div>';

  return edits.map((item, idx) => {
    const batch = state.db.batches.find((b) => b.id === item.batchId);
    if (!batch) return '';
    const book = Number(item.bookQuantity ?? batch.quantity ?? 0);
    const actual = Number(item.actualQuantity ?? book);
    const diff = actual - book;
    const rowTone = diffTone(diff);
    const diffHtml = `<span class="diff-cell ${rowTone}">${escapeHtml(diffLabel(diff))}</span>`;
    const inputAttrs = confirmed ? 'readonly disabled' : '';
    return `
      <tr class="stocktake-row ${rowTone ? 'row-' + rowTone : ''}">
        <td>
          <div><strong>${escapeHtml(batch.name)}</strong> ${pill(batch.safetyLevel, toneFor(batch.safetyLevel))}</div>
          <div class="meta">批次：${escapeHtml(batch.batchNo)}　柜位：${escapeHtml(relationLabel({ collection: 'cabinets', labelFields: ['code'] }, batch.cabinetId))}</div>
        </td>
        <td class="num-cell">
          <input type="number" class="st-input book-input" data-st="${stocktake.id}" data-idx="${idx}" data-field="bookQuantity" value="${book}" ${inputAttrs} min="0">
          <span class="unit">${escapeHtml(batch.unit || '')}</span>
        </td>
        <td class="num-cell">
          <input type="number" class="st-input actual-input" data-st="${stocktake.id}" data-idx="${idx}" data-field="actualQuantity" value="${actual}" ${inputAttrs} min="0">
          <span class="unit">${escapeHtml(batch.unit || '')}</span>
        </td>
        <td class="num-cell">${diffHtml}</td>
        <td>
          <input type="text" class="st-input remark-input" data-st="${stocktake.id}" data-idx="${idx}" data-field="remark" value="${escapeHtml(item.remark || '')}" ${confirmed ? 'readonly disabled' : ''} placeholder="差异原因...">
        </td>
      </tr>
    `;
  }).join('');
}

function renderStocktakeCard(stocktake, view) {
  const isExpanded = state.expandedStocktake === stocktake.id;
  const title = view.titleFields.map((f) => stocktake[f]).filter(Boolean).join(' / ') || stocktake.id;
  const summary = (view.summaryFields || []).map((f) => stocktake[f]).filter(Boolean).join(' · ');
  const confirmed = stocktake.status === '已确认';
  const cabinetLabel = stocktake.cabinetId ? `范围：${escapeHtml(relationLabel({ collection: 'cabinets', labelFields: ['code', 'area'] }, stocktake.cabinetId))}` : '范围：全部柜位';
  const diffHtml = (stocktake.items || []).length || state.stocktakeEdits[stocktake.id]?.length ? renderStocktakeDiffSummary(stocktake) : '';

  let expandContent = '';
  if (isExpanded) {
    const actions = confirmed ? '' : `
      <div class="stocktake-actions">
        <button class="ghost" data-stocktake-save="${stocktake.id}">保存录入</button>
        <button class="secondary" data-stocktake-confirm="${stocktake.id}" ${!stocktake.items || !stocktake.items.length ? 'disabled' : ''}>确认盘点并更新库存</button>
      </div>
    `;
    expandContent = `
      <div class="stocktake-detail">
        ${confirmed && stocktake.confirmedAt ? `<div class="meta">确认人：${escapeHtml(stocktake.confirmedBy || '-')}　确认时间：${fmtDate(stocktake.confirmedAt)}</div>` : ''}
        ${diffHtml}
        <table class="stocktake-table">
          <thead>
            <tr><th>药剂批次</th><th>账面数量</th><th>实盘数量</th><th>差异</th><th>备注/原因</th></tr>
          </thead>
          <tbody>
            ${renderStocktakeItemRows(stocktake)}
          </tbody>
        </table>
        ${actions}
      </div>
    `;
  }

  return `<article class="card stocktake-card">
    <div class="card-head" data-expand-stocktake="${stocktake.id}" style="cursor:pointer;">
      <div>
        <h3>${escapeHtml(title)}</h3>
        <div class="meta">${cabinetLabel}　${summary ? escapeHtml(summary) : ''}</div>
        ${diffHtml && !isExpanded ? `<div class="stocktake-card-summary">${diffHtml}</div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        ${pill(stocktake.status, toneFor(stocktake.status))}
        <span class="meta">${(stocktake.items || []).length ? stocktake.items.length + '个批次' : '未录入'}</span>
        <span class="meta">${isExpanded ? '▲ 收起' : '▼ 展开详情'}</span>
      </div>
    </div>
    ${expandContent}
    ${historyHtml(stocktake)}
  </article>`;
}

function renderStocktakeList(view) {
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[view.collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length ? items.map((item) => renderStocktakeCard(item, view)).join('') : `<div class="empty">暂无盘点单</div>`;
}

function renderStocktakeView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}" data-stocktake-create>
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderStocktakeList(view)}</div>
      </div>
    </div>
  </section>`;
}

function renderWasteCard(waste, view) {
  const isExpanded = state.expandedWaste === waste.id;
  const title = view.titleFields.map((f) => waste[f]).filter(Boolean).join(' / ') || waste.id;
  const summary = (view.summaryFields || []).map((f) => waste[f]).filter(Boolean).join(' · ');
  const batch = state.db.batches?.find((b) => b.id === waste.batchId);
  const batchLabel = batch ? `${batch.name} / ${batch.batchNo}` : '未关联批次';
  const unit = batch?.unit || '';

  let expandContent = '';
  if (isExpanded) {
    const detailRows = (view.detailFields || []).map((field) => {
      let value;
      if (field.type === 'relation') {
        value = relationLabel(field, waste[field.name]);
      } else {
        value = waste[field.name];
      }
      const displayValue = value === null || value === undefined || value === '' ? '-' : value;
      return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(displayValue)}</strong></div>`;
    }).join('');

    let actionButtons = '';
    if (waste.status === '待审批') {
      actionButtons = `
        <div class="waste-actions">
          <button class="secondary" data-waste-approve="${waste.id}">审批通过</button>
          <button class="danger" data-action="waste-reject" data-id="${waste.id}">驳回</button>
        </div>
      `;
    } else if (waste.status === '待处置') {
      const actualQty = state.wasteEdits[waste.id]?.actualQuantity ?? waste.quantity;
      const disposalMethod = state.wasteEdits[waste.id]?.disposalMethod || waste.disposalMethod || '';
      const witness = state.wasteEdits[waste.id]?.witness || waste.witness || '';
      const operator = state.wasteEdits[waste.id]?.operator || '';
      actionButtons = `
        <div class="waste-dispose-form">
          <h4>确认处置</h4>
          <div class="form-grid">
            <label>实际处置数量<input type="number" class="waste-input" data-waste="${waste.id}" data-field="actualQuantity" value="${actualQty}" min="0" max="${waste.quantity}"><span class="unit">${escapeHtml(unit)}</span></label>
            <label>处置方式
              <select class="waste-input" data-waste="${waste.id}" data-field="disposalMethod">
                <option value="">请选择</option>
                <option value="专业机构回收" ${disposalMethod === '专业机构回收' ? 'selected' : ''}>专业机构回收</option>
                <option value="化学中和销毁" ${disposalMethod === '化学中和销毁' ? 'selected' : ''}>化学中和销毁</option>
                <option value="深埋处理" ${disposalMethod === '深埋处理' ? 'selected' : ''}>深埋处理</option>
                <option value="其他" ${disposalMethod === '其他' ? 'selected' : ''}>其他</option>
              </select>
            </label>
            <label>见证人<input type="text" class="waste-input" data-waste="${waste.id}" data-field="witness" value="${escapeHtml(witness)}"></label>
            <label>操作人<input type="text" class="waste-input" data-waste="${waste.id}" data-field="operator" value="${escapeHtml(operator)}"></label>
          </div>
          <div class="waste-actions">
            <button class="danger" data-waste-dispose="${waste.id}">确认处置并扣减库存</button>
          </div>
        </div>
      `;
    } else if (waste.status === '已处置') {
      actionButtons = `
        <div class="waste-disposed-info">
          <h4>处置详情</h4>
          <div class="form-grid">
            <div class="meta">实际处置数量<br><strong>${waste.actualQuantity || waste.quantity || 0} ${escapeHtml(unit)}</strong></div>
            <div class="meta">处置方式<br><strong>${escapeHtml(waste.disposalMethod || '-')}</strong></div>
            <div class="meta">见证人<br><strong>${escapeHtml(waste.witness || '-')}</strong></div>
            <div class="meta">处置人<br><strong>${escapeHtml(waste.disposedBy || '-')}</strong></div>
          </div>
          <div class="meta" style="margin-top:8px;">处置时间：${fmtDate(waste.disposedAt)}</div>
        </div>
      `;
    }

    expandContent = `
      <div class="waste-detail">
        <div class="meta">关联批次：${escapeHtml(batchLabel)}</div>
        ${batch ? `<div class="meta">批次当前库存：${batch.quantity} ${escapeHtml(batch.unit || '')}　${pill(batch.status, toneFor(batch.status))}</div>` : ''}
        ${waste.reason ? `<div class="meta">报废原因：${escapeHtml(waste.reason)}</div>` : ''}
        ${waste.note ? `<div class="meta">备注：${escapeHtml(waste.note)}</div>` : ''}
        ${waste.approver ? `<div class="meta">审批人：${escapeHtml(waste.approver)}　审批时间：${fmtDate(waste.approvedAt)}</div>` : ''}
        <div class="detail">${detailRows}</div>
        ${actionButtons}
      </div>
    `;
  }

  return `<article class="card waste-card">
    <div class="card-head" data-expand-waste="${waste.id}" style="cursor:pointer;">
      <div>
        <h3>${escapeHtml(title)}</h3>
        <div class="meta">批次：${escapeHtml(batchLabel)}　${summary ? escapeHtml(summary) : ''}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        ${pill(waste.status, toneFor(waste.status))}
        <span class="meta">申请数量：${waste.quantity || 0} ${escapeHtml(unit)}</span>
        <span class="meta">${isExpanded ? '▲ 收起' : '▼ 展开详情'}</span>
      </div>
    </div>
    ${expandContent}
    ${historyHtml(waste)}
  </article>`;
}

function renderWasteList(view) {
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[view.collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => {
      const raw = String(item[field] || '');
      if (raw.includes(query)) return true;
      if (field === 'batchId') {
        const batch = state.db.batches?.find((b) => b.id === item[field]);
        if (batch && (batch.name.includes(query) || batch.batchNo.includes(query))) return true;
      }
      return false;
    }));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length ? items.map((item) => renderWasteCard(item, view)).join('') : `<div class="empty">暂无报废单</div>`;
}

function renderWasteView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}" data-waste-create>
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderWasteList(view)}</div>
      </div>
    </div>
  </section>`;
}

function refreshWasteList(viewId) {
  const view = state.config.views.find((v) => v.id === viewId);
  if (!view) return;
  const listEl = $(`#list-${viewId}`);
  if (listEl) listEl.innerHTML = renderWasteList(view);
}

function renderAuditLogCard(log) {
  const collLabel = collectionLabel(log.targetCollection);
  const changes = log.changes || {};
  const changeKeys = Object.keys(changes);
  let changesHtml = '';
  if (changeKeys.length) {
    changesHtml = `<div class="audit-changes">
      <div class="audit-changes-title">字段变化：</div>
      <div class="audit-changes-list">
        ${changeKeys.map((key) => {
          const c = changes[key];
          const beforeVal = c.before === undefined || c.before === null || c.before === '' ? '(空)' : c.before;
          const afterVal = c.after === undefined || c.after === null || c.after === '' ? '(空)' : c.after;
          return `<div class="audit-change-item">
            <span class="audit-change-key">${escapeHtml(key)}</span>
            <span class="audit-change-before">${escapeHtml(String(beforeVal))}</span>
            <span class="audit-change-arrow">→</span>
            <span class="audit-change-after">${escapeHtml(String(afterVal))}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  return `<article class="card audit-log-card">
    <div class="card-head">
      <div>
        <h3>${escapeHtml(log.actionType)}</h3>
        <div class="meta">目标：${escapeHtml(collLabel)} · ${escapeHtml(log.targetLabel || log.targetId)}</div>
      </div>
      ${pill(log.actionType, toneFor(log.actionType) || '')}
    </div>
    ${log.note ? `<p>${escapeHtml(log.note)}</p>` : ''}
    <div class="detail">
      <div>操作时间<br><strong>${fmtDate(log.createdAt)}</strong></div>
      <div>目标集合<br><strong>${escapeHtml(collLabel)}</strong></div>
      <div>操作人<br><strong>${escapeHtml(log.operator || '系统')}</strong></div>
    </div>
    ${changesHtml}
  </article>`;
}

function renderAuditLogsList(view) {
  const actionType = document.getElementById(`action-type-${view.id}`)?.value || '';
  const targetColl = document.getElementById(`target-collection-${view.id}`)?.value || '';
  const keyword = document.getElementById(`search-${view.id}`)?.value.trim() || '';

  let items = [...(state.db.auditLogs || [])];

  if (actionType) {
    items = items.filter((item) => item.actionType === actionType);
  }
  if (targetColl) {
    items = items.filter((item) => item.targetCollection === targetColl);
  }
  if (keyword) {
    items = items.filter((item) => {
      const inLabel = (item.targetLabel || '').includes(keyword);
      const inNote = (item.note || '').includes(keyword);
      const inOperator = (item.operator || '').includes(keyword);
      const inId = (item.targetId || '').includes(keyword);
      const inAction = (item.actionType || '').includes(keyword);
      return inLabel || inNote || inOperator || inId || inAction;
    });
  }

  if (!items.length) return '<div class="empty">暂无审计日志</div>';

  return items.map((log) => renderAuditLogCard(log)).join('');
}

function refreshAuditLogsList(viewId) {
  const view = state.config.views.find((v) => v.id === viewId);
  if (!view) return;
  const listEl = document.getElementById(`list-${viewId}`);
  if (listEl) listEl.innerHTML = renderAuditLogsList(view);
}

function renderAuditLogsView(view) {
  const actionTypes = state.config.auditLog?.actionTypes || [];
  const targetCollections = state.config.auditLog?.targetCollections || [];

  return `<section class="view" id="${view.id}">
    <div class="panel">
      <h2>操作审计日志</h2>
      <p class="meta">所有关键操作均会自动记录，日志只读不可修改。</p>
      <div class="audit-toolbar">
        <select id="action-type-${view.id}">
          <option value="">全部操作类型</option>
          ${actionTypes.map((type) => `<option>${escapeHtml(type)}</option>`).join('')}
        </select>
        <select id="target-collection-${view.id}">
          <option value="">全部目标集合</option>
          ${targetCollections.map((coll) => `<option value="${coll}">${escapeHtml(collectionLabel(coll))}</option>`).join('')}
        </select>
        <input id="search-${view.id}" placeholder="搜索关键词（标题、备注、操作人等）">
      </div>
      <div class="list" id="list-${view.id}">${renderAuditLogsList(view)}</div>
    </div>
  </section>`;
}

function renderBatchImportView(view) {
  const preview = state.importPreview;
  const hasPreview = preview && preview.totalRows > 0;

  const sampleCsv = `药剂名称,品类,批次号,供应商,存放柜位,安全等级,库存数量,单位,有效期,状态
冷焰火粉A17,冷焰火,PY-A17-2606,星焰化工,防爆柜B-2,高,20,罐,2027-05-30,可用
高空喷射礼花B03,喷射类,SP-B03-2606,星焰化工,防爆柜C-1,中,15,箱,2027-03-15,可用`;

  let summaryHtml = '';
  let tableHtml = '';

  if (hasPreview) {
    summaryHtml = `
      <div class="import-summary">
        <div class="import-stat import-stat-total">
          <span class="import-stat-label">解析总行数</span>
          <strong>${preview.totalRows}</strong>
        </div>
        <div class="import-stat import-stat-valid">
          <span class="import-stat-label">有效行</span>
          <strong>${preview.validCount}</strong>
        </div>
        <div class="import-stat import-stat-error">
          <span class="import-stat-label">错误行</span>
          <strong>${preview.errorCount}</strong>
        </div>
        <div class="import-stat import-stat-dup">
          <span class="import-stat-label">重复批次号</span>
          <strong>${preview.duplicateBatchNos.length}</strong>
        </div>
      </div>
      <div class="import-error-summary">
        ${preview.missingCount > 0 ? `<span class="pill bad">缺失必填项：${preview.missingCount} 行</span>` : ''}
        ${preview.quantityErrorCount > 0 ? `<span class="pill bad">数量格式错误：${preview.quantityErrorCount} 行</span>` : ''}
        ${preview.duplicateBatchNos.length > 0 ? `<span class="pill warn">重复批次号：${preview.duplicateBatchNos.slice(0, 5).join('、')}${preview.duplicateBatchNos.length > 5 ? '...' : ''}</span>` : ''}
      </div>
    `;

    const allRows = [
      ...(preview.validRows || []).map((r) => ({ ...r, rowType: 'valid' })),
      ...(preview.errorRows || []).map((r) => ({ ...r, rowType: 'error' }))
    ].sort((a, b) => a.rowIndex - b.rowIndex);

    const displayFields = [
      { key: 'name', label: '药剂名称' },
      { key: 'category', label: '品类' },
      { key: 'batchNo', label: '批次号' },
      { key: 'quantity', label: '数量' },
      { key: 'unit', label: '单位' },
      { key: 'expiresAt', label: '有效期' },
      { key: 'status', label: '状态' }
    ];

    tableHtml = `
      <div class="import-table-wrap">
        <table class="import-table">
          <thead>
            <tr>
              <th class="col-idx">行号</th>
              ${displayFields.map((f) => `<th>${escapeHtml(f.label)}</th>`).join('')}
              <th class="col-status">状态</th>
            </tr>
          </thead>
          <tbody>
            ${allRows.map((row) => `
              <tr class="import-row import-row-${row.rowType}">
                <td class="col-idx">${row.rowIndex}</td>
                ${displayFields.map((f) => `<td>${escapeHtml(row.data[f.key] || '-')}</td>`).join('')}
                <td class="col-status">
                  ${row.rowType === 'valid'
                    ? '<span class="pill ok">有效</span>'
                    : `<div class="import-errors">${row.errors.map((e) => `<span class="pill bad">${escapeHtml(e)}</span>`).join('')}</div>`
                  }
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="import-actions">
        <button class="secondary" data-import-reset>重新输入</button>
        <button data-import-confirm ${preview.validCount === 0 ? 'disabled' : ''}>
          确认导入 ${preview.validCount} 条
        </button>
      </div>
    `;
  }

  return `<section class="view" id="${view.id}">
    <div class="panel">
      <h2>批量导入药剂批次</h2>
      <p class="meta">粘贴 CSV 文本，支持中文表头。系统会先预览解析结果，确认无误后再写入。</p>
      ${!hasPreview ? `
      <div class="import-input-area">
        <label>
          CSV 内容
          <textarea id="csv-input" placeholder="请粘贴 CSV 内容，第一行为表头&#10;示例表头：药剂名称,品类,批次号,供应商,存放柜位,安全等级,库存数量,单位,有效期,状态"></textarea>
        </label>
        <div class="import-hint">
          <details>
            <summary>查看示例 CSV 格式</summary>
            <pre class="sample-csv">${escapeHtml(sampleCsv)}</pre>
          </details>
          <p class="meta">必填字段：药剂名称、品类、批次号、库存数量、单位、有效期</p>
          <p class="meta">供应商和柜位请填写名称/编号，系统会自动匹配</p>
        </div>
        <div class="import-actions">
          <button data-import-preview>解析预览</button>
        </div>
      </div>
      ` : ''}
      ${summaryHtml}
      ${tableHtml}
    </div>
  </section>`;
}

function applyAutoFill(select) {
  const form = select.closest('form');
  if (!form) return;
  const autoFillConfig = JSON.parse(select.dataset.autoFill);
  const collection = select.dataset.collection;
  const selectedId = select.value;
  const selectedItem = state.db[collection]?.find((item) => item.id === selectedId);
  autoFillConfig.forEach((mapping) => {
    const targetField = form.querySelector(`[name="${mapping.to}"]`);
    if (targetField) {
      targetField.value = selectedItem?.[mapping.from] || '';
    }
  });
}

function initializeAutoFillFields() {
  $$('select[data-auto-fill]').forEach(applyAutoFill);
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map((view) => {
    if (view.type === 'risk-alerts') return renderRiskAlertsView(view);
    if (view.type === 'dashboard') return renderDashboardView(view);
    if (view.type === 'stocktake') return renderStocktakeView(view);
    if (view.type === 'waste') return renderWasteView(view);
    if (view.type === 'audit-logs') return renderAuditLogsView(view);
    if (view.type === 'batch-import') return renderBatchImportView(view);
    return renderCrudView(view);
  }).join('');
  setTab(state.activeTab || state.config.views[0].id);
  initializeAutoFillFields();
}

function refreshStocktakeList(viewId) {
  const view = state.config.views.find((v) => v.id === viewId);
  if (!view) return;
  const listEl = $(`#list-${viewId}`);
  if (listEl) listEl.innerHTML = renderStocktakeList(view);
}

async function load() {
  state.db = await api('/api/db');
  render();
}

function openRequestModal(batchId) {
  const alertData = computeAlertData();
  const batch = (state.db.batches || []).find((b) => b.id === batchId);
  if (!batch) return;

  const openStatuses = state.config.alerts?.openRequestStatuses || ['待审批', '已审批', '已出库'];
  const requests = (state.db.requests || []).filter((r) => r.batchId === batchId && openStatuses.includes(r.status));

  const batchName = [batch.name, batch.batchNo].filter(Boolean).join(' / ');

  const requestsHtml = requests.length
    ? requests.map((r) => {
        const projectLabel = relationLabel({ collection: 'projects', labelFields: ['name', 'venue'] }, r.projectId);
        return `<div class="modal-request-item">
          <div class="modal-request-head">
            <strong>${escapeHtml(r.showName || r.id)}</strong>
            ${pill(r.status, toneFor(r.status))}
          </div>
          <div class="meta">地点：${escapeHtml(r.venue || '-')}</div>
          <div class="meta">时段：${escapeHtml(r.useWindow || '-')}</div>
          <div class="meta">数量：${r.quantity} ${escapeHtml(batch.unit || '')}　操作：${escapeHtml(r.operator || '-')}</div>
          <div class="meta">项目：${escapeHtml(projectLabel)}</div>
          ${r.memo ? `<div class="meta">备注：${escapeHtml(r.memo)}</div>` : ''}
          <div class="modal-request-actions">
            <button class="ghost" data-jump-request="${r.id}">查看申请 →</button>
          </div>
        </div>`;
      }).join('')
    : '<div class="empty">暂无关联申请</div>';

  const modalBody = $('#modal-body');
  const modal = $('#request-modal');
  if (modalBody && modal) {
    modalBody.innerHTML = `
      <div class="modal-batch-info">
        <h4>${escapeHtml(batchName)}</h4>
        <div class="meta">共 ${requests.length} 个未闭环申请</div>
      </div>
      <div class="modal-requests">
        ${requestsHtml}
      </div>
    `;
    modal.classList.remove('hidden');
  }
}

function closeRequestModal() {
  const modal = $('#request-modal');
  if (modal) modal.classList.add('hidden');
}

function resetViewFilters(viewId) {
  const view = state.config.views.find((entry) => entry.id === viewId);
  if (!view) return;

  const searchInput = $(`#search-${viewId}`);
  const statusInput = $(`#status-${viewId}`);
  let changed = false;

  if (searchInput?.value) {
    searchInput.value = '';
    changed = true;
  }
  if (statusInput?.value) {
    statusInput.value = '';
    changed = true;
  }

  if (changed) {
    const listEl = $(`#list-${viewId}`);
    if (listEl) listEl.innerHTML = renderList(view);
  }
}

function jumpToRequest(requestId) {
  state.highlightRequestId = requestId;
  closeRequestModal();
  setTab('requests');
  resetViewFilters('requests');
  setTimeout(() => {
    const card = document.querySelector(`#requests .card[data-id="${requestId}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('highlight');
      setTimeout(() => card.classList.remove('highlight'), 2500);
    }
    state.highlightRequestId = null;
  }, 150);
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  const expandEl = event.target.closest('[data-expand-stocktake]');
  const expandWasteEl = event.target.closest('[data-expand-waste]');
  const saveBtn = event.target.closest('[data-stocktake-save]');
  const confirmBtn = event.target.closest('[data-stocktake-confirm]');
  const wasteApproveBtn = event.target.closest('[data-waste-approve]');
  const wasteDisposeBtn = event.target.closest('[data-waste-dispose]');
  const createWasteFromBatchBtn = event.target.closest('[data-create-waste-from-batch]');
  const viewRequestsBtn = event.target.closest('[data-view-requests]');
  const closeModalBtn = event.target.closest('#close-modal');
  const jumpRequestBtn = event.target.closest('[data-jump-request]');
  const modal = event.target.closest('#request-modal');
  const importPreviewBtn = event.target.closest('[data-import-preview]');
  const importResetBtn = event.target.closest('[data-import-reset]');
  const importConfirmBtn = event.target.closest('[data-import-confirm]');

  if (tab) setTab(tab.dataset.tab);

  if (importPreviewBtn) {
    const csvInput = $('#csv-input');
    const csvText = csvInput?.value || '';
    if (!csvText.trim()) {
      toast('请输入 CSV 内容');
      return;
    }
    try {
      const result = await api('/api/batches/import-preview', {
        method: 'POST',
        body: JSON.stringify({ csvText })
      });
      state.importPreview = result;
      const view = state.config.views.find((v) => v.id === 'batch-import');
      if (view) {
        const viewEl = $('#batch-import');
        if (viewEl) viewEl.outerHTML = renderBatchImportView(view);
      }
      toast(`解析完成：${result.validCount} 条有效，${result.errorCount} 条错误`);
    } catch (err) {
      toast(err.message);
    }
    return;
  }

  if (importResetBtn) {
    state.importPreview = null;
    const view = state.config.views.find((v) => v.id === 'batch-import');
    if (view) {
      const viewEl = $('#batch-import');
      if (viewEl) viewEl.outerHTML = renderBatchImportView(view);
    }
    return;
  }

  if (importConfirmBtn) {
    const preview = state.importPreview;
    if (!preview || !preview.validRows?.length) {
      toast('没有可导入的数据');
      return;
    }
    const ok = confirm(`确认导入 ${preview.validCount} 条药剂批次？\n确认后将写入系统，不可撤销。`);
    if (!ok) return;
    try {
      const rows = preview.validRows.map((r) => r.data);
      const result = await api('/api/batches/import-confirm', {
        method: 'POST',
        body: JSON.stringify({ rows, operator: '系统' })
      });
      await load();
      state.importPreview = null;
      const view = state.config.views.find((v) => v.id === 'batch-import');
      if (view) {
        const viewEl = $('#batch-import');
        if (viewEl) viewEl.outerHTML = renderBatchImportView(view);
      }
      toast(`导入成功：${result.importedCount} 条`);
    } catch (err) {
      toast(err.message);
    }
    return;
  }

  if (createWasteFromBatchBtn) {
    const batchId = createWasteFromBatchBtn.dataset.createWasteFromBatch;
    state.preselectedBatchId = batchId;
    setTab('wastes');
    setTimeout(() => {
      const form = document.querySelector('#wastes form[data-create="wastes"]');
      if (form) {
        const batchSelect = form.querySelector('select[name="batchId"]');
        if (batchSelect) {
          batchSelect.value = batchId;
          batchSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const quantityInput = form.querySelector('input[name="quantity"]');
        if (quantityInput) {
          const batch = state.db.batches?.find((b) => b.id === batchId);
          if (batch) quantityInput.value = batch.quantity;
        }
      }
    }, 50);
    toast('已跳转到报废页面，请确认报废信息');
    return;
  }

  if (action) {
    try {
      await api(`/api/action/${action.dataset.action}/${action.dataset.id}`, { method: 'POST' });
      await load();
      toast('已更新');
    } catch (error) {
      toast(error.message);
    }
  }

  if (viewRequestsBtn) {
    openRequestModal(viewRequestsBtn.dataset.viewRequests);
  }

  if (jumpRequestBtn) {
    jumpToRequest(jumpRequestBtn.dataset.jumpRequest);
  }

  if (closeModalBtn || (modal && event.target === modal)) {
    closeRequestModal();
  }

  if (expandEl && !event.target.closest('button') && !event.target.closest('input') && !event.target.closest('select')) {
    const stocktakeId = expandEl.dataset.expandStocktake;
    state.expandedStocktake = state.expandedStocktake === stocktakeId ? null : stocktakeId;
    const view = state.config.views.find((v) => v.id === 'stocktakes');
    if (view) refreshStocktakeList('stocktakes');
  }

  if (saveBtn) {
    const stocktakeId = saveBtn.dataset.stocktakeSave;
    const edits = state.stocktakeEdits[stocktakeId] || [];
    try {
      await api(`/api/stocktakes/${stocktakeId}/items`, {
        method: 'PATCH',
        body: JSON.stringify({ items: edits })
      });
      await load();
      state.expandedStocktake = stocktakeId;
      refreshStocktakeList('stocktakes');
      toast('录入已保存');
    } catch (err) {
      toast(err.message);
    }
  }

  if (confirmBtn) {
    const stocktakeId = confirmBtn.dataset.stocktakeConfirm;
    const stocktake = state.db.stocktakes?.find((s) => s.id === stocktakeId);
    if (!stocktake) return;
    const itemsCount = (stocktake.items || []).length;
    const diffSummary = computeStocktakeDiff(stocktake);
    const diffMsg = diffSummary.surplusCount + diffSummary.deficitCount > 0
      ? `\n\n将产生：盘盈${diffSummary.surplusCount}项(+${diffSummary.surplusQty})，盘亏${diffSummary.deficitCount}项(-${diffSummary.deficitQty})\n对应批次库存将被更新。`
      : `\n\n无差异项，批次库存保持不变。`;
    const ok = confirm(`确认盘点「${stocktake.code || stocktake.title}」？\n共${itemsCount}个批次。${diffMsg}\n\n确认后不可撤销。`);
    if (!ok) return;
    try {
      await api(`/api/stocktakes/${stocktakeId}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ confirmedBy: stocktake.operator })
      });
      await load();
      state.expandedStocktake = stocktakeId;
      refreshStocktakeList('stocktakes');
      toast('盘点已确认，库存已同步更新');
    } catch (err) {
      toast(err.message);
    }
  }

  if (expandWasteEl && !event.target.closest('button') && !event.target.closest('input') && !event.target.closest('select')) {
    const wasteId = expandWasteEl.dataset.expandWaste;
    state.expandedWaste = state.expandedWaste === wasteId ? null : wasteId;
    refreshWasteList('wastes');
  }

  if (wasteApproveBtn) {
    const wasteId = wasteApproveBtn.dataset.wasteApprove;
    const waste = state.db.wastes?.find((w) => w.id === wasteId);
    if (!waste) return;
    const batch = state.db.batches?.find((b) => b.id === waste.batchId);
    const unit = batch?.unit || '';
    const ok = confirm(`审批通过报废申请「${waste.code || waste.title}」？\n申请报废：${waste.quantity}${unit}\n\n审批通过后进入待处置状态。`);
    if (!ok) return;
    try {
      await api(`/api/wastes/${wasteId}/approve`, { method: 'POST' });
      await load();
      state.expandedWaste = wasteId;
      refreshWasteList('wastes');
      toast('审批已通过');
    } catch (err) {
      toast(err.message);
    }
  }

  if (wasteDisposeBtn) {
    const wasteId = wasteDisposeBtn.dataset.wasteDispose;
    const waste = state.db.wastes?.find((w) => w.id === wasteId);
    if (!waste) return;
    const batch = state.db.batches?.find((b) => b.id === waste.batchId);
    const unit = batch?.unit || '';
    const edits = state.wasteEdits[wasteId] || {};
    const actualQty = edits.actualQuantity ?? waste.quantity;
    const ok = confirm(`确认处置报废单「${waste.code || waste.title}」？\n实际处置：${actualQty}${unit}\n\n确认后将扣减批次库存，不可撤销。`);
    if (!ok) return;
    try {
      await api(`/api/wastes/${wasteId}/dispose`, {
        method: 'POST',
        body: JSON.stringify({
          actualQuantity: actualQty,
          disposalMethod: edits.disposalMethod || waste.disposalMethod,
          witness: edits.witness || waste.witness,
          operator: edits.operator
        })
      });
      await load();
      state.expandedWaste = wasteId;
      refreshWasteList('wastes');
      toast('处置已确认，库存已扣减');
    } catch (err) {
      toast(err.message);
    }
  }
});

document.addEventListener('input', (event) => {
  const crudView = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (crudView) {
    if (crudView.type === 'stocktake') {
      refreshStocktakeList(crudView.id);
    } else if (crudView.type === 'waste') {
      refreshWasteList(crudView.id);
    } else if (crudView.type === 'audit-logs') {
      refreshAuditLogsList(crudView.id);
    } else {
      const listEl = $(`#list-${crudView.id}`);
      if (listEl) listEl.innerHTML = renderList(crudView);
    }
  }

  const auditView = state.config.views.find((entry) => entry.id && (event.target.id === `action-type-${entry.id}` || event.target.id === `target-collection-${entry.id}`));
  if (auditView && auditView.type === 'audit-logs') {
    refreshAuditLogsList(auditView.id);
  }

  const stInput = event.target.closest('.st-input');
  if (stInput) {
    const stId = stInput.dataset.st;
    const idx = Number(stInput.dataset.idx);
    const field = stInput.dataset.field;
    if (!state.stocktakeEdits[stId]) return;
    const edit = state.stocktakeEdits[stId][idx];
    if (!edit) return;
    let val = stInput.value;
    if (field === 'bookQuantity' || field === 'actualQuantity') {
      val = Number(val || 0);
    }
    edit[field] = val;
    edit.difference = Number(edit.actualQuantity ?? 0) - Number(edit.bookQuantity ?? 0);
    const row = stInput.closest('.stocktake-row');
    if (row) {
      const batch = state.db.batches.find((b) => b.id === edit.batchId);
      const diff = edit.difference;
      const tone = diffTone(diff);
      row.classList.remove('row-surplus', 'row-deficit');
      if (tone) row.classList.add('row-' + tone);
      const diffCell = row.querySelector('.diff-cell');
      if (diffCell) {
        diffCell.className = `diff-cell ${tone}`;
        diffCell.textContent = diffLabel(diff);
      }
      const unit = batch?.unit || '';
      row.querySelectorAll('.unit').forEach((u) => u.textContent = unit);
    }
    const stocktake = state.db.stocktakes?.find((s) => s.id === stId);
    const summaryWrap = row.closest('.stocktake-detail')?.querySelector('.stocktake-summary');
    if (stocktake && summaryWrap) {
      const newSum = computeStocktakeDiff(stocktake);
      const hasDiff = newSum.surplusCount + newSum.deficitCount > 0;
      const diffPart = hasDiff ? `
        <div class="diff-summary">
          <span class="diff-stat surplus">盘盈：${newSum.surplusCount}项（+${newSum.surplusQty || 0}）</span>
          <span class="diff-stat deficit">盘亏：${newSum.deficitCount}项（-${newSum.deficitQty || 0}）</span>
        </div>
      ` : `<div class="diff-summary"><span class="diff-stat consistent">所有批次账实一致</span></div>`;
      summaryWrap.innerHTML = `
        <div class="diff-stat">账面合计：${newSum.totalBook}　实盘合计：${newSum.totalActual}　净差异：${newSum.totalDiff >= 0 ? '+' : ''}${newSum.totalDiff}</div>
        ${diffPart}
      `;
    }
  }

  const wasteInput = event.target.closest('.waste-input');
  if (wasteInput) {
    const wasteId = wasteInput.dataset.waste;
    const field = wasteInput.dataset.field;
    if (!state.wasteEdits[wasteId]) state.wasteEdits[wasteId] = {};
    let val = wasteInput.value;
    if (field === 'actualQuantity') {
      val = Number(val || 0);
    }
    state.wasteEdits[wasteId][field] = val;
  }
});

document.addEventListener('change', (event) => {
  const select = event.target.closest('select[data-auto-fill]');
  if (!select) return;
  applyAutoFill(select);
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  if (view?.type === 'stocktake' && form.dataset.stocktakeCreate !== undefined) {
    const payload = values(form, view);
    payload.status = '草稿';
    payload.items = [];
    payload.history = undefined;
    try {
      const created = await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(payload) });
      form.reset();
      await load();
      state.expandedStocktake = created.id;
      refreshStocktakeList('stocktakes');
      toast('盘点单已创建，请展开并录入实盘数量');
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (view?.type === 'waste' && form.dataset.wasteCreate !== undefined) {
    const payload = values(form, view);
    payload.status = view.defaults?.status || '待审批';
    payload.history = undefined;
    try {
      const created = await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(payload) });
      form.reset();
      await load();
      state.expandedWaste = created.id;
      refreshWasteList('wastes');
      toast('报废申请已提交，等待审批');
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(values(form, view)) });
  form.reset();
  await load();
  toast('已保存');
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
