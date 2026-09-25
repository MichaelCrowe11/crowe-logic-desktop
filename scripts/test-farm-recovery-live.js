#!/usr/bin/env node
// Actual renderer -> sandboxed preload -> trusted main -> worker -> SQLite.
// Drop one committed shipment reply, exit the owned app, then recover unchanged
// in a new app process. No store/bridge replacements, external calls or real profile.
// Run with the installed Electron binary, not Node. Isolation guards are defense
// in depth, not authorization to bypass a denied OS sandbox execution.
'use strict';
const { app, BrowserWindow, safeStorage, shell, session, ipcMain, utilityProcess, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const option = (name) => process.argv.find((arg) => arg.startsWith(`--farm-${name}=`))?.slice(`--farm-${name}=`.length);
const stage = option('stage');
assert.ok(!stage || ['lose-response', 'replay'].includes(stage), 'Unknown recovery stage');
assert.ok(stage || !option('root'), 'Only child stages accept a pre-existing test root');
const rootInput = stage ? option('root') : fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-farm-recovery-'));
assert.ok(rootInput && path.isAbsolute(rootInput), 'An absolute isolated test root is required');
const root = fs.realpathSync(rootInput);
const marker = path.join(root, '.farm-recovery-test');
if (!stage) fs.writeFileSync(marker, 'isolated shipment recovery fixture\n', { mode: 0o600 });
assert.equal(fs.readFileSync(marker, 'utf8'), 'isolated shipment recovery fixture\n', 'Refusing an unmarked test directory');
const home = path.join(root, 'home');
const profile = path.join(root, stage ? 'profile' : 'runner-profile');
const workspace = path.join(root, 'workspace');
for (const dir of [home, profile, workspace, path.join(root, 'screenshots')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
// Do not inherit account tokens, NODE_OPTIONS, proxy credentials or login shell configuration.
const inherited = { PATH: process.env.PATH || '', LANG: 'en_US.UTF-8', ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}) };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, inherited, { HOME: home, USERPROFILE: home, CROWE_EDITION: 'desktop', CROWE_SPACES: 'chat,projects',
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache') });
os.homedir = () => home;
app.setPath('home', home);
app.setPath('userData', profile);
app.setPath('sessionData', profile);
for (const name of ['logs', 'documents', 'downloads', 'temp', 'crashDumps', 'appData']) {
  const dir = path.join(root, 'paths', name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  app.setPath(name, dir);
}
process.env.TMPDIR = process.env.TMP = process.env.TEMP = app.getPath('temp');
process.chdir(workspace);
safeStorage.isEncryptionAvailable = () => false;
safeStorage.encryptString = safeStorage.decryptString = () => { throw new Error('Credential access is disabled in farm recovery tests'); };
shell.openExternal = async () => { throw new Error('External navigation is disabled in farm recovery tests'); };
assert.ok(!app.commandLine.hasSwitch('no-sandbox') && !app.commandLine.hasSwitch('disable-setuid-sandbox'), 'Chromium sandbox must not be disabled');

if (!stage) {
  const run = (name) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, `--farm-stage=${name}`, `--farm-root=${root}`, `--user-data-dir=${path.join(root, 'profile')}`], {
      cwd: workspace, env: { ...process.env }, stdio: ['ignore', 'inherit', 'inherit'],
    });
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, 90000);
    child.once('error', (error) => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (!timedOut && code === 0) resolve();
      else reject(new Error(`Recovery stage ${name} ${timedOut ? 'timed out' : `failed (${code ?? signal})`}; only owned PID ${child.pid} was targeted`));
    });
  });
  (async () => {
    let code = 0;
    try {
      for (const name of ['lose-response', 'replay']) await run(name);
      console.log(`\nFarm recovery live: both actual-app processes passed. Evidence: ${root}`);
    } catch (error) { code = 1; console.error(error.stack); console.error(`Preserved evidence: ${root}`); }
    app.exit(code);
  })();
} else {
  if (stage === 'lose-response') fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ cwd: workspace,
    telemetry: false, onboarded: true, autonomy: 'readonly', mcpServers: {}, plugins: {}, sense: { mode: 'off' }, controlPlane: 'off' }), { mode: 0o600 });
  let transferDialogs = 0;
  dialog.showSaveDialog = async () => { transferDialogs++; return { canceled: true }; };
  dialog.showOpenDialog = async () => { transferDialogs++; return { canceled: true, filePaths: [] }; };
  const processAttempts = [];
  const networkAttempts = [];
  const stubbedFetches = [];
  const blockProcess = (api) => () => { processAttempts.push(api); const error = new Error(`Subprocess disabled in recovery test: ${api}`); console.error(error.stack); throw error; };
  const childProcess = require('node:child_process');
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[method] = blockProcess(`child_process.${method}`);
  utilityProcess.fork = blockProcess('utilityProcess.fork');
  let nativePty;
  try { nativePty = require('node-pty'); } catch { /* Optional native dependency. */ }
  if (nativePty) nativePty.spawn = blockProcess('node-pty.spawn');
  const blockedNetwork = (api) => () => { networkAttempts.push(api); throw new Error(`Networking disabled in recovery test: ${api}`); };
  for (const module of ['node:http', 'node:https']) {
    require(module).request = blockedNetwork(`${module}.request`);
    require(module).get = blockedNetwork(`${module}.get`);
  }
  require('node:net').Socket.prototype.connect = blockedNetwork('net.Socket.connect');
  require('node:tls').connect = blockedNetwork('tls.connect');
  global.fetch = async (url, options = {}) => {
    const address = String(url);
    stubbedFetches.push({ url: address, method: options.method || 'GET' });
    if (/\/chat|\/responses|\/messages/.test(address)) throw new Error('Farm recovery attempted an engine request');
    return new Response(JSON.stringify(address.includes('/catalog') ? { models: [] } : {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const pendingPrefix = 'crowe.farm.pending-shipment.';
  const pendingExpression = `Object.keys(localStorage).filter(k => k.startsWith(${JSON.stringify(pendingPrefix)})).sort().map(key => ({key, raw: localStorage.getItem(key)}))`;
  const expectedFile = path.join(root, 'expected.json');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let win;
  let checks = 0;
  let shutdownNativeResources = async () => {};
  let dropNextShipment = false;
  let dropped = null;
  const observedShipments = [];
  const js = (code) => win.webContents.executeJavaScript(code);
  function check(condition, message) { assert.ok(condition, message); checks++; console.log(`  ok ${message}`); }
  function same(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; console.log(`  ok ${message}`); }
  async function waitFor(code, message, timeout = 15000) {
    let last;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { last = await js(code); if (last) return last; } catch (error) { last = error.message; }
      await sleep(75);
    }
    throw new Error(`${message}; last value: ${JSON.stringify(last)}`);
  }
  async function request(action, payload = {}) {
    const result = await js(`window.crowe.farm.request(${JSON.stringify(action)}, ${JSON.stringify(payload)})`);
    assert.ok(result?.ok, `${action}: ${JSON.stringify(result)}`);
    return result.data;
  }
  async function click(selector) {
    await waitFor(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e && !e.matches(':disabled') && !e.closest('[hidden]'); })()`, `Enabled visible ${selector}`);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function refresh() {
    await click('.farm-compliance [data-fc="refresh"]');
    await waitFor(`!document.querySelector('[data-fc="refresh"]').disabled && document.querySelector('[data-fc="status"]').textContent.includes('Local records current')`, 'Farm refresh finished');
  }
  async function shot(name) {
    await sleep(100);
    fs.writeFileSync(path.join(root, 'screenshots', `${stage}-${name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  async function frozen(payload) {
    await waitFor(`(() => { const retry = document.querySelector('[data-fc="retry-shipment"]'); return retry && !retry.hidden && !retry.disabled; })()`, 'Pending request exposes enabled unchanged retry');
    const ui = await js(`(() => {
      const f = document.querySelector('form[data-form="shipment"]');
      const notice = document.querySelector('[data-fc="shipment-recovery"]');
      const read = name => f.querySelector('[name="'+name+'"]').value;
      return { locked: f.querySelector('fieldset').disabled,
        allFieldsLocked: [...f.querySelectorAll('fieldset input, fieldset select, fieldset textarea, fieldset button')].every(e => e.matches(':disabled')),
        submitHidden: f.querySelector('button[type="submit"]').hidden,
        correctionHidden: f.querySelector('[data-fc="correct-shipment"]').hidden,
        restoreLocked: document.querySelector('form[data-form="restore"] fieldset').disabled,
        noticeVisible: !notice.hidden && !notice.closest('[hidden]'), noticeText: notice.textContent,
        payload: JSON.parse(notice.querySelector('[data-fc="pending-shipment-payload"] pre').textContent),
        customerId: read('customerId'), notes: read('notes'), shippedAt: new Date(read('shippedAt')).toISOString(),
        items: [...f.querySelectorAll('.fc-shipment-item')].map(row => ({ lotId: row.querySelector('select').value, quantityLbs: row.querySelector('input').value })) };
    })()`);
    check(ui.locked && ui.allFieldsLocked && ui.submitHidden && ui.correctionHidden && ui.restoreLocked, 'unknown intent freezes all shipment fields, hides new/correction controls and blocks restore');
    check(ui.noticeVisible && ui.noticeText.includes(payload.requestId) && ui.noticeText.includes('Never re-enter'), 'visible recovery warning identifies retained request and forbids re-entry');
    same(ui.payload, payload, 'recovery disclosure shows the exact immutable shipment request');
    same({ customerId: ui.customerId, shippedAt: ui.shippedAt, notes: ui.notes, items: ui.items },
      { customerId: payload.customerId, shippedAt: payload.shippedAt, notes: payload.notes, items: payload.items }, 'frozen owner form retains original date, customer, notes and allocation');
    await js(`document.querySelector('[data-fc="pending-shipment-payload"]').open = true`);
  }
  function assertSingleAllocation(tables, payload, shipmentId) {
    check(tables.shipments.length === 1 && tables.shipment_items.length === 1, 'real SQLite tables contain exactly one shipment and one allocation');
    check(tables.shipments[0].id === shipmentId && tables.shipments[0].request_id === payload.requestId &&
      tables.shipment_items[0].shipment_id === shipmentId && tables.shipment_items[0].lot_id === payload.items[0].lotId &&
      tables.shipment_items[0].quantity === 7125, 'stored request ID, shipment identity and exact 7.125 lb allocation agree');
    check(tables.audit.filter(event => event.action === 'shipment.create').length === 1, 'audit contains exactly one shipment.create event');
  }

  // Capture the actual registration before main captures ipcMain.handle. Await
  // its successful response (which follows the worker COMMIT), independently
  // read that same real service's tables, then reject only the reply transport.
  // The actual preload must translate the rejection to WRITE_OUTCOME_UNKNOWN.
  const register = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => register(channel, channel !== 'crowe:farm:request' ? handler : async (event, action, payload) => {
    if (action !== 'shipment.create') return handler(event, action, payload);
    const observation = { payload: structuredClone(payload), response: null };
    observedShipments.push(observation);
    const result = await handler(event, action, payload);
    observation.response = structuredClone(result);
    if (dropNextShipment && result?.ok) {
      dropNextShipment = false;
      const backup = await handler(event, 'backup.export', {});
      dropped = { payload: structuredClone(payload), result: structuredClone(result), backup: structuredClone(backup) };
      throw new Error('TEST_ONLY_LOST_SHIPMENT_REPLY_AFTER_COMMIT');
    }
    return result;
  });

  async function loseResponse() {
    const fresh = await request('snapshot');
    check(fresh.lots.length === 0 && fresh.customers.length === 0 && fresh.shipments.length === 0 && (await request('audit')).length === 0, 'isolated database starts empty with no sample data');
    same(await js(pendingExpression), [], 'fresh renderer has no pending shipment intent');
    await request('facility.save', { name: 'Recovery Fixture Farm', ownerName: 'Isolated Fixture Owner', address: '1 Fixture Lane' });
    const lot = await request('lot.create', { harvestDate: '2026-09-23', room: 'Fixture Room', species: 'Blue Oyster', quantityLbs: '20.000', notes: 'Isolated recovery fixture' });
    const customer = await request('customer.create', { name: 'Recovery Fixture Market', contact: 'Fixture Receiver', email: 'receiver@fixture.test', phone: '555-0100', address: '2 Fixture Lane' });
    check(lot.id && customer.id, 'fixture seeded only through real renderer preload/main/worker bridge');
    const auditBefore = await request('audit');
    await refresh();
    await click('.farm-compliance [data-lane="shipments"]');
    await waitFor(`!document.querySelector('form[data-form="shipment"] fieldset').disabled`, 'Shipment form enabled');
    const intended = await js(`(() => {
      const f = document.querySelector('form[data-form="shipment"]');
      const fields = {customerId: ${JSON.stringify(customer.id)}, shippedAt: '2026-09-23T15:30', notes: 'Lost reply recovery fixture'};
      for (const [name, value] of Object.entries(fields)) { const el = f.querySelector('[name="'+name+'"]'); el.value = value; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); }
      const row = f.querySelector('.fc-shipment-item');
      row.querySelector('select').value = ${JSON.stringify(lot.id)};
      row.querySelector('select').dispatchEvent(new Event('change', {bubbles: true}));
      row.querySelector('input').value = '7.125';
      row.querySelector('input').dispatchEvent(new Event('input', {bubbles: true}));
      if (!f.checkValidity()) throw new Error('Actual shipment form is invalid');
      return {...fields, shippedAt: new Date(fields.shippedAt).toISOString(), items: [{lotId: ${JSON.stringify(lot.id)}, quantityLbs: '7.125'}]};
    })()`);
    dropNextShipment = true;
    await click('form[data-form="shipment"] button[type="submit"]');
    await waitFor(`(() => { const e = document.querySelector('[data-form-error="shipment"]'); return !e.hidden && e.textContent.includes('WRITE_OUTCOME_UNKNOWN') && document.querySelector('form[data-form="shipment"] .fc-form-status').textContent.includes('Exact request retained across restart'); })()`, 'Actual preload and renderer report WRITE_OUTCOME_UNKNOWN');
    check(dropped?.result?.ok && dropped?.backup?.ok && !dropNextShipment && observedShipments.length === 1, 'one real committed shipment reply was lost at IPC, never a fake store result');
    const payload = dropped.payload;
    same({ ...payload, requestId: undefined }, { ...intended, requestId: undefined }, 'actual form dispatched the intended recipient, instant, notes and quantity');
    check(typeof payload.requestId === 'string' && payload.requestId.length > 0, 'renderer generated a shipment request ID');
    const saved = await js(pendingExpression);
    check(saved.length === 1, 'exactly one pending localStorage key survives the lost reply');
    const state = await request('snapshot');
    const record = JSON.parse(saved[0].raw);
    same(record, { schemaVersion: 1, operatorId: state.storage.operator.id, payload }, 'pending intent stores exact payload and local operator identity');
    check(saved[0].key === `${pendingPrefix}v1:${encodeURIComponent(record.operatorId)}`, 'pending intent uses the versioned operator-specific storage key');
    await frozen(payload);
    const dialogsBefore = transferDialogs;
    for (const action of ['notebook.export', 'farm.export']) {
      const refused = await js(`window.crowe.transfer.request(${JSON.stringify(action)}, {})`);
      check(!refused.ok && refused.error.code === 'RECOVERY_REQUIRED', `${action} host barrier refuses pending intent before dialog`);
    }
    check(transferDialogs === dialogsBefore, 'Blocked transfers never open a native chooser');
    same(await js(pendingExpression), saved, 'Transfer refusal never changes unresolved intent bytes');
    const tables = dropped.backup.data.tables;
    assertSingleAllocation(tables, payload, dropped.result.data.id);
    const audit = await request('audit');
    check(audit.length === auditBefore.length + 1, 'real commit added exactly one audit event');
    for (const event of auditBefore) assert.deepEqual(audit.find(row => row.id === event.id), event);
    check(state.lots[0].shippedLbs === '7.125' && state.lots[0].remainingLbs === '12.875', 'committed inventory is 7.125 lb shipped and 12.875 lb remaining despite unknown UI');
    await shot('unknown-frozen-intent');
    fs.writeFileSync(expectedFile, JSON.stringify({ pid: process.pid, pending: saved, payload, result: dropped.result.data, state, audit, tables }), { mode: 0o600 });
    // Explicitly flush Chromium DOM storage before a clean owned-process exit.
    // Restart equality below, not this call, proves durable localStorage recovery.
    win.webContents.session.flushStorageData();
  }

  async function replay() {
    const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
    check(process.pid !== expected.pid, 'recovery runs in a new Electron main process, not a page reload');
    same(await js(pendingExpression), expected.pending, 'same profile reopened with byte-for-byte unchanged persisted pending intent');
    same(await request('snapshot'), expected.state, 'all records and inventory survive full application restart exactly');
    same(await request('audit'), expected.audit, 'restart adds no phantom audit event');
    same((await request('backup.export')).tables, expected.tables, 'every real SQLite table survives restart unchanged');
    check(observedShipments.length === 0, 'reopening pending intent does not automatically re-send the shipment');
    await click('.farm-compliance [data-lane="shipments"]');
    await frozen(expected.payload);
    await shot('reopened-frozen-intent');
    const refused = await js(`window.crowe.transfer.request('farm.export', {})`);
    check(!refused.ok && refused.error.code === 'RECOVERY_REQUIRED', 'Restarted pending intent still blocks host export');
    same(await js(pendingExpression), expected.pending, 'Restarted export refusal preserves exact original intent');
    await click('[data-fc="retry-shipment"]');
    await waitFor(`!document.querySelector('form[data-form="shipment"] fieldset').disabled && document.querySelector('[data-fc="retry-shipment"]').hidden && ${pendingExpression}.length === 0`, 'Owner retry confirmed and cleared retained intent');
    check(observedShipments.length === 1 && observedShipments[0].response?.ok, 'owner unchanged-retry control made exactly one successful real bridge call');
    same(observedShipments[0].payload, expected.payload, 'retry reuses every original payload field and the same requestId');
    same(observedShipments[0].response.data, expected.result, 'real store returns the original committed shipment, not a duplicate');
    same((await request('backup.export')).tables, expected.tables, 'unchanged retry leaves every SQLite table byte-value equivalent, including audit and allocations');
    same(await request('snapshot'), expected.state, 'retry preserves all records and exact remaining/shipped inventory');
    same(await request('audit'), expected.audit, 'retry leaves complete audit history unchanged');
    assertSingleAllocation((await request('backup.export')).tables, expected.payload, expected.result.id);
    same(await js(pendingExpression), [], 'confirmed unchanged replay clears the original pending key');
    check(await js(`document.querySelector('[data-form-error="shipment"]').hidden && !document.querySelector('form[data-form="shipment"] button[type="submit"]').hidden && document.querySelector('[data-fc="shipment-recovery"]').hidden`), 'successful confirmation removes unknown-error/recovery surface and restores new-shipment control');
    await shot('confirmed-single-shipment');
    const ready = await js(`window.crowe.transfer.request('farm.export', {})`);
    check(ready.ok && ready.data.canceled && transferDialogs === 1, 'Reconciled source passes host recovery barrier and reaches cancellable native export');
  }

  app.whenReady().then(async () => {
    let failed = false;
    try {
      await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: '127.0.0.1:9', proxyBypassRules: '<-loopback>' });
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
        networkAttempts.push(`Chromium ${details.url}`); callback({ cancel: true });
      });
      ({ shutdownNativeResources } = require('../main'));
      ipcMain.removeHandler('crowe:pty:start');
      ipcMain.handle('crowe:pty:start', () => ({ ok: false, error: 'Terminal disabled by isolated recovery test' }));
      ipcMain.removeHandler('crowe:git:status');
      ipcMain.handle('crowe:git:status', () => ({ repo: false, cwd: workspace }));
      // Settings eagerly probes Tailscale in production. Keep this unrelated
      // companion discovery inert; real legacy/transfer/farm handlers stay intact.
      // This fixture does not prove all Settings behavior is subprocess-free.
      ipcMain.removeHandler('crowe:companion:status');
      ipcMain.handle('crowe:companion:status', () => ({ running: false, tailscale: null, devices: [], paired: false }));
      const deadline = Date.now() + 15000;
      while (!win && Date.now() < deadline) { win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed()); if (!win) await sleep(75); }
      assert.ok(win, 'Actual main app window was not created');
      if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
      win.setSize(1280, 1000);
      console.log(`\nFarm recovery live stage: ${stage} (PID ${process.pid})`);
      const prefs = win.webContents.getLastWebPreferences();
      check(prefs.sandbox === true && prefs.contextIsolation === true && prefs.nodeIntegration === false, `actual product preload retains Chromium sandbox and context isolation without Node integration (${JSON.stringify({ sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration })})`);
      // Electron versions differ on whether getLastWebPreferences exposes preload.
      // The product main constructs this window and the bridge below is supplied
      // exclusively by its unmodified preload, not a test-installed bridge.
      check(fs.realpathSync(app.getPath('userData')) === fs.realpathSync(profile) && app.getPath('sessionData') === profile && os.homedir() === home && process.env.HOME === home && process.env.USERPROFILE === home && fs.realpathSync(process.cwd()) === fs.realpathSync(workspace), 'app home, profile, session and working directory remain isolated');
      await waitFor(`Boolean(window.crowe?.farm && window.FarmCompliance && document.querySelector('#spaces [data-space="farm"]'))`, 'Real farm bridge and app shell available');
      check(await js(`typeof require === 'undefined' && typeof process === 'undefined'`), 'actual renderer cannot access Node globals');
      await waitFor(`!document.getElementById('launch') && document.body.classList.contains('booted')`, 'Product startup veil has naturally lifted before owner interactions');
      check(await js(`window.crowe.edition.id === 'desktop' && !window.crowe.edition.legacyAccess && document.querySelector('#spaces [data-space="farm"]').hidden`), 'Desktop ordinary navigation hides grower tabs');
      const denied = await js(`window.crowe.farm.request('snapshot', {})`);
      check(!denied.ok && denied.error.code === 'UNAVAILABLE', 'Direct farm read denied before explicit legacy entry');
      if (stage === 'lose-response') check(!fs.existsSync(path.join(profile, 'farm-compliance')), 'Denied ordinary startup creates no farm store');
      await click('#settings-btn');
      await click('[data-legacy="enter"]');
      await waitFor(`document.body.classList.contains('legacy-recovery') && document.body.dataset.space === 'farm'`, 'Owner enters host-authorized legacy recovery through Settings');
      check(await js(`document.querySelector('#spaces [data-space="farm"]').hidden && !document.querySelector('#legacy-recovery-banner').hidden && document.querySelector('#cfg-sense').classList.contains('hidden')`), 'Legacy recovery stays labeled and outside ordinary tabs with Sense disabled');
      await waitFor(`Boolean(document.querySelector('.farm-compliance form[data-form="facility"]')) && !document.querySelector('.farm-compliance form[data-form="facility"] fieldset').disabled`, 'Actual SQLite farm workspace ready');
      if (stage === 'lose-response') await loseResponse();
      else await replay();
      const database = path.join(profile, 'farm-compliance', 'farm.db');
      const fd = fs.openSync(database, 'r');
      try { const header = Buffer.alloc(16); fs.readSync(fd, header, 0, 16, 0); check(header.toString('utf8') === 'SQLite format 3\0', 'real SQLite database exists only inside the temporary profile'); } finally { fs.closeSync(fd); }
      check(!require.cache[require.resolve('../farm/store')] && !require.cache[require.resolve('../farm/worker')], 'SQLite store runs outside main in the real farm worker, not an in-process fake');
      check(!stubbedFetches.some(entry => /\/chat|\/responses|\/messages/.test(entry.url)), 'farm recovery makes no engine request');
      same(networkAttempts, [], 'no Node or Chromium networking attempts escaped the local startup fetch stub');
      same(processAttempts, [], 'no Node, PTY or utility subprocess attempts occurred inside app stages');
      check(!fs.existsSync(path.join(home, '.config', 'crowe-logic', 'auth.json')), 'no real legacy account was imported');
      console.log(`Farm recovery live ${stage}: ${checks} checks passed`);
    } catch (error) {
      failed = true; console.error(`Farm recovery live ${stage}: FAIL`, error.stack);
      try { if (win) { await shot('failure'); fs.writeFileSync(path.join(root, `${stage}-failure-ui.txt`), await js('document.body.innerText'), { mode: 0o600 }); } } catch {}
    } finally {
      try { win?.webContents.session.flushStorageData(); await shutdownNativeResources(); } catch (error) { failed = true; console.error('Recovery shutdown failed', error.stack); }
      await sleep(200);
      app.exit(failed ? 1 : 0);
    }
  });
}
