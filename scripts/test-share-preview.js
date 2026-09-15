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

/* What the real binary prints when a config file names a tunnel: it creates
   and routes a named tunnel on the account behind cert.pem and never prints
   a trycloudflare link. Representative lines, kept so the fixture's named
   path is recognisable in a failure's tail. */
const NAMED_TUNNEL_LINES = [
  "2026-09-14T00:40:12Z INF Tunnel credentials written to ~/.cloudflared/7a7a7a7a-1b1b-4c4c-8d8d-2e2e2e2e2e2e.json. Keep this file secret. To revoke these credentials, delete the tunnel.",
  "2026-09-14T00:40:12Z INF Created tunnel crowe-share-preview-regression-check with id 7a7a7a7a-1b1b-4c4c-8d8d-2e2e2e2e2e2e",
  "2026-09-14T00:40:13Z INF Registered tunnel connection connIndex=0 connection=9b9b9b9b-3c3c-4d4d-8e8e-1f1f1f1f1f1f event=0 ip=198.41.200.13 location=lax01 protocol=quic",
];

/* A cloudflared that never runs: an EventEmitter with the surface the code
   touches. Lines go out on stderr the way the real binary logs, one chunk per
   line unless the test hands over its own chunks. kill() records the signal
   and exits on the next tick, so the stop path can be checked for what was
   sent and in what order; ignoreTerm makes it sit through SIGTERM so the
   SIGKILL fallback has something to do.

   The one thing it does read is its config file, the way the binary does
   (cmd/cloudflared/tunnel/cmd.go, config/configuration.go): the --config
   argument when there is one, where a missing file is exit 1 before anything
   else; otherwise <home>/.cloudflared/config.yml when the test gave it a
   home. A config carrying name: takes the named-tunnel path, which is
   dispatched before the --url quick-tunnel branch and prints no link.
   configRead says which file it settled on. */
function fakeSpawn(lines, opts = {}) {
  const calls = [];
  const spawn = (bin, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.pid = 40000 + calls.length; child.signals = []; child.exited = false;
    // spawnError: the binary could not be started at all. Node then emits
    // error with no pid and no exit event.
    if (opts.spawnError) {
      child.pid = undefined;
      child.kill = (sig) => { child.signals.push(sig || "SIGTERM"); return false; };
      calls.push({ bin, args, options, child });
      setImmediate(() => child.emit("error", Object.assign(new Error(`spawn ${bin} EACCES`), { code: "EACCES" })));
      return child;
    }
    child.kill = (sig) => {
      sig = sig || "SIGTERM";
      child.signals.push(sig);
      if (opts.ignoreTerm && sig === "SIGTERM") return true;
      if (!child.exited) { child.exited = true; setImmediate(() => child.emit("exit", null, sig)); }
      return true;
    };
    const ci = args.indexOf("--config");
    const cfgPath = ci >= 0 ? args[ci + 1] : opts.home ? path.join(opts.home, ".cloudflared", "config.yml") : null;
    let cfg = null; if (cfgPath) { try { cfg = fs.readFileSync(cfgPath, "utf8"); } catch {} }
    child.configRead = cfg === null ? null : cfgPath;
    let chunks, exitCode;
    if (ci >= 0 && cfg === null) { chunks = [`open ${cfgPath}: no such file or directory\n`]; exitCode = 1; }
    else if (cfg !== null && /^name:\s*\S/m.test(cfg)) chunks = NAMED_TUNNEL_LINES.map((l) => l + "\n");
    else chunks = opts.chunks || lines.map((l) => l + "\n");
    calls.push({ bin, args, options, child });
    setImmediate(() => {
      for (const c of chunks) if (!child.exited) child.stderr.emit("data", Buffer.from(c));
      if (exitCode !== undefined && !child.exited) { child.exited = true; child.emit("exit", exitCode, null); }
    });
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

    // The child: the fixed argument list, aimed at the loopback port the server
    // took, with cloudflared pinned to a config this module wrote rather than
    // whatever ~/.cloudflared/config.yml says.
    assert.strictEqual(ctx.spawn.calls.length, 1);
    const call = ctx.spawn.calls[0];
    assert.strictEqual(call.bin, "/fake/bin/cloudflared");
    assert.deepStrictEqual(call.args.slice(0, 2), ["tunnel", "--config"]);
    const cfg = call.args[2];
    assert.deepStrictEqual(call.args.slice(3), ["--no-autoupdate", "--url", `http://127.0.0.1:${share.port}`]);
    assert.ok(path.isAbsolute(cfg) && fs.statSync(cfg).isFile(), "the pinned config exists when the child starts");
    if (process.platform !== "win32") assert.strictEqual(fs.statSync(cfg).mode & 0o777, 0o600, "readable by this user only");
    assert.strictEqual(fs.readFileSync(cfg, "utf8"), S.PINNED_CONFIG);
    assert.deepStrictEqual(S.PINNED_CONFIG.split("\n").filter((l) => l && !l.startsWith("#")), ["{}"],
      "an empty mapping and nothing else: no name, no tunnel, no credentials-file, no ingress");
    for (const d of ["~/.cloudflared", "~/.cloudflare-warp", "~/cloudflare-warp", "/etc/cloudflared", "/usr/local/etc/cloudflared"]) {
      const abs = d.replace(/^~/, os.homedir());
      assert.ok(cfg !== path.join(abs, "config.yml") && !cfg.startsWith(abs + path.sep), `the pinned config is not under cloudflared's default search dir ${d}`);
    }
    assert.strictEqual(call.child.configRead, cfg, "what the child read as its config is that file");
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
    assert.match(await raw(port, "GET /../secret.txt"), /^HTTP\/1\.1 404/, "a dot-dot segment is refused");
    assert.match(await raw(port, "GET /assets/%2e%2e/%2e%2e/secret.txt"), /^HTTP\/1\.1 404/);
    // Those two are 404 either way, since dist/secret.txt does not exist. These
    // tell refusal from resolution: a URL parser folds the dot segments and
    // serves index.html; the server refuses the path as it was sent.
    assert.match(await raw(port, "GET /assets/../index.html"), /^HTTP\/1\.1 404/, "a dot-dot segment is refused even when following it would land in the tree");
    assert.match(await raw(port, "GET /assets/%2e%2e/index.html"), /^HTTP\/1\.1 404/, "and so is its percent-encoded spelling");
    assert.match(await raw(port, "GET /./index.html"), /^HTTP\/1\.1 404/, "a single-dot segment likewise");
    assert.match(await raw(port, "GET http://preview.invalid/index.html"), /^HTTP\/1\.1 400/, "an absolute-form target is for a proxy, not this server");
    assert.match(await raw(port, "GET /index.html?v=1"), /^HTTP\/1\.1 200/, "the query string is not part of the path");
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
    assert.strictEqual(fs.existsSync(cfg), false, "the pinned config goes with the last preview, not only at quit");
    assert.strictEqual(fs.existsSync(path.dirname(cfg)), false);
  } finally {
    delete process.env.CROWE_TEST_API_TOKEN; delete process.env.TUNNEL_ORIGIN_CERT;
    await S.stopAll("test cleanup");
  }
});

test("a folder replaced while the card is open is checked again before anything is served", async () => {
  // The card named the resolved dist/. While it was open, dist/ became a
  // symlink to the home folder. "Still a directory" would pass; the start
  // re-resolves the path and requires the folder the card named.
  const ctx = makeCtx();
  const dist = path.join(ctx.dir, "dist");
  const named = fs.realpathSync(dist);
  ctx.requestApproval = async (req) => {
    ctx.approvalsSeen.push(req);
    fs.renameSync(dist, dist + ".moved");
    fs.symlinkSync(os.homedir(), dist);
    return { approved: true };
  };
  try {
    const out = await run(ctx, { dir: "dist" });
    assert.match(out, new RegExp(`^error: ${named.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} now leads to .*not the folder the card named; nothing was published`), out);
    assert.strictEqual(ctx.approvalsSeen.length, 1);
    assert.strictEqual(ctx.spawn.calls.length, 0, "no tunnel was spawned");
    assert.strictEqual(S.listShares().length, 0);
    assert.strictEqual(events(ctx, "PREVIEW_STARTED").length, 0);
    // A fresh card, drawn for the folder as it now is, is honoured: the
    // refusal was about the swap, not the path.
    fs.unlinkSync(dist); fs.mkdirSync(dist); fs.writeFileSync(path.join(dist, "index.html"), "other");
    ctx.requestApproval = async (req) => { ctx.approvalsSeen.push(req); return { approved: true }; };
    const again = await run(ctx, { dir: "dist" });
    assert.match(again, /^preview live at/, again);
    assert.strictEqual(ctx.approvalsSeen.length, 2);
  } finally { await S.stopAll("test cleanup"); }
});

test("a different folder at the same path, made while the card was open, is refused by its identity and not only its name", async () => {
  // rm -rf dist && mkdir dist between the card and the yes: the same real
  // path, still a directory, so the path check alone would pass and the file
  // server would publish a folder the card never named. The start compares
  // the directory's device and inode with what planShare recorded.
  const ctx = makeCtx();
  const dist = path.join(ctx.dir, "dist");
  const named = fs.realpathSync(dist);
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  ctx.requestApproval = async (req) => {
    ctx.approvalsSeen.push(req);
    fs.renameSync(dist, dist + ".moved");
    fs.mkdirSync(dist); fs.writeFileSync(path.join(dist, "index.html"), "another folder");
    return { approved: true };
  };
  try {
    const out = await run(ctx, { dir: "dist" });
    assert.match(out, new RegExp(`^error: ${esc(named)} was replaced while the card was open.*nothing was published`), out);
    assert.strictEqual(ctx.approvalsSeen.length, 1);
    assert.strictEqual(ctx.spawn.calls.length, 0, "no tunnel was spawned");
    assert.strictEqual(S.listShares().length, 0);
    assert.strictEqual(events(ctx, "PREVIEW_STARTED").length, 0);
    // The plan carries the identity as exact decimal strings from a bigint
    // stat, not as a Number that would round a large inode, and not in the
    // key the card was hashed on, which describes what the user saw.
    const plan = await S.planShare(ctx, { dir: "dist" }, ctx.previewDeps);
    const st = fs.statSync(dist, { bigint: true });
    assert.deepStrictEqual([plan.dev, plan.ino], [String(st.dev), String(st.ino)]);
    assert.deepStrictEqual(Object.keys(plan.key).sort(), ["dir", "listenPort", "minutes", "mode"]);
    // A platform or mount that reports no inode is identity unavailable, not a
    // swap: the path check stands alone and the share goes ahead.
    const blind = await S.startShare(ctx, stateFor(ctx), { ...plan, dev: "0", ino: "0" }, { ...ctx.previewDeps });
    assert.match(blind, /^preview live at/, blind);
    // A fresh card, drawn for the folder as it now is, is honoured.
    ctx.requestApproval = async (req) => { ctx.approvalsSeen.push(req); return { approved: true }; };
    const again = await run(ctx, { dir: "dist" });
    assert.match(again, /^preview live at/, again);
    assert.strictEqual(ctx.approvalsSeen.length, 2);
  } finally { await S.stopAll("test cleanup"); }
});

test("two starts racing for the last slot cannot both take it", async () => {
  const upstream = http.createServer((_q, res) => res.end("upstream"));
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const port = upstream.address().port;
  // A slow port probe, so both starts pass the capacity check before either
  // has claimed a slot; the check is repeated after the await.
  const ctx = makeCtx({}, { approve: true, previewDeps: { maxPreviews: 1, portOpen: () => new Promise((r) => setTimeout(() => r(true), 40)) } });
  try {
    const outs = await Promise.all([run(ctx, { port }), run(ctx, { port })]);
    assert.strictEqual(outs.filter((o) => /^preview live at/.test(o)).length, 1, outs.join("\n---\n"));
    assert.strictEqual(outs.filter((o) => /^error: 1 previews are already running \(p\d+\)/.test(o)).length, 1, outs.join("\n---\n"));
    assert.strictEqual(ctx.spawn.calls.length, 1, "the loser was never spawned");
    assert.strictEqual(S.listShares().length, 1);
  } finally {
    await S.stopAll("test cleanup");
    await new Promise((r) => upstream.close(r));
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
    const cfg = ctx.spawn.calls[0].args[2];
    assert.ok(fs.existsSync(cfg));
    const pending = S.stopAll("the app is quitting");
    assert.deepStrictEqual(ctx.spawn.calls[0].child.signals, ["SIGTERM"], "sent synchronously, before the first await");
    assert.strictEqual(S.listShares().length, 0, "unlisted synchronously too");
    await pending;
    assert.strictEqual(await refused(port), true);
    assert.strictEqual(fs.existsSync(cfg), false, "the pinned config is removed once nothing is running");
    assert.strictEqual(fs.existsSync(path.dirname(cfg)), false);
  } finally { await S.stopAll("test cleanup"); }
});

test("the quit hold: nothing running means no hold, a running child is waited for through SIGKILL, and a stop already winding down is joined", async () => {
  assert.strictEqual(S.stopAllForQuit("the app is quitting"), null, "with nothing running the app quits as it always did");
  const spawn = fakeSpawn(BANNER, { ignoreTerm: true });
  const ctx = makeCtx({}, { approve: true, spawn });
  try {
    await run(ctx, { dir: "dist" });
    await run(ctx, { dir: "dist" });
    const [a, b] = spawn.calls.map((c) => c.child);
    const ports = S.listShares().map((e) => e.port);
    // b was stopped a moment before the quit: out of the registry already, its
    // child still sitting through the grace period.
    const early = run(ctx, { stop: true, id: S.listShares()[1].id });
    await tick();
    assert.deepStrictEqual(b.signals, ["SIGTERM"]);
    assert.strictEqual(S.listShares().length, 1);
    const t0 = Date.now();
    const hold = S.stopAllForQuit("the app is quitting");
    assert.ok(hold && typeof hold.then === "function", "something is running, so there is a hold");
    assert.deepStrictEqual(a.signals, ["SIGTERM"], "signalled before the first await, as before");
    assert.strictEqual(S.listShares().length, 0);
    await hold;
    assert.deepStrictEqual(a.signals, ["SIGTERM", "SIGKILL"], "the hold lasted through the grace period and the SIGKILL");
    assert.deepStrictEqual(b.signals, ["SIGTERM", "SIGKILL"], "and joined the stop that was already winding down");
    assert.ok(Date.now() - t0 >= FAST.stopGraceMs - 5, "the grace period was waited out");
    for (const p of ports) assert.strictEqual(await refused(p), true);
    await early;
    assert.strictEqual(S.stopAllForQuit("the app is quitting"), null, "and afterwards there is nothing left to hold for");
  } finally { await S.stopAll("test cleanup"); }
});

test("the quit hold is bounded: a teardown that does not settle releases the quit after holdMs", async () => {
  // The listener's close() takes far longer than the bound (a stand-in for
  // anything in the teardown that hangs); the hold gives up at holdMs and the
  // app quits, with the teardown left to finish in the background.
  const slowClose = async (root, o) => {
    const s = await S.createStaticServer(root, o);
    return { ...s, close: () => { s.close(); return new Promise((r) => { const t = setTimeout(r, 1500); if (t.unref) t.unref(); }); } };
  };
  const ctx = makeCtx({}, { approve: true, previewDeps: { createStaticServer: slowClose } });
  try {
    await run(ctx, { dir: "dist" });
    const child = ctx.spawn.calls[0].child;
    const t0 = Date.now();
    const hold = S.stopAllForQuit("the app is quitting", 120);
    assert.ok(hold, "there is a hold");
    await hold;
    const took = Date.now() - t0;
    assert.ok(took >= 110 && took < 1000, `released by the bound, not the teardown: ${took} ms`);
    assert.deepStrictEqual(child.signals, ["SIGTERM"], "the child had left on SIGTERM; only the listener was slow");
    assert.strictEqual(S.listShares().length, 0);
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

test("an ambient ~/.cloudflared/config.yml carrying name: does not turn the quick tunnel into a named one", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-preview-home-"));
  fs.mkdirSync(path.join(home, ".cloudflared"));
  const ambient = path.join(home, ".cloudflared", "config.yml");
  fs.writeFileSync(ambient, "name: crowe-share-preview-regression-check\n");
  const spawn = fakeSpawn(BANNER, { home });
  const ctx = makeCtx({}, { approve: true, spawn });
  process.env.TUNNEL_NAME = "crowe-share-preview-regression-check";
  try {
    // First, that the fixture bites: the same cloudflared with no --config
    // reads the ambient file and runs a named tunnel, which prints no link.
    const loose = spawn("/fake/bin/cloudflared", ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:1"], {});
    let said = ""; loose.stderr.on("data", (c) => { said += c; });
    await tick();
    assert.strictEqual(loose.configRead, ambient);
    assert.match(said, /Created tunnel crowe-share-preview-regression-check/);
    assert.strictEqual(S.parseTunnelUrl(said), null, "a named tunnel prints no trycloudflare link");
    // Then, that the tool's own spawn never gets there.
    const out = await run(ctx, { dir: "dist" });
    assert.match(out, new RegExp(`^preview live at ${LINK.replace(/\./g, "\\.")}`), out);
    const call = ctx.spawn.calls[1];
    const cfg = call.args[call.args.indexOf("--config") + 1];
    assert.ok(cfg && cfg !== ambient, "--config names the module's file, not the ambient one");
    assert.strictEqual(call.child.configRead, cfg);
    assert.doesNotMatch(fs.readFileSync(cfg, "utf8"), /^name:/m);
    assert.ok(!Object.hasOwn(call.options.env, "TUNNEL_NAME"), "the flag's environment alias does not reach the child either");
  } finally {
    delete process.env.TUNNEL_NAME;
    await S.stopAll("test cleanup");
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the app's own sign-in callback ports are refused in both modes, before any card, and match main.js", async () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const m = /const PORTS = \[([0-9, ]+)\];/.exec(src);
  assert.ok(m, "main.js declares the sign-in callback ports as `const PORTS = [...]`");
  assert.deepStrictEqual(m[1].split(",").map((x) => Number(x.trim())), S.OWN_LOOPBACK_PORTS);
  const ctx = makeCtx({}, { approve: true, previewDeps: { portOpen: async () => true } });
  for (const port of S.OWN_LOOPBACK_PORTS) {
    assert.match(await run(ctx, { port }), /^error: refusing port \d+: it is the app's own sign-in callback port/);
    assert.match(await run(ctx, { dir: "dist", port }), /^error: refusing port \d+/);
  }
  assert.strictEqual(ctx.approvalsSeen.length, 0);
  assert.strictEqual(ctx.spawn.calls.length, 0);
});

test("main.js holds the quit for the teardown: the first quit is cancelled while a preview is up and asked for again when the hold settles", () => {
  // main.js cannot run here, so this reads the wiring. shutdownNativeResources
  // must hand the hold back, before-quit must cancel only when there is one
  // and quit again when it settles, and will-quit must still sweep.
  const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(src, /function shutdownNativeResources\(\) \{[\s\S]{0,700}?return require\("\.\/share-preview"\)\.stopAllForQuit\("the app is quitting"\)/,
    "shutdownNativeResources returns the hold from stopAllForQuit");
  const m = /app\.on\("before-quit", \(event\) => \{([\s\S]*?)\n\}\);/.exec(src);
  assert.ok(m, "before-quit has a handler that sees the event");
  const body = m[1];
  assert.match(body, /const pending = shutdownNativeResources\(\);\s*\n\s*if \(!pending\) return;/, "no preview, no hold");
  assert.match(body, /event\.preventDefault\(\)/, "the first quit is cancelled");
  assert.match(body, /app\.quit\(\)/, "and asked for again once the hold settles");
  assert.match(body, /quitPhase === "draining"\) \{ event\.preventDefault\(\); return; \}/, "a quit during the wait is held too");
  assert.match(src, /app\.on\("will-quit", \(\) => \{ shutdownNativeResources\(\);/, "will-quit still sweeps synchronously");
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

test("a failed start whose child ignores SIGTERM still gets SIGKILL, because the child is on the entry before the link arrives", async () => {
  const ctx = makeCtx({}, { approve: true,
    spawn: fakeSpawn(["2026-09-14T00:40:12Z INF Requesting new quick Tunnel on trycloudflare.com..."], { ignoreTerm: true }),
    previewDeps: { urlTimeoutMs: 80 } });
  const t0 = Date.now();
  const out = await run(ctx, { dir: "dist" });
  assert.match(out, /^error: cloudflared did not print a tunnel URL within \ds/);
  assert.deepStrictEqual(ctx.spawn.calls[0].child.signals, ["SIGTERM", "SIGKILL"], "the failure path escalates the way a stop does");
  assert.ok(Date.now() - t0 >= 80 + FAST.stopGraceMs - 10, "SIGKILL waited out the grace period");
  assert.strictEqual(S.listShares().length, 0);
});

test("startTunnel on its own escalates to SIGKILL when a failed start's SIGTERM is ignored", async () => {
  const spawn = fakeSpawn([], { chunks: [], ignoreTerm: true });
  await assert.rejects(S.startTunnel({ bin: "/fake/bin/cloudflared", port: 1, spawn, env: {}, urlTimeoutMs: 50, stopGraceMs: 60 }), /did not print a tunnel URL/);
  const child = spawn.calls[0].child;
  assert.deepStrictEqual(child.signals, ["SIGTERM"]);
  await new Promise((r) => setTimeout(r, 130));
  assert.deepStrictEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("quitting while a tunnel is still starting signals the child at once and the start reports the stop", async () => {
  const spawn = fakeSpawn([], { chunks: [] });
  const ctx = makeCtx({}, { approve: true, spawn, previewDeps: { urlTimeoutMs: 5000 } });
  try {
    const pending = run(ctx, { dir: "dist" });
    await tick();
    assert.strictEqual(S.listShares()[0].state, "starting");
    const child = spawn.calls[0].child;
    const quit = S.stopAll("the app is quitting");
    assert.deepStrictEqual(child.signals, ["SIGTERM"], "the child is known to the registry before the link arrives");
    assert.strictEqual(S.listShares().length, 0);
    await quit;
    const out = await pending;
    assert.match(out, /^error: the preview was stopped while it was starting \(the app is quitting\); nothing was published/);
    assert.deepStrictEqual(child.signals, ["SIGTERM"], "the failure path did not signal it a second time");
    assert.strictEqual(events(ctx, "PREVIEW_STARTED").length, 0);
    assert.strictEqual(events(ctx, "PREVIEW_ENDED").length, 0, "a stop is not an unexpected exit");
  } finally { await S.stopAll("test cleanup"); }
});

test("quitting while the listener is still binding spawns nothing, and the listener is closed", async () => {
  // The server takes a while to bind; the quit lands in that window, when the
  // entry has neither a server nor a child. The start must notice on its way
  // out rather than spawn a cloudflared that no registry entry names.
  let release; const gate = new Promise((r) => { release = r; });
  let made = null;
  const slow = async (root, o) => { await gate; made = await S.createStaticServer(root, o); return made; };
  const ctx = makeCtx({}, { approve: true, previewDeps: { createStaticServer: slow } });
  try {
    const pending = run(ctx, { dir: "dist" });
    await tick();
    assert.strictEqual(S.listShares()[0].state, "starting");
    const quit = S.stopAll("the app is quitting");
    assert.strictEqual(S.listShares().length, 0);
    await quit;
    release();
    const out = await pending;
    assert.match(out, /^error: the preview was stopped while it was starting \(the app is quitting\); nothing was published/);
    assert.strictEqual(ctx.spawn.calls.length, 0, "nothing was spawned after the stop");
    assert.ok(made, "the listener did bind, late");
    assert.strictEqual(await refused(made.port), true, "and was closed on the way out");
    assert.strictEqual(S.listShares().length, 0);
  } finally { await S.stopAll("test cleanup"); }
});

test("a failure that lands while a stop is already in flight does not signal the child a second time", async () => {
  // The child ignores SIGTERM and never prints a link. The stop's grace clock
  // and the start's URL timeout both run; the start must join the stop, not
  // start its own SIGTERM-then-SIGKILL alongside it.
  const spawn = fakeSpawn(["2026-09-14T00:40:12Z INF Requesting new quick Tunnel on trycloudflare.com..."], { ignoreTerm: true });
  const ctx = makeCtx({}, { approve: true, spawn, previewDeps: { urlTimeoutMs: 60, stopGraceMs: 150 } });
  try {
    const pending = run(ctx, { dir: "dist" });
    await tick();
    const child = spawn.calls[0].child;
    const stop = run(ctx, { stop: true });
    await tick();
    assert.deepStrictEqual(child.signals, ["SIGTERM"]);
    const [out] = await Promise.all([pending, stop]);
    assert.match(out, /^error: the preview was stopped while it was starting \(stopped by the agent\); nothing was published/);
    assert.deepStrictEqual(child.signals, ["SIGTERM", "SIGKILL"], "one SIGTERM, one SIGKILL, in that order");
    assert.strictEqual(S.listShares().length, 0);
  } finally { await S.stopAll("test cleanup"); }
});

test("a cloudflared that cannot be started at all is reported at once, without waiting out a grace period", async () => {
  const ctx = makeCtx({}, { approve: true, spawn: fakeSpawn([], { spawnError: true }) });
  const t0 = Date.now();
  const out = await run(ctx, { dir: "dist" });
  assert.match(out, /^error: cloudflared could not be started: spawn .* EACCES/);
  assert.ok(Date.now() - t0 < FAST.stopGraceMs, "no grace period was waited for a process that never existed");
  assert.deepStrictEqual(ctx.spawn.calls[0].child.signals, [], "nothing is signalled at a process that never started");
  assert.strictEqual(S.listShares().length, 0);
});

test("a cloudflared that prints the link and then exits before registering says so, not that it never printed one", async () => {
  const spawn = fakeSpawn(BANNER.slice(0, 6), { ignoreTerm: false });
  const ctx = makeCtx({}, { approve: true, spawn, previewDeps: { registerWaitMs: 5000 } });
  const pending = run(ctx, { dir: "dist" });
  await tick();
  const child = spawn.calls[0].child;
  child.exited = true; child.emit("exit", 2, null);
  const out = await pending;
  assert.match(out, new RegExp(`^error: cloudflared exited \\(code 2\\) after printing ${LINK.replace(/\./g, "\\.")}, before the tunnel registered`), out);
  assert.strictEqual(S.listShares().length, 0);
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

test("the prompt tells the model what the tool is and that it asks first, without promising a card in a mode that draws none", () => {
  assert.match(H.TIER_LINES.execute, /share_preview/);
  assert.match(H.TIER_LINES.execute, /asks the user first in every mode that asks/);
  const fn = H.BUILTIN_TOOLS.find((t) => t.function.name === "share_preview").function;
  assert.match(fn.description, /approval in every mode that asks/);
  assert.doesNotMatch(fn.description, /every time/, "approvals: off skips the card, so the description does not claim one");
  assert.match(fn.parameters.properties.dir.description, /build output, not at the workspace/);
  assert.match(fn.parameters.properties.dir.description, /files written after approval are published too/);
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
