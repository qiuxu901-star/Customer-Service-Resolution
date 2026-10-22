'use strict';
window.CsrAuth = (() => {
  let user = null;
  const rawFetch = window.fetch.bind(window);
  // Existing feature modules share this boundary, including background polling.
  window.fetch = async (...args) => {
    const response = await rawFetch(...args);
    const target = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    if (typeof target === 'string' && target.startsWith('/api/') && !target.startsWith('/api/auth/')) {
      if (response.status === 401) location.replace('/login');
      else if (response.status === 403) {
        const value = await response.clone().json().catch(() => ({}));
        if (value.code === 'PASSWORD_CHANGE_REQUIRED') location.replace('/account');
      }
    }
    return response;
  };
  async function request(method, url, body) {
    const response = await window.fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (response.status === 401) location.replace('/login');
    if (!response.ok) throw Error(result.error || '请求失败，请稍后重试');
    return result;
  }
  async function logout() {
    await request('POST', '/api/auth/logout', {});
    try { for (const key of ['csr-business-actor', 'csr-workspace-conversation', 'se_operator']) localStorage.removeItem(key); } catch {}
    location.replace('/login');
  }
  const ready = request('GET', '/api/auth/me').then(result => {
    user = result.user;
    const host = document.getElementById('authIdentity');
    if (host) {
      const label = document.createElement('span'); label.textContent = user.name + ' · ' + user.position; host.append(label);
      if (user.is_admin && !user.must_change_password) { const link = document.createElement('a'); link.href = '/accounts'; link.textContent = '账号管理'; host.append(link); }
      const account = document.createElement('a'); account.href = '/account'; account.textContent = '修改密码'; host.append(account);
      const exit = document.createElement('button'); exit.type = 'button'; exit.textContent = '退出登录'; exit.onclick = () => logout().catch(error => alert(error.message)); host.append(exit);
    }
    const actor = document.getElementById('actor');
    if (actor) { actor.value = user.name; actor.readOnly = true; actor.title = '当前登录账号'; }
    return user;
  });
  // A rejected identity request must not become an unhandled rejection on the workbench.
  ready.catch(() => {});
  return { ready, request, logout, get user() { return user; } };
})();
