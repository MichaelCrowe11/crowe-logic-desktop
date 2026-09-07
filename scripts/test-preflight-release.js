'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');
const { preflight } = require('./preflight-release');
const version = require('../package.json').version;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-preflight-'));
  const url = `Crowe Logic-${version}.zip`;
  const body = Buffer.from('release fixture');
  const item = { url, size: body.length, sha512: crypto.createHash('sha512').update(body).digest('base64') };
  const feedFile = path.join(root, 'latest-mac.yml');
  const write = (feed = { version, files: [item] }) => fs.writeFileSync(feedFile, yaml.dump(feed));
  let checks = 0;
  async function rejects(pattern, fn) { await assert.rejects(fn, pattern); checks++; }
  try {
    fs.writeFileSync(path.join(root, url), body);
    fs.writeFileSync(path.join(root, `${url}.blockmap`), 'blockmap fixture');
    write();
    assert.equal((await preflight(root)).artifacts, 1); checks++;
    await rejects(/differs from package/, () => preflight(root, '0.0.0'));
    write({ version: '0.0.0', files: [item] });
    await rejects(/expected version/, () => preflight(root));
    write({ version, files: [] });
    await rejects(/empty files/, () => preflight(root));
    write({ version, files: [{ ...item, size: 1 }] });
    await rejects(/size mismatch/, () => preflight(root));
    write({ version, files: [{ ...item, sha512: 'invalid' }] });
    await rejects(/sha512 mismatch/, () => preflight(root));
    write({ version, files: [{ ...item, url: `../${url}` }] });
    await rejects(/unsafe or stale/, () => preflight(root));
    write({ version, files: [item, item] });
    await rejects(/duplicate artifact/, () => preflight(root));
    write({ version, files: [item], path: 'missing.zip' });
    await rejects(/legacy path/, () => preflight(root));
    write();
    fs.unlinkSync(path.join(root, `${url}.blockmap`));
    await rejects(/missing release file/, () => preflight(root));
    fs.writeFileSync(path.join(root, `${url}.blockmap`), 'blockmap fixture');
    const dotted = url.replace(/ /g, '.');
    fs.copyFileSync(path.join(root, url), path.join(root, dotted));
    await rejects(/ambiguous/, () => preflight(root));
    fs.unlinkSync(path.join(root, url));
    assert.equal((await preflight(root)).artifacts, 1); checks++;
    const publisher = path.join(__dirname, 'publish-rclone.sh');
    const dry = spawnSync('bash', [publisher, root], { cwd: os.tmpdir(), env: { ...process.env, DRY_RUN: '1' }, encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /nothing uploaded/); checks++;
    // Even without dry-run, an invalid release must fail before invoking rclone.
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    const marker = path.join(root, 'upload-invoked');
    fs.writeFileSync(path.join(bin, 'rclone'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    write({ version: '0.0.0', files: [item] });
    const bad = spawnSync('bash', [publisher, root], { env: { ...process.env, DRY_RUN: '0', PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.equal(fs.existsSync(marker), false); checks++;
    fs.unlinkSync(feedFile);
    await rejects(/no release feeds/, () => preflight(root));
    console.log(`preflight-release: ${checks} checks passed`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
