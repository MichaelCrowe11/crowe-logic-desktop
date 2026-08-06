'use strict';

// Proves a published release is actually installable and updatable.
//
//   npm run verify:release                 # the version in package.json
//   npm run verify:release -- 0.16.0
//   npm run verify:release -- 0.16.0 --full
//   npm run verify:release -- 0.16.0 --base=https://staging.example
//
// Everything about a release fails silently. An update feed that names a file
// the bucket does not have reports nothing to anyone: the updater 404s in the
// background and the user simply stays on the old version forever. Twice now
// that has nearly shipped - once because GitHub rewrites spaces to dots in
// release asset names while the feed keeps the spaces, and once because the
// publish script globbed the whole release directory and folded the previous
// version's artifacts into this version's SHA256SUMS.
//
// So this checks the release the way a client meets it, over the network,
// against the deployed worker: fetch each channel feed, then ask for every file
// it names by the exact url it names, through the channel prefix the updater
// resolves against - not the versioned prefix the objects are stored under.
// That path goes through the worker's key remapping, which is where the bodies
// are buried.
//
// A range request rather than a HEAD, because electron-updater applies blockmap
// diffs with ranges. A 206 proves the object resolves and that differential
// updates will work; a HEAD would prove only the former.
//
// --full additionally downloads every artifact and verifies its sha512 against
// the feed. That is around half a gigabyte, so it is opt-in; without it the
// declared size is checked against the object's real size, which catches a
// truncated or mismatched upload without the transfer.

const crypto = require('crypto');
const pkg = require('../package.json');

// One source of truth for where releases live. If the publish url stops looking
// like this, the assumptions below about channel prefixes are stale too.
const PUBLISH = pkg.build.publish[0].url;
const LIVE = PUBLISH.replace(/\/desktop\/channel\/\$\{os\}\/?$/, '');
if (LIVE === PUBLISH) {
  console.error(`verify-release: build.publish url is not the expected shape: ${PUBLISH}`);
  process.exit(2);
}

const CHANNELS = [
  { os: 'mac', feed: 'latest-mac.yml' },
  { os: 'win', feed: 'latest.yml' },
  { os: 'linux', feed: 'latest-linux.yml' },
];

// electron-builder ships the updater's blockmap two different ways, and this
// check got it wrong for AppImage until 0.16.0 was verified by hand.
//
// NsisTarget and ArchiveTarget call createBlockmap(), which writes a separate
// <artifact>.blockmap beside the installer. AppImage calls appendBlockmap()
// instead (app-builder-lib/out/targets/appimage/appImageUtil.js), which has no
// out file: the compressed blockmap is appended to the AppImage itself,
// followed by its own length as a big-endian uint32, and the length is
// published in the feed as blockMapSize. electron-updater then reads it back
// from `fileSize - (blockMapSize + 4)`
// (differentialDownloader/FileWithEmbeddedBlockMapDifferentialDownloader.js).
//
// So there is no such object as Crowe Logic-x.y.z.AppImage.blockmap, and asking
// for one warned on every release that a Linux update would download in full
// when differential updates were working the whole time. A checker that cries
// wolf is worse than no checker, because the next warning gets waved through.
const SIDECAR_BLOCKMAP = /\.(exe|dmg|zip)$/;
const EMBEDDED_BLOCKMAP = /\.AppImage$/;

const args = process.argv.slice(2);
const full = args.includes('--full');
// --base points the same checks at a staging worker, and at the stub server in
// scripts/test-verify-release.js that proves these checks can actually fail.
const baseArg = args.find((a) => a.startsWith('--base='));
const BASE = (baseArg ? baseArg.slice(7) : LIVE).replace(/\/$/, '');
// GITHUB_REF_NAME is the tag on a tag-triggered run and the branch on every
// other kind, and only the first one names a release. Unguarded, the scheduled
// run read "main" as a version and spent three days failing every check against
// a release that does not exist, while the actual release was fine. Take it
// when it is shaped like a version; a branch falls through to package.json,
// which is what this workflow's own comment always said it checked.
const ref = process.env.GITHUB_REF_NAME;
const fromRef = /^v?\d+\.\d+\.\d+/.test(ref || '') ? ref : null;
const version = (args.find((a) => !a.startsWith('--')) || fromRef || pkg.version).replace(/^v/, '');

let failures = 0;
let warnings = 0;
function ok(name) { console.log(`ok      ${name}`); }
function fail(name, detail) {
  failures++;
  console.log(`not ok  ${name}`);
  if (detail) String(detail).split('\n').forEach((l) => console.log(`        ${l}`));
}
function warn(name, detail) {
  warnings++;
  console.log(`warn    ${name}`);
  if (detail) console.log(`        ${detail}`);
}

// latest*.yml is small and its shape is fixed by electron-builder, so parse it
// directly rather than take a yaml dependency the app itself does not declare.
function parseFeed(text) {
  const version = (/^version:\s*(\S+)/m.exec(text) || [])[1] || null;
  const files = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const url = /^\s+-\s+url:\s*(.+?)\s*$/.exec(line);
    if (url) { cur = { url: url[1].replace(/^["']|["']$/g, ''), sha512: null, size: null }; files.push(cur); continue; }
    if (!cur) continue;
    if (/^\S/.test(line)) { cur = null; continue; }   // back out to a top-level key
    const sha = /^\s+sha512:\s*(\S+)/.exec(line);
    if (sha) { cur.sha512 = sha[1]; continue; }
    const size = /^\s+size:\s*(\d+)/.exec(line);
    if (size) { cur.size = Number(size[1]); continue; }
    const bms = /^\s+blockMapSize:\s*(\d+)/.exec(line);
    if (bms) cur.blockMapSize = Number(bms[1]);
  }
  return { version, files };
}

// Two retries because R2 in front of a worker occasionally drops a request, and
// a flaky fetch reported as a broken release is worse than a slow check.
async function get(url, init, attempt = 1) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (attempt >= 3) throw err;
    await new Promise((r) => setTimeout(r, attempt * 500));
    return get(url, init, attempt + 1);
  }
}

// `new URL` percent-encodes the spaces that live in the Windows installer name,
// which is exactly what the updater does and exactly what the worker decodes.
const at = (path) => new URL(path, BASE + '/').toString();

async function probe(channelUrl, file) {
  const res = await get(channelUrl, { headers: { Range: 'bytes=0-0' } });
  if (res.status !== 206) {
    await res.arrayBuffer().catch(() => {});
    return { okay: false, why: `expected 206 for a range request, got ${res.status}` };
  }
  await res.arrayBuffer();
  const range = res.headers.get('content-range') || '';
  const total = Number(range.split('/')[1]);
  if (!Number.isFinite(total)) return { okay: false, why: `no usable content-range: ${range || '(absent)'}` };
  if (file.size != null && total !== file.size) {
    return { okay: false, why: `feed declares ${file.size} bytes, object is ${total}` };
  }
  return { okay: true, total };
}

// Read the AppImage's trailing blockmap exactly as electron-updater does, and
// inflate it. Deflate is unforgiving: a tail that is off by a byte, or an
// object some proxy re-encoded, fails here rather than on a user's machine
// halfway through an update.
async function verifyEmbeddedBlockmap(channelUrl, file) {
  if (file.blockMapSize == null) return 'feed declares no blockMapSize';
  if (file.size == null) return 'feed declares no size';
  const start = file.size - (file.blockMapSize + 4);
  if (start < 0) return `blockMapSize ${file.blockMapSize} exceeds the ${file.size} byte object`;

  const res = await get(channelUrl, { headers: { Range: `bytes=${start}-${file.size - 1}` } });
  if (res.status !== 206) {
    await res.arrayBuffer().catch(() => {});
    return `expected 206 for the blockmap tail, got ${res.status}`;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== file.blockMapSize + 4) {
    return `asked for ${file.blockMapSize + 4} tail bytes, got ${buf.length}`;
  }
  // The last four bytes repeat the length. They disagreeing with the feed means
  // the feed and the object came from different builds.
  const declared = buf.readUInt32BE(buf.length - 4);
  if (declared !== file.blockMapSize) {
    return `object's trailer says ${declared} bytes, feed says ${file.blockMapSize}`;
  }
  let map;
  try {
    map = JSON.parse(require('zlib').inflateRawSync(buf.subarray(0, buf.length - 4)).toString());
  } catch (err) {
    return `blockmap does not inflate: ${err.message}`;
  }
  const chunks = map.files && map.files[0] && map.files[0].sizes;
  if (!Array.isArray(chunks) || chunks.length === 0) return 'blockmap names no chunks';
  // The chunks have to describe the payload, not some prefix of it: they should
  // account for every byte up to where the blockmap itself begins.
  const covered = chunks.reduce((a, b) => a + b, 0);
  if (covered !== start) return `chunks cover ${covered} bytes of a ${start} byte payload`;
  return null;
}

async function verifySha512(channelUrl, file) {
  const res = await get(channelUrl);
  if (!res.ok) return `download failed with ${res.status}`;
  const hash = crypto.createHash('sha512');
  for await (const chunk of res.body) hash.update(chunk);
  const got = hash.digest('base64');
  return got === file.sha512 ? null : `sha512 mismatch\n  feed: ${file.sha512}\n  live: ${got}`;
}

(async () => {
  console.log(`verify-release: ${version} at ${BASE}\n`);
  const published = [];   // every artifact name any feed names, for the SHA256SUMS check

  for (const { os, feed } of CHANNELS) {
    const feedUrl = at(`desktop/channel/${os}/${feed}`);
    let parsed;
    try {
      const res = await get(feedUrl);
      if (!res.ok) { fail(`${os}: feed resolves`, `${res.status} for ${feedUrl}`); continue; }
      parsed = parseFeed(await res.text());
    } catch (err) {
      fail(`${os}: feed resolves`, err.message);
      continue;
    }

    if (parsed.version !== version) {
      fail(`${os}: feed advertises ${version}`, `feed says ${parsed.version || '(no version key)'}`);
      continue;   // every file below would be the wrong release
    }
    ok(`${os}: feed advertises ${version}`);

    if (parsed.files.length === 0) { fail(`${os}: feed names at least one file`); continue; }

    for (const file of parsed.files) {
      published.push(file.url);
      const url = at(`desktop/channel/${os}/${file.url}`);
      let result;
      try { result = await probe(url, file); } catch (err) { result = { okay: false, why: err.message }; }
      if (result.okay) ok(`${os}: ${file.url} resolves and serves ranges`);
      else fail(`${os}: ${file.url} resolves and serves ranges`, result.why);

      if (SIDECAR_BLOCKMAP.test(file.url)) {
        try {
          const res = await get(at(`desktop/channel/${os}/${file.url}.blockmap`), { headers: { Range: 'bytes=0-0' } });
          await res.arrayBuffer().catch(() => {});
          if (res.status !== 206) warn(`${os}: ${file.url}.blockmap present`, `${res.status} - updates will download in full`);
          else ok(`${os}: ${file.url}.blockmap present`);
        } catch (err) {
          warn(`${os}: ${file.url}.blockmap present`, err.message);
        }
      } else if (EMBEDDED_BLOCKMAP.test(file.url)) {
        // Fetch the tail the updater will fetch and read it the way the updater
        // reads it. Checking that the feed merely mentions blockMapSize would
        // pass on a truncated or re-compressed object, which is the case where
        // the update actually breaks.
        const why = await verifyEmbeddedBlockmap(url, file);
        if (why) warn(`${os}: ${file.url} carries its blockmap`, `${why} - updates will download in full`);
        else ok(`${os}: ${file.url} carries its blockmap`);
      }

      if (full && file.sha512 && result.okay) {
        const why = await verifySha512(url, file);
        if (why) fail(`${os}: ${file.url} matches its feed sha512`, why);
        else ok(`${os}: ${file.url} matches its feed sha512`);
      }
    }
  }

  // The download page tells people to run sha256sum -c, so the file has to exist
  // and has to describe this release and only this release.
  try {
    const res = await get(at(`desktop/${version}/SHA256SUMS`));
    if (!res.ok) {
      fail('SHA256SUMS is published', `${res.status}`);
    } else {
      const named = (await res.text()).split(/\r?\n/)
        .map((l) => l.replace(/^\S+\s+\*?/, '').trim())
        .filter(Boolean);
      const missing = published.filter((n) => !named.includes(n));
      const extra = named.filter((n) => !published.includes(n));
      if (missing.length) fail('SHA256SUMS covers every published artifact', missing.join('\n'));
      else ok('SHA256SUMS covers every published artifact');
      // An extra name here is how a previous release's artifacts leak into this
      // one: the checksum file is the only place that leak is visible.
      if (extra.length) fail('SHA256SUMS names nothing from another release', extra.join('\n'));
      else ok('SHA256SUMS names nothing from another release');
    }
  } catch (err) {
    fail('SHA256SUMS is published', err.message);
  }

  // The page is what humans meet, and it read three releases stale once before.
  try {
    const res = await get(BASE + '/');
    const html = res.ok ? await res.text() : '';
    if (!res.ok) fail('download page serves', `${res.status}`);
    else if (!html.includes(`v${version}`)) fail('download page offers this release', `no "v${version}" in the page`);
    else ok('download page offers this release');
  } catch (err) {
    fail('download page serves', err.message);
  }

  console.log(`\n${failures ? `${failures} failed` : 'all checks passed'}${warnings ? `, ${warnings} warning${warnings > 1 ? 's' : ''}` : ''}`);
  if (!full) console.log('(pass --full to also download each artifact and verify its sha512)');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('verify-release: ' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
