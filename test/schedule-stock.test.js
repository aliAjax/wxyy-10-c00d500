const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const PORT = 3999;
const BASE_URL = `http://localhost:${PORT}`;
const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');
const DB_BACKUP = path.join(__dirname, '..', 'data', 'db.test-backup.json');

const TEST_USER_SHOW = 'user-show-1';
const TEST_USER_SAFETY = 'user-safety-1';
const TEST_USER_LIBRARIAN = 'user-staff-1';

let serverProcess = null;

function request(method, urlPath, body = null, userId = TEST_USER_SHOW) {
  return new Promise((resolve, reject) => {
    const options = {
      method,
      hostname: 'localhost',
      port: PORT,
      path: urlPath,
      headers: {
        'Content-Type': 'application/json',
        'x-current-user-id': userId
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function backupDb() {
  const content = await fs.readFile(DB_FILE, 'utf-8');
  await fs.writeFile(DB_BACKUP, content);
}

async function restoreDb() {
  try {
    const exists = await fs.access(DB_BACKUP).then(() => true).catch(() => false);
    if (exists) {
      const content = await fs.readFile(DB_BACKUP, 'utf-8');
      await fs.writeFile(DB_FILE, content);
      await fs.unlink(DB_BACKUP);
    }
  } catch (e) {
    console.error('恢复数据库失败:', e.message);
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const env = { ...process.env, PORT: String(PORT) };
    serverProcess = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let started = false;
    serverProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('port') || msg.includes('PORT') || msg.includes('Express') || !started) {
        if (!started) {
          started = true;
          setTimeout(resolve, 500);
        }
      }
    });

    serverProcess.stderr.on('data', (data) => {
      process.stderr.write(data);
    });

    serverProcess.on('error', reject);
    serverProcess.on('close', () => {
      if (!started) reject(new Error('服务器启动失败'));
    });

    setTimeout(() => {
      if (!started) {
        started = true;
        resolve();
      }
    }, 2000);
  });
}

async function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

async function getBatch(batchId) {
  const res = await request('GET', '/api/db');
  const batches = res.body.batches || [];
  return batches.find(b => b.id === batchId);
}

async function getSchedule(scheduleId) {
  const res = await request('GET', '/api/db');
  const schedules = res.body.schedules || [];
  return schedules.find(s => s.id === scheduleId);
}

before(async () => {
  await backupDb();
  await startServer();
});

after(async () => {
  await stopServer();
  await restoreDb();
});

describe('用药调度库存校验回归测试', () => {
  let testBatchId = null;
  let testProjectId = 'project-seed-2';
  let testBatchInitialQty = 0;

  test('准备测试数据：创建测试批次', async () => {
    const res = await request('POST', '/api/batches', {
      name: '回归测试专用药剂',
      category: '测试类',
      batchNo: 'TEST-REGRESS-001',
      supplierId: 'suppliers-1782020614900-fa3f3',
      cabinetId: 'cabinets-1782020614900-55917',
      safetyLevel: '中',
      quantity: 20,
      unit: '罐',
      expiresAt: '2030-01-01',
      status: '可用'
    }, TEST_USER_LIBRARIAN);

    assert.equal(res.status, 201, '创建批次应该成功');
    assert.ok(res.body.id, '应该返回批次ID');
    testBatchId = res.body.id;
    testBatchInitialQty = Number(res.body.quantity || 0);
    assert.equal(testBatchInitialQty, 20, '初始库存应为20');
    assert.equal(Number(res.body.reservedQuantity || 0), 0, '初始预占量应为0');
  });

  test('场景1：创建调度单时正确计算可用量 - 第一个调度单', async () => {
    const res = await request('POST', '/api/schedules', {
      code: 'TEST-SCHED-001',
      projectId: testProjectId,
      useWindow: '2026-09-01 19:00-20:00',
      operator: '测试员A',
      note: '回归测试调度单1',
      items: [
        {
          batchId: testBatchId,
          sprayPoint: '舞台中央',
          safetyLevel: '中',
          quantity: 8
        }
      ]
    }, TEST_USER_SHOW);

    assert.equal(res.status, 201, '创建调度单1应该成功');
    assert.equal(res.body.status, '调度待审批', '状态应为调度待审批');

    const batch = await getBatch(testBatchId);
    assert.equal(Number(batch.reservedQuantity || 0), 0, '待审批状态不应预占库存');
  });

  test('场景1：同一批次被多个调度预占时的可用量计算 - 审批第一个调度单', async () => {
    const schedulesRes = await request('GET', '/api/db');
    const schedule1 = (schedulesRes.body.schedules || []).find(s => s.code === 'TEST-SCHED-001');
    assert.ok(schedule1, '应该能找到调度单1');

    const approveRes = await request('POST', `/api/schedules/${schedule1.id}/approve`, {}, TEST_USER_SAFETY);
    assert.equal(approveRes.status, 200, '审批调度单1应该成功');
    assert.equal(approveRes.body.status, '调度已审批', '状态应为调度已审批');

    const batch = await getBatch(testBatchId);
    assert.equal(Number(batch.reservedQuantity), 8, '审批后预占量应为8');
    assert.equal(Number(batch.quantity), 20, '总库存仍为20');
  });

  test('场景1：同一批次被多个调度预占时的可用量计算 - 创建第二个调度单时库存校验', async () => {
    const res = await request('POST', '/api/schedules', {
      code: 'TEST-SCHED-002',
      projectId: testProjectId,
      useWindow: '2026-09-02 19:00-20:00',
      operator: '测试员B',
      note: '回归测试调度单2',
      items: [
        {
          batchId: testBatchId,
          sprayPoint: '舞台左侧',
          safetyLevel: '中',
          quantity: 10
        }
      ]
    }, TEST_USER_SHOW);

    assert.equal(res.status, 201, '创建调度单2应该成功（可用量20-8=12 >= 10）');

    const batch = await getBatch(testBatchId);
    assert.equal(Number(batch.reservedQuantity), 8, '待审批状态不增加预占');
  });

  test('场景1：同一批次被多个调度预占时的可用量计算 - 审批第二个调度单', async () => {
    const schedulesRes = await request('GET', '/api/db');
    const schedule2 = (schedulesRes.body.schedules || []).find(s => s.code === 'TEST-SCHED-002');
    assert.ok(schedule2, '应该能找到调度单2');

    const approveRes = await request('POST', `/api/schedules/${schedule2.id}/approve`, {}, TEST_USER_SAFETY);
    assert.equal(approveRes.status, 200, '审批调度单2应该成功');
    assert.equal(approveRes.body.status, '调度已审批', '状态应为调度已审批');

    const batch = await getBatch(testBatchId);
    assert.equal(Number(batch.reservedQuantity), 18, '审批后总预占量应为8+10=18');
    assert.equal(Number(batch.quantity), 20, '总库存仍为20');
  });

  test('场景4：库存不足时返回明确错误 - 创建超出可用量的调度单', async () => {
    const res = await request('POST', '/api/schedules', {
      code: 'TEST-SCHED-OVERFLOW',
      projectId: testProjectId,
      useWindow: '2026-09-03 19:00-20:00',
      operator: '测试员C',
      note: '超量测试调度单',
      items: [
        {
          batchId: testBatchId,
          sprayPoint: '舞台右侧',
          safetyLevel: '中',
          quantity: 5
        }
      ]
    }, TEST_USER_SHOW);

    assert.equal(res.status, 409, '库存不足应该返回409');
    assert.ok(res.body.error, '应该返回错误信息');
    assert.ok(
      res.body.error.includes('可用') || res.body.error.includes('超出') || res.body.error.includes('预占'),
      '错误信息应包含可用量或超出提示'
    );
    assert.ok(
      res.body.error.includes(String(testBatchInitialQty)) || res.body.error.includes('20'),
      '错误信息应包含库存相关数字'
    );

    const batch = await getBatch(testBatchId);
    assert.equal(Number(batch.reservedQuantity), 18, '创建失败不应改变预占量');
  });

  test('场景4：库存不足时返回明确错误 - 审批时库存不足', async () => {
    const schedulesRes = await request('GET', '/api/db');
    const existingReserved = schedulesRes.body.batches.find(b => b.id === testBatchId).reservedQuantity;
    assert.equal(Number(existingReserved), 18, '当前预占应为18');

    const createRes = await request('POST', '/api/schedules', {
      code: 'TEST-SCHED-APPROVE-FAIL',
      projectId: testProjectId,
      useWindow: '2026-09-04 19:00-20:00',
      operator: '测试员D',
      note: '审批失败测试',
      items: [
        {
          batchId: testBatchId,
          sprayPoint: '后台区域',
          safetyLevel: '中',
          quantity: 3
        }
      ]
    }, TEST_USER_SHOW);

    assert.equal(createRes.status, 409, '创建时就应该因库存不足失败');
    assert.ok(createRes.body.error, '应该返回错误信息');
  });

  test('场景2：审批后预占数量正确写回 - 验证预占明细', async () => {
    const schedulesRes = await request('GET', '/api/db');
    const schedule1 = (schedulesRes.body.schedules || []).find(s => s.code === 'TEST-SCHED-001');
    assert.ok(schedule1, '应该能找到调度单1');
    assert.equal(schedule1.status, '调度已审批', '状态应为调度已审批');

    const item1 = schedule1.items.find(it => it.batchId === testBatchId);
    assert.ok(item1, '应该能找到批次明细');
    assert.equal(Number(item1.reservedQuantity), 8, '明细中预占数量应为8');

    const batch = await getBatch(testBatchId);
    assert.equal(Number(batch.reservedQuantity), 18, '批次总预占量应为18');
  });

  test('场景3：删除调度单后释放预占', async () => {
    const schedulesRes = await request('GET', '/api/db');
    const schedule2 = (schedulesRes.body.schedules || []).find(s => s.code === 'TEST-SCHED-002');
    assert.ok(schedule2, '应该能找到调度单2');
    assert.equal(schedule2.status, '调度已审批', '状态应为调度已审批');

    const batchBefore = await getBatch(testBatchId);
    const reservedBefore = Number(batchBefore.reservedQuantity);
    assert.equal(reservedBefore, 18, '删除前预占量应为18');

    const deleteRes = await request('DELETE', `/api/schedules/${schedule2.id}`, null, TEST_USER_SHOW);
    assert.equal(deleteRes.status, 204, '删除调度单应该成功');

    const batchAfter = await getBatch(testBatchId);
    const reservedAfter = Number(batchAfter.reservedQuantity);
    assert.equal(reservedAfter, 8, '删除后预占量应减少10，变为8');
  });

  test('场景3：驳回调度单后释放预占', async () => {
    const createRes = await request('POST', '/api/schedules', {
      code: 'TEST-SCHED-REJECT',
      projectId: testProjectId,
      useWindow: '2026-09-05 19:00-20:00',
      operator: '测试员E',
      note: '驳回测试调度单',
      items: [
        {
          batchId: testBatchId,
          sprayPoint: '观众席',
          safetyLevel: '中',
          quantity: 5
        }
      ]
    }, TEST_USER_SHOW);

    assert.equal(createRes.status, 201, '创建调度单应该成功');
    const scheduleId = createRes.body.id;

    const approveRes = await request('POST', `/api/schedules/${scheduleId}/approve`, {}, TEST_USER_SAFETY);
    assert.equal(approveRes.status, 200, '审批调度单应该成功');

    const batchBeforeReject = await getBatch(testBatchId);
    assert.equal(Number(batchBeforeReject.reservedQuantity), 13, '驳回前预占量应为8+5=13');

    const rejectRes = await request('POST', `/api/action/schedule-reject/${scheduleId}`, {}, TEST_USER_SAFETY);
    assert.equal(rejectRes.status, 200, '驳回调度单应该成功');
    assert.equal(rejectRes.body.status, '调度已驳回', '状态应为调度已驳回');

    const batchAfterReject = await getBatch(testBatchId);
    assert.equal(Number(batchAfterReject.reservedQuantity), 8, '驳回后预占量应减少5，变为8');
  });

  test('场景2+3：完整生命周期验证 - 创建、审批、删除释放', async () => {
    const batchStart = await getBatch(testBatchId);
    const startReserved = Number(batchStart.reservedQuantity);

    const createRes = await request('POST', '/api/schedules', {
      code: 'TEST-SCHED-LIFECYCLE',
      projectId: testProjectId,
      useWindow: '2026-09-06 19:00-20:00',
      operator: '测试员F',
      note: '完整生命周期测试',
      items: [
        {
          batchId: testBatchId,
          sprayPoint: '舞台顶部',
          safetyLevel: '中',
          quantity: 3
        }
      ]
    }, TEST_USER_SHOW);

    assert.equal(createRes.status, 201);
    const scheduleId = createRes.body.id;

    const batchAfterCreate = await getBatch(testBatchId);
    assert.equal(Number(batchAfterCreate.reservedQuantity), startReserved, '创建后预占不变');

    const approveRes = await request('POST', `/api/schedules/${scheduleId}/approve`, {}, TEST_USER_SAFETY);
    assert.equal(approveRes.status, 200);

    const batchAfterApprove = await getBatch(testBatchId);
    assert.equal(Number(batchAfterApprove.reservedQuantity), startReserved + 3, '审批后预占+3');

    const deleteRes = await request('DELETE', `/api/schedules/${scheduleId}`, null, TEST_USER_SHOW);
    assert.equal(deleteRes.status, 204);

    const batchAfterDelete = await getBatch(testBatchId);
    assert.equal(Number(batchAfterDelete.reservedQuantity), startReserved, '删除后预占恢复原值');
  });

  test('库存流水记录验证 - 预占和释放都有流水', async () => {
    const res = await request('GET', `/api/batches/${testBatchId}/transactions`);
    assert.equal(res.status, 200, '应该能获取批次流水');
    assert.ok(Array.isArray(res.body.transactions), '应该返回流水数组');

    const transactions = res.body.transactions;
    const reserveTx = transactions.filter(t => t.type === 'reserve');
    const releaseTx = transactions.filter(t => t.type === 'releaseReserve');

    assert.ok(reserveTx.length > 0, '应该有预占流水记录');
    assert.ok(releaseTx.length > 0, '应该有释放预占流水记录');

    const reserveSum = reserveTx.reduce((s, t) => s + Number(t.reservedDelta || 0), 0);
    const releaseSum = releaseTx.reduce((s, t) => s + Number(t.reservedDelta || 0), 0);

    const batch = await getBatch(testBatchId);
    const expectedNet = Number(batch.reservedQuantity || 0);
    const actualNet = reserveSum + releaseSum;
    assert.equal(actualNet, expectedNet, '预占流水净增量应等于当前预占量');
  });
});
