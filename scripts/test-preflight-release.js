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
    // The developer edition's feed is developers-mac.yml. The default channel
    // must not read it, or a developer build could be published as the full
    // app; and the developers channel must not read latest-mac.yml.
    write();
    const devFeed = path.join(root, 'developers-mac.yml');
    fs.renameSync(feedFile, devFeed);
    await rejects(/no release feeds found for the latest channel/, () => preflight(root));
    assert.deepEqual(await preflight(root, version, 'developers'), { channel: 'developers', feeds: ['developers-mac.yml'], artifacts: 1 }); checks++;
    await rejects(/no release feeds found for the developers channel/, () => preflight(bin, version, 'developers'));
    for (const flags of [['--channel', 'developers'], ['--config', path.join(__dirname, '..', 'electron-builder.developer.js')]]) {
      const devDry = spawnSync('bash', [publisher, root, ...flags], { cwd: os.tmpdir(), env: { ...process.env, DRY_RUN: '1' }, encoding: 'utf8' });
      assert.equal(devDry.status, 0, devDry.stderr);
      assert.match(devDry.stdout, /dry run passed for the developers channel/); checks++;
    }
    // The default publisher refuses that directory before rclone is ever invoked.
    const cross = spawnSync('bash', [publisher, root], { env: { ...process.env, DRY_RUN: '0', PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    assert.notEqual(cross.status, 0);
    assert.match(cross.stderr, /no release feeds found for the latest channel/);
    assert.equal(fs.existsSync(marker), false); checks++;
    fs.renameSync(devFeed, feedFile);
    fs.unlinkSync(feedFile);
    await rejects(/no release feeds/, () => preflight(root));
    console.log(`preflight-release: ${checks} checks passed`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
