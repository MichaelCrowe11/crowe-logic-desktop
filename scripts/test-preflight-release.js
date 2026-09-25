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
    // Exercise the exact preflight subprocess boundary, never the publisher.
    // Even a publisher dry run is not permission to load signing/cloud auth.
    const cli = (...flags) => spawnSync(process.execPath, [path.join(__dirname, 'preflight-release.js'), root, ...flags], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });
    const dry = cli();
    assert.equal(dry.status, 0, dry.stderr); checks++;
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    write({ version: '0.0.0', files: [item] });
    const bad = cli();
    assert.notEqual(bad.status, 0); checks++;
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
      const devDry = cli(...flags);
      assert.equal(devDry.status, 0, devDry.stderr);
      assert.match(devDry.stdout, /developers channel/); checks++;
    }
    const cross = cli();
    assert.notEqual(cross.status, 0);
    assert.match(cross.stderr, /no release feeds found for the latest channel/); checks++;
    fs.renameSync(devFeed, feedFile);
    fs.unlinkSync(feedFile);
    await rejects(/no release feeds/, () => preflight(root));
    const matrix = 'mac:arm64:dmg+zip,mac:x64:dmg+zip';
    const strict = { strict: true, matrix };
    const mycFeed = path.join(root, 'mycology-mac.yml');
    const items = ['arm64', 'x64'].flatMap(arch => ['zip', 'dmg'].map(type => ({ ...item, url: `CroweLogic-mycology-${version}-${arch}.${type}` })));
    // Exercise the installed builder's actual sidecar shape and the installed
    // updater's name matching, not only a hand-authored schema fixture.
    const zlib = require('zlib');
    const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');
    const { computeOperations } = require('electron-updater/out/differentialDownloader/downloadPlanBuilder');
    const generatedMap = path.join(root, 'fixture.blockmap');
    await buildBlockMap(path.join(root, dotted), 'gzip', generatedMap);
    const blockmap = fs.readFileSync(generatedMap);
    const builderMap = JSON.parse(zlib.gunzipSync(blockmap));
    assert.equal(builderMap.files[0].name, 'file'); checks++;
    const logger = { info() {}, warn() {} };
    assert.doesNotThrow(() => computeOperations(builderMap, builderMap, logger)); checks++;
    for (const file of items) {
      fs.writeFileSync(path.join(root, file.url), body);
      fs.writeFileSync(path.join(root, `${file.url}.blockmap`), blockmap);
    }
    const writeMyc = (files = items) => fs.writeFileSync(mycFeed, yaml.dump({ version, files, path: files[0]?.url }));
    writeMyc();
    assert.equal((await preflight(root, version, 'mycology', strict)).artifacts, 4); checks++;
    for (const name of [undefined, '', null, 7, 'wrong']) {
      const invalid = structuredClone(builderMap);
      if (name === undefined) delete invalid.files[0].name;
      else invalid.files[0].name = name;
      assert.throws(() => computeOperations(builderMap, invalid, logger), /no file .* in old blockmap/); checks++;
      fs.writeFileSync(path.join(root, `${items[0].url}.blockmap`), zlib.gzipSync(Buffer.from(JSON.stringify(invalid))));
      await rejects(/invalid blockmap file name/, () => preflight(root, version, 'mycology', strict));
    }
    fs.writeFileSync(path.join(root, `${items[0].url}.blockmap`), blockmap);
    const goodStrict = cli('--channel', 'mycology', '--strict', '--matrix', matrix);
    assert.equal(goodStrict.status, 0, goodStrict.stderr); checks++;
    const noMatrix = cli('--channel', 'mycology', '--strict');
    assert.notEqual(noMatrix.status, 0); assert.match(noMatrix.stderr, /requires an explicit --matrix/); checks++;
    writeMyc(items.filter(file => !file.url.endsWith('x64.zip')));
    await rejects(/missing required artifact/, () => preflight(root, version, 'mycology', strict));
    writeMyc(items.map((file, i) => i ? file : { ...file, sha512: undefined }));
    await rejects(/missing or invalid sha512/, () => preflight(root, version, 'mycology', strict));
    writeMyc();
    fs.writeFileSync(path.join(root, 'mycology-linux-arm64.yml'), 'version: 1');
    await rejects(/unexpected advertised feed/, () => preflight(root, version, 'mycology', strict));
    fs.unlinkSync(path.join(root, 'mycology-linux-arm64.yml'));
    fs.writeFileSync(path.join(root, `${items[0].url}.blockmap`), 'invalid');
    await rejects(/blockmap does not inflate/, () => preflight(root, version, 'mycology', strict));
    fs.writeFileSync(path.join(root, `${items[0].url}.blockmap`), blockmap);
    fs.unlinkSync(path.join(root, items[0].url));
    await rejects(/missing release file/, () => preflight(root, version, 'mycology', strict));
    fs.unlinkSync(mycFeed);
    await rejects(/missing required feed/, () => preflight(root, version, 'mycology', strict));
    // Actual updater tail format, synthetic payload. This is not an AppImage
    // executable and therefore cannot be evidence of Linux install acceptance.
    const payload = Buffer.alloc(32, 7);
    const map = require('zlib').deflateRawSync(Buffer.from(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, sizes: [32], checksums: ['synthetic'] }] })));
    const trailer = Buffer.alloc(4); trailer.writeUInt32BE(map.length);
    const appImage = Buffer.concat([payload, map, trailer]);
    const linuxUrl = `CroweLogic-mycology-${version}-x64.AppImage`;
    const linuxItem = { url: linuxUrl, size: appImage.length, blockMapSize: map.length, sha512: crypto.createHash('sha512').update(appImage).digest('base64') };
    const linuxFeed = path.join(root, 'mycology-linux.yml');
    fs.writeFileSync(path.join(root, linuxUrl), appImage);
    fs.writeFileSync(linuxFeed, yaml.dump({ version, files: [linuxItem] }));
    const linuxStrict = { strict: true, matrix: 'linux:x64:AppImage' };
    assert.equal((await preflight(root, version, 'mycology', linuxStrict)).artifacts, 1); checks++;
    fs.writeFileSync(linuxFeed, yaml.dump({ version, files: [{ ...linuxItem, blockMapSize: undefined }] }));
    await rejects(/invalid blockMapSize/, () => preflight(root, version, 'mycology', linuxStrict));
    const corrupt = Buffer.from(appImage); corrupt.writeUInt32BE(7, corrupt.length - 4);
    fs.writeFileSync(path.join(root, linuxUrl), corrupt);
    fs.writeFileSync(linuxFeed, yaml.dump({ version, files: [{ ...linuxItem, sha512: crypto.createHash('sha512').update(corrupt).digest('base64') }] }));
    await rejects(/blockmap trailer mismatch/, () => preflight(root, version, 'mycology', linuxStrict));
    console.log(`preflight-release: ${checks} checks passed`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
