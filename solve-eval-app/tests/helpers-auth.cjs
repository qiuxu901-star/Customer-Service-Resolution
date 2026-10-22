'use strict';
const path = require('node:path');
const { Auth } = require('../auth');
// Real login + password-change requests, backed by an isolated test account.
exports.authenticatedFetch = function authenticatedFetch(dir) {
  const auth = new Auth(path.join(dir, 'auth.json'), {});
  auth.create({ phone: '13900000001', name: '合成验收管理员', position: '自动化验收', password: 'test-temporary-password', is_admin: true }, 'test-fixture');
  let cookie = '', pending;
  return async (url, options = {}) => {
    const origin = new URL(url).origin;
    if (!cookie) {
      pending ||= (async () => {
        let response = await globalThis.fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '13900000001', password: 'test-temporary-password' }) });
        if (!response.ok) throw Error('测试账号登录失败：' + await response.text());
        let token = response.headers.get('set-cookie').split(';')[0];
        response = await globalThis.fetch(origin + '/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: token }, body: JSON.stringify({ current_password: 'test-temporary-password', new_password: 'test-permanent-password' }) });
        if (!response.ok) throw Error('测试账号改密失败：' + await response.text());
        cookie = response.headers.get('set-cookie').split(';')[0];
      })();
      try { await pending; } catch (error) { pending = null; throw error; }
    }
    return globalThis.fetch(url, { ...options, headers: { ...options.headers, Cookie: cookie } });
  };
};
