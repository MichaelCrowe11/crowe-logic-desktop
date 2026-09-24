#!/usr/bin/env node
'use strict';
// Two actual Electron main processes, one isolated profile. Lose a committed
// notebook-save reply, flush Chromium storage and exit, then recover via the real
// UI/preload/production host. This is orderly restart, not crash/power-loss proof.
const { app, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-vision-recovery-')));
fs.writeFileSync(path.join(root, '.vision-recovery-test'), 'isolated Vision recovery fixture\n', { mode: 0o600 });
const home = path.join(root, 'runner-home'), profile = path.join(root, 'runner-profile');
for (const dir of [home, profile]) fs.mkdirSync(dir, { mode: 0o700 });
const inherited = { PATH: process.env.PATH || '', LANG: 'en_US.UTF-8', ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}) };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, inherited, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache') });
os.homedir = () => home;
app.commandLine.appendSwitch('user-data-dir', profile);
app.setPath('home', home); app.setPath('userData', profile); app.setPath('sessionData', profile);
for (const name of ['logs', 'documents', 'downloads', 'temp', 'crashDumps', 'appData']) {
  const dir = path.join(root, 'runner-paths', name); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); app.setPath(name, dir);
}
process.env.TMPDIR = process.env.TMP = process.env.TEMP = app.getPath('temp');
safeStorage.isEncryptionAvailable = () => false;
safeStorage.encryptString = safeStorage.decryptString = () => { throw new Error('Credential access disabled in recovery launcher'); };
shell.openExternal = async () => { throw new Error('External navigation disabled in recovery launcher'); };
assert.ok(!app.commandLine.hasSwitch('no-sandbox') && !app.commandLine.hasSwitch('disable-setuid-sandbox'), 'Chromium sandbox must remain enabled');
const reports = [];
function run(stage) {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomUUID();
    const child = spawn(process.execPath, [path.join(__dirname, 'test-vision-fixture.js'), `--vision-stage=${stage}`, `--vision-root=${root}`, `--vision-nonce=${nonce}`], {
      cwd: root, env: { ...process.env }, stdio: ['ignore', 'inherit', 'inherit'],
    });
    let timedOut = false, killTimer;
    const timer = setTimeout(() => {
      timedOut = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, 90000);
    child.once('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      try {
        assert.ok(!timedOut && code === 0, `${stage} ${timedOut ? 'timed out' : `failed (${code ?? signal})`}; only owned PID ${child.pid} targeted`);
        const report = JSON.parse(fs.readFileSync(path.join(root, `${stage}-result.json`), 'utf8'));
        assert.equal(report.stage, stage); assert.equal(report.pid, child.pid); assert.equal(report.nonce, nonce);
        assert.equal(report.profile, path.join(root, 'profile')); assert.equal(report.syntheticOnly, true);
        assert.ok(report.checks > 0); reports.push(report); resolve();
      } catch (error) { reject(error); }
    });
  });
}
(async () => {
  let code = 0;
  try {
    await run('lose-response');
    await run('reconcile');
    assert.notEqual(reports[0].pid, reports[1].pid); assert.notEqual(reports[0].nonce, reports[1].nonce);
    assert.equal(reports[0].id, reports[1].id); assert.deepEqual(reports[0].notebookHashes, reports[1].notebookHashes);
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ checks: reports.reduce((n, r) => n + r.checks, 0),
      scope: 'Full-process orderly restart after lost save response; synthetic gateway, real decoder/main/preload/renderer. Not crash or power-loss proof.', reports }, null, 2), { mode: 0o600 });
    console.log(`Vision recovery live: both actual-app processes passed. Evidence: ${root}`);
  } catch (error) { code = 1; console.error(error.stack, `\nPreserved evidence: ${root}`); }
  app.exit(code);
})();
