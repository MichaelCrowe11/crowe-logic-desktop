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
const { execFile } = require('child_process');

const VERSION = '1.2.3';
const VERIFY = path.join(__dirname, 'verify-release.js');

// One healthy release, described the way electron-builder describes one. Each
// scenario below is this with a single thing broken, so a failure names the
// broken thing rather than the scaffolding.
function baseline() {
  return {
    version: VERSION,
    // name -> byte length the stub will serve
    objects: {
      'CroweLogic-1.2.3-arm64.zip': 400,
      'CroweLogic-1.2.3-arm64.zip.blockmap': 40,
      'CroweLogic-1.2.3-arm64.dmg': 500,
      'CroweLogic-1.2.3-arm64.dmg.blockmap': 50,
      'Crowe Logic Setup 1.2.3.exe': 600,
      'Crowe Logic Setup 1.2.3.exe.blockmap': 60,
      'crowe-logic-desktop_1.2.3_amd64.deb': 700,
    },
    feeds: {
      mac: { version: VERSION, files: [
        { url: 'CroweLogic-1.2.3-arm64.zip', size: 400 },
        { url: 'CroweLogic-1.2.3-arm64.dmg', size: 500 },
      ] },
      win: { version: VERSION, files: [{ url: 'Crowe Logic Setup 1.2.3.exe', size: 600 }] },
      linux: { version: VERSION, files: [{ url: 'crowe-logic-desktop_1.2.3_amd64.deb', size: 700 }] },
    },
    sums: [
      'CroweLogic-1.2.3-arm64.zip',
      'CroweLogic-1.2.3-arm64.dmg',
      'Crowe Logic Setup 1.2.3.exe',
      'crowe-logic-desktop_1.2.3_amd64.deb',
    ],
  };
}

const FEED_NAME = { mac: 'latest-mac.yml', win: 'latest.yml', linux: 'latest-linux.yml' };

function renderFeed(feed) {
  const files = feed.files
    .map((f) => `  - url: ${f.url}\n    sha512: ${'A'.repeat(88)}\n    size: ${f.size}`)
    .join('\n');
  return `version: ${feed.version}\nfiles:\n${files}\npath: ${feed.files[0].url}\nreleaseDate: '2026-07-28T00:00:00.000Z'\n`;
}

function serve(state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = decodeURIComponent(url.pathname);

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
      const size = state.objects[name];
      if (size == null) { res.writeHead(404); return res.end('Not found'); }
      // The worker lets R2 slice the object; one byte is all the verifier asks
      // for, and the content-range total is what it checks the feed against.
      if (req.headers.range) {
        res.writeHead(206, { 'content-range': `bytes 0-0/${size}`, 'content-length': '1' });
        return res.end('x');
      }
      res.writeHead(200, { 'content-length': String(size) });
      return res.end(Buffer.alloc(size));
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
    expect: (r) => {
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
      assert.match(r.out, /all checks passed/);
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
    const state = baseline();
    s.break(state);
    const server = await serve(state);
    const result = await run(server.address().port);
    server.close();
    try {
      s.expect(result);
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
