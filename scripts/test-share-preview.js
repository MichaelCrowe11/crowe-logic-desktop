// Headless tests for share_preview: the tool that publishes a folder or a local
// port at a Cloudflare quick-tunnel link. Pure Node, no Electron, no network.
// cloudflared is a stub that prints what the real binary prints, so the URL
// parsing, the tier and approval gates, the file server's refusals, and the
// stop and quit paths are all driven end to end without a tunnel ever opening.
//
//   node scripts/test-share-preview.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const { EventEmitter } = require("events");
const H = require("../harness");
const S = require("../share-preview");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── Fixtures ────────────────────────────────────────────────────────────────
/* What cloudflared 2026.x writes to stderr for `tunnel --url`, timestamps and
   all. The first line carries two other https://...cloudflare.com URLs and the
   second names the host with no scheme; only the boxed one is the link. */
const LINK = "https://quiet-otter-lamp-basin.trycloudflare.com";
const BANNER = [
  "2026-09-14T00:40:12Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use (https://www.cloudflare.com/website-terms/), and Cloudflare reserves the right to investigate your use of Tunnels for violations of such terms. If you intend to use Tunnels in production you should use a pre-created named tunnel by following: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps",
  "2026-09-14T00:40:12Z INF Requesting new quick Tunnel on trycloudflare.com...",
  "2026-09-14T00:40:13Z INF +--------------------------------------------------------------------------------------------+",
  "2026-09-14T00:40:13Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
  `2026-09-14T00:40:13Z INF |  ${LINK}                                        |`,
  "2026-09-14T00:40:13Z INF +--------------------------------------------------------------------------------------------+",
  "2026-09-14T00:40:13Z INF Cannot determine default configuration path. No file [config.yml config.yaml] in [~/.cloudflared ~/.cloudflare-warp ~/cloudflare-warp /etc/cloudflared /usr/local/etc/cloudflared]",
  "2026-09-14T00:40:13Z INF Version 2026.6.1 (Checksum 1a2b3c)",
  "2026-09-14T00:40:13Z INF GOOS: darwin, GOVersion: go1.24.4, GoArch: arm64",
  "2026-09-14T00:40:13Z INF Settings: map[ha-connections:1 no-autoupdate:true protocol:quic url:http://127.0.0.1:54321]",
  "2026-09-14T00:40:13Z INF Generated Connector ID: 1c1c1c1c-2d2d-4e4e-8f8f-0a0a0a0a0a0a",
  "2026-09-14T00:40:13Z INF Initial protocol quic",
  "2026-09-14T00:40:14Z INF Registered tunnel connection connIndex=0 connection=9b9b9b9b-3c3c-4d4d-8e8e-1f1f1f1f1f1f event=0 ip=198.41.200.13 location=lax01 protocol=quic",
];

/* A cloudflared that never runs: an EventEmitter with the surface the code
   touches. Lines go out on stderr the way the real binary logs, one chunk per
   line unless the test hands over its own chunks. kill() records the signal
   and exits on the next tick, so the stop path can be checked for what was
   sent and in what order; ignoreTerm makes it sit through SIGTERM so the
   SIGKILL fallback has something to do. */
function fakeSpawn(lines, opts = {}) {
  const calls = [];
  const spawn = (bin, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.pid = 40000 + calls.length; child.signals = []; child.exited = false;
    child.kill = (sig) => {
      sig = sig || "SIGTERM";
      child.signals.push(sig);
      if (opts.ignoreTerm && sig === "SIGTERM") return true;
      if (!child.exited) { child.exited = true; setImmediate(() => child.emit("exit", null, sig)); }
      return true;
    };
    calls.push({ bin, args, options, child });
    const chunks = opts.chunks || lines.map((l) => l + "\n");
    setImmediate(() => { for (const c of chunks) if (!child.exited) child.stderr.emit("data", Buffer.from(c)); });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

/* A workspace with a built site in dist/ and the things a preview must never
   hand out: a dotfile, a .git folder, a source map, a credentials file, and a
   symlink that points outside the served tree. */
function site() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-preview-"));
  fs.mkdirSync(path.join(dir, "dist", "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "index.html"), "<!doctype html><h1>preview</h1>");
  fs.writeFileSync(path.join(dir, "dist", "assets", "app.js"), "console.log(1)");
  fs.writeFileSync(path.join(dir, "dist", "assets", "app.js.map"), "{}");
  fs.writeFileSync(path.join(dir, "dist", ".env"), "SECRET=shhh\n");
  fs.writeFileSync(path.join(dir, "dist", "credentials.json"), "{}");
  fs.mkdirSync(path.join(dir, "dist", ".git"));
  fs.writeFileSync(path.join(dir, "dist", ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(dir, "secret.txt"), "outside the served tree\n");
  fs.symlinkSync(path.join(dir, "secret.txt"), path.join(dir, "dist", "escape.txt"));
  return dir;
}
const FAST = { registerWaitMs: 150, urlTimeoutMs: 2000, stopGraceMs: 150, exitWaitMs: 150 };
function makeCtx(cfgPatch = {}, hooks = {}) {
  const dir = hooks.dir || site();
  let cwd = dir;
  const cfg = { autonomy: "execute", approvals: "high-risk", verifier: false, turnBudgetUsd: 0,
    autoApprove: true, model: "test-model", ...cfgPatch };
  const spawn = hooks.spawn || fakeSpawn(BANNER);
  const ctx = {
    dir, spawn, journalEvents: [], approvalsSeen: [],
    getCwd: () => cwd, setCwd: (p) => { cwd = p; },
    loadConfig: () => cfg,
    proposeEdit: async () => "applied edit", mcpTools: () => [], mcpCall: async () => "mcp result", openUrl: () => {},
    journal: (ev) => ctx.journalEvents.push(ev),
    artifactDir: () => path.join(dir, ".artifacts"),
    previewDeps: { cloudflared: "/fake/bin/cloudflared", spawn, ...FAST, ...(hooks.previewDeps || {}) },
  };
  if (hooks.approve !== undefined) {
    ctx.requestApproval = async (req) => { ctx.approvalsSeen.push(req); return { approved: hooks.approve }; };
  }
  return ctx;
}
const stateFor = (ctx) => ({ journal: (ev) => ctx.journalEvents.push(ev), agentId: "main" });
const run = (ctx, args, route) => H.execTool(ctx, "share_preview", args, route || null, stateFor(ctx));
const events = (ctx, type) => ctx.journalEvents.filter((e) => e.event_type === type);

function get(port, pathname, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method }, (res) => {
      let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => resolve({ status: res.statusCode, body, type: res.headers["content-type"] || "" }));
    });
    req.on("error", reject); req.end();
  });
}
// The raw request line, so a path Node's URL parser would tidy up reaches the server as written.
function raw(port, requestLine) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => s.write(`${requestLine} HTTP/1.1\r\nHost: preview\r\nConnection: close\r\n\r\n`));
    let out = ""; s.on("data", (c) => { out += c; }); s.on("end", () => resolve(out)); s.on("error", reject);
  });
}
function refused(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(true));
  });
}
const tick = () => new Promise((r) => setTimeout(r, 30));

// ─── URL parsing ─────────────────────────────────────────────────────────────
test("the quick-tunnel link is parsed out of cloudflared's banner and nothing else in it matches", () => {
  assert.strictEqual(S.parseTunnelUrl(BANNER.join("\n")), LINK);
  assert.strictEqual(S.parseTunnelUrl(BANNER[0]), null, "the terms and docs URLs are not the link");
  assert.strictEqual(S.parseTunnelUrl(BANNER[1]), null, "the bare host with no scheme is not the link");
  assert.strictEqual(S.parseTunnelUrl(BANNER[4]), LINK, "the boxed line alone is enough");
  assert.strictEqual(S.parseTunnelUrl(`\x1b[32mINF\x1b[0m |  \x1b[1m${LINK}\x1b[0m  |`), LINK, "colour codes are stripped first");
  assert.strictEqual(S.parseTunnelUrl(`see ${LINK}.`), LINK, "a sentence's full stop is not part of the host");
  assert.strictEqual(S.parseTunnelUrl("https://quiet-otter.trycloudflare.com.evil.example/"), null, "a lookalike suffix does not match as its own prefix");
  assert.strictEqual(S.parseTunnelUrl("http://quiet-otter.trycloudflare.com"), null, "plain http is not a tunnel link");
  assert.strictEqual(S.parseTunnelUrl(""), null);
  assert.strictEqual(S.parseTunnelUrl(null), null);
});

// ─── Finding the binary ──────────────────────────────────────────────────────
test("cloudflared is looked for on PATH and then in the Homebrew and /usr/local bins, skipping relative entries", () => {
  const env = { PATH: ["relative/bin", "", "/usr/bin", "/opt/homebrew/bin"].join(path.delimiter) };
  assert.deepStrictEqual(S.searchDirs(env, { platform: "darwin" }), ["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"]);
  const only = (want) => (p) => p === want;
  assert.strictEqual(S.findCloudflared({ env, platform: "darwin", executable: only("/opt/homebrew/bin/cloudflared") }), "/opt/homebrew/bin/cloudflared");
  assert.strictEqual(S.findCloudflared({ env: { PATH: "/usr/bin" }, platform: "darwin", executable: only("/usr/local/bin/cloudflared") }), "/usr/local/bin/cloudflared",
    "the extra bins are consulted even when PATH does not name them");
  assert.strictEqual(S.findCloudflared({ env: { PATH: "relative" }, platform: "darwin", executable: only("relative/cloudflared") }), null, "a relative PATH entry is never searched");
  assert.strictEqual(S.findCloudflared({ env, platform: "darwin", executable: () => false }), null);
  assert.strictEqual(S.findCloudflared({ env: { PATH: "C:\\tools" }, platform: "win32", executable: only(path.join("C:\\tools", "cloudflared.exe")) }), null,
    "on Windows the .exe is searched for under win32 path rules, which this host does not have");
  assert.match(S.installHint("darwin"), /brew install cloudflared/);
  assert.match(S.installHint("linux"), /developers\.cloudflare\.com/);
  assert.match(S.installHint("darwin"), /^error: cloudflared is not installed/);
});

// ─── The tool and its tier ───────────────────────────────────────────────────
test("share_preview is a built-in the operator is offered and the verifier is not, delivered as compensatable", () => {
  const ctx = makeCtx();
  const names = H.BUILTIN_TOOLS.map((t) => t.function.name);
  assert.ok(names.includes("share_preview"));
  const schema = H.BUILTIN_TOOLS.find((t) => t.function.name === "share_preview").function.parameters.properties;
  for (const k of ["dir", "port", "minutes", "stop", "id"]) assert.ok(schema[k], `schema declares ${k}`);
  assert.ok(H.allTools(ctx, null).some((t) => t.function.name === "share_preview"));
  assert.ok(!H.verifierTools(ctx).some((t) => t.function.name === "share_preview"));
  assert.strictEqual(H.deliveryOf(ctx, "share_preview", { dir: "dist" }), "compensatable");
});

test("share_preview is an Execute-tier action: edit, plan, and read-only block it before anything asks or spawns", async () => {
  for (const tier of ["edit", "plan", "readonly"]) {
    const ctx = makeCtx({ autonomy: tier }, { approve: true });
    const out = await run(ctx, { dir: "dist" });
    assert.match(out, /^blocked: share_preview exposes files or a local port to the internet/, tier);
    assert.match(out, /Execute/, tier);
    assert.strictEqual(ctx.approvalsSeen.length, 0, `${tier}: no card was drawn`);
    assert.strictEqual(ctx.spawn.calls.length, 0, `${tier}: nothing was spawned`);
    assert.strictEqual(S.listShares().length, 0);
  }
});

test("the verifier cannot publish", async () => {
  const ctx = makeCtx({}, { approve: true });
  const out = await run(ctx, { dir: "dist" }, { verify: true });
  assert.match(out, /^blocked: the verifier checks the work; it does not publish it\./);
  assert.strictEqual(ctx.approvalsSeen.length, 0);
});

test("in Execute it pauses for a strict approval card bound to the folder and the duration, and a denial starts nothing", async () => {
  const ctx = makeCtx({}, { approve: false });
  const out = await run(ctx, { dir: "dist", minutes: 45 });
  assert.match(out, /^blocked: the user DENIED this action/);
  assert.strictEqual(ctx.approvalsSeen.length, 1);
  const card = ctx.approvalsSeen[0];
  assert.strictEqual(card.kind, "share_preview");
  assert.strictEqual(card.risk, "strict");
  assert.strictEqual(card.title, "Share a preview publicly");
  assert.ok(card.detail.includes(fs.realpathSync(path.join(ctx.dir, "dist"))), "the card names the exact folder");
  assert.match(card.detail, /45 minutes/);
  assert.match(card.why, /^publishes .* at a public link with no sign-in/);
  assert.strictEqual(card.hash, H.inputHash("share_preview", { mode: "dir", dir: fs.realpathSync(path.join(ctx.dir, "dist")), listenPort: 0, minutes: 45 }),
    "the hash is bound to the plan, not to the raw arguments");
  assert.strictEqual(ctx.spawn.calls.length, 0);
  assert.strictEqual(S.listShares().length, 0);
  assert.strictEqual(events(ctx, "APPROVAL_DENIED").length, 1);
});

test("auto-approve does not extend to a public link: the card is still drawn", async () => {
  const ctx = makeCtx({ autoApprove: true, approvals: "high-risk" }, { approve: false });
  await run(ctx, { dir: "dist" });
  assert.strictEqual(ctx.approvalsSeen.length, 1);
  assert.strictEqual(ctx.approvalsSeen[0].risk, "strict");
});

test("a missing cloudflared returns the install instruction instead of a card or a silent failure", async () => {
  const ctx = makeCtx({}, { approve: true, previewDeps: { cloudflared: null, platform: "darwin" } });
  const out = await run(ctx, { dir: "dist" });
  assert.match(out, /brew install cloudflared/);
  assert.match(out, /No Cloudflare account is needed/);
  assert.strictEqual(ctx.approvalsSeen.length, 0, "nothing was asked for something that cannot run");
  assert.strictEqual(ctx.spawn.calls.length, 0);
});

test("bad arguments are refused before the card", async () => {
  const ctx = makeCtx({}, { approve: true });
  assert.match(await run(ctx, {}), /^error: pass dir .* or port/);
  assert.match(await run(ctx, { dir: "dist", minutes: 0 }), /^error: minutes must be a whole number from 1 to 720/);
  assert.match(await run(ctx, { dir: "dist", minutes: 100000 }), /^error: minutes must be/);
  assert.match(await run(ctx, { port: 70000 }), /^error: port must be a whole number from 1 to 65535/);
  assert.match(await run(ctx, { dir: "https://example.com" }), /^error: dir is a folder on this machine, not a URL/);
  assert.match(await run(ctx, { dir: "dist/index.html" }), /is a file, not a directory/);
  assert.match(await run(ctx, { dir: "nope" }), /^error: no such directory/);
  assert.strictEqual(ctx.approvalsSeen.length, 0);
});

test("the filesystem root, the home folder, and a folder that contains the workspace are refused", async () => {
  const ctx = makeCtx({}, { approve: true });
  assert.match(await run(ctx, { dir: "/" }), /^error: refusing to serve the filesystem root/);
  assert.match(await run(ctx, { dir: os.homedir() }), /^error: refusing to serve your home folder/);
  assert.match(await run(ctx, { dir: ".." }), /contains the whole workspace/);
  assert.strictEqual(ctx.approvalsSeen.length, 0);
});

// ─── The start path ──────────────────────────────────────────────────────────
test("an approved dir share serves the folder on loopback, spawns cloudflared at that port, and returns the link; stop takes it down", async () => {
  process.env.CROWE_TEST_API_TOKEN = "placeholder-not-a-real-value";
  process.env.TUNNEL_ORIGIN_CERT = "/nowhere/cert.pem";
  const ctx = makeCtx({}, { approve: true });
  try {
    const out = await run(ctx, { dir: "dist" });
    assert.match(out, new RegExp(`^preview live at ${LINK.replace(/\./g, "\\.")}\\n`), out);
    assert.match(out, /The tunnel is connected\./);
    assert.match(out, /stop: true and id "p\d+"/);
    assert.strictEqual(ctx.approvalsSeen.length, 1);

    const shares = S.listShares();
    assert.strictEqual(shares.length, 1);
    const [share] = shares;
    assert.strictEqual(share.state, "running");
    assert.strictEqual(share.mode, "dir");
    assert.strictEqual(share.url, LINK);
    assert.ok(Number.isInteger(share.port) && share.port > 0);

    // The child: the fixed argument list, aimed at the loopback port the server took.
    assert.strictEqual(ctx.spawn.calls.length, 1);
    const call = ctx.spawn.calls[0];
    assert.strictEqual(call.bin, "/fake/bin/cloudflared");
    assert.deepStrictEqual(call.args, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${share.port}`]);
    assert.deepStrictEqual(call.options.stdio, ["ignore", "pipe", "pipe"]);
    // Its environment: the harness's filtered shell env, minus cloudflared's own switches, plus the extra bins.
    assert.ok(!Object.hasOwn(call.options.env, "CROWE_TEST_API_TOKEN"), "token-shaped variables do not reach the child");
    assert.ok(!Object.hasOwn(call.options.env, "TUNNEL_ORIGIN_CERT"), "TUNNEL_* switches do not reach the child");
    assert.ok(call.options.env.PATH.split(path.delimiter).includes("/opt/homebrew/bin"));

    // The server: the site, and none of the things beside it.
    const port = share.port;
    const index = await get(port, "/");
    assert.strictEqual(index.status, 200); assert.match(index.body, /preview/); assert.match(index.type, /text\/html/);
    assert.strictEqual((await get(port, "/index.html")).status, 200);
    assert.strictEqual((await get(port, "/assets/app.js")).status, 200);
    assert.strictEqual((await get(port, "/assets")).status, 301, "a directory without a slash redirects");
    assert.strictEqual((await get(port, "/.env")).status, 404, "dotfiles are never served");
    assert.strictEqual((await get(port, "/.git/HEAD")).status, 404, "nothing under a dot folder either");
    assert.strictEqual((await get(port, "/assets/app.js.map")).status, 404, "source maps are never served");
    assert.strictEqual((await get(port, "/credentials.json")).status, 404, "the harness's secret-path rule applies to the served tree");
    assert.strictEqual((await get(port, "/escape.txt")).status, 404, "a symlink that leaves the tree is refused on what it points at");
    assert.strictEqual((await get(port, "/missing.html")).status, 404);
    assert.strictEqual((await get(port, "/", "POST")).status, 405);
    assert.match(await raw(port, "GET /../secret.txt"), /^HTTP\/1\.1 404/, "a dot-dot segment is refused, not normalised into a hit");
    assert.match(await raw(port, "GET /assets/%2e%2e/%2e%2e/secret.txt"), /^HTTP\/1\.1 404/);
    assert.match(await raw(port, "GET /assets%5c..%5c..%5csecret.txt"), /^HTTP\/1\.1 400/, "a backslash in the path is refused outright");
    const notFound = await get(port, "/missing.html");
    assert.ok(!notFound.body.includes(ctx.dir), "error bodies carry no local paths");

    assert.strictEqual(events(ctx, "PREVIEW_STARTED").length, 1);
    assert.match(events(ctx, "PREVIEW_STARTED")[0].output_summary, new RegExp(LINK.replace(/\./g, "\\.")));

    // Stop by id: SIGTERM to the child, the listener closed, the registry emptied.
    const stopped = await run(ctx, { stop: true, id: share.id });
    assert.match(stopped, new RegExp(`^stopped ${share.id} \\(${LINK.replace(/\./g, "\\.")}\\)\\nthe link no longer answers new visits\\.$`));
    assert.deepStrictEqual(call.child.signals, ["SIGTERM"]);
    assert.strictEqual(S.listShares().length, 0);
    assert.strictEqual(await refused(port), true, "the loopback server is gone with the tunnel");
    assert.strictEqual(events(ctx, "PREVIEW_STOPPED").length, 1);
    assert.strictEqual(ctx.approvalsSeen.length, 1, "stopping asks nothing");
  } finally {
    delete process.env.CROWE_TEST_API_TOKEN; delete process.env.TUNNEL_ORIGIN_CERT;
    await S.stopAll("test cleanup");
  }
});

test("stopping is allowed in every tier, because it only narrows exposure", async () => {
  const ctx = makeCtx({}, { approve: true });
  try {
    await run(ctx, { dir: "dist" });
    assert.strictEqual(S.listShares().length, 1);
    ctx.loadConfig().autonomy = "readonly";
    const out = await run(ctx, { stop: true });
    assert.match(out, /^stopped p\d+/);
    assert.strictEqual(S.listShares().length, 0);
  } finally { await S.stopAll("test cleanup"); }
});

test("stop with no id stops everything; an unknown id names what is running; nothing running says so", async () => {
  const ctx = makeCtx({}, { approve: true });
  try {
    assert.strictEqual(await run(ctx, { stop: true }), "no preview is running.");
    await run(ctx, { dir: "dist" });
    fs.mkdirSync(path.join(ctx.dir, "docs")); fs.writeFileSync(path.join(ctx.dir, "docs", "index.html"), "docs");
    await run(ctx, { dir: "docs" });
    assert.strictEqual(S.listShares().length, 2);
    const miss = await run(ctx, { stop: true, id: "nope" });
    assert.match(miss, /^error: no preview with id nope; running: p\d+ \(https:/);
    assert.strictEqual(S.listShares().length, 2);
    const all = await run(ctx, { stop: true });
    assert.strictEqual((all.match(/^stopped p\d+/gm) || []).length, 2);
    assert.strictEqual(S.listShares().length, 0);
    for (const c of ctx.spawn.calls) assert.deepStrictEqual(c.child.signals, ["SIGTERM"]);
  } finally { await S.stopAll("test cleanup"); }
});

test("quitting the app signals every tunnel before anything is awaited", async () => {
  const ctx = makeCtx({}, { approve: true });
  try {
    await run(ctx, { dir: "dist" });
    const { port } = S.listShares()[0];
    const pending = S.stopAll("the app is quitting");
    assert.deepStrictEqual(ctx.spawn.calls[0].child.signals, ["SIGTERM"], "sent synchronously, before the first await");
    assert.strictEqual(S.listShares().length, 0, "unlisted synchronously too");
    await pending;
    assert.strictEqual(await refused(port), true);
  } finally { await S.stopAll("test cleanup"); }
});

test("a child that ignores SIGTERM gets SIGKILL after the grace period", async () => {
  const ctx = makeCtx({}, { approve: true, spawn: fakeSpawn(BANNER, { ignoreTerm: true }) });
  try {
    await run(ctx, { dir: "dist" });
    const id = S.listShares()[0].id;
    const t0 = Date.now();
    await run(ctx, { stop: true, id });
    assert.deepStrictEqual(ctx.spawn.calls[0].child.signals, ["SIGTERM", "SIGKILL"]);
    assert.ok(Date.now() - t0 >= FAST.stopGraceMs - 5, "SIGKILL waited out the grace period");
  } finally { await S.stopAll("test cleanup"); }
});

test("a port share forwards a server that is already listening and refuses a port nobody is on", async () => {
  const upstream = http.createServer((_q, res) => res.end("upstream"));
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const port = upstream.address().port;
  const ctx = makeCtx({}, { approve: true });
  try {
    const out = await run(ctx, { port, minutes: 10 });
    assert.match(out, /^preview live at https:/);
    assert.match(out, new RegExp(`forwarding to the server on 127\\.0\\.0\\.1:${port}`));
    const card = ctx.approvalsSeen[0];
    assert.strictEqual(card.title, "Expose a local server publicly");
    assert.match(card.why, /^exposes the server on local port \d+ .* including routes that change data/);
    assert.match(card.detail, new RegExp(`^127\\.0\\.0\\.1:${port} -> https://<random>\\.trycloudflare\\.com for 10 minutes$`));
    assert.deepStrictEqual(ctx.spawn.calls[0].args.slice(-1), [`http://127.0.0.1:${port}`]);
    assert.strictEqual(S.listShares()[0].mode, "port");
    await run(ctx, { stop: true });
    assert.strictEqual(await refused(port), false, "stopping the share does not touch the user's own server");

    const dead = makeCtx({}, { approve: true, previewDeps: { portOpen: async () => false } });
    const miss = await run(dead, { port: 65000 });
    assert.match(miss, /^error: nothing is listening on 127\.0\.0\.1:65000/);
    assert.strictEqual(dead.approvalsSeen.length, 0, "no card for a port nobody is on");
  } finally {
    await S.stopAll("test cleanup");
    await new Promise((r) => upstream.close(r));
  }
});

test("a link split across two chunks is still found", async () => {
  const head = BANNER.slice(0, 4).join("\n") + "\n2026-09-14T00:40:13Z INF |  https://quiet-otter-";
  const tail = "lamp-basin.trycloudflare.com  |\n" + BANNER.slice(5).join("\n") + "\n";
  const ctx = makeCtx({}, { approve: true, spawn: fakeSpawn([], { chunks: [head, tail] }) });
  try {
    const out = await run(ctx, { dir: "dist" });
    assert.match(out, new RegExp(`^preview live at ${LINK.replace(/\./g, "\\.")}`));
  } finally { await S.stopAll("test cleanup"); }
});

test("a link that arrives without the registration line is returned with the caveat", async () => {
  const ctx = makeCtx({}, { approve: true, spawn: fakeSpawn(BANNER.slice(0, 6)) });
  try {
    const out = await run(ctx, { dir: "dist" });
    assert.match(out, /^preview live at https:/);
    assert.match(out, /has not confirmed its connection yet/);
    assert.strictEqual(S.listShares()[0].connected, false);
  } finally { await S.stopAll("test cleanup"); }
});

test("a cloudflared that never prints a link is killed and reported with its last lines, and the server it fronted is closed", async () => {
  const ctx = makeCtx({}, { approve: true,
    spawn: fakeSpawn(["2026-09-14T00:40:12Z INF Requesting new quick Tunnel on trycloudflare.com...", "2026-09-14T00:40:13Z ERR failed to request quick Tunnel error=\"dial tcp: lookup api.trycloudflare.com: no such host\""]),
    previewDeps: { urlTimeoutMs: 80 } });
  const out = await run(ctx, { dir: "dist" });
  assert.match(out, /^error: cloudflared did not print a tunnel URL within \ds/);
  assert.match(out, /cloudflared said:\n[\s\S]*no such host/);
  assert.deepStrictEqual(ctx.spawn.calls[0].child.signals, ["SIGTERM"]);
  assert.strictEqual(S.listShares().length, 0);
  assert.strictEqual(events(ctx, "PREVIEW_STARTED").length, 0);
});

test("a cloudflared that exits before printing a link is reported as such", async () => {
  const spawn = fakeSpawn([], { chunks: [] });
  const ctx = makeCtx({}, { approve: true, spawn });
  const pending = run(ctx, { dir: "dist" });
  await tick();
  const child = spawn.calls[0].child;
  child.exited = true; child.emit("exit", 1, null);
  const out = await pending;
  assert.match(out, /^error: cloudflared exited \(code 1\) before it printed a tunnel URL/);
  assert.strictEqual(S.listShares().length, 0);
});

test("a tunnel that dies on its own takes its file server down, leaves the registry, and is journaled", async () => {
  const ctx = makeCtx({}, { approve: true });
  try {
    await run(ctx, { dir: "dist" });
    const [{ port }] = S.listShares();
    const child = ctx.spawn.calls[0].child;
    child.exited = true; child.emit("exit", null, "SIGKILL");
    await tick(); await tick();
    assert.strictEqual(S.listShares().length, 0);
    assert.strictEqual(await refused(port), true);
    assert.strictEqual(events(ctx, "PREVIEW_ENDED").length, 1);
    assert.match(events(ctx, "PREVIEW_ENDED")[0].output_summary, /cloudflared exited \(signal SIGKILL\)/);
    assert.deepStrictEqual(child.signals, [], "nothing is signalled at a process that is already gone");
  } finally { await S.stopAll("test cleanup"); }
});

test("a preview expires on its own after the minutes it was approved for", async () => {
  const ctx = makeCtx({}, { approve: true, previewDeps: { minuteMs: 40 } });
  try {
    await run(ctx, { dir: "dist", minutes: 1 });
    assert.strictEqual(S.listShares().length, 1);
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(S.listShares().length, 0);
    assert.match(events(ctx, "PREVIEW_STOPPED")[0].output_summary, /expired after 1 minutes/);
  } finally { await S.stopAll("test cleanup"); }
});

test("the registry is capped, and the cap is reported with the ids to stop", async () => {
  const ctx = makeCtx({}, { approve: true });
  try {
    for (let i = 0; i < S.MAX_PREVIEWS; i++) {
      fs.mkdirSync(path.join(ctx.dir, `s${i}`)); fs.writeFileSync(path.join(ctx.dir, `s${i}`, "index.html"), String(i));
      assert.match(await run(ctx, { dir: `s${i}` }), /^preview live at/);
    }
    const out = await run(ctx, { dir: "dist" });
    assert.match(out, new RegExp(`^error: ${S.MAX_PREVIEWS} previews are already running \\(p\\d+`));
    assert.strictEqual(ctx.spawn.calls.length, S.MAX_PREVIEWS, "the fifth was never spawned");
  } finally { await S.stopAll("test cleanup"); }
});

test("the prompt tells the model what the tool is and that it asks first", () => {
  assert.match(H.TIER_LINES.execute, /share_preview/);
  assert.match(H.TIER_LINES.execute, /asks the user first every time/);
});

// ─── Runner ──────────────────────────────────────────────────────────────────
/* share-preview.js unrefs every timer it sets, so a tunnel's grace period or
   expiry never keeps the app alive on its own. Under plain Node that means a
   test waiting on one of those timers can be the only thing left in the loop,
   and the process exits with no summary and code 0. The interval is the handle
   that keeps the loop honest until the runner has spoken. */
(async () => {
  const keepAlive = setInterval(() => {}, 1000);
  let passed = 0;
  const failures = [];
  for (const t of tests) {
    try { await t.fn(); passed += 1; process.stdout.write("."); }
    catch (e) { failures.push({ name: t.name, e }); process.stdout.write("x"); }
    try { await S.stopAll("between tests"); } catch {}
  }
  process.stdout.write("\n");
  if (failures.length) {
    for (const f of failures) {
      console.error(`\nFAIL: ${f.name}`);
      console.error(String((f.e && f.e.stack) || f.e).split("\n").slice(0, 12).join("\n"));
    }
    console.error(`\n${passed} passed, ${failures.length} failed`);
    process.exit(1);
  }
  clearInterval(keepAlive);
  console.log(`share_preview: ${passed} tests passed`);
})();
