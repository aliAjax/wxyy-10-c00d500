const state = {
  config: null,
  db: {},
  activeTab: '',
  expandedStocktake: null,
  stocktakeEdits: {}
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
  const actions = state.config.actions
    .filter((action) => action.collection === collection)
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
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
    if (view.type === 'dashboard') return renderDashboardView(view);
    if (view.type === 'stocktake') return renderStocktakeView(view);
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

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  const expandEl = event.target.closest('[data-expand-stocktake]');
  const saveBtn = event.target.closest('[data-stocktake-save]');
  const confirmBtn = event.target.closest('[data-stocktake-confirm]');

  if (tab) setTab(tab.dataset.tab);

  if (action) {
    try {
      await api(`/api/action/${action.dataset.action}/${action.dataset.id}`, { method: 'POST' });
      await load();
      toast('已更新');
    } catch (error) {
      toast(error.message);
    }
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
});

document.addEventListener('input', (event) => {
  const crudView = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (crudView) {
    if (crudView.type === 'stocktake') {
      refreshStocktakeList(crudView.id);
    } else {
      const listEl = $(`#list-${crudView.id}`);
      if (listEl) listEl.innerHTML = renderList(crudView);
    }
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
