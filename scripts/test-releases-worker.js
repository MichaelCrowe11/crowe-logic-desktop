'use strict';

// The releases worker decides two things that fail silently when wrong: which
// bucket key an update download resolves to, and which installers the download
// page offers. Both shipped broken. The page advertised a version three releases
// old and linked a Windows installer that had never been built under that name,
// while every update download 404'd because the manifest lives under the channel
// prefix and the installers do not.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'deploy', 'releases-worker', 'src', 'index.js'),
  'utf8'
);

// The worker is a module, so load it by evaluating the source with the default
// export turned into a local binding and handing back what the tests need.
const load = new Function(`
  ${src.replace('export default', 'const handler =')}
  return { versionedKeysFor, catalog, renderPage, handler };
`);
const { versionedKeysFor, catalog, renderPage, handler } = load();

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok      ${name}`))
    .catch((err) => {
      failed++;
      console.log(`FAIL    ${name}`);
      console.log(`        ${String(err.message).split('\n').join('\n        ')}`);
    });
}

const MANIFESTS = {
  'desktop/channel/darwin/latest-mac.yml': `version: 0.14.0
files:
  - url: CroweLogic-0.14.0-arm64.zip
    sha512: aaa
    size: 1
  - url: CroweLogic-0.14.0-arm64.dmg
    sha512: bbb
    size: 2
path: CroweLogic-0.14.0-arm64.zip
`,
  'desktop/channel/windows/latest.yml': `version: 0.14.0
files:
  - url: Crowe Logic Setup 0.14.0.exe
    sha512: ccc
    size: 3
path: Crowe Logic Setup 0.14.0.exe
`,
  'desktop/channel/linux/latest-linux.yml': `version: 0.14.0
files:
  - url: Crowe Logic-0.14.0.AppImage
    sha512: ddd
    size: 4
  - url: crowe-logic-desktop_0.14.0_amd64.deb
    sha512: eee
    size: 5
path: Crowe Logic-0.14.0.AppImage
`,
};

function envWith(manifests) {
  return {
    RELEASES: {
      async get(key) {
        if (!(key in manifests)) return null;
        return { text: async () => manifests[key] };
      },
    },
  };
}

async function main() {
  const mappings = [
    ['desktop/channel/darwin/CroweLogic-0.14.0-arm64.dmg', ['desktop/0.14.0/CroweLogic-0.14.0-arm64.dmg', 'desktop/0.14.0-arm64.dmg/CroweLogic-0.14.0-arm64.dmg']],
    ['desktop/channel/darwin/CroweLogic-0.14.0-arm64.zip.blockmap', ['desktop/0.14.0/CroweLogic-0.14.0-arm64.zip.blockmap', 'desktop/0.14.0-arm64.zip.blockmap/CroweLogic-0.14.0-arm64.zip.blockmap']],
    ['desktop/channel/linux/Crowe Logic-0.14.0.AppImage', ['desktop/0.14.0/Crowe Logic-0.14.0.AppImage']],
    ['desktop/channel/linux/crowe-logic-desktop_0.14.0_amd64.deb', ['desktop/0.14.0/crowe-logic-desktop_0.14.0_amd64.deb']],
    ['desktop/channel/windows/Crowe Logic Setup 0.14.0.exe', ['desktop/0.14.0/Crowe Logic Setup 0.14.0.exe']],
    ['desktop/channel/darwin/CroweLogic-0.15.0-rc.1-arm64.dmg', ['desktop/0.15.0/CroweLogic-0.15.0-rc.1-arm64.dmg', 'desktop/0.15.0-rc.1/CroweLogic-0.15.0-rc.1-arm64.dmg']],
    ['desktop/channel/darwin/latest-mac.yml', []],
    ['desktop/channel/linux/latest-linux.yml', []],
    ['desktop/channel/windows/latest.yml', []],
    ['desktop/0.14.0/CroweLogic-0.14.0-arm64.dmg', []],
    ['brand/mark.svg', []],
    ['desktop/channel/darwin/nested/CroweLogic-0.14.0-arm64.dmg', []],
    ['desktop/channel/darwin/CroweLogic-arm64.dmg', []],
  ];
  for (const [input, expected] of mappings) {
    await check(`maps ${input}`, () => assert.deepStrictEqual(versionedKeysFor(input), expected));
  }

  await check('catalog reads every installer out of the manifests', async () => {
    assert.deepStrictEqual(await catalog(envWith(MANIFESTS)), {
      version: '0.14.0',
      windows: 'Crowe Logic Setup 0.14.0.exe',
      macos: 'CroweLogic-0.14.0-arm64.dmg',
      appimage: 'Crowe Logic-0.14.0.AppImage',
      deb: 'crowe-logic-desktop_0.14.0_amd64.deb',
    });
  });

  await check('a platform left behind on an older version is not offered', async () => {
    const stale = { ...MANIFESTS };
    stale['desktop/channel/windows/latest.yml'] = MANIFESTS['desktop/channel/windows/latest.yml']
      .replace(/0\.14\.0/g, '0.13.0');
    const rel = await catalog(envWith(stale));
    assert.strictEqual(rel.version, '0.14.0');
    assert.strictEqual(rel.windows, null);
    assert.strictEqual(rel.macos, 'CroweLogic-0.14.0-arm64.dmg');
  });

  await check('version ordering is numeric, not lexical', async () => {
    const newer = { ...MANIFESTS };
    newer['desktop/channel/darwin/latest-mac.yml'] = MANIFESTS['desktop/channel/darwin/latest-mac.yml']
      .replace(/0\.14\.0/g, '0.9.0');
    assert.strictEqual((await catalog(envWith(newer))).version, '0.14.0');
  });

  await check('an empty bucket yields no catalog rather than a broken page', async () => {
    assert.strictEqual(await catalog(envWith({})), null);
  });

  await check('the page links the filenames that were actually published', async () => {
    const html = renderPage(await catalog(envWith(MANIFESTS)));
    assert.ok(html.includes('v0.14.0'), 'version not rendered');
    for (const name of [
      'Crowe Logic Setup 0.14.0.exe',
      'CroweLogic-0.14.0-arm64.dmg',
      'Crowe Logic-0.14.0.AppImage',
      'crowe-logic-desktop_0.14.0_amd64.deb',
      'SHA256SUMS',
    ]) {
      const link = `/desktop/0.14.0/${encodeURIComponent(name)}`;
      assert.ok(html.includes(`href="${link}"`), `missing link ${link}`);
    }
    assert.ok(!html.includes('Coming soon'), 'linux is published, not coming soon');
  });

  await check('a missing installer degrades instead of linking nothing', async () => {
    const html = renderPage({ version: '0.14.0', windows: null, macos: 'a.dmg', appimage: null, deb: null });
    assert.ok(html.includes('Not in this release'));
    assert.ok(!html.includes('/desktop/0.14.0/null'));
  });

  await check('an update download falls through to the versioned object', async () => {
    const body = 'installer bytes';
    const env = {
      RELEASES: {
        async get(key) {
          if (key !== 'desktop/0.14.0/CroweLogic-0.14.0-arm64.dmg') return null;
          return { body, size: body.length, httpEtag: '"x"', writeHttpMetadata() {} };
        },
      },
    };
    const res = await handler.fetch(
      new Request('https://x/desktop/channel/darwin/CroweLogic-0.14.0-arm64.dmg'),
      env
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-length'), String(body.length));
  });

  await check('a range request is answered with 206 and only those bytes', async () => {
    const full = 'installer bytes';
    const env = {
      RELEASES: {
        async get(key, options) {
          if (key !== 'desktop/0.14.0/CroweLogic-0.14.0-arm64.dmg') return null;
          const object = { size: full.length, httpEtag: '"x"', writeHttpMetadata() {} };
          if (!options || !options.range) return { ...object, body: full };
          // R2 resolves the Range header itself; stand in for a bytes=4-8 ask.
          return { ...object, body: full.slice(4, 9), range: { offset: 4, length: 5 } };
        },
      },
    };
    const res = await handler.fetch(
      new Request('https://x/desktop/channel/darwin/CroweLogic-0.14.0-arm64.dmg', {
        headers: { range: 'bytes=4-8' },
      }),
      env
    );
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get('content-range'), 'bytes 4-8/15');
    assert.strictEqual(res.headers.get('content-length'), '5');
    assert.strictEqual(res.headers.get('accept-ranges'), 'bytes');
  });

  await check('an object that exists nowhere is still a 404', async () => {
    const res = await handler.fetch(
      new Request('https://x/desktop/channel/darwin/CroweLogic-9.9.9-arm64.dmg'),
      envWith({})
    );
    assert.strictEqual(res.status, 404);
  });

  console.log(`\n${ran - failed}/${ran} passed`);
  process.exit(failed ? 1 : 0);
}

main();
