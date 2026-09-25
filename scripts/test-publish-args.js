'use strict';

// Run copied publishers only, with synthetic artifacts and sealed substitute
// upload/verification executables. No real publisher credential or network path
// is exercised, even when testing the non-dry-run shell control flow.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { resolvePublishArgs, shellArgs } = require('./publish-args');
const pkg = require('../package.json');
const matrix = 'mac:arm64:dmg+zip';
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-publisher-contract-')));
let checks = 0;
const check = fn => { fn(); checks++; };
const hash = (data, kind = 'sha512', encoding = 'base64') => crypto.createHash(kind).update(data).digest(encoding);
try {
  const repo = path.join(root, 'repo');
  const caller = path.join(root, "caller with ' quotes");
  const scripts = path.join(repo, 'scripts');
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  for (const dir of [scripts, caller, bin, home]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: pkg.version }));
  for (const name of ['publish-r2.sh', 'publish-rclone.sh', 'publish-args.js', 'release-channel.js', 'release-matrix.js']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(scripts, name));
  }
  fs.copyFileSync(path.join(__dirname, 'preflight-release.js'), path.join(scripts, 'preflight-core.js'));
  fs.mkdirSync(path.join(repo, 'node_modules'));
  fs.symlinkSync(path.dirname(require.resolve('js-yaml/package.json')), path.join(repo, 'node_modules/js-yaml'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const trace = path.join(root, 'trace.jsonl');
  const record = "require('node:fs').appendFileSync(process.env.TRACE, JSON.stringify";
  fs.writeFileSync(path.join(scripts, 'preflight-release.js'), `
    ${record}({kind:'preflight', args:process.argv.slice(2)})+'\\n');
    const r=require('node:child_process').spawnSync(process.execPath,[require('node:path').join(__dirname,'preflight-core.js'),...process.argv.slice(2)],{stdio:'inherit'});
    ${record}({kind:'preflight-result',status:r.status})+'\\n');
    process.exit(r.status === null ? 1 : r.status);
  `);
  fs.writeFileSync(path.join(scripts, 'verify-release.js'), `
    ${record}({kind:'verify', args:process.argv.slice(2)})+'\\n');
    process.exit(Number(process.env.VERIFY_STATUS || 0));
  `);
  const executable = (name, source) => fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  executable('npx', `
    const fs=require('node:fs'),crypto=require('node:crypto');
    const data=fs.readFileSync(0);
    ${record}({kind:'upload',tool:'npx',args:process.argv.slice(2),sha256:crypto.createHash('sha256').update(data).digest('hex')})+'\\n');
  `);
  executable('rclone', `
    const fs=require('node:fs'),crypto=require('node:crypto');
    const data=fs.readFileSync(process.argv.at(-2));
    ${record}({kind:'upload',tool:'rclone',args:process.argv.slice(2),sha256:crypto.createHash('sha256').update(data).digest('hex')})+'\\n');
  `);
  // These must never be consulted, even accidentally, by preflight/dry-run.
  for (const name of ['aws', 'az', 'security', 'asm-exec', 'curl', 'gh']) executable(name, `
    ${record}({kind:'forbidden',tool:${JSON.stringify(name)}})+'\\n'); process.exit(99);
  `);
  const config = path.join(caller, 'edition config.json');
  fs.writeFileSync(config, JSON.stringify({ publish: [{ channel: 'mycology' }], directories: { output: 'release-mycology' } }));
  const explicit = path.join(caller, 'artifacts');
  const body = Buffer.from('synthetic release bytes');
  const items = ['zip', 'dmg'].map(type => ({ url: `CroweLogic-mycology-${pkg.version}-arm64.${type}`, size: body.length, sha512: hash(body) }));
  function fixture(dir) {
    fs.mkdirSync(dir, { recursive: true });
    // Preflight skips build .app directories. Upload discovery must skip them
    // too, rather than publishing a same-named, unvalidated nested artifact.
    const app = path.join(dir, 'Unvalidated.app');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'mycology-mac.yml'), 'not a release feed');
    for (const item of items) fs.writeFileSync(path.join(app, item.url), 'unvalidated bytes');
    for (const item of items) {
      fs.writeFileSync(path.join(dir, item.url), body);
      fs.writeFileSync(path.join(dir, item.url + '.blockmap'), zlib.gzipSync(Buffer.from(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, sizes: [body.length], checksums: ['synthetic'] }] }))));
    }
    fs.writeFileSync(path.join(dir, 'mycology-mac.yml'), JSON.stringify({ version: pkg.version, files: items, path: items[0].url }));
  }
  fixture(explicit);
  fixture(path.join(repo, 'release-mycology'));
  // A competing same-name tree in the repository must not override caller root.
  fixture(path.join(repo, 'artifacts'));
  const defaults = { cwd: caller, repo, env: {} };
  const args = ['artifacts', '--config', 'edition config.json', '--matrix', matrix];
  check(() => {
    const parsed = resolvePublishArgs(args, defaults);
    assert.equal(parsed.root, explicit);
    assert.equal(parsed.channel, 'mycology');
    assert.equal(parsed.version, pkg.version);
    assert.deepEqual(parsed.validationArgs, ['--config', config, '--channel', 'mycology', '--strict', '--matrix', matrix]);
    const quoted = spawnSync('/bin/bash', ['-c', `${shellArgs(parsed)}\nprintf '%s\\n' "$root" "\${validation_args[@]}"`], { encoding: 'utf8', env: {} });
    assert.equal(quoted.status, 0);
    assert.deepEqual(quoted.stdout.trimEnd().split('\n'), [explicit, ...parsed.validationArgs]);
  });
  check(() => assert.equal(resolvePublishArgs(['--config=edition config.json', '--matrix=' + matrix], defaults).root, path.join(repo, 'release-mycology')));
  check(() => assert.equal(resolvePublishArgs(['--matrix', matrix], defaults).channel, 'latest'));
  check(() => assert.equal(resolvePublishArgs(args, { ...defaults, env: { GITHUB_REF_NAME: 'v' + pkg.version } }).version, pkg.version));
  const unloadedConfig = path.join(caller, 'must-not-load.js');
  fs.writeFileSync(unloadedConfig, 'throw new Error("CONFIG LOADED BEFORE CLI VALIDATION");');
  const unreadEnv = new Proxy({}, { get() { throw new Error('ENV READ BEFORE CLI VALIDATION'); } });
  for (const flags of [[], ['--matrix', matrix, '--unknown'], ['--matrix', matrix, '--channel', '../wrong']]) check(() => {
    assert.throws(() => resolvePublishArgs(['--config', unloadedConfig, ...flags], { ...defaults, env: unreadEnv }), /explicit --matrix|unexpected publisher|release channel must/);
  });

  function run(script, flags = args, overrides = {}) {
    fs.writeFileSync(trace, '');
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: root, TRACE: trace, DRY_RUN: '1', ...overrides };
    const result = spawnSync('/bin/bash', [path.join(scripts, script), ...flags], { cwd: caller, env, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    const events = fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(events.some(event => event.kind === 'forbidden'), false);
    return { ...result, events };
  }
  for (const script of ['publish-r2.sh', 'publish-rclone.sh']) {
    for (const invalid of [
      [], ['--strict'], ['--matrix'], ['--matrix='],
      ['--matrix', matrix, '--matrix', matrix],
      ['--matrix', 'mac:arm64:dmg'],
      ['--matrix', matrix, '--full'],
      ['--matrix', matrix, '--no-strict'],
      ['--matrix', matrix, '--base=https://invalid.test'],
      ['artifacts', 'other', '--matrix', matrix],
      ['--config', '--matrix', matrix],
      ['--channel', '--matrix', matrix],
      ['--config', 'edition config.json', '--channel', 'latest', '--matrix', matrix],
      ['--channel', 'latest', '--config', 'edition config.json', '--matrix', matrix],
    ]) check(() => {
      const result = run(script, invalid, { DRY_RUN: '0' });
      assert.notEqual(result.status, 0, result.stdout);
      assert.equal(result.events.length, 0, 'parse must fail before preflight or credential tools');
    });
    check(() => {
      const result = run(script, args, { GITHUB_REF_NAME: 'v0.0.0', DRY_RUN: '0' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /differs from package/);
      assert.equal(result.events.length, 0);
    });
    for (const flags of [args, ['--matrix=' + matrix, '--channel=mycology', 'artifacts', '--config=edition config.json']]) check(() => {
      const result = run(script, flags);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.events.map(event => event.kind), ['preflight', 'preflight-result']);
      assert.equal(result.events[0].args[0], explicit);
      assert.equal(result.events[0].args.at(-1), matrix);
      assert.ok(result.events[0].args.includes('--strict'));
      assert.ok(result.events[0].args.includes(config));
      assert.match(result.stdout, /nothing uploaded/);
    });
    check(() => {
      const result = run(script, ['--config', 'edition config.json', '--matrix', matrix]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.events[0].args[0], path.join(repo, 'release-mycology'));
    });
    // Tamper selected artifact, not competing repo/artifacts. Same byte length
    // proves preflight hashes the body, not only its declared length.
    check(() => {
      fs.writeFileSync(path.join(explicit, items[0].url), Buffer.alloc(body.length, 88));
      for (const dry of ['0', '1']) {
        const result = run(script, args, { DRY_RUN: dry });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /sha512 mismatch/);
        assert.deepEqual(result.events.map(event => event.kind), ['preflight', 'preflight-result']);
      }
      fixture(explicit);
    });
    check(() => {
      const result = run(script, ['artifacts', '--config', 'edition config.json', '--matrix', matrix + ',mac:x64:dmg+zip'], { DRY_RUN: '0' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /missing required artifact/);
      assert.equal(result.events.some(event => event.kind === 'upload'), false);
    });
    for (const status of ['0', '7']) check(() => {
      const result = run(script, args, { DRY_RUN: '0', VERIFY_STATUS: status });
      assert.equal(result.status, Number(status), result.stderr);
      const kinds = result.events.map(event => event.kind);
      assert.deepEqual(kinds.slice(0, 2), ['preflight', 'preflight-result']);
      assert.equal(result.events[1].status, 0);
      assert.equal(kinds.at(-1), 'verify');
      const uploads = result.events.filter(event => event.kind === 'upload');
      assert.equal(uploads.length, 6); // two bodies, two maps, checksums, feed
      for (const item of items) {
        const upload = uploads.find(event => event.args.some(arg => arg.endsWith(`/desktop/mycology/${pkg.version}/${item.url}`)));
        assert.ok(upload, item.url);
        assert.equal(upload.sha256, hash(body, 'sha256', 'hex'));
      }
      assert.ok(uploads.at(-1).args.some(arg => arg.endsWith('/desktop/mycology/channel/mac/mycology-mac.yml')));
      assert.deepEqual(result.events.at(-1).args, [pkg.version, '--config', config, '--channel', 'mycology', '--strict', '--matrix', matrix, '--full']);
    });
  }
  console.log(`publisher contracts: ${checks} synthetic checks passed; no real upload, credential access or remote verification`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
