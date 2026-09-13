'use strict';

// scripts/release-channel.js is where the publishers, the preflight, the
// verifier and the developer config agree on what a channel is called and
// where it lives. Two things have to hold: the full edition's keys are exactly
// the ones it has always been published to, and no key of one channel is a key
// of the other.

const assert = require('assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const layout = require('./release-channel');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
let checks = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };

// The full edition: unchanged, key for key.
eq(layout.prefix('latest'), 'desktop');
eq(layout.outputDir('latest'), 'release');
eq(layout.pagePath('latest'), '/');
eq(layout.OSES.map((os) => layout.feedKey('latest', os)),
  ['desktop/channel/win/latest.yml', 'desktop/channel/mac/latest-mac.yml', 'desktop/channel/linux/latest-linux.yml']);
eq(layout.artifactKey('latest', '0.24.7', 'CroweLogic-0.24.7-arm64.dmg'), 'desktop/0.24.7/CroweLogic-0.24.7-arm64.dmg');
eq(layout.updateKey('latest', 'mac', 'CroweLogic-0.24.7-arm64.dmg'), 'desktop/channel/mac/CroweLogic-0.24.7-arm64.dmg');

// The developer edition: beside it, under its own prefix, feeds included.
eq(layout.prefix('developers'), 'desktop/developers');
eq(layout.outputDir('developers'), 'release-developers');
eq(layout.pagePath('developers'), '/developers');
eq(layout.OSES.map((os) => layout.feedKey('developers', os)), [
  'desktop/developers/channel/win/developers.yml',
  'desktop/developers/channel/mac/developers-mac.yml',
  'desktop/developers/channel/linux/developers-linux.yml',
]);
eq(layout.artifactKey('developers', '0.24.7', 'SHA256SUMS'), 'desktop/developers/0.24.7/SHA256SUMS');
eq(layout.updateKey('developers', 'mac', 'CroweLogic-developers-0.24.7-arm64.zip'),
  'desktop/developers/channel/mac/CroweLogic-developers-0.24.7-arm64.zip');

// No key of one channel is a key of the other, and neither channel's prefix is
// a prefix of the other's keys.
const keysOf = (c) => [...layout.OSES.map((os) => layout.feedKey(c, os)), layout.artifactKey(c, '1.0.0', 'SHA256SUMS')];
eq(keysOf('latest').filter((k) => keysOf('developers').includes(k)), []);
eq(keysOf('latest').filter((k) => k.startsWith(layout.prefix('developers') + '/')), []);

// A name that could escape the prefix or shadow the channel directory is refused.
for (const bad of ['../latest', 'Latest', 'channel', 'a/b', '', 'latest ', undefined]) {
  assert.throws(() => layout.prefix(bad), /release channel must be/, `accepted ${JSON.stringify(bad)}`);
  checks++;
}
assert.throws(() => layout.feedName('latest', 'darwin'), /unknown os/); checks++;

// Argument parsing: defaults, --channel in both spellings, --config, and the
// rest handed back untouched and in order.
eq(layout.fromArgs([]), { channel: 'latest', dir: 'release', rest: [] });
eq(layout.fromArgs(['release', '0.1.0', '--channel', 'developers', '--full']),
  { channel: 'developers', dir: 'release-developers', rest: ['release', '0.1.0', '--full'] });
eq(layout.fromArgs(['--channel=developers', '--base=http://127.0.0.1:1']),
  { channel: 'developers', dir: 'release-developers', rest: ['--base=http://127.0.0.1:1'] });
assert.throws(() => layout.fromArgs(['--channel']), /needs a value/); checks++;
assert.throws(() => layout.fromArgs(['--channel', 'Nope']), /release channel must be/); checks++;

// --config reads the channel and the output directory out of the electron-builder
// config the build ran with, so the developer edition can be published with the
// same file that built it.
const cfg = path.join(root, 'electron-builder.developer.js');
eq(layout.fromArgs(['--config', cfg]), { channel: 'developers', dir: 'release-developers', rest: [] });
eq(layout.fromArgs(['--config', path.join(root, 'package.json')]), { channel: 'latest', dir: 'release', rest: [] });

// The developer config's publish url ends in the channel directory the feeds
// are written to. Anything else and the updater asks one place while the
// publisher writes another, which is a 404 nobody sees.
const dev = require(cfg);
eq(dev.publish.map((p) => p.url), [pkg.build.publish[0].url.replace('/desktop/channel/', `/${layout.prefix('developers')}/channel/`)]);
eq(dev.directories.output, layout.outputDir('developers'));

// --shell hands bash the same answers, quoted.
function shell(...args) {
  const run = spawnSync(process.execPath, [path.join(__dirname, 'release-channel.js'), '--shell', ...args], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return Object.fromEntries(run.stdout.trim().split('\n').map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1).replace(/^'|'$/g, '')];
  }));
}
eq(shell(), { channel: 'latest', root: '', dir: 'release', prefix: 'desktop', page: '/', feed_win: 'latest.yml', feed_mac: 'latest-mac.yml', feed_linux: 'latest-linux.yml' });
eq(shell('--config', cfg, 'somewhere'), {
  channel: 'developers', root: 'somewhere', dir: 'release-developers', prefix: 'desktop/developers', page: '/developers',
  feed_win: 'developers.yml', feed_mac: 'developers-mac.yml', feed_linux: 'developers-linux.yml',
});
eq(shell('release-developers', '--channel', 'developers').root, 'release-developers');
const refused = spawnSync(process.execPath, [path.join(__dirname, 'release-channel.js'), '--shell', '--channel', '../x'], { encoding: 'utf8' });
eq(refused.status, 1);
eq(refused.stdout, '');

console.log(`release-channel: ${checks} checks passed`);
