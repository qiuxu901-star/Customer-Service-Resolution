'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage, COLLECTIONS } = require('../storage');
const { passwordMatches } = require('../auth');
const { prepareProductionData, CONFIG_COLLECTIONS } = require('../../scripts/prepare-production-data.cjs');
test('发布只保留三类配置和版本关系，排除模型、业务记录与旧账号，并创建独立初始超管', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-production-data-'));
  try {
    const sourceFile = path.join(root, 'local/db.json'), storage = new Storage(sourceFile);
    const scene = require('../scenes').createScenes({ storage }).save({ code: 'SYN-CONFIG', name: '合成发布场景', scopes: ['tier2'], description: '配置迁移验收', boundary: '仅合成材料', actor: '测试' });
    storage.insert('service_skills', { scene_id: scene.id, code: 'SYN-SKILL', raw: '# 合成业务定义', content_hash: 'synthetic' });
    require('../evaluator-skill').createEvaluatorSkill({ storage });
    require('../issue-taxonomy').createIssueTaxonomy({ storage });
    storage.transaction(() => {
      for (const key of COLLECTIONS.filter(key => !CONFIG_COLLECTIONS.includes(key) && key !== 'scene_assignments')) storage.data[key] = [{ id: 'DO_NOT_COPY', secret: 'PRIVATE_MODEL_AND_BUSINESS_DATA' }];
      storage.data.settings.llm_api_key = 'PRIVATE_MODEL_AND_BUSINESS_DATA';
      storage.data.settings.model_default = { profile_id: 'DO_NOT_COPY' };
      storage.data.settings.operator = 'PRIVATE_LOCAL_OPERATOR';
    });
    const before = fs.readFileSync(sourceFile), outputDir = path.join(root, 'private/data'), credentialsFile = path.join(root, 'private/admin.json');
    const manifest = prepareProductionData({ sourceFile, outputDir, credentialsFile });
    assert.deepEqual(fs.readFileSync(sourceFile), before, 'local database must not be mutated');
    const source = JSON.parse(before), target = JSON.parse(fs.readFileSync(path.join(outputDir, 'db.json'), 'utf8'));
    for (const key of CONFIG_COLLECTIONS) assert.deepEqual(target[key], source[key], key);
    for (const key of COLLECTIONS.filter(key => !CONFIG_COLLECTIONS.includes(key))) assert.deepEqual(target[key], [], key);
    assert.doesNotMatch(JSON.stringify(target), /PRIVATE_|DO_NOT_COPY/);
    assert.deepEqual(Object.keys(target.settings).sort(), ['evaluator_skill_state', 'issue_taxonomy_state']);
    const auth = JSON.parse(fs.readFileSync(path.join(outputDir, 'auth.json'), 'utf8')), credential = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
    assert.equal(auth.users.length, 1); assert.equal(auth.sessions.length, 0);
    assert.equal(auth.users[0].is_admin, true); assert.equal(auth.users[0].must_change_password, true);
    assert.equal(auth.users[0].phone, '19900000000');
    assert.equal(passwordMatches(credential.password, auth.users[0].password_hash), true);
    assert.doesNotMatch(JSON.stringify(auth), new RegExp(credential.password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(fs.statSync(credentialsFile).mode & 0o777, 0o600);
    assert.equal(manifest.administrator_count, 1);
    assert.throws(() => prepareProductionData({ sourceFile, outputDir, credentialsFile }), /已存在/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
