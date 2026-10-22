'use strict';
document.getElementById('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('button[type="submit"]'), error = document.getElementById('loginError');
  error.textContent = ''; button.disabled = true; button.textContent = '正在登录…';
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: form.elements.phone.value.trim(), password: form.elements.password.value }) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '登录失败，请稍后重试');
    try { for (const key of ['csr-business-actor', 'csr-workspace-conversation', 'se_operator']) localStorage.removeItem(key); } catch {}
    location.replace(result.user.must_change_password ? '/account' : '/');
  } catch (failure) {
    error.textContent = failure.message;
    button.disabled = false; button.textContent = '登录工作空间 ↗';
  }
});
