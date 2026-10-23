'use strict';
// v1.8.8 加载性能修复验收：
// ① /api/monitor 下发的 LLM 评级剔除可回退/按需字段（evaluator_skill_snapshot、record_snapshot、request_snapshot.reference_index）；
// ② 完整评级经 GET /api/monitor/ratings/:id 按需拉取（含规则全文索引）；
// ③ 评级跑批轮询经 GET /api/monitor/rating-progress 只拿进行中跑批摘要；
// ④ 大响应按 Accept-Encoding: gzip 压缩下发；
// ⑤ 评级跑批写入节流（中间态合并落盘，终态不被覆盖）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { authenticatedFetch } = require('./helpers-auth.cjs');

async function reservePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startServer(dir) {
  const port = await reservePort();
  const handle = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
    env: { ...process.env, CSR_DATA_DIR: dir, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  handle.stderr.on('data', (x) => { stderr += x; });
  const base = 'http://127.0.0.1:' + port;
  const fetch = authenticatedFetch(dir);
  for (let i = 0; i < 240; i++) {
    try { const r = await fetch(base + '/api/monitor'); if (r.status === 200) return { base, fetch, handle, stderr }; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  handle.kill();
  throw Error('测试服务未启动: ' + stderr);
}

// 合成一个可评级批次：场景 → 方案 → 确认 → 批次 → 路由确认。
async function fixture(base, fetch) {
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, value: await response.json().catch(() => null) };
  };
  const scene = (await api('POST', '/api/monitor/scenes', { code: 'PERF-SCENE', name: '取消费争议', description: '合成场景', boundary: '仅测试', scopes: ['frontline'], actor: '测试' })).value.scene;
  const plan = await api('POST', '/api/monitor/plans', { scene_id: scene.id, name: 'PERF合成方案', scene: '取消费争议', scope: 'frontline', goal: '核对联系', trigger: '明确陈述', prompt: '读底单', materials: '话单', judgement: '事实一致', exceptions: '缺失不判断', output: '证据和问题', reference: '不判断责任', actor: '测试' });
  const revision = plan.value.revision;
  await api('POST', '/api/monitor/plans/' + revision.plan_id + '/confirm', { revision_id: revision.id, actor: '测试' });
  const candidate = (await api('POST', '/api/monitor/plans/' + revision.plan_id + '/generate', { revision_id: revision.id, mode: 'local' })).value.candidate;
  await api('POST', '/api/monitor/candidates/' + candidate.id + '/approve', { actor: '测试' });
  const batch = (await api('POST', '/api/monitor/batches', { scene_id: scene.id, candidate_id: candidate.id, name: 'PERF批次', source_kind: 'sync', source_name: '合成同步', request_id: 'perf-batch-1', actor: '测试', records: [{ name: '合成展示样本', scope: 'frontline', scene: '取消费争议', ai_reply: '已外呼2次。', evidence: [] }] })).value.batch;
  const review = (await api('GET', '/api/monitor/batches/' + batch.id + '/routing')).value;
  await api('POST', '/api/monitor/batches/' + batch.id + '/routing/confirm', { review_hash: review.review_hash, confirmed: true, group_keys: review.groups.map((g) => g.key), actor: '测试' });
  return api;
}

test('加载性能：评级按需加载、轮询轻量端点与 gzip 压缩', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-perf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { base, fetch, handle, stderr } = await startServer(dir);
  await fetch(base + '/api/monitor'); // 触发测试账号创建与改密（helpers-auth）
  const loginResp = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '13900000001', password: 'test-permanent-password' }) });
  const cookie = loginResp.headers.get('set-cookie').split(';')[0];
  const api = await fixture(base, fetch);
  let mock;
  try {
    mock = await require('./mock-rating-service.cjs').createMockRatingService();
    const profile = (await api('POST', '/api/monitor/models', { name: '本地合成模型', base_url: mock.base_url, api_key: 'SYNTHETIC_ONLY', models: ['fixture-model'], actor: '测试' })).value.profile;
    await api('POST', '/api/monitor/model-default', { selection: { profile_id: profile.id, model: 'fixture-model' }, actor: '测试' });
    const rated = await api('POST', '/api/monitor/batches/' + (await latestBatchId(api)) + '/rate', { actor: '测试', request_id: require('node:crypto').randomUUID() });
    assert.equal(rated.status, 200, JSON.stringify(rated.value));
    for (let i = 0; i < 200; i++) {
      const state = await api('GET', '/api/monitor/rating-runs/' + rated.value.run.id);
      if (state.value.run.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // ① /api/monitor 的 LLM 评级摘要剔除三个字段（渲染均有回退路径）。
    const boot = (await api('GET', '/api/monitor')).value;
    const rating = boot.ratings.find((r) => r.run_id === rated.value.run.id);
    assert.ok(rating, 'bootstrap 应包含该评级摘要');
    assert.equal(rating.grade, "L2");
    assert.equal(rating.evaluator_skill_snapshot, undefined, '摘要不应下发 evaluator_skill_snapshot');
    assert.equal(rating.record_snapshot, undefined, '摘要不应下发 record_snapshot');
    assert.equal(rating.request_snapshot.reference_index, undefined, '摘要不应下发规则全文索引');
    assert.ok(rating.request_snapshot.sources?.length, '摘要保留 sources（问题定位渲染需要）');
    assert.ok(boot.batch_items.some((i) => i.record_snapshot), 'batch_items 仍带 record_snapshot（回退路径）');

    // ② 完整单条按需拉取，含规则全文索引与原始返回。
    const detail = await api('GET', '/api/monitor/ratings/' + rating.id);
    assert.equal(detail.status, 200);
    assert.ok(Array.isArray(detail.value.rating.request_snapshot.reference_index), '完整单条应含规则全文索引');
    assert.ok(detail.value.rating.raw_response, '完整单条应含模型原始返回');
    assert.ok(detail.value.rating.evaluator_skill_snapshot, '完整单条应含评估员快照');
    assert.ok(detail.value.rating.record_snapshot, '完整单条应含记录快照');
    const missing = await api('GET', '/api/monitor/ratings/not-exist');
    assert.equal(missing.status, 404);

    // ③ 跑批已结束，轻量轮询端点返回空（不返回全量）。
    const progress = await api('GET', '/api/monitor/rating-progress');
    assert.equal(progress.status, 200);
    assert.deepEqual(progress.value.runs, []);
    assert.deepEqual(progress.value.ratings, []);

    // ④ 大响应 gzip：/api/monitor 压缩后显著小于原体积（原生 http 请求，避免 fetch 自动解压干扰）。
    const http = require('node:http');
    const rawGet = (acceptGzip) => new Promise((resolve, reject) => {
      const u = new URL(base + '/api/monitor');
      const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { Cookie: cookie, ...(acceptGzip ? { 'Accept-Encoding': 'gzip' } : {}) } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ headers: res.headers, buf: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
    const plain = await rawGet(false);
    assert.equal(plain.headers['content-encoding'], undefined, '无 Accept-Encoding 时不应压缩');
    const gz = await rawGet(true);
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.ok(gz.buf.length < plain.buf.length * 0.6, 'gzip 后应显著小于原文（' + gz.buf.length + ' vs ' + plain.buf.length + '）');
    const zlib = require('node:zlib');
    assert.deepEqual(JSON.parse(zlib.gunzipSync(gz.buf).toString('utf8')), JSON.parse(plain.buf.toString('utf8')), '解压后内容与原文一致');

    // ⑤ 写入节流不破坏终态：评级完成后 step_runs 全为终态，进度计数准确。
    assert.equal(detail.value.rating.status, 'completed');
    assert.ok(detail.value.rating.step_runs.every((s) => ['completed', 'skipped', 'failed'].includes(s.status)), '终态 step_runs 不应残留 running/pending');
    const run = boot.rating_runs.find((r) => r.id === rated.value.run.id);
    assert.equal(run.status, 'completed');
    assert.equal(run.processed_count, run.total);
  } finally {
    if (mock) await mock.close();
    handle.kill();
  }
});

async function latestBatchId(api) {
  const boot = (await api('GET', '/api/monitor')).value;
  return boot.batches.at(-1).id;
}
