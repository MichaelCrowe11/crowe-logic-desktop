'use strict';
// Private append-only staging archive. Hashes are integrity checks, not an
// adversarial-user signature. External/noncooperating writers are unsupported.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const I = require('./index');
const { LIMITS, hash, digest, snapshot, fields, bounded, reject } = require('./safety');
const { directory, readBounded } = require('../vision/io');
const STORE_LIMITS = Object.freeze({ bytes: 128 * 1024 * 1024, imports: 64, revisions: 64, files: 4096 });
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function createImportStore(userData, { onStep = () => {} } = {}) {
  const root = path.join(userData, 'farm-imports');
  function initialize() {
    directory(userData);
    try { fs.mkdirSync(root, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    directory(root);
    const st = fs.lstatSync(root);
    if (!st.isDirectory() || st.isSymbolicLink() || (process.platform !== 'win32' && (st.mode & 0o077))) reject('UNSAFE_PATH', 'Import archive must be a real private directory.');
  }
  function inventory() {
    initialize();
    const names = fs.readdirSync(root);
    if (names.length > STORE_LIMITS.files) reject('STORE_CAPACITY', 'Local staging archive file limit reached.');
    let total = 0;
    for (const name of names) {
      const st = fs.lstatSync(path.join(root, name));
      if (name === '.lock' || name.startsWith('.pending-')) reject('STORE_RECOVERY_REQUIRED', 'An interrupted staging write needs local archive inspection. Do not retry the import automatically.');
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (process.platform !== 'win32' && (st.mode & 0o077))) reject('UNSAFE_FILE', 'Local staging archive contains an unsafe or non-private file.');
      if (!/^[0-9a-f-]+\.(?:source|r[1-9]\d*|h[a-f0-9]{64})\.json$/.test(name)) reject('STORE_CORRUPT', 'Unexpected file in local staging archive.');
      total += st.size;
    }
    if (total > STORE_LIMITS.bytes) reject('STORE_CAPACITY', 'Local staging archive byte limit reached.');
    return { names, total };
  }
  function writeNew(name, value, before) {
    const bytes = Buffer.from(JSON.stringify(snapshot(value)));
    if (before.total + bytes.length > STORE_LIMITS.bytes) reject('STORE_CAPACITY', 'Local staging archive would exceed 128 MiB.');
    const parent = directory(root), lockPath = path.join(root, '.lock'), target = path.join(root, name);
    let lock, fd, dirfd, temp, published = false;
    try {
      try { lock = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600); }
      catch (e) { if (e.code === 'EEXIST') reject('STORE_RECOVERY_REQUIRED', 'Another or interrupted archive writer holds the staging lock.'); throw e; }
      dirfd = fs.openSync(root, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      fs.fsyncSync(dirfd); // fail before publication if directory durability unsupported
      temp = path.join(root, `.pending-${crypto.randomUUID()}`);
      fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      onStep('before-publish');
      const now = directory(root), descriptor = fs.fstatSync(dirfd, { bigint: true });
      if (now.dev !== parent.dev || now.ino !== parent.ino || descriptor.dev !== parent.dev || descriptor.ino !== parent.ino) reject('SOURCE_CHANGED', 'Archive directory changed before publication.');
      const names = fs.readdirSync(root).filter(n => n !== '.lock' && n !== path.basename(temp)).sort();
      if (JSON.stringify(names) !== JSON.stringify(before.names.slice().sort())) reject('SOURCE_CHANGED', 'Archive changed before publication.');
      // link+unlink publishes without ever replacing an existing immutable file.
      fs.linkSync(temp, target); published = true; fs.unlinkSync(temp); temp = undefined;
      onStep('after-publish'); fs.fsyncSync(dirfd);
    } catch (error) {
      if (published) reject('WRITE_OUTCOME_UNKNOWN', 'The staged record may have been saved. Reload local imports to reconcile; do not repeat the write automatically.');
      throw error;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
      if (temp) { try { fs.unlinkSync(temp); } catch {} }
      if (lock !== undefined) { try { fs.closeSync(lock); fs.unlinkSync(lockPath); if (dirfd !== undefined) fs.fsyncSync(dirfd); } catch {} }
      if (dirfd !== undefined) { try { fs.closeSync(dirfd); } catch {} }
    }
  }
  function idCheck(id) { if (typeof id !== 'string' || !ID.test(id)) reject('VALIDATION', 'Invalid local import identifier.'); }
  function read(name, max = LIMITS.stageBytes) { try { return snapshot(JSON.parse(readBounded(path.join(root, name), max).bytes.toString('utf8')), max); } catch (e) { if (e.code) throw e; reject('STORE_CORRUPT', 'Local staging archive JSON is invalid.'); } }
  function load(id) {
    idCheck(id); const inv = inventory();
    if (!inv.names.includes(`${id}.source.json`)) reject('SOURCE_MISSING', 'Local staged source no longer exists.');
    const original = read(`${id}.source.json`), { archiveDigest, ...body } = original;
    if (hash(body) !== archiveDigest || original.id !== id || original.version !== 'farm-import-archive-1') reject('STORE_CORRUPT', 'Archived source metadata changed.');
    const stage = original.stage, { stageDigest, ...stageBody } = stage;
    if (hash(stageBody) !== stageDigest || digest(Buffer.from(stage.source.original, 'base64')) !== stage.source.digest || Buffer.from(stage.source.original, 'base64').length !== stage.source.byteLength) reject('STORE_CORRUPT', 'Archived original bytes or parsed stage changed.');
    const names = inv.names.filter(n => n.startsWith(id + '.r'));
    if (names.length > STORE_LIMITS.revisions) reject('STORE_CORRUPT', 'Too many staged revisions.');
    let latest = null;
    for (let n = 1; n <= names.length; n++) {
      if (!names.includes(`${id}.r${n}.json`)) reject('STORE_CORRUPT', 'Staged revision sequence is incomplete.');
      const revision = read(`${id}.r${n}.json`, LIMITS.responseBytes * 2), { revisionDigest, ...value } = revision;
      if (hash(value) !== revisionDigest || value.id !== id || value.revision !== n || value.parentDigest !== (latest?.revisionDigest || archiveDigest) || value.stageDigest !== stageDigest) reject('STORE_CORRUPT', 'Staged revision chain changed.');
      const expected = I.createCandidates(stage, value.selections);
      if (hash(expected) !== hash(value.candidates)) reject('STORE_CORRUPT', 'Stored staged candidates no longer match source.');
      if (value.receipt) I.verifyReviewReceipt(stage, value.candidates, value.receipt);
      latest = revision;
    }
    return { original, latest, inventory: inv };
  }
  const brief = record => {
    const { original, latest } = record, s = original.stage;
    return { id: original.id, createdAt: original.createdAt, name: s.source.name, sourceDigest: s.source.digest, stageDigest: s.stageDigest, byteLength: s.source.byteLength, declaredMime: s.source.declaredMime, format: s.format, parseStatus: s.status, warnings: s.warnings, pageCount: s.pageCount, sheets: s.sheets, elementCount: s.elements.length, revision: latest?.revision || 0, revisionDigest: latest?.revisionDigest || original.archiveDigest, state: latest?.receipt ? 'reviewed_for_staging' : latest ? 'draft_revision' : 'parsed_source', note: latest?.note || '', candidates: latest?.candidates || [], receipt: latest?.receipt || null, reviewer: latest?.reviewer || null, promotionAvailable: false, originalRetained: true };
  };
  function choose(filename, createdAt) {
    require('../farm/validation').instant(createdAt);
    // Parse native-selected file before taking lock; no original path retained.
    const stage = I.parseSelected(filename), inv = inventory();
    if (inv.names.filter(n => n.endsWith('.source.json')).length >= STORE_LIMITS.imports) reject('STORE_CAPACITY', 'Local staging archive supports up to 64 imported originals.');
    const id = crypto.randomUUID(), body = { version: 'farm-import-archive-1', id, createdAt, stage };
    writeNew(`${id}.source.json`, { ...body, archiveDigest: hash(body) }, inv);
    return brief(load(id));
  }
  function list() {
    const inv = inventory(), ids = inv.names.filter(n => n.endsWith('.source.json')).map(n => n.slice(0, -12));
    if (ids.length > STORE_LIMITS.imports) reject('STORE_CAPACITY', 'Local staging archive import limit reached.');
    if (inv.names.some(n => !ids.some(id => n.startsWith(id + '.')))) reject('STORE_CORRUPT', 'Orphaned revision in local staging archive.');
    return ids.map(id => { const b = brief(load(id)); return { id: b.id, name: b.name, createdAt: b.createdAt, format: b.format, parseStatus: b.parseStatus, state: b.state, revision: b.revision, sourceDigest: b.sourceDigest, originalRetained: true }; }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  function preview(id, offset = 0, limit = 50) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) reject('VALIDATION', 'Invalid preview page.');
    const r = load(id), elements = r.original.stage.elements;
    const page = []; let size = 0;
    for (const item of elements.slice(offset, offset + limit)) { const bytes = Buffer.byteLength(JSON.stringify(item)); if (size + bytes > LIMITS.responseBytes && page.length) break; page.push(item); size += bytes; }
    return { ...brief(r), elements: page, offset, nextOffset: offset + page.length < elements.length ? offset + page.length : null };
  }
  function append(id, expectedRevision, selections, note, createdAt, reviewer, acknowledge) {
    require('../farm/validation').instant(createdAt);
    const r = load(id), current = r.latest?.revision || 0;
    if (expectedRevision !== current) reject('REVISION_CONFLICT', 'Staged review changed. Reload the current revision.');
    if (current >= STORE_LIMITS.revisions) reject('STORE_CAPACITY', 'Staged revision limit reached.');
    bounded(note, 4000, 'reviewer note', true);
    const stage = r.original.stage, candidates = I.createCandidates(stage, selections);
    let receipt = null;
    if (reviewer) {
      fields(reviewer, ['name', 'attribution']); bounded(reviewer.name, 200, 'reviewer');
      if (!['trusted_host', 'self_attributed'].includes(reviewer.attribution)) reject('VALIDATION', 'Invalid reviewer attribution.');
      receipt = I.createReviewReceipt(stage, candidates, { reviewer: reviewer.name, reviewedAt: createdAt, acknowledgedUncertainty: acknowledge, decision: 'reviewed_for_staging' });
    }
    const body = { version: 'farm-import-revision-1', id, revision: current + 1, parentDigest: r.latest?.revisionDigest || r.original.archiveDigest, stageDigest: stage.stageDigest, createdAt, selections, candidates, note, reviewer: reviewer || null, receipt };
    const revision = { ...body, revisionDigest: hash(body) };
    snapshot(revision, LIMITS.responseBytes * 2);
    writeNew(`${id}.r${revision.revision}.json`, revision, r.inventory);
    return brief(load(id));
  }
  function revise(id, expectedRevision, selections, note, createdAt) { return append(id, expectedRevision, snapshot(selections, LIMITS.responseBytes), note, createdAt, null, false); }
  function review(id, expectedRevision, reviewer, acknowledged, createdAt) {
    const r = load(id);
    if (!r.latest) reject('REVIEW_REQUIRED', 'Create a staged candidate revision before review.');
    return append(id, expectedRevision, r.latest.selections, r.latest.note, createdAt, reviewer, acknowledged);
  }
  function promotion(id, revision, receiptDigest) {
    const r = load(id), latest = r.latest;
    if (!latest?.receipt || revision !== latest.revision || receiptDigest !== latest.receipt.receiptDigest) reject('REVIEW_MISMATCH', 'Exact current staged receipt is required.');
    I.verifyReviewReceipt(r.original.stage, latest.candidates, latest.receipt);
    return { version: 'farm-import-promotion-snapshot-1', original: r.original, revision: latest, ledgerWriteAuthorized: false };
  }
  function sharedRecord(id, destination) {
    const C = require('./shared-contract'); C.destination(destination);
    const r = load(id), original = C.source(r.original.stage);
    const name = `${id}.h${hash(destination)}.json`;
    let intent = null;
    if (r.inventory.names.includes(name)) {
      intent = read(name, 524288);
      const { intentDigest, ...body } = intent;
      if (hash(body) !== intentDigest || body.version !== 'farm-import-shared-intent-1' || body.id !== id ||
          hash(body.destination) !== hash(destination) || body.sourceDigest !== original.sourceDigest ||
          body.archiveDigest !== r.original.archiveDigest) reject('STORE_CORRUPT', 'Shared staging intent changed.');
      C.command(body.payload);
      if (body.payload.sourceBase64 !== original.sourceBase64 || body.payload.fileName !== original.fileName ||
          body.payload.mediaType !== original.mediaType || body.payload.farmId !== destination.farmId ||
          body.payload.departmentId !== destination.departmentId) reject('STORE_CORRUPT', 'Shared staging payload no longer matches its immutable source and destination.');
    }
    return { r, original, name, intent };
  }
  function sharedPrepare(id, destination) {
    const { original, intent } = sharedRecord(id, destination);
    return { fileName: original.fileName, mediaType: original.mediaType, sourceDigest: original.sourceDigest,
      byteLength: original.byteLength, requestId: intent?.payload.requestId || null, retry: !!intent };
  }
  function sharedIntent(id, destination, sourceDigest, createdAt) {
    require('../farm/validation').instant(createdAt);
    const { r, original, name, intent } = sharedRecord(id, destination);
    if (sourceDigest !== original.sourceDigest) reject('SOURCE_CHANGED', 'Shared consent does not match the retained source.');
    if (intent) return intent;
    const payload = { farmId: destination.farmId, requestId: crypto.randomUUID(), departmentId: destination.departmentId,
      fileName: original.fileName, mediaType: original.mediaType, sourceBase64: original.sourceBase64 };
    require('./shared-contract').command(payload);
    const body = { version: 'farm-import-shared-intent-1', id, destination, sourceDigest,
      archiveDigest: r.original.archiveDigest, createdAt, payload };
    if (r.inventory.names.length >= STORE_LIMITS.files) reject('STORE_CAPACITY', 'Local staging archive file limit reached.');
    // Durable before any network send. Outcome intentionally not inferred from this
    // record: explicit retries always replay this exact request, including restart.
    writeNew(name, { ...body, intentDigest: hash(body) }, r.inventory);
    return sharedRecord(id, destination).intent;
  }
  return { choose, list, open: id => brief(load(id)), preview, revise, review, promotion, sharedPrepare, sharedIntent };
}
module.exports = { createImportStore, STORE_LIMITS };
