'use strict';
const fs = require('fs');
const path = require('path');

const COLLECTIONS = ['batches', 'sessions', 'demands', 'detections', 'reviews', 'standards', 'standard_issues', 'corrections', 'material_versions', 'agent_configs'];

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
      this.data = Object.assign({ seq: {}, settings: {} }, raw);
      for (const c of COLLECTIONS) if (!Array.isArray(this.data[c])) this.data[c] = [];
    } catch (e) {
      this.flush();
    }
  }

  flush() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  id(prefix) {
    this.data.seq[prefix] = (this.data.seq[prefix] || 0) + 1;
    return prefix + '_' + Date.now().toString(36) + '_' + this.data.seq[prefix];
  }

  list(name) { return this.data[name]; }
  find(name, pred) { return this.data[name].find(pred); }
  byId(name, id) { return this.data[name].find((x) => x.id === id); }
  insert(name, obj) {
    obj.id = obj.id || this.id(name.slice(0, 3));
    obj.created_at = obj.created_at || new Date().toISOString();
    this.data[name].push(obj);
    this.flush();
    return obj;
  }
  update(name, id, patch) {
    const obj = this.byId(name, id);
    if (!obj) return null;
    Object.assign(obj, patch, { updated_at: new Date().toISOString() });
    this.flush();
    return obj;
  }
  remove(name, id) {
    const i = this.data[name].findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.data[name].splice(i, 1);
    this.flush();
    return true;
  }
  getSetting(key, fallback) {
    return this.data.settings[key] !== undefined ? this.data.settings[key] : fallback;
  }
  setSetting(key, value) {
    this.data.settings[key] = value;
    this.flush();
  }
}

module.exports = { Storage, COLLECTIONS };
