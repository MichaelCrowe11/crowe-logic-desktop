'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const { auditPayload } = require('./audit-customer-payload');
const asar = createRequire(require.resolve('electron-builder/package.json'))('@electron/asar');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-payload-audit-'));
const source = path.join(root, 'source');
const archive = path.join(root, 'app.asar');
let checks = 0;
function put(name, text) {
  const file = path.join(source, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
async function pack() { await asar.createPackage(source, archive); }
function audit() { return auditPayload(archive, { kind: 'desktop', edition: 'mycology' }); }
function rule(result, expected) { assert.ok(result.issues.some(i => i.rule === expected)); checks++; }
(async () => {
  try {
    for (const name of ['main.js', 'preload.js', 'app-edition.js', 'edition-bootstrap.js', 'rooms/registry.js',
      'cloud/profile-auth.js', 'farm/worker.js', 'vision/host.js', 'THIRD_PARTY_NOTICES.md']) put(name, '// synthetic test payload\n');
    put('rooms/agents.customer.json', fs.readFileSync(path.join(__dirname, '../rooms/agents.customer.json')));
    put('package.json', JSON.stringify({ version: require('../package.json').version, croweEdition: 'mycology' }));
    await pack();
    assert.equal(audit().ok, true); checks++;
    fs.unlinkSync(path.join(source, 'cloud/profile-auth.js'));
    await pack();
    assert.ok(audit().issues.some(i => i.file === 'cloud/profile-auth.js' && i.rule === 'missing-packed-runtime-file')); checks++;
    put('cloud/profile-auth.js', '// synthetic test payload\n');
    put('rooms/agents.vendored.json', '{}');
    await pack();
    rule(audit(), 'excluded-private-or-fixture-path');
    fs.unlinkSync(path.join(source, 'rooms/agents.vendored.json'));
    put('main.js', 'const marker = "swm-sops";');
    await pack();
    rule(audit(), 'internal-sop-bucket');
    assert.equal(JSON.stringify(audit().issues).includes('swm-sops'), false); checks++;
    put('main.js', '// synthetic test payload\n');
    put('rooms/agents.customer.json', '{}');
    await pack();
    rule(audit(), 'customer-roster-mismatch');
    put('rooms/agents.customer.json', fs.readFileSync(path.join(__dirname, '../rooms/agents.customer.json')));
    put('package.json', JSON.stringify({ version: require('../package.json').version, croweEdition: 'desktop' }));
    await pack();
    rule(audit(), 'edition-mismatch');
    fs.mkdirSync(archive + '.unpacked/rooms', { recursive: true });
    fs.writeFileSync(archive + '.unpacked/rooms/agents.vendored.json', '{}');
    rule(audit(), 'excluded-private-or-fixture-path');
    fs.symlinkSync(source, archive + '.unpacked/linked');
    rule(audit(), 'unreviewed-symlink');
    // Declared unpacked payloads must exist and match the declared size.
    fs.rmSync(archive + '.unpacked', { recursive: true, force: true });
    put('plugins/fixture.js', '// synthetic unpacked module');
    await asar.createPackageWithOptions(source, archive, { unpack: '**/plugins/**' });
    const unpackedFile = archive + '.unpacked/plugins/fixture.js';
    assert.equal(fs.existsSync(unpackedFile), true); checks++;
    fs.unlinkSync(unpackedFile);
    rule(audit(), 'missing-declared-unpacked-file');
    fs.mkdirSync(unpackedFile);
    rule(audit(), 'missing-declared-unpacked-file');
    fs.rmdirSync(unpackedFile);
    fs.writeFileSync(unpackedFile, 'short');
    rule(audit(), 'unpacked-size-mismatch');
    fs.writeFileSync(unpackedFile, '// swm-sops synthetic marker');
    rule(audit(), 'internal-sop-bucket');
    const web = path.join(root, 'web');
    fs.mkdirSync(web);
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html>');
    fs.copyFileSync(path.join(__dirname, '../renderer/rooms-web.js'), path.join(web, 'rooms-web.js'));
    const result = auditPayload(web, { kind: 'web' });
    // A stale/private source bundle is not blessed just because it matches disk.
    assert.equal(result.issues.some(i => i.rule === 'customer-bundle-mismatch'), false); checks++;
    fs.writeFileSync(path.join(web, 'rooms-web.js'), 'wrong bundle');
    rule(auditPayload(web, { kind: 'web' }), 'customer-bundle-mismatch');
    console.log(`customer payload audit: ${checks} synthetic checks passed; no customer artifact accepted`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(() => { console.error('Customer payload audit fixture failed'); process.exitCode = 1; });
