'use strict';
/*
 * 解决力评估 · 服务端（Node 原生 http，零外部依赖）
 * 页面：public/index.html（检测台 / 复核台 / 数据看板 / 全盘记录 / 标准库）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Storage } = require('./storage');
const { analyze, parseMessages, mergeSupplements } = require('./engine');
const { seedStandards } = require('./standards-seed');
const { createMonitoring } = require('./monitoring');
const { generateMonitoringPlan, replayServiceSkill } = require('./model-bridge');
const { createAgent, getAgentConfig, ensureAgentConfig } = require('./agent');
const M = require('./materials');

const PORT = Number(process.env.PORT || 8817);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.CSR_DATA_DIR || path.join(ROOT, 'data'));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const storage = new Storage(path.join(DATA_DIR, 'db.json'));
const access = require('./auth').createAuth({ dataDir: DATA_DIR, send });
seedStandards(storage);
const modelConfigs = require('./model-configs').createModelConfigs({storage});
ensureAgentConfig(storage);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
        // The account identity takes precedence over browser-local signatures.
        if (req.user) {
          const current = access.auth.current(req.headers.cookie);
          if (!current) throw Object.assign(Error('登录已失效，请重新登录'), { statusCode: 401 });
          if (current.user.must_change_password) throw Object.assign(Error('请先修改初始或重置密码'), { statusCode: 403, code: 'PASSWORD_CHANGE_REQUIRED' });
          value.actor = current.user.name; value.operator = current.user.name;
        }
        resolve(value);
      }
      catch (e) { reject(e.statusCode ? e : new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function getLlmConfig() {
  return {
    base_url: storage.getSetting('llm_base_url', ''),
    api_key: storage.getSetting('llm_api_key', ''),
    model: storage.getSetting('llm_model', ''),
  };
}

// ---------- 检测入库 ----------

async function detectAndStore(rawInput, batchId) {
  const input = mergeSupplements(rawInput);
  const standards = storage.list('standards');
  const llm = getLlmConfig();
  const result = await analyze(rawInput, standards, llm);

  if (result.status === 'need_input') {
    return { status: 'need_input', questions: result.questions, mode: result.mode, note: result.note };
  }

  const missingFields = [];
  if (!String(input.session_text || '').trim()) missingFields.push('原始会话');
  if (!String(input.ai_reply || '').trim()) missingFields.push('AI 建议回复');
  if (!String(input.intent_id || input.intent_name || '').trim()) missingFields.push('系统意图');
  if (!String(input.scene_id || input.scene_name || '').trim()) missingFields.push('命中场景');

  const session = storage.insert('sessions', {
    batch_id: batchId || null,
    source_type: input.source_type || 'text',
    session_time: input.session_time || '',
    raw_text: input.session_text,
    messages_json: JSON.stringify(parseMessages(input.session_text)),
    intent_id: input.intent_id || '',
    intent_name: input.intent_name || '',
    scene_id: input.scene_id || '',
    scene_name: input.scene_name || '',
    ai_reply: input.ai_reply || '',
    exec_result: input.exec_result || '',
    missing_fields: missingFields,
    operator: input.operator || storage.getSetting('operator', '未署名'),
  });

  const reviewIds = [];
  for (const r of result.demands) {
    const level = r.solution_eval.overall_level;
    const det = storage.insert('detections', {
      session_id: session.id,
      demand_key: r.demand.key,
      mode: result.mode,
      demand_description: r.demand.description,
      demand_is_primary: r.demand.is_primary,
      demand_type: r.demand.demand_type,
      overall_level: level,
      intent_conclusion: r.intent_eval.conclusion,
      scene_conclusion: r.scene_eval.conclusion,
      result_json: JSON.stringify(r),
      rule_refs: (r.solution_eval.level_rule_refs || result.rule_refs || []).join(','),
    });
    // 抽检：L3 按比例随机抽检（V2.1 6.3 抽检纪律）
    const ratio = Number(storage.getSetting('spotcheck_ratio', 0.1));
    const needsSpotcheck = level === 'L3' && Math.random() < ratio;
    const priority = level === 'U' || level === 'L0' || r.demand.primary_pending ? 'high' : needsSpotcheck ? 'spotcheck' : 'normal';
    const review = storage.insert('reviews', {
      session_id: session.id,
      detection_id: det.id,
      status: '待复核',
      priority,
      needs_spotcheck: !!needsSpotcheck,
      reviewer: '',
      human_level: '',
      fix_reason: '',
      extra_evidence: '',
      history_json: '[]',
    });
    reviewIds.push(review.id);
  }

  return {
    status: 'done',
    session_id: session.id,
    review_ids: reviewIds,
    mode: result.mode,
    report: result,
    disclaimer: result.disclaimer,
  };
}

// ---------- 统计（V2.1 7.1 分母口径） ----------

function computeStats() {
  const allSessions = storage.list('sessions');
  const sessions = allSessions.filter((s) => s.count_in_stats !== false); // 复验样本不计入默认口径
  const countedIds = new Set(sessions.map((s) => s.id));
  const sessionMeta = {};
  for (const s of allSessions) sessionMeta[s.id] = s;
  const dets = storage.list('detections').filter((d) => countedIds.has(d.session_id));
  const reviews = storage.list('reviews').filter((r) => countedIds.has(r.session_id));
  const corrections = storage.list('corrections');

  const total = dets.length;
  const levelCount = { L0: 0, L1: 0, L2: 0, L3: 0, U: 0 };
  for (const d of dets) if (levelCount[d.overall_level] !== undefined) levelCount[d.overall_level]++;
  const evaluable = total - levelCount.U;
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

  // 分组统计（按意图 / 场景 / 问题类型）
  const groupBy = (keyFn) => {
    const g = {};
    for (const d of dets) {
      const k = keyFn(d) || '（缺失）';
      const s = g[k] || (g[k] = { total: 0, L0: 0, L1: 0, L2: 0, L3: 0, U: 0 });
      s.total++;
      if (s[d.overall_level] !== undefined) s[d.overall_level]++;
    }
    for (const k of Object.keys(g)) {
      const s = g[k];
      s.evaluable = s.total - s.U;
      s.l3_rate = s.evaluable ? Math.round((s.L3 / s.evaluable) * 1000) / 10 : null;
    }
    return g;
  };
  const byIntent = groupBy((d) => (sessionMeta[d.session_id] || {}).intent_name || (sessionMeta[d.session_id] || {}).intent_id);
  const byScene = groupBy((d) => (sessionMeta[d.session_id] || {}).scene_name || (sessionMeta[d.session_id] || {}).scene_id);
  const byType = groupBy((d) => d.demand_type);

  // 链路质量
  const intentEvalable = dets.filter((d) => ['correct', 'wrong', 'missed'].includes(d.intent_conclusion));
  const intentCorrect = intentEvalable.filter((d) => d.intent_conclusion === 'correct').length;
  const sceneEvalable = dets.filter((d) => ['correct', 'wrong'].includes(d.scene_conclusion));
  const sceneCorrect = sceneEvalable.filter((d) => d.scene_conclusion === 'correct').length;

  // 人工替代潜力（residual_work 各环节 ai_done 占比，分母=已记录环节）
  const workKeys = { query: '信息查询', analysis: '原因分析', decision: '方案判断', communication: '沟通组织', execution: '业务执行' };
  const workStats = {};
  for (const k of Object.keys(workKeys)) {
    let done = 0, manual = 0, na = 0, u = 0;
    for (const d of dets) {
      try {
        const w = JSON.parse(d.result_json).residual_work || {};
        const v = w[k];
        if (v === 'ai_done') done++;
        else if (v === 'manual') manual++;
        else if (v === 'not_needed') na++;
        else u++;
      } catch (e) { /* ignore */ }
    }
    workStats[k] = { label: workKeys[k], ai_done: done, manual, not_needed: na, u, total: done + manual + na + u };
  }

  // 归因分布
  const attrCount = {};
  for (const d of dets) {
    try {
      const a = JSON.parse(d.result_json).attribution || {};
      for (const i of (a.direct_issues || [])) {
        const key = i.type || '未分类';
        attrCount[key] = (attrCount[key] || 0) + 1;
      }
    } catch (e) { /* ignore */ }
  }

  // U 原因分布
  const uReasonCount = {};
  for (const d of dets) {
    try {
      const r = JSON.parse(d.result_json);
      const us = (r.solution_eval.u_reasons || []).concat(r.intent_eval.u ? [r.intent_eval.u] : [], r.scene_eval.u ? [r.scene_eval.u] : []);
      for (const u of us) if (u && u.code) uReasonCount[u.code] = (uReasonCount[u.code] || 0) + 1;
    } catch (e) { /* ignore */ }
  }

  // 复核状态分布
  const reviewStatus = {};
  for (const r of reviews) reviewStatus[r.status] = (reviewStatus[r.status] || 0) + 1;

  // 会话级
  const sessionSummary = { '检测通过': 0, '存在已确认问题': 0, '整体无法判断': 0 };
  for (const s of sessions) {
    const ds = dets.filter((d) => d.session_id === s.id);
    if (!ds.length) continue;
    const anyError = ds.some((d) => d.overall_level === 'L0' || d.intent_conclusion === 'wrong' || d.scene_conclusion === 'wrong');
    const anyU = ds.some((d) => d.overall_level === 'U' || d.intent_conclusion === 'u' || d.scene_conclusion === 'u');
    if (anyError) sessionSummary['存在已确认问题']++;
    else if (anyU) sessionSummary['整体无法判断']++;
    else sessionSummary['检测通过']++;
  }

  // 纠正任务
  const correctionStatus = {};
  for (const c of corrections) correctionStatus[c.status] = (correctionStatus[c.status] || 0) + 1;

  return {
    overview: {
      session_count: sessions.length,
      demand_count: total,
      level_count: levelCount,
      evaluable,
      l3_delivery_rate: pct(levelCount.L3, evaluable),
      effective_assist_rate: pct(levelCount.L2 + levelCount.L3, evaluable),
      l1_rate: pct(levelCount.L1, evaluable),
      l0_rate: pct(levelCount.L0, evaluable),
      evaluable_rate: pct(evaluable, total),
      u_rate: pct(levelCount.U, total),
      full_l3_coverage: pct(levelCount.L3, total),
    },
    link_quality: {
      intent_accuracy: pct(intentCorrect, intentEvalable.length),
      intent_evaluable: intentEvalable.length,
      scene_accuracy: pct(sceneCorrect, sceneEvalable.length),
      scene_evaluable: sceneEvalable.length,
    },
    work_stats: workStats,
    by_intent: byIntent,
    by_scene: byScene,
    by_type: byType,
    attribution: attrCount,
    u_reasons: uReasonCount,
    review_status: reviewStatus,
    session_summary: sessionSummary,
    correction_status: correctionStatus,
  };
}

// ---------- 路由 ----------

const routes = {
  'GET /api/bootstrap': async (req, res) => {
    send(res, 200, {
      settings: {
        operator: storage.getSetting('operator', ''),
        spotcheck_ratio: storage.getSetting('spotcheck_ratio', 0.1),
        llm_base_url: storage.getSetting('llm_base_url', ''),
        llm_model: storage.getSetting('llm_model', ''),
        llm_api_key_set: !!storage.getSetting('llm_api_key', ''),
      },
      engine_mode: (getLlmConfig().base_url && getLlmConfig().api_key && getLlmConfig().model) ? 'llm' : 'rule',
      standards: storage.list('standards').map((s) => ({ id: s.id, type: s.type, name: s.name, version: s.version, status: s.status })),
      materials: createAgent({ storage, computeStats, getLlmConfig }).materialsReadiness(),
      datasets: M.datasetSummary(storage),
      stats: computeStats(),
    });
  },

  'POST /api/detect': async (req, res) => {
    const input = await readBody(req);
    if (!String(input.session_text || '').trim() && !(input.supplements || {}).session_text) {
      return send(res, 400, { error: '请先粘贴会话内容' });
    }
    const r = await detectAndStore(input, null);
    send(res, r.status === 'need_input' ? 200 : 200, r);
  },

  'POST /api/batch': async (req, res) => {
    const body = await readBody(req);
    const rows = body.rows || [];
    if (!Array.isArray(rows) || !rows.length) return send(res, 400, { error: '导入数据为空' });
    const batch = storage.insert('batches', { name: body.name || '未命名批次', status: '检测中', row_count: rows.length });
    const results = [];
    let ok = 0, needInput = 0, failed = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const r = await detectAndStore({
          session_text: row.session_text || row['会话内容'] || '',
          intent_id: row.intent_id || row['系统意图ID'] || '',
          intent_name: row.intent_name || row['意图名称'] || '',
          scene_id: row.scene_id || row['场景ID'] || '',
          scene_name: row.scene_name || row['场景名称'] || '',
          ai_reply: row.ai_reply || row['AI建议回复'] || '',
          exec_result: row.exec_result || row['执行结果'] || '',
          source_type: row.source_type || row['来源类型'] || 'text',
          session_time: row.session_time || row['会话时间'] || '',
          operator: body.operator || '',
        }, batch.id);
        if (r.status === 'need_input') needInput++; else ok++;
        results.push({ index: i + 1, status: r.status, session_id: r.session_id, review_ids: r.review_ids, questions: r.questions || null, mode: r.mode });
      } catch (e) {
        failed++;
        results.push({ index: i + 1, status: 'error', error: e.message });
      }
    }
    storage.update('batches', batch.id, { status: '已完成', stats_json: JSON.stringify({ ok, needInput, failed }) });
    const addedIds = results.filter((r) => r.session_id).map((r) => r.session_id);
    if (addedIds.length) {
      M.recordSamplesVersion(storage, { added: addedIds.length, added_ids: addedIds, note: '批量导入：' + (body.name || '未命名批次'), operator: body.operator || storage.getSetting('operator', '') || '' });
    }
    send(res, 200, { batch_id: batch.id, summary: { total: rows.length, ok, needInput, failed }, results });
  },

  'GET /api/batches': async (req, res) => {
    const batches = storage.list('batches').slice().reverse().map((b) => {
      const ss = storage.list('sessions').filter((s) => s.batch_id === b.id);
      return Object.assign({}, b, { session_count: ss.length });
    });
    send(res, 200, { batches });
  },

  'GET /api/reviews': async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const status = u.searchParams.get('status') || '';
    const q = (u.searchParams.get('q') || '').trim();
    let list = storage.list('reviews');
    if (status && status !== '全部') list = list.filter((r) => r.status === status);
    const out = [];
    for (const r of list) {
      const s = storage.byId('sessions', r.session_id);
      const d = storage.byId('detections', r.detection_id);
      if (!s || !d) continue;
      if (q && !(s.intent_name || '').includes(q) && !(s.scene_name || '').includes(q) && !(d.demand_description || '').includes(q) && !(s.raw_text || '').includes(q)) continue;
      out.push({
        review_id: r.id,
        status: r.status,
        priority: r.priority,
        needs_spotcheck: r.needs_spotcheck,
        reviewer: r.reviewer,
        human_level: r.human_level,
        session_id: s.id,
        source_type: s.source_type,
        demand_description: d.demand_description,
        intent_name: s.intent_name || s.intent_id,
        scene_name: s.scene_name || s.scene_id,
        overall_level: d.overall_level,
        mode: d.mode,
        created_at: d.created_at,
      });
    }
    out.sort((a, b) => {
      const order = { high: 0, spotcheck: 1, normal: 2 };
      return (order[a.priority] - order[b.priority]) || (b.created_at > a.created_at ? 1 : -1);
    });
    send(res, 200, { reviews: out });
  },

  'GET /api/reviews/:id': async (req, res, params) => {
    const r = storage.byId('reviews', params.id);
    if (!r) return send(res, 404, { error: '复核记录不存在' });
    const s = storage.byId('sessions', r.session_id);
    const d = storage.byId('detections', r.detection_id);
    send(res, 200, {
      review: r,
      session: s ? { id: s.id, source_type: s.source_type, raw_text: s.raw_text, intent_id: s.intent_id, intent_name: s.intent_name, scene_id: s.scene_id, scene_name: s.scene_name, ai_reply: s.ai_reply, exec_result: s.exec_result, missing_fields: s.missing_fields, created_at: s.created_at } : null,
      detection: d ? { id: d.id, mode: d.mode, demand_description: d.demand_description, demand_is_primary: d.demand_is_primary, overall_level: d.overall_level, result: JSON.parse(d.result_json) } : null,
    });
  },

  'POST /api/reviews/:id/action': async (req, res, params) => {
    const r = storage.byId('reviews', params.id);
    if (!r) return send(res, 404, { error: '复核记录不存在' });
    const body = await readBody(req);
    const action = body.action;
    const history = JSON.parse(r.history_json || '[]');
    const operator = body.operator || storage.getSetting('operator', '未署名');
    const TERMINAL = ['confirm', 'fix', 'mark_u', 'arbitrate'];
    if (TERMINAL.includes(action) && ['已复核', '已裁决'].includes(r.status)) {
      return send(res, 409, { error: '该记录已被' + (r.reviewer || '其他人') + '处理（状态：' + r.status + '），你的操作未生效，请刷新后查看最新结论。' });
    }
    history.push({ action, at: new Date().toISOString(), by: operator, payload: body.payload || null });

    let patch = { history_json: JSON.stringify(history), reviewer: operator };
    if (action === 'start') patch.status = '复核中';
    else if (action === 'confirm') { patch.status = '已复核'; patch.human_level = body.payload && body.payload.level || null; }
    else if (action === 'fix') { patch.status = '已复核'; patch.human_level = (body.payload || {}).level || ''; patch.fix_reason = (body.payload || {}).reason || ''; }
    else if (action === 'evidence') { patch.status = '复核中'; patch.extra_evidence = (body.payload || {}).text || ''; }
    else if (action === 'mark_u') { patch.status = '已复核'; patch.human_level = 'U'; patch.fix_reason = (body.payload || {}).reason || '人工标记无法判断'; }
    else if (action === 'dispute') { patch.status = '争议待裁决'; patch.fix_reason = (body.payload || {}).reason || ''; }
    else if (action === 'arbitrate') { patch.status = '已裁决'; patch.human_level = (body.payload || {}).level || ''; patch.fix_reason = (body.payload || {}).reason || ''; }
    else if (action === 'submit_standard') {
      patch.status = '标准待完善';
      const d = storage.byId('detections', r.detection_id);
      storage.insert('standard_issues', {
        type: (body.payload || {}).type || '缺失',
        description: (body.payload || {}).description || '标准缺失待补充',
        reason_code: (body.payload || {}).reason_code || '',
        related_session_ids: r.session_id,
        related_detection_ids: r.detection_id,
        status: '待处理',
        owner: '',
      });
    } else return send(res, 400, { error: '未知复核动作' });

    const updated = storage.update('reviews', r.id, patch);
    send(res, 200, { review: updated });
  },

  'GET /api/stats': async (req, res) => {
    send(res, 200, computeStats());
  },

  'GET /api/sessions': async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = (u.searchParams.get('q') || '').trim();
    let sessions = storage.list('sessions').slice().reverse();
    const out = [];
    for (const s of sessions) {
      const dets = storage.list('detections').filter((d) => d.session_id === s.id);
      const reviews = storage.list('reviews').filter((r) => r.session_id === s.id);
      const rec = {
        id: s.id,
        source_type: s.source_type,
        created_at: s.created_at,
        intent_name: s.intent_name || s.intent_id || '（缺失）',
        scene_name: s.scene_name || s.scene_id || '（缺失）',
        missing_fields: s.missing_fields,
        demand_count: dets.length,
        levels: dets.map((d) => d.overall_level),
        review_statuses: reviews.map((r) => r.status),
        preview: (s.raw_text || '').slice(0, 60),
      };
      if (q && !rec.intent_name.includes(q) && !rec.scene_name.includes(q) && !rec.preview.includes(q) && !s.id.includes(q)) continue;
      out.push(rec);
    }
    send(res, 200, { sessions: out });
  },

  'GET /api/sessions/:id': async (req, res, params) => {
    const s = storage.byId('sessions', params.id);
    if (!s) return send(res, 404, { error: '会话不存在' });
    const dets = storage.list('detections').filter((d) => d.session_id === s.id);
    const reviews = storage.list('reviews').filter((r) => r.session_id === s.id);
    const rechecks = storage.list('sessions').filter((x) => x.recheck_of === s.id).map((x) => ({
      id: x.id, created_at: x.created_at,
      levels: storage.list('detections').filter((d) => d.session_id === x.id).map((d) => d.overall_level),
    }));
    send(res, 200, {
      session: s,
      detections: dets.map((d) => ({ id: d.id, demand_description: d.demand_description, overall_level: d.overall_level, mode: d.mode, result: JSON.parse(d.result_json) })),
      reviews,
      rechecks,
    });
  },

  'GET /api/standards': async (req, res) => {
    send(res, 200, { standards: storage.list('standards') });
  },

  'POST /api/standards': async (req, res) => {
    const body = await readBody(req);
    if (!body.name || !body.type) return send(res, 400, { error: '标准类型与名称必填' });
    const s = storage.insert('standards', {
      type: body.type, name: body.name, content: body.content || '',
      version: 1, status: body.status || '草稿', source: '人工',
      effective_at: body.status === '已生效' ? new Date().toISOString() : null,
    });
    const ds = M.datasetOfType(s.type);
    const v = ds ? M.commitDataset(storage, ds.key, { note: '人工新增：' + s.name, source: '人工', operator: storage.getSetting('operator', '') }) : null;
    send(res, 200, { standard: s, dataset_version: v ? v.version : null });
  },

  'PATCH /api/standards/:id': async (req, res, params) => {
    const s = storage.byId('standards', params.id);
    if (!s) return send(res, 404, { error: '标准不存在' });
    const body = await readBody(req);
    const patch = {};
    if (body.content !== undefined) patch.content = body.content;
    if (body.status !== undefined) {
      patch.status = body.status;
      if (body.status === '已生效') { patch.version = s.version + 1; patch.effective_at = new Date().toISOString(); }
    }
    const updated = storage.update('standards', s.id, patch);
    const ds = M.datasetOfType(s.type);
    const v = ds ? M.commitDataset(storage, ds.key, { note: '人工修改：' + s.name, source: '人工', operator: storage.getSetting('operator', '') }) : null;
    send(res, 200, { standard: updated, dataset_version: v ? v.version : null });
  },

  'DELETE /api/standards/:id': async (req, res, params) => {
    const s = storage.byId('standards', params.id);
    if (!s) return send(res, 404, { error: '标准不存在' });
    storage.remove('standards', params.id);
    const ds = M.datasetOfType(s.type);
    const v = ds ? M.commitDataset(storage, ds.key, { note: '人工删除：' + s.name, source: '人工', operator: storage.getSetting('operator', '') }) : null;
    send(res, 200, { ok: true, dataset_version: v ? v.version : null });
  },

  'GET /api/standard-issues': async (req, res) => {
    send(res, 200, { issues: storage.list('standard_issues').slice().reverse() });
  },

  'PATCH /api/standard-issues/:id': async (req, res, params) => {
    const it = storage.byId('standard_issues', params.id);
    if (!it) return send(res, 404, { error: '事项不存在' });
    const body = await readBody(req);
    send(res, 200, { issue: storage.update('standard_issues', it.id, { status: body.status || it.status, owner: body.owner || it.owner }) });
  },

  'POST /api/corrections': async (req, res) => {
    const body = await readBody(req);
    const c = storage.insert('corrections', {
      session_id: body.session_id || null,
      detection_id: body.detection_id || null,
      target: body.target || '',
      description: body.description || '',
      current_level: body.current_level || '',
      expected_level: body.expected_level || '',
      attribution: body.attribution || '',
      suggestion: body.suggestion || '',
      fix_type: body.fix_type || '原 AI 能力修正',
      status: '待纠正',
    });
    send(res, 200, { correction: c });
  },

  'GET /api/corrections': async (req, res) => {
    send(res, 200, { corrections: storage.list('corrections').slice().reverse() });
  },

  'PATCH /api/corrections/:id': async (req, res, params) => {
    const c = storage.byId('corrections', params.id);
    if (!c) return send(res, 404, { error: '任务不存在' });
    const body = await readBody(req);
    send(res, 200, { correction: storage.update('corrections', c.id, body) });
  },

  'POST /api/settings': async (req, res) => {
    const body = await readBody(req);
    const allowed = ['operator', 'spotcheck_ratio', 'llm_base_url', 'llm_api_key', 'llm_model'];
    for (const k of allowed) if (body[k] !== undefined) storage.setSetting(k, body[k]);
    send(res, 200, { ok: true });
  },

  // ---------- 评估助手（Agent 对话） ----------
  'POST /api/agent/chat': async (req, res) => {
    const body = await readBody(req);
    const agent = createAgent({ storage, computeStats, getLlmConfig });
    const r = await agent.chat(body.message);
    // 对话中提交的检测：直接走检测入库，回摘要
    if (r.intent === 'detect' && r.payload) {
      const stored = await detectAndStore(r.payload, null);
      if (stored.status === 'need_input') {
        return send(res, 200, { reply: '这段材料还不足以检测，引擎有 ' + stored.questions.length + ' 个问题要问：' + stored.questions.map((q) => q.label || q.field).join('、') + '。请在检测台补齐后重试。', blocks: [], trace: r.trace, need_input: stored.questions, actions: [{ label: '去检测台', view: 'detect' }] });
      }
      const rep = stored.report;
      const dm = rep.demands[0] || {};
      return send(res, 200, {
        reply: '检测完成（' + (stored.mode === 'llm' ? '大模型' : '规则引擎') + '模式），会话级结论：' + rep.session_summary + '。' +
          rep.demands.map((d) => '「' + d.demand.description.slice(0, 24) + '」→ ' + d.solution_eval.overall_level).join('；') +
          '。已落入复核台待复核。',
        blocks: [{ type: 'detect_result', data: { session_id: stored.session_id, levels: rep.demands.map((d) => d.solution_eval.overall_level), summary: rep.session_summary, mode: stored.mode } }],
        trace: r.trace, actions: [{ label: '查看检测报告', view: 'detect', sessionId: stored.session_id }, { label: '去复核', view: 'review' }],
      });
    }
    send(res, 200, r);
  },

  // ---------- 材料就绪度 ----------
  'GET /api/materials': async (req, res) => {
    const agent = createAgent({ storage, computeStats, getLlmConfig });
    send(res, 200, agent.materialsReadiness());
  },

  // ---------- 模板下载（材料中心用） ----------
  'GET /api/templates': async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const kind = u.searchParams.get('kind') || 'batch';
    const csv = (headers, rows) => {
      const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      return '\ufeff' + headers.map(q).join(',') + '\n' + rows.map((r) => r.map(q).join(',')).join('\n');
    };
    const map = {
      intent: csv(['标准类型', '名称', '内容（定义：含什么/排除什么/边界）', '状态'], [
        ['意图定义', '奖励未到账咨询', '司机询问奖励/保底/冲单奖为什么没到账、什么时候到账。排除：奖励金额算错（归奖励金额异常）、奖励规则咨询。', '已生效'],
        ['意图定义', '奖励金额异常', '司机认为奖励金额与预期不符、算错、少发。排除：单纯未到账。', '已生效'],
      ]),
      scene: csv(['标准类型', '名称', '内容（适用条件/排除条件）', '状态'], [
        ['场景定义', '奖励到账查询', '适用于司机查询奖励发放状态、到账时间。排除：奖励计算规则咨询。', '已生效'],
      ]),
      mapping: csv(['标准类型', '名称', '内容（映射依据）', '状态'], [
        ['意图-场景映射', '奖励未到账咨询 → 奖励到账查询', '该意图的诉求均涉及发放状态查询，统一进入到账查询场景。', '已生效'],
      ]),
      checklist: csv(['标准类型', '名称', '内容（逐条检查项）', '状态'], [
        ['场景检查清单', '奖励到账查询', '1 是否说明当前奖励批次/状态；2 是否说明到账时效规则；3 是否说明在哪里查明细；4 是否说明超期怎么办（申诉入口）。', '已生效'],
      ]),
      cases: csv(['标准类型', '名称', '内容（案例原文 + 为什么好/坏）', '状态'], [
        ['正案例', '奖励到账查询', '「已查到您的奖励在10月第2批，审核中，按规则3个工作日内到账，可在司机端账单明细查看，超期可走奖励申诉」——有事实、有规则、有入口，属 L3。', '已生效'],
        ['负案例', '奖励到账查询', '「奖励一般三个工作日内到账，请您耐心等待」——只有通用规则没有当前事实，属 L1。', '已生效'],
      ]),
      intent_wide: csv(['一级意图', '一级意图ID', '二级意图', '二级意图ID', '三级意图', '三级意图ID', '三级意图规则', '三级意图定义', '案例1', '案例2', '案例3'], [
        ['司机违规申诉', '100', '判罚申诉', '110', '判罚结果异议', '111', '司机对判罚结果有异议、要求复核时适用', '司机不认可违章/违规判罚结果，要求复核或撤销。', '我根本没超速为什么判我违规', '这个判罚我不认可', ''],
        ['司机违规申诉', '100', '判罚申诉', '110', '判罚依据咨询', '112', '', '司机询问判罚的具体依据与规则条款。', '判我违规的依据是什么', '', ''],
      ]),
      skill: csv(['标准类型', '名称', '内容（Skill 说明：适用场景/动作/输出要求/边界）', '状态'], [
        ['Skill 定义', '奖励到账核查', '适用场景：司机询问奖励未到账。动作：按司机ID查奖励批次与审核状态。输出要求：说明当前批次/状态、到账时效规则、明细查看入口、超期申诉入口。边界：不承诺具体到账日期。', '已生效'],
      ]),
      skill_scene: csv(['标准类型', '名称', '内容（映射依据）', '状态'], [
        ['Skill-场景映射', '奖励到账核查 → 奖励到账查询', '该 Skill 的输出正好覆盖「奖励到账查询」场景检查清单的全部检查项。', '已生效'],
      ]),
      sessions: csv(['会话内容', '来源类型', '系统意图ID', '意图名称', '场景ID', '场景名称', 'AI建议回复', '执行结果', '会话时间'], [
        ['司机：上周的保底奖励还没有到账\n客服：我帮您核实一下', 'text', 'INT_1007', '奖励到账咨询', 'SC_2003', '奖励到账查询', '已查到您的奖励在10月第2批，审核中，按规则3个工作日内到账', '', '2026-10-10 14:30'],
        ['司机：奖励金额少了30元', 'text', 'INT_1008', '奖励金额异常', 'SC_2004', '奖励金额核查', '因为您上周有2单取消率超标，按规则扣减了对应奖励，您可在规则页查看明细', '', '2026-10-10 15:02'],
      ]),
      batch: csv(['会话内容', '来源类型', '系统意图ID', '意图名称', '场景ID', '场景名称', 'AI建议回复', '执行结果', '会话时间'], [
        ['司机：奖励还没到账\n客服：帮您核实', 'text', '', '奖励到账咨询', '', '奖励到账查询', '已查到您的奖励在审核中，3个工作日内到账，可在账单明细查看', '', ''],
      ]),
    };
    const text = map[kind] || map.batch;
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="template_' + kind + '.csv"' });
    res.end(text);
  },

  // ---------- 标准批量导入（扁平行：标准模板行 / 意图库宽表行） ----------
  'POST /api/standards/import': async (req, res) => {
    const body = await readBody(req);
    const r = M.importRows(storage, Array.isArray(body.rows) ? body.rows : [], { note: body.note, operator: body.operator || storage.getSetting('operator', '') });
    if (r.error) return send(res, 400, { error: r.error });
    send(res, 200, {
      added: r.added, updated: r.updated, skipped: r.skipped, skipped_list: r.skipped_list,
      total: storage.list('standards').length, versions: r.versions,
    });
  },

  // ---------- 材料统一导入（意图库树形 JSON / 扁平行） ----------
  // 兼容两种提交方式：① body 直接就是树形 JSON 或行数组；② 包装体 {data: ..., format: ...}
  'POST /api/materials/import': async (req, res) => {
    const body = await readBody(req);
    const operator = body.operator || storage.getSetting('operator', '') || '';
    let data = body.data !== undefined ? body.data : body;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { return send(res, 400, { error: '内容不是合法 JSON：' + e.message }); }
    }
    const isTree = data && !Array.isArray(data) && Array.isArray(data.intents);
    let r;
    if (body.format === 'intent_tree' || (body.format === 'auto' && isTree) || (!body.format && isTree)) {
      r = M.importIntentTree(storage, data, { note: body.note || '导入意图库（树形 JSON）', operator });
    } else if (Array.isArray(data)) {
      r = M.importRows(storage, data, { note: body.note || '导入材料（扁平行）', operator });
    } else {
      return send(res, 400, { error: '无法识别的内容格式：支持 ① {"intents":[...]} 意图库树形 JSON；② 标准/意图宽表行数组' });
    }
    if (r.error) return send(res, 400, { error: r.error });
    r.total = storage.list('standards').length;
    send(res, 200, r);
  },

  // ---------- 材料数据集与版本管理 ----------
  'GET /api/datasets': async (req, res) => {
    send(res, 200, { datasets: M.datasetSummary(storage) });
  },

  'GET /api/material-versions': async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const key = u.searchParams.get('dataset') || '';
    if (key && !M.datasetByKey(key)) return send(res, 400, { error: '未知数据集：' + key });
    const out = key
      ? M.getVersions(storage, key)
      : M.DATASETS.map((d) => ({ dataset: d.key, name: d.name, versions: M.getVersions(storage, d.key) }));
    send(res, 200, key ? { versions: out } : { by_dataset: out });
  },

  'GET /api/material-versions/:id': async (req, res, params) => {
    const v = M.getVersionDetail(storage, params.id);
    if (!v) return send(res, 404, { error: '版本不存在' });
    send(res, 200, { version: v });
  },

  'POST /api/material-versions/:id/rollback': async (req, res, params) => {
    const body = await readBody(req).catch(() => ({}));
    const r = M.rollback(storage, params.id, { operator: body.operator || storage.getSetting('operator', '') });
    if (r.error) return send(res, 400, { error: r.error });
    send(res, 200, r);
  },

  // ---------- 评估助手配置（提示词 / 路由规则 / 能力清单 / 技能知识库 / 展示） ----------
  'GET /api/agent-config': async (req, res) => {
    send(res, 200, { config: getAgentConfig(storage) });
  },

  'PUT /api/agent-config': async (req, res) => {
    const body = await readBody(req);
    const cfg = body.config || body;
    const cur = ensureAgentConfig(storage);
    // 合并语义：未提交的字段保持原值（防止只改展示文案把提示词/能力/知识库清空）；显式提交空串/空数组才算清空
    const pres = cfg.presentation || {};
    const next = {
      system_prompt: cfg.system_prompt !== undefined ? String(cfg.system_prompt).slice(0, 8000) : cur.system_prompt,
      rules: Array.isArray(cfg.rules) ? cfg.rules.map((r) => ({ key: String(r.key || ''), name: String(r.name || ''), trigger: String(r.trigger || ''), desc: String(r.desc || ''), enabled: r.enabled !== false })).filter((r) => r.key) : cur.rules,
      capabilities: Array.isArray(cfg.capabilities) ? cfg.capabilities.map((c) => ({ key: String(c.key || ''), name: String(c.name || ''), desc: String(c.desc || ''), enabled: c.enabled !== false })).filter((c) => c.name) : cur.capabilities,
      knowledge: Array.isArray(cfg.knowledge) ? cfg.knowledge.map((k) => ({ id: k.id || storage.id('kn'), title: String(k.title || '').slice(0, 120), content: String(k.content || '').slice(0, 8000), updated_at: new Date().toISOString() })).filter((k) => k.title || k.content) : cur.knowledge,
      presentation: {
        greeting: pres.greeting !== undefined ? String(pres.greeting).slice(0, 200) : cur.presentation.greeting,
        welcome_sub: pres.welcome_sub !== undefined ? String(pres.welcome_sub).slice(0, 500) : cur.presentation.welcome_sub,
        help: pres.help !== undefined ? String(pres.help).slice(0, 4000) : cur.presentation.help,
      },
    };
    storage.update('agent_configs', 'default', next);
    send(res, 200, { config: getAgentConfig(storage) });
  },

  // ---------- 同口径复验（标准更新后重跑同一样本） ----------
  'POST /api/sessions/:id/recheck': async (req, res, params) => {
    const src = storage.byId('sessions', params.id);
    if (!src) return send(res, 404, { error: '会话不存在' });
    const stored = await detectAndStore({
      session_text: src.raw_text, source_type: src.source_type,
      intent_id: src.intent_id, intent_name: src.intent_name,
      scene_id: src.scene_id, scene_name: src.scene_name,
      ai_reply: src.ai_reply, exec_result: src.exec_result,
      operator: (storage.getSetting('operator', '') || '') + '（复验）',
    }, null);
    if (stored.status !== 'done') return send(res, 200, { status: 'need_input', questions: stored.questions });
    storage.update('sessions', stored.session_id, { run_kind: 'recheck', recheck_of: src.id, count_in_stats: false });
    // 对比
    const origDets = storage.list('detections').filter((d) => d.session_id === src.id).map((d) => ({ demand: d.demand_description, level: d.overall_level }));
    const newDets = storage.list('detections').filter((d) => d.session_id === stored.session_id).map((d) => ({ demand: d.demand_description, level: d.overall_level }));
    const changes = [];
    for (let i = 0; i < Math.max(origDets.length, newDets.length); i++) {
      const a = origDets[i] || {}, b = newDets[i] || {};
      if (a.level !== b.level) changes.push({ demand: b.demand || a.demand, from: a.level || '—', to: b.level || '—' });
    }
    send(res, 200, { status: 'done', recheck_session_id: stored.session_id, original: origDets, recheck: newDets, changes });
  },

  'GET /api/export': async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const type = u.searchParams.get('type') || 'sessions';
    let rows = [];
    if (type === 'sessions') {
      rows = storage.list('sessions').map((s) => {
        const dets = storage.list('detections').filter((d) => d.session_id === s.id);
        return {
          会话ID: s.id, 来源: s.source_type, 时间: s.created_at,
          系统意图: (s.intent_name || s.intent_id || '（缺失）'), 命中场景: (s.scene_name || s.scene_id || '（缺失）'),
          诉求数: dets.length, 等级: dets.map((d) => d.overall_level).join('/'),
          缺失字段: (s.missing_fields || []).join('/'), 会话摘要: (s.raw_text || '').slice(0, 80),
        };
      });
    } else if (type === 'detections') {
      rows = storage.list('detections').map((d) => {
        const r = JSON.parse(d.result_json);
        return {
          检测ID: d.id, 会话ID: d.session_id, 诉求: d.demand_description, 主诉求: d.demand_is_primary ? '是' : '否',
          问题类型: d.demand_type, 整体等级: d.overall_level, 意图结论: d.intent_conclusion, 场景结论: d.scene_conclusion,
          判级依据: r.solution_eval.level_reason, 规则引用: (r.solution_eval.level_rule_refs || []).join(','),
          检测模式: d.mode,
        };
      });
    } else if (type === 'reviews') {
      rows = storage.list('reviews').map((r) => {
        const s = storage.byId('sessions', r.session_id);
        const d = storage.byId('detections', r.detection_id);
        return {
          复核ID: r.id, 会话ID: r.session_id, 诉求: d ? d.demand_description : '', 原判定: d ? d.overall_level : '',
          状态: r.status, 复核人: r.reviewer, 人工结论: r.human_level, 修正原因: r.fix_reason, 更新时间: r.updated_at || r.created_at,
        };
      });
    } else if (type === 'materials') {
      const agent = createAgent({ storage, computeStats, getLlmConfig });
      const mat = agent.materialsReadiness();
      rows = mat.items.map((i) => ({ 材料: i.name, 当前: i.current, 目标: i.target, 状态: i.ready ? '已就绪' : '待提供', 为什么需要: i.why, 提供格式: i.format }));
    }
    if (u.searchParams.get('format') === 'csv') {
      const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const headers = rows.length ? Object.keys(rows[0]) : ['空'];
      const text = '\ufeff' + headers.map(q).join(',') + '\n' + rows.map((r) => headers.map((h) => q(r[h])).join(',')).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="export_' + type + '.csv"' });
      return res.end(text);
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="export_' + type + '.json"' });
    res.end(JSON.stringify(rows, null, 2));
  },
};

function parseRoute(method, url) {
  const pathname = url.split('?')[0];
  for (const key of Object.keys(routes)) {
    const [m, p] = key.split(' ');
    if (m !== method) continue;
    if (!p.includes(':')) { if (p === pathname) return { handler: routes[key], params: {} }; continue; }
    const pp = p.split('/');
    const up = pathname.split('/');
    if (pp.length !== up.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(up[i]);
      else if (pp[i] !== up[i]) { ok = false; break; }
    }
    if (ok) return { handler: routes[key], params };
  }
  return null;
}

const monitor = createMonitoring({storage,getLlmConfig:selection=>modelConfigs.resolve(selection),modelGenerate:generateMonitoringPlan,modelReplay:replayServiceSkill});
const sceneRegistry = require('./scenes').createScenes({storage});
const evaluatorSkill = require('./evaluator-skill').createEvaluatorSkill({storage});
let monitorLearning;
const modelCallLimiter = require('./model-call-limit').createCallLimiter(2);
const issueTaxonomy = require('./issue-taxonomy').createIssueTaxonomy({storage});
const issueClassification = require('./issue-classification').createIssueClassification({storage,taxonomy:issueTaxonomy});
const issueClassificationAI = require('./issue-classification-ai').createIssueClassificationAI({storage,taxonomy:issueTaxonomy,classification:issueClassification,getLlmConfig:selection=>modelConfigs.resolve(selection),limiter:modelCallLimiter});
const skillDiagnosis = require('./skill-diagnosis').createSkillDiagnosis({storage,getLlmConfig:selection=>modelConfigs.resolve(selection),limiter:modelCallLimiter});
const serviceSkillLinks = require('./service-skill-links').createServiceSkillLinks({storage});
const serviceSkills = require('./service-skills').createServiceSkills({storage,monitor});
const batchSkillDiagnosis = require('./batch-skill-diagnosis').createBatchSkillDiagnosis({storage,diagnosis:skillDiagnosis,links:serviceSkillLinks,getLlmConfig:selection=>modelConfigs.resolve(selection),limiter:modelCallLimiter});
const diagnosisService = id => storage.byId('service_skill_batch_diagnoses',id)?batchSkillDiagnosis:skillDiagnosis;
const recordAttention = require('./record-attention').createRecordAttention({storage});
const batchRating = require('./batch-rating').createBatchRating({storage,limiter:modelCallLimiter,onCompleted:()=>monitorLearning?.collect(),evaluatorSkill,monitor,scenes:sceneRegistry,getLlmConfig:selection=>modelConfigs.resolve(selection)});
monitorLearning = require('./monitor-learning').createMonitorLearning({storage,monitor,scenes:sceneRegistry,startTrial:body=>batchRating.startPlanTrial(body)});
const workspaceAgent = require('./workspace-agent').createWorkspaceAgent({storage,modelConfigs,getBatchRoutingReview:id=>batchRating.routingReview(id)});
function evaluatorExecutionRows(){const all=storage.list('monitor_ratings'),seen=new Set();return [...all.filter(r=>r.status==='running'),...all.slice(-100).reverse()].filter(r=>{if(seen.has(r.id))return false;seen.add(r.id);return true;}).slice(0,100);}
function evaluatorPublicState(){const {VERSION,SYSTEM,OUTPUT_CONTRACT,PROMPT_HASH}=require('./llm-rating');return {...evaluatorSkill.bootstrap(),executions:evaluatorExecutionRows().map(r=>({id:r.id,name:r.record_snapshot?.name||r.request_snapshot?.record?.name||r.id,status:r.status,error:r.error,created_at:r.created_at,started_at:r.started_at,finished_at:r.finished_at,model:r.model_snapshot?.model,evaluator_version:r.evaluator_skill_snapshot?.version,evaluation_flow:r.evaluation_flow,step_runs:r.step_runs,usage:r.usage,cost_estimate:r.cost_estimate,elapsed_ms:r.elapsed_ms})),system_protocol:{version:VERSION,system_prompt:SYSTEM,output_contract:OUTPUT_CONTRACT,prompt_hash:PROMPT_HASH}};}
const monitorRoutes = {
  'GET /api/monitor/issue-taxonomy': async () => issueTaxonomy.bootstrap(),
  'POST /api/monitor/issue-taxonomy/revisions': async body => ({revision:issueTaxonomy.save(body)}),
  'POST /api/monitor/issue-taxonomy/revisions/:id/activate': async (body,p) => ({revision:issueTaxonomy.activate(p.id,body)}),
  'GET /api/monitor/issues/classification-history': async (body,p,req) => {const q=new URL(req.url,'http://localhost').searchParams;return {assignments:issueClassification.history().filter(a=>a.rating_id===q.get('rating_id')&&a.finding_index===Number(q.get('finding_index')))};},
  'GET /api/monitor/issues': async (body,p,req) => ({issues:issueClassification.list(Object.fromEntries(new URL(req.url,'http://localhost').searchParams))}),
  'POST /api/monitor/issues/classification-preview': async body => issueClassification.preview(body),
  'POST /api/monitor/issues/classifications': async body => ({change:issueClassification.apply(body)}),
  'POST /api/monitor/issue-classification-ai/preview': async body => issueClassificationAI.preview(body),
  'POST /api/monitor/issue-classification-ai/runs': async body => ({run:issueClassificationAI.start(body)}),
  'GET /api/monitor/issue-classification-ai/runs/:id': async (body,p) => ({run:issueClassificationAI.get(p.id)}),
  'PATCH /api/monitor/issue-classification-suggestions/:id': async (body,p) => ({suggestion:issueClassificationAI.edit(p.id,body)}),
  'POST /api/monitor/issue-classification-suggestions/:id/preview': async (body,p) => issueClassificationAI.applicationPreview(p.id),
  'POST /api/monitor/issue-classification-suggestions/:id/apply': async (body,p) => ({suggestion:issueClassificationAI.apply(p.id,body)}),
  'POST /api/monitor/ratings/:id/diagnoses/preview': async (body,p) => skillDiagnosis.preview(p.id,body),
  'POST /api/monitor/ratings/:id/diagnoses': async (body,p) => ({diagnosis:skillDiagnosis.start(p.id,body)}),
  'POST /api/monitor/service-skill-links': async body => serviceSkillLinks.bind(body),
  'POST /api/monitor/batch-skill-diagnoses/preview': async body => batchSkillDiagnosis.preview(body),
  'POST /api/monitor/batch-skill-diagnoses': async body => ({diagnosis:batchSkillDiagnosis.start(body)}),
  'POST /api/monitor/skill-diagnoses/status': async body => {
    if(!Array.isArray(body.ids)||!body.ids.length||body.ids.length>100||body.ids.some(id=>typeof id!=='string')||new Set(body.ids).size!==body.ids.length)throw Object.assign(Error('请选择1至100个不重复的诊断任务'),{statusCode:400});
    return {diagnoses:body.ids.map(id=>{const {request_snapshot,request_messages,raw_response,system_prompt,output_contract,...state}=diagnosisService(id).get(id);return {...state,can_reparse:state.status==='failed'&&!!raw_response&&!!state.error?.startsWith('模型诊断结果无效：')};})};
  },
  'GET /api/monitor/skill-diagnoses/:id': async (body,p) => ({diagnosis:diagnosisService(p.id).get(p.id)}),
  'POST /api/monitor/skill-diagnoses/:id/reparse': async (body,p) => ({diagnosis:diagnosisService(p.id).reparse(p.id,body)}),
  'POST /api/monitor/skill-diagnoses/:id/tasks': async (body,p) => ({task:diagnosisService(p.id).createTask(p.id,body)}),
  'POST /api/monitor/learning/collect': async () => {monitorLearning.collect();return monitorLearning.bootstrap();},
  'POST /api/monitor/learning/drafts': async body => ({draft:monitorLearning.draft(body)}),
  'PATCH /api/monitor/learning/drafts/:id': async (body,p) => ({draft:monitorLearning.saveDraft(p.id,body)}),
  'POST /api/monitor/learning/drafts/:id/trial': async (body,p) => ({trial:monitorLearning.trial(p.id,body)}),
  'POST /api/monitor/learning/drafts/:id/activate': async (body,p) => ({draft:monitorLearning.activate(p.id,body)}),
  'GET /api/monitor/evaluator-skill': async () => evaluatorPublicState(),
  'POST /api/monitor/evaluator-skill/revisions': async body => ({revision:evaluatorSkill.save(body)}),
  'POST /api/monitor/evaluator-skill/revisions/:id/activate': async (body,p) => ({revision:evaluatorSkill.activate(p.id,body)}),
  'POST /api/monitor/evaluator-skill/trials': async body => ({trial:batchRating.startEvaluatorTrial(body)}),
  'GET /api/monitor/evaluator-skill/trials/:id': async (body,p) => ({trial:batchRating.getEvaluatorTrial(p.id)}),
  'GET /api/monitor/conversations': async () => ({conversations:workspaceAgent.list()}),
  'POST /api/monitor/conversations': async body => ({conversation:workspaceAgent.create(body)}),
  'GET /api/monitor/conversations/:id': async (body,p) => ({conversation:workspaceAgent.read(p.id)}),
  'POST /api/monitor/conversations/:id/messages': async (body,p) => ({conversation:await workspaceAgent.send(p.id,body)}),
  'POST /api/monitor/conversations/:id/batches': async (body,p) => ({conversation:workspaceAgent.attachBatch(p.id,body)}),
  'GET /api/monitor': async (body,p,req) => ({record_views:recordAttention.views(req.user.id),...monitor.bootstrap(),services:serviceSkills.list(),...batchRating.bootstrap(),...sceneRegistry.bootstrap(),model_config:modelConfigs.state(),model_configured:modelConfigs.state().configured,rating_reviews:storage.list('monitor_rating_reviews'),evaluator_skill:evaluatorPublicState(),monitor_learning:monitorLearning.bootstrap(),skill_improvement_version:'customer-skill-improvement/v2',skill_diagnoses:[...storage.list('service_skill_diagnoses'),...storage.list('service_skill_batch_diagnoses')].sort((a,b)=>a.created_at.localeCompare(b.created_at)),service_skill_links:serviceSkillLinks.bootstrap(),issue_taxonomy:issueTaxonomy.bootstrap(),issue_classifications:issueClassification.list(),issue_classification_ai_runs:issueClassificationAI.list()}),
  'POST /api/monitor/ratings/:id/review': async (body,p) => {const review=workspaceAgent.reviewRating(p.id,body);try{monitorLearning.collect();return {review};}catch{return {review,learning_error:'复核已保存，检查建议暂未整理，可稍后重试'};}},
  'POST /api/monitor/ratings/:id/tasks': async (body,p) => ({task:workspaceAgent.createRatingTask(p.id,body)}),
  'PATCH /api/monitor/rating-tasks/:id': async (body,p) => ({task:workspaceAgent.updateRatingTask(p.id,body)}),
  'GET /api/monitor/models': async () => modelConfigs.state(),
  'POST /api/monitor/models': async body => ({profile:modelConfigs.save(body)}),
  'PATCH /api/monitor/models/:id': async (body,p) => ({profile:modelConfigs.save(body,p.id)}),
  'DELETE /api/monitor/models/:id': async (body,p) => modelConfigs.remove(p.id,body),
  'POST /api/monitor/model-default': async body => modelConfigs.setDefault(body),
  'POST /api/monitor/model-test': async body => modelConfigs.test(body),
  'POST /api/monitor/models/:id/discover': async (body,p) => modelConfigs.discover(p.id),
  'POST /api/monitor/plans': async body => ({revision:monitor.savePlan(sceneRegistry.attach(body))}),
  'PATCH /api/monitor/plans/:id': async (body,p) => ({revision:monitor.savePlan(sceneRegistry.attach(body),p.id)}),
  'POST /api/monitor/plans/:id/confirm': async (body,p) => ({revision:monitor.confirm(p.id,body)}),
  'POST /api/monitor/plans/:id/generate': async (body,p) => ({candidate:await monitor.generate(p.id,body)}),
  'POST /api/monitor/candidates/:id/approve': async (body,p) => ({candidate:monitor.approve(p.id,body)}),
  'POST /api/monitor/cases': async body => {const batch=batchRating.importBatch({name:'手工登记 · '+body.name,source_kind:'manual',source_name:'页面登记',request_id:body.request_id||require('crypto').randomUUID(),actor:body.actor,scene_id:body.scene_id,scope:body.scope,candidate_id:body.candidate_id,records:[body]});const item=storage.list('monitor_batch_items').find(i=>i.batch_id===batch.id);if(!item?.case_id){const error=Error(item?.error||'材料导入失败');error.statusCode=400;throw error;}return {batch,sample:storage.byId('monitor_cases',item.case_id)};},
  'POST /api/monitor/scenes': async body => ({scene:sceneRegistry.save(body)}),
  'PATCH /api/monitor/scenes/:id': async (body,p) => ({scene:sceneRegistry.save(body,p.id)}),
  'POST /api/monitor/scenes/:id/map': async (body,p) => sceneRegistry.mapLegacy(p.id,body),
  'POST /api/monitor/examples': async body => ({example:sceneRegistry.example(body)}),
  'POST /api/monitor/batches/preview': async body => batchRating.preview(body),
  'POST /api/monitor/batch-items/:id/view': async (body,p,req) => ({view:recordAttention.viewed(p.id,body,req.user)}),
  'POST /api/monitor/batch-items/:id/attention/cancel': async (body,p,req) => recordAttention.cancel(p.id,body,req.user),
  'POST /api/monitor/batch-items/:id/attention': async (body,p,req) => recordAttention.mark(p.id,body,req.user),
  'PATCH /api/monitor/attention-tasks/:id': async (body,p,req) => recordAttention.updateTask(p.id,body,req.user),
  'PATCH /api/monitor/batch-items/:id/attention': async (body,p,req) => ({item:recordAttention.saveMarks(p.id,body,req.user)}),
  'PATCH /api/monitor/batch-items/:id/mark': async (body,p,req) => ({item:batchRating.markItem(p.id,{...body,actor:req.user.name})}),
  'POST /api/monitor/batch-items/:id/resolve': async (body,p) => ({routing:batchRating.resolveItem(p.id,body)}),
  'POST /api/monitor/batches': async body => ({batch:batchRating.importBatch(body)}),
  'GET /api/monitor/batches/:id/routing': async (body,p) => batchRating.routingReview(p.id),
  'POST /api/monitor/batches/:id/routing/refresh': async (body,p) => batchRating.refreshRouting(p.id,body),
  'POST /api/monitor/batches/:id/routing/group': async (body,p) => batchRating.resolveGroup(p.id,body),
  'POST /api/monitor/batches/:id/routing/confirm': async (body,p) => ({confirmation:batchRating.confirmRouting(p.id,body)}),
  'GET /api/monitor/rating-runs/:id': async (body,p) => ({run:batchRating.getRatingRun(p.id)}),
  'POST /api/monitor/batches/:id/rate': async (body,p) => ({run:batchRating.evaluate(p.id,body)}),
  'POST /api/monitor/services': async body => ({service:serviceSkills.create(sceneRegistry.attach(body))}),
  'PATCH /api/monitor/services/:id': async (body,p) => ({service:serviceSkills.edit(p.id,body)}),
  'POST /api/monitor/services/:id/activate': async (body,p) => ({service:serviceSkills.activate(p.id,body)}),
  'DELETE /api/monitor/services/:id': async (body,p) => serviceSkills.remove(p.id,body),
  'POST /api/monitor/evaluate': async body => ({run:monitor.evaluate(body)}),
  'POST /api/monitor/compare': async body => ({run:monitor.compare(body)}),
  'POST /api/monitor/replay': async body => ({run:await monitor.replay(body)}),
  'POST /api/monitor/tasks': async body => ({task:monitor.task(body)}),
  'PATCH /api/monitor/tasks/:id': async (body,p) => ({task:monitor.updateTask(p.id,body)}),
};
for(const [route,handler] of Object.entries(monitorRoutes))routes[route]=async (req,res,params)=>{
  const body=req.method==='GET'?{}:await readBody(req);
  const definitionWrite=route.startsWith('POST /api/monitor/issue-taxonomy/')||route.startsWith('PATCH /api/monitor/issue-classification-suggestions/')&&body.decision!=='reject';
  const applyingDefinition=route.endsWith('/apply')&&route.includes('issue-classification-suggestions')&&['new','update'].includes(storage.byId('issue_classification_suggestions',params.id)?.action);
  if((definitionWrite||applyingDefinition)&&!req.user?.is_admin)throw Object.assign(Error('仅管理员可维护和发布问题分类定义'),{statusCode:403});
  send(res,200,await handler(body,params,req));
};

const server = http.createServer(async (req, res) => {
  try {
    if (await access.gate(req, res)) return;
    const route = parseRoute(req.method, req.url);
    if (route) return await route.handler(req, res, route.params);
    if(req.url.split('?')[0].startsWith('/api/'))return send(res,404,{error:'接口不存在：'+req.method+' '+req.url.split('?')[0]+'，请确认服务已更新。'});
    // 静态文件
    let fp = req.url.split('?')[0];
    if (fp === '/') fp = '/workbench.html';
    if (fp === '/legacy') fp = '/index.html';
    if (fp === '/login') fp = '/login.html';
    if (fp === '/account') fp = '/account.html';
    if (fp === '/accounts') fp = '/accounts.html';
    const abs = path.normalize(path.join(PUBLIC, fp));
    if (!abs.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    send(res, e.statusCode || 500, { error: e.message, ...(e.code ? { code: e.code } : {}) });
  }
});

function lanAddresses() {
  const os = require('os');
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  return out;
}

const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log('解决力评估应用已启动（' + (HOST === '127.0.0.1' ? '本机模式' : '指定网络模式') + '）:');
  console.log('  本机:  http://localhost:' + PORT);
  if (HOST === '0.0.0.0') for (const ni of lanAddresses()) console.log('  局域网: http://' + ni.address + ':' + PORT + '   [' + ni.name + ']');
  console.log('引擎模式: ' + ((getLlmConfig().base_url && getLlmConfig().api_key && getLlmConfig().model) ? 'llm' : 'rule（未配置大模型，规则引擎模式）'));
});
