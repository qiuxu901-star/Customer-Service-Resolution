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
const { createAgent } = require('./agent');

const PORT = Number(process.env.PORT || 8817);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const storage = new Storage(path.join(DATA_DIR, 'db.json'));
seedStandards(storage);

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
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('JSON 解析失败')); }
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
    send(res, 200, { standard: s });
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
    send(res, 200, { standard: storage.update('standards', s.id, patch) });
  },

  'DELETE /api/standards/:id': async (req, res, params) => {
    storage.remove('standards', params.id);
    send(res, 200, { ok: true });
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

  // ---------- 标准批量导入 ----------
  'POST /api/standards/import': async (req, res) => {
    const body = await readBody(req);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return send(res, 400, { error: '导入内容为空' });
    const existing = new Set(storage.list('standards').map((s) => s.type + '|' + s.name));
    let added = 0; const skipped = [];
    for (const r of rows) {
      const type = String(r['标准类型'] || r.type || '').trim();
      const name = String(r['名称'] || r.name || '').trim();
      const content = String(r['内容（定义：含什么/排除什么/边界）'] || r['内容（适用条件/排除条件）'] || r['内容（映射依据）'] || r['内容（逐条检查项）'] || r['内容（案例原文 + 为什么好/坏）'] || r.content || '').trim();
      const status = String(r['状态'] || r.status || '草稿').trim();
      if (!type || !name) { skipped.push(name || '(无名)'); continue; }
      if (existing.has(type + '|' + name)) { skipped.push(name); continue; }
      storage.insert('standards', { type, name, content, version: 1, status: ['草稿', '待确认', '已生效'].includes(status) ? status : '草稿', source: '导入', effective_at: status === '已生效' ? new Date().toISOString() : null });
      existing.add(type + '|' + name);
      added++;
    }
    send(res, 200, { added, skipped, total: storage.list('standards').length });
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

const server = http.createServer(async (req, res) => {
  try {
    const route = parseRoute(req.method, req.url);
    if (route) return await route.handler(req, res, route.params);
    // 静态文件
    let fp = req.url.split('?')[0];
    if (fp === '/') fp = '/index.html';
    const abs = path.normalize(path.join(PUBLIC, fp));
    if (!abs.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    send(res, 500, { error: e.message });
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

server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log('解决力评估应用已启动（局域网共享模式）:');
  console.log('  本机:  http://localhost:' + PORT);
  for (const ni of lanAddresses()) console.log('  局域网: http://' + ni.address + ':' + PORT + '   [' + ni.name + ']');
  console.log('引擎模式: ' + ((getLlmConfig().base_url && getLlmConfig().api_key && getLlmConfig().model) ? 'llm' : 'rule（未配置大模型，规则引擎模式）'));
});
