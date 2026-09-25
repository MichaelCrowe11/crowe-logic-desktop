'use strict';
// Node-only: synthetic sessions, injected transport, disposable local archives.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { createImportHost } = require('../imports/host');
const { createImportStore } = require('../imports/host-store');
const { createTeamHost } = require('../farm/team-host');
const C = require('../imports/shared-contract');
const { digest, hash } = require('../imports/safety');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'farm-shared-')));
const raw = Buffer.from('﻿when,value\r\n2026-01-01,"a,b"\r\n');
const filename = path.join(root, 'source.csv'); fs.writeFileSync(filename, raw);
const time = '2026-09-24T12:00:00Z';
let count = 0; const pass = label => console.log(`ok ${++count} - ${label}`);
const profile = name => { const p = path.join(root, name); fs.mkdirSync(p); return p; };
const destination = { accountId: 'verified-member', server: 'https://api.crowelogic.com/api/farm/commands', farmId: 'farm-one', departmentId: null };
const accepted = p => ({ id: 'server-import', fileName: p.fileName, mediaType: p.mediaType, sourceHash: digest(Buffer.from(p.sourceBase64, 'base64')), sourceBytes: Buffer.from(p.sourceBase64, 'base64').length, departmentId: p.departmentId, revision: 1, revisionHash: 'a'.repeat(64), candidates: [], status: 'staged', ledgerWriteAuthorized: false });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const tick = () => new Promise(r => setImmediate(r));
function fixture(userData, custom = {}) {
  const sender = new EventEmitter(), event = { sender, senderFrame: {} }, calls = [];
  let session = { token: 'synthetic-token', generation: 1, baseUrl: 'https://api.crowelogic.com' }, member = 'verified-member', behavior = null;
  const team = createTeamHost({ isTrustedSender: e => e.sender === sender, canAccess: () => true, getSession: () => session,
    fetch: async (_url, init) => {
      const command = JSON.parse(init.body); calls.push(command);
      if (command.action === 'farm.list') return json({ ok: true, data: { items: member ? [{ id: 'farm-one', name: 'Fixture farm', currentMemberId: member }, { id: 'farm-two', name: 'Other fixture', currentMemberId: member }] : [] } });
      if (command.action === 'department.list') return json({ ok: true, data: { items: [{ id: 'lab', name: 'Lab' }] } });
      assert.equal(command.action, 'import.stage');
      return behavior ? behavior(command.payload) : json({ ok: true, data: accepted(command.payload) });
    } });
  const host = createImportHost({ isTrustedSender: e => e.sender === sender, canAccess: () => true, assertAdmission() {}, getUserData: () => userData, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [custom.filename || filename] }) }, getWindow: () => null, shared: team.imports, clock: () => Date.parse(time) });
  return { host, team, event, calls, setSession: x => { session = x; }, session: () => session, setMember: x => { member = x; }, behavior: x => { behavior = x; },
    request: (action, payload = {}) => host.request(event, action, payload),
    async ok(action, payload = {}) { const r = await host.request(event, action, payload); assert.equal(r.ok, true, JSON.stringify(r)); return r.data; },
    writes: () => calls.filter(c => c.action === 'import.stage'),
    async close() { team.invalidate(); await host.close(); } };
}
const prepare = (f, item, extra = {}) => f.ok('shared.prepare', { ref: item.ref, farmId: 'farm-one', departmentId: null, ...extra });
const stage = (f, item, consent) => f.ok('shared.stage', { ref: item.ref, consentId: consent.consentId, acknowledgedUpload: true });
(async () => {
  const p = profile('store'), store = createImportStore(p), item = store.choose(filename, time);
  const info = store.sharedPrepare(item.id, destination); assert.equal(info.sourceDigest, digest(raw)); assert.equal(info.retry, false);
  assert.equal(fs.readdirSync(path.join(p, 'farm-imports')).length, 1);
  const intent = store.sharedIntent(item.id, destination, digest(raw), time);
  assert.equal(intent.payload.sourceBase64, raw.toString('base64')); assert(!('receipt' in intent.payload)); assert(!('candidates' in intent.payload));
  assert.deepEqual(createImportStore(p).sharedIntent(item.id, destination, digest(raw), time), intent);
  assert.equal(createImportStore(p).sharedPrepare(item.id, destination).requestId, intent.payload.requestId);
  assert.equal(fs.statSync(path.join(p, 'farm-imports', `${item.id}.h${hash(destination)}.json`)).mode & 0o777, 0o600);
  pass('exact original and destination-bound immutable request survive store restart; prepare has no durable write');
  const changed = store.sharedIntent(item.id, { ...destination, farmId: 'farm-two' }, digest(raw), time);
  assert.notEqual(changed.payload.requestId, intent.payload.requestId);
  assert.equal(store.sharedPrepare(item.id, { ...destination, accountId: 'other-member' }).retry, false);
  assert.throws(() => store.sharedIntent(item.id, destination, '0'.repeat(64), time), { code: 'SOURCE_CHANGED' });
  const intentPath = path.join(p, 'farm-imports', `${item.id}.h${hash(destination)}.json`);
  const tampered = JSON.parse(fs.readFileSync(intentPath, 'utf8')); tampered.payload.sourceBase64 = Buffer.from('changed').toString('base64'); fs.writeFileSync(intentPath, JSON.stringify(tampered));
  assert.throws(() => store.sharedPrepare(item.id, destination), { code: 'STORE_CORRUPT' });
  pass('scope/account isolation, source mismatch and corrupt persisted intents fail closed');
  const sourceFor = (raw, name = 'source.csv', format = 'csv') => ({ format, source: { name, original: raw.toString('base64'), byteLength: raw.length, digest: digest(raw) } });
  assert.equal(C.source(sourceFor(Buffer.alloc(262144, 65))).byteLength, 262144);
  for (const size of [0, 262145, 8 * 1024 * 1024]) assert.throws(() => C.source(sourceFor(Buffer.alloc(size, 65))), { code: 'SOURCE_LIMIT' });
  assert.throws(() => C.source(sourceFor(raw, 'x'.repeat(241))), { code: 'SOURCE_NAME' });
  assert.throws(() => C.source(sourceFor(raw, 'a\tb.csv')), { code: 'SOURCE_NAME' });
  assert.throws(() => C.source(sourceFor(raw, 'picture.png', 'image')), { code: 'SOURCE_MEDIA' });
  assert.throws(() => C.command({ ...intent.payload, sourceBase64: 'YQ===' }), { code: 'STORE_CORRUPT' });
  pass('honest 256 KiB vs 8 MiB, empty, media, filename and canonical-base64 limits');
  const crashProfile = profile('intent-crash');
  const cleanStore = createImportStore(crashProfile), crashItem = cleanStore.choose(filename, time);
  const crashStore = createImportStore(crashProfile, { onStep(step) { if (step === 'after-publish') throw Error('synthetic lost fsync'); } });
  assert.throws(() => crashStore.sharedIntent(crashItem.id, destination, digest(raw), time), { code: 'WRITE_OUTCOME_UNKNOWN' });
  const recoveredIntent = createImportStore(crashProfile).sharedIntent(crashItem.id, destination, digest(raw), time);
  assert.equal(createImportStore(crashProfile).sharedPrepare(crashItem.id, destination).requestId, recoveredIntent.payload.requestId);
  assert.equal(fs.readdirSync(path.join(crashProfile, 'farm-imports')).length, 2);
  pass('post-publication disk failure reconciles durable intent without minting a replacement request');

  const hp = profile('host'), f = fixture(hp);
  let chosen;
  try {
    chosen = await f.ok('choose'); await f.ok('preview', { ref: chosen.ref });
    assert.equal(f.calls.length, 0);
    assert.equal((await f.request('shared.stage', { ref: chosen.ref, consentId: 'invented', acknowledgedUpload: true })).error.code, 'REVIEW_REQUIRED');
    assert.equal((await f.team.request(f.event, 'import.stage', intent.payload)).error.code, 'VALIDATION');
    assert.equal((await f.team.request(f.event, 'import.promote', intent.payload)).error.code, 'VALIDATION');
    let consent = await prepare(f, chosen); assert.equal(f.writes().length, 0); assert.equal(consent.accountId, 'verified-member'); assert.equal(consent.farmName, 'Fixture farm');
    assert(!JSON.stringify(consent).includes('sourceBase64')); assert(!JSON.stringify(consent).includes('synthetic-token'));
    assert.equal((await f.request('shared.stage', { ref: chosen.ref, consentId: consent.consentId, acknowledgedUpload: false })).error.code, 'REVIEW_REQUIRED');
    f.behavior(() => { throw Error('synthetic lost connection after commit'); });
    const unknown = await stage(f, chosen, consent); assert.equal(unknown.status, 'shared_stage_unconfirmed'); assert.equal(unknown.error.code, 'WRITE_OUTCOME_UNKNOWN');
    await tick(); assert.equal(f.writes().length, 1); assert.equal(f.writes()[0].payload.sourceBase64, raw.toString('base64'));
    assert.equal((await f.request('shared.stage', { ref: chosen.ref, consentId: consent.consentId, acknowledgedUpload: true })).error.code, 'REVIEW_REQUIRED');
    consent = await prepare(f, chosen); assert.equal(consent.requestId, unknown.requestId); assert.equal(consent.retry, true);
    f.behavior(null); const success = await stage(f, chosen, consent); assert.equal(success.status, 'shared_staged'); assert.equal(success.ledgerWriteAuthorized, false); assert.deepEqual(f.writes()[0], f.writes()[1]);
    pass('local choose/review never dispatch; native consent, stage-only channel and explicit unknown replay preserve exact identity');
    consent = await prepare(f, chosen); f.setSession({ ...f.session(), token: 'synthetic-new-token' });
    assert.equal((await f.request('shared.stage', { ref: chosen.ref, consentId: consent.consentId, acknowledgedUpload: true })).error.code, 'AUTH_CHANGED'); assert.equal(f.writes().length, 2);
    consent = await prepare(f, chosen); await f.ok('cancel');
    assert.equal((await f.request('shared.stage', { ref: chosen.ref, consentId: consent.consentId, acknowledgedUpload: true })).error.code, 'STALE_REFERENCE'); assert.equal(f.writes().length, 2);
    chosen = await f.ok('open', { id: chosen.id });
    consent = await prepare(f, chosen); f.setMember(null); f.setSession({ ...f.session(), generation: 2 });
    assert.equal((await f.request('shared.prepare', { ref: chosen.ref, farmId: 'farm-one' })).error.code, 'AUTH_REQUIRED'); f.setMember('verified-member');
    pass('token change, cancellation and missing server-verified membership block dispatch');
    for (const change of [r => ({ ...r, sourceHash: '0'.repeat(64) }), r => ({ ...r, ledgerWriteAuthorized: true }), r => ({ ...r, candidates: [{}] }), r => ({ ...r, revision: 2 }), r => ({ ...r, departmentId: 'wrong' })]) {
      consent = await prepare(f, chosen); f.behavior(payload => json({ ok: true, data: change(accepted(payload)) }));
      const result = await f.request('shared.stage', { ref: chosen.ref, consentId: consent.consentId, acknowledgedUpload: true }); assert.equal(result.error.code, 'WRITE_OUTCOME_UNKNOWN');
    }
    pass('mismatched server digest, scope, candidate, revision or write authority never claims staging success');
    consent = await prepare(f, chosen); f.behavior(() => json({ detail: { code: 'source_already_staged', message: 'Already staged' } }, 409));
    const duplicate = await stage(f, chosen, consent); assert.equal(duplicate.status, 'shared_stage_unconfirmed'); assert.equal(duplicate.error.code, 'source_already_staged');
    assert.equal((await prepare(f, chosen)).requestId, duplicate.requestId);
    pass('real lowercase backend rejection remains explicit and never replaces unknown intent');
    let resolve;
    consent = await prepare(f, chosen); f.behavior(payload => new Promise(r => { resolve = () => r(json({ ok: true, data: accepted(payload) })); }));
    const waiting = f.request('shared.stage', { ref: chosen.ref, consentId: consent.consentId, acknowledgedUpload: true });
    while (!resolve) await tick(); await f.ok('cancel'); resolve(); assert.equal((await waiting).error.code, 'WRITE_OUTCOME_UNKNOWN');
    pass('cancellation during dispatch suppresses success without erasing original destination retry identity');
  } finally { await f.close(); }
  const restart = fixture(hp);
  try {
    chosen = await restart.ok('open', { id: chosen.id }); const consent = await prepare(restart, chosen);
    assert.equal(consent.retry, true); const result = await stage(restart, chosen, consent);
    assert.equal(result.status, 'shared_staged'); assert.deepEqual(restart.writes()[0], f.writes()[0]);
    pass('host restart reauthenticates, requires fresh consent and replays exactly the same original request');
  } finally { await restart.close(); }
  const oversized = path.join(root, 'large.txt'); fs.writeFileSync(oversized, 'x\n'.repeat(150000));
  // Create an otherwise valid retained stage with long lines bounded by parser.
  fs.writeFileSync(oversized, ('x'.repeat(1000) + '\n').repeat(270));
  const large = fixture(profile('large'), { filename: oversized });
  try {
    const source = await large.ok('choose'); const r = await large.request('shared.prepare', { ref: source.ref, farmId: 'farm-one' });
    assert.equal(r.error.code, 'SOURCE_LIMIT'); assert.equal(large.writes().length, 0); assert.equal(fs.readdirSync(path.join(root, 'large/farm-imports')).length, 1);
    pass('large but valid local original is refused before intent publication or source upload');
  } finally { await large.close(); }
  console.log(`farm shared import: ${count} Node-only tests passed; no real accounts, network, models, GUI or ledger writes`);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
