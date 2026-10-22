'use strict';
// Private migration payload. Never add its output to Git or a public Release.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Storage, COLLECTIONS } = require('../solve-eval-app/storage');
const { Auth } = require('../solve-eval-app/auth');
const CONFIG_COLLECTIONS = [
  'business_scenes', 'business_scene_versions', 'service_skills',
  'monitor_plans', 'monitor_revisions', 'monitor_candidates',
  'evaluator_skill_revisions', 'issue_taxonomy_revisions',
];
const CONFIG_SETTINGS = ['evaluator_skill_state', 'issue_taxonomy_state'];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function selectConfiguration(source) {
  const data = { seq: {}, settings: {} };
  for (const key of COLLECTIONS) data[key] = [];
  for (const key of CONFIG_COLLECTIONS) {
    if (!Array.isArray(source[key])) throw Error('缺少配置集合：' + key);
    data[key] = structuredClone(source[key]);
  }
  // Only configuration-to-scene links belong to this migration, never case links.
  const plans = new Set(data.monitor_plans.map(row => row.id));
  data.scene_assignments = structuredClone((source.scene_assignments || []).filter(row => row.plan_id && plans.has(row.plan_id) && !row.case_id));
  for (const key of CONFIG_SETTINGS) {
    if (source.settings?.[key] !== undefined) data.settings[key] = structuredClone(source.settings[key]);
  }
  for (const key of [...CONFIG_COLLECTIONS, 'scene_assignments']) {
    const prefix = key.slice(0, 3);
    data.seq[prefix] = Math.max(data.seq[prefix] || 0, source.seq?.[prefix] || 0);
  }
  return data;
}
function validateConfiguration(data) {
  const scenes = new Set(data.business_scenes.map(row => row.id));
  const plans = new Set(data.monitor_plans.map(row => row.id));
  const revisions = new Set(data.monitor_revisions.map(row => row.id));
  const services = new Set(data.service_skills.map(row => row.id));
  for (const row of data.business_scene_versions) if (!scenes.has(row.scene_id)) throw Error('场景版本存在失效关联');
  for (const row of data.service_skills) {
    if (row.scene_id && !scenes.has(row.scene_id)) throw Error('客服业务 Skill 存在失效场景关联');
    if (row.based_on_id && !services.has(row.based_on_id)) throw Error('客服业务 Skill 缺少来源版本');
  }
  for (const row of data.monitor_plans) {
    if (row.scene_id && !scenes.has(row.scene_id)) throw Error('评估方案存在失效场景关联');
    if (!revisions.has(row.current_revision_id)) throw Error('评估方案缺少当前修订');
  }
  for (const row of data.monitor_revisions) if (!plans.has(row.plan_id)) throw Error('评估修订缺少所属方案');
  for (const [setting, collection] of [['evaluator_skill_state', 'evaluator_skill_revisions'], ['issue_taxonomy_state', 'issue_taxonomy_revisions']]) {
    const state = data.settings[setting];
    if (!state) throw Error('缺少配置生效状态：' + setting);
    const ids = new Set(data[collection].map(row => row.id));
    for (const key of ['active_revision_id', 'head_revision_id']) if (!ids.has(state[key])) throw Error('配置生效版本关联失效：' + setting);
  }
}
function prepareProductionData({ sourceFile, outputDir, credentialsFile, phone = '19900000000' }) {
  sourceFile = path.resolve(sourceFile); outputDir = path.resolve(outputDir); credentialsFile = path.resolve(credentialsFile);
  if (fs.existsSync(outputDir) || fs.existsSync(credentialsFile)) throw Error('输出目录或账号凭据文件已存在，未覆盖');
  if (credentialsFile.startsWith(outputDir + path.sep)) throw Error('明文凭据必须保存在数据目录之外');
  const raw = fs.readFileSync(sourceFile), source = JSON.parse(raw), data = selectConfiguration(source);
  validateConfiguration(data);
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 }); fs.chmodSync(outputDir, 0o700);
  const dataFile = path.join(outputDir, 'db.json');
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  const storage = new Storage(dataFile);
  // Check active snapshots and resource links using the application's actual validators.
  const evaluator = require('../solve-eval-app/evaluator-skill').createEvaluatorSkill({ storage });
  evaluator.snapshot();
  require('../solve-eval-app/evaluation-capability').normalizeConfiguration(evaluator.configuration(), { storage });
  require('../solve-eval-app/issue-taxonomy').createIssueTaxonomy({ storage }).bootstrap();
  const password = 'GL-' + crypto.randomBytes(18).toString('base64url');
  const auth = new Auth(path.join(outputDir, 'auth.json'), {});
  const admin = auth.create({ phone, password, name: '超级管理员', position: '系统管理', is_admin: true }, 'production-initialization');
  fs.mkdirSync(path.dirname(credentialsFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(credentialsFile, JSON.stringify({ phone, password, name: admin.name, must_change_password: true, created_at: admin.created_at }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const manifest = {
    prepared_at: new Date().toISOString(), source_sha256: sha(raw),
    configuration_sha256: sha(JSON.stringify(data)),
    collections: Object.fromEntries([...CONFIG_COLLECTIONS, 'scene_assignments'].map(key => [key, data[key].length])),
    settings: Object.keys(data.settings), excluded_collections_empty: true,
    model_profiles: 0, existing_users_migrated: 0, administrator_count: 1,
    administrator_phone: phone, password_in_manifest: false,
    db_sha256: sha(fs.readFileSync(dataFile)), auth_sha256: sha(fs.readFileSync(path.join(outputDir, 'auth.json'))),
  };
  fs.writeFileSync(path.join(path.dirname(outputDir), 'migration-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  return manifest;
}
if (require.main === module) {
  const [sourceFile, outputDir, credentialsFile, phone] = process.argv.slice(2);
  if (!sourceFile || !outputDir || !credentialsFile) {
    console.error('用法：node scripts/prepare-production-data.cjs <源db.json> <全新数据目录> <目录外凭据文件> [超管手机号]');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(prepareProductionData({ sourceFile, outputDir, credentialsFile, phone }))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
module.exports = { CONFIG_COLLECTIONS, CONFIG_SETTINGS, selectConfiguration, validateConfiguration, prepareProductionData };
