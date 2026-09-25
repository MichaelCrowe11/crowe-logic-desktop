#!/usr/bin/env node
'use strict';
// Synthetic, offline only. No Electron main, home profiles or credentials loaded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const V = require('../vision/validation');
const { createVisionHost, TTL } = require('../vision/host');
const { createNotebook, guardOrdinary } = require('../vision/notebook');
const { dimensions, normalizeSelected, createDecoder, LIMITS } = require('../vision/image');
const transfer = require('../grow-transfer');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-vision-unit-')));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const route = { alias: 'crowelm-vision', engine: 'synthetic-offline-engine', provider: 'fixture-provider', recipient: 'fixture-only, no network', revision: 'fixture-contract-1', metered: true, noFallback: true, toolFree: true, boundedResponse: true };
const response = () => ({ content: { findings: [{ observation: '<script>do not execute</script> Synthetic surface detail.', uncertainty: 'Synthetic fixture cannot diagnose anything.' }] }, toolCalls: [], provenance: { alias: route.alias, engine: route.engine, provider: route.provider, recipient: route.recipient, revision: route.revision, requestId: 'fixture-request-1' } });
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
function setup(name, options = {}) {
  const dir = path.join(root, name); fs.mkdirSync(path.join(dir, 'grow'), { recursive: true });
  const target = { type: 'blocks', id: 'block-1' }, row = { id: 'block-1', species: 'Synthetic oyster', stage: 'fruiting', code: 'fixture-lot', notes: 'PRIVATE_NOT_SENT', custom: { retain: true } };
  fs.writeFileSync(path.join(dir, 'grow', 'blocks.json'), JSON.stringify([row]));
  fs.writeFileSync(path.join(dir, 'grow', 'log.json'), JSON.stringify([{ id: 'old-log', entry: 'original', extension: { exact: [1, null, 'x'] } }]));
  const image = path.join(dir, 'synthetic.png'); fs.writeFileSync(image, png);
  const sender = new EventEmitter(), event = { sender, senderFrame: {} };
  let calls = 0, picks = 0, busy = false, now = Date.now();
  const assertAdmission = () => { if (busy) throw V.fault('TRANSFER_BUSY', 'Transfer busy.'); };
  const store = options.notebook || createNotebook({ getUserData: () => dir, assertAdmission, onStep: options.onStep });
  const host = createVisionHost({ getUserData: () => dir, isTrustedSender: e => e === event, canAccess: () => options.edition !== 'desktop', assertAdmission,
    getWindow: () => null, dialog: { showOpenDialog: async () => { picks++; return options.selection ? options.selection() : { canceled: false, filePaths: [image] }; } },
    decode: options.decode || (async () => png), gateway: async input => { calls++; assert.equal(input.model, 'crowelm-vision'); assert.deepEqual(input.tools, []); assert.equal(input.fallback, false); assert.equal(input.toolChoice, 'none'); assert.equal(input.maxResponseBytes, 32768); check(!JSON.stringify(input).includes('PRIVATE_NOT_SENT'), 'Private notes excluded from transport'); return options.gateway ? options.gateway(input) : response(); },
    verifiedRoute: options.unavailable ? null : route, clock: () => now, notebook: store });
  return { dir, target, row, image, sender, event, host, store, get calls() { return calls; }, get picks() { return picks; }, busy(v) { busy = v; }, expire() { now += TTL + 1; },
    ask: (action, payload = {}) => host.request(event, action, payload),
    async prepare() { const r = await host.request(event, 'prepare', { target }); assert.ok(r.ok, JSON.stringify(r)); return r.data; },
    async analyze(p) { return host.request(event, 'analyze', { ref: p.ref, disclosureDigest: p.disclosureDigest, noticeVersion: p.disclosure.noticeVersion, consent: true }); } };
}
(async () => {
  try {
    const blocked = setup('blocked', { unavailable: true });
    check(!(await blocked.ask('status')).data.available, 'Production-style route unavailable');
    check((await blocked.ask('prepare', { target: blocked.target })).error.code === 'UNAVAILABLE' && blocked.picks === 0 && blocked.calls === 0, 'Unverified route refuses before native picker or network');
    const denied = setup('denied', { edition: 'desktop' });
    check((await denied.ask('prepare', { target: denied.target })).error.code === 'UNAVAILABLE', 'Other edition refused');
    const s = setup('happy');
    check((await s.host.request({ sender: new EventEmitter(), senderFrame: {} }, 'status')).error.code === 'UNAVAILABLE', 'Untrusted direct IPC denied');
    let p = await s.prepare();
    check(s.calls === 0 && p.preview === `data:image/png;base64,${png.toString('base64')}`, 'Exact normalized preview before network');
    check(p.disclosure.imageDigest === V.hash(png) && p.disclosureDigest === V.hash(p.disclosure), 'Consent binds exact image and context disclosure');
    check((await s.ask('analyze', { ref: p.ref, disclosureDigest: 'wrong', noticeVersion: p.disclosure.noticeVersion, consent: true })).error.code === 'CONSENT_REQUIRED' && s.calls === 0, 'Wrong digest rejected without network');
    check((await s.ask('prepare', { target: s.target, path: s.image })).error.code === 'VALIDATION', 'Renderer paths refused');
    const findings = await s.analyze(p); check(findings.ok && findings.data.findings[0].observation.startsWith('<script>'), 'Inert strings retained rather than interpreted');
    check(!fs.existsSync(path.join(s.dir, 'farm-compliance')), 'Inspection initializes no farm store');
    const input = { ref: p.ref, findingIds: ['finding-1'], reviewer: 'Fixture reviewer', reviewerNote: 'Human amendment, separate from model.' };
    const review = await s.ask('review', input); check(review.ok, 'Explicit review creates save ticket');
    const again = await s.ask('review', input); assert.deepEqual(again.data.receipt, review.data.receipt); checks++;
    check((await s.ask('save', { ref: p.ref, receipt: review.data.receipt, confirm: false })).error.code === 'CONSENT_REQUIRED', 'Save requires separate confirmation');
    const saved = await s.ask('save', { ref: p.ref, receipt: review.data.receipt, confirm: true }); check(saved.ok, 'Notebook-only atomic save');
    const savedAgain = await s.ask('save', { ref: p.ref, receipt: review.data.receipt, confirm: true }); check(savedAgain.ok && savedAgain.data.id === saved.data.id, 'Identical retry returns original ID');
    let rows = JSON.parse(fs.readFileSync(path.join(s.dir, 'grow', 'log.json')));
    check(rows.length === 2 && rows[0].extension.exact[2] === 'x', 'Existing rows and extensions preserved');
    check(rows[1].vision.reviewer.note === input.reviewerNote && rows[1].vision.findings[0].observation === findings.data.findings[0].observation, 'Reviewer and original findings distinct');
    check(!JSON.stringify(rows).includes('data:image') && !JSON.stringify(rows).includes(png.toString('base64')) && rows[1].vision.imageRetained === false, 'No image persisted');
    const reopened = createNotebook({ getUserData: () => s.dir });
    check(reopened.reconcile(review.data.receipt).id === saved.data.id, 'Restart reconciles persisted key/digest with no remote call');
    assert.throws(() => reopened.reconcile({ key: review.data.receipt.key, digest: 'a'.repeat(64) }), { code: 'IDEMPOTENCY_CONFLICT' }); checks++;
    assert.throws(() => guardOrdinary(rows, { id: saved.data.id, entry: 'overwrite' }), { code: 'VISION_PROTECTED' }); checks++;
    assert.throws(() => guardOrdinary(rows, { entry: 'forge', vision: {} }), { code: 'VISION_PROTECTED' }); checks++;
    guardOrdinary(rows, { id: 'old-log', entry: 'ordinary edit' }); checks++;
    const archive = await transfer.createArchive({ userData: s.dir, source: { edition: 'mycology', version: 'fixture' } });
    check(transfer.inspectArchive(archive).files.length === 7, 'Saved evidence remains seven-slot transfer compatible');
    const destination = path.join(root, 'import'); fs.mkdirSync(destination);
    await transfer.importArchive({ userData: destination, archive });
    check(createNotebook({ getUserData: () => destination }).reconcile(review.data.receipt).id === saved.data.id, 'Export/import retains exact idempotency/provenance');
    s.host.invalidate();
    for (const [name, gateway, code] of [
      ['tools', () => ({ ...response(), toolCalls: [{ name: 'bad' }] }), 'TOOLS_REFUSED'],
      ['provenance', () => ({ ...response(), provenance: { ...response().provenance, provider: 'guessed' } }), 'PROVENANCE_UNVERIFIED'],
      ['large', () => ({ ...response(), content: { findings: [{ observation: 'a'.repeat(40000), uncertainty: '?' }] } }), 'RESPONSE_LIMIT'],
      ['quota', () => { throw V.fault('QUOTA_EXCEEDED', 'Quota exceeded.'); }, 'QUOTA_EXCEEDED'],
    ]) { const x = setup(name, { gateway }); const pp = await x.prepare(); const r = await x.analyze(pp); check(r.error.code === code && x.calls === 1, `${name} fails closed without retry`); x.host.invalidate(); }
    for (const mode of ['navigation', 'cancel', 'transfer', 'target', 'expiry']) {
      const x = setup(mode), pp = await x.prepare();
      if (mode === 'navigation') x.sender.emit('did-start-navigation', {}, 'file://next', false, true);
      if (mode === 'cancel') await x.ask('cancel');
      if (mode === 'transfer') x.host.invalidate();
      if (mode === 'target') fs.writeFileSync(path.join(x.dir, 'grow', 'blocks.json'), JSON.stringify([{ ...x.row, stage: 'spent' }]));
      if (mode === 'expiry') x.expire();
      check(!(await x.analyze(pp)).ok && x.calls === 0, `${mode} invalidates prepared reference`); x.host.invalidate();
    }
    let finish; const delayed = setup('delayed', { gateway: () => new Promise(resolve => { finish = resolve; }) });
    const dp = await delayed.prepare(), run = delayed.analyze(dp); await new Promise(resolve => setImmediate(resolve)); await delayed.ask('cancel'); finish(response());
    check(!(await run).ok && delayed.host.pendingCount === 0, 'Delayed response cannot revive cancellation');
    const busy = setup('busy'); const bp = await busy.prepare(); busy.busy(true); check((await busy.analyze(bp)).error.code === 'TRANSFER_BUSY' && busy.calls === 0, 'Transfer admission excludes Vision dispatch'); busy.host.invalidate();
    const corrupt = setup('corrupt'), cp = await corrupt.prepare(); await corrupt.analyze(cp); const cr = await corrupt.ask('review', { ...input, ref: cp.ref });
    const bad = '[{"id":"a","id":"b"}]'; fs.writeFileSync(path.join(corrupt.dir, 'grow', 'log.json'), bad);
    check(!(await corrupt.ask('save', { ref: cp.ref, receipt: cr.data.receipt, confirm: true })).ok && fs.readFileSync(path.join(corrupt.dir, 'grow', 'log.json'), 'utf8') === bad, 'Duplicate-key corrupt log preserved on refusal'); corrupt.host.invalidate();
    for (const step of ['before-file-sync', 'after-rename']) {
      let injected = false; const x = setup(step, { onStep: at => { if (at === step && !injected) { injected = true; throw new Error('injected I/O failure'); } } });
      const xp = await x.prepare(); await x.analyze(xp); const ticket = await x.ask('review', { ...input, ref: xp.ref });
      const r = await x.ask('save', { ref: xp.ref, receipt: ticket.data.receipt, confirm: true }); check(!r.ok, `${step} reports failure`);
      const rec = createNotebook({ getUserData: () => x.dir }).reconcile(ticket.data.receipt);
      check(rec.status === (step === 'after-rename' ? 'saved' : 'not-found'), `${step} restart reconciles correct outcome`);
      if (step === 'after-rename') {
        check(!(await x.ask('review', { ...input, ref: xp.ref, reviewerNote: 'changed' })).ok, 'Uncertain commit cannot mint a second save ticket');
        check((await x.ask('reconcile', { receipt: ticket.data.receipt })).data.status === 'saved', 'Host reconciles uncertain commit');
        check(!(await x.ask('review', { ...input, ref: xp.ref, reviewerNote: 'changed' })).ok && JSON.parse(fs.readFileSync(path.join(x.dir, 'grow', 'log.json'))).length === 2, 'Reconciled inspection remains terminal with one observation');
      }
      x.host.invalidate();
    }
    check(dimensions(png).width === 1, 'PNG header validated');
    assert.throws(() => dimensions(Buffer.from('<svg>' + 'x'.repeat(100))), { code: 'IMAGE_FORMAT' }); checks++;
    const bomb = Buffer.from(png); bomb.writeUInt32BE(100000, 16); assert.throws(() => dimensions(bomb), { code: 'IMAGE_DIMENSIONS' }); checks++;
    const symlink = path.join(root, 'alias.png'); fs.symlinkSync(s.image, symlink);
    await assert.rejects(normalizeSelected(symlink, async () => png), { code: 'UNSAFE_FILE' }); checks++;
    const oversized = path.join(root, 'large.png'); fs.writeFileSync(oversized, Buffer.alloc(LIMITS.sourceBytes + 1));
    await assert.rejects(normalizeSelected(oversized, async () => png), { code: 'UNSAFE_FILE' }); checks++;
    await assert.rejects(normalizeSelected(s.image, async () => Buffer.alloc(LIMITS.outputBytes + 1)), { code: 'IMAGE_LIMIT' }); checks++;
    let destroyed = 0;
    const fakeSession = { fromPartition(_name, opts) { assert.equal(opts.cache, false); return { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} }, on() {} }; } };
    class HangingWindow {
      constructor(opts) { check(opts.webPreferences.sandbox && !opts.webPreferences.nodeIntegration && opts.webPreferences.contextIsolation, 'Decoder window has no Node and remains sandboxed'); this.webContents = { setWindowOpenHandler() {}, on() {} }; }
      loadURL() { return new Promise(() => {}); }
      isDestroyed() { return false; }
      destroy() { destroyed++; }
    }
    const decoder = createDecoder({ BrowserWindow: HangingWindow, session: fakeSession });
    const realTimer = global.setTimeout;
    try {
      global.setTimeout = (fn, ms, ...args) => realTimer(fn, ms === LIMITS.decodeMs ? 5 : ms, ...args);
      await assert.rejects(decoder(png, dimensions(png)), { code: 'DECODE_TIMEOUT' });
      check(destroyed === 1, 'Decoder deadline destroys its isolated process window');
    } finally { global.setTimeout = realTimer; }
    const controller = new AbortController(), cancelledDecode = decoder(png, dimensions(png), controller.signal); controller.abort();
    await assert.rejects(cancelledDecode, { code: 'CANCELLED' }); check(destroyed === 2, 'Decoder cancellation destroys its isolated process window');
    console.log(`Vision offline tests: ${checks} checks passed. Synthetic adapter only; production routing remains unverified.`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
