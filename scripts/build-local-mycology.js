'use strict';
// Explicit opt-in local helper. Does not install or launch the result.
// Every writable build input is independently copied; shared deps never rebuild.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const GiB = 1024 ** 3;
function space(where, required) {
  const stat = fs.statfsSync(where);
  assert.ok(stat.bavail * stat.bsize >= required, 'Insufficient disk headroom; no cleanup of unrelated files is permitted');
}
function copyTree(from, to) {
  fs.cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true,
    force: false, mode: fs.constants.COPYFILE_FICLONE });
}
function linksStayInside(directory) {
  function visit(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink()) {
        const relative = path.relative(directory, fs.realpathSync(file));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Staged symlink escapes independent dependency tree');
      } else if (item.isDirectory()) visit(file);
      else assert.equal(fs.statSync(file).nlink, 1, 'Hardlinked build input refused');
    }
  }
  visit(directory);
}
async function build(destination) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.ok(destination && path.isAbsolute(destination), 'Pass a fresh absolute staging directory');
  assert.ok(!fs.existsSync(destination), 'Staging directory already exists');
  space(path.dirname(destination), 2 * GiB);
  const config = require('../electron-builder.mycology.local');
  assert.equal(config.appId, 'com.crowelogic.desktop.mycology');
  assert.equal(config.mac.identity, null); assert.equal(config.mac.notarize, false);
  assert.equal(config.afterSign, null); assert.equal(config.publish, null);
  assert.equal(config.afterPack, 'build/fuses.js');
  assert.equal(config.npmRebuild, false);
  const tools = createRequire(require.resolve('electron-builder/package.json'));
  const { minimatch } = tools('minimatch');
  const patterns = config.files.filter(p => !p.startsWith('node_modules/'));
  const positives = patterns.filter(p => !p.startsWith('!'));
  const negatives = patterns.filter(p => p.startsWith('!')).map(p => p.slice(1));
  const selected = name => positives.some(p => minimatch(name, p)) && !negatives.some(p => minimatch(name, p));
  const files = new Set(['package.json', 'package-lock.json', 'electron-builder.mycology.js',
    'electron-builder.mycology.local.js', 'scripts/release-channel.js']);
  function enumerate(dir, prefix = '') {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + item.name;
      if (item.name.startsWith('.') || ['node_modules', 'mobile', 'release', 'release-mycology'].includes(name)) continue;
      if (item.isSymbolicLink()) { if (selected(name)) throw new Error('Application source symlink refused'); continue; }
      if (item.isDirectory()) {
        if (['assets', 'renderer', 'rooms', 'farm', 'vision', 'cloud', 'plugins', 'build'].includes(name) || prefix) enumerate(path.join(dir, item.name), name + '/');
      } else if (selected(name) || name.startsWith('build/')) files.add(name);
    }
  }
  enumerate(root);
  const snapshot = [...files].sort().map(file => ({ file, sha256: hash(fs.readFileSync(path.join(root, file))) }));
  fs.mkdirSync(destination, { mode: 0o700 });
  const stage = path.join(destination, 'stage'); fs.mkdirSync(stage);
  for (const item of snapshot) {
    const to = path.join(stage, item.file); fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(root, item.file), to, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    assert.equal(hash(fs.readFileSync(to)), item.sha256, 'Source changed during snapshot');
  }
  const shared = fs.realpathSync(path.join(root, 'node_modules'));
  const guarded = ['electron/dist/Electron.app/Contents/MacOS/Electron', 'node-pty/build/Release/pty.node'];
  const before = guarded.map(file => hash(fs.readFileSync(path.join(shared, file))));
  copyTree(shared, path.join(stage, 'node_modules'));
  linksStayInside(path.join(stage, 'node_modules'));
  const pty = path.join(stage, 'node_modules/node-pty');
  fs.rmSync(path.join(pty, 'build'), { recursive: true, force: true });
  for (const name of fs.readdirSync(path.join(pty, 'prebuilds'))) {
    if (name !== 'darwin-arm64') fs.rmSync(path.join(pty, 'prebuilds', name), { recursive: true });
  }
  assert.ok(!fs.existsSync(path.join(stage, 'rooms/agents.vendored.json')));
  const home = path.join(destination, 'build-home'), tmp = path.join(destination, 'build-tmp');
  fs.mkdirSync(home); fs.mkdirSync(tmp);
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: tmp, LANG: 'en_US.UTF-8',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false', CROWE_SKIP_NOTARIZE: '1', CI: 'true' };
  space(destination, 1.5 * GiB);
  const result = spawnSync(process.execPath, [path.join(stage, 'node_modules/electron-builder/cli.js'),
    '--config', 'electron-builder.mycology.local.js', '--mac', 'dir', '--arm64', '--publish', 'never'],
  { cwd: stage, env, encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  fs.writeFileSync(path.join(destination, 'build.log'), (result.stdout || '') + (result.stderr || ''));
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Directory build failed; inspect build.log');
  const app = path.join(stage, 'candidate/mac-arm64/Crowe Logic Mycology.app');
  const resources = path.join(app, 'Contents/Resources');
  assert.ok(!fs.existsSync(path.join(resources, 'app-update.yml')), 'Local candidate must not carry an updater feed');
  space(destination, GiB);
  // Builder's identity:'-' still enumerates Keychain identities. Bypass that
  // path with direct explicit signing, identity validation/profile embedding off.
  const signer = tools('@electron/osx-sign');
  const previous = process.env; process.env = env;
  try {
    await signer.signAsync({ app, platform: 'darwin', identity: '-', identityValidation: false,
      preAutoEntitlements: false, preEmbedProvisioningProfile: false, gatekeeperAssess: false,
      optionsForFile: file => ({ hardenedRuntime: true, timestamp: 'none',
        entitlements: path.join(stage, file === app ? 'build/entitlements.mac.plist' : 'build/entitlements.mac.inherit.plist') }) });
  } finally { process.env = previous; }
  const audit = require('./audit-customer-payload').auditPayload(path.join(resources, 'app.asar'), { kind: 'desktop', edition: 'mycology' });
  fs.writeFileSync(path.join(destination, 'payload-audit.json'), JSON.stringify(audit, null, 2));
  assert.equal(audit.ok, true, 'Packaged customer payload gate failed');
  const metadata = JSON.parse(tools('@electron/asar').extractFile(path.join(resources, 'app.asar'), 'package.json'));
  assert.equal(metadata.croweLocalPrerelease, true);
  assert.equal(metadata.croweBuildChannel, 'local-prerelease');
  assert.equal(metadata.version, require('../package.json').version);
  for (const [i, file] of guarded.entries()) assert.equal(hash(fs.readFileSync(path.join(shared, file))), before[i], 'Shared dependencies changed');
  for (const item of snapshot) assert.equal(hash(fs.readFileSync(path.join(root, item.file))), item.sha256, 'Source changed after snapshot; candidate is stale');
  const evidence = { classification: 'local-prerelease-not-a-release', version: metadata.version,
    appId: config.appId, app, signing: 'ad-hoc', installed: false, launched: false,
    source: snapshot, nativeSelection: 'node-pty/prebuilds/darwin-arm64; staged build and other prebuilds removed',
    asarSha256: hash(fs.readFileSync(path.join(resources, 'app.asar'))), sharedInputsUnchanged: true };
  fs.writeFileSync(path.join(destination, 'build-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ app, evidence: path.join(destination, 'build-evidence.json'), payloadFiles: audit.inventory.length }));
}
if (require.main === module) build(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { build };
