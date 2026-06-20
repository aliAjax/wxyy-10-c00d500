module.exports = {
  port: 3910,
  title: '舞台烟火药剂出入库',
  lede: '把药剂批次、演出领用审批、出库回库和报废记录串起来，避免过期、错级和库存不足的危险流转。',
  tones: {
    '可用': 'ok',
    '已回库': 'ok',
    '合作中': 'ok',
    '锁定': 'warn',
    '待审批': 'warn',
    '已审批': 'warn',
    '已出库': 'warn',
    '已暂停': 'warn',
    '已过期': 'bad',
    '已报废': 'bad',
    '已驳回': 'bad',
    '资质过期': 'bad'
  },
  collections: {
    batches: { label: '药剂批次' },
    requests: { label: '领用申请' },
    suppliers: { label: '供应商档案' }
  },
  stats: [
    { label: '药剂批次', collection: 'batches' },
    { label: '可用批次', collection: 'batches', filter: { field: 'status', value: '可用' } },
    { label: '待审批', collection: 'requests', filter: { field: 'status', value: '待审批' } },
    { label: '已出库', collection: 'requests', filter: { field: 'status', value: '已出库' } },
    { label: '供应商', collection: 'suppliers' },
    { label: '合作中', collection: 'suppliers', filter: { field: 'status', value: '合作中' } }
  ],
  views: [
    {
      id: 'dashboard',
      label: '库存看板',
      type: 'dashboard',
      focusTitle: '风险批次与未闭环申请',
      focus: { collection: 'requests', field: 'status', values: ['待审批', '已审批', '已出库'], limit: 8 }
    },
    {
      id: 'batches',
      label: '药剂批次',
      collection: 'batches',
      formTitle: '新增药剂批次',
      listTitle: '批次列表',
      submitLabel: '保存批次',
      searchPlaceholder: '搜索名称、批次、柜位',
      searchFields: ['name', 'category', 'batchNo', 'cabinet'],
      statusField: 'status',
      statusOptions: ['可用', '锁定', '已过期', '已报废'],
      titleFields: ['name', 'batchNo'],
      summaryFields: ['category', 'cabinet'],
      detailFields: [
        { label: '安全等级', name: 'safetyLevel' },
        { label: '库存', name: 'quantity' },
        { label: '有效期', name: 'expiresAt' },
        { label: '供应商', name: 'supplierId', type: 'relation', collection: 'suppliers', labelFields: ['name'] }
      ],
      fields: [
        { label: '药剂名称', name: 'name', required: true },
        { label: '品类', name: 'category', required: true },
        { label: '批次号', name: 'batchNo', required: true },
        { label: '供应商', name: 'supplierId', type: 'relation', collection: 'suppliers', labelFields: ['name'], required: true, wide: true },
        { label: '存放柜位', name: 'cabinet', required: true },
        { label: '安全等级', name: 'safetyLevel', type: 'select', options: ['低', '中', '高'] },
        { label: '库存数量', name: 'quantity', type: 'number', required: true },
        { label: '单位', name: 'unit', default: '罐', required: true },
        { label: '有效期', name: 'expiresAt', type: 'date', required: true },
        { label: '状态', name: 'status', type: 'select', options: ['可用', '锁定', '已过期', '已报废'], wide: true }
      ]
    },
    {
      id: 'requests',
      label: '演出审批',
      collection: 'requests',
      formTitle: '提交领用申请',
      listTitle: '审批流转',
      submitLabel: '提交申请',
      searchPlaceholder: '搜索演出、地点、操作员',
      searchFields: ['showName', 'venue', 'operator', 'memo'],
      statusField: 'status',
      statusOptions: ['待审批', '已审批', '已出库', '已回库', '已驳回'],
      titleFields: ['showName', 'venue'],
      relation: { collection: 'batches', localKey: 'batchId', labelFields: ['name', 'batchNo'] },
      summaryFields: ['useWindow', 'operator', 'memo'],
      detailFields: [
        { label: '申请数量', name: 'quantity' },
        { label: '已回库', name: 'returned' },
        { label: '报废', name: 'wasted' }
      ],
      defaults: { status: '待审批', returned: 0, wasted: 0 },
      fields: [
        { label: '药剂批次', name: 'batchId', type: 'relation', collection: 'batches', labelFields: ['name', 'batchNo'], required: true, wide: true },
        { label: '演出名称', name: 'showName', required: true },
        { label: '演出地点', name: 'venue', required: true },
        { label: '使用时段', name: 'useWindow', required: true },
        { label: '操作人员', name: 'operator', required: true },
        { label: '申请数量', name: 'quantity', type: 'number', required: true },
        { label: '所需安全等级', name: 'safetyLevel', type: 'select', options: ['低', '中', '高'] },
        { label: '安全备注', name: 'memo', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'suppliers',
      label: '供应商档案',
      collection: 'suppliers',
      formTitle: '新增供应商',
      listTitle: '供应商列表',
      submitLabel: '保存供应商',
      searchPlaceholder: '搜索名称、联系人、品类',
      searchFields: ['name', 'contact', 'category'],
      statusField: 'status',
      statusOptions: ['合作中', '已暂停', '资质过期'],
      titleFields: ['name'],
      summaryFields: ['contact', 'category'],
      detailFields: [
        { label: '风险等级', name: 'riskLevel' },
        { label: '资质到期', name: 'certExpiresAt' },
        { label: '联系电话', name: 'phone' }
      ],
      fields: [
        { label: '供应商名称', name: 'name', required: true },
        { label: '联系人', name: 'contact', required: true },
        { label: '联系电话', name: 'phone' },
        { label: '供应品类', name: 'category', required: true },
        { label: '风险等级', name: 'riskLevel', type: 'select', options: ['低', '中', '高'] },
        { label: '资质到期日', name: 'certExpiresAt', type: 'date', required: true },
        { label: '状态', name: 'status', type: 'select', options: ['合作中', '已暂停', '资质过期'], wide: true }
      ]
    }
  ],
  actions: [
    { id: 'batch-ok', label: '可用', collection: 'batches', patches: [{ field: 'status', value: '可用' }] },
    { id: 'batch-lock', label: '锁定', collection: 'batches', patches: [{ field: 'status', value: '锁定' }] },
    { id: 'batch-waste', label: '报废', collection: 'batches', danger: true, patches: [{ field: 'status', value: '已报废' }] },
    { id: 'request-approve', label: '审批通过', collection: 'requests', patches: [{ field: 'status', value: '已审批' }] },
    {
      id: 'request-issue',
      label: '出库',
      collection: 'requests',
      relation: { collection: 'batches', localKey: 'batchId' },
      guards: [
        { left: 'related.status', op: 'eq', right: '可用', message: '批次不可用，不能出库' },
        { left: 'related.quantity', op: 'gte', rightPath: 'item.quantity', message: '库存不足，不能出库' },
        { left: 'related.safetyLevel', op: 'levelGte', rightPath: 'item.safetyLevel', message: '安全等级不匹配，不能出库' }
      ],
      patches: [{ field: 'status', value: '已出库' }],
      deltas: [{ target: 'related', field: 'quantity', amountPath: 'item.quantity', amount: -1 }]
    },
    { id: 'request-return', label: '回库闭环', collection: 'requests', patches: [{ field: 'status', value: '已回库' }, { field: 'returned', valuePath: 'item.quantity' }] },
    { id: 'request-reject', label: '驳回', collection: 'requests', danger: true, patches: [{ field: 'status', value: '已驳回' }] },
    { id: 'supplier-active', label: '合作中', collection: 'suppliers', patches: [{ field: 'status', value: '合作中' }] },
    { id: 'supplier-pause', label: '暂停', collection: 'suppliers', patches: [{ field: 'status', value: '已暂停' }] },
    { id: 'supplier-expired', label: '资质过期', collection: 'suppliers', danger: true, patches: [{ field: 'status', value: '资质过期' }] }
  ]
};
