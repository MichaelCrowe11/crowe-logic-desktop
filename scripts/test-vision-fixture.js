#!/usr/bin/env node
'use strict';
// Actual main/preload/renderer + sandboxed Chromium image decoder. Picker and
// gateway are synthetic adapters; no claim of live routing or native-picker UX.
const { app, BrowserWindow, session, ipcMain, dialog, safeStorage, shell, utilityProcess, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const option = name => process.argv.find(arg => arg.startsWith(`--vision-${name}=`))?.slice(`--vision-${name}=`.length);
const stage = option('stage');
assert.ok(!stage || ['lose-response', 'reconcile'].includes(stage), 'Unknown Vision recovery stage');
assert.ok(stage || (!option('root') && !option('nonce')), 'Only child stages accept a shared test root');
const rootInput = stage ? option('root') : fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-vision-fixture-'));
assert.ok(rootInput && path.isAbsolute(rootInput), 'An absolute isolated test root is required');
const root = fs.realpathSync(rootInput);
if (stage) {
  assert.equal(fs.readFileSync(path.join(root, '.vision-recovery-test'), 'utf8'), 'isolated Vision recovery fixture\n', 'Refusing an unmarked test directory');
  assert.match(option('nonce') || '', /^[0-9a-f-]{36}$/, 'Child launch nonce required');
}
const home = path.join(root, 'home'), profile = path.join(root, 'profile'), workspace = path.join(root, 'workspace');
for (const dir of [home, profile, workspace, path.join(profile, 'grow')]) {
  if (stage === 'reconcile') assert.ok(fs.statSync(dir).isDirectory(), 'Recovery cannot seed missing fixture directories');
  else fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
const inherited = { PATH: process.env.PATH || '', LANG: 'en_US.UTF-8', ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}) };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, inherited, { HOME: home, USERPROFILE: home, CROWE_EDITION: 'mycology', XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache') });
os.homedir = () => home;
app.commandLine.appendSwitch('user-data-dir', profile);
app.setPath('home', home); app.setPath('userData', profile); app.setPath('sessionData', profile);
for (const name of ['logs', 'documents', 'downloads', 'temp', 'crashDumps', 'appData']) { const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); app.setPath(name, dir); }
process.env.TMPDIR = process.env.TMP = process.env.TEMP = app.getPath('temp'); process.chdir(workspace);
assert.ok(!app.commandLine.hasSwitch('no-sandbox') && !app.commandLine.hasSwitch('disable-setuid-sandbox'), 'Chromium sandbox must remain enabled');
if (stage !== 'reconcile') {
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ cwd: workspace, telemetry: false, onboarded: true, autonomy: 'readonly', mcpServers: {}, plugins: {}, sense: { mode: 'off' }, controlPlane: 'off' }));
  fs.writeFileSync(path.join(profile, 'grow', 'blocks.json'), JSON.stringify([{ id: 'fixture-block', code: 'Fixture-Lot', species: 'Synthetic oyster', stage: 'fruiting', notes: 'PRIVATE_CONTEXT_DO_NOT_SEND' }]));
  fs.writeFileSync(path.join(profile, 'grow', 'log.json'), JSON.stringify([{ id: 'fixture-old-log', entry: 'Retained fixture entry', custom: { preserved: true } }]));
}
const processAttempts = [], networkAttempts = [], fetches = [];
safeStorage.isEncryptionAvailable = () => false;
safeStorage.encryptString = safeStorage.decryptString = () => { throw new Error('Credential access disabled in fixture'); };
shell.openExternal = async () => { throw new Error('External navigation disabled'); };
const cp = require('node:child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = () => { processAttempts.push(name); throw new Error('Subprocess disabled'); };
utilityProcess.fork = () => { processAttempts.push('utility'); throw new Error('Utility subprocess disabled'); };
try { require('node-pty').spawn = () => { processAttempts.push('pty'); throw new Error('PTY disabled'); }; } catch (_) {}
const blockedNetwork = name => () => { networkAttempts.push(name); throw new Error('Network disabled'); };
for (const name of ['node:http', 'node:https']) { require(name).request = blockedNetwork(name); require(name).get = blockedNetwork(name); }
require('node:net').Socket.prototype.connect = blockedNetwork('net'); require('node:tls').connect = blockedNetwork('tls');
global.fetch = async url => { const address = String(url); fetches.push(address); if (/\/chat|\/responses|\/messages/.test(address)) throw new Error('Engine requests forbidden'); return new Response(JSON.stringify(address.includes('/catalog') ? { models: [] } : {}), { headers: { 'Content-Type': 'application/json' } }); };
const hostModule = require('../vision/host'), originalFactory = hostModule.createVisionHost;
const route = { alias: 'crowelm-vision', engine: 'synthetic-offline-engine', provider: 'fixture-provider', recipient: 'synthetic fixture only, no network', revision: 'fixture-1', metered: true, noFallback: true, toolFree: true, boundedResponse: true };
let fixtureEnabled = false, fixtureHost, calls = 0, picks = 0, cancelPicker = false, delayResolve = null, delayed = false, loseSaveResponse = false;
let droppedReplies = 0;
const actions = [];
const receiptKey = 'crowe.vision.pending-save.v1';
const expectedFile = path.join(root, 'expected-recovery.json');
const answer = () => ({ content: { findings: [{ observation: '<img src=x onerror="window.__visionExecuted=true"> Synthetic surface observation.', uncertainty: 'Not a diagnosis. This response is an offline fixture.' }] }, toolCalls: [], provenance: { alias: route.alias, engine: route.engine, provider: route.provider, recipient: route.recipient, revision: route.revision, requestId: 'synthetic-request-1' } });
hostModule.createVisionHost = opts => {
  const production = originalFactory(opts);
  if (stage !== 'reconcile') fixtureHost = originalFactory({ ...opts, verifiedRoute: route, gateway: async request => {
    calls++; assert.equal(request.model, 'crowelm-vision'); assert.deepEqual(request.tools, []); assert.equal(request.fallback, false); assert.equal(request.toolChoice, 'none');
    assert.ok(!JSON.stringify(request).includes('PRIVATE_CONTEXT_DO_NOT_SEND'));
    assert.ok(request.messages[1].content[1].image_url.url.startsWith('data:image/png;base64,'));
    if (delayed) return new Promise(resolve => { delayResolve = resolve; });
    return answer();
  } });
  return { request: async (...args) => {
    actions.push(args[1]);
    const result = await (fixtureEnabled ? fixtureHost : production).request(...args);
    if (loseSaveResponse && args[1] === 'save' && result.ok) {
      const rows = growRows();
      assert.equal(rows.filter(row => row.id === result.data.id).length, 1, 'Reply loss injected only after real notebook commit');
      assert.equal(rows.find(row => row.id === result.data.id).vision.save.key, args[2].receipt.key);
      droppedReplies++; loseSaveResponse = false; throw new Error('Injected lost IPC response after commit');
    }
    return result;
  }, invalidate: () => { production.invalidate(); fixtureHost?.invalidate(); } };
};
const imageFile = path.join(root, 'synthetic.png');
dialog.showOpenDialog = async (_win, options) => { picks++; assert.deepEqual(options.filters[0].extensions, ['png', 'jpg', 'jpeg']); return { canceled: cancelPicker, filePaths: cancelPicker ? [] : [imageFile] }; };
let win, shutdown = async () => {}, checks = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code);
const check = (condition, label) => { assert.ok(condition, label); checks++; console.log(`  ok ${label}`); };
async function wait(code) { for (let i = 0; i < 180; i++) { try { if (await js(code)) return; } catch (_) {} await sleep(60); } throw new Error(`Wait failed: ${code}`); }
async function click(selector) { await wait(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function shot(name) {
  win.show(); win.focus();
  await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await sleep(250);
  fs.writeFileSync(path.join(root, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}
function growRows() { return JSON.parse(fs.readFileSync(path.join(profile, 'grow', 'log.json'), 'utf8')); }
function notebookHashes() {
  return Object.fromEntries(fs.readdirSync(path.join(profile, 'grow')).sort().map(name => [name,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(profile, 'grow', name))).digest('hex')]));
}
function reportStage(extra = {}) {
  check(networkAttempts.length === 0 && processAttempts.length === 0 && !fetches.some(url => /\/chat|\/responses|\/messages/.test(url)), 'No real network, application subprocess or gateway requests');
  fs.writeFileSync(path.join(root, `${stage}-result.json`), JSON.stringify({ stage, pid: process.pid, nonce: option('nonce'), checks,
    calls, picks, droppedReplies, actions, profile, syntheticOnly: true, shutdown: 'orderly', ...extra }, null, 2), { mode: 0o600 });
  console.log(`Vision recovery ${stage}: ${checks} checks passed. Evidence ${root}.`);
}
async function reconcileAfterRestart() {
  const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
  check(process.pid !== expected.pid && option('nonce') !== expected.nonce, 'Fresh Electron main process and launch identity');
  check(!fixtureHost && !fixtureEnabled, 'Fresh process has production host only, no injected route or gateway');
  check(await js(`localStorage.getItem(${JSON.stringify(receiptKey)}) === ${JSON.stringify(expected.pendingReceipt)}`), 'Pending receipt survived full process exit without reseeding');
  assert.deepEqual(notebookHashes(), expected.notebookHashes); checks++;
  assert.deepEqual(await js(`window.crowe.farm.request('snapshot',{})`), expected.beforeFarm); checks++;
  assert.deepEqual(await js(`window.crowe.farm.request('audit',{})`), expected.beforeAudit); checks++;
  await js(`setSpace('cultivation'); cultLane='blocks'; renderGrowLane('blocks')`);
  await wait(`document.querySelector('.gr-open')`); await click('.gr-open'); await click('[data-vision="inspect"]');
  await wait(`document.querySelector('[data-vision="choose"]').disabled && document.querySelector('[data-vision="reconcile"]')`);
  check(await js(`!document.querySelector('[data-vision="reconcile"]').disabled && !document.querySelector('[data-vision="reconcile"]').closest('[hidden]')`), 'Unavailable production inspection still exposes enabled recovery UI');
  await click('[data-vision="reconcile"]');
  await wait(`document.querySelector('[data-vision="status"]').textContent.includes('Prior observation verified')`);
  check(await js(`document.querySelector('[data-vision="status"]').textContent.includes(${JSON.stringify(expected.id)})`), 'Actual preload and production host reconcile the original saved ID');
  check(await js(`!localStorage.getItem(${JSON.stringify(receiptKey)}) && !document.querySelector('[data-vision="reconcile"]')`), 'Successful recovery clears pending receipt and recovery control');
  check(await js(`document.querySelector('[data-vision="choose"]').disabled`), 'Recovery does not enable the unavailable production route');
  const rows = growRows();
  check(rows.length === 2 && rows.filter(row => row.vision).length === 1 && rows[1].id === expected.id, 'Exactly the original observation remains, no duplicate');
  assert.deepEqual(notebookHashes(), expected.notebookHashes); checks++;
  assert.deepEqual(await js(`window.crowe.farm.request('snapshot',{})`), expected.beforeFarm); checks++;
  assert.deepEqual(await js(`window.crowe.farm.request('audit',{})`), expected.beforeAudit); checks++;
  check(calls === 0 && picks === 0 && actions.filter(action => action === 'reconcile').length === 1 && !actions.some(action => ['prepare', 'analyze', 'review', 'save'].includes(action)), 'Recovery invokes reconcile once, never picker, analysis, review or save');
  await shot('vision-process-reconciled');
  reportStage({ id: expected.id, notebookHashes: notebookHashes() });
}
app.whenReady().then(async () => {
  let failed = false;
  try {
    if (stage !== 'reconcile') {
      const pixels = Buffer.alloc(160 * 120 * 4); for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 80; pixels[i + 1] = 130; pixels[i + 2] = 170; pixels[i + 3] = 255; }
      fs.writeFileSync(imageFile, nativeImage.createFromBitmap(pixels, { width: 160, height: 120 }).toPNG());
    }
    await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: '127.0.0.1:9', proxyBypassRules: '<-loopback>' });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, cb) => { networkAttempts.push(details.url); cb({ cancel: true }); });
    ({ shutdownNativeResources: shutdown } = require('../main'));
    for (const [channel, value] of [['crowe:pty:start', { ok: false, error: 'Fixture disabled' }], ['crowe:git:status', { repo: false, cwd: workspace }], ['crowe:companion:status', { running: false, tailscale: null, devices: [], paired: false }]]) { ipcMain.removeHandler(channel); ipcMain.handle(channel, () => value); }
    for (let i = 0; i < 180 && !win; i++) { win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed()); if (!win) await sleep(60); }
    assert.ok(win); if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await wait(`window.crowe?.vision && window.MycologyVision && document.body.classList.contains('booted') && !document.getElementById('launch')`);
    const prefs = win.webContents.getLastWebPreferences(); check(prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration, 'Actual sandboxed preload and renderer');
    check(app.getPath('userData') === profile && app.getPath('sessionData') === profile && os.homedir() === home, 'Isolated fixture home/profile/session');
    check(!(await js(`window.crowe.vision.request('status')`)).data.available, 'Actual main wiring refuses unverified production route');
    if (stage === 'reconcile') { await reconcileAfterRestart(); return; }
    const unavailable = await js(`window.crowe.vision.request('prepare',{target:{type:'blocks',id:'fixture-block'}})`);
    check(unavailable.error.code === 'UNAVAILABLE' && picks === 0 && calls === 0, 'Production unavailable before photo read/picker/dispatch');
    fixtureEnabled = true;
    await js(`setSpace('cultivation'); cultLane='blocks'; renderGrowLane('blocks')`);
    await wait(`document.querySelector('.gr-open')`); await click('.gr-open'); await click('[data-vision="inspect"]');
    cancelPicker = true; await click('[data-vision="choose"]'); await wait(`document.querySelector('[data-vision="status"]').textContent.includes('Selection cancelled')`);
    check(calls === 0, 'Declined picker sends nothing'); cancelPicker = false;
    await click('[data-vision="choose"]'); await wait(`document.querySelector('[data-vision="preview"]')`);
    check(calls === 0 && (await js(`document.querySelector('[data-vision="preview"]').naturalWidth`)) === 160, 'Actual isolated decoder preview precedes consent');
    check(!(await js(`document.querySelector('[data-vision="disclosure"]').textContent`)).includes('PRIVATE_CONTEXT'), 'Exact disclosed context excludes private notes');
    const beforeFarm = await js(`window.crowe.farm.request('snapshot',{})`);
    const beforeAudit = await js(`window.crowe.farm.request('audit',{})`);
    assert.ok(beforeFarm.ok && beforeAudit.ok, 'Baseline must be real successful Farm snapshot/audit, not matching errors');
    win.setSize(1050, 900); await js(`applyTheme(false)`); await sleep(180);
    check(await js(`!document.body.classList.contains('dark') && getComputedStyle(document.querySelector('.mycology-vision')).backgroundColor === 'rgb(244, 240, 231)'`), 'Light capture uses actual notebook theme colors');
    await shot('vision-preview-light');
    await js(`applyTheme(true)`); win.setSize(900, 820); await sleep(180);
    check(await js(`document.body.classList.contains('dark') && getComputedStyle(document.querySelector('.mycology-vision')).backgroundColor === 'rgb(18, 18, 18)'`), 'Dark capture uses actual notebook theme colors');
    check(win.getSize()[0] === 900, 'Narrow capture is actual supported 900px minimum');
    await shot('vision-preview-900px-dark');
    check(await js(`document.querySelector('[data-vision="dialog"]').scrollWidth <= document.querySelector('[data-vision="dialog"]').clientWidth + 2`), 'Narrow dialog has no horizontal overflow');
    await click('[data-vision="consent"]'); await click('[data-vision="analyze"]'); await wait(`document.querySelector('[data-vision="reviewer"]')`);
    check(calls === 1 && !await js('window.__visionExecuted === true') && !await js(`!!document.querySelector('.vision-finding img')`), 'Tool-free single call and hostile findings rendered as inert text');
    check(growRows().length === 1, 'Analysis alone saves no note');
    await js(`document.querySelector('[data-vision="reviewer"]').value='Fixture Reviewer'; document.querySelector('[data-vision="note"]').value='Separate fixture reviewer note.';`);
    await click('[data-vision="review"]'); await wait(`!document.querySelector('[data-vision="save"]').disabled`);
    await shot('vision-reviewed'); loseSaveResponse = true; await click('[data-vision="save"]');
    await wait(`document.querySelector('[data-vision="status"]').textContent.includes('WRITE_OUTCOME_UNKNOWN')`);
    const pendingReceipt = await js(`localStorage.getItem('crowe.vision.pending-save.v1')`);
    if (stage === 'lose-response') {
      const receipt = JSON.parse(pendingReceipt), rows = growRows(), saved = rows[1];
      assert.deepEqual(Object.keys(receipt).sort(), ['digest', 'key']); checks++;
      assert.deepEqual(receipt, { key: saved.vision.save.key, digest: saved.vision.save.digest }); checks++;
      check(rows.length === 2 && rows[0].custom.preserved && saved.vision.imageRetained === false, 'Lost committed reply leaves exactly one observation and original note');
      const { save, ...operation } = saved.vision;
      check(require('../vision/validation').hash(operation) === receipt.digest && save.rowId === saved.id, 'Persisted receipt digest binds the actual saved operation');
      check(droppedReplies === 1 && calls === 1 && actions.filter(action => action === 'save').length === 1 && !actions.includes('reconcile'), 'One model call, one committed save and one dropped reply, not reconciled in first process');
      assert.deepEqual(await js(`window.crowe.farm.request('snapshot',{})`), beforeFarm); checks++;
      assert.deepEqual(await js(`window.crowe.farm.request('audit',{})`), beforeAudit); checks++;
      fs.writeFileSync(expectedFile, JSON.stringify({ pid: process.pid, nonce: option('nonce'), pendingReceipt, id: saved.id,
        notebookHashes: notebookHashes(), beforeFarm, beforeAudit }, null, 2), { mode: 0o600 });
      await shot('vision-process-uncertain');
      reportStage({ id: saved.id, notebookHashes: notebookHashes() });
      return;
    }
    await js(`document.querySelector('[data-vision="note"]').value='Changed note after uncertain commit'; document.querySelector('[data-vision="note"]').dispatchEvent(new Event('input',{bubbles:true}))`);
    await click('[data-vision="review"]');
    check(await js(`localStorage.getItem('crowe.vision.pending-save.v1') === ${JSON.stringify(pendingReceipt)} && document.querySelector('[data-vision="save"]').disabled && document.querySelector('[data-vision="status"]').textContent.includes('RECOVERY_REQUIRED')`), 'Uncertain save prevents changing review or replacing pending receipt');
    await click('[data-vision="reconcile"]');
    await wait(`document.querySelector('[data-vision="status"]').textContent.includes('Prior observation verified')`);
    check(await js(`document.querySelector('[data-vision="review"]').disabled && document.querySelector('[data-vision="save"]').disabled && !localStorage.getItem('crowe.vision.pending-save.v1')`), 'Reconciliation terminalizes old findings and prevents another save ticket');
    const rows = growRows(); check(rows.length === 2 && rows[0].custom.preserved && rows[1].vision.imageRetained === false, 'One notebook note preserves originals, no retained image');
    check(rows[1].vision.reviewer.note === 'Separate fixture reviewer note.' && rows[1].vision.findings[0].observation.includes('<img'), 'Original model evidence and reviewer note stored separately');
    const id = rows[1].id;
    check(!(await js(`window.crowe.grow.save('log',{id:${JSON.stringify(id)},entry:'overwrite'})`)).ok, 'Actual ordinary IPC refuses generated evidence edits');
    check(!(await js(`window.crowe.grow.delete('log',${JSON.stringify(id)})`)).ok, 'Actual ordinary IPC refuses generated evidence deletion');
    check((await js(`window.crowe.grow.save('log',{id:'fixture-old-log',entry:'Ordinary permitted amendment'})`)).ok, 'Unrelated legacy note still editable');
    assert.deepEqual(await js(`window.crowe.farm.request('snapshot',{})`), beforeFarm); assert.deepEqual(await js(`window.crowe.farm.request('audit',{})`), beforeAudit); checks += 2;
    await click('[data-vision="close"]');
    await click('[data-vision="inspect"]'); await click('[data-vision="choose"]'); await wait(`document.querySelector('[data-vision="consent"]')`);
    delayed = true; await click('[data-vision="consent"]'); await click('[data-vision="analyze"]');
    for (let i = 0; i < 100 && !delayResolve; i++) await sleep(30);
    assert.ok(delayResolve); await click('[data-vision="close"]'); delayResolve(answer()); await sleep(100);
    check(growRows().length === 2 && fixtureHost.pendingCount === 0 && !await js(`!!document.querySelector('[data-vision="dialog"]')`), 'Cancellation discards delayed response and retains one saved observation');
    // Destroy transient host state, then reconcile the same durable receipt via
    // actual preload after a renderer reload, without executing the model again.
    fixtureHost.invalidate(); const receipt = { key: rows[1].vision.save.key, digest: rows[1].vision.save.digest }, count = calls;
    win.reload(); await new Promise(resolve => win.webContents.once('did-finish-load', resolve)); await wait(`!!window.crowe?.vision`);
    const reconciled = await js(`window.crowe.vision.request('reconcile',{receipt:${JSON.stringify(receipt)}})`);
    check(reconciled.ok && reconciled.data.id === id && calls === count && growRows().length === 2, 'Reload reconciliation returns saved ID without model rerun or duplicate');
    check(networkAttempts.length === 0 && processAttempts.length === 0 && !fetches.some(url => /\/chat|\/responses|\/messages/.test(url)), 'No real network, subprocess, or gateway requests');
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ checks, syntheticOnly: true, calls, picks, profile, imageDigest: crypto.createHash('sha256').update(fs.readFileSync(imageFile)).digest('hex') }, null, 2));
    console.log(`Vision actual-app fixture: ${checks} checks passed. Evidence ${root}. Picker/gateway simulated; decoder/main/preload/renderer real.`);
  } catch (error) { failed = true; console.error(error.stack, `\nFixture evidence: ${root}`); try { if (win) { await shot('failure'); fs.writeFileSync(path.join(root, 'failure.txt'), await js('document.body.innerText')); } } catch (_) {} }
  finally {
    fixtureHost?.invalidate();
    try { win?.webContents.session.flushStorageData(); await shutdown(); }
    catch (error) { failed = true; console.error('Vision fixture shutdown failed', error.stack); }
    app.exit(failed ? 1 : 0);
  }
});
