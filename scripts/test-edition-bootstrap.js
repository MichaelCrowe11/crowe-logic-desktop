#!/usr/bin/env node
'use strict';

// Pure bootstrap behavior + execution of main's whole module against a deny-by-
// default require. No app import, credentials, network, or native Electron here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { bootstrapEdition } = require('../edition-bootstrap');
const ROOT = path.resolve(__dirname, '..');

function runUnits() {
  const root = fs.mkdtempSync(path.join(ROOT, '.edition-bootstrap-unit-'));
  let checks = 0;
  function test(label, fn) { fn(); checks++; console.log(`ok - ${label}`); }
  function fixture({ packaged = false, override, primary = true } = {}) {
    const app = new EventEmitter(), paths = { appData: path.join(root, 'appData') }, calls = [];
    Object.assign(app, {
      isPackaged: packaged,
      commandLine: { hasSwitch: () => override !== undefined, getSwitchValue: () => override },
      getPath: key => paths[key],
      setPath(key, value) { calls.push(key); paths[key] = value; },
      requestSingleInstanceLock() {
        calls.push('lock');
        assert.deepEqual(calls, ['userData', 'sessionData', 'lock']);
        assert.equal(paths.userData, paths.sessionData);
        assert.equal(app.listenerCount('second-instance'), 1);
        return primary;
      },
      exit(code) { calls.push(`exit:${code}`); },
    });
    return { app, paths, calls };
  }
  function windowFixture() {
    const f = fixture(), startup = bootstrapEdition({ app: f.app, metadata: {}, env: {} });
    const timers = [], created = [];
    class Window extends EventEmitter {
      constructor() {
        super(); this.events = []; this.destroyed = false; this.minimized = false;
        this.webContents = new EventEmitter();
        Object.assign(this.webContents, { setWindowOpenHandler() {}, session: {
          setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} },
        } });
        created.push(this);
      }
      isDestroyed() { return this.destroyed; }
      isMinimized() { return this.minimized; }
      restore() { this.events.push('restore'); this.minimized = false; }
      show() { this.events.push('show'); }
      focus() { this.events.push('focus'); }
      loadFile() {}
      close() { this.destroyed = true; this.emit('closed'); }
    }
    // Execute createWindow's actual reveal wiring, not a separately reimplemented
    // model. Everything native, file-loading or timer-related is synthetic.
    const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const begin = source.indexOf('function createWindow() {');
    const end = source.indexOf('\n}\n\n/* The main window', begin) + 2;
    assert.ok(begin >= 0 && end > begin);
    const context = vm.createContext({
      startup, mainWindow: null, legacyWindow: null, BrowserWindow: Window,
      path, __dirname: ROOT, APP_ENTRY: 'synthetic-app-entry', EDITION: startup.edition,
      process: { platform: 'linux' }, app: f.app,
      installSpaces: () => [], publicEditionDescriptor: value => value,
      require: name => { assert.equal(name, './app-edition'); return { editionIconName: () => 'icon' }; },
      setTimeout: (fn, delay) => { const timer = { fn, delay, cleared: false }; timers.push(timer); return timer; },
      clearTimeout: timer => { if (timer) timer.cleared = true; },
    });
    vm.runInContext(source.slice(begin, end), context);
    return { app: f.app, startup, timers, created, context,
      access: { getWindow: () => context.mainWindow, createWindow: () => context.createWindow() } };
  }
  try {
    for (const packaged of [false, true]) for (const [id, name] of [
      ['desktop', 'Crowe Logic'], ['developers', 'Crowe Logic for Developers'], ['mycology', 'Crowe Logic Mycology'],
    ]) for (const explicit of [false, true]) {
      test(`${id} packaged=${packaged} explicit=${explicit}: selected profile/session before lock`, () => {
        const override = explicit ? path.join(root, 'explicit with spaces') : undefined;
        const f = fixture({ packaged, override });
        const startup = bootstrapEdition({ app: f.app, metadata: { croweEdition: id }, env: {} });
        assert.equal(startup.profile, fs.realpathSync(override || path.join(root, 'appData', name)));
        assert.equal(startup.edition.id, id); assert.equal(startup.primary, true);
        if (id === 'mycology') {
          assert.deepEqual(startup.edition.defaultSpaces, ['farm', 'cultivation', 'messenger']);
          assert.equal(startup.edition.landingSpace, 'farm');
          assert.ok(!startup.edition.defaultSpaces.includes('chat'));
        } else assert.ok(!startup.edition.allowedSpaces.includes('messenger'));
      });
    }
    test('only immutable packaged local metadata isolates the default profile; explicit paths remain authoritative', () => {
      for (const packaged of [false, true]) for (const flag of [undefined, false, 'true', true]) {
        const f = fixture({ packaged });
        const isolated = packaged && flag === true;
        const result = bootstrapEdition({ app: f.app, metadata: { croweEdition: 'mycology', croweLocalPrerelease: flag }, env: { CROWE_LOCAL_PRERELEASE: 'true' } });
        assert.equal(result.profile, fs.realpathSync(path.join(root, 'appData', 'Crowe Logic Mycology' + (isolated ? ' Local Prerelease' : ''))));
        assert.equal(result.edition.profileName, 'Crowe Logic Mycology');
      }
      const override = path.join(root, 'explicit local candidate');
      const f = fixture({ packaged: true, override });
      assert.equal(bootstrapEdition({ app: f.app, metadata: { croweEdition: 'mycology', croweLocalPrerelease: true }, env: {} }).profile, fs.realpathSync(override));
    });
    test('legacy Desktop metadata retains historical Crowe Logic path', () => {
      const f = fixture({ packaged: true });
      assert.equal(bootstrapEdition({ app: f.app, metadata: {}, env: {} }).profile,
        fs.realpathSync(path.join(root, 'appData', 'Crowe Logic')));
    });
    test('development edition override honored; packaged override ignored', () => {
      for (const packaged of [true, false]) {
        const f = fixture({ packaged });
        assert.equal(bootstrapEdition({ app: f.app, metadata: { croweEdition: 'desktop' }, env: { CROWE_EDITION: 'mycology' } }).edition.id,
          packaged ? 'desktop' : 'mycology');
      }
    });
    test('empty explicit profile fails closed before lock', () => {
      const f = fixture({ override: '' });
      assert.throws(() => bootstrapEdition({ app: f.app, metadata: {}, env: {} }), /nonempty/);
      assert.deepEqual(f.calls, []);
    });
    test('relative explicit profile is honored rather than replaced', () => {
      const f = fixture({ override: path.relative(process.cwd(), path.join(root, 'relative')) });
      assert.equal(bootstrapEdition({ app: f.app, metadata: {}, env: {} }).profile, fs.realpathSync(path.join(root, 'relative')));
    });
    if (process.platform !== 'win32') test('symlink aliases select the same canonical lock and session path', () => {
      fs.symlinkSync(path.join(root, 'appData'), path.join(root, 'alias'));
      const f = fixture({ override: path.join(root, 'alias', 'Crowe Logic') });
      assert.equal(bootstrapEdition({ app: f.app, metadata: {}, env: {} }).profile, fs.realpathSync(path.join(root, 'appData', 'Crowe Logic')));
    });
    test('early launches queue one activation; late/minimized/destroyed windows are handled', () => {
      const f = fixture(), startup = bootstrapEdition({ app: f.app, metadata: {}, env: {} });
      f.app.emit('second-instance'); f.app.emit('activate');
      let window = null, created = 0; const events = [];
      const access = { getWindow: () => window, createWindow: () => {
        created++; window = { isDestroyed: () => false, isMinimized: () => true,
          restore: () => events.push('restore'), show: () => events.push('show'), focus: () => events.push('focus') };
      } };
      assert.equal(created, 0); startup.windowsReady(access);
      assert.equal(created, 1); assert.deepEqual(events, ['restore', 'show', 'focus']);
      events.length = 0; f.app.emit('second-instance'); assert.equal(created, 1);
      assert.deepEqual(events, ['restore', 'show', 'focus']);
      window.isDestroyed = () => true; f.app.emit('activate'); assert.equal(created, 2);
    });
    for (const gate of ['ready-to-show', 'fallback']) test(`queued activation waits for actual main ${gate} reveal wiring`, () => {
      const f = windowFixture();
      f.app.emit('second-instance');
      f.access.createWindow();
      const window = f.context.mainWindow;
      window.minimized = true;
      f.startup.windowsReady(f.access);
      f.app.emit('second-instance'); f.app.emit('activate');
      assert.deepEqual(window.events, []);
      assert.equal(f.timers[0].delay, 4000);
      if (gate === 'fallback') f.timers[0].fn(); else window.emit('ready-to-show');
      assert.deepEqual(window.events, ['show', 'restore', 'show', 'focus']);
      assert.equal(f.timers[0].cleared, true);
      window.events.length = 0;
      window.emit('ready-to-show'); f.timers[0].fn();
      assert.deepEqual(window.events, []);
      window.minimized = true; f.app.emit('second-instance');
      assert.deepEqual(window.events, ['restore', 'show', 'focus']);
    });
    test('recreated windows await their own paint; old reveal callbacks cannot expose them', () => {
      const f = windowFixture();
      f.access.createWindow(); f.startup.windowsReady(f.access);
      const old = f.context.mainWindow;
      old.close(); f.app.emit('activate');
      const replacement = f.context.mainWindow;
      assert.notEqual(old, replacement);
      assert.equal(f.created.length, 2);
      assert.deepEqual(replacement.events, []);
      old.emit('ready-to-show'); f.timers[0].fn();
      assert.deepEqual(replacement.events, []);
      assert.equal(f.timers[0].cleared, true);
      replacement.emit('ready-to-show');
      assert.deepEqual(replacement.events, ['show', 'show', 'focus']);
    });
    test('normal first reveal stays single without a pending activation', () => {
      const f = windowFixture();
      f.access.createWindow(); f.startup.windowsReady(f.access);
      const window = f.context.mainWindow;
      assert.deepEqual(window.events, []);
      window.emit('ready-to-show');
      assert.deepEqual(window.events, ['show']);
      f.timers[0].fn(); assert.deepEqual(window.events, ['show']);
    });
    test('lock loser exits and returns from real main before ANY eager service import or writer', () => {
      const f = fixture({ primary: false }), imports = [];
      const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
      const wrapped = vm.runInNewContext(`(function(require, module, exports, __dirname, __filename) {\n${source}\n})`,
        { process: { env: {} } }, { timeout: 1000 });
      const requireOnlyBootstrap = name => {
        imports.push(name);
        if (name === 'electron') return { app: f.app };
        if (name === './edition-bootstrap') return { bootstrapEdition };
        if (name === './package.json') return { croweEdition: 'mycology' };
        throw new Error(`Loser reached forbidden import ${name}`);
      };
      // exit intentionally returns, proving the actual module-level return guard.
      wrapped(requireOnlyBootstrap, { exports: {} }, {}, ROOT, path.join(ROOT, 'main.js'));
      assert.deepEqual(imports, ['electron', './edition-bootstrap', './package.json']);
      assert.equal(f.calls.at(-1), 'exit:0');
      assert.equal(f.app.listenerCount('second-instance'), 0);
      assert.equal(f.app.listenerCount('activate'), 0);
    });
    test('winner locks before first app-service import in the actual main module', () => {
      const f = fixture(), reached = new Error('first non-bootstrap import');
      const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
      const wrapped = vm.runInNewContext(`(function(require) {\n${source}\n})`, { process: { env: {} } }, { timeout: 1000 });
      assert.throws(() => wrapped(name => {
        if (name === 'electron') return { app: f.app };
        if (name === './edition-bootstrap') return { bootstrapEdition };
        if (name === './package.json') return {};
        assert.equal(f.calls.at(-1), 'lock'); throw reached;
      }), error => error === reached);
    });
    console.log(`edition-bootstrap: ${checks} synthetic unit groups passed`);
    return checks;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (require.main === module) runUnits();
module.exports = { runUnits };
