'use strict';
CsrAuth.ready.then(user => {
  document.getElementById('accountProfile').textContent = user.name + ' / ' + user.phone + ' / ' + user.position;
  if (user.must_change_password) document.getElementById('passwordHint').textContent = '当前使用初始或重置密码。请先设置自己的新密码，再进入工作空间。';
}).catch(error => { document.getElementById('passwordError').textContent = error.message; });
document.getElementById('passwordForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, fields = form.elements, error = document.getElementById('passwordError'), button = form.querySelector('button');
  error.textContent = '';
  if (fields.new_password.value !== fields.confirmation.value) { error.textContent = '两次新密码不一致'; return; }
  button.disabled = true;
  try {
    await CsrAuth.request('POST', '/api/auth/password', { current_password: fields.current_password.value, new_password: fields.new_password.value });
    form.reset(); location.replace('/');
  } catch (failure) { error.textContent = failure.message; button.disabled = false; }
});
