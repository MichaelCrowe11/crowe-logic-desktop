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
    console,
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
