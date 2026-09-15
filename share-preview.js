// Crowe Logic desktop - share_preview. A temporary public link to something the
// agent just built, the way a hosted preview works, without an account: a folder
// (or a local server that is already running) is exposed through a Cloudflare
// quick tunnel, and the https://<random>.trycloudflare.com address cloudflared
// prints is handed back to the agent.
//
// Pure Node, no Electron imports, so the whole path - argument checks, the file
// server, the child process, the registry - runs headlessly with the spawn
// stubbed. harness.js owns the policy (which tier may start one, the approval
// card, the journal); this file owns the mechanics.
//
// What this is not: a boundary against a hostile filesystem. It is a preview of
// files the agent wrote, shown to whoever the user sends the link. The guards
// here close the mistakes that are cheap to close and expensive to make: a
// dotfile, a credentials file, or a source map under the served tree is never
// sent; a symlink that leaves the tree is refused; the filesystem root, the home
// folder, and any folder that contains the workspace cannot be served; a port is
// only forwarded if something is listening on it; and every tunnel this process
// started is stopped when it quits, when its time runs out, or when the agent
// asks. Stopping ends new visits. It cannot take back what was already read.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const { spawn: nodeSpawn } = require("child_process");

const URL_TIMEOUT_MS = 30000;        // how long cloudflared gets to print a URL
const REGISTER_WAIT_MS = 6000;       // after the URL, how long to wait for "Registered tunnel connection"
const STOP_GRACE_MS = 3000;          // SIGTERM to SIGKILL
const EXIT_WAIT_MS = 2000;           // after SIGKILL, how long to wait for the exit event
const PORT_PROBE_MS = 1000;
const MAX_PREVIEWS = 4;
const DEFAULT_MINUTES = 120;
const MAX_MINUTES = 720;
const LOG_LINES = 40;                // the ring buffer of cloudflared's own log, for error messages
const SCAN_TAIL_CHARS = 8192;        // a URL split across two chunks still matches in here
const MAX_PATH_CHARS = 2048;
// Where Homebrew and manual installs land on macOS. A packaged app launched
// from Finder inherits the login shell's PATH only partially, so these are
// consulted after PATH rather than instead of it.
const EXTRA_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
// The app's own sign-in callback listener (main.js, signIn: `const PORTS`).
// Forwarding it would publish the OAuth redirect to the internet for no
// reason anyone has; scripts/test-share-preview.js holds the two in step.
const OWN_LOOPBACK_PORTS = [8765, 9275];
const TUNNEL_HOST = ".trycloudflare.com";
/* Only a quick-tunnel host. cloudflared's first log line carries two other
   https://...cloudflare.com URLs (terms of use, the docs) and the line before
   the banner says "trycloudflare.com" with no scheme; none of those may match.
   The lookahead stops "x.trycloudflare.com.attacker.example" from matching as
   its own prefix, while still allowing a sentence's trailing full stop. */
const TUNNEL_URL_RE = /https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com(?![A-Za-z0-9-]|\.[A-Za-z0-9])/;
const REGISTERED_RE = /Registered tunnel connection/;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// ─── cloudflared's output ────────────────────────────────────────────────────
function parseTunnelUrl(text) {
  const m = TUNNEL_URL_RE.exec(String(text || "").replace(ANSI_RE, ""));
  if (!m) return null;
  try {
    const u = new URL(m[0]);
    if (u.protocol !== "https:" || !u.hostname.endsWith(TUNNEL_HOST) || u.port || u.username || u.password || u.search || u.hash) return null;
    return u.origin;
  } catch { return null; }
}

// ─── Finding the binary ──────────────────────────────────────────────────────
/* PATH entries that are empty or relative would resolve against whatever the
   current directory happens to be, which for an agent is the workspace it was
   handed. They are skipped rather than searched. */
function searchDirs(env = process.env, { platform = process.platform, extraDirs } = {}) {
  const extra = extraDirs || (platform === "win32" ? [] : EXTRA_BIN_DIRS);
  const seen = new Set(); const out = [];
  for (const d of [...String((env && env.PATH) || "").split(path.delimiter), ...extra]) {
    if (!d || !path.isAbsolute(d) || seen.has(d)) continue;
    seen.add(d); out.push(d);
  }
  return out;
}
function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}
// The bare binary only: no .cmd or shell wrapper, which would put a shell back
// between the fixed argument list and the process.
function findCloudflared({ env = process.env, platform = process.platform, extraDirs, executable = isExecutable } = {}) {
  const names = platform === "win32" ? ["cloudflared.exe"] : ["cloudflared"];
  for (const dir of searchDirs(env, { platform, extraDirs })) {
    for (const n of names) { const p = path.join(dir, n); if (executable(p)) return p; }
  }
  return null;
}
function installHint(platform = process.platform) {
  const how = platform === "darwin"
    ? "Install it with `brew install cloudflared`"
    : "Install it from Cloudflare's downloads page, developers.cloudflare.com/cloudflare-one/connections/connect-apps/downloads";
  return `error: cloudflared is not installed, so there is no way to open a public tunnel from this machine. ${how}, then call share_preview again. No Cloudflare account is needed for a quick tunnel.`;
}
/* The child's environment: the harness's filtered shell environment, minus
   cloudflared's own TUNNEL_* switches so a stray variable cannot redirect or
   reconfigure the tunnel, plus the extra bin directories on PATH. */
function childEnv(base) {
  const env = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (/^TUNNEL_|^NO_AUTOUPDATE$/i.test(k) || typeof v !== "string") continue;
    env[k] = v;
  }
  env.PATH = searchDirs(base || {}).join(path.delimiter);
  return env;
}

// ─── The file server ─────────────────────────────────────────────────────────
const TYPES = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".pdf": "application/pdf", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json",
};
// Never served, whatever the request asked for: any dot segment (.git, .env,
// .DS_Store) and source maps, whose sourcesContent is the unbuilt source.
const HIDDEN_RE = /(^|\/)\.[^/]/;
function neverServed(relPosix) { return HIDDEN_RE.test(relPosix) || /\.map$/i.test(relPosix); }

/* One pipeline from request path to open file descriptor. The path is decoded
   once, refused if it carries a NUL or a backslash, split into segments that are
   each checked before anything is joined (so ".." is refused, not normalised
   away), then the file it names is resolved through symlinks and checked again:
   it has to sit under the real root, and its real relative path has to pass
   the same name rules, so a link called public.txt pointing at .env is refused
   on what it points at. The descriptor is what gets streamed, and fstat on it
   decides that it is an ordinary file. */
function resolveRequest(rootReal, encodedPath, refuse, platform = process.platform) {
  if (encodedPath.length > MAX_PATH_CHARS) return { status: 414 };
  let decoded; try { decoded = decodeURIComponent(encodedPath); } catch { return { status: 400 }; }
  if (/[\0\\]/.test(decoded) || (platform === "win32" && /[:*?"<>|]/.test(decoded))) return { status: 400 };
  const segs = decoded.split("/").filter(Boolean);
  for (const s of segs) {
    if (s === "." || s === ".." || s.startsWith(".")) return { status: 404 };
    if (platform === "win32" && /[. ]$/.test(s)) return { status: 404 };
  }
  const joined = path.join(rootReal, ...segs);
  let st; try { st = fs.statSync(joined); } catch { return { status: 404 }; }
  let target = joined;
  if (st.isDirectory()) {
    if (!encodedPath.endsWith("/")) return { status: 301, location: encodedPath + "/" };
    target = path.join(joined, "index.html");
  }
  let real; try { real = fs.realpathSync(target); } catch { return { status: 404 }; }
  const rel = path.relative(rootReal, real);
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return { status: 404 };
  const relPosix = rel.split(path.sep).join("/");
  if (neverServed(relPosix) || (typeof refuse === "function" && refuse(relPosix))) return { status: 404 };
  let fd; try { fd = fs.openSync(real, "r"); } catch { return { status: 404 }; }
  let fst; try { fst = fs.fstatSync(fd); } catch { try { fs.closeSync(fd); } catch {} return { status: 404 }; }
  if (!fst.isFile()) { try { fs.closeSync(fd); } catch {} return { status: 404 }; }
  return { status: 200, fd, size: fst.size, type: TYPES[path.extname(real).toLowerCase()] || "application/octet-stream" };
}
function plain(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
const REASONS = { 400: "bad request", 404: "not found", 405: "method not allowed", 414: "path too long" };
/* Loopback only; the tunnel is the only way in from outside. Error bodies carry
   no local paths. close() destroys open sockets as well as the listener,
   because server.close() alone lets an in-flight download finish after the
   user has said stop. */
function createStaticServer(root, { port = 0, refuse, platform } = {}) {
  const rootReal = fs.realpathSync(root);
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const method = req.method || "GET";
    if (method !== "GET" && method !== "HEAD") { res.setHeader("Allow", "GET, HEAD"); return plain(res, 405, REASONS[405]); }
    let pathname; try { pathname = new URL(req.url || "/", "http://preview.invalid").pathname; } catch { return plain(res, 400, REASONS[400]); }
    const r = resolveRequest(rootReal, pathname, refuse, platform);
    if (r.status === 301) { res.writeHead(301, { Location: r.location }); return res.end(); }
    if (r.status !== 200) return plain(res, r.status, REASONS[r.status] || REASONS[400]);
    res.writeHead(200, { "Content-Type": r.type, "Content-Length": r.size });
    if (method === "HEAD") { fs.close(r.fd, () => {}); return res.end(); }
    const stream = fs.createReadStream(null, { fd: r.fd, autoClose: true });
    stream.on("error", () => { try { res.destroy(); } catch {} });
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 200;
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      server.on("error", () => {});
      resolve({
        server, root: rootReal, port: server.address().port,
        close: () => new Promise((done) => {
          server.close(() => done());
          for (const s of sockets) { try { s.destroy(); } catch {} }
          if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        }),
      });
    });
  });
}

// ─── cloudflared's config file ───────────────────────────────────────────────
/* cloudflared reads a YAML config file before it decides what kind of tunnel
   to run, and with no --config it reads ~/.cloudflared/config.yml when one
   exists. A `name:` in that file is dispatched before the --url quick-tunnel
   branch (cmd/cloudflared/tunnel/cmd.go, TunnelCommand, read from master and
   the 2026.6.1 tag), so an ambient config would turn the approved account-less
   quick tunnel into a named tunnel created and routed on the user's own
   Cloudflare account with their origin certificate, an effect no card covered
   and one that killing the child does not undo. The child is therefore always
   pointed at a config this module wrote: an empty mapping in a private temp
   directory, checked before every spawn. Two facts about cloudflared make this
   a pin and not a preference: an explicitly named file that is missing is a
   hard exit, not a fall back to the default path, so a lost file fails the
   share rather than widening it; and `{}` parses as a real empty config,
   where a zero-byte file is logged as "Configuration file ... was empty" at
   ERR and leaves the config source unset. Both were run against 2026.6.1. */
const PINNED_CONFIG = [
  "# Written by Crowe Logic desktop before each share_preview tunnel.",
  "# Empty on purpose: cloudflared reads this file instead of ~/.cloudflared/config.yml,",
  "# so a name: there cannot turn the quick tunnel into a named tunnel on the user's account.",
  "{}",
  "",
].join("\n");
let pinnedDir = null;
function pinnedConfigPath() {
  let st = null; try { st = pinnedDir && fs.statSync(pinnedDir); } catch {}
  if (!st || !st.isDirectory()) pinnedDir = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-preview-cloudflared-"));
  const file = path.join(pinnedDir, "config.yml");
  let have = null; try { have = fs.readFileSync(file, "utf8"); } catch {}
  if (have !== PINNED_CONFIG) fs.writeFileSync(file, PINNED_CONFIG, { mode: 0o600 });
  return file;
}
function removePinnedConfig() {
  if (!pinnedDir) return;
  try { fs.rmSync(pinnedDir, { recursive: true, force: true }); } catch {}
  pinnedDir = null;
}

// ─── The tunnel process ──────────────────────────────────────────────────────
/* Resolves once cloudflared has printed a quick-tunnel URL, then waits a little
   longer for "Registered tunnel connection", which is the point the link starts
   answering; `connected` says which of the two happened. Rejects if the process
   exits or errors first, or prints nothing usable in time, and in every failure
   the child is killed and the last log lines travel with the error. The log
   handlers stay attached after success so a later failure has context too.

   onSpawn, when given, receives the child and its exit promise the moment it
   exists, before any of that waiting: the caller then owns the child's
   shutdown, so a stop that arrives while the link is still pending signals a
   process the registry knows about, and a failed start is torn down with the
   same bounded SIGTERM-then-SIGKILL as a running one. Without onSpawn the
   failure path does that escalation itself, over stopGraceMs. */
function startTunnel({ bin, port, spawn = nodeSpawn, env, urlTimeoutMs = URL_TIMEOUT_MS, registerWaitMs = REGISTER_WAIT_MS, stopGraceMs = STOP_GRACE_MS, onSpawn = null }) {
  return new Promise((resolve, reject) => {
    let configFile;
    try { configFile = pinnedConfigPath(); }
    catch (e) { return reject(new Error(`could not write the config file cloudflared is pinned to: ${String((e && e.message) || e)}`)); }
    const args = ["tunnel", "--config", configFile, "--no-autoupdate", "--url", `http://127.0.0.1:${port}`];
    let proc;
    try { proc = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
    catch (e) { return reject(new Error(`could not start cloudflared: ${String((e && e.message) || e)}`)); }
    const lines = [];
    let tail = "", partial = "", url = null, registered = false, settled = false, gone = false;
    let urlTimer = null, regTimer = null;
    let exitResolve; const exited = new Promise((r) => { exitResolve = r; });
    const clear = () => { if (urlTimer) clearTimeout(urlTimer); if (regTimer) clearTimeout(regTimer); urlTimer = regTimer = null; };
    const logs = () => lines.slice();
    const fail = (msg) => {
      if (settled) return; settled = true; clear();
      if (!onSpawn && !gone) {
        try { proc.kill("SIGTERM"); } catch {}
        const t = setTimeout(() => { if (!gone) { try { proc.kill("SIGKILL"); } catch {} } }, stopGraceMs);
        if (t.unref) t.unref();
      }
      const last = lines.slice(-6).filter(Boolean).join("\n");
      reject(new Error(msg + (last ? `\ncloudflared said:\n${last}` : "")));
    };
    const finish = () => {
      if (settled) return; settled = true; clear();
      resolve({ proc, url, connected: registered, logs, exited });
    };
    const onData = (chunk) => {
      const s = String(chunk).replace(ANSI_RE, "");
      tail = (tail + s).slice(-SCAN_TAIL_CHARS);
      partial += s;
      const parts = partial.split("\n"); partial = parts.pop();
      for (const l of parts) { lines.push(l.trimEnd()); if (lines.length > LOG_LINES) lines.shift(); }
      if (settled) return;
      if (!url) {
        url = parseTunnelUrl(tail);
        if (url) {
          if (urlTimer) { clearTimeout(urlTimer); urlTimer = null; }
          regTimer = setTimeout(finish, registerWaitMs);
          if (regTimer.unref) regTimer.unref();
        }
      }
      if (url && !registered && REGISTERED_RE.test(tail)) { registered = true; finish(); }
    };
    if (proc.stdout) proc.stdout.on("data", onData);
    if (proc.stderr) proc.stderr.on("data", onData);
    proc.on("error", (e) => {
      lines.push(`process error: ${String((e && e.message) || e)}`);
      // A spawn that never happened (no pid) emits error and no exit, so the
      // owner would otherwise wait out both grace periods for nothing.
      if (!proc.pid && !gone) { gone = true; exitResolve({ code: null, signal: null }); }
      fail(`cloudflared could not be started: ${String((e && e.message) || e)}`);
    });
    proc.on("exit", (code, signal) => {
      gone = true;
      exitResolve({ code, signal });
      const how = signal ? `signal ${signal}` : `code ${code}`;
      fail(url ? `cloudflared exited (${how}) after printing ${url}, before the tunnel registered`
               : `cloudflared exited (${how}) before it printed a tunnel URL`);
    });
    if (onSpawn) onSpawn(proc, exited);
    urlTimer = setTimeout(() => fail(`cloudflared did not print a tunnel URL within ${Math.round(urlTimeoutMs / 1000)}s`), urlTimeoutMs);
    if (urlTimer.unref) urlTimer.unref();
  });
}

// ─── Arguments ───────────────────────────────────────────────────────────────
function intArg(v) {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string" && /^\s*\d{1,6}\s*$/.test(v)) return Number(v.trim());
  return null;
}
function resolveDir(ctx, p) {
  p = String(p).replace(/^~(?=$|\/)/, os.homedir());
  return path.isAbsolute(p) ? p : path.join(ctx.getCwd(), p);
}
function safeReal(p) { try { return fs.realpathSync(p); } catch { return path.resolve(String(p)); } }
function isUnder(child, parent) { return child !== parent && child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep); }
/* Serving the root or the home folder is never a preview. A folder that contains
   the workspace is the same mistake one level up: everything the user opened,
   plus whatever sits beside it. The workspace itself is allowed, with the card
   saying so, because a small site is often exactly the folder that was opened. */
function refuseDir(real, ctx) {
  if (real === path.parse(real).root) return "refusing to serve the filesystem root";
  const home = safeReal(os.homedir());
  if (real === home) return "refusing to serve your home folder";
  if (isUnder(home, real)) return `refusing to serve ${real}: it contains your home folder`;
  const cwd = safeReal(ctx.getCwd());
  if (isUnder(cwd, real)) return `refusing to serve ${real}: it contains the whole workspace and everything beside it; pass the folder that holds the site`;
  return null;
}
function portOpen(port, ms = PORT_PROBE_MS) {
  return new Promise((resolve) => {
    let s;
    try { s = net.connect({ host: "127.0.0.1", port }); } catch { return resolve(false); }
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(ms, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}
function withDefaults(over) {
  return {
    spawn: nodeSpawn, env: process.env, platform: process.platform, portOpen, refuse: null, cloudflared: null, createStaticServer,
    urlTimeoutMs: URL_TIMEOUT_MS, registerWaitMs: REGISTER_WAIT_MS, stopGraceMs: STOP_GRACE_MS, exitWaitMs: EXIT_WAIT_MS,
    minuteMs: 60000, maxPreviews: MAX_PREVIEWS,
    ...(over || {}),
  };
}
/* Turns the model's arguments into a plan the gate can show and the start can
   run, or an error. Strict on shape: a port is a whole number in range (as a
   number or a string of digits), a dir is a path and not a URL, and one of the
   two has to be present. The plan carries the exact words for the approval card
   and a normalised key for its hash, so the approval is bound to this folder or
   this port, for this long, and to nothing else. */
async function planShare(ctx, args, over) {
  const deps = withDefaults(over);
  const a = args && typeof args === "object" ? args : {};
  const minutes = a.minutes === undefined || a.minutes === null ? DEFAULT_MINUTES : intArg(a.minutes);
  if (minutes === null || minutes < 1 || minutes > MAX_MINUTES) return { error: `minutes must be a whole number from 1 to ${MAX_MINUTES}` };
  const hasPort = a.port !== undefined && a.port !== null && a.port !== "";
  const port = hasPort ? intArg(a.port) : null;
  if (hasPort && (port === null || port < 1 || port > 65535)) return { error: "port must be a whole number from 1 to 65535" };
  if (hasPort && OWN_LOOPBACK_PORTS.includes(port)) return { error: `refusing port ${port}: it is the app's own sign-in callback port (${OWN_LOOPBACK_PORTS.join(" and ")} are reserved for that); pick another port` };
  const hasDir = a.dir !== undefined && a.dir !== null && a.dir !== "";
  if (hasDir) {
    if (typeof a.dir !== "string" || /\0/.test(a.dir)) return { error: "dir must be a path" };
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a.dir)) return { error: "dir is a folder on this machine, not a URL; to expose a server that is already running, pass its port instead" };
    const abs = resolveDir(ctx, a.dir);
    let st; try { st = fs.statSync(abs); } catch { return { error: `no such directory: ${abs}` }; }
    if (!st.isDirectory()) return { error: `${abs} is a file, not a directory; pass the folder that holds the site` };
    const real = fs.realpathSync(abs);
    const refused = refuseDir(real, ctx);
    if (refused) return { error: refused };
    const whole = real === safeReal(ctx.getCwd());
    return {
      mode: "dir", dir: real, listenPort: port || 0, minutes, wholeWorkspace: whole,
      title: "Share a preview publicly",
      why: `publishes ${real}${whole ? " (the whole workspace)" : ""} at a public link with no sign-in: anyone who has the link can read every file under it, including files added later, until it is stopped or ${minutes} minutes pass`,
      detail: `${real} -> https://<random>.trycloudflare.com for ${minutes} minutes${port ? ` (served on 127.0.0.1:${port})` : ""}`,
      key: { mode: "dir", dir: real, listenPort: port || 0, minutes },
    };
  }
  if (port === null) return { error: "pass dir (a folder to serve) or port (a local server that is already running)" };
  if (!(await deps.portOpen(port))) return { error: `nothing is listening on 127.0.0.1:${port}; start the server first, or pass dir to serve a folder instead` };
  return {
    mode: "port", port, minutes,
    title: "Expose a local server publicly",
    why: `exposes the server on local port ${port} at a public link with no sign-in: anyone who has the link can reach every route it serves, including routes that change data, until it is stopped or ${minutes} minutes pass`,
    detail: `127.0.0.1:${port} -> https://<random>.trycloudflare.com for ${minutes} minutes`,
    key: { mode: "port", port, minutes },
  };
}

// ─── The registry ────────────────────────────────────────────────────────────
/* Process-wide, because a tunnel is a process resource and not a turn's: the
   turn that opened it ends, the link stays up, and the app's quit path has to
   find it. Entries go in before anything is spawned and come out on every
   failure path, so nothing that is running is ever unlisted. */
const previews = new Map();
let seq = 0;

function listShares() {
  return [...previews.values()].map((e) => ({
    id: e.id, state: e.state, mode: e.mode, dir: e.dir, port: e.port, url: e.url,
    connected: e.connected, startedAt: e.startedAt, expiresAt: e.expiresAt, agentId: e.agentId,
  }));
}
function raceExit(entry, ms) {
  if (entry.exited || !entry.exitPromise) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    if (t.unref) t.unref();
    entry.exitPromise.then(() => { clearTimeout(t); resolve(true); });
  });
}
/* The signal goes out synchronously, before the first await, so the app's own
   quit handler - which cannot wait - still gets every child told. Then a bounded
   wait, SIGKILL if that was ignored, and the listener and its open sockets are
   torn down alongside. */
async function teardown(entry, deps) {
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
  const proc = entry.proc;
  if (proc && !entry.exited) { try { proc.kill("SIGTERM"); } catch {} }
  const srv = entry.server; entry.server = null;
  const closing = srv ? srv.close() : Promise.resolve();
  previews.delete(entry.id);
  // The last preview out takes the pinned config with it. cloudflared read the
  // file at boot and never again (no watcher in TunnelCommand), so a child
  // still winding down does not miss it, and the next spawn writes it afresh.
  if (!previews.size) removePinnedConfig();
  if (proc && !entry.exited) {
    if (!(await raceExit(entry, deps.stopGraceMs))) {
      try { proc.kill("SIGKILL"); } catch {}
      await raceExit(entry, deps.exitWaitMs);
    }
  }
  await closing;
}
function stopPreview(entry, reason, deps) {
  if (entry.stopping) return entry.stopping;
  entry.state = "stopping";
  entry.stopReason = reason;
  entry.stopping = teardown(entry, deps).then(() => ({ id: entry.id, url: entry.url, reason }));
  return entry.stopping;
}
function stopAll(reason) {
  const deps = withDefaults();
  return Promise.all([...previews.values()].map((e) => stopPreview(e, reason || "the app is quitting", deps)))
    // teardown already removed the file with the last entry; this sweeps the
    // case where startTunnel was used on its own and nothing was registered.
    .then((r) => { if (!previews.size) removePinnedConfig(); return r; });
}

function successText(e) {
  const what = e.mode === "dir" ? `serving ${e.dir} from 127.0.0.1:${e.port}` : `forwarding to the server on 127.0.0.1:${e.port}`;
  const live = e.connected
    ? "The tunnel is connected."
    : "The tunnel has not confirmed its connection yet, so the link may take a few seconds to answer.";
  return [
    `preview live at ${e.url}`,
    `${what}. ${live}`,
    `No sign-in is needed: anyone who has the link can open it${e.mode === "dir" ? ", and later changes to those files show up there too" : ""}. ` +
      `It stops after ${e.minutes} minutes, when the app quits, or when you call share_preview with stop: true and id "${e.id}". ` +
      "Stopping ends new visits; it cannot take back anything already downloaded.",
  ].join("\n");
}
/* Runs an approved plan. The checks that decided the approval are made again
   here, because the folder or the listener can change while the card is open,
   and the answer is bound to what is there now. For a folder that means the
   same resolved path the card named and the same refusals, not only "still a
   directory": a symlink dropped in its place while the card was open would
   otherwise be followed by the file server to wherever it points. */
async function startShare(ctx, state, plan, over) {
  const deps = withDefaults(over);
  const now = (ev) => { try { if (state && state.journal) state.journal(ev); else if (ctx && ctx.journal) ctx.journal(ev); } catch {} };
  const later = (ev) => { try { if (ctx && ctx.journal) ctx.journal(ev); } catch {} };
  const full = () => `error: ${previews.size} previews are already running (${[...previews.keys()].join(", ")}); stop one with share_preview {stop: true, id} before starting another`;
  if (previews.size >= deps.maxPreviews) return full();
  if (!deps.cloudflared) return installHint(deps.platform);
  if (plan.mode === "dir") {
    let real = null; try { if (fs.statSync(plan.dir).isDirectory()) real = fs.realpathSync(plan.dir); } catch {}
    if (!real) return `error: ${plan.dir} is no longer a directory`;
    if (real !== plan.dir) return `error: ${plan.dir} now leads to ${real}, which is not the folder the card named; nothing was published. Ask again with the folder you mean`;
    const refused = refuseDir(real, ctx);
    if (refused) return `error: ${refused}`;
  } else if (!(await deps.portOpen(plan.port))) {
    return `error: nothing is listening on 127.0.0.1:${plan.port} any more`;
  }
  // The port probe awaited, and another start in this process may have taken
  // the last slot meanwhile; the slot is claimed on the line after this check.
  if (previews.size >= deps.maxPreviews) return full();
  const entry = {
    id: `p${++seq}`, state: "starting", mode: plan.mode, dir: plan.dir || null, port: plan.port || null,
    url: null, proc: null, server: null, exited: false, exitPromise: null, connected: false, logs: () => [],
    minutes: plan.minutes, startedAt: Date.now(), expiresAt: null, timer: null, stopping: null,
    agentId: (state && state.agentId) || "main",
  };
  previews.set(entry.id, entry);
  try {
    if (plan.mode === "dir") {
      let srv;
      try { srv = await deps.createStaticServer(plan.dir, { port: plan.listenPort, refuse: deps.refuse, platform: deps.platform }); }
      catch (e) {
        throw new Error(e && e.code === "EADDRINUSE"
          ? `port ${plan.listenPort} is already in use; to expose the server that is running there, call share_preview with port only and no dir`
          : `could not start the file server: ${String((e && e.message) || e)}`);
      }
      entry.server = srv; entry.port = srv.port;
      // A stop that landed while the listener was binding found no server and
      // no child; nothing is spawned for an entry that is already unlisted.
      if (entry.state === "stopping") throw new Error("the preview was stopped while it was starting");
    }
    const tun = await startTunnel({ bin: deps.cloudflared, port: entry.port, spawn: deps.spawn, env: childEnv(deps.env),
      urlTimeoutMs: deps.urlTimeoutMs, registerWaitMs: deps.registerWaitMs, stopGraceMs: deps.stopGraceMs,
      /* The child is on the entry from the moment it exists, so a stop that
         lands while the link is pending signals it at once, and a start that
         fails is torn down below with the same SIGTERM-then-SIGKILL as a
         running preview. */
      onSpawn: (proc, exited) => {
        entry.proc = proc; entry.exitPromise = exited;
        exited.then((x) => {
          entry.exited = true;
          // Starting: startTunnel rejects and the catch below tears down.
          // Stopping: teardown is already under way. Running: the child went
          // away on its own (network, a crash, a kill from outside); the
          // listener behind it is closed too, so nothing keeps serving to a
          // tunnel that no longer exists, and the registry says so.
          if (entry.state !== "running") return;
          later({ event_type: "PREVIEW_ENDED", tool_id: "share_preview", output_summary: `${entry.id} ${entry.url || ""}: cloudflared exited (${x && x.signal ? `signal ${x.signal}` : `code ${x && x.code}`})` });
          stopPreview(entry, "the tunnel process exited", deps);
        });
      },
    });
    entry.url = tun.url; entry.connected = tun.connected; entry.logs = tun.logs;
    if (entry.state === "stopping") throw new Error("the preview was stopped while it was starting");
    entry.state = "running";
    const ttl = plan.minutes * deps.minuteMs;
    entry.expiresAt = entry.startedAt + ttl;
    entry.timer = setTimeout(() => {
      stopPreview(entry, "expired", deps).then(() =>
        later({ event_type: "PREVIEW_STOPPED", tool_id: "share_preview", output_summary: `${entry.id} ${entry.url}: expired after ${plan.minutes} minutes` }));
    }, ttl);
    if (entry.timer.unref) entry.timer.unref();
    /* The link is the only credential an unauthenticated preview has. It goes
       to the local journal, which stays on this machine, and back to the
       model, which the user asked for. It is not diagnostic text: nothing
       here or downstream may forward it into shared telemetry. */
    now({ event_type: "PREVIEW_STARTED", tool_id: "share_preview",
      output_summary: `${entry.id} ${plan.mode === "dir" ? plan.dir : `port ${plan.port}`} -> ${entry.url}${entry.connected ? "" : " (not yet connected)"}, ${plan.minutes} min` });
    return successText(entry);
  } catch (e) {
    // A stop already in flight owns the child's shutdown; wait for it rather
    // than signalling the same process twice with two escalation clocks. The
    // teardown after it only picks up what was acquired since (a listener
    // that bound after the stop looked), and finds nothing else to do.
    if (entry.stopping) { try { await entry.stopping; } catch {} }
    await teardown(entry, deps);
    if (entry.stopReason) return `error: the preview was stopped while it was starting (${entry.stopReason}); nothing was published`;
    return `error: ${String((e && e.message) || e)}`;
  }
}
/* Stop by exact id, or everything this process started when no id is given.
   Never a process the agent did not start through this tool: the registry is
   the only thing consulted. */
async function stopShares(ctx, state, args, over) {
  const deps = withDefaults(over);
  const now = (ev) => { try { if (state && state.journal) state.journal(ev); else if (ctx && ctx.journal) ctx.journal(ev); } catch {} };
  const id = args && args.id !== undefined && args.id !== null && args.id !== "" ? String(args.id) : null;
  if (!previews.size) return "no preview is running.";
  const targets = id ? [previews.get(id)].filter(Boolean) : [...previews.values()];
  if (!targets.length)
    return `error: no preview with id ${id}; running: ${[...previews.values()].map((e) => `${e.id} (${e.url || "starting"})`).join(", ")}`;
  const out = [];
  for (const e of targets) {
    const r = await stopPreview(e, "stopped by the agent", deps);
    now({ event_type: "PREVIEW_STOPPED", tool_id: "share_preview", output_summary: `${r.id} ${r.url || ""}: ${r.reason}` });
    out.push(`stopped ${r.id}${r.url ? ` (${r.url})` : ""}`);
  }
  return out.join("\n") + "\nthe link no longer answers new visits.";
}

module.exports = {
  parseTunnelUrl, findCloudflared, searchDirs, isExecutable, installHint, childEnv,
  createStaticServer, resolveRequest, neverServed, startTunnel, portOpen, pinnedConfigPath,
  planShare, startShare, stopShares, stopAll, listShares,
  TUNNEL_URL_RE, MAX_PREVIEWS, DEFAULT_MINUTES, MAX_MINUTES, EXTRA_BIN_DIRS, OWN_LOOPBACK_PORTS, PINNED_CONFIG,
};
