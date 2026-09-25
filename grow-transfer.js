'use strict';

/** Notebook-only, raw-text transfer. No normalization, migration, adoption or merge.
 *
 * The HOST must hold its cooperating-writer lease across every async call (and
 * dialogs/confirmation), and call assertReady(userData) before ordinary notebook
 * reads/writes. This is not protection against a hostile filesystem administrator.
 * userData must already exist and be an absolute, non-symlinked directory.
 *
 * createArchive({userData, source:{edition,version}}) -> frozen archive object.
 * validateArchive(object|string|Buffer) -> detached, deeply frozen archive.
 * inspectArchive(archive) -> frozen counts/bytes/hash/source summary, no raw rows.
 * importArchive({userData,archive}) -> {status:'committed'|'already-imported',
 *   archiveId, receipt, summary}. Always revalidates/copies before its first await.
 * recoverImport({userData}) -> {status:'ready'|'committed', archiveId?, receipt?}.
 * assertReady(userData), assertNotebookReady({userData}) -> true; read-only gates.
 *
 * Errors have code GROW_*, state 'not-imported'|'recovery-required', and committed
 * (true only if a commit was observed in this call). Never interpret false as
 * permission to overwrite: an interrupted rename must be reconciled on restart.
 * Import/recovery never remove records, a committed directory, or orphan stages.
 * Only a revalidated zero-entry original target is rmdir'ed; only the authoritative
 * journal is unlinked. Unused receipt temporaries are retained. Unsupported directory
 * fsync fails closed. Orphan/incomplete/corrupt/ambiguous transactions remain
 * blocked for explicit recovery, retaining evidence. Receipts live outside grow.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { plain, json, canonical } = require('./farm/validation');
const { GROW_TYPES: schemaTypes } = require('./grow-schema');

const FORMAT = 'crowe-grow-archive';
const VERSION = 1;
const GROW_TYPES = Object.freeze(['blocks', 'flushes', 'contam', 'env', 'strains', 'recipes', 'log']);
if (GROW_TYPES.length !== schemaTypes.size || GROW_TYPES.some(type => !schemaTypes.has(type))) {
  throw new Error('Notebook archive v1 allowlist differs from the notebook schema.');
}
const LIMITS = Object.freeze({ fileBytes: 16 * 1024 * 1024, rawBytes: 32 * 1024 * 1024,
  archiveBytes: 64 * 1024 * 1024, rowsPerType: 10000, rowBytes: 1024 * 1024,
  depth: 40, nodes: 250000, metadataBytes: 64 * 1024, idLength: 200 });
const MAX_ARCHIVE_BYTES = LIMITS.archiveBytes;
const JOURNAL_NAME = '.grow-transfer-journal.json';
const RECEIPT_NAME = '.grow-transfer-receipt.json';
const STAGE_PREFIX = '.grow-transfer-stage-';
const RECEIPT_TEMP_PREFIX = '.grow-transfer-receipt-temp-';
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const decoder = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const hashObject = value => digest(canonical(value));

class GrowTransferError extends Error {
  constructor(code, message, state = 'not-imported', committed = false) {
    super(message); this.name = 'GrowTransferError'; this.code = code;
    this.state = state; this.committed = committed;
  }
}
function fail(code, message) { throw new GrowTransferError(code, message); }
function error(cause, pending = false, committed = false) {
  const out = cause instanceof GrowTransferError ? cause :
    new GrowTransferError('GROW_IO', 'Notebook storage operation failed; the original records have not been removed.');
  if (pending) out.state = 'recovery-required';
  out.committed = committed || out.committed;
  return out;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function exactKeys(value, keys, label) {
  if (!plain(value) || Reflect.ownKeys(value).length !== keys.length ||
      keys.some(k => !Object.hasOwn(value, k)) || Reflect.ownKeys(value).some(k => !keys.includes(k))) {
    fail('GROW_INVALID_ARCHIVE', `${label} has missing or unsupported fields.`);
  }
}
function boundedJson(value, bytes) {
  try { return json(value, bytes); }
  catch { fail('GROW_INVALID_JSON', 'Only bounded, finite plain JSON without unsafe fields, accessors, cycles or sparse arrays is supported.'); }
}
function utf8(buffer) {
  try { return decoder().decode(buffer); }
  catch { fail('GROW_INVALID_UTF8', 'Notebook transfer contains invalid UTF-8.'); }
}

// Scan before JSON.parse: bound recursion, reject duplicate (including escaped)
// property names, and measure raw row tokens. JSON.parse alone erases duplicate
// fields, so merely preserving the original text would give a misleading preview.
function parseText(text, maxDepth, rowSizes = null) {
  let i = 0, nodes = 0;
  const ws = () => { while (i < text.length && /[\t\n\r ]/.test(text[i])) i++; };
  function string() {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    throw new Error('Unterminated string');
  }
  function value(depth) {
    if (depth > maxDepth || ++nodes > LIMITS.nodes) fail('GROW_LIMIT', 'JSON exceeds the supported depth or node limit.');
    ws();
    if (text[i] === '{') {
      i++; ws(); const keys = new Set();
      if (text[i] === '}') { i++; return; }
      while (true) {
        if (text[i] !== '"') throw new Error('Expected key');
        const key = string();
        if (keys.has(key)) fail('GROW_INVALID_JSON', 'Duplicate JSON property names are unsupported.');
        if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('GROW_INVALID_JSON', 'Unsafe JSON property names are unsupported.');
        keys.add(key); ws(); if (text[i++] !== ':') throw new Error('Expected colon');
        value(depth + 1); ws(); const next = text[i++];
        if (next === '}') return;
        if (next !== ',') throw new Error('Expected comma');
        ws();
      }
    }
    if (text[i] === '[') {
      i++; ws(); if (text[i] === ']') { i++; return; }
      while (true) {
        ws(); const start = i; value(depth + 1);
        if (rowSizes && depth === 0) rowSizes.push(Buffer.byteLength(text.slice(start, i), 'utf8'));
        ws(); const next = text[i++]; if (next === ']') return;
        if (next !== ',') throw new Error('Expected comma');
      }
    }
    if (text[i] === '"') { string(); return; }
    const start = i;
    while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
    if (i === start) throw new Error('Expected value');
    JSON.parse(text.slice(start, i));
  }
  try { value(0); ws(); if (i !== text.length) throw new Error('Trailing data'); return JSON.parse(text); }
  catch (cause) {
    if (cause instanceof GrowTransferError) throw cause;
    fail('GROW_INVALID_JSON', 'Notebook transfer contains malformed JSON.');
  }
}
function validateRows(text) {
  const sizes = [];
  const rows = parseText(text, LIMITS.depth + 1, sizes);
  if (!Array.isArray(rows)) fail('GROW_INVALID_ROWS', 'Each present notebook file must contain a JSON array.');
  if (rows.length > LIMITS.rowsPerType) fail('GROW_LIMIT', 'Notebook file exceeds the row limit.');
  const ids = new Set();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!plain(row) || typeof row.id !== 'string' || !row.id || row.id.length > LIMITS.idLength ||
        row.id.trim() !== row.id || /[\x00-\x1f\x7f]/.test(row.id)) {
      fail('GROW_INVALID_ID', 'Every notebook row needs an unchanged, nonblank stable string ID of at most 200 characters.');
    }
    if (ids.has(row.id)) fail('GROW_DUPLICATE_ID', 'Notebook record IDs are duplicated within a type.');
    ids.add(row.id);
    if (sizes[i] > LIMITS.rowBytes) fail('GROW_LIMIT', 'Notebook row exceeds the raw byte limit.');
    boundedJson(row, LIMITS.rowBytes);
  }
  return rows.length;
}
function sourceInfo(source) {
  exactKeys(source, ['edition', 'version'], 'Source description');
  if (!['desktop', 'developers', 'mycology'].includes(source.edition) ||
      typeof source.version !== 'string' || !source.version.trim() || source.version.length > 100 ||
      /[\x00-\x1f\x7f]/.test(source.version)) fail('GROW_INVALID_ARCHIVE', 'Source edition/version is unsupported.');
}
function instant(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function manifestOf(archive) {
  return GROW_TYPES.map(type => {
    const { present, bytes, count, sha256 } = archive.slots[type];
    return { type, present, bytes, count, sha256 };
  });
}
function validateManifest(manifest) {
  if (!Array.isArray(manifest) || manifest.length !== GROW_TYPES.length) fail('GROW_INVALID_ARCHIVE', 'Expected exactly seven manifest slots.');
  let total = 0;
  for (let i = 0; i < manifest.length; i++) {
    const m = manifest[i];
    exactKeys(m, ['type', 'present', 'bytes', 'count', 'sha256'], 'Manifest slot');
    if (m.type !== GROW_TYPES[i] || typeof m.present !== 'boolean' || !Number.isSafeInteger(m.bytes) ||
        m.bytes < 0 || m.bytes > LIMITS.fileBytes || !Number.isSafeInteger(m.count) || m.count < 0 || m.count > LIMITS.rowsPerType ||
        (m.present ? !SHA.test(m.sha256) : (m.bytes !== 0 || m.count !== 0 || m.sha256 !== null))) {
      fail('GROW_INVALID_ARCHIVE', 'Manifest slot is invalid.');
    }
    total += m.bytes;
  }
  if (total > LIMITS.rawBytes) fail('GROW_LIMIT', 'Notebook aggregate source bytes exceed the limit.');
}
function validateArchive(input) {
  let archive;
  if (Buffer.isBuffer(input) || typeof input === 'string') {
    if (Buffer.byteLength(input) > MAX_ARCHIVE_BYTES) fail('GROW_LIMIT', 'Encoded archive exceeds 64 MiB.');
    archive = parseText(Buffer.isBuffer(input) ? utf8(input) : input, LIMITS.depth);
  } else {
    // Descriptor validation happens before serialization; callers cannot smuggle
    // getters/toJSON/undefined or subsequently mutate a validated candidate.
    archive = JSON.parse(boundedJson(input, MAX_ARCHIVE_BYTES));
  }
  exactKeys(archive, ['format', 'version', 'archiveId', 'createdAt', 'source', 'slots'], 'Archive');
  if (archive.format !== FORMAT || archive.version !== VERSION || !SHA.test(archive.archiveId) || !instant(archive.createdAt)) {
    fail('GROW_INVALID_ARCHIVE', 'Unsupported notebook archive format, version or identity.');
  }
  sourceInfo(archive.source);
  exactKeys(archive.slots, GROW_TYPES, 'Archive slots');
  let bytes = 0;
  for (const type of GROW_TYPES) {
    const slot = archive.slots[type];
    exactKeys(slot, ['present', 'text', 'bytes', 'count', 'sha256'], 'Archive slot');
    if (typeof slot.present !== 'boolean') fail('GROW_INVALID_ARCHIVE', 'Slot presence must be explicit.');
    if (!slot.present) {
      if (slot.text !== null || slot.bytes !== 0 || slot.count !== 0 || slot.sha256 !== null) fail('GROW_INVALID_ARCHIVE', 'Absent slots cannot contain data.');
      continue;
    }
    if (typeof slot.text !== 'string') fail('GROW_INVALID_ARCHIVE', 'Present slots require raw file text.');
    const buffer = Buffer.from(slot.text, 'utf8');
    if (buffer.length > LIMITS.fileBytes || (bytes += buffer.length) > LIMITS.rawBytes) fail('GROW_LIMIT', 'Notebook source bytes exceed the file or aggregate limit.');
    if (utf8(buffer) !== slot.text) fail('GROW_INVALID_UTF8', 'Raw file text cannot contain unpaired Unicode surrogates.');
    if (slot.bytes !== buffer.length || slot.sha256 !== digest(buffer)) fail('GROW_CHECKSUM', 'Notebook raw file size or checksum does not match.');
    if (slot.count !== validateRows(slot.text)) fail('GROW_INVALID_ARCHIVE', 'Notebook row count does not match the raw file.');
  }
  validateManifest(manifestOf(archive));
  const { archiveId, ...body } = archive;
  if (archiveId !== hashObject(body)) fail('GROW_CHECKSUM', 'Notebook archive checksum does not match.');
  // Also bound canonical transport encoding of a whitespace-heavy object input.
  if (Buffer.byteLength(JSON.stringify(archive)) > MAX_ARCHIVE_BYTES) fail('GROW_LIMIT', 'Encoded archive exceeds 64 MiB.');
  return freeze(archive);
}
function summaryOf(archive) {
  const files = manifestOf(archive);
  return freeze({ format: FORMAT, version: VERSION, archiveId: archive.archiveId,
    source: { ...archive.source }, createdAt: archive.createdAt,
    totalBytes: files.reduce((n, f) => n + f.bytes, 0), totalRows: files.reduce((n, f) => n + f.count, 0), files });
}
function inspectArchive(archive) { return summaryOf(validateArchive(archive)); }

function maybeStat(filename) {
  try { return fs.lstatSync(filename, { bigint: true }); }
  catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
}
function identity(stat) { return { dev: String(stat.dev), ino: String(stat.ino) }; }
function sameIdentity(a, b) { return !!a && !!b && a.dev === b.dev && a.ino === b.ino; }
function stamp(stat) { return stat && [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'); }
function dirChain(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0') ||
      directory.split(path.sep).some(p => p === '..' || p === '.')) fail('GROW_UNSAFE_PATH', 'Notebook profile must use an absolute path without aliases.');
  const full = path.normalize(directory);
  const root = path.parse(full).root;
  let current = root;
  for (const part of full.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = maybeStat(current);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) fail('GROW_UNSAFE_PATH', 'Notebook directory chain must consist only of existing real directories.');
  }
  return identity(fs.lstatSync(full, { bigint: true }));
}
function directoryState(directory) {
  dirChain(path.dirname(directory));
  const stat = maybeStat(directory);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('GROW_UNSAFE_PATH', 'Notebook path must be a real directory.');
  return { identity: identity(stat), stamp: stamp(stat), entries: fs.readdirSync(directory).sort() };
}
function safeMetadata(filename) {
  const stat = maybeStat(filename);
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)) fail('GROW_UNSAFE_PATH', 'Notebook transfer metadata must be a regular, unaliased file.');
}
function profile(userData) {
  const parentIdentity = dirChain(userData);
  return { root: path.normalize(userData), parentIdentity, grow: path.join(userData, 'grow'),
    journal: path.join(userData, JOURNAL_NAME), receipt: path.join(userData, RECEIPT_NAME) };
}
function checkParent(p) {
  if (!sameIdentity(dirChain(p.root), p.parentIdentity)) fail('GROW_SOURCE_CHANGED', 'Notebook profile directory identity changed.');
}
function pendingNames(p) { return fs.readdirSync(p.root).filter(name => name.startsWith(STAGE_PREFIX)); }
function assertReady(userData) {
  try {
    const p = profile(userData);
    if (maybeStat(p.journal) || pendingNames(p).length) {
      throw new GrowTransferError('GROW_RECOVERY_REQUIRED', 'An interrupted notebook import must be reconciled before notebook access.', 'recovery-required');
    }
    safeMetadata(p.receipt);
    const current = directoryState(p.grow);
    if (current) for (const type of GROW_TYPES) safeMetadata(path.join(p.grow, type + '.json'));
    return true;
  } catch (cause) { throw error(cause); }
}
async function assertNotebookReady({ userData }) { return assertReady(userData); }

async function readFile(filename, maxBytes, sync = false) {
  dirChain(path.dirname(filename));
  const before = maybeStat(filename);
  if (!before) return null;
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) fail('GROW_UNSAFE_PATH', 'Notebook input must be a regular, unaliased file.');
  if (before.size > BigInt(maxBytes)) fail('GROW_LIMIT', 'Notebook input file exceeds its byte limit.');
  let handle;
  try {
    handle = await fsp.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || stamp(opened) !== stamp(before)) fail('GROW_SOURCE_CHANGED', 'Notebook file changed before reading.');
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (sync) await handle.sync();
    const after = await handle.stat({ bigint: true });
    dirChain(path.dirname(filename));
    if (length !== Number(opened.size) || stamp(after) !== stamp(opened) || stamp(maybeStat(filename)) !== stamp(opened)) {
      fail('GROW_SOURCE_CHANGED', 'Notebook file changed while reading.');
    }
    return { text: utf8(buffer.subarray(0, length)), stamp: stamp(after) };
  } finally { if (handle) await handle.close(); }
}
async function syncDirectory(directory) {
  const before = dirChain(directory);
  const handle = await fsp.open(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !sameIdentity(before, identity(opened))) fail('GROW_SOURCE_CHANGED', 'Notebook directory changed before its durability barrier.');
    await handle.sync();
    if (!sameIdentity(before, dirChain(directory))) fail('GROW_SOURCE_CHANGED', 'Notebook directory changed during its durability barrier.');
  } finally { await handle.close(); }
}
async function writeExclusive(filename, text) {
  dirChain(path.dirname(filename));
  const handle = await fsp.open(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}
function unchangedDirectory(directory, before) {
  const after = directoryState(directory);
  if ((!before) !== (!after) || (before && (before.stamp !== after.stamp ||
      JSON.stringify(before.entries) !== JSON.stringify(after.entries)))) fail('GROW_SOURCE_CHANGED', 'Notebook directory changed during export.');
}
function checkEntries(state, manifest) {
  const expected = manifest.filter(m => m.present).map(m => m.type + '.json').sort();
  if (!state || JSON.stringify(state.entries) !== JSON.stringify(expected)) fail('GROW_CONTENT_CHANGED', 'Notebook contains missing, additional or unexpected files.');
}
function checkEmpty(state) {
  if (state && state.entries.length) fail('GROW_DESTINATION_NOT_EMPTY', 'Notebook import requires an absent directory or a real zero-entry directory; existing files are never overwritten.');
}
function validIdentity(value) {
  exactKeys(value, ['dev', 'ino'], 'Directory identity');
  if (!['dev', 'ino'].every(k => typeof value[k] === 'string' && /^\d{1,30}$/.test(value[k]))) fail('GROW_INVALID_ARCHIVE', 'Invalid directory identity.');
}
function receiptFor(journal) {
  return { format: 'crowe-grow-import-receipt', version: VERSION, archiveId: journal.archiveId,
    transactionId: journal.transactionId, importedAt: journal.createdAt, source: journal.source,
    parentIdentity: journal.parentIdentity, directoryIdentity: journal.stageIdentity, manifest: journal.manifest };
}
function validateReceipt(receipt) {
  exactKeys(receipt, ['format', 'version', 'archiveId', 'transactionId', 'importedAt', 'source', 'parentIdentity', 'directoryIdentity', 'manifest'], 'Receipt');
  if (receipt.format !== 'crowe-grow-import-receipt' || receipt.version !== VERSION || !SHA.test(receipt.archiveId) ||
      !UUID.test(receipt.transactionId) || !instant(receipt.importedAt)) fail('GROW_INVALID_ARCHIVE', 'Invalid transfer receipt.');
  sourceInfo(receipt.source); validIdentity(receipt.parentIdentity); validIdentity(receipt.directoryIdentity); validateManifest(receipt.manifest);
  return receipt;
}
function validateJournal(journal) {
  exactKeys(journal, ['format', 'version', 'transactionId', 'archiveId', 'createdAt', 'source', 'parentIdentity', 'stageIdentity', 'originalTargetIdentity', 'manifest', 'checksum'], 'Journal');
  if (journal.format !== 'crowe-grow-import-journal' || journal.version !== VERSION || !UUID.test(journal.transactionId) ||
      !SHA.test(journal.archiveId) || !instant(journal.createdAt)) fail('GROW_INVALID_ARCHIVE', 'Invalid transfer journal.');
  sourceInfo(journal.source); validIdentity(journal.parentIdentity); validIdentity(journal.stageIdentity);
  if (journal.originalTargetIdentity !== null) validIdentity(journal.originalTargetIdentity);
  validateManifest(journal.manifest);
  const { checksum, ...body } = journal;
  if (checksum !== hashObject(body)) fail('GROW_CHECKSUM', 'Transfer journal checksum does not match.');
  return journal;
}
async function readMetadata(filename, validator) {
  const result = await readFile(filename, LIMITS.metadataBytes);
  if (!result) return null;
  return validator(parseText(result.text, LIMITS.depth));
}
async function verifyDirectory(directory, expectedIdentity, manifest, sync = false) {
  const initial = directoryState(directory);
  if (!initial || !sameIdentity(initial.identity, expectedIdentity)) fail('GROW_CONTENT_CHANGED', 'Notebook directory identity does not match the transfer.');
  checkEntries(initial, manifest);
  const reads = [];
  for (const m of manifest) if (m.present) {
    const filename = path.join(directory, m.type + '.json');
    const result = await readFile(filename, LIMITS.fileBytes, sync);
    if (!result || Buffer.byteLength(result.text) !== m.bytes || digest(result.text) !== m.sha256 || validateRows(result.text) !== m.count) {
      fail('GROW_CONTENT_CHANGED', 'Notebook file content does not match the transfer manifest.');
    }
    reads.push([filename, result.stamp]);
  }
  unchangedDirectory(directory, initial);
  for (const [filename, before] of reads) if (stamp(maybeStat(filename)) !== before) fail('GROW_CONTENT_CHANGED', 'Notebook content changed during verification.');
  if (sync) await syncDirectory(directory);
}

// A private hook factory is exported solely for fixture fault-injection. Hooks
// run at completed I/O boundaries, may throw or terminate the fixture process,
// and are never selected through archive content or the production environment.
function createTransfer({ onStep = async () => {} } = {}) {
  const step = (name, context = {}) => onStep(name, Object.freeze(context));
  async function createArchive({ userData, source }) {
    try {
      const sourceCopy = JSON.parse(boundedJson(source, 1024)); sourceInfo(sourceCopy);
      assertReady(userData); const p = profile(userData); const initial = directoryState(p.grow);
      if (initial && initial.entries.some(name => !GROW_TYPES.some(type => name === type + '.json'))) {
        fail('GROW_UNKNOWN_FILE', 'Notebook contains unsupported files; export will not silently omit them.');
      }
      const slots = {}, reads = [];
      let bytes = 0;
      for (const type of GROW_TYPES) {
        const filename = path.join(p.grow, type + '.json');
        const result = initial ? await readFile(filename, LIMITS.fileBytes) : null;
        if (!result) slots[type] = { present: false, text: null, bytes: 0, count: 0, sha256: null };
        else {
          const size = Buffer.byteLength(result.text);
          if ((bytes += size) > LIMITS.rawBytes) fail('GROW_LIMIT', 'Notebook aggregate source bytes exceed 32 MiB.');
          slots[type] = { present: true, text: result.text, bytes: size, count: validateRows(result.text), sha256: digest(result.text) };
        }
        reads.push([filename, result && result.stamp]);
        await step('source-file-read', { type });
      }
      await step('source-read'); checkParent(p); unchangedDirectory(p.grow, initial);
      for (const [filename, before] of reads) if (stamp(maybeStat(filename)) !== before) fail('GROW_SOURCE_CHANGED', 'Notebook file changed during export.');
      const body = { format: FORMAT, version: VERSION, createdAt: new Date().toISOString(), source: sourceCopy, slots };
      return validateArchive({ ...body, archiveId: hashObject(body) });
    } catch (cause) { throw error(cause); }
  }
  async function finish(p, journal) {
    checkParent(p);
    const stage = path.join(p.root, STAGE_PREFIX + journal.transactionId);
    if (maybeStat(stage) || pendingNames(p).length) fail('GROW_RECOVERY_REQUIRED', 'Unexpected staging directories remain beside the committed notebook.');
    await verifyDirectory(p.grow, journal.stageIdentity, journal.manifest, true);
    // Recovery must re-establish durability, not infer it from a visible rename.
    await syncDirectory(p.root); await step('commit-synced');
    const expected = receiptFor(journal);
    const receipt = await readMetadata(p.receipt, validateReceipt);
    if (receipt && canonical(receipt) !== canonical(expected)) fail('GROW_RECEIPT_CONFLICT', 'A different notebook transfer receipt already exists.');
    if (!receipt) {
      const temporary = path.join(p.root, RECEIPT_TEMP_PREFIX + randomUUID());
      await writeExclusive(temporary, JSON.stringify(expected)); await step('receipt-file-synced');
      checkParent(p);
      if (maybeStat(p.receipt)) fail('GROW_RECEIPT_CONFLICT', 'Notebook receipt appeared during finalization.');
      // The writer lease excludes cooperating metadata writers as well as grow.
      await fsp.rename(temporary, p.receipt); await step('receipt-renamed');
    }
    await syncDirectory(p.root); await step('receipt-synced');
    // Revalidate both identities and content before retiring the recovery gate.
    await verifyDirectory(p.grow, journal.stageIdentity, journal.manifest);
    const persisted = await readMetadata(p.journal, validateJournal);
    if (!persisted || canonical(persisted) !== canonical(journal)) fail('GROW_RECOVERY_REQUIRED', 'Notebook transfer journal changed during finalization.');
    checkParent(p); await fsp.unlink(p.journal); await step('journal-removed');
    await syncDirectory(p.root); await step('complete');
    return freeze(expected);
  }
  async function commit(p, journal, observeCommit) {
    checkParent(p);
    const stage = path.join(p.root, STAGE_PREFIX + journal.transactionId);
    await verifyDirectory(stage, journal.stageIdentity, journal.manifest, true);
    const persisted = await readMetadata(p.journal, validateJournal);
    if (!persisted || canonical(persisted) !== canonical(journal)) fail('GROW_RECOVERY_REQUIRED', 'Notebook transfer journal changed before commit.');
    // Flush the visible journal again on restart and persist the stage's NAME in
    // its parent before removing even an empty original target.
    await readFile(p.journal, LIMITS.metadataBytes, true);
    await syncDirectory(p.root); await step('before-commit');
    checkParent(p);
    const target = directoryState(p.grow);
    if (target) {
      if (!sameIdentity(target.identity, journal.originalTargetIdentity)) fail('GROW_DESTINATION_CHANGED', 'Notebook destination identity changed after preparation.');
      checkEmpty(target);
      // Nonrecursive rmdir refuses entries even if a noncooperating writer has
      // appeared since revalidation. The host lease spans all await boundaries.
      // Ordinary rename is not a hostile-external-writer no-replace primitive.
      fs.rmdirSync(p.grow);
    }
    await step('target-removed');
    checkParent(p);
    if (maybeStat(p.grow)) fail('GROW_DESTINATION_CHANGED', 'Notebook destination appeared before commit.');
    const staged = directoryState(stage);
    if (!staged || !sameIdentity(staged.identity, journal.stageIdentity)) fail('GROW_CONTENT_CHANGED', 'Staged notebook identity changed before commit.');
    fs.renameSync(stage, p.grow);
    observeCommit();
    await step('renamed');
  }
  async function importArchive({ userData, archive: input }) {
    let pending = false, committed = false;
    try {
      const archive = validateArchive(input); // detach BEFORE awaiting anything
      assertReady(userData); const p = profile(userData);
      const existing = await readMetadata(p.receipt, validateReceipt);
      checkParent(p);
      if (existing) {
        if (existing.archiveId !== archive.archiveId || canonical(existing.manifest) !== canonical(manifestOf(archive)) ||
            !sameIdentity(existing.parentIdentity, p.parentIdentity)) {
          fail('GROW_DESTINATION_NOT_EMPTY', 'Destination has a different transfer receipt; import never replaces or merges notebook records.');
        }
        await verifyDirectory(p.grow, existing.directoryIdentity, existing.manifest);
        return freeze({ status: 'already-imported', archiveId: archive.archiveId, receipt: existing, summary: summaryOf(archive) });
      }
      const target = directoryState(p.grow); checkEmpty(target);
      const transactionId = randomUUID(), stage = path.join(p.root, STAGE_PREFIX + transactionId);
      checkParent(p); await fsp.mkdir(stage, { mode: 0o700 }); pending = true;
      await step('stage-created');
      const stageIdentity = directoryState(stage).identity;
      for (const type of GROW_TYPES) if (archive.slots[type].present) {
        await writeExclusive(path.join(stage, type + '.json'), archive.slots[type].text);
        await step('stage-file-synced', { type });
      }
      await syncDirectory(stage); await step('stage-synced');
      const body = { format: 'crowe-grow-import-journal', version: VERSION, transactionId,
        archiveId: archive.archiveId, createdAt: new Date().toISOString(), source: archive.source,
        parentIdentity: p.parentIdentity, stageIdentity, originalTargetIdentity: target ? target.identity : null,
        manifest: manifestOf(archive) };
      const journal = { ...body, checksum: hashObject(body) };
      checkParent(p); await writeExclusive(p.journal, JSON.stringify(journal)); await step('journal-file-synced');
      await syncDirectory(p.root); await step('journal-synced');
      await commit(p, journal, () => { committed = true; });
      const receipt = await finish(p, journal);
      return freeze({ status: 'committed', archiveId: archive.archiveId, receipt, summary: summaryOf(archive) });
    } catch (cause) { throw error(cause, pending, committed); }
  }
  async function recoverImport({ userData }) {
    let committed = false;
    try {
      const p = profile(userData);
      if (!maybeStat(p.journal)) { assertReady(userData); return { status: 'ready' }; }
      const journal = await readMetadata(p.journal, validateJournal);
      if (!sameIdentity(journal.parentIdentity, p.parentIdentity)) fail('GROW_RECOVERY_REQUIRED', 'Journal belongs to a different profile directory.');
      const stageName = STAGE_PREFIX + journal.transactionId, stage = path.join(p.root, stageName);
      if (pendingNames(p).some(name => name !== stageName)) fail('GROW_RECOVERY_REQUIRED', 'Multiple or unexplained staged notebook directories require explicit recovery.');
      const target = directoryState(p.grow), staged = directoryState(stage);
      if (target && sameIdentity(target.identity, journal.stageIdentity)) {
        committed = true;
        if (staged) fail('GROW_RECOVERY_REQUIRED', 'Both staged and committed notebook directories exist.');
      } else {
        if (!staged || !sameIdentity(staged.identity, journal.stageIdentity)) fail('GROW_RECOVERY_REQUIRED', 'The journal does not identify a valid staged or committed notebook.');
        const existing = await readMetadata(p.receipt, validateReceipt);
        if (existing) fail('GROW_RECEIPT_CONFLICT', 'A receipt exists without its committed notebook directory.');
        await commit(p, journal, () => { committed = true; });
      }
      const receipt = await finish(p, journal);
      return freeze({ status: 'committed', archiveId: journal.archiveId, receipt });
    } catch (cause) { throw error(cause, true, committed); }
  }
  return Object.freeze({ createArchive, importArchive, recoverImport });
}

// Shared strict, transfer-compatible reader for notebook evidence appends. This
// does not add a transfer collection or change archive validation.
function parseNotebookRows(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.fileBytes) fail('GROW_LIMIT', 'Notebook file exceeds the byte limit.');
  const text = utf8(bytes); validateRows(text); return JSON.parse(text);
}

module.exports = Object.freeze({ ...createTransfer(), validateArchive, inspectArchive, assertReady, assertNotebookReady, parseNotebookRows,
  GrowTransferError, FORMAT, VERSION, GROW_TYPES, LIMITS, MAX_ARCHIVE_BYTES, JOURNAL_NAME, RECEIPT_NAME,
  STAGE_PREFIX, RECEIPT_TEMP_PREFIX, _testing: Object.freeze({ createTransfer }) });
