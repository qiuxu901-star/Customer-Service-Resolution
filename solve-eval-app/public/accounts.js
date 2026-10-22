'use strict';
(() => {
  const el = id => document.getElementById(id), escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let users = [], editing = null, mode = 'create', saving = false;
  const dialog = el('accountDialog'), form = el('accountForm');
  async function load() { users = (await CsrAuth.request('GET', '/api/accounts')).users; render(); }
  function render() {
    const query = el('accountSearch').value.trim().toLowerCase();
    const rows = users.filter(user => [user.name, user.phone, user.position].some(v => v.toLowerCase().includes(query)));
    el('accountCount').textContent = users.length + ' 个账号 · ' + users.filter(user => user.active).length + ' 个已启用';
    el('accountRows').innerHTML = rows.length ? rows.map(user => '<tr><td><strong>' + escape(user.name) + '</strong>' + (user.id === CsrAuth.user.id ? '<small>当前账号</small>' : '') + '</td><td>' + escape(user.phone) + '</td><td>' + escape(user.position) + '</td><td>' + (user.is_admin ? '管理员' : '成员') + '</td><td><span class="account-status ' + (user.active ? 'enabled' : '') + '">' + (user.active ? '已启用' : '已停用') + '</span>' + (user.must_change_password ? '<small>待修改密码</small>' : '') + '</td><td class="account-actions"><button data-edit="' + user.id + '">编辑</button><button data-reset="' + user.id + '">重置密码</button><button data-toggle="' + user.id + '">' + (user.active ? '停用' : '启用') + '</button></td></tr>').join('') : '<tr><td colspan="6" class="empty-accounts">没有符合条件的账号</td></tr>';
  }
  function open(nextMode, user) {
    mode = nextMode; editing = user || null; el('accountFormError').textContent = '';
    el('accountDialogTitle').textContent = mode === 'create' ? '新建账号' : mode === 'reset' ? '重置密码 · ' + user.name : '编辑账号';
    let html = '';
    if (mode !== 'reset') html += '<label>手机号<input name="phone" type="tel" inputmode="numeric" autocomplete="off" pattern="1[3-9][0-9]{9}" maxlength="11" value="' + escape(user?.phone) + '" required></label><label>姓名<input name="name" maxlength="50" value="' + escape(user?.name) + '" required></label><label>岗位<input name="position" maxlength="100" value="' + escape(user?.position) + '" placeholder="如：产品经理、客服运营" required></label><label class="check-label"><input name="is_admin" type="checkbox" ' + (user?.is_admin ? 'checked' : '') + '>授予账号管理权限</label>';
    if (mode !== 'edit') html += '<p class="password-explainer">' + (mode === 'reset' ? '重置后，该账号所有设备的登录将失效。' : '') + '请将临时密码提供给本人，首次登录必须修改。</p><label>临时密码<input name="password" type="password" autocomplete="new-password" minlength="10" maxlength="128" required placeholder="10–128 个字符"></label><label>再次输入临时密码<input name="confirmation" type="password" autocomplete="new-password" minlength="10" maxlength="128" required></label>';
    if (mode === 'edit') html += '<p class="password-explainer">保存后该账号需重新登录，权限立即更新。</p>';
    el('accountFields').innerHTML = html;
    el('saveAccount').textContent = mode === 'reset' ? '确认重置密码' : '保存账号';
    dialog.showModal(); form.querySelector('input')?.focus();
  }
  function close() { if (!saving) { dialog.close(); form.reset(); el('accountFields').innerHTML = ''; } }
  el('newAccount').onclick = () => open('create');
  el('accountSearch').oninput = render;
  el('closeAccountDialog').onclick = close; el('cancelAccountDialog').onclick = close;
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  el('accountRows').addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    const id = button.dataset.edit || button.dataset.reset || button.dataset.toggle, user = users.find(item => item.id === id);
    if (button.dataset.edit) return open('edit', user);
    if (button.dataset.reset) return open('reset', user);
    if (!confirm((user.active ? '停用后，该账号将立即退出且无法登录。确认停用 ' : '确认启用 ') + user.name + '？')) return;
    button.disabled = true; el('accountsError').textContent = '';
    try {
      await CsrAuth.request('PATCH', '/api/accounts/' + id, { active: !user.active });
      if (id === CsrAuth.user.id) return location.replace('/login');
      await load(); el('accountsNotice').textContent = '账号状态已更新。';
    } catch (error) { el('accountsError').textContent = error.message; button.disabled = false; }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (saving) return;
    const fields = form.elements;
    if (mode !== 'edit' && fields.password.value !== fields.confirmation.value) { el('accountFormError').textContent = '两次临时密码不一致'; return; }
    const body = mode === 'reset' ? { password: fields.password.value } : { phone: fields.phone.value.trim(), name: fields.name.value.trim(), position: fields.position.value.trim(), is_admin: fields.is_admin.checked, ...(mode === 'create' ? { password: fields.password.value } : {}) };
    saving = true; el('saveAccount').disabled = true; el('accountFormError').textContent = '';
    try {
      const url = '/api/accounts' + (editing ? '/' + editing.id : '') + (mode === 'reset' ? '/password' : '');
      await CsrAuth.request(mode === 'edit' ? 'PATCH' : 'POST', url, body);
      saving = false; close();
      if (editing?.id === CsrAuth.user.id) return location.replace('/login');
      await load(); el('accountsNotice').textContent = mode === 'create' ? '账号已创建，请将手机号和临时密码提供给本人。' : mode === 'reset' ? '密码已重置，原有登录已失效。请将临时密码提供给本人。' : '账号信息已更新，该账号需重新登录。';
    } catch (error) { el('accountFormError').textContent = error.message; }
    finally { saving = false; el('saveAccount').disabled = false; }
  });
  CsrAuth.ready.then(user => { if (!user.is_admin) throw Error('仅管理员可管理账号'); return load(); }).catch(error => { el('accountsError').textContent = error.message; });
})();
