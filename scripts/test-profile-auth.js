'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createProfileAuth, createAuthSession } = require('../cloud/profile-auth');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-profile-auth-'));
const fakeHome = path.join(root, 'home');
const legacy = path.join(fakeHome, '.config/crowe-logic/auth.json');
fs.mkdirSync(path.dirname(legacy), { recursive: true });
const sentinel = JSON.stringify({ access_token: 'synthetic-global-access', refresh_token: 'synthetic-global-refresh' });
fs.writeFileSync(legacy, sentinel);
const codec = { isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from('SYNTHETIC:' + text),
  decryptString: data => { assert.equal(data.subarray(0, 10).toString(), 'SYNTHETIC:'); return data.subarray(10).toString(); } };
let serial = 0, checks = 0;
function fixture(edition, explicitProfile = false, options = {}) {
  const profile = path.join(root, 'profile-' + serial++);
  fs.mkdirSync(profile);
  let homeReads = 0;
  const store = createProfileAuth({ edition, explicitProfile, getProfile: () => profile,
    getHome: () => { homeReads++; return fakeHome; }, safeStorage: codec, isPackaged: true, ...options });
  return { store, profile, homeReads: () => homeReads };
}
async function check(name, fn) { await fn(); checks++; console.log('ok - ' + name); }
const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const start = main.indexOf('const CROWE_ID =');
const end = main.indexOf('async function licensedFetch', start);
assert(start > 0 && end > start);
function authMain(store, { listenError } = {}) {
  const ipc = new Map(), opened = [], servers = [], timers = new Set(), writes = [], invalidated = [];
  let fetchImpl = async () => { throw new Error('No network allowed'); };
  const context = {
    profileAuth: store, authSession: createAuthSession(), Buffer, URL, URLSearchParams, crypto,
    AbortController, AbortSignal, Date,
    loadConfig: () => store.readAuth(),
    saveConfig: value => { store.writeAuth(value); writes.push(value); },
    fetch: (...args) => fetchImpl(...args), fetchCatalog() {},
    shell: { openExternal: url => opened.push(url) },
    browserSessions: { endAll: async () => {} },
    teamHost: { invalidate() { invalidated.push('team'); } },
    importHost: { invalidate() { invalidated.push('imports'); } },
    setTimeout(fn, ms) { const t = { fn, ms }; timers.add(t); return t; },
    clearTimeout(t) { timers.delete(t); },
    http: { createServer(callback) {
      const server = new EventEmitter();
      server.callback = callback; server.closed = false;
      server.listen = (port, host) => { if (listenError) throw listenError; assert.equal(host, '127.0.0.1'); server.port = port; server.closed = false; server.emit('listening'); };
      server.address = () => ({ port: server.port });
      server.close = () => { server.closed = true; };
      servers.push(server); return server;
    } },
    ipcMain: { handle: (name, fn) => ipc.set(name, fn) },
  };
  vm.runInNewContext(main.slice(start, end) + '\nthis.api = { signIn, refreshToken, migrateLegacyAuth };', context);
  return { ...context.api, opened, servers, timers, writes, invalidated,
    fetchWith(fn) { fetchImpl = fn; }, logout: () => ipc.get('crowe:auth:logout')(),
    callback(server, state, code = 'synthetic-code') {
      const response = { writeHead(status) { this.status = status; }, end() {} };
      return { response, done: server.callback({ url: '/callback?' + new URLSearchParams({ state, code }) }, response) };
    } };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
(async () => {
  try {
    for (const edition of ['developers', 'mycology']) {
      await check(edition + ' never consults global home or local plaintext auth', () => {
        const f = fixture(edition);
        fs.writeFileSync(path.join(f.profile, 'config.json'), JSON.stringify({ token: 'synthetic-local', refreshToken: 'synthetic-local-refresh' }));
        assert.equal(f.store.migrationTokens(), null);
        const a = authMain(f.store); a.migrateLegacyAuth(); a.logout();
        f.store.writeAuth({ token: 'synthetic-own', refreshToken: 'synthetic-own-refresh' });
        f.store.writeKeys({ provider: { value: 'synthetic-provider' } });
        assert.equal(f.store.readKeys().provider.value, 'synthetic-provider');
        assert.equal(f.homeReads(), 0);
        assert.equal(fs.readFileSync(legacy, 'utf8'), sentinel);
      });
    }
    await check('default Desktop reads legacy once without changing CLI source', () => {
      const f = fixture('desktop'); const a = authMain(f.store); a.migrateLegacyAuth();
      assert.equal(f.store.readAuth().token, 'synthetic-global-access');
      assert.equal(f.homeReads(), 1); a.logout(); a.migrateLegacyAuth();
      assert.equal(f.store.readAuth().token, ''); assert.equal(f.homeReads(), 1);
      assert.equal(fs.readFileSync(legacy, 'utf8'), sentinel);
    });
    await check('explicit Desktop ignores global legacy but retains own config compatibility', () => {
      const f = fixture('desktop', true);
      assert.equal(f.store.migrationTokens(), null);
      fs.writeFileSync(path.join(f.profile, 'config.json'), JSON.stringify({ token: 'synthetic-local' }));
      assert.equal(f.store.migrationTokens().token, 'synthetic-local'); assert.equal(f.homeReads(), 0);
    });
    await check('profile config takes precedence without consulting global credentials', () => {
      const f = fixture('desktop');
      fs.writeFileSync(path.join(f.profile, 'config.json'), JSON.stringify({ token: 'synthetic-local' }));
      assert.equal(f.store.migrationTokens().token, 'synthetic-local'); assert.equal(f.homeReads(), 0);
    });
    for (const text of ['', '{}', 'unreadable-synthetic']) {
      await check('any existing auth store blocks legacy import: ' + (text || 'empty'), () => {
        const f = fixture('desktop'); fs.writeFileSync(path.join(f.profile, 'auth.bin'), text);
        assert.equal(f.store.migrationTokens(), null); assert.equal(f.homeReads(), 0);
      });
    }
    await check('three profiles keep auth and provider stores independent under one codec', () => {
      const profiles = ['desktop', 'developers', 'mycology'].map(id => fixture(id));
      profiles.forEach((f, i) => { f.store.writeAuth({ token: 'synthetic-' + i }); f.store.writeKeys({ index: i }); });
      profiles[2].store.writeAuth({ token: '' });
      assert.equal(profiles[0].store.readAuth().token, 'synthetic-0');
      assert.equal(profiles[1].store.readAuth().token, 'synthetic-1');
      profiles.forEach((f, i) => assert.equal(f.store.readKeys().index, i));
    });
    await check('packaged plaintext opt-in still refuses encryption absence', () => {
      const f = fixture('mycology', false, { allowPlaintext: true, safeStorage: { isEncryptionAvailable: () => false } });
      assert.throws(() => f.store.writeAuth({ token: 'synthetic' }), /encryption/);
      assert.throws(() => f.store.writeKeys({ value: 'synthetic' }), /encryption/);
    });
    await check('development-only plaintext auth roundtrips but provider keys refuse', () => {
      const f = fixture('mycology', true, { isPackaged: false, allowPlaintext: true, safeStorage: { isEncryptionAvailable: () => false } });
      f.store.writeAuth({ token: 'synthetic' }); assert.equal(f.store.readAuth().token, 'synthetic');
      assert.throws(() => f.store.writeKeys({ value: 'synthetic' }), /encryption/);
    });
    await check('symlink and hardlink stores cannot overwrite another profile', () => {
      const a = fixture('desktop'), b = fixture('mycology'); a.store.writeAuth({ token: 'synthetic-original' });
      const target = path.join(a.profile, 'auth.bin'), dest = path.join(b.profile, 'auth.bin');
      fs.symlinkSync(target, dest); assert.throws(() => b.store.writeAuth({ token: 'bad' }), /regular file/);
      fs.unlinkSync(dest); fs.linkSync(target, dest); assert.throws(() => b.store.writeAuth({ token: 'bad' }), /regular file/);
      fs.unlinkSync(dest); assert.equal(a.store.readAuth().token, 'synthetic-original');
    });
    await check('failed encryption leaves existing credential bytes unchanged', () => {
      const f = fixture('mycology'); f.store.writeAuth({ token: 'synthetic-original' });
      const before = fs.readFileSync(path.join(f.profile, 'auth.bin'));
      const fail = createProfileAuth({ edition: 'mycology', explicitProfile: true, getProfile: () => f.profile,
        getHome: () => { throw new Error('forbidden'); }, isPackaged: true,
        safeStorage: { ...codec, encryptString() { throw new Error('synthetic failure'); } } });
      assert.throws(() => fail.writeAuth({ token: 'synthetic-new' }), /synthetic failure/);
      assert.deepEqual(fs.readFileSync(path.join(f.profile, 'auth.bin')), before);
      assert.deepEqual(fs.readdirSync(f.profile), ['auth.bin']);
    });
    await check('logout during refresh cannot restore identity and refreshes coalesce', async () => {
      const f = fixture('mycology'); f.store.writeAuth({ token: 'synthetic-old', refreshToken: 'synthetic-refresh' });
      const a = authMain(f.store), response = deferred(); let calls = 0;
      a.fetchWith(() => { calls++; return response.promise; });
      const first = a.refreshToken(), second = a.refreshToken(); assert.equal(first, second);
      await Promise.resolve(); a.logout();
      response.resolve({ json: async () => ({ access_token: 'synthetic-late', refresh_token: 'synthetic-rotated' }) });
      assert.equal(await first, null); assert.equal(calls, 1); assert.equal(f.store.readAuth().token, '');
    });
    await check('successful coalesced refresh persists only its own profile', async () => {
      const f = fixture('developers'); f.store.writeAuth({ token: 'synthetic-old', refreshToken: 'synthetic-refresh' });
      const a = authMain(f.store); a.fetchWith(async () => ({ json: async () => ({ access_token: 'synthetic-new' }) }));
      assert.equal(await a.refreshToken(), 'synthetic-new'); assert.equal(f.store.readAuth().refreshToken, 'synthetic-refresh');
    });
    await check('logout cancels listener/timer and late authorization exchange', async () => {
      const f = fixture('mycology'), a = authMain(f.store), response = deferred();
      a.fetchWith(() => response.promise);
      const login = a.signIn(); assert.equal(a.signIn(), login); assert.equal(a.servers.length, 1);
      const state = new URL(a.opened[0]).searchParams.get('state');
      const invalid = a.callback(a.servers[0], 'wrong-state'); await invalid.done;
      assert.equal(invalid.response.status, 400);
      const callback = a.callback(a.servers[0], state);
      a.logout(); assert.equal((await login).error, 'sign-in cancelled');
      assert.equal(a.servers[0].closed, true); assert.equal(a.timers.size, 0);
      response.resolve({ json: async () => ({ access_token: 'synthetic-late' }) }); await callback.done;
      assert.equal(f.store.readAuth().token, '');
    });
    await check('two editions reject each other\'s callback state and can sign in independently', async () => {
      const one = fixture('developers'), two = fixture('mycology'); const a = authMain(one.store), b = authMain(two.store);
      for (const v of [a, b]) v.fetchWith(async () => ({ json: async () => ({ access_token: 'synthetic-current' }) }));
      const pa = a.signIn(), pb = b.signIn();
      const sa = new URL(a.opened[0]).searchParams.get('state'), sb = new URL(b.opened[0]).searchParams.get('state');
      assert.notEqual(sa, sb); const wrong = b.callback(b.servers[0], sa); await wrong.done; assert.equal(wrong.response.status, 400);
      await a.callback(a.servers[0], sa).done; await b.callback(b.servers[0], sb).done;
      assert.equal((await pa).ok, true); assert.equal((await pb).ok, true);
      a.logout(); assert.equal(two.store.readAuth().token, 'synthetic-current');
    });
    await check('timed out exchange cannot persist and a new attempt stays independent', async () => {
      const f = fixture('mycology'), a = authMain(f.store), response = deferred(); a.fetchWith(() => response.promise);
      const old = a.signIn(), state = new URL(a.opened[0]).searchParams.get('state');
      const callback = a.callback(a.servers[0], state);
      [...a.timers].find(t => t.ms === 300000).fn(); assert.equal((await old).error, 'sign-in timed out');
      const next = a.signIn(); response.resolve({ json: async () => ({ access_token: 'synthetic-stale' }) }); await callback.done;
      assert.equal(f.store.readAuth().token, undefined); a.logout(); assert.equal((await next).error, 'sign-in cancelled');
    });
    await check('refresh pending before a new sign-in cannot replace the new identity', async () => {
      const f = fixture('mycology'); f.store.writeAuth({ token: 'synthetic-old', refreshToken: 'synthetic-refresh' });
      const a = authMain(f.store), oldResponse = deferred(); let calls = 0;
      a.fetchWith(async () => { calls++; return calls === 1 ? oldResponse.promise : { json: async () => ({ access_token: 'synthetic-new-user' }) }; });
      const refresh = a.refreshToken(); await Promise.resolve();
      const login = a.signIn(); assert.equal(await a.refreshToken(), null); assert.equal(calls, 1);
      await a.callback(a.servers[0], new URL(a.opened[0]).searchParams.get('state')).done;
      assert.equal((await login).ok, true);
      oldResponse.resolve({ json: async () => ({ access_token: 'synthetic-old-user-late' }) });
      assert.equal(await refresh, null); assert.equal(f.store.readAuth().token, 'synthetic-new-user');
    });
    await check('duplicate valid callback exchanges once and logout aborts transport', async () => {
      const f = fixture('mycology'), a = authMain(f.store), response = deferred(); let calls = 0, signal;
      a.fetchWith((url, options) => { calls++; signal = options.signal; return response.promise; });
      const login = a.signIn(), state = new URL(a.opened[0]).searchParams.get('state');
      const first = a.callback(a.servers[0], state), duplicate = a.callback(a.servers[0], state);
      await duplicate.done; assert.equal(duplicate.response.status, 409); assert.equal(calls, 1);
      a.logout(); assert.equal(signal.aborted, true); await login;
      response.resolve({ json: async () => ({ access_token: 'synthetic-late' }) }); await first.done;
      assert.equal(f.store.readAuth().token, '');
    });
    await check('cancellation removes retry and overall timers without reopening a port', async () => {
      const f = fixture('mycology'), a = authMain(f.store); const login = a.signIn();
      a.servers[0].emit('error', { code: 'EADDRINUSE' });
      const retry = [...a.timers].find(t => t.ms === 40); assert(retry);
      a.logout(); await login; retry.fn();
      assert.equal(a.servers[0].port, 8765); assert.equal(a.servers[0].closed, true); assert.equal(a.timers.size, 0);
    });
    await check('synchronous listener failure cleans up and permits another attempt', async () => {
      const f = fixture('mycology'), a = authMain(f.store, { listenError: new Error('synthetic-listen-failure') });
      assert.match((await a.signIn()).error, /synthetic-listen-failure/); assert.equal(a.timers.size, 0);
      assert.match((await a.signIn()).error, /synthetic-listen-failure/); assert.equal(a.servers.length, 2);
      a.logout();
    });
    await check('native encryption unavailable blocks import retry when store already exists', () => {
      const f = fixture('desktop', false, { safeStorage: { isEncryptionAvailable: () => false } });
      fs.writeFileSync(path.join(f.profile, 'auth.bin'), codec.encryptString('{}'));
      assert.deepEqual(f.store.readAuth(), {}); assert.equal(f.store.migrationTokens(), null); assert.equal(f.homeReads(), 0);
    });
    await check('failed atomic replacement preserves destination and cleans temporary file', () => {
      const f = fixture('mycology'); f.store.writeAuth({ token: 'synthetic-original' });
      const before = fs.readFileSync(path.join(f.profile, 'auth.bin')), rename = fs.renameSync;
      try {
        fs.renameSync = () => { throw new Error('synthetic-rename-failure'); };
        assert.throws(() => f.store.writeAuth({ token: 'synthetic-replacement' }), /synthetic-rename-failure/);
      } finally { fs.renameSync = rename; }
      assert.deepEqual(fs.readFileSync(path.join(f.profile, 'auth.bin')), before);
      assert.deepEqual(fs.readdirSync(f.profile), ['auth.bin']);
    });
    await check('development without explicit plaintext opt-in also fails closed', () => {
      const f = fixture('mycology', true, { isPackaged: false, safeStorage: { isEncryptionAvailable: () => false } });
      assert.throws(() => f.store.writeAuth({ token: 'synthetic' }), /encryption/);
    });
    await check('main storage wiring uses trusted edition and selected profile only', () => {
      assert.match(main, /edition: EDITION\.id, explicitProfile: app\.commandLine\.hasSwitch\("user-data-dir"\)/);
      assert.match(main, /getProfile: \(\) => app\.getPath\("userData"\)/);
      assert.match(main, /function readAuthStore\(\) \{ return profileAuth\.readAuth\(\); \}/);
      assert.match(main, /function writeAuthStore\(store\) \{ profileAuth\.writeAuth\(store\); \}/);
      assert.match(main, /function readKeyStore\(\) \{ return profileAuth\.readKeys\(\); \}/);
      assert.match(main, /function writeKeyStore\(store\) \{ profileAuth\.writeKeys\(store\); \}/);
      assert.doesNotMatch(main, /LEGACY_AUTH_JSON/);
    });
    await check('unknown or missing trusted migration policy fails closed', () => {
      assert.throws(() => createProfileAuth({ edition: 'unknown', explicitProfile: false }), /Unknown auth edition/);
      assert.throws(() => createProfileAuth({ edition: 'desktop' }), /Explicit profile policy/);
    });
    await check('directory and oversized stores are rejected and new stores are private', () => {
      const f = fixture('mycology'), dest = path.join(f.profile, 'auth.bin');
      fs.mkdirSync(dest); assert.throws(() => f.store.writeAuth({}), /regular file/); fs.rmdirSync(dest);
      fs.writeFileSync(dest, Buffer.alloc(1024 * 1024 + 1)); assert.throws(() => f.store.writeAuth({}), /regular file/);
      fs.unlinkSync(dest); f.store.writeAuth({ token: 'synthetic' }); assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
    });
    await check('actual saveConfig writes encrypted migration before removing local plaintext', () => {
      const f = fixture('desktop'), config = path.join(f.profile, 'config.json');
      fs.writeFileSync(config, JSON.stringify({ token: 'synthetic-local', refreshToken: 'synthetic-local-refresh', preference: 'keep' }));
      const from = main.indexOf('function saveConfig(patch) {'), to = main.indexOf('\n}', from) + 2;
      const context = { fs, configPath: () => config,
        loadConfig: () => ({ ...JSON.parse(fs.readFileSync(config)), ...f.store.readAuth() }),
        writeAuthStore: value => f.store.writeAuth(value) };
      vm.runInNewContext(main.slice(from, to) + '\nthis.save = saveConfig;', context);
      context.save(f.store.migrationTokens());
      assert.equal(f.store.readAuth().token, 'synthetic-local'); assert.deepEqual(JSON.parse(fs.readFileSync(config)), { preference: 'keep' });
      context.writeAuthStore = () => { throw new Error('synthetic-encryption-failure'); };
      const before = fs.readFileSync(config); assert.throws(() => context.save({ token: 'synthetic-next' }), /synthetic-encryption-failure/);
      assert.deepEqual(fs.readFileSync(config), before);
    });
    assert.equal(fs.readFileSync(legacy, 'utf8'), sentinel);
    console.log(`Profile auth: ${checks} synthetic checks passed; no OS keychain, real profile or network access`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
