'use strict';

// The releases worker decides two things that fail silently when wrong: which
// bucket key an update download resolves to, and which installers the download
// page offers. Both shipped broken. The page advertised a version three releases
// old and linked a Windows installer that had never been built under that name,
// while every update download 404'd because the manifest lives under the channel
// prefix and the installers do not.
//
// Two editions now share it. Crowe Logic for Developers lives under
// desktop/developers/, feeds included, and the worker has to keep the two apart
// in both directions: a developer download must never resolve out of the full
// edition's tree, and the full edition's page must never offer a developer
// build. The layout itself is written down once, in scripts/release-channel.js;
// the worker cannot import it, so this file holds the two spellings together.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const layout = require('./release-channel');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'deploy', 'releases-worker', 'src', 'index.js'),
  'utf8'
);

// The worker is a module, so load it by evaluating the source with the default
// export turned into a local binding and handing back what the tests need.
const load = new Function(`
  ${src.replace('export default', 'const handler =')}
  return { versionedKeysFor, catalog, renderPage, handler, feedKey, validIngestKey };
`);
const { versionedKeysFor, catalog, renderPage, handler, feedKey, validIngestKey } = load();

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

// electron-builder's ${os} macro expands to the platform's build key, not the
// node platform name: Platform.MAC is new Platform("mac", "mac", "darwin").
// Publishing to darwin/ and windows/ instead is why macOS clients sat on 0.12.0
// for two releases and Windows never had a feed at all. Nothing surfaced it,
// because a missing manifest looks exactly like being up to date.
const MANIFESTS = {
  'desktop/channel/mac/latest-mac.yml': `version: 0.14.0
files:
  - url: CroweLogic-0.14.0-arm64.zip
    sha512: aaa
    size: 1
  - url: CroweLogic-0.14.0-arm64.dmg
    sha512: bbb
    size: 2
path: CroweLogic-0.14.0-arm64.zip
`,
  'desktop/channel/win/latest.yml': `version: 0.14.0
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

// The developer edition, macOS only, the way its first publish looks.
const DEV_DMG = 'CroweLogic-developers-0.14.0-arm64.dmg';
const DEV_MANIFESTS = {
  'desktop/developers/channel/mac/developers-mac.yml': `version: 0.14.0
files:
  - url: CroweLogic-developers-0.14.0-arm64.zip
    sha512: fff
    size: 6
  - url: ${DEV_DMG}
    sha512: ggg
    size: 7
path: CroweLogic-developers-0.14.0-arm64.zip
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
    // The developer edition resolves within its own tree, chosen by the channel
    // directory the request came through. Its feeds are direct hits like the
    // full edition's and are never remapped.
    [`desktop/developers/channel/mac/${DEV_DMG}`, [`desktop/developers/0.14.0/${DEV_DMG}`, `desktop/developers/0.14.0-arm64.dmg/${DEV_DMG}`]],
    ['desktop/developers/channel/mac/CroweLogic-developers-0.14.0-arm64.zip.blockmap', ['desktop/developers/0.14.0/CroweLogic-developers-0.14.0-arm64.zip.blockmap', 'desktop/developers/0.14.0-arm64.zip.blockmap/CroweLogic-developers-0.14.0-arm64.zip.blockmap']],
    ['desktop/developers/channel/win/CroweLogic-developers-0.14.0-x64.exe', ['desktop/developers/0.14.0/CroweLogic-developers-0.14.0-x64.exe', 'desktop/developers/0.14.0-x64.exe/CroweLogic-developers-0.14.0-x64.exe']],
    ['desktop/developers/channel/mac/developers-mac.yml', []],
    ['desktop/developers/channel/win/developers.yml', []],
    // The tree is chosen by the directory, never by the name: a developer
    // artifact asked for through the full edition's channel directory is looked
    // for in the full edition's tree, where it is not, and 404s.
    [`desktop/channel/mac/${DEV_DMG}`, [`desktop/0.14.0/${DEV_DMG}`, `desktop/0.14.0-arm64.dmg/${DEV_DMG}`]],
    ['desktop/channel/channel/mac/CroweLogic-0.14.0-arm64.dmg', []],
    ['desktop/Developers/channel/mac/CroweLogic-0.14.0-arm64.dmg', []],
    ['desktop/developers/0.14.0/CroweLogic-developers-0.14.0-arm64.dmg', []],
  ];
  for (const [input, expected] of mappings) {
    await check(`maps ${input}`, () => assert.deepStrictEqual(versionedKeysFor(input), expected));
  }

  await check('the publish url is still built from the ${os} macro', () => {
    const publish = [].concat(require('../package.json').build.publish);
    assert.ok(
      publish.some((p) => p.url && p.url.includes('/desktop/channel/${os}')),
      `publish config is ${JSON.stringify(publish)}`
    );
    const dev = [].concat(require('../electron-builder.developer.js').publish);
    assert.ok(
      dev.every((p) => p.url && p.url.endsWith(`/${layout.prefix('developers')}/channel/\${os}`)),
      `developer publish config is ${JSON.stringify(dev)}`
    );
  });

  await check('the worker and the publishers agree on every feed key', () => {
    for (const channel of ['latest', 'developers']) {
      for (const os of layout.OSES) {
        assert.strictEqual(feedKey(channel, os), layout.feedKey(channel, os));
      }
    }
    for (const wrong of ['channel/darwin/', 'channel/windows/', 'channel/win32/']) {
      assert.ok(!src.includes(wrong), `worker still references ${wrong}`);
    }
  });

  await check('both publishers key every write off the channel layout', () => {
    for (const name of ['publish-r2.sh', 'publish-rclone.sh']) {
      const sh = fs.readFileSync(path.join(__dirname, name), 'utf8');
      assert.ok(sh.includes('release-channel.js" --shell'), `${name} does not resolve its layout through release-channel.js`);
      assert.ok(sh.includes('put "$prefix/$version/$url"'), `${name} does not write installers under the channel prefix`);
      assert.ok(sh.includes('put "$prefix/$version/SHA256SUMS"'), `${name} does not write SHA256SUMS under the channel prefix`);
      assert.ok(sh.includes('put "$prefix/channel/$os/$name"'), `${name} does not write feeds under the channel prefix`);
      assert.ok(!/put "desktop\//.test(sh), `${name} still writes a hardcoded desktop/ key`);
    }
  });

  await check('catalog reads every installer out of the manifests', async () => {
    assert.deepStrictEqual(await catalog(envWith(MANIFESTS)), {
      version: '0.14.0',
      windows: 'Crowe Logic Setup 0.14.0.exe',
      macos: 'CroweLogic-0.14.0-arm64.dmg',
      // A one-architecture release offers no Intel link rather than repeating
      // the arm64 file behind a button that promises Intel.
      macosIntel: null,
      appimage: 'Crowe Logic-0.14.0.AppImage',
      deb: 'crowe-logic-desktop_0.14.0_amd64.deb',
    });
  });

  /* The arch split, held at the ordering that caused the bug. electron-builder
     writes x64 ahead of arm64, and the catalog used to take the first dmg in
     the feed - so every Apple Silicon visitor got the Intel build from a card
     headed "Apple Silicon". It downloads and it runs under Rosetta, which is
     why it went unreported through two releases. Ordering x64 first here is the
     point of the fixture: sorted the other way it would pass on the old code. */
  await check('a universal release sends Apple Silicon the arm64 build, not the first dmg', async () => {
    const both = { ...MANIFESTS };
    both['desktop/channel/mac/latest-mac.yml'] = `version: 0.14.0
files:
  - url: CroweLogic-0.14.0-x64.dmg
    sha512: aaa
    size: 1
  - url: CroweLogic-0.14.0-arm64.dmg
    sha512: bbb
    size: 2
path: CroweLogic-0.14.0-x64.dmg
`;
    const rel = await catalog(envWith(both));
    assert.strictEqual(rel.macos, 'CroweLogic-0.14.0-arm64.dmg');
    assert.strictEqual(rel.macosIntel, 'CroweLogic-0.14.0-x64.dmg');
  });

  await check('a platform left behind on an older version is not offered', async () => {
    const stale = { ...MANIFESTS };
    stale['desktop/channel/win/latest.yml'] = MANIFESTS['desktop/channel/win/latest.yml']
      .replace(/0\.14\.0/g, '0.13.0');
    const rel = await catalog(envWith(stale));
    assert.strictEqual(rel.version, '0.14.0');
    assert.strictEqual(rel.windows, null);
    assert.strictEqual(rel.macos, 'CroweLogic-0.14.0-arm64.dmg');
  });

  await check('version ordering is numeric, not lexical', async () => {
    const newer = { ...MANIFESTS };
    newer['desktop/channel/mac/latest-mac.yml'] = MANIFESTS['desktop/channel/mac/latest-mac.yml']
      .replace(/0\.14\.0/g, '0.9.0');
    assert.strictEqual((await catalog(envWith(newer))).version, '0.14.0');
  });

  await check('an empty bucket yields no catalog rather than a broken page', async () => {
    assert.strictEqual(await catalog(envWith({})), null);
  });

  await check('the developer catalog reads its own feeds and only its own', async () => {
    const both = { ...MANIFESTS, ...DEV_MANIFESTS };
    assert.deepStrictEqual(await catalog(envWith(both), 'developers'), {
      version: '0.14.0', windows: null, macos: DEV_DMG, macosIntel: null, appimage: null, deb: null,
    });
    // The full edition's catalog is the same with the developer feeds present
    // or absent, and a bucket holding only developer builds has no full
    // release to offer.
    assert.deepStrictEqual(await catalog(envWith(both)), await catalog(envWith(MANIFESTS)));
    assert.strictEqual(await catalog(envWith(DEV_MANIFESTS)), null);
    assert.strictEqual(await catalog(envWith(MANIFESTS), 'developers'), null);
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
    assert.ok(html.includes('<title>Crowe Logic releases</title>') && html.includes('<h1>Crowe Logic desktop</h1>'), 'the full page changed its heading');
  });

  await check('the developer page links its own prefix and nothing of the full edition', async () => {
    const both = { ...MANIFESTS, ...DEV_MANIFESTS };
    const html = renderPage(await catalog(envWith(both), 'developers'), 'developers');
    assert.ok(html.includes('<h1>Crowe Logic for Developers</h1>'), 'edition not named');
    assert.ok(html.includes(`href="/desktop/developers/0.14.0/${encodeURIComponent(DEV_DMG)}"`), 'dmg not linked under the developers prefix');
    assert.ok(html.includes('href="/desktop/developers/0.14.0/SHA256SUMS"'), 'SHA256SUMS not linked under the developers prefix');
    assert.ok(html.includes('Not in this release'), 'platforms the release lacks are not marked');
    assert.ok(!html.includes('/desktop/0.14.0/'), 'links into the full edition');
    const full = renderPage(await catalog(envWith(both)));
    assert.ok(!full.includes('/desktop/developers/') && !full.includes('-developers-'), 'the full page offers a developer build');
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

  await check('a developer update download falls through within the developer tree only', async () => {
    const body = 'developer bytes';
    const asked = [];
    const env = {
      RELEASES: {
        async get(key) {
          asked.push(key);
          if (key !== `desktop/developers/0.14.0/${DEV_DMG}`) return null;
          return { body, size: body.length, httpEtag: '"y"', writeHttpMetadata() {} };
        },
      },
    };
    const res = await handler.fetch(new Request(`https://x/desktop/developers/channel/mac/${DEV_DMG}`), env);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-length'), String(body.length));
    assert.ok(asked.every((k) => k.startsWith('desktop/developers/')), `looked outside the developer tree: ${asked.join(', ')}`);
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

  await check('/developers serves the developer page and / still serves the full one', async () => {
    const env = envWith({ ...MANIFESTS, ...DEV_MANIFESTS });
    const dev = await handler.fetch(new Request('https://x/developers'), env);
    assert.strictEqual(dev.status, 200);
    assert.match(dev.headers.get('content-type'), /text\/html/);
    const devHtml = await dev.text();
    assert.ok(devHtml.includes('Crowe Logic for Developers') && devHtml.includes('/desktop/developers/0.14.0/'));
    const full = await handler.fetch(new Request('https://x/'), env);
    assert.strictEqual(full.status, 200);
    const fullHtml = await full.text();
    assert.ok(fullHtml.includes('/desktop/0.14.0/') && !fullHtml.includes('/desktop/developers/'));
    const head = await handler.fetch(new Request('https://x/developers', { method: 'HEAD' }), env);
    assert.strictEqual(head.status, 200);
  });

  await check('/developers/<platform> redirects to the current developer installer', async () => {
    const env = envWith(DEV_MANIFESTS);
    const mac = await handler.fetch(new Request('https://x/developers/mac'), env);
    assert.strictEqual(mac.status, 302);
    assert.strictEqual(mac.headers.get('location'), `https://x/desktop/developers/0.14.0/${DEV_DMG}`);
    // A platform the release does not include is a 404, not a redirect to "null".
    for (const missing of ['windows', 'mac-intel', 'appimage', 'deb']) {
      const res = await handler.fetch(new Request(`https://x/developers/${missing}`), env);
      assert.strictEqual(res.status, 404, `${missing} answered ${res.status}`);
    }
    const unknown = await handler.fetch(new Request('https://x/developers/amiga'), env);
    assert.strictEqual(unknown.status, 404);
  });

  await check('an unseeded developers channel answers 503, not a broken page', async () => {
    const env = envWith(MANIFESTS);
    assert.strictEqual((await handler.fetch(new Request('https://x/developers'), env)).status, 503);
    assert.strictEqual((await handler.fetch(new Request('https://x/developers/mac'), env)).status, 503);
  });

  await check('ingest accepts both editions\' key shapes and nothing else', () => {
    for (const ok of [
      'desktop/0.14.0/CroweLogic-0.14.0-arm64.dmg',
      'desktop/0.14.0/CroweLogic-0.14.0-arm64.dmg.blockmap',
      'desktop/0.14.0/SHA256SUMS',
      'desktop/0.15.0-rc.1/CroweLogic-0.15.0-rc.1-arm64.dmg',
      'desktop/channel/mac/latest-mac.yml',
      'desktop/channel/win/latest.yml',
      `desktop/developers/0.14.0/${DEV_DMG}`,
      'desktop/developers/0.14.0/SHA256SUMS',
      'desktop/developers/channel/mac/developers-mac.yml',
    ]) {
      assert.ok(validIngestKey(ok), `refused ${ok}`);
    }
    for (const bad of [
      'brand/mark.svg',
      'desktop/../0.14.0/x.dmg',
      '/desktop/0.14.0/x.dmg',
      'desktop/0.14.0',
      'desktop/0.14.0/',
      'desktop/channel/mac/',
      'desktop/channel/mac/a/b',
      'desktop/developers/channel/mac/a/b',
      'desktop/developers/0.14.0',
      'desktop/nightly/0.14.0/x.dmg',
      'desktop/latest/0.14.0/x.dmg',
      'desktop/developers/developers/0.14.0/x.dmg',
      // A version segment has to look like one, and a channel directory has to
      // be one the updater can be pointed at.
      'desktop/nonsense/x.dmg',
      'desktop/developers/nonsense/x.dmg',
      'desktop/channel/darwin/latest-mac.yml',
      'desktop/developers/channel/windows/developers.yml',
    ]) {
      assert.ok(!validIngestKey(bad), `accepted ${bad}`);
    }
  });

  console.log(`\n${ran - failed}/${ran} passed`);
  process.exit(failed ? 1 : 0);
}

main();
