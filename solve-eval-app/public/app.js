'use strict';

/* ============ 工具 ============ */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status));
  return data;
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function openModal(html) {
  $('modalBox').innerHTML = html;
  $('modalMask').classList.remove('hidden');
}
function closeModal() { $('modalMask').classList.add('hidden'); }
$('modalMask').addEventListener('click', (e) => { if (e.target === $('modalMask')) closeModal(); });

const LEVEL_LABEL = { L3: 'L3 完整方案', L2: 'L2 有效辅助', L1: 'L1 仅信息相关', L0: 'L0 错误或不可用', U: 'U 无法判断' };
const lvTag = (lv) => '<span class="lv lv-' + esc(lv) + '">' + esc(lv) + '</span>';
const LEVEL_COLOR = { L3: '#2E7D5B', L2: '#3A6EA5', L1: '#B8862B', L0: '#B34A44', U: '#8A8378' };
const WORK_LABEL = { query: '信息查询', analysis: '原因分析', decision: '方案判断', communication: '沟通组织', execution: '业务执行' };
const WORK_VALUE_LABEL = { ai_done: 'AI 已完成', manual: '人工仍需完成', not_needed: '本次不需要', u: '无法判断' };
const REVIEW_STATUSES = ['待复核', '复核中', '已复核', '争议待裁决', '标准待完善', '已裁决'];

const state = {
  view: 'agent',
  inputMode: 'single',
  lastDetect: null,      // {session_id, report}
  pendingQuestions: null, // need_input 时的问题列表
  reviewStatus: '全部',
  reviewPriority: '全部',
  selectedReview: null,
  batchResults: null,
  recordFilters: { level: '', intent: '', scene: '', review: '' },
  allSessions: null,
  chatHistory: [],
  corrStatus: '全部',
  matDataset: 'intents',
  agentCfgTab: 'prompt',
  agentCfg: null,
};

/* ============ 视图切换 ============ */

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.view = btn.dataset.view;
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $('view-' + state.view).classList.add('active');
    if (state.view === 'review') loadReviews();
    if (state.view === 'board') loadBoard();
    if (state.view === 'records') loadRecords();
    if (state.view === 'standards') loadStandards();
    if (state.view === 'materials') loadMaterials();
    if (state.view === 'corrections') loadCorrections();
    if (state.view === 'agent-config') loadAgentConfig();
    if (state.view === 'agent') renderChat();
  });
});

/* ============ 检测台：单条 ============ */

$('btnDemo').addEventListener('click', () => {
  $('f_session').value = '司机：上周的保底奖励还没有到账，而且显示的金额少了 30 元\n客服：我帮您核实一下\n司机：这都多久了，能不能快点';
  $('f_intent_id').value = 'INT_1007';
  $('f_intent_name').value = '奖励到账咨询';
  $('f_scene_id').value = 'SC_2003';
  $('f_scene_name').value = '奖励到账咨询';
  $('f_ai_reply').value = '奖励一般在三个工作日内到账，以司机端账单明细为准，请您耐心等待。';
  $('f_exec').value = '';
  toast('已填入示例会话（对应 V2.1 附录 B 多诉求示例）');
});

function readSingleForm() {
  return {
    session_text: $('f_session').value,
    source_type: $('f_source').value,
    intent_id: $('f_intent_id').value.trim(),
    intent_name: $('f_intent_name').value.trim(),
    scene_id: $('f_scene_id').value.trim(),
    scene_name: $('f_scene_name').value.trim(),
    ai_reply: $('f_ai_reply').value.trim(),
    exec_result: $('f_exec').value.trim(),
    operator: '',
  };
}

function renderQuestions(questions, prevInput) {
  const box = $('questionBox');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="report-title" style="margin-bottom:4px">开始检测前，需要先确认几件事</div>' +
    '<div class="field-hint" style="margin-bottom:14px">R1-R2：缺失会记入材料缺失清单、不补造；补齐后即可复检，也可以选择「标记为缺失」按现状检测。</div>' +
    questions.map((q, i) =>
      '<div class="question-item">' +
      '<div class="question-title">' + (i + 1) + '. ' + esc(q.label || q.field) + '</div>' +
      '<div class="question-ask">' + esc(q.ask) + '</div>' +
      '<div class="field-row"><input class="input q-input" data-field="' + esc(q.field) + '" placeholder="补充内容…">' +
      (q.canMarkNA ? '<button class="btn btn-sm btn-ghost q-na" data-field="' + esc(q.field) + '">标记为缺失 / 不适用</button>' : '') + '</div>' +
      '</div>'
    ).join('') +
    '<div class="form-actions"><button class="btn btn-primary" id="btnRecheck">补齐后重新检测</button></div>';

  box.querySelectorAll('.q-na').forEach((b) => b.addEventListener('click', () => {
    const field = b.dataset.field;
    const input = box.querySelector('.q-input[data-field="' + field + '"]');
    input.value = '__NA__';
    input.setAttribute('data-na', '1');
    b.textContent = '已标记为缺失 ✓';
    b.disabled = true;
  }));
  $('btnRecheck').addEventListener('click', () => {
    const supplements = {};
    box.querySelectorAll('.q-input').forEach((inp) => {
      const v = inp.value.trim();
      if (v) supplements[inp.dataset.field] = v;
    });
    runDetect(Object.assign({}, prevInput, { supplements }));
  });
}

async function runDetect(input) {
  const btn = $('btnDetect');
  btn.disabled = true;
  btn.textContent = '检测中…';
  try {
    const r = await api('POST', '/api/detect', input);
    if (r.status === 'need_input') {
      state.pendingQuestions = r.questions;
      renderQuestions(r.questions, input);
      $('reportBox').innerHTML = '';
      toast('材料不足，引擎发起 ' + r.questions.length + ' 个追问');
    } else {
      $('questionBox').classList.add('hidden');
      state.pendingQuestions = null;
      state.lastDetect = { session_id: r.session_id, report: r.report, mode: r.mode };
      renderReport(r);
      refreshBadge();
      toast('检测完成，结果已落入复核台（待复核）');
    }
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '开始检测';
  }
}

$('btnDetect').addEventListener('click', () => {
  const input = readSingleForm();
  if (!input.session_text.trim()) return toast('请先粘贴会话内容');
  runDetect(input);
});

/* ---- 报告渲染（结论 → 依据 → 不确定性 三段式） ---- */

function dimLevelTag(level) {
  const map = { pass: ['tag-pass', '达标'], fail: ['tag-fail', '错误'], weak: ['tag-weak', '偏弱'], u: ['tag-u', '无法判断'] };
  const m = map[level] || ['tag-u', level];
  return '<span class="tag ' + m[0] + '">' + m[1] + '</span>';
}

function renderReport(r) {
  const rep = r.report;
  const summaryCls = rep.session_summary === '检测通过' ? 'sum-pass' : rep.session_summary === '存在已确认问题' ? 'sum-error' : 'sum-u';
  let html = '<div class="pane"><div class="report-head">' +
    '<div class="report-title">检测报告</div>' +
    '<span class="report-summary-tag ' + summaryCls + '">会话级：' + esc(rep.session_summary) + '</span>' +
    '<span class="report-mode">模式：' + (rep.mode === 'llm' ? '大模型' : '规则引擎') + ' · 会话 ID：' + esc(r.session_id) + '</span></div>';

  if (rep.disclaimer) html += '<div class="disclaimer">' + esc(rep.disclaimer) + '</div>';

  // 诉求卡片
  rep.demands.forEach((d, idx) => {
    const s = d.solution_eval;
    html += '<div class="demand-card"><div class="demand-head">' +
      '<span class="tag tag-accent">' + (d.demand.is_primary ? '主诉求' : '次诉求') + (d.demand.primary_pending ? ' · 主次待确认' : '') + '</span>' +
      '<span class="demand-title">' + (idx + 1) + '. ' + esc(d.demand.description) + '</span>' +
      lvTag(s.overall_level) +
      '<span class="tag">' + esc(d.demand.demand_type || '业务查询类') + '</span>' +
      '<span class="tag ' + (d.demand_summary === '链路通过' ? 'tag-pass' : d.demand_summary === '整体无法判断' ? 'tag-u' : 'tag-fail') + '">' + esc(d.demand_summary || '') + '</span>' +
      '</div><div class="demand-body">';

    html += '<div class="section-sub">诉求还原（依据）</div>';
    html += '<div class="eval-row"><div class="eval-key">证据原文</div><div class="eval-val eval-evidence">' + esc(d.demand.evidence || d.demand.source_msg || '') + '</div></div>';

    // 意图检测
    html += '<div class="section-sub">意图检测</div>';
    const ie = d.intent_eval;
    const ieTag = ie.conclusion === 'correct' ? '<span class="tag tag-pass">正确</span>' : ie.conclusion === 'wrong' ? '<span class="tag tag-fail">错误</span>' : ie.conclusion === 'u' ? '<span class="tag tag-u">无法判断</span>' : '<span class="tag">' + esc(ie.conclusion) + '</span>';
    html += '<div class="eval-row"><div class="eval-key">结论</div><div class="eval-val">' + ieTag + (ie.error_type ? ' <span class="tag">' + esc(ie.error_type) + '</span>' : '') + '<div class="eval-reason">' + esc(ie.reason || '') + '</div>' + (ie.u ? '<div class="eval-reason">无法判断：' + esc(ie.u.code + ' ' + (ie.u.item || '') + '，缺「' + (ie.u.missing || '') + '」，需' + esc(ie.u.owner || '') + '补齐</div>') : '') + '</div></div>';

    // 场景检测
    html += '<div class="section-sub">场景检测</div>';
    const se = d.scene_eval;
    const seTag = se.conclusion === 'correct' ? '<span class="tag tag-pass">正确</span>' : se.conclusion === 'wrong' ? '<span class="tag tag-fail">错误</span>' : '<span class="tag tag-u">无法判断</span>';
    html += '<div class="eval-row"><div class="eval-key">结论</div><div class="eval-val">' + seTag +
      '<div class="eval-reason">' + esc(se.reason || '') + '</div>' +
      (se.independent !== undefined ? '<div class="eval-reason">独立场景正确性：' + esc(se.independent) + ' · 条件场景正确性：' + esc(se.conditional) + '</div>' : '') +
      (se.u ? '<div class="eval-reason">无法判断：' + esc(se.u.code + ' ' + (se.u.item || '') + '，缺「' + (se.u.missing || '') + '」</div>') : '') +
      '</div></div>';

    // 七维度
    html += '<div class="section-sub">方案质量 · 七维度检测</div>';
    html += '<table class="dims-table"><tr><th style="width:110px">维度</th><th style="width:76px">结论</th><th>说明</th></tr>';
    const dimNames = { fact: '事实充分性', cause: '原因分析', judgment: '业务判断', plan: '处理方案', executability: '可执行性', communication: '沟通交付', risk: '风险控制' };
    const dimKeys = { fact: '关键', cause: '关键', judgment: '关键', plan: '关键', executability: '关键', communication: '支撑', risk: '一票否决' };
    for (const k of Object.keys(dimNames)) {
      const dim = (s.dimensions || {})[k];
      if (!dim) continue;
      html += '<tr><td class="dim-name">' + dimNames[k] + '<span class="dim-key">' + dimKeys[k] + ' · ' + esc(dim.rule || '') + '</span></td><td>' + dimLevelTag(dim.level) + '</td><td>' + esc(dim.note || '') + '</td></tr>';
    }
    html += '</table>';
    html += '<div class="eval-row"><div class="eval-key">判级</div><div class="eval-val">' + lvTag(s.overall_level) + ' <span class="tag">' + esc(LEVEL_LABEL[s.overall_level] || '') + '</span><div class="eval-reason">' + esc(s.level_reason || '') + '</div>' +
      ((s.level_rule_refs || []).length ? '<div style="margin-top:4px">' + s.level_rule_refs.map((rr) => '<span class="tag tag-rule">' + esc(rr) + '</span>').join('') + '</div>' : '') + '</div></div>';

    // 关键错误
    if ((s.key_errors || []).length) {
      html += '<div class="section-sub">已确认错误</div>';
      for (const e of s.key_errors) html += '<div class="eval-row"><div class="eval-key">' + esc(e.dim) + '</div><div class="eval-val"><span class="tag tag-fail">' + esc(e.rule) + '</span> ' + esc(e.detail) + '</div></div>';
    }

    // 剩余工作矩阵
    html += '<div class="section-sub">人工剩余工作</div><div class="work-matrix">';
    for (const k of Object.keys(WORK_LABEL)) {
      const v = (d.residual_work || {})[k] || 'u';
      html += '<div class="work-cell"><div class="w-name">' + WORK_LABEL[k] + '</div><div class="w-val w-' + esc(v) + '">' + esc(WORK_VALUE_LABEL[v] || v) + '</div></div>';
    }
    html += '</div>';

    // 归因
    html += '<div class="section-sub">问题归因</div>';
    const a = d.attribution || {};
    const issues = a.direct_issues || [];
    html += '<div class="eval-row"><div class="eval-key">直接问题</div><div class="eval-val">' + (issues.length ? issues.map((i) => '<span class="tag tag-fail">' + esc(i.type) + '</span><span class="eval-reason">' + esc(i.detail || '') + '</span>').join('<br>') : '<span class="tag tag-pass">未发现已确认缺陷</span>') + '</div></div>';
    if (a.root_cause) html += '<div class="eval-row"><div class="eval-key">根因</div><div class="eval-val"><span class="tag ' + (a.root_cause.confidence === 'confirmed' ? 'tag-pass' : 'tag-weak') + '">' + (a.root_cause.confidence === 'confirmed' ? '已确认' : '可能') + '</span> ' + esc(a.root_cause.text) + '</div></div>';
    if ((a.cascade || []).length) html += '<div class="eval-row"><div class="eval-key">连锁影响</div><div class="eval-val">' + a.cascade.map((c) => esc(c)).join('<br>') + '</div></div>';

    // 不确定性
    const uReasons = (s.u_reasons || []).concat(ie.u ? [ie.u] : [], se.u ? [se.u] : []);
    html += '<div class="section-sub">不确定性与待补齐</div>';
    if (uReasons.length) {
      html += '<table class="dims-table"><tr><th style="width:60px">代码</th><th style="width:110px">检测项</th><th>缺少依据</th><th style="width:110px">待补齐方</th></tr>' +
        uReasons.filter((u) => u && u.code).map((u) => '<tr><td>' + esc(u.code) + '</td><td>' + esc(u.item) + '</td><td>' + esc(u.missing) + '</td><td>' + esc(u.owner) + '</td></tr>').join('') + '</table>';
    } else {
      html += '<div class="eval-reason">无未决项：本报告所有检测维度均有依据或明确结论。</div>';
    }
    html += '</div></div>';
  });

  // 结果信号（只记录不评价）
  if ((rep.result_signals || []).length) {
    html += '<div class="section-sub">会话结果信号（只记录不评价 · B7）</div>';
    for (const sig of rep.result_signals) html += '<div class="eval-row"><div class="eval-key">' + esc(sig.type) + '</div><div class="eval-val eval-evidence">' + esc(sig.evidence) + '</div></div>';
  }

  // 规则引用
  if ((rep.rule_refs || []).length) {
    html += '<div class="section-sub">规则引用（结论可复核）</div><div>' + rep.rule_refs.map((rr) => '<span class="tag tag-rule">' + esc(rr) + '</span>').join(' ') + '</div>';
  }

  html += '<div class="form-actions"><span class="form-note">报告已同步写入复核台与全盘记录；原检测结论不会被引擎重跑或人工操作覆盖。</span></div></div>';
  $('reportBox').innerHTML = html;
}

/* ============ 检测台：批量 ============ */

document.querySelectorAll('#inputMode .seg-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#inputMode .seg-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  state.inputMode = b.dataset.mode;
  $('singlePane').classList.toggle('hidden', state.inputMode !== 'single');
  $('batchPane').classList.toggle('hidden', state.inputMode !== 'batch');
  $('questionBox').classList.add('hidden');
}));

function parseBatchInput(text) {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith('[') || t.startsWith('{')) return JSON.parse(t);
  // 简易 CSV：表头 + 数据行
  const lines = t.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].match(/("([^"]|"")*"|[^,]*)(,|$)/g);
    const vals = [];
    let cur = '';
    let inQ = false;
    for (const ch of lines[i]) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    vals.push(cur.trim());
    const row = {};
    headers.forEach((h, j) => { row[h] = (vals[j] || '').replace(/^"|"$/g, ''); });
    rows.push(row);
  }
  return rows;
}

$('btnBatch').addEventListener('click', async () => {
  let rows = null;
  try { rows = parseBatchInput($('f_batch').value); } catch (e) { return toast('解析失败：' + e.message); }
  if (!rows || !rows.length) return toast('请粘贴 JSON 数组或 CSV 数据');
  const btn = $('btnBatch');
  btn.disabled = true;
  btn.textContent = '检测中…';
  try {
    const r = await api('POST', '/api/batch', { name: '批次 ' + new Date().toLocaleString('zh-CN', { hour12: false }), rows });
    state.batchResults = r;
    const s = r.summary;
    $('batchNote').textContent = '共 ' + s.total + ' 条：完成 ' + s.ok + ' · 待追问 ' + s.needInput + ' · 失败 ' + s.failed;
    $('batchResults').innerHTML = '<div class="batch-summary">批次 ' + esc(r.batch_id) + ' 已创建。逐条实时检测完成，结果全部落入复核台「待复核」。</div>' +
      r.results.map((x) => '<div class="batch-row"><span style="color:var(--text-3);width:36px">#' + x.index + '</span>' +
        (x.status === 'done' ? '<span class="lv lv-L3" style="min-width:44px">完成</span>' : x.status === 'need_input' ? '<span class="lv lv-U">待追问</span>' : '<span class="lv lv-L0">失败</span>') +
        '<span>' + (x.status === 'done' ? '会话 ' + esc(x.session_id) : x.status === 'need_input' ? (x.questions || []).map((q) => esc(q.label || q.field)).join('、') + ' 待补充' : esc(x.error || '')) + '</span>' +
        (x.status === 'need_input' ? '<button class="btn btn-sm btn-ghost batch-goto" data-idx="' + x.index + '">去单条处理</button>' : '') +
        '</div>').join('');
    document.querySelectorAll('.batch-goto').forEach((b) => b.addEventListener('click', () => {
      document.querySelector('#inputMode .seg-btn[data-mode="single"]').click();
      toast('请将该条会话粘贴到单条检测，按追问补齐');
    }));
    refreshBadge();
    toast('批量检测完成');
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '导入并检测';
  }
});

/* ============ 复核台 ============ */

async function refreshBadge() {
  try {
    const [rv, boot] = await Promise.all([
      api('GET', '/api/reviews?status=待复核'),
      api('GET', '/api/bootstrap'),
    ]);
    $('reviewBadge').textContent = rv.reviews.length || '';
    const pendingMat = (boot.materials || {}).items ? boot.materials.items.filter((i) => !i.ready).length : 0;
    $('matBadge').textContent = pendingMat || '';
    $('engineChip').textContent = '引擎：' + (boot.engine_mode === 'llm' ? '大模型模式' : '规则模式');
    $('engineChip').classList.toggle('llm', boot.engine_mode === 'llm');
    $('operatorChip').textContent = '操作人：' + (boot.settings.operator || '未设置');
  } catch (e) { /* ignore */ }
}

function renderReviewSeg() {
  const counts = state.reviewCounts || {};
  $('reviewStatusSeg').innerHTML = ['全部'].concat(REVIEW_STATUSES).map((s) =>
    '<button class="seg-btn ' + (state.reviewStatus === s ? 'active' : '') + '" data-status="' + s + '">' + s + (counts[s] != null ? ' ' + counts[s] : '') + '</button>'
  ).join('');
  document.querySelectorAll('#reviewStatusSeg .seg-btn').forEach((b) => b.addEventListener('click', () => {
    state.reviewStatus = b.dataset.status;
    loadReviews();
  }));
  const prios = [['全部', '全部优先级'], ['high', '优先（U/L0）'], ['spotcheck', 'L3 抽检'], ['normal', '常规']];
  $('reviewPrioritySeg').innerHTML = prios.map(([v, l]) =>
    '<button class="seg-btn ' + (state.reviewPriority === v ? 'active' : '') + '" data-prio="' + v + '">' + l + '</button>'
  ).join('');
  document.querySelectorAll('#reviewPrioritySeg .seg-btn').forEach((b) => b.addEventListener('click', () => {
    state.reviewPriority = b.dataset.prio;
    loadReviews();
  }));
}

async function loadReviews() {
  renderReviewSeg();
  const [all, cur] = await Promise.all([
    api('GET', '/api/reviews'),
    api('GET', '/api/reviews' + (state.reviewStatus !== '全部' ? '?status=' + encodeURIComponent(state.reviewStatus) : '')),
  ]);
  state.reviewCounts = { '全部': all.reviews.length };
  for (const r of all.reviews) state.reviewCounts[r.status] = (state.reviewCounts[r.status] || 0) + 1;
  renderReviewSeg();
  const list = $('reviewList');
  let items = cur.reviews;
  if (state.reviewPriority !== '全部') items = items.filter((r) => r.priority === state.reviewPriority);
  if (!items.length) {
    list.innerHTML = '<div class="empty">该状态下暂无复核任务</div>';
    return;
  }
  list.innerHTML = items.map((r) =>
    '<div class="review-item ' + (state.selectedReview === r.review_id ? 'selected' : '') + '" data-id="' + r.review_id + '">' +
    lvTag(r.overall_level) +
    '<div class="ri-main"><div class="ri-demand">' + esc(r.demand_description) + '</div>' +
    '<div class="ri-meta"><span>' + esc(r.intent_name) + '</span><span>·</span><span>' + esc(r.scene_name) + '</span><span>·</span><span>' + esc(r.status) + '</span>' +
    (r.priority === 'high' ? '<span class="ri-flag ri-high">优先</span>' : '') +
    (r.needs_spotcheck ? '<span class="ri-flag ri-spot">L3 抽检</span>' : '') +
    '</div></div></div>'
  ).join('');
  list.querySelectorAll('.review-item').forEach((el) => el.addEventListener('click', () => {
    state.selectedReview = el.dataset.id;
    loadReviews();
    openReviewDetail(el.dataset.id);
  }));
}

async function openReviewDetail(id) {
  const d = await api('GET', '/api/reviews/' + id);
  const r = d.review;
  const det = d.detection || {};
  const rep = det.result || {};
  const s = d.session || {};
  let html = '<div class="review-actions" style="margin-top:0;padding-top:0;border:none;justify-content:space-between;align-items:center">' +
    '<div style="display:flex;gap:8px;align-items:center">' + lvTag(det.overall_level) + '<span class="tag">' + esc(r.status) + '</span>' +
    (r.priority === 'high' ? '<span class="ri-flag ri-high">优先复核</span>' : '') + (r.needs_spotcheck ? '<span class="ri-flag ri-spot">L3 随机抽检</span>' : '') + '</div>' +
    '<span style="font-size:11.5px;color:var(--text-3)">复核人：' + esc(r.reviewer || '未署名') + '</span></div>';

  html += '<div class="section-sub">原始会话（依据）</div><div class="eval-evidence" style="white-space:pre-wrap;background:#FBFAF6;border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-size:12.5px;max-height:180px;overflow-y:auto">' + esc(s.raw_text || '') + '</div>';

  html += '<div class="section-sub">诉求</div><div class="eval-row"><div class="eval-key">描述</div><div class="eval-val">' + esc(det.demand_description) + ' ' + (det.demand_is_primary ? '<span class="tag tag-accent">主诉求</span>' : '<span class="tag">次诉求</span>') + '</div></div>';
  if (rep.demand && rep.demand.evidence) html += '<div class="eval-row"><div class="eval-key">证据原文</div><div class="eval-val eval-evidence">' + esc(rep.demand.evidence) + '</div></div>';

  html += '<div class="section-sub">系统结果</div>' +
    '<div class="eval-row"><div class="eval-key">意图</div><div class="eval-val">' + esc(s.intent_name || s.intent_id || '（缺失）') + ' <span class="tag">' + esc((rep.intent_eval || {}).conclusion || '') + '</span><div class="eval-reason">' + esc((rep.intent_eval || {}).reason || '') + '</div></div></div>' +
    '<div class="eval-row"><div class="eval-key">场景</div><div class="eval-val">' + esc(s.scene_name || s.scene_id || '（缺失）') + ' <span class="tag">' + esc((rep.scene_eval || {}).conclusion || '') + '</span><div class="eval-reason">' + esc((rep.scene_eval || {}).reason || '') + '</div></div></div>' +
    '<div class="eval-row"><div class="eval-key">AI 建议</div><div class="eval-val eval-evidence">' + esc(s.ai_reply || '（缺失）') + '</div></div>';

  const sv = rep.solution_eval || {};
  html += '<div class="section-sub">检测结论</div>' +
    '<div class="eval-row"><div class="eval-key">整体等级</div><div class="eval-val">' + lvTag(sv.overall_level) + ' <span class="tag">' + esc(LEVEL_LABEL[sv.overall_level] || '') + '</span><div class="eval-reason">' + esc(sv.level_reason || '') + '</div>' + ((sv.level_rule_refs || []).map((x) => ' <span class="tag tag-rule">' + esc(x) + '</span>').join('')) + '</div></div>';

  if ((sv.u_reasons || []).length) {
    html += '<div class="eval-row"><div class="eval-key">无法判断</div><div class="eval-val">' + sv.u_reasons.map((u) => '<span class="tag tag-u">' + esc(u.code) + '</span> ' + esc(u.item) + '：缺「' + esc(u.missing) + '」，需' + esc(u.owner) + '补齐').join('<br>') + '</div></div>';
  }

  html += '<div class="section-sub">人工剩余工作</div><div class="work-matrix">';
  for (const k of Object.keys(WORK_LABEL)) {
    const v = ((rep.residual_work || {})[k]) || 'u';
    html += '<div class="work-cell"><div class="w-name">' + WORK_LABEL[k] + '</div><div class="w-val w-' + esc(v) + '">' + esc(WORK_VALUE_LABEL[v] || v) + '</div></div>';
  }
  html += '</div>';

  if ((rep.attribution || {}).direct_issues || (rep.attribution || {}).root_cause) {
    const a = rep.attribution;
    html += '<div class="section-sub">归因</div><div class="eval-row"><div class="eval-key">直接问题</div><div class="eval-val">' + ((a.direct_issues || []).map((i) => '<span class="tag tag-fail">' + esc(i.type) + '</span> ' + esc(i.detail || '')).join('<br>') || '<span class="tag tag-pass">未发现已确认缺陷</span>') + '</div></div>';
    if (a.root_cause) html += '<div class="eval-row"><div class="eval-key">根因</div><div class="eval-val"><span class="tag ' + (a.root_cause.confidence === 'confirmed' ? 'tag-pass' : 'tag-weak') + '">' + (a.root_cause.confidence === 'confirmed' ? '已确认' : '可能') + '</span> ' + esc(a.root_cause.text) + '</div></div>';
  }

  if ((r.history_json || '[]') !== '[]' && JSON.parse(r.history_json || '[]').length) {
    html += '<div class="section-sub">复核留痕</div>';
    for (const h of JSON.parse(r.history_json)) {
      html += '<div class="eval-row"><div class="eval-key">' + esc(h.at.slice(0, 16).replace('T', ' ')) + '</div><div class="eval-val"><span class="tag tag-accent">' + esc(h.action) + '</span> ' + esc(h.by || '') + (h.payload && h.payload.reason ? ' · ' + esc(h.payload.reason) : '') + '</div></div>';
    }
  }

  html += '<div class="review-actions">' +
    '<button class="btn btn-sm" data-act="start">开始复核</button>' +
    '<button class="btn btn-sm btn-primary" data-act="confirm">确认通过</button>' +
    '<button class="btn btn-sm" data-act="fix">驳回并修正</button>' +
    '<button class="btn btn-sm" data-act="evidence">补充证据</button>' +
    '<button class="btn btn-sm" data-act="mark_u">标记无法判断</button>' +
    '<button class="btn btn-sm" data-act="submit_standard">提交标准事项</button>' +
    '<button class="btn btn-sm" data-act="dispute">标记争议</button>' +
    (r.status === '争议待裁决' ? '<button class="btn btn-sm" data-act="arbitrate">业务裁决</button>' : '') +
    '<button class="btn btn-sm btn-ghost" data-act="correction">派生纠正任务</button>' +
    '</div>';

  $('reviewDetail').innerHTML = html;
  $('reviewDetail').querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => reviewAction(id, b.dataset.act, d)));
}

/* 操作人：多人共用时按浏览器独立标识，回退到全局设置 */
function myOperator() {
  const mine = window.CsrAuth?.user?.name || (localStorage.getItem('se_operator') || '').trim();
  if (mine) return mine;
  const chip = $('operatorChip').textContent.replace('操作人：', '').trim();
  return chip && chip !== '未设置' ? chip : '';
}

/* 统一提交复核动作：失败（含被他人抢先处理的 409）时提示并刷新，不再静默 */
async function submitReview(id, body) {
  try {
    await api('POST', '/api/reviews/' + id + '/action', Object.assign({ operator: myOperator() }, body));
    return true;
  } catch (e) {
    toast(e.message || '提交失败，请重试');
    if (state.view === 'review') loadReviews();
    return false;
  }
}

async function reviewAction(id, act, ctx) {
  const operator = myOperator();
  if (act === 'start') {
    if (!await submitReview(id, { action: 'start', operator })) return;
  } else if (act === 'confirm') {
    if (!await submitReview(id, { action: 'confirm', operator, payload: { level: ctx.detection.overall_level } })) return;
    toast('已确认通过，原检测结论保留，人工结论独立留痕');
  } else if (act === 'fix') {
    openModal('<h3>驳回并修正</h3>' +
      '<div class="field-label">修正后等级</div><select id="m_level" class="input">' + Object.keys(LEVEL_LABEL).map((k) => '<option value="' + k + '" ' + (k === ctx.detection.overall_level ? 'selected' : '') + '>' + LEVEL_LABEL[k] + '</option>').join('') + '</select>' +
      '<div class="field-label" style="margin-top:10px">修正原因与依据（必填）</div><textarea id="m_reason" class="ta ta-tall" placeholder="原判定为什么错？依据是什么（会话证据/标准条目）？"></textarea>' +
      '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" id="m_ok">提交修正</button></div>');
    $('m_ok').addEventListener('click', async () => {
      const reason = $('m_reason').value.trim();
      if (!reason) return toast('修正原因必填：人工结论必须带依据');
      if (!await submitReview(id, { action: 'fix', operator, payload: { level: $('m_level').value, reason } })) return;
      closeModal(); toast('已提交修正，原结论保留在留痕中'); openReviewDetail(id); loadReviews(); refreshBadge();
    });
    return;
  } else if (act === 'evidence') {
    openModal('<h3>补充证据</h3><div class="field-label">补充的证据或标准依据</div><textarea id="m_ev" class="ta ta-tall" placeholder="如：会话第 3 轮司机原话、某标准条目内容"></textarea><div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" id="m_ev_ok">提交</button></div>');
    $('m_ev_ok').addEventListener('click', async () => {
      const text = $('m_ev').value.trim();
      if (!text) return toast('请输入补充证据');
      if (!await submitReview(id, { action: 'evidence', operator, payload: { text } })) return;
      closeModal(); toast('证据已补充，状态回到复核中'); openReviewDetail(id);
    });
    return;
  } else if (act === 'mark_u') {
    openModal('<h3>标记无法判断</h3><div class="field-label">原因（缺什么依据、需要谁补齐）</div><textarea id="m_u" class="ta" placeholder="如：缺少该司机的订单数据，需数据提供方补齐"></textarea><div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" id="m_u_ok">标记</button></div>');
    $('m_u_ok').addEventListener('click', async () => {
      const reason = $('m_u').value.trim();
      if (!reason) return toast('请填写原因');
      if (!await submitReview(id, { action: 'mark_u', operator, payload: { reason } })) return;
      closeModal(); toast('已标记无法判断（U 是治理输入，不是失败）'); openReviewDetail(id); loadReviews(); refreshBadge();
    });
    return;
  } else if (act === 'submit_standard') {
    const sv = (ctx.detection.result || {}).solution_eval || {};
    const uReasons = (sv.u_reasons || []).concat((((ctx.detection.result || {}).intent_eval || {}).u) || []).concat((((ctx.detection.result || {}).scene_eval || {}).u) || []);
    openModal('<h3>提交标准事项</h3>' +
      '<div class="field-label">事项类型</div><select id="s_type" class="input"><option value="缺失">标准缺失</option><option value="冲突">标准冲突</option></select>' +
      '<div class="field-label" style="margin-top:10px">原因代码</div><select id="s_code" class="input">' + (uReasons.length ? uReasons.filter((u) => u && u.code).map((u) => '<option value="' + esc(u.code) + '">' + esc(u.code + ' ' + (u.item || '')) + '</option>').join('') : '<option value="U01">U01 意图标准缺失</option><option value="U02">U02 场景标准缺失</option><option value="U04">U04 回复业务规则缺失</option><option value="U05">U05 标准冲突</option>') + '</select>' +
      '<div class="field-label" style="margin-top:10px">事项描述</div><textarea id="s_desc" class="ta" placeholder="缺什么标准、影响哪些判断、需要谁确认"></textarea>' +
      '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" id="s_ok">提交</button></div>');
    $('s_ok').addEventListener('click', async () => {
      const desc = $('s_desc').value.trim();
      if (!desc) return toast('请填写事项描述');
      if (!await submitReview(id, { action: 'submit_standard', operator, payload: { type: $('s_type').value, reason_code: $('s_code').value, description: desc } })) return;
      closeModal(); toast('已提交标准事项，样本转入「标准待完善」'); openReviewDetail(id); loadReviews(); refreshBadge();
    });
    return;
  } else if (act === 'dispute') {
    openModal('<h3>标记争议</h3><div class="field-label">争议点</div><textarea id="d_r" class="ta" placeholder="标注人员意见不一致的点 / 标准相互冲突的描述"></textarea><div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" id="d_ok">标记</button></div>');
    $('d_ok').addEventListener('click', async () => {
      const reason = $('d_r').value.trim();
      if (!reason) return toast('请填写争议点');
      if (!await submitReview(id, { action: 'dispute', operator, payload: { reason } })) return;
      closeModal(); toast('已转入「争议待裁决」，等业务规则负责人裁决'); openReviewDetail(id); loadReviews(); refreshBadge();
    });
    return;
  } else if (act === 'arbitrate') {
    openModal('<h3>业务裁决</h3><div class="field-label">裁决结论等级</div><select id="a_level" class="input">' + Object.keys(LEVEL_LABEL).map((k) => '<option value="' + k + '">' + LEVEL_LABEL[k] + '</option>').join('') + '</select><div class="field-label" style="margin-top:10px">裁决依据</div><textarea id="a_r" class="ta" placeholder="裁决所依据的标准条目与证据；若标准仍缺失，应保留无法判断，不得投票式定对错"></textarea><div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" id="a_ok">裁决</button></div>');
    $('a_ok').addEventListener('click', async () => {
      const reason = $('a_r').value.trim();
      if (!reason) return toast('裁决依据必填');
      if (!await submitReview(id, { action: 'arbitrate', operator, payload: { level: $('a_level').value, reason } })) return;
      closeModal(); toast('已裁决'); openReviewDetail(id); loadReviews(); refreshBadge();
    });
    return;
  } else if (act === 'correction') {
    const sv = (ctx.detection.result || {}).solution_eval || {};
    const a = (ctx.detection.result || {}).attribution || {};
    openModal('<h3>派生纠正任务</h3>' +
      '<div class="field-label">问题对象</div><input id="c_target" class="input" value="' + esc(ctx.detection.demand_description || '') + '">' +
      '<div class="field-label" style="margin-top:10px">当前等级 / 期望等级</div><div class="field-row"><input id="c_cur" class="input" value="' + esc(sv.overall_level || '') + '" placeholder="当前"><input id="c_exp" class="input" value="L3" placeholder="期望"></div>' +
      '<div class="field-label" style="margin-top:10px">改进建议</div><textarea id="c_sug" class="ta" placeholder="需要补充哪项知识、标准、数据或业务能力"></textarea>' +
      '<div class="field-label" style="margin-top:10px">修正类型</div><select id="c_fix" class="input"><option value="原 AI 能力修正">原 AI 能力修正</option><option value="评价标准修正">评价标准修正</option></select>' +
      '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" id="c_ok">创建任务</button></div>');
    $('c_ok').addEventListener('click', async () => {
      const suggestion = $('c_sug').value.trim();
      if (!suggestion) return toast('请填写改进建议');
      await api('POST', '/api/corrections', {
        session_id: ctx.session.id, detection_id: ctx.detection.id,
        target: $('c_target').value, description: '由复核台派生：' + (sv.level_reason || ''),
        current_level: $('c_cur').value, expected_level: $('c_exp').value,
        attribution: JSON.stringify(a), suggestion, fix_type: $('c_fix').value,
      });
      closeModal(); toast('纠正任务已创建（待纠正）');
    });
    return;
  }
  openReviewDetail(id); loadReviews(); refreshBadge();
}

/* ============ 数据看板 ============ */

function hbar(label, value, max, color, suffix) {
  const w = max ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return '<div class="bar-row"><span>' + esc(label) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + w + '%;background:' + color + '"></div></div><span class="bar-num">' + value + (suffix || '') + '</span></div>';
}

async function loadBoard() {
  const s = await api('GET', '/api/stats');
  const o = s.overview;
  const kpi = (label, val, foot, nullish, drill) =>
    '<div class="kpi' + (drill ? ' kpi-click' : '') + '" ' + (drill ? 'data-drill="' + drill + '"' : '') + '><div class="kpi-label">' + label + (drill ? ' <span style="color:var(--text-3)">▾</span>' : '') + '</div><div class="kpi-value' + (nullish ? ' null' : '') + '">' + (val == null ? '暂无数据' : val) + '</div><div class="kpi-foot">' + foot + '</div></div>';

  let html = '<div class="kpi-row">' +
    kpi('完整方案可交付率（L3）', o.l3_delivery_rate == null ? null : o.l3_delivery_rate + '%', '分子 ' + o.level_count.L3 + ' · 分母（可评价）' + o.evaluable, o.l3_delivery_rate == null, JSON.stringify({ level: 'L3' })) +
    kpi('有效辅助覆盖率（L2+L3）', o.effective_assist_rate == null ? null : o.effective_assist_rate + '%', '分子 ' + (o.level_count.L2 + o.level_count.L3) + ' · 分母（可评价）' + o.evaluable, o.effective_assist_rate == null, '') +
    kpi('无法判断率（U）', o.u_rate == null ? null : o.u_rate + '%', '分子 ' + o.level_count.U + ' · 分母（应检测）' + o.demand_count, o.u_rate == null, JSON.stringify({ level: 'U' })) +
    kpi('全量 L3 覆盖率', o.full_l3_coverage == null ? null : o.full_l3_coverage + '%', '分子 ' + o.level_count.L3 + ' · 分母（应检测）' + o.demand_count, o.full_l3_coverage == null, JSON.stringify({ level: 'L3' })) +
    '</div>';

  // 第一层：能力总览
  const maxLv = Math.max(1, o.level_count.L3, o.level_count.L2, o.level_count.L1, o.level_count.L0, o.level_count.U);
  html += '<div class="board-section"><h3>第一层 · AI 解决能力总览</h3><div class="bs-desc">以「完整处理方案」为最终标准的能力等级分布；U 与能力指标并列披露，防止把「可评价率低」包装成「准确率高」。</div>';
  html += hbar('L3 完整方案可交付', o.level_count.L3, maxLv, LEVEL_COLOR.L3) +
    hbar('L2 有效辅助', o.level_count.L2, maxLv, LEVEL_COLOR.L2) +
    hbar('L1 仅信息相关', o.level_count.L1, maxLv, LEVEL_COLOR.L1) +
    hbar('L0 错误或不可用', o.level_count.L0, maxLv, LEVEL_COLOR.L0) +
    hbar('U 无法判断', o.level_count.U, maxLv, LEVEL_COLOR.U);
  html += '<table class="metric-table" style="margin-top:12px"><tr><th>指标</th><th>口径</th><th style="text-align:right">值</th></tr>' +
    [['仅相关不足率', 'L1 / 可评价', o.l1_rate], ['错误或不可用率', 'L0 / 可评价', o.l0_rate], ['可评价覆盖率', '可评价 / 应检测', o.evaluable_rate]].map((m) =>
      '<tr><td>' + m[0] + '</td><td>' + m[1] + '</td><td style="text-align:right"><span class="metric-num' + (m[2] == null ? ' null' : '') + '">' + (m[2] == null ? '—' : m[2] + '%') + '</span></td></tr>').join('') + '</table>';
  if (o.level_count.U > 0) html += '<div class="u-warn">当前有 ' + o.level_count.U + ' 个诉求无法判断。U 是治理输入而非失败：请按原因代码补齐标准或证据后复评。</div>';
  html += '</div>';

  // 第二层：链路质量
  const lq = s.link_quality;
  html += '<div class="board-section"><h3>第二层 · AI 决策链路质量</h3><div class="bs-desc">过程指标用于解释 L3 率为什么高或低，不得平均后充当 L3 结论。</div><table class="metric-table"><tr><th>指标</th><th>口径</th><th style="text-align:right">值</th></tr>' +
    '<tr><td>主意图准确率</td><td>正确主意图 ' + lq.intent_evaluable + ' 条可评价</td><td style="text-align:right"><span class="metric-num' + (lq.intent_accuracy == null ? ' null' : '') + '">' + (lq.intent_accuracy == null ? '—' : lq.intent_accuracy + '%') + '</span></td></tr>' +
    '<tr><td>场景匹配准确率</td><td>正确场景 ' + lq.scene_evaluable + ' 条可评价</td><td style="text-align:right"><span class="metric-num' + (lq.scene_accuracy == null ? ' null' : '') + '">' + (lq.scene_accuracy == null ? '—' : lq.scene_accuracy + '%') + '</span></td></tr>' +
    '</table></div>';

  // 下钻：按意图 / 按场景
  const groupTable = (title, desc, by, drillKey) => {
    const rows = Object.entries(by).sort((a, b) => b[1].total - a[1].total);
    if (!rows.length) return '';
    let t = '<div class="board-section"><h3>' + title + '</h3><div class="bs-desc">' + desc + '</div><table class="metric-table"><tr><th>名称</th><th>样本</th><th>L3</th><th>L2</th><th>L1</th><th>L0</th><th>U</th><th style="text-align:right">L3 率</th></tr>' +
      rows.map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + v.total + '</td><td>' + v.L3 + '</td><td>' + v.L2 + '</td><td>' + v.L1 + '</td><td>' + v.L0 + '</td><td>' + v.U + '</td><td style="text-align:right"><span class="metric-num' + (v.l3_rate == null ? ' null' : '') + '">' + (v.l3_rate == null ? '—' : v.l3_rate + '%') + '</span></td></tr>').join('') + '</table></div>';
    return t;
  };
  html += groupTable('下钻 · 按意图', '每个意图的等级分布与完整方案率；点击名称可下钻到全盘记录。', s.by_intent || {}, 'intent');
  html += groupTable('下钻 · 按场景', '每个场景的等级分布与完整方案率。', s.by_scene || {}, 'scene');

  // 第三层：人工替代潜力
  html += '<div class="board-section"><h3>第三层 · 人工替代潜力</h3><div class="bs-desc">各工作环节中 AI 已完成占比。一期为能力评价（预计可替代工作环节），不等于实际节省工时。</div>';
  const workMax = Math.max(1, ...Object.values(s.work_stats).map((w) => w.total));
  for (const k of Object.keys(s.work_stats)) {
    const w = s.work_stats[k];
    const pct = w.total ? Math.round((w.ai_done / w.total) * 100) : null;
    html += '<div class="bar-row"><span>' + w.label + '</span><div class="bar-track"><div class="bar-fill" style="width:' + (pct || 0) + '%;background:' + LEVEL_COLOR.L3 + '"></div></div><span class="bar-num">' + (pct == null ? '—' : pct + '%') + '</span></div>' +
      '<div style="font-size:11px;color:var(--text-3);margin:-2px 0 6px 140px">AI 已完成 ' + w.ai_done + ' · 人工仍需 ' + w.manual + ' · 本次不需要 ' + w.not_needed + ' · 无法判断 ' + w.u + '</div>';
  }
  html += '</div>';

  // 第四层：归因分布
  const attrs = Object.entries(s.attribution).sort((a, b) => b[1] - a[1]);
  const attrMax = attrs.length ? attrs[0][1] : 1;
  html += '<div class="board-section"><h3>第四层 · 问题归因与优化机会</h3><div class="bs-desc">直接问题分布（去重前）。根因只统计「已确认」，可能根因与无法归因不计入。</div>';
  html += attrs.length ? attrs.map(([k, v]) => hbar(k, v, attrMax, LEVEL_COLOR.L0)).join('') : '<div class="eval-reason">暂未发现已确认问题。</div>';
  html += '</div>';

  // 第五层：纠正与复核进展
  const cs = s.correction_status;
  const rs = s.review_status;
  html += '<div class="board-section"><h3>第五层 · 复核与纠正进展</h3><div class="bs-desc">复核六态分布与纠正任务流转。纠正前后必须同样本、同口径对比。</div><table class="metric-table"><tr><th>对象</th><th>状态分布</th></tr>' +
    '<tr><td>人工复核</td><td>' + (Object.keys(rs).length ? Object.entries(rs).map(([k, v]) => '<span class="tag">' + esc(k) + ' ' + v + '</span>').join('') : '—') + '</td></tr>' +
    '<tr><td>纠正任务</td><td>' + (Object.keys(cs).length ? Object.entries(cs).map(([k, v]) => '<span class="tag tag-accent">' + esc(k) + ' ' + v + '</span>').join('') : '—') + '</td></tr>' +
    '</table></div>';

  // U 原因分布
  const us = Object.entries(s.u_reasons).sort((a, b) => b[1] - a[1]);
  if (us.length) {
    const uMax = us[0][1];
    html += '<div class="board-section"><h3>U 专区 · 无法判断原因分布</h3><div class="bs-desc">U01 意图标准缺失 / U02 场景标准缺失 / U03 关联规则缺失 / U04 回复业务规则缺失 / U05 标准冲突 / U06 对话证据不足 / U07 转写不明确 / U08 业务条件不足 / U09 检测对象信息缺失。同一缺失高频聚集时，优先补标准。</div>';
    html += us.map(([k, v]) => hbar(k, v, uMax, LEVEL_COLOR.U)).join('');
    html += '</div>';
  }

  $('boardBox').innerHTML = html;
  // 下钻：KPI → 全盘记录（按等级筛选）
  $('boardBox').querySelectorAll('[data-drill]').forEach((el) => el.addEventListener('click', () => {
    let f = {};
    try { f = JSON.parse(el.dataset.drill); } catch (e) { /* ignore */ }
    state.recordFilters = { level: f.level || '', intent: '', scene: '', review: '' };
    document.querySelector('.nav-item[data-view="records"]').click();
    $('recFilterLevel').value = f.level || '';
    toast('已按等级 ' + (f.level || '全部') + ' 筛选全盘记录');
  }));
  // 下钻：按意图/场景名称 → 全盘记录
  $('boardBox').querySelectorAll('.metric-table tr td:first-child').forEach((td) => {
    const name = td.textContent.trim();
    if (!name || name === '名称') return;
    td.style.cursor = 'pointer';
    td.title = '点击下钻到全盘记录';
    td.addEventListener('click', () => {
      const isIntent = !!Object.keys(s.by_intent || {})[name];
      state.recordFilters = { level: '', intent: isIntent ? name : '', scene: isIntent ? '' : name, review: '' };
      document.querySelector('.nav-item[data-view="records"]').click();
      $('recFilterIntent').value = isIntent ? name : '';
      $('recFilterScene').value = isIntent ? '' : name;
      toast('已下钻：' + name);
    });
  });
}

/* ============ 全盘记录 ============ */

let recordsTimer = null;
$('recordSearch').addEventListener('input', () => {
  clearTimeout(recordsTimer);
  recordsTimer = setTimeout(loadRecords, 300);
});
['recFilterLevel', 'recFilterIntent', 'recFilterScene', 'recFilterReview'].forEach((id) => {
  $(id).addEventListener('change', () => {
    state.recordFilters = {
      level: $('recFilterLevel').value,
      intent: $('recFilterIntent').value,
      scene: $('recFilterScene').value,
      review: $('recFilterReview').value,
    };
    loadRecords();
  });
});

async function loadRecords() {
  const q = $('recordSearch').value.trim();
  const r = await api('GET', '/api/sessions' + (q ? '?q=' + encodeURIComponent(q) : ''));
  let sessions = r.sessions;
  state.allSessions = sessions;
  // 填充意图/场景筛选选项
  const fill = (id, key) => {
    const sel = $(id);
    const cur = sel.value;
    const names = [...new Set(sessions.map((s) => s[key]).filter((x) => x && x !== '（缺失）'))].sort();
    sel.innerHTML = '<option value="">全部' + (id === 'recFilterIntent' ? '意图' : '场景') + '</option>' + names.map((n) => '<option>' + esc(n) + '</option>').join('');
    sel.value = names.includes(cur) ? cur : '';
  };
  fill('recFilterIntent', 'intent_name');
  fill('recFilterScene', 'scene_name');
  const f = state.recordFilters;
  sessions = sessions.filter((s) =>
    (!f.level || s.levels.includes(f.level)) &&
    (!f.intent || s.intent_name === f.intent) &&
    (!f.scene || s.scene_name === f.scene) &&
    (!f.review || s.review_statuses.includes(f.review)));
  const box = $('recordsBox');
  if (!sessions.length) {
    box.innerHTML = '<div class="empty">没有符合筛选条件的记录</div>';
    return;
  }
  box.innerHTML = '<table class="record-table"><tr><th>会话</th><th>来源</th><th>意图 / 场景</th><th>诉求与等级</th><th>缺失字段</th><th>复核状态</th><th>时间</th></tr>' +
    sessions.map((s) => '<tr>' +
      '<td><a class="rec-link" data-id="' + esc(s.id) + '">' + esc(s.id) + '</a><div style="font-size:11px;color:var(--text-3);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s.preview) + '</div></td>' +
      '<td>' + (s.source_type === 'asr' ? '语音转写' : '文本') + '</td>' +
      '<td>' + esc(s.intent_name) + '<br><span style="font-size:11px;color:var(--text-3)">' + esc(s.scene_name) + '</span></td>' +
      '<td>' + s.demand_count + ' 个诉求<br>' + s.levels.map((l) => lvTag(l)).join(' ') + '</td>' +
      '<td>' + (s.missing_fields.length ? s.missing_fields.map((m) => '<span class="missing-tag">' + esc(m) + '</span>').join('') : '<span style="color:var(--text-3)">无</span>') + '</td>' +
      '<td>' + s.review_statuses.map((x) => '<span class="tag">' + esc(x) + '</span>').join(' ') + '</td>' +
      '<td style="font-size:11px;color:var(--text-3)">' + esc(s.created_at.slice(0, 16).replace('T', ' ')) + '</td>' +
      '</tr>').join('') + '</table>' +
    '<div class="field-hint" style="margin-top:10px">共 ' + sessions.length + ' 条' + (Object.values(f).some(Boolean) ? '（已按筛选条件过滤）' : '') + '</div>';
  box.querySelectorAll('.rec-link').forEach((a) => a.addEventListener('click', () => openSessionDetail(a.dataset.id)));
}

async function openSessionDetail(id) {
  const d = await api('GET', '/api/sessions/' + id);
  const s = d.session;
  let html = '<h3>会话 ' + esc(s.id) + '</h3>' +
    '<div class="section-sub">原始会话</div><div style="white-space:pre-wrap;background:#FBFAF6;border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-size:12.5px;max-height:220px;overflow-y:auto">' + esc(s.raw_text) + '</div>' +
    '<div class="section-sub">检测结果</div>';
  for (const det of d.detections) {
    const r = det.result;
    html += '<div class="demand-card"><div class="demand-head"><span class="tag tag-accent">' + (det.result.demand && det.result.demand.is_primary ? '主诉求' : '次诉求') + '</span><span class="demand-title">' + esc(det.demand_description) + '</span>' + lvTag(det.overall_level) + '<span class="tag">' + (det.mode === 'llm' ? '大模型' : '规则引擎') + '</span></div>' +
      '<div class="demand-body"><div class="eval-row"><div class="eval-key">判级依据</div><div class="eval-val">' + esc((r.solution_eval || {}).level_reason || '') + '</div></div>' +
      '<div class="eval-row"><div class="eval-key">意图</div><div class="eval-val">' + esc((r.intent_eval || {}).reason || '') + '</div></div>' +
      '<div class="eval-row"><div class="eval-key">场景</div><div class="eval-val">' + esc((r.scene_eval || {}).reason || '') + '</div></div></div></div>';
  }
  html += '<div class="section-sub">复核记录</div>';
  for (const rv of d.reviews) {
    html += '<div class="eval-row"><div class="eval-key">' + esc(rv.status) + '</div><div class="eval-val"><span class="tag">' + esc(rv.human_level || '—') + '</span> ' + esc(rv.fix_reason || '') + ' <span style="color:var(--text-3);font-size:11px">' + esc(rv.reviewer || '') + '</span></div></div>';
  }
  html += '<div class="section-sub">同口径复验（标准更新后用当前标准重跑本样本）</div>';
  html += '<div class="eval-reason" style="margin-bottom:8px">复验样本不计入默认统计口径，只用于前后对比：同样本、同标准版本下的等级变化才是真实能力变化。</div>';
  html += '<div id="recheckBox">' + (d.rechecks && d.rechecks.length
    ? d.rechecks.map((rc) => '<div class="eval-row"><div class="eval-key">' + esc(rc.created_at.slice(0, 16).replace('T', ' ')) + '</div><div class="eval-val">' + rc.levels.map((l) => lvTag(l)).join(' ') + '</div></div>').join('')
    : '<div class="eval-reason">尚未复验。</div>') + '</div>';
  html += '<div style="margin:8px 0"><button class="btn btn-sm" id="btnRecheck">执行同口径复验</button></div>';
  html += '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">关闭</button></div>';
  openModal(html);
  $('btnRecheck').addEventListener('click', async () => {
    $('btnRecheck').disabled = true;
    $('btnRecheck').textContent = '复验中…';
    try {
      const rc = await api('POST', '/api/sessions/' + id + '/recheck', {});
      const box2 = $('recheckBox');
      const rows = rc.changes.length
        ? rc.changes.map((c) => '<div class="eval-row"><div class="eval-key">' + esc(c.demand.slice(0, 18)) + '</div><div class="eval-val">' + lvTag(c.from) + ' → ' + lvTag(c.to) + '</div></div>').join('')
        : '<div class="eval-reason">本次复验各诉求等级无变化（标准未变或样本稳定）。</div>';
      box2.innerHTML = '<div class="eval-reason" style="color:var(--l3)">复验完成：</div>' + rows;
      toast(rc.changes.length ? '复验完成，有 ' + rc.changes.length + ' 项等级变化' : '复验完成，等级无变化');
    } catch (e) { toast(e.message); }
    $('btnRecheck').disabled = false;
    $('btnRecheck').textContent = '执行同口径复验';
  });
}

document.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => {
  const fmt = b.dataset.format || 'json';
  window.location = '/api/export?type=' + b.dataset.export + (fmt === 'csv' ? '&format=csv' : '');
  toast('已开始导出（' + fmt.toUpperCase() + '）');
}));

/* ============ 评估助手（Agent 对话） ============ */

const CHAT_QUICK = [
  '当前完整方案可交付率是多少？',
  '无法判断的原因分布？',
  '待复核还有多少？优先处理哪些？',
  '按意图看一下 L3 率',
  '给我分析结论',
  '我还需要提供哪些材料？',
  '意图库的版本历史',
  '新增意图：乘客要求导致违规，定义：因乘客要求导致的违规判罚申诉',
  '搜索会话：奖励',
  '检测这段对话：司机：奖励还没到账\n意图：奖励到账咨询\n场景：奖励到账查询\nAI建议：奖励一般三个工作日内到账，请您耐心等待',
];

function loadChatHistory() {
  try { state.chatHistory = JSON.parse(localStorage.getItem('solve-eval-chat') || '[]'); } catch (e) { state.chatHistory = []; }
}
function saveChatHistory() {
  localStorage.setItem('solve-eval-chat', JSON.stringify(state.chatHistory.slice(-60)));
}

function renderChat() {
  const quick = $('chatQuick');
  quick.innerHTML = CHAT_QUICK.slice(0, 6).map((q) => '<button class="chip" data-q="' + esc(q) + '">' + esc(q.split('\n')[0].slice(0, 18)) + '</button>').join('');
  quick.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
    $('chatInput').value = CHAT_QUICK.find((q) => q.startsWith(c.dataset.q.slice(0, 18))) || c.dataset.q;
    $('chatInput').focus();
  }));
  renderChatMessages();
}

function renderChatMessages() {
  const list = $('chatList');
  if (!state.chatHistory.length) {
    const pres = (state.agentCfg && state.agentCfg.presentation) || {};
    list.innerHTML = '<div class="chat-welcome"><div class="chat-welcome-title">' + esc(pres.greeting || '我是评估助手') + '</div>' +
      '<div class="chat-welcome-sub">' + esc(pres.welcome_sub || '问我数据（指标/分布/队列），也让我检测一段会话，或者告诉我还缺什么材料。所有结论都能追溯到平台里的原始记录。') + '</div></div>';
    return;
  }
  list.innerHTML = state.chatHistory.map((m) => {
    if (m.role === 'user') return '<div class="chat-msg chat-user"><div class="chat-bubble">' + esc(m.text).replace(/\n/g, '<br>') + '</div></div>';
    let blocks = '';
    for (const b of (m.blocks || [])) blocks += renderChatBlock(b, m.actions || []);
    return '<div class="chat-msg chat-bot"><div class="chat-bubble">' + esc(m.text).replace(/\n/g, '<br>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') + '</div>' + blocks +
      (m.trace && m.trace.length ? '<div class="chat-trace">' + m.trace.map((t) => '<span class="tag tag-rule">' + esc(t) + '</span>').join(' ') + '</div>' : '') + '</div>';
  }).join('');
  list.querySelectorAll('[data-session]').forEach((a) => a.addEventListener('click', () => openSessionDetail(a.dataset.session)));
  list.scrollTop = list.scrollHeight;
}

function renderChatBlock(b, actions) {
  if (b.type === 'kpi') {
    const o = b.data;
    return '<div class="chat-kpi">' +
      cell('L3 可交付率', o.l3_delivery_rate) + cell('有效辅助率', o.effective_assist_rate) + cell('U 率', o.u_rate) + cell('诉求总数', o.demand_count) +
      '</div>';
  }
  if (b.type === 'levels') {
    const c = b.data;
    return '<div class="chat-levels">' + ['L3', 'L2', 'L1', 'L0', 'U'].map((k) => '<span>' + lvTag(k) + ' × ' + c[k] + '</span>').join('') + '</div>';
  }
  if (b.type === 'table') {
    return '<table class="dims-table"><tr>' + b.data.head.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr>' +
      b.data.rows.map((r) => '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('') + '</table>';
  }
  if (b.type === 'bars') {
    const max = Math.max(1, ...b.data.map((x) => x.value));
    return '<div class="chat-bars">' + b.data.map((x) => '<div class="bar-row"><span>' + esc(x.label) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + Math.max(2, Math.round((x.value / max) * 100)) + '%;background:var(--accent)"></div></div><span class="bar-num">' + x.value + '</span></div>').join('') + '</div>';
  }
  if (b.type === 'sessions') {
    return b.data.map((s) => '<div class="chat-session"><a class="rec-link" data-session="' + esc(s.id) + '">' + esc(s.id) + '</a> <span class="tag">' + esc(s.intent_name) + '</span> ' + esc(s.preview) + '</div>').join('');
  }
  if (b.type === 'materials') {
    return '<div class="chat-materials">' + b.data.items.map((i) => '<div class="chat-mat-row"><span>' + (i.ready ? '✅' : '⏳') + ' ' + esc(i.name) + '</span><span class="metric-num' + (i.ready ? '' : ' null') + '">' + i.current + '/' + i.target + '</span></div>').join('') + '</div>';
  }
  if (b.type === 'review_queue') {
    return b.data.length ? '<div class="chat-sessions">' + b.data.map((r) => '<div class="chat-session">' + (r.priority === 'high' ? '<span class="ri-flag ri-high">优先</span>' : r.needs_spotcheck ? '<span class="ri-flag ri-spot">抽检</span>' : '') + ' <a class="rec-link" data-review="' + esc(r.review_id) + '">' + esc(r.review_id.slice(-12)) + '</a> ' + esc(r.status) + '</div>').join('') + '</div>' : '<div class="eval-reason">待复核队列为空。</div>';
  }
  if (b.type === 'detect_result') {
    return '<div class="chat-kpi">' + cell('会话级', b.data.summary) + cell('等级', b.data.levels.join('/')) + cell('模式', b.data.mode === 'llm' ? '大模型' : '规则引擎') + '</div>';
  }
  if (b.type === 'export_links') {
    return '<div class="chat-actions"><a class="btn btn-sm btn-ghost" href="/api/export?type=sessions&format=csv">导出会话 CSV</a><a class="btn btn-sm btn-ghost" href="/api/export?type=detections&format=csv">导出检测 CSV</a><a class="btn btn-sm btn-ghost" href="/api/export?type=reviews&format=csv">导出复核 CSV</a></div>';
  }
  if (b.type === 'text') return '<div class="chat-note">' + esc(b.data).replace(/\n/g, '<br>') + '</div>';
  return '';
  function cell(l, v) { return '<div class="chat-kpi-cell"><div class="kpi-label">' + l + '</div><div class="kpi-value" style="font-size:18px">' + esc(v) + '</div></div>'; }
}

async function sendChat() {
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  state.chatHistory.push({ role: 'user', text });
  renderChatMessages();
  const list = $('chatList');
  const typing = document.createElement('div');
  typing.className = 'chat-msg chat-bot';
  typing.innerHTML = '<div class="chat-bubble chat-typing">思考中…</div>';
  list.appendChild(typing);
  list.scrollTop = list.scrollHeight;
  try {
    const r = await api('POST', '/api/agent/chat', { message: text });
    typing.remove();
    state.chatHistory.push({ role: 'bot', text: r.reply, blocks: r.blocks || [], actions: r.actions || [], trace: r.trace || [] });
  } catch (e) {
    typing.remove();
    state.chatHistory.push({ role: 'bot', text: '出错了：' + e.message, blocks: [], actions: [], trace: [] });
  }
  saveChatHistory();
  renderChatMessages();
  refreshBadge();
}

$('btnChatSend').addEventListener('click', sendChat);
$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
$('chatList').addEventListener('click', (e) => {
  const a = e.target.closest('[data-chat-action]');
  if (a) {
    const act = JSON.parse(a.dataset.chatAction);
    document.querySelector('.nav-item[data-view="' + act.view + '"]').click();
    if (act.preset && act.preset.reviewStatus) state.reviewStatus = act.preset.reviewStatus;
    return;
  }
  const s = e.target.closest('[data-session]');
  if (s) return openSessionDetail(s.dataset.session);
  const rv = e.target.closest('[data-review]');
  if (rv) { document.querySelector('.nav-item[data-view="review"]').click(); state.selectedReview = rv.dataset.review; loadReviews(); openReviewDetail(rv.dataset.review); }
});
// 渲染 actions 按钮
const _origRenderChatBlock = renderChatBlock;
renderChatBlock = function (b, actions) {
  let html = _origRenderChatBlock(b, actions);
  if (actions && actions.length) {
    html += '<div class="chat-actions">' + actions.map((a, i) => '<button class="btn btn-sm" data-chat-action=\'' + esc(JSON.stringify(a)) + '\'>' + esc(a.label) + '</button>').join('') + '</div>';
  }
  return html;
};

/* ============ 材料中心 ============ */

async function loadMaterials() {
  const [mat, issues] = await Promise.all([api('GET', '/api/materials'), api('GET', '/api/standard-issues')]);
  const pending = mat.items.filter((i) => !i.ready);
  $('matOverview').innerHTML = '<div class="pane"><div class="report-head" style="border:none;padding-bottom:6px;margin-bottom:10px">' +
    '<div class="report-title">材料就绪度</div>' +
    '<span class="report-summary-tag ' + (mat.pct === 100 ? 'sum-pass' : 'sum-u') + '">' + mat.readyCount + '/' + mat.total + ' 项达标（' + mat.pct + '%）</span></div>' +
    '<div class="bar-track" style="height:10px;margin-bottom:14px"><div class="bar-fill" style="width:' + mat.pct + '%;background:' + (mat.pct === 100 ? 'var(--l3)' : 'var(--accent)') + '"></div></div>' +
    (pending.length ? '<div class="u-warn">还差 ' + pending.length + ' 项：' + pending.map((i) => esc(i.name)).join('、') + '。不补齐也能跑，但对应维度会大量拒判（U），结论覆盖率上不去。</div>' : '<div class="eval-reason" style="color:var(--l3)">全部就绪，可以扩大样本量做统计结论了。</div>') +
    '</div>';
  $('matOverview').innerHTML += '<div class="pane"><h3 style="font-size:14px;font-weight:500;margin-bottom:12px">材料清单与提供方式</h3>' +
    '<table class="metric-table"><tr><th style="width:36px">状态</th><th>材料</th><th>为什么需要</th><th>提供格式</th><th style="width:90px">进度</th></tr>' +
    mat.items.map((i) => '<tr><td>' + (i.ready ? '<span class="tag tag-pass">就绪</span>' : '<span class="tag tag-u">待提供</span>') + '</td>' +
      '<td><b>' + esc(i.name) + '</b></td><td style="font-size:12px;color:var(--text-2)">' + esc(i.why) + '</td><td style="font-size:12px;color:var(--text-2)">' + esc(i.format) + '</td>' +
      '<td><span class="metric-num' + (i.ready ? '' : ' null') + '">' + i.current + '/' + i.target + '</span></td></tr>').join('') + '</table>' +
    '<div class="field-hint" style="margin-top:12px">两种提供方式：① 下载模板填写后在本页导入；② 直接在「评估助手」里把内容贴给我，说「导入意图库：…」，我来解析入库。</div></div>';
  // 待处理的标准事项
  const open = issues.issues.filter((i) => i.status !== '已关闭');
  $('matOverview').innerHTML += '<div class="pane"><h3 style="font-size:14px;font-weight:500;margin-bottom:10px">标准事项队列（' + open.length + ' 条待处理）</h3>' +
    (open.length ? open.map((i) => '<div class="issue-item"><span class="tag">' + esc(i.type) + '</span>' + (i.reason_code ? '<span class="tag tag-u">' + esc(i.reason_code) + '</span>' : '') + '<span style="flex:1">' + esc(i.description) + '</span><span class="issue-status">' + esc(i.status) + '</span></div>').join('') : '<div class="eval-reason">暂无待处理标准事项。复核台标记 U 样本时会自动生成。</div>') + '</div>';
  loadMatVersions();
}

$('btnStdImport').addEventListener('click', async () => {
  const text = $('f_std_import').value.trim();
  if (!text) return toast('请先粘贴导入内容');
  let data = null;
  try { data = text.startsWith('[') || text.startsWith('{') ? JSON.parse(text) : parseBatchInput(text); } catch (e) { return toast('解析失败：' + e.message); }
  const isTree = data && !Array.isArray(data) && Array.isArray(data.intents);
  if (!isTree && (!Array.isArray(data) || !data.length)) return toast('没有解析到数据行');
  try {
    const r = isTree
      ? await api('POST', '/api/materials/import', { format: 'intent_tree', data })
      : await api('POST', '/api/materials/import', { format: 'rows', data });
    const verInfo = isTree
      ? '，意图库版本 → v' + r.version
      : (r.versions && Object.keys(r.versions).length ? '，受影响库版本：' + Object.entries(r.versions).map(([k, v]) => k + ' v' + v).join('、') : '');
    $('stdImportResult').innerHTML = '<div class="batch-summary">导入完成：新增 ' + r.added + ' 条、更新 ' + (r.updated || 0) + ' 条、跳过 ' + r.skipped + ' 条' + verInfo + '。标准库现有 ' + (r.total || '') + ' 条。</div>';
    toast('已导入 ' + r.added + ' 条');
    loadMaterials();
    refreshBadge();
  } catch (e) { toast(e.message); }
});

/* ============ 材料中心 · 版本管理 ============ */

const DATASET_LABELS = { intents: '意图库', scenes: '场景库', mappings: '意图-场景映射', skills: 'Skill 库', skill_scenes: 'Skill-场景映射', cases: '正负案例', checklists: '场景检查清单', reply_rules: '业务规则', sessions: '真实会话样本' };

async function loadMatVersions() {
  const seg = $('matDatasetSeg');
  const keys = Object.keys(DATASET_LABELS);
  if (!state.matDataset) state.matDataset = 'intents';
  seg.innerHTML = keys.map((k) => '<button class="seg-btn ' + (state.matDataset === k ? 'active' : '') + '" data-ds="' + k + '">' + DATASET_LABELS[k] + '</button>').join('');
  seg.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => { state.matDataset = b.dataset.ds; loadMatVersions(); }));
  const box = $('matVersionPanel');
  try {
    const [dsRes, verRes] = await Promise.all([
      api('GET', '/api/datasets'),
      api('GET', '/api/material-versions?dataset=' + encodeURIComponent(state.matDataset)),
    ]);
    const ds = (dsRes.datasets || []).find((d) => d.key === state.matDataset) || {};
    const versions = verRes.versions || [];
    let html = '<div class="version-summary">' +
      '<div><span class="version-num">v' + (ds.current_version || 0) + '</span><span class="version-label">当前版本</span></div>' +
      '<div><span class="version-num">' + (ds.count || 0) + '</span><span class="version-label">记录条数（已生效 ' + (ds.effective || 0) + '）</span></div>' +
      '<div><span class="version-num">' + (ds.versions || 0) + '</span><span class="version-label">历史版本数</span></div>' +
      '<div style="flex:1;text-align:right;font-size:12px;color:var(--text-3)">' + (ds.last_updated ? '最近更新：' + esc(ds.last_updated.slice(0, 16).replace('T', ' ')) : '暂无版本记录') + '</div></div>';
    if (!versions.length) {
      html += '<div class="empty">该资料库还没有版本记录。导入或增删改后会自动生成版本。</div>';
    } else {
      html += '<table class="metric-table"><tr><th style="width:52px">版本</th><th>说明</th><th style="width:80px">来源</th><th style="width:110px">变更（增/改/删）</th><th style="width:70px">操作人</th><th style="width:130px">时间</th><th style="width:120px">操作</th></tr>' +
        versions.map((v) => '<tr><td><b>v' + v.version + '</b></td>' +
          '<td>' + esc(v.note || '') + (v.changes && v.changes.total != null ? ' <span style="color:var(--text-3);font-size:11px">（合计 ' + v.changes.total + ' 条）</span>' : '') + '</td>' +
          '<td>' + esc(v.source || '') + '</td>' +
          '<td><span style="color:var(--l3)">+' + (v.changes ? v.changes.added : 0) + '</span> / <span style="color:var(--accent)">~' + (v.changes ? v.changes.updated : 0) + '</span> / <span style="color:var(--l0)">-' + (v.changes ? v.changes.removed : 0) + '</span></td>' +
          '<td>' + esc(v.operator || '—') + '</td>' +
          '<td style="font-size:12px">' + esc((v.created_at || '').slice(0, 16).replace('T', ' ')) + '</td>' +
          '<td><button class="btn btn-sm btn-ghost" data-verdetail="' + v.id + '">明细</button>' +
          (v.rollbackable ? ' <button class="btn btn-sm btn-ghost btn-danger" data-verrollback="' + v.id + '" data-ver="v' + v.version + '">回滚</button>' : '') +
          '</td></tr>').join('') + '</table>';
      html += '<div class="field-hint" style="margin-top:10px">回滚 = 把该资料库恢复到所选版本的全量状态（回滚操作本身也会记一个新版本）。仅保留最近 30 个版本的快照；会话样本为审计记录，不回滚。</div>';
    }
    box.innerHTML = html;
    box.querySelectorAll('[data-verdetail]').forEach((b) => b.addEventListener('click', () => openVersionDetail(b.dataset.verdetail)));
    box.querySelectorAll('[data-verrollback]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('确认把「' + DATASET_LABELS[state.matDataset] + '」回滚到 ' + b.dataset.ver + '？当前状态会被替换（回滚本身也会记版本，可再次回滚找回）。')) return;
      try {
        const r = await api('POST', '/api/material-versions/' + b.dataset.verrollback + '/rollback', {});
        toast('已回滚，恢复 ' + r.restored + ' 条，新版本 v' + r.version);
        loadMatVersions(); loadMaterials();
      } catch (e) { toast(e.message); }
    }));
  } catch (e) { box.innerHTML = '<div class="empty">版本信息加载失败：' + esc(e.message) + '</div>'; }
}

async function openVersionDetail(id) {
  let v;
  try { v = (await api('GET', '/api/material-versions/' + id)).version; } catch (e) { return toast(e.message); }
  const ch = v.changes || {};
  let html = '<div class="modal-title">「' + esc(DATASET_LABELS[v.dataset] || v.dataset) + '」v' + v.version + ' · ' + esc(v.note || '') + '</div>' +
    '<div class="field-hint" style="margin-bottom:10px">来源：' + esc(v.source || '') + ' · 操作人：' + esc(v.operator || '—') + ' · 时间：' + esc((v.created_at || '').slice(0, 16).replace('T', ' ')) + ' · 变更：新增 ' + (ch.added || 0) + ' / 更新 ' + (ch.updated || 0) + ' / 删除 ' + (ch.removed || 0) + ' / 合计 ' + (ch.total || 0) + '</div>';
  if (Array.isArray(v.detail) && v.detail.length) {
    html += '<div class="ver-detail-list">' + v.detail.map((d) => '<div class="ver-detail-item"><span class="ver-act ver-act-' + d.action + '">' + (d.action === 'add' ? '新增' : d.action === 'update' ? '更新' : '删除') + '</span>' + esc(d.name || d.id) + '</div>').join('') + '</div>';
  }
  if (v.records) {
    html += '<div class="field-hint" style="margin:10px 0 6px">该版本的全量记录（' + v.records.length + ' 条）：</div><div class="ver-detail-list" style="max-height:280px;overflow:auto">' +
      v.records.map((r) => '<div class="ver-detail-item"><span class="tag">' + esc(r.status || '') + '</span>' + esc(r.name || '') + (r.intent_id ? ' <span style="color:var(--text-3);font-size:11px">#' + esc(r.intent_id) + '</span>' : '') + '</div>').join('') + '</div>';
  } else if (v.dataset === 'sessions') {
    html += '<div class="field-hint" style="margin-top:8px">会话样本版本为审计记录（只记录批量导入的样本变更，不保存全量快照）。</div>';
  }
  openModal(html + '<div class="form-actions"><button class="btn btn-ghost" onclick="closeModal()">关闭</button></div>');
}

/* ============ 纠正任务 ============ */

async function loadCorrections() {
  const seg = $('corrStatusSeg');
  const statuses = ['全部', '待纠正', '纠正中', '待复验', '已关闭'];
  seg.innerHTML = statuses.map((s) => '<button class="seg-btn ' + (state.corrStatus === s ? 'active' : '') + '" data-st="' + s + '">' + s + '</button>').join('');
  seg.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => { state.corrStatus = b.dataset.st; loadCorrections(); }));
  const r = await api('GET', '/api/corrections');
  let list = r.corrections;
  if (state.corrStatus !== '全部') list = list.filter((c) => c.status === state.corrStatus);
  $('corrBadge').textContent = r.corrections.filter((c) => c.status === '待纠正' || c.status === '纠正中').length || '';
  const box = $('corrList');
  if (!list.length) { box.innerHTML = '<div class="empty">暂无纠正任务。在复核台对样本点「派生纠正任务」即可创建。</div>'; return; }
  box.innerHTML = list.map((c) => '<div class="pane" style="padding:16px 20px">' +
    '<div class="review-item" style="padding:0;border:none;cursor:default">' + lvTag(c.current_level || '?') + '<span style="color:var(--text-3)">→</span>' + lvTag(c.expected_level || 'L3') +
    '<div class="ri-main"><div class="ri-demand">' + esc(c.target) + '</div>' +
    '<div class="ri-meta"><span>' + esc(c.fix_type) + '</span><span>·</span><span>' + esc(c.status) + '</span><span>·</span><span>' + esc((c.created_at || '').slice(0, 10)) + '</span>' +
    (c.session_id ? '<a class="rec-link" data-csess="' + esc(c.session_id) + '">查看会话</a>' : '') + '</div></div></div>' +
    (c.suggestion ? '<div class="eval-reason" style="margin-top:6px">改进建议：' + esc(c.suggestion) + '</div>' : '') +
    '<div class="review-actions">' +
    ['待纠正', '纠正中', '待复验', '已关闭'].map((s) => '<button class="btn btn-sm ' + (c.status === s ? 'btn-primary' : '') + '" data-corr="' + c.id + '" data-st="' + s + '">' + s + '</button>').join('') +
    '</div></div>').join('');
  box.querySelectorAll('[data-corr]').forEach((b) => b.addEventListener('click', async () => {
    await api('PATCH', '/api/corrections/' + b.dataset.corr, { status: b.dataset.st });
    toast('任务状态已更新为「' + b.dataset.st + '」');
    loadCorrections();
  }));
  box.querySelectorAll('[data-csess]').forEach((a) => a.addEventListener('click', () => openSessionDetail(a.dataset.csess)));
}

/* ============ 徽标 ============ */

/* ============ 启动 ============ */

(async function init() {
  await window.CsrAuth?.ready;
  await loadSettings();
  loadChatHistory();
  await refreshBadge();
  renderChat();
})();

/* ============ 标准库 ============ */

const STD_TYPE_LABEL = { intent_def: '意图定义', scene_def: '场景定义', mapping: '意图-场景映射', skill_def: 'Skill 定义', skill_scene: 'Skill-场景映射', checklist: '场景检查清单', reply_rule: '回复规则', case_positive: '正案例', case_negative: '负案例' };

async function loadStandards() {
  const [std, issues] = await Promise.all([api('GET', '/api/standards'), api('GET', '/api/standard-issues')]);
  const groups = {};
  for (const s of std.standards) {
    const g = STD_TYPE_LABEL[s.type] || s.type;
    (groups[g] = groups[g] || []).push(s);
  }
  $('stdList').innerHTML = Object.keys(groups).map((g) =>
    '<div class="std-group"><div class="std-group-title">' + esc(g) + '</div>' +
    groups[g].map((s) => '<div class="std-item"><div class="std-item-head"><span class="std-item-name">' + esc(s.name) + '</span><span class="std-status st-' + esc(s.status) + '">' + esc(s.status) + '</span><span style="font-size:11px;color:var(--text-3)">v' + s.version + '</span>' +
      '<span style="margin-left:auto;font-size:11px;color:var(--text-3)">' + (s.source === '人工' ? '人工维护' : esc(s.source)) + '</span></div>' +
      '<div class="std-item-content">' + esc(s.content) + '</div>' +
      '<div class="std-item-foot">' +
      (s.status !== '已生效' ? '<button class="btn btn-sm" data-activate="' + s.id + '">生效</button>' : '') +
      (s.status === '已生效' ? '<button class="btn btn-sm btn-danger" data-conflict="' + s.id + '">标记冲突</button>' : '') +
      '<button class="btn btn-sm btn-ghost btn-danger" data-del="' + s.id + '">删除</button>' +
      '</div></div>').join('') + '</div>'
  ).join('') || '<div class="empty">标准库为空</div>';

  $('stdList').querySelectorAll('[data-activate]').forEach((b) => b.addEventListener('click', async () => {
    await api('PATCH', '/api/standards/' + b.dataset.activate, { status: '已生效' });
    toast('标准已生效，版本号 +1'); loadStandards();
  }));
  $('stdList').querySelectorAll('[data-conflict]').forEach((b) => b.addEventListener('click', async () => {
    await api('PATCH', '/api/standards/' + b.dataset.conflict, { status: '已冲突' });
    toast('已标记冲突（B4：冲突不自动失效，交业务裁决）'); loadStandards();
  }));
  $('stdList').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('确认删除该标准？')) return;
    await api('DELETE', '/api/standards/' + b.dataset.del);
    toast('已删除'); loadStandards();
  }));

  $('issueList').innerHTML = issues.issues.length ? issues.issues.map((it) =>
    '<div class="issue-item"><span class="tag">' + esc(it.type) + '</span>' + (it.reason_code ? '<span class="tag tag-u">' + esc(it.reason_code) + '</span>' : '') +
    '<span style="flex:1">' + esc(it.description) + '</span>' +
    '<span class="issue-status' + (it.status === '已关闭' ? ' done' : '') + '">' + esc(it.status) + '</span>' +
    (it.status !== '已关闭' ? '<button class="btn btn-sm" data-close="' + it.id + '">关闭</button>' : '') + '</div>').join('') : '<div class="empty">暂无标准事项</div>';
  $('issueList').querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', async () => {
    await api('PATCH', '/api/standard-issues/' + b.dataset.close, { status: '已关闭' });
    toast('事项已关闭'); loadStandards();
  }));
}

$('btnStdAdd').addEventListener('click', async () => {
  const name = $('std_name').value.trim();
  if (!name) return toast('请填写标准名称');
  await api('POST', '/api/standards', {
    type: $('std_type').value, name, content: $('std_content').value, status: $('std_status').value,
  });
  $('std_name').value = ''; $('std_content').value = '';
  toast('标准已保存');
  loadStandards();
});

/* ============ 助手配置 ============ */

const AGENT_CFG_TABS = [
  { key: 'prompt', name: '系统提示词' },
  { key: 'rules', name: '路由规则' },
  { key: 'capabilities', name: '能力清单' },
  { key: 'knowledge', name: '技能知识库' },
  { key: 'presentation', name: '展示文案' },
];

async function loadAgentConfig() {
  try {
    const r = await api('GET', '/api/agent-config');
    state.agentCfg = r.config;
  } catch (e) { $('agentCfgPanel').innerHTML = '<div class="empty">配置加载失败：' + esc(e.message) + '</div>'; return; }
  const seg = $('agentCfgSeg');
  seg.innerHTML = AGENT_CFG_TABS.map((t) => '<button class="seg-btn ' + (state.agentCfgTab === t.key ? 'active' : '') + '" data-tab="' + t.key + '">' + t.name + '</button>').join('');
  seg.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => { state.agentCfgTab = b.dataset.tab; loadAgentConfig(); }));
  const cfg = state.agentCfg;
  const box = $('agentCfgPanel');
  if (state.agentCfgTab === 'prompt') {
    box.innerHTML = '<div class="pane"><h3 style="font-size:14px;font-weight:500;margin-bottom:12px">系统提示词（大模型通道的基础指令）</h3>' +
      '<div class="field-hint" style="margin-bottom:10px">平台数据快照、工具清单与技能知识库会在每次对话时自动附加在这段指令之后；这里维护的是助手的人设与行为基线。</div>' +
      '<textarea id="cfg_prompt" class="ta ta-tall" style="min-height:180px">' + esc(cfg.system_prompt || '') + '</textarea>' +
      '<div class="form-actions"><button class="btn btn-primary" id="btnCfgSavePrompt">保存提示词</button><span class="form-note">保存后对下一次大模型对话生效。</span></div></div>';
    $('btnCfgSavePrompt').addEventListener('click', async () => {
      try {
        await api('PUT', '/api/agent-config', { config: Object.assign({}, cfg, { system_prompt: $('cfg_prompt').value }) });
        toast('提示词已保存'); loadAgentConfig();
      } catch (e) { toast(e.message); }
    });
  } else if (state.agentCfgTab === 'rules') {
    box.innerHTML = '<div class="pane"><h3 style="font-size:14px;font-weight:500;margin-bottom:12px">路由规则（规则通道按顺序匹配，可单独启停）</h3>' +
      '<div class="field-hint" style="margin-bottom:10px">关闭某条规则后，对应问法会继续向后匹配（如关闭「指标总览」，「L3 率是多少」会落到兜底）。大模型通道不受此处开关影响。</div>' +
      '<table class="metric-table"><tr><th style="width:60px">启用</th><th style="width:110px">规则</th><th>触发词</th><th>说明</th></tr>' +
      (cfg.rules || []).map((r, i) => '<tr><td><input type="checkbox" data-rule="' + i + '" ' + (r.enabled !== false ? 'checked' : '') + '></td>' +
        '<td><b>' + esc(r.name) + '</b><div style="font-size:11px;color:var(--text-3)">' + esc(r.key) + '</div></td>' +
        '<td style="font-size:12px">' + esc(r.trigger || '') + '</td><td style="font-size:12px;color:var(--text-2)">' + esc(r.desc || '') + '</td></tr>').join('') + '</table>' +
      '<div class="form-actions"><button class="btn btn-primary" id="btnCfgSaveRules">保存规则开关</button></div></div>';
    $('btnCfgSaveRules').addEventListener('click', async () => {
      const rules = (cfg.rules || []).map((r, i) => Object.assign({}, r, { enabled: !!box.querySelector('[data-rule="' + i + '"]').checked }));
      try {
        await api('PUT', '/api/agent-config', { config: Object.assign({}, cfg, { rules }) });
        toast('规则开关已保存'); loadAgentConfig();
      } catch (e) { toast(e.message); }
    });
  } else if (state.agentCfgTab === 'capabilities') {
    box.innerHTML = '<div class="pane"><h3 style="font-size:14px;font-weight:500;margin-bottom:12px">能力清单（帮助回复与欢迎语中展示）</h3>' +
      '<div class="field-hint" style="margin-bottom:10px">名称与说明会展示在「帮助」回复里；勾选状态仅作为维护标记。</div>' +
      (cfg.capabilities || []).map((c, i) => '<div class="cap-item"><input type="checkbox" data-cap="' + i + '" ' + (c.enabled !== false ? 'checked' : '') + '>' +
        '<div style="flex:1"><input class="input" data-capname="' + i + '" value="' + esc(c.name) + '" placeholder="能力名称">' +
        '<input class="input" data-capdesc="' + i + '" value="' + esc(c.desc) + '" placeholder="能力说明" style="margin-top:6px"></div></div>').join('') +
      '<div class="form-actions"><button class="btn btn-ghost" id="btnCapAdd">+ 新增一项</button><button class="btn btn-primary" id="btnCfgSaveCaps">保存能力清单</button></div></div>';
    $('btnCapAdd').addEventListener('click', () => {
      cfg.capabilities.push({ key: 'cap_' + Date.now().toString(36), name: '', desc: '', enabled: true });
      loadAgentConfig();
    });
    $('btnCfgSaveCaps').addEventListener('click', async () => {
      const capabilities = (cfg.capabilities || []).map((c, i) => ({
        key: c.key, name: box.querySelector('[data-capname="' + i + '"]').value.trim(), desc: box.querySelector('[data-capdesc="' + i + '"]').value.trim(),
        enabled: !!box.querySelector('[data-cap="' + i + '"]').checked,
      })).filter((c) => c.name);
      try {
        await api('PUT', '/api/agent-config', { config: Object.assign({}, cfg, { capabilities }) });
        toast('能力清单已保存'); loadAgentConfig();
      } catch (e) { toast(e.message); }
    });
  } else if (state.agentCfgTab === 'knowledge') {
    box.innerHTML = '<div class="pane"><h3 style="font-size:14px;font-weight:500;margin-bottom:12px">技能知识库（大模型对话时自动注入）</h3>' +
      '<div class="field-hint" style="margin-bottom:10px">把助手需要知道的业务知识、口径、常见问题答案维护在这里，每次大模型对话都会带上。</div>' +
      (cfg.knowledge || []).map((k, i) => '<div class="kn-item"><div class="kn-head"><input class="input" data-kntitle="' + i + '" value="' + esc(k.title) + '" placeholder="条目名称">' +
        '<button class="btn btn-sm btn-ghost btn-danger" data-kndel="' + i + '">删除</button></div>' +
        '<textarea class="ta" data-kncontent="' + i + '" placeholder="内容" style="margin-top:6px;min-height:70px">' + esc(k.content) + '</textarea></div>').join('') +
      (!cfg.knowledge || !cfg.knowledge.length ? '<div class="empty">还没有知识条目。</div>' : '') +
      '<div class="form-actions"><button class="btn btn-ghost" id="btnKnAdd">+ 新增条目</button><button class="btn btn-primary" id="btnCfgSaveKn">保存知识库</button></div></div>';
    $('btnKnAdd').addEventListener('click', () => {
      if (!cfg.knowledge) cfg.knowledge = [];
      cfg.knowledge.push({ id: '', title: '', content: '' });
      loadAgentConfig();
    });
    box.querySelectorAll('[data-kndel]').forEach((b) => b.addEventListener('click', () => { cfg.knowledge.splice(Number(b.dataset.kndel), 1); loadAgentConfig(); }));
    $('btnCfgSaveKn').addEventListener('click', async () => {
      const knowledge = (cfg.knowledge || []).map((k, i) => ({
        id: k.id, title: box.querySelector('[data-kntitle="' + i + '"]').value.trim(), content: box.querySelector('[data-kncontent="' + i + '"]').value,
      })).filter((k) => k.title || k.content);
      try {
        await api('PUT', '/api/agent-config', { config: Object.assign({}, cfg, { knowledge }) });
        toast('知识库已保存'); loadAgentConfig();
      } catch (e) { toast(e.message); }
    });
  } else {
    box.innerHTML = '<div class="pane"><h3 style="font-size:14px;font-weight:500;margin-bottom:12px">展示文案（聊天界面的问候与欢迎语）</h3>' +
      '<label class="field-label">问候语</label><input id="cfg_greeting" class="input" value="' + esc(cfg.presentation.greeting || '') + '">' +
      '<label class="field-label">欢迎副标题（聊天窗口空态）</label><textarea id="cfg_welcome" class="ta" style="min-height:60px">' + esc(cfg.presentation.welcome_sub || '') + '</textarea>' +
      '<label class="field-label">帮助回复文案</label><textarea id="cfg_help" class="ta ta-tall" style="min-height:160px">' + esc(cfg.presentation.help || '') + '</textarea>' +
      '<div class="form-actions"><button class="btn btn-primary" id="btnCfgSavePres">保存展示文案</button></div></div>';
    $('btnCfgSavePres').addEventListener('click', async () => {
      try {
        await api('PUT', '/api/agent-config', { config: Object.assign({}, cfg, { presentation: { greeting: $('cfg_greeting').value, welcome_sub: $('cfg_welcome').value, help: $('cfg_help').value } }) });
        toast('展示文案已保存'); loadAgentConfig(); renderChat();
      } catch (e) { toast(e.message); }
    });
  }
}

/* ============ 设置 ============ */

async function loadSettings() {
  const b = await api('GET', '/api/bootstrap');
  const mine = window.CsrAuth?.user?.name || (localStorage.getItem('se_operator') || '').trim();
  $('set_operator').value = mine || b.settings.operator || '';
  $('set_operator').readOnly = !!window.CsrAuth?.user;
  $('set_operator').placeholder = '本浏览器署名，多人共用时各自填写（如：张三）';
  $('set_ratio').value = b.settings.spotcheck_ratio;
  $('set_llm_url').value = b.settings.llm_base_url || '';
  $('set_llm_model').value = b.settings.llm_model || '';
  $('engineChip').textContent = '引擎：' + (b.engine_mode === 'llm' ? '大模型模式' : '规则模式');
  $('engineChip').classList.toggle('llm', b.engine_mode === 'llm');
  $('operatorChip').textContent = '操作人：' + (mine || b.settings.operator || '未设置');
}

$('btnSaveSettings').addEventListener('click', async () => {
  const operator = $('set_operator').value.trim();
  localStorage.setItem('se_operator', operator);
  const body = {
    spotcheck_ratio: Number($('set_ratio').value),
    llm_base_url: $('set_llm_url').value.trim(),
    llm_model: $('set_llm_model').value.trim(),
  };
  if (operator) body.operator = operator;
  const key = $('set_llm_key').value.trim();
  if (key) body.llm_api_key = key;
  await api('POST', '/api/settings', body);
  toast('设置已保存');
  loadSettings();
});

/* ============ 启动 ============ */

/* 多人共用：定时刷新徽标与当前视图（切窗口/输入中/弹窗打开时不刷，避免打断） */
function autoRefresh() {
  if (document.visibilityState !== 'visible') return;
  if (document.querySelector('.modal-mask:not(.hidden)')) return;
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
  refreshBadge();
  if (state.view === 'review') loadReviews();
  else if (state.view === 'records') loadRecords();
  else if (state.view === 'board') loadBoard();
  else if (state.view === 'materials') loadMaterials();
  else if (state.view === 'corrections') loadCorrections();
  else if (state.view === 'agent-config') loadAgentConfig();
}
setInterval(autoRefresh, 20000);

(async function init() {
  await window.CsrAuth?.ready;
  await loadSettings();
  await refreshBadge();
})();
