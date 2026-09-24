'use strict';

// An explicit acceptance inventory, not a claim about architectures inside a
// binary. Signature, installer, payload and native-dependency gates are separate.
// Example: --strict --matrix mac:arm64:dmg+zip,mac:x64:dmg+zip
const { OSES, feedName, assertChannel } = require('./release-channel');
const zlib = require('zlib');

// Only current build/routing lanes. mac config declares arm64 and x64; the
// Windows/Linux release workflow uses x64 runners. Adding a lane requires its
// publisher, worker and updater feed routing to be qualified first. In
// particular Linux arm64 has a DIFFERENT feed, not another file in linux.yml.
const ARCHES = { mac: ['arm64', 'x64'], win: ['x64'], linux: ['x64'] };
const TYPES = { mac: ['dmg', 'zip'], win: ['exe'], linux: ['AppImage', 'deb'] };
const SIDECAR_BLOCKMAP = /\.(dmg|zip|exe)$/;

function parseMatrix(value) {
  if (typeof value !== 'string' || !value) throw new Error('--matrix needs an explicit platform:arch:artifact+artifact inventory');
  const rows = [];
  const seen = new Set();
  for (const entry of value.split(',')) {
    const parts = entry.split(':');
    if (parts.length !== 3) throw new Error(`invalid matrix entry: ${entry}`);
    const [os, arch, kinds] = parts;
    if (!Object.hasOwn(ARCHES, os) || !ARCHES[os].includes(arch)) throw new Error(`unsupported release matrix lane: ${os}:${arch}`);
    const types = kinds.split('+');
    if (types.some(type => !TYPES[os].includes(type)) || new Set(types).size !== types.length) throw new Error(`invalid artifact matrix: ${entry}`);
    if (os === 'mac' && !TYPES.mac.every(type => types.includes(type))) throw new Error('mac matrix requires both dmg and updater zip for each architecture');
    if (seen.has(`${os}:${arch}`)) throw new Error(`duplicate matrix lane: ${os}:${arch}`);
    seen.add(`${os}:${arch}`);
    rows.push({ os, arch, types });
  }
  return rows;
}

function fromArgs(args) {
  let strict = false;
  let matrix;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--strict') { strict = true; continue; }
    if (arg === '--matrix' || arg.startsWith('--matrix=')) {
      if (matrix !== undefined) throw new Error('duplicate --matrix');
      matrix = arg === '--matrix' ? args[++i] : arg.slice(9);
      // Parse now, including missing/empty values, rather than silently falling
      // back to a nonstrict probe when an option is misspelled or incomplete.
      parseMatrix(matrix);
      continue;
    }
    rest.push(arg);
  }
  if (strict && matrix === undefined) throw new Error('--strict requires an explicit --matrix');
  if (matrix !== undefined && !strict) throw new Error('--matrix requires --strict');
  return { strict, matrix, rest };
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function artifactIdentity(url, os, version, channel) {
  if (typeof url !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/.test(url)) throw new Error('unsafe artifact name');
  const v = escapeRegExp(version);
  const edition = channel === 'latest' ? '' : `-${escapeRegExp(channel)}`;
  const tagged = new RegExp(`^CroweLogic${edition}-${v}-(arm64|x64|amd64)\\.(dmg|zip|exe|AppImage|deb)$`).exec(url);
  if (tagged) {
    const arch = tagged[1] === 'amd64' && tagged[2] === 'deb' ? 'x64' : tagged[1];
    if (!TYPES[os].includes(tagged[2])) throw new Error(`unexpected artifact type on ${os}: ${url}`);
    return { arch, type: tagged[2] };
  }
  // electron-builder's legacy defaults omit x64 for NSIS and AppImage. This
  // identifies advertised naming only; it cannot prove executable architecture.
  if (channel === 'latest') {
    if (os === 'win' && url === `Crowe Logic Setup ${version}.exe`) return { arch: 'x64', type: 'exe' };
    if (os === 'linux' && url === `Crowe Logic-${version}.AppImage`) return { arch: 'x64', type: 'AppImage' };
    if (os === 'linux' && url === `crowe-logic-desktop_${version}_amd64.deb`) return { arch: 'x64', type: 'deb' };
  }
  throw new Error(`unexpected artifact edition, version, architecture or type: ${url}`);
}

function validateFeed(feed, os, version, channel, matrix) {
  assertChannel(channel);
  const required = matrix.filter(row => row.os === os);
  if (!required.length) throw new Error(`unexpected advertised platform: ${os}`);
  if (!feed || feed.version !== version) throw new Error(`expected version ${version}`);
  if (!Array.isArray(feed.files) || !feed.files.length) throw new Error('empty files list');
  // NSIS-web package maps are not published by the existing scripts. Do not
  // count an unchecked secondary download as a verified installer.
  if (feed.packages != null) throw new Error('unsupported updater packages inventory');
  const found = new Set();
  const urls = new Set();
  for (const file of feed.files) {
    if (!file || typeof file !== 'object') throw new Error('invalid feed artifact');
    const { arch, type } = artifactIdentity(file.url, os, version, channel);
    if (!required.some(row => row.arch === arch && row.types.includes(type))) throw new Error(`unexpected advertised architecture/artifact: ${os}:${arch}:${type}`);
    const key = `${arch}:${type}`;
    if (found.has(key) || urls.has(file.url)) throw new Error(`duplicate artifact: ${file.url}`);
    found.add(key);
    urls.add(file.url);
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error(`${file.url}: missing or invalid size`);
    if (typeof file.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) || Buffer.from(file.sha512, 'base64').toString('base64') !== file.sha512) {
      throw new Error(`${file.url}: missing or invalid sha512`);
    }
  }
  for (const { arch, types } of required) {
    for (const type of types) if (!found.has(`${arch}:${type}`)) throw new Error(`missing required artifact: ${os}:${arch}:${type}`);
  }
  if (feed.path != null && !urls.has(feed.path)) throw new Error('legacy path not in files');
  if (feed.sha512 != null && (!feed.path || feed.sha512 !== feed.files.find(file => file.url === feed.path)?.sha512)) throw new Error('legacy checksum mismatch');
  if (os === 'mac' && feed.path != null && !feed.path.endsWith('.zip')) throw new Error('mac legacy path must name updater zip');
}

// Other channels may coexist in a directory; extra feeds of THIS channel may
// not. Linux arch-specific feeds are real electron-builder output but current
// publishers only promote the x64 feed. Reject rather than ignore them.
function validateFeedNames(names, channel, matrix) {
  const expected = matrix.map(row => feedName(channel, row.os));
  for (const name of names) {
    if ((name === `${channel}.yml` || name.startsWith(`${channel}-`) && name.endsWith('.yml')) && !expected.includes(name)) {
      throw new Error(`unexpected advertised feed: ${name}`);
    }
  }
  for (const name of new Set(expected)) if (!names.includes(name)) throw new Error(`missing required feed: ${name}`);
}

function blockmapError(buffer, size, embedded = false) {
  try {
    const map = JSON.parse((embedded ? zlib.inflateRawSync : zlib.gunzipSync)(buffer, { maxOutputLength: 32 * 1024 * 1024 }).toString());
    if (map.version !== '2' || !Array.isArray(map.files) || map.files.length !== 1) return 'unsupported blockmap format';
    const file = map.files[0];
    // The locked builder emits the single canonical entry "file". The updater
    // matches old/new maps by this name before planning any differential copy.
    if (!file || file.name !== 'file') return 'invalid blockmap file name';
    if (file.offset !== 0 || !Array.isArray(file.sizes) || !file.sizes.length || file.sizes.some(n => !Number.isSafeInteger(n) || n <= 0)) return 'invalid blockmap chunks';
    if (!Array.isArray(file.checksums) || file.checksums.length !== file.sizes.length || file.checksums.some(s => typeof s !== 'string' || !s)) return 'invalid blockmap checksums';
    const covered = file.sizes.reduce((a, b) => a + b, 0);
    return covered === size ? null : `chunks cover ${covered} bytes of a ${size} byte payload`;
  } catch (error) { return `blockmap does not inflate: ${error.message}`; }
}

module.exports = { parseMatrix, fromArgs, validateFeed, validateFeedNames, blockmapError, SIDECAR_BLOCKMAP, OSES };
