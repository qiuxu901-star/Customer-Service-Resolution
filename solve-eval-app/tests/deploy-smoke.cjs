'use strict';
// Exercise the real deployment script without systemd or production files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-deploy-test-'));
const script = path.resolve(__dirname, '../../scripts/deploy.sh');
function write(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}
function nodeShim(file, source) { write(file, '#!' + process.execPath + '\n' + source, 0o755); }
(async () => {
  try {
    const app = path.join(root, 'app');
    const units = path.join(root, 'units');
    const bin = path.join(root, 'bin');
    const stateFile = path.join(root, 'systemctl.json');
    const logFile = path.join(root, 'systemctl.log');
    const legacyFile = path.join(app, 'solve-eval-app/data/db.json');
    const unitFile = path.join(units, 'csr.service');
    write(legacyFile, '{"old_record":"keep-out-of-new-data","settings":{"model":"old"}}');
    write(unitFile, 'original legacy service config\n');
    write(stateFile, '{"active":true}');
    nodeShim(path.join(bin, 'systemctl'), `
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),command=args[0],state=JSON.parse(fs.readFileSync(process.env.FAKE_SYSTEMCTL_STATE,'utf8'));
fs.appendFileSync(process.env.FAKE_SYSTEMCTL_LOG,args.join(' ')+'\\n');
if(command==='is-active')process.exit(state.active?0:3);
if(command==='show'){console.log(fs.existsSync(path.join(process.env.SYSTEMD_UNIT_DIR,'csr.service'))?'loaded':'not-found');process.exit(0);}
if(command==='stop')state.active=false;
if(command==='restart')state.active=true;
fs.writeFileSync(process.env.FAKE_SYSTEMCTL_STATE,JSON.stringify(state));
`);
    nodeShim(path.join(bin, 'mv'), `
const fs=require('node:fs'),args=process.argv.slice(2).filter(x=>!x.startsWith('-'));
fs.renameSync(args[0],args[1]);
`);
    write(path.join(bin, 'curl'), '#!/bin/sh\nexit "${FAKE_CURL_FAIL:-0}"\n', 0o755);
    write(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', 0o755);
    const fixture = path.join(root, 'fixture/customer-service-resolution');
    write(path.join(fixture, 'solve-eval-app/server.js'), "'use strict';\n");
    const tarball = path.join(root, 'candidate.tar.gz');
    const tar = spawnSync('tar', ['-czf', tarball, '-C', path.dirname(fixture), path.basename(fixture)]);
    assert.equal(tar.status, 0, tar.stderr.toString());
    const port = await new Promise((resolve, reject) => {
      const listener = net.createServer();
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        const value = listener.address().port;
        listener.close(() => resolve(value));
      });
    });
    const env = {
      ...process.env,
      PATH: bin + path.delimiter + process.env.PATH,
      NODE_BIN: process.execPath,
      APP_DIR: app,
      PORT: String(port),
      SUDO_USER: os.userInfo().username,
      SYSTEMD_UNIT_DIR: units,
      FAKE_SYSTEMCTL_STATE: stateFile,
      FAKE_SYSTEMCTL_LOG: logFile,
    };
    function deploy(extra = {}, archive = tarball) {
      return spawnSync('bash', [script, archive], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
    }
    const beforeData = fs.readFileSync(legacyFile, 'utf8');
    const beforeUnit = fs.readFileSync(unitFile, 'utf8');
    const dry = deploy({ RESET_DATA: '1', DEPLOY_DRY_RUN: '1' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(fs.existsSync(logFile), false, 'dry run must not call systemctl');
    assert.equal(fs.readFileSync(legacyFile, 'utf8'), beforeData);
    assert.equal(fs.readFileSync(unitFile, 'utf8'), beforeUnit);
    const reset = deploy({ RESET_DATA: '1' });
    assert.equal(reset.status, 0, reset.stderr + reset.stdout);
    const firstRelease = fs.readlinkSync(path.join(app, 'current'));
    const cleanData = fs.readlinkSync(path.join(firstRelease, 'solve-eval-app/data'));
    assert.deepEqual(fs.readdirSync(cleanData), [], 'reset must not import old records or keys');
    assert.equal(fs.readFileSync(legacyFile, 'utf8'), beforeData);
    assert.ok(fs.readFileSync(unitFile, 'utf8').includes('CSR_DATA_DIR=' + cleanData));
    const snapshot = '{"new_record":"persist-on-next-update","settings":{}}';
    write(path.join(cleanData, 'db.json'), snapshot);
    const accounts = '{"version":1,"users":[{"id":"synthetic-admin"}],"sessions":[],"audit":[]}';
    write(path.join(cleanData, 'auth.json'), accounts);
    const update = deploy();
    assert.equal(update.status, 0, update.stderr + update.stdout);
    const updatedRelease = fs.readlinkSync(path.join(app, 'current'));
    assert.notEqual(updatedRelease, firstRelease);
    assert.equal(fs.readlinkSync(path.join(updatedRelease, 'solve-eval-app/data')), cleanData);
    assert.equal(fs.readFileSync(path.join(cleanData, 'db.json'), 'utf8'), snapshot);
    assert.equal(fs.readFileSync(path.join(cleanData, 'auth.json'), 'utf8'), accounts);
    assert.ok(fs.readdirSync(path.join(app, 'backups')).some(name => {
      const file = path.join(app, 'backups', name, 'auth.json');
      return fs.existsSync(file) && fs.readFileSync(file, 'utf8') === accounts;
    }), 'normal upgrade backs up account data');
    const goodUnit = fs.readFileSync(unitFile, 'utf8');
    const failed = deploy({ RESET_DATA: '1', FAKE_CURL_FAIL: '1' });
    assert.equal(failed.status, 1, failed.stderr + failed.stdout);
    assert.equal(fs.readlinkSync(path.join(app, 'current')), updatedRelease);
    assert.equal(fs.readFileSync(unitFile, 'utf8'), goodUnit);
    assert.equal(fs.readFileSync(path.join(cleanData, 'db.json'), 'utf8'), snapshot);
    assert.equal(fs.readFileSync(path.join(cleanData, 'auth.json'), 'utf8'), accounts);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).active, true);
    assert.match(failed.stdout, /已恢复旧版本链接和服务配置/);
    // A legacy installation must also recover its original unit on first-update failure.
    const legacyApp = path.join(root, 'legacy-app');
    write(path.join(legacyApp, 'solve-eval-app/data/db.json'), beforeData);
    write(unitFile, beforeUnit);
    const legacy = spawnSync('bash', [script, tarball], {
      env: { ...env, APP_DIR: legacyApp, RESET_DATA: '1', FAKE_CURL_FAIL: '1' }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(legacy.status, 1, legacy.stderr + legacy.stdout);
    assert.equal(fs.existsSync(path.join(legacyApp, 'current')), false);
    assert.equal(fs.readFileSync(unitFile, 'utf8'), beforeUnit);
    assert.equal(fs.readFileSync(path.join(legacyApp, 'solve-eval-app/data/db.json'), 'utf8'), beforeData);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).active, true);
    console.log(JSON.stringify({ dry_run_non_mutating: true, reset_uses_empty_data: true, subsequent_update_preserves_current_data: true, failure_restores_unit_and_version: true, legacy_failure_recovers: true, production_touched: false }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
