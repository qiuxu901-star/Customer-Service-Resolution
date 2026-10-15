'use strict';
/*
 * 解决力评估 · 检测引擎
 * 严格执行《检测规则清单 V1.0》：P/R/Q/I/S/D/G/W/A/UR/O/B 十二段
 * 双模式：llm（配置了模型时优先，失败自动降级并标注） / rule（规则启发式，保守判级）
 */

// ---------- 通用工具 ----------

function parseMessages(raw) {
  // 格式：逐行 "角色：内容"，支持 司机/客服/AI/客户/用户/坐席/机器人
  const lines = String(raw || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const roleMap = { '司机': 'driver', '客户': 'driver', '用户': 'driver', '客服': 'agent', '坐席': 'agent', 'ai': 'ai', '机器人': 'ai', '智能客服': 'ai', 'AI建议': 'ai' };
  const messages = [];
  for (const line of lines) {
    const m = line.match(/^([^\s：:]{1,8})[：:]\s*(.+)$/);
    if (m && roleMap[m[1]]) {
      messages.push({ role: roleMap[m[1]], text: m[2].trim(), raw_role: m[1] });
    } else if (messages.length) {
      messages[messages.length - 1].text += ' ' + line;
    } else {
      messages.push({ role: 'driver', text: line, raw_role: '司机' });
    }
  }
  return messages;
}

function bigramSim(a, b) {
  const bg = (s) => { const r = new Set(); for (let i = 0; i < s.length - 1; i++) r.add(s.slice(i, i + 2)); return r; };
  const A = bg(a), B = bg(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.min(A.size, B.size);
}

function splitSentences(text) {
  return String(text || '').split(/[。！？!?；;\n]+/).map((s) => s.trim()).filter((s) => s.length >= 4);
}

// ---------- R1-R6 前置：完整性检查与追问 ----------

const BLOCKING_FIELDS = [
  { key: 'session_text', label: '原始会话内容', ask: '请粘贴司机与客服的完整会话（每行按「司机：…」「客服：…」「AI：…」格式）' },
  { key: 'ai_reply', label: 'AI 建议回复', ask: '本场景的 AI 建议回复是什么？（若该会话确实不产生 AI 建议，可选择「标记为不适用」）', optional: true },
];

function completenessCheck(input) {
  const missing = [];
  const messages = parseMessages(input.session_text);
  if (!messages.length) missing.push({ field: 'session_text', label: '原始会话内容', ask: BLOCKING_FIELDS[0].ask });
  const aiReply = String(input.ai_reply || '').trim();
  if (!aiReply) missing.push({ field: 'ai_reply', label: 'AI 建议回复', ask: BLOCKING_FIELDS[1].ask, canMarkNA: true });
  const intentId = String(input.intent_id || '').trim();
  const intentName = String(input.intent_name || '').trim();
  if (!intentId && !intentName) missing.push({ field: 'intent', label: '系统识别意图', ask: '系统对该会话识别出的意图（ID 或名称）是什么？若原系统未输出意图，可选择「标记为缺失」', canMarkNA: true });
  const sceneId = String(input.scene_id || '').trim();
  const sceneName = String(input.scene_name || '').trim();
  if (!sceneId && !sceneName) missing.push({ field: 'scene', label: '命中场景', ask: '该会话命中的场景（ID 或名称）是什么？若原系统未输出场景，可选择「标记为缺失」', canMarkNA: true });
  return { messages, missing };
}

// ---------- Q1-Q9 诉求还原 ----------

const DEMAND_SIGNALS = ['未到账', '没到账', '不到账', '少了', '多扣', '扣了', '为什么', '怎么回事', '怎么办', '如何', '什么时候', '多久', '异常', '出错', '错误', '投诉', '申诉', '不认可', '不同意', '要求', '申请', '取消', '修改', '查询', '核实', '冻结', '封号', '限制', '处罚', '违规', '扣款', '退款', '提现', '审核', '未通过', '驳回', '延迟', '不到', '没有', '无法', '不能'];
const NEW_DEMAND_SIGNALS = ['另外', '还有', '还有一个', '另一个问题', '第二件事', '同时'];
const EMOTION_SIGNALS = ['太过分', '垃圾', '投诉你们', '什么破', '坑', '烦死', '态度'];
const URGE_SIGNALS = ['多久', '快点', '能不能', '催一下', '催催', '赶快', '尽快'];
const COMPOUND_SPLIT = /[，,]?\s*(?:而且|并且|同时|另有|还有一个)\s*/;

function extractDemands(messages) {
  const driverMsgs = messages.filter((m) => m.role === 'driver');
  const demands = [];
  const seen = [];
  const pushDemand = (text, msg) => {
    const s = text.trim();
    if (s.length < 4) return;
    const hasDemand = DEMAND_SIGNALS.some((k) => s.includes(k));
    if (!hasDemand) return;
    // Q5：纯催促/情绪表达（多久、快点、能不能）不单列为诉求
    const isUrgeOnly = URGE_SIGNALS.some((k) => s.includes(k)) && !/(到账|金额|退|扣|订单|奖励|处罚|违规|审核|提现|申诉|取消|修改|冻结)/.test(s);
    if (isUrgeOnly) return;
    const isDup = seen.some((prev) => bigramSim(prev, s) > 0.55); // Q2 重复表达不重复计算
    if (isDup) return;
    seen.push(s);
    demands.push({ text: s, evidence: s, source_msg: msg ? msg.raw_role + '：' + msg.text : '', is_emotion_only: false });
  };
  for (const msg of driverMsgs) {
    for (const sentence of splitSentences(msg.text)) {
      // Q6：可独立处理的复合诉求应拆分（"奖励未到账，而且金额少了 30 元"）
      for (const part of sentence.split(COMPOUND_SPLIT)) pushDemand(part);
      // 整句也作为一个候选（句内含"而且"但两侧都不足 4 字等边界情况）
      if (sentence.includes('而且') || sentence.includes('并且') || sentence.includes('同时')) pushDemand(sentence);
    }
  }
  if (!demands.length) {
    // 无信号词时退化为司机首条消息（Q7 主诉求兜底，但标注主次待确认）
    const first = driverMsgs[0];
    if (first) demands.push({ text: first.text, evidence: first.text, source_msg: first.raw_role + '：' + first.text, is_emotion_only: false });
  }
  return demands.map((d, i) => ({
    key: 'dm' + (i + 1),
    description: d.text,
    evidence: d.evidence,
    source_msg: d.source_msg,
    is_primary: i === 0,
    demand_type: '业务查询类',
    primary_pending: demands.length > 1,
    is_emotion_only: !!d.is_emotion_only,
  }));
}

function classifyDemandType(text) {
  if (/申诉|不认可|不同意|撤销|判责|处罚|违规/.test(text)) return '判责争议类';
  if (/为什么|什么原因|导致|异常|出错|错误|算错/.test(text)) return '异常处理类';
  if (/如何|怎么|怎样|步骤|操作|修改|提交|取消/.test(text)) return '操作指导类';
  if (/规则|怎么算|计算|标准|条件/.test(text)) return '规则咨询类';
  return '业务查询类';
}

// ---------- I1-I6 意图检测 ----------

function nameCoreMatch(name, text) {
  // 用标准名称的核心词与诉求做字符覆盖，避免长定义稀释相似度
  const core = String(name || '').replace(/(咨询|异常|处理|问题|类|服务)$/, '');
  if (!core) return 0;
  const sim = bigramSim(core, text);
  const chars = core.split('');
  const hit = chars.filter((c) => text.includes(c)).length / chars.length;
  return Math.max(sim, hit * 0.6);
}

function evalIntent(demand, input, standards, ruleRefs) {
  const intentName = String(input.intent_name || input.intent_id || '').trim();
  const hasIntentLabel = !!intentName;
  const def = standards.find((s) => s.type === 'intent_def' && s.status === '已生效' && (s.name === intentName || String(s.id) === String(input.intent_id) || (s.intent_id && String(s.intent_id) === String(input.intent_id))));
  ruleRefs.push('I3');

  if (!hasIntentLabel) {
    return { conclusion: 'n_a', error_type: null, reason: '原系统未输出意图，标记检测对象信息缺失', standard_ref: null, rule_refs: ['I3'], u: { code: 'U09', item: '主意图准确性', missing: '原系统意图记录', owner: '数据提供方' } };
  }
  if (!def) {
    // I3：无意图定义及边界标准时，不得仅凭标签字面意思正式判定
    return { conclusion: 'u', error_type: 'standard_unclear', reason: '标准库中无该意图的定义及适用边界，按 I3 仅记录现象不正式判定', standard_ref: null, rule_refs: ['I3'], u: { code: 'U01', item: '主意图准确性', missing: '意图「' + intentName + '」的定义与边界标准', owner: '业务规则负责人' } };
  }
  const score = nameCoreMatch(def.name, demand.description);
  if (score >= 0.35) {
    return { conclusion: 'correct', error_type: null, reason: '原意图与真实主诉求在标准定义范围内匹配（核心词覆盖 ' + score.toFixed(2) + '）', standard_ref: def.id + '@' + def.version, rule_refs: ['I2'], u: null };
  }
  // I4/B1：次诉求未被识别——原系统多意图支持情况未知时，记录为覆盖能力差距，不计入识别错误
  if (!demand.is_primary) {
    return {
      conclusion: 'missed', error_type: 'omission',
      reason: '次诉求「' + demand.description.slice(0, 24) + '」未被原意图覆盖。原系统是否设计为多意图识别未知，按 I4/B1 记录为覆盖能力差距（待确认），不计入模型识别错误',
      standard_ref: def.id + '@' + def.version, rule_refs: ['I4', 'B1'], u: null,
    };
  }
  return { conclusion: 'wrong', error_type: 'recognition_error', reason: '原意图与真实主诉求不匹配（核心词覆盖 ' + score.toFixed(2) + '），存在更明确适用的诉求指向', standard_ref: def.id + '@' + def.version, rule_refs: ['I2'], u: null };
}

// ---------- S1-S7 场景检测 ----------

function evalScene(demand, input, standards, ruleRefs) {
  const sceneName = String(input.scene_name || input.scene_id || '').trim();
  const def = standards.find((s) => s.type === 'scene_def' && s.status === '已生效' && (s.name === sceneName || String(s.id) === String(input.scene_id) || (s.scene_id && String(s.scene_id) === String(input.scene_id))));
  ruleRefs.push('S3');
  if (!sceneName) {
    return { independent: 'u', conditional: 'u', conclusion: 'u', reason: '原系统未输出命中场景，检测对象信息缺失', standard_ref: null, rule_refs: ['S3'], u: { code: 'U09', item: '场景匹配', missing: '原系统场景记录', owner: '数据提供方' } };
  }
  if (!def) {
    // S3：不得因场景名称与意图名称相似判定匹配正确
    return { independent: 'u', conditional: 'u', conclusion: 'u', reason: '标准库中无该场景的定义，按 S3 不因名称相似判定匹配', standard_ref: null, rule_refs: ['S3'], u: { code: 'U02', item: '场景匹配', missing: '场景「' + sceneName + '」的定义', owner: '业务规则负责人' } };
  }
  const sim = nameCoreMatch(def.name, demand.description);
  const independent = sim >= 0.35 ? 'correct' : 'wrong';
  const conditional = independent;
  return { independent, conditional, conclusion: independent, reason: '按真实诉求独立判断场景匹配（核心词覆盖 ' + sim.toFixed(2) + '）', standard_ref: def.id + '@' + def.version, rule_refs: ['S1', 'S3'], u: null };
}

// ---------- D1-D12 七维度 ----------

const RISK_PATTERNS = [/保证.{0,6}到账/, /一定(会|能)?(退|到账|赔)/, /全额(赔|退)/, /肯定(能|会)/, /没问题(的|，|,)?.{0,4}(退|到账)/, /无需(担心|害怕)/, /100%/];
const FACT_PATTERNS = [/订?单\s*(号|编号|id)?\s*[:#]?\s*\w{4,}/i, /\d+\s*元/, /账号|账户/, /\d{4}-\d{2}-\d{2}/, /查到|查询到|显示|系统记录/, /在?(审核|处理|发放|冻结)中/, /批次/];
const CAUSE_PATTERNS = [/因为/, /原因是/, /由于/, /导致/, /属于/, /判定为/];
const JUDGE_PATTERNS = [/根据.{0,12}(规则|规定|政策)/, /按(照)?[^。]{0,8}(规则|规定|政策)/, /符合.{0,8}(条件|规则)/, /应当|应予/];
const PLAN_PATTERNS = [/第一步/, /然后/, /最后/, /您可以?通过/, /路径/, /步骤/, /进入.{0,10}(页面|入口|app|小程序)/, /提交/, /申诉/, /可在?[^。]{0,14}(查看|查询|明细|入口)/, /通过[^。]{0,10}(提交|申诉|申请)/];
const EXEC_PATTERNS = [/app|小程序|页面|入口|客服中心|司机端/];
const L1_PATTERNS = [/耐心等待/, /请稍等/, /请稍后/, /核实一下/, /请联系/, /以页面显示为准/, /暂时无法/];

function evalSolution(aiReply, sessionText, demand, standards, ruleRefs) {
  const reply = String(aiReply || '').trim();
  const dims = {};
  const keyErrors = [];
  const uReasons = [];

  if (!reply) {
    return {
      dimensions: {},
      overall_level: 'u', level_reason: '缺少 AI 建议回复原文，方案质量检测对象缺失',
      key_errors: [], u_reasons: [{ code: 'U09', item: '方案质量整体', missing: 'AI 建议回复', owner: '数据提供方' }],
      standard_refs: [], rule_refs: ['D9'],
    };
  }

  // D7 风险控制（一票否决）
  const riskHit = RISK_PATTERNS.find((p) => p.test(reply));
  dims.risk = riskHit
    ? { level: 'fail', note: '命中风险模式「' + riskHit.source + '」：存在错误承诺或误导嫌疑', rule: 'D7' }
    : { level: 'pass', note: '未发现已确认的错误承诺或误导表述', rule: 'D7' };
  if (riskHit) keyErrors.push({ dim: 'risk', rule: 'D7', detail: '命中风险模式「' + riskHit.source + '」' });

  // D1 事实充分性：是否引用该司机的特定事实
  const specificFact = FACT_PATTERNS.find((p) => p.test(reply)) && /元|订单|账号|账户|显示|查到/.test(reply);
  dims.fact = specificFact
    ? { level: 'pass', note: 'AI 建议引用了该司机的具体状态信息', rule: 'D1' }
    : { level: 'weak', note: '未见该司机的特定事实引用，可能为通用描述（需结合证据复核）', rule: 'D1' };

  // D2 原因分析
  const causeHit = CAUSE_PATTERNS.find((p) => p.test(reply));
  dims.cause = causeHit
    ? { level: 'pass', note: '包含原因说明（信号：' + causeHit.source + '）', rule: 'D2' }
    : { level: 'weak', note: '未形成有证据的原因判断', rule: 'D2' };

  // D3 业务判断
  const judgeHit = JUDGE_PATTERNS.find((p) => p.test(reply));
  dims.judgment = judgeHit
    ? { level: 'pass', note: '包含基于规则的业务判断（信号：' + judgeHit.source + '）', rule: 'D3' }
    : { level: 'weak', note: '未见基于有效规则的判断表述', rule: 'D3' };

  // D4 处理方案：仅当问题类型需要处理路径时，缺步骤才构成关键错误（D4 典型不达标：缺步骤/缺分支/缺责任归属）
  const needsPath = ['异常处理类', '操作指导类', '判责争议类'].includes(demand.demand_type);
  const planHit = PLAN_PATTERNS.find((p) => p.test(reply));
  if (planHit) dims.plan = { level: 'pass', note: '包含处理路径/步骤（信号：' + planHit.source + '）', rule: 'D4' };
  else if (needsPath) { dims.plan = { level: 'fail', note: '该问题类型需要处理路径，但 AI 只给方向未给路径：缺步骤、责任或分支', rule: 'D4' }; keyErrors.push({ dim: 'plan', rule: 'D4', detail: '未提供可执行的处理步骤（' + demand.demand_type + '必须有路径）' }); }
  else dims.plan = { level: 'weak', note: '未提供操作步骤（该问题类型以状态说明与规则解释为主，步骤非必需，见 D4 边界）', rule: 'D4' };

  // D5 可执行性
  const execHit = EXEC_PATTERNS.find((p) => p.test(reply));
  dims.executability = execHit
    ? { level: 'pass', note: '指向可定位的操作入口', rule: 'D5' }
    : { level: 'weak', note: '未见明确操作入口，可执行性待复核', rule: 'D5' };

  // D6 沟通交付（支撑维度）
  dims.communication = { level: reply.length >= 30 ? 'pass' : 'weak', note: reply.length >= 30 ? '内容长度与结构可支持直接转述' : '内容过短，可能无法直接转述', rule: 'D6' };

  // 回复规则标准缺失检查（U04）
  const hasReplyRule = standards.some((s) => (s.type === 'reply_rule' || s.type === 'checklist') && s.status === '已生效');
  if (!hasReplyRule) {
    uReasons.push({ code: 'U04', item: '回复业务规则', missing: '该场景的回复规则/检查清单', owner: '业务规则负责人' });
  }

  // L1 信号
  const l1Hit = L1_PATTERNS.find((p) => p.test(reply));
  const pathNeeded = ['异常处理类', '操作指导类', '判责争议类'].includes(demand.demand_type);
  const strengthKeys = ['fact', 'cause', 'judgment', 'executability'].concat(pathNeeded ? ['plan'] : []);
  const strengthScore = strengthKeys.reduce((n, k) => n + (dims[k].level === 'pass' ? 1 : 0), 0);

  return {
    dimensions: dims,
    overall_level: null, // 由 gradeLevel 统一判
    level_reason: null,
    key_errors: keyErrors,
    u_reasons: uReasons,
    l1_signal: l1Hit ? l1Hit.source : null,
    strength_score: strengthScore,
    strength_total: strengthKeys.length,
    demand_type: demand.demand_type,
    standard_refs: [],
    rule_refs: ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'],
  };
}

// ---------- G1-G12 判级 ----------

function gradeLevel(solution, ruleRefs) {
  const dims = solution.dimensions;
  // G1 关键错误 → L0
  if (dims.risk && dims.risk.level === 'fail') {
    ruleRefs.push('G1', 'D8');
    return { level: 'L0', reason: '风险控制维度（D7）存在已确认问题，一票否决并倾向 L0（B5）', rule_refs: ['G1', 'D8', 'B5'] };
  }
  // G2 关键维度缺必要证据 → U
  if (solution.u_reasons && solution.u_reasons.length) {
    ruleRefs.push('G2', 'D9');
    return { level: 'U', reason: '关键判断缺少必要标准/证据（' + solution.u_reasons.map((u) => u.code).join('、') + '），按 P4 不强判', rule_refs: ['G2', 'D9', 'P4'], u_reasons: solution.u_reasons };
  }
  // D8：处理方案维度 fail 视为关键错误 → 无 U 项时 L0；有 U 项时错误照记、整体保持 U（UR4）
  if (dims.plan && dims.plan.level === 'fail') {
    if (!(solution.u_reasons || []).length) {
      ruleRefs.push('D8');
      return { level: 'L0', reason: '处理方案维度（D4）存在明确缺口：未提供可执行路径，属方向性不完整', rule_refs: ['D8', 'G1'] };
    }
    ruleRefs.push('D8', 'UR4');
    return { level: 'U', reason: '处理方案维度（D4）存在明确缺口，但关键判断同时缺少必要证据（' + (solution.u_reasons || []).map((u) => u.code).join('、') + '）：错误照记，整体按 G2 拒判', rule_refs: ['D8', 'UR4', 'G2'], u_reasons: solution.u_reasons };
  }
  const score = solution.strength_score || 0;
  const total = solution.strength_total || 4;
  const l1 = solution.l1_signal;
  const commPass = dims.communication && dims.communication.level === 'pass';
  // G4 第四步：无需重新分析，客服只需转述/确认/执行已明确的步骤
  if (score >= total && commPass && !l1) {
    ruleRefs.push('G4', 'G6');
    return { level: 'L3', reason: '自检三问通过：司机问题有事实引用、原因判断、规则依据与可定位入口，客服可直接转述（规则引擎预判，须人工复核确认）', rule_refs: ['G4', 'G6'] };
  }
  // G3 第三步：仍需人工重新分析
  if (l1 || score <= Math.max(1, Math.floor(total * 0.5))) {
    ruleRefs.push('G3', 'G8');
    return { level: 'L1', reason: l1 ? 'AI 仅提供相关信息（命中 L1 信号「' + l1 + '」），未形成处理判断' : 'AI 输出与该诉求关联但未形成实质处理判断（' + score + '/' + total + ' 项信号）', rule_refs: ['G3', 'G8', 'P1'] };
  }
  ruleRefs.push('G3', 'G5');
  return { level: 'L2', reason: 'AI 已完成部分实质工作（' + score + '/' + total + ' 项信号），但客服仍需补充关键查询或确认后才能处理', rule_refs: ['G3', 'G5'] };
}

// ---------- W1-W4 剩余工作 ----------

function residualWork(solution, level) {
  const dims = solution.dimensions || {};
  const pass = (k) => dims[k] && dims[k].level === 'pass';
  const w = {
    query: pass('fact') ? 'ai_done' : 'manual',
    analysis: pass('cause') ? 'ai_done' : 'manual',
    decision: pass('judgment') && pass('plan') ? 'ai_done' : 'manual',
    communication: pass('communication') ? 'ai_done' : 'manual',
    execution: 'manual',
  };
  // W2 组合合法性：L3 时查询/分析/判断/沟通不得为 manual
  if (level === 'L3') {
    for (const k of ['query', 'analysis', 'decision', 'communication']) {
      if (w[k] === 'manual') w[k] = 'u';
    }
  }
  return w;
}

// ---------- A1-A6 归因 ----------

function attribution(intentEval, sceneEval, solution, level) {
  const direct = [];
  const cascade = [];
  if (intentEval.conclusion === 'wrong') direct.push({ type: '诉求理解问题', rule: 'I2', detail: intentEval.reason });
  if (intentEval.conclusion === 'u') direct.push({ type: '检测证据不足', rule: 'I3', detail: intentEval.reason });
  if (sceneEval.conclusion === 'wrong') direct.push({ type: '场景问题', rule: 'S1', detail: sceneEval.reason });
  if (solution.key_errors && solution.key_errors.length) {
    for (const e of solution.key_errors) direct.push({ type: e.dim === 'risk' ? 'AI 回复问题' : '方案决策不足', rule: e.rule, detail: e.detail });
  }
  // A5 连锁影响：意图错 → 场景/回复错 记连锁
  if (intentEval.conclusion === 'wrong' && (sceneEval.conclusion === 'wrong' || (solution.key_errors || []).length)) {
    cascade.push('意图识别错误可能导致场景匹配与 AI 回复偏离司机原始诉求（连锁影响，场景与回复结论仍独立给出）');
  }
  let root = null;
  if (intentEval.conclusion === 'wrong') root = { text: '意图识别偏差（有证据链：原意图≠真实诉求）', confidence: 'confirmed' };
  else if (direct.length) root = { text: '待进一步定位', confidence: 'possible' };
  return { direct_issues: direct, root_cause: root, cascade };
}

// ---------- 会话结果信号（B7：只记录不评价） ----------

function resultSignals(messages) {
  const driverMsgs = messages.filter((m) => m.role === 'driver');
  const signals = [];
  const last = driverMsgs[driverMsgs.length - 1];
  if (last) {
    if (/谢谢|感谢|好的|行吧|明白了|了解了/.test(last.text)) signals.push({ type: '司机明确接受', evidence: last.text.slice(0, 60) });
    if (!/(未到账|为什么|怎么办|还是|仍然|依旧|再问|追问)/.test(last.text) && driverMsgs.length >= 2) signals.push({ type: '未再追问', evidence: '司机最后一轮未提出新的问题' });
  }
  return signals;
}

// ---------- 规则模式主流程 ----------

function runRuleEngine(input, standards) {
  const ruleRefs = [];
  const { messages } = completenessCheck(input);
  const demands = extractDemands(messages);
  const sessionText = messages.map((m) => m.text).join(' ');
  const results = [];

  for (const d of demands) {
    d.demand_type = classifyDemandType(d.description);
    const intentEval = evalIntent(d, input, standards, ruleRefs);
    const sceneEval = evalScene(d, input, standards, ruleRefs);
    const solution = evalSolution(input.ai_reply, sessionText, d, standards, ruleRefs);
    // 意图/场景检测的 U 并入方案级 U 原因（G2：任一关键维度缺必要证据 → 整体 U）
    for (const u of [intentEval.u, sceneEval.u]) {
      if (u && u.code && !solution.u_reasons.some((x) => x.code === u.code)) solution.u_reasons.push(u);
    }
    const graded = gradeLevel(solution, ruleRefs);
    const level = graded.level;
    const work = residualWork(solution, level);
    const attr = attribution(intentEval, sceneEval, solution, level);
    results.push({
      demand: d,
      intent_eval: intentEval,
      scene_eval: sceneEval,
      solution_eval: {
        dimensions: solution.dimensions,
        overall_level: level,
        level_reason: graded.reason,
        level_rule_refs: graded.rule_refs,
        key_errors: solution.key_errors,
        u_reasons: graded.u_reasons || [],
        standard_refs: [],
      },
      residual_work: work,
      attribution: attr,
      // O2 诉求级汇总
      demand_summary: level === 'L3' ? '链路通过' : level === 'U' ? '整体无法判断' : '链路未通过',
    });
  }

  // O3 会话级汇总
  const anyError = results.some((r) => r.solution_eval.overall_level === 'L0' || r.intent_eval.conclusion === 'wrong' || r.scene_eval.conclusion === 'wrong');
  const anyU = results.some((r) => r.solution_eval.overall_level === 'U' || r.intent_eval.conclusion === 'u' || r.scene_eval.conclusion === 'u');
  const sessionSummary = anyError ? '存在已确认问题' : anyU ? '整体无法判断' : '检测通过';

  return {
    mode: 'rule',
    demands: results,
    session_summary: sessionSummary,
    result_signals: resultSignals(messages),
    rule_refs: Array.from(new Set(ruleRefs)),
    disclaimer: '规则引擎模式：以上为启发式预判，未接入大模型，结论必须经人工复核确认后方可作为正式评价（G9：不能因未发现错误而下结论）。',
  };
}

// ---------- LLM 模式 ----------

const LLM_SYSTEM = `你是「客服 AI 解决能力价值评估」检测引擎。你的任务是：以原始客服会话为事实输入，独立还原司机真实诉求，评价 AI 建议回复是否构成一套正确、完整、有依据、可直接交付给客服使用的处理方案。

评价纪律（必须严格遵守）：
P1 关联不等于有效：AI 仅提到相关知识/规则/方向，不构成解决能力证据。
P2 答案正确不等于方案完整：必须针对当前诉求提供事实依据、分析判断与处理动作。
P3 完整方案不等于实际执行成功：方案可交付不认定问题已解决。
P4 缺少依据不能强行判断：缺标准/事实/证据 → U，不得自行推断补齐。
P5 以真实诉求为评价起点：先还原司机真实问题，再评价系统结果。

判级四步路径（按顺序执行，第一步命中即定）：
G1 存在已确认关键错误（事实错误/违规建议/错误承诺/方向性错误）→ L0
G2 关键维度缺少必要证据（标准/事实/规则缺失）→ U（必须带原因代码 U01-U09）
G3 客服仍需重新分析如何处理？有实质价值输出→L2；仅相关信息/通用规则/查询入口→L1
G4 客服只需转述/确认/执行已明确的步骤 → L3
L3 自检三问（全部通过）：①司机问题原因与处理方式已明确 ②方案覆盖全部必要环节（前提/分支/司机侧动作）③不存在需要客服自行查证的关键未知。

七维度（事实充分性/原因分析/业务判断/处理方案/可执行性/沟通交付/风险控制），前六项中风险控制为一票否决项。任一关键维度错误→不得 L3；任一关键维度无法判断→U。整体必须是整体判断，不得用维度平均分抵消关键问题。

U 原因代码：U01 意图标准缺失 U02 场景标准缺失 U03 关联规则缺失 U04 回复业务规则缺失 U05 标准冲突 U06 对话证据不足 U07 转写内容不明确 U08 业务条件不足 U09 检测对象信息缺失。

常见误判（禁止）：把语气好当 L3；把提到正确规则当 L2/L3；把没发现错误当 L3；把司机说谢谢当 L3；把步骤长当完整；把相关当有效。

如果你判断关键材料缺失、无法形成可靠判定，且缺失项可以通过提问补齐（例如缺少该司机的订单事实、缺少业务规则），返回 need_input 与具体问题列表（questions 数组，每项含 field、ask、canMarkNA）。否则直接返回报告。

报告 JSON 结构（严格遵守字段名）：
{
  "demands": [{"description":"诉求描述","is_primary":true,"evidence":"司机原话片段","demand_type":"规则咨询类|业务查询类|操作指导类|异常处理类|判责争议类","primary_pending":false}],
  "intent_eval": {"conclusion":"correct|wrong|missed|system_missing|standard_unclear|n_a","error_type":"recognition_error|omission|system_missing|standard_unclear|null","reason":"...","evidence":"...","standard_ref":"...","u":{"code":"U01","item":"...","missing":"...","owner":"..."}},
  "scene_eval": {"independent":"correct|wrong|u","conditional":"correct|wrong|u","conclusion":"correct|wrong|u","reason":"...","u":{"code":"U02","item":"...","missing":"...","owner":"..."}},
  "solution_eval": {
    "dimensions": {"fact":{"level":"pass|weak|fail|u","note":"..."},"cause":{...},"judgment":{...},"plan":{...},"executability":{...},"communication":{...},"risk":{...}},
    "overall_level":"L0|L1|L2|L3|U","level_reason":"...","key_errors":[{"dim":"risk","rule":"D7","detail":"..."}],"u_reasons":[{"code":"U04","item":"...","missing":"...","owner":"..."}]
  },
  "residual_work": {"query":"ai_done|manual|not_needed|u","analysis":"...","decision":"...","communication":"...","execution":"..."},
  "attribution": {"direct_issues":[{"type":"九类问题类型之一","rule":"规则编号","detail":"..."}],"root_cause":{"text":"...","confidence":"confirmed|possible"},"cascade":["..."]},
  "rule_refs": ["D7","G1"]
}
注意：conclusion/level 等枚举值只能取给定值；reason 必须引用会话证据或标准；不得输出 JSON 以外的任何内容。`;

async function callLLM(config, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(config.base_url.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.api_key },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('LLM HTTP ' + res.status);
    const data = await res.json();
    return data.choices[0].message.content;
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(text) {
  const t = String(text || '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('LLM 未返回 JSON');
  return JSON.parse(t.slice(start, end + 1));
}

// LLM 通道的标准库组装：尺子类标准（意图/场景/映射/Skill）按与本次输入的相关性展开全文，
// 不相关的只给名称索引——意图库上百条时全量展开会撑爆 prompt 且稀释注意力。
function buildStandardText(standards, input) {
  const eff = standards.filter((s) => s.status === '已生效');
  if (!eff.length) return '（标准库为空）';
  const FILTERABLE = ['intent_def', 'scene_def', 'mapping', 'skill_def', 'skill_scene'];
  const iName = String(input.intent_name || '').trim();
  const sName = String(input.scene_name || '').trim();
  const related = (s) => {
    if (!FILTERABLE.includes(s.type)) return true;
    const n = String(s.name || '');
    return (iName.length >= 2 && (n.includes(iName) || iName.includes(n))) ||
           (sName.length >= 2 && (n.includes(sName) || sName.includes(n))) ||
           (s.intent_id && String(s.intent_id) === String(input.intent_id)) ||
           (s.scene_id && String(s.scene_id) === String(input.scene_id));
  };
  const full = eff.filter(related);
  const idxOnly = eff.filter((s) => !related(s));
  const lines = full.map((s) => '[' + s.type + '] ' + s.name + '（v' + s.version + '）：' + s.content);
  if (idxOnly.length) {
    lines.push('【其余标准名称索引（与本次输入不直接相关，未展开全文）】' +
      idxOnly.map((s) => s.type + ':' + s.name).join('；'));
  }
  return lines.join('\n');
}

async function runLLMEngine(input, standards, config) {
  const standardText = buildStandardText(standards, input);
  const userContent = [
    '【原始会话】\n' + input.session_text,
    '【系统识别意图】' + (input.intent_id || '') + ' / ' + (input.intent_name || '（未提供）'),
    '【命中场景】' + (input.scene_id || '') + ' / ' + (input.scene_name || '（未提供）'),
    '【AI 建议回复】\n' + (input.ai_reply || '（未提供）'),
    '【执行结果（可选）】' + (input.exec_result || '（未提供）'),
    '【生效标准库】\n' + standardText,
    '【输入补充说明】' + (input.supplements ? JSON.stringify(input.supplements) : '无'),
  ].join('\n\n');
  const raw = await callLLM(config, [
    { role: 'system', content: LLM_SYSTEM },
    { role: 'user', content: userContent },
  ]);
  const parsed = extractJson(raw);
  if (parsed.need_input) {
    return { status: 'need_input', questions: parsed.questions || [], mode: 'llm' };
  }
  // 规整为统一报告结构
  const demands = (parsed.demands || []).map((d, i) => ({
    key: 'dm' + (i + 1),
    description: d.description, evidence: d.evidence, is_primary: !!d.is_primary,
    demand_type: d.demand_type || '业务查询类', primary_pending: !!d.primary_pending, source_msg: '',
  }));
  const perDemand = {
    demand: demands[0] || { description: '（未还原）', evidence: '', is_primary: true },
    intent_eval: parsed.intent_eval || {},
    scene_eval: parsed.scene_eval || {},
    solution_eval: parsed.solution_eval || {},
    residual_work: parsed.residual_work || {},
    attribution: parsed.attribution || {},
    demand_summary: null,
  };
  if (!demands.length) demands.push(perDemand.demand);
  const results = demands.map((d) => Object.assign({}, perDemand, { demand: d }));
  const anyError = results.some((r) => r.solution_eval.overall_level === 'L0' || r.intent_eval.conclusion === 'wrong' || r.scene_eval.conclusion === 'wrong');
  const anyU = results.some((r) => r.solution_eval.overall_level === 'U' || r.intent_eval.conclusion === 'u' || r.scene_eval.conclusion === 'u');
  return {
    status: 'done',
    mode: 'llm',
    demands: results,
    session_summary: anyError ? '存在已确认问题' : anyU ? '整体无法判断' : '检测通过',
    result_signals: resultSignals(parseMessages(input.session_text)),
    rule_refs: parsed.rule_refs || [],
    disclaimer: '大模型检测模式：结论由模型按规则清单生成，仍须人工复核确认。',
  };
}

// ---------- 统一入口 ----------

// 把追问环节的补充值合并回输入（__NA__ 表示用户标记为缺失/不适用，不并入）
function mergeSupplements(input) {
  const sup = input.supplements || {};
  const out = Object.assign({}, input);
  const na = (v) => v === '__NA__';
  if (sup.session_text && !na(sup.session_text)) out.session_text = sup.session_text;
  if (sup.ai_reply && !na(sup.ai_reply)) out.ai_reply = sup.ai_reply;
  if (sup.intent && !na(sup.intent)) {
    if (/^\d+$/.test(sup.intent)) { out.intent_id = out.intent_id || sup.intent; }
    else out.intent_name = out.intent_name || sup.intent;
  }
  if (sup.scene && !na(sup.scene)) {
    if (/^\d+$/.test(sup.scene)) { out.scene_id = out.scene_id || sup.scene; }
    else out.scene_name = out.scene_name || sup.scene;
  }
  return out;
}

async function analyze(rawInput, standards, llmConfig) {
  const input = mergeSupplements(rawInput);
  // R1 完整性：阻断级缺失（原始会话 / AI 建议）先追问——缺什么问什么，用户可补充或标记缺失
  const { messages, missing } = completenessCheck(input);
  const BLOCKING_FIELDS = ['session_text', 'ai_reply'];
  const supplements = rawInput.supplements || {};
  const markedNA = Object.keys(supplements).filter((k) => supplements[k] === '__NA__');
  const blocking = missing.filter((m) => BLOCKING_FIELDS.includes(m.field) && !markedNA.includes(m.field));

  if (blocking.length) {
    return { status: 'need_input', mode: 'precheck', questions: blocking, note: '开始检测前需要先确认关键材料（R1-R2：缺失会记入材料缺失清单，不补造）' };
  }

  if (llmConfig && llmConfig.base_url && llmConfig.api_key && llmConfig.model) {
    try {
      const r = await runLLMEngine(input, standards, llmConfig);
      if (r.status === 'need_input') return r;
      return Object.assign({ status: 'done' }, r);
    } catch (e) {
      const rule = runRuleEngine(input, standards);
      rule.llm_error = '大模型调用失败，已降级为规则引擎：' + e.message;
      return Object.assign({ status: 'done' }, rule);
    }
  }
  const rule = runRuleEngine(input, standards);
  return Object.assign({ status: 'done' }, rule);
}

module.exports = { analyze, parseMessages, runRuleEngine, completenessCheck, mergeSupplements };
