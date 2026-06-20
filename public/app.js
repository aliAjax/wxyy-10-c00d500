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
  scheduleFormRows: [{}]
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
    const canEdit = !confirmed && canCurrentUser('special', 'stocktakes-items');
    const inputAttrs = canEdit ? '' : 'readonly disabled';
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

  const canApprove = waste.status === '待审批' && canCurrentUser('special', 'wastes-approve');
  const canReject = waste.status === '待审批' && canCurrentUser('action', 'waste-reject');
  const canDispose = waste.status === '待处置' && canCurrentUser('special', 'wastes-dispose');

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
          ${canApprove ? `<button class="secondary" data-waste-approve="${waste.id}">审批通过</button>` : ''}
          ${canReject ? `<button class="danger" data-action="waste-reject" data-id="${waste.id}">驳回</button>` : ''}
          ${!canApprove && !canReject ? `<span class="no-permission-tip-inline">⚠️ 当前角色无报废审批权限</span>` : ''}
        </div>
      `;
    } else if (waste.status === '待处置') {
      const actualQty = state.wasteEdits[waste.id]?.actualQuantity ?? waste.quantity;
      const disposalMethod = state.wasteEdits[waste.id]?.disposalMethod || waste.disposalMethod || '';
      const witness = state.wasteEdits[waste.id]?.witness || waste.witness || '';
      const disposalNote = state.wasteEdits[waste.id]?.disposalNote || waste.disposalNote || '';
      const disabledAttr = canDispose ? '' : 'readonly disabled';
      actionButtons = `
        <div class="waste-dispose-form">
          <h4>确认处置</h4>
          <div class="form-grid">
            <label>实际处置数量<input type="number" class="waste-input" data-waste-actual="${waste.id}" data-waste="${waste.id}" data-field="actualQuantity" value="${actualQty}" min="0" max="${waste.quantity}" ${disabledAttr}><span class="unit">${escapeHtml(unit)}</span></label>
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
            <label class="wide">处置备注<input type="text" class="waste-input" data-waste-note="${waste.id}" data-waste="${waste.id}" data-field="disposalNote" value="${escapeHtml(disposalNote)}" ${disabledAttr} placeholder="记录处置过程中的特殊情况..."></label>
          </div>
          <div class="waste-actions">
            ${canDispose ? `<button class="danger" data-waste-dispose="${waste.id}">确认处置并扣减库存</button>` : `<span class="no-permission-tip-inline">⚠️ 当前角色无报废处置权限</span>`}
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
  const createForm = canCreate ? `
    <form class="panel" data-waste-form data-create="${view.collection}" data-view="${view.id}">
      <h2>${escapeHtml(view.formTitle)}</h2>
      <div class="form-grid">${view.fields.map(formField).join('')}</div>
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

  return `<section class="view" id="${view.id}">
    <div class="panel">
      <h2>操作审计日志</h2>
      <p class="meta">所有关键操作均会自动记录，日志只读不可修改。</p>
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
          <p class="meta">供应商和柜位请填写名称/编号，系统会自动匹配</p>
        </div>
        <div class="import-actions">
          <button data-import-preview>解析预览</button>
        </div>
      </div>
    `;
  }

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
                    : `<div class="import-errors">${row.errors.map((e) => `<span class="pill bad">${escapeHtml(e)}</span>`).join('')}</div>`}
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
      ${inputArea}
      ${summaryHtml}
      ${tableHtml}
    </div>
  </section>`;
}

function renderScheduleFormRows() {
  const rows = state.scheduleFormRows || [{}];
  const batches = (state.db.batches || []).filter(b => b.status === '可用');
  return rows.map((row, idx) => {
    const selectedBatch = batches.find(b => b.id === row.batchId);
    const maxQty = selectedBatch ? selectedBatch.quantity : 0;
    const unit = selectedBatch ? selectedBatch.unit : '';
    const canRemove = rows.length > 1;
    return `<tr class="schedule-form-row">
      <td>
        <select data-sched-row="${idx}" data-sched-field="batchId">
          <option value="">请选择批次</option>
          ${batches.map(b => `<option value="${b.id}" ${row.batchId === b.id ? 'selected' : ''}>${escapeHtml(b.name + ' / ' + b.batchNo + '（库存：' + b.quantity + b.unit + ' / 等级：' + b.safetyLevel + '）')}</option>`).join('')}
        </select>
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
        <input type="number" min="1" max="${maxQty || ''}" data-sched-row="${idx}" data-sched-field="quantity" value="${row.quantity || ''}" placeholder="数量">
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
  return {
    actualQuantity: inputs.actualQuantity !== undefined ? Number(inputs.actualQuantity) : Number(waste?.quantity || 0),
    disposalMethod: inputs.disposalMethod || waste?.disposalMethod || '',
    witness: inputs.witness || '',
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
    state.activeView = 'wastes';
    state.activeModal = { collection: 'wastes', prefill: { batchId } };
    render();
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
      const parsed = parseImportText(raw);
      state.importPreview = parsed;
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

  const importConfirm = e.target.closest('[data-import-confirm]');
  if (importConfirm) {
    e.preventDefault();
    if (!state.importPreview || state.importPreview.length === 0) {
      toast('没有可导入的数据');
      return;
      }
    const results = [];
    for (const row of state.importPreview) {
      const ok = await api('/api/batches', { method: 'POST', body: JSON.stringify(row) });
      results.push(ok);
    }
    toast(`成功导入 ${results.filter(r => r).length} 条`);
    state.importPreview = null;
    await loadDb();
    render();
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
    await api('/api/wastes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    state.activeModal = null;
    await loadDb();
    render();
    return;
  }

  const crudForm = e.target.closest('[data-crud-form]');
  if (crudForm) {
    e.preventDefault();
    const collection = crudForm.dataset.crudForm;
    const editId = crudForm.dataset.editId;
    const data = collectFormData(crudForm);
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
