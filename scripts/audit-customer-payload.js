'use strict';

// Checks the actual customer payload, not electron-builder's source patterns.
// This is a private-content/roster gate, not signing or a complete secret audit.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
const LIMIT = 32 * 1024 * 1024;
const TEXT = /\.(?:[cm]?js|json|html|css|md|txt|ya?ml|map|py|sh)$/i;
const FORBIDDEN = /(?:^|\/)(?:agents\.vendored\.json|CLAUDE\.md|MEMORY\.md|\.git|\.claude|\.env(?:\.[^/]*)?)(?:\/|$)|(?:^|\/)farm\/fixtures\.js$|(?:^|\/)renderer\/(?:preview\.html|preview-shim\.js)$/i;
const MARKERS = [
  ['internal-prompt-reference', 'SYSTEM_PROMPT.md'],
  ['internal-sop-bucket', 'swm-sops'],
  ['operator-home-path', '/Users/crowelogic/'],
];
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function asarLibrary() {
  // Use the locked builder dependency; do not fetch an audit tool at release time.
  return createRequire(require.resolve('electron-builder/package.json'))('@electron/asar');
}

function auditPayload(target, { kind, edition } = {}) {
  if (!['desktop', 'web'].includes(kind)) throw new Error('Specify payload kind desktop or web');
  const abs = path.resolve(target);
  if (fs.lstatSync(abs).isSymbolicLink()) throw new Error('Payload root must not be a symlink');
  // Evaluate source policy now, not against a cached prior build result.
  require('./sync-agent-registry').readCustomerRoster();
  const { bundle: freshBundle } = require('./build-rooms-web').createRoomsBundle();
  const issues = [];
  const inventory = [];
  const entries = new Map();
  const issue = (file, rule) => issues.push({ file, rule });
  function record(name, bytes) {
    inventory.push({ file: name, size: bytes.length, sha256: hash(bytes) });
    if (FORBIDDEN.test(name)) issue(name, 'excluded-private-or-fixture-path');
    if (TEXT.test(name)) {
      const text = bytes.toString('utf8');
      for (const [rule, marker] of MARKERS) if (text.includes(marker)) issue(name, rule);
    }
  }
  function directory(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { issue(name, 'unreviewed-symlink'); continue; }
      if (entry.isDirectory()) {
        if (FORBIDDEN.test(name)) issue(name, 'excluded-private-or-fixture-path');
        directory(file, name + '/');
      } else if (entry.isFile()) {
        const size = fs.statSync(file).size;
        if (size > LIMIT) { issue(name, 'file-exceeds-audit-bound'); continue; }
        const bytes = fs.readFileSync(file);
        record(name, bytes);
        entries.set(name, bytes);
      } else issue(name, 'nonregular-entry');
    }
  }
  if (kind === 'desktop') {
    if (!fs.statSync(abs).isFile() || path.basename(abs) !== 'app.asar') throw new Error('Desktop audit requires the actual app.asar');
    const asar = asarLibrary();
    asar.uncache(abs);
    const declaredUnpacked = new Map();
    for (const raw of asar.listPackage(abs)) {
      const name = raw.replace(/^\//, '');
      if (name.split('/').some(p => !p || p === '..' || p === '.') || name.includes('\\') || path.isAbsolute(name)) {
        issue(name, 'unsafe-archive-path'); continue;
      }
      const stat = asar.statFile(abs, name, false);
      if (stat.files) continue;
      if (stat.link) { issue(name, 'unreviewed-archive-link'); continue; }
      if (stat.size > LIMIT) { issue(name, 'file-exceeds-audit-bound'); continue; }
      if (stat.unpacked) {
        declaredUnpacked.set('app.asar.unpacked/' + name, stat.size);
        continue; // Inspect physical bytes below, including orphaned files.
      }
      const bytes = asar.extractFile(abs, name, false);
      record(name, bytes);
      entries.set(name, bytes);
    }
    const unpacked = abs + '.unpacked';
    if (fs.existsSync(unpacked)) {
      if (fs.lstatSync(unpacked).isSymbolicLink()) issue('app.asar.unpacked', 'unreviewed-symlink');
      else directory(unpacked, 'app.asar.unpacked/');
    }
    for (const [name, size] of declaredUnpacked) {
      const bytes = entries.get(name);
      if (!bytes) issue(name, 'missing-declared-unpacked-file');
      else if (bytes.length !== size) issue(name, 'unpacked-size-mismatch');
    }
    for (const required of ['main.js', 'preload.js', 'app-edition.js', 'edition-bootstrap.js', 'rooms/registry.js',
      'rooms/agents.customer.json', 'cloud/profile-auth.js', 'farm/worker.js', 'vision/host.js', 'THIRD_PARTY_NOTICES.md', 'package.json']) {
      if (!entries.has(required)) issue(required, 'missing-packed-runtime-file');
    }
    const roster = entries.get('rooms/agents.customer.json');
    const approved = fs.readFileSync(path.join(ROOT, 'rooms/agents.customer.json'));
    if (roster && !roster.equals(approved)) issue('rooms/agents.customer.json', 'customer-roster-mismatch');
    const metadata = entries.get('package.json');
    if (metadata) {
      try {
        const pkg = JSON.parse(metadata);
        if (!edition || pkg.croweEdition !== edition) issue('package.json', 'edition-mismatch');
        if (pkg.version !== require('../package.json').version) issue('package.json', 'source-version-mismatch');
      } catch { issue('package.json', 'invalid-package-metadata'); }
    }
  } else {
    if (!fs.statSync(abs).isDirectory()) throw new Error('Web audit requires a generated payload directory');
    directory(abs);
    const bundle = entries.get('rooms-web.js');
    const approved = Buffer.from(freshBundle);
    if (!bundle || !bundle.equals(approved)) issue('rooms-web.js', 'customer-bundle-mismatch');
    if (!entries.has('index.html')) issue('index.html', 'missing-entry');
  }
  inventory.sort((a, b) => a.file.localeCompare(b.file));
  return { ok: issues.length === 0, kind, edition: edition || null, issues, inventory,
    scope: 'Roster, known private markers and payload inventory only; not signature, provenance, complete secret or installer acceptance.' };
}

if (require.main === module) {
  try {
    const [kind, target, edition] = process.argv.slice(2);
    if (!target) throw new Error('usage: node scripts/audit-customer-payload.js <desktop|web> <payload> [edition]');
    const result = auditPayload(target, { kind, edition });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    // Never dump suspect file contents or archive parse errors.
    console.error('Customer payload audit could not complete. Check the payload path, kind and required source files.');
    process.exitCode = 1;
  }
}
module.exports = { auditPayload };
