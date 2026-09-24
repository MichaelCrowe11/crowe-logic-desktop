'use strict';

// scripts/verify-release.js only earns trust if it can be shown to fail. Run
// against the live release it prints a wall of ok lines, which is exactly what
// a check that silently does nothing also prints.
//
// So stand up a stub of the releases worker and hand it each way a release has
// actually broken here: a feed naming a file the bucket does not have (GitHub
// rewrites spaces to dots in asset names while the feed keeps the spaces), a
// feed advertising the wrong version, an object whose size disagrees with the
// feed, and a SHA256SUMS carrying the previous release's artifacts into this
// one (the publish script used to glob the whole release directory).

const assert = require('assert');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { execFile } = require('child_process');
const layout = require('./release-channel');

const VERSION = '1.2.3';
const VERIFY = path.join(__dirname, 'verify-release.js');
// The real version, for the scenario that asserts the script falls back to it.
// Read rather than written down, so cutting a release does not turn this red.
const PKG_VERSION = require('../package.json').version;

// An AppImage keeps its blockmap inside itself rather than in a sidecar:
// payload, then the deflated blockmap, then that blockmap's length as a
// big-endian uint32. Build a real one so the tail the verifier fetches is a
// tail it can actually inflate - a stub of zeroes would fail the check for the
// wrong reason and prove nothing.
function makeAppImage(payloadSize, opts = {}) {
  const chunk = Math.ceil(payloadSize / 4);
  const sizes = [];
  for (let left = payloadSize; left > 0; left -= chunk) sizes.push(Math.min(chunk, left));
  if (opts.shortChunks) sizes.pop();   // describes less than the payload
  const map = { version: '2', files: [{ name: 'file', offset: 0, checksums: sizes.map(() => 'x'), sizes }] };
  let body = zlib.deflateRawSync(Buffer.from(JSON.stringify(map)));
  if (opts.corrupt) body = Buffer.alloc(body.length, 0xff);   // right length, not deflate
  const trailer = Buffer.allocUnsafe(4);
  trailer.writeUInt32BE(opts.lieInTrailer != null ? opts.lieInTrailer : body.length, 0);
  return { buf: Buffer.concat([Buffer.alloc(payloadSize), body, trailer]), blockMapSize: body.length };
}

// One healthy release, described the way electron-builder describes one. Each
// scenario below is this with a single thing broken, so a failure names the
// broken thing rather than the scaffolding.
const APPIMAGE = 'Crowe Logic-1.2.3.AppImage';

function baseline(appImage = makeAppImage(800)) {
  return {
    version: VERSION,
    channel: 'latest',   // the one channel this stub serves; the developers scenarios flip it
    requests: [],   // every path the verifier asked for, so a scenario can assert one was not
    // name -> byte length, or a Buffer when the bytes themselves matter
    objects: {
      'CroweLogic-1.2.3-arm64.zip': 400,
      'CroweLogic-1.2.3-arm64.zip.blockmap': 40,
      'CroweLogic-1.2.3-arm64.dmg': 500,
      'CroweLogic-1.2.3-arm64.dmg.blockmap': 50,
      'Crowe Logic Setup 1.2.3.exe': 600,
      'Crowe Logic Setup 1.2.3.exe.blockmap': 60,
      [APPIMAGE]: appImage.buf,
      'crowe-logic-desktop_1.2.3_amd64.deb': 700,
    },
    feeds: {
      mac: { version: VERSION, files: [
        { url: 'CroweLogic-1.2.3-arm64.zip', size: 400 },
        { url: 'CroweLogic-1.2.3-arm64.dmg', size: 500 },
      ] },
      win: { version: VERSION, files: [{ url: 'Crowe Logic Setup 1.2.3.exe', size: 600 }] },
      linux: { version: VERSION, files: [
        { url: APPIMAGE, size: appImage.buf.length, blockMapSize: appImage.blockMapSize },
        { url: 'crowe-logic-desktop_1.2.3_amd64.deb', size: 700 },
      ] },
    },
    sums: [
      'CroweLogic-1.2.3-arm64.zip',
      'CroweLogic-1.2.3-arm64.dmg',
      'Crowe Logic Setup 1.2.3.exe',
      APPIMAGE,
      'crowe-logic-desktop_1.2.3_amd64.deb',
    ],
  };
}

function renderFeed(feed) {
  const files = feed.files
    .map((f) => `  - url: ${f.url}\n    sha512: ${'A'.repeat(88)}\n    size: ${f.size}`
      + (f.blockMapSize != null ? `\n    blockMapSize: ${f.blockMapSize}` : ''))
    .join('\n');
  return `version: ${feed.version}\nfiles:\n${files}\npath: ${feed.files[0].url}\nreleaseDate: '2026-07-28T00:00:00.000Z'\n`;
}

// These bytes are deliberately NOT installers. They only qualify matrix and
// transport/hash rejection behavior, never signing or application acceptance.
function strictBaseline() {
  const state = baseline();
  state.channel = 'mycology';
  state.strictFixture = true;
  state.fullRequests = [];
  state.objects = {};
  state.feeds = { mac: { version: VERSION, files: [] } };
  for (const arch of ['arm64', 'x64']) {
    for (const type of ['zip', 'dmg']) {
      const url = `CroweLogic-mycology-${VERSION}-${arch}.${type}`;
      const body = Buffer.from(`synthetic ${arch} ${type}`);
      state.objects[url] = body;
      state.objects[`${url}.blockmap`] = zlib.gzipSync(Buffer.from(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, sizes: [body.length], checksums: ['synthetic'] }] })));
      state.feeds.mac.files.push({ url, size: body.length, sha512: crypto.createHash('sha512').update(body).digest('base64') });
    }
  }
  state.feeds.mac.path = state.feeds.mac.files[0].url;
  state.sums = state.feeds.mac.files.map(file => file.url);
  state.hashes = Object.fromEntries(state.sums.map(name => [name, crypto.createHash('sha256').update(state.objects[name]).digest('hex')]));
  return state;
}

function serve(state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = decodeURIComponent(url.pathname);
    state.requests.push(p);

    // The stub holds one channel's layout, under that channel's prefix and page,
    // so a check of the other channel finds nothing here.
    const prefix = layout.prefix(state.channel);

    if (p === layout.pagePath(state.channel)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<html><span class="ver">v${state.version}</span></html>`);
    }

    if (p === `/${prefix}/${VERSION}/SHA256SUMS`) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(state.sums.map((n) => `${state.hashes?.[n] || '0'.repeat(64)}  ${n}`).join('\n') + '\n');
    }

    const channel = new RegExp(`^/${prefix}/channel/(mac|win|linux)/(.+)$`).exec(p);
    if (channel) {
      const [, os, name] = channel;
      if (name === layout.feedName(state.channel, os)) {
        // A platform the release was never built for has no feed object at all.
        if (!state.feeds[os]) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'content-type': 'text/yaml' });
        return res.end(state.strictFixture ? yaml.dump(state.feeds[os]) : renderFeed(state.feeds[os]));
      }
      const object = state.objects[name];
      if (object == null) { res.writeHead(404); return res.end('Not found'); }
      // Most objects only need a plausible length, so they are stored as one;
      // the AppImage is stored as real bytes because the verifier inflates its
      // tail. Either way serve the range that was asked for rather than a
      // hardcoded first byte - slicing wrongly is one of the failures under test.
      const body = Buffer.isBuffer(object) ? object : Buffer.alloc(object);
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), body.length - 1);
        const slice = body.subarray(start, end + 1);
        res.writeHead(206, {
          'content-range': `bytes ${start}-${end}/${body.length}`,
          'content-length': String(slice.length),
        });
        return res.end(slice);
      }
      if (state.fullRequests) state.fullRequests.push(name);
      res.writeHead(200, { 'content-length': String(body.length) });
      return res.end(body);
    }

    res.writeHead(404);
    res.end('Not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Most scenarios name the version on the command line, which is also how the
// bug below survived: the argument always won, so the fallbacks underneath it
// were never exercised by anything. `version: null` omits it and leaves the
// script to work out for itself which release it is looking at.
function run(port, opts = {}) {
  const version = 'version' in opts ? opts.version : VERSION;
  const args = [VERIFY];
  if (version != null) args.push(version);
  args.push(`--base=http://127.0.0.1:${port}`);
  if (opts.args) args.push(...opts.args);
  // Blank rather than inherited: run this suite inside Actions and the real
  // GITHUB_REF_NAME would otherwise reach through and make the result depend on
  // which branch the checkout happens to be on.
  const env = { PATH: process.env.PATH, GITHUB_REF_NAME: '', ...(opts.env || {}) };
  return new Promise((resolve) => {
    execFile(process.execPath, args, { env },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
  });
}

const scenarios = [
  {
    name: 'a healthy release passes',
    break: () => {},
    expect: (r, state) => {
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
      assert.match(r.out, /all checks passed/);
      // Not just "no failures": no warnings either. This check used to ask for a
      // Crowe Logic-x.y.z.AppImage.blockmap, which electron-builder never writes,
      // and so warned on every healthy release. A warning nobody can act on is
      // how the next real one gets waved through.
      assert.doesNotMatch(r.out, /^warn/m, `warned on a healthy release\n${r.out}`);
      assert.match(r.out, /ok\s+linux: Crowe Logic-1\.2\.3\.AppImage carries its blockmap/);
      const sidecar = state.requests.filter((p) => p.endsWith('.AppImage.blockmap'));
      assert.deepStrictEqual(sidecar, [], 'asked for an AppImage sidecar blockmap that cannot exist');
    },
  },
  {
    name: 'a feed naming a file the bucket does not have fails',
    // Exactly the GitHub rename: the asset landed as Crowe.Logic.Setup...exe
    // while the feed still says Crowe Logic Setup ... .exe.
    break: (s) => {
      delete s.objects['Crowe Logic Setup 1.2.3.exe'];
      s.objects['Crowe.Logic.Setup.1.2.3.exe'] = 600;
    },
    expect: (r) => {
      assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.out}`);
      assert.match(r.out, /not ok\s+win: Crowe Logic Setup 1\.2\.3\.exe resolves/);
      assert.match(r.out, /got 404/);
    },
  },
  {
    name: 'a feed left on the previous version fails',
    break: (s) => { s.feeds.linux.version = '1.2.2'; },
    expect: (r) => {
      assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.out}`);
      assert.match(r.out, /not ok\s+linux: feed advertises 1\.2\.3/);
      assert.match(r.out, /feed says 1\.2\.2/);
    },
  },
  {
    name: 'an object whose size disagrees with the feed fails',
    break: (s) => { s.objects['CroweLogic-1.2.3-arm64.dmg'] = 499; },
    expect: (r) => {
      assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.out}`);
      assert.match(r.out, /feed declares 500 bytes, object is 499/);
    },
  },
  {
    name: "SHA256SUMS carrying another release's artifacts fails",
    break: (s) => { s.sums.push('CroweLogic-1.2.2-arm64.dmg'); },
    expect: (r) => {
      assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.out}`);
      assert.match(r.out, /not ok\s+SHA256SUMS names nothing from another release/);
      assert.match(r.out, /CroweLogic-1\.2\.2-arm64\.dmg/);
    },
  },
  {
    name: 'a SHA256SUMS missing an artifact fails',
    break: (s) => { s.sums = s.sums.filter((n) => !n.endsWith('.deb')); },
    expect: (r) => {
      assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.out}`);
      assert.match(r.out, /not ok\s+SHA256SUMS covers every published artifact/);
    },
  },
  {
    name: 'a missing blockmap warns but does not fail',
    break: (s) => { delete s.objects['CroweLogic-1.2.3-arm64.dmg.blockmap']; },
    expect: (r) => {
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
      assert.match(r.out, /warn\s+mac: CroweLogic-1\.2\.3-arm64\.dmg\.blockmap present/);
      assert.match(r.out, /all checks passed, 1 warning/);
    },
  },
  // The AppImage check is the one that has to be shown to fail, because the
  // thing it replaced passed a broken release and failed a healthy one. Each of
  // these breaks the embedded blockmap a different way; all warn rather than
  // fail, because a full download still installs.
  {
    name: 'an AppImage feed entry with no blockMapSize warns',
    break: (s) => { delete s.feeds.linux.files[0].blockMapSize; },
    expect: (r) => {
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
      assert.match(r.out, /warn\s+linux: Crowe Logic-1\.2\.3\.AppImage carries its blockmap/);
      assert.match(r.out, /feed declares no blockMapSize/);
    },
  },
  {
    name: 'a blockMapSize larger than the AppImage warns',
    break: (s) => { s.feeds.linux.files[0].blockMapSize = 99999; },
    expect: (r) => {
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
      assert.match(r.out, /blockMapSize 99999 exceeds the \d+ byte object/);
    },
  },
  {
    // The trailer and the feed are written by the same build, so disagreement
    // means the object and the feed came from different ones - the failure that
    // leaves the updater seeking to an offset that is not the blockmap.
    name: "a trailer disagreeing with the feed warns",
    appImage: () => makeAppImage(800, { lieInTrailer: 7 }),
    break: () => {},
    expect: (r) => {
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
      assert.match(r.out, /object's trailer says 7 bytes, feed says \d+/);
    },
  },
  {
    // Right length, wrong bytes: what a proxy that re-encodes the body leaves
    // behind. Only inflating it catches this; a length check does not.
    name: 'a blockmap that does not inflate warns',
    appImage: () => makeAppImage(800, { corrupt: true }),
    break: () => {},
    expect: (r) => {
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
      assert.match(r.out, /blockmap does not inflate/);
    },
  },
  {
    // Inflates, parses, and still describes the wrong file: the chunks stop
    // short of where the blockmap begins, so the updater would diff a prefix.
    name: 'a blockmap whose chunks miss part of the payload warns',
    appImage: () => makeAppImage(800, { shortChunks: true }),
    break: () => {},
    expect: (r) => {
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
      assert.match(r.out, /chunks cover 600 bytes of a 800 byte payload/);
    },
  },
  {
    name: 'a stale download page fails',
    break: (s) => { s.version = '1.2.2'; },   // page only; feeds keep VERSION
    expect: (r) => {
      assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.out}`);
      assert.match(r.out, /not ok\s+download page offers this release/);
    },
  },
  // Which release is under test is itself a thing that can be wrong, and when it
  // is, every check below it fails for a reason that has nothing to do with the
  // release. These two pin the resolution rather than the checks.
  {
    // The scheduled run passes no version, and GitHub sets GITHUB_REF_NAME to
    // whatever ref it ran on - for a cron, the branch. Read as a version that
    // verifies a release called "main": all three feeds mismatch, SHA256SUMS
    // 404s, and the page has no "vmain" in it. Red every morning against a
    // release that is perfectly healthy, which is how a gate gets turned off.
    name: 'a scheduled run on a branch verifies package.json, not the branch name',
    run: { version: null, env: { GITHUB_REF_NAME: 'main' } },
    break: () => {},
    expect: (r) => {
      assert.doesNotMatch(r.out, /verify-release: main\b/,
        `verified a release named after the branch\n${r.out}`);
      assert.match(r.out, new RegExp(`verify-release: ${PKG_VERSION.replace(/\./g, '\\.')}\\b`),
        `expected it to fall back to package.json's ${PKG_VERSION}\n${r.out}`);
    },
  },
  {
    // The fallback still earns its place: a tag-triggered run names the release
    // in GITHUB_REF_NAME, and package.json is not necessarily still on it.
    name: "a tag-triggered run verifies the tag's version",
    run: { version: null, env: { GITHUB_REF_NAME: `v${VERSION}` } },
    break: () => {},
    expect: (r) => {
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
      assert.match(r.out, /all checks passed/);
    },
  },
  // Crowe Logic for Developers is verified under its own prefix. The stub here
  // holds only the developers layout, so a check that strayed into the full
  // edition's keys would 404 and fail; asserting that it asked for none of them
  // is the stronger claim, that a green developers check says nothing about the
  // full app and cannot be satisfied by it.
  {
    name: 'the developers channel verifies under its own prefix and reads nothing of the full edition',
    channel: 'developers',
    run: { args: ['--channel', 'developers'] },
    break: () => {},
    expect: (r, state) => {
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
      assert.match(r.out, /verify-release: 1\.2\.3 on the developers channel/);
      assert.match(r.out, /all checks passed/);
      assert.doesNotMatch(r.out, /^warn/m, `warned on a healthy release\n${r.out}`);
      const strayed = state.requests.filter((p) => p === '/' || /^\/desktop\/(channel|1\.2\.3)\//.test(p));
      assert.deepStrictEqual(strayed, [], `read the full edition's keys: ${strayed.join(', ')}`);
      assert.ok(state.requests.includes('/desktop/developers/channel/mac/developers-mac.yml'), 'never read the developers feed');
      assert.ok(state.requests.includes('/desktop/developers/1.2.3/SHA256SUMS'), 'never read the developers SHA256SUMS');
      assert.ok(state.requests.includes('/developers'), 'never read the developers page');
    },
  },
  {
    name: 'a developer release does not pass as the full app',
    channel: 'developers',
    break: () => {},
    expect: (r) => {
      assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.out}`);
      assert.match(r.out, /not ok\s+mac: feed resolves/);
      assert.match(r.out, /not ok\s+download page serves/);
    },
  },
  // The first developer release is macOS only. A platform with no feed at all
  // is said, not failed on, on an edition's channel; on the full app's channel
  // the same absence is a platform silently missing from a release and fails,
  // exactly as it always has.
  {
    name: 'a macOS-only developer release passes and names the platforms it lacks',
    channel: 'developers',
    run: { args: ['--channel', 'developers'] },
    break: (s) => { delete s.feeds.win; delete s.feeds.linux; s.sums = s.sums.filter((n) => /arm64\.(zip|dmg)$/.test(n)); },
    expect: (r) => {
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
      assert.match(r.out, /warn\s+win: feed resolves\n\s+404 - no win release on the developers channel/);
      assert.match(r.out, /warn\s+linux: feed resolves/);
      assert.match(r.out, /all checks passed, 2 warnings/);
    },
  },
  {
    name: 'the full app with a platform missing its feed still fails',
    break: (s) => { delete s.feeds.win; },
    expect: (r) => {
      assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.out}`);
      assert.match(r.out, /not ok\s+win: feed resolves/);
      assert.match(r.out, /404 for/);
    },
  },
];

const strictArgs = ['--channel', 'mycology', '--strict', '--matrix', 'mac:arm64:dmg+zip,mac:x64:dmg+zip'];
scenarios.push({
  name: 'strict explicit mac inventory passes with full hashing even without --full',
  strictFixture: true, run: { args: strictArgs }, break: () => {},
  expect: (r, s) => {
    assert.strictEqual(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /^warn/m);
    for (const name of s.sums) assert.ok(s.fullRequests.includes(name), `never downloaded ${name}`);
    assert.ok(s.requests.every(p => p === '/mycology' || p.startsWith('/desktop/mycology/')), 'cross-edition read');
  },
});
for (const [name, change, pattern] of [
  ['missing required mac feed', s => delete s.feeds.mac, /not ok\s+mac: feed resolves/],
  ['missing required updater ZIP', s => s.feeds.mac.files.splice(2, 1), /missing required artifact: mac:x64:zip/],
  ['unlisted Windows feed', s => s.feeds.win = baseline().feeds.win, /unexpected advertised platform/],
  ['unlisted Linux architecture feed', s => s.objects['mycology-linux-arm64.yml'] = Buffer.from('version: 1.2.3'), /unexpected advertised feed/],
  ['missing required hash', s => delete s.feeds.mac.files[0].sha512, /missing or invalid sha512/],
  ['wrong edition artifact', s => s.feeds.mac.files[0].url = 'CroweLogic-developers-1.2.3-arm64.zip', /unexpected artifact edition/],
  ['unknown architecture artifact', s => s.feeds.mac.files[0].url = 'CroweLogic-mycology-1.2.3-universal.zip', /unexpected artifact edition/],
  ['missing installer bytes', s => delete s.objects[s.sums[0]], /expected 206.*got 404/],
  ['same-size changed bytes', s => s.objects[s.sums[0]].fill(1), /sha512 mismatch/],
  ['missing sidecar blockmap', s => delete s.objects[`${s.sums[0]}.blockmap`], /not ok\s+mac: .*blockmap present/],
  ['corrupt sidecar blockmap', s => s.objects[`${s.sums[0]}.blockmap`] = Buffer.from('bad'), /blockmap does not inflate/],
  ['missing sidecar file name', s => {
    const key = `${s.sums[0]}.blockmap`;
    const map = JSON.parse(zlib.gunzipSync(s.objects[key]));
    delete map.files[0].name;
    s.objects[key] = zlib.gzipSync(Buffer.from(JSON.stringify(map)));
  }, /invalid blockmap file name/],
  ['mismatched sidecar file name', s => {
    const key = `${s.sums[0]}.blockmap`;
    const map = JSON.parse(zlib.gunzipSync(s.objects[key]));
    map.files[0].name = 'wrong';
    s.objects[key] = zlib.gzipSync(Buffer.from(JSON.stringify(map)));
  }, /invalid blockmap file name/],
  ['incorrect download checksum', s => s.hashes[s.sums[0]] = '0'.repeat(64), /not ok\s+SHA256SUMS matches downloaded/],
  ['duplicate checksum entry', s => s.sums.push(s.sums[0]), /invalid or duplicate checksum/],
]) scenarios.push({ name: `strict rejects ${name}`, strictFixture: true, run: { args: strictArgs }, break: change, expect: r => { assert.strictEqual(r.code, 1, r.out); assert.match(r.out, pattern); } });
function addLinux(state) {
  const appImage = makeAppImage(800);
  const url = `CroweLogic-mycology-${VERSION}-x64.AppImage`;
  const deb = `CroweLogic-mycology-${VERSION}-amd64.deb`;
  state.objects[url] = appImage.buf;
  state.objects[deb] = Buffer.from('synthetic deb');
  state.feeds.linux = { version: VERSION, files: [url, deb].map(name => ({ url: name, size: state.objects[name].length, sha512: crypto.createHash('sha512').update(state.objects[name]).digest('base64'), ...(name === url ? { blockMapSize: appImage.blockMapSize } : {}) })) };
  for (const name of [url, deb]) { state.sums.push(name); state.hashes[name] = crypto.createHash('sha256').update(state.objects[name]).digest('hex'); }
}
const linuxArgs = [...strictArgs.slice(0, -1), `${strictArgs.at(-1)},linux:x64:AppImage+deb`];
scenarios.push({ name: 'strict mac and Linux inventory accepts embedded AppImage blockmap', strictFixture: true, run: { args: linuxArgs }, break: addLinux, expect: (r, s) => { assert.strictEqual(r.code, 0, r.out); assert.ok(s.fullRequests.includes(`CroweLogic-mycology-${VERSION}-x64.AppImage`)); } });
for (const [name, change, pattern] of [
  ['missing embedded map declaration', s => delete s.feeds.linux.files[0].blockMapSize, /not ok\s+linux: .*carries its blockmap/],
  ['wrong embedded trailer', s => s.objects[s.feeds.linux.files[0].url].writeUInt32BE(7, s.feeds.linux.files[0].size - 4), /object's trailer says/],
  ['negative embedded size', s => s.feeds.linux.files[0].blockMapSize = -1, /invalid blockMapSize/],
  ['missing embedded file name', s => {
    const item = s.feeds.linux.files[0];
    const previous = s.objects[item.url];
    const payload = previous.subarray(0, item.size - item.blockMapSize - 4);
    const map = JSON.parse(zlib.inflateRawSync(previous.subarray(payload.length, previous.length - 4)));
    delete map.files[0].name;
    const compressed = zlib.deflateRawSync(Buffer.from(JSON.stringify(map)));
    const trailer = Buffer.alloc(4); trailer.writeUInt32BE(compressed.length);
    const body = Buffer.concat([payload, compressed, trailer]);
    s.objects[item.url] = body;
    item.size = body.length;
    item.blockMapSize = compressed.length;
    item.sha512 = crypto.createHash('sha512').update(body).digest('base64');
    s.hashes[item.url] = crypto.createHash('sha256').update(body).digest('hex');
  }, /invalid blockmap file name/],
]) scenarios.push({ name: `strict rejects ${name}`, strictFixture: true, run: { args: linuxArgs }, break: s => { addLinux(s); change(s); }, expect: r => { assert.strictEqual(r.code, 1, r.out); assert.match(r.out, pattern); } });
scenarios.push({ name: 'strict rejects x64 artifacts outside the chosen arm64-only matrix', strictFixture: true, run: { args: [...strictArgs.slice(0, -1), 'mac:arm64:dmg+zip'] }, break: () => {}, expect: r => { assert.strictEqual(r.code, 1, r.out); assert.match(r.out, /unexpected advertised architecture/); } });
for (const [name, args, pattern] of [
  ['absent matrix', ['--channel', 'mycology', '--strict'], /requires an explicit --matrix/],
  ['matrix without strict', ['--matrix', 'mac:arm64:dmg+zip'], /requires --strict/],
  ['contradictory edition', [...strictArgs, '--channel', 'developers'], /conflicting release channels/],
  ['unsupported lane', ['--strict', '--matrix', 'linux:arm64:AppImage'], /unsupported release matrix lane/],
]) scenarios.push({ name: `arguments reject ${name} before network`, strictFixture: true, run: { args }, break: () => {}, expect: (r, s) => { assert.notStrictEqual(r.code, 0, r.out); assert.match(r.out, pattern); assert.deepStrictEqual(s.requests, []); } });

(async () => {
  let failed = 0;
  for (const s of scenarios) {
    const state = s.strictFixture ? strictBaseline() : baseline(s.appImage ? s.appImage() : undefined);
    if (s.channel) state.channel = s.channel;
    s.break(state);
    const server = await serve(state);
    const result = await run(server.address().port, s.run || {});
    server.close();
    try {
      s.expect(result, state);
      console.log(`ok      ${s.name}`);
    } catch (err) {
      failed++;
      console.log(`not ok  ${s.name}`);
      String(err.message).split('\n').forEach((l) => console.log(`        ${l}`));
    }
  }
  console.log(`\n${scenarios.length - failed}/${scenarios.length} passed`);
  process.exit(failed ? 1 : 0);
})();
