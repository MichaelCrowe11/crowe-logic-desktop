'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { FarmStore, DOCUMENT_TYPES } = require('../farm/store');
const v = require('../farm/validation');
const f = require('../farm/fixtures');

if (!isMainThread) {
  const store = new FarmStore({ filename: workerData.filename });
  const gate = new Int32Array(workerData.gate);
  parentPort.postMessage({ ready: true });
  Atomics.wait(gate, 0, 0);
  try { parentPort.postMessage({ ok: true, result: store.handle(workerData.action, workerData.payload) }); }
  catch (error) { parentPort.postMessage({ ok: false, code: error.code, message: error.message }); }
  finally { store.close(); }
} else {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-farm-domain-'));
  const stores = [];
  let tests = 0;
  const store = name => { const s = new FarmStore({ filename: path.join(root, name + '.sqlite') }); stores.push(s); return s; };
  const check = (name, fn) => { fn(); tests++; console.log('PASS ' + name); };
  const rejects = (s, action, payload, code) => assert.throws(() => s.handle(action, payload), e => e.code === code, `${action} should fail with ${code}`);
  const copy = x => JSON.parse(JSON.stringify(x));
  const sign = b => { const { checksum, ...body } = b; return { ...body, checksum: v.hash(body) }; };
  try {
    const s = store('primary');
    check('empty authoritative store and durable pragmas', () => {
      assert.equal(s.handle('snapshot').facility, null); assert.equal(s.handle('audit').length, 0);
      assert.equal(s.one('PRAGMA journal_mode').journal_mode, 'wal'); assert.equal(s.one('PRAGMA synchronous').synchronous, 2); assert.equal(s.one('PRAGMA foreign_keys').foreign_keys, 1);
    });
    const seeded = f.seed(s), { firstLot: a, secondLot: b, customer: c } = seeded;
    check('strict unknown fields, identities, dates, quantities and JSON', () => {
      rejects(s, 'not.real', {}, 'VALIDATION'); rejects(s, 'snapshot', { actor: 'forged' }, 'VALIDATION');
      for (const quantityLbs of ['0', '-1', '1.0001', 'NaN', 'Infinity', '01', ' 1', '1e3', '9007199254740.992', 2, NaN, Infinity]) rejects(s, 'lot.create', { ...f.lot, quantityLbs }, 'VALIDATION');
      for (const harvestDate of ['2026-02-29', '2026-04-31', '0000-01-01', '2026-9-01']) rejects(s, 'lot.create', { ...f.lot, harvestDate }, 'VALIDATION');
      rejects(s, 'lot.create', { ...f.lot, room: 'x'.repeat(501) }, 'VALIDATION');
      rejects(s, 'lot.create', { ...f.lot, notes: 'x'.repeat(5001) }, 'VALIDATION');
      const cycle = {}; cycle.self = cycle; rejects(s, 'snapshot', cycle, 'VALIDATION');
      assert.throws(() => v.json({ n: undefined }), e => e.code === 'VALIDATION');
      assert.throws(() => v.json({ get name() { throw new Error('getter executed'); } }), e => e.code === 'VALIDATION');
      const sparse = Array(1); sparse.extra = 1; assert.throws(() => v.json(sparse), e => e.code === 'VALIDATION');
      assert.equal(v.pounds(v.units('9007199254740.991')), '9007199254740.991');
      assert.equal(v.pounds(v.units('0.001')), '0.001');
      assert.equal(v.instant('2026-09-23T10:00:00-07:00'), '2026-09-23T17:00:00.000Z');
      assert.throws(() => v.instant('2026-09-23T25:00:00Z'), e => e.code === 'VALIDATION');
      assert.throws(() => v.instant('2026-09-23'), e => e.code === 'VALIDATION');
    });
    check('adoption exact provenance and stable operator attribution', () => {
      assert.deepEqual(a.sourceSnapshot, f.sourceSnapshot); assert.equal(a.sourceHash, v.hash(f.sourceSnapshot));
      assert.equal(a.sourceReviewedBy.name, f.facility.ownerName); assert.equal(a.sourceReviewedBy.id, s.operator().id);
      assert.equal(a.sourceApprovedAt, a.createdAt); assert.deepEqual(a.originalRecord.sourceSnapshot, f.sourceSnapshot);
      const payload = { ...f.lot, sourceId: 'legacy-flush:mutable-test', sourceSnapshot: { ...f.sourceSnapshot, id: 'mutable-test' } };
      const adopted = s.handle('lot.adopt', payload); payload.sourceSnapshot.notes = 'changed'; delete payload.sourceSnapshot.block;
      assert.equal(s.handle('recall', { lotId: adopted.id }).lot.sourceSnapshot.notes, f.sourceSnapshot.notes);
      rejects(s, 'lot.adopt', { ...f.lot, sourceId: a.sourceId, sourceSnapshot: { ...f.sourceSnapshot } }, 'DUPLICATE_SOURCE');
      rejects(s, 'lot.adopt', { ...f.lot, sourceId: 'legacy-flush:wrong', sourceSnapshot: { ...f.sourceSnapshot } }, 'VALIDATION');
      const previousId = s.operator().id; s.handle('facility.save', { ...f.facility, ownerName: 'Renamed Owner' });
      assert.equal(s.operator().id, previousId); assert.equal(s.operator().name, 'Renamed Owner');
      assert.equal(s.handle('recall', { lotId: a.id }).lot.sourceReviewedBy.name, 'Test Owner');
    });
    check('extended raw source evidence survives adoption and backup without normalization', () => {
      const extended = store('extended-source'); extended.handle('facility.save', f.facility);
      const raw = { ...f.sourceSnapshot, id: 'extended-row', room: ' Historical Room ', strain: 'Oyster',
        weight: '-bad legacy reading', extra: { labels: ['first', 'second'], inspection: { passed: false, value: null } } };
      const payload = { ...f.lot, sourceId: 'legacy-flush:extended-row', sourceSnapshot: raw };
      const adopted = extended.handle('lot.adopt', payload);
      assert.deepEqual(adopted.sourceSnapshot, raw); assert.equal(adopted.sourceHash, v.hash(raw));
      const restored = store('extended-restored');
      restored.handle('backup.restore', { backup: extended.handle('backup.export'), confirmation: 'RESTORE EMPTY FARM' });
      assert.deepEqual(restored.handle('recall', { lotId: adopted.id }).lot.sourceSnapshot, raw);
      const before = extended.handle('audit').length;
      for (const sourceSnapshot of [null, [], { id: 'wrong' }, { id: 'extended-row', extra: Infinity },
        { id: 'extended-row', extra: 'x'.repeat(v.MAX_PAYLOAD_BYTES) },
        JSON.parse('{"id":"extended-row","extra":{"__proto__":{"polluted":true}}}')]) {
        rejects(extended, 'lot.adopt', { ...payload, sourceSnapshot }, 'VALIDATION');
      }
      assert.equal(extended.handle('audit').length, before);
    });
    const shipPayload = { requestId: 'delivery-1', customerId: c.id, shippedAt: '2026-09-23T10:00:00Z', items: [{ lotId: a.id, quantityLbs: '20.001' }, { lotId: b.id, quantityLbs: '10.000' }], notes: 'First delivery' };
    const shipment = s.handle('shipment.create', shipPayload);
    check('multi-lot shipment, exact quantities and bound idempotency', () => {
      assert.equal(s.handle('recall', { lotId: a.id }).remainingLbs, '27.999');
      const count = s.handle('audit').length; assert.deepEqual(s.handle('shipment.create', shipPayload), shipment); assert.equal(s.handle('audit').length, count);
      rejects(s, 'shipment.create', { ...shipPayload, notes: 'different' }, 'CONFLICT');
      rejects(s, 'shipment.create', { ...shipPayload, requestId: 'dupe-items', items: [shipPayload.items[0], shipPayload.items[0]] }, 'VALIDATION');
      assert.deepEqual(shipment.customer, f.customer); assert.equal(shipment.items[0].lotSnapshot.version, 1);
      const before = s.handle('snapshot');
      rejects(s, 'shipment.create', { ...shipPayload, requestId: 'rollback-unavailable', items: [{ lotId: a.id, quantityLbs: '1' }, { lotId: b.id, quantityLbs: '100' }] }, 'INSUFFICIENT_QUANTITY');
      assert.deepEqual(s.handle('snapshot'), before); assert.equal(s.handle('audit').length, count);
      rejects(s, 'shipment.create', { ...shipPayload, requestId: 'rollback-missing', items: [{ lotId: a.id, quantityLbs: '1' }, { lotId: 'missing', quantityLbs: '1' }] }, 'NOT_FOUND');
      assert.deepEqual(s.handle('snapshot'), before); assert.equal(s.handle('audit').length, count);
    });
    check('append-only correction retains receipt and shipment-time source trace', () => {
      const corrected = s.handle('lot.correct', { id: a.id, expectedVersion: 1, reason: 'Scale transcription correction', room: 'Room C', quantityLbs: '40.000' });
      assert.equal(corrected.version, 2); assert.equal(corrected.originalRecord.quantityLbs, '48.000');
      assert.equal(corrected.corrections[0].before.room, 'Room A'); assert.equal(corrected.corrections[0].after.room, 'Room C');
      assert.equal(corrected.corrections[0].actor.name, 'Renamed Owner'); assert.equal(corrected.remainingLbs, '19.999');
      const recall = s.handle('recall', { lotId: a.id }); assert.deepEqual(recall.affectedShipments[0].lotSnapshot, shipment.items[0].lotSnapshot);
      assert.equal(recall.affectedShipments[0].lotSnapshot.room, 'Room A'); assert.deepEqual(recall.affectedShipments[0].lotSnapshot.sourceSnapshot, f.sourceSnapshot);
      rejects(s, 'lot.correct', { id: a.id, expectedVersion: 1, reason: 'stale', notes: 'x' }, 'CONFLICT');
      rejects(s, 'lot.correct', { id: a.id, expectedVersion: 2, reason: 'too low', quantityLbs: '20.000' }, 'INSUFFICIENT_QUANTITY');
      rejects(s, 'lot.correct', { id: a.id, expectedVersion: 2, reason: ' ', notes: 'x' }, 'VALIDATION');
      rejects(s, 'lot.correct', { id: a.id, expectedVersion: 2, reason: 'rewrite source', sourceSnapshot: {} }, 'VALIDATION');
      assert.equal(s.handle('recall', { lotId: b.id }).lot.corrections.length, 0);
      const unshipped = s.handle('lot.create', { ...f.lot, quantityLbs: '0.001' }); assert.deepEqual(s.handle('recall', { lotId: unshipped.id }).affectedShipments, []);
      rejects(s, 'recall', { lotId: 'missing' }, 'NOT_FOUND');
      const exact = s.handle('lot.correct', { id: a.id, expectedVersion: 2, reason: 'Final reconciled quantity', quantityLbs: '20.001' }); assert.equal(exact.remainingLbs, '0.000');
    });
    check('explicit deviations, reasoned optimistic edits and retained resolution', () => {
      const log = s.handle('log.create', { loggedAt: '2026-09-23', room: 'Room A', temperatureF: 72, humidityPercent: 85, cleaningCompleted: true, lotId: a.id, deviationNotes: 'Door left open', correctiveAction: 'Closed door' });
      assert.equal(log.deviationStatus, 'OPEN'); assert.equal(log.resolvedAt, null);
      rejects(s, 'log.update', { id: log.id, expectedVersion: 1, reason: 'erase', deviationNotes: '' }, 'INVALID_STATE');
      const edited = s.handle('log.update', { id: log.id, expectedVersion: 1, reason: 'Thermometer reading and deviation clarification', temperatureF: 73, deviationNotes: 'North door left open' }); assert.equal(edited.version, 2);
      assert.equal(edited.deviationNotes, 'North door left open'); assert.equal(s.handle('audit', { entityId: log.id }).at(-1).before.deviationNotes, 'Door left open');
      rejects(s, 'log.update', { id: log.id, expectedVersion: 1, reason: 'stale', room: 'Room B' }, 'CONFLICT');
      rejects(s, 'log.resolve', { id: log.id, expectedVersion: 2, reason: 'resolve', correctiveAction: '' }, 'VALIDATION');
      const resolved = s.handle('log.resolve', { id: log.id, expectedVersion: 2, reason: 'Verified', correctiveAction: 'Closed and checked door' }); assert.equal(resolved.deviationStatus, 'RESOLVED');
      assert.equal(resolved.resolvedBy.id, s.operator().id);
      rejects(s, 'log.update', { id: log.id, expectedVersion: 3, reason: 'erase action', correctiveAction: '' }, 'INVALID_STATE');
      const reopened = s.handle('log.reopen', { id: log.id, expectedVersion: 3, reason: 'Door failed again' }); assert.equal(reopened.deviationStatus, 'OPEN'); assert.equal(reopened.correctiveAction, resolved.correctiveAction);
      const history = s.handle('audit', { entityId: log.id }); assert.equal(history.length, 4); assert.equal(history.at(-1).before.deviationStatus, 'RESOLVED');
      const clear = s.handle('log.create', { loggedAt: '2026-09-23', room: 'Room B', cleaningCompleted: false, correctiveAction: 'Routine maintenance' }); assert.equal(clear.deviationStatus, 'NONE');
      rejects(s, 'log.resolve', { id: clear.id, expectedVersion: 1, reason: 'no deviation', correctiveAction: 'Done' }, 'INVALID_STATE');
    });
    let document;
    check('immutable document approval, hash and atomic supersession', () => {
      assert.deepEqual(DOCUMENT_TYPES, ['FOOD_SAFETY_PLAN', 'SANITATION_SOP', 'HARVEST_PACKING_SOP', 'RECALL_PLAN', 'LOT_CODING_SOP']);
      document = s.handle('document.create', { title: 'Recall procedure', type: 'RECALL_PLAN', content: 'Contact each shipment recipient.' });
      const first = document.revisions[0]; assert.equal(first.status, 'DRAFT'); assert.equal(s.handle('snapshot').dashboard.documentsAwaitingApproval, 0);
      rejects(s, 'document.approve', { id: document.id, revisionId: first.id, expectedVersion: 1, attestation: true }, 'INVALID_STATE');
      document = s.handle('document.submit', { id: document.id, revisionId: first.id, expectedVersion: 1 }); assert.equal(document.revisions[0].editVersion, 2); assert.equal(s.handle('snapshot').dashboard.documentsAwaitingApproval, 1);
      document = s.handle('document.edit', { id: document.id, revisionId: first.id, expectedVersion: 2, title: 'Recall procedure', content: 'Call and document each recipient.', reason: 'Clarify recording' }); assert.equal(document.revisions[0].status, 'DRAFT');
      document = s.handle('document.submit', { id: document.id, revisionId: first.id, expectedVersion: 3 });
      rejects(s, 'document.approve', { id: document.id, revisionId: first.id, expectedVersion: 4, attestation: false }, 'VALIDATION');
      document = s.handle('document.approve', { id: document.id, revisionId: first.id, expectedVersion: 4, attestation: true });
      const approved = document.revisions[0]; assert.equal(approved.contentHash, v.hash({ title: approved.title, content: approved.content })); assert.equal(approved.approvedBy.id, s.operator().id);
      rejects(s, 'document.edit', { id: document.id, revisionId: first.id, expectedVersion: 5, title: 'mutate', content: 'bad', reason: 'not allowed' }, 'INVALID_STATE');
      document = s.handle('document.revise', { id: document.id, reason: 'Annual review' }); const second = document.revisions[1]; assert.equal(document.revisions[0].status, 'APPROVED');
      rejects(s, 'document.revise', { id: document.id, reason: 'Competing draft' }, 'CONFLICT');
      document = s.handle('document.edit', { id: document.id, revisionId: second.id, expectedVersion: 1, title: 'Updated recall procedure', content: 'Call, document and verify receipt.', reason: 'Add verification' });
      document = s.handle('document.submit', { id: document.id, revisionId: second.id, expectedVersion: 2 });
      const pre = s.handle('snapshot'), auditCount = s.handle('audit').length;
      // Deliberately fail the second half of approval to prove the old approval
      // and audit cannot commit alone after a transactional supersession.
      s.db.exec(`CREATE TRIGGER test_approval_failure BEFORE UPDATE ON document_revisions WHEN NEW.id='${second.id}' AND NEW.status='APPROVED' BEGIN SELECT RAISE(ABORT,'injected failure'); END;`);
      rejects(s, 'document.approve', { id: document.id, revisionId: second.id, expectedVersion: 3, attestation: true }, 'INTERNAL');
      assert.deepEqual(s.handle('snapshot'), pre); assert.equal(s.handle('audit').length, auditCount); s.db.exec('DROP TRIGGER test_approval_failure');
      document = s.handle('document.approve', { id: document.id, revisionId: second.id, expectedVersion: 3, attestation: true });
      assert.equal(document.revisions[0].status, 'SUPERSEDED'); assert.equal(document.revisions[0].supersededByRevisionId, second.id); assert.equal(document.revisions[1].supersedesRevisionId, first.id);
      assert.equal(document.revisions[0].content, approved.content); assert.equal(document.revisions[0].contentHash, approved.contentHash); assert.equal(document.title, 'Updated recall procedure');
    });
    check('SQL immutability, checks, foreign keys and audit rollback', () => {
      for (const table of ['lots', 'lot_corrections', 'customers', 'shipments', 'shipment_items', 'audit']) {
        assert.throws(() => s.db.exec(`UPDATE ${table} SET ${table === 'shipment_items' ? 'quantity=quantity' : table === 'audit' ? 'action=action' : 'id=id'}`), /immutable/);
        assert.throws(() => s.db.exec(`DELETE FROM ${table}`), /cannot be deleted/);
      }
      for (const r of document.revisions) assert.throws(() => s.run('UPDATE document_revisions SET content=? WHERE id=?', 'tamper', r.id), /immutable/);
      assert.throws(() => s.run('UPDATE logs SET humidity_percent=101,version=version+1'), /CHECK/);
      assert.throws(() => s.run('UPDATE logs SET lot_id=?,version=version+1', 'missing'), /FOREIGN KEY/);
      const before = s.handle('snapshot'); const count = s.handle('audit').length;
      s.db.exec("CREATE TRIGGER test_audit_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'injected audit failure'); END;");
      rejects(s, 'lot.create', { ...f.lot }, 'INTERNAL'); assert.deepEqual(s.handle('snapshot'), before); assert.equal(s.handle('audit').length, count);
      s.db.exec('DROP TRIGGER test_audit_failure');
    });
    check('dashboard derives actual records, not seeded counters', () => {
      const snap = s.handle('snapshot'); assert.equal(snap.dashboard.lotsCreated, snap.lots.length); assert.equal(snap.dashboard.shipmentsRecorded, snap.shipments.length);
      assert.equal(snap.dashboard.openDeviations, snap.logs.filter(l => l.deviationStatus === 'OPEN').length); assert.equal(snap.dashboard.documentsAwaitingApproval, 0);
    });
    const race = store('race'), raceData = f.seed(race), raceFile = path.join(root, 'race.sqlite');
    let outcomes = await raceRequests(raceFile, 'lot.adopt', [0, 1].map(() => ({ ...f.lot, sourceId: 'legacy-flush:race-source', sourceSnapshot: { ...f.sourceSnapshot, id: 'race-source' } })));
    check('two-connection adoption race allows exactly one source receipt', () => { assert.equal(outcomes.filter(o => o.ok).length, 1); assert.equal(outcomes.find(o => !o.ok).code, 'DUPLICATE_SOURCE'); assert.equal(race.handle('snapshot').lots.filter(l => l.sourceId === 'legacy-flush:race-source').length, 1); });
    outcomes = await raceRequests(raceFile, 'shipment.create', [0, 1].map(i => ({ requestId: 'race-' + i, customerId: raceData.customer.id, shippedAt: '2026-09-23T12:00:00Z', items: [{ lotId: raceData.firstLot.id, quantityLbs: '30' }] })));
    check('two-connection shipment race cannot overship', () => { assert.equal(outcomes.filter(o => o.ok).length, 1); assert.equal(outcomes.find(o => !o.ok).code, 'INSUFFICIENT_QUANTITY'); assert.equal(race.handle('recall', { lotId: raceData.firstLot.id }).totalShippedLbs, '30.000'); });
    const retryPayload = { requestId: 'race-idempotent', customerId: raceData.customer.id, shippedAt: '2026-09-23T12:00:00Z', items: [{ lotId: raceData.firstLot.id, quantityLbs: '10' }] };
    outcomes = await raceRequests(raceFile, 'shipment.create', [retryPayload, retryPayload]);
    check('two-connection request retry commits one shipment and one event', () => { assert.equal(outcomes.filter(o => o.ok).length, 2); assert.equal(outcomes[0].result.id, outcomes[1].result.id); assert.equal(race.handle('snapshot').shipments.length, 2); assert.equal(race.handle('audit').filter(e => e.action === 'shipment.create').length, 2); });
    check('maximum safe thousandths allocate exactly without floating point loss', () => {
      const exact = store('max-units'), lot = exact.handle('lot.create', { ...f.lot, quantityLbs: '9007199254740.991' });
      const customer = exact.handle('customer.create', { ...f.customer });
      exact.handle('shipment.create', { requestId: 'max-1', customerId: customer.id, shippedAt: '2026-09-23T12:00:00Z', items: [{ lotId: lot.id, quantityLbs: '9007199254740.990' }] });
      assert.equal(exact.handle('recall', { lotId: lot.id }).remainingLbs, '0.001');
      exact.handle('shipment.create', { requestId: 'max-2', customerId: customer.id, shippedAt: '2026-09-23T12:00:00Z', items: [{ lotId: lot.id, quantityLbs: '0.001' }] });
      assert.equal(exact.handle('recall', { lotId: lot.id }).totalShippedLbs, '9007199254740.991');
      rejects(exact, 'shipment.create', { requestId: 'max-3', customerId: customer.id, shippedAt: '2026-09-23T12:00:00Z', items: [{ lotId: lot.id, quantityLbs: '0.001' }] }, 'INSUFFICIENT_QUANTITY');
    });
    check('capacity-crossing edit rolls back while accepted history stays exportable', () => {
      const large = store('large-export');
      let document = large.handle('document.create', { title: 'Large plan', type: 'RECALL_PLAN', content: 'x'.repeat(100000) });
      let rejected = false;
      for (let i = 0; i < 40; i++) {
        const before = large.rawTables(), revision = document.revisions[0];
        try { document = large.handle('document.edit', { id: document.id, revisionId: revision.id, expectedVersion: revision.editVersion, title: document.title, content: (i % 2 ? 'é' : 'x').repeat(100000), reason: 'Recorded update' }); }
        catch (error) { assert.equal(error.code, 'BACKUP_CAPACITY'); assert.deepEqual(large.rawTables(), before); rejected = true; }
        assert.ok(Buffer.byteLength(JSON.stringify(large.handle('backup.export'))) <= v.MAX_BACKUP_BYTES);
        if (rejected) break;
      }
      assert.ok(rejected, 'bounded history must reject a capacity-crossing edit');
    });
    check('restore receipt capacity overflow leaves the target empty and identity unchanged', () => {
      const target = store('receipt-capacity'), before = target.rawTables(), input = s.handle('backup.export');
      const limit = v.MAX_BACKUP_BYTES;
      // A valid file exactly at a configured capacity leaves no room for the
      // required restore receipt. Replay must not hide that final target check.
      v.MAX_BACKUP_BYTES = Buffer.byteLength(JSON.stringify(input));
      try { rejects(target, 'backup.restore', { backup: input, confirmation: 'RESTORE EMPTY FARM' }, 'BACKUP_CAPACITY'); }
      finally { v.MAX_BACKUP_BYTES = limit; }
      assert.deepEqual(target.rawTables(), before);
    });
    const backup = s.handle('backup.export');
    check('complete backup roundtrip, restored provenance and repeated backup restore', () => {
      const target = store('restored'), initialIdentity = target.operator();
      assert.notEqual(initialIdentity.id, s.operator().id);
      assert.deepEqual(target.handle('backup.restore', { backup, confirmation: 'RESTORE EMPTY FARM' }), s.counts());
      assert.deepEqual(target.handle('snapshot'), s.handle('snapshot'));
      const audit = target.handle('audit'); assert.deepEqual(audit.slice(0, -1), s.handle('audit')); assert.equal(audit.at(-1).action, 'backup.restore');
      assert.deepEqual(target.handle('recall', { lotId: a.id }), s.handle('recall', { lotId: a.id }));
      assert.deepEqual(target.handle('shipment.create', shipPayload), shipment);
      const secondBackup = target.handle('backup.export'), again = store('restored-again'); again.handle('backup.restore', { backup: JSON.stringify(secondBackup), confirmation: 'RESTORE EMPTY FARM' }); assert.deepEqual(again.handle('snapshot'), s.handle('snapshot'));
      rejects(target, 'backup.restore', { backup, confirmation: 'RESTORE EMPTY FARM' }, 'STORE_NOT_EMPTY');
    });
    check('hostile checksummed backups fail staging without changing empty target', () => {
      const target = store('invalid-target'), empty = target.handle('snapshot');
      const attempts = [
        b => { b.schemaVersion = 99; }, b => { b.tables.lots[0].quantity = -1; },
        b => { b.tables.lots[0].source_snapshot = JSON.stringify({ ...f.sourceSnapshot, notes: 'tampered' }); },
        b => { b.tables.lots[0].source_reviewer = JSON.stringify({ id: s.operator().id, name: 'imposter' }); },
        b => { b.tables.lot_corrections[0].reason = ''; }, b => { b.tables.lot_corrections[0].version = 99; },
        b => { b.tables.shipment_items[0].quantity = 1; }, b => { b.tables.shipment_items[0].lot_id = 'missing'; },
        b => { b.tables.shipment_items[0].lot_snapshot = '{}'; }, b => { b.tables.shipments[0].customer_snapshot = '{}'; },
        b => { b.tables.document_revisions[0].content = 'rewritten'; }, b => { b.tables.document_revisions[1].supersedes_revision_id = null; },
        b => { b.tables.logs[0].version++; }, b => { b.tables.logs[0].deviation_status = 'NONE'; },
        b => { b.tables.audit.pop(); }, b => { b.tables.audit[1].before_record = '{}'; },
        b => { b.tables.audit[1].actor = JSON.stringify({ id: 'forged', name: 'forged' }); },
        b => { b.tables.operator[0].name = 'Wrong operator'; }, b => { b.tables.audit = []; },
        b => { b.tables.customers.push(copy(b.tables.customers[0])); }, b => { b.tables.lots[0].unexpected = 'column'; },
      ];
      for (const mutate of attempts) {
        const bad = copy(backup); mutate(bad); rejects(target, 'backup.restore', { backup: sign(bad), confirmation: 'RESTORE EMPTY FARM' }, 'INVALID_BACKUP');
        assert.deepEqual(target.handle('snapshot'), empty); assert.equal(target.handle('audit').length, 0);
      }
      rejects(target, 'backup.restore', { backup: { ...backup, checksum: 'bad' }, confirmation: 'RESTORE EMPTY FARM' }, 'INVALID_BACKUP');
      rejects(target, 'backup.restore', { backup: '{', confirmation: 'RESTORE EMPTY FARM' }, 'INVALID_BACKUP');
      rejects(target, 'backup.restore', { backup: ' '.repeat(v.MAX_BACKUP_BYTES + 1), confirmation: 'RESTORE EMPTY FARM' }, 'INVALID_BACKUP');
      rejects(target, 'backup.restore', { backup, confirmation: 'RESTORE' }, 'VALIDATION');
      assert.deepEqual(target.handle('snapshot'), empty);
    });
    check('full reopen preserves all facts, history and operator identity', () => {
      const before = s.handle('snapshot'), audit = s.handle('audit'); s.close(); const reopened = store('primary');
      assert.deepEqual(reopened.handle('snapshot'), before); assert.deepEqual(reopened.handle('audit'), audit);
      rejects(s, 'snapshot', {}, 'UNAVAILABLE');
    });
    check('unsupported and unversioned schemas fail closed without rewriting data', () => {
      for (const [name, version] of [['future', 2], ['unversioned', 0]]) {
        const file = path.join(root, name + '.sqlite'), db = new DatabaseSync(file); db.exec(`CREATE TABLE preserve(value TEXT); INSERT INTO preserve VALUES('untouched'); PRAGMA user_version=${version};`); db.close();
        assert.throws(() => new FarmStore({ filename: file }), e => e.code === 'CORRUPT_STORE'); const verify = new DatabaseSync(file); assert.equal(verify.prepare('SELECT value FROM preserve').get().value, 'untouched'); assert.equal(verify.prepare('PRAGMA user_version').get().user_version, version); verify.close();
      }
    });
    const runtime = new DatabaseSync(':memory:');
    const sqliteVersion = runtime.prepare('SELECT sqlite_version() AS v').get().v; runtime.close();
    console.log(`${tests} FarmStore integrity groups passed on Node ${process.versions.node}, SQLite ${sqliteVersion}.`);
  } finally { for (const s of stores) s.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

async function raceRequests(filename, action, payloads) {
  const gate = new SharedArrayBuffer(4), state = new Int32Array(gate);
  let ready = 0;
  return Promise.all(payloads.map(payload => new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { filename, action, payload, gate } });
    let result;
    worker.on('message', message => {
      if (message.ready) { if (++ready === payloads.length) { Atomics.store(state, 0, 1); Atomics.notify(state, 0); } }
      else result = message;
    });
    worker.on('error', reject);
    worker.on('exit', code => code || !result ? reject(new Error(`Race worker failed (${code})`)) : resolve(result));
  })));
}
