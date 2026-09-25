'use strict';

// The releases worker decides two things that fail silently when wrong: which
// bucket key an update download resolves to, and which installers the download
// page offers. Both shipped broken. The page advertised a version three releases
// old and linked a Windows installer that had never been built under that name,
// while every update download 404'd because the manifest lives under the channel
// prefix and the installers do not.
//
// Three editions now share it. Developers and Mycology live under their own
// desktop/<edition>/ prefixes, feeds included; the worker must keep them apart
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
  return { versionedKeysFor, catalog, renderPage, handler, feedKey, validIngestKey, artifactOf };
`);
const { versionedKeysFor, catalog, renderPage, handler, feedKey, validIngestKey, artifactOf } = load();

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

const MYC_DMG = 'CroweLogic-mycology-0.14.0-arm64.dmg';
const MYC_MANIFESTS = Object.fromEntries(Object.entries(DEV_MANIFESTS).map(([key, text]) => [
  key.replaceAll('developers', 'mycology'), text.replaceAll('developers', 'mycology'),
]));

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
    for (const channel of ['latest', 'developers', 'mycology']) {
      for (const os of layout.OSES) {
        assert.strictEqual(feedKey(channel, os), layout.feedKey(channel, os));
      }
    }
    for (const wrong of ['channel/darwin/', 'channel/windows/', 'channel/win32/']) {
      assert.ok(!src.includes(wrong), `worker still references ${wrong}`);
    }
  });

  await check('both publishers key every write off the channel layout', () => {
    const helper = fs.readFileSync(path.join(__dirname, 'publish-args.js'), 'utf8');
    assert.ok(helper.includes("require('./release-channel')"));
    assert.ok(helper.includes('channels.fromArgs(selection)'));
    const { resolvePublishArgs, shellArgs } = require('./publish-args');
    for (const channel of ['latest', 'developers', 'mycology']) {
      const target = resolvePublishArgs(['--channel', channel, '--matrix', 'mac:arm64:dmg+zip'], { env: {} });
      assert.strictEqual(target.channel, channel);
      const shell = shellArgs(target);
      assert.ok(shell.includes(`prefix='${layout.prefix(channel)}'`));
      for (const os of layout.OSES) assert.ok(shell.includes(`feed_${os}='${layout.feedName(channel, os)}'`));
    }
    for (const name of ['publish-r2.sh', 'publish-rclone.sh']) {
      const sh = fs.readFileSync(path.join(__dirname, name), 'utf8');
      assert.ok(sh.includes('publish-args.js" "$@"'), `${name} does not resolve its layout through publish-args.js`);
      assert.ok(sh.includes('eval "$resolved"'), `${name} does not consume its resolved layout`);
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

  await check('the Windows card states the signing as it is on both editions', async () => {
    // Windows installers have been signed through Azure Trusted Signing since 0.24.9
    // (release.yml and release-developers.yml both gate on Get-AuthenticodeSignature
    // reading Valid). The page used to say validation was still being completed,
    // which read as "unsigned" to a careful downloader.
    const both = { ...MANIFESTS, ...DEV_MANIFESTS };
    for (const [html, page] of [
      [renderPage(await catalog(envWith(MANIFESTS))), 'full'],
      [renderPage(await catalog(envWith(both), 'developers'), 'developers'), 'developers'],
    ]) {
      assert.ok(html.includes('signed with Azure Trusted Signing'), `${page} page does not say the installer is signed`);
      assert.ok(html.includes('SmartScreen names Michael Crowe as the publisher'), `${page} page does not name the publisher SmartScreen shows`);
      assert.ok(!html.includes('code-signing validation'), `${page} page still implies signing is pending`);
      assert.ok(!html.includes('not code signed'), `${page} page claims the installer is unsigned`);
    }
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

  await check('Mycology catalog and page use only their own feeds and artifact prefix', async () => {
    const all = { ...MANIFESTS, ...DEV_MANIFESTS, ...MYC_MANIFESTS };
    assert.deepStrictEqual(await catalog(envWith(all), 'mycology'), {
      version: '0.14.0', windows: null, macos: MYC_DMG, macosIntel: null, appimage: null, deb: null,
    });
    assert.strictEqual(await catalog(envWith({ ...MANIFESTS, ...DEV_MANIFESTS }), 'mycology'), null);
    assert.strictEqual(await catalog(envWith(MYC_MANIFESTS)), null);
    assert.strictEqual(await catalog(envWith(MYC_MANIFESTS), 'developers'), null);
    assert.deepStrictEqual(await catalog(envWith(all)), await catalog(envWith(MANIFESTS)));
    const env = envWith(all);
    const response = await handler.fetch(new Request('https://x/mycology'), env);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('<h1>Crowe Logic Mycology</h1>'));
    assert.ok(html.includes(`href="/desktop/mycology/0.14.0/${MYC_DMG}"`));
    assert.ok(html.includes('href="/desktop/mycology/0.14.0/SHA256SUMS"'));
    assert.ok(!html.includes('/desktop/0.14.0/') && !html.includes('/desktop/developers/'));
    for (const page of ['/', '/developers']) {
      const other = await (await handler.fetch(new Request(`https://x${page}`), env)).text();
      assert.ok(!other.includes('/desktop/mycology/'));
    }
    const head = await handler.fetch(new Request('https://x/mycology', { method: 'HEAD' }), env);
    assert.strictEqual(head.status, 200);
    assert.strictEqual(await head.text(), '');
    const mac = await handler.fetch(new Request('https://x/mycology/mac'), env);
    assert.strictEqual(mac.status, 302);
    assert.strictEqual(mac.headers.get('location'), `https://x/desktop/mycology/0.14.0/${MYC_DMG}`);
    for (const missing of ['mac-intel', 'windows', 'appimage', 'deb', 'amiga']) {
      assert.strictEqual((await handler.fetch(new Request(`https://x/mycology/${missing}`), env)).status, 404);
    }
  });

  await check('unseeded Mycology never uses Desktop or Developers pages, feeds or artifacts', async () => {
    const asked = [];
    const env = envWith({ ...MANIFESTS, ...DEV_MANIFESTS });
    const get = env.RELEASES.get;
    env.RELEASES.get = async (key) => { asked.push(key); return get(key); };
    for (const page of ['mycology', 'mycology/mac', 'mycology/windows']) {
      const res = await handler.fetch(new Request(`https://x/${page}`), env);
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.headers.get('location'), null);
    }
    for (const os of layout.OSES) {
      const res = await handler.fetch(new Request(`https://x/${layout.feedKey('mycology', os)}`), env);
      assert.strictEqual(res.status, 404);
    }
    assert.strictEqual((await handler.fetch(new Request(`https://x/desktop/mycology/channel/mac/${DEV_DMG}`), env)).status, 404);
    assert.ok(asked.every((key) => key.startsWith('desktop/mycology/')), asked.join(', '));
  });

  await check('Mycology updater stays in its tree for installers, blockmaps and missing feeds', async () => {
    const asked = [];
    const body = 'mycology bytes';
    const env = {
      RELEASES: { async get(key) {
        asked.push(key);
        if (![`${layout.prefix('mycology')}/0.14.0/${MYC_DMG}`, `${layout.prefix('mycology')}/0.14.0/${MYC_DMG}.blockmap`].includes(key)) return null;
        return { body, size: body.length, httpEtag: '"m"', writeHttpMetadata() {} };
      } },
    };
    for (const name of [MYC_DMG, `${MYC_DMG}.blockmap`]) {
      const res = await handler.fetch(new Request(`https://x/${layout.updateKey('mycology', 'mac', name)}`), env);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(await res.text(), body);
    }
    assert.ok(asked.every((key) => key.startsWith('desktop/mycology/')));
    for (const channel of ['latest', 'developers']) {
      assert.strictEqual((await handler.fetch(new Request(`https://x/${layout.updateKey(channel, 'mac', MYC_DMG)}`), env)).status, 404);
    }
    for (const os of layout.OSES) assert.deepStrictEqual(versionedKeysFor(layout.feedKey('mycology', os)), []);
  });

  await check('identically named artifacts never cross edition boundaries in either direction', async () => {
    const name = 'shared-1.2.3-arm64.dmg';
    const channels = ['latest', 'developers', 'mycology'];
    for (const populated of channels) {
      const env = { RELEASES: { async get(key) {
        if (key !== layout.artifactKey(populated, '1.2.3', name)) return null;
        return { body: populated, size: populated.length, httpEtag: '"same-name"', writeHttpMetadata() {} };
      } } };
      for (const requested of channels) {
        const response = await handler.fetch(new Request(`https://x/${layout.updateKey(requested, 'mac', name)}`), env);
        assert.strictEqual(response.status, requested === populated ? 200 : 404, `${requested} read ${populated}'s artifact`);
        if (response.status === 200) assert.strictEqual(await response.text(), populated);
      }
    }
  });

  await check('ingest accepts all three editions\' key shapes and nothing else', () => {
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
      `desktop/mycology/0.14.0/${MYC_DMG}`,
      'desktop/mycology/0.14.0/SHA256SUMS',
      ...layout.OSES.map((os) => layout.feedKey('mycology', os)),
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
      'desktop/mycology/../0.14.0/x.dmg',
      'desktop/mycology/channel/mac/a/b',
      'desktop/mycology/channel/windows/mycology.yml',
      'desktop/mycology/mycology/0.14.0/x.dmg',
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

  // Install counting. The worker writes one data point per installer or feed
  // it serves to the crowe_releases Analytics Engine dataset, in the shape
  // the funnel report queries. Nothing about the response may change for it,
  // and a request that is not an install (HEAD, 404, a blockmap) writes nothing.
  const OBJECTS = {
    'desktop/0.14.0/CroweLogic-0.14.0-arm64.dmg': 'installer bytes',
    'desktop/0.14.0/CroweLogic-0.14.0-arm64.zip.blockmap': 'blockmap',
    'desktop/0.14.0/SHA256SUMS': 'sums',
    'desktop/channel/mac/latest-mac.yml': MANIFESTS['desktop/channel/mac/latest-mac.yml'],
    'desktop/channel/win/latest.yml': MANIFESTS['desktop/channel/win/latest.yml'],
    'desktop/developers/channel/linux/developers-linux.yml': 'version: 0.14.0\nfiles: []\n',
    [`desktop/developers/0.14.0/${DEV_DMG}`]: 'developer bytes',
    [`desktop/mycology/0.14.0/${MYC_DMG}`]: 'mycology bytes',
    'desktop/mycology/channel/mac/mycology-mac.yml': MYC_MANIFESTS['desktop/mycology/channel/mac/mycology-mac.yml'],
    'brand/mark.svg': '<svg/>',
  };
  function countingEnv() {
    const points = [];
    return {
      points,
      RELEASES: {
        async get(key, options) {
          const full = OBJECTS[key];
          if (full === undefined) return null;
          const object = { size: full.length, httpEtag: '"x"', writeHttpMetadata() {} };
          if (!options || !options.range) return { ...object, body: full };
          return { ...object, body: full.slice(4, 9), range: { offset: 4, length: 5 } };
        },
      },
      crowe_releases: { writeDataPoint(point) { points.push(point); } },
    };
  }
  // The handler reads url, method, headers and cf off the request, so a plain
  // object stands in for one where a country has to be attached.
  const fromCountry = (url, country, init = {}) => ({
    url, method: init.method || 'GET', headers: new Headers(init.headers || {}), cf: { country },
  });

  await check('artifact kinds and platforms are read off the path', () => {
    assert.deepStrictEqual(artifactOf('/desktop/0.14.0/CroweLogic-0.14.0-arm64.dmg'), { kind: 'dmg', platform: 'mac' });
    assert.deepStrictEqual(artifactOf('/desktop/channel/mac/CroweLogic-0.14.0-arm64.zip'), { kind: 'zip', platform: 'mac' });
    assert.deepStrictEqual(artifactOf('/desktop/0.14.0/Crowe Logic Setup 0.14.0.exe'), { kind: 'exe', platform: 'win' });
    assert.deepStrictEqual(artifactOf('/desktop/0.14.0/Crowe Logic-0.14.0.AppImage'), { kind: 'appimage', platform: 'linux' });
    assert.deepStrictEqual(artifactOf('/desktop/0.14.0/crowe-logic-desktop_0.14.0_amd64.deb'), { kind: 'deb', platform: 'linux' });
    assert.deepStrictEqual(artifactOf('/desktop/channel/mac/latest-mac.yml'), { kind: 'yml', platform: 'mac' });
    assert.deepStrictEqual(artifactOf('/desktop/channel/win/latest.yml'), { kind: 'yml', platform: 'win' });
    assert.deepStrictEqual(artifactOf('/desktop/developers/channel/linux/developers-linux.yml'), { kind: 'yml', platform: 'linux' });
    for (const notCounted of [
      '/desktop/0.14.0/CroweLogic-0.14.0-arm64.zip.blockmap',
      '/desktop/0.14.0/SHA256SUMS',
      '/brand/mark.svg',
      '/desktop/0.14.0/notes.md',
    ]) {
      assert.strictEqual(artifactOf(notCounted), null, `${notCounted} counted`);
    }
  });

  await check('a served installer writes one data point in the agreed shape', async () => {
    const env = countingEnv();
    const path = '/desktop/channel/mac/CroweLogic-0.14.0-arm64.dmg';
    const res = await handler.fetch(fromCountry(`https://x${path}`, 'US'), env);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(env.points, [{
      indexes: ['dmg'],
      blobs: ['stable', 'mac', 'dmg', path, 'US', '200'],
      doubles: [1, 'installer bytes'.length],
    }]);
  });

  await check('feeds are counted per platform and edition, and the response does not change', async () => {
    const env = countingEnv();
    const before = await handler.fetch(new Request('https://x/desktop/channel/mac/latest-mac.yml'), { RELEASES: env.RELEASES });
    const after = await handler.fetch(new Request('https://x/desktop/channel/mac/latest-mac.yml'), env);
    assert.strictEqual(after.status, 200);
    assert.strictEqual(await after.text(), await before.text());
    assert.deepStrictEqual([...after.headers].sort(), [...before.headers].sort(), 'the feed response changed');
    await handler.fetch(new Request('https://x/desktop/channel/win/latest.yml'), env);
    await handler.fetch(new Request('https://x/desktop/developers/channel/linux/developers-linux.yml'), env);
    assert.deepStrictEqual(env.points.map((p) => p.blobs.slice(0, 3)), [
      ['stable', 'mac', 'yml'],
      ['stable', 'win', 'yml'],
      ['developers', 'linux', 'yml'],
    ]);
    // No country on the request is an empty blob, not a crash and not "undefined".
    assert.strictEqual(env.points[0].blobs[4], '');
    assert.deepStrictEqual(env.points[0].doubles, [1, OBJECTS['desktop/channel/mac/latest-mac.yml'].length]);
  });

  await check('a developer installer is counted on the developers channel', async () => {
    const env = countingEnv();
    await handler.fetch(new Request(`https://x/desktop/developers/channel/mac/${DEV_DMG}`), env);
    assert.strictEqual(env.points.length, 1);
    assert.deepStrictEqual(env.points[0].blobs.slice(0, 3), ['developers', 'mac', 'dmg']);
  });

  await check('Mycology installers and feeds are counted on their own channel', async () => {
    const env = countingEnv();
    for (const key of [layout.updateKey('mycology', 'mac', MYC_DMG), layout.feedKey('mycology', 'mac')]) {
      assert.strictEqual((await handler.fetch(new Request(`https://x/${key}`), env)).status, 200);
    }
    assert.deepStrictEqual(env.points.map((point) => point.blobs.slice(0, 3)), [
      ['mycology', 'mac', 'dmg'], ['mycology', 'mac', 'yml'],
    ]);
  });

  await check('a range request is recorded as a 206 with the bytes it served', async () => {
    const env = countingEnv();
    const res = await handler.fetch(
      new Request('https://x/desktop/channel/mac/CroweLogic-0.14.0-arm64.dmg', { headers: { range: 'bytes=4-8' } }),
      env
    );
    assert.strictEqual(res.status, 206);
    assert.strictEqual(env.points.length, 1);
    assert.strictEqual(env.points[0].blobs[5], '206');
    assert.deepStrictEqual(env.points[0].doubles, [1, 5]);
  });

  await check('HEADs, 404s, blockmaps, checksums and brand assets write nothing', async () => {
    const env = countingEnv();
    const head = await handler.fetch(new Request('https://x/desktop/channel/mac/CroweLogic-0.14.0-arm64.dmg', { method: 'HEAD' }), env);
    assert.strictEqual(head.status, 200);
    const missing = await handler.fetch(new Request('https://x/desktop/channel/mac/CroweLogic-9.9.9-arm64.dmg'), env);
    assert.strictEqual(missing.status, 404);
    const missingFeed = await handler.fetch(new Request('https://x/desktop/channel/linux/latest-linux.yml'), env);
    assert.strictEqual(missingFeed.status, 404);
    for (const served of [
      'https://x/desktop/0.14.0/CroweLogic-0.14.0-arm64.zip.blockmap',
      'https://x/desktop/0.14.0/SHA256SUMS',
      'https://x/brand/mark.svg',
    ]) {
      assert.strictEqual((await handler.fetch(new Request(served), env)).status, 200);
    }
    assert.deepStrictEqual(env.points, []);
  });

  await check('a missing or failing binding never costs a download', async () => {
    const plain = countingEnv();
    delete plain.crowe_releases;
    assert.strictEqual((await handler.fetch(new Request('https://x/desktop/channel/mac/latest-mac.yml'), plain)).status, 200);
    const broken = countingEnv();
    broken.crowe_releases.writeDataPoint = () => { throw new Error('analytics down'); };
    const res = await handler.fetch(new Request('https://x/desktop/channel/mac/CroweLogic-0.14.0-arm64.dmg'), broken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'installer bytes');
  });

  await check('wrangler.jsonc binds the crowe_releases dataset under that name', () => {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deploy', 'releases-worker', 'wrangler.jsonc'), 'utf8'));
    assert.deepStrictEqual(config.analytics_engine_datasets, [{ binding: 'crowe_releases', dataset: 'crowe_releases' }]);
    assert.ok(src.includes('env.crowe_releases'), 'the worker does not write through the crowe_releases binding');
  });

  console.log(`\n${ran - failed}/${ran} passed`);
  process.exit(failed ? 1 : 0);
}

main();
