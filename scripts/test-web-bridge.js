#!/usr/bin/env node
// Keeps the web port honest against the desktop it was copied from.
//
//   node scripts/test-web-bridge.js
//
// renderer/app.html ships the desktop renderer unmodified and re-implements the
// bridge underneath it, the same bargain mobile/ makes. That buys one codebase
// for the UI and costs the same coupling: the shape of window.crowe, which
// preload.js defines and renderer.js calls. A method the web build forgot is a
// TypeError at a click, in production, with no build step to catch it.
//
// Two of these checks exist because the thing they assert was shipped wrong.
// setConfig used to Object.assign its whole patch into localStorage, so a token
// handed to it was published into browser storage — against rule 1 at the top
// of web-bridge.js. And agentRun's finally deleted the controller for `id`
// unconditionally, so a second run under the same id lost its stop.
//
// Run under plain node; no Electron, no browser, no network.

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let failures = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${String(e.message || e).split("\n").join("\n       ")}`);
  }
}
function assert(cond, message) { if (!cond) throw new Error(message); }
// The room checks compare structures; keep the house `assert(cond, msg)` and
// borrow node's equality helpers for those, so a mismatch prints both sides.
const nodeAssert = require("assert");
assert.strictEqual = nodeAssert.strictEqual;
assert.deepStrictEqual = nodeAssert.deepStrictEqual;

// ─── Load both bridges ───────────────────────────────────────────────────────

// preload.js runs in Electron. Feed it a contextBridge that keeps what it is
// handed instead of exposing it to a renderer that does not exist here.
function loadPreloadSurface() {
  let exposed = null;
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
    ipcRenderer: { invoke: () => Promise.resolve(), send: () => {}, on: () => {}, removeListener: () => {} },
  };
  const require_ = (name) => { if (name === "electron") return electron; throw new Error(`preload required ${name}`); };
  new Function("require", "process", read("preload.js"))(require_, { argv: [] });
  assert(exposed, "preload.js did not expose anything on window.crowe");
  return exposed;
}

// web-bridge.js runs in a plain browser tab. Give it the globals it touches at
// load: storage, an origin, and a fetch that fails the way an unreachable edge
// does unless a test supplies its own.
function loadWebSurface({ fetchImpl, seedConfig, rooms = true } = {}) {
  const store = new Map();
  if (seedConfig) store.set("crowe.web.config", JSON.stringify(seedConfig));

  const win = {};
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const sandbox = {
    window: win,
    localStorage,
    location: { origin: "https://crowelm.com" },
    fetch: fetchImpl || (() => Promise.reject(new TypeError("offline"))),
    AbortController,
    TextDecoder,
    // The bridge warns once when it routes around an unopened edge; that is
    // for a browser console, not for a test log, so warn is quiet here.
    console: Object.assign(Object.create(console), { warn: () => {} }),
  };
  // app.html loads rooms-web.js ahead of the bridge; do the same here so the
  // bridge sees the engine the way a browser tab does. `rooms:false` is the
  // old-app.html case, where the surface must still answer.
  if (rooms) new Function("window", read("renderer/rooms-web.js"))(win);
  new Function(...Object.keys(sandbox), read("renderer/web-bridge.js"))(...Object.values(sandbox));
  assert(win.crowe, "web-bridge.js did not install window.crowe");
  return { crowe: win.crowe, store, win };
}

/* An edge that answers chat/completions in SSE, one canned reply per call,
   attributing nothing: the bridge is what has to attribute. `replies` is
   consumed in call order; each may be a string or an Error to fail that seat. */
function fakeEdge(replies) {
  let n = 0;
  const calls = [];
  const impl = async (url, init = {}) => {
    if (!String(url).includes("/chat/completions")) return new Response("{}", { status: 200 });
    const body = JSON.parse(init.body || "{}");
    calls.push({ model: body.model, messages: body.messages });
    const r = replies[Math.min(n++, replies.length - 1)];
    if (r instanceof Error) return new Response(r.message, { status: 500 });
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: r } }] })}\n`,
      `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 12 } })}\n`,
      "data: [DONE]\n",
    ].join("");
    return new Response(frames, { status: 200 });
  };
  impl.calls = calls;
  return impl;
}

// Every callable path in an exposed surface, one level of grouping deep —
// which is as deep as the bridge goes.
function methodPaths(surface) {
  const out = [];
  for (const [key, value] of Object.entries(surface)) {
    if (typeof value === "function") out.push(key);
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [name, fn] of Object.entries(value)) if (typeof fn === "function") out.push(`${key}.${name}`);
    }
  }
  return out.sort();
}

const okText = (body) => async () => new Response(body, { status: 200 });

(async () => {
  console.log("web bridge");
  const desktop = loadPreloadSurface();

  await check("every desktop bridge method exists on the web bridge", () => {
    const { crowe: web } = loadWebSurface();
    const missing = methodPaths(desktop).filter((p) => {
      const [group, name] = p.split(".");
      const target = name ? web[group] && web[group][name] : web[group];
      return typeof target !== "function";
    });
    assert(!missing.length, `web bridge is missing: ${missing.join(", ")}`);
    return `${methodPaths(desktop).length} methods`;
  });

  // ─── Rule 1: it never holds a credential ──────────────────────────────────

  await check("setConfig refuses to persist a token", async () => {
    const { crowe: web, store } = loadWebSurface();
    await web.setConfig({ token: "sk-live-should-never-land-here", theme: "dark" });
    const raw = store.get("crowe.web.config") || "";
    assert(!/sk-live-should-never-land-here/.test(raw), `token was written to localStorage: ${raw}`);
    assert(/dark/.test(raw), "the allowlisted key was dropped along with the token");
    return "token dropped, theme kept";
  });

  await check("setConfig ignores any key the allowlist does not name", async () => {
    const { crowe: web, store } = loadWebSurface();
    await web.setConfig({ apiKey: "nope", sessionCookie: "nope", password: "nope" });
    const raw = store.get("crowe.web.config") || "{}";
    assert(!/nope/.test(raw), `an unnamed key was persisted: ${raw}`);
    return "denies by default";
  });

  await check("a token already in storage is purged on load", () => {
    // The broken build shipped, so this cleans up after it rather than waiting
    // for the credential to expire on its own.
    const { store } = loadWebSurface({ seedConfig: { token: "sk-live-left-over", theme: "dark" } });
    const raw = store.get("crowe.web.config") || "";
    assert(!/sk-live-left-over/.test(raw), `stale token survived load: ${raw}`);
    assert(/dark/.test(raw), "purge took the legitimate keys with it");
    return "stale credential removed";
  });

  await check("getConfig never reports a token, only whether one exists", async () => {
    const { crowe: web } = loadWebSurface();
    const cfg = await web.getConfig();
    assert(!("token" in cfg), "getConfig exposed a token field");
    assert(cfg.hasToken === false, "the web build cannot hold a token, so hasToken must be false");
    return "mirrors main.js:1017";
  });

  // ─── The shape renderer.js was written against ────────────────────────────

  await check("baseUrl is a URL the status line can parse", async () => {
    // renderer.js:2267 does new URL(cfg.baseUrl).host. Undefined threw into the
    // catch and rendered the literal string "undefined".
    const { crowe: web } = loadWebSurface();
    const cfg = await web.getConfig();
    const host = new URL(cfg.baseUrl).host;
    assert(host && host !== "undefined", `baseUrl did not parse: ${cfg.baseUrl}`);
    return host;
  });

  await check("setConfig returns the same shape getConfig does", async () => {
    const { crowe: web } = loadWebSurface();
    const before = Object.keys(await web.getConfig()).sort();
    const after = Object.keys(await web.setConfig({ onboarded: true })).sort();
    assert(before.join() === after.join(), `shapes differ:\n  get: ${before}\n  set: ${after}`);
    return `${before.length} keys`;
  });

  await check("autonomy does not claim a capability the browser refuses", async () => {
    // fs and pty both reject here, so reporting "edit" or "execute" would light
    // up controls that cannot work.
    const { crowe: web } = loadWebSurface();
    const { autonomy } = await web.getConfig();
    assert(autonomy === "readonly", `default autonomy was ${autonomy}`);
    return autonomy;
  });

  // ─── Identity: one source, not two ────────────────────────────────────────

  await check("license and auth agree when the edge answers", async () => {
    const { crowe: web } = loadWebSurface({ fetchImpl: okText("michael@crowelogic.com") });
    const [auth, license] = await Promise.all([web.auth.status(), web.license.status()]);
    assert(auth.user && auth.user.email === "michael@crowelogic.com", "auth did not read the edge user");
    assert(license.authenticated === true, "license disagreed with auth");
    return "both signed in";
  });

  await check("license and auth agree when the edge does not answer", async () => {
    // The regression: license hardcoded authenticated:true, so the shell showed
    // a signed in user around a composer that showed a sign-in gate.
    const { crowe: web } = loadWebSurface({ fetchImpl: () => Promise.reject(new TypeError("offline")) });
    const [auth, license] = await Promise.all([web.auth.status(), web.license.status()]);
    assert(auth.user === null, "auth invented a user");
    assert(license.authenticated === false, "license claimed authenticated while auth reported none");
    return "both signed out";
  });

  // ─── Run control ──────────────────────────────────────────────────────────

  await check("a second run under one id does not lose its stop", async () => {
    // The regression needs run one to finish AFTER run two has registered, so
    // that run one's finally is what removes run two's controller. An earlier
    // draft of this check let run one finish first, which is not a race at all
    // — it passed against the broken bridge and proved nothing.
    let aborted = false;
    const gate = (() => {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      return { promise, open: resolve };
    })();

    let call = 0;
    const fetchImpl = async (url, init = {}) => {
      if (!String(url).includes("/chat/completions")) return new Response("{}", { status: 200 });
      call += 1;
      if (call === 1) {
        // Run one: held open until run two has registered, then completes.
        await gate.promise;
        return new Response("data: [DONE]\n", { status: 200 });
      }
      // Run two: never resolves on its own, so only an abort can end it.
      init.signal.addEventListener("abort", () => { aborted = true; });
      await new Promise(() => {});
      return new Response("", { status: 200 });
    };

    const { crowe: web } = loadWebSurface({ fetchImpl });
    const first = web.agent.run([{ role: "user", content: "one" }], "main");
    await new Promise((r) => setTimeout(r, 10));       // run one is in flight
    const second = web.agent.run([{ role: "user", content: "two" }], "main");
    await new Promise((r) => setTimeout(r, 10));       // run two has registered
    gate.open();                                       // run one finishes, runs finally
    await first.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));

    await web.agent.stop("main");
    await new Promise((r) => setTimeout(r, 10));
    second.catch(() => {});
    assert(aborted, "run one's finally removed run two's controller, so stop() aborted nothing");
    return "stop still reaches it";
  });

  // ─── Named agents ─────────────────────────────────────────────────────────

  /* An edge that exposes Open WebUI's model list: two custom models (agents)
     with descriptions and knowledge, one plain lane; and records every
     chat/completions body so the scope decision can be read off the wire. */
  function agentEdge({ modelsStatus = 200 } = {}) {
    const bodies = [];
    const impl = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith("/app/owui/api/models")) {
        if (modelsStatus !== 200) return new Response("", { status: modelsStatus });
        return new Response(JSON.stringify({ data: [
          { id: "toxictee-manager", name: "ToxicTee Manager", info: { meta: { description: "Runs the ToxicTee brand.", knowledge: [{ id: "k1" }] } } },
          { id: "peoria-ford", name: "Peoria Ford", info: { meta: { knowledge: [{ id: "k2" }, { id: "k3" }] } } },
          { id: "crowelm-apex", name: "crowelm-apex" },
        ] }), { status: 200 });
      }
      if (u.endsWith("/app/gw/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "crowelm-apex" }, { id: "crowelm-flash" }] }), { status: 200 });
      }
      if (u.includes("/chat/completions")) {
        bodies.push(JSON.parse(init.body || "{}"));
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\ndata: [DONE]\n`, { status: 200 });
      }
      return new Response("", { status: 404 });
    };
    impl.bodies = bodies;
    return impl;
  }

  await check("custom models surface as named agents with their brief", async () => {
    const { crowe: web } = loadWebSurface({ fetchImpl: agentEdge() });
    const rows = await web.catalog.get();
    const byId = Object.fromEntries(rows.map((r) => [r[0], r]));
    assert(byId["toxictee-manager"], "agent missing from catalog");
    assert.strictEqual(byId["toxictee-manager"][1], "ToxicTee Manager", "agent must show its own name, not a lane label");
    assert.strictEqual(byId["toxictee-manager"][3], "Runs the ToxicTee brand.", "agent description belongs in the role column");
    assert(/2 knowledge collections/.test(byId["peoria-ford"][3]), `undescribed agent should say what it knows: ${byId["peoria-ford"][3]}`);
    assert.strictEqual(byId["crowelm-apex"][1], "CroweLM Apex", "a plain lane keeps the lane label");
    return `${rows.length} rows, 2 agents`;
  });

  await check("a run against a named agent sends no pinned collections", async () => {
    // The agent's knowledge is its scope. Pinning the SWM collections on top
    // would answer a Peoria Ford question out of a mushroom transcript.
    const edge = agentEdge();
    const { crowe: web } = loadWebSurface({ fetchImpl: edge });
    await web.catalog.get();
    await web.agent.run([{ role: "user", content: "hi" }], "main", { model: "peoria-ford" });
    await web.agent.run([{ role: "user", content: "hi" }], "main", { model: "crowelm-apex" });
    assert.strictEqual(edge.bodies.length, 2, "expected two runs");
    assert(!("files" in edge.bodies[0]), "agent run must not carry pinned collections");
    assert(Array.isArray(edge.bodies[1].files) && edge.bodies[1].files.length === 3, "plain lane must keep the operator's three collections");
    return "agent unscoped, lane pinned";
  });

  await check("when the edge hides the model list the catalog falls back to the gateway", async () => {
    // Today the edge answers 404 for /app/owui/api/models. Nothing may regress
    // while that line waits to be applied.
    const { crowe: web } = loadWebSurface({ fetchImpl: agentEdge({ modelsStatus: 404 }) });
    const rows = await web.catalog.get();
    assert.deepStrictEqual(rows.map((r) => r[0]).sort(), ["crowelm-apex", "crowelm-flash"], `fallback rows: ${rows.map((r) => r[0])}`);
    return "gateway lanes";
  });

  // ─── Sessions ─────────────────────────────────────────────────────────────

  /* An edge where OWUI's chats API is open, backed by an in-memory table with
     server-minted ids and OWUI's wire shapes (seconds for updated_at, `chat`
     wrapper on write, bare array on list). Chat completions answer through the
     gateway so a run can happen. */
  function chatsEdge({ open = true } = {}) {
    const table = new Map();
    let n = 0;
    const impl = async (url, init = {}) => {
      const u = String(url);
      const m = init.method || "GET";
      if (u.startsWith("/app/owui/api/v1/chats")) {
        if (!open) return new Response(null, { status: 404, headers: { server: "Caddy" } });
        const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
        if (u.startsWith("/app/owui/api/v1/chats/?") && m === "GET") {
          return json([...table.values()].map((c) => ({ id: c.id, title: c.title, updated_at: c.updated_at, created_at: c.created_at })));
        }
        if (u === "/app/owui/api/v1/chats/new" && m === "POST") {
          const { chat } = JSON.parse(init.body);
          const id = `owui-${++n}`;
          const now = Math.floor(Date.now() / 1000);
          table.set(id, { id, title: chat.title, chat, updated_at: now, created_at: now });
          return json(table.get(id));
        }
        const id = decodeURIComponent(u.slice("/app/owui/api/v1/chats/".length));
        if (m === "GET") return table.has(id) ? json(table.get(id)) : json({ detail: "not found" }, 404);
        if (m === "POST") {
          if (!table.has(id)) return json({ detail: "not found" }, 404);
          const { chat } = JSON.parse(init.body);
          const row = table.get(id);
          Object.assign(row, { title: chat.title, chat, updated_at: Math.floor(Date.now() / 1000) + 1 });
          return json(row);
        }
        if (m === "DELETE") { table.delete(id); return json(true); }
      }
      if (u.startsWith("/app/owui/api/chat/completions")) return new Response(null, { status: 404, headers: { server: "Caddy" } });
      if (u.startsWith("/app/gw/v1/chat/completions")) {
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "answer" } }] })}\ndata: [DONE]\n`, { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    impl.table = table;
    return impl;
  }

  await check("a run writes the transcript into the current session (local)", async () => {
    // The first web build never wrote a message into a session, so every thread
    // stayed "Untitled" and empty. This is main.js:894 on the web.
    const edge = chatsEdge({ open: false });
    const { crowe: web, store } = loadWebSurface({ fetchImpl: edge });
    await web.sessions.new();
    await web.agent.run([{ role: "user", content: "How wet should straw be?" }], "main");
    const rows = await web.sessions.list();
    assert.strictEqual(rows.length, 1, `expected one session, got ${rows.length}`);
    assert.strictEqual(rows[0].title, "How wet should straw be?", `title was ${rows[0].title}`);
    assert(rows[0].current === true, "the session just written is not marked current");
    // Reload: same storage, fresh bridge.
    const again = loadWebSurface({ fetchImpl: edge });
    again.store.set("crowe.web.sessions", store.get("crowe.web.sessions"));
    const loaded = await again.crowe.sessions.load(rows[0].id);
    assert(loaded && loaded.messages.length === 2, `transcript did not survive reload: ${JSON.stringify(loaded)}`);
    assert.strictEqual(loaded.messages[1].content, "answer");
    return "titled, persisted, reloads";
  });

  await check("when the edge opens OWUI chats, sessions live on the server", async () => {
    const edge = chatsEdge({ open: true });
    const { crowe: web, store } = loadWebSurface({ fetchImpl: edge });
    await web.sessions.new();
    await web.agent.run([{ role: "user", content: "Sterilize or pasteurize?" }], "main");
    await web.agent.run([{ role: "user", content: "Sterilize or pasteurize?" }, { role: "assistant", content: "answer" }, { role: "user", content: "why?" }], "main");
    assert.strictEqual(edge.table.size, 1, `expected one server chat, got ${edge.table.size} (a second run must update, not create)`);
    const [row] = [...edge.table.values()];
    assert.strictEqual(row.title, "Sterilize or pasteurize?");
    assert.strictEqual(row.chat.crowe.messages.length, 4, "the second run's transcript did not update the same chat");
    assert(!store.get("crowe.web.sessions"), "server-side sessions must not also be written to localStorage");
    // A different browser, same server: the session is there.
    const other = loadWebSurface({ fetchImpl: edge });
    const rows = await other.crowe.sessions.list();
    assert.strictEqual(rows.length, 1);
    assert(rows[0].updatedAt > 1e12, `updatedAt must be milliseconds for new Date(); got ${rows[0].updatedAt}`);
    const loaded = await other.crowe.sessions.load(rows[0].id);
    assert.strictEqual(loaded.messages.length, 4);
    await other.crowe.sessions.delete(rows[0].id);
    assert.strictEqual(edge.table.size, 0, "delete did not reach the server");
    return "server-side, cross-browser, ms timestamps";
  });

  await check("the store is chosen once per page and rooms stay on the local record", async () => {
    let probes = 0;
    const base = chatsEdge({ open: true });
    const counting = async (url, init) => { if (String(url).startsWith("/app/owui/api/v1/chats/?")) probes += 1; return base(url, init); };
    const { crowe: web } = loadWebSurface({ fetchImpl: counting });
    await web.sessions.list(); await web.sessions.list(); await web.sessions.new();
    // One probe plus the two real lists: the probe is not re-run per call.
    assert(probes <= 3, `chats endpoint hit ${probes} times for one probe and two lists`);
    const { agents } = await web.rooms.agents();
    const made = await web.rooms.create({ title: "r", agentIds: [agents[0].id] });
    assert(made.room, "room did not create with the remote session store active");
    assert.strictEqual(base.table.size, 0, "a room must not be written to OWUI chats");
    return "one probe, rooms local";
  });

  // ─── Named sessions ───────────────────────────────────────────────────────

  await check("a session can be named and briefed, and both survive the next run", async () => {
    // A session is an agent when it has a name and a standing brief. The name
    // replaces the auto title in the rail; the brief is sent on every turn.
    // Both must survive the run-time write that titles and persists the
    // transcript, which is where the desktop's own persistSession would have
    // dropped them had it not been read-merge-written.
    const edge = chatsEdge({ open: false });
    const { crowe: web } = loadWebSurface({ fetchImpl: edge });
    const { id } = await web.sessions.new();
    const upd = await web.sessions.update(id, { name: "Straw desk", brief: "You are the substrate specialist for this farm." });
    assert(upd && upd.ok, `update failed: ${JSON.stringify(upd)}`);
    await web.agent.run([{ role: "user", content: "How wet?" }], "main");
    const rows = await web.sessions.list();
    const row = rows.find((r) => r.current);
    assert(row, "no current row after the run");
    assert.strictEqual(row.name, "Straw desk", `rail should carry the name, got ${JSON.stringify(row)}`);
    assert.strictEqual(row.title, "How wet?", "the auto title still records the first question");
    const loaded = await web.sessions.load(row.id);
    assert.strictEqual(loaded.brief, "You are the substrate specialist for this farm.", "brief did not survive the run");
    assert.strictEqual(loaded.name, "Straw desk");
    return "name and brief persist across a run";
  });

  await check("a run with a brief sends it as the first system message", async () => {
    let body = null;
    const fetchImpl = async (url, init = {}) => {
      const u = String(url);
      if (u.startsWith("/app/owui/api/chat/completions")) return new Response(null, { status: 404, headers: { server: "Caddy" } });
      if (u.startsWith("/app/gw/v1/chat/completions")) {
        body = JSON.parse(init.body);
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\ndata: [DONE]\n`, { status: 200 });
      }
      return new Response(null, { status: 404, headers: { server: "Caddy" } });
    };
    const { crowe: web } = loadWebSurface({ fetchImpl });
    await web.agent.run([{ role: "user", content: "hi" }], "main", { brief: "Answer as the grower.", context: "block 12: colonizing" });
    assert(body, "no request reached the gateway");
    assert.strictEqual(body.messages[0].role, "system");
    assert(/Answer as the grower\./.test(body.messages[0].content), `brief missing from the first system message: ${body.messages[0].content}`);
    // The brief is who is speaking; the records are what the world looks like.
    // Both are system messages and the brief comes first, as in the harness.
    assert.strictEqual(body.messages[1].role, "system");
    assert(/block 12/.test(body.messages[1].content), "context must follow the brief");
    assert.strictEqual(body.messages[2].role, "user");
    return "brief first, then context";
  });

  await check("update refuses unknown fields and caps the brief", async () => {
    const { crowe: web } = loadWebSurface({ fetchImpl: chatsEdge({ open: false }) });
    const { id } = await web.sessions.new();
    await web.sessions.update(id, { name: "n", brief: "b", token: "sk-live-no", role: "admin" });
    await web.agent.run([{ role: "user", content: "q" }], "main");
    const loaded = await web.sessions.load((await web.sessions.list()).find((r) => r.current).id);
    assert(!("token" in loaded) && !("role" in loaded), "unknown fields were persisted onto the session");
    const long = await web.sessions.update(loaded.id, { brief: "x".repeat(10_000) });
    assert(long.ok && long.brief.length <= 4000, `brief was not capped: ${long.brief && long.brief.length}`);
    return "allowlisted, capped";
  });

  await check("the renderer sends the session brief on every turn and draws the editor", () => {
    // Held by field name, not copy. The bridges are held to sessions.update by
    // the parity walk above; this is the one place the renderer has to hand
    // the brief to agent.run and give the person somewhere to write it.
    const src = read("renderer/renderer.js");
    assert(/runOpts\.brief\s*=\s*sessionMeta\.brief/.test(src), "renderer does not pass the session brief to agent.run");
    assert(/window\.crowe\.sessions\.update\(/.test(src), "renderer never calls sessions.update");
    assert(/class="sess-meta"/.test(src) || /className\s*=\s*"sess-meta"/.test(src), "no session name/brief editor in the drawer");
    for (const bridge of ["renderer/web-bridge.js", "mobile/src/mobile-bridge.js", "main.js"]) {
      const b = read(bridge);
      assert(/brief/.test(b) && /(persona|role:\s*"system")/.test(b), `${bridge} does not carry the brief into the system prompt`);
    }
    return "renderer and three bridges";
  });

  // ─── The edge that has not opened OWUI ────────────────────────────────────

  await check("when the edge 404s the OWUI path, chat answers through the gateway", async () => {
    // Production on 2026-08-15: /app/owui/api/chat/completions is a bare Caddy
    // 404 for every model; /app/gw/v1/chat/completions is 200. The bridge must
    // route around that rather than fail every turn until the edge is fixed.
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      const u = String(url);
      calls.push(u);
      // A real Caddy 404: null body (so no content-type is synthesised) and the
      // server header Caddy sets. new Response("") would add text/plain, which
      // is not what the edge sends and would mask the case being tested.
      if (u.startsWith("/app/owui/api/chat/completions")) return new Response(null, { status: 404, headers: { server: "Caddy" } });
      if (u.startsWith("/app/gw/v1/chat/completions")) {
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "via gateway" } }] })}\ndata: [DONE]\n`, { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    const { crowe: web } = loadWebSurface({ fetchImpl });
    const first = await web.agent.run([{ role: "user", content: "hi" }], "main");
    assert.strictEqual(first.text, "via gateway", `first run: ${JSON.stringify(first)}`);
    const second = await web.agent.run([{ role: "user", content: "again" }], "main");
    assert.strictEqual(second.text, "via gateway");
    const owuiCalls = calls.filter((u) => u.startsWith("/app/owui/api/chat/completions")).length;
    assert.strictEqual(owuiCalls, 1, `OWUI probed ${owuiCalls} times; after one bare 404 it should be remembered for the page`);
    return "falls back once, remembers";
  });

  await check("a JSON 404 from OWUI is an OWUI error, not an unopened edge", async () => {
    // OWUI itself answers 404 with a JSON detail for an unknown model. That is
    // a real error to surface, not a reason to abandon the path.
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (String(url).startsWith("/app/owui/api/chat/completions")) {
        return new Response(JSON.stringify({ detail: "Model not found" }), { status: 404, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200 });
    };
    const { crowe: web } = loadWebSurface({ fetchImpl });
    let err = null;
    try { await web.agent.run([{ role: "user", content: "hi" }], "main", { model: "nope" }); } catch (e) { err = e; }
    assert(err && /404/.test(err.message) && /Model not found/.test(err.message), `expected the OWUI detail surfaced, got ${err && err.message}`);
    assert(!calls.some((u) => u.startsWith("/app/gw/v1/chat/completions")), "must not fall back to the gateway on an OWUI-level 404");
    return "surfaced, no fallback";
  });

  // ─── Refusals and escalations ─────────────────────────────────────────────

  await check("a refused capability resolves in the shape its call site reads", async () => {
    // The renderer awaits these without a catch (pty.start at renderer.js:724,
    // fs.list at 1651). A rejection there is an unhandled throw and a panel
    // stuck on "starting"; the mobile bridge resolves, and so must this one.
    const { crowe: web } = loadWebSurface();
    const pty = await web.pty.start({ id: "t1", cols: 80, rows: 24 });
    assert(pty && pty.ok === false && pty.error, `pty.start shape: ${JSON.stringify(pty)}`);
    const ls = await web.fs.list("/");
    assert(ls && Array.isArray(ls.entries) && ls.entries.length === 0 && ls.error, `fs.list shape: ${JSON.stringify(ls)}`);
    const st = await web.git.status();
    assert(st && st.repo === false && st.error, `git.status shape: ${JSON.stringify(st)}`);
    for (const arr of [web.fs.walk(), web.fs.pick(), web.git.log(), web.git.branches()]) {
      assert(Array.isArray(await arr), "an array-returning method must still return an array");
    }
    return "resolved, not rejected";
  });

  await check("a refusal a Workspace can satisfy carries the offer to open one", async () => {
    const { crowe: web } = loadWebSurface();
    for (const [name, p] of [["pty.start", web.pty.start({})], ["fs.list", web.fs.list("/")], ["git.status", web.git.status()]]) {
      const r = await p;
      assert(r.remedy && r.remedy.kind === "workspace", `${name} carries no workspace remedy`);
      assert(/^https:\/\/croweos\.com\//.test(r.remedy.url), `${name} remedy points at ${r.remedy.url}`);
      assert(r.remedy.label, `${name} remedy has no label`);
    }
    return "terminal, files, git escalate to croweos.com";
  });

  await check("a refusal nothing can satisfy carries no remedy", async () => {
    // Plugins run MCP servers as local processes; a Workspace does not change
    // that for the browser tab. Offering one would be a remedy that does not
    // remedy, which is worse than the plain refusal.
    const { crowe: web } = loadWebSurface();
    const r = await web.plugins.enable("x");
    assert(r && r.error && !r.remedy, `plugins.enable: ${JSON.stringify(r)}`);
    return "plain refusal";
  });

  await check("the renderer shows a remedy where it shows the reason", () => {
    // Additive on Electron: the preload never sets `remedy`, so both sites are
    // inert there. Matched on the field name rather than the copy, so rewording
    // the offer does not fail this.
    const src = read("renderer/renderer.js");
    const term = src.slice(src.indexOf("window.crowe.pty.start({id:p.id"));
    assert(/remedy/.test(term.slice(0, 600)), "terminal panel does not print the remedy under the refusal");
    const tree = src.slice(src.indexOf("async function loadTree("));
    assert(/remedy/.test(tree.slice(0, 1200)), "files tree does not offer the remedy");
    return "terminal and files";
  });

  // ─── Rooms ────────────────────────────────────────────────────────────────

  await check("the bundled engine is the engine in rooms/, byte for byte", () => {
    // build-rooms-web.js wraps the sources verbatim. If either source appears
    // in the bundle in any edited form, the web is running a second engine.
    const bundle = read("renderer/rooms-web.js");
    for (const src of ["rooms/engine.js", "rooms/registry.js"]) {
      const body = read(src).split("\n").map((l) => (l.length ? "    " + l : l)).join("\n");
      assert(bundle.includes(body), `${src} is not embedded verbatim in renderer/rooms-web.js`);
    }
    return "verbatim";
  });

  await check("the web roster is the desktop roster", () => {
    const { crowe: web } = loadWebSurface();
    const registry = require(path.join(root, "rooms", "registry.js"));
    return web.rooms.agents().then(({ agents, templates }) => {
      assert.strictEqual(agents.length, registry.listAgents().length, "agent count differs");
      assert.strictEqual(templates.length, registry.listTemplates().length, "template count differs");
      return `${agents.length} agents, ${templates.length} templates`;
    });
  });

  await check("a room turn is attributed to the seat that spoke, on the edge", async () => {
    // Two seats, one addressed message. The engine decides who runs; the
    // bridge has to call the edge once per addressed seat, hand it the seat's
    // own model and brief, and put the answer in the transcript under that
    // seat's id. Nothing here mocks the engine.
    const edge = fakeEdge(["Pasteurize; the pressure vessel is the expense.", "Sterilize; the contam rate is the expense."]);
    const { crowe: web } = loadWebSurface({ fetchImpl: edge });
    const { agents } = await web.rooms.agents();
    const [a, b] = agents.slice(0, 2).map((x) => x.id);
    const made = await web.rooms.create({ title: "straw", agentIds: [a, b], budgetUsd: 1 });
    assert(made.room && made.room.id, `create failed: ${JSON.stringify(made)}`);
    assert.strictEqual(made.room.tier, "readonly", "a web room must clamp to readonly (Gate 4)");

    const out = await web.rooms.say(made.room.id, `@room pasteurize or sterilize straw?`);
    assert(out.ran && out.ran.length === 2, `expected two seats to run, got ${JSON.stringify(out.ran)}`);
    assert(out.ran.every((r) => r.ok), `a seat failed: ${JSON.stringify(out.ran)}`);
    assert.strictEqual(edge.calls.length, 2, `edge was called ${edge.calls.length} times for two seats`);

    // Each call carried the seat's brief as the system message.
    for (const c of edge.calls) {
      assert.strictEqual(c.messages[0].role, "system", "seat brief missing");
      assert(/You are /.test(c.messages[0].content), "seat brief did not name the agent");
    }

    const loaded = await web.rooms.load(made.room.id);
    const authors = loaded.messages.filter((m) => m.kind === "reply").map((m) => m.author).sort();
    assert.deepStrictEqual(authors, [a, b].sort(), `replies attributed to ${authors}`);
    assert(loaded.room.spentUsd === 0, "web rooms report cost 0 until the ledger prices them");
    const calls = loaded.room.agents.map((s) => s.cost.calls);
    assert.deepStrictEqual(calls, [1, 1], `per-seat call counts ${calls}`);
    return `2 seats, 2 calls, attributed`;
  });

  await check("seat events carry roomId and roomAgent for the roster", async () => {
    const edge = fakeEdge(["one"]);
    const { crowe: web } = loadWebSurface({ fetchImpl: edge });
    const { agents } = await web.rooms.agents();
    const made = await web.rooms.create({ title: "ev", agentIds: [agents[0].id] });
    const seen = [];
    const off = web.agent.onEvent((ev) => seen.push(ev));
    await web.rooms.say(made.room.id, "hello");
    off();
    const types = seen.map((e) => e.type);
    for (const t of ["route", "assistant_delta", "final"]) assert(types.includes(t), `missing ${t} event: ${types}`);
    for (const e of seen) {
      assert.strictEqual(e.roomId, made.room.id, "event missing roomId");
      assert.strictEqual(e.roomAgent, agents[0].id, "event missing roomAgent");
      assert.strictEqual(e.agentId, `room:${made.room.id}:${agents[0].id}`, "seat id must be room:<room>:<agent>");
    }
    return `${seen.length} events stamped`;
  });

  await check("a failed seat is marked failed and does not enter the transcript", async () => {
    const edge = fakeEdge([new Error("upstream fell over"), "fine"]);
    const { crowe: web } = loadWebSurface({ fetchImpl: edge });
    const { agents } = await web.rooms.agents();
    const [a, b] = agents.slice(0, 2).map((x) => x.id);
    const made = await web.rooms.create({ title: "fail", agentIds: [a, b] });
    const out = await web.rooms.say(made.room.id, "@room go");
    const failed = out.ran.filter((r) => !r.ok);
    assert.strictEqual(failed.length, 1, `expected one failed seat, got ${JSON.stringify(out.ran)}`);
    const loaded = await web.rooms.load(made.room.id);
    const replies = loaded.messages.filter((m) => m.kind === "reply");
    assert.strictEqual(replies.length, 1, "the failed seat's error must not be in the transcript");
    const seat = loaded.room.agents.find((s) => s.agentId === failed[0].agentId);
    assert.strictEqual(seat.state, "failed", `seat state ${seat.state}`);
    return "contained";
  });

  await check("rooms persist across a reload and stay out of the sessions rail", async () => {
    const edge = fakeEdge(["x"]);
    const first = loadWebSurface({ fetchImpl: edge });
    const { agents } = await first.crowe.rooms.agents();
    const made = await first.crowe.rooms.create({ title: "persist", agentIds: [agents[0].id] });
    await first.crowe.rooms.say(made.room.id, "hi");
    // Same storage, fresh bridge: what a page reload is.
    const raw = first.store.get("crowe.web.sessions");
    const second = loadWebSurface({ fetchImpl: edge });
    second.store.set("crowe.web.sessions", raw);
    const list = await second.crowe.rooms.list();
    assert(list.some((r) => r.id === made.room.id), "room not listed after reload");
    const loaded = await second.crowe.rooms.load(made.room.id);
    assert.strictEqual(loaded.messages.length, 2, "transcript did not survive reload");
    const threads = await second.crowe.sessions.list();
    assert(!threads.some((s) => s.id === made.room.id), "a room leaked into the sessions rail");
    return "survives reload, separate rail";
  });

  await check("without the engine the surface still answers, with a reason", async () => {
    const { crowe: web } = loadWebSurface({ rooms: false });
    const made = await web.rooms.create({ title: "x", agentIds: ["crowe-logic"] });
    assert(made.error && /engine/.test(made.error), `expected a stated reason, got ${JSON.stringify(made)}`);
    assert.deepStrictEqual(await web.rooms.list(), []);
    return "stated reason";
  });

  // ─── The web entry point ──────────────────────────────────────────────────

  await check("app.html loads web-bridge before renderer", () => {
    const html = read("renderer/app.html");
    const bridge = html.indexOf("web-bridge.js");
    const renderer = html.indexOf("renderer.js");
    assert(bridge !== -1, "app.html does not load web-bridge.js");
    assert(renderer !== -1, "app.html does not load renderer.js");
    assert(bridge < renderer, "web-bridge.js must define window.crowe before renderer.js reads it");
    return "order correct";
  });

  await check("app.html does not claim to be generated", () => {
    // scripts/gen-preview.js produces renderer/preview.html and nothing else, so
    // a "regenerate instead of editing" note points at a script that cannot.
    const html = read("renderer/app.html");
    const gen = read("scripts/gen-preview.js");
    assert(!/GENERATED FILE/i.test(html), "app.html claims to be generated but nothing generates it");
    assert(!/app\.html/.test(gen), "gen-preview.js now touches app.html; update this check and the header");
    return "header matches reality";
  });

  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
