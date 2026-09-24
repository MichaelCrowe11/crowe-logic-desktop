#!/usr/bin/env node
// Actual renderer -> preload -> trusted IPC -> worker -> SQLite acceptance test.
// Uses temporary fixture paths and transport/process guards with Chromium's
// renderer sandbox retained. This is accidental isolation, not OS containment.
// The user approved this alternative on 2026-09-23; no real profile is used.
const { app, BrowserWindow, safeStorage, shell, session, ipcMain, utilityProcess } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const stageArg = process.argv.find((x) => x.startsWith('--farm-stage='));
const rootArg = process.argv.find((x) => x.startsWith('--farm-root='));
const stage = stageArg && stageArg.split('=')[1];
const rootInput = rootArg ? rootArg.slice('--farm-root='.length) : fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-farm-live-'));
// macOS exposes /var via an alias; the notebook rejects aliased path chains.
const root = fs.realpathSync(rootInput);
if (!stage) fs.writeFileSync(path.join(root, '.farm-live-test'), 'isolated farm workflow fixture\n');
if (!fs.existsSync(path.join(root, '.farm-live-test'))) throw new Error('Refusing an unmarked live-test directory');
const home = path.join(root, 'home');
const profile = path.join(root, stage === 'restore' ? 'restored-profile' : stage ? 'profile' : 'runner-profile');
const workspace = path.join(root, 'workspace');
for (const dir of [home, profile, workspace, path.join(root, 'screenshots')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
os.homedir = () => home;
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = path.join(home, '.config');
process.env.CROWE_EDITION = 'mycology';
process.env.CROWE_SPACES = 'chat,cultivation,farm';
app.setPath('home', home);
app.setPath('userData', profile);
app.setPath('sessionData', profile);
for (const name of ['logs', 'documents', 'downloads', 'temp', 'crashDumps', 'appData']) {
  const dir = path.join(root, 'paths', name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  app.setPath(name, dir);
}
process.env.TMPDIR = process.env.TMP = process.env.TEMP = app.getPath('temp');
process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');
process.env.XDG_CACHE_HOME = path.join(home, '.cache');
process.chdir(workspace);
// The test never signs in and must never invoke the macOS login keychain.
safeStorage.isEncryptionAvailable = () => false;
safeStorage.encryptString = safeStorage.decryptString = () => { throw new Error('Credential access is disabled in farm tests'); };
shell.openExternal = async () => { throw new Error('External navigation is disabled in farm tests'); };

if (!stage) {
  const run = (name) => new Promise((resolve, reject) => {
    const args = [__filename, `--farm-stage=${name}`, `--farm-root=${root}`, `--user-data-dir=${path.join(root, name === 'restore' ? 'restored-profile' : 'profile')}`];
    const child = spawn(process.execPath, args, {
      cwd: workspace,
      env: { PATH: process.env.PATH || '', HOME: home, USERPROFILE: home, TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8', CROWE_EDITION: 'mycology', CROWE_SPACES: 'chat,cultivation,farm', ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}) },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Farm live stage ${name} timed out`)); }, 150000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Farm live stage ${name} failed (${code ?? signal})`)); });
  });
  (async () => {
    let code = 0;
    try {
      for (const name of ['create', 'reopen', 'restore']) await run(name);
      console.log(`\nFarm live: all three actual-app stages passed. Evidence: ${root}`);
    } catch (error) { code = 1; console.error(error.stack); console.error(`Preserved evidence: ${root}`); }
    app.exit(code);
  })();
} else {
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ cwd: workspace, telemetry: false, onboarded: true,
    autonomy: 'readonly', mcpServers: {}, plugins: {}, sense: { mode: 'off' }, controlPlane: 'off' }), { mode: 0o600 });
  const source = { id: 'harvest-fixture-001', block: 'CULTIVATION-20260923-01', n: '1', date: '2026-09-23', weight: '50.000', grade: 'A', notes: 'Original recorded harvest', createdAt: 1790160000000,
    room: 'Legacy room label', strain: 'Legacy Blue Oyster', operator: '  Original notebook operator  ',
    scale: { serial: 'FIXTURE-SCALE-01', tareLbs: '0.250', readings: [50, null, '  untouched  '] },
    attachments: [{ name: 'weigh-sheet-fixture.txt', metadata: { verified: false } }], optionalRawField: null };
  const legacyFile = path.join(profile, 'grow', 'flushes.json');
  if (stage === 'create') { fs.mkdirSync(path.dirname(legacyFile), { recursive: true }); fs.writeFileSync(legacyFile, JSON.stringify([source])); }
  const network = [];
  const processAttempts = [];
  // Only the outer runner may spawn the three isolated Electron stages. Inside
  // a stage, native shells, plugin children and utility-process forks are not
  // part of the farm workflow. Block before main captures these exports, and
  // fail the final assertion even if product code catches the refusal.
  function blockProcess(api) {
    return () => { processAttempts.push(api); throw new Error(`Subprocess disabled in isolated farm stage: ${api}`); };
  }
  const childProcess = require('node:child_process');
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[method] = blockProcess(`child_process.${method}`);
  utilityProcess.fork = blockProcess('utilityProcess.fork');
  let nativePty;
  try { nativePty = require('node-pty'); } catch { /* Optional native dependency. */ }
  if (nativePty) nativePty.spawn = blockProcess('node-pty.spawn');
  // Block Node transports independently of Chromium's fixed dead proxy. These
  // guards are for accidental isolation, not a security boundary against code
  // deliberately bypassing them. The farm worker has no networking code.
  const blockedNetwork = () => { throw new Error('External networking is disabled in farm tests'); };
  for (const module of ['node:http', 'node:https']) {
    require(module).request = blockedNetwork;
    require(module).get = blockedNetwork;
  }
  require('node:net').Socket.prototype.connect = blockedNetwork;
  require('node:tls').connect = blockedNetwork;
  global.fetch = async (url, options = {}) => {
    const address = String(url);
    network.push({ url: address, method: options.method || 'GET' });
    if (/\/chat|\/responses|\/messages/.test(address)) throw new Error('Farm workflow attempted an engine request');
    return new Response(JSON.stringify(address.includes('/catalog') ? { models: [] } : {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  // Install proxy before the product creates its window. Remote renderer loads
  // fail locally even if a future screen adds one; local file resources still work.
  let shutdownNativeResources = async () => {};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let checks = 0;
  let win;
  const js = (code) => win.webContents.executeJavaScript(code);
  async function waitFor(code, message, timeout = 20000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try { last = await js(code); if (last) return last; } catch (error) { last = error.message; }
      await sleep(75);
    }
    throw new Error(`${message}; last value: ${JSON.stringify(last)}`);
  }
  function check(condition, message) { assert.ok(condition, message); checks++; console.log(`  ok ${message}`); }
  async function request(action, payload = {}) {
    const result = await js(`window.crowe.farm.request(${JSON.stringify(action)}, ${JSON.stringify(payload)})`);
    assert.ok(result && result.ok, `${action}: ${JSON.stringify(result)}`);
    return result.data;
  }
  const snapshot = () => request('snapshot');
  async function reject(action, payload, code) {
    const result = await js(`window.crowe.farm.request(${JSON.stringify(action)}, ${JSON.stringify(payload)})`);
    check(result && !result.ok && (!code || result.error.code === code), `${action} refused${code ? ` with ${code}` : ''}`);
    return result;
  }
  async function lane(name) {
    await js(`(() => { const b = document.querySelector('.farm-compliance [data-lane="${name}"]') || document.querySelector('.farm-compliance [data-farm-lane="${name}"]'); if (!b) throw new Error('Missing lane ${name}'); b.click(); })()`);
    await sleep(50);
  }
  const formSelector = (form) => `.farm-compliance form[data-form="${form}"]`;
  async function formReady(form) {
    await waitFor(`(() => { const f = document.querySelector(${JSON.stringify(formSelector(form))}); return f && !f.closest('[hidden]') && !f.querySelector('fieldset').disabled; })()`, `${form} form visible and enabled`);
  }
  async function fill(form, values) {
    await formReady(form);
    await js(`(() => { const f = document.querySelector(${JSON.stringify(formSelector(form))});
      for (const [name,value] of Object.entries(${JSON.stringify(values)})) { const el = f.querySelector('[name="'+name+'"]'); if (!el || el.matches(':disabled')) throw new Error('Missing or disabled field '+name+' in ${form}');
        if (el.type === 'checkbox') el.checked = Boolean(value); else el.value = String(value);
        if (el.type !== 'checkbox' && el.value !== String(value)) throw new Error('Field did not retain value: '+name);
        el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
    })()`);
  }
  async function submit(form) {
    await formReady(form);
    await js(`(() => { const f = document.querySelector(${JSON.stringify(formSelector(form))}); if (!f.checkValidity()) throw new Error('Invalid form: '+[...f.elements].filter(e=>e.validity&&!e.validity.valid).map(e=>e.name+': '+e.validationMessage).join('; '));
      const button = f.querySelector('button[type="submit"]'); if (!button || button.matches(':disabled')) throw new Error('Missing enabled submit control'); button.click(); })()`);
  }
  async function clickControl(selector) {
    await waitFor(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); return b && !b.matches(':disabled') && !b.closest('[hidden]'); })()`, `visible enabled control ${selector}`);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function revisionReady(status, version) {
    await waitFor(`(() => { const f = document.querySelector(${JSON.stringify(formSelector('revision'))}); return f && !f.querySelector('fieldset').disabled && f.querySelector('h2').textContent.endsWith(${JSON.stringify(`/ revision ${version}`)}) && [...f.querySelectorAll('.fc-detail')].some(d => d.querySelector('dt').textContent === 'Status' && d.querySelector('dd').textContent === ${JSON.stringify(status)}); })()`, `revision ${version} renders ${status}`);
  }
  async function chooseBackupFile(filename) {
    assert.equal(path.dirname(filename), root, 'Only fixture files may be selected for restore');
    await formReady('restore');
    const debuggerApi = win.webContents.debugger;
    assert.equal(debuggerApi.isAttached(), false, 'File selection must not replace an existing debugger session');
    debuggerApi.attach('1.3');
    try {
      const { root: documentRoot } = await debuggerApi.sendCommand('DOM.getDocument');
      const { nodeId } = await debuggerApi.sendCommand('DOM.querySelector', { nodeId: documentRoot.nodeId, selector: `${formSelector('restore')} input[name="backupFile"]` });
      assert.ok(nodeId, 'Owner backup File input exists');
      await debuggerApi.sendCommand('DOM.setFileInputFiles', { nodeId, files: [filename] });
    } finally { debuggerApi.detach(); }
    check(await js(`(() => { const input = document.querySelector(${JSON.stringify(`${formSelector('restore')} input[name="backupFile"]`)}); return input.files.length === 1 && input.files[0] instanceof File && input.files[0].name === ${JSON.stringify(path.basename(filename))}; })()`), 'owner restore control contains the selected local File');
  }
  async function downloadBackup() {
    await lane('audit');
    await formReady('export');
    const filename = path.join(root, 'backup.json');
    const downloads = win.webContents.session;
    let item;
    let timer;
    let onDownload;
    const completed = new Promise((resolve, rejectDownload) => {
      timer = setTimeout(() => rejectDownload(new Error('Owner backup download did not complete')), 15000);
      onDownload = (event, download, contents) => {
        try {
          item = download;
          assert.equal(contents, win.webContents, 'Backup download originates from the actual owner window');
          assert.match(download.getURL(), /^blob:/, 'Backup export uses the renderer Blob download');
          assert.match(download.getFilename(), /^crowe-farm-backup-\d{4}-\d{2}-\d{2}\.json$/);
          download.setSavePath(filename);
          download.once('done', (_event, status) => status === 'completed' ? resolve() : rejectDownload(new Error(`Backup download ${status}`)));
        } catch (error) { event.preventDefault(); rejectDownload(error); }
      };
      downloads.once('will-download', onDownload);
    });
    // Attach the rejection handler before driving the owner control.
    completed.catch(() => {});
    try {
      await submit('export');
      await completed;
      check(item.getSavePath() === filename && fs.statSync(filename).size > 0, 'owner export control completed a real local JSON download');
      return JSON.parse(fs.readFileSync(filename, 'utf8'));
    } finally {
      clearTimeout(timer);
      downloads.removeListener('will-download', onDownload);
      if (item && item.getState() === 'progressing') item.cancel();
    }
  }
  async function waitSnapshot(predicate, message) {
    const end = Date.now() + 15000;
    let value;
    while (Date.now() < end) {
      const result = await js(`window.crowe.farm.request('snapshot', {})`);
      if (!result?.ok && result?.error?.code === 'TRANSFER_BUSY') { await sleep(100); continue; }
      assert.ok(result?.ok, `snapshot: ${JSON.stringify(result)}`); value = result.data;
      if (predicate(value)) { check(true, message); return value; } await sleep(100);
    }
    const errors = await js(`[...document.querySelectorAll('.farm-compliance [role="alert"]')].filter(e=>!e.hidden).map(e=>e.textContent)`);
    throw new Error(`${message}: ${JSON.stringify(errors)}; snapshot ${JSON.stringify(value).slice(0, 1500)}`);
  }
  async function shot(name, selector) {
    await js(`(() => { document.querySelector('.farm-compliance').scrollTop = 0; ${selector ? `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'start' });` : ''} })()`);
    await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await sleep(180);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(root, 'screenshots', `${stage}-${name}.png`), image.toPNG());
  }
  async function clickText(text, scope = '.farm-compliance') {
    await waitFor(`[...document.querySelectorAll(${JSON.stringify(scope)}+' button')].some(e=>e.textContent.trim()===${JSON.stringify(text)} && !e.matches(':disabled') && !e.closest('[hidden]'))`, `visible enabled button ${text}`);
    await js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)}+' button')].find(e=>e.textContent.trim()===${JSON.stringify(text)} && !e.matches(':disabled') && !e.closest('[hidden]')); b.click(); })()`);
  }
  async function refresh() {
    await clickControl('.farm-compliance [data-fc="refresh"]');
    await waitFor(`!document.querySelector('.farm-compliance [data-fc="refresh"]').disabled && document.querySelector('.farm-compliance [data-fc="status"]').textContent.includes('Local records current')`, 'owner snapshot refresh completed');
  }
  async function exerciseCreate() {
    check((await snapshot()).lots.length === 0, 'fresh isolated farm has no automatic sample records');
    await lane('facility');
    await fill('facility', { name: 'Sample Mushroom Farm', ownerName: 'Farm Owner', address: '1 Sample Farm Lane', emergencyPhone: '555-0101', waterSource: 'Municipal' });
    await submit('facility');
    await waitSnapshot((s) => s.facility?.name === 'Sample Mushroom Farm', 'facility saved through actual form and IPC');
    await lane('lots');
    await fill('lot', { harvestDate: '2026-09-23', room: 'Fruiting Room 2', species: 'Blue Oyster', quantityLbs: '48.000', notes: 'Morning harvest' });
    await submit('lot');
    let state = await waitSnapshot((s) => s.lots.length === 1, 'harvest lot created through actual form');
    const manual = state.lots[0];
    await lane('recall');
    await fill('recall', { lotId: manual.id });
    await submit('recall');
    await waitFor(`document.querySelector('.farm-compliance [data-fc="recall-result"]').textContent.includes('No shipments recorded for this lot. No affected recipients in this database.')`, 'unshipped lot renders an explicit empty recipient result');
    const emptyRecall = await request('recall', { lotId: manual.id });
    check(emptyRecall.affectedShipments.length === 0 && emptyRecall.totalShippedLbs === '0.000' && emptyRecall.remainingLbs === '48.000', 'empty recall retains exact available quantity');
    await reject('recall', { lotId: 'unknown-live-fixture-lot' }, 'NOT_FOUND');
    // A stale selection cannot normally be chosen from the current list; inject
    // only the stale option, then exercise the real form/error handling.
    await js(`(() => { const input = document.querySelector('form[data-form="recall"] [name="lotId"]'); input.add(new Option('Missing fixture lot', 'unknown-live-fixture-lot')); })()`);
    await fill('recall', { lotId: 'unknown-live-fixture-lot' });
    await submit('recall');
    await waitFor(`(() => { const e = document.querySelector('[data-form-error="recall"]'); return !e.hidden && e.textContent.includes('NOT_FOUND'); })()`, 'unknown lot displays a real service error in the recall form');
    check(await js(`document.querySelector('[data-fc="print-recall"]').disabled`), 'unknown recall cannot print a previous result');
    await lane('lots');
    const candidates = await js('window.crowe.farm.legacyHarvests()');
    assert.ok(candidates.ok, `synthetic legacy candidates failed: ${JSON.stringify(candidates.error)}`);
    check(candidates.data.some((c) => c.sourceId === 'legacy-flush:harvest-fixture-001'), 'legacy harvest candidate read through real trusted bridge');
    await clickText('Read current harvest sources');
    await waitFor(`document.querySelector('.farm-compliance [data-fc="adoption"]').textContent.includes('legacy-flush:harvest-fixture-001')`, 'legacy source visible');
    await clickControl('.farm-compliance [data-source-id="legacy-flush:harvest-fixture-001"]');
    await waitFor(`Boolean(document.querySelector('form[data-form="adopt"]'))`, 'owner adoption form opened');
    await fill('adopt', { harvestDate: '2026-09-23', room: 'Fruiting Room 1', species: 'Blue Oyster', quantityLbs: '50.000', notes: 'Owner-reviewed source harvest', ownerConfirmation: true });
    await submit('adopt');
    state = await waitSnapshot((s) => s.lots.length === 2, 'source harvest adopted only after owner form review');
    const adopted = state.lots.find((l) => l.sourceId);
    assert.deepEqual(adopted.sourceSnapshot, source);
    check(adopted.sourceId === 'legacy-flush:harvest-fixture-001', 'adoption retains source identity and full raw row including nested, null and whitespace-bearing extension fields');
    check(fs.readFileSync(legacyFile, 'utf8') === JSON.stringify([source]), 'owner adoption leaves the original notebook file unchanged');
    check(Boolean(adopted.sourceReviewedBy && adopted.sourceApprovedAt && adopted.sourceHash), 'adoption records reviewer, approval time and source hash');
    const adoptionPayload = { sourceId: adopted.sourceId, harvestDate: '2026-09-23', room: 'Fruiting Room 1', species: 'Blue Oyster', quantityLbs: '50.000', notes: 'Retry' };
    await reject('lot.adopt', adoptionPayload, 'DUPLICATE_SOURCE');
    check((await snapshot()).lots.length === 2, 'duplicate source cannot create another compliance lot');
    await reject('lot.adopt', { ...adoptionPayload, sourceSnapshot: { id: 'forged' } });
    await reject('facility.save', { name: 'Spoof', ownerName: 'Spoof', actor: { id: 'forged' } });

    await lane('shipments');
    await fill('customer', { name: 'Sample Market', contact: 'Receiving desk', email: 'buyer@samplemarket.test', phone: '555-0100', address: '10 Sample Market Road' });
    await submit('customer');
    state = await waitSnapshot((s) => s.customers.length === 1, 'customer saved through actual form');
    const customer = state.customers[0];
    await fill('shipment', { customerId: customer.id, shippedAt: '2026-09-23T15:00', notes: 'Delivered refrigerated' });
    await js(`(() => { const row=document.querySelector('.fc-shipment-items'); const s=row.querySelector('select'); const i=row.querySelector('input'); s.value=${JSON.stringify(adopted.id)}; s.dispatchEvent(new Event('change',{bubbles:true})); i.value='20.000'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await clickText('Add lot to shipment');
    await js(`(() => { const box=document.querySelector('.fc-shipment-items'); const selects=[...box.querySelectorAll('select')]; const inputs=[...box.querySelectorAll('input')]; selects[1].value=${JSON.stringify(manual.id)}; selects[1].dispatchEvent(new Event('change',{bubbles:true})); inputs[1].value='10.000'; inputs[1].dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await submit('shipment');
    state = await waitSnapshot((s) => s.shipments.length === 1, 'multi-lot shipment saved through actual form');
    const shipment = state.shipments[0];
    check(shipment.items.length === 2 && shipment.customer.address === '10 Sample Market Road', 'shipment retains both allocations and recipient snapshot');
    check(shipment.items.find((i) => i.lotId === adopted.id).lotSnapshot.sourceHash === adopted.sourceHash, 'shipment preserves source-linked lot facts at posting time');
    const partial = { requestId: 'live-partial-shipment', customerId: customer.id, shippedAt: '2026-09-23T18:00:00.000Z', items: [{ lotId: adopted.id, quantityLbs: '5.125' }], notes: 'Partial afternoon delivery' };
    const second = await request('shipment.create', partial);
    const retry = await request('shipment.create', partial);
    check(second.id === retry.id && (await snapshot()).shipments.length === 2, 'shipment retry is idempotent through real bridge');
    await reject('shipment.create', { ...partial, items: [{ lotId: adopted.id, quantityLbs: '6.000' }] });
    await reject('shipment.create', { ...partial, requestId: 'live-over-allocation', items: [{ lotId: manual.id, quantityLbs: '1.000' }, { lotId: adopted.id, quantityLbs: '30.000' }] }, 'INSUFFICIENT_QUANTITY');
    check((await snapshot()).lots.find((l) => l.id === manual.id).shippedLbs === '10.000', 'failed multi-lot shipment rolls back earlier allocation');

    fs.writeFileSync(legacyFile, JSON.stringify([{ ...source, weight: '1.000', notes: 'Notebook edited after shipping' }]));
    state = await snapshot();
    let current = state.lots.find((l) => l.id === adopted.id);
    check(current.quantityLbs === '50.000' && current.sourceSnapshot.weight === '50.000', 'notebook edits cannot alter adopted or shipped records');
    await refresh(); await lane('lots');
    await clickControl(`.farm-compliance [data-correct-lot-id="${current.id}"]`);
    await fill('lot-correct', { reason: 'Verified scale transcription correction', quantityLbs: '49.500', notes: 'Corrected from original weigh sheet' });
    await submit('lot-correct');
    state = await waitSnapshot((s) => s.lots.find((l) => l.id === adopted.id)?.quantityLbs === '49.500', 'owner correction form appends the changed harvest facts');
    current = state.lots.find((l) => l.id === adopted.id);
    await waitFor(`!document.querySelector('form[data-form="lot-correct"]')`, 'saved correction editor closes');
    assert.deepEqual(current.originalRecord, adopted.originalRecord);
    assert.deepEqual(current.sourceSnapshot, source);
    check(current.corrections.length === 1, 'harvest correction preserves original receipt, complete source row and correction history');
    check(current.sourceHash === adopted.sourceHash && current.sourceApprovedAt === adopted.sourceApprovedAt, 'correction does not change adoption provenance');
    await reject('lot.correct', { id: current.id, expectedVersion: current.version, reason: 'Impossible correction', quantityLbs: '1.000' }, 'INSUFFICIENT_QUANTITY');
    const history = await request('audit', { entityId: current.id });
    const corrected = history.find((e) => e.action === 'lot.correct');
    check(Boolean(corrected?.actor && corrected.reason && corrected.before && corrected.after), 'correction audit records who changed what and why');
    const recall = await request('recall', { lotId: adopted.id });
    check(recall.affectedShipments.length === 2 && recall.totalShippedLbs === '25.125' && recall.remainingLbs === '24.375', 'recall reconciles exact recorded quantities');
    check(recall.lot.sourceId === adopted.sourceId && recall.affectedShipments.every((s) => s.customer.name === 'Sample Market'), 'shipped lot traces to preserved source harvest and recipient records');
    check(recall.affectedShipments[0].lotSnapshot.quantityLbs === '50.000', 'correction cannot rewrite shipment-time lot facts');
    await refresh(); await lane('recall'); await fill('recall', { lotId: adopted.id }); await submit('recall');
    await waitFor(`document.querySelector('[data-fc="recall-result"]').textContent.includes('Sample Market')`, 'recall recipients render');
    await shot('recall', '[data-fc="recall-result"]');

    await lane('logs');
    await fill('log', { loggedAt: '2026-09-23', room: 'Fruiting Room 1', temperatureF: 64, humidityPercent: 89, cleaningCompleted: false, lotId: adopted.id, deviationNotes: 'Packing table cleaning missed', correctiveAction: '' });
    await submit('log');
    state = await waitSnapshot((s) => s.logs.length === 1 && s.dashboard.openDeviations === 1, 'daily deviation starts explicitly open');
    const log = state.logs[0];
    await clickControl(`.farm-compliance [data-resolve-id="${log.id}"]`);
    await fill('log-edit', { correctiveAction: 'Cleaned and inspected packing table before next use', reason: 'Owner verified completed action' });
    await submit('log-edit');
    state = await waitSnapshot((s) => s.logs.find((l) => l.id === log.id)?.deviationStatus === 'RESOLVED' && s.dashboard.openDeviations === 0, 'owner corrective action form closes the deviation');
    const resolvedLog = state.logs.find((l) => l.id === log.id);
    check(resolvedLog.deviationNotes === log.deviationNotes && resolvedLog.resolvedBy && resolvedLog.resolvedAt && resolvedLog.correctiveAction === 'Cleaned and inspected packing table before next use', 'resolution retains original deviation and owner/action/time evidence');
    await waitFor(`!document.querySelector('form[data-form="log-edit"]')`, 'saved deviation editor closes');
    await reject('log.update', { id: log.id, expectedVersion: log.version, reason: 'Stale form', room: 'Changed room' }, 'CONFLICT');

    await lane('documents');
    await fill('document', { title: 'Recall Plan', type: 'RECALL_PLAN', content: 'Sample fixture only. Identify affected lots, review recipient records, and contact the designated owner.' });
    await submit('document');
    state = await waitSnapshot((s) => s.documents.length === 1, 'document draft created through actual form');
    let doc = state.documents[0]; let revision = doc.revisions[0];
    const documentId = doc.id;
    await clickControl(`.farm-compliance [data-document-id="${doc.id}"][data-revision-id="${revision.id}"]`);
    await revisionReady('DRAFT', 1);
    await clickControl('.farm-compliance [data-fc="submit-review"]');
    state = await waitSnapshot((s) => s.documents.find((d) => d.id === documentId)?.revisions[0].status === 'NEEDS_REVIEW', 'owner submit control sends the exact draft for review');
    doc = state.documents.find((d) => d.id === documentId); revision = doc.revisions[0];
    await revisionReady('NEEDS_REVIEW', 1);
    await shot('document-review', 'form[data-form="revision"]');
    await shot('document-attestation', 'form[data-form="revision"] .fc-check');
    await clickControl('.farm-compliance [data-fc="approve-revision"]');
    await waitFor(`(() => { const e = document.querySelector('[data-form-error="revision"]'); return !e.hidden && e.textContent.includes('ATTESTATION_REQUIRED'); })()`, 'owner approval requires explicit review attestation');
    check((await snapshot()).documents.find((d) => d.id === documentId).revisions[0].status === 'NEEDS_REVIEW', 'unchecked owner attestation cannot approve a document');
    await reject('document.approve', { id: doc.id, revisionId: revision.id, expectedVersion: revision.editVersion, attestation: false });
    await fill('revision', { attestation: true });
    await clickControl('.farm-compliance [data-fc="approve-revision"]');
    state = await waitSnapshot((s) => s.documents.find((d) => d.id === documentId)?.revisions[0].status === 'APPROVED', 'owner approval control approves revision one');
    doc = state.documents.find((d) => d.id === documentId); revision = doc.revisions[0];
    const approvedContent = revision.content;
    check(revision.approvedAt && revision.approvedBy && revision.contentHash, 'owner approval binds exact document content and identity/time');
    await revisionReady('APPROVED', 1);
    check(await js(`!document.querySelector('form[data-form="revision"] [name="content"]') && !document.querySelector('form[data-form="revision"] [name="title"]')`), 'approved revision UI exposes no mutable title or content field');
    await shot('document-approved', 'form[data-form="revision"]');
    await reject('document.edit', { id: doc.id, revisionId: revision.id, expectedVersion: revision.editVersion, title: 'Overwrite', content: 'Changed approved text', reason: 'Attempted overwrite' }, 'INVALID_STATE');
    await fill('revision', { reason: 'Update recall contact procedure' });
    await submit('revision');
    state = await waitSnapshot((s) => s.documents.find((d) => d.id === documentId)?.revisions.length === 2, 'owner successor control creates a new draft');
    doc = state.documents.find((d) => d.id === documentId);
    let successor = doc.revisions.find((r) => r.status === 'DRAFT');
    check(doc.revisions.find((r) => r.id === revision.id).status === 'APPROVED' && successor.content === approvedContent, 'successor draft retains the active prior approval until reviewed');
    await revisionReady('DRAFT', 2);
    const successorContent = `${approvedContent}\nConfirm current emergency contacts.`;
    await fill('revision', { title: 'Recall Plan', content: successorContent, reason: 'Added contact check' });
    await clickControl('.farm-compliance [data-fc="submit-review"]');
    await waitFor(`(() => { const e = document.querySelector('[data-form-error="revision"]'); return !e.hidden && e.textContent.includes('UNSAVED_CHANGES'); })()`, 'review control refuses unsaved successor text');
    await submit('revision');
    state = await waitSnapshot((s) => s.documents.find((d) => d.id === documentId)?.revisions.find((r) => r.id === successor.id)?.content === successorContent, 'owner edit form saves successor content and edit reason');
    doc = state.documents.find((d) => d.id === documentId);
    successor = doc.revisions.find((r) => r.id === successor.id);
    await revisionReady('DRAFT', 2);
    await clickControl('.farm-compliance [data-fc="submit-review"]');
    await waitSnapshot((s) => s.documents.find((d) => d.id === documentId)?.revisions.find((r) => r.id === successor.id)?.status === 'NEEDS_REVIEW', 'owner submits saved successor for review');
    await revisionReady('NEEDS_REVIEW', 2);
    check(await js(`!document.querySelector('form[data-form="revision"] [name="attestation"]').checked`), 'successor review requires a fresh unchecked attestation');
    await fill('revision', { attestation: true });
    await clickControl('.farm-compliance [data-fc="approve-revision"]');
    state = await waitSnapshot((s) => s.documents.find((d) => d.id === documentId)?.revisions.find((r) => r.id === successor.id)?.status === 'APPROVED', 'owner successor approval completes explicit supersession');
    doc = state.documents.find((d) => d.id === documentId);
    const superseded = doc.revisions.find((r) => r.id === revision.id);
    successor = doc.revisions.find((r) => r.id === successor.id);
    check(superseded.status === 'SUPERSEDED' && superseded.content === approvedContent && superseded.contentHash === revision.contentHash && superseded.approvedAt === revision.approvedAt, 'supersession preserves prior approved text, hash and approval time');
    check(superseded.supersededByRevisionId === successor.id && successor.supersedesRevisionId === superseded.id && successor.content === successorContent, 'supersession links both immutable revisions');
    await revisionReady('APPROVED', 2);
    await shot('document-successor-approved', 'form[data-form="revision"]');
    await clickControl(`.farm-compliance [data-document-id="${doc.id}"][data-revision-id="${revision.id}"]`);
    await revisionReady('SUPERSEDED', 1);
    check(await js(`document.querySelector('.fc-document-content').textContent === ${JSON.stringify(approvedContent)}`), 'owner can inspect the superseded original content');
    await shot('documents', 'form[data-form="revision"]');
    await lane('dashboard'); await shot('dashboard');
    win.setMinimumSize(360, 560); win.setSize(430, 850);
    await waitFor(`document.body.classList.contains('sidebar-collapsed') && document.querySelector('.farm-compliance').getBoundingClientRect().width >= innerWidth - 4`, 'narrow farm window preserves usable content width');
    await shot('narrow');
    check(await js(`document.querySelector('.farm-compliance').scrollWidth <= document.querySelector('.farm-compliance').clientWidth + 2`), 'workspace fits narrow viewport without horizontal overflow');
    check(await js(`document.querySelector('.farm-compliance').clientWidth >= 400 && document.querySelector('#sidebar-toggle').getAttribute('aria-expanded') === 'false'`), 'narrow workspace has readable width and accessible collapsed navigation');
    await clickControl('#sidebar-toggle');
    check(await js(`!document.body.classList.contains('sidebar-collapsed') && document.querySelector('#sidebar-toggle').getAttribute('aria-expanded') === 'true'`), 'owner can reopen navigation in narrow window');
    win.setSize(1280, 900); await sleep(250);
    await shot('dark');
    await clickControl('#theme-btn');
    check(await js(`!document.body.classList.contains('dark')`), 'owner theme control selects real light mode');
    await shot('light');
    await clickControl('#theme-btn');
    const backup = await downloadBackup();
    const supplementalBackup = await request('backup.export');
    check(backup.format === 'crowe-farm-backup' && backup.schemaVersion === 1 && typeof backup.checksum === 'string', 'downloaded backup carries the real versioned store envelope');
    assert.deepEqual(backup.tables, supplementalBackup.tables);
    check(true, 'owner-downloaded backup agrees with supplemental live IPC export, including audit and provenance');
    const final = await snapshot();
    const audit = await request('audit');
    const records = Object.fromEntries(['facility', 'lots', 'customers', 'shipments', 'logs', 'documents'].map((key) => [key, final[key]]));
    fs.writeFileSync(path.join(root, 'expected.json'), JSON.stringify({ facility: final.facility.name, lotId: adopted.id, sourceHash: adopted.sourceHash, lots: final.lots.length, shipments: final.shipments.length, documents: final.documents.length, totalShippedLbs: recall.totalShippedLbs, auditCount: audit.length, audit, records }), { mode: 0o600 });
    await reject('backup.restore', { backup, confirmation: 'RESTORE EMPTY FARM' }, 'STORE_NOT_EMPTY');
  }
  async function exerciseReopen() {
    const expected = JSON.parse(fs.readFileSync(path.join(root, 'expected.json')));
    const state = await snapshot();
    check(state.facility.name === expected.facility && state.lots.length === expected.lots && state.shipments.length === expected.shipments, 'records survive a full application process restart');
    const lot = state.lots.find((l) => l.id === expected.lotId);
    assert.deepEqual(lot.sourceSnapshot, source);
    check(lot.sourceHash === expected.sourceHash && lot.corrections.length === 1, 'complete raw source provenance and corrections survive restart');
    for (const [key, records] of Object.entries(expected.records)) assert.deepEqual(state[key], records, `${key} records survive restart exactly`);
    assert.deepEqual(await request('audit'), expected.audit);
    check(true, 'restart preserves full record content and exact audit history without phantom mutations');
    await lane('recall'); await fill('recall', { lotId: expected.lotId }); await submit('recall');
    await waitFor(`document.querySelector('[data-fc="recall-result"]').textContent.includes('Sample Market')`, 'reopened recall renders');
    await shot('persisted-recall', '[data-fc="recall-result"]');
  }
  async function exerciseRestore() {
    const expected = JSON.parse(fs.readFileSync(path.join(root, 'expected.json')));
    const backup = JSON.parse(fs.readFileSync(path.join(root, 'backup.json')));
    check((await snapshot()).lots.length === 0, 'restore target is a separate empty profile');
    await reject('backup.restore', { backup: { ...backup, schemaVersion: 999 }, confirmation: 'RESTORE EMPTY FARM' }, 'INVALID_BACKUP');
    await lane('audit');
    const invalidFile = path.join(root, 'invalid-backup.json');
    fs.writeFileSync(invalidFile, '{invalid JSON fixture', { mode: 0o600 });
    await chooseBackupFile(invalidFile);
    await fill('restore', { confirmation: 'RESTORE EMPTY FARM' });
    await submit('restore');
    await waitFor(`(() => { const e = document.querySelector('[data-form-error="restore"]'); return !e.hidden && e.textContent.includes('INVALID_BACKUP'); })()`, 'selected malformed backup produces a visible parse error');
    await formReady('restore');
    const incompatibleFile = path.join(root, 'incompatible-backup.json');
    fs.writeFileSync(incompatibleFile, JSON.stringify({ ...backup, schemaVersion: 999 }), { mode: 0o600 });
    await chooseBackupFile(incompatibleFile);
    await submit('restore');
    await waitFor(`(() => { const f = document.querySelector('form[data-form="restore"]'); const e = f.querySelector('[role="alert"]'); return !f.querySelector('fieldset').disabled && !e.hidden && e.textContent.includes('INVALID_BACKUP') && f.querySelector('.fc-form-status').textContent.includes('Not confirmed'); })()`, 'selected incompatible backup is rejected by the real service');
    check((await snapshot()).lots.length === 0 && (await snapshot()).facility === null && (await request('audit')).length === 0, 'failed file restores leave empty target and audit unchanged');
    await chooseBackupFile(path.join(root, 'backup.json'));
    await fill('restore', { confirmation: 'not confirmed' });
    await submit('restore');
    await waitFor(`(() => { const e = document.querySelector('[data-form-error="restore"]'); return !e.hidden && e.textContent.includes('CONFIRMATION_REQUIRED'); })()`, 'restore requires the explicit owner confirmation phrase');
    check((await snapshot()).facility === null, 'incorrect owner confirmation cannot start restore');
    await fill('restore', { confirmation: 'RESTORE EMPTY FARM' });
    await submit('restore');
    const state = await waitSnapshot((s) => s.facility?.name === expected.facility && s.lots.length === expected.lots && s.shipments.length === expected.shipments && s.documents.length === expected.documents, 'owner-selected downloaded File restores all linked records into empty profile');
    assert.deepEqual(state.lots.find((l) => l.id === expected.lotId).sourceSnapshot, source);
    await waitFor(`document.querySelector('form[data-form="restore"] fieldset').disabled && document.querySelector('[data-fc="restore-notice"]').textContent.includes('Restore is unavailable')`, 'successful restore locks populated target against overwrite');
    const recall = await request('recall', { lotId: expected.lotId });
    check(recall.totalShippedLbs === expected.totalShippedLbs && recall.lot.sourceHash === expected.sourceHash, 'restore preserves quantities, adoption provenance and forward trace');
    for (const [key, records] of Object.entries(expected.records)) assert.deepEqual(state[key], records, `${key} records restore exactly`);
    const restoredAudit = await request('audit');
    check(restoredAudit.length === expected.auditCount + 1, 'restore adds exactly one receipt to preserved audit history');
    for (const event of expected.audit) assert.deepEqual(restoredAudit.find((row) => row.id === event.id), event, `restored audit event ${event.id}`);
    check(true, 'restore retains every original audit event and complete linked record content');
    await refresh(); await lane('dashboard'); await shot('restored-dashboard');
  }
  app.whenReady().then(async () => {
    let failed = false;
    try {
      await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: '127.0.0.1:9', proxyBypassRules: '<-loopback>' });
      ({ shutdownNativeResources } = require('../main'));
      ipcMain.removeHandler('crowe:pty:start');
      ipcMain.handle('crowe:pty:start', () => ({ ok: false, error: 'Terminal disabled by isolated farm test' }));
      ipcMain.removeHandler('crowe:git:status');
      ipcMain.handle('crowe:git:status', () => ({ repo: false, cwd: workspace }));
      const end = Date.now() + 15000;
      while (!win && Date.now() < end) { win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()); if (!win) await sleep(75); }
      assert.ok(win, 'actual main app window was not created');
      if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
      win.setSize(1280, 900);
      check(fs.realpathSync(app.getPath('userData')) === fs.realpathSync(profile) && os.homedir() === home, 'real app runs only in marked temporary profile and home');
      check(fs.realpathSync(process.cwd()) === fs.realpathSync(workspace) && app.getPath('sessionData') === profile && process.env.HOME === home && process.env.USERPROFILE === home, 'stage retains isolated working directory, session and inherited home paths');
      await waitFor(`Boolean(window.crowe?.farm && window.FarmCompliance && document.querySelector('#spaces [data-space="farm"]'))`, 'farm bridge and actual shell are present');
      await waitFor(`!document.getElementById('launch') && document.body.classList.contains('booted')`, 'startup veil naturally lifts before owner interaction');
      check(await js(`window.crowe.edition.id === 'mycology' && document.body.dataset.space === 'farm' && !document.querySelector('.onboarding-actions') && !document.querySelector('#panel-deck .panel')`), 'Mycology lands directly on Farm without onboarding or hidden panels');
      await waitFor(`Boolean(document.querySelector('.farm-compliance form[data-form="facility"]'))`, 'actual farm workspace mounted');
      await waitFor(`!document.querySelector('.farm-compliance form[data-form="facility"] fieldset').disabled`, 'SQLite workspace ready');
      console.log(`\nFarm live stage: ${stage}`);
      if (stage === 'create') await exerciseCreate();
      else if (stage === 'reopen') await exerciseReopen();
      else if (stage === 'restore') await exerciseRestore();
      else throw new Error(`Unknown stage ${stage}`);
      check(!network.some((entry) => /\/chat|\/responses|\/messages/.test(entry.url)), 'complete farm workflow makes no engine requests');
      check(processAttempts.length === 0, `farm stage attempted no Node, PTY or utility subprocesses (${processAttempts.join(', ')})`);
      check(!fs.existsSync(path.join(home, '.config', 'crowe-logic', 'auth.json')), 'test never imports a real legacy account');
      console.log(`Farm live ${stage}: ${checks} checks passed`);
    } catch (error) {
      failed = true; console.error(`Farm live ${stage}: FAIL`, error.stack);
      try { if (win) { await shot('failure'); fs.writeFileSync(path.join(root, `${stage}-failure-ui.txt`), await js('document.body.innerText')); } } catch {}
    } finally {
      try { await shutdownNativeResources(); } catch {}
      await sleep(150);
      app.exit(failed ? 1 : 0);
    }
  });
}
