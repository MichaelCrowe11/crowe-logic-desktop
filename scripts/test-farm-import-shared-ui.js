'use strict';
// Synthetic DOM lifecycle tests only; not proof of actual Electron rendering.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
let document;
class Element {
  constructor(tag) { this.tagName = tag; this.ownerDocument = document; this.children = []; this.dataset = {}; this.listeners = {}; this.disabled = false; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  click() { if (!this.disabled) this.listeners.click?.(); }
  remove() { this.removed = true; }
  set innerHTML(_value) { throw Error('Untrusted HTML must not be rendered'); }
}
document = { createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text, children: [] }) };
const descendants = node => [node, ...node.children.flatMap(descendants)];
const find = (root, key) => descendants(root).find(n => n.dataset?.imports === key);
const texts = root => descendants(root).map(n => n.textContent || '').join('\n');
const settle = async () => { for (let n = 0; n < 8; n++) await new Promise(r => setImmediate(r)); };
const window = {}; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/farm-imports.js'), 'utf8'), { window });
function fixture(options = {}) {
  const calls = [], container = new Element('main'); let preparedResolve;
  const source = { id: 'source1', ref: 'ref1', name: '<script>bad()</script>.csv', byteLength: options.bytes ?? 23, sourceDigest: 'a'.repeat(64), parseStatus: 'parsed', elementCount: 0, revision: 0, state: 'parsed_source', pageCount: null, candidates: [], elements: [], nextOffset: null };
  const consent = { consentId: 'consent1', farmId: 'farm-one', farmName: 'Farm <b>one</b>', accountId: 'verified-member', server: 'https://example.invalid/api/farm/commands', departmentId: null, fileName: source.name, mediaType: 'text/csv', byteLength: source.byteLength, sourceDigest: source.sourceDigest, notice: 'Only staged originals. No promotion.', retry: options.retry || false, requestId: options.retry ? 'retained-request' : null };
  const api = { async request(action, payload) {
    calls.push({ action, payload });
    if (action === 'status') return { ok: true, data: { reviewerMode: 'self_attributed', sharedStagingAvailable: true, notice: 'Local archive', ocrReason: 'No OCR' } };
    if (action === 'list') return { ok: true, data: { imports: [] } };
    if (['choose', 'preview'].includes(action)) return { ok: true, data: { ...source } };
    if (action === 'shared.prepare') { if (options.deferred) return new Promise(resolve => { preparedResolve = () => resolve({ ok: true, data: consent }); }); return { ok: true, data: consent }; }
    if (action === 'shared.stage') return { ok: true, data: options.unknown ? { status: 'shared_stage_unconfirmed', requestId: 'retained-request', farmId: 'farm-one', sourceDigest: source.sourceDigest, error: { code: 'WRITE_OUTCOME_UNKNOWN', message: 'Acceptance unknown' } } : { status: 'shared_staged', requestId: 'retained-request', farmId: 'farm-one', sourceDigest: source.sourceDigest, importId: 'server1', revisionHash: 'b'.repeat(64), notice: 'No candidates transferred' } };
    return { ok: true, data: { status: 'cancelled' } };
  } };
  const selection = { farmId: 'farm-one' }, mounted = window.FarmImports.mount(container, api, options.noFarm ? {} : { sharedFarm: selection });
  return { calls, container, mounted, selection, resolve: () => preparedResolve(), async choose() { await settle(); find(container, 'choose').click(); await settle(); } };
}
(async () => {
  const f = fixture(); await f.choose(); assert(!f.calls.some(c => c.action.startsWith('shared.')));
  f.selection.farmId = 'farm-two'; find(f.container, 'shared-prepare').click(); await settle();
  assert.equal(f.calls.find(c => c.action === 'shared.prepare').payload.farmId, 'farm-one');
  assert.equal(f.calls.filter(c => c.action === 'shared.stage').length, 0); assert(texts(f.container).includes('Farm <b>one</b>'));
  find(f.container, 'shared-stage').click(); await settle(); assert.equal(f.calls.filter(c => c.action === 'shared.stage').length, 0);
  find(f.container, 'shared-consent').checked = true; find(f.container, 'shared-stage').click(); await settle();
  const command = f.calls.find(c => c.action === 'shared.stage'); assert.equal(command.payload.acknowledgedUpload, true); assert.equal(command.payload.consentId, 'consent1');
  assert.deepEqual(Object.keys(command.payload).sort(), ['acknowledgedUpload', 'consentId', 'ref']); assert(texts(f.container).includes('server1'));
  assert(!f.calls.some(c => /promot|analyz|import\.revise/.test(c.action))); f.mounted.destroy();
  console.log('ok 1 - copied farm scope, no auto upload, explicit consent, source-only request and text-only content');
  const unknown = fixture({ unknown: true, retry: true }); await unknown.choose(); find(unknown.container, 'shared-prepare').click(); await settle();
  assert(texts(unknown.container).includes('Retained request retained-request')); find(unknown.container, 'shared-consent').checked = true; find(unknown.container, 'shared-stage').click(); await settle();
  assert(texts(unknown.container).includes('Shared staging not confirmed')); assert(texts(unknown.container).includes('WRITE_OUTCOME_UNKNOWN')); assert.equal(unknown.calls.filter(c => c.action === 'shared.stage').length, 1); unknown.mounted.destroy();
  console.log('ok 2 - unknown outcome has retained identity and no automatic retry');
  for (const options of [{ bytes: 262145 }, { noFarm: true }]) { const blocked = fixture(options); await blocked.choose(); assert(!find(blocked.container, 'shared-prepare')); assert(!blocked.calls.some(c => c.action.startsWith('shared.'))); blocked.mounted.destroy(); }
  console.log('ok 3 - oversized local original or missing destination does not offer upload');
  const late = fixture({ deferred: true }); await late.choose(); find(late.container, 'shared-prepare').click(); await settle(); late.mounted.deactivate(); late.resolve(); await settle();
  assert(!find(late.container, 'shared-stage')); assert(late.calls.some(c => c.action === 'cancel')); assert(!late.calls.some(c => c.action === 'shared.stage')); late.mounted.destroy();
  console.log('ok 4 - deactivate revokes consent presentation and suppresses late prepare result');
  console.log('farm shared import UI: 4 Node-only synthetic DOM groups passed; real persistent GUI verification pending');
})().catch(e => { console.error(e); process.exitCode = 1; });
