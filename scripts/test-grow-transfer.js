#!/usr/bin/env node
'use strict';

// Synthetic profiles only. No Electron, dependencies or actual user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const transfer = require('../grow-transfer');
const { canonical } = require('../farm/validation');
const { GROW_TYPES, LIMITS, JOURNAL_NAME, RECEIPT_NAME, STAGE_PREFIX } = transfer;
const hash = data => createHash('sha256').update(data).digest('hex');
const source = { edition: 'desktop', version: 'fixture-1.0.0' };
const clone = object => JSON.parse(JSON.stringify(object));
let root, counter = 0, passed = 0;
function profile() { const p = path.join(root, String(++counter)); fs.mkdirSync(p); return p; }
function notebook(p, slots = {}) {
  fs.mkdirSync(path.join(p, 'grow'));
  for (const [type, text] of Object.entries(slots)) fs.writeFileSync(path.join(p, 'grow', type + '.json'), text);
  return p;
}
function seal(archive) {
  for (const slot of Object.values(archive.slots)) if (slot.present) {
    slot.bytes = Buffer.byteLength(slot.text); slot.sha256 = hash(slot.text);
    try { const rows = JSON.parse(slot.text); slot.count = Array.isArray(rows) ? rows.length : 0; } catch { slot.count = 0; }
  }
  const { archiveId, ...body } = archive; archive.archiveId = hash(canonical(body)); return archive;
}
function withText(archive, text, type = 'blocks') {
  const out = clone(archive); out.slots[type] = { present: true, text, bytes: 0, count: 0, sha256: '' }; return seal(out);
}
async function expectCode(fn, code) {
  await assert.rejects(async () => fn(), cause => {
    assert(cause instanceof transfer.GrowTransferError, `unexpected error: ${cause.stack}`);
    if (code) assert([].concat(code).includes(cause.code), `${cause.code} != ${code}: ${cause.message}`);
    return true;
  });
}
async function test(name, fn) {
  await fn(); passed++; process.stdout.write(`ok ${passed} - ${name}\n`);
}
function inventory(directory) {
  if (!fs.existsSync(directory)) return null;
  const out = {};
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    out[name] = stat.isSymbolicLink() ? { link: fs.readlinkSync(file) } : stat.isDirectory() ? inventory(file) : hash(fs.readFileSync(file));
  }
  return out;
}
// Test cleanup walks only this fixture root, does not follow symlinks and never
// asks the platform to recursively remove a directory.
function removeFixture(directory) {
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    if (fs.lstatSync(file).isDirectory()) removeFixture(file); else fs.unlinkSync(file);
  }
  fs.rmdirSync(directory);
}
function crashChild(mode, target, archiveFile, boundary) {
  return spawnSync(process.execPath, [__filename, '--crash', mode, target, archiveFile, boundary], { encoding: 'utf8', timeout: 60000 });
}
async function childMain() {
  const [, , , mode, target, archiveFile, boundary] = process.argv;
  const api = transfer._testing.createTransfer({ onStep(name) { if (name === boundary) process.exit(73); } });
  if (mode === 'import') await api.importArchive({ userData: target, archive: fs.readFileSync(archiveFile) });
  else await api.recoverImport({ userData: target });
  process.exit(74);
}

async function main() {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'crowe-grow-transfer-fixture-'));
  const original = notebook(profile(), Object.fromEntries(GROW_TYPES.map((type, index) => [type,
    ` [\n  {"id":"${type}-stable", "timestamp":"2020-01-02T03:04:05Z", "legacy": {"unrecognized":[false,null,${index}]}, "notes":"菌 ${type}"}\n ]\r\n`])));
  const beforeSource = inventory(original);
  const archive = await transfer.createArchive({ userData: original, source });
  const archiveFile = path.join(root, 'fixture-archive.json'); fs.writeFileSync(archiveFile, JSON.stringify(archive));

  await test('seven-slot exact raw roundtrip, private modes, independent source, receipt and repeat', async () => {
    assert(Object.isFrozen(archive)); assert(Object.isFrozen(archive.slots.blocks));
    const summary = transfer.inspectArchive(archive);
    assert.equal(summary.totalRows, 7); assert.equal(summary.files.length, 7); assert(!JSON.stringify(summary).includes('unrecognized'));
    const destination = profile(); const result = await transfer.importArchive({ userData: destination, archive });
    assert.equal(result.status, 'committed');
    assert.deepEqual(inventory(path.join(destination, 'grow')), inventory(path.join(original, 'grow')));
    assert.equal(fs.statSync(path.join(destination, 'grow')).mode & 0o777, 0o700);
    for (const type of GROW_TYPES) {
      assert.equal(fs.statSync(path.join(destination, 'grow', type + '.json')).mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(path.join(destination, 'grow', type + '.json'), 'utf8'), archive.slots[type].text);
    }
    assert.equal(fs.statSync(path.join(destination, RECEIPT_NAME)).mode & 0o777, 0o600);
    assert.equal(transfer.assertReady(destination), true);
    assert.equal(await transfer.assertNotebookReady({ userData: destination }), true);
    assert.deepEqual(await transfer.recoverImport({ userData: destination }), { status: 'ready' });
    const again = await transfer.importArchive({ userData: destination, archive }); assert.equal(again.status, 'already-imported');
    assert.deepEqual(inventory(original), beforeSource);
    assert.equal(fs.existsSync(path.join(original, RECEIPT_NAME)), false);
    const altered = withText(archive, '[{"id":"new"}]');
    const before = inventory(destination); await expectCode(() => transfer.importArchive({ userData: destination, archive: altered }), 'GROW_DESTINATION_NOT_EMPTY');
    assert.deepEqual(inventory(destination), before);
    fs.writeFileSync(path.join(destination, 'grow', 'blocks.json'), '[{"id":"edited-after-import"}]');
    const changed = inventory(destination); await expectCode(() => transfer.importArchive({ userData: destination, archive }), 'GROW_CONTENT_CHANGED');
    assert.deepEqual(inventory(destination), changed); assert.equal(transfer.assertReady(destination), true);
  });
  await test('missing slots distinct from present [] and zero-byte/corrupt files rejected', async () => {
    const p = notebook(profile(), { blocks: '[]\n' }); const partial = await transfer.createArchive({ userData: p, source });
    assert.equal(partial.slots.blocks.present, true); assert.equal(partial.slots.flushes.present, false);
    const target = notebook(profile()); await transfer.importArchive({ userData: target, archive: partial });
    assert.deepEqual(fs.readdirSync(path.join(target, 'grow')), ['blocks.json']);
    const absent = await transfer.createArchive({ userData: profile(), source });
    assert(absent && Object.values(absent.slots).every(s => !s.present));
    const emptyTarget = profile(); await transfer.importArchive({ userData: emptyTarget, archive: absent });
    assert.deepEqual(fs.readdirSync(path.join(emptyTarget, 'grow')), []);
    assert.equal((await transfer.importArchive({ userData: emptyTarget, archive: absent })).status, 'already-imported');
    for (const text of ['', ' ', '{', 'null', '{}']) {
      const bad = notebook(profile(), { blocks: text }); const before = inventory(bad);
      await expectCode(() => transfer.createArchive({ userData: bad, source })); assert.deepEqual(inventory(bad), before);
    }
  });
  await test('never overwrites [] files, hidden files, unknown files, existing data or non-directory grow', async () => {
    for (const name of ['blocks.json', '.hidden', 'unknown.json']) {
      const p = notebook(profile()); fs.writeFileSync(path.join(p, 'grow', name), '[]');
      const before = inventory(p); await expectCode(() => transfer.importArchive({ userData: p, archive }), 'GROW_DESTINATION_NOT_EMPTY');
      assert.deepEqual(inventory(p), before);
    }
    const p = profile(); fs.writeFileSync(path.join(p, 'grow'), 'original');
    await expectCode(() => transfer.importArchive({ userData: p, archive }), 'GROW_UNSAFE_PATH');
    assert.equal(fs.readFileSync(path.join(p, 'grow'), 'utf8'), 'original');
  });
  await test('source unknown files, nested directories, symlink chains and hard-link aliases rejected', async () => {
    const p = notebook(profile(), { unknown: '[]' }); await expectCode(() => transfer.createArchive({ userData: p, source }), 'GROW_UNKNOWN_FILE');
    const nested = notebook(profile()); fs.mkdirSync(path.join(nested, 'grow', 'blocks.json'));
    await expectCode(() => transfer.createArchive({ userData: nested, source }), 'GROW_UNSAFE_PATH');
    const linked = profile(); fs.symlinkSync(path.join(original, 'grow'), path.join(linked, 'grow'));
    await expectCode(() => transfer.createArchive({ userData: linked, source }), 'GROW_UNSAFE_PATH');
    await expectCode(() => transfer.importArchive({ userData: linked, archive }), 'GROW_UNSAFE_PATH');
    const ancestor = path.join(root, 'alias'); fs.symlinkSync(original, ancestor);
    await expectCode(() => transfer.createArchive({ userData: ancestor, source }), 'GROW_UNSAFE_PATH');
    await expectCode(() => transfer.importArchive({ userData: ancestor, archive }), 'GROW_UNSAFE_PATH');
    const fileLink = notebook(profile()); fs.symlinkSync(path.join(original, 'grow', 'blocks.json'), path.join(fileLink, 'grow', 'blocks.json'));
    await expectCode(() => transfer.createArchive({ userData: fileLink, source }), 'GROW_UNSAFE_PATH');
    const hard = notebook(profile()); fs.linkSync(path.join(original, 'grow', 'log.json'), path.join(hard, 'grow', 'log.json'));
    await expectCode(() => transfer.createArchive({ userData: hard, source }), 'GROW_UNSAFE_PATH');
    fs.unlinkSync(path.join(hard, 'grow', 'log.json'));
    await expectCode(() => transfer.createArchive({ userData: original + '/../' + path.basename(original), source }));
  });
  await test('fatal UTF-8 and unsupported BOM are rejected without changing source', async () => {
    for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[]')])]) {
      const p = notebook(profile()); fs.writeFileSync(path.join(p, 'grow', 'blocks.json'), bytes);
      await expectCode(() => transfer.createArchive({ userData: p, source })); assert.deepEqual(fs.readFileSync(path.join(p, 'grow', 'blocks.json')), bytes);
    }
    await expectCode(() => transfer.validateArchive(Buffer.from([0xff])), 'GROW_INVALID_UTF8');
  });
  await test('strict stable IDs and duplicates, unknown row fields preserved, dangerous keys explicitly rejected', async () => {
    for (const row of [{}, { id: 1 }, { id: '' }, { id: ' x' }, { id: 'x\n' }, { id: 'x'.repeat(201) }, [], null]) {
      await expectCode(() => transfer.validateArchive(withText(archive, JSON.stringify([row]))), 'GROW_INVALID_ID');
    }
    await expectCode(() => transfer.validateArchive(withText(archive, '[{"id":"same"},{"id":"same"}]')), 'GROW_DUPLICATE_ID');
    for (const text of ['[{"id":"x","unknown":{"__proto__":true}}]', '[{"id":"x","constructor":1}]',
      '[{"id":"x","prototype":1}]', '[{"id":"x","id":"y"}]', '[{"id":"x","a":1,"\\u0061":2}]', '[{"id":"x","n":1e999}]']) {
      await expectCode(() => transfer.validateArchive(withText(archive, text)), 'GROW_INVALID_JSON');
    }
    const accepted = withText(archive, '[{"id":"../kept-as-data","olderField":{"a":[true,null,-0,2]},"timestamp":"old literal"}]');
    assert.equal(transfer.validateArchive(accepted).slots.blocks.text, accepted.slots.blocks.text);
  });
  await test('archive slot allowlist and path escape reject before writes; raw/checksum/count/version validation', async () => {
    const cases = [];
    let bad = clone(archive); bad.slots['../../escape'] = bad.slots.blocks; cases.push(bad);
    bad = clone(archive); delete bad.slots.env; cases.push(bad);
    bad = clone(archive); bad.slots.blocks.filename = '../escape'; cases.push(bad);
    bad = clone(archive); bad.profile = '/somewhere'; cases.push(bad);
    bad = clone(archive); bad.slots.blocks.bytes++; cases.push(bad);
    bad = clone(archive); bad.slots.blocks.count++; cases.push(bad);
    bad = clone(archive); bad.slots.blocks.sha256 = '0'.repeat(64); cases.push(bad);
    bad = clone(archive); bad.version = 2; cases.push(bad);
    bad = clone(archive); bad.archiveId = '0'.repeat(64); cases.push(bad);
    bad = clone(archive); bad.source.edition = 'unknown'; cases.push(bad);
    bad = clone(archive); bad.slots.blocks.present = false; cases.push(bad);
    bad = clone(archive); bad.slots.blocks.text = '\ud800'; cases.push(seal(bad));
    for (const invalid of cases) {
      const p = profile(); await expectCode(() => transfer.importArchive({ userData: p, archive: invalid })); assert.deepEqual(fs.readdirSync(p), []);
    }
  });
  await test('object input rejects getters, symbols, decorated arrays, cycles and non-JSON coercion', async () => {
    const cases = [];
    let invalid = clone(archive); Object.defineProperty(invalid.source, 'version', { get() { throw new Error('getter executed'); }, enumerable: true }); cases.push(invalid);
    invalid = clone(archive); invalid.extra = undefined; cases.push(invalid);
    invalid = clone(archive); invalid.extra = NaN; cases.push(invalid);
    invalid = clone(archive); invalid.extra = 1n; cases.push(invalid);
    invalid = clone(archive); invalid.extra = new Date(); cases.push(invalid);
    invalid = clone(archive); invalid[Symbol('s')] = 'bad'; cases.push(invalid);
    invalid = clone(archive); invalid.extra = invalid; cases.push(invalid);
    invalid = clone(archive); invalid.extra = Array(2); cases.push(invalid);
    invalid = clone(archive); invalid.extra = []; invalid.extra.x = 1; cases.push(invalid);
    for (const value of cases) await expectCode(() => transfer.validateArchive(value), 'GROW_INVALID_JSON');
    const duplicateEnvelope = JSON.stringify(archive).replace('"version":1', '"version":1,"version":1');
    await expectCode(() => transfer.validateArchive(duplicateEnvelope), 'GROW_INVALID_JSON');
  });
  await test('row/file/raw/archive size, count, depth and node bounds', async () => {
    await expectCode(() => transfer.validateArchive(withText(archive, JSON.stringify(Array.from({ length: 10001 }, (_, i) => ({ id: String(i) }))))), 'GROW_LIMIT');
    await expectCode(() => transfer.validateArchive(withText(archive, '[{"id":"x","note":"' + 'x'.repeat(LIMITS.rowBytes) + '"}]')), 'GROW_LIMIT');
    await expectCode(() => transfer.validateArchive(withText(archive, '[{' + ' '.repeat(LIMITS.rowBytes) + '"id":"x"}]')), 'GROW_LIMIT');
    let row = { id: 'deep', extension: 'leaf' }; for (let i = 0; i < 42; i++) row.extension = { next: row.extension };
    await expectCode(() => transfer.validateArchive(withText(archive, JSON.stringify([row]))), 'GROW_LIMIT');
    await expectCode(() => transfer.validateArchive(withText(archive, JSON.stringify([{ id: 'nodes', extension: Array(250001).fill(0) }]))), 'GROW_LIMIT');
    const hugeFile = notebook(profile()); fs.writeFileSync(path.join(hugeFile, 'grow', 'blocks.json'), '[]');
    fs.truncateSync(path.join(hugeFile, 'grow', 'blocks.json'), LIMITS.fileBytes + 1);
    await expectCode(() => transfer.createArchive({ userData: hugeFile, source }), 'GROW_LIMIT');
    let large = clone(archive); for (const type of ['blocks', 'flushes', 'contam']) large.slots[type].text = ' '.repeat(11 * 1024 * 1024) + '[]'; seal(large);
    await expectCode(() => transfer.validateArchive(large), 'GROW_LIMIT'); large = null;
    // Raw bytes within 32 MiB but JSON string escaping takes >64 MiB.
    const encoded = clone(archive); for (const type of ['blocks', 'flushes']) encoded.slots[type].text = '\t'.repeat(LIMITS.fileBytes - 2) + '[]'; seal(encoded);
    await expectCode(() => transfer.validateArchive(encoded));
    await expectCode(() => transfer.validateArchive(' '.repeat(LIMITS.archiveBytes + 1)), 'GROW_LIMIT');
  });
  await test('source modifications, deletion, replacement and new missing files during export fail closed', async () => {
    for (const mutation of ['change', 'delete', 'replace', 'add']) {
      const p = notebook(profile(), { blocks: '[{"id":"original"}]' });
      const api = transfer._testing.createTransfer({ onStep(name) {
        if (name !== 'source-read') return;
        const filename = path.join(p, 'grow', 'blocks.json');
        if (mutation === 'change') fs.writeFileSync(filename, '[{"id":"modified"}]');
        if (mutation === 'delete') fs.unlinkSync(filename);
        if (mutation === 'replace') { fs.renameSync(filename, path.join(p, 'outside')); fs.writeFileSync(filename, '[{"id":"original"}]'); }
        if (mutation === 'add') fs.writeFileSync(path.join(p, 'grow', 'env.json'), '[]');
      } });
      await expectCode(() => api.createArchive({ userData: p, source }), 'GROW_SOURCE_CHANGED');
      assert.equal(fs.existsSync(path.join(p, RECEIPT_NAME)), false);
    }
  });
  await test('validated candidate detached before awaits; preview mutation is revalidated', async () => {
    const mutable = clone(archive), p = profile();
    transfer.inspectArchive(mutable); mutable.slots.blocks.text += ' '; await expectCode(() => transfer.importArchive({ userData: p, archive: mutable }), 'GROW_CHECKSUM');
    assert.deepEqual(fs.readdirSync(p), []);
    const live = clone(archive), destination = profile();
    const api = transfer._testing.createTransfer({ onStep(name) { if (name === 'stage-created') live.slots.blocks.text = 'bad'; } });
    await api.importArchive({ userData: destination, archive: live });
    assert.equal(fs.readFileSync(path.join(destination, 'grow', 'blocks.json'), 'utf8'), archive.slots.blocks.text);
  });
  await test('cooperating writer readiness barrier blocks staging; destination recheck preserves later writes', async () => {
    const p = notebook(profile()); let blocked = false;
    const api = transfer._testing.createTransfer({ onStep(name) {
      if (name === 'stage-created') { assert.throws(() => transfer.assertReady(p), { code: 'GROW_RECOVERY_REQUIRED' }); blocked = true; }
      if (name === 'before-commit') fs.writeFileSync(path.join(p, 'grow', 'blocks.json'), '[]');
    } });
    await expectCode(() => api.importArchive({ userData: p, archive }), 'GROW_DESTINATION_NOT_EMPTY');
    assert(blocked); assert.equal(fs.readFileSync(path.join(p, 'grow', 'blocks.json'), 'utf8'), '[]');
    await expectCode(() => transfer.recoverImport({ userData: p }), 'GROW_DESTINATION_NOT_EMPTY');
  });
  await test('hard process crashes at every import commit boundary retain/reconcile exact content', async () => {
    for (const boundary of ['stage-created', 'stage-file-synced', 'stage-synced', 'journal-file-synced', 'journal-synced',
      'before-commit', 'target-removed', 'renamed', 'commit-synced', 'receipt-file-synced', 'receipt-renamed', 'receipt-synced', 'journal-removed', 'complete']) {
      const p = notebook(profile()); const crashed = crashChild('import', p, archiveFile, boundary);
      assert.equal(crashed.status, 73, `${boundary}: ${crashed.stderr}`);
      const hasJournal = fs.existsSync(path.join(p, JOURNAL_NAME));
      if (['stage-created', 'stage-file-synced', 'stage-synced'].includes(boundary)) {
        assert.equal(hasJournal, false); const before = inventory(p);
        await expectCode(() => transfer.recoverImport({ userData: p }), 'GROW_RECOVERY_REQUIRED'); assert.deepEqual(inventory(p), before);
        assert.deepEqual(fs.readdirSync(path.join(p, 'grow')), []);
      } else {
        if (hasJournal) assert.throws(() => transfer.assertReady(p), { code: 'GROW_RECOVERY_REQUIRED' });
        const recovered = await transfer.recoverImport({ userData: p });
        assert(['committed', 'ready'].includes(recovered.status));
        assert.deepEqual(inventory(path.join(p, 'grow')), inventory(path.join(original, 'grow')));
        assert.equal(transfer.assertReady(p), true);
        assert.equal((await transfer.importArchive({ userData: p, archive })).status, 'already-imported');
      }
    }
  });
  await test('recovery is itself restart-safe at every finalization boundary', async () => {
    for (const boundary of ['before-commit', 'target-removed', 'renamed', 'commit-synced', 'receipt-file-synced',
      'receipt-renamed', 'receipt-synced', 'journal-removed', 'complete']) {
      const p = profile(); assert.equal(crashChild('import', p, archiveFile, 'journal-synced').status, 73);
      const crashed = crashChild('recover', p, archiveFile, boundary); assert.equal(crashed.status, 73, `${boundary}: ${crashed.stderr}`);
      await transfer.recoverImport({ userData: p });
      assert.deepEqual(inventory(path.join(p, 'grow')), inventory(path.join(original, 'grow')));
      assert.equal((await transfer.importArchive({ userData: p, archive })).status, 'already-imported');
    }
  });
  await test('fsync/response errors after rename never remove committed target and support receipt-only retry', async () => {
    for (const boundary of ['renamed', 'commit-synced', 'receipt-file-synced', 'receipt-renamed', 'receipt-synced', 'journal-removed', 'complete']) {
      const p = profile(); const api = transfer._testing.createTransfer({ onStep(name) { if (name === boundary) throw Object.assign(new Error('fixture I/O error'), { code: 'EIO' }); } });
      await assert.rejects(() => api.importArchive({ userData: p, archive }), cause => cause.code === 'GROW_IO' && cause.state === 'recovery-required');
      assert.deepEqual(inventory(path.join(p, 'grow')), inventory(path.join(original, 'grow')));
      await transfer.recoverImport({ userData: p });
      assert.equal((await transfer.importArchive({ userData: p, archive })).status, 'already-imported');
    }
  });
  await test('actual file/directory fsync failures retain evidence and never delete a committed target', async () => {
    const promises = require('node:fs/promises'), originalOpen = promises.open;
    for (let failureAt = 1; failureAt <= 34; failureAt++) {
      const p = profile(); let syncs = 0, fired = false, result, cause;
      promises.open = async (...args) => {
        const handle = await originalOpen(...args), originalSync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (++syncs === failureAt) { fired = true; throw Object.assign(new Error('fixture fsync failure'), { code: 'EIO' }); }
          return originalSync();
        };
        return handle;
      };
      try { result = await transfer.importArchive({ userData: p, archive }); }
      catch (failure) { cause = failure; }
      finally { promises.open = originalOpen; }
      if (!fired) { assert.equal(result.status, 'committed'); continue; }
      assert.equal(cause.code, 'GROW_IO'); assert.equal(cause.state, 'recovery-required');
      const committed = fs.existsSync(path.join(p, 'grow'));
      const hasJournal = fs.existsSync(path.join(p, JOURNAL_NAME));
      if (committed) {
        assert.equal(cause.committed, true);
        assert.deepEqual(inventory(path.join(p, 'grow')), inventory(path.join(original, 'grow')));
      }
      if (hasJournal || committed) {
        await transfer.recoverImport({ userData: p });
        assert.equal((await transfer.importArchive({ userData: p, archive })).status, 'already-imported');
      } else {
        const before = inventory(p); await expectCode(() => transfer.recoverImport({ userData: p }), 'GROW_RECOVERY_REQUIRED');
        assert.deepEqual(inventory(p), before);
      }
    }
  });
  await test('corrupt journals, replaced stages/targets, tampered content, unknown entries and receipt conflicts remain blocked', async () => {
    for (const mutation of ['journal', 'stage-file', 'stage-identity', 'target-identity', 'unknown', 'extra-stage', 'receipt', 'missing-stage']) {
      const p = notebook(profile()); assert.equal(crashChild('import', p, archiveFile, 'journal-synced').status, 73);
      const stage = path.join(p, fs.readdirSync(p).find(n => n.startsWith(STAGE_PREFIX)));
      if (mutation === 'journal') fs.writeFileSync(path.join(p, JOURNAL_NAME), '{');
      if (mutation === 'stage-file') fs.writeFileSync(path.join(stage, 'blocks.json'), '[]');
      if (mutation === 'stage-identity') { fs.renameSync(stage, path.join(root, `retained-stage-${counter}`)); fs.mkdirSync(stage); }
      if (mutation === 'target-identity') { fs.renameSync(path.join(p, 'grow'), path.join(root, `retained-empty-${counter}`)); fs.mkdirSync(path.join(p, 'grow')); }
      if (mutation === 'unknown') fs.writeFileSync(path.join(stage, 'unrecognized'), 'do not remove');
      if (mutation === 'extra-stage') fs.mkdirSync(path.join(p, STAGE_PREFIX + 'unknown'));
      if (mutation === 'receipt') fs.writeFileSync(path.join(p, RECEIPT_NAME), '{}');
      if (mutation === 'missing-stage') fs.renameSync(stage, path.join(root, `retained-missing-${counter}`));
      const before = inventory(p); await expectCode(() => transfer.recoverImport({ userData: p }));
      assert.deepEqual(inventory(p), before); assert.throws(() => transfer.assertReady(p), { code: 'GROW_RECOVERY_REQUIRED' });
    }
  });
  await test('committed target identity and exact hashes must match before journal retirement', async () => {
    for (const mutation of ['content', 'identity', 'extra', 'missing', 'symlink']) {
      const p = profile(); assert.equal(crashChild('import', p, archiveFile, 'renamed').status, 73);
      const grow = path.join(p, 'grow');
      if (mutation === 'content') fs.writeFileSync(path.join(grow, 'flushes.json'), '[]');
      if (mutation === 'identity') { fs.renameSync(grow, path.join(root, `retained-committed-${counter}`)); fs.mkdirSync(grow); }
      if (mutation === 'extra') fs.writeFileSync(path.join(grow, '.hidden'), 'keep');
      if (mutation === 'missing') fs.unlinkSync(path.join(grow, 'log.json'));
      if (mutation === 'symlink') { fs.renameSync(grow, path.join(root, `retained-linked-${counter}`)); fs.symlinkSync(path.join(root, `retained-linked-${counter}`), grow); }
      const before = inventory(p); await expectCode(() => transfer.recoverImport({ userData: p })); assert.deepEqual(inventory(p), before);
      assert(fs.existsSync(path.join(p, JOURNAL_NAME)));
    }
  });
  await test('sync readiness is read-only and refuses symlinked metadata and dangling journal', async () => {
    const p = profile(); fs.symlinkSync(path.join(p, 'missing'), path.join(p, JOURNAL_NAME));
    const before = inventory(p); assert.throws(() => transfer.assertReady(p), { code: 'GROW_RECOVERY_REQUIRED' }); assert.deepEqual(inventory(p), before);
    const q = profile(); fs.symlinkSync(path.join(q, 'missing'), path.join(q, RECEIPT_NAME));
    assert.throws(() => transfer.assertReady(q), { code: 'GROW_UNSAFE_PATH' });
    const nonexistent = path.join(root, 'never-created'); await expectCode(() => transfer.importArchive({ userData: nonexistent, archive }), 'GROW_UNSAFE_PATH');
    assert.equal(fs.existsSync(nonexistent), false);
  });
  assert.deepEqual(inventory(original), beforeSource);
  process.stdout.write(`\n${passed} notebook transfer tests passed (synthetic data only).\n`);
}

if (process.argv[2] === '--crash') childMain().catch(cause => { process.stderr.write(cause.stack + '\n'); process.exit(1); });
else main().catch(cause => { process.stderr.write(cause.stack + '\n'); process.exitCode = 1; }).finally(() => { if (root) removeFixture(root); });
