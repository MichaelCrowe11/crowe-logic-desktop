'use strict';

const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const v = require('./validation');
const { initialize, SCHEMA_VERSION, TABLES } = require('./schema');

const LOT_FIELDS = ['harvestDate', 'room', 'species', 'quantityLbs', 'notes'];
const LOG_FIELDS = ['loggedAt', 'room', 'temperatureF', 'humidityPercent', 'cleaningCompleted', 'lotId', 'deviationNotes', 'correctiveAction'];
const FIELDS = Object.freeze({
  snapshot: [], 'facility.save': ['name', 'ownerName', 'address', 'emergencyPhone', 'waterSource'],
  'lot.create': LOT_FIELDS, 'lot.adopt': [...LOT_FIELDS, 'sourceId', 'sourceSnapshot'],
  'lot.correct': ['id', 'expectedVersion', 'reason', ...LOT_FIELDS],
  'customer.create': ['name', 'contact', 'email', 'phone', 'address'],
  'shipment.create': ['requestId', 'customerId', 'shippedAt', 'items', 'notes'],
  'log.create': LOG_FIELDS, 'log.update': ['id', 'expectedVersion', 'reason', ...LOG_FIELDS],
  'log.resolve': ['id', 'expectedVersion', 'correctiveAction', 'reason'], 'log.reopen': ['id', 'expectedVersion', 'reason'],
  'document.create': ['title', 'type', 'content'], 'document.edit': ['id', 'revisionId', 'expectedVersion', 'title', 'content', 'reason'],
  'document.submit': ['id', 'revisionId', 'expectedVersion'], 'document.approve': ['id', 'revisionId', 'expectedVersion', 'attestation'],
  'document.revise': ['id', 'reason'], recall: ['lotId'], audit: ['entityId'], 'backup.export': [], 'backup.restore': ['backup', 'confirmation'],
});
const ACTIONS = Object.freeze(Object.keys(FIELDS));
const READS = new Set(['snapshot', 'recall', 'audit', 'backup.export']);
const parse = value => value === null ? null : JSON.parse(value);
const encode = value => value === null ? null : JSON.stringify(value);
const optional = (value, field, max = 500) => v.text(value, field, { optional: true, max });
const reason = value => v.text(value, 'reason', { max: 5000 });
const clone = value => JSON.parse(JSON.stringify(value));
function equal(a, b) { return v.canonical(a) === v.canonical(b); }

class FarmStore {
  constructor({ filename } = {}) {
    if (typeof filename !== 'string' || !filename || filename.includes('\0')) v.fail('VALIDATION', 'A farm database filename is required.');
    this.closed = false;
    try {
      if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
      this.db = new DatabaseSync(filename);
      initialize(this.db);
    } catch (error) {
      if (this.db) this.db.close();
      if (error instanceof v.FarmError) throw error;
      v.fail('CORRUPT_STORE', 'Farm database could not be opened or validated. Existing records were not reset.');
    }
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  one(sql, ...args) { return this.db.prepare(sql).get(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  insert(table, row) {
    const columns = Object.keys(row);
    return this.run(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, ...columns.map(k => row[k]));
  }
  update(table, id, row) { this.run(`UPDATE ${table} SET ${Object.keys(row).map(k => `${k}=?`).join(',')} WHERE id=?`, ...Object.values(row), id); }
  operator() { return { ...this.one('SELECT id,name FROM operator') }; }
  newId(prefix) {
    const next = this.replay ? this.replay.ids.shift() : `${prefix}_${randomUUID()}`;
    if (typeof next !== 'string' || !next.startsWith(prefix + '_')) v.fail('INVALID_BACKUP', 'Invalid generated record identity in history.');
    v.id(next);
    this.context.ids.push(next);
    return next;
  }
  need(table, id) {
    v.id(id);
    const row = this.one(`SELECT * FROM ${table} WHERE id=?`, id);
    if (!row) v.fail('NOT_FOUND', 'The requested farm record does not exist.');
    return row;
  }
  expect(actual, expected) { if (actual !== v.version(expected)) v.fail('CONFLICT', 'This record changed. Reload it before saving.'); }
  event(entityId, action, before, after, why = '') {
    const id = this.newId('event');
    this.insert('audit', { id, entity_id: entityId, action, actor: encode(this.context.actor), timestamp: this.context.time,
      reason: why, before_record: encode(before), after_record: encode(after),
      command: encode({ payload: this.context.payload, ids: this.context.ids }) });
  }
  handle(action, payload = {}) {
    if (this.closed) v.fail('UNAVAILABLE', 'Farm storage is closed.');
    if (typeof action !== 'string' || !Object.hasOwn(FIELDS, action)) v.fail('VALIDATION', 'Unknown farm action.');
    if (action === 'backup.restore') return this.restore(payload);
    v.json(payload); v.keys(payload, FIELDS[action]);
    let begun = false;
    try {
      this.db.exec(READS.has(action) ? 'BEGIN' : 'BEGIN IMMEDIATE'); begun = true;
      this.context = { actor: this.operator(), time: this.replay ? this.replay.timestamp : new Date().toISOString(), payload: clone(payload), ids: [] };
      if (this.replay && !equal(this.replay.actor, this.context.actor)) v.fail('INVALID_BACKUP', 'Audit actor does not match the local operator at this point in history.');
      let result;
      switch (action) {
        case 'snapshot': result = this.snapshot(); break;
        case 'facility.save': result = this.saveFacility(payload); break;
        case 'lot.create': case 'lot.adopt': result = this.createLot(payload, action); break;
        case 'lot.correct': result = this.correctLot(payload); break;
        case 'customer.create': result = this.createCustomer(payload); break;
        case 'shipment.create': result = this.createShipment(payload); break;
        case 'log.create': result = this.createLog(payload); break;
        case 'log.update': case 'log.resolve': case 'log.reopen': result = this.changeLog(payload, action); break;
        case 'document.create': result = this.createDocument(payload); break;
        case 'document.edit': case 'document.submit': case 'document.approve': case 'document.revise': result = this.changeDocument(payload, action); break;
        case 'recall': result = this.recall(v.id(payload.lotId, 'lotId')); break;
        case 'audit': result = this.audit(payload); break;
        case 'backup.export': result = this.exportBackup(); break;
      }
      if (this.replay && this.replay.ids.length) v.fail('INVALID_BACKUP', 'Unexpected record identities in history.');
      if (!READS.has(action) && !this.replay) this.ensureBackupCapacity();
      this.db.exec('COMMIT'); begun = false;
      return result;
    } catch (error) {
      if (begun) this.db.exec('ROLLBACK');
      if (error instanceof v.FarmError) throw error;
      if (/database is locked|database is busy/.test(error.message)) v.fail('CONFLICT', 'Farm storage is busy. Retry the operation.');
      v.fail('INTERNAL', 'Farm operation failed and was rolled back.');
    } finally { this.context = null; }
  }
  facility() {
    const r = this.one('SELECT * FROM facility');
    return r ? { id: r.id, name: r.name, ownerName: r.owner_name, address: r.address, emergencyPhone: r.emergency_phone, waterSource: r.water_source, createdAt: r.created_at, updatedAt: r.updated_at } : null;
  }
  saveFacility(p) {
    const before = this.facility();
    const fields = { name: v.text(p.name, 'name'), owner_name: v.text(p.ownerName, 'ownerName'), address: optional(p.address, 'address'),
      emergency_phone: optional(p.emergencyPhone, 'emergencyPhone'), water_source: optional(p.waterSource, 'waterSource'), updated_at: this.context.time };
    if (before) this.update('facility', before.id, fields);
    else this.insert('facility', { id: this.newId('facility'), ...fields, created_at: this.context.time });
    this.run('UPDATE operator SET name=?', fields.owner_name);
    const after = this.facility(); this.event(after.id, 'facility.save', before, after); return after;
  }
  lotFields(p) {
    return { harvestDate: v.date(p.harvestDate, 'harvestDate'), room: v.text(p.room, 'room'), species: v.text(p.species, 'species'),
      quantityLbs: v.pounds(v.units(p.quantityLbs)), notes: optional(p.notes, 'notes', 5000) };
  }
  source(p) {
    const sourceId = v.id(p.sourceId, 'sourceId');
    // Source evidence is the complete host-reread row, not our reviewed DTO.
    // handle() already validates bounded, finite, acyclic plain JSON, including
    // nested extensions. Retain those facts without coercion or field stripping.
    const raw = p.sourceSnapshot;
    if (!v.plain(raw) || !Object.hasOwn(raw, 'id')) v.fail('VALIDATION', 'Legacy source must be an object with its original ID.');
    if (raw.id !== v.id(raw.id) || sourceId !== 'legacy-flush:' + raw.id) v.fail('VALIDATION', 'sourceId must match the exact legacy harvest ID.');
    return { sourceId, sourceSnapshot: clone(p.sourceSnapshot), sourceReviewedBy: this.context.actor,
      sourceApprovedAt: this.context.time, sourceHash: v.hash(p.sourceSnapshot) };
  }
  createLot(p, action) {
    const fields = this.lotFields(p);
    const provenance = action === 'lot.adopt' ? this.source(p) : {};
    if (provenance.sourceId && this.one('SELECT id FROM lots WHERE source_id=?', provenance.sourceId)) v.fail('DUPLICATE_SOURCE', 'This legacy harvest has already been adopted.');
    const id = this.newId('lot');
    const lotCode = 'LOT-' + fields.harvestDate.replaceAll('-', '') + '-' + id.slice(4).toUpperCase();
    const original = { id, lotCode, version: 1, ...fields, ...provenance, createdAt: this.context.time };
    this.insert('lots', { id, lot_code: lotCode, harvest_date: fields.harvestDate, room: fields.room, species: fields.species,
      quantity: v.units(fields.quantityLbs), notes: fields.notes, created_at: this.context.time,
      source_id: provenance.sourceId ?? null, source_snapshot: encode(provenance.sourceSnapshot ?? null), source_reviewer: encode(provenance.sourceReviewedBy ?? null),
      source_approved_at: provenance.sourceApprovedAt ?? null, source_hash: provenance.sourceHash ?? null, original_record: encode(original) });
    const after = this.lot(id); this.event(id, action, null, after); return after;
  }
  lot(id) {
    const r = this.need('lots', id);
    const rows = this.all('SELECT * FROM lot_corrections WHERE lot_id=? ORDER BY version', id);
    const last = rows.at(-1) || r;
    const shipped = this.one('SELECT COALESCE(SUM(quantity),0) AS n FROM shipment_items WHERE lot_id=?', id).n;
    return { id, lotCode: r.lot_code, version: rows.length + 1, harvestDate: last.harvest_date, room: last.room, species: last.species,
      quantityLbs: v.pounds(last.quantity), shippedLbs: v.pounds(shipped), remainingLbs: v.pounds(last.quantity - shipped), notes: last.notes,
      ...(r.source_id === null ? {} : { sourceId: r.source_id, sourceSnapshot: parse(r.source_snapshot), sourceReviewedBy: parse(r.source_reviewer), sourceApprovedAt: r.source_approved_at, sourceHash: r.source_hash }),
      originalRecord: parse(r.original_record), corrections: rows.map(c => ({ id: c.id, version: c.version, before: parse(c.before_record), after: parse(c.after_record), actor: parse(c.actor), timestamp: c.timestamp, reason: c.reason })), createdAt: r.created_at };
  }
  lotRecord(lot) {
    const { shippedLbs, remainingLbs, originalRecord, corrections, ...record } = lot;
    return record;
  }
  correctLot(p) {
    const before = this.lot(v.id(p.id)); this.expect(before.version, p.expectedVersion); const why = reason(p.reason);
    if (!LOT_FIELDS.some(k => Object.hasOwn(p, k))) v.fail('VALIDATION', 'Supply at least one harvest fact to correct.');
    const fields = this.lotFields({ ...before, ...p });
    if (BigInt(fields.quantityLbs.replace('.', '')) < BigInt(before.shippedLbs.replace('.', ''))) v.fail('INSUFFICIENT_QUANTITY', 'Corrected quantity cannot be below the amount already shipped.');
    const afterRecord = { ...this.lotRecord(before), ...fields, version: before.version + 1 };
    if (LOT_FIELDS.every(k => fields[k] === before[k])) v.fail('VALIDATION', 'The correction must change a harvest fact.');
    this.insert('lot_corrections', { id: this.newId('correction'), lot_id: before.id, version: afterRecord.version,
      harvest_date: fields.harvestDate, room: fields.room, species: fields.species, quantity: v.units(fields.quantityLbs), notes: fields.notes,
      before_record: encode(this.lotRecord(before)), after_record: encode(afterRecord), actor: encode(this.context.actor), timestamp: this.context.time, reason: why });
    const after = this.lot(before.id); this.event(before.id, 'lot.correct', before, after, why); return after;
  }
  customer(id) {
    const r = this.need('customers', id);
    return { id: r.id, name: r.name, contact: r.contact, email: r.email, phone: r.phone, address: r.address, createdAt: r.created_at };
  }
  createCustomer(p) {
    const row = { id: this.newId('customer'), name: v.text(p.name, 'name'), contact: optional(p.contact, 'contact'), email: optional(p.email, 'email'),
      phone: optional(p.phone, 'phone'), address: optional(p.address, 'address'), created_at: this.context.time };
    this.insert('customers', row); const after = this.customer(row.id); this.event(row.id, 'customer.create', null, after); return after;
  }
  shipment(id) {
    const r = this.need('shipments', id);
    return { id, customerId: r.customer_id, customer: parse(r.customer_snapshot), shippedAt: r.shipped_at,
      items: this.all('SELECT * FROM shipment_items WHERE shipment_id=? ORDER BY position', id).map(i => ({ lotId: i.lot_id, lotCode: i.lot_code, quantityLbs: v.pounds(i.quantity), lotSnapshot: parse(i.lot_snapshot) })), notes: r.notes, createdAt: r.created_at };
  }
  shipmentPayload(p) {
    const requestId = v.id(p.requestId, 'requestId'), customerId = v.id(p.customerId, 'customerId');
    const shippedAt = v.instant(p.shippedAt, 'shippedAt');
    if (!Array.isArray(p.items) || p.items.length < 1 || p.items.length > 1000) v.fail('VALIDATION', 'A shipment requires between 1 and 1000 lot items.');
    const seen = new Set();
    const items = p.items.map(i => {
      v.keys(i, ['lotId', 'quantityLbs'], ['lotId', 'quantityLbs']);
      const lotId = v.id(i.lotId, 'lotId');
      if (seen.has(lotId)) v.fail('VALIDATION', 'Duplicate lot IDs are not permitted within one shipment.');
      seen.add(lotId); return { lotId, quantityLbs: v.pounds(v.units(i.quantityLbs)) };
    });
    return { requestId, customerId, shippedAt, items, notes: optional(p.notes, 'notes', 5000) };
  }
  createShipment(input) {
    const p = this.shipmentPayload(input), payloadHash = v.hash(p);
    const existing = this.one('SELECT id,payload_hash FROM shipments WHERE request_id=?', p.requestId);
    if (existing) {
      if (existing.payload_hash !== payloadHash) v.fail('CONFLICT', 'This shipment request ID was already used with different content.');
      return this.shipment(existing.id);
    }
    const { id: customerId, createdAt, ...customer } = this.customer(p.customerId);
    const id = this.newId('shipment');
    this.insert('shipments', { id, request_id: p.requestId, payload_hash: payloadHash, customer_id: customerId, customer_snapshot: encode(customer), shipped_at: p.shippedAt, notes: p.notes, created_at: this.context.time });
    for (let position = 0; position < p.items.length; position++) {
      const item = p.items[position], lot = this.lot(item.lotId), quantity = v.units(item.quantityLbs);
      const remaining = BigInt(lot.remainingLbs.replace('.', ''));
      if (BigInt(quantity) > remaining) v.fail('INSUFFICIENT_QUANTITY', 'A selected lot does not have enough remaining quantity. No shipment was recorded.');
      this.insert('shipment_items', { shipment_id: id, position, lot_id: lot.id, quantity, lot_code: lot.lotCode, lot_snapshot: encode(lot) });
    }
    const after = this.shipment(id); this.event(id, 'shipment.create', null, after); return after;
  }
  log(id) {
    const r = this.need('logs', id);
    return { id, version: r.version, loggedAt: r.logged_at, room: r.room, temperatureF: r.temperature_f, humidityPercent: r.humidity_percent,
      cleaningCompleted: !!r.cleaning_completed, lotId: r.lot_id, deviationNotes: r.deviation_notes, correctiveAction: r.corrective_action,
      deviationStatus: r.deviation_status, resolvedAt: r.resolved_at, resolvedBy: parse(r.resolved_by), createdAt: r.created_at, updatedAt: r.updated_at };
  }
  logFields(p) {
    if (typeof p.cleaningCompleted !== 'boolean') v.fail('VALIDATION', 'cleaningCompleted must be true or false.');
    const lotId = p.lotId === undefined || p.lotId === null ? null : v.id(p.lotId, 'lotId');
    if (lotId !== null) this.need('lots', lotId);
    return { logged_at: v.date(p.loggedAt, 'loggedAt'), room: v.text(p.room, 'room'), temperature_f: v.measured(p.temperatureF, 'temperatureF', -100, 250),
      humidity_percent: v.measured(p.humidityPercent, 'humidityPercent', 0, 100), cleaning_completed: Number(p.cleaningCompleted), lot_id: lotId,
      deviation_notes: optional(p.deviationNotes, 'deviationNotes', 5000), corrective_action: optional(p.correctiveAction, 'correctiveAction', 5000) };
  }
  createLog(p) {
    const fields = this.logFields(p), id = this.newId('log');
    this.insert('logs', { id, version: 1, ...fields, deviation_status: fields.deviation_notes ? 'OPEN' : 'NONE', resolved_at: null, resolved_by: null,
      created_at: this.context.time, updated_at: this.context.time });
    const after = this.log(id); this.event(id, 'log.create', null, after); return after;
  }
  changeLog(p, action) {
    const before = this.log(v.id(p.id)); this.expect(before.version, p.expectedVersion); const why = reason(p.reason);
    const fields = { version: before.version + 1, updated_at: this.context.time };
    if (action === 'log.update') {
      if (!LOG_FIELDS.some(k => Object.hasOwn(p, k))) v.fail('VALIDATION', 'Supply at least one log field to edit.');
      Object.assign(fields, this.logFields({ ...before, ...p }));
      if (before.deviationNotes && !fields.deviation_notes) v.fail('INVALID_STATE', 'An existing deviation cannot be erased by editing its notes.');
      if (before.deviationStatus === 'RESOLVED' && (fields.corrective_action !== before.correctiveAction || fields.deviation_notes !== before.deviationNotes)) v.fail('INVALID_STATE', 'Reopen the deviation before changing its notes or corrective action.');
      fields.deviation_status = before.deviationStatus === 'NONE' && fields.deviation_notes ? 'OPEN' : before.deviationStatus;
    } else if (action === 'log.resolve') {
      if (before.deviationStatus !== 'OPEN') v.fail('INVALID_STATE', 'Only an open deviation can be resolved.');
      Object.assign(fields, { corrective_action: v.text(p.correctiveAction, 'correctiveAction', { max: 5000 }), deviation_status: 'RESOLVED', resolved_at: this.context.time, resolved_by: encode(this.context.actor) });
    } else {
      if (before.deviationStatus !== 'RESOLVED') v.fail('INVALID_STATE', 'Only a resolved deviation can be reopened.');
      Object.assign(fields, { deviation_status: 'OPEN', resolved_at: null, resolved_by: null });
    }
    this.update('logs', before.id, fields); const after = this.log(before.id); this.event(before.id, action, before, after, why); return after;
  }
  document(id) {
    const r = this.need('documents', id);
    return { id, title: r.title, type: r.type, revisions: this.all('SELECT * FROM document_revisions WHERE document_id=? ORDER BY version', id).map(x => ({
      id: x.id, version: x.version, editVersion: x.edit_version, title: x.title, content: x.content, status: x.status, createdAt: x.created_at, updatedAt: x.updated_at,
      submittedAt: x.submitted_at, approvedAt: x.approved_at, approvedBy: parse(x.approved_by), contentHash: x.content_hash,
      supersedesRevisionId: x.supersedes_revision_id, supersededByRevisionId: x.superseded_by_revision_id })) };
  }
  draft(documentId, version, title, content) {
    const id = this.newId('revision');
    this.insert('document_revisions', { id, document_id: documentId, version, edit_version: 1, title, content, status: 'DRAFT', created_at: this.context.time,
      updated_at: this.context.time, submitted_at: null, approved_at: null, approved_by: null, content_hash: null, supersedes_revision_id: null, superseded_by_revision_id: null });
    return id;
  }
  createDocument(p) {
    const title = v.text(p.title, 'title'), content = v.text(p.content, 'content', { max: 100000 });
    if (!v.DOCUMENT_TYPES.includes(p.type)) v.fail('VALIDATION', 'Select a supported document type.');
    const id = this.newId('document'); this.insert('documents', { id, title, type: p.type }); this.draft(id, 1, title, content);
    const after = this.document(id); this.event(id, 'document.create', null, after); return after;
  }
  changeDocument(p, action) {
    const before = this.document(v.id(p.id));
    let why = '';
    if (action === 'document.revise') {
      why = reason(p.reason);
      if (before.revisions.some(r => ['DRAFT', 'NEEDS_REVIEW'].includes(r.status))) v.fail('CONFLICT', 'This document already has an active draft or review revision.');
      const current = before.revisions.find(r => r.status === 'APPROVED');
      if (!current) v.fail('INVALID_STATE', 'Approve a document revision before creating a successor.');
      this.draft(before.id, before.revisions.at(-1).version + 1, current.title, current.content);
    } else {
      const revisionId = v.id(p.revisionId, 'revisionId'), r = before.revisions.find(x => x.id === revisionId);
      if (!r) v.fail('NOT_FOUND', 'The requested document revision does not exist.');
      this.expect(r.editVersion, p.expectedVersion);
      const fields = { edit_version: r.editVersion + 1, updated_at: this.context.time };
      if (action === 'document.edit') {
        why = reason(p.reason);
        if (!['DRAFT', 'NEEDS_REVIEW'].includes(r.status)) v.fail('INVALID_STATE', 'Approved or superseded content is immutable. Create a successor draft.');
        Object.assign(fields, { title: v.text(p.title, 'title'), content: v.text(p.content, 'content', { max: 100000 }), status: 'DRAFT', submitted_at: null });
        this.update('documents', before.id, { title: fields.title });
      } else if (action === 'document.submit') {
        if (r.status !== 'DRAFT') v.fail('INVALID_STATE', 'Only a draft can be submitted for local owner review.');
        Object.assign(fields, { status: 'NEEDS_REVIEW', submitted_at: this.context.time });
      } else {
        if (p.attestation !== true) v.fail('VALIDATION', 'Explicit local owner review attestation is required.');
        if (r.status !== 'NEEDS_REVIEW') v.fail('INVALID_STATE', 'Submit the draft for review before approving it.');
        const prior = before.revisions.find(x => x.status === 'APPROVED');
        if (prior) this.update('document_revisions', prior.id, { status: 'SUPERSEDED', edit_version: prior.editVersion + 1, superseded_by_revision_id: r.id, updated_at: this.context.time });
        Object.assign(fields, { status: 'APPROVED', approved_at: this.context.time, approved_by: encode(this.context.actor),
          content_hash: v.hash({ title: r.title, content: r.content }), supersedes_revision_id: prior?.id ?? null });
      }
      this.update('document_revisions', r.id, fields);
    }
    const after = this.document(before.id); this.event(before.id, action, before, after, why); return after;
  }
  recall(lotId) {
    const lot = this.lot(lotId);
    const affectedShipments = this.all('SELECT shipment_id,quantity,lot_snapshot FROM shipment_items WHERE lot_id=? ORDER BY rowid', lotId).map(i => {
      const s = this.shipment(i.shipment_id);
      return { shipmentId: s.id, shippedAt: s.shippedAt, customer: s.customer, quantityLbs: v.pounds(i.quantity), notes: s.notes, lotSnapshot: parse(i.lot_snapshot) };
    });
    return { lot, affectedShipments, totalShippedLbs: lot.shippedLbs, remainingLbs: lot.remainingLbs };
  }
  audit(p) {
    const rows = p.entityId === undefined ? this.all('SELECT * FROM audit ORDER BY sequence') : this.all('SELECT * FROM audit WHERE entity_id=? ORDER BY sequence', v.id(p.entityId, 'entityId'));
    return rows.map(r => ({ id: r.id, entityId: r.entity_id, actor: parse(r.actor), timestamp: r.timestamp, action: r.action, reason: r.reason, before: parse(r.before_record), after: parse(r.after_record) }));
  }
  snapshot() {
    const list = (table, method) => this.all(`SELECT id FROM ${table} ORDER BY rowid`).map(r => this[method](r.id));
    const lots = list('lots', 'lot'), customers = list('customers', 'customer'), shipments = list('shipments', 'shipment'), logs = list('logs', 'log'), documents = list('documents', 'document');
    return { facility: this.facility(), lots, customers, shipments, logs, documents,
      dashboard: { lotsCreated: lots.length, shipmentsRecorded: shipments.length, openDeviations: logs.filter(l => l.deviationStatus === 'OPEN').length,
        documentsAwaitingApproval: documents.reduce((n, d) => n + d.revisions.filter(r => r.status === 'NEEDS_REVIEW').length, 0), recentLots: lots.slice(-5).reverse(), recentShipments: shipments.slice(-5).reverse() },
      storage: { kind: 'desktop-local', schemaVersion: SCHEMA_VERSION, operator: this.operator(), notice: 'Desktop-local single-owner records. Actor attribution is a local profile, not verified identity or a regulatory electronic signature. Back up this device; administrator tampering is outside this integrity guarantee. Writes stop before exceeding the 10 MiB JSON recovery capacity; no history is pruned.' } };
  }
  rawTables() { return Object.fromEntries(TABLES.map(t => [t, this.all(`SELECT * FROM ${t} ORDER BY rowid`).map(r => ({ ...r }))])); }
  exportBackup() {
    const body = { format: 'crowe-farm-backup', schemaVersion: SCHEMA_VERSION, exportedAt: this.context.time, tables: this.rawTables() };
    try { v.json(body, v.MAX_BACKUP_BYTES); } catch (error) { if (error instanceof v.FarmError && error.code === 'VALIDATION') v.fail('INVALID_BACKUP', 'Farm backup exceeds the supported JSON size or structure limits (10 MiB maximum).'); throw error; }
    const backup = { ...body, checksum: v.hash(body) };
    try { v.json(backup, v.MAX_BACKUP_BYTES); } catch (error) { if (error instanceof v.FarmError && error.code === 'VALIDATION') v.fail('INVALID_BACKUP', 'Farm backup exceeds the supported JSON size or structure limits (10 MiB maximum).'); throw error; }
    return backup;
  }
  ensureBackupCapacity() {
    // A write includes its full audit evidence. Do not commit records which the
    // only supported recovery format cannot export. Historical replay skips
    // this scan; restore checks once more after adding its own audit receipt.
    try { this.exportBackup(); }
    catch (error) {
      if (error instanceof v.FarmError && error.code === 'INVALID_BACKUP') v.fail('BACKUP_CAPACITY', 'This change would exceed the supported 10 MiB backup capacity and was not saved. Export the current records; a higher-capacity storage version is required before adding more history.');
      throw error;
    }
  }
  isEmpty() { return TABLES.filter(t => t !== 'operator').every(t => !this.one(`SELECT 1 FROM ${t} LIMIT 1`)); }
  validateBackup(input) {
    let backup = input;
    if (typeof input === 'string') {
      if (Buffer.byteLength(input, 'utf8') > v.MAX_BACKUP_BYTES) v.fail('INVALID_BACKUP', 'Backup exceeds 10 MiB.');
      backup = JSON.parse(input);
    }
    v.json(backup, v.MAX_BACKUP_BYTES);
    v.keys(backup, ['format', 'schemaVersion', 'exportedAt', 'tables', 'checksum'], ['format', 'schemaVersion', 'exportedAt', 'tables', 'checksum']);
    const { checksum, ...body } = backup;
    if (backup.format !== 'crowe-farm-backup' || backup.schemaVersion !== SCHEMA_VERSION || typeof checksum !== 'string' || checksum !== v.hash(body)) v.fail('INVALID_BACKUP', 'Backup format, schema version, or checksum is invalid.');
    v.instant(backup.exportedAt, 'exportedAt'); v.keys(backup.tables, TABLES, TABLES);
    for (const table of TABLES) if (!Array.isArray(backup.tables[table])) v.fail('INVALID_BACKUP', 'Backup tables must be arrays.');
    if (backup.tables.operator.length !== 1) v.fail('INVALID_BACKUP', 'Backup must preserve one local operator.');
    const operator = backup.tables.operator[0]; v.keys(operator, ['id', 'name'], ['id', 'name']); v.id(operator.id); v.text(operator.name, 'operator name');
    return backup;
  }
  // A checksum is only an accidental-corruption check. Replaying the complete
  // command ledger in a separate SQLite store validates FKs, domain transitions,
  // versions, allocations, immutable snapshots, hashes, actor history and audit
  // before/after images together, including hostile files with fresh checksums.
  stageBackup(backup) {
    const stage = new FarmStore({ filename: ':memory:' });
    try {
      stage.run('UPDATE operator SET id=?', backup.tables.operator[0].id);
      for (const event of backup.tables.audit) {
        const command = parse(event.command);
        v.keys(command, ['payload', 'ids'], ['payload', 'ids']);
        if (!Array.isArray(command.ids) || !command.ids.length || command.ids.some(id => typeof id !== 'string')) v.fail('INVALID_BACKUP', 'Audit generated identities are invalid.');
        const actor = parse(event.actor); v.keys(actor, ['id', 'name'], ['id', 'name']); v.id(actor.id); v.text(actor.name, 'actor name');
        if (v.instant(event.timestamp) !== event.timestamp) v.fail('INVALID_BACKUP', 'Audit timestamp is not canonical.');
        stage.replay = { ids: [...command.ids], timestamp: event.timestamp, actor };
        if (event.action === 'backup.restore') {
          v.keys(command.payload, ['checksum', 'counts', 'exportedAt'], ['checksum', 'counts', 'exportedAt']);
          v.instant(command.payload.exportedAt, 'exportedAt');
          const priorBody = { format: 'crowe-farm-backup', schemaVersion: SCHEMA_VERSION, exportedAt: command.payload.exportedAt, tables: stage.rawTables() };
          if (command.payload.checksum !== v.hash(priorBody) || !equal(command.payload.counts, stage.counts()) || !equal(actor, stage.operator())) v.fail('INVALID_BACKUP', 'Restore audit receipt is invalid.');
          stage.db.exec('BEGIN IMMEDIATE');
          stage.context = { actor, time: event.timestamp, payload: command.payload, ids: [] };
          stage.event('farm', 'backup.restore', null, command.payload, 'Restored validated backup into an empty local store.');
          if (stage.replay.ids.length) v.fail('INVALID_BACKUP', 'Restore audit identities are invalid.');
          stage.db.exec('COMMIT'); stage.context = null;
        } else {
          if (!ACTIONS.includes(event.action) || READS.has(event.action)) v.fail('INVALID_BACKUP', 'Unsupported audit action.');
          stage.handle(event.action, command.payload);
        }
        stage.replay = null;
      }
      if (!equal(stage.rawTables(), backup.tables)) v.fail('INVALID_BACKUP', 'Backup records do not match their complete, valid audit history.');
      if (stage.one('PRAGMA foreign_key_check') || stage.one('PRAGMA integrity_check').integrity_check !== 'ok') v.fail('INVALID_BACKUP', 'Backup relational integrity failed.');
      return stage;
    } catch (error) { stage.close(); throw error; }
  }
  counts() {
    return Object.fromEntries(['lots', 'customers', 'shipments', 'logs', 'documents'].map(t => [t, this.one(`SELECT COUNT(*) AS n FROM ${t}`).n]));
  }
  restore(p) {
    let backup, stage;
    v.keys(p, FIELDS['backup.restore'], ['backup', 'confirmation']);
    if (Object.values(Object.getOwnPropertyDescriptors(p)).some(d => !Object.hasOwn(d, 'value'))) v.fail('VALIDATION', 'JSON accessors are not accepted.');
    if (p.confirmation !== 'RESTORE EMPTY FARM') v.fail('VALIDATION', 'Type RESTORE EMPTY FARM to restore into an empty store.');
    try {
      // A JSON-string backup is accepted internally too; do not count its
      // escaped wrapper representation against the file's UTF-8 byte limit.
      if (typeof p.backup !== 'string') v.json(p, v.MAX_BACKUP_BYTES + 4096);
      backup = this.validateBackup(p.backup); stage = this.stageBackup(backup);
    } catch {
      v.fail('INVALID_BACKUP', 'Backup validation failed. The target farm was not changed.');
    }
    let begun = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); begun = true;
      if (!this.isEmpty()) v.fail('STORE_NOT_EMPTY', 'Restore is allowed only into an empty farm. Existing records were not changed.');
      this.db.exec('PRAGMA defer_foreign_keys=ON');
      const tables = stage.rawTables();
      this.run('UPDATE operator SET id=?,name=?', tables.operator[0].id, tables.operator[0].name);
      for (const table of TABLES.filter(t => t !== 'operator')) for (const row of tables[table]) this.insert(table, row);
      if (this.one('PRAGMA foreign_key_check')) v.fail('INVALID_BACKUP', 'Backup relational integrity failed.');
      const counts = this.counts(), receipt = { checksum: backup.checksum, counts, exportedAt: backup.exportedAt };
      this.context = { actor: this.operator(), time: new Date().toISOString(), payload: receipt, ids: [] };
      this.event('farm', 'backup.restore', null, receipt, 'Restored validated backup into an empty local store.');
      this.ensureBackupCapacity();
      this.db.exec('COMMIT'); begun = false; return counts;
    } catch (error) {
      if (begun) this.db.exec('ROLLBACK');
      if (error instanceof v.FarmError) throw error;
      v.fail('INVALID_BACKUP', 'Backup restore failed. The target farm was not changed.');
    } finally { stage.close(); this.context = null; }
  }
}
module.exports = { FarmStore, ACTIONS, DOCUMENT_TYPES: v.DOCUMENT_TYPES, MAX_BACKUP_BYTES: v.MAX_BACKUP_BYTES, MAX_PAYLOAD_BYTES: v.MAX_PAYLOAD_BYTES };
