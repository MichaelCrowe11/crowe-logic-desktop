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
const { execFile } = require('child_process');

const VERSION = '1.2.3';
const VERIFY = path.join(__dirname, 'verify-release.js');

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

const FEED_NAME = { mac: 'latest-mac.yml', win: 'latest.yml', linux: 'latest-linux.yml' };

function renderFeed(feed) {
  const files = feed.files
    .map((f) => `  - url: ${f.url}\n    sha512: ${'A'.repeat(88)}\n    size: ${f.size}`
      + (f.blockMapSize != null ? `\n    blockMapSize: ${f.blockMapSize}` : ''))
    .join('\n');
  return `version: ${feed.version}\nfiles:\n${files}\npath: ${feed.files[0].url}\nreleaseDate: '2026-07-28T00:00:00.000Z'\n`;
}

function serve(state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = decodeURIComponent(url.pathname);
    state.requests.push(p);

    if (p === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<html><span class="ver">v${state.version}</span></html>`);
    }

    if (p === `/desktop/${VERSION}/SHA256SUMS`) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(state.sums.map((n) => `${'0'.repeat(64)}  ${n}`).join('\n') + '\n');
    }

    const channel = /^\/desktop\/channel\/(mac|win|linux)\/(.+)$/.exec(p);
    if (channel) {
      const [, os, name] = channel;
      if (name === FEED_NAME[os]) {
        res.writeHead(200, { 'content-type': 'text/yaml' });
        return res.end(renderFeed(state.feeds[os]));
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
      res.writeHead(200, { 'content-length': String(body.length) });
      return res.end(body);
    }

    res.writeHead(404);
    res.end('Not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function run(port) {
  return new Promise((resolve) => {
    execFile(process.execPath, [VERIFY, VERSION, `--base=http://127.0.0.1:${port}`],
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
];

(async () => {
  let failed = 0;
  for (const s of scenarios) {
    const state = baseline(s.appImage ? s.appImage() : undefined);
    s.break(state);
    const server = await serve(state);
    const result = await run(server.address().port);
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
