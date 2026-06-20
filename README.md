# 舞台烟火药剂出入库

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3910

数据保存在`data/db.json`，后续可以继续增量迭代。

## 操作审计日志

系统内置**操作审计日志**模块，所有关键操作均会自动记录到 `auditLogs` 集合，日志只读不可修改。

### 日志覆盖范围

| 操作类型 | 目标集合 | 说明 |
|---------|---------|------|
| **创建** | batches / requests / suppliers / cabinets / projects / stocktakes / wastes | 所有新增记录操作 |
| **更新** | 所有集合 | 字段更新及状态变更（通过 PATCH 接口） |
| **删除** | 所有集合 | 记录删除操作及删除前的数据 |
| **审批通过** | requests / wastes | 审批通过操作 |
| **驳回** | requests / wastes | 申请驳回操作 |
| **出库** | requests | 领用申请出库操作 |
| **回库闭环** | requests | 领用申请回库操作 |
| **锁定** | batches | 批次锁定操作 |
| **可用** | batches | 批次解锁/恢复可用操作 |
| **报废** | batches | 批次直接报废操作 |
| **盘点录入** | stocktakes | 盘点单录入操作 |
| **盘点确认** | stocktakes | 盘点确认操作 |
| **审批通过** | wastes | 报废单审批通过 |
| **确认处置** | wastes | 报废单确认处置 |
| **报废审批(关联)** | batches | 由报废单审批触发的批次关联记录 |
| **报废扣减(关联)** | batches | 由报废处置触发的批次库存扣减关联记录 |

### 日志字段

- `actionType`：操作类型
- `targetCollection`：目标集合
- `targetId`：目标记录ID
- `targetLabel`：目标记录标题（便于展示）
- `changes`：主要字段变化（before / after）
- `note`：备注信息
- `operator`：操作人
- `createdAt`：操作时间

### 前端功能

在「操作审计日志」标签页中可查看所有日志，支持：
- 按**操作类型**过滤
- 按**目标集合**过滤
- 按**关键词**搜索（标题、备注、操作人、ID等）
