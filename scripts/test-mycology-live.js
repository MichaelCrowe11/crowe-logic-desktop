#!/usr/bin/env node
'use strict';
// Actual main/preload/renderer/native-dialog/worker transfers in separate marked
// fixture profiles. Transport and subprocess guards are accidental isolation,
// not OS containment or authorization to bypass an execution denial.
const { app, BrowserWindow, safeStorage, shell, session, ipcMain, utilityProcess, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const option = name => process.argv.find(arg => arg.startsWith(`--mycology-${name}=`))?.slice(`--mycology-${name}=`.length);
const stage = option('stage');
assert.ok(!stage || ['source', 'import', 'reopen', 'reverse', 'reverse-reopen'].includes(stage), 'Known fixture stage only');
assert.ok(stage || !option('root'), 'Only child stages accept an existing fixture root');
const rootInput = stage ? option('root') : fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-mycology-live-'));
assert.ok(rootInput && path.isAbsolute(rootInput), 'Absolute fixture root required');
// Native notebook selection deliberately rejects aliases, including macOS /var.
const root = fs.realpathSync(rootInput);
assert.ok(root && path.isAbsolute(root), 'Absolute fixture root required');
const marker = path.join(root, '.mycology-live-test');
if (!stage) fs.writeFileSync(marker, 'isolated mycology transfer fixture\n', { mode: 0o600 });
assert.equal(fs.readFileSync(marker, 'utf8'), 'isolated mycology transfer fixture\n');
const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
const profileName = name => !name ? 'runner-profile' : name === 'source' ? 'desktop-profile' : name.startsWith('reverse') ? 'reverse-profile' : 'mycology-profile';
const profile = path.join(root, profileName(stage));
for (const dir of [home, workspace, profile, path.join(root, 'screenshots')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const inherited = { PATH: process.env.PATH || '', LANG: 'en_US.UTF-8', ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}) };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, inherited, { HOME: home, USERPROFILE: home, CROWE_EDITION: stage === 'source' ? 'desktop' : 'mycology',
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache') });
os.homedir = () => home;
app.setPath('home', home); app.setPath('userData', profile); app.setPath('sessionData', profile);
for (const name of ['logs', 'documents', 'downloads', 'temp', 'crashDumps', 'appData']) { const dir = path.join(root, 'paths', name); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); app.setPath(name, dir); }
process.env.TMPDIR = process.env.TMP = process.env.TEMP = app.getPath('temp');
process.chdir(workspace);
safeStorage.isEncryptionAvailable = () => false;
safeStorage.encryptString = safeStorage.decryptString = () => { throw new Error('Credential access disabled in fixture'); };
shell.openExternal = async () => { throw new Error('External navigation disabled in fixture'); };
assert.ok(!app.commandLine.hasSwitch('no-sandbox') && !app.commandLine.hasSwitch('disable-setuid-sandbox'), 'Chromium sandbox remains enabled');
if (!stage) {
  const run = name => new Promise((resolve, reject) => {
    const target = path.join(root, profileName(name));
    const child = spawn(process.execPath, [__filename, `--mycology-stage=${name}`, `--mycology-root=${root}`, `--user-data-dir=${target}`], { cwd: workspace, env: { ...process.env }, stdio: ['ignore', 'inherit', 'inherit'] });
    let timedOut = false, killTimer;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 5000); }, 120000);
    child.once('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(killTimer); !timedOut && code === 0 ? resolve() : reject(new Error(`${name} failed (${code ?? signal}); only owned PID ${child.pid} targeted`)); });
  });
  const sourceHashes = () => {
    const result = {};
    const visit = directory => {
      if (!fs.existsSync(directory)) return;
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, item.name);
        if (item.isDirectory()) visit(filename);
        else { assert.ok(item.isFile(), 'Fixture source records contain no aliases'); result[path.relative(root, filename)] = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }
      }
    };
    visit(path.join(root, 'desktop-profile', 'grow')); visit(path.join(root, 'desktop-profile', 'farm-compliance'));
    return result;
  };
  (async () => {
    let code = 0;
    try {
      await run('source'); const hashes = sourceHashes();
      assert.ok(Object.keys(hashes).some(name => name.includes('farm-compliance/')), 'Completed source ledger exists');
      for (const name of ['import', 'reopen', 'reverse', 'reverse-reopen']) { await run(name); assert.deepEqual(sourceHashes(), hashes, 'Notebook and farm source files unchanged after destination operation'); }
      fs.writeFileSync(path.join(root, 'source-record-hashes.json'), JSON.stringify(hashes), { mode: 0o600 });
      console.log(`Mycology live: five separate actual-app stages passed; all source record hashes unchanged. Evidence: ${root}`);
    } catch (error) { code = 1; console.error(error.stack, `\nPreserved evidence: ${root}`); }
    app.exit(code);
  })();
} else {
  if (!stage.endsWith('reopen')) fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ cwd: workspace, telemetry: false, onboarded: stage === 'source', autonomy: 'readonly', mcpServers: {}, plugins: {}, sense: { mode: 'off' }, controlPlane: 'off' }), { mode: 0o600 });
  const types = ['blocks', 'flushes', 'contam', 'env', 'strains', 'recipes', 'log'];
  const originalHarvest = { id: 'transfer-harvest-1', date: '2026-09-23', weight: '12.500', strain: 'Blue Oyster', room: 'Fixture source room', notes: '  exact raw notebook notes  ', nested: { readings: [12.5, null], operator: '  historic operator  ' } };
  if (stage === 'source') {
    fs.mkdirSync(path.join(profile, 'grow'), { mode: 0o700 });
    fs.writeFileSync(path.join(profile, 'grow', 'flushes.json'), ' \n' + JSON.stringify([originalHarvest], null, 2) + '\n');
    fs.writeFileSync(path.join(profile, 'grow', 'blocks.json'), JSON.stringify([{ id: 'block-stable-1', strain: 'Blue Oyster', notes: 'Raw unknown fields preserved', custom: { retained: true } }]));
    fs.writeFileSync(path.join(profile, 'grow', 'env.json'), '[ ]\n');
    // Remaining four files are intentionally absent, not [] replacements.
  }
  const processAttempts = [], networkAttempts = [], fetches = [];
  const blockedProcess = name => () => { processAttempts.push(name); throw new Error(`Subprocess disabled: ${name}`); };
  const cp = require('node:child_process');
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = blockedProcess(name);
  utilityProcess.fork = blockedProcess('utilityProcess.fork');
  try { require('node-pty').spawn = blockedProcess('pty.spawn'); } catch (_) {}
  const blockedNetwork = name => () => { networkAttempts.push(name); throw new Error(`Network disabled: ${name}`); };
  for (const name of ['node:http', 'node:https']) { require(name).request = blockedNetwork(name); require(name).get = blockedNetwork(name); }
  require('node:net').Socket.prototype.connect = blockedNetwork('net'); require('node:tls').connect = blockedNetwork('tls');
  global.fetch = async url => { const address = String(url); fetches.push(address); if (/\/chat|\/responses|\/messages/.test(address)) throw new Error('Engine request forbidden'); return new Response(JSON.stringify(address.includes('/catalog') ? { models: [] } : {}), { headers: { 'Content-Type': 'application/json' } }); };
  const notebookFile = path.join(root, 'notebook.json'), farmFile = path.join(root, 'farm.json'), expectedFile = path.join(root, 'expected.json');
  let holdSave = false, finishSave = null, saveRequested = false;
  dialog.showSaveDialog = async (_window, options) => {
    const filePath = options.defaultPath === 'crowe-notebook.json' ? notebookFile : farmFile;
    assert.equal(path.dirname(filePath), root);
    saveRequested = true;
    if (holdSave) return new Promise(resolve => { finishSave = () => resolve({ canceled: false, filePath }); });
    return { canceled: false, filePath };
  };
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [notebookFile] });
  const hash = text => crypto.createHash('sha256').update(text).digest('hex');
  function notebookContents(where) { return Object.fromEntries(types.map(type => { const file = path.join(where, 'grow', `${type}.json`); return [type, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null]; })); }
  let win, shutdownNativeResources = async () => {}, checks = 0;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code);
  const check = (condition, text) => { assert.ok(condition, text); checks++; console.log(`  ok ${text}`); };
  const same = (a, b, text) => { assert.deepEqual(a, b, text); checks++; console.log(`  ok ${text}`); };
  async function wait(code, message) { let last; for (let i = 0; i < 240; i++) { try { last = await js(code); if (last) return last; } catch (e) { last = e.message; } await sleep(75); } throw new Error(`${message}: ${JSON.stringify(last)}`); }
  async function click(selector) { await wait(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); return e && !e.matches(':disabled') && !e.closest('[hidden]'); })()`, selector); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); }
  async function farm(action, payload = {}) { const result = await js(`window.crowe.farm.request(${JSON.stringify(action)},${JSON.stringify(payload)})`); assert.ok(result?.ok, `${action}: ${JSON.stringify(result)}`); return result.data; }
  async function transfer(action, payload = {}) { return js(`window.crowe.transfer.request(${JSON.stringify(action)},${JSON.stringify(payload)})`); }
  async function refresh() { await click('[data-fc="refresh"]'); await wait(`document.querySelector('[data-fc="status"]').textContent.includes('Local records current') && !document.querySelector('[data-fc="refresh"]').disabled`, 'refreshed'); }
  async function shot(name) { await sleep(150); fs.writeFileSync(path.join(root, 'screenshots', `${stage}-${name}.png`), (await win.webContents.capturePage()).toPNG()); }
  async function selectRestoreFile(filename) {
    assert.equal(path.dirname(filename), root); const dbg = win.webContents.debugger; assert.equal(dbg.isAttached(), false); dbg.attach('1.3');
    try { const { root: dom } = await dbg.sendCommand('DOM.getDocument'); const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: dom.nodeId, selector: '[name="backupFile"]' }); assert.ok(nodeId); await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: [filename] }); }
    finally { dbg.detach(); }
  }
  async function confirmRestore() { await js(`(() => { const f=document.querySelector('[data-form="restore"]'); f.querySelector('[name="confirmation"]').value='RESTORE EMPTY FARM'; if(!f.checkValidity())throw Error('Invalid restore form'); f.requestSubmit(); })()`); }
  async function sourceStage() {
    const before = notebookContents(profile);
    await farm('facility.save', { name: 'Transfer fixture farm', ownerName: 'Original source owner' });
    const lot = await farm('lot.adopt', { sourceId: 'legacy-flush:transfer-harvest-1', harvestDate: '2026-09-23', room: 'Owner reviewed room', species: 'Blue Oyster', quantityLbs: '12.500', notes: 'Owner adoption' });
    const customer = await farm('customer.create', { name: 'Transfer fixture recipient', address: 'Original recipient address' });
    await farm('shipment.create', { customerId: customer.id, shippedAt: '2026-09-23T12:00:00.000Z', items: [{ lotId: lot.id, quantityLbs: '2.125' }], requestId: 'transfer-fixture-shipment', notes: 'Immutable shipment' });
    await farm('lot.correct', { id: lot.id, expectedVersion: lot.version, room: 'Corrected room', quantityLbs: '12.000', reason: 'Fixture weigh-sheet correction' });
    const log = await farm('log.create', { loggedAt: '2026-09-23', room: 'Transfer source room', temperatureF: 64, humidityPercent: 89, cleaningCompleted: false, lotId: lot.id, deviationNotes: 'Fixture sanitation deviation', correctiveAction: '' });
    await farm('log.resolve', { id: log.id, expectedVersion: log.version, correctiveAction: 'Owner cleaned and verified the fixture worktable', reason: 'Owner verified completed corrective action' });
    let doc = await farm('document.create', { title: 'Transfer recall plan', type: 'RECALL_PLAN', content: 'Fixture owner reviewed recall procedure.' });
    const snapshotDoc = (await farm('snapshot')).documents.find(d => d.id === doc.id); let revision = snapshotDoc.revisions[0];
    await farm('document.submit', { id: doc.id, revisionId: revision.id, expectedVersion: revision.editVersion });
    revision = (await farm('snapshot')).documents.find(d => d.id === doc.id).revisions[0];
    await farm('document.approve', { id: doc.id, revisionId: revision.id, expectedVersion: revision.editVersion, attestation: true });
    // Current notebook evidence may differ from historical adopted snapshots.
    fs.writeFileSync(path.join(profile, 'grow', 'flushes.json'), '\n' + JSON.stringify([{ ...originalHarvest, weight: '1.000', notes: 'Later notebook edit, not adopted facts' }], null, 2) + '\n');
    const raw = notebookContents(profile); await refresh();
    await js(`document.querySelector('[data-transfer="panel"]').open=true`);
    // Hold actual native save await while exercising the renderer lock.
    holdSave = true; await click('[data-transfer="notebook-export"]');
    for (let i = 0; i < 100 && !finishSave; i++) await sleep(30);
    check(saveRequested && finishSave && await js('window.FarmRecovery.isLocked()'), 'Native export dialog keeps acknowledged renderer lock');
    const busy = await js(`window.crowe.farm.request('facility.save',{name:'Unintended queued write',ownerName:'Must not save'})`);
    check(!busy.ok && busy.error.code === 'TRANSFER_BUSY', 'Competing writes rejected rather than queued during dialog');
    await js(`document.querySelector('[data-form="shipment"]').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
    check(await js(`Object.keys(localStorage).every(k=>!k.startsWith('crowe.farm.pending-shipment.'))`), 'Locked submit creates no new intent before dispatch');
    finishSave(); holdSave = false;
    await wait(`document.querySelector('[data-transfer-status="notebook"]').dataset.phase==='exported'`, 'Notebook native export verified');
    await click('[data-transfer="farm-export"]'); await wait(`document.querySelector('[data-transfer-status="farm"]').dataset.phase==='exported'`, 'Farm native export verified');
    same(notebookContents(profile), raw, 'Both exports leave exact source notebook bytes and absent slots unchanged');
    const backup = JSON.parse(fs.readFileSync(farmFile, 'utf8'));
    same((await farm('backup.export')).tables, backup.tables, 'Transfer farm archive preserves exact authoritative source tables');
    const snapshot = await farm('snapshot'), audit = await farm('audit');
    fs.writeFileSync(expectedFile, JSON.stringify({ raw, originalHarvest, snapshot, audit, tables: backup.tables, notebookHash: hash(fs.readFileSync(notebookFile)), farmHash: hash(fs.readFileSync(farmFile)), sourcePid: process.pid }), { mode: 0o600 });
    check(before.flushes !== raw.flushes && snapshot.lots[0].sourceSnapshot.weight === '12.500', 'Changed notebook evidence cannot rewrite historical adoption');
    await shot('legacy-transfer');
    await click('#legacy-recovery-banner button:last-child');
    await wait(`!document.body.classList.contains('legacy-recovery')`, 'Legacy access revoked');
    const denied = await js(`window.crowe.farm.request('snapshot',{})`); check(!denied.ok && denied.error.code === 'UNAVAILABLE', 'Leaving recovery revokes farm bridge');
  }
  async function destinationStage() {
    const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
    check(process.pid !== expected.sourcePid, 'Mycology is a separate process/profile from source Desktop');
    if (stage === 'import') {
      check(!fs.existsSync(path.join(profile, 'grow')), 'Fresh farm-first launch creates no notebook directory');
      await js(`document.querySelector('[data-transfer="panel"]').open=true`);
      await click('[data-transfer="notebook-preview"]');
      await wait(`!document.querySelector('[data-transfer="notebook-summary"]').hidden`, 'Host-selected notebook preview rendered');
      await js(`(() => { const input=document.querySelector('[data-transfer="notebook-confirmation"]'); input.value='IMPORT EMPTY NOTEBOOK'; input.dispatchEvent(new Event('input')); })()`);
      await click('[data-transfer="notebook-import"]'); await wait(`document.querySelector('[data-transfer-status="notebook"]').dataset.phase==='committed'`, 'Notebook committed and verified through owner panel');
      same(notebookContents(profile), expected.raw, 'Notebook import preserves every raw byte, stable ID and absent file');
      check((await farm('snapshot')).lots.length === 0, 'Notebook import does not automatically approve compliance lots');
      const invalid = path.join(root, 'invalid-farm.json'); fs.writeFileSync(invalid, JSON.stringify({ format: 'crowe-farm-backup', schemaVersion: 999 }));
      await click('[data-transfer="farm-restore"]'); await selectRestoreFile(invalid); await confirmRestore();
      await wait(`document.querySelector('[data-transfer-status="farm"]').dataset.phase==='failed'`, 'Farm component reports authoritative failed restore');
      check(await js(`document.querySelector('[data-transfer-status="notebook"]').dataset.phase==='committed'`), 'Farm failure retains notebook committed outcome');
      same(notebookContents(profile), expected.raw, 'Failed farm import never rolls back successful notebook');
      await wait(`!document.querySelector('[data-form="restore"] fieldset').disabled`, 'Restore available after failure');
      await selectRestoreFile(farmFile); await confirmRestore();
      await wait(`document.querySelector('[data-transfer-status="farm"]').dataset.phase==='committed'`, 'Retry only failed farm component commits verified original backup');
      await shot('independent-committed-components');
    }
    if (stage === 'reverse') {
      check(!fs.existsSync(path.join(profile, 'grow')), 'Reverse-order destination starts with absent notebook');
      await farm('backup.restore', { backup: JSON.parse(fs.readFileSync(farmFile, 'utf8')), confirmation: 'RESTORE EMPTY FARM' });
      const beforeTables = (await farm('backup.export')).tables;
      const preview = await transfer('notebook.preview'); assert.ok(preview.ok, JSON.stringify(preview));
      const imported = await transfer('notebook.import', { token: preview.data.token, confirmation: 'IMPORT EMPTY NOTEBOOK' });
      check(imported.ok && imported.data.status === 'committed' && imported.data.verified, 'Non-no-op notebook import succeeds with populated Farm already restored');
      same((await farm('backup.export')).tables, beforeTables, 'Notebook commit changes no populated Farm table, operator, history or receipt');
      fs.writeFileSync(path.join(root, 'reverse-farm-tables.json'), JSON.stringify(beforeTables), { mode: 0o600 });
    }
    if (stage === 'reverse-reopen') same((await farm('backup.export')).tables, JSON.parse(fs.readFileSync(path.join(root, 'reverse-farm-tables.json'), 'utf8')), 'No cross-store modification appears after reverse-order destination restart');
    same(notebookContents(profile), expected.raw, 'Exact notebook bytes survive destination startup/restart');
    const state = await farm('snapshot');
    for (const key of ['facility', 'lots', 'customers', 'shipments', 'logs', 'documents']) same(state[key], expected.snapshot[key], `${key} complete linked records preserved`);
    same(state.storage.operator, expected.snapshot.storage.operator, 'Original operator retained without attribution rewrite');
    const audit = await farm('audit');
    check(audit.length === expected.audit.length + 1 && audit.filter(e => e.action === 'backup.restore').length === 1, 'Exactly one restore receipt appended');
    for (const event of expected.audit) assert.deepEqual(audit.find(e => e.id === event.id), event);
    const preview = await transfer('notebook.preview'); assert.ok(preview.ok, JSON.stringify(preview));
    const repeat = await transfer('notebook.import', { token: preview.data.token, confirmation: 'IMPORT EMPTY NOTEBOOK' });
    check(repeat.ok && repeat.data.status === 'already-imported' && repeat.data.verified, 'Repeated notebook import verifies receipt/content without duplicates');
    const backup = JSON.parse(fs.readFileSync(farmFile, 'utf8'));
    const repeatFarm = await js(`window.crowe.farm.request('backup.restore',${JSON.stringify({ backup, confirmation: 'RESTORE EMPTY FARM' })})`);
    check(!repeatFarm.ok && repeatFarm.error.code === 'STORE_NOT_EMPTY', 'Repeated farm restore refuses nonempty destination without overwrite');
    same(await farm('audit'), audit, 'Repeated imports append no duplicate audit or receipt');
    const adopted = state.lots.find(l => l.sourceId);
    const duplicate = await js(`window.crowe.farm.request('lot.adopt',${JSON.stringify({ sourceId: adopted.sourceId, harvestDate: '2026-09-23', room: 'Attempt', species: 'Oyster', quantityLbs: '1.000', notes: '' })})`);
    check(!duplicate.ok && duplicate.error.code === 'DUPLICATE_SOURCE', 'Imported historical source cannot be adopted twice');
    const recall = await farm('recall', { lotId: adopted.id });
    check(recall.totalShippedLbs === '2.125' && recall.remainingLbs === '9.875' && recall.affectedShipments[0].customer.name === 'Transfer fixture recipient' && recall.affectedShipments[0].lotSnapshot.quantityLbs === '12.500', 'Imported corrections, shipment-time facts and source-to-recipient recall remain exact');
    same(notebookContents(path.join(root, 'desktop-profile')), expected.raw, 'Independent source profile remains intact');
    check(hash(fs.readFileSync(notebookFile)) === expected.notebookHash && hash(fs.readFileSync(farmFile)) === expected.farmHash, 'Original transfer archives unchanged across imports/restart/retries');
    await shot('verified-destination');
  }
  app.whenReady().then(async () => {
    let failed = false;
    try {
      await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: '127.0.0.1:9', proxyBypassRules: '<-loopback>' });
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, cb) => { networkAttempts.push(details.url); cb({ cancel: true }); });
      ({ shutdownNativeResources } = require('../main'));
      ipcMain.removeHandler('crowe:pty:start'); ipcMain.handle('crowe:pty:start', () => ({ ok: false, error: 'Disabled in fixture' }));
      ipcMain.removeHandler('crowe:git:status'); ipcMain.handle('crowe:git:status', () => ({ repo: false, cwd: workspace }));
      // Production Settings eagerly discovers Tailscale. Isolate only that
      // unrelated feature; no claim that all Settings is subprocess-free.
      ipcMain.removeHandler('crowe:companion:status'); ipcMain.handle('crowe:companion:status', () => ({ running: false, tailscale: null, devices: [], paired: false }));
      for (let i = 0; i < 200 && !win; i++) { win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed()); if (!win) await sleep(75); }
      assert.ok(win); if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
      win.setSize(1280, 980);
      console.log(`\nMycology actual-app transfer stage ${stage}`);
      const prefs = win.webContents.getLastWebPreferences(); check(prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration, 'Actual sandboxed product preload, no Node renderer');
      check(fs.realpathSync(app.getPath('userData')) === fs.realpathSync(profile) && app.getPath('sessionData') === profile && os.homedir() === home && process.env.HOME === home && fs.realpathSync(process.cwd()) === fs.realpathSync(workspace), 'All profile/session/home/workspace paths isolated');
      await wait(`window.crowe?.transfer && window.FarmRecovery && !document.getElementById('launch') && document.body.classList.contains('booted')`, 'Actual product shell loaded and veil lifted');
      if (stage === 'source') {
        check(await js(`window.crowe.edition.id==='desktop' && !window.crowe.edition.legacyAccess && document.querySelector('#spaces [data-space="farm"]').hidden`), 'Desktop has no ordinary grower tabs');
        const denied = await js(`window.crowe.farm.request('snapshot',{})`); check(!denied.ok && denied.error.code === 'UNAVAILABLE' && !fs.existsSync(path.join(profile, 'farm-compliance')), 'Denied Desktop access creates no ledger');
        await click('#settings-btn'); await click('[data-legacy="enter"]');
        await wait(`document.body.classList.contains('legacy-recovery') && document.body.dataset.space==='farm'`, 'Explicit Settings recovery entry acknowledged by main');
      } else check(await js(`window.crowe.edition.id==='mycology' && document.body.dataset.space==='farm' && !document.querySelector('.onboarding-actions') && !document.querySelector('#panel-deck .panel')`), 'Mycology launches Farm every time without onboarding/hidden terminal panels');
      await wait(`document.querySelector('[data-form="facility"]') && !document.querySelector('[data-form="facility"] fieldset').disabled`, 'Real worker-backed ledger ready');
      if (stage === 'source') await sourceStage(); else await destinationStage();
      same(networkAttempts, [], 'No Node/Chromium network calls'); same(processAttempts, [], 'No Node/PTY/utility subprocess attempts');
      check(!fetches.some(url => /\/chat|\/responses|\/messages/.test(url)), 'No engine requests');
      check(!fs.existsSync(path.join(home, '.config', 'crowe-logic', 'auth.json')), 'No real legacy account accessed');
      console.log(`Mycology live ${stage}: ${checks} checks passed`);
    } catch (error) { failed = true; console.error(error.stack); try { if (win) { await shot('failure'); fs.writeFileSync(path.join(root, `${stage}-failure.txt`), await js('document.body.innerText'), { mode: 0o600 }); } } catch (_) {} }
    finally { try { win?.webContents.session.flushStorageData(); await shutdownNativeResources(); } catch (e) { failed = true; console.error(e.stack); } await sleep(200); app.exit(failed ? 1 : 0); }
  });
}
