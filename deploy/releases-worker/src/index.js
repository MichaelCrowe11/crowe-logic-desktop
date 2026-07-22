// Crowe Logic release site: branded download page at "/", installer objects
// streamed from the crowe-releases R2 bucket under /desktop/* and /brand/*.
const VERSION = "0.5.1";

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Crowe Logic releases</title>
<meta name="description" content="Download the Crowe Logic desktop app for Windows, macOS, and Linux." />
<link rel="icon" href="/brand/mark.png" />
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
header img { width:28px; height:28px; }
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
footer { border-top:1px solid var(--line); padding:24px 0 40px; color:var(--dim); font-size:12.5px; }
footer .wrap { display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <img src="/brand/mark.png" alt="" />
    <span class="name">Crowe Logic</span>
    <span class="tag">releases</span>
  </div>
</header>
<main>
  <div class="wrap">
    <h1>Crowe Logic desktop</h1>
    <p class="sub">The operator for your workspace. Chat, a real terminal, reviewable edits, and an in-app browser, signed in with your Crowe ID.</p>
    <span class="ver">v${VERSION}</span>
    <div class="grid">
      <div class="card">
        <h2>Windows</h2>
        <span class="meta">64-bit installer</span>
        <p>Windows will warn about an unrecognized app. Choose More info, then Run anyway. The build is unsigned for now; that warning is expected.</p>
        <a class="btn" href="/desktop/${VERSION}/CroweLogic-Setup-${VERSION}.exe">Download for Windows</a>
      </div>
      <div class="card">
        <h2>macOS</h2>
        <span class="meta">Apple Silicon dmg</span>
        <p>Open the dmg and drag Crowe Logic to Applications. First launch: right-click the app and choose Open, then Open again. The build is signed but not yet notarized, so that step is expected once.</p>
        <a class="btn" href="/desktop/${VERSION}/CroweLogic-${VERSION}-arm64.dmg">Download for macOS</a>
      </div>
      <div class="card">
        <h2>Linux</h2>
        <span class="meta">x86_64 deb and AppImage</span>
        <p>The deb package is recommended for Ubuntu 22.04 and 24.04 and close derivatives.</p>
        <a class="btn" href="/desktop/${VERSION}/crowe-logic-desktop_${VERSION}_amd64.deb">Download .deb</a>
        <span class="alt"><a href="/desktop/${VERSION}/CroweLogic-${VERSION}-x86_64.AppImage">AppImage</a> &middot; <a href="/desktop/${VERSION}/INSTALL-linux.md">install guide</a></span>
      </div>
    </div>
    <div class="note">Linux install: <code>sudo apt install ./crowe-logic-desktop_${VERSION}_amd64.deb</code>. On Ubuntu 24.04, if the app does not start, run <code>crowe-logic-desktop --no-sandbox</code>. The install guide covers the details.</div>
    <section class="checks">
      <h3>Verify your download</h3>
      <p>With <a style="color:var(--gold)" href="/desktop/${VERSION}/SHA256SUMS">SHA256SUMS</a> in your download folder:</p>
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    if (path === "/" || path === "/index.html") {
      return new Response(request.method === "HEAD" ? null : PAGE, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
      });
    }

    if (path.startsWith("/desktop/") || path.startsWith("/brand/")) {
      const key = path.slice(1);
      const object = await env.RELEASES.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("content-type", contentTypeFor(key, headers.get("content-type")));
      headers.set("etag", object.httpEtag);
      headers.set("cache-control", "public, max-age=3600");
      headers.set("content-length", String(object.size));
      if (request.method === "HEAD") { object.body?.cancel?.(); return new Response(null, { headers }); }
      return new Response(object.body, { headers });
    }

    return new Response("Not found", { status: 404 });
  },
};
