'use strict';
const fs = require('fs');
const path = require('path');

const COLLECTIONS = ['batches', 'sessions', 'demands', 'detections', 'reviews', 'standards', 'standard_issues', 'corrections', 'monitor_plans', 'monitor_revisions', 'monitor_candidates', 'monitor_cases', 'monitor_runs', 'service_skills', 'monitor_tasks', 'monitor_batches', 'monitor_batch_items', 'monitor_rating_runs', 'monitor_ratings', 'business_scenes', 'business_scene_versions', 'scene_assignments', 'monitor_examples', 'monitor_import_counters', 'monitor_item_routes', 'model_profiles', 'monitor_batch_confirmations', 'workspace_conversations', 'workspace_messages', 'monitor_rating_reviews', 'monitor_record_views', 'evaluator_skill_revisions', 'evaluator_skill_trials', 'monitor_learning_signals', 'monitor_learning_drafts', 'monitor_plan_trials', 'material_versions', 'agent_configs', 'service_skill_diagnoses', 'service_skill_batch_diagnoses', 'issue_taxonomy_revisions', 'issue_classification_assignments', 'issue_classification_changes', 'issue_classification_ai_runs', 'issue_classification_suggestions'];

class Storage {
  constructor(file) {
    this.file = file;
    this.data = { seq: {}, settings: {} };
    for (const c of COLLECTIONS) this.data[c] = [];
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('数据库结构无效');
      for (const c of COLLECTIONS) if (raw[c] !== undefined && !Array.isArray(raw[c])) throw new Error('数据库集合格式无效：' + c);
      this.data = Object.assign({ seq: {}, settings: {} }, raw);
      for (const c of COLLECTIONS) if (!Array.isArray(this.data[c])) this.data[c] = [];
    } catch (e) {
      if (e.code === 'ENOENT') {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this.flush();
      } else {
        throw new Error('数据文件读取失败，原文件已保留：' + e.message, { cause: e });
      }
    }
  }

  flush() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  id(prefix) {
    this.data.seq[prefix] = (this.data.seq[prefix] || 0) + 1;
    return prefix + '_' + Date.now().toString(36) + '_' + this.data.seq[prefix];
  }

  transaction(fn) {
    const previous = structuredClone(this.data);
    const oldFlush = this.flush;
    this.flush = () => {};
    try { const result = fn(); this.flush = oldFlush; this.flush(); return result; }
    catch (e) { this.data = previous; this.flush = oldFlush; throw e; }
  }

  list(name) { return this.data[name]; }
  find(name, pred) { return this.data[name].find(pred); }
  byId(name, id) { return this.data[name].find((x) => x.id === id); }
  mutate(fn) {
    const previous = structuredClone(this.data);
    try { const result = fn(); this.flush(); return result; }
    catch (error) { this.data = previous; throw error; }
  }
  insert(name, obj) {
    return this.mutate(() => {
      const value = structuredClone(obj);
      value.id = value.id || this.id(name.slice(0, 3));
      value.created_at = value.created_at || new Date().toISOString();
      this.data[name].push(value);
      return value;
    });
  }
  update(name, id, patch) {
    return this.mutate(() => {
      const obj = this.byId(name, id);
      if (!obj) return null;
      Object.assign(obj, structuredClone(patch), { updated_at: new Date().toISOString() });
      return obj;
    });
  }
  remove(name, id) {
    return this.mutate(() => {
      const i = this.data[name].findIndex((x) => x.id === id);
      if (i < 0) return false;
      this.data[name].splice(i, 1);
      return true;
    });
  }
  getSetting(key, fallback) {
    return this.data.settings[key] !== undefined ? this.data.settings[key] : fallback;
  }
  setSetting(key, value) {
    this.mutate(() => { this.data.settings[key] = value; });
  }
}

module.exports = { Storage, COLLECTIONS };
