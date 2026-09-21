// Crowe Logic release site: branded download page at "/", installer objects
// streamed from the crowe-releases R2 bucket under /desktop/* and /brand/*.

// Canonical standalone Gate Glyph from assets/gate-glyph.svg.
const MARK_SVG = `<svg class="mark" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <g transform="translate(-3.50 0.00) scale(1.0000)"><path d="M41.31,47.76 A20,20 0 1 1 41.31,16.24" fill="none" stroke="#121212" stroke-width="8" stroke-linecap="butt"/><path d="M48,12 h8 v40 h-8 z M48,44 h15 v8 h-15 z" fill="#121212"/><polygon points="37.63,35.25 32.00,38.50 26.37,35.25 26.37,28.75 32.00,25.50 37.63,28.75" fill="#B99A5B"/></g>
</svg>`;
const MARK_ICON = "data:image/svg+xml," + encodeURIComponent(MARK_SVG.replace(' class="mark"', ""));

// Two editions share the bucket and this worker. The full edition is stored
// under desktop/ and Crowe Logic for Developers under desktop/developers/, its
// update feeds included, so nothing either publishes can land on a key the
// other serves. scripts/release-channel.js is the source of this layout; the
// worker ships on its own and cannot import it, so the same layout is spelled
// out here and scripts/test-releases-worker.js holds the two to each other.
const CHANNELS = {
  latest: {
    prefix: "desktop",
    name: "Crowe Logic",
    tag: "releases",
    title: "Crowe Logic desktop",
    description: "Download the Crowe Logic desktop app for Windows, macOS, and Linux.",
    sub: "The operator for your workspace. Chat, a real terminal, reviewable edits, and an in-app browser, signed in with your Crowe ID.",
  },
  developers: {
    prefix: "desktop/developers",
    name: "Crowe Logic for Developers",
    tag: "developers",
    title: "Crowe Logic for Developers",
    description: "Download Crowe Logic for Developers for Windows, macOS, and Linux.",
    sub: "The coding agent for your repositories. Chat and Projects, a real terminal, reviewable edits, and an in-app browser, signed in with your Crowe ID.",
  },
};

// The feed electron-updater asks for: named after the channel, in the channel
// directory under the edition's prefix. Windows has no os suffix.
function feedKey(channel, os) {
  return `${CHANNELS[channel].prefix}/channel/${os}/${channel}${os === "win" ? "" : `-${os}`}.yml`;
}

function href(channel, version, name) {
  return `/${CHANNELS[channel].prefix}/${encodeURIComponent(version)}/${encodeURIComponent(name)}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function card(channel, title, meta, body, rel, primary, secondary, secondaryLabel) {
  const buttons = primary
    ? `<a class="btn" href="${href(channel, rel.version, primary)}">Download for ${escapeHtml(title)}</a>` +
      (secondary ? `\n        <span class="alt"><a href="${href(channel, rel.version, secondary)}">${escapeHtml(secondaryLabel)}</a></span>` : "")
    : `<span class="meta">Not in this release</span>`;
  return `<div class="card">
        <h2>${escapeHtml(title)}</h2>
        <span class="meta">${escapeHtml(meta)}</span>
        <p>${escapeHtml(body)}</p>
        ${buttons}
      </div>`;
}

// The page used to hardcode a version and installer filenames, which drifted
// three releases out of date and linked a Windows installer that had never been
// built under that name. Read the channel manifests the updater reads instead,
// so the page cannot disagree with what was actually published.
async function readManifest(env, key) {
  const object = await env.RELEASES.get(key);
  if (!object) return null;
  const text = await object.text();
  const version = /^version:\s*(\S+)/m.exec(text);
  if (!version) return null;
  return { version: version[1], files: [...text.matchAll(/^\s+- url:\s*(.+?)\s*$/gm)].map((m) => m[1]) };
}

async function catalog(env, channel = "latest") {
  // The channel directories must match electron-builder's ${os} macro in the
  // publish url, which expands to mac, win and linux.
  const [mac, win, lin] = await Promise.all(["mac", "win", "linux"].map((os) => readManifest(env, feedKey(channel, os))));

  // Platforms can lag each other, so show the newest version any of them
  // reached and only offer the installers that belong to it.
  const versions = [mac, win, lin].filter(Boolean).map((m) => m.version);
  if (versions.length === 0) return null;
  const version = versions.sort(compareVersions).pop();
  const at = (m) => (m && m.version === version ? m.files : []);
  const pick = (m, re) => at(m).find((f) => re.test(f)) || null;

  // Match the architecture explicitly rather than taking the first dmg in the
  // feed. electron-builder writes x64 ahead of arm64, so "first dmg" handed
  // every Apple Silicon visitor the Intel build under a card that said Apple
  // Silicon - and the download works, so nobody would have reported it.
  return {
    version,
    windows: pick(win, /\.exe$/),
    macos: pick(mac, /arm64\.dmg$/) || pick(mac, /\.dmg$/),
    macosIntel: pick(mac, /x64\.dmg$/),
    appimage: pick(lin, /\.AppImage$/),
    deb: pick(lin, /\.deb$/),
  };
}

function compareVersions(a, b) {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      // A prerelease identifier sorts below the release of the same numbers.
      if (pa[i] === pb[i]) continue;
      if (pa[i] === undefined) return 1;
      if (pb[i] === undefined) return -1;
      return pa[i] < pb[i] ? -1 : 1;
    }
    if (na !== nb) return na - nb;
  }
  return 0;
}

function renderPage(rel, channel = "latest") {
  const edition = CHANNELS[channel];
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(edition.name)} releases</title>
<meta name="description" content="${escapeHtml(edition.description)}" />
<link rel="icon" type="image/svg+xml" href="${MARK_ICON}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
:root { --paper:#f7f3ea; --panel:#fdfbf5; --ink:#1a1714; --gold:#b8893a; --dim:#6b6457; --line:rgba(26,23,20,.12); }
* { box-sizing:border-box; margin:0; }
body { background:var(--paper); color:var(--ink); font-family:Inter,system-ui,sans-serif; line-height:1.6; }
.wrap { max-width:920px; margin:0 auto; padding:0 24px; }
header { border-bottom:1px solid var(--line); }
header .wrap { display:flex; align-items:center; gap:12px; padding-top:16px; padding-bottom:16px; }
header .mark { width:28px; height:28px; }
header .name { font-family:Fraunces,Georgia,serif; font-weight:600; font-size:18px; }
header .tag { font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--dim); border:1px solid var(--line); border-radius:999px; padding:2px 10px; margin-left:4px; }
main { padding:56px 0 64px; }
h1 { font-family:Fraunces,Georgia,serif; font-weight:600; font-size:40px; line-height:1.1; letter-spacing:-0.01em; }
.sub { color:var(--dim); font-size:15px; max-width:560px; margin:16px 0 8px; }
.ver { display:inline-block; font-family:'JetBrains Mono',monospace; font-size:12px; color:var(--gold); border:1px solid var(--gold); border-radius:999px; padding:2px 12px; margin:8px 0 40px; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:16px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:24px; display:flex; flex-direction:column; gap:12px; }
.card h2 { font-family:Fraunces,Georgia,serif; font-weight:600; font-size:20px; }
.card .meta { font-family:'JetBrains Mono',monospace; font-size:11.5px; color:var(--dim); }
.card p { font-size:13.5px; color:var(--dim); flex:1; }
.btn { display:inline-block; background:var(--ink); color:var(--paper); text-decoration:none; font-size:14px; font-weight:500; border-radius:10px; padding:10px 18px; text-align:center; }
.btn:hover { background:var(--gold); }
.alt { font-size:13px; }
.alt a { color:var(--gold); }
code, pre { font-family:'JetBrains Mono',monospace; font-size:12px; }
pre { background:#17150f; color:#e9e2cf; border-radius:8px; padding:10px 14px; overflow-x:auto; }
.note { border-left:2px solid var(--gold); padding-left:14px; margin-top:24px; font-size:13px; color:var(--dim); }
section.checks { margin-top:56px; border-top:1px solid var(--line); padding-top:32px; }
section.checks h3 { font-family:Fraunces,Georgia,serif; font-size:18px; font-weight:600; margin-bottom:8px; }
section.checks p { font-size:13.5px; color:var(--dim); margin-bottom:10px; }
section.presale { margin:48px 0 0; background:var(--panel); border:1px solid var(--gold); border-radius:14px; padding:28px; }
section.presale .eyebrow { font-family:'JetBrains Mono',monospace; font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--gold); margin-bottom:10px; }
section.presale h2 { font-family:Fraunces,Georgia,serif; font-size:26px; font-weight:600; margin-bottom:10px; }
section.presale p { font-size:14px; color:var(--dim); max-width:600px; }
section.presale .price { font-family:Fraunces,Georgia,serif; font-size:22px; margin:14px 0 4px; }
section.presale .price small { font-size:13px; color:var(--dim); font-family:Inter,system-ui,sans-serif; }
section.presale form { display:flex; gap:10px; margin-top:16px; flex-wrap:wrap; }
section.presale input[type=email] { flex:1; min-width:220px; border:1px solid var(--line); border-radius:10px; padding:10px 14px; font-size:14px; font-family:Inter,system-ui,sans-serif; background:#fff; }
section.presale button { background:var(--gold); color:#fff; border:0; border-radius:10px; padding:10px 22px; font-size:14px; font-weight:600; cursor:pointer; }
section.presale button:hover { background:var(--ink); }
section.presale .err { color:#a33; font-size:13px; margin-top:10px; display:none; }
footer { border-top:1px solid var(--line); padding:24px 0 40px; color:var(--dim); font-size:12.5px; }
footer .wrap { display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; }
</style>
</head>
<body>
<header>
  <div class="wrap">
    ${MARK_SVG}
    <span class="name">${escapeHtml(edition.name)}</span>
    <span class="tag">${escapeHtml(edition.tag)}</span>
  </div>
</header>
<main>
  <div class="wrap">
    <h1>${escapeHtml(edition.title)}</h1>
    <p class="sub">${escapeHtml(edition.sub)}</p>
    <span class="ver">v${rel.version}</span>
    <div class="grid">
      ${card(channel, "Windows", "64-bit installer", "Run the installer and follow the setup prompts. The installer is signed with Azure Trusted Signing and SmartScreen names Michael Crowe as the publisher; if it still asks, choose More info, then Run anyway, and check the SHA-256 against SHA256SUMS.", rel, rel.windows)}
      ${card(channel, "macOS", "Apple Silicon dmg", `Open the dmg and drag ${edition.name} to Applications. The dmg and the app inside it are Developer ID signed, Apple notarized, and stapled.`, rel, rel.macos, rel.macosIntel, "Download for Intel")}
      ${card(channel, "Linux", "x86_64 AppImage and deb", "Mark the AppImage executable and run it, or install the deb with apt.", rel, rel.appimage, rel.deb, "Download deb")}
    </div>
    <section class="checks">
      <h3>Verify your download</h3>
      <p>With <a style="color:var(--gold)" href="${href(channel, rel.version, "SHA256SUMS")}">SHA256SUMS</a> in your download folder:</p>
      <pre>sha256sum -c SHA256SUMS --ignore-missing</pre>
    </section>
  </div>
</main>
<footer>
  <div class="wrap">
    <span>Crowe Logic, Inc.</span>
    <span>Questions: michael@crowelogic.com</span>
  </div>
</footer>
</body>
</html>`;
}

const TYPES = {
  ".exe": "application/octet-stream",
  ".dmg": "application/octet-stream",
  ".deb": "application/octet-stream",
  ".AppImage": "application/octet-stream",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
};

function contentTypeFor(key, stored) {
  if (stored && stored !== "application/octet-stream") return stored;
  const ext = Object.keys(TYPES).find((e) => key.endsWith(e));
  return ext ? TYPES[ext] : stored || "application/octet-stream";
}

// electron-updater resolves the `url` of each file in latest-*.yml relative to
// the feed, which is desktop/channel/<os>/. The installers themselves are stored
// once per release under desktop/<version>/, so that lookup misses and every
// update download 404s. Rather than storing a second copy of a 120 MB installer
// per channel, map the miss back onto the versioned key using the version in the
// filename.
//
// The three platforms disagree on naming, so the version is delimited differently
// in each: CroweLogic-0.14.0-arm64.dmg, Crowe.Logic-0.14.0.AppImage,
// crowe-logic-desktop_0.14.0_amd64.deb, Crowe Logic Setup 0.14.0.exe.
//
// A plain release is stored under x.y.z, but a prerelease tag such as v0.15.0-rc.1
// is stored under the full identifier, and by inspection alone a trailing
// prerelease is indistinguishable from an arch suffix. So return candidates,
// shortest first, and let the bucket decide.
//
// The edition's tree is chosen by the channel directory the request came
// through, never by the file's name: desktop/channel/<os>/ resolves under
// desktop/, desktop/<edition>/channel/<os>/ under desktop/<edition>/. Feeds are
// stored where they are asked for and are never remapped.
function versionedKeysFor(key) {
  const m = /^(desktop(?:\/(?!channel\/)[a-z][a-z0-9-]*)?)\/channel\/[^/]+\/([^/]+)$/.exec(key);
  if (!m) return [];
  const [, prefix, name] = m;
  if (name.endsWith(".yml")) return [];

  const v = /(?:^|[-_. ])(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.]+))?(?=[-_. ]|$)/.exec(name);
  if (!v) return [];

  const keys = [`${prefix}/${v[1]}/${name}`];
  if (v[2]) keys.push(`${prefix}/${v[1]}-${v[2]}/${name}`);
  return keys;
}

// Publishing a release means moving ~500 MB into the bucket, and the release
// machine is whatever laptop notarized the macOS build. Cloudflare's object API
// refuses bodies that size on some networks: v0.21.0's macOS artifacts failed
// fifteen times running from a residential uplink, while GitHub had accepted the
// very same files without complaint. Sized PUTs died in under 200ms, before a
// byte was sent, and streaming only raised the ceiling rather than removing it.
//
// Nothing about the files is the problem. The direction is. So pull instead of
// push: hand this endpoint an asset id on this repo's GitHub release and it
// copies the object in over Cloudflare's own network, GitHub to R2, with only a
// small JSON request crossing the release machine's uplink.
//
// The endpoint does not exist unless INGEST_TOKEN is set (wrangler secret put
// INGEST_TOKEN), it holds no GitHub credential of its own - the caller supplies
// one per request - and it cannot be aimed anywhere but this repo's own release
// assets, because the source url is built here from an integer id rather than
// accepted from the caller.
const INGEST_REPO = "MichaelCrowe11/crowe-logic-desktop";

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Only the shapes the publishers write: <prefix>/<version>/<file> and
// <prefix>/channel/<os>/<file>, where <prefix> is desktop or an edition's
// desktop/<channel>, <version> is x.y.z with an optional prerelease, and <os>
// is one of the three electron-builder's ${os} macro expands to. Segments are
// matched against a literal set of characters, so "..", a leading slash and an
// empty segment are all unmatchable rather than filtered out afterwards.
function validIngestKey(key) {
  const seg = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;
  const parts = key.split("/");
  if (parts[0] !== "desktop") return false;
  const rest = parts.slice(1);
  if (!rest.every((p) => seg.test(p) && !p.includes(".."))) return false;
  if (rest.length > 1 && Object.hasOwn(CHANNELS, rest[0]) && CHANNELS[rest[0]].prefix !== "desktop") rest.shift();
  if (rest.length === 2) return /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(rest[0]);
  return rest.length === 3 && rest[0] === "channel" && ["mac", "win", "linux"].includes(rest[1]);
}

async function ingest(request, env) {
  if (!env.INGEST_TOKEN) return new Response("Not found", { status: 404 });
  if (!safeEqual(request.headers.get("x-ingest-token") || "", env.INGEST_TOKEN)) {
    return new Response("Forbidden", { status: 403 });
  }

  const githubToken = request.headers.get("x-github-token") || "";
  if (!githubToken) return new Response("Missing x-github-token", { status: 400 });

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Expected a JSON body", { status: 400 });
  }
  const key = String(body.key || "");
  const assetId = body.assetId;
  const expected = body.size;
  if (!validIngestKey(key)) return new Response(`Refusing key: ${key}`, { status: 400 });
  if (!Number.isInteger(assetId) || assetId <= 0) return new Response("assetId must be a positive integer", { status: 400 });

  // GitHub answers the asset api with a redirect to a signed storage url, and
  // forwarding the Authorization header on to that host is both unnecessary and
  // rejected by it. Follow the hop by hand so the credential stops here.
  const head = await fetch(`https://api.github.com/repos/${INGEST_REPO}/releases/assets/${assetId}`, {
    headers: {
      authorization: `Bearer ${githubToken}`,
      accept: "application/octet-stream",
      "user-agent": "crowe-releases-ingest",
    },
    redirect: "manual",
  });
  const location = head.headers.get("location");
  const source = location ? await fetch(location) : head;
  if (!source.ok || !source.body) {
    return new Response(`GitHub returned ${source.status} for asset ${assetId}`, { status: 502 });
  }

  const written = await env.RELEASES.put(key, source.body, {
    httpMetadata: { contentType: contentTypeFor(key, null) },
  });

  // A truncated copy is worse than a missing one: the feed would name it, the
  // updater would download it, and the signature check would fail on a user's
  // machine with nothing to point at. Refuse to leave a short object behind.
  if (Number.isInteger(expected) && written.size !== expected) {
    await env.RELEASES.delete(key);
    return new Response(`Wrote ${written.size} bytes, expected ${expected} - deleted`, { status: 502 });
  }

  return Response.json({ key, size: written.size, etag: written.httpEtag });
}

// Install counting. Nothing counted downloads until now: a Workers Analytics
// query for the account came back empty because no dataset was ever written.
// One data point goes to the crowe_releases dataset per installer or update
// feed request the bucket answered. HEADs and 404s never reach this, so probes
// and dead links are not installs. The shape is what the funnel report queries:
//   blobs    channel (stable or developers), platform (mac, win, linux),
//            artifact kind (dmg, zip, exe, appimage, deb, yml), the requested
//            path, the caller's country, and the response status as text.
//            electron-updater fetches a differential update as many 206 range
//            requests, so an install is a 200 and the 206s are traffic.
//   doubles  a count of one, then the bytes served.
//   index    the artifact kind, so the feed polls every launch makes cannot
//            sample the installer rows away.
// Blockmaps, SHA256SUMS and brand assets are served but not counted. A failed
// write must never cost anyone a download, so the binding is optional and the
// write is best effort.
const KINDS = [
  [/\.dmg$/i, "dmg", "mac"],
  [/\.zip$/i, "zip", "mac"],
  [/\.exe$/i, "exe", "win"],
  [/\.AppImage$/i, "appimage", "linux"],
  [/\.deb$/i, "deb", "linux"],
  [/\.yml$/i, "yml", null],
];

function artifactOf(path) {
  const hit = KINDS.find(([re]) => re.test(path));
  if (!hit) return null;
  const [, kind, platform] = hit;
  const dir = /\/channel\/(mac|win|linux)\//.exec(path);
  return { kind, platform: platform || (dir ? dir[1] : "") };
}

function channelOf(path) {
  return path.startsWith(`/${CHANNELS.developers.prefix}/`) ? "developers" : "stable";
}

function recordServe(env, request, path, status, bytes) {
  const artifact = artifactOf(path);
  if (!artifact || !env.crowe_releases || typeof env.crowe_releases.writeDataPoint !== "function") return;
  try {
    env.crowe_releases.writeDataPoint({
      indexes: [artifact.kind],
      blobs: [channelOf(path), artifact.platform, artifact.kind, path, (request.cf && request.cf.country) || "", String(status)],
      doubles: [1, Number.isFinite(bytes) ? bytes : 0],
    });
  } catch {
    // Counting is not serving.
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);

    if (path === "/_ingest" && request.method === "POST") return ingest(request, env);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    if (path === "/" || path === "/index.html") {
      const rel = await catalog(env);
      if (!rel) return new Response("No release published yet", { status: 503 });
      return new Response(request.method === "HEAD" ? null : renderPage(rel), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
      });
    }

    // Crowe Logic for Developers has a page of its own and, for the Azure
    // Marketplace listing to point at, stable links that resolve to the current
    // installer without the listing having to know the version: /developers/mac
    // is the Apple Silicon dmg, /developers/mac-intel the Intel one, and
    // /developers/windows, /developers/appimage and /developers/deb the rest. A
    // platform the release does not include is a 404, not a link to nothing.
    const dev = /^\/developers(?:\/(mac|mac-intel|windows|appimage|deb))?$/.exec(path);
    if (dev) {
      const rel = await catalog(env, "developers");
      if (!rel) return new Response("No developer release published yet", { status: 503 });
      if (!dev[1]) {
        return new Response(request.method === "HEAD" ? null : renderPage(rel, "developers"), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
        });
      }
      const file = rel[{ mac: "macos", "mac-intel": "macosIntel", windows: "windows", appimage: "appimage", deb: "deb" }[dev[1]]];
      if (!file) return new Response("Not in this release", { status: 404 });
      return Response.redirect(new URL(href("developers", rel.version, file), url).toString(), 302);
    }

    // The previous worker published /crowe-logic/<version>/<file> links with
    // hyphenated installer names that no longer match the R2 keys. Those URLs
    // are already out in the wild, so send them to the download page rather
    // than 404 someone holding an old link.
    if (path.startsWith("/crowe-logic/")) {
      return Response.redirect(new URL("/", url).toString(), 302);
    }

    if (path.startsWith("/desktop/") || path.startsWith("/brand/")) {
      const key = path.slice(1);
      // electron-updater asks for byte ranges when it applies a blockmap diff,
      // so serving the whole object with a 200 would defeat the differential
      // download the blockmaps exist for. Let R2 do the slicing.
      const range = request.headers.get("range") || undefined;
      const options = range ? { range: request.headers } : undefined;

      let object = await env.RELEASES.get(key, options);
      for (const alt of object ? [] : versionedKeysFor(key)) {
        object = await env.RELEASES.get(alt, options);
        if (object) break;
      }
      if (!object) return new Response("Not found", { status: 404 });

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("content-type", contentTypeFor(key, headers.get("content-type")));
      headers.set("etag", object.httpEtag);
      headers.set("cache-control", "public, max-age=3600");
      headers.set("accept-ranges", "bytes");

      let status = 200;
      if (object.range && range) {
        const offset = object.range.offset ?? 0;
        const length = object.range.length ?? object.size - offset;
        headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
        headers.set("content-length", String(length));
        status = 206;
      } else {
        headers.set("content-length", String(object.size));
      }

      if (request.method === "HEAD") { object.body?.cancel?.(); return new Response(null, { status, headers }); }
      recordServe(env, request, path, status, Number(headers.get("content-length")));
      return new Response(object.body, { status, headers });
    }

    return new Response("Not found", { status: 404 });
  },
};
