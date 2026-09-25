#!/usr/bin/env node
'use strict';
// Node-only domain/restart evidence. No Electron app/main, network, production
// profile, or installation. UI/localStorage behavior is tested by test-farm-ui.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { FarmStore } = require('../farm/store');
const vm = require('node:vm');
const pendingRows = new Map();
const window = { localStorage: { get length() { return pendingRows.size; }, key: index => [...pendingRows.keys()][index] || null, getItem: key => pendingRows.get(key) ?? null } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/farm-recovery.js'), 'utf8'), { window });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-farm-retry-'));
const filename = path.join(home, 'farm.sqlite');
const profile = path.join(home, 'pending-intent.json');
let store;
try {
  store = new FarmStore({ filename });
  const lot = store.handle('lot.create', { harvestDate: '2026-09-23', room: 'Fixture room', species: 'Oyster', quantityLbs: '10.000', notes: '' });
  const customer = store.handle('customer.create', { name: 'Restart fixture recipient' });
  const operatorId = store.handle('snapshot').storage.operator.id;
  const payload = { customerId: customer.id, shippedAt: '2026-09-23T10:30:00.000Z', notes: 'Exact persisted request',
    items: [{ lotId: lot.id, quantityLbs: '2.125' }], requestId: randomUUID() };
  // This file stands in for the desktop profile's retained localStorage bytes.
  // Write before the store sees the request, then deliberately discard its reply.
  const raw = JSON.stringify({ schemaVersion: 1, operatorId, payload });
  fs.writeFileSync(profile, raw, { flag: 'wx', mode: 0o600 });
  const committed = store.handle('shipment.create', payload);
  const auditBefore = store.handle('audit');
  store.close();
  store = new FarmStore({ filename });
  const key = window.FarmRecovery.shipmentStorageKey(operatorId);
  pendingRows.set(key, fs.readFileSync(profile, 'utf8'));
  const parsed = window.FarmRecovery.readPendingShipment();
  assert.equal(parsed.raw, raw, 'Shared renderer parser retains exact persisted bytes');
  assert.equal(window.FarmRecovery.acquire('retry-source-transfer').ok, true);
  assert.equal(window.FarmRecovery.inspect('retry-source-transfer').ok, false, 'Transfer blocked until original persisted intent is reconciled');
  assert.equal(window.FarmRecovery.release('retry-source-transfer').ok, true);
  const pending = JSON.parse(parsed.raw);
  assert.equal(store.handle('snapshot').storage.operator.id, pending.operatorId);
  assert.deepEqual(pending.payload, payload);
  const repeated = store.handle('shipment.create', pending.payload);
  assert.deepEqual(repeated, committed);
  assert.equal(store.handle('snapshot').shipments.length, 1);
  assert.equal(store.handle('snapshot').lots[0].shippedLbs, '2.125');
  assert.equal(store.handle('snapshot').lots[0].remainingLbs, '7.875');
  assert.deepEqual(store.handle('audit'), auditBefore, 'Replay must not append another allocation event');
  assert.throws(() => store.handle('shipment.create', { ...pending.payload, notes: 'Changed after restart' }), error => error.code === 'CONFLICT');
  assert.deepEqual(store.handle('audit'), auditBefore);
  assert.equal(fs.readFileSync(profile, 'utf8'), raw, 'Unknown/conflicting attempts preserve exact pending bytes');
  console.log('PASS real FarmStore close/reopen with persisted exact intent returns original shipment, one allocation and unchanged audit');
  // Even when all remaining stock has since shipped, old-key replay must resolve
  // against the receipt before current availability is considered.
  store.handle('shipment.create', { ...payload, requestId: randomUUID(), items: [{ lotId: lot.id, quantityLbs: '7.875' }] });
  assert.deepEqual(store.handle('shipment.create', pending.payload), committed);
  assert.equal(store.handle('snapshot').lots[0].remainingLbs, '0.000');
  assert.equal(store.handle('snapshot').shipments.length, 2);
  console.log('PASS exact pending replay succeeds despite exhausted inventory and stale availability snapshot');
  // Clear only once the authoritative replay has succeeded.
  fs.unlinkSync(profile);
  console.log(`farm-retry: 2 checks passed. Node ${process.versions.node}`);
} finally {
  if (store) store.close();
  fs.rmSync(home, { recursive: true, force: true });
}
