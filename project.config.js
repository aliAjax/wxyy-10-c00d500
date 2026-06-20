module.exports = {
  port: 3910,
  title: '舞台烟火药剂出入库',
  lede: '把药剂批次、演出领用审批、出库回库和报废记录串起来，避免过期、错级和库存不足的危险流转。',
  tones: {
    '可用': 'ok',
    '已回库': 'ok',
    '合作中': 'ok',
    '空闲': 'ok',
    '使用中': 'ok',
    '已确认': 'ok',
    '锁定': 'warn',
    '待审批': 'warn',
    '已审批': 'warn',
    '已出库': 'warn',
    '已暂停': 'warn',
    '已满': 'warn',
    '录入中': 'warn',
    '已过期': 'bad',
    '已报废': 'bad',
    '已驳回': 'bad',
    '资质过期': 'bad',
    '停用': 'bad',
    '草稿': 'warn',
    '筹备中': 'warn',
    '进行中': 'ok',
    '已完成': 'ok',
    '已取消': 'bad'
  },
  collections: {
    batches: { label: '药剂批次' },
    requests: { label: '领用申请' },
    suppliers: { label: '供应商档案' },
    cabinets: { label: '柜位台账' },
    projects: { label: '演出项目' },
    stocktakes: { label: '库存盘点' }
  },
  alerts: {
    expiringDays: 30,
    lowStockThreshold: 10,
    openRequestStatuses: ['待审批', '已审批', '已出库']
  },
  stats: [
    { label: '药剂批次', collection: 'batches' },
    { label: '可用批次', collection: 'batches', filter: { field: 'status', value: '可用' } },
    { label: '待审批', collection: 'requests', filter: { field: 'status', value: '待审批' } },
    { label: '已出库', collection: 'requests', filter: { field: 'status', value: '已出库' } },
    { label: '防爆柜', collection: 'cabinets' },
    { label: '空闲柜位', collection: 'cabinets', filter: { field: 'status', value: '空闲' } },
    { label: '供应商', collection: 'suppliers' },
    { label: '合作中', collection: 'suppliers', filter: { field: 'status', value: '合作中' } },
    { label: '演出项目', collection: 'projects' },
    { label: '筹备中', collection: 'projects', filter: { field: 'status', value: '筹备中' } },
    { label: '盘点单', collection: 'stocktakes' },
    { label: '录入中盘点', collection: 'stocktakes', filter: { field: 'status', value: '录入中' } }
  ],
  views: [
    {
      id: 'risk-alerts',
      label: '风险预警中心',
      type: 'risk-alerts',
      collection: 'batches',
      titleFields: ['name', 'batchNo'],
      summaryFields: ['category'],
      statusField: 'status',
      detailFields: [
        { label: '安全等级', name: 'safetyLevel' },
        { label: '库存', name: 'quantity' },
        { label: '有效期', name: 'expiresAt' },
        { label: '供应商', name: 'supplierId', type: 'relation', collection: 'suppliers', labelFields: ['name'] },
        { label: '存放区域', name: 'cabinetId', type: 'relation', collection: 'cabinets', labelFields: ['area'] },
        { label: '柜位负责人', name: 'cabinetId', type: 'relation', collection: 'cabinets', labelFields: ['manager'] }
      ]
    },
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
      searchFields: ['name', 'category', 'batchNo', 'cabinetId'],
      statusField: 'status',
      statusOptions: ['可用', '锁定', '已过期', '已报废'],
      titleFields: ['name', 'batchNo'],
      summaryFields: ['category'],
      detailFields: [
        { label: '安全等级', name: 'safetyLevel' },
        { label: '库存', name: 'quantity' },
        { label: '有效期', name: 'expiresAt' },
        { label: '供应商', name: 'supplierId', type: 'relation', collection: 'suppliers', labelFields: ['name'] },
        { label: '存放区域', name: 'cabinetId', type: 'relation', collection: 'cabinets', labelFields: ['area'] },
        { label: '柜位负责人', name: 'cabinetId', type: 'relation', collection: 'cabinets', labelFields: ['manager'] }
      ],
      fields: [
        { label: '药剂名称', name: 'name', required: true },
        { label: '品类', name: 'category', required: true },
        { label: '批次号', name: 'batchNo', required: true },
        { label: '供应商', name: 'supplierId', type: 'relation', collection: 'suppliers', labelFields: ['name'], required: true, wide: true },
        { label: '存放柜位', name: 'cabinetId', type: 'relation', collection: 'cabinets', labelFields: ['code', 'area'], required: true, wide: true },
        { label: '安全等级', name: 'safetyLevel', type: 'select', options: ['低', '中', '高'] },
        { label: '库存数量', name: 'quantity', type: 'number', required: true },
        { label: '单位', name: 'unit', default: '罐', required: true },
        { label: '有效期', name: 'expiresAt', type: 'date', required: true },
        { label: '状态', name: 'status', type: 'select', options: ['可用', '锁定', '已过期', '已报废'], wide: true }
      ]
    },
    {
      id: 'cabinets',
      label: '柜位台账',
      collection: 'cabinets',
      formTitle: '新增柜位',
      listTitle: '柜位列表',
      submitLabel: '保存柜位',
      searchPlaceholder: '搜索编号、区域、负责人',
      searchFields: ['code', 'area', 'manager'],
      statusField: 'status',
      statusOptions: ['空闲', '使用中', '已满', '停用'],
      titleFields: ['code'],
      summaryFields: ['area', 'manager'],
      detailFields: [
        { label: '容量上限', name: 'capacity' },
        { label: '已占用', name: 'occupiedCount', type: 'computed', compute: 'count', source: 'batches', matchField: 'cabinetId' },
        { label: '已占用库存', name: 'occupiedQuantity', type: 'computed', compute: 'sum', source: 'batches', matchField: 'cabinetId', sumField: 'quantity' }
      ],
      fields: [
        { label: '防爆柜编号', name: 'code', required: true },
        { label: '所在区域', name: 'area', required: true },
        { label: '容量上限', name: 'capacity', type: 'number', required: true },
        { label: '负责人', name: 'manager', required: true },
        { label: '状态', name: 'status', type: 'select', options: ['空闲', '使用中', '已满', '停用'], wide: true }
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
      searchFields: ['showName', 'venue', 'operator', 'memo', 'projectId'],
      statusField: 'status',
      statusOptions: ['待审批', '已审批', '已出库', '已回库', '已驳回'],
      titleFields: ['showName', 'venue'],
      relation: { collection: 'batches', localKey: 'batchId', labelFields: ['name', 'batchNo'] },
      summaryFields: ['useWindow', 'operator', 'memo'],
      detailFields: [
        { label: '申请数量', name: 'quantity' },
        { label: '已回库', name: 'returned' },
        { label: '报废', name: 'wasted' },
        { label: '演出日期', name: 'projectId', type: 'relation', collection: 'projects', labelFields: ['showDate'] },
        { label: '项目负责人', name: 'projectId', type: 'relation', collection: 'projects', labelFields: ['manager'] },
        { label: '风险等级', name: 'projectId', type: 'relation', collection: 'projects', labelFields: ['riskLevel'] }
      ],
      defaults: { status: '待审批', returned: 0, wasted: 0 },
      fields: [
        { label: '药剂批次', name: 'batchId', type: 'relation', collection: 'batches', labelFields: ['name', 'batchNo'], required: true, wide: true },
        { label: '演出项目', name: 'projectId', type: 'relation', collection: 'projects', labelFields: ['name', 'venue'], required: true, wide: true, autoFill: [{ from: 'name', to: 'showName' }, { from: 'venue', to: 'venue' }] },
        { label: '演出名称', name: 'showName', type: 'display', required: true },
        { label: '演出地点', name: 'venue', type: 'display', required: true },
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
    },
    {
      id: 'projects',
      label: '演出项目档案',
      collection: 'projects',
      formTitle: '新增演出项目',
      listTitle: '项目列表',
      submitLabel: '保存项目',
      searchPlaceholder: '搜索演出名称、地点、主办方、负责人',
      searchFields: ['name', 'venue', 'organizer', 'manager'],
      statusField: 'status',
      statusOptions: ['筹备中', '进行中', '已完成', '已取消'],
      titleFields: ['name'],
      summaryFields: ['venue', 'organizer'],
      detailFields: [
        { label: '演出日期', name: 'showDate' },
        { label: '风险等级', name: 'riskLevel' },
        { label: '负责人', name: 'manager' },
        { label: '关联申请', name: 'requestCount', type: 'computed', compute: 'count', source: 'requests', matchField: 'projectId' }
      ],
      fields: [
        { label: '演出名称', name: 'name', required: true, wide: true },
        { label: '演出地点', name: 'venue', required: true, wide: true },
        { label: '主办方', name: 'organizer', required: true },
        { label: '负责人', name: 'manager', required: true },
        { label: '演出日期', name: 'showDate', type: 'date', required: true },
        { label: '风险等级', name: 'riskLevel', type: 'select', options: ['低', '中', '高'] },
        { label: '状态', name: 'status', type: 'select', options: ['筹备中', '进行中', '已完成', '已取消'], wide: true }
      ]
    },
    {
      id: 'stocktakes',
      label: '库存盘点',
      type: 'stocktake',
      collection: 'stocktakes',
      formTitle: '创建盘点单',
      listTitle: '盘点单列表',
      submitLabel: '创建盘点单',
      searchPlaceholder: '搜索盘点单号、标题、操作员',
      searchFields: ['code', 'title', 'operator', 'note'],
      statusField: 'status',
      statusOptions: ['草稿', '录入中', '已确认'],
      titleFields: ['code', 'title'],
      summaryFields: ['operator', 'note'],
      fields: [
        { label: '盘点单号', name: 'code', required: true },
        { label: '盘点标题', name: 'title', required: true, wide: true },
        { label: '盘点柜位', name: 'cabinetId', type: 'relation', collection: 'cabinets', labelFields: ['code', 'area'], wide: true },
        { label: '操作员', name: 'operator', required: true },
        { label: '盘点范围/备注', name: 'note', type: 'textarea', wide: true }
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
    { id: 'supplier-expired', label: '资质过期', collection: 'suppliers', danger: true, patches: [{ field: 'status', value: '资质过期' }] },
    { id: 'cabinet-free', label: '空闲', collection: 'cabinets', patches: [{ field: 'status', value: '空闲' }] },
    { id: 'cabinet-inuse', label: '使用中', collection: 'cabinets', patches: [{ field: 'status', value: '使用中' }] },
    { id: 'cabinet-full', label: '已满', collection: 'cabinets', patches: [{ field: 'status', value: '已满' }] },
    { id: 'cabinet-disable', label: '停用', collection: 'cabinets', danger: true, patches: [{ field: 'status', value: '停用' }] },
    { id: 'project-prepare', label: '筹备中', collection: 'projects', patches: [{ field: 'status', value: '筹备中' }] },
    { id: 'project-ongoing', label: '进行中', collection: 'projects', patches: [{ field: 'status', value: '进行中' }] },
    { id: 'project-complete', label: '已完成', collection: 'projects', patches: [{ field: 'status', value: '已完成' }] },
    { id: 'project-cancel', label: '取消', collection: 'projects', danger: true, patches: [{ field: 'status', value: '已取消' }] }
  ]
};
