'use strict';
/*
 * 材料中心 · 资料数据集与版本管理
 *
 * 数据集（dataset）= 材料中心管理的一类资料：
 *   意图库 / 场景库 / 意图-场景映射 / Skill 库 / Skill-场景映射 /
 *   正负案例 / 场景检查清单 / 业务规则 / 真实会话样本
 * 前 8 类落在 standards 集合（按 type 区分），会话样本落在 sessions 集合。
 *
 * 版本纪律：任何变更（导入 / 人工增删改 / 评估助手更新）都必须走 commitDataset
 *   落一个版本——版本号按数据集自增，记录变更明细与当时全量快照，支持回滚。
 *   快照只保留每个数据集最近 30 个（更早的清理快照、保留版本元数据）。
 *   会话样本为审计型版本（只记录、不快照、不回滚：回滚会牵连检测/复核记录）。
 */

const DATASETS = [
  { key: 'intents',      name: '意图库',         types: ['intent_def'],                    desc: '三级意图体系（一级/二级/三级意图，含定义、识别规则、典型案例）' },
  { key: 'scenes',       name: '场景库',         types: ['scene_def'],                     desc: '场景定义（适用条件/排除条件/边界）' },
  { key: 'mappings',     name: '意图-场景映射',   types: ['mapping'],                       desc: '意图与场景的对应关系及映射依据' },
  { key: 'skills',       name: 'Skill 库',       types: ['skill_def'],                     desc: '一线客服 Skills（技能定义：适用场景、动作、输出要求）' },
  { key: 'skill_scenes', name: 'Skill-场景映射', types: ['skill_scene'],                   desc: 'Skill 与场景的对应关系' },
  { key: 'cases',        name: '正负案例',       types: ['case_positive', 'case_negative'], desc: '不同场景的好答复（正）与坏答复（负）参照' },
  { key: 'checklists',   name: '场景检查清单',    types: ['checklist'],                     desc: '「完整方案」的尺子：每类问题必须答到什么程度' },
  { key: 'reply_rules',  name: '业务规则',       types: ['reply_rule'],                    desc: '到账时效/计算规则/处理规则等业务事实' },
  { key: 'sessions',     name: '真实会话样本',    types: [], special: 'sessions',            desc: '含系统结果的真实会话（检测与基准样本的来源）' },
];

const STD_TYPES = DATASETS.filter((d) => !d.special).flatMap((d) => d.types);
const KEEP_SNAPSHOTS = 30;

function datasetByKey(key) { return DATASETS.find((d) => d.key === key) || null; }
function datasetOfType(type) { return DATASETS.find((d) => d.types.includes(type)) || null; }

function currentRecords(storage, ds) {
  if (ds.special === 'sessions') return storage.list('sessions').slice();
  return storage.list('standards').filter((s) => ds.types.includes(s.type));
}

const clone = (o) => JSON.parse(JSON.stringify(o));

function versionsOf(storage, key) {
  return storage.list('material_versions').filter((v) => v.dataset === key).sort((a, b) => b.version - a.version);
}

function nextVersion(storage, key) {
  const vs = versionsOf(storage, key);
  return vs.length ? vs[0].version + 1 : 1;
}

function latestSnapshot(storage, key) {
  const v = versionsOf(storage, key).find((x) => Array.isArray(x.snapshot));
  return v ? v.snapshot : null;
}

/* 快照清理：每个数据集只保留最近 KEEP_SNAPSHOTS 个版本的快照 */
function pruneVersions(storage, key) {
  const vs = versionsOf(storage, key);
  vs.slice(KEEP_SNAPSHOTS).forEach((v) => {
    if (v.snapshot) storage.update('material_versions', v.id, { snapshot: null });
  });
}

/*
 * 提交一个数据集版本：调用前必须先完成数据变更。
 * 返回版本记录（含 added/updated/removed 统计）。
 */
function commitDataset(storage, key, opts) {
  const ds = datasetByKey(key);
  if (!ds) return null;
  const o = opts || {};
  const before = latestSnapshot(storage, key);
  const after = currentRecords(storage, ds);
  const beforeMap = new Map((before || []).map((r) => [r.id, r]));
  const afterMap = new Map(after.map((r) => [r.id, r]));
  const detail = [];
  let added = 0, updated = 0, removed = 0;
  const sig = (r) => JSON.stringify({ name: r.name, content: r.content, status: r.status, version: r.version, intent_id: r.intent_id, scene_id: r.scene_id, level1_id: r.level1_id, level2_id: r.level2_id });
  for (const [id, r] of afterMap) {
    const old = beforeMap.get(id);
    if (!old) { added++; if (detail.length < 60) detail.push({ action: 'add', id, name: r.name || id }); }
    else if (sig(old) !== sig(r)) { updated++; if (detail.length < 60) detail.push({ action: 'update', id, name: r.name || id }); }
  }
  for (const [id, r] of beforeMap) {
    if (!afterMap.has(id)) { removed++; if (detail.length < 60) detail.push({ action: 'remove', id, name: r.name || id }); }
  }
  // 无实质变更且已有版本记录时，不产生新版本（避免重复导入刷版本号）
  const existing = versionsOf(storage, key);
  if (!added && !updated && !removed && existing.length) {
    return Object.assign({}, existing[0], { no_change: true });
  }
  const rec = storage.insert('material_versions', {
    dataset: key,
    version: nextVersion(storage, key),
    note: o.note || '变更',
    source: o.source || '人工',
    operator: o.operator || '',
    changes: { added, updated, removed, total: after.length },
    detail,
    snapshot: after.map(clone),
    created_at: new Date().toISOString(),
  });
  pruneVersions(storage, key);
  return rec;
}

/* ---------- 意图库导入（树形 JSON：level1 → level2 → level3） ---------- */

function composeIntentContent(l3) {
  const parts = [];
  if (l3.definition) parts.push('【定义】' + String(l3.definition).trim());
  if (l3.rule) parts.push('【识别规则】' + String(l3.rule).trim());
  const cases = Array.isArray(l3.cases) ? l3.cases.filter((c) => String(c || '').trim()) : [];
  if (cases.length) parts.push('【典型案例】\n' + cases.map((c, i) => (i + 1) + '. ' + String(c).trim()).join('\n'));
  return parts.join('\n\n');
}

function flattenIntents(tree) {
  const out = [];
  const roots = Array.isArray(tree) ? tree : (tree && Array.isArray(tree.intents) ? tree.intents : []);
  for (const l1 of roots) {
    if (!l1) continue;
    for (const l2 of l1.level2 || []) {
      if (!l2) continue;
      for (const l3 of l2.level3 || []) {
        if (!l3 || !String(l3.level3_name || '').trim()) continue;
        out.push({
          type: 'intent_def',
          id: l3.level3_id ? 'intent_' + String(l3.level3_id) : undefined,
          name: String(l3.level3_name).trim(),
          intent_id: l3.level3_id ? String(l3.level3_id) : '',
          level1_id: l1.level1_id ? String(l1.level1_id) : '',
          level1_name: String(l1.level1_name || ''),
          level2_id: l2.level2_id ? String(l2.level2_id) : '',
          level2_name: String(l2.level2_name || ''),
          content: composeIntentContent(l3),
          status: '已生效',
        });
      }
    }
  }
  return out;
}

/* ---------- 通用 upsert（标准类记录） ---------- */

function findStandardMatch(storage, rec) {
  const all = storage.list('standards');
  if (rec.intent_id) {
    const m = all.find((s) => s.type === 'intent_def' && String(s.intent_id) === String(rec.intent_id));
    if (m) return m;
  }
  if (rec.scene_id) {
    const m = all.find((s) => s.type === 'scene_def' && String(s.scene_id) === String(rec.scene_id));
    if (m) return m;
  }
  return all.find((s) => s.type === rec.type && s.name === rec.name) || null;
}

function upsertStandard(storage, rec, opts) {
  const o = opts || {};
  const existing = findStandardMatch(storage, rec);
  if (existing) {
    const patch = { name: rec.name, content: rec.content, status: rec.status || existing.status };
    if (rec.intent_id) patch.intent_id = rec.intent_id;
    if (rec.level1_id) { patch.level1_id = rec.level1_id; patch.level1_name = rec.level1_name; patch.level2_id = rec.level2_id; patch.level2_name = rec.level2_name; }
    const changed = existing.content !== patch.content || existing.status !== patch.status || existing.name !== patch.name;
    if (changed) patch.version = (existing.version || 1) + 1;
    storage.update('standards', existing.id, patch);
    return { action: changed ? 'updated' : 'skipped', id: existing.id };
  }
  const s = storage.insert('standards', {
    type: rec.type, name: rec.name, content: rec.content,
    version: 1, status: rec.status || '草稿', source: o.source || '导入',
    effective_at: (rec.status === '已生效') ? new Date().toISOString() : null,
    intent_id: rec.intent_id || undefined, scene_id: rec.scene_id || undefined,
    level1_id: rec.level1_id || undefined, level1_name: rec.level1_name || undefined,
    level2_id: rec.level2_id || undefined, level2_name: rec.level2_name || undefined,
  });
  return { action: 'added', id: s.id };
}

/* ---------- 导入入口 ---------- */

function importIntentTree(storage, tree, opts) {
  const o = opts || {};
  const records = flattenIntents(tree);
  if (!records.length) return { error: '没有解析到意图（需要 {intents:[{level1_id,level1_name,level2:[{level2_id,level2_name,level3:[{level3_id,level3_name,rule,definition,cases}]}]}]} 结构）' };
  let added = 0, updated = 0, skipped = 0;
  for (const r of records) {
    const res = upsertStandard(storage, r, { source: o.source || '导入' });
    if (res.action === 'added') added++;
    else if (res.action === 'updated') updated++;
    else skipped++;
  }
  const v = commitDataset(storage, 'intents', { note: o.note || '导入意图库（树形 JSON）', source: o.source || '导入', operator: o.operator });
  return { added, updated, skipped, total: records.length, dataset: 'intents', version: v ? v.version : null, version_id: v ? v.id : null };
}

/* 扁平行导入：支持两种表头——
   ① 标准模板行：标准类型/type、名称/name、内容/content、状态/status
   ② 意图库宽表行（xlsx 导出）：一级意图(ID)/二级意图(ID)/三级意图(ID)/三级意图规则/三级意图定义/三级意图典型案例(1-6) */
function importRows(storage, rows, opts) {
  const o = opts || {};
  if (!Array.isArray(rows) || !rows.length) return { error: '导入内容为空' };
  const touched = new Set();
  const skipped = [];
  let added = 0, updated = 0, unchanged = 0;
  for (const r of rows) {
    const isIntentWide = r['三级意图'] || r['三级意图ID'] || r['三级意图名称'];
    let rec = null;
    if (isIntentWide) {
      const cases = [];
      const caseKeys = ['三级意图典型案例', '三级意图典型案例1', '典型案例', '典型案例1', '案例', '案例1'];
      for (let i = 2; i <= 6; i++) caseKeys.push('三级意图典型案例' + i, '典型案例' + i, '案例' + i);
      for (const k of caseKeys) { if (r[k]) cases.push(String(r[k])); }
      if (Array.isArray(r.cases)) cases.push(...r.cases.map(String));
      rec = {
        type: 'intent_def',
        name: String(r['三级意图'] || r['三级意图名称'] || r.name || '').trim(),
        intent_id: String(r['三级意图ID'] || r.intent_id || '').trim(),
        level1_id: String(r['一级意图ID'] || '').trim(), level1_name: String(r['一级意图'] || '').trim(),
        level2_id: String(r['二级意图ID'] || '').trim(), level2_name: String(r['二级意图'] || '').trim(),
        content: [
          r['三级意图定义'] ? '【定义】' + String(r['三级意图定义']).trim() : '',
          r['三级意图规则'] ? '【识别规则】' + String(r['三级意图规则']).trim() : '',
          cases.length ? '【典型案例】\n' + cases.map((c, i) => (i + 1) + '. ' + c).join('\n') : '',
        ].filter(Boolean).join('\n\n'),
        status: String(r['状态'] || r.status || '已生效').trim(),
      };
    } else {
      const type = String(r['标准类型'] || r.type || '').trim();
      const name = String(r['名称'] || r.name || '').trim();
      if (!type || !name) { skipped.push(name || '(无名行)'); continue; }
      const content = String(
        r['内容（定义：含什么/排除什么/边界）'] || r['内容（适用条件/排除条件）'] || r['内容（映射依据）'] ||
        r['内容（逐条检查项）'] || r['内容（案例原文 + 为什么好/坏）'] || r['内容（Skill 说明：适用场景/动作/输出要求/边界）'] || r.content || '').trim();
      const status = String(r['状态'] || r.status || '草稿').trim();
      rec = { type, name, content, status: ['草稿', '待确认', '已生效', '已冲突'].includes(status) ? status : '草稿' };
    }
    if (!rec.name) { skipped.push('(无名行)'); continue; }
    const res = upsertStandard(storage, rec, { source: o.source || '导入' });
    if (res.action === 'added') { added++; touched.add(rec.type); }
    else if (res.action === 'updated') { updated++; touched.add(rec.type); }
    else unchanged++;
  }
  const versions = {};
  for (const type of touched) {
    const ds = datasetOfType(type);
    if (!ds) continue;
    const v = commitDataset(storage, ds.key, { note: o.note || '导入标准（扁平行）', source: o.source || '导入', operator: o.operator });
    versions[ds.key] = v ? v.version : null;
  }
  return { added, updated, skipped: unchanged + skipped.length, skipped_list: skipped.slice(0, 20), versions };
}

/* ---------- 会话样本版本（审计型：只记录，不快照，不回滚） ---------- */

function recordSamplesVersion(storage, opts) {
  const o = opts || {};
  const sessions = storage.list('sessions');
  const rec = storage.insert('material_versions', {
    dataset: 'sessions',
    version: nextVersion(storage, 'sessions'),
    note: o.note || '批量导入会话样本',
    source: o.source || '批量导入',
    operator: o.operator || '',
    changes: { added: o.added || 0, updated: 0, removed: 0, total: sessions.length },
    detail: (o.added_ids || []).slice(0, 60).map((id) => {
      const s = sessions.find((x) => x.id === id);
      return { action: 'add', id, name: s ? ((s.intent_name || '') + ' · ' + String(s.raw_text || '').slice(0, 24)) : id };
    }),
    snapshot: null,
    created_at: new Date().toISOString(),
  });
  pruneVersions(storage, 'sessions');
  return rec;
}

/* ---------- 版本查询与回滚 ---------- */

function getVersions(storage, key) {
  return versionsOf(storage, key).map((v) => ({
    id: v.id, dataset: v.dataset, version: v.version, note: v.note, source: v.source,
    operator: v.operator, changes: v.changes, detail: v.detail,
    has_snapshot: Array.isArray(v.snapshot), rollbackable: Array.isArray(v.snapshot) && !datasetByKey(v.dataset).special,
    created_at: v.created_at,
  }));
}

function getVersionDetail(storage, id) {
  const v = storage.byId('material_versions', id);
  if (!v) return null;
  return {
    id: v.id, dataset: v.dataset, version: v.version, note: v.note, source: v.source,
    operator: v.operator, changes: v.changes, detail: v.detail, created_at: v.created_at,
    records: Array.isArray(v.snapshot)
      ? v.snapshot.map((r) => ({ id: r.id, name: r.name, status: r.status, version: r.version, type: r.type, intent_id: r.intent_id, level1_name: r.level1_name, level2_name: r.level2_name, content: r.content }))
      : null,
  };
}

function rollback(storage, versionId, opts) {
  const o = opts || {};
  const v = storage.byId('material_versions', versionId);
  if (!v) return { error: '版本不存在' };
  const ds = datasetByKey(v.dataset);
  if (!ds) return { error: '未知数据集：' + v.dataset };
  if (ds.special === 'sessions') return { error: '会话样本版本为审计记录，不支持回滚（回滚会牵连检测与复核记录）' };
  if (!Array.isArray(v.snapshot)) return { error: '该版本的快照已被清理（仅保留最近 ' + KEEP_SNAPSHOTS + ' 个版本快照），无法回滚' };
  const cur = currentRecords(storage, ds);
  for (const r of cur) storage.remove('standards', r.id);
  for (const r of v.snapshot) storage.insert('standards', clone(r));
  const rec = commitDataset(storage, v.dataset, { note: '回滚到 v' + v.version, source: '回滚', operator: o.operator });
  return { ok: true, dataset: v.dataset, restored: v.snapshot.length, version: rec ? rec.version : null, version_id: rec ? rec.id : null };
}

/* ---------- 数据集概览（材料中心版本面板用） ---------- */

function datasetSummary(storage) {
  return DATASETS.map((ds) => {
    const records = currentRecords(storage, ds);
    const vs = versionsOf(storage, ds.key);
    const effective = ds.special === 'sessions'
      ? records.filter((s) => s.count_in_stats !== false).length
      : records.filter((s) => s.status === '已生效').length;
    return {
      key: ds.key, name: ds.name, desc: ds.desc, special: !!ds.special,
      count: records.length, effective,
      current_version: vs.length ? vs[0].version : 0,
      last_updated: vs.length ? vs[0].created_at : null,
      versions: vs.length,
    };
  });
}

module.exports = {
  DATASETS, STD_TYPES, datasetByKey, datasetOfType, currentRecords,
  commitDataset, flattenIntents, composeIntentContent, upsertStandard,
  importIntentTree, importRows, recordSamplesVersion,
  getVersions, getVersionDetail, rollback, datasetSummary,
};
