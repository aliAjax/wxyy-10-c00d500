const USER_STORAGE_KEY = 'wxyy_current_user_id';
const SYSTEM_IMPORT_LABEL = '系统导入';

const state = {
  config: null,
  db: {},
  activeTab: '',
  activeView: '',
  expandedStocktake: null,
  stocktakeEdits: {},
  expandedWaste: null,
  wasteEdits: {},
  highlightRequestId: null,
  preselectedBatchId: null,
  importPreview: null,
  currentUser: null,
  filters: {},
  expandedItems: {},
  activeModal: null,
  stocktakeInputs: {},
  wasteDisposalInputs: {},
  expandedSchedule: null,
  scheduleEdits: {},
  scheduleReturnInputs: {},
  scheduleFormRows: [{}],
  wastePrefill: null,
  expandedProject: null,
  projectClosureSummaries: {}
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
  const incomingHeaders = options.headers || {};
  const headers = {
    'Content-Type': 'application/json',
    ...incomingHeaders
  };
  if (state.currentUser) {
    headers['x-current-user-id'] = state.currentUser.id;
  }
  const fetchOpts = { ...options, headers };
  delete fetchOpts.headers;
  fetchOpts.headers = headers;
  const res = await fetch(path, fetchOpts);
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

function computeCabinetOccupancy(cabinetId, excludeBatchId = null) {
  const cabinet = state.db.cabinets?.find((c) => c.id === cabinetId);
  if (!cabinet) return null;
  const capacity = Number(cabinet.capacity || 0);
  const occupiedQuantity = (state.db.batches || [])
    .filter((b) => b.cabinetId === cabinetId && b.id !== excludeBatchId && b.status !== '已报废')
    .reduce((sum, b) => sum + Number(b.quantity || 0), 0);
  return {
    cabinetId,
    cabinetCode: cabinet.code,
    cabinetArea: cabinet.area,
    cabinetManager: cabinet.manager,
    capacity,
    occupiedQuantity,
    remainingQuantity: capacity - occupiedQuantity,
    occupancyRate: capacity > 0 ? Math.round((occupiedQuantity / capacity) * 100) : 0,
    isOverLimit: occupiedQuantity > capacity,
    isNearFull: capacity > 0 && occupiedQuantity / capacity >= 0.8
  };
}

function getAllCabinetOccupancies() {
  return (state.db.cabinets || []).map((c) => computeCabinetOccupancy(c.id));
}

function getBatchAvailableQuantity(batch) {
  if (!batch) return 0;
  const qty = Number(batch.quantity || 0);
  const reserved = Number(batch.reservedQuantity || 0);
  return Math.max(0, qty - reserved);
}

function aggregateBatchReservedByOthers(batchId, excludeScheduleId) {
  let reservedByOthers = 0;
  (state.db.schedules || []).forEach(s => {
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

function batchAvailabilityInfo(batchId, excludeScheduleId) {
  const batch = (state.db.batches || []).find(b => b.id === batchId);
  if (!batch) return null;
  const stockQty = Number(batch.quantity || 0);
  const reservedByOthers = aggregateBatchReservedByOthers(batchId, excludeScheduleId);
  const available = Math.max(0, stockQty - reservedByOthers);
  return {
    batch,
    stockQty,
    reservedByOthers,
    available,
    unit: batch.unit || ''
  };
}

function occupancyTone(occ) {
  if (!occ) return '';
  if (occ.isOverLimit) return 'bad';
  if (occ.isNearFull) return 'warn';
  return 'ok';
}

function cabinetOptionLabel(cabinet, occ) {
  const base = [cabinet.code, cabinet.area].filter(Boolean).join(' / ');
  if (!occ) return base;
  return `${base}（已用${occ.occupiedQuantity}/${occ.capacity}，剩余${occ.remainingQuantity}）`;
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function cabinetOptionList(collection, labelFields, excludeBatchId = null) {
  const items = state.db[collection] || [];
  return items.map((item) => {
    const occ = computeCabinetOccupancy(item.id, excludeBatchId);
    const label = cabinetOptionLabel(item, occ);
    const disabled = occ?.isOverLimit ? 'disabled' : '';
    return `<option value="${item.id}" ${disabled} data-capacity='${JSON.stringify(occ || {})}'>${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field, prefill = null) {
  const required = field.required ? 'required' : '';
  const prefillValue = prefill && prefill[field.name] !== undefined ? prefill[field.name] : '';
  const defaultOrPrefill = prefillValue !== '' ? prefillValue : (field.default || '');
  const value = defaultOrPrefill ? `value="${escapeHtml(defaultOrPrefill)}"` : '';
  const readonly = field.type === 'display' ? 'readonly' : '';

  if (field.type === 'display') {
    const dataAttr = field.autoFillSource ? `data-auto-fill-target="${field.name}"` : '';
    const displayValue = prefillValue !== '' ? escapeHtml(prefillValue) : '';
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="text" name="${field.name}" value="${displayValue}" ${dataAttr} ${required} readonly></label>`;
  }
  if (field.type === 'textarea') {
    const textAreaValue = prefillValue !== '' ? escapeHtml(prefillValue) : '';
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}>${textAreaValue}</textarea></label>`;
  }
  if (field.type === 'select') {
    const options = field.options.map((option) => {
      const selected = String(prefillValue) === option ? 'selected' : '';
      return `<option ${selected}>${escapeHtml(option)}</option>`;
    }).join('');
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${options}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    const autoFillAttr = field.autoFill ? `data-auto-fill='${JSON.stringify(field.autoFill)}' data-collection="${field.collection}"` : '';
    const selectedValue = prefillValue || '';
    const optionItems = items.map((item) => {
      const label = field.labelFields.map((f) => item[f]).filter(Boolean).join(' / ');
      const selected = String(item.id) === String(selectedValue) ? 'selected' : '';
      return `<option value="${item.id}" ${selected}>${escapeHtml(label)}</option>`;
    }).join('');
    if (field.collection === 'cabinets' && field.name === 'cabinetId') {
      return `
        <label class="${field.wide ? 'wide' : ''}">${field.label}
          <select name="${field.name}" ${required} ${autoFillAttr} data-cabinet-select>
            <option value="">请选择</option>
            ${cabinetOptionList('cabinets', field.labelFields, selectedValue)}
          </select>
        </label>
        <div class="cabinet-capacity-info" data-cabinet-capacity-info></div>
      `;
    }
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required} ${autoFillAttr}><option value="">请选择</option>${optionItems}</select></label>`;
  }
  if (field.type === 'number') {
    let maxAttr = '';
    if (field.name === 'quantity' && prefill && prefill.maxQuantity !== undefined) {
      maxAttr = `max="${prefill.maxQuantity}"`;
    }
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="number" name="${field.name}" ${value} ${maxAttr} min="0" ${required}></label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${readonly} ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyOperatorLabel(entry) {
  if (entry.operatorLabel) return entry.operatorLabel;
  if (entry.operator && typeof entry.operator === 'object' && entry.operator.name) {
    return entry.operator.roleLabel ? `${entry.operator.name}（${entry.operator.roleLabel}）` : entry.operator.name;
  }
  return SYSTEM_IMPORT_LABEL;
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 5).map((entry) => `
    <div class="history-item">
      <span>${fmtDate(entry.at)}</span>
      <span class="history-op">[${escapeHtml(historyOperatorLabel(entry))}]</span>
      <span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span>
    </div>
  `).join('')}</div>`;
}

function values(form, view) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  return { ...view.defaults, ...payload };
}

function canCurrentUser(permType, key) {
  if (!state.currentUser || !state.config?.permissions) return false;
  const allowed = state.config.permissions[permType]?.[key];
  if (!allowed) return true;
  return allowed.includes(state.currentUser.role);
}

function currentUserLabelHtml() {
  if (!state.currentUser) return '<span class="user-switcher-none">未选择用户</span>';
  const u = state.currentUser;
  const roleInfo = state.config.roles?.[u.role] || {};
  const color = roleInfo.color || '#555';
  return `
    <span class="user-chip" style="--uc:${color};">
      <span class="user-avatar" style="background:${color};">${escapeHtml(u.name?.[0] || 'U')}</span>
      <span class="user-name">${escapeHtml(u.name)}</span>
      <span class="user-role" style="color:${color};">${escapeHtml(u.roleLabel)}</span>
      <span class="user-caret">▾</span>
    </span>
  `;
}

function userSwitcherDropdownHtml() {
  const users = state.config?.users || [];
  return `
    <div id="userDropdown" class="user-dropdown hidden">
      <div class="user-dropdown-title">切换当前用户</div>
      <div class="user-list">
        ${users.map((u) => {
          const roleInfo = state.config.roles?.[u.role] || {};
          const color = roleInfo.color || '#555';
          const active = state.currentUser?.id === u.id ? 'active' : '';
          return `
            <button class="user-option ${active}" data-switch-user="${u.id}">
              <span class="user-avatar" style="background:${color};">${escapeHtml(u.name?.[0] || 'U')}</span>
              <span class="user-option-info">
                <span class="user-option-name">${escapeHtml(u.name)}</span>
                <span class="user-option-role" style="color:${color};">${escapeHtml(u.roleLabel)}</span>
              </span>
              ${active ? '<span class="user-check">✓</span>' : ''}
            </button>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderUserSwitcher() {
  const container = $('#user-switcher-container');
  if (!container) return;
  container.innerHTML = currentUserLabelHtml() + userSwitcherDropdownHtml();
}

function switchUser(userId) {
  const user = state.config?.users?.find((u) => u.id === userId);
  if (!user) return;
  state.currentUser = user;
  try { localStorage.setItem(USER_STORAGE_KEY, user.id); } catch (e) {}
  renderUserSwitcher();
  render();
  toast(`已切换到：${user.name}（${user.roleLabel}）`);
}

function renderTabs() {
  const active = state.activeTab || state.activeView || state.config.views[0].id;
  state.activeTab = active;
  state.activeView = active;
  $('#tabs').innerHTML = state.config.views.map((view) => `
    <button class="tab${view.id === active ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
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

function filterActionsByPermission(actions) {
  return actions.filter((action) => canCurrentUser('action', action.id));
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
  actions = filterActionsByPermission(actions);
  const actionsHtml = actions
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  const canCreateWaste = collection === 'batches' && item.status !== '已报废' && canCurrentUser('create', 'wastes');
  const extraActions = canCreateWaste
    ? `<button class="ghost" data-create-waste-from-batch="${item.id}">发起报废</button>`
    : '';
  const allActions = actionsHtml || extraActions
    ? `<div class="actions">${actionsHtml}${extraActions}</div>`
    : '';
  return `<article class="card" data-collection="${collection}" data-id="${item.id}">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${collection === 'batches' ? (() => {
      const availInfo = batchAvailabilityInfo(item.id);
      if (!availInfo) return '';
      return `<div class="detail batch-stock-detail">
        <div>已预占<br><strong>${availInfo.reservedByOthers}${escapeHtml(availInfo.unit)}</strong></div>
        <div>可用库存<br><strong class="${availInfo.available <= 0 ? 'bad-text' : (availInfo.available < Number(item.quantity||0) * 0.3 ? 'warn-text' : 'ok-text')}">${availInfo.available}${escapeHtml(availInfo.unit)}</strong></div>
      </div>`;
    })() : ''}
    ${allActions}
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const query = state.filters[view.id]?.search?.trim() || '';
  const status = state.filters[view.id]?.status || '';
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
  actions = filterActionsByPermission(actions);
  const actionsHtml = actions
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${batch.id}">${escapeHtml(action.label)}</button>`)
    .join('');

  const viewRequestsBtn = openRequests.length > 0
    ? `<button class="ghost" data-view-requests="${batch.id}">查看关联申请</button>`
    : '';

  const canCreateWaste = batch.status !== '已报废' && canCurrentUser('create', 'wastes');
  const wasteFromBatchBtn = canCreateWaste
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
    ${actionsHtml || viewRequestsBtn || wasteFromBatchBtn ? `<div class="actions">${actionsHtml}${viewRequestsBtn}${wasteFromBatchBtn}</div>` : ''}
  </article>`;
}

function renderRiskAlertsView(view) {
  const alertData = computeAlertData();
  const { expiringSoon, expiredNotWasted, lowStock, lockedWithOpenRequests } = alertData;

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

function renderCabinetCapacityCard(occ) {
  const tone = occupancyTone(occ);
  const rate = Math.min(occ.occupancyRate, 100);
  const overAmount = occ.isOverLimit ? occ.occupiedQuantity - occ.capacity : 0;
  const statusHtml = occ.isOverLimit
    ? `<span class="pill bad">⚠️ 已超限 ${overAmount}</span>`
    : occ.isNearFull
    ? `<span class="pill warn">即将满载</span>`
    : `<span class="pill ok">正常</span>`;

  const batchesInCabinet = (state.db.batches || []).filter((b) => b.cabinetId === occ.cabinetId && b.status !== '已报废');
  const batchCount = batchesInCabinet.length;
  const batchPreview = batchesInCabinet.slice(0, 3).map((b) =>
    `<div class="meta">• ${escapeHtml(b.name)} / ${escapeHtml(b.batchNo)}：${b.quantity}${escapeHtml(b.unit || '')}</div>`
  ).join('');
  const moreHint = batchCount > 3 ? `<div class="meta" style="color:var(--accent);">... 还有 ${batchCount - 3} 个批次</div>` : '';

  return `
    <article class="card capacity-card">
      <div class="card-head">
        <div>
          <h3>${escapeHtml(occ.cabinetCode)}</h3>
          <div class="meta">${escapeHtml(occ.cabinetArea)}　负责人：${escapeHtml(occ.cabinetManager || '-')}</div>
        </div>
        ${statusHtml}
      </div>
      <div class="capacity-progress-wrap">
        <div class="capacity-progress-bar capacity-${tone}">
          <div class="capacity-progress-fill" style="width:${Math.max(rate, 2)}%;"></div>
        </div>
        <div class="capacity-labels">
          <span>已占用 <strong class="cap-used">${occ.occupiedQuantity}</strong></span>
          <span>容量 <strong class="cap-total">${occ.capacity}</strong></span>
          <span class="${occ.isOverLimit ? 'cap-bad' : (occ.isNearFull ? 'cap-warn' : 'cap-ok')}">
            剩余 <strong class="cap-remain">${Math.max(occ.remainingQuantity, 0)}</strong>
          </span>
        </div>
      </div>
      <div class="detail" style="grid-template-columns: repeat(2, minmax(0, 1fr));margin-top:10px;">
        <div>批次数量<br><strong>${batchCount} 个</strong></div>
        <div>占用率<br><strong>${rate}%</strong></div>
      </div>
      ${batchCount > 0 ? `
        <div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--line);">
          <div class="meta" style="font-weight:700;margin-bottom:6px;">存放批次：</div>
          ${batchPreview}
          ${moreHint}
        </div>
      ` : '<div class="empty" style="padding:10px;margin-top:8px;">暂无库存</div>'}
    </article>
  `;
}

function renderDashboardView(view) {
  const occList = getAllCabinetOccupancies();
  const overLimitCount = occList.filter((o) => o.isOverLimit).length;
  const nearFullCount = occList.filter((o) => o.isNearFull && !o.isOverLimit).length;
  const totalCapacity = occList.reduce((s, o) => s + o.capacity, 0);
  const totalOccupied = occList.reduce((s, o) => s + o.occupiedQuantity, 0);
  const totalRate = totalCapacity > 0 ? Math.round((totalOccupied / totalCapacity) * 100) : 0;

  const capacityStats = `
    <div class="stats">
      <div class="stat"><span>防爆柜总数</span><strong>${occList.length}</strong></div>
      <div class="stat"><span>总容量 / 已占用</span><strong>${totalOccupied}<span style="font-size:16px;color:var(--muted);"> / ${totalCapacity}</span></strong></div>
      <div class="stat"><span>整体占用率</span><strong>${totalRate}<span style="font-size:16px;color:var(--muted);">%</span></strong></div>
      <div class="stat">
        <span>容量预警</span>
        <strong>
          ${overLimitCount > 0 ? `<span style="color:var(--bad);">${overLimitCount}超限</span> ` : ''}
          ${nearFullCount > 0 ? `<span style="color:var(--warn);">${nearFullCount}满载</span>` : (overLimitCount === 0 ? '<span style="color:var(--ok);">正常</span>' : '')}
        </strong>
      </div>
    </div>
  `;

  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 5);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;

  return `<section class="view active" id="${view.id}">
    ${capacityStats}
    <div class="panel">
      <h2>📦 柜位容量占用情况</h2>
      <div class="capacity-grid">
        ${occList.length ? occList.map(renderCabinetCapacityCard).join('') : '<div class="empty">暂无柜位数据</div>'}
      </div>
    </div>
    <div class="panel" style="margin-top:18px;">
      <h2>${escapeHtml(view.focusTitle)}</h2>
      <div class="list">
        ${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无重点事项</div>'}
      </div>
    </div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  const canCreate = canCurrentUser('create', view.collection);
  const createForm = canCreate ? `
    <form class="panel" data-crud-form="${view.collection}" data-create="${view.collection}" data-view="${view.id}">
      <h2>${escapeHtml(view.formTitle)}</h2>
      <div class="form-grid">${view.fields.map(formField).join('')}</div>
      <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
    </form>
  ` : `
    <div class="panel no-permission-panel">
      <h2>${escapeHtml(view.formTitle)}</h2>
      <div class="no-permission-tip">⚠️ 当前用户无权限创建${escapeHtml(collectionLabel(view.collection))}，请切换到有权限的角色。</div>
    </div>
  `;
  return `<section class="view" id="${view.id}">
    <div class="grid">
      ${createForm}
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input data-search="${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}" value="${escapeHtml(state.filters[view.id]?.search || '')}">
          <select data-status-filter="${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option${state.filters[view.id]?.status === option ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('')}
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

  let suggestionPart = '';
  if (stocktake.status === '已确认' && stocktake.suggestionSummary) {
    const s = stocktake.suggestionSummary;
    const totalDiffs = s.pendingCount || 0 + (s.wasteRegisteredCount || 0) + (s.stockInNotedCount || 0) + (s.completedCount || 0);
    const hasPending = (s.pendingCount || 0) > 0;
    suggestionPart = `
      <div class="diff-summary diff-suggestion-summary">
        <span class="diff-stat ${hasPending ? 'warn' : 'ok'}">
          差异处理：${s.pendingCount || 0}项待处理
          ${s.wasteRegisteredCount ? ` · ${s.wasteRegisteredCount}项已创建报废单` : ''}
          ${s.stockInNotedCount ? ` · ${s.stockInNotedCount}项已补入库备注` : ''}
          ${s.completedCount ? ` · ${s.completedCount}项已处理完成` : ''}
        </span>
      </div>
    `;
  }

  return `
    <div class="stocktake-summary">
      <div class="diff-stat">账面合计：${summary.totalBook ?? '-'}　实盘合计：${summary.totalActual ?? '-'}　净差异：${netDiff >= 0 ? '+' : ''}${netDiff}</div>
      ${diffPart}
      ${suggestionPart}
    </div>
  `;
}

function actionStatusLabel(status) {
  const map = {
    pending: { label: '待处理', tone: 'warn' },
    registered: { label: '已创建报废单', tone: 'ok' },
    completed: { label: '已处理', tone: 'ok' },
    consistent: { label: '账实一致', tone: 'ok' }
  };
  return map[status] || { label: status || '-', tone: '' };
}

function renderStocktakeItemRows(stocktake) {
  const confirmed = stocktake.status === '已确认';
  const edits = state.stocktakeEdits[stocktake.id] || stocktake.items || [];
  const savedMap = {};
  (stocktake.items || []).forEach((it) => { savedMap[it.batchId] = it; });

  const suggestionMap = {};
  (stocktake.diffSuggestions || []).forEach((d) => { suggestionMap[d.batchId] = d; });

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

  const canCreateWaste = canCurrentUser('create', 'wastes');
  const canMarkNote = canCurrentUser('special', 'stocktakes-items');

  return edits.map((item, idx) => {
    const batch = state.db.batches.find((b) => b.id === item.batchId);
    if (!batch) return '';
    const book = Number(item.bookQuantity ?? batch.quantity ?? 0);
    const actual = Number(item.actualQuantity ?? book);
    const diff = actual - book;
    const rowTone = diffTone(diff);
    const diffHtml = `<span class="diff-cell ${rowTone}">${escapeHtml(diffLabel(diff))}</span>`;
    const canEdit = !confirmed && canCurrentUser('special', 'stocktakes-items');
    const inputAttrs = canEdit ? '' : 'readonly disabled';

    const suggestion = suggestionMap[item.batchId] || item;
    const actionStatus = confirmed ? (suggestion.actionStatus || (diff === 0 ? 'consistent' : 'pending')) : null;
    const statusInfo = actionStatus ? actionStatusLabel(actionStatus) : null;

    let actionCell = '';
    if (confirmed && diff !== 0) {
      const suggestionText = suggestion.suggestion || (diff > 0 ? '建议补入库备注' : '建议补登记报废');
      let actionBtn = '';
      let disabledReason = '';

      const deficitQty = Math.abs(diff);
      const stockQty = Number(batch.quantity || 0);
      const reservedQty = Number(batch.reservedQuantity || 0);
      const availableQty = Math.max(0, stockQty - reservedQty);
      const maxAllowed = Math.min(deficitQty, availableQty + deficitQty);

      if (diff < 0 && actionStatus === 'pending' && canCreateWaste) {
        if (batch.status === '已报废') {
          disabledReason = '批次已报废';
          actionBtn = `<span class="pill muted" style="font-size:11px;">⚠ 批次已报废</span>`;
        } else if (maxAllowed <= 0) {
          disabledReason = `无可报废数量（盘亏${deficitQty}${batch.unit || ''}，但可用库存${availableQty}${batch.unit || ''}为负）`;
          actionBtn = `<span class="pill warn" style="font-size:11px;">⚠ 无可报废数量</span>`;
        } else {
          const wasteExists = (state.db.wastes || []).some((w) =>
            w.batchId === item.batchId && w.stocktakeId === stocktake.id &&
            w.status !== '已驳回' && w.status !== '已撤销'
          );
          if (wasteExists) {
            actionBtn = `<span class="pill warn" style="font-size:11px;">⚠ 已有未完成报废单</span>`;
          } else {
            actionBtn = `<button class="ghost danger" data-create-waste-from-stocktake="${stocktake.id}" data-batch-id="${item.batchId}" data-deficit-qty="${deficitQty}" data-available-qty="${availableQty}" style="padding:6px 10px;font-size:12px;">创建报废单草稿</button>`;
          }
        }
      } else if (diff < 0 && actionStatus === 'registered' && suggestion.wasteId) {
        const waste = (state.db.wastes || []).find((w) => w.id === suggestion.wasteId);
        if (waste) {
          const wasteLabel = `${waste.code || waste.id}（${waste.status}）`;
          const canView = true;
          actionBtn = `<span class="pill ok" style="font-size:11px;cursor:pointer;" data-view-waste="${waste.id}" title="点击查看报废单">📋 ${escapeHtml(wasteLabel)}</span>`;
        } else {
          actionBtn = `<span class="pill warn" style="font-size:11px;">⚠ 报废单数据异常</span>`;
        }
      } else if (diff < 0 && actionStatus === 'completed') {
        const wasteLabel = suggestion.actualWasteQty
          ? `已报废 ${suggestion.actualWasteQty}${batch.unit || ''}`
          : '已处理完成';
        actionBtn = `<span class="pill ok" style="font-size:11px;">✓ ${escapeHtml(wasteLabel)}</span>`;
      } else if (diff > 0 && actionStatus === 'pending' && canMarkNote) {
        actionBtn = `<button class="ghost" data-mark-stocktake-note="${stocktake.id}" data-batch-id="${item.batchId}" style="padding:6px 10px;font-size:12px;">标记已补备注</button>`;
      } else if (diff > 0 && actionStatus === 'completed') {
        actionBtn = `<span class="pill ok" style="font-size:11px;">✓ 已补备注</span>`;
      }

      actionCell = `
        <td class="stocktake-action-cell">
          <div class="stocktake-suggestion">
            <span class="meta">${escapeHtml(suggestionText)}</span>
            ${statusInfo ? pill(statusInfo.label, statusInfo.tone) : ''}
          </div>
          ${actionBtn ? `<div class="stocktake-item-actions">${actionBtn}</div>` : ''}
        </td>
      `;
    } else if (confirmed && diff === 0) {
      actionCell = `<td class="stocktake-action-cell">${statusInfo ? pill(statusInfo.label, statusInfo.tone) : ''}</td>`;
    }

    const extraCol = confirmed ? '<th>差异处理建议</th>' : '';
    const extraCellHtml = confirmed ? actionCell : '';
    const extraHeadHtml = confirmed ? '<th>差异处理建议</th>' : '';

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
          <input type="number" class="st-input actual-input" data-stocktake-qty="${stocktake.id}" data-batch-id="${item.batchId}" data-st="${stocktake.id}" data-idx="${idx}" data-field="actualQuantity" value="${actual}" ${inputAttrs} min="0">
          <span class="unit">${escapeHtml(batch.unit || '')}</span>
        </td>
        <td class="num-cell">${diffHtml}</td>
        <td>
          <input type="text" class="st-input remark-input" data-st="${stocktake.id}" data-idx="${idx}" data-field="remark" value="${escapeHtml(item.remark || '')}" ${inputAttrs} placeholder="差异原因...">
        </td>
        ${confirmed ? extraCellHtml : ''}
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

  const canSaveItems = !confirmed && canCurrentUser('special', 'stocktakes-items');
  const canConfirm = !confirmed && canCurrentUser('special', 'stocktakes-confirm') && stocktake.items && stocktake.items.length > 0;

  const headCells = confirmed
    ? '<tr><th>药剂批次</th><th>账面数量</th><th>实盘数量</th><th>差异</th><th>备注/原因</th><th>差异处理建议</th></tr>'
    : '<tr><th>药剂批次</th><th>账面数量</th><th>实盘数量</th><th>差异</th><th>备注/原因</th></tr>';

  let expandContent = '';
  if (isExpanded) {
    const actions = confirmed ? '' : `
      <div class="stocktake-actions">
        ${canSaveItems ? `<button class="ghost" data-stocktake-save="${stocktake.id}">保存录入</button>` : ''}
        ${canConfirm ? `<button class="secondary" data-stocktake-confirm="${stocktake.id}">确认盘点并更新库存</button>` : ''}
        ${!canSaveItems && !canConfirm ? `<span class="no-permission-tip-inline">⚠️ 当前角色无盘点操作权限</span>` : ''}
      </div>
    `;
    expandContent = `
      <div class="stocktake-detail">
        ${confirmed && stocktake.confirmedAt ? `<div class="meta">确认人：${escapeHtml(stocktake.confirmedBy || '-')}　确认时间：${fmtDate(stocktake.confirmedAt)}</div>` : ''}
        ${diffHtml}
        <table class="stocktake-table">
          <thead>
            ${headCells}
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
  const query = state.filters[view.id]?.search?.trim() || '';
  const status = state.filters[view.id]?.status || '';
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
  const canCreate = canCurrentUser('create', 'stocktakes');
  const createForm = canCreate ? `
    <form class="panel" data-stocktake-form data-create="${view.collection}" data-view="${view.id}">
      <h2>${escapeHtml(view.formTitle)}</h2>
      <div class="form-grid">${view.fields.map(formField).join('')}</div>
      <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
    </form>
  ` : `
    <div class="panel no-permission-panel">
      <h2>${escapeHtml(view.formTitle)}</h2>
      <div class="no-permission-tip">⚠️ 当前用户无权限创建盘点单，请切换到有权限的角色。</div>
    </div>
  `;
  return `<section class="view" id="${view.id}">
    <div class="grid">
      ${createForm}
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input data-search="${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}" value="${escapeHtml(state.filters[view.id]?.search || '')}">
          <select data-status-filter="${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option${state.filters[view.id]?.status === option ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('')}
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

  const qty = Number(waste.quantity || 0);
  const disposedQty = Number(waste.disposedQuantity ?? waste.actualQuantity ?? 0);
  const remainingQty = Number(waste.remainingQuantity ?? (qty - disposedQty));
  const disposalCount = Number(waste.disposalCount ?? (disposedQty > 0 ? 1 : 0));
  const progressPct = qty > 0 ? Math.min(100, Math.round((disposedQty / qty) * 100)) : 0;

  const canApprove = waste.status === '待审批' && canCurrentUser('special', 'wastes-approve');
  const canReject = waste.status === '待审批' && canCurrentUser('action', 'waste-reject');
  const canDispose = (waste.status === '待处置' || waste.status === '部分处置') && canCurrentUser('special', 'wastes-dispose');

  let expandContent = '';
  if (isExpanded) {
    const detailRows = (view.detailFields || []).map((field) => {
      let value;
      if (field.type === 'relation') {
        value = relationLabel(field, waste[field.name]);
      } else if (field.name === 'disposedQuantity') {
        value = disposedQty > 0 ? `${disposedQty}${unit}` : '-';
      } else if (field.name === 'remainingQuantity') {
        value = remainingQty > 0 ? `${remainingQty}${unit}` : (waste.status === '已处置' ? '0' + unit : '-');
      } else if (field.name === 'disposalCount') {
        value = disposalCount > 0 ? disposalCount + '次' : '-';
      } else {
        value = waste[field.name];
      }
      const displayValue = value === null || value === undefined || value === '' ? '-' : value;
      return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(displayValue)}</strong></div>`;
    }).join('');

    let disposalRecordsHtml = '';
    if (Array.isArray(waste.disposalRecords) && waste.disposalRecords.length > 0) {
      disposalRecordsHtml = `
        <div class="waste-disposal-records">
          <h4>处置明细记录（${waste.disposalRecords.length}次）</h4>
          <div class="disposal-records-table">
            <div class="dr-table-head">
              <span>序号</span>
              <span>处置数量</span>
              <span>处置方式</span>
              <span>见证人</span>
              <span>扣减库存</span>
              <span>盘亏抵充</span>
              <span>处置人</span>
              <span>处置时间</span>
              <span>备注</span>
            </div>
            ${waste.disposalRecords.map((r) => `
              <div class="dr-table-row">
                <span class="dr-seq" data-label="序号">#${r.seq}</span>
                <span class="dr-qty" data-label="处置数量"><strong>${r.actualQuantity}${escapeHtml(unit)}</strong></span>
                <span data-label="处置方式">${escapeHtml(r.disposalMethod || '-')}</span>
                <span data-label="见证人">${escapeHtml(r.witness || '-')}</span>
                <span class="dr-stock" data-label="扣减库存">${Number(r.deductFromStock || 0) > 0 ? '-' + r.deductFromStock + escapeHtml(unit) : '-'}</span>
                <span class="dr-offset" data-label="盘亏抵充">${Number(r.offsetByStocktake || 0) > 0 ? r.offsetByStocktake + escapeHtml(unit) : '-'}</span>
                <span data-label="处置人">${escapeHtml(r.disposedBy || '-')}</span>
                <span class="dr-time" data-label="处置时间">${fmtDate(r.disposedAt)}</span>
                <span class="dr-note" data-label="备注">${escapeHtml(r.note || '-')}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    let actionButtons = '';
    if (waste.status === '待审批') {
      actionButtons = `
        <div class="waste-actions">
          ${canApprove ? `<button class="secondary" data-waste-approve="${waste.id}">审批通过</button>` : ''}
          ${canReject ? `<button class="danger" data-action="waste-reject" data-id="${waste.id}">驳回</button>` : ''}
          ${!canApprove && !canReject ? `<span class="no-permission-tip-inline">⚠️ 当前角色无报废审批权限</span>` : ''}
        </div>
      `;
    } else if (waste.status === '待处置' || waste.status === '部分处置') {
      const maxDisposeQty = remainingQty > 0 ? remainingQty : waste.quantity;
      const defaultActualQty = state.wasteEdits[waste.id]?.actualQuantity ?? maxDisposeQty;
      const lastRecord = (waste.status === '部分处置' && Array.isArray(waste.disposalRecords) && waste.disposalRecords.length > 0)
        ? waste.disposalRecords[waste.disposalRecords.length - 1]
        : null;
      const disposalMethod = state.wasteEdits[waste.id]?.disposalMethod
        || lastRecord?.disposalMethod
        || waste.disposalMethod
        || '';
      const witness = state.wasteEdits[waste.id]?.witness
        || lastRecord?.witness
        || waste.witness
        || '';
      const disposalNote = state.wasteEdits[waste.id]?.disposalNote
        || waste.disposalNote
        || '';
      const disabledAttr = canDispose ? '' : 'readonly disabled';
      const statusHint = waste.status === '部分处置' ? `<div class="partial-disposal-hint">📌 当前处于部分处置状态，已处置 ${disposedQty}/${qty}${escapeHtml(unit)}，剩余 ${remainingQty}${escapeHtml(unit)} 可继续处置</div>` : '';
      actionButtons = `
        <div class="waste-dispose-form">
          <h4>${waste.status === '部分处置' ? '继续处置' : '确认处置'}</h4>
          ${statusHint}
          <div class="form-grid">
            <label>本次处置数量<input type="number" class="waste-input" data-waste-actual="${waste.id}" data-waste="${waste.id}" data-field="actualQuantity" value="${defaultActualQty}" min="0" max="${maxDisposeQty}" ${disabledAttr}><span class="unit">${escapeHtml(unit)}　(剩余可处置: ${maxDisposeQty}${escapeHtml(unit)})</span></label>
            <label>处置方式
              <select class="waste-input" data-waste-method="${waste.id}" data-waste="${waste.id}" data-field="disposalMethod" ${canDispose ? '' : 'disabled'}>
                <option value="">请选择</option>
                <option value="专业机构回收" ${disposalMethod === '专业机构回收' ? 'selected' : ''}>专业机构回收</option>
                <option value="化学中和销毁" ${disposalMethod === '化学中和销毁' ? 'selected' : ''}>化学中和销毁</option>
                <option value="深埋处理" ${disposalMethod === '深埋处理' ? 'selected' : ''}>深埋处理</option>
                <option value="其他" ${disposalMethod === '其他' ? 'selected' : ''}>其他</option>
              </select>
            </label>
            <label>见证人<input type="text" class="waste-input" data-waste-witness="${waste.id}" data-waste="${waste.id}" data-field="witness" value="${escapeHtml(witness)}" ${disabledAttr}></label>
            <label class="wide">处置备注<input type="text" class="waste-input" data-waste-note="${waste.id}" data-waste="${waste.id}" data-field="disposalNote" value="${escapeHtml(disposalNote)}" ${disabledAttr} placeholder="记录本次处置过程中的特殊情况..."></label>
          </div>
          <div class="waste-actions">
            ${canDispose ? `<button class="danger" data-waste-dispose="${waste.id}">${waste.status === '部分处置' ? '确认继续处置并扣减库存' : '确认处置并扣减库存'}</button>` : `<span class="no-permission-tip-inline">⚠️ 当前角色无报废处置权限</span>`}
          </div>
        </div>
      `;
    } else if (waste.status === '已处置') {
      actionButtons = `
        <div class="waste-disposed-info">
          <h4>处置完成详情</h4>
          <div class="form-grid">
            <div class="meta">申请数量<br><strong>${qty} ${escapeHtml(unit)}</strong></div>
            <div class="meta">累计已处置<br><strong>${disposedQty} ${escapeHtml(unit)}</strong></div>
            <div class="meta">处置次数<br><strong>${disposalCount}次</strong></div>
            <div class="meta">最终处置方式<br><strong>${escapeHtml(waste.disposalMethod || '-')}</strong></div>
            <div class="meta">见证人<br><strong>${escapeHtml(waste.witness || '-')}</strong></div>
            <div class="meta">最终处置人<br><strong>${escapeHtml(waste.disposedBy || '-')}</strong></div>
          </div>
          <div class="meta" style="margin-top:8px;">最终处置时间：${fmtDate(waste.disposedAt)}</div>
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
        <div class="waste-progress-section">
          <div class="waste-progress-header">
            <span>处置进度</span>
            <span class="waste-progress-numbers"><strong>${disposedQty}</strong> / ${qty} ${escapeHtml(unit)} · 剩余 <strong>${remainingQty}</strong> ${escapeHtml(unit)} · ${progressPct}%</span>
          </div>
          <div class="waste-progress-bar">
            <div class="waste-progress-fill" style="width:${progressPct}%;"></div>
          </div>
        </div>
        <div class="detail">${detailRows}</div>
        ${disposalRecordsHtml}
        ${actionButtons}
      </div>
    `;
  }

  const qtySummary = disposedQty > 0
    ? `<span class="meta">申请：${qty}${escapeHtml(unit)} · 已处置：<strong>${disposedQty}</strong>${escapeHtml(unit)} · 剩余：<strong>${remainingQty}</strong>${escapeHtml(unit)}</span>`
    : `<span class="meta">申请数量：${qty}${escapeHtml(unit)}</span>`;

  return `<article class="card waste-card ${waste.status === '部分处置' ? 'waste-partial' : ''}">
    <div class="card-head" data-expand-waste="${waste.id}" style="cursor:pointer;">
      <div>
        <h3>${escapeHtml(title)}</h3>
        <div class="meta">批次：${escapeHtml(batchLabel)}　${summary ? escapeHtml(summary) : ''}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        ${pill(waste.status, toneFor(waste.status))}
        ${qtySummary}
        <span class="meta">${isExpanded ? '▲ 收起' : '▼ 展开详情'}</span>
      </div>
    </div>
    ${expandContent}
    ${historyHtml(waste)}
  </article>`;
}

function renderWasteList(view) {
  const query = state.filters[view.id]?.search?.trim() || '';
  const status = state.filters[view.id]?.status || '';
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
  const canCreate = canCurrentUser('create', 'wastes');
  const prefill = state.wastePrefill;
  let alertToneClass = '';
  let alertLabel = '';
  let alertIcon = '📦';
  if (prefill?.alertType === 'expired') {
    alertToneClass = 'expired';
    alertLabel = '已过期批次发起报废';
    alertIcon = '⚠️';
  } else if (prefill?.alertType === 'expiring') {
    alertToneClass = 'expiring';
    alertLabel = '临期批次发起报废';
    alertIcon = '⏰';
  } else if (prefill?.alertType === 'stocktake-deficit') {
    alertToneClass = 'stocktake';
    alertLabel = '盘点盘亏发起报废';
    alertIcon = '🔍';
  }
  const extraMeta = prefill?.stocktakeInfo
    ? `　盘点单：${escapeHtml(prefill.stocktakeInfo.stocktakeCode || prefill.stocktakeInfo.stocktakeId)}，盘亏：${prefill.stocktakeInfo.deficitQty || 0}${escapeHtml(prefill.unit || '')}`
    : '';
  const alertBanner = prefill ? `
    <div class="waste-prefill-banner ${alertToneClass}">
      <span class="waste-prefill-icon">${alertIcon}</span>
      <div class="waste-prefill-info">
        <strong>${escapeHtml(alertLabel || '发起报废申请')}</strong>
        <span class="meta">批次：${escapeHtml(prefill.batchName || '')} / ${escapeHtml(prefill.batchNo || '')}，库存：${prefill.quantity || 0}${escapeHtml(prefill.unit || '')}，有效期：${escapeHtml(prefill.expiresAt || '未设置')}${extraMeta}</span>
      </div>
      <button type="button" class="ghost waste-prefill-clear" data-clear-waste-prefill>清除预填</button>
    </div>
  ` : '';
  const prefillFormData = prefill ? {
    code: prefill.suggestedCode || '',
    title: prefill.suggestedTitle || '',
    batchId: prefill.batchId || '',
    maxQuantity: prefill.quantity || 0,
    unit: prefill.unit || '',
    suggestTitle: prefill.suggestedTitle || '',
    quantity: prefill.quantity || 0,
    maxQuantity_raw: prefill.quantity || 0,
    reason: prefill.suggestedReason || '',
    applicant: state.currentUser?.name || '',
    stocktakeId: prefill.stocktakeId || '',
    ...prefill
  } : null;
  const stocktakeHidden = prefill?.stocktakeId
    ? `<input type="hidden" name="stocktakeId" value="${escapeHtml(prefill.stocktakeId)}">`
    : '';
  const createForm = canCreate ? `
    <form class="panel" data-waste-form data-create="${view.collection}" data-view="${view.id}" ${prefill ? 'data-waste-prefill="true"' : ''}>
      <h2>${escapeHtml(view.formTitle)}</h2>
      ${alertBanner}
      ${stocktakeHidden}
      <div class="form-grid">${view.fields.map((f) => formField(f, prefillFormData)).join('')}</div>
      <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
    </form>
  ` : `
    <div class="panel no-permission-panel">
      <h2>${escapeHtml(view.formTitle)}</h2>
      <div class="no-permission-tip">⚠️ 当前用户无权限创建报废单，请切换到有权限的角色。</div>
    </div>
  `;
  return `<section class="view" id="${view.id}">
    <div class="grid">
      ${createForm}
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input data-search="${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}" value="${escapeHtml(state.filters[view.id]?.search || '')}">
          <select data-status-filter="${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option${state.filters[view.id]?.status === option ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('')}
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

  const opLabel = log.operator && log.operator !== SYSTEM_IMPORT_LABEL ? log.operator : SYSTEM_IMPORT_LABEL;

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
      <div>操作人<br><strong>${escapeHtml(opLabel)}</strong></div>
    </div>
    ${changesHtml}
  </article>`;
}

function getFilteredAuditLogsCount(viewId) {
  const actionType = state.filters[viewId]?.actionType || '';
  const targetColl = state.filters[viewId]?.targetCollection || '';
  const keyword = state.filters[viewId]?.search?.trim() || '';

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

  return items.length;
}

function renderAuditLogsList(view) {
  const actionType = state.filters[view.id]?.actionType || '';
  const targetColl = state.filters[view.id]?.targetCollection || '';
  const keyword = state.filters[view.id]?.search?.trim() || '';

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
  const f = state.filters[view.id] || {};
  const filteredCount = getFilteredAuditLogsCount(view.id);

  return `<section class="view" id="${view.id}">
    <div class="panel">
      <div class="audit-header">
        <div>
          <h2>操作审计日志</h2>
          <p class="meta">所有关键操作均会自动记录，日志只读不可修改。当前筛选结果共 <strong>${filteredCount}</strong> 条。</p>
        </div>
        <button class="export-btn" data-export-audit="${view.id}">
          <span class="export-icon">⬇</span> 导出 CSV
        </button>
      </div>
      <div class="audit-toolbar">
        <select data-audit-action="${view.id}">
          <option value="">全部操作类型</option>
          ${actionTypes.map((type) => `<option${f.actionType === type ? ' selected' : ''}>${escapeHtml(type)}</option>`).join('')}
        </select>
        <select data-audit-collection="${view.id}">
          <option value="">全部目标集合</option>
          ${targetCollections.map((coll) => `<option value="${coll}"${f.targetCollection === coll ? ' selected' : ''}>${escapeHtml(collectionLabel(coll))}</option>`).join('')}
        </select>
        <input data-search="${view.id}" placeholder="搜索关键词（标题、备注、操作人等）" value="${escapeHtml(f.search || '')}">
      </div>
      <div class="list" id="list-${view.id}">${renderAuditLogsList(view)}</div>
    </div>
  </section>`;
}

function renderPendingEditForm(row, type) {
  const pendingData = row.pendingCreate[type];
  if (!pendingData) return '';

  const isSupplier = type === 'supplier';
  const fields = isSupplier
    ? [
        { key: 'name', label: '供应商名称', required: true, readonly: true },
        { key: 'contact', label: '联系人', required: true, type: 'text' },
        { key: 'phone', label: '联系电话', required: false, type: 'text' },
        { key: 'category', label: '供应品类', required: true, type: 'text' },
        { key: 'riskLevel', label: '风险等级', required: false, type: 'select', options: ['低', '中', '高'] },
        { key: 'certExpiresAt', label: '资质到期日', required: true, type: 'date' }
      ]
    : [
        { key: 'code', label: '柜位编号', required: true, readonly: true },
        { key: 'area', label: '所在区域', required: true, type: 'text' },
        { key: 'capacity', label: '容量上限', required: true, type: 'number' },
        { key: 'manager', label: '负责人', required: true, type: 'text' },
        { key: 'status', label: '状态', required: false, type: 'select', options: ['空闲', '使用中', '已满', '停用'] }
      ];

  const requiredMissing = fields.filter(f => f.required && !pendingData[f.key]).length;
  const statusClass = requiredMissing > 0 ? 'pending-incomplete' : 'pending-complete';

  return `
    <div class="pending-edit-form ${statusClass}">
      <div class="pending-edit-header">
        <span class="pill pending">📝 待创建${isSupplier ? '供应商' : '柜位'}：${escapeHtml(isSupplier ? pendingData.name : pendingData.code)}</span>
        ${requiredMissing > 0 
          ? `<span class="pill bad">⚠ 缺少 ${requiredMissing} 个必填字段</span>`
          : `<span class="pill ok">✓ 字段完整</span>`}
      </div>
      <form class="pending-edit-grid" data-pending-form="${type}-${row.rowIndex}">
        ${fields.map(f => {
          const name = `${type}_${row.rowIndex}_${f.key}`;
          const value = pendingData[f.key] || '';
          const required = f.required ? 'required' : '';
          const readonly = f.readonly ? 'readonly' : '';
          if (f.type === 'select') {
            return `
              <label>
                ${escapeHtml(f.label)}${f.required ? ' *' : ''}
                <select name="${name}" ${required} ${readonly ? 'disabled' : ''}>
                  ${f.options.map(opt => `<option value="${opt}" ${value === opt ? 'selected' : ''}>${opt}</option>`).join('')}
                </select>
              </label>
            `;
          }
          return `
            <label>
              ${escapeHtml(f.label)}${f.required ? ' *' : ''}
              <input type="${f.type || 'text'}" name="${name}" value="${escapeHtml(value)}" ${required} ${readonly}>
            </label>
          `;
        }).join('')}
        <div class="pending-edit-actions">
          <button type="button" class="ghost" data-pending-edit="${row.rowIndex}" data-pending-type="${type}">保存字段</button>
        </div>
      </form>
    </div>
  `;
}

function renderBatchImportView(view) {
  const canImport = canCurrentUser('special', 'batches-import');
  const preview = state.importPreview;
  const hasPreview = preview && preview.totalRows > 0;

  const sampleCsv = `药剂名称,品类,批次号,供应商,存放柜位,安全等级,库存数量,单位,有效期,状态
冷焰火粉A17,冷焰火,PY-A17-2606,华光烟火科技,防爆柜B-2,高,20,罐,2027-05-30,可用
高空喷射礼花B03,礼花,LH-B03-2606,华光烟火科技,防爆柜C-1,中,15,发,2027-03-15,可用`;

  let summaryHtml = '';
  let tableHtml = '';
  let inputArea = '';
  let pendingFormsHtml = '';

  if (!canImport) {
    inputArea = `
      <div class="no-permission-panel">
        <div class="no-permission-tip" style="font-size:15px;padding:24px;">⚠️ 当前用户无批量导入权限，请切换到库管员角色。</div>
      </div>
    `;
  } else if (!hasPreview) {
    inputArea = `
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
          <p class="meta">必填字段：药剂名称、品类、批次号、供应商、存放柜位、库存数量、单位、有效期</p>
          <p class="meta">供应商和柜位如不存在，系统将标记为「待创建」，请在预览中补齐必填字段后再导入</p>
        </div>
        <div class="import-actions">
          <button data-import-preview>解析预览</button>
        </div>
      </div>
    `;
  }

  if (hasPreview) {
    const totalImportable = (preview.validCount || 0) + (preview.pendingCount || 0);

    summaryHtml = `
      <div class="import-summary">
        <div class="import-stat import-stat-total">
          <span class="import-stat-label">解析总行数</span>
          <strong>${preview.totalRows}</strong>
        </div>
        <div class="import-stat import-stat-valid">
          <span class="import-stat-label">有效行</span>
          <strong>${preview.validCount || 0}</strong>
        </div>
        <div class="import-stat import-stat-pending">
          <span class="import-stat-label">待创建</span>
          <strong>${preview.pendingCount || 0}</strong>
        </div>
        <div class="import-stat import-stat-error">
          <span class="import-stat-label">错误行</span>
          <strong>${preview.errorCount || 0}</strong>
        </div>
      </div>
      <div class="import-error-summary">
        ${preview.missingCount > 0 ? `<span class="pill bad">缺失必填项：${preview.missingCount} 行</span>` : ''}
        ${preview.quantityErrorCount > 0 ? `<span class="pill bad">数量格式错误：${preview.quantityErrorCount} 行</span>` : ''}
        ${preview.duplicateBatchNos.length > 0 ? `<span class="pill warn">重复批次号：${preview.duplicateBatchNos.slice(0, 5).join('、')}${preview.duplicateBatchNos.length > 5 ? '...' : ''}</span>` : ''}
        ${preview.pendingSupplierNames?.length > 0 ? `<span class="pill pending">待创建供应商：${preview.pendingSupplierNames.slice(0, 5).join('、')}${preview.pendingSupplierNames.length > 5 ? '...' : ''}</span>` : ''}
        ${preview.pendingCabinetCodes?.length > 0 ? `<span class="pill pending">待创建柜位：${preview.pendingCabinetCodes.slice(0, 5).join('、')}${preview.pendingCabinetCodes.length > 5 ? '...' : ''}</span>` : ''}
      </div>
    `;

    const allRows = [
      ...(preview.validRows || []).map((r) => ({ ...r, rowType: 'valid' })),
      ...(preview.pendingRows || []).map((r) => ({ ...r, rowType: 'pending' })),
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
            ${allRows.map((row) => {
              let statusHtml = '';
              if (row.rowType === 'valid') {
                statusHtml = '<span class="pill ok">✓ 有效</span>';
              } else if (row.rowType === 'pending') {
                const pendingInfo = [];
                if (row.pendingCreate?.supplier) {
                  pendingInfo.push(`供应商「${row.supplierName}」待创建`);
                }
                if (row.pendingCreate?.cabinet) {
                  pendingInfo.push(`柜位「${row.cabinetName}」待创建`);
                }
                statusHtml = `<div class="import-errors">
                  <span class="pill pending">⏳ 待创建</span>
                  ${pendingInfo.map(info => `<span class="pill pending-sm">${escapeHtml(info)}</span>`).join('')}
                </div>`;
              } else {
                statusHtml = `<div class="import-errors">${row.errors.map((e) => `<span class="pill bad">${escapeHtml(e)}</span>`).join('')}</div>`;
              }
              return `
                <tr class="import-row import-row-${row.rowType}">
                  <td class="col-idx">${row.rowIndex}</td>
                  ${displayFields.map((f) => `<td>${escapeHtml(row.data[f.key] || '-')}</td>`).join('')}
                  <td class="col-status">${statusHtml}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    if (preview.pendingRows && preview.pendingRows.length > 0) {
      pendingFormsHtml = `
        <div class="pending-forms-section">
          <h3 style="margin-top:20px;margin-bottom:12px;font-size:16px;">📝 待创建记录 - 请补齐必填字段</h3>
          <div class="pending-forms-grid">
            ${preview.pendingRows.map(row => `
              ${row.pendingCreate?.supplier ? renderPendingEditForm(row, 'supplier') : ''}
              ${row.pendingCreate?.cabinet ? renderPendingEditForm(row, 'cabinet') : ''}
            `).join('')}
          </div>
        </div>
      `;
    }

    const canConfirm = totalImportable > 0 && (preview.pendingCount || 0) === (preview.pendingRows || []).filter(row => {
      let complete = true;
      if (row.pendingCreate?.supplier) {
        const s = row.pendingCreate.supplier;
        complete = complete && s.contact && s.category && s.certExpiresAt;
      }
      if (row.pendingCreate?.cabinet) {
        const c = row.pendingCreate.cabinet;
        complete = complete && c.area && c.capacity && c.manager;
      }
      return complete;
    }).length;

    tableHtml += `
      <div class="import-actions">
        <button class="secondary" data-import-reset>重新输入</button>
        <button data-import-confirm ${canConfirm ? '' : 'disabled'}>
          确认导入 ${totalImportable} 条
          ${preview.pendingCount > 0 ? `（含待创建 ${preview.pendingCount} 条）` : ''}
        </button>
      </div>
    `;
  }

  return `<section class="view" id="${view.id}">
    <div class="panel">
      <h2>批量导入药剂批次</h2>
      <p class="meta">粘贴 CSV 文本，支持中文表头。系统会先预览解析结果，供应商或柜位不存在时将标记为「待创建」，请补齐字段后再导入。</p>
      ${inputArea}
      ${summaryHtml}
      ${tableHtml}
      ${pendingFormsHtml}
    </div>
  </section>`;
}

function renderScheduleFormRows() {
  const rows = state.scheduleFormRows || [{}];
  const batches = (state.db.batches || []).filter(b => b.status === '可用');
  return rows.map((row, idx) => {
    const selectedBatch = batches.find(b => b.id === row.batchId);
    const availInfo = selectedBatch ? batchAvailabilityInfo(selectedBatch.id) : null;
    const stockQty = availInfo ? availInfo.stockQty : 0;
    const reservedByOthers = availInfo ? availInfo.reservedByOthers : 0;
    const availableQty = availInfo ? availInfo.available : 0;
    const unit = selectedBatch ? selectedBatch.unit : '';
    const canRemove = rows.length > 1;
    return `<tr class="schedule-form-row">
      <td>
        <select data-sched-row="${idx}" data-sched-field="batchId">
          <option value="">请选择批次</option>
          ${batches.map(b => {
            const bInfo = batchAvailabilityInfo(b.id);
            const bAvail = bInfo ? bInfo.available : 0;
            const bRes = bInfo ? bInfo.reservedByOthers : 0;
            const bStock = bInfo ? bInfo.stockQty : 0;
            const disabled = bAvail <= 0 ? 'disabled' : '';
            return `<option value="${b.id}" ${row.batchId === b.id ? 'selected' : ''} ${disabled}>${escapeHtml(b.name + ' / ' + b.batchNo)}${bAvail <= 0 ? '（无可用）' : '（可申请' + bAvail + b.unit + ' / 库存' + bStock + b.unit + ' / 已预占' + bRes + b.unit + ' / 等级：' + b.safetyLevel + '）'}</option>`;
          }).join('')}
        </select>
        ${selectedBatch ? `
        <div class="batch-stock-info">
          <span class="stock-line"><span class="stock-label">库存：</span><strong>${stockQty}${escapeHtml(unit)}</strong></span>
          <span class="stock-line reserved"><span class="stock-label">已预占：</span><strong>${reservedByOthers}${escapeHtml(unit)}</strong></span>
          <span class="stock-line available"><span class="stock-label">可申请：</span><strong>${availableQty}${escapeHtml(unit)}</strong></span>
        </div>` : ''}
      </td>
      <td>
        <input type="text" data-sched-row="${idx}" data-sched-field="sprayPoint" placeholder="如：舞台左侧" value="${escapeHtml(row.sprayPoint || '')}">
      </td>
      <td>
        <select data-sched-row="${idx}" data-sched-field="safetyLevel">
          <option value="低" ${row.safetyLevel === '低' ? 'selected' : ''}>低</option>
          <option value="中" ${row.safetyLevel === '中' ? 'selected' : ''}>中</option>
          <option value="高" ${row.safetyLevel === '高' ? 'selected' : ''}>高</option>
        </select>
      </td>
      <td class="num-cell">
        <input type="number" min="1" max="${availableQty || ''}" data-sched-row="${idx}" data-sched-field="quantity" value="${row.quantity || ''}" placeholder="数量">
        <span class="unit">${escapeHtml(unit)}</span>
      </td>
      <td>
        ${canRemove ? `<button type="button" class="danger" data-sched-remove-row="${idx}">删除</button>` : ''}
      </td>
    </tr>`;
  }).join('');
}

function collectScheduleFormData() {
  const form = document.querySelector('[data-schedule-form]');
  if (!form) return {};
  const data = {};
  const fd = new FormData(form);
  for (const [k, v] of fd.entries()) {
    if (v === '' || v === null || v === undefined) continue;
    if (!isNaN(Number(v)) && v !== '' && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) {
      data[k] = Number(v);
    } else {
      data[k] = v;
    }
  }
  const rows = state.scheduleFormRows || [{}];
  data.items = rows.map(r => ({
    batchId: r.batchId || '',
    sprayPoint: r.sprayPoint || '',
    safetyLevel: r.safetyLevel || '低',
    quantity: Number(r.quantity || 0)
  }));
  return data;
}

function renderScheduleBoardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter(item => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 10);
  const pending = (state.db.schedules || []).filter(s => s.status === '调度待审批').length;
  const approved = (state.db.schedules || []).filter(s => s.status === '调度已审批').length;
  const issued = (state.db.schedules || []).filter(s => s.status === '调度已出库').length;
  const done = (state.db.schedules || []).filter(s => s.status === '调度已回库').length;
  const boardStats = `
    <div class="stats">
      <div class="stat"><span>调度待审批</span><strong>${pending}</strong></div>
      <div class="stat"><span>调度已审批</span><strong>${approved}</strong></div>
      <div class="stat"><span>调度已出库</span><strong>${issued}</strong></div>
      <div class="stat"><span>调度已回库</span><strong>${done}</strong></div>
    </div>
  `;
  const schedCards = items.length ? items.map(item => {
    const viewCfg = state.config.views.find(v => v.id === 'schedules');
    return renderScheduleCard(item, viewCfg || {});
  }).join('') : '<div class="empty">暂无流转中的调度单</div>';
  const jumpBtn = `<div style="margin:12px 0;"><button class="secondary" data-jump-schedules>进入用药调度 →</button></div>`;
  return `<section class="view" id="${view.id}">
    ${renderStats()}
    ${boardStats}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2>${jumpBtn}<div class="list">${schedCards}</div></div>
  </section>`;
}

function renderScheduleCard(schedule, view) {
  const isExpanded = state.expandedSchedule === schedule.id;
  const title = [schedule.code, schedule.showName].filter(Boolean).join(' / ') || schedule.id;
  const statusValue = schedule[view.statusField];
  const summary = (view.summaryFields || []).map(f => schedule[f]).filter(Boolean).join(' · ');
  const projectLabel = relationLabel({ collection: 'projects', labelFields: ['name', 'venue'] }, schedule.projectId);
  const itemsCount = (schedule.items || []);
  const totalQty = itemsCount.reduce((s, it) => s + (it.quantity || 0), 0);
  const canApprove = schedule.status === '调度待审批' && canCurrentUser('special', 'schedules-approve');
  const canReject = schedule.status === '调度待审批' && canCurrentUser('action', 'schedule-reject');
  const canIssue = schedule.status === '调度已审批' && canCurrentUser('special', 'schedules-issue');
  const canReturn = schedule.status === '调度已出库' && canCurrentUser('special', 'schedules-return');
  const canDelete = ['调度待审批', '调度已驳回'].includes(schedule.status) && canCurrentUser('delete', 'schedules');
  let expandContent = '';
  if (isExpanded) {
    const detailRows = (view.detailFields || []).map(field => {
      let value;
      if (field.type === 'computed') {
        if (field.compute === 'countItems') value = itemsCount.length;
        else if (field.compute === 'sumItems') value = totalQty;
        else value = '-';
      } else if (field.type === 'relation') {
        value = relationLabel(field, schedule[field.name]);
      } else {
        value = schedule[field.name];
      }
      const displayValue = value === null || value === undefined || value === '' ? '-' : value;
      return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(displayValue)}</strong></div>`;
    }).join('');
    const itemsTable = `
      <table class="schedule-items-table">
        <thead>
          <tr><th>药剂批次</th><th>喷点</th><th>安全等级</th><th>出库数量</th><th>已回库</th><th>已报废</th></tr>
        </thead>
        <tbody>
          ${itemsCount.map(it => {
            const batch = state.db.batches?.find(b => b.id === it.batchId);
            const batchLabel = batch ? `${batch.name} / ${batch.batchNo}` : it.batchId;
            const unit = batch?.unit || '';
            const toneCls = '';
            let returnInput = '';
            if (schedule.status === '调度已出库' && canReturn) {
              const rinputs = state.scheduleReturnInputs?.[schedule.id] || {};
              const returned = rinputs[it.batchId]?.returned ?? it.returned ?? 0;
              const wasted = rinputs[it.batchId]?.wasted ?? it.wasted ?? 0;
              returnInput = `<td class="num-cell"><input type="number" min="0" max="${it.quantity}" data-sched-return-row data-sched-return="${schedule.id}" data-sched-batch="${it.batchId}" data-sched-return-field="returned" value="${returned}" placeholder="回库"><span class="unit">${escapeHtml(unit)}</span></td>
              <td class="num-cell"><input type="number" min="0" max="${it.quantity}" data-sched-return-row data-sched-return="${schedule.id}" data-sched-batch="${it.batchId}" data-sched-return-field="wasted" value="${wasted}" placeholder="报废"><span class="unit">${escapeHtml(unit)}</span></td>`;
            } else {
              returnInput = `<td class="num-cell">${it.returned || 0} ${escapeHtml(unit)}</td><td class="num-cell">${it.wasted || 0} ${escapeHtml(unit)}</td>`;
            }
            return `<tr>
              <td><div><strong>${escapeHtml(batchLabel)}</strong></div><div class="meta">喷点：${escapeHtml(it.sprayPoint || '-')}</div></td>
              <td>${escapeHtml(it.sprayPoint || '-')}</td>
              <td>${pill(it.safetyLevel, toneFor(it.safetyLevel))}</td>
              <td class="num-cell">${it.quantity || 0} ${escapeHtml(unit)}</td>
              ${returnInput}
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
    let actionButtons = '';
    if (schedule.status === '调度待审批') {
      actionButtons = `<div class="schedule-actions">
        ${canApprove ? `<button class="secondary" data-sched-approve="${schedule.id}">审批通过</button>` : ''}
        ${canReject ? `<button class="danger" data-action="schedule-reject" data-id="${schedule.id}">驳回</button>` : ''}
        ${!canApprove && !canReject ? '<span class="no-permission-tip-inline">⚠️ 当前角色无调度审批权限</span>' : ''}
      </div>`;
    } else if (schedule.status === '调度已审批') {
      actionButtons = `<div class="schedule-actions">
        ${canIssue ? `<button class="secondary" data-sched-issue="${schedule.id}">确认出库（批量扣减库存）</button>` : ''}
        ${!canIssue ? '<span class="no-permission-tip-inline">⚠️ 当前角色无出库权限</span>' : ''}
      </div>`;
    } else if (schedule.status === '调度已出库') {
      actionButtons = `<div class="schedule-actions">
        ${canReturn ? `<button class="secondary" data-sched-return="${schedule.id}">确认回库闭环</button>` : ''}
        ${!canReturn ? '<span class="no-permission-tip-inline">⚠️ 当前角色无回库权限</span>' : ''}
      </div>`;
    }
    const metaInfo = `
      <div class="meta">关联演出项目：${escapeHtml(projectLabel)}</div>
      ${schedule.useWindow ? `<div class="meta">使用时段：${escapeHtml(schedule.useWindow)}</div>` : ''}
      ${schedule.operator ? `<div class="meta">操作人员：${escapeHtml(schedule.operator)}</div>` : ''}
      ${schedule.approver ? `<div class="meta">审批人：${escapeHtml(schedule.approver)}　审批时间：${fmtDate(schedule.approvedAt)}</div>` : ''}
      ${schedule.issuer ? `<div class="meta">出库人：${escapeHtml(schedule.issuer)}　出库时间：${fmtDate(schedule.issuedAt)}</div>` : ''}
      ${schedule.returner ? `<div class="meta">回库人：${escapeHtml(schedule.returner)}　回库时间：${fmtDate(schedule.returnedAt)}</div>` : ''}
      ${schedule.note ? `<div class="meta">备注：${escapeHtml(schedule.note)}</div>` : ''}
    `;
    const deleteBtn = canDelete ? `<button class="danger" data-delete-schedule="${schedule.id}" style="margin-left:auto;">删除调度单</button>` : '';
    expandContent = `
      <div class="schedule-detail">
        ${metaInfo}
        <div class="detail">${detailRows}</div>
        ${itemsTable}
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;">
          ${actionButtons}
          ${deleteBtn}
        </div>
      </div>
    `;
  }
  const summaryHtml = summary ? `<p>${escapeHtml(summary)}</p>` : '';
  return `<article class="card schedule-card">
    <div class="card-head" data-expand-schedule="${schedule.id}" style="cursor:pointer;">
      <div>
        <h3>${escapeHtml(title)}</h3>
        <div class="meta">演出：${escapeHtml(projectLabel)}　${summaryHtml ? summaryHtml : ''}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        ${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}
        <span class="meta">${itemsCount.length}条明细，共${totalQty}单位</span>
        <span class="meta">${isExpanded ? '▲ 收起' : '▼ 展开详情'}</span>
      </div>
    </div>
    ${expandContent}
    ${historyHtml(schedule)}
  </article>`;
}

function renderScheduleList(view) {
  const query = state.filters[view.id]?.search?.trim() || '';
  const statusFilter = state.filters[view.id]?.status || '';
  let items = [...(state.db[view.collection] || [])];
  if (query) {
    items = items.filter(item => view.searchFields.some(field => {
      const raw = String(item[field] || '');
      if (raw.includes(query)) return true;
      if (field === 'projectId') {
        const p = state.db.projects?.find(x => x.id === item[field]);
        if (p && (p.name.includes(query) || p.venue.includes(query))) return true;
      }
      return false;
    }));
  }
  if (statusFilter) items = items.filter(item => item[view.statusField] === statusFilter);
  return items.length ? items.map(item => renderScheduleCard(item, view)).join('') : '<div class="empty">暂无调度单</div>';
}

function renderScheduleView(view) {
  const statusOptions = view.statusOptions || [];
  const canCreate = canCurrentUser('create', 'schedules');
  const batches = (state.db.batches || []);
  const projectOptions = (state.db.projects || []);
  const createForm = canCreate ? `
    <form class="panel" data-schedule-form data-create="schedules" data-view="${view.id}">
      <h2>${escapeHtml(view.formTitle)}</h2>
      <div class="form-grid">${view.fields.map(f => {
        if (f.type === 'textarea') return `<label class="${f.wide ? 'wide' : ''}">${escapeHtml(f.label)}<textarea name="${f.name}" ${f.required ? 'required' : ''}></textarea></label>`;
        if (f.type === 'relation') {
          const items = state.db[f.collection] || [];
          return `<label class="${f.wide ? 'wide' : ''}">${escapeHtml(f.label)}<select name="${f.name}" ${f.required ? 'required' : ''}><option value="">请选择</option>${optionList(items, f.labelFields)}</select></label>`;
        }
        return `<label class="${f.wide ? 'wide' : ''}">${escapeHtml(f.label)}<input type="text" name="${f.name}" ${f.required ? 'required' : ''}></label>`;
      }).join('')}</div>
      <h3 style="margin:16px 0 8px;">用药明细</h3>
      <table class="schedule-items-table">
        <thead>
          <tr><th>药剂批次（库存/等级）</th><th>喷点/使用位置</th><th>所需安全等级</th><th>领用数量</th><th>操作</th></tr>
        </thead>
        <tbody data-sched-rows>
          ${renderScheduleFormRows()}
        </tbody>
      </table>
      <div class="actions" style="justify-content:space-between;">
        <button type="button" class="ghost" data-sched-add-row>+ 新增明细行</button>
        <button>${escapeHtml(view.submitLabel || '提交')}</button>
      </div>
      <p class="meta" style="margin-top:8px;">💡 兼容旧流程：单批次领用可继续使用「演出审批」标签页，也可在此处仅添加一行明细。</p>
    </form>
  ` : `
    <div class="panel no-permission-panel">
      <h2>${escapeHtml(view.formTitle)}</h2>
      <div class="no-permission-tip">⚠️ 当前用户无权限创建调度单，请切换到演出负责人角色。</div>
    </div>
  `;
  return `<section class="view" id="${view.id}">
    <div class="grid">
      ${createForm}
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input data-search="${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}" value="${escapeHtml(state.filters[view.id]?.search || '')}">
          <select data-status-filter="${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map(opt => `<option${state.filters[view.id]?.status === opt ? ' selected' : ''}>${escapeHtml(opt)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderScheduleList(view)}</div>
      </div>
    </div>
  </section>`;
}

function computeProjectClosureLocal(projectId) {
  const project = state.db.projects?.find((p) => p.id === projectId);
  if (!project) return null;

  const requests = (state.db.requests || []).filter((r) => r.projectId === projectId);
  const schedules = (state.db.schedules || []).filter((s) => s.projectId === projectId);
  const wastes = (state.db.wastes || []).filter((w) => w.projectId === projectId);

  const batchIds = new Set();
  requests.forEach((r) => { if (r.batchId) batchIds.add(r.batchId); });
  schedules.forEach((s) => {
    (s.items || []).forEach((it) => {
      if (it.batchId) batchIds.add(it.batchId);
    });
  });

  const riskBatches = [];
  const now = new Date();
  const expiringDays = state.config.alerts?.expiringDays || 30;
  const lowStockThreshold = state.config.alerts?.lowStockThreshold || 10;
  const expiringCutoff = new Date(now.getTime() + expiringDays * 24 * 60 * 60 * 1000);

  (state.db.batches || []).forEach((batch) => {
    if (!batchIds.has(batch.id)) return;
    if (batch.status === '已报废') return;
    let hasRisk = false;
    let riskTypes = [];
    const expireDate = batch.expiresAt ? new Date(batch.expiresAt) : null;
    if (expireDate) {
      if (expireDate < now) {
        hasRisk = true;
        riskTypes.push('已过期');
      } else if (expireDate <= expiringCutoff) {
        hasRisk = true;
        const daysLeft = Math.ceil((expireDate - now) / (1000 * 60 * 60 * 24));
        riskTypes.push(`临期(${daysLeft}天)`);
      }
    }
    const qty = Number(batch.quantity || 0);
    if (qty < lowStockThreshold) {
      hasRisk = true;
      riskTypes.push(`低库存(${qty})`);
    }
    if (batch.status === '锁定') {
      hasRisk = true;
      riskTypes.push('锁定');
    }
    if (hasRisk) {
      riskBatches.push({ ...batch, riskTypes });
    }
  });

  const openRequestStatuses = ['待审批', '已审批', '已出库'];
  const openScheduleStatuses = ['调度待审批', '调度已审批', '调度已出库'];
  const openWasteStatuses = ['待审批', '待处置', '部分处置'];

  const openRequests = requests.filter((r) => openRequestStatuses.includes(r.status));
  const openSchedules = schedules.filter((s) => openScheduleStatuses.includes(s.status));
  const openWastes = wastes.filter((w) => openWasteStatuses.includes(w.status));

  const unclosedItems = [];
  openRequests.forEach((r) => {
    unclosedItems.push({
      type: 'request',
      id: r.id,
      label: r.showName || r.id,
      status: r.status,
      category: '领用申请'
    });
  });
  openSchedules.forEach((s) => {
    unclosedItems.push({
      type: 'schedule',
      id: s.id,
      label: s.code || s.id,
      status: s.status,
      category: '用药调度'
    });
  });
  openWastes.forEach((w) => {
    unclosedItems.push({
      type: 'waste',
      id: w.id,
      label: w.code || w.title || w.id,
      status: w.status,
      category: '报废单'
    });
  });

  return {
    projectId,
    projectName: project.name,
    total: {
      requests: requests.length,
      schedules: schedules.length,
      wastes: wastes.length,
      riskBatches: riskBatches.length
    },
    unclosed: {
      requests: openRequests.length,
      schedules: openSchedules.length,
      wastes: openWastes.length,
      riskBatches: riskBatches.length,
      total: unclosedItems.length
    },
    details: {
      requests,
      schedules,
      wastes,
      riskBatches
    },
    unclosedItems,
    hasUnclosed: unclosedItems.length > 0 || riskBatches.length > 0
  };
}

function renderProjectCard(project, view) {
  const isExpanded = state.expandedProject === project.id;
  const title = view.titleFields.map((f) => project[f]).filter(Boolean).join(' / ') || project.id;
  const summary = (view.summaryFields || []).map((f) => project[f]).filter(Boolean).join(' · ');
  const statusValue = project[view.statusField];
  const closureSummary = computeProjectClosureLocal(project.id);

  const details = (view.detailFields || []).map((field) => {
    let value;
    if (field.type === 'computed') {
      value = computedFieldValue(field, project);
    } else if (field.type === 'relation') {
      value = relationLabel(field, project[field.name]);
    } else {
      value = project[field.name];
    }
    const displayValue = value === null || value === undefined || value === '' ? '-' : value;
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(displayValue)}</strong></div>`;
  }).join('');

  let actions = state.config.actions
    .filter((action) => action.collection === 'projects');
  actions = filterActionsByPermission(actions);
  const actionsHtml = actions
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${project.id}" data-project-action="${action.id}">${escapeHtml(action.label)}</button>`)
    .join('');

  let closureBadge = '';
  if (closureSummary && closureSummary.hasUnclosed) {
    const unclosedTotal = closureSummary.unclosed.total || 0;
    const riskCount = closureSummary.unclosed.riskBatches || 0;
    const badgeText = unclosedTotal > 0
      ? `${unclosedTotal}个未闭环项`
      : `${riskCount}个风险批次`;
    closureBadge = `<span class="pill warn" style="margin-top:6px;">⚠ ${badgeText}</span>`;
  } else if (closureSummary) {
    closureBadge = `<span class="pill ok" style="margin-top:6px;">✓ 全部闭环</span>`;
  }

  let expandContent = '';
  if (isExpanded && closureSummary) {
    const total = closureSummary.total;
    const unclosed = closureSummary.unclosed;

    const requestListHtml = total.requests > 0
      ? closureSummary.details.requests.map((r) => {
          const batchLabel = relationLabel({ collection: 'batches', labelFields: ['name', 'batchNo'] }, r.batchId);
          const isOpen = ['待审批', '已审批', '已出库'].includes(r.status);
          return `<div class="closure-item ${isOpen ? 'unclosed' : 'closed'}">
            <div class="closure-item-head">
              <span class="closure-item-title">${escapeHtml(r.showName || r.id)}</span>
              ${pill(r.status, toneFor(r.status))}
            </div>
            <div class="meta">批次：${escapeHtml(batchLabel)}　数量：${r.quantity}${escapeHtml(r.unit || '')}</div>
            <div class="meta">操作：${escapeHtml(r.operator || '-')}　时段：${escapeHtml(r.useWindow || '-')}</div>
          </div>`;
        }).join('')
      : '<div class="empty">暂无领用申请</div>';

    const scheduleListHtml = total.schedules > 0
      ? closureSummary.details.schedules.map((s) => {
          const isOpen = ['调度待审批', '调度已审批', '调度已出库'].includes(s.status);
          const itemsCount = (s.items || []).length;
          const totalQty = (s.items || []).reduce((sum, it) => sum + Number(it.quantity || 0), 0);
          return `<div class="closure-item ${isOpen ? 'unclosed' : 'closed'}">
            <div class="closure-item-head">
              <span class="closure-item-title">${escapeHtml(s.code || s.id)}</span>
              ${pill(s.status, toneFor(s.status))}
            </div>
            <div class="meta">${itemsCount}条明细，共${totalQty}单位　操作：${escapeHtml(s.operator || '-')}</div>
            <div class="meta">时段：${escapeHtml(s.useWindow || '-')}</div>
          </div>`;
        }).join('')
      : '<div class="empty">暂无用药调度</div>';

    const wasteListHtml = total.wastes > 0
      ? closureSummary.details.wastes.map((w) => {
          const batchLabel = relationLabel({ collection: 'batches', labelFields: ['name', 'batchNo'] }, w.batchId);
          const isOpen = ['待审批', '待处置', '部分处置'].includes(w.status);
          const disposedQty = Number(w.disposedQuantity ?? w.actualQuantity ?? 0);
          const qtyInfo = disposedQty > 0 ? ` · 已处置：${disposedQty}/${w.quantity}` : ` · 数量：${w.quantity}`;
          return `<div class="closure-item ${isOpen ? 'unclosed' : 'closed'}">
            <div class="closure-item-head">
              <span class="closure-item-title">${escapeHtml(w.code || w.title || w.id)}</span>
              ${pill(w.status, toneFor(w.status))}
            </div>
            <div class="meta">批次：${escapeHtml(batchLabel)}${qtyInfo}${escapeHtml(w.unit || '')}</div>
            <div class="meta">申请人：${escapeHtml(w.applicant || '-')}　原因：${escapeHtml(w.reason || '-')}</div>
          </div>`;
        }).join('')
      : '<div class="empty">暂无报废单</div>';

    const riskBatchListHtml = total.riskBatches > 0
      ? closureSummary.details.riskBatches.map((b) => {
          const riskPills = (b.riskTypes || []).map((r) => `<span class="pill warn" style="font-size:11px;">${escapeHtml(r)}</span>`).join(' ');
          return `<div class="closure-item unclosed">
            <div class="closure-item-head">
              <span class="closure-item-title">${escapeHtml(b.name)} / ${escapeHtml(b.batchNo)}</span>
              ${pill(b.status, toneFor(b.status))}
            </div>
            <div class="meta">库存：${b.quantity}${escapeHtml(b.unit || '')}　有效期：${fmtDate(b.expiresAt)}</div>
            <div class="closure-risk-badges">${riskPills}</div>
          </div>`;
        }).join('')
      : '<div class="empty">暂无风险批次</div>';

    expandContent = `
      <div class="project-closure-detail">
        <div class="closure-stats">
          <div class="closure-stat">
            <span class="closure-stat-label">领用申请</span>
            <strong>${total.requests}</strong>
            <span class="closure-stat-sub ${unclosed.requests > 0 ? 'bad-text' : 'ok-text'}">${unclosed.requests > 0 ? unclosed.requests + '个未闭环' : '全部闭环'}</span>
          </div>
          <div class="closure-stat">
            <span class="closure-stat-label">用药调度</span>
            <strong>${total.schedules}</strong>
            <span class="closure-stat-sub ${unclosed.schedules > 0 ? 'bad-text' : 'ok-text'}">${unclosed.schedules > 0 ? unclosed.schedules + '个未闭环' : '全部闭环'}</span>
          </div>
          <div class="closure-stat">
            <span class="closure-stat-label">报废单</span>
            <strong>${total.wastes}</strong>
            <span class="closure-stat-sub ${unclosed.wastes > 0 ? 'bad-text' : 'ok-text'}">${unclosed.wastes > 0 ? unclosed.wastes + '个未完成' : '全部完成'}</span>
          </div>
          <div class="closure-stat">
            <span class="closure-stat-label">风险批次</span>
            <strong>${total.riskBatches}</strong>
            <span class="closure-stat-sub ${unclosed.riskBatches > 0 ? 'warn-text' : 'ok-text'}">${unclosed.riskBatches > 0 ? unclosed.riskBatches + '个有风险' : '无风险'}</span>
          </div>
        </div>

        <div class="closure-sections">
          <div class="closure-section">
            <div class="closure-section-header">
              <h4>📋 领用申请</h4>
              ${unclosed.requests > 0 ? `<span class="pill bad">${unclosed.requests}个未闭环</span>` : `<span class="pill ok">全部闭环</span>`}
            </div>
            <div class="closure-list">${requestListHtml}</div>
          </div>

          <div class="closure-section">
            <div class="closure-section-header">
              <h4>📅 用药调度</h4>
              ${unclosed.schedules > 0 ? `<span class="pill bad">${unclosed.schedules}个未闭环</span>` : `<span class="pill ok">全部闭环</span>`}
            </div>
            <div class="closure-list">${scheduleListHtml}</div>
          </div>

          <div class="closure-section">
            <div class="closure-section-header">
              <h4>🗑️ 报废单</h4>
              ${unclosed.wastes > 0 ? `<span class="pill warn">${unclosed.wastes}个待处置</span>` : `<span class="pill ok">全部完成</span>`}
            </div>
            <div class="closure-list">${wasteListHtml}</div>
          </div>

          <div class="closure-section">
            <div class="closure-section-header">
              <h4>⚠️ 风险批次</h4>
              ${unclosed.riskBatches > 0 ? `<span class="pill warn">${unclosed.riskBatches}个风险项</span>` : `<span class="pill ok">无风险</span>`}
            </div>
            <div class="closure-list">${riskBatchListHtml}</div>
          </div>
        </div>

        ${actionsHtml ? `<div class="actions">${actionsHtml}</div>` : ''}
      </div>
    `;
  }

  return `<article class="card project-card">
    <div class="card-head" data-expand-project="${project.id}" style="cursor:pointer;">
      <div>
        <h3>${escapeHtml(title)}</h3>
        <div class="meta">${summary ? escapeHtml(summary) : ''}</div>
        ${closureBadge ? `<div style="margin-top:4px;">${closureBadge}</div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        ${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}
        <span class="meta">${isExpanded ? '▲ 收起' : '▼ 展开闭环视图'}</span>
      </div>
    </div>
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${expandContent}
    ${!isExpanded && actionsHtml ? `<div class="actions">${actionsHtml}</div>` : ''}
    ${historyHtml(project)}
  </article>`;
}

function renderProjectList(view) {
  const query = state.filters[view.id]?.search?.trim() || '';
  const status = state.filters[view.id]?.status || '';
  let items = [...(state.db[view.collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => {
      const raw = String(item[field] || '');
      return raw.includes(query);
    }));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length ? items.map((item) => renderProjectCard(item, view)).join('') : '<div class="empty">暂无演出项目</div>';
}

function renderProjectView(view) {
  const statusOptions = view.statusOptions || [];
  const canCreate = canCurrentUser('create', 'projects');
  const createForm = canCreate ? `
    <form class="panel" data-crud-form="${view.collection}" data-create="${view.collection}" data-view="${view.id}">
      <h2>${escapeHtml(view.formTitle)}</h2>
      <div class="form-grid">${view.fields.map(formField).join('')}</div>
      <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
    </form>
  ` : `
    <div class="panel no-permission-panel">
      <h2>${escapeHtml(view.formTitle)}</h2>
      <div class="no-permission-tip">⚠️ 当前用户无权限创建演出项目，请切换到有权限的角色。</div>
    </div>
  `;
  return `<section class="view" id="${view.id}">
    <div class="grid">
      ${createForm}
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input data-search="${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}" value="${escapeHtml(state.filters[view.id]?.search || '')}">
          <select data-status-filter="${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option${state.filters[view.id]?.status === option ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderProjectList(view)}</div>
      </div>
    </div>
  </section>`;
}

function collectScheduleReturnData(scheduleId) {
  const inputs = state.scheduleReturnInputs?.[scheduleId] || {};
  const schedule = state.db.schedules?.find(s => s.id === scheduleId);
  const items = (schedule?.items || []).map(it => {
    const r = inputs[it.batchId] || {};
    return {
      batchId: it.batchId,
      returned: Number(r.returned ?? it.returned ?? 0),
      wasted: Number(r.wasted ?? it.wasted ?? 0)
    };
  });
  return { items };
}

function renderCabinetCapacityInfo(form) {
  if (!form) return;
  const cabinetSelect = form.querySelector('select[data-cabinet-select]');
  const capacityInfo = form.querySelector('[data-cabinet-capacity-info]');
  const qtyInput = form.querySelector('input[name="quantity"]');

  if (!cabinetSelect || !capacityInfo) return;

  const cabinetId = cabinetSelect.value;
  const qty = Number(qtyInput?.value || 0);
  const editId = form.dataset.editId;

  if (!cabinetId) {
    capacityInfo.innerHTML = '';
    return;
  }

  const occ = computeCabinetOccupancy(cabinetId, editId);
  if (!occ) {
    capacityInfo.innerHTML = '';
    return;
  }

  let newOccupied = occ.occupiedQuantity + qty;
  let newRemaining = occ.capacity - newOccupied;
  let willOver = newOccupied > occ.capacity;
  let willNearFull = occ.capacity > 0 && newOccupied / occ.capacity >= 0.8;
  let overAmount = newOccupied - occ.capacity;

  const tone = willOver ? 'bad' : willNearFull ? 'warn' : 'ok';
  const rate = Math.min(Math.round((newOccupied / occ.capacity) * 100), 100);

  const diffLabel = !editId ? `新增${qty}` : qty >= 0 ? `调整+${qty}` : `调整${qty}`;
  const diffPillLabel = !editId ? `本次新增 +${qty}` : qty >= 0 ? `本次调整 +${qty}` : `本次调整 ${qty}`;

  const overTipHtml = willOver
    ? `<div class="capacity-over-tip">⚠️ 容量不足！本次${diffLabel}后将超出 ${overAmount}，请减少数量或选择其他柜位</div>`
    : willNearFull
    ? `<div class="capacity-near-tip">⚡ 本次${diffLabel}后柜位即将满载（占用率${rate}%），请合理分配库存</div>`
    : '';

  const afterLabelHtml = qty !== 0 || editId
    ? `
      <div class="capacity-after-label">
        <span class="pill" style="background:rgba(17,97,92,.1);color:var(--accent);font-size:11px;">${diffPillLabel}</span>
      </div>
    `
    : '';

  capacityInfo.innerHTML = `
    <div class="cabinet-capacity-panel">
      <div class="capacity-header">
        <span class="capacity-title">柜位容量：${occ.cabinetCode}</span>
        ${afterLabelHtml}
      </div>
      <div class="capacity-progress-wrap capacity-inline">
        <div class="capacity-progress-bar capacity-${tone}">
          <div class="capacity-progress-fill" style="width:${Math.max(rate, 2)}%;"></div>
        </div>
        <div class="capacity-labels capacity-labels-sm">
          <span>已占用 <strong>${occ.occupiedQuantity}</strong></span>
          <span>${editId ? '调整后' : '新增后'} <strong class="${willOver ? 'cap-bad' : ''}">${newOccupied}</strong> / ${occ.capacity}</span>
          <span class="${willOver ? 'cap-bad' : (willNearFull ? 'cap-warn' : 'cap-ok')}">
            剩余 <strong>${Math.max(newRemaining, 0)}</strong>
          </span>
        </div>
      </div>
      ${overTipHtml}
    </div>
  `;
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
  $$('form').forEach(renderCabinetCapacityInfo);
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  renderUserSwitcher();
  const needLogin = !state.currentUser;
  if (needLogin) {
    $('#main').innerHTML = `
      <div class="login-required">
        <div class="login-card">
          <h2>👋 欢迎使用</h2>
          <p>请先选择当前用户角色以继续操作</p>
          <div class="login-user-list">
            ${(state.config.users || []).map((u) => {
              const roleInfo = state.config.roles?.[u.role] || {};
              const color = roleInfo.color || '#555';
              return `
                <button class="login-user-option" data-switch-user="${u.id}">
                  <span class="user-avatar" style="background:${color};width:48px;height:48px;font-size:20px;">${escapeHtml(u.name?.[0] || 'U')}</span>
                  <div class="login-user-info">
                    <span class="login-user-name">${escapeHtml(u.name)}</span>
                    <span class="login-user-role" style="color:${color};">${escapeHtml(u.roleLabel)}</span>
                  </div>
                </button>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    `;
    return;
  }
  for (const view of state.config.views) {
    if (!state.filters[view.id]) {
      state.filters[view.id] = { search: '', status: '', actionType: '', targetCollection: '' };
    } else {
      if (state.filters[view.id].search === undefined) state.filters[view.id].search = '';
      if (state.filters[view.id].status === undefined) state.filters[view.id].status = '';
      if (state.filters[view.id].actionType === undefined) state.filters[view.id].actionType = '';
      if (state.filters[view.id].targetCollection === undefined) state.filters[view.id].targetCollection = '';
    }
  }
  renderTabs();
  $('#main').innerHTML = state.config.views.map((view) => {
    if (view.type === 'risk-alerts') return renderRiskAlertsView(view);
    if (view.type === 'dashboard') return renderDashboardView(view);
    if (view.type === 'stocktake') return renderStocktakeView(view);
    if (view.type === 'waste') return renderWasteView(view);
    if (view.type === 'audit-logs') return renderAuditLogsView(view);
    if (view.type === 'batch-import') return renderBatchImportView(view);
    if (view.type === 'schedule-board') return renderScheduleBoardView(view);
    if (view.type === 'schedule') return renderScheduleView(view);
    if (view.type === 'project') return renderProjectView(view);
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

async function loadDb() {
  state.db = await api('/api/db');
  render();
}

function collectFormData(form) {
  const data = {};
  const formData = new FormData(form);
  for (const [key, value] of formData.entries()) {
    if (value === '' || value === null || value === undefined) continue;
    if (!isNaN(Number(value)) && value !== '' && typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
      data[key] = Number(value);
    } else {
      data[key] = value;
    }
  }
  return data;
}

function parseImportText(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('数据不足：至少需要表头和一行数据');
  const headers = lines[0].split(/[,\t]/).map(h => h.trim());
  const nameIdx = headers.findIndex(h => h.includes('名称') || h.toLowerCase().includes('name'));
  const categoryIdx = headers.findIndex(h => h.includes('品类') || h.toLowerCase().includes('category'));
  const batchNoIdx = headers.findIndex(h => h.includes('批次') || h.toLowerCase().includes('batch'));
  const supplierIdx = headers.findIndex(h => h.includes('供应商') || h.toLowerCase().includes('supplier'));
  const cabinetIdx = headers.findIndex(h => h.includes('柜位') || h.toLowerCase().includes('cabinet'));
  const safetyIdx = headers.findIndex(h => h.includes('安全') || h.toLowerCase().includes('safety'));
  const qtyIdx = headers.findIndex(h => h.includes('数量') || h.includes('库存') || h.toLowerCase().includes('quantity'));
  const unitIdx = headers.findIndex(h => h.includes('单位') || h.toLowerCase().includes('unit'));
  const expiresIdx = headers.findIndex(h => h.includes('有效期') || h.includes('到期') || h.toLowerCase().includes('expire'));
  if (nameIdx < 0 || batchNoIdx < 0) throw new Error('缺少必要列：名称、批次号');
  const suppliers = state.db.suppliers || [];
  const cabinets = state.db.cabinets || [];
  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(/[,\t]/).map(c => c.trim());
    const row = {};
    if (nameIdx >= 0) row.name = cols[nameIdx];
    if (categoryIdx >= 0) row.category = cols[categoryIdx] || '未分类';
    if (batchNoIdx >= 0) row.batchNo = cols[batchNoIdx];
    if (safetyIdx >= 0) row.safetyLevel = cols[safetyIdx] || '低';
    if (qtyIdx >= 0) row.quantity = Number(cols[qtyIdx] || 0);
    if (unitIdx >= 0) row.unit = cols[unitIdx] || '罐';
    if (expiresIdx >= 0) row.expiresAt = cols[expiresIdx];
    if (supplierIdx >= 0) {
      const name = cols[supplierIdx];
      const match = suppliers.find(s => s.name === name);
      if (match) row.supplierId = match.id;
    }
    if (cabinetIdx >= 0) {
      const code = cols[cabinetIdx];
      const match = cabinets.find(c => c.code === code || c.area === code);
      if (match) row.cabinetId = match.id;
    }
    row.status = '可用';
    if (!row.name || !row.batchNo) continue;
    results.push(row);
  }
  return results;
}

function collectStocktakeItems(stocktakeId) {
  const inputs = state.stocktakeInputs?.[stocktakeId] || {};
  const stocktake = state.db.stocktakes?.find(s => s.id === stocktakeId);
  const existing = stocktake?.items || [];
  const cabinetFilter = stocktake?.cabinetId;
  const allBatches = (state.db.batches || []).filter(b => !cabinetFilter || b.cabinetId === cabinetFilter);
  return allBatches.map(batch => {
    const inputQty = inputs[batch.id];
    const existingItem = existing.find(it => it.batchId === batch.id);
    const systemQty = Number(batch.quantity || 0);
    const actualQty = inputQty !== undefined ? Number(inputQty) : (existingItem?.actualQuantity ?? systemQty);
    return {
      batchId: batch.id,
      batchName: batch.name,
      batchNo: batch.batchNo,
      systemQuantity: systemQty,
      actualQuantity: actualQty,
      diff: actualQty - systemQty
    };
  });
}

function collectWasteDisposalData(wasteId) {
  const inputs = state.wasteDisposalInputs?.[wasteId] || {};
  const waste = state.db.wastes?.find(w => w.id === wasteId);
  const qty = Number(waste?.quantity || 0);
  const disposedQty = Number(waste?.disposedQuantity ?? waste?.actualQuantity ?? 0);
  const remainingQty = Number(waste?.remainingQuantity ?? Math.max(0, qty - disposedQty));
  const fallbackQty = waste?.status === '部分处置' && remainingQty > 0 ? remainingQty : qty;
  const lastRecord = (waste?.status === '部分处置' && Array.isArray(waste?.disposalRecords) && waste.disposalRecords.length > 0)
    ? waste.disposalRecords[waste.disposalRecords.length - 1]
    : null;
  return {
    actualQuantity: inputs.actualQuantity !== undefined ? Number(inputs.actualQuantity) : fallbackQty,
    disposalMethod: inputs.disposalMethod || lastRecord?.disposalMethod || waste?.disposalMethod || '',
    witness: inputs.witness || lastRecord?.witness || waste?.witness || '',
    disposalNote: inputs.disposalNote || ''
  };
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
  const view = state.config.views.find((v) => v.id === viewId);
  if (!view) {
    state.filters[viewId] = { search: '', status: '' };
  }
  state.expandedItems[viewId] = null;
  state.activeModal = null;
  state.importPreview = null;
  render();
}

function jumpToRequest(requestId) {
  closeRequestModal();
  state.activeView = 'requests';
  state.expandedItems['requests'] = requestId;
  render();
}

document.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    const id = tab.dataset.tab;
    state.activeTab = id;
    state.activeView = id;
    state.expandedItems[id] = null;
    state.activeModal = null;
    state.importPreview = null;
    render();
    return;
  }

  const expand = e.target.closest('[data-expand]');
  if (expand) {
    const viewId = expand.dataset.view;
    const id = expand.dataset.expand;
    state.expandedItems[viewId] = state.expandedItems[viewId] === id ? null : id;
    render();
    return;
  }

  const expandStocktake = e.target.closest('[data-expand-stocktake]');
  if (expandStocktake) {
    const id = expandStocktake.dataset.expandStocktake;
    state.expandedStocktake = state.expandedStocktake === id ? null : id;
    render();
    return;
  }

  const expandWaste = e.target.closest('[data-expand-waste]');
  if (expandWaste) {
    const id = expandWaste.dataset.expandWaste;
    state.expandedWaste = state.expandedWaste === id ? null : id;
    render();
    return;
  }

  const closeModal = e.target.closest('[data-close-modal]');
  if (closeModal) {
    state.activeModal = null;
    render();
    return;
  }

  const jumpReq = e.target.closest('[data-jump-request]');
  if (jumpReq) {
    jumpToRequest(jumpReq.dataset.jumpRequest);
    return;
  }

  const closeReqModal = e.target.closest('#request-modal [data-close-modal]');
  if (closeReqModal || (e.target.id === 'request-modal')) {
    closeRequestModal();
    return;
  }

  const switchUser = e.target.closest('[data-switch-user]');
  if (switchUser) {
    const uid = switchUser.dataset.switchUser;
    const user = state.config.users.find((u) => u.id === uid);
    if (user) {
      state.currentUser = user;
      localStorage.setItem(USER_STORAGE_KEY, user.id);
      state.expandedItems = {};
      state.activeModal = null;
      state.importPreview = null;
      render();
    }
    const dd = $('#userDropdown');
    if (dd) dd.classList.add('hidden');
    return;
  }

  const userChip = e.target.closest('.user-chip');
  if (userChip) {
    const dd = $('#userDropdown');
    if (dd) dd.classList.toggle('hidden');
    return;
  } else {
    const dd = $('#userDropdown');
    if (dd && !dd.classList.contains('hidden')) {
      dd.classList.add('hidden');
    }
  }

  const openWasteFromBatch = e.target.closest('[data-create-waste-from-batch]');
  if (openWasteFromBatch) {
    const batchId = openWasteFromBatch.dataset.createWasteFromBatch;
    try {
      const prefill = await api(`/api/batches/${batchId}/waste-prefill`);
      state.wastePrefill = prefill;
      state.activeView = 'wastes';
      state.activeTab = 'wastes';
      render();
      setTimeout(() => {
        const form = document.querySelector('[data-waste-form]');
        if (form) {
          form.scrollIntoView({ behavior: 'smooth', block: 'start' });
          form.classList.add('waste-form-highlight');
          setTimeout(() => form.classList.remove('waste-form-highlight'), 2500);
        }
      }, 100);
      toast('已一键带入报废申请信息，请确认后提交');
    } catch (err) {
      toast(err.message || '获取预填充信息失败');
    }
    return;
  }

  const openWasteFromStocktake = e.target.closest('[data-create-waste-from-stocktake]');
  if (openWasteFromStocktake) {
    const stocktakeId = openWasteFromStocktake.dataset.createWasteFromStocktake;
    const batchId = openWasteFromStocktake.dataset.batchId;
    const deficitQty = Number(openWasteFromStocktake.dataset.deficitQty || 0);
    const availableQty = Number(openWasteFromStocktake.dataset.availableQty || 0);
    const batch = state.db.batches?.find((b) => b.id === batchId);
    const stocktake = state.db.stocktakes?.find((s) => s.id === stocktakeId);

    if (!batch) {
      toast('批次不存在，无法发起报废');
      return;
    }
    if (batch.status === '已报废') {
      toast('该批次已报废，无法重复发起报废');
      return;
    }
    if (!stocktake || stocktake.status !== '已确认') {
      toast('盘点单未确认，无法发起报废');
      return;
    }

    const diffItem = (stocktake.diffSuggestions || []).find((d) => d.batchId === batchId);
    if (diffItem && diffItem.actionStatus === 'registered' && diffItem.wasteId) {
      const existingWaste = (state.db.wastes || []).find((w) => w.id === diffItem.wasteId && w.status !== '已驳回' && w.status !== '已撤销');
      if (existingWaste) {
        if (!confirm(`该盘亏项已存在报废单「${existingWaste.code || existingWaste.id}」（${existingWaste.status}），是否跳转到报废页面查看？`)) {
          return;
        }
        state.activeView = 'wastes';
        state.activeTab = 'wastes';
        state.expandedWaste = existingWaste.id;
        render();
        setTimeout(() => {
          const card = document.querySelector(`[data-expand-waste="${existingWaste.id}"]`);
          if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.add('waste-form-highlight');
            setTimeout(() => card.classList.remove('waste-form-highlight'), 2500);
          }
        }, 100);
        return;
      }
    }

    const maxAllowed = Math.min(deficitQty, availableQty + deficitQty);
    if (maxAllowed <= 0) {
      toast(`无可报废数量：盘亏${deficitQty}${batch.unit || ''}，但当前可用库存${availableQty}${batch.unit || ''}，请先检查批次状态`);
      return;
    }

    if (deficitQty > 0 && availableQty < deficitQty) {
      if (!confirm(`盘亏数量为${deficitQty}${batch.unit || ''}，但当前可用库存仅${availableQty}${batch.unit || ''}。\n\n报废单将预填盘亏数量${deficitQty}${batch.unit || ''}，其中${availableQty}${batch.unit || ''}从当前库存扣减，${deficitQty - availableQty}${batch.unit || ''}由盘点盘亏已扣减抵充。\n\n是否继续？`)) {
        return;
      }
    }

    try {
      const prefill = await api(`/api/batches/${batchId}/waste-prefill?stocktakeId=${encodeURIComponent(stocktakeId)}`);
      if (!prefill || !prefill.batchId) {
        toast('获取预填充信息失败，请稍后重试');
        return;
      }
      state.wastePrefill = prefill;
      state.activeView = 'wastes';
      state.activeTab = 'wastes';
      render();
      setTimeout(() => {
        const form = document.querySelector('[data-waste-form]');
        if (form) {
          form.scrollIntoView({ behavior: 'smooth', block: 'start' });
          form.classList.add('waste-form-highlight');
          setTimeout(() => form.classList.remove('waste-form-highlight'), 2500);
        }
      }, 100);
      const prefillQty = prefill.quantity || deficitQty;
      const deductFromStock = Math.max(0, prefillQty - deficitQty);
      const offsetByStocktake = Math.min(prefillQty, deficitQty);
      toast(`已带入盘点盘亏报废信息：预填报废${prefillQty}${batch.unit || ''}，其中${offsetByStocktake}${batch.unit || ''}由盘亏已扣减抵充${deductFromStock > 0 ? `，${deductFromStock}${batch.unit || ''}从当前库存扣减` : ''}。请确认后提交。`);
    } catch (err) {
      toast(err.message || '获取预填充信息失败，请检查盘点单和批次状态');
    }
    return;
  }

  const viewWaste = e.target.closest('[data-view-waste]');
  if (viewWaste) {
    const wasteId = viewWaste.dataset.viewWaste;
    const waste = (state.db.wastes || []).find((w) => w.id === wasteId);
    if (!waste) {
      toast('报废单不存在');
      return;
    }
    state.activeView = 'wastes';
    state.activeTab = 'wastes';
    state.expandedWaste = wasteId;
    render();
    setTimeout(() => {
      const card = document.querySelector(`[data-expand-waste="${wasteId}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('waste-form-highlight');
        setTimeout(() => card.classList.remove('waste-form-highlight'), 2500);
      }
    }, 100);
    return;
  }

  const markStocktakeNote = e.target.closest('[data-mark-stocktake-note]');
  if (markStocktakeNote) {
    const stocktakeId = markStocktakeNote.dataset.markStocktakeNote;
    const batchId = markStocktakeNote.dataset.batchId;
    if (!confirm('确认已对该盘盈批次补入库备注吗？')) return;
    try {
      const updated = await api(`/api/stocktakes/${stocktakeId}/mark-note/${batchId}`, { method: 'POST' });
      state.db.stocktakes = state.db.stocktakes.map((s) => (s.id === updated.id ? updated : s));
      if (state.db.auditLogs && updated.auditLogs) {
        state.db.auditLogs = updated.auditLogs.concat(state.db.auditLogs.filter((l) => !(l.collection === 'stocktakes' && l.targetId === stocktakeId)));
      }
      render();
      toast('已标记盘盈已补入库备注');
    } catch (err) {
      toast(err.message || '标记失败');
    }
    return;
  }

  const clearWastePrefill = e.target.closest('[data-clear-waste-prefill]');
  if (clearWastePrefill) {
    state.wastePrefill = null;
    render();
    toast('已清除预填充信息');
    return;
  }

  const viewRequestsBtn = e.target.closest('[data-view-requests]');
  if (viewRequestsBtn) {
    const batchId = viewRequestsBtn.dataset.viewRequests;
    showRequestsForBatch(batchId);
    return;
  }

  const importPreview = e.target.closest('[data-import-preview]');
  if (importPreview) {
    e.preventDefault();
    const textarea = document.getElementById('csv-input');
    const raw = textarea ? textarea.value : '';
    try {
      const preview = await api('/api/batches/import-preview', {
        method: 'POST',
        body: JSON.stringify({ csvText: raw })
      });
      state.importPreview = preview;
      render();
    } catch (err) {
      toast('解析失败：' + err.message);
    }
    return;
  }

  const importReset = e.target.closest('[data-import-reset]');
  if (importReset) {
    state.importPreview = null;
    render();
    return;
  }

  const pendingEdit = e.target.closest('[data-pending-edit]');
  if (pendingEdit) {
    e.preventDefault();
    const rowIndex = Number(pendingEdit.dataset.pendingEdit);
    const type = pendingEdit.dataset.pendingType;
    const row = state.importPreview.pendingRows?.find(r => r.rowIndex === rowIndex);
    if (!row) return;
    const pendingData = row.pendingCreate[type];
    if (!pendingData) return;
    const form = e.target.closest('form');
    if (!form) return;
    const formData = new FormData(form);
    for (const [key, value] of formData.entries()) {
      if (key.startsWith(`${type}_${rowIndex}_`)) {
        const field = key.replace(`${type}_${rowIndex}_`, '');
        pendingData[field] = value;
      }
    }
    render();
    return;
  }

  const importConfirm = e.target.closest('[data-import-confirm]');
  if (importConfirm) {
    e.preventDefault();
    const preview = state.importPreview;
    if (!preview || (preview.validCount === 0 && preview.pendingCount === 0)) {
      toast('没有可导入的数据');
      return;
    }

    const importableRows = [
      ...(preview.validRows || []),
      ...(preview.pendingRows || [])
    ];

    const pendingErrors = [];
    preview.pendingRows?.forEach(row => {
      if (row.pendingCreate.supplier) {
        const s = row.pendingCreate.supplier;
        if (!s.contact || !s.category || !s.certExpiresAt) {
          pendingErrors.push(`第${row.rowIndex}行：供应商「${s.name}」缺少必填字段`);
        }
      }
      if (row.pendingCreate.cabinet) {
        const c = row.pendingCreate.cabinet;
        if (!c.area || !c.capacity || !c.manager) {
          pendingErrors.push(`第${row.rowIndex}行：柜位「${c.code}」缺少必填字段`);
        }
      }
    });

    if (pendingErrors.length > 0) {
      alert('请先补齐待创建记录的必填字段：\n' + pendingErrors.join('\n'));
      return;
    }

    try {
      const result = await api('/api/batches/import-confirm', {
        method: 'POST',
        body: JSON.stringify({ rows: importableRows })
      });
      let msg = `成功导入 ${result.importedCount} 条批次`;
      if (result.createdSuppliersCount > 0) msg += `，创建供应商 ${result.createdSuppliersCount} 个`;
      if (result.createdCabinetsCount > 0) msg += `，创建柜位 ${result.createdCabinetsCount} 个`;
      if (result.failedCount > 0) msg += `，失败 ${result.failedCount} 条`;
      toast(msg);
      state.importPreview = null;
      await loadDb();
      render();
    } catch (err) {
      toast('导入失败：' + err.message);
    }
    return;
  }

  const stocktakeSave = e.target.closest('[data-stocktake-save]');
  if (stocktakeSave) {
    const id = stocktakeSave.dataset.stocktakeSave;
    const items = collectStocktakeItems(id);
    await api(`/api/stocktakes/${id}/items`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    });
    await loadDb();
    render();
    return;
  }

  const stocktakeConfirm = e.target.closest('[data-stocktake-confirm]');
  if (stocktakeConfirm) {
    const id = stocktakeConfirm.dataset.stocktakeConfirm;
    await api(`/api/stocktakes/${id}/confirm`, { method: 'POST' });
    await loadDb();
    render();
    return;
  }

  const wasteApprove = e.target.closest('[data-waste-approve]');
  if (wasteApprove) {
    const id = wasteApprove.dataset.wasteApprove;
    await api(`/api/wastes/${id}/approve`, { method: 'POST' });
    await loadDb();
    render();
    return;
  }

  const wasteDispose = e.target.closest('[data-waste-dispose]');
  if (wasteDispose) {
    const id = wasteDispose.dataset.wasteDispose;
    const payload = collectWasteDisposalData(id);
    await api(`/api/wastes/${id}/dispose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    await loadDb();
    render();
    return;
  }

  const actionBtn = e.target.closest('[data-action]');
  if (actionBtn) {
    const actionId = actionBtn.dataset.action;
    const id = actionBtn.dataset.id;
    const viewId = actionBtn.dataset.view;
    if (actionBtn.dataset.confirm && !confirm(`确定执行「${actionBtn.textContent.trim()}」操作吗？`)) {
      return;
    }
    if (actionId === 'project-complete') {
      const closureSummary = computeProjectClosureLocal(id);
      if (closureSummary && closureSummary.unclosed.total > 0) {
        const unclosed = closureSummary.unclosed;
        const msg = `项目存在 ${unclosed.total} 个未闭环项，无法完成：\n` +
          (unclosed.requests > 0 ? `  - ${unclosed.requests} 个领用申请未闭环\n` : '') +
          (unclosed.schedules > 0 ? `  - ${unclosed.schedules} 个用药调度未闭环\n` : '') +
          (unclosed.wastes > 0 ? `  - ${unclosed.wastes} 个报废单未完成\n` : '');
        alert(msg + '\n请先处理完所有未闭环项后再完成项目。');
        return;
      }
      if (!confirm('确定要完成该项目吗？项目完成后将无法再进行用药或报废操作。')) {
        return;
      }
    }
    try {
      await api(`/api/action/${actionId}/${id}`, { method: 'POST' });
      await loadDb();
      state.expandedItems[viewId] = id;
      render();
    } catch (err) {
      toast(err.message || '操作失败');
    }
    return;
  }

  const openModal = e.target.closest('[data-open-modal]');
  if (openModal) {
    state.activeModal = { collection: openModal.dataset.openModal };
    render();
    return;
  }

  const deleteBtn = e.target.closest('[data-delete]');
  if (deleteBtn) {
    const viewId = deleteBtn.dataset.view;
    const id = deleteBtn.dataset.delete;
    const label = deleteBtn.dataset.label || '该记录';
    if (!confirm(`确定删除${label}吗？此操作不可恢复。`)) return;
    const collection = deleteBtn.dataset.collection;
    await api(`/api/${collection}/${id}`, { method: 'DELETE' });
    state.expandedItems[viewId] = null;
    await loadDb();
    render();
    return;
  }

  const expandSchedule = e.target.closest('[data-expand-schedule]');
  if (expandSchedule) {
    const id = expandSchedule.dataset.expandSchedule;
    state.expandedSchedule = state.expandedSchedule === id ? null : id;
    render();
    return;
  }

  const expandProject = e.target.closest('[data-expand-project]');
  if (expandProject) {
    const id = expandProject.dataset.expandProject;
    state.expandedProject = state.expandedProject === id ? null : id;
    render();
    return;
  }

  const schedAddRow = e.target.closest('[data-sched-add-row]');
  if (schedAddRow) {
    if (!state.scheduleFormRows) state.scheduleFormRows = [{}];
    state.scheduleFormRows.push({});
    render();
    return;
  }

  const schedRemoveRow = e.target.closest('[data-sched-remove-row]');
  if (schedRemoveRow) {
    const idx = Number(schedRemoveRow.dataset.schedRemoveRow);
    if (state.scheduleFormRows && state.scheduleFormRows.length > 1) {
      state.scheduleFormRows.splice(idx, 1);
      render();
    }
    return;
  }

  const schedApprove = e.target.closest('[data-sched-approve]');
  if (schedApprove) {
    const id = schedApprove.dataset.schedApprove;
    await api(`/api/schedules/${id}/approve`, { method: 'POST' });
    await loadDb();
    render();
    return;
  }

  const schedIssue = e.target.closest('[data-sched-issue]');
  if (schedIssue) {
    const id = schedIssue.dataset.schedIssue;
    await api(`/api/schedules/${id}/issue`, { method: 'POST' });
    await loadDb();
    render();
    return;
  }

  const schedReturn = e.target.closest('[data-sched-return]');
  if (schedReturn && !schedReturn.dataset.schedBatch) {
    const id = schedReturn.dataset.schedReturn;
    const payload = collectScheduleReturnData(id);
    await api(`/api/schedules/${id}/return`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    await loadDb();
    render();
    return;
  }

  const deleteSchedule = e.target.closest('[data-delete-schedule]');
  if (deleteSchedule) {
    const id = deleteSchedule.dataset.deleteSchedule;
    if (!confirm('确定删除该调度单吗？此操作不可恢复。')) return;
    await api(`/api/schedules/${id}`, { method: 'DELETE' });
    state.expandedSchedule = null;
    await loadDb();
    render();
    return;
  }

  const jumpSchedules = e.target.closest('[data-jump-schedules]');
  if (jumpSchedules) {
    state.activeTab = 'schedules';
    state.activeView = 'schedules';
    render();
    return;
  }

  const exportAudit = e.target.closest('[data-export-audit]');
  if (exportAudit) {
    const viewId = exportAudit.dataset.exportAudit;
    const f = state.filters[viewId] || {};
    const params = new URLSearchParams();
    if (f.actionType) params.set('actionType', f.actionType);
    if (f.targetCollection) params.set('targetCollection', f.targetCollection);
    if (f.search?.trim()) params.set('search', f.search.trim());
    const qs = params.toString();
    const url = '/api/audit-logs/export' + (qs ? '?' + qs : '');
    try {
      const res = await fetch(url, { headers: { 'x-current-user-id': state.currentUser.id } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || '导出失败');
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : 'audit-logs.csv';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      toast('导出成功');
    } catch (err) {
      toast(err.message || '导出失败');
    }
    return;
  }
});

document.addEventListener('input', (e) => {
  const searchInput = e.target.closest('[data-search]');
  if (searchInput) {
    const viewId = searchInput.dataset.search;
    state.filters[viewId].search = searchInput.value;
    clearTimeout(state._searchTimer);
    state._searchTimer = setTimeout(render, 200);
    return;
  }

  const statusFilter = e.target.closest('[data-status-filter]');
  if (statusFilter) {
    const viewId = statusFilter.dataset.statusFilter;
    state.filters[viewId].status = statusFilter.value;
    render();
    return;
  }

  const stocktakeQtyInput = e.target.closest('[data-stocktake-qty]');
  if (stocktakeQtyInput) {
    const stId = stocktakeQtyInput.dataset.stocktakeQty;
    const batchId = stocktakeQtyInput.dataset.batchId;
    if (!state.stocktakeInputs) state.stocktakeInputs = {};
    if (!state.stocktakeInputs[stId]) state.stocktakeInputs[stId] = {};
    state.stocktakeInputs[stId][batchId] = stocktakeQtyInput.value;
    return;
  }

  const wasteActualInput = e.target.closest('[data-waste-actual]');
  if (wasteActualInput) {
    const wId = wasteActualInput.dataset.wasteActual;
    if (!state.wasteDisposalInputs) state.wasteDisposalInputs = {};
    state.wasteDisposalInputs[wId] = state.wasteDisposalInputs[wId] || {};
    state.wasteDisposalInputs[wId].actualQuantity = wasteActualInput.value;
    return;
  }

  const wasteMethodInput = e.target.closest('[data-waste-method]');
  if (wasteMethodInput) {
    const wId = wasteMethodInput.dataset.wasteMethod;
    if (!state.wasteDisposalInputs) state.wasteDisposalInputs = {};
    state.wasteDisposalInputs[wId] = state.wasteDisposalInputs[wId] || {};
    state.wasteDisposalInputs[wId].disposalMethod = wasteMethodInput.value;
    return;
  }

  const wasteWitnessInput = e.target.closest('[data-waste-witness]');
  if (wasteWitnessInput) {
    const wId = wasteWitnessInput.dataset.wasteWitness;
    if (!state.wasteDisposalInputs) state.wasteDisposalInputs = {};
    state.wasteDisposalInputs[wId] = state.wasteDisposalInputs[wId] || {};
    state.wasteDisposalInputs[wId].witness = wasteWitnessInput.value;
    return;
  }

  const wasteNoteInput = e.target.closest('[data-waste-note]');
  if (wasteNoteInput) {
    const wId = wasteNoteInput.dataset.wasteNote;
    if (!state.wasteDisposalInputs) state.wasteDisposalInputs = {};
    state.wasteDisposalInputs[wId] = state.wasteDisposalInputs[wId] || {};
    state.wasteDisposalInputs[wId].disposalNote = wasteNoteInput.value;
    return;
  }

  const schedRowInput = e.target.closest('[data-sched-row][data-sched-field]');
  if (schedRowInput) {
    const idx = Number(schedRowInput.dataset.schedRow);
    const field = schedRowInput.dataset.schedField;
    if (!state.scheduleFormRows) state.scheduleFormRows = [{}];
    if (!state.scheduleFormRows[idx]) state.scheduleFormRows[idx] = {};
    state.scheduleFormRows[idx][field] = schedRowInput.value;
    if (field === 'batchId') {
      const batch = (state.db.batches || []).find(b => b.id === schedRowInput.value);
      if (batch) {
        state.scheduleFormRows[idx].safetyLevel = batch.safetyLevel;
      }
    }
    render();
    return;
  }

  const schedReturnInput = e.target.closest('[data-sched-return][data-sched-batch][data-sched-return-field]');
  if (schedReturnInput) {
    const sId = schedReturnInput.dataset.schedReturn;
    const bId = schedReturnInput.dataset.schedBatch;
    const field = schedReturnInput.dataset.schedReturnField;
    if (!state.scheduleReturnInputs) state.scheduleReturnInputs = {};
    if (!state.scheduleReturnInputs[sId]) state.scheduleReturnInputs[sId] = {};
    if (!state.scheduleReturnInputs[sId][bId]) state.scheduleReturnInputs[sId][bId] = {};
    state.scheduleReturnInputs[sId][bId][field] = schedReturnInput.value;
    return;
  }

  const qtyInput = e.target.closest('input[name="quantity"]');
  if (qtyInput) {
    const form = e.target.closest('form');
    if (form) renderCabinetCapacityInfo(form);
    return;
  }
});

document.addEventListener('change', (e) => {
  const statusFilter = e.target.closest('[data-status-filter]');
  if (statusFilter) {
    const viewId = statusFilter.dataset.statusFilter;
    state.filters[viewId].status = statusFilter.value;
    render();
    return;
  }

  const auditAction = e.target.closest('[data-audit-action]');
  if (auditAction) {
    const viewId = auditAction.dataset.auditAction;
    state.filters[viewId] = state.filters[viewId] || { search: '', status: '', actionType: '', targetCollection: '' };
    state.filters[viewId].actionType = auditAction.value;
    render();
    return;
  }

  const auditCollection = e.target.closest('[data-audit-collection]');
  if (auditCollection) {
    const viewId = auditCollection.dataset.auditCollection;
    state.filters[viewId] = state.filters[viewId] || { search: '', status: '', actionType: '', targetCollection: '' };
    state.filters[viewId].targetCollection = auditCollection.value;
    render();
    return;
  }

  const cabinetSelect = e.target.closest('select[data-cabinet-select]');
  if (cabinetSelect) {
    const form = e.target.closest('form');
    if (form) renderCabinetCapacityInfo(form);
  }

  const autoFill = e.target.closest('[data-auto-fill]');
  if (autoFill) {
    const viewCfg = state.config.views.find(v => v.id === state.activeView);
    const form = e.target.closest('form');
    if (!form || !viewCfg) return;
    const fieldName = autoFill.name;
    const fieldCfg = viewCfg.fields?.find(f => f.name === fieldName);
    if (!fieldCfg || !fieldCfg.autoFill || fieldCfg.type !== 'relation') return;
    const relatedId = autoFill.value;
    const related = state.db[fieldCfg.collection]?.find(r => r.id === relatedId);
    if (!related) return;
    for (const rule of fieldCfg.autoFill) {
      const target = form.querySelector(`[name="${rule.to}"]`);
      if (target && related[rule.from] !== undefined) {
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
          target.value = related[rule.from];
        }
      }
    }
    if (fieldCfg.collection === 'batches' && fieldName === 'batchId' && related) {
      const now = new Date();
      const expiringDays = state.config.alerts?.expiringDays || 30;
      const expireDate = related.expiresAt ? new Date(related.expiresAt) : null;
      let alertType = 'normal';
      let reasonPrefix = '';
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
      const batchTitle = [related.name, related.batchNo].filter(Boolean).join(' / ');
      const suggestedTitle = `【${reasonPrefix}】${batchTitle}报废申请`;
      const suggestedReason = `${reasonPrefix}，建议报废。批次：${related.batchNo}，品名：${related.name}，规格：${related.quantity || 0}${related.unit || ''}，有效期：${related.expiresAt || '未设置'}。`;
      const titleInput = form.querySelector('input[name="title"]');
      if (titleInput && !titleInput.value.trim()) {
        titleInput.value = suggestedTitle;
      }
      const reasonInput = form.querySelector('textarea[name="reason"]');
      if (reasonInput && !reasonInput.value.trim()) {
        reasonInput.value = suggestedReason;
      }
      const suggestTitleDisplay = form.querySelector('input[name="suggestTitle"]');
      if (suggestTitleDisplay) {
        suggestTitleDisplay.value = suggestedTitle;
      }
      const qtyInput = form.querySelector('input[name="quantity"]');
      if (qtyInput && related.quantity !== undefined) {
        qtyInput.max = related.quantity;
        if (!qtyInput.value) {
          qtyInput.value = related.quantity;
        }
      }
      const applicantInput = form.querySelector('input[name="applicant"]');
      if (applicantInput && !applicantInput.value.trim() && state.currentUser?.name) {
        applicantInput.value = state.currentUser.name;
      }
      const codeInput = form.querySelector('input[name="code"]');
      if (codeInput && !codeInput.value.trim()) {
        const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const existingCount = (state.db.wastes || []).filter(w => w.code && w.code.includes(todayStr)).length;
        const seqNum = String(existingCount + 1).padStart(3, '0');
        codeInput.value = `BF${todayStr}${seqNum}`;
      }
    }
    if (form) renderCabinetCapacityInfo(form);
    return;
  }
});

document.addEventListener('submit', async (e) => {
  const stocktakeForm = e.target.closest('[data-stocktake-form]');
  if (stocktakeForm) {
    e.preventDefault();
    const data = collectFormData(stocktakeForm);
    data.status = '录入中';
    await api('/api/stocktakes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    state.activeModal = null;
    await loadDb();
    render();
    return;
  }

  const wasteForm = e.target.closest('[data-waste-form]');
  if (wasteForm) {
    e.preventDefault();
    const data = collectFormData(wasteForm);
    const qtyInput = wasteForm.querySelector('input[name="quantity"]');
    const maxQtyInput = wasteForm.querySelector('input[name="maxQuantity"]');
    if (qtyInput && maxQtyInput) {
      const qty = Number(qtyInput.value || 0);
      const maxQty = Number(maxQtyInput.value || 0);
      if (qty <= 0) {
        toast('报废数量必须大于0');
        return;
      }
      if (qty > maxQty) {
        toast(`报废数量(${qty})超过当前库存(${maxQty})`);
        return;
      }
    }
    try {
      await api('/api/wastes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      state.activeModal = null;
      state.wastePrefill = null;
      toast('报废申请已提交，等待审批');
      await loadDb();
      render();
    } catch (err) {
      toast(err.message || '提交失败');
    }
    return;
  }

  const crudForm = e.target.closest('[data-crud-form]');
  if (crudForm) {
    e.preventDefault();
    const collection = crudForm.dataset.crudForm;
    const editId = crudForm.dataset.editId;
    const data = collectFormData(crudForm);

    if (collection === 'batches' && data.cabinetId) {
      const qty = Number(data.quantity || 0);
      const occ = computeCabinetOccupancy(data.cabinetId, editId);
      if (occ) {
        const newOccupied = occ.occupiedQuantity + qty;
        if (newOccupied > occ.capacity) {
          const diffLabel = !editId ? `本次${qty}` : qty >= 0 ? `本次调整+${qty}` : `本次调整${qty}`;
          toast(`柜位容量不足！容量${occ.capacity}，已占用${occ.occupiedQuantity}，${diffLabel}，超出${newOccupied - occ.capacity}`);
          return;
        }
      }
    }

    try {
      if (editId) {
        await api(`/api/${collection}/${editId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
      } else {
        await api(`/api/${collection}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
      }
      state.activeModal = null;
      await loadDb();
      render();
    } catch (err) {
      toast(err.message || '保存失败');
    }
    return;
  }

  const scheduleForm = e.target.closest('[data-schedule-form]');
  if (scheduleForm) {
    e.preventDefault();
    const data = collectScheduleFormData();
    await api('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    state.scheduleFormRows = [{}];
    await loadDb();
    render();
    return;
  }
});

$('#refreshBtn').addEventListener('click', async () => {
  await loadDb();
  render();
  toast('数据已刷新');
});

async function boot() {
  try {
    const res = await fetch('/api/config');
    state.config = await res.json();
    document.getElementById('title').textContent = state.config.title;
    document.getElementById('lede').textContent = state.config.lede;

    const savedUserId = localStorage.getItem(USER_STORAGE_KEY);
    if (savedUserId) {
      state.currentUser = state.config.users.find(u => u.id === savedUserId) || null;
    }

    state.activeTab = state.config.views[0].id;
    state.activeView = state.config.views[0].id;
    await loadDb();
  } catch (err) {
    console.error(err);
    toast('启动失败：' + err.message);
  }
}

boot();
