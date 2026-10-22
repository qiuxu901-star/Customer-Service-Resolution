'use strict';
// Server-local recovery: no public registration or unauthenticated reset endpoint.
const path = require('node:path');
const { Writable } = require('node:stream');
const readline = require('node:readline/promises');
const { Auth } = require('./auth');

async function main() {
  const command = process.argv[2];
  if (!['create-admin', 'reset-password'].includes(command)) throw Error('用法：node manage-accounts.js create-admin | reset-password');
  if (!process.stdin.isTTY) throw Error('请在交互终端中运行，密码通过隐藏输入读取');
  const output = new Writable({ write(chunk, encoding, done) { if (!output.muted) process.stdout.write(chunk, encoding); done(); } });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  const ask = async (prompt, secret = false) => {
    const answer = rl.question(prompt);
    output.muted = secret;
    try { return await answer; } finally { output.muted = false; if (secret) process.stdout.write('\n'); }
  };
  try {
    const phone = (await ask('手机号：')).trim();
    const fields = command === 'create-admin' ? { phone, name: await ask('姓名：'), position: await ask('岗位：'), is_admin: true } : null;
    const password = await ask('临时密码（10–128 个字符）：', true);
    if (password !== await ask('再次输入临时密码：', true)) throw Error('两次密码不一致，未修改账号');
    const dataDir = path.resolve(process.env.CSR_DATA_DIR || path.join(__dirname, 'data'));
    const auth = new Auth(path.join(dataDir, 'auth.json'), {});
    if (fields) auth.create({ ...fields, password }, 'server-console');
    else {
      const user = auth.list().find(u => u.phone === phone);
      if (!user) throw Error('账号不存在');
      auth.reset(user.id, password, 'server-console');
    }
    console.log('已' + (fields ? '创建管理员' : '重置密码') + '。请使用临时密码登录并设置自己的密码。');
  } finally { rl.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
