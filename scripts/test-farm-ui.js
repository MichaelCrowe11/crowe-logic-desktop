#!/usr/bin/env node
'use strict';
// Renderer contract tests, not domain-integrity evidence. No app/main import,
// production profile, external network, engine, or installed dependency writes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-farm-ui-'));
  const electron = require('electron');
  const env = { ...process.env, HOME: home, FARM_UI_TEST_HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache') };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawnSync(electron, [__filename], { env, stdio: 'inherit', timeout: 120000 });
  if (child.error) console.error(child.error.message);
  process.exit(child.status === null ? 1 : child.status);
}
const { app, BrowserWindow, session } = require('electron');
const home = process.env.FARM_UI_TEST_HOME;
if (!home || !path.basename(home).startsWith('crowe-farm-ui-') || !fs.statSync(home).isDirectory()) throw new Error('Run this test through Node to create an isolated temporary home.');
for (const name of ['home', 'userData', 'sessionData', 'logs', 'crashDumps', 'downloads']) {
  const target = path.join(home, name); fs.mkdirSync(target, { recursive: true }); app.setPath(name, target);
}
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const source = name => pathToFileURL(path.join(root, name)).href;
const fixture = path.join(home, 'fixture.html');
fs.writeFileSync(path.join(home, 'fixture.css'), '#host { height: 100%; min-height: 0; width: 100%; overflow: hidden; }');
fs.writeFileSync(fixture, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' file:; style-src 'self' file:; font-src 'self' file:; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'"><link rel="stylesheet" href="${source('renderer/styles.css')}"><link rel="stylesheet" href="${source('renderer/farm-compliance.css')}"><link rel="stylesheet" href="fixture.css"><script defer src="${source('renderer/farm-recovery.js')}"></script><script defer src="${source('renderer/farm-compliance.js')}"></script><script defer src="${source('renderer/mycology-transfer.js')}"></script></head><body><main id="host"></main></body></html>`);
let win;
app.whenReady().then(async () => {
  try {
    const partition = session.fromPartition('farm-ui-isolated');
    partition.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !['file:', 'blob:', 'data:', 'devtools:'].includes(new URL(details.url).protocol) }));
    partition.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win = new BrowserWindow({ width: 1280, height: 960, show: false, webPreferences: { session: partition, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await win.loadFile(fixture);
    const result = await win.webContents.executeJavaScript(`(${browserTests.toString()})()`);
    console.log(`Runtime Electron ${process.versions.electron}, Node ${process.versions.node}`);
    for (const name of result.passed) console.log('PASS ' + name);
    if (result.error) throw new Error(result.error);
    // Assert print isolation under actual Chromium print-media CSS.
    await win.webContents.executeJavaScript(`window.testWorkspace.open('recall'); document.querySelector('.farm-compliance').classList.add('fc-printing'); document.querySelectorAll('[data-fc="recall-result"] details').forEach(el => el.open = true)`);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { media: 'print' });
    const printState = await win.webContents.executeJavaScript(`({header:getComputedStyle(document.querySelector('.fc-header')).display,form:getComputedStyle(document.querySelector('[data-form="recall"]')).display,result:getComputedStyle(document.querySelector('.fc-recall-result')).display,max:getComputedStyle(document.querySelector('.fc-recall-result pre')).maxHeight})`);
    if (printState.header !== 'none' || printState.form !== 'none' || printState.result === 'none' || printState.max !== 'none') throw new Error('Recall-only print CSS failed: ' + JSON.stringify(printState));
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { media: '' }); win.webContents.debugger.detach();
    await win.webContents.executeJavaScript(`document.querySelector('.farm-compliance').classList.remove('fc-printing')`);
    console.log('PASS actual Chromium recall-only print CSS and unbounded evidence');
    // Capture both supported themes and a narrow viewport for visual inspection.
    for (const [theme, lane, width] of [['light', 'overview', 1280], ['dark', 'recall', 1280], ['light', 'documents', 390]]) {
      win.setContentSize(width, 960);
      const bounds = await win.webContents.executeJavaScript(`(async () => {
        document.body.classList.toggle('dark', ${theme === 'dark'}); window.testWorkspace.open(${JSON.stringify(lane)});
        document.querySelector('.farm-compliance').scrollTop = 0;
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const workspace = document.querySelector('.farm-compliance');
        return { width: innerWidth, scroll: workspace.scrollWidth, client: workspace.clientWidth,
          lane: document.querySelector('[role="tab"][aria-selected="true"]').dataset.lane,
          visible: [...document.querySelectorAll('[data-pane]')].filter(el => !el.hidden && getComputedStyle(el).display !== 'none').map(el => el.dataset.pane),
          dark: document.body.classList.contains('dark'), background: getComputedStyle(workspace).backgroundColor };
      })()`);
      const color = bounds.background.match(/\d+/g).map(Number);
      if (bounds.width !== width || bounds.lane !== lane || JSON.stringify(bounds.visible) !== JSON.stringify([lane]) || bounds.dark !== (theme === 'dark') || (theme === 'dark' ? color[0] > 50 : color[0] < 200)) throw new Error(`Capture state was not rendered: ${JSON.stringify(bounds)}`);
      if (bounds.scroll > bounds.client + 1) throw new Error(`Horizontal workspace overflow at ${width}px: ${JSON.stringify(bounds)}`);
      // Capture through Chromium after its frame pipeline rather than reusing the
      // last hidden-window backing-store image from capturePage().
      win.webContents.debugger.attach('1.3');
      const image = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      win.webContents.debugger.detach();
      fs.writeFileSync(path.join(home, `${theme}-${lane}-${width}.png`), Buffer.from(image.data, 'base64'));
    }
    console.log(`farm-ui: ${result.passed.length + 1} checks passed. Isolated evidence: ${home}`);
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack); if (win) win.destroy(); app.exit(1); }
});

async function browserTests() {
  const passed = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const equal = (a, b, message) => assert(JSON.stringify(a) === JSON.stringify(b), `${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  const q = selector => document.querySelector(selector);
  const qa = selector => [...document.querySelectorAll(selector)];
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const wait = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } throw new Error('Timed out waiting for renderer state'); };
  const clone = object => JSON.parse(JSON.stringify(object));
  const ok = data => ({ ok: true, data });
  const bad = (code, message) => ({ ok: false, error: { code, message } });
  const field = (form, name, value) => { const input = q(`[data-form="${form}"] [name="${name}"]`); assert(input, `Missing ${form}.${name}`); if (input.type === 'checkbox') input.checked = value; else input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); return input; };
  const submit = async form => { const f = q(`[data-form="${form}"]`); assert(f.checkValidity(), `Invalid fixture input in ${form}`); f.requestSubmit(); await tick(); };
  const click = async selector => { assert(q(selector), `Missing ${selector}`); q(selector).click(); await tick(); };
  const timestamp = '2026-09-23T09:00:00.000Z';
  const lot = { id: 'lot-1', lotCode: 'H-0001', version: 2, harvestDate: '2026-09-22', room: 'Room B', species: 'Oyster', quantityLbs: '48.000', shippedLbs: '20.000', remainingLbs: '28.000', notes: 'Reviewed harvest', sourceId: 'legacy-flush:source-1', sourceSnapshot: { id: 'source-1', strain: 'Oyster', room: 'Room A' }, sourceReviewedBy: { id: 'operator-local', name: 'Local owner' }, sourceApprovedAt: timestamp, sourceHash: 'fixture-source-hash', originalRecord: { room: 'Room A', quantityLbs: '48.000' }, corrections: [{ timestamp, actor: { name: 'Local owner' }, reason: 'Correct room', before: { room: 'Room A' }, after: { room: 'Room B' } }], createdAt: timestamp };
  const lot2 = { ...clone(lot), id: 'lot-2', lotCode: 'H-0002', version: 1, shippedLbs: '0.000', remainingLbs: '48.000', sourceId: null, sourceSnapshot: null, corrections: [] };
  const savedLot = { ...clone(lot), version: 1, room: 'Room A', corrections: [] };
  const customer = { id: 'customer-1', name: 'Fixture recipient', contact: 'Receiving desk', email: 'fixture@example.invalid', phone: '555-0100', address: 'Recorded address' };
  const shipment = { id: 'shipment-1', customerId: customer.id, customer: clone(customer), shippedAt: timestamp, items: [{ lotId: lot.id, lotCode: lot.lotCode, quantityLbs: '20.000', lotSnapshot: savedLot }], notes: 'Fixture dispatch' };
  const revision = { id: 'rev-1', version: 1, editVersion: 3, title: 'Fixture sanitation SOP', content: '<img src=x onerror="window.injected=true">\nOwner-reviewed text.', status: 'DRAFT', approvedAt: null, approvedBy: null };
  const doc = { id: 'document-1', title: revision.title, type: 'SANITATION_SOP', revisions: [revision] };
  const log = { id: 'log-1', version: 4, loggedAt: '2026-09-23', room: 'Room A', temperatureF: 67, humidityPercent: 91, cleaningCompleted: true, lotId: lot.id, deviationNotes: 'Humidity exceeded limit', correctiveAction: 'Adjust ventilation', deviationStatus: 'OPEN' };
  const populated = { facility: { id: 'facility-1', name: 'Fixture farm', ownerName: 'Fixture owner', address: 'Local address', emergencyPhone: '555-0101', waterSource: 'Municipal' }, lots: [lot, lot2], customers: [customer], shipments: [shipment], logs: [log], documents: [doc], dashboard: { lotsCreated: 2, shipmentsRecorded: 1, openDeviations: 1, documentsAwaitingApproval: 0, recentLots: [lot, lot2], recentShipments: [shipment] }, storage: { kind: 'desktop-local', schemaVersion: 1, operator: { id: 'operator-local', name: 'Local owner' }, notice: 'Isolated renderer fixture. Desktop-local only.' } };
  const emptyState = { ...clone(populated), facility: null, lots: [], customers: [], shipments: [], logs: [], documents: [], dashboard: { lotsCreated: 0, shipmentsRecorded: 0, openDeviations: 0, documentsAwaitingApproval: 0, recentLots: [], recentShipments: [] } };
  let snapshot = clone(populated), calls = [], handlers = {}, instance;
  const api = {
    request(action, payload) {
      calls.push({ action, payload: clone(payload) });
      if (handlers[action]) return handlers[action](payload);
      if (action === 'snapshot') return Promise.resolve(ok(clone(snapshot)));
      if (action === 'recall') return Promise.resolve(ok({ lot: clone(snapshot.lots.find(l => l.id === payload.lotId)), affectedShipments: payload.lotId === lot.id ? [{ shipmentId: shipment.id, shippedAt: timestamp, customer, quantityLbs: '20.000', notes: shipment.notes, lotSnapshot: savedLot }] : [], totalShippedLbs: payload.lotId === lot.id ? '20.000' : '0.000', remainingLbs: payload.lotId === lot.id ? '28.000' : '48.000' }));
      if (action === 'audit') return Promise.resolve(ok([{ id: 'audit-1', entityId: lot.id, actor: { name: 'Local owner' }, timestamp, action: 'lot.correct', reason: 'Correct room', before: { room: 'Room A' }, after: { room: 'Room B' } }]));
      if (action === 'backup.export') return Promise.resolve(ok({ format: 'crowe-farm-backup', schemaVersion: 1, exportedAt: timestamp, checksum: 'fixture-checksum', fixtureOnly: true }));
      return Promise.resolve(ok({ id: 'saved-fixture' }));
    },
    legacyHarvests() { return Promise.resolve(ok([{ id: 'source-1', sourceId: lot.sourceId, date: lot.harvestDate, room: 'Room A', strain: 'Oyster', weightLbs: '48.000' }])); }
  };
  const remount = async (data = populated, bridge = api) => {
    if (instance) instance.destroy(); snapshot = clone(data); calls = []; handlers = {};
    instance = window.FarmCompliance.mount(q('#host'), bridge); window.testWorkspace = instance;
    await wait(() => !q('[data-fc="status"]').textContent.startsWith('Opening') && !q('[data-fc="status"]').textContent.startsWith('Reading'));
  };
  const refresh = async () => { await click('[data-fc="refresh"]'); await wait(() => !q('[data-fc="refresh"]').disabled); };
  try {
    await remount();
    equal(qa('[role="tab"]').map(el => el.dataset.lane), ['overview', 'facility', 'lots', 'shipments', 'logs', 'recall', 'documents', 'audit'], 'Eight final contract tabs');
    assert(q('[data-count="lotsCreated"]').textContent === '2', 'Store dashboard count');
    const tab = q('[data-lane="overview"]'); tab.focus(); tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert(document.activeElement.dataset.lane === 'facility' && q('[data-lane="facility"]').getAttribute('aria-selected') === 'true', 'Keyboard tabs');
    assert(qa('[data-form] input:not([type="submit"]), [data-form] textarea, [data-form] select').every(el => el.labels.length), 'All form inputs labeled');
    passed.push('eight tabs, keyboard navigation, labels, authoritative neutral counts');

    const recovery = window.FarmRecovery;
    assert(recovery.acquire('fixture-lease').ok && recovery.isLocked(), 'Host acquisition installs lock synchronously');
    assert(recovery.inspect('fixture-lease').ok, 'Clean mounted farm passes inspection');
    assert(!recovery.acquire('competing-lease').ok && !recovery.release('competing-lease').ok && recovery.isLocked(), 'Competing owner cannot acquire or release');
    assert(q('[data-form="shipment"] fieldset').disabled && q('[data-form="restore"] fieldset').disabled, 'Transfer lease disables submit and restore');
    const beforeLocked = calls.length;
    q('[data-form="shipment"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick();
    assert(calls.length === beforeLocked && !recovery.readPendingShipment(), 'Locked programmatic submit cannot create first intent');
    let memoryBlock = 'A shipment could not be persisted'; const unregister = recovery.registerBlocker(() => memoryBlock);
    assert(!recovery.inspect('fixture-lease').ok, 'In-memory failed persistence blocks with empty namespace');
    memoryBlock = null; unregister();
    const foreignKey = recovery.shipmentStorageKey('foreign-owner');
    const foreignRaw = JSON.stringify({ schemaVersion: 1, operatorId: 'foreign-owner', payload: { customerId: customer.id, shippedAt: timestamp, notes: '', items: [{ lotId: lot.id, quantityLbs: '1.000' }], requestId: 'fixture-foreign-request' } });
    localStorage.setItem(foreignKey, foreignRaw);
    assert(!recovery.inspect('fixture-lease').ok && localStorage.getItem(foreignKey) === foreignRaw, 'Entire foreign namespace blocks read-only inspection');
    localStorage.setItem('crowe.farm.pending-shipment.unknown-version', '{}');
    assert(!recovery.inspect('fixture-lease').ok, 'Unknown prefix/schema fails closed');
    localStorage.removeItem('crowe.farm.pending-shipment.unknown-version'); localStorage.removeItem(foreignKey);
    const storageKey = Storage.prototype.key;
    try { Storage.prototype.key = () => { throw new DOMException('Fixture enumeration denied', 'SecurityError'); }; localStorage.setItem('fixture-unrelated', '1'); assert(!recovery.inspect('fixture-lease').ok, 'Storage enumeration failure cannot mean clean'); }
    finally { Storage.prototype.key = storageKey; localStorage.removeItem('fixture-unrelated'); }
    assert(recovery.release('fixture-lease').ok && !recovery.isLocked() && !recovery.inspect('fixture-lease').ok, 'Only owning host releases and stale inspection fails');
    passed.push('main-owned lease, first-intent lock, foreign/schema/enumeration barriers and independent in-memory blockers');

    await remount(emptyState); instance.open('audit');
    const leaseRestoreFile = new DataTransfer(); leaseRestoreFile.items.add(new File(['{}'], 'lease-restore.json', { type: 'application/json' }));
    q('[name="backupFile"]').files = leaseRestoreFile.files; field('restore', 'confirmation', 'RESTORE EMPTY FARM');
    let guardedRestore = false;
    handlers['backup.restore'] = async () => {
      assert(q('[data-form="restore"] fieldset').disabled, 'Restore already busy before host acquisition');
      assert(recovery.acquire('restore-owner').ok && recovery.inspect('restore-owner').ok, 'Host ordinary restore must not self-block on form.busy');
      guardedRestore = true; recovery.release('restore-owner'); return ok({ restored: true });
    };
    await submit('restore'); await wait(() => guardedRestore && !q('[data-form="restore"] fieldset').disabled);
    assert(q('[data-form="restore"] .fc-form-status').textContent.includes('Saved'), 'Guarded ordinary restore still reports success');
    passed.push('ordinary host-guarded restore acquires during its own busy form without deadlock');
    await remount();

    instance.open('lots'); field('lot', 'room', 'Unsaved room'); field('lot', 'notes', 'Keep these notes');
    const input = q('[data-form="lot"] [name="notes"]'); input.focus(); input.setSelectionRange(2, 5);
    await refresh(); assert(q('[data-form="lot"] [name="notes"]') === input && input.value === 'Keep these notes' && input.selectionStart === 2, 'Refresh preserves field node/value/caret');
    instance.deactivate(); assert(q('.farm-compliance').hidden, 'deactivate hides'); instance.open('lots'); assert(input.value === 'Keep these notes', 'open preserves form');
    handlers.snapshot = () => Promise.resolve(bad('INTERNAL', 'Fixture read failure')); await refresh(); assert(input.value === 'Keep these notes' && q('[data-list="lots"]').textContent.includes('H-0001'), 'Refresh failure preserves list and draft'); delete handlers.snapshot;
    passed.push('persistent form nodes and data through refresh failure, deactivate and reopen');

    await click('[data-correct-lot-id="lot-1"]');
    assert(q('[data-form="lot-correct"]').textContent.includes('fixture-source-hash') && q('[data-form="lot-correct"]').textContent.includes('Local owner'), 'Explicit source provenance');
    field('lot-correct', 'room', 'Corrected room'); field('lot-correct', 'reason', 'Owner correction');
    handlers['lot.correct'] = () => Promise.resolve(bad('CONFLICT', 'Version changed. Review current lot.'));
    await submit('lot-correct'); const correction = calls.find(c => c.action === 'lot.correct');
    assert(correction.payload.expectedVersion === 2 && correction.payload.reason === 'Owner correction', 'Captured lot version and reason');
    assert(!('sourceSnapshot' in correction.payload) && !('sourceReviewedBy' in correction.payload), 'Cannot rewrite source');
    await refresh(); assert(q('[data-form="lot-correct"] [name="room"]').value === 'Corrected room' && q('[data-form-error="lot-correct"]').textContent.includes('Version changed'), 'Conflict preserves edit');
    passed.push('lot.correct version, reason, immutable provenance and retained conflict editor');

    await click('[data-fc="load-legacy"]'); await click('[data-source-id="legacy-flush:source-1"]');
    assert(!q('[data-form="adopt"]').checkValidity(), 'Adoption needs explicit owner confirmation');
    field('adopt', 'ownerConfirmation', true); await submit('adopt');
    const adoption = calls.find(c => c.action === 'lot.adopt'); assert(adoption.payload.sourceId === lot.sourceId && !('sourceSnapshot' in adoption.payload) && !('ownerConfirmation' in adoption.payload), 'Adoption only owner reviewed facts and source ID');
    passed.push('explicit source review gate and narrow adoption payload');

    await remount(); instance.open('shipments');
    field('shipment', 'customerId', customer.id); field('shipment', 'shippedAt', '2026-09-23T10:30'); field('shipment', 'notes', 'Frozen notes');
    field('shipment', 'lot-1', lot.id); field('shipment', 'quantity-1', '2');
    await click('[data-fc="add-shipment-item"]'); field('shipment', 'lot-2', lot2.id); field('shipment', 'quantity-2', '1.125');
    let finishShipment;
    handlers['shipment.create'] = () => new Promise(resolve => { finishShipment = resolve; });
    const form = q('[data-form="shipment"]'); form.requestSubmit(); form.requestSubmit(); await tick();
    assert(calls.filter(c => c.action === 'shipment.create').length === 1 && q('[data-form="shipment"] fieldset').disabled, 'Dispatch atomically freezes request and disables repeated submit');
    const first = clone(calls.find(c => c.action === 'shipment.create').payload); equal(first.items.map(item => item.quantityLbs), ['2.000', '1.125'], 'Canonical exact amounts');
    assert(recovery.acquire('inflight-lease').ok && !recovery.inspect('inflight-lease').ok, 'Accepted in-flight shipment blocks transfer after lock');
    finishShipment(bad('INTERNAL', 'Unknown result')); await tick(); await tick();
    assert(!recovery.inspect('inflight-lease').ok && q('[data-fc="retry-shipment"]').disabled, 'Unresolved reply cannot bypass locked retry');
    recovery.release('inflight-lease');
    assert(q('[data-form="shipment"] fieldset').disabled && !q('[data-fc="retry-shipment"]').hidden && q('[data-fc="correct-shipment"]').hidden, 'Unknown result frozen');
    // Even a programmatic edit cannot alter the captured request.
    field('shipment', 'notes', 'Must not dispatch'); instance.open('lots'); await refresh(); instance.open('shipments');
    handlers['shipment.create'] = () => Promise.resolve(bad('INTERNAL', 'Still unknown')); await click('[data-fc="retry-shipment"]');
    equal(calls.filter(c => c.action === 'shipment.create')[1].payload, first, 'Exact unchanged retry');
    handlers['shipment.create'] = () => Promise.resolve(bad('VALIDATION', 'Rejected fixture quantity')); await click('[data-fc="retry-shipment"]');
    assert(!q('[data-fc="correct-shipment"]').hidden, 'Known rejection allows correction');
    const rejectedRaw = localStorage.getItem(recovery.shipmentStorageKey(populated.storage.operator.id));
    recovery.acquire('rejected-lease'); await click('[data-fc="correct-shipment"]');
    assert(localStorage.getItem(recovery.shipmentStorageKey(populated.storage.operator.id)) === rejectedRaw, 'Lease prohibits clearing rejected intent');
    recovery.release('rejected-lease'); await click('[data-fc="correct-shipment"]');
    assert(q('[data-form="shipment"] [name="notes"]').value === 'Frozen notes', 'Correction starts from the rejected payload rather than mutated locked fields');
    await refresh(); assert(!q('[data-form="shipment"] fieldset').disabled, 'Correct rejected request unlocks after current snapshot');
    handlers['shipment.create'] = () => Promise.resolve(ok(shipment)); handlers.snapshot = () => Promise.resolve(bad('INTERNAL', 'Refresh failed after commit'));
    await submit('shipment'); await tick(); assert(q('[data-form="shipment"] fieldset').disabled && q('[data-fc="retry-shipment"]').hidden, 'Confirmed shipment clears retry but blocks new shipment while snapshot is stale');
    assert(calls.filter(c => c.action === 'shipment.create').at(-1).payload.requestId !== first.requestId, 'Corrected definitive rejection uses new ID');
    passed.push('multi-lot exact quantities, double-submit gate, frozen unknown-outcome retries, validation unlock and confirmed-save refresh failure');

    await remount(); instance.open('shipments');
    field('shipment', 'customerId', customer.id); field('shipment', 'shippedAt', '2026-09-23T10:30');
    field('shipment', 'lot-1', lot.id); field('shipment', 'quantity-1', '1');
    let resolveLockedShipment;
    handlers['shipment.create'] = () => new Promise(resolve => { resolveLockedShipment = resolve; });
    await submit('shipment'); const lockedKey = recovery.shipmentStorageKey(populated.storage.operator.id), lockedRaw = localStorage.getItem(lockedKey);
    recovery.acquire('commit-lease'); resolveLockedShipment(ok(shipment)); await tick(); await tick();
    assert(localStorage.getItem(lockedKey) === lockedRaw && !recovery.inspect('commit-lease').ok, 'Definitive in-flight success cannot clear intent under transfer lock');
    recovery.release('commit-lease'); handlers['shipment.create'] = payload => { equal(payload, JSON.parse(lockedRaw).payload, 'After lease exact retry unchanged'); return Promise.resolve(ok(shipment)); };
    await click('[data-fc="retry-shipment"]'); await tick();
    assert(localStorage.getItem(lockedKey) === null, 'Only post-lease exact reconciliation clears intent');
    passed.push('lease during dispatch preserves definitive-result intent until unchanged post-lease retry');

    const pendingPrefix = 'crowe.farm.pending-shipment.';
    const pendingKey = operator => `${pendingPrefix}v1:${encodeURIComponent(operator)}`;
    const operatorId = populated.storage.operator.id;
    const storedIntent = payload => JSON.stringify({ schemaVersion: 1, operatorId, payload });
    const seedIntent = payload => localStorage.setItem(pendingKey(operatorId), storedIntent(payload));
    const pendingKeys = () => Object.keys(localStorage).filter(key => key.startsWith(pendingPrefix));
    const fillShipment = () => {
      instance.open('shipments'); field('shipment', 'customerId', customer.id); field('shipment', 'shippedAt', '2026-09-23T10:30');
      field('shipment', 'notes', 'Frozen restart notes');
      const row = q('[data-fc="shipment-items"] [data-item]'); row._item.lot.value = lot.id; row._item.amount.value = '2.125';
    };
    assert(pendingKeys().length === 0, 'Definitive success removed pending intent despite read failure');
    await remount(); fillShipment();
    const committed = new Map(); let allocationCount = 0, dispatched;
    const committedBridge = payload => {
      const persisted = JSON.parse(localStorage.getItem(pendingKey(operatorId)));
      equal(persisted.payload, payload, 'Exact intent is persisted before dispatch');
      assert(Object.isFrozen(payload) && Object.isFrozen(payload.items) && Object.isFrozen(payload.items[0]), 'Payload deeply frozen');
      dispatched = clone(payload);
      if (!committed.has(payload.requestId)) { committed.set(payload.requestId, clone(payload)); allocationCount++; }
      else equal(committed.get(payload.requestId), payload, 'Idempotent mock receives identical content');
      return Promise.resolve(bad('INTERNAL', 'Worker stopped after fixture commit; reply lost'));
    };
    handlers['shipment.create'] = committedBridge;
    await submit('shipment');
    const restartPayload = clone(dispatched), restartRaw = localStorage.getItem(pendingKey(operatorId));
    assert(allocationCount === 1 && restartRaw && q('[data-fc="shipment-recovery"]').textContent.includes('Unresolved shipment'), 'Commit with lost reply remains visibly unresolved');
    await remount(); instance.open('shipments');
    assert(q('[data-form="shipment"] fieldset').disabled && q('[data-form="shipment"] [name="notes"]').value === restartPayload.notes, 'Remount restores locked original fields');
    equal(JSON.parse(q('[data-fc="pending-shipment-payload"] pre').textContent), restartPayload, 'Restored exact frozen payload visible');
    assert(!calls.some(c => c.action === 'shipment.create'), 'Mount never retries automatically');
    field('shipment', 'notes', 'Programmatic corruption must not dispatch');
    q('[data-fc="shipment-items"] [data-item]')._item.amount.value = '999';
    await refresh(); handlers['shipment.create'] = committedBridge;
    await click('[data-fc="retry-shipment"]');
    equal(dispatched, restartPayload, 'Remount retry retains exact request ID, timestamp, notes and quantities');
    assert(allocationCount === 1 && localStorage.getItem(pendingKey(operatorId)) === restartRaw, 'No second allocation and no pending rewrite on unknown retry');
    handlers['shipment.create'] = payload => { equal(payload, restartPayload, 'Successful retry unchanged'); return Promise.resolve(ok(shipment)); };
    await click('[data-fc="retry-shipment"]'); await tick();
    assert(!pendingKeys().length && !q('[data-form="shipment"] fieldset').disabled, 'Success clears intent and refresh permits next shipment');
    passed.push('persist-before-dispatch, committed-but-lost response remount, deeply frozen same-ID retry and no duplicate mock allocation');

    seedIntent(restartPayload); instance.destroy(); let resolveMount;
    instance = window.FarmCompliance.mount(q('#host'), { request: () => new Promise(resolve => { resolveMount = resolve; }) }); window.testWorkspace = instance;
    assert(q('[data-form="shipment"] fieldset').disabled && q('[data-fc="retry-shipment"]').disabled && q('[data-fc="shipment-recovery"]').textContent.includes('Waiting for a desktop snapshot'), 'Pending recovery visible and locked before snapshot');
    resolveMount(bad('UNAVAILABLE', 'Failed worker startup')); await tick();
    assert(!q('[data-fc="shipment-recovery"]').hidden && q('[data-fc="shipment-recovery"]').textContent.includes(restartPayload.requestId), 'UNAVAILABLE keeps global recovery evidence visible');
    await remount({ ...clone(populated), storage: { ...clone(populated.storage), operator: { id: 'restored-other-operator', name: 'Restored owner' } } });
    assert(q('[data-fc="retry-shipment"]').disabled && q('[data-form="shipment"] fieldset').disabled && q('[data-fc="shipment-recovery"]').textContent.includes('different local operator'), 'Backup identity change cannot reuse foreign intent or create a new allocation');
    assert(localStorage.getItem(pendingKey(operatorId)) === restartRaw, 'Foreign operator record not discarded');
    await remount(emptyState); assert(q('[data-form="restore"] fieldset').disabled, 'Even empty farm cannot restore over unresolved intent');
    passed.push('pre-snapshot and unavailable recovery, operator namespace mismatch and pending restore interlock');

    for (const [label, raw] of [ ['invalid JSON', '{broken'], ['wrong schema', JSON.stringify({ schemaVersion: 2, operatorId, payload: restartPayload })],
      ['extra non-shipment field', JSON.stringify({ schemaVersion: 1, operatorId, payload: { ...restartPayload, unexpected: 'not allowed' } })],
      ['noncanonical quantity', storedIntent({ ...restartPayload, items: [{ lotId: lot.id, quantityLbs: '2.1250' }] })] ]) {
      localStorage.setItem(pendingKey(operatorId), raw); await remount();
      assert(q('[data-form="shipment"] fieldset').disabled && q('[data-fc="shipment-recovery"]').textContent.includes('blocked'), `${label} fails closed`);
      q('[data-form="shipment"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick();
      assert(!calls.some(c => c.action === 'shipment.create') && localStorage.getItem(pendingKey(operatorId)) === raw, `${label} never dispatched or silently deleted`);
    }
    localStorage.removeItem(pendingKey(operatorId));
    const setItem = Storage.prototype.setItem, getItem = Storage.prototype.getItem, removeItem = Storage.prototype.removeItem;
    try {
      await remount(); fillShipment();
      Storage.prototype.setItem = function (key, value) { if (key.startsWith(pendingPrefix)) throw new DOMException('Fixture quota exceeded', 'QuotaExceededError'); return setItem.call(this, key, value); };
      await submit('shipment');
      assert(!calls.some(c => c.action === 'shipment.create') && q('[data-form="shipment"] fieldset').disabled && q('[data-fc="retry-shipment"]').disabled, 'Unwritable intent blocks first dispatch and retry');
      assert(q('[data-form="shipment"] [name="notes"]').value === 'Frozen restart notes', 'Unwritable storage preserves visible payload');
      await refresh(); assert(q('[data-form="shipment"] fieldset').disabled, 'Refresh does not bypass write failure');
      assert(!pendingKeys().length && recovery.acquire('failed-storage-lease').ok && !recovery.inspect('failed-storage-lease').ok, 'Real mounted in-memory intent blocks transfer even when persistence failed');
      recovery.release('failed-storage-lease');
    } finally { Storage.prototype.setItem = setItem; }
    seedIntent(restartPayload);
    try {
      Storage.prototype.getItem = function (key) { if (key.startsWith(pendingPrefix)) throw new DOMException('Fixture storage denied', 'SecurityError'); return getItem.call(this, key); };
      await remount(); assert(q('[data-form="shipment"] fieldset').disabled && q('[data-fc="shipment-recovery"]').textContent.includes('unreadable'), 'Unreadable pending storage fails closed');
    } finally { Storage.prototype.getItem = getItem; }
    passed.push('corrupt, unsupported, noncanonical, unreadable and unwritable pending storage fail closed without dispatch or discard');

    await remount(); instance.open('shipments');
    handlers['shipment.create'] = () => Promise.resolve({ error: { code: 'VALIDATION', message: 'Malformed envelope is not a definitive rejection' } });
    await click('[data-fc="retry-shipment"]');
    assert(q('[data-fc="correct-shipment"]').hidden && q('[data-form-error="shipment"]').textContent.includes('INVALID_RESPONSE'), 'Only explicit false envelope is a trusted rejection');
    handlers['shipment.create'] = () => Promise.resolve(ok(null)); await click('[data-fc="retry-shipment"]');
    assert(pendingKeys().length === 1 && q('[data-fc="correct-shipment"]').hidden, 'Malformed success never clears the pending request');
    handlers['shipment.create'] = () => Promise.resolve(bad('CONFLICT', 'Key already used with different content'));
    await click('[data-fc="retry-shipment"]'); assert(q('[data-fc="correct-shipment"]').hidden && pendingKeys().length === 1, 'Conflict does not release potentially committed key');
    handlers['shipment.create'] = () => Promise.resolve(bad('BACKUP_CAPACITY', 'Guaranteed rolled back: backup capacity exceeded'));
    await click('[data-fc="retry-shipment"]'); assert(!q('[data-fc="correct-shipment"]').hidden, 'Backup capacity is explicit correctable rejection');
    await remount(); instance.open('shipments');
    assert(q('[data-fc="correct-shipment"]').hidden, 'Rejection not persisted as authority; restart requires exact retry');
    handlers['shipment.create'] = () => Promise.resolve(bad('VALIDATION', 'Explicit rejection'));
    await click('[data-fc="retry-shipment"]');
    try {
      Storage.prototype.removeItem = function (key) { if (key.startsWith(pendingPrefix)) throw new DOMException('Fixture removal denied', 'SecurityError'); return removeItem.call(this, key); };
      await click('[data-fc="correct-shipment"]');
      assert(q('[data-form="shipment"] fieldset').disabled && localStorage.getItem(pendingKey(operatorId)) === restartRaw, 'Rejected request cannot unlock when clear fails');
    } finally { Storage.prototype.removeItem = removeItem; }
    await remount(); instance.open('shipments'); handlers['shipment.create'] = () => Promise.resolve(ok(shipment));
    try {
      Storage.prototype.removeItem = function (key) { if (key.startsWith(pendingPrefix)) return; return removeItem.call(this, key); };
      await click('[data-fc="retry-shipment"]'); await tick();
      assert(q('[data-form="shipment"] fieldset').disabled && q('[data-fc="retry-shipment"]').disabled && localStorage.getItem(pendingKey(operatorId)) === restartRaw, 'Silent clear failure after success blocks any new allocation');
    } finally { Storage.prototype.removeItem = removeItem; }
    await remount(); instance.open('shipments'); handlers['shipment.create'] = () => Promise.resolve(ok(shipment)); await click('[data-fc="retry-shipment"]');
    assert(!pendingKeys().length, 'Successful reconciliation after clear failure uses original key and clears it');
    passed.push('CONFLICT stays unresolved, BACKUP_CAPACITY correction, rejection restart, and throwing/silent clear failures remain locked');

    seedIntent(restartPayload); await remount(); instance.open('shipments');
    localStorage.setItem(pendingKey(operatorId), storedIntent({ ...restartPayload, notes: 'Changed on disk' }));
    await click('[data-fc="retry-shipment"]');
    assert(!calls.some(c => c.action === 'shipment.create') && q('[data-fc="retry-shipment"]').disabled, 'Changed stored payload is never overwritten or retried from stale memory');
    localStorage.removeItem(pendingKey(operatorId));
    await remount(); fillShipment(); let lateShipment;
    handlers['shipment.create'] = () => new Promise(resolve => { lateShipment = resolve; }); await submit('shipment');
    const lateRaw = localStorage.getItem(pendingKey(operatorId)); instance.destroy(); lateShipment(ok(shipment)); await tick();
    assert(localStorage.getItem(pendingKey(operatorId)) === lateRaw, 'Destroyed mount never clears intent while another mount may own it');
    await remount(); instance.open('shipments'); handlers['shipment.create'] = () => Promise.resolve(ok(shipment)); await click('[data-fc="retry-shipment"]');
    assert(!pendingKeys().length, 'In-flight unmount reconciles using stored request');
    passed.push('storage mutation detection and destroyed-in-flight completion retain restart-safe intent');

    await remount(emptyState); instance.open('audit');
    const identityFile = new DataTransfer(); identityFile.items.add(new File(['{}'], 'identity.json', { type: 'application/json' }));
    q('[name="backupFile"]').files = identityFile.files; field('restore', 'confirmation', 'RESTORE EMPTY FARM');
    handlers['backup.restore'] = () => {
      snapshot = clone(populated); snapshot.storage.operator = { id: 'restored-operator-2', name: 'Restored owner' };
      return Promise.resolve(ok({ restored: true }));
    };
    handlers.snapshot = () => Promise.resolve(bad('INTERNAL', 'Snapshot lost after restore'));
    await submit('restore'); await tick();
    assert(q('[data-form="shipment"] fieldset').disabled, 'Unconfirmed identity after restore cannot use old namespace');
    delete handlers.snapshot; await refresh(); fillShipment();
    handlers['shipment.create'] = payload => {
      assert(localStorage.getItem(pendingKey('restored-operator-2')) && !localStorage.getItem(pendingKey(operatorId)), 'Shipment uses refreshed restored operator namespace');
      return Promise.resolve(ok(shipment));
    };
    await submit('shipment'); assert(!pendingKeys().length, 'Restored operator shipment resolved cleanly');
    passed.push('backup restore invalidates old operator until fresh snapshot and new intents use restored namespace');

    await remount(); instance.open('logs'); field('log', 'room', 'Persistent log');
    await click('[data-resolve-id="log-1"]'); field('log-edit', 'reason', 'Reviewed completed correction'); await submit('log-edit');
    const resolution = calls.find(c => c.action === 'log.resolve'); assert(resolution.payload.expectedVersion === 4 && resolution.payload.correctiveAction === 'Adjust ventilation', 'Explicit resolution and captured version');
    field('log', 'deviationNotes', 'New deviation'); q('[data-fc="log-filter"]').value = 'OPEN'; await refresh();
    assert(q('[data-fc="log-filter"]').value === 'OPEN' && q('[data-form="log"] [name="room"]').value === 'Persistent log', 'Filter and other log form stay');
    passed.push('daily-log explicit resolution, expectedVersion, persistent filters');

    instance.open('documents');
    equal(qa('[data-form="document"] [name="type"] option').map(el => el.value), ['FOOD_SAFETY_PLAN', 'SANITATION_SOP', 'HARVEST_PACKING_SOP', 'RECALL_PLAN', 'LOT_CODING_SOP'], 'Final document enum');
    assert(q('[data-form="document"] [name="content"]').maxLength === 100000, 'Document content bound');
    await click('[data-revision-id="rev-1"]'); assert(!q('[data-fc="document-editor"] img') && !window.injected, 'Content does not execute');
    handlers['document.submit'] = payload => { assert(payload.expectedVersion === 3, 'Revision uses editVersion'); snapshot.documents[0].revisions[0].status = 'NEEDS_REVIEW'; snapshot.documents[0].revisions[0].editVersion++; return Promise.resolve(ok(doc)); };
    field('revision', 'content', 'Changed unsaved text'); await click('[data-fc="submit-review"]'); assert(!calls.some(c => c.action === 'document.submit'), 'Cannot submit unsaved revision');
    field('revision', 'content', revision.content); await click('[data-fc="submit-review"]'); await tick();
    await click('[data-fc="approve-revision"]'); assert(!calls.some(c => c.action === 'document.approve'), 'Approval needs attestation');
    handlers['document.approve'] = payload => { assert(payload.expectedVersion === 4 && payload.attestation === true, 'Approval exact revision version and attestation'); Object.assign(snapshot.documents[0].revisions[0], { status: 'APPROVED', editVersion: 5, approvedBy: { name: 'Local owner' }, approvedAt: timestamp, contentHash: 'fixture-document-hash' }); return Promise.resolve(ok(doc)); };
    field('revision', 'attestation', true); await click('[data-fc="approve-revision"]'); await tick();
    assert(!q('[data-form="revision"] [name="content"]') && q('.fc-document-content').textContent === revision.content && !q('.fc-document-content img'), 'Approved content immutable plain text');
    handlers['document.revise'] = payload => { assert(payload.reason === 'Updated procedure', 'Successor reason'); snapshot.documents[0].revisions.push({ ...clone(revision), id: 'rev-2', version: 2, editVersion: 1 }); return Promise.resolve(ok(doc)); };
    field('revision', 'reason', 'Updated procedure'); await submit('revision'); await tick();
    assert(q('[data-form="revision"] h2').textContent.includes('revision 2') && snapshot.documents[0].revisions[0].status === 'APPROVED', 'Successor does not alter previous approval');
    passed.push('final document enums, bounded plain text, exact editVersion, explicit attestation and immutable successor workflow');
    // A confirmed revision edit followed by a failed read cannot resurrect a
    // stale action/version or mislabel that committed edit as an unknown write.
    handlers['document.edit'] = payload => { assert(payload.expectedVersion === 1 && payload.reason === 'Clarify procedure', 'Draft edit uses exact version and reason'); Object.assign(snapshot.documents[0].revisions[1], { title: payload.title, content: payload.content, editVersion: 2 }); return Promise.resolve(ok(doc)); };
    handlers.snapshot = () => Promise.resolve(bad('INTERNAL', 'Read after saved revision failed'));
    field('revision', 'content', 'Revised exact text'); field('revision', 'reason', 'Clarify procedure'); await submit('revision'); await tick();
    assert(q('[data-form="revision"] fieldset').disabled && q('[data-fc="reload-revision"]'), 'Saved revision locks stale controls after refresh failure');
    delete handlers.snapshot; await click('[data-fc="reload-revision"]'); await tick();
    assert(!q('[data-form="revision"] fieldset').disabled && q('[data-form="revision"] [name="content"]').value === 'Revised exact text', 'Explicit reload gets committed content');
    handlers['document.submit'] = payload => { assert(payload.expectedVersion === 2, 'Reloaded edit version'); snapshot.documents[0].revisions[1].status = 'NEEDS_REVIEW'; snapshot.documents[0].revisions[1].editVersion = 3; return Promise.resolve(ok(doc)); };
    await click('[data-fc="submit-review"]'); await tick();
    handlers['document.approve'] = payload => { assert(payload.attestation && payload.expectedVersion === 3, 'Successor approval bound'); Object.assign(snapshot.documents[0].revisions[0], { status: 'SUPERSEDED', supersededByRevisionId: 'rev-2' }); Object.assign(snapshot.documents[0].revisions[1], { status: 'APPROVED', supersedesRevisionId: 'rev-1', approvedBy: { name: 'Local owner' }, approvedAt: timestamp }); return Promise.resolve(ok(doc)); };
    field('revision', 'attestation', true); await click('[data-fc="approve-revision"]'); await tick();
    assert(q('[data-form="revision"]').textContent.includes('rev-1') && !q('[data-form="revision"] [name="content"]'), 'Approved successor shows supersession linkage');
    passed.push('revision edit, post-commit read failure recovery and linked successor approval');

    instance.open('recall'); field('recall', 'lotId', lot.id); await submit('recall');
    const report = q('[data-fc="recall-result"]').textContent;
    for (const expected of ['fixture-source-hash', 'Local owner', lot.sourceId, 'Correct room', 'Room A', 'Harvest corrected since shipment', 'Local source scope:', 'Generated 20']) assert(report.includes(expected), 'Recall includes ' + expected);
    window.print = () => { assert(q('.farm-compliance.fc-printing') && qa('[data-fc="recall-result"] details').every(el => el.open), 'Print opens evidence only for recall'); };
    await click('[data-fc="print-recall"]'); assert(!q('.fc-printing'), 'Print mode cleans up');
    handlers.recall = () => Promise.resolve(bad('INTERNAL', 'Recall read failed')); await submit('recall'); assert(q('[data-fc="recall-result"]').textContent === report && q('[data-fc="print-recall"]').disabled, 'Failed recall retains last result but cannot print stale report'); delete handlers.recall;
    field('recall', 'lotId', lot2.id); await submit('recall'); assert(q('[data-fc="recall-result"]').textContent.includes('No shipments recorded for this lot'), 'Explicit unshipped result');
    let oldRecall; handlers.recall = () => new Promise(resolve => { oldRecall = resolve; }); await submit('recall'); field('recall', 'lotId', lot.id); oldRecall(ok({ lot: lot2, affectedShipments: [], totalShippedLbs: '0.000', remainingLbs: '48.000' })); await tick();
    assert(q('[data-fc="print-recall"]').disabled && !q('[data-fc="recall-result"]').textContent.includes('Recall record: H-0002'), 'Stale recall generation ignored'); delete handlers.recall;
    passed.push('recall provenance, corrections, shipment snapshot, local scope, timestamp, print gate, empty and stale/error states');

    instance.open('audit'); await submit('audit'); assert(q('[data-list="audit"]').textContent.includes('Correct room'), 'Audit before after reason');
    assert(q('[data-form="restore"] fieldset').disabled, 'Populated restore locked');
    let downloaded, clickedDownload = false;
    const originalURL = URL.createObjectURL, originalClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = blob => { downloaded = blob; return 'blob:fixture'; };
    HTMLAnchorElement.prototype.click = function () { clickedDownload = this.download.endsWith('.json'); };
    await submit('export'); assert(downloaded instanceof Blob && clickedDownload && (await downloaded.text()).includes('crowe-farm-backup'), 'JSON Blob download');
    URL.createObjectURL = originalURL; HTMLAnchorElement.prototype.click = originalClick;
    await remount(emptyState); instance.open('audit');
    const fileInput = q('[name="backupFile"]');
    const setFile = (content, name = 'backup.json') => { const dt = new DataTransfer(); dt.items.add(new File([content], name, { type: 'application/json' })); fileInput.files = dt.files; };
    setFile('{}'); field('restore', 'confirmation', 'wrong'); await submit('restore'); assert(!calls.some(c => c.action === 'backup.restore'), 'Exact restore confirmation required');
    field('restore', 'confirmation', 'RESTORE EMPTY FARM'); setFile(new Uint8Array(10 * 1024 * 1024 + 1));
    let readFile = false; const originalText = File.prototype.text; File.prototype.text = function () { readFile = true; return originalText.call(this); };
    await submit('restore'); assert(!readFile && !calls.some(c => c.action === 'backup.restore'), '10 MiB enforced before file read'); File.prototype.text = originalText;
    setFile('{invalid'); await submit('restore'); await wait(() => q('[data-form-error="restore"]').textContent.includes('not valid JSON')); assert(!q('[data-form="restore"] fieldset').disabled, 'Parse failure unlocks while preserving input');
    setFile('{"format":"crowe-farm-backup"}'); await submit('restore'); await wait(() => calls.some(c => c.action === 'backup.restore' && c.payload.confirmation === 'RESTORE EMPTY FARM'));
    passed.push('audit evidence, Blob download, populated restore lock, exact confirmation and 10 MiB pre-read gate');

    await remount(); let staleSnapshot; handlers.snapshot = () => new Promise(resolve => { staleSnapshot = resolve; });
    q('[data-fc="refresh"]').click(); await tick(); const stale = clone(emptyState);
    instance.open('facility'); field('facility', 'name', 'New facility');
    delete handlers.snapshot; await submit('facility'); staleSnapshot(ok(stale)); await tick();
    assert(q('[data-count="lotsCreated"]').textContent === '2', 'Old read cannot overwrite post-mutation snapshot');
    let late; handlers.snapshot = () => new Promise(resolve => { late = resolve; }); q('[data-fc="refresh"]').click(); await tick(); instance.destroy(); late(ok(populated)); await tick(); assert(!q('.farm-compliance'), 'Destroyed view ignores async completion');
    passed.push('snapshot epoch guard and destroyed async completion safety');

    await remount(emptyState, { request: () => Promise.resolve(bad('UNAVAILABLE', 'Desktop local only')) });
    assert(!q('[data-fc="unavailable"]').hidden && q('.fc-body').hidden && !q('[data-list="lots"]').textContent.includes('H-0001'), 'UNAVAILABLE no fake records');
    passed.push('UNAVAILABLE explanatory runtime without successful writes or sample data');

    await remount(); instance.open('recall'); field('recall', 'lotId', lot.id); await submit('recall'); instance.open('documents'); await click('[data-revision-id="rev-1"]');
    assert(!window.require && !window.process, 'Sandboxed renderer without Node');
    const transferCalls = []; let transferReply;
    window.crowe = { transfer: { request: async (action, payload) => { transferCalls.push({ action, payload }); return transferReply; } } };
    const transferHost = document.createElement('div'); q('#host').append(transferHost);
    let importRefresh = 0;
    const transfer = window.MycologyTransfer.mount(transferHost, { edition: () => ({ id: 'mycology' }), onNotebookImported() { importRefresh++; throw new Error('Display refresh failed after commit'); } });
    transfer.open();
    transferReply = ok({ token: 'preview-1', summary: { archiveId: 'fixture-archive', counts: { blocks: 1 } } });
    await click('[data-transfer="notebook-preview"]');
    assert(q('[data-transfer="notebook-summary"]').textContent.includes('fixture-archive'), 'Validated host preview visible');
    const confirmNotebook = q('[data-transfer="notebook-confirmation"]'); confirmNotebook.value = 'wrong'; confirmNotebook.dispatchEvent(new Event('input'));
    assert(q('[data-transfer="notebook-import"]').disabled, 'Exact notebook confirmation required');
    confirmNotebook.value = 'IMPORT EMPTY NOTEBOOK'; confirmNotebook.dispatchEvent(new Event('input'));
    window.dispatchEvent(new CustomEvent('crowe:farm-restore-result', { detail: ok({ restored: true }) }));
    transferReply = bad('STORE_NOT_EMPTY', 'Fixture notebook contains records'); await click('[data-transfer="notebook-import"]');
    assert(q('[data-transfer-status="farm"]').dataset.phase === 'committed' && q('[data-transfer-status="notebook"]').dataset.phase === 'failed', 'Notebook failure retains separately committed farm');
    transferReply = ok({ status: 'committed', verified: true, archiveId: 'fixture-archive' }); await click('[data-transfer="notebook-import"]');
    assert(q('[data-transfer-status="notebook"]').dataset.phase === 'committed' && importRefresh === 1, 'Host-verified import remains committed even when display refresh fails');
    equal(transferCalls.at(-1).payload, { token: 'preview-1', confirmation: 'IMPORT EMPTY NOTEBOOK' }, 'Import sends token/confirmation only, never paths or caller clearance');
    window.dispatchEvent(new CustomEvent('crowe:farm-restore-result', { detail: bad('CONNECTION_ERROR', 'Reply lost') }));
    assert(q('[data-transfer-status="farm"]').dataset.phase === 'recovery-required' && q('[data-transfer-status="notebook"]').dataset.phase === 'committed', 'Lost farm response keeps verified notebook and demands recovery');
    transfer.destroy(); transferHost.remove(); delete window.crowe;
    passed.push('transfer preview, exact confirmation, independent component outcomes and post-commit refresh safety');
    return { passed };
  } catch (error) { return { passed, error: error.stack || String(error) }; }
}
