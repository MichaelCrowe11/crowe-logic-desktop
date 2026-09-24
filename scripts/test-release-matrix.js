'use strict';
// Synthetic inventory/metadata only. No application, auth, publisher or network.
const assert = require('assert/strict');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { parseMatrix, fromArgs, validateFeed, validateFeedNames } = require('./release-matrix');
const matrix = 'mac:arm64:dmg+zip,mac:x64:dmg+zip';
const version = '1.2.3';
const rows = parseMatrix(matrix);
const sha512 = crypto.createHash('sha512').update('fixture').digest('base64');
const feed = { version, files: rows.flatMap(row => row.types.map(type => ({ url: `CroweLogic-mycology-${version}-${row.arch}.${type}`, size: 7, sha512 }))) };
let checks = 0;
function rejects(fn, pattern) { assert.throws(fn, pattern); checks++; }
assert.equal(rows.length, 2); checks++;
assert.deepEqual(fromArgs(['--strict', `--matrix=${matrix}`, '1.2.3']).rest, ['1.2.3']); checks++;
for (const value of ['', 'mac:arm64', 'mac:universal:dmg+zip', 'linux:arm64:AppImage', 'win:ia32:exe', 'other:x64:zip', 'mac:x64:dmg+dmg', 'mac:x64:dmg', 'mac:x64:zip', 'win:x64:msi', 'win:x64:exe,win:x64:exe']) rejects(() => parseMatrix(value), /matrix|lane|artifact/);
rejects(() => fromArgs(['--strict']), /explicit --matrix/);
rejects(() => fromArgs(['--matrix', matrix]), /requires --strict/);
rejects(() => fromArgs(['--strict', '--matrix']), /explicit/);
rejects(() => fromArgs(['--strict', '--matrix', matrix, '--matrix', matrix]), /duplicate/);
validateFeed(feed, 'mac', version, 'mycology', rows); checks++;
validateFeed(yaml.load(yaml.dump(feed, { flowLevel: 1 })), 'mac', version, 'mycology', rows); checks++;
validateFeedNames(['mycology-mac.yml', 'latest-mac.yml'], 'mycology', rows); checks++;
rejects(() => validateFeedNames([], 'mycology', rows), /missing required feed/);
rejects(() => validateFeedNames(['mycology-mac.yml', 'mycology.yml'], 'mycology', rows), /unexpected advertised feed/);
rejects(() => validateFeedNames(['mycology-mac.yml', 'mycology-linux-arm64.yml'], 'mycology', rows), /unexpected advertised feed/);
for (const [change, pattern] of [
  [f => f.files.pop(), /missing required artifact/],
  [f => f.files.push(f.files[0]), /duplicate artifact/],
  [f => delete f.files[0].sha512, /sha512/],
  [f => f.files[0].sha512 = 'A'.repeat(88), /sha512/],
  [f => f.files[0].size = '7', /size/],
  [f => f.files[0].url = f.files[0].url.replace('mycology', 'developers'), /edition/],
  [f => f.files[0].url = f.files[0].url.replace('arm64', 'universal'), /architecture/],
  [f => f.files[0].url = 'https://example.invalid/artifact.zip', /unsafe/],
  [f => f.path = f.files[0].url, /updater zip/],
  [f => f.path = 'missing.zip', /legacy path/],
  [f => f.sha512 = sha512, /legacy checksum/],
  [f => f.packages = {}, /unsupported updater packages/],
]) {
  const copy = structuredClone(feed); change(copy);
  rejects(() => validateFeed(copy, 'mac', version, 'mycology', rows), pattern);
}
rejects(() => validateFeed(feed, 'win', version, 'mycology', rows), /unexpected advertised platform/);
rejects(() => validateFeed(feed, 'mac', version, 'mycology', parseMatrix('mac:arm64:dmg+zip')), /unexpected advertised architecture/);
for (const os of ['win', 'linux']) {
  const types = os === 'win' ? ['exe'] : ['AppImage', 'deb'];
  const f = { version, files: types.map(type => ({ url: `CroweLogic-mycology-${version}-${type === 'deb' ? 'amd64' : 'x64'}.${type}`, size: 7, sha512 })) };
  validateFeed(f, os, version, 'mycology', parseMatrix(`${os}:x64:${types.join('+')}`)); checks++;
}
console.log(`release-matrix: ${checks} checks passed`);
