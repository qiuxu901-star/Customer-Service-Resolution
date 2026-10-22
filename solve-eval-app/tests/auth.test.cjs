'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Auth } = require('../auth');

test('账号生命周期：所有入口鉴权、权限、重置、会话撤销和持久化', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-auth-test-'));
  let child;
  const port = await new Promise(resolve => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
  const base = 'http://127.0.0.1:' + port;
  const credentials = { phone: '13800000001', name: '管理员', position: '产品经理', password: 'initial-password-001', is_admin: true };
  let admin, member, adminCookie, memberCookie;
  async function call(method, url, body, cookie, extra = {}) {
    const response = await fetch(base + url, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text();
    let value; try { value = JSON.parse(raw); } catch { value = raw; }
    return { status: response.status, value, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function start(extra = {}) {
    child = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env: { ...process.env, CSR_DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', CSR_ADMIN_PHONE: '', CSR_ADMIN_PASSWORD: '', ...extra }, stdio: 'ignore' });
    for (let n = 0; n < 100; n++) { try { if ((await call('GET', '/api/health')).status === 200) return; } catch {} await new Promise(resolve => setTimeout(resolve, 30)); }
    throw Error('测试服务未启动');
  }
  async function stop() { if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }
  try {
    await start();
    await t.test('空账号库仍需登录，不能通过公开注册接管', async () => {
      for (const url of ['/', '/legacy', '/workbench.html', '/index.html', '/accounts', '/account', '/workbench.js', '/release.json']) {
        const result = await call('GET', url); assert.equal(result.status, 303, url); assert.equal(result.headers.get('location'), '/login');
      }
      for (const url of ['/api/bootstrap', '/api/monitor', '/api/materials', '/api/accounts', '/api/auth/me', '/api/export/records', '/api/unknown']) assert.equal((await call('GET', url)).status, 401, url);
      assert.equal((await call('POST', '/api/monitor/scenes', { name: 'unauthorized' })).status, 401);
      assert.equal((await call('POST', '/api/auth/register', credentials)).status, 401);
      assert.equal((await call('POST', '/api/auth/login', credentials)).status, 401);
      const login = await call('GET', '/login'); assert.equal(login.status, 200); assert.match(login.value, /手机号/); assert.match(login.headers.get('cache-control'), /no-store/);
      const auth = new Auth(path.join(dir, 'auth.json'), {}); admin = auth.create(credentials, 'test-console');
    });
    await t.test('初始密码只能进入改密页，Cookie 受保护且不泄露凭据', async () => {
      const login = await call('POST', '/api/auth/login', credentials);
      assert.equal(login.status, 200); adminCookie = login.cookie;
      assert.match(login.headers.get('set-cookie'), /HttpOnly/); assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
      assert.equal(login.value.user.password_hash, undefined); assert.equal(login.value.token, undefined);
      const blocked = await call('GET', '/api/monitor', undefined, adminCookie); assert.equal(blocked.status, 403); assert.equal(blocked.value.code, 'PASSWORD_CHANGE_REQUIRED');
      assert.equal((await call('GET', '/', undefined, adminCookie)).headers.get('location'), '/account');
      assert.equal((await call('GET', '/account', undefined, adminCookie)).status, 200);
      assert.equal((await call('POST', '/api/auth/password', { current_password: credentials.password, new_password: 'short' }, adminCookie)).status, 400);
      assert.equal((await call('POST', '/api/auth/password', { current_password: credentials.password, new_password: credentials.password }, adminCookie)).status, 400);
      const changed = await call('POST', '/api/auth/password', { current_password: credentials.password, new_password: 'permanent-password-001' }, adminCookie);
      assert.equal(changed.status, 200); assert.equal(changed.value.user.must_change_password, false);
      assert.equal((await call('GET', '/api/auth/me', undefined, adminCookie)).status, 401); adminCookie = changed.cookie;
      assert.equal((await call('GET', '/api/monitor', undefined, adminCookie)).status, 200);
      for (const url of ['/', '/legacy', '/workbench.js', '/auth-widget.css']) assert.equal((await call('GET', url, undefined, adminCookie)).status, 200);
    });
    await t.test('管理员创建、校验及编辑，岗位与管理员权限独立', async () => {
      const body = { phone: '13800000002', name: '客服运营', position: '系统管理员', password: 'member-temporary-001' };
      const created = await call('POST', '/api/accounts', body, adminCookie); assert.equal(created.status, 201); member = created.value.user; assert.equal(member.is_admin, false);
      assert.equal((await call('POST', '/api/accounts', body, adminCookie)).status, 409);
      assert.equal((await call('POST', '/api/accounts', { ...body, phone: '123' }, adminCookie)).status, 400);
      assert.equal((await call('POST', '/api/accounts', { ...body, phone: '13800000003', name: '' }, adminCookie)).status, 400);
      assert.equal((await call('POST', '/api/accounts', { ...body, phone: '13800000003', is_admin: 'false' }, adminCookie)).status, 400);
      const edit = await call('PATCH', '/api/accounts/' + member.id, { name: '运营同事', position: '客服运营' }, adminCookie); assert.equal(edit.status, 200);
      assert.equal((await call('PATCH', '/api/accounts/' + member.id, { phone: credentials.phone }, adminCookie)).status, 409);
      for (const patch of [{ active: false }, { is_admin: false }]) assert.equal((await call('PATCH', '/api/accounts/' + admin.id, patch, adminCookie)).status, 409);
      memberCookie = (await call('POST', '/api/auth/login', { phone: member.phone, password: body.password })).cookie;
      memberCookie = (await call('POST', '/api/auth/password', { current_password: body.password, new_password: 'member-permanent-001' }, memberCookie)).cookie;
      assert.ok(memberCookie);
      for (const url of ['/api/accounts', '/accounts', '/accounts.html']) assert.equal((await call('GET', url, undefined, memberCookie)).status, 403);
      assert.equal((await call('POST', '/api/accounts', body, memberCookie)).status, 403);
      assert.equal((await call('POST', '/api/accounts/' + admin.id + '/password', { password: 'attacker-password-001' }, memberCookie)).status, 403);
      const scene = await call('POST', '/api/monitor/scenes', { name: '合成授权场景', code: 'AUTH-TEST', scopes: ['frontline'], description: '测试', boundary: '仅测试', actor: '伪造姓名' }, memberCookie);
      assert.equal(scene.status, 200); assert.equal(scene.value.scene.actor, '运营同事');
    });
    await t.test('跨站和表单请求被拦截，账号列表不含密码或会话', async () => {
      assert.equal((await call('POST', '/api/auth/login', credentials, undefined, { Origin: 'https://attacker.invalid' })).status, 403);
      assert.equal((await call('POST', '/api/auth/logout', {}, adminCookie, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
      assert.equal((await call('POST', '/api/monitor/scenes', {}, adminCookie, { 'Content-Type': 'text/plain' })).status, 415);
      assert.equal((await call('POST', '/api/auth/login', [], undefined)).status, 400);
      const list = await call('GET', '/api/accounts', undefined, adminCookie); assert.equal(list.status, 200); assert.equal(list.value.users.length, 2);
      assert.doesNotMatch(JSON.stringify(list.value), /password_hash|token_hash|permanent-password|temporary-001/);
    });
    await t.test('重置撤销全部会话，临时密码再次强制修改', async () => {
      const second = await call('POST', '/api/auth/login', { phone: member.phone, password: 'member-permanent-001' }); assert.equal(second.status, 200);
      assert.equal((await call('POST', '/api/accounts/' + member.id + '/password', { password: 'member-reset-002' }, adminCookie)).status, 200);
      for (const cookie of [memberCookie, second.cookie]) assert.equal((await call('GET', '/api/auth/me', undefined, cookie)).status, 401);
      assert.equal((await call('POST', '/api/auth/login', { phone: member.phone, password: 'member-permanent-001' })).status, 401);
      memberCookie = (await call('POST', '/api/auth/login', { phone: member.phone, password: 'member-reset-002' })).cookie;
      assert.equal((await call('GET', '/api/accounts', undefined, memberCookie)).status, 403);
      assert.equal((await call('GET', '/api/monitor', undefined, memberCookie)).value.code, 'PASSWORD_CHANGE_REQUIRED');
      memberCookie = (await call('POST', '/api/auth/password', { current_password: 'member-reset-002', new_password: 'member-new-final-002' }, memberCookie)).cookie;
      assert.equal((await call('PATCH', '/api/accounts/' + member.id, { active: false }, adminCookie)).status, 200);
      assert.equal((await call('GET', '/api/monitor', undefined, memberCookie)).status, 401);
      assert.equal((await call('POST', '/api/auth/login', { phone: member.phone, password: 'member-new-final-002' })).status, 401);
      assert.equal((await call('PATCH', '/api/accounts/' + member.id, { active: true }, adminCookie)).status, 200);
      memberCookie = (await call('POST', '/api/auth/login', { phone: member.phone, password: 'member-new-final-002' })).cookie;
    });
    await t.test('升级重启保留账号和会话，本地应急重置在线生效', async () => {
      await stop(); await start({ CSR_COOKIE_SECURE: '1' });
      const secureLogin = await call('POST', '/api/auth/login', { phone: credentials.phone, password: 'permanent-password-001' });
      assert.match(secureLogin.headers.get('set-cookie'), /; Secure/);
      assert.equal((await call('GET', '/api/accounts', undefined, adminCookie)).value.users.length, 2);
      assert.equal((await call('GET', '/api/monitor', undefined, memberCookie)).status, 200);
      const auth = new Auth(path.join(dir, 'auth.json'), {}); auth.reset(member.id, 'console-recovery-003', 'server-console');
      assert.equal((await call('GET', '/api/auth/me', undefined, memberCookie)).status, 401);
      const logout = await call('POST', '/api/auth/logout', {}, adminCookie); assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
      assert.equal((await call('GET', '/api/auth/me', undefined, adminCookie)).status, 401);
      const persisted = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
      assert.doesNotMatch(persisted, /initial-password|permanent-password|member-reset|console-recovery|csr_session/);
      assert.ok(JSON.parse(persisted).audit.some(row => row.action === 'password_reset'));
      assert.equal(fs.statSync(path.join(dir, 'auth.json')).mode & 0o777, 0o600);
    });
  } finally { await stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('登录限流、会话到期、管理员引导不会重置已有账号', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-auth-unit-')), file = path.join(dir, 'auth.json');
  try {
    const env = { CSR_ADMIN_PHONE: '13900000008', CSR_ADMIN_NAME: '首位管理员', CSR_ADMIN_POSITION: '运营', CSR_ADMIN_PASSWORD: 'bootstrap-secret-001' };
    const auth = new Auth(file, env); assert.equal(auth.list().length, 1);
    for (let n = 0; n < 10; n++) assert.throws(() => auth.login({ phone: env.CSR_ADMIN_PHONE, password: 'wrong' }, 'test-ip'), { statusCode: 401 });
    assert.throws(() => auth.login({ phone: env.CSR_ADMIN_PHONE, password: env.CSR_ADMIN_PASSWORD }, 'new-ip'), { statusCode: 429 });
    const restarted = new Auth(file, { ...env, CSR_ADMIN_PASSWORD: 'ignored-new-secret-002' });
    assert.throws(() => restarted.login({ phone: env.CSR_ADMIN_PHONE, password: 'ignored-new-secret-002' }, 'fresh-ip'), { statusCode: 401 });
    const login = restarted.login({ phone: env.CSR_ADMIN_PHONE, password: env.CSR_ADMIN_PASSWORD }, 'fresh-ip');
    assert.ok(restarted.current('csr_session=' + login.token));
    const data = JSON.parse(fs.readFileSync(file)); data.sessions.forEach(row => { row.expires_at = Date.now() - 1; }); fs.writeFileSync(file, JSON.stringify(data));
    assert.equal(restarted.current('csr_session=' + login.token), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
