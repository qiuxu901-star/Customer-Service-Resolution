'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const COOKIE = 'csr_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const RATE_MS = 15 * 60 * 1000;
const fail = (statusCode, message, code) => { throw Object.assign(Error(message), { statusCode, code }); };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) fail(400, '密码需为 10–128 个字符');
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 64).toString('hex');
}
function passwordMatches(password, hash) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [salt, value] = hash.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(password, salt, 64), Buffer.from(value, 'hex'));
}
function publicUser(user) {
  const { id, phone, name, position, is_admin, active, must_change_password, created_at, updated_at } = user;
  return { id, phone, name, position, is_admin, active, must_change_password, created_at, updated_at };
}
function profile(input) {
  const phone = String(input.phone ?? '').trim(), name = String(input.name ?? '').trim(), position = String(input.position ?? '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) fail(400, '请输入有效的 11 位手机号');
  if (!name || name.length > 50) fail(400, '姓名需为 1–50 个字符');
  if (!position || position.length > 100) fail(400, '岗位需为 1–100 个字符');
  for (const key of ['is_admin', 'active']) if (input[key] !== undefined && typeof input[key] !== 'boolean') fail(400, '账号权限和状态格式无效');
  return { phone, name, position };
}

class Auth {
  constructor(file, env = process.env) {
    this.file = file;
    this.rates = new Map();
    // A fixed dummy credential keeps missing accounts on the same verification path.
    this.dummyHash = passwordHash(crypto.randomBytes(32).toString('hex'));
    this.load();
    if (!this.data.users.length && env.CSR_ADMIN_PHONE && env.CSR_ADMIN_PASSWORD) {
      this.create({ phone: env.CSR_ADMIN_PHONE, name: env.CSR_ADMIN_NAME || '管理员', position: env.CSR_ADMIN_POSITION || '系统管理', password: env.CSR_ADMIN_PASSWORD, is_admin: true }, 'server-bootstrap');
    }
  }
  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.users) || !Array.isArray(data.sessions) || !Array.isArray(data.audit)) throw Error('账号文件格式无效');
      this.data = data;
    } catch (error) {
      if (error.code !== 'ENOENT') throw Error('账号数据读取失败，原文件已保留：' + error.message);
      this.data = { version: 1, users: [], sessions: [], audit: [] };
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  event(action, actor, target) {
    this.data.audit.push({ action, actor, target, at: new Date().toISOString() });
    this.data.audit = this.data.audit.slice(-2000);
  }
  list() { this.load(); return this.data.users.map(publicUser); }
  create(input, actor) {
    this.load();
    const fields = profile(input);
    if (this.data.users.some(u => u.phone === fields.phone)) fail(409, '该手机号已存在');
    const hash = passwordHash(input.password);
    const now = new Date().toISOString();
    const user = { id: crypto.randomUUID(), ...fields, password_hash: hash, is_admin: input.is_admin === true, active: true, must_change_password: true, created_at: now, updated_at: now };
    this.data.users.push(user);
    this.event('account_created', actor, user.id);
    this.save();
    return publicUser(user);
  }
  update(id, input, actor) {
    this.load();
    const user = this.user(id), fields = profile({ ...user, ...input });
    if (this.data.users.some(u => u.id !== id && u.phone === fields.phone)) fail(409, '该手机号已存在');
    const next = { ...fields, is_admin: input.is_admin ?? user.is_admin, active: input.active ?? user.active };
    if (user.active && user.is_admin && (!next.active || !next.is_admin) && !this.data.users.some(u => u.id !== id && u.active && u.is_admin)) fail(409, '至少保留一个启用的管理员');
    Object.assign(user, next, { updated_at: new Date().toISOString() });
    this.revoke(id);
    this.event('account_updated', actor, id);
    this.save();
    return publicUser(user);
  }
  user(id) { return this.data.users.find(u => u.id === id) || fail(404, '账号不存在'); }
  revoke(id) { this.data.sessions = this.data.sessions.filter(s => s.user_id !== id); }
  reset(id, password, actor) {
    this.load();
    const user = this.user(id), hash = passwordHash(password);
    if (passwordMatches(password, user.password_hash)) fail(400, '新密码不能与当前密码相同');
    Object.assign(user, { password_hash: hash, must_change_password: true, updated_at: new Date().toISOString() });
    this.revoke(id);
    this.event('password_reset', actor, id);
    this.save();
    return publicUser(user);
  }
  rate(keys, consume = false) {
    const now = Date.now();
    for (const [key, value] of this.rates) if (value.until <= now) this.rates.delete(key);
    for (const [key, limit] of keys) {
      const entry = this.rates.get(key);
      if (entry && entry.count >= limit) fail(429, '尝试次数过多，请在 15 分钟后重试');
    }
    if (consume) for (const [key] of keys) {
      const entry = this.rates.get(key) || { count: 0, until: now + RATE_MS };
      entry.count++;
      this.rates.set(key, entry);
    }
  }
  issue(user) {
    const token = crypto.randomBytes(32).toString('base64url'), now = Date.now();
    this.data.sessions = this.data.sessions.filter(s => s.expires_at > now);
    const existing = this.data.sessions.filter(s => s.user_id === user.id);
    for (const old of existing.slice(0, Math.max(0, existing.length - 9))) this.data.sessions.splice(this.data.sessions.indexOf(old), 1);
    this.data.sessions.push({ token_hash: digest(token), user_id: user.id, expires_at: now + SESSION_MS });
    return { user: publicUser(user), token };
  }
  login(input, ip) {
    this.load();
    const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
    const keys = [['login-ip:' + ip, 40], ['login-phone:' + digest(phone), 10]];
    this.rate(keys, true);
    const user = this.data.users.find(u => u.phone === phone);
    const valid = passwordMatches(input.password, user?.password_hash || this.dummyHash);
    if (!user || !user.active || !valid) fail(401, '手机号或密码错误，或账号已停用');
    const result = this.issue(user);
    this.event('login', user.id, user.id);
    this.save();
    return result;
  }
  current(cookie = '') {
    this.load();
    const token = cookie.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    if (!token || token.length > 100) return null;
    const token_hash = digest(token), session = this.data.sessions.find(s => s.token_hash === token_hash && s.expires_at > Date.now());
    const user = session && this.data.users.find(u => u.id === session.user_id && u.active);
    return user ? { user: publicUser(user), token_hash } : null;
  }
  logout(session) {
    this.load();
    this.data.sessions = this.data.sessions.filter(s => s.token_hash !== session.token_hash);
    this.event('logout', session.user.id, session.user.id);
    this.save();
  }
  change(session, input) {
    this.load();
    this.rate([['change:' + session.user.id, 10]], true);
    const user = this.user(session.user.id);
    if (!this.data.sessions.some(s => s.token_hash === session.token_hash && s.expires_at > Date.now()) || !user.active) fail(401, '登录已失效，请重新登录');
    if (!passwordMatches(input.current_password, user.password_hash)) fail(400, '当前密码不正确');
    const hash = passwordHash(input.new_password);
    if (passwordMatches(input.new_password, user.password_hash)) fail(400, '新密码不能与当前密码相同');
    Object.assign(user, { password_hash: hash, must_change_password: false, updated_at: new Date().toISOString() });
    this.revoke(user.id);
    const result = this.issue(user);
    this.event('password_changed', user.id, user.id);
    this.save();
    return result;
  }
}

function createAuth({ dataDir, send, env = process.env }) {
  const auth = new Auth(path.join(dataDir, 'auth.json'), env);
  function cookie(req, res, token) {
    const secure = env.CSR_COOKIE_SECURE === '1' || req.socket.encrypted;
    res.setHeader('Set-Cookie', COOKIE + '=' + (token || '') + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + (token ? SESSION_MS / 1000 : 0) + (secure ? '; Secure' : ''));
  }
  async function body(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) fail(413, '请求体过大');
      chunks.push(chunk);
    }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; }
    catch { fail(400, 'JSON 格式无效'); }
  }
  const redirect = (res, to) => { res.writeHead(303, { Location: to, 'Cache-Control': 'no-store' }); res.end(); };
  async function adminBody(req) {
    const value = await body(req);
    // A request body may arrive after another request disables or demotes its sender.
    const current = auth.current(req.headers.cookie);
    if (!current) fail(401, '登录已失效，请重新登录');
    if (!current.user.is_admin || current.user.must_change_password) fail(403, '仅管理员可管理账号');
    return value;
  }
  async function gate(req, res) {
    const pathname = req.url.split('?')[0];
    const isRead = ['GET', 'HEAD'].includes(req.method);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (!isRead) {
      let sameOrigin = true;
      try { if (req.headers.origin) sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { sameOrigin = false; }
      if (!sameOrigin || req.headers['sec-fetch-site'] === 'cross-site') fail(403, '请在本站页面内操作');
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415, '请使用 application/json 提交请求');
    }
    if (pathname === '/api/health' && req.method === 'GET') { send(res, 200, { ok: true }); return true; }
    if (['/login', '/login.html', '/auth.css', '/login.js'].includes(pathname) && isRead) return false;
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const result = auth.login(await body(req), req.socket.remoteAddress);
      cookie(req, res, result.token); send(res, 200, { user: result.user }); return true;
    }
    const session = auth.current(req.headers.cookie);
    if (!session) {
      if (pathname.startsWith('/api/')) { cookie(req, res, null); send(res, 401, { error: '请先登录', code: 'LOGIN_REQUIRED' }); }
      else redirect(res, '/login');
      return true;
    }
    req.user = session.user;
    if (pathname === '/api/auth/me' && req.method === 'GET') { send(res, 200, { user: session.user }); return true; }
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      auth.logout(session); cookie(req, res, null); send(res, 200, { ok: true }); return true;
    }
    if (pathname === '/api/auth/password' && req.method === 'POST') {
      const result = auth.change(session, await body(req)); cookie(req, res, result.token); send(res, 200, { user: result.user }); return true;
    }
    if (session.user.must_change_password && !['/account', '/account.html', '/account.js', '/auth.css', '/auth-client.js'].includes(pathname)) {
      if (pathname.startsWith('/api/')) send(res, 403, { error: '请先修改初始或重置密码', code: 'PASSWORD_CHANGE_REQUIRED' });
      else redirect(res, '/account');
      return true;
    }
    if (pathname === '/accounts' || pathname === '/accounts.html' || pathname.startsWith('/api/accounts')) {
      if (!session.user.is_admin) fail(403, '仅管理员可管理账号');
      if (pathname === '/api/accounts' && req.method === 'GET') { send(res, 200, { users: auth.list() }); return true; }
      if (pathname === '/api/accounts' && req.method === 'POST') { send(res, 201, { user: auth.create(await adminBody(req), session.user.id) }); return true; }
      const match = pathname.match(/^\/api\/accounts\/([a-f0-9-]+)(\/password)?$/);
      if (match && req.method === (match[2] ? 'POST' : 'PATCH')) {
        const input = await adminBody(req);
        const user = match[2] ? auth.reset(match[1], input.password, session.user.id) : auth.update(match[1], input, session.user.id);
        send(res, 200, { user }); return true;
      }
    }
    return false;
  }
  return { gate, auth };
}
module.exports = { Auth, createAuth, passwordHash, passwordMatches, SESSION_MS };
