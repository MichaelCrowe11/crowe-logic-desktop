#!/usr/bin/env node
// Keeps the mobile port honest against the desktop it was copied from.
//
//   node scripts/test-mobile-bridge.js
//
// mobile/ ships the desktop renderer unmodified and re-implements the bridge
// underneath it. That buys one codebase for the UI and costs three couplings
// that nothing else would notice breaking:
//
//   1. the shape of window.crowe, which preload.js defines and the renderer
//      calls — a method the phone forgot to implement is a TypeError at a tap
//   2. the routing table, copied out of harness.js because the harness is Node
//      and cannot be loaded in a webview — a role added there and not here
//      sends the same question to a different expert on the phone
//   3. the sentences mobile-ui.js rewrites in the renderer's first-run copy,
//      which are matched literally — reword one in renderer.js and the phone
//      silently goes back to offering a terminal it does not have
//
// Everything below is one of those three, plus the www build's own transforms.
// Run under plain node; no Electron, no browser, no network.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let failures = 0;
// Awaited, so a rejection from an async check fails the run. An earlier draft
// called fn() and moved on: every assertion inside an async check rejected into
// nothing and the suite passed by not looking.
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

// mobile-bridge.js runs in a webview. Give it the smallest globals it touches
// at load: storage it can write to, a fetch that fails the way an offline
// device does, and no Capacitor, which is the browser-preview path.
function loadMobileSurface(fetchImpl) {
  const store = new Map();
  const win = {
    Capacitor: null,
    crypto: require("crypto").webcrypto,
    CROWE_GROW: require(path.join(root, "grow-schema.js")),
    open: () => {},
  };
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const sandbox = {
    window: win, localStorage,
    document: { createElement: () => ({ appendChild() {}, style: {}, classList: { add() {} } }) },
    fetch: fetchImpl || (() => Promise.reject(new TypeError("offline"))),
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    performance: { now: () => 0 },
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
  };
  const src = read("mobile/src/mobile-bridge.js");
  new Function(...Object.keys(sandbox), src)(...Object.values(sandbox));
  assert(win.crowe, "mobile-bridge.js did not install window.crowe");
  return win.crowe;
}

// A gateway that answers in SSE, the way the real one does when it honours
// stream:true. `turns` is one payload list per round; the round with tool_calls
// is what drives the loop round a second time.
function fakeGateway(turns) {
  let round = 0;
  return async (url, init = {}) => {
    if (!String(url).includes("/api/gateway/chat")) return new Response("{}", { status: 200 });
    const turn = turns[Math.min(round++, turns.length - 1)];
    const body = turn.map((d) => `data: ${JSON.stringify(d)}\n`).join("") + "data: [DONE]\n";
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
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

// Sequential and awaited: the checks read as a transcript of one run, and an
// async assertion that throws lands in the same failure count as a sync one.
(async () => {
  console.log("mobile bridge");
  const desktop = loadPreloadSurface();
  const mobile = loadMobileSurface();

  await check("every desktop bridge method exists on mobile", () => {
    const missing = methodPaths(desktop).filter((p) => {
      const [group, name] = p.split(".");
      const target = name ? mobile[group] && mobile[group][name] : mobile[group];
      return typeof target !== "function";
    });
    assert(!missing.length, `mobile is missing: ${missing.join(", ")}`);
    return `${methodPaths(desktop).length} methods`;
  });

  await check("mobile adds nothing the renderer cannot already call", () => {
    // Extra methods are not a failure in themselves, but an accidental one is a
    // method the desktop will never grow — so they are declared here by name.
    const ALLOWED_EXTRA = [];
    const extra = methodPaths(mobile).filter((p) => !methodPaths(desktop).includes(p) && !ALLOWED_EXTRA.includes(p));
    assert(!extra.length, `undeclared mobile-only methods: ${extra.join(", ")}`);
  });

  await check("every call answers with a promise, every subscription with a function", () => {
    const wrong = [];
    for (const p of methodPaths(mobile)) {
      const [group, name] = p.split(".");
      const fn = name ? mobile[group][name] : mobile[group];
      const subscription = /(^|\.)on[A-Z]/.test(p);
      let result;
      try { result = fn(subscription ? () => {} : undefined); } catch (e) { wrong.push(`${p} threw ${e.message}`); continue; }
      if (subscription) {
        // ipcRenderer.on returns its remover synchronously; a promise here would
        // leave the renderer holding a thenable it tries to call at teardown.
        if (typeof result !== "function") wrong.push(`${p} did not return an unsubscribe function`);
      } else if (!result || typeof result.then !== "function") {
        wrong.push(`${p} did not return a promise`);
      }
    }
    assert(!wrong.length, wrong.join("\n"));
    return `${methodPaths(mobile).length} methods`;
  });

  await check("refused capabilities say why instead of failing empty", async () => {
    const cases = [["git.status", await mobile.git.status()], ["pty.start", await mobile.pty.start({})],
                   ["fs.read", await mobile.fs.read("x")], ["plugins.enable", await mobile.plugins.enable("x")]];
    for (const [name, result] of cases) {
      assert(result && typeof result.error === "string" && result.error.length > 20,
        `${name} answered ${JSON.stringify(result)} — a refusal has to explain itself`);
    }
  });

  await check("the update banner stays hidden", async () => {
    // renderer.js hides it for idle/current/dev and draws an empty bar for
    // anything else, so the status the phone reports has to be one of those.
    const state = await mobile.update.state();
    assert(["idle", "current", "dev"].includes(state.status), `update.state() reported "${state.status}"`);
  });

  await check("keys.list returns { encrypted, providers }", async () => {
    const result = await mobile.keys.list();
    assert(Array.isArray(result.providers) && result.providers.length, "no providers array — the Key Manager renders empty");
    assert(typeof result.encrypted === "boolean", "encrypted flag missing");
    assert(read("renderer/renderer.js").includes("result.encrypted?"), "renderKeyManager no longer reads result.encrypted");
  });

  // ─── The agent loop ──────────────────────────────────────────────────────────
  /* The one path with no desktop twin to compare against: main.js delegates to
     harness.runAgent, and the phone runs its own smaller loop. What has to hold
     is the event stream, because the transcript, the HUD, the agent panels and
     the workflow runner all read it — and every one of them reads a different
     part, so a missing event type is a surface that goes quiet rather than an
     error anyone sees. */

  console.log("agent loop");
  await check("a streamed turn with a tool call emits the events the UI reads", async () => {
    const bridge = loadMobileSurface(fakeGateway([
      // Round one: a little prose, then a call to write the flush down.
      [{ delta: { content: "Logging that flush. " } },
       { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "log_grow", arguments: '{"type":"flushes","record":{"block":"260722-01","n":1,"date":"2026-07-30","weight":"4.2","grade":"A"}}' } }] } },
       { usage: { prompt_tokens: 120, completion_tokens: 40 } }],
      // Round two: the answer, no more tools.
      [{ delta: { content: "Logged. That is 4.2 lb off 260722-01." } },
       { usage: { prompt_tokens: 260, completion_tokens: 22 } }],
    ]));
    await bridge.setConfig({ token: "header." + Buffer.from('{"email":"grower@example.com","exp":9999999999}').toString("base64") + ".sig" });

    const seen = [];
    const off = await bridge.agent.onEvent((ev) => seen.push(ev));
    const result = await bridge.agent.run([{ role: "user", content: "Log 4.2 lb off 260722-01, flush 1, grade A, today." }]);
    off();

    const types = seen.map((e) => e.type);
    for (const want of ["route", "assistant_delta", "assistant", "tool_call", "tool_result", "telemetry", "final"]) {
      assert(types.includes(want), `no ${want} event — the stream was: ${types.join(", ")}`);
    }
    assert(seen.every((e) => e.agentId === "main"), "an event went out without an agentId; every surface filters on it");
    assert(result.done && /4\.2 lb/.test(result.text), `the turn returned ${JSON.stringify(result)}`);

    const call = seen.find((e) => e.type === "tool_call");
    assert(call.name === "log_grow" && call.args.type === "flushes", `tool_call carried ${JSON.stringify(call)}`);
    const rows = await bridge.grow.list("flushes");
    assert(rows.length === 1 && rows[0].weight === "4.2", `the tool did not write the record: ${JSON.stringify(rows)}`);
    const sessions = await bridge.sessions.list();
    assert(sessions.length === 1, "the turn was not persisted to a session");

    const telemetry = seen.filter((e) => e.type === "telemetry").pop();
    assert(telemetry.promptTokens === 380 && telemetry.completionTokens === 62,
      `the meter did not accumulate across rounds: ${JSON.stringify(telemetry)}`);
    return `${types.length} events over 2 rounds`;
  });

  await check("the cultivation pin routes to the grower, not the router's guess", async () => {
    const bridge = loadMobileSurface(fakeGateway([[{ delta: { content: "ok" } }]]));
    await bridge.setConfig({ token: "a.b.c" });
    const seen = [];
    const off = await bridge.agent.onEvent((ev) => seen.push(ev));
    await bridge.agent.run([{ role: "user", content: "how is the weather" }], "main", { role: "cultivation" });
    off();
    const route = seen.find((e) => e.type === "route");
    assert(route.model === "crowelm-grower", `pinned cultivation routed to ${route.model}`);
    assert(/pinned/.test(route.reason), `the route did not report the pin: ${route.reason}`);
  });

  await check("a read-only tier is not handed a tool that writes", async () => {
    const bridge = loadMobileSurface(fakeGateway([[{ delta: { content: "ok" } }]]));
    await bridge.setConfig({ token: "a.b.c", autonomy: "readonly" });
    await bridge.agent.run([{ role: "user", content: "log something" }]);
    assert(!(await bridge.grow.list("log")).length, "a read-only turn still wrote a record");

    // The tier decides which tools are advertised, but a model that calls one
    // anyway — out of an older turn, or its own invention — has to be refused
    // at the tool rather than trusted to have read the list.
    const bridge2 = loadMobileSurface(fakeGateway([
      [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "log_grow", arguments: '{"type":"log","record":{"date":"2026-07-30","subject":"x","entry":"y"}}' } }] } }],
      [{ delta: { content: "understood" } }],
    ]));
    await bridge2.setConfig({ token: "a.b.c", autonomy: "readonly" });
    const events = [];
    const off2 = await bridge2.agent.onEvent((ev) => events.push(ev));
    await bridge2.agent.run([{ role: "user", content: "log something" }]);
    off2();
    const refusal = events.find((e) => e.type === "tool_result");
    assert(refusal && refusal.status === "blocked", `log_grow was not blocked: ${JSON.stringify(refusal)}`);
    assert(!(await bridge2.grow.list("log")).length, "the blocked call wrote the record anyway");
  });

  await check("an unsigned-in turn says so instead of failing silently", async () => {
    const bridge = loadMobileSurface(fakeGateway([[{ delta: { content: "never reached" } }]]));
    const seen = [];
    const off = await bridge.agent.onEvent((ev) => seen.push(ev));
    const result = await bridge.agent.run([{ role: "user", content: "hello" }]);
    off();
    const error = seen.find((e) => e.type === "error");
    assert(error && /signed in/i.test(error.text), `the error event was ${JSON.stringify(error)}`);
    assert(!result.done, "an unauthenticated turn reported success");
  });

  // ─── Routing parity with the harness ─────────────────────────────────────────

  console.log("routing");
  const harnessSrc = read("harness.js");
  const bridgeSrc = read("mobile/src/mobile-bridge.js");
  const roleLines = (src) => (src.match(/\{ role: "[a-z-]+", match: \/.+\/i \},?/g) || []).map((l) => l.replace(/,$/, ""));

  await check("the role table is identical to the harness's", () => {
    const fromHarness = roleLines(harnessSrc), fromBridge = roleLines(bridgeSrc);
    assert(fromHarness.length, "no role table found in harness.js — this check has gone stale");
    assert(fromBridge.length === fromHarness.length,
      `harness has ${fromHarness.length} roles, mobile has ${fromBridge.length}`);
    for (let i = 0; i < fromHarness.length; i++) {
      assert(fromBridge[i] === fromHarness[i], `role ${i + 1} differs:\n  harness: ${fromHarness[i]}\n  mobile:  ${fromBridge[i]}`);
    }
    return `${fromHarness.length} roles`;
  });

  await check("the bridge model map is identical to the harness's", () => {
    const grab = (src) => (src.match(/BRIDGE_ROLE_MODEL = (\{[^}]*\})/) || [])[1];
    assert(grab(harnessSrc), "BRIDGE_ROLE_MODEL not found in harness.js");
    assert(grab(bridgeSrc) === grab(harnessSrc), `harness: ${grab(harnessSrc)}\nmobile:  ${grab(bridgeSrc)}`);
  });

  await check("the routed-role list is identical to main's", () => {
    // This one lives in main.js, not the harness: it is the list the desktop
    // resolves for the Home surface's routing card, which the phone renders too.
    const grab = (src) => (src.match(/ROUTED_ROLES = (\[[^\]]*\])/) || [])[1];
    const fromMain = grab(read("main.js"));
    assert(fromMain, "ROUTED_ROLES not found in main.js");
    assert(grab(bridgeSrc) === fromMain, `main.js: ${fromMain}\nmobile:  ${grab(bridgeSrc)}`);
  });

  // ─── Copy the phone rewrites ─────────────────────────────────────────────────

  console.log("copy");
  const uiSrc = read("mobile/src/mobile-ui.js");
  const rendererSrc = read("renderer/renderer.js");

  await check("every sentence mobile-ui rewrites still exists in the renderer", () => {
    const table = uiSrc.slice(uiSrc.indexOf("const COPY = ["), uiSrc.indexOf("function mobiliseCopy"));
    const needles = [...table.matchAll(/\["([^"]+)",/g)].map((m) => m[1]);
    assert(needles.length >= 3, "the COPY table could not be read — this check has gone stale");
    const missing = needles.filter((n) => !rendererSrc.includes(n));
    assert(!missing.length, `renderer.js no longer says:\n  ${missing.join("\n  ")}`);
    return `${needles.length} sentences`;
  });

  await check("the welcome the phone replaces is still the one in index.html", () => {
    const html = read("renderer/index.html");
    assert(html.includes('class="welcome"'), "the welcome block is gone from index.html");
    assert((html.match(/class="chip"/g) || []).length >= 3, "the welcome no longer offers three chips");
  });

  // ─── The www build ───────────────────────────────────────────────────────────

  console.log("www build");
  execFileSync(process.execPath, [path.join(root, "mobile", "scripts", "build-www.js")], { stdio: "pipe" });
  const built = read("mobile/www/index.html");

  await check("the bridge loads before anything that reads it", () => {
    const at = (needle) => built.indexOf(needle);
    assert(at("mobile-bridge.js") > 0, "mobile-bridge.js was not injected");
    assert(at("mobile-bridge.js") < at("renderer.js"), "the bridge loads after renderer.js");
    assert(at("grow-schema.js") < at("mobile-bridge.js"), "the grow schema loads after the bridge that reads it");
    assert(at("renderer.js") < at("mobile-ui.js"), "the phone chrome loads before the renderer it decorates");
  });

  await check("nothing reaches for node_modules", () => {
    assert(!built.includes("node_modules"), "a node_modules path survived into www/index.html");
    const missing = ["viewport", "viewport-fit=cover", "mobile.css", "manifest.webmanifest"].filter((s) => !built.includes(s));
    assert(!missing.length, `www/index.html is missing: ${missing.join(", ")}`);
  });

  await check("the grow schema is browser-loadable", () => {
    const wrapped = read("mobile/www/grow-schema.js");
    const win = {};
    new Function("window", wrapped)(win);
    assert(win.CROWE_GROW && win.CROWE_GROW.GROW_TYPES.size, "the wrapped schema exposed no record types");
    return `${win.CROWE_GROW.GROW_TYPES.size} record types`;
  });

  await check("the OAuth redirect matches what the native projects registered", () => {
    const redirect = (bridgeSrc.match(/DEFAULT_REDIRECT = "([^"]+)"/) || [])[1];
    assert(redirect, "DEFAULT_REDIRECT not found in the bridge");
    const scheme = redirect.split("://")[0];
    const appId = JSON.parse(read("mobile/capacitor.config.json")).appId;
    assert(scheme === appId, `the redirect scheme (${scheme}) is not the app id (${appId})`);
    for (const [file, needle] of [
      ["mobile/ios/App/App/Info.plist", `<string>${scheme}</string>`],
      ["mobile/android/app/src/main/AndroidManifest.xml", `android:scheme="${scheme}"`],
    ]) {
      if (!fs.existsSync(path.join(root, file))) continue;   // platform not added in this checkout
      assert(read(file).includes(needle), `${file} does not register ${scheme}`);
    }
    return redirect;
  });

  console.log(failures ? `\n${failures} check(s) failed` : "\nall mobile bridge checks passed");
  process.exit(failures ? 1 : 0);
})();
