/* Trusted-renderer coordination only. Main owns the transfer lease and IPC gate. */
(function (global) {
  'use strict';
  const SHIPMENT_STORAGE_PREFIX = 'crowe.farm.pending-shipment.';
  const shipmentStorageKey = operatorId => `${SHIPMENT_STORAGE_PREFIX}v1:${encodeURIComponent(operatorId)}`;
  const recoveryError = message => ({ code: 'SHIPMENT_RECOVERY_BLOCKED', message });
  const validId = value => typeof value === 'string' && !!value.trim() && value === value.trim() && value.length <= 200 && !value.includes('\0');
  function quantity(raw) {
    const value = String(raw).trim();
    if (!/^\d+(?:\.\d{1,3})?$/.test(value)) throw { code: 'VALIDATION', message: 'Enter a positive pound quantity with no more than 3 decimal places.' };
    const [whole, fraction = ''] = value.split('.');
    const units = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
    if (units <= 0n || units > BigInt(Number.MAX_SAFE_INTEGER)) throw { code: 'VALIDATION', message: 'Quantity is outside the supported positive range.' };
    return `${units / 1000n}.${String(units % 1000n).padStart(3, '0')}`;
  }
  function pendingRecord(raw, key) {
    // Keep this persistence/retry contract unchanged. Inspection never repairs data.
    const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
    if (typeof raw !== 'string' || raw.length > 1024 * 1024) throw recoveryError('Pending shipment data is missing or too large.');
    const record = JSON.parse(raw), p = record && record.payload;
    if (!exactKeys(record, ['schemaVersion', 'operatorId', 'payload']) || record.schemaVersion !== 1 || !validId(record.operatorId) || key !== shipmentStorageKey(record.operatorId) ||
      !exactKeys(p, ['customerId', 'shippedAt', 'notes', 'items', 'requestId']) || !validId(p.requestId) || !validId(p.customerId) ||
      typeof p.shippedAt !== 'string' || !Number.isFinite(Date.parse(p.shippedAt)) || new Date(p.shippedAt).toISOString() !== p.shippedAt ||
      typeof p.notes !== 'string' || p.notes.length > 5000 || p.notes.includes('\0') || !Array.isArray(p.items) || !p.items.length || p.items.length > 1000 ||
      p.items.some(item => !exactKeys(item, ['lotId', 'quantityLbs']) || !validId(item.lotId) || typeof item.quantityLbs !== 'string' || item.quantityLbs.length > 20 || quantity(item.quantityLbs) !== item.quantityLbs) ||
      new Set(p.items.map(item => item.lotId)).size !== p.items.length) throw recoveryError('Pending shipment data has an unsupported schema or invalid content.');
    return { operatorId: record.operatorId, key, raw, payload: Object.freeze({ ...p, items: Object.freeze(p.items.map(Object.freeze)) }), persisted: true, definitive: false };
  }
  function readPendingShipment() {
    const storage = global.localStorage, records = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(SHIPMENT_STORAGE_PREFIX)) records.push(pendingRecord(storage.getItem(key), key));
    }
    if (records.length > 1) throw recoveryError('Multiple pending shipment records require recovery.');
    return records[0] || null;
  }
  let lease = null;
  const blockers = new Set(), listeners = new Set();
  const failure = (code, message) => ({ ok: false, error: { code, message } });
  const busy = () => failure('TRANSFER_BUSY', 'A transfer or restore is in progress. Shipment intent and records are locked until it settles.');
  function notify() { for (const listener of listeners) { try { listener(); } catch (_) { /* UI failure cannot release a lease. */ } } }
  function acquire(leaseId) {
    if (!validId(leaseId)) return failure('INVALID_LEASE', 'A valid host lease is required.');
    if (lease && lease !== leaseId) return busy();
    // Install first, before inspection or notification. Main drains accepted writes next.
    lease = leaseId; notify(); return { ok: true };
  }
  function inspect(leaseId) {
    if (!lease || lease !== leaseId) return failure('INVALID_LEASE', 'The recovery lock is missing or belongs to another operation.');
    try {
      if (readPendingShipment()) return failure('SHIPMENT_RECOVERY_BLOCKED', 'Resolve the retained shipment in its original profile before transfer or restore. Never clear or copy its pending intent.');
      for (const blocker of blockers) {
        const error = blocker();
        if (error) return failure('SHIPMENT_RECOVERY_BLOCKED', typeof error === 'string' ? error : error.message || 'Shipment recovery is unresolved.');
      }
      return { ok: true };
    } catch (_) { return failure('SHIPMENT_RECOVERY_BLOCKED', 'Pending shipment storage is inaccessible, corrupt, changed, or contains multiple intents. Preserve this profile and resolve recovery before transfer.'); }
  }
  function release(leaseId) {
    if (!lease || lease !== leaseId) return failure('INVALID_LEASE', 'Only the owning host operation can release recovery.');
    lease = null; notify(); return { ok: true };
  }
  global.FarmRecovery = Object.freeze({
    acquire, inspect, release, pendingRecord, readPendingShipment, shipmentStorageKey, recoveryError, validId, quantity,
    isLocked: () => lease !== null,
    assertUnlocked() { if (lease) throw busy().error; },
    registerBlocker(fn) { if (typeof fn !== 'function') throw new TypeError('A recovery blocker is required.'); blockers.add(fn); return () => blockers.delete(fn); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  });
})(window);
