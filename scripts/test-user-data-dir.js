#!/usr/bin/env node
'use strict';

// node scripts/test-user-data-dir.js             synthetic native-process suite
// node scripts/test-user-data-dir.js --source-only    unit suite (legacy alias)
// Electron children load ONLY edition-bootstrap, never main/auth/app services.
// All OS paths are redirected before ready; every launch also has a disposable
// --user-data-dir as a pre-bootstrap guard. Packaged POLICY is tested through a
// native-app facade; this is not acceptance of an installed signed package or
// the OS's default appData in a disposable account/VM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const option = name => process.argv.find(arg => arg.startsWith(`--fixture-${name}=`))?.slice(`--fixture-${name}=`.length);
const MARKER = 'synthetic edition bootstrap fixture v1\n';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function child() {
  const { app, safeStorage } = require('electron');
  const root = option('root'), id = option('id');
  assert.ok(root && path.isAbsolute(root) && path.dirname(root) === ROOT);
  assert.match(path.basename(root), /^\.edition-native-/);
  assert.equal(fs.readFileSync(path.join(root, '.fixture'), 'utf8'), MARKER);
  assert.match(id, /^[a-z0-9-]+$/);
  const guard = app.commandLine.getSwitchValue('user-data-dir');
  assert.ok(guard && path.resolve(guard).startsWith(root + path.sep));
  // Do not permit a switch regression to initialize an actual profile.
  assert.equal(fs.realpathSync(app.getPath('userData')), fs.realpathSync(guard));
  assert.equal(fs.realpathSync(app.getPath('sessionData')), fs.realpathSync(guard));
  assert.ok(!app.commandLine.hasSwitch('no-sandbox') && !app.commandLine.hasSwitch('disable-setuid-sandbox'));
  const home = path.join(root, id, 'home');
  for (const name of ['home', 'appData', 'cache', 'temp', 'logs', 'documents', 'downloads', 'crashDumps', 'desktop', 'music', 'pictures', 'videos']) {
    const dir = name === 'appData' ? path.join(root, 'appData') : name === 'home' ? home : path.join(root, id, name);
    fs.mkdirSync(dir, { recursive: true }); app.setPath(name, dir);
  }
  require('node:os').homedir = () => home;
  process.env.HOME = process.env.USERPROFILE = home;
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = app.getPath('temp');
  safeStorage.isEncryptionAvailable = () => { throw new Error('No credential access in bootstrap fixture'); };
  safeStorage.encryptString = safeStorage.decryptString = safeStorage.isEncryptionAvailable;
  // Guard against accidental future JS transport additions. No session/window,
  // model, auth, or full-main imports are used by this native lock fixture.
  const deny = () => { throw new Error('Network disabled in bootstrap fixture'); };
  global.fetch = deny;
  for (const name of ['node:http', 'node:https']) { require(name).request = deny; require(name).get = deny; }
  require('node:net').Socket.prototype.connect = deny; require('node:tls').connect = deny;
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('proxy-server', '127.0.0.1:9');
  if (option('default') === 'yes') app.commandLine.removeSwitch('user-data-dir');
  const edition = option('edition');
  // Different names exercise cross-edition native-lock scope, not an app-wide
  // handmade lock. The facade injects ONLY packaged metadata selection.
  app.setName(`Synthetic ${edition}`);
  const nativeApp = {
    isPackaged: option('packaged') === 'yes', commandLine: app.commandLine,
    getPath: app.getPath.bind(app), setPath: app.setPath.bind(app),
    on: app.on.bind(app), removeListener: app.removeListener.bind(app),
    requestSingleInstanceLock: app.requestSingleInstanceLock.bind(app),
  };
  const send = event => process.stdout.write(`FIXTURE ${JSON.stringify({ id, ...event })}\n`);
  const startup = require('../edition-bootstrap').bootstrapEdition({ app: nativeApp, metadata: { croweEdition: edition }, env: {} });
  if (!startup.primary) {
    // Return remains necessary if app.exit returns control. No application
    // writer sentinel below may ever be created by this process.
    app.exit(0);
    return;
  }
  fs.writeFileSync(path.join(root, `${id}.writer`), 'primary-only fixture writer\n');
  send({ event: 'locked', profile: app.getPath('userData'), session: app.getPath('sessionData') });
  let activations = 0, window = null, creates = 0;
  const access = { getWindow: () => window, createWindow() {
    creates++;
    window = { isDestroyed: () => false, isMinimized: () => true,
      restore: () => {}, show: () => {}, focus: () => send({ event: 'focused', creates }) };
  } };
  app.on('second-instance', () => send({ event: 'second-instance', count: ++activations }));
  require('node:readline').createInterface({ input: process.stdin }).on('line', command => {
    if (command === 'windows') startup.windowsReady(access);
    if (command === 'destroy') { window = null; send({ event: 'destroyed' }); }
    if (command === 'activate') app.emit('activate');
    if (command === 'stop') app.exit(0);
  });
  app.whenReady().then(() => send({ event: 'ready' }));
  setTimeout(() => app.exit(2), 30000);
}

async function runProcesses() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, '.edition-native-')));
  fs.writeFileSync(path.join(root, '.fixture'), MARKER);
  const children = [];
  // An Electron invocation remains supported, but Node is preferable for the
  // coordinator since it never initializes Chromium's own parent profile.
  const electron = process.versions.electron ? process.execPath : require('electron');
  let checks = 0;
  const check = (condition, label) => { assert.ok(condition, label); checks++; console.log(`ok - ${label}`); };
  function launch(id, { edition = 'desktop', packaged = false, profile, defaults = false } = {}) {
    const guard = profile || path.join(root, id, 'guard'); fs.mkdirSync(guard, { recursive: true });
    const own = path.join(root, id); fs.mkdirSync(own, { recursive: true });
    const env = { PATH: process.env.PATH || '', LANG: 'en_US.UTF-8', HOME: own, USERPROFILE: own,
      TMPDIR: own, TMP: own, TEMP: own, XDG_CONFIG_HOME: own, XDG_DATA_HOME: own, XDG_CACHE_HOME: own,
      ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}) };
    const proc = spawn(electron, [__filename, `--fixture-root=${root}`, `--fixture-id=${id}`, `--fixture-edition=${edition}`,
      `--fixture-packaged=${packaged ? 'yes' : 'no'}`, `--fixture-default=${defaults ? 'yes' : 'no'}`, `--user-data-dir=${guard}`],
    { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const events = []; let buffer = '', stderr = '', ended = false, exitCode;
    const closed = new Promise(resolve => proc.once('close', (code, signal) => { ended = true; exitCode = code; resolve({ code, signal }); }));
    proc.once('error', error => { stderr += String(error); });
    proc.stdout.on('data', bytes => {
      buffer += bytes;
      while (buffer.includes('\n')) {
        const i = buffer.indexOf('\n'), line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        if (line.startsWith('FIXTURE ')) events.push(JSON.parse(line.slice(8)));
      }
    });
    proc.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-5000); });
    async function wait(event, count = 1) {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const matching = events.filter(item => item.event === event);
        if (matching.length >= count) return matching[count - 1];
        if (ended) throw new Error(`${id} exited ${exitCode} before ${event}: ${stderr}`);
        await sleep(25);
      }
      throw new Error(`${id}: timed out waiting for ${event}: ${stderr}`);
    }
    const item = { proc, events, closed, wait, command: command => { if (!ended) proc.stdin.write(command + '\n'); },
      async stop() {
        if (!ended) item.command('stop');
        const timer = setTimeout(() => { if (!ended) proc.kill('SIGKILL'); }, 2000);
        try { return await closed; } finally { clearTimeout(timer); }
      },
    };
    children.push(item); return item;
  }
  async function rejected(id, options) {
    const p = launch(id, options);
    const timer = setTimeout(() => p.proc.kill('SIGKILL'), 12000);
    try {
      const result = await p.closed;
      check(result.code === 0 && result.signal === null && !fs.existsSync(path.join(root, `${id}.writer`)), `${id}: rejected real process exits before fixture writer`);
    } finally { clearTimeout(timer); }
  }
  try {
    // Six real processes execute the actual packaged/development bootstrap
    // branches against synthetic appData, never regex-extracted policy text.
    for (const packaged of [false, true]) {
      const owners = [];
      for (const [edition, name] of [['desktop', 'Crowe Logic'], ['developers', 'Crowe Logic for Developers'], ['mycology', 'Crowe Logic Mycology']]) {
        const p = launch(`${edition}-${packaged ? 'pkg' : 'dev'}`, { edition, packaged, defaults: true });
        const locked = await p.wait('locked'); await p.wait('ready'); owners.push(p);
        check(locked.profile === path.join(root, 'appData', name) && locked.session === locked.profile,
          `${edition} ${packaged ? 'packaged-policy' : 'development'} selects explicit default userData/sessionData`);
      }
      check(owners.every(p => p.events.some(e => e.event === 'ready')), 'three edition default profiles coexist in native processes');
      await rejected(`default-vs-override-${packaged ? 'pkg' : 'dev'}`, {
        edition: 'desktop', packaged: !packaged, profile: path.join(root, 'appData', 'Crowe Logic Mycology'),
      });
      await owners[2].wait('second-instance');
      for (const p of owners) await p.stop();
    }
    const shared = path.join(root, 'shared with spaces');
    const owner = launch('owner', { edition: 'mycology', packaged: true, profile: shared });
    const selected = await owner.wait('locked'); await owner.wait('ready');
    check(selected.profile === shared && selected.session === shared, 'explicit profile with spaces overrides packaged defaults');
    await rejected('early-other-edition', { edition: 'developers', profile: shared });
    await owner.wait('second-instance');
    check(!owner.events.some(e => e.event === 'focused'), 'early native second-instance waits for window initialization');
    owner.command('windows'); const first = await owner.wait('focused');
    check(first.creates === 1, 'queued native activation creates/restores/focuses one window');
    await rejected('late-same-edition', { edition: 'mycology', packaged: false, profile: shared });
    const second = await owner.wait('focused', 2);
    check(second.creates === 1, 'late native activation reuses the existing window');
    if (process.platform !== 'win32') {
      const alias = path.join(root, 'shared-alias'); fs.symlinkSync(shared, alias);
      await rejected('aliased-profile', { edition: 'desktop', packaged: true, profile: alias });
      await owner.wait('focused', 3);
    }
    const other = launch('different-profile', { edition: 'mycology', profile: path.join(root, 'different-profile-data') });
    await other.wait('ready'); check(true, 'same edition with different explicit profile coexists'); await other.stop();
    const focusCount = owner.events.filter(e => e.event === 'focused').length;
    owner.command('destroy'); await owner.wait('destroyed'); owner.command('activate');
    const recreated = await owner.wait('focused', focusCount + 1);
    check(recreated.creates === 2, 'activation after last window destroyed recreates the primary window');
    await owner.stop();
    const restart = launch('restart', { edition: 'desktop', packaged: true, profile: shared });
    await restart.wait('ready'); check(true, 'profile lock released on real primary-process exit'); await restart.stop();
    console.log(`user-data-dir: ${checks} native-process checks passed; packaged-policy facade, synthetic windows, no installed-package/OS-default acceptance`);
  } finally {
    for (const child of children) await child.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (option('id')) {
  child();
} else if (process.argv.includes('--source-only') || process.argv.includes('--unit')) {
  require('./test-edition-bootstrap').runUnits();
} else if (process.versions.electron) {
  // Safety for the legacy `electron scripts/test-user-data-dir.js` invocation.
  const { app } = require('electron');
  const root = fs.mkdtempSync(path.join(ROOT, '.edition-native-coordinator-'));
  for (const name of ['userData', 'sessionData', 'appData', 'home', 'logs', 'crashDumps', 'temp']) {
    const dir = path.join(root, name); fs.mkdirSync(dir); app.setPath(name, dir);
  }
  runProcesses().then(() => { fs.rmSync(root, { recursive: true, force: true }); app.exit(0); }, error => { console.error(error); app.exit(1); });
} else {
  runProcesses().catch(error => { console.error(error); process.exitCode = 1; });
}
