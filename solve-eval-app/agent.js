'use strict';
/*
 * 解决力评估 · 评估助手（Agent）
 * 双通道：规则路由（零依赖，开箱即用） + 大模型工具调用（设置页配置后启用，失败自动降级）
 * 通过对话即可获取平台数据信息与分析结论，也可在对话中直接提交一段会话做检测，
 * 还可维护材料（意图库/场景库/映射/Skill/案例/清单/规则）——所有材料变更自动记版本、可回滚。
 * 助手自身配置（系统提示词/路由规则/能力清单/技能知识库/展示）在「助手配置」视图维护。
 */
const M = require('./materials');

const DETECT_TRIGGER = /(检测|评估|分析|判断|跑一下|测一下|看看这)/;
const ROLE_LINE = /^(司机|客服|AI|系统|转写|语音)\s*[:：]/;
const CMD_PREFIX = /^\s*(?:帮我|请|麻烦)?(?:检测|评估|分析|判断|跑一下|测一下|看看这)[^：:\n]{0,16}[：:]\s*/;
// 大模型调用超时（毫秒）：健康时几秒返回；故障挂起时及时降级到规则引擎，避免接口无限等待
const LLM_TIMEOUT_MS = 45000;

/* ---------- 助手配置（系统提示词 / 路由规则 / 能力清单 / 技能知识库 / 展示） ---------- */

const DEFAULT_AGENT_CONFIG = {
  system_prompt: '你是「解决力评估」平台的问答与材料维护助手。用中文简洁回答，给出数字与口径；需要平台数据时调用工具；不知道就说不知道，不要编造数字。用户要求维护材料（意图库/场景库/映射/Skill/案例/清单/规则）时，调用 update_material 工具执行，并说明变更内容与产生的版本号；用户要求查看或回滚版本时，用 get_dataset_versions / rollback_material。',
  rules: [
    { key: 'detect', name: '对话中直接检测', trigger: '含「检测/评估」且带「司机：」开头内容，或粘贴 ≥2 行角色会话', desc: '识别到待检测会话即提交检测', enabled: true },
    { key: 'material_update', name: '材料维护指令', trigger: '新增/修改/删除/导入 + 意图/场景/映射/Skill/案例/清单/规则', desc: '执行材料增删改，自动记版本', enabled: true },
    { key: 'material_version', name: '材料版本查询/回滚', trigger: '版本/历史/回滚 + 材料类型', desc: '查看版本历史；回滚需二次确认', enabled: true },
    { key: 'materials', name: '材料就绪度查询', trigger: '材料/需要提供/模板/就绪/跑通', desc: '返回材料就绪度与缺口', enabled: true },
    { key: 'help', name: '帮助与能力清单', trigger: '帮助/你能/怎么用/会什么', desc: '返回能力清单', enabled: true },
    { key: 'conclusion', name: '分析结论', trigger: '结论/分析一下/总体情况/总结/建议', desc: '生成分析结论', enabled: true },
    { key: 'reviews', name: '复核队列', trigger: '复核/待复核/积压/队列/优先', desc: '复核六态与优先队列', enabled: true },
    { key: 'by_intent', name: '按意图下钻', trigger: '意图', desc: '按意图的等级分布与 L3 率', enabled: true },
    { key: 'by_scene', name: '按场景下钻', trigger: '场景', desc: '按场景的等级分布与 L3 率', enabled: true },
    { key: 'u_reasons', name: 'U 原因分布', trigger: '无法判断/拒判/U0/判不了', desc: '无法判断原因分布', enabled: true },
    { key: 'work', name: '人工剩余工作', trigger: '人工/替代/剩余工作/工时', desc: '各环节 AI 完成率', enabled: true },
    { key: 'attribution', name: '问题归因', trigger: '归因/根因/主要问题', desc: '已确认问题分布', enabled: true },
    { key: 'standards', name: '标准库查询', trigger: '标准/尺子/清单/意图库/场景库/规则库', desc: '标准库分类统计', enabled: true },
    { key: 'search', name: '会话检索', trigger: '会话/记录/搜/查一下', desc: '按关键词检索会话', enabled: true },
    { key: 'export', name: '导出指引', trigger: '导出/下载', desc: '导出入口指引', enabled: true },
    { key: 'overview', name: '指标总览', trigger: '完整方案/L3/总体/多少/什么情况', desc: '核心指标总览', enabled: true },
    { key: 'fallback', name: '兜底建议', trigger: '未命中任何路由', desc: '给出问法建议', enabled: true },
  ],
  capabilities: [
    { key: 'qa', name: '数据问答', desc: '指标总览、按意图/场景下钻、U 原因分布、问题归因、人工剩余工作、复核队列' },
    { key: 'materials_query', name: '材料就绪度', desc: '各类材料的达标情况、缺口与提供格式' },
    { key: 'detect', name: '对话中直接检测', desc: '粘贴一段会话即可跑检测并落入复核台' },
    { key: 'material_update', name: '材料维护', desc: '新增/修改/删除意图、场景、映射、Skill、案例、清单、规则——自动记版本，可回滚' },
    { key: 'version', name: '版本管理', desc: '查看材料版本历史与变更明细，回滚到指定版本' },
    { key: 'search', name: '会话检索与导出', desc: '按关键词搜索历史会话，指引导出入口' },
  ],
  knowledge: [],
  presentation: {
    greeting: '你好，我是解决力评估助手。',
    welcome_sub: '问我数据（指标/分布/队列），让我检测一段会话，或者让我维护材料（意图库/场景库/映射/Skill/案例/清单/规则）——材料变更会自动记版本，可随时回滚。',
    help: '我是解决力评估助手。你可以直接用大白话问我，例如：\n·「当前完整方案可交付率是多少？」\n·「无法判断的原因分布？」\n·「待复核还有多少？优先处理哪些？」\n·「按意图看一下 L3 率」\n·「搜索会话：奖励」\n·「检测这段对话：司机：… 意图：… 场景：… AI建议：…」\n·「给我分析结论」\n·「导出检测结果」\n·「新增意图：堵车导致违规，定义：因道路客观原因导致的违规判罚申诉」\n·「意图库的版本历史」「把意图库回滚到 v2」',
  },
};

function ensureAgentConfig(storage) {
  let c = storage.byId('agent_configs', 'default');
  if (!c) c = storage.insert('agent_configs', Object.assign({}, DEFAULT_AGENT_CONFIG, { id: 'default' }));
  return c;
}

function getAgentConfig(storage) {
  const c = ensureAgentConfig(storage);
  const cfg = Object.assign({}, DEFAULT_AGENT_CONFIG, c);
  cfg.rules = Array.isArray(c.rules) && c.rules.length ? c.rules : DEFAULT_AGENT_CONFIG.rules;
  cfg.capabilities = Array.isArray(c.capabilities) && c.capabilities.length ? c.capabilities : DEFAULT_AGENT_CONFIG.capabilities;
  cfg.knowledge = Array.isArray(c.knowledge) ? c.knowledge : [];
  cfg.presentation = Object.assign({}, DEFAULT_AGENT_CONFIG.presentation, c.presentation || {});
  return cfg;
}

function looksLikeDetect(m) {
  if (DETECT_TRIGGER.test(m) && /司机\s*[:：]/.test(m)) return true;
  // 直接粘贴多轮会话（至少两行角色内容）也视为检测请求
  return m.split(/\r?\n/).filter((l) => ROLE_LINE.test(l.trim())).length >= 2;
}

/* ---------- 从对话消息中解析一段待检测会话 ---------- */
function parseDetectPayload(message) {
  const cleaned = message.replace(CMD_PREFIX, '');
  const lines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sessionLines = [];
  let intent = '', scene = '', aiReply = '', exec = '';
  for (const line of lines) {
    if (ROLE_LINE.test(line)) { sessionLines.push(line); continue; }
    const m = line.match(/^(意图|系统意图)\s*[:：]\s*(.+)$/); if (m) { intent = m[2].trim(); continue; }
    const s = line.match(/^(场景|命中场景)\s*[:：]\s*(.+)$/); if (s) { scene = s[2].trim(); continue; }
    const a = line.match(/^(AI\s*建议|AI\s*答复|建议回复|建议)\s*[:：]\s*(.+)$/); if (a) { aiReply = a[2].trim(); continue; }
    const e = line.match(/^(执行结果|结果)\s*[:：]\s*(.+)$/); if (e) { exec = e[2].trim(); continue; }
  }
  if (!sessionLines.length) {
    // 兜底：去掉命令前缀后仍有实质内容（含司机相关表述），按会话原文处理
    if (/司机/.test(cleaned) && cleaned.length >= 12) {
      return { session_text: cleaned, intent_name: intent, scene_name: scene, ai_reply: aiReply, exec_result: exec, source_type: /转写|语音/.test(message) ? 'asr' : 'text' };
    }
    return null;
  }
  return {
    session_text: sessionLines.join('\n'),
    intent_name: intent, scene_name: scene, ai_reply: aiReply, exec_result: exec,
    source_type: /转写|语音/.test(message) ? 'asr' : 'text',
  };
}

/* ---------- 材料就绪度（Q3：保证平台能跑通需要的信息） ---------- */
const MATERIAL_DEFS = [
  { key: 'intent_def', name: '意图库（意图定义）', target: 10, why: '没有意图定义与边界，引擎只能拒判（U01），无法评价意图准确性', format: 'CSV/JSON：类型=意图定义，名称，定义内容（含什么/排除什么/边界）', get: (d) => d.standards.intent_def_effective },
  { key: 'scene_def', name: '场景库（场景定义）', target: 5, why: '没有场景定义，场景匹配只能拒判（U02）', format: 'CSV/JSON：类型=场景定义，名称，适用与排除条件', get: (d) => d.standards.scene_def_effective },
  { key: 'mapping', name: '意图-场景映射规则', target: 5, why: '缺少映射关系无法判断场景该不该命中（U03）', format: '类型=映射，名称=意图名→场景名，内容=映射依据', get: (d) => d.standards.mapping_effective },
  { key: 'checklist', name: '场景检查清单', target: 3, why: '检查清单是「完整方案」的尺子：每类问题必须答到什么程度', format: '类型=检查清单，名称=场景名，内容=逐条检查项', get: (d) => d.standards.checklist_effective },
  { key: 'reply_rule', name: '业务规则（到账时效/计算规则/处理规则）', target: 3, why: '没有规则无法判断 AI 答复的正确性（U04）', format: '类型=回复规则，名称=规则名，内容=规则原文+生效时间', get: (d) => d.standards.reply_rule_effective },
  { key: 'cases', name: '正负案例（好答复 vs 坏答复）', target: 6, why: '案例是判定 L3/L1 的参照系，也是人工基准样本的种子', format: '类型=正案例/负案例，名称=场景，内容=答复原文+为什么好/坏', get: (d) => d.standards.cases_effective },
  { key: 'sessions', name: '真实会话样本（含系统结果）', target: 20, why: '没有真实会话无法验证检测效果，样本要覆盖各类意图与难度', format: '批量导入 CSV：会话内容/意图/场景/AI建议 每行一条', get: (d) => d.samples.sessions },
  { key: 'baseline', name: '人工确认的基准样本', target: 10, why: 'N 检测自身的准确率只能用人工基准样本衡量（防止自证）', format: '在复核台对样本逐条确认/修正，即自动成为基准样本', get: (d) => d.samples.baseline },
  { key: 'asr', name: '语音转写样本', target: 5, why: '验证转写文本场景下的检测表现与数据质量风险（U07）', format: '来源类型选「语音转写」的会话', get: (d) => d.samples.asr },
];

function materialsReadiness(deps) {
  const std = deps.storage.list('standards');
  const sessions = deps.storage.list('sessions').filter((s) => s.count_in_stats !== false);
  const reviews = deps.storage.list('reviews');
  const reviewedSessionIds = new Set(reviews.filter((r) => ['已复核', '已裁决'].includes(r.status)).map((r) => r.session_id));
  const eff = (t) => std.filter((s) => s.type === t && s.status === '已生效').length;
  const data = {
    standards: {
      intent_def_effective: eff('intent_def'), scene_def_effective: eff('scene_def'),
      mapping_effective: eff('mapping'), checklist_effective: eff('checklist'),
      reply_rule_effective: eff('reply_rule'), cases_effective: eff('case_positive') + eff('case_negative'),
    },
    samples: {
      sessions: sessions.length,
      baseline: sessions.filter((s) => reviewedSessionIds.has(s.id)).length,
      asr: sessions.filter((s) => s.source_type === 'asr').length,
    },
  };
  const items = MATERIAL_DEFS.map((m) => {
    const current = m.get(data);
    return { key: m.key, name: m.name, why: m.why, format: m.format, current, target: m.target, ready: current >= m.target };
  });
  const readyCount = items.filter((i) => i.ready).length;
  return { items, readyCount, total: items.length, pct: Math.round((readyCount / items.length) * 100) };
}

/* ---------- 分析结论生成（模板驱动，规则模式） ---------- */
function buildConclusion(stats, materials) {
  const o = stats.overview;
  if (!o.demand_count) return '平台还没有检测数据。先去检测台粘贴一段会话，或批量导入历史会话，我再给你分析结论。';
  const parts = [];
  parts.push('当前共检测 ' + o.session_count + ' 条会话、' + o.demand_count + ' 个诉求。');
  parts.push('完整方案可交付率（L3）' + (o.l3_delivery_rate == null ? '暂无可评价样本' : o.l3_delivery_rate + '%（' + o.level_count.L3 + '/' + o.evaluable + '）') + '，有效辅助覆盖率 ' + (o.effective_assist_rate == null ? '—' : o.effective_assist_rate + '%') + '。');
  const attrs = Object.entries(stats.attribution).sort((a, b) => b[1] - a[1]);
  if (attrs.length) parts.push('已确认问题最集中的是「' + attrs[0][0] + '」（' + attrs[0][1] + ' 处）。');
  const us = Object.entries(stats.u_reasons).sort((a, b) => b[1] - a[1]);
  if (us.length) parts.push('无法判断（U）占比 ' + (o.u_rate == null ? '—' : o.u_rate + '%') + '，Top 原因是 ' + us[0][0] + '（' + us[0][1] + ' 处）——这是标准/证据缺口，不是 AI 的错，优先补对应材料。');
  const pending = stats.review_status['待复核'] || 0;
  if (pending) parts.push('还有 ' + pending + ' 条待人工复核，其中优先队列建议先处理 U 与 L0。');
  if (materials.readyCount < materials.total) parts.push('材料就绪度 ' + materials.pct + '%（' + materials.readyCount + '/' + materials.total + '），还缺：' + materials.items.filter((i) => !i.ready).map((i) => i.name).join('、') + '。补齐后检测覆盖率和结论可信度会明显上升。');
  else parts.push('材料就绪度 100%，检测口径完整，可以扩大样本量做统计结论了。');
  return parts.join('');
}

/* ---------- 材料维护（对话中增删改材料，自动记版本） ---------- */

function detectDataset(m) {
  if (/(skill|Skill).{0,6}(映射|对应)|(映射|对应).{0,6}(skill|Skill)/i.test(m)) return 'skill_scenes';
  if (/(映射|对应关系)/.test(m)) return 'mappings';
  if (/skill/i.test(m)) return 'skills';
  if (/意图/.test(m)) return 'intents';
  if (/场景/.test(m)) return 'scenes';
  if (/案例/.test(m)) return 'cases';
  if (/清单/.test(m)) return 'checklists';
  if (/规则/.test(m)) return 'reply_rules';
  if (/(样本|会话)/.test(m)) return 'sessions';
  return null;
}

function parseMaterialOp(m) {
  // ① 粘贴了意图库树形 JSON（{"intents":[...]}）→ 直接导入
  const blob = m.match(/\{[\s\S]*"intents"\s*:\s*\[[\s\S]*\}/);
  if (blob) {
    try {
      const tree = JSON.parse(blob[0]);
      if (Array.isArray(tree.intents) && tree.intents.length) return { kind: 'import_tree', tree };
    } catch (e) { /* 不是完整 JSON，继续按指令解析 */ }
  }
  // ② 增删改指令
  if (!/(新增|添加|增加|录入|导入|修改|更新|改成|改为|调整为|删除|移除|去掉)/.test(m)) return null;
  const action = /(删除|移除|去掉)/.test(m) ? 'remove' : /(修改|更新|改成|改为|调整为)/.test(m) ? 'update' : 'add';
  const dataset = detectDataset(m);
  if (!dataset) return null;
  // 名称：优先「」/"" 包裹；否则取「数据集词 + 冒号」后第一段
  let name = '';
  const q = m.match(/[「『"]([^」』"]{1,60})[」』"]/);
  if (q) name = q[1].trim();
  if (!name) {
    const c = m.match(/(?:意图|场景|映射|对应关系|skill|案例|清单|规则|样本)[^「』"'\n]{0,6}[：:]\s*([^，,。；;\n]{1,60})/i);
    if (c) name = c[1].trim();
  }
  if (!name) return null;
  // 内容：定义/内容/规则/说明/依据 冒号后的全部（允许「定义改成：」这类夹带）
  const cm = m.match(/(?:定义|内容|规则|说明|依据)[^。\n]{0,8}[：:]\s*([\s\S]+)$/);
  const content = cm ? cm[1].trim().replace(/[。\s]+$/, '') : '';
  return { kind: 'op', dataset, action, record: { name, content } };
}

function applyMaterialOp(op, deps, trace) {
  const operator = deps.storage.getSetting('operator', '') || '';
  if (op.kind === 'import_tree') {
    const r = M.importIntentTree(deps.storage, op.tree, { source: '评估助手', operator });
    if (r.error) return { intent: 'material_update', trace, reply: '意图库导入失败：' + r.error, blocks: [] };
    return {
      intent: 'material_update', trace: trace.concat('助手导入意图库'),
      reply: '意图库已更新：新增 ' + r.added + ' 条、更新 ' + r.updated + ' 条、无变化 ' + r.skipped + ' 条，共 ' + r.total + ' 条三级意图。意图库版本 → v' + r.version + '（材料中心可查看版本历史与回滚）。',
      blocks: [{ type: 'text', data: '导入来源：对话粘贴的意图库 JSON。引擎按「已生效」的意图定义参与意图识别。' }],
      actions: [{ label: '打开材料中心', view: 'materials' }],
    };
  }
  const ds = M.datasetByKey(op.dataset);
  if (!ds) return { intent: 'material_update', trace, reply: '未知材料类型。', blocks: [] };
  if (ds.special === 'sessions') {
    return {
      intent: 'material_update', trace, blocks: [],
      reply: '真实会话样本请通过检测台「批量导入」积累，或直接把会话贴给我说「检测」——不支持在对话里直接增删样本。',
      actions: [{ label: '去检测台批量导入', view: 'detect' }],
    };
  }
  const std = deps.storage.list('standards');
  const findRec = () => std.find((s) => ds.types.includes(s.type) && (s.name === op.record.name || (op.record.intent_id && String(s.intent_id) === String(op.record.intent_id))));
  if (op.action === 'remove') {
    const rec = findRec();
    if (!rec) return { intent: 'material_update', trace, blocks: [], reply: '「' + ds.name + '」里没有找到「' + op.record.name + '」，请核对名称。' };
    deps.storage.remove('standards', rec.id);
    const v = M.commitDataset(deps.storage, ds.key, { note: '助手删除：' + op.record.name, source: '评估助手', operator });
    return {
      intent: 'material_update', trace: trace.concat('删除材料 ' + op.record.name), blocks: [],
      reply: '已从「' + ds.name + '」删除「' + op.record.name + '」。「' + ds.name + '」版本 → v' + v.version + '，可在材料中心回滚。',
      actions: [{ label: '打开材料中心', view: 'materials' }],
    };
  }
  if (op.action === 'update') {
    const rec = findRec();
    if (!rec) return { intent: 'material_update', trace, blocks: [], reply: '「' + ds.name + '」里没有找到「' + op.record.name + '」。如果是新内容，请说「新增…」。' };
    const patch = { name: op.record.name };
    if (op.record.content) { patch.content = op.record.content; patch.version = (rec.version || 1) + 1; }
    deps.storage.update('standards', rec.id, patch);
    const v = M.commitDataset(deps.storage, ds.key, { note: '助手更新：' + op.record.name, source: '评估助手', operator });
    return {
      intent: 'material_update', trace: trace.concat('更新材料 ' + op.record.name), blocks: [],
      reply: '已更新「' + ds.name + '」中的「' + op.record.name + '」' + (op.record.content ? '（内容已替换，记录版本 v' + ((rec.version || 1) + 1) + '）' : '') + '。「' + ds.name + '」版本 → v' + v.version + '。',
      actions: [{ label: '打开材料中心', view: 'materials' }],
    };
  }
  // add
  const rec = { type: ds.types[0], name: op.record.name, content: op.record.content || '', status: op.record.status || '草稿' };
  const res = M.upsertStandard(deps.storage, rec, { source: '评估助手' });
  const v = M.commitDataset(deps.storage, ds.key, { note: '助手' + (res.action === 'updated' ? '更新' : '新增') + '：' + op.record.name, source: '评估助手', operator });
  const statusNote = res.action === 'updated' ? '同名材料已存在，已按新内容更新' : '已新增为「草稿」——在标准库点「生效」后参与检测（尺子生效纪律）';
  return {
    intent: 'material_update', trace: trace.concat('新增材料 ' + op.record.name), blocks: [],
    reply: '「' + ds.name + '」-' + op.record.name + '：' + statusNote + '。「' + ds.name + '」版本 → v' + v.version + '。',
    actions: [{ label: '打开标准库', view: 'standards' }, { label: '打开材料中心', view: 'materials' }],
  };
}

/* ---------- 规则路由 ---------- */
function ruleRoute(message, deps) {
  const m = message.trim();
  const stats = deps.computeStats();
  const materials = materialsReadiness(deps);
  const cfg = getAgentConfig(deps.storage);
  const ruleMap = {};
  for (const r of cfg.rules) ruleMap[r.key] = r;
  const on = (k) => !ruleMap[k] || ruleMap[k].enabled !== false;
  const trace = ['规则路由'];

  // 1. 对话中直接提交检测
  if (on('detect') && looksLikeDetect(m)) {
    const payload = parseDetectPayload(m);
    if (payload) return { intent: 'detect', payload, trace: trace.concat('识别到待检测会话') };
  }

  // 1.5 材料维护（先于材料查询/标准库路由，避免「意图库」抢路由）
  if (on('material_update')) {
    const op = parseMaterialOp(m);
    if (op) return applyMaterialOp(op, deps, trace);
  }

  // 1.6 材料版本查询 / 回滚（先于标准库路由）
  if (on('material_version') && /(版本|历史|回滚|变更记录)/.test(m)) {
    // 数据集定位：消息带了库名用库名；没带则看哪些库有版本记录——唯一就直接用，多个先问，都没有就提示
    let dsKey = detectDataset(m);
    if (!dsKey) {
      const withVer = M.DATASETS.filter((d) => M.getVersions(deps.storage, d.key).length > 0);
      if (withVer.length === 1) dsKey = withVer[0].key;
      else if (withVer.length > 1) {
        return {
          intent: 'material_version', trace, blocks: [],
          reply: '有版本记录的库目前有：' + withVer.map((d) => '「' + d.name + '」').join('、') + '。要查/回滚哪个库？比如说「意图库的版本历史」或「场景库回滚到 v2」。',
        };
      } else {
        return {
          intent: 'material_version', trace, blocks: [],
          reply: '各库还没有版本记录——导入材料或做增删改后，会自动生成第一个版本。',
        };
      }
    }
    const ds = M.datasetByKey(dsKey);
    const rollM = m.match(/回滚到\s*v?\s*(\d+)/) || m.match(/恢复到\s*v?\s*(\d+)/);
    if (rollM) {
      // 指令明确（带版本号）即执行：回滚本身会记一个新版本，可再回滚回去，无需二次确认
      const target = Number(rollM[1]);
      const v = deps.storage.list('material_versions').find((x) => x.dataset === dsKey && x.version === target);
      if (!v) {
        const avail = M.getVersions(deps.storage, dsKey);
        return { intent: 'material_version', trace, blocks: [], reply: '没找到「' + ds.name + '」的 v' + target + '，可用版本：' + (avail.length ? avail.map((x) => 'v' + x.version).join('、') : '（暂无）') + '。' };
      }
      const r = M.rollback(deps.storage, v.id, { operator: deps.storage.getSetting('operator', '') || '' });
      if (r.error) return { intent: 'material_version', trace, blocks: [], reply: '回滚失败：' + r.error };
      return {
        intent: 'material_version', trace: trace.concat('回滚 ' + ds.name + ' → v' + target), blocks: [],
        reply: '已把「' + ds.name + '」回滚到 v' + target + '，恢复 ' + r.restored + ' 条记录。回滚本身也记了新版本 v' + r.version + '——想反悔，回滚到 v' + (r.version - 1) + ' 即可。',
        actions: [{ label: '打开材料中心', view: 'materials' }],
      };
    }
    if (/(回滚|恢复|撤销)/.test(m)) {
      const vs = M.getVersions(deps.storage, dsKey).slice(0, 5);
      return {
        intent: 'material_version', trace, blocks: [],
        reply: vs.length
          ? '要回滚「' + ds.name + '」到哪个版本？最近的是：' + vs.map((x) => 'v' + x.version + '（' + (x.created_at || '').slice(0, 10) + '，' + x.note + '）').join('、') + '。告诉我版本号即可，例如「' + ds.name + '回滚到 v' + vs[0].version + '」。回滚会生成新版本，随时能回去。'
          : '「' + ds.name + '」还没有版本记录，暂时无法回滚。',
        actions: [{ label: '打开材料中心', view: 'materials' }],
      };
    }
    const all = M.getVersions(deps.storage, dsKey);
    const vs = all.slice(0, 8);
    return {
      intent: 'material_version', trace: trace.concat('版本历史：' + ds.name),
      reply: vs.length
        ? '「' + ds.name + '」当前 v' + vs[0].version + '，共 ' + all.length + ' 个版本，最近的如下：\n' +
          vs.map((v) => '· v' + v.version + '（' + (v.created_at || '').slice(0, 10) + ' · ' + v.source + '）' + v.note + ' —— 增 ' + v.changes.added + ' / 改 ' + v.changes.updated + ' / 删 ' + v.changes.removed).join('\n')
        : '「' + ds.name + '」还没有版本记录，导入或增删改后会自动生成。',
      blocks: [{ type: 'text', data: '在材料中心「版本管理」面板可查看每个版本的明细并回滚。' }],
      actions: [{ label: '打开材料中心', view: 'materials' }],
    };
  }

  // 2. 材料相关
  if (on('materials') && /(材料|需要提供|提供什么|模板|怎么提供|就绪|跑通|初始化)/.test(m)) {
    return {
      intent: 'materials', trace: trace.concat('材料就绪度查询'),
      reply: '材料就绪度 ' + materials.pct + '%（' + materials.readyCount + '/' + materials.total + ' 项达标）。下面是每一项的状态、为什么需要、以及提供格式——已在「材料中心」视图提供可下载模板。',
      blocks: [{ type: 'materials', data: materials }],
      actions: [{ label: '打开材料中心', view: 'materials' }],
    };
  }

  // 3. 帮助
  if (on('help') && /(帮助|你能|功能|怎么用|怎么问|会什么)/.test(m)) {
    return {
      intent: 'help', trace: trace.concat('能力清单'),
      reply: cfg.presentation.help || DEFAULT_AGENT_CONFIG.presentation.help,
      blocks: [{ type: 'text', data: '当前能力：\n' + cfg.capabilities.map((c) => '· ' + c.name + '：' + c.desc).join('\n') }],
    };
  }

  // 4. 分析结论
  if (on('conclusion') && /(结论|分析一下|总体情况|整体情况|怎么看|总结|建议)/.test(m)) {
    return { intent: 'conclusion', trace: trace.concat('生成分析结论'), reply: buildConclusion(stats, materials), blocks: [{ type: 'text', data: '以上结论由当前平台数据实时生成；样本量越大越接近真实水平。' }], actions: [{ label: '查看数据看板', view: 'board' }] };
  }

  // 5. 复核队列（先于总览，避免「待复核还有多少」被「多少」抢路由）
  if (on('reviews') && /(复核|待复核|积压|队列|优先)/.test(m)) {
    const rs = stats.review_status;
    const list = deps.storage.list('reviews').filter((r) => r.status === '待复核').slice(0, 5);
    return {
      intent: 'reviews', trace: trace.concat('复核队列'),
      reply: '复核六态：' + Object.entries(rs).map(([k, v]) => k + ' ' + v).join(' · ') + '。优先队列 = U / L0 / 主次待确认的样本。',
      blocks: [{ type: 'review_queue', data: list.map((r) => ({ review_id: r.id, priority: r.priority, status: r.status })) }],
      actions: [{ label: '打开人工复核台', view: 'review' }],
    };
  }

  // 6. 按意图（先于总览，避免「按意图看 L3 率」被「L3」抢路由）
  if (on('by_intent') && /(意图)/.test(m)) {
    const by = stats.by_intent;
    const rows = Object.entries(by).sort((a, b) => (b[1].total - a[1].total)).slice(0, 8);
    return {
      intent: 'by_intent', trace: trace.concat('按意图下钻'),
      reply: '主意图准确率 ' + (stats.link_quality.intent_accuracy == null ? '—' : stats.link_quality.intent_accuracy + '%') + '（' + stats.link_quality.intent_evaluable + ' 条可评价）。按意图的完整方案率如下（按样本量取前 8）：',
      blocks: [{ type: 'table', data: { head: ['意图', '样本', 'L3', 'L2', 'L1', 'L0', 'U', 'L3率'], rows: rows.map(([k, v]) => [k, v.total, v.L3, v.L2, v.L1, v.L0, v.U, v.l3_rate == null ? '—' : v.l3_rate + '%']) } }],
      actions: [{ label: '查看数据看板', view: 'board' }],
    };
  }

  // 7. 按场景
  if (on('by_scene') && /(场景)/.test(m)) {
    const by = stats.by_scene;
    const rows = Object.entries(by).sort((a, b) => (b[1].total - a[1].total)).slice(0, 8);
    return {
      intent: 'by_scene', trace: trace.concat('按场景下钻'),
      reply: '场景匹配准确率 ' + (stats.link_quality.scene_accuracy == null ? '—' : stats.link_quality.scene_accuracy + '%') + '（' + stats.link_quality.scene_evaluable + ' 条可评价）。按场景的完整方案率如下：',
      blocks: [{ type: 'table', data: { head: ['场景', '样本', 'L3', 'L2', 'L1', 'L0', 'U', 'L3率'], rows: rows.map(([k, v]) => [k, v.total, v.L3, v.L2, v.L1, v.L0, v.U, v.l3_rate == null ? '—' : v.l3_rate + '%']) } }],
    };
  }

  // 8. 无法判断
  if (on('u_reasons') && /(无法判断|拒判|U0|标准缺失|为什么.{0,4}U|判不了)/.test(m)) {
    const us = Object.entries(stats.u_reasons).sort((a, b) => b[1] - a[1]);
    const uNames = { U01: '意图标准缺失', U02: '场景标准缺失', U03: '关联规则缺失', U04: '回复业务规则缺失', U05: '标准冲突', U06: '对话证据不足', U07: '转写不明确', U08: '业务条件不足', U09: '检测对象信息缺失' };
    return {
      intent: 'u_reasons', trace: trace.concat('U 原因分布'),
      reply: us.length ? '共 ' + stats.overview.level_count.U + ' 个诉求无法判断，占 ' + (stats.overview.u_rate == null ? '—' : stats.overview.u_rate + '%') + '。Top 原因：' + us.slice(0, 3).map(([k, v]) => k + ' ' + (uNames[k] || '') + '（' + v + '）').join('；') + '。U 是治理输入不是失败，优先补对应标准。' : '当前没有无法判断的样本。',
      blocks: us.length ? [{ type: 'bars', data: us.map(([k, v]) => ({ label: k + ' ' + (uNames[k] || ''), value: v })) }] : [],
      actions: [{ label: '去复核台处理 U 样本', view: 'review', preset: { reviewStatus: '待复核' } }],
    };
  }

  // 9. 人工剩余工作
  if (on('work') && /(人工|替代|剩余工作|还要人|节省|工时)/.test(m)) {
    const ws = stats.work_stats;
    return {
      intent: 'work', trace: trace.concat('人工剩余工作'),
      reply: '各工作环节中「AI 已完成」占比（一期为能力评价，不等于实际节省工时）：',
      blocks: [{ type: 'table', data: { head: ['工作环节', 'AI已完成', '人工仍需', '本次不需要', '无法判断', 'AI完成率'], rows: Object.values(ws).map((w) => [w.label, w.ai_done, w.manual, w.not_needed, w.u, w.total ? Math.round((w.ai_done / w.total) * 100) + '%' : '—']) } }],
    };
  }

  // 10. 归因
  if (on('attribution') && /(归因|根因|主要问题|问题.{0,4}(最多|集中)|哪类问题)/.test(m)) {
    const attrs = Object.entries(stats.attribution).sort((a, b) => b[1] - a[1]);
    return {
      intent: 'attribution', trace: trace.concat('问题归因'),
      reply: attrs.length ? '已确认直接问题分布（Top）：' + attrs.slice(0, 5).map(([k, v]) => k + ' ' + v + ' 处').join('；') + '。根因只统计「已确认」，连锁影响不重复计。' : '当前没有已确认问题。',
      blocks: attrs.length ? [{ type: 'bars', data: attrs.slice(0, 6).map(([k, v]) => ({ label: k, value: v })) }] : [],
      actions: [{ label: '去数据看板看第四层', view: 'board' }],
    };
  }

  // 11. 标准库
  if (on('standards') && /(标准|尺子|清单|意图库|场景库|规则库)/.test(m)) {
    const std = deps.storage.list('standards');
    const groups = {};
    for (const s of std) groups[s.type] = (groups[s.type] || 0) + 1;
    return {
      intent: 'standards', trace: trace.concat('标准库查询'),
      reply: '标准库共 ' + std.length + ' 条：' + Object.entries(groups).map(([k, v]) => k + ' ' + v).join(' · ') + '。尺子缺失时引擎拒判而不是硬猜。',
      actions: [{ label: '打开标准库', view: 'standards' }, { label: '查看材料就绪度', view: 'materials' }],
    };
  }

  // 12. 会话检索
  if (on('search') && /(会话|记录|搜|查一下|找一下)/.test(m)) {
    const colonIdx = Math.max(m.lastIndexOf('：'), m.lastIndexOf(':'));
    const kw = colonIdx >= 0 ? m.slice(colonIdx + 1).trim() : m.replace(/^(搜索|查一下|找一下|搜|会话|记录)\s*/, '').trim();
    const sessions = deps.storage.list('sessions').slice().reverse().filter((s) => !kw || (s.raw_text || '').includes(kw) || (s.intent_name || '').includes(kw) || (s.scene_name || '').includes(kw)).slice(0, 6);
    return {
      intent: 'search', trace: trace.concat('会话检索: ' + (kw || '全部')),
      reply: sessions.length ? '找到 ' + sessions.length + ' 条相关会话（最多显示 6 条）：' : '没有找到相关会话' + (kw ? '（关键词：' + kw + '）' : '') + '。',
      blocks: sessions.length ? [{ type: 'sessions', data: sessions.map((s) => ({ id: s.id, intent_name: s.intent_name || '（缺失）', preview: (s.raw_text || '').slice(0, 50) })) }] : [],
      actions: [{ label: '打开全盘记录', view: 'records' }],
    };
  }

  // 13. 导出
  if (on('export') && /(导出|下载| excel|csv)/i.test(m)) {
    return {
      intent: 'export', trace: trace.concat('导出指引'),
      reply: '在全盘记录页有导出按钮（会话/检测/复核/材料清单，支持 JSON 与 CSV）。也可以直接点下面的链接：',
      blocks: [{ type: 'export_links' }],
      actions: [{ label: '打开全盘记录', view: 'records' }],
    };
  }

  // 14. 指标总览（放在意图/场景/复核之后，避免抢路由）
  if (on('overview') && /(完整方案|可交付|L3|解决能力|总体|整体|概览|指标|多少|什么情况|怎么样)/.test(m)) {
    const o = stats.overview;
    return {
      intent: 'overview', trace: trace.concat('指标总览'),
      reply: '当前完整方案可交付率（L3）' + (o.l3_delivery_rate == null ? '暂无可评价样本' : '**' + o.l3_delivery_rate + '%**（' + o.level_count.L3 + '/' + o.evaluable + ' 可评价）') + '；有效辅助覆盖率 ' + (o.effective_assist_rate == null ? '—' : o.effective_assist_rate + '%') + '；无法判断率 ' + (o.u_rate == null ? '—' : o.u_rate + '%') + '。',
      blocks: [{ type: 'kpi', data: stats.overview }, { type: 'levels', data: stats.overview.level_count }],
      actions: [{ label: '查看数据看板', view: 'board' }],
    };
  }

  // 15. 兜底
  if (!on('fallback')) return { intent: 'off', trace: trace.concat('路由已全部关闭'), reply: '所有对话路由都已在助手配置里关闭。请在「助手配置」中启用需要的路由规则。', blocks: [] };
  return {
    intent: 'fallback', trace: trace.concat('未命中，给出建议'),
    reply: '我没理解这个问题。试试这些问法：「完整方案可交付率」「无法判断的原因」「待复核多少」「按意图看 L3 率」「搜索会话：奖励」「检测这段对话：司机：…」「给我分析结论」。',
    blocks: [{ type: 'text', data: '如果你配置了大模型（设置页），我会用大模型理解更自由的说法。' }],
  };
}

/* ---------- 大模型通道 ---------- */
const TOOLS_DESC = [
  { name: 'get_overview', desc: '总体指标：L3可交付率、有效辅助率、U率、会话/诉求数' },
  { name: 'get_by_intent', desc: '按意图的等级分布与L3率' },
  { name: 'get_by_scene', desc: '按场景的等级分布与L3率' },
  { name: 'get_u_reasons', desc: '无法判断(U)的原因分布' },
  { name: 'get_reviews', desc: '复核队列状态' },
  { name: 'get_work_stats', desc: '人工剩余工作各环节AI完成率' },
  { name: 'get_attribution', desc: '问题归因分布' },
  { name: 'get_materials', desc: '材料就绪度与缺口' },
  { name: 'search_sessions', desc: '按关键词搜索会话，参数 keyword' },
  { name: 'run_detection', desc: '检测一段会话，参数 session_text/intent_name/scene_name/ai_reply' },
  { name: 'list_datasets', desc: '材料数据集清单：各资料库（意图库/场景库/映射/Skill/案例/清单/规则/样本）的条数与当前版本' },
  { name: 'get_dataset_versions', desc: '某个材料库的版本历史，参数 dataset（intents/scenes/mappings/skills/skill_scenes/cases/checklists/reply_rules/sessions）' },
  { name: 'update_material', desc: '维护一条材料，参数 dataset/action(add|update|remove)/record{name,content,status?}；新增默认草稿' },
  { name: 'rollback_material', desc: '回滚材料库到某版本，参数 dataset/version；用户没说版本号时先调 get_dataset_versions 看历史，不要猜' },
];

function materialToolCall(name, args, deps) {
  const a = args || {};
  const operator = deps.storage.getSetting('operator', '') || '';
  if (name === 'list_datasets') return M.datasetSummary(deps.storage);
  if (name === 'get_dataset_versions') {
    const key = String(a.dataset || 'intents');
    if (!M.datasetByKey(key)) return { error: '未知数据集：' + key + '，可用：' + M.DATASETS.map((d) => d.key).join('/') };
    return M.getVersions(deps.storage, key).slice(0, 20);
  }
  if (name === 'update_material') {
    const ds = M.datasetByKey(String(a.dataset || ''));
    if (!ds) return { error: '未知数据集：' + a.dataset + '，可用：' + M.DATASETS.map((d) => d.key).join('/') };
    if (ds.special === 'sessions') return { error: '会话样本请走检测台批量导入，不支持直接增删' };
    const action = ['add', 'update', 'remove'].includes(a.action) ? a.action : null;
    if (!action) return { error: 'action 必须是 add/update/remove' };
    const record = a.record || {};
    if (!record.name) return { error: 'record.name 不能为空' };
    const op = { kind: 'op', dataset: ds.key, action, record: { name: String(record.name), content: record.content ? String(record.content) : '', status: record.status } };
    const r = applyMaterialOp(op, deps, ['大模型通道']);
    return { ok: true, dataset: ds.key, action, name: record.name, reply: r.reply };
  }
  if (name === 'rollback_material') {
    const key = String(a.dataset || '');
    const ver = Number(a.version || 0);
    const v = deps.storage.list('material_versions').find((x) => x.dataset === key && x.version === ver);
    if (!v) return { error: '找不到「' + key + '」的 v' + ver };
    const r = M.rollback(deps.storage, v.id, { operator });
    return r.error ? { error: r.error } : { ok: true, dataset: key, restored: r.restored, new_version: r.version };
  }
  return { error: 'unknown tool' };
}

function toolCall(name, args, deps) {
  const stats = deps.computeStats();
  if (['list_datasets', 'get_dataset_versions', 'update_material', 'rollback_material'].includes(name)) {
    return materialToolCall(name, args, deps);
  }
  switch (name) {
    case 'get_overview': return stats.overview;
    case 'get_by_intent': return stats.by_intent;
    case 'get_by_scene': return stats.by_scene;
    case 'get_u_reasons': return stats.u_reasons;
    case 'get_reviews': return stats.review_status;
    case 'get_work_stats': return stats.work_stats;
    case 'get_attribution': return stats.attribution;
    case 'get_materials': return materialsReadiness(deps);
    case 'search_sessions': {
      const kw = String((args || {}).keyword || '');
      return deps.storage.list('sessions').slice(-10).reverse().filter((s) => !kw || (s.raw_text || '').includes(kw)).map((s) => ({ id: s.id, intent: s.intent_name, preview: (s.raw_text || '').slice(0, 60) }));
    }
    case 'run_detection': return { need_ui: true, payload: args };
    default: return { error: 'unknown tool' };
  }
}

async function llmChat(message, deps) {
  const llm = deps.getLlmConfig();
  const stats = deps.computeStats();
  const cfg = getAgentConfig(deps.storage);
  const snapshot = JSON.stringify({ overview: stats.overview, link_quality: stats.link_quality, review_status: stats.review_status, u_reasons: stats.u_reasons, attribution: stats.attribution });
  const knowledgeText = cfg.knowledge.length
    ? '\n技能知识库（维护在助手配置中）：\n' + cfg.knowledge.map((k) => '· ' + (k.title || '') + '：' + (k.content || '')).join('\n')
    : '';
  const sys = cfg.system_prompt +
    '\n平台数据快照：' + snapshot +
    '\n可用工具：' + JSON.stringify(TOOLS_DESC) + knowledgeText +
    '\n规则：1) 需要数据时先只返回 JSON {"tool":"工具名","args":{...}}，不要解释；2) 拿到工具结果后用中文简洁回答，给出数字与口径；3) 用户粘贴了会话原文并要求检测时，返回 {"tool":"run_detection","args":{...}}；4) 用户要求维护材料时返回 {"tool":"update_material","args":{...}}；5) 不知道就说不知道，不要编造数字。';
  const body = {
    model: llm.model,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: message }],
    temperature: 0.2,
  };
  const doFetch = async (b) => {
    // 超时控制：LLM 故障时（如服务端挂起）及时中断并降级，避免整个接口无限等待
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('LLM_TIMEOUT')), LLM_TIMEOUT_MS);
    try {
      const res = await fetch(llm.base_url.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + llm.api_key },
        body: JSON.stringify(b),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error('LLM HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (e && (e.message === 'LLM_TIMEOUT' || e.name === 'AbortError' || e.name === 'TimeoutError')) {
        throw new Error('大模型 ' + Math.round(LLM_TIMEOUT_MS / 1000) + ' 秒无响应（疑似服务端故障或网络中断）');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
  let r1 = await doFetch(body);
  let c1 = (r1.choices && r1.choices[0] && r1.choices[0].message && r1.choices[0].message.content || '').trim();
  const toolMatch = c1.match(/\{[\s\S]*"tool"[\s\S]*\}/);
  if (toolMatch) {
    let call;
    try { call = JSON.parse(toolMatch[0]); } catch (e) { /* not json */ }
    if (call && call.tool) {
      const result = toolCall(call.tool, call.args, deps);
      if (result.need_ui) {
        return { intent: 'detect', payload: result.payload, reply: '大模型识别到一段待检测会话，正在提交检测…', trace: ['大模型通道', '工具调用: run_detection'] };
      }
      const r2 = await doFetch({
        model: llm.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: message },
          { role: 'assistant', content: c1 },
          { role: 'user', content: '工具 ' + call.tool + ' 返回：' + JSON.stringify(result) + '\n请用中文简洁回答，附数字与口径。' },
        ],
        temperature: 0.2,
      });
      const c2 = (r2.choices && r2.choices[0] && r2.choices[0].message && r2.choices[0].message.content || '').trim();
      return { intent: 'llm_' + call.tool, reply: c2 || '（大模型未返回内容）', blocks: [], trace: ['大模型通道', '工具调用: ' + call.tool] };
    }
  }
  return { intent: 'llm_direct', reply: c1 || '（大模型未返回内容）', blocks: [], trace: ['大模型通道', '直接回答'] };
}

/* ---------- 对外入口 ---------- */
function createAgent(deps) {
  async function chat(message) {
    const m = String(message || '').trim();
    if (!m) return { reply: '请输入你的问题。', blocks: [], trace: [] };
    const llm = deps.getLlmConfig();
    if (llm.base_url && llm.api_key && llm.model) {
      try {
        const r = await llmChat(m, deps);
        if (r.intent === 'detect') return Object.assign(r, { mode: 'llm' });
        return r;
      } catch (e) {
        const fallback = ruleRoute(m, deps);
        fallback.reply = '（大模型调用失败：' + e.message + '，已自动降级为规则引擎）\n' + fallback.reply;
        fallback.trace = fallback.trace.concat('大模型降级');
        return fallback;
      }
    }
    return ruleRoute(m, deps);
  }
  return {
    chat,
    materialsReadiness: () => materialsReadiness(deps),
    buildConclusion: (s) => buildConclusion(s, materialsReadiness(deps)),
    getAgentConfig: () => getAgentConfig(deps.storage),
  };
}

module.exports = { createAgent, materialsReadiness, MATERIAL_DEFS, getAgentConfig, ensureAgentConfig, DEFAULT_AGENT_CONFIG };
