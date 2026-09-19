// Headless tests for the cloud browser tools: harness.js driving
// browser-client.js against a fake Crowe Browser (node http, actions only).
// Pure Node, no Electron, no network beyond the loopback.
//
//   node scripts/test-browser-tools.js
//
// What is asserted is the contract in crowe-browser/docs/API.md as the desktop
// keeps it: one session per turn owner, created on the first browser tool and
// reused across turns; a session the server ended (410) replaced once, with a
// read retried on the restored page and an act refused until a fresh read;
// reads at any tier and acts at Execute only; a `browser` event after every
// action carrying the thumbnail and the live view address; and the model's
// tool results carrying neither.
"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const H = require("../harness");
const { CroweBrowserClient, BrowserSessions, BrowserError, normalizeBaseUrl } = require("../browser-client");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── The fake service ────────────────────────────────────────────────────────
const THUMB = "data:image/jpeg;base64,VEhVTUI=";       // "THUMB", never a real frame
const SHOT = "data:image/jpeg;base64,U0hPVA==";        // "SHOT"
const KEY = "svc_test_key_do_not_print";
function fakeServer() {
  const sessions = new Map();   // id -> { id, token, url, title, ended, owner }
  const calls = [];             // { method, path, auth, body }
  let n = 0;
  const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const err = (res, status, code, message, state) => json(res, status, { error: { code, message }, ...(state ? { state } : {}) });
  const stateOf = (s) => ({ url: s.url, title: s.title, thumb: THUMB, thumb_width: 480, thumb_height: 300 });
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const auth = String(req.headers.authorization || "");
      const url = new URL(req.url, "http://x");
      calls.push({ method: req.method, path: url.pathname, auth, body });
      if (req.method === "POST" && url.pathname === "/v1/sessions") {
        if (auth !== `Bearer ${KEY}`) return err(res, 401, "unauthorized", "bad service key");
        n += 1;
        const s = { id: `s_${n}`, token: `st_${n}_secret`, url: (body && body.start_url) || "about:blank", title: "", ended: false, owner: (body && body.owner) || "" };
        sessions.set(s.id, s);
        return json(res, 201, { id: s.id, token: s.token, state: "starting",
          connect_url: `ws://127.0.0.1/v1/sessions/${s.id}/cdp?token=${s.token}`,
          live_view_url: `${base}/v1/sessions/${s.id}/view?token=${s.token}`,
          thumb_url: `${base}/v1/sessions/${s.id}/thumb.jpg?token=${s.token}`,
          expires_at: "2026-09-18T18:40:00Z" });
      }
      const m = url.pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/(actions|keepalive))?$/);
      if (!m) return err(res, 404, "not_found", "no such route");
      const s = sessions.get(m[1]);
      if (!s) return err(res, 404, "not_found", "no such session");
      if (auth !== `Bearer ${s.token}` && url.searchParams.get("token") !== s.token) return err(res, 401, "unauthorized", "bad session token");
      if (s.ended) return err(res, 410, "session_ended", "the session has ended");
      if (req.method === "DELETE") { s.ended = true; res.writeHead(204); return res.end(); }
      if (m[2] === "keepalive" || (req.method === "GET" && !m[2])) return json(res, 200, { id: s.id, state: "ready", url: s.url, title: s.title, pages: [], expires_at: "2026-09-18T18:40:00Z" });
      if (req.method !== "POST" || m[2] !== "actions") return err(res, 404, "not_found", "no such route");
      const a = body || {};
      const ok = (result) => json(res, 200, { ok: true, result, state: stateOf(s), duration_ms: 7 });
      switch (a.type) {
        case "navigate": s.url = String(a.url); s.title = `Page ${s.url.replace(/^https?:\/\//, "").split("/")[0]}`; return ok({ status: 200, url: s.url, title: s.title });
        case "snapshot": return ok({ url: s.url, title: s.title, text: `Welcome to ${s.title}. ${"lorem ".repeat(50)}`.trim(), elements: [
          { ref: "e1", role: "link", name: "Docs", tag: "a", href: s.url + "docs" },
          { ref: "e2", role: "textbox", name: "Password", tag: "input" },
          { ref: "e3", role: "textbox", name: "Search", tag: "input", value: "" },
          { ref: "e4", role: "button", name: "Go", tag: "button" },
          { ref: "e5", role: "heading", name: "Welcome", tag: "h1" },
        ] });
        case "click":
          if (a.ref === "e404") return err(res, 422, "action_failed", "no element with ref e404", stateOf(s));
          s.url = s.url.replace(/\/$/, "") + "/clicked"; return ok({ url: s.url, title: s.title });
        case "type": return ok({ url: s.url, title: s.title });
        case "press": return ok({ url: s.url, title: s.title });
        case "scroll": return ok({ scroll_y: a.dy || 0 });
        case "back": s.url = s.url.replace(/\/clicked$/, "") || s.url; return ok({ url: s.url, title: s.title });
        case "screenshot": return ok({ image: SHOT, width: 1280, height: a.full_page ? 2400 : 800 });
        default: return err(res, 400, "bad_request", `unknown action ${a.type}`);
      }
    });
  });
  let base = "";
  const start = () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${server.address().port}`; resolve(base); }));
  return { server, sessions, calls, start, get base() { return base; },
    end: (id) => { const s = sessions.get(id); if (s) s.ended = true; },
    live: () => [...sessions.values()].filter((s) => !s.ended).map((s) => s.id),
    close: () => new Promise((r) => server.close(() => r())) };
}

// ─── Harness fixtures, after test-harness.js ─────────────────────────────────
function makeCtx(fake, cfgPatch = {}, hooks = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-browser-"));
  const cfg = { autonomy: "execute", approvals: "high-risk", verifier: false, turnBudgetUsd: 0, autoApprove: true, model: "test-model",
    croweBrowser: { url: fake.base, key: KEY }, ...cfgPatch };
  const pool = hooks.pool || new BrowserSessions({ clientFor: () => cfg.croweBrowser.key ? new CroweBrowserClient({ url: cfg.croweBrowser.url, key: cfg.croweBrowser.key }) : null });
  const ctx = {
    dir, pool, journalEvents: [], approvalsSeen: [],
    getCwd: () => dir, setCwd: () => {},
    loadConfig: () => cfg,
    proposeEdit: async () => "applied edit",
    mcpTools: () => [], mcpCall: async () => "mcp result",
    openUrl: () => {},
    journal: (ev) => ctx.journalEvents.push(ev),
    artifactDir: () => path.join(dir, ".artifacts"),
    rateIn: 1.25 / 1e6, rateOut: 10 / 1e6,
    browser: pool,
  };
  if (hooks.approve !== undefined) ctx.requestApproval = async (req) => { ctx.approvalsSeen.push(req); return { approved: hooks.approve }; };
  return ctx;
}
const call = (name, args, id = "c" + Math.random().toString(36).slice(2, 7)) => ({ id, function: { name, arguments: JSON.stringify(args) } });
const reply = (tool_calls, content = "") => ({ content, tool_calls, usage: { prompt_tokens: 10, completion_tokens: 5 }, elapsedMs: 5 });
function makeDeps(script, extra = {}) {
  const events = [], seen = [];
  let n = 0;
  return {
    events, seen,
    results: () => events.filter((e) => e.type === "tool_result"),
    browserEvents: () => events.filter((e) => e.type === "browser"),
    gatewayChat: async (msgs, tools) => { seen.push({ msgs: msgs.map((m) => ({ ...m })), tools }); const r = await script(n++, msgs, tools); return r || reply([], "done"); },
    send: (ev) => events.push(ev),
    isAborted: () => false, setController: () => {},
    ...extra,
  };
}
// One turn: the scripted calls in round one, "done" in round two.
async function turn(ctx, calls, extra = {}) {
  const deps = makeDeps((n) => (n === 0 ? reply(calls) : null), extra);
  const out = await H.runAgent(ctx, [{ role: "user", content: "browse" }], deps);
  return { out, deps };
}
const leaks = (text) => /data:image\//.test(text) || /token=/.test(text) || /st_\d+_secret/.test(text) || /\/view\?/.test(text);

// ─── Offering ────────────────────────────────────────────────────────────────
test("the browser tools are offered only where a configured pool is handed in", async () => {
  const fake = fakeServer(); await fake.start();
  try {
    const names = (ctx) => H.allTools(ctx, { expert: "coding" }, {}).map((t) => t.function.name).filter((x) => x.startsWith("browser_"));
    const none = makeCtx(fake); delete none.browser;
    assert.deepStrictEqual(names(none), []);
    const unset = makeCtx(fake, { croweBrowser: { url: fake.base, key: "" } });
    assert.deepStrictEqual(names(unset), []);
    assert.strictEqual(unset.pool.configured(), false);
    const on = makeCtx(fake);
    assert.deepStrictEqual(names(on), ["browser_open", "browser_read", "browser_click", "browser_type", "browser_press", "browser_scroll", "browser_back", "browser_screenshot"]);
    // The open_url tool is still there, unchanged.
    assert.ok(H.allTools(on, { expert: "coding" }, {}).some((t) => t.function.name === "open_url"));
    // Read tier: five tools; Execute tier: three, and the table says which.
    assert.deepStrictEqual([...H.BROWSER_EXECUTE].sort(), ["browser_click", "browser_press", "browser_type"]);
    for (const n of ["browser_open", "browser_read", "browser_scroll", "browser_back", "browser_screenshot"]) assert.strictEqual(H.deliveryOf(on, n, {}), "compensatable", n);
    for (const n of H.BROWSER_EXECUTE) assert.strictEqual(H.deliveryOf(on, n, {}), "irreversible", n);
    // A hallucinated call where the pool is unconfigured is answered in words.
    const r = await H.execTool(unset, "browser_read", {}, { expert: "coding" }, H.newState(unset, unset.loadConfig(), { agentId: "main" }, { expert: "coding", model: "m" }));
    assert.match(r, /^blocked: Crowe Browser is not set up/);
  } finally { await fake.close(); }
});

// ─── Sessions: lazy, per owner, reused ───────────────────────────────────────
test("one session per owner, created on the first browser tool and reused across turns", async () => {
  const fake = fakeServer(); await fake.start();
  try {
    const ctx = makeCtx(fake);
    assert.strictEqual(fake.sessions.size, 0);
    const t1 = await turn(ctx, [call("browser_open", { url: "https://example.com/" }), call("browser_read", {})]);
    assert.strictEqual(fake.sessions.size, 1, "the first browser tool created exactly one session");
    const [r1, r2] = t1.deps.results().map((e) => e.result);
    assert.match(r1, /^opened https:\/\/example\.com\/ \(HTTP 200\) "Page example\.com"\. Call browser_read/);
    assert.match(r2, /^URL: https:\/\/example\.com\/\nTitle: Page example\.com\n\n--- page text \(\d+ chars\) ---\nWelcome to Page example\.com\./);
    assert.match(r2, /--- elements \(5\) ---\ne1 link "Docs" href=https:\/\/example\.com\/docs\ne2 textbox "Password"\ne3 textbox "Search"\ne4 button "Go"\ne5 heading "Welcome"/);
    // A second turn for the same owner reuses the browser where it was.
    const t2 = await turn(ctx, [call("browser_read", {})]);
    assert.strictEqual(fake.sessions.size, 1, "the second turn reused the session");
    assert.match(t2.deps.results()[0].result, /^URL: https:\/\/example\.com\//);
    assert.strictEqual(fake.sessions.get("s_1").owner, "main");
    // Another owner gets its own.
    const t3 = await turn(ctx, [call("browser_open", { url: "https://other.example/" })], { agentId: "room:r-1:researcher" });
    assert.strictEqual(fake.sessions.size, 2);
    assert.strictEqual(fake.sessions.get("s_2").owner, "room:r-1:researcher");
    assert.match(t3.deps.results()[0].result, /^opened https:\/\/other\.example\//);
    assert.deepStrictEqual(ctx.pool.owners().sort(), ["main", "room:r-1:researcher"]);
    // The service key creates sessions; every call on a session carries that session's token and never the key.
    const creates = fake.calls.filter((c) => c.path === "/v1/sessions");
    assert.ok(creates.length === 2 && creates.every((c) => c.auth === `Bearer ${KEY}`));
    const onSession = fake.calls.filter((c) => c.path !== "/v1/sessions");
    assert.ok(onSession.length >= 4 && onSession.every((c) => /^Bearer st_\d+_secret$/.test(c.auth)));
    // Ending: a seat dropped, then all, and the server sees the DELETEs.
    await ctx.pool.drop("room:r-1:researcher");
    assert.deepStrictEqual(fake.live(), ["s_1"]);
    assert.strictEqual(await ctx.pool.endAll(), 1);
    assert.deepStrictEqual(fake.live(), []);
    assert.deepStrictEqual(ctx.pool.owners(), []);
  } finally { await fake.close(); }
});

test("creation is serialised per owner: two tools in one round open one browser", async () => {
  const fake = fakeServer(); await fake.start();
  try {
    const ctx = makeCtx(fake);
    const [a, b] = await Promise.all([ctx.pool.ensure("main"), ctx.pool.ensure("main")]);
    assert.strictEqual(a, b);
    assert.strictEqual(fake.sessions.size, 1);
  } finally { await fake.close(); }
});

// ─── 410 ─────────────────────────────────────────────────────────────────────
test("a session the server ended is replaced once: a read is retried on the restored page, an act is refused until a fresh read", async () => {
  const fake = fakeServer(); await fake.start();
  try {
    const ctx = makeCtx(fake);
    await turn(ctx, [call("browser_open", { url: "https://example.com/start" })]);
    fake.end("s_1");                                   // the idle timer fired between turns
    const t = await turn(ctx, [call("browser_read", {})]);
    assert.strictEqual(fake.sessions.size, 2, "one new session");
    const r = t.deps.results()[0].result;
    assert.match(r, /^URL: https:\/\/example\.com\/start\n/, "the read was retried on the restored page");
    const onNew = fake.calls.filter((c) => c.path === "/v1/sessions/s_2/actions").map((c) => c.body.type);
    assert.deepStrictEqual(onNew, ["navigate", "snapshot"]);
    const evs = t.deps.browserEvents();
    assert.ok(evs.length >= 2 && evs.every((e) => e.session_id === "s_2"), "the card events name the new session");
    assert.strictEqual(fake.calls.filter((c) => c.path === "/v1/sessions/s_1/actions").length, 2, "one 410 for the read; nothing else went to the dead session");

    // An act after a 410 is not retried: the refs it names came from a page that is gone.
    await turn(ctx, [call("browser_read", {})]);
    fake.end("s_2");
    const t2 = await turn(ctx, [call("browser_click", { ref: "e1" })]);
    assert.strictEqual(fake.sessions.size, 3);
    assert.match(t2.deps.results()[0].result, /^error: the cloud browser session had ended, so a new one was started at https:\/\/example\.com\/start\. Its refs are new: call browser_read, then browser_click again/);
    assert.deepStrictEqual(fake.calls.filter((c) => c.path === "/v1/sessions/s_3/actions").map((c) => c.body.type), ["navigate"], "the new session was put back on its page and nothing was clicked");
    assert.strictEqual(t2.deps.results()[0].status, "FAIL");

    // A second 410 in the same call is not recovered twice.
    fake.end("s_3");
    const t3 = await turn(ctx, [call("browser_open", { url: "https://example.com/again" })]);
    assert.strictEqual(fake.sessions.size, 4);
    assert.match(t3.deps.results()[0].result, /^opened https:\/\/example\.com\/again/);
  } finally { await fake.close(); }
});

// ─── Tiers ───────────────────────────────────────────────────────────────────
test("reads run at every tier; click, type and press wait for Execute, with the room's own wording under a cap", async () => {
  const fake = fakeServer(); await fake.start();
  try {
    for (const tier of ["plan", "readonly", "edit"]) {
      const ctx = makeCtx(fake, { autonomy: tier });
      const t = await turn(ctx, [call("browser_open", { url: "https://example.com/" }), call("browser_read", {}), call("browser_scroll", { dy: 400 }),
        call("browser_back", {}), call("browser_screenshot", {}), call("browser_click", { ref: "e1" }), call("browser_type", { ref: "e3", text: "hello" }), call("browser_press", { key: "Enter" })]);
      const rs = t.deps.results();
      assert.match(rs[0].result, /^opened /, tier);
      assert.match(rs[1].result, /^URL: /, tier);
      assert.match(rs[2].result, /^scrolled down 400 px to y=400\./, tier);
      assert.match(rs[3].result, /^went back\./, tier);
      assert.match(rs[4].result, /^screenshot taken \(1280x800\) of https:\/\/example\.com\/; it is on the Cloud browser card for the user\./, tier);
      for (const i of [5, 6, 7]) {
        assert.match(rs[i].result, new RegExp(`^blocked: browser_(click|type|press) acts on a live page, which needs Execute autonomy, and the current mode is "${tier}"`), tier);
        assert.strictEqual(rs[i].status, "BLOCKED");
      }
      const acted = fake.calls.filter((c) => /\/actions$/.test(c.path) && ["click", "type", "press"].includes(c.body.type));
      assert.strictEqual(acted.length, 0, `${tier}: nothing acted on the page`);
      await ctx.pool.endAll();
    }
    // Execute: all eight run.
    const ctx = makeCtx(fake, { autonomy: "execute" });
    const t = await turn(ctx, [call("browser_open", { url: "https://example.com/" }), call("browser_read", {}), call("browser_click", { ref: "e1" }),
      call("browser_type", { ref: "e3", text: "hello", submit: true }), call("browser_press", { key: "Escape" })]);
    const rs = t.deps.results().map((e) => e.result);
    assert.match(rs[2], /^clicked e1\. Now at https:\/\/example\.com\/clicked "Page example\.com"\. Refs may have changed/);
    assert.match(rs[3], /^typed 5 characters into e3 and pressed Enter\. Now at /);
    assert.match(rs[4], /^pressed Escape\. Now at /);
    // A room cap lowers Execute to read-only and says so in the room's words.
    const t2 = await turn(ctx, [call("browser_click", { ref: "e1" })], { agentId: "room:r-9:seat", tier: "readonly" });
    assert.match(t2.deps.results()[0].result, /^blocked: this room runs at "readonly"; a seat may read pages in the cloud browser, not click or type on them\./);
    assert.strictEqual(fake.sessions.size, 4, "a blocked act opened no session");
  } finally { await fake.close(); }
});

// ─── Events and what the model sees ──────────────────────────────────────────
test("every action emits a browser event with the thumbnail and the live view; the model never receives either", async () => {
  const fake = fakeServer(); await fake.start();
  try {
    const ctx = makeCtx(fake);
    const t = await turn(ctx, [call("browser_open", { url: "https://example.com/" }), call("browser_read", {}), call("browser_screenshot", { full_page: true }),
      call("browser_click", { ref: "e404" }), call("browser_scroll", { dy: -100 })]);
    const evs = t.deps.browserEvents();
    assert.strictEqual(evs.length, 5, "one event per action, the failed click included");
    for (const e of evs) {
      assert.strictEqual(e.session_id, "s_1");
      assert.strictEqual(e.thumb, THUMB);
      assert.strictEqual(e.thumb_width, 480);
      assert.strictEqual(e.live_view_url, `${fake.base}/v1/sessions/s_1/view?token=st_1_secret`);
      assert.strictEqual(e.expires_at, "2026-09-18T18:40:00Z");
      assert.match(e.url, /^https:\/\/example\.com\//);
      assert.strictEqual(e.title, "Page example.com");
    }
    // Order: the card is drawn before the tool result closes the tool card.
    const order = t.deps.events.filter((e) => e.type === "browser" || e.type === "tool_result").map((e) => e.type);
    assert.deepStrictEqual(order.slice(0, 4), ["browser", "tool_result", "browser", "tool_result"]);
    // The 422 is reported with the page it happened on, and the event still went out.
    const rs = t.deps.results();
    assert.match(rs[3].result, /^error: browser_click failed: no element with ref e404 Now at https:\/\/example\.com\/ "Page example\.com"\.$/);
    assert.strictEqual(rs[3].status, "FAIL");
    assert.match(rs[2].result, /^screenshot taken \(1280x2400\)/);
    // Nothing the model receives carries a frame, a token, or the live view.
    for (const r of rs) assert.ok(!leaks(r.result), `tool result leaked: ${r.result.slice(0, 80)}`);
    const toolMsgs = t.deps.seen.flatMap((s) => s.msgs).filter((m) => m.role === "tool");
    assert.ok(toolMsgs.length >= 5);
    for (const m of toolMsgs) assert.ok(!leaks(String(m.content)), "a tool message to the model leaked");
    const sys = t.deps.seen[0].msgs.find((m) => m.role === "system");
    assert.match(sys.content, /Cloud browser: browser_open, browser_read/);
    assert.ok(!leaks(sys.content));
    // The journal names the action and the page, never the frame or the token.
    const j = ctx.journalEvents.filter((e) => /^BROWSER_ACTION/.test(e.event_type));
    assert.strictEqual(j.length, 5);
    assert.strictEqual(j.filter((e) => e.event_type === "BROWSER_ACTION_FAILED").length, 1);
    for (const e of j) assert.ok(!leaks(JSON.stringify(e)), "the journal leaked");
    // The tool card's arguments for a type are the text with secrets cut, not hidden.
    assert.deepStrictEqual(H.shownArgs("browser_type", { ref: "e3", text: "hello sk_live_ABCDEFGHIJKLMNOPQRST" }).text.includes("sk_live_ABCDEFGHIJKLMNOPQRST"), false);
  } finally { await fake.close(); }
});

// ─── Approval floors ─────────────────────────────────────────────────────────
test("browser_open asks about a URL that carries data and lets a bare page through; browser_type asks for a credential or a credential field", async () => {
  const fake = fakeServer(); await fake.start();
  try {
    const ctx = makeCtx(fake, {}, { approve: false });
    const t = await turn(ctx, [call("browser_open", { url: "https://example.com/" }), call("browser_open", { url: "https://example.com/search?q=the+users+notes" })]);
    const rs = t.deps.results();
    assert.match(rs[0].result, /^opened https:\/\/example\.com\//);
    assert.match(rs[1].result, /^blocked: the user DENIED this action \(opens a URL in the cloud browser that carries data the model composed\)/);
    assert.strictEqual(ctx.approvalsSeen.length, 1);
    assert.strictEqual(ctx.approvalsSeen[0].kind, "browser_open");
    assert.strictEqual(fake.calls.filter((c) => c.body && c.body.type === "navigate").length, 1);

    // Typing: a secret shape in the text, or a field whose name says credential.
    const ok = makeCtx(fake, {}, { approve: true });
    await turn(ok, [call("browser_open", { url: "https://example.com/login" }), call("browser_read", {})]);
    const t2 = await turn(ok, [
      call("browser_type", { ref: "e3", text: "plain words" }),
      call("browser_type", { ref: "e3", text: "sk_live_ABCDEFGHIJKLMNOPQRSTUV" }),
      call("browser_type", { ref: "e2", text: "hunter2" }),
      call("browser_type", { selector: "input[type=password]", text: "hunter2" }),
    ]);
    const asked = ok.approvalsSeen.filter((r) => r.kind === "browser_type");
    assert.strictEqual(asked.length, 3, "plain words into a plain field did not ask");
    assert.match(asked[0].why, /^types what looks like a live Stripe secret key into textbox "Search" on https:\/\/example\.com\/login$/);
    assert.match(asked[1].why, /^types into textbox "Password", which looks like a credential field, on https:\/\/example\.com\/login$/);
    assert.match(asked[2].why, /^types into selector input\[type=password\], which looks like a credential field/);
    for (const r of asked) {
      assert.strictEqual(r.risk, "strict");
      assert.ok(!/hunter2|sk_live/.test(r.why + r.detail + JSON.stringify(r.meta || {})), "the card named the value");
      assert.match(r.detail, /characters, not shown/);
    }
    const rs2 = t2.deps.results().map((e) => e.result);
    for (const r of rs2) assert.match(r, /^typed \d+ characters into /);
    // Denied, nothing is typed.
    const no = makeCtx(fake, {}, { approve: false });
    await turn(no, [call("browser_open", { url: "https://example.com/login" }), call("browser_read", {})]);
    const before = fake.calls.filter((c) => c.body && c.body.type === "type").length;
    const t3 = await turn(no, [call("browser_type", { ref: "e2", text: "hunter2", submit: true })]);
    assert.match(t3.deps.results()[0].result, /^blocked: the user DENIED this action/);
    assert.strictEqual(fake.calls.filter((c) => c.body && c.body.type === "type").length, before);
    // Approvals off still asks: the floor is alwaysAsk, like mail.
    const off = makeCtx(fake, { approvals: "off" }, { approve: true });
    await turn(off, [call("browser_open", { url: "https://example.com/login" }), call("browser_read", {})]);
    await turn(off, [call("browser_type", { ref: "e2", text: "hunter2" })]);
    assert.strictEqual(off.approvalsSeen.filter((r) => r.kind === "browser_type").length, 1);
  } finally { await fake.close(); }
});

// ─── Arguments, the verifier, errors ─────────────────────────────────────────
test("malformed arguments are refused before the service is reached, and the verifier may not drive the browser", async () => {
  const fake = fakeServer(); await fake.start();
  try {
    const ctx = makeCtx(fake);
    const t = await turn(ctx, [call("browser_click", {}), call("browser_type", { ref: "e1" }), call("browser_press", {}), call("browser_scroll", {}), call("browser_open", { url: "not a url at all" })]);
    const rs = t.deps.results().map((e) => e.result);
    assert.match(rs[0], /^rejected: browser_click needs a ref/);
    assert.match(rs[1], /^rejected: browser_type needs text to type\./);
    assert.match(rs[2], /^rejected: browser_press needs one key name/);
    assert.match(rs[3], /^rejected: browser_scroll needs dy in pixels or a ref/);
    assert.match(rs[4], /^blocked: https:\/\/not a url at all is not a web address\./);
    assert.strictEqual(fake.sessions.size, 0, "no session was opened for a refused call");
    const state = H.newState(ctx, ctx.loadConfig(), { agentId: "main" }, { expert: "coding", model: "m", verify: true });
    assert.match(await H.execTool(ctx, "browser_read", {}, { expert: "coding", verify: true }, state), /^blocked: the verifier checks the workspace; it does not drive the cloud browser\./);
    // A wrong key is said in words, once, and no session exists.
    const bad = makeCtx(fake, { croweBrowser: { url: fake.base, key: "wrong" } });
    const t2 = await turn(bad, [call("browser_open", { url: "https://example.com/" })]);
    assert.match(t2.deps.results()[0].result, /^error: could not start a cloud browser: bad service key/);
    assert.strictEqual(fake.sessions.size, 0);
  } finally { await fake.close(); }
});

// ─── The client on its own ───────────────────────────────────────────────────
test("the client normalises the base URL, refuses what is not a Crowe Browser, and types its errors", async () => {
  assert.strictEqual(normalizeBaseUrl("https://browser.crowelogic.com/"), "https://browser.crowelogic.com");
  assert.strictEqual(normalizeBaseUrl("https://browser.crowelogic.com/prefix/"), "https://browser.crowelogic.com/prefix");
  assert.strictEqual(normalizeBaseUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  for (const bad of ["http://browser.example", "ftp://x", "https://u:p@host", "https://host/?x=1", "not a url", ""]) assert.strictEqual(normalizeBaseUrl(bad), "", bad);
  assert.throws(() => new CroweBrowserClient({ url: "http://browser.example", key: "k" }), BrowserError);
  const fake = fakeServer(); await fake.start();
  try {
    const c = new CroweBrowserClient({ url: fake.base, key: KEY });
    const s = await c.createSession({ owner: "t", ttlSeconds: 5 });
    assert.strictEqual(fake.calls[0].body.ttl_seconds, 60, "ttl is clamped into the contract's range");
    assert.strictEqual((await c.getSession(s)).state, "ready");
    assert.strictEqual((await c.keepalive(s)).id, s.id);
    await assert.rejects(c.action(s, "click", { ref: "e404" }), (e) => e instanceof BrowserError && e.status === 422 && e.code === "action_failed" && e.state && e.state.thumb === THUMB);
    assert.strictEqual(await c.endSession(s), true);
    assert.strictEqual(await c.endSession(s), true, "ending twice is fine");
    await assert.rejects(c.action(s, "snapshot", {}), (e) => e instanceof BrowserError && e.status === 410 && e.code === "session_ended");
    const wrong = new CroweBrowserClient({ url: fake.base, key: "nope" });
    await assert.rejects(wrong.createSession({}), (e) => e instanceof BrowserError && e.status === 401 && e.code === "unauthorized");
    // The header carries the key exactly once, on creation.
    assert.ok(fake.calls.filter((c2) => c2.auth === `Bearer ${KEY}`).length === 1);
    // A timeout is typed, and the error text never quotes the key.
    const slow = new CroweBrowserClient({ url: fake.base, key: KEY, timeoutMs: 20, fetch: (u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))) });
    await assert.rejects(slow.createSession({}), (e) => e instanceof BrowserError && e.code === "timeout" && !e.message.includes(KEY));
  } finally { await fake.close(); }
});

// ─── Runner ──────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  const failures = [];
  for (const t of tests) {
    try { await t.fn(); passed += 1; process.stdout.write("."); }
    catch (e) { failures.push({ name: t.name, e }); process.stdout.write("x"); }
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
  console.log(`browser-tools: ${passed} tests passed`);
})();
