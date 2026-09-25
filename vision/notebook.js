'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const notebook = require('../grow-transfer');
const { readBounded, directory, stamp } = require('./io');
const { fault, hash, fields, text } = require('./validation');
const digestPattern = /^[0-9a-f]{64}$/;
function receipt(value) {
  fields(value, ['key', 'digest']); text(value.key, 100, 'save key');
  if (!digestPattern.test(value.digest)) throw fault('VALIDATION', 'Invalid save digest.');
  return value;
}
function readRows(userData, type) {
  notebook.assertReady(userData);
  if (!fs.existsSync(path.join(userData, 'grow'))) return { rows: [], bytes: Buffer.from('[]'), stamp: null };
  const source = readBounded(path.join(userData, 'grow', `${type}.json`), notebook.LIMITS.fileBytes, true);
  return { ...source, rows: notebook.parseNotebookRows(source.bytes) };
}
function readTarget(userData, target) {
  const { rows } = readRows(userData, target.type);
  const row = rows.find(r => r.id === target.id);
  if (!row) throw fault('TARGET_MISSING', 'The selected notebook record no longer exists.');
  return { row, digest: hash(row) };
}
// Ordinary notebook APIs may neither forge nor amend generated evidence. A
// reviewer can add a separate ordinary note; the original model text stays put.
function guardOrdinary(rows, recordOrId) {
  const id = typeof recordOrId === 'string' ? recordOrId : recordOrId?.id;
  if ((recordOrId && typeof recordOrId === 'object' && Object.hasOwn(recordOrId, 'vision')) || rows.some(row => row.id === id && Object.hasOwn(row, 'vision'))) throw fault('VISION_PROTECTED', 'Vision evidence cannot be edited or deleted here. Add a separate dated reviewer note; original findings and provenance are preserved.');
}
function matchReceipt(rows, expected) {
  receipt(expected);
  const matches = rows.filter(row => row.vision?.save?.key === expected.key);
  if (matches.length > 1) throw fault('SAVE_CORRUPT', 'The notebook contains ambiguous duplicate Vision save keys.');
  if (!matches.length) return null;
  const row = matches[0];
  const v = row.vision;
  if (v.save.digest !== expected.digest) throw fault('IDEMPOTENCY_CONFLICT', 'This save key is already bound to different observation content.');
  // The commit digest covers every persisted operation field, not just the
  // client's selections. It is a consistency check, not a cryptographic audit.
  const { save, ...operation } = v;
  if (hash(operation) !== save.digest || row.id !== save.rowId || row.entry !== operation.entry || row.subject !== operation.subject || row.date !== operation.date) throw fault('SAVE_CORRUPT', 'Stored Vision evidence was changed. Preserve the notebook and inspect it before retrying.');
  return row;
}
function createNotebook({ getUserData, assertAdmission = () => {}, onStep = () => {} }) {
  let committing = false;
  function admission() { assertAdmission(); if (committing) throw fault('NOTEBOOK_BUSY', 'A notebook evidence commit is in progress.'); }
  function reconcile(expected) {
    admission();
    const row = matchReceipt(readRows(getUserData(), 'log').rows, expected);
    return row ? { status: 'saved', id: row.id, receipt: expected } : { status: 'not-found', receipt: expected };
  }
  function append(operation, expected) {
    admission(); receipt(expected);
    if (hash(operation) !== expected.digest) throw fault('IDEMPOTENCY_CONFLICT', 'Save content changed after review.');
    committing = true;
    let temp, fd, dirfd, renamed = false;
    try {
      const userData = getUserData(), dir = path.join(userData, 'grow'), filename = path.join(dir, 'log.json');
      notebook.assertReady(userData);
      const parent = directory(dir);
      const source = readRows(userData, 'log');
      const existing = matchReceipt(source.rows, expected);
      if (existing) return { status: 'saved', id: existing.id, receipt: expected };
      if (readTarget(userData, operation.target).digest !== operation.targetSnapshotDigest) throw fault('TARGET_CHANGED', 'The selected notebook record changed. Inspect again before saving.');
      const now = Date.now(), id = `vision-${crypto.randomUUID()}`;
      const row = { id, createdAt: now, updatedAt: now, date: operation.date, subject: operation.subject, entry: operation.entry,
        vision: { ...operation, save: { ...expected, rowId: id } } };
      const bytes = Buffer.from(JSON.stringify([...source.rows, row], null, 2));
      notebook.parseNotebookRows(bytes); // seven-slot byte/row/depth limits
      dirfd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      fs.fsyncSync(dirfd); // unsupported directory durability fails pre-commit
      temp = path.join(dir, `.vision-${crypto.randomUUID()}.tmp`);
      fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.writeFileSync(fd, bytes); onStep('before-file-sync'); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
      onStep('before-commit');
      // Entire compare + replace is synchronous, with no await or event-loop
      // yield: the same main-process cooperating writer exclusion as growWrite.
      // External/noncooperating file writers are NOT an immutable history model.
      assertAdmission(); notebook.assertReady(userData);
      const currentParent = directory(dir);
      if (currentParent.dev !== parent.dev || currentParent.ino !== parent.ino) throw fault('SOURCE_CHANGED', 'Notebook directory changed.');
      let currentStamp = null;
      try { currentStamp = stamp(fs.lstatSync(filename, { bigint: true })); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (currentStamp !== source.stamp || readTarget(userData, operation.target).digest !== operation.targetSnapshotDigest) throw fault('TARGET_CHANGED', 'Notebook changed before the observation commit.');
      fs.renameSync(temp, filename); renamed = true; temp = null;
      onStep('after-rename'); fs.fsyncSync(dirfd);
      return { status: 'saved', id, receipt: expected };
    } catch (error) {
      if (renamed) throw fault('WRITE_OUTCOME_UNKNOWN', 'The observation may be saved. Reconcile the same save key and digest after restart; do not rerun Vision or create another note.');
      throw error;
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch {} }
      if (dirfd != null) { try { fs.closeSync(dirfd); } catch {} }
      if (temp) { try { fs.unlinkSync(temp); } catch {} }
      committing = false;
    }
  }
  return { readTarget: target => { admission(); return readTarget(getUserData(), target); }, append, reconcile, assertAdmission: admission };
}
module.exports = { createNotebook, readRows, guardOrdinary, receipt, matchReceipt };
