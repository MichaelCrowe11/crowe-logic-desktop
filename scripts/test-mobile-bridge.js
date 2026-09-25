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

const NOTICE_VERSION = Number((/DATA_NOTICE_VERSION = (\d+);/.exec(read("mobile/src/mobile-bridge.js")) || [])[1]);
if (!NOTICE_VERSION) throw new Error("mobile-bridge.js no longer declares DATA_NOTICE_VERSION");

// mobile-bridge.js runs in a webview. Give it the smallest globals it touches
// at load: storage it can write to, a fetch that fails the way an offline
// device does, and no Capacitor, which is the browser-preview path.
function loadMobileSurface(fetchImpl, capacitor, opts = {}) {
  const store = new Map(Object.entries(opts.seed || {}));
  const storageAccess = [];
  // The data notice gate: mobile-bridge.js refuses every gateway path until
  // config.dataConsent carries the current DATA_NOTICE_VERSION. Every check
  // here runs as a phone whose person has already allowed it, except the one
  // that proves the gate holds, which passes { consent: false }.
  const CONSENT = { version: NOTICE_VERSION, at: "2026-09-19T00:00:00.000Z" };
  if (opts.consent !== false) store.set("crowe:data-consent-v2", JSON.stringify({ dataConsent: CONSENT }));
  // A check that hands the bridge a Preferences plugin keeps its own map, so
  // the same allowance is merged into what that plugin answers for "config".
  if (opts.consent !== false && capacitor && capacitor.Plugins && capacitor.Plugins.Preferences) {
    const P = capacitor.Plugins.Preferences, get = P.get.bind(P);
    P.get = async (args) => {
      const r = await get(args);
      if (!args || args.key !== "data-consent-v2") return r;
      const cfg = r && r.value ? JSON.parse(r.value) : {};
      if (!cfg.dataConsent) cfg.dataConsent = CONSENT;
      return { value: JSON.stringify(cfg) };
    };
  }
  const win = {
    Capacitor: capacitor || null,
    crypto: require("crypto").webcrypto,
    CROWE_GROW: require(path.join(root, "grow-schema.js")),
    open: () => {},
  };
  const localStorage = {
    getItem: (k) => { storageAccess.push(["get", k]); return store.has(k) ? store.get(k) : null; },
    setItem: (k, v) => { storageAccess.push(["set", k]); return store.set(k, String(v)); },
    removeItem: (k) => { storageAccess.push(["remove", k]); return store.delete(k); },
  };
  const sandbox = {
    window: win, localStorage,
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    document: { createElement: () => ({ appendChild() {}, style: {}, classList: { add() {} } }) },
    fetch: fetchImpl || (() => Promise.reject(new TypeError("offline"))),
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    performance: { now: () => 0 },
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
  };
  for (const file of ["rooms-web.js", "council.js", "rooms-local.js"])
    new Function("window", "setInterval", read("renderer/" + file))(win, () => 0);
  if (opts.roomHost) win.CroweLocalRooms.create = opts.roomHost;
  if (opts.vault) new Function("window", read("mobile/src/vault.js"))(win);
  const src = read("mobile/src/mobile-bridge.js");
  new Function(...Object.keys(sandbox), src)(...Object.values(sandbox));
  assert(win.crowe, "mobile-bridge.js did not install window.crowe");
  // The picker grant lives on window.crowePhone, beside window.crowe rather
  // than on it — the surface parity walk below must see exactly the desktop's
  // shape. Exposed for the phone-file checks without widening the surface.
  loadMobileSurface.lastWindow = win;
  loadMobileSurface.lastStore = store;
  loadMobileSurface.lastStorageAccess = storageAccess;
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
    //
    // remote.* is deliberate and phone-only. The desktop owns its workspace
    // directly: main.js forks a pty, walks a real file tree, shells out to git.
    // A phone cannot, so it drives a machine that can, over Tailscale. There is
    // nothing for the desktop to grow here — it is already standing where these
    // calls are trying to reach.
    //
    // mobile.openExternal is the same shape of deliberate. The desktop opens a
    // page by embedding one: the browser panel mounts an Electron <webview> and
    // drives it. That element does not exist in a WKWebView, so the phone hands
    // the address to the system browser instead. There is nothing for the
    // desktop to grow here either — it already has the engine this is standing
    // in for.
    const ALLOWED_EXTRA = ["remote.status", "remote.pair", "remote.run", "mobile.openExternal", "auth.deleteAccount",
      "intents.take", "reminders.list", "reminders.add", "reminders.pending", "reminders.remove", "camera.list", "camera.add", "diag.list", "diag.clear", "diag.note"];
    const extra = methodPaths(mobile).filter((p) => !methodPaths(desktop).includes(p) && !ALLOWED_EXTRA.includes(p));
    assert(!extra.length, `undeclared mobile-only methods: ${extra.join(", ")}`);
  });

  await check("nothing reaches the gateway before the data notice is allowed", async () => {
    const calls = [];
    const bridge = loadMobileSurface(async (url) => { calls.push(String(url)); return new Response("{}", { status: 200 }); }, null, { consent: false });
    const events = [];
    loadMobileSurface.lastWindow.dispatchEvent = (e) => { events.push(e && e.type); return true; };
    const run = await bridge.agent.run([{ role: "user", content: "hello" }]);
    assert(run && run.done === false && /data notice/.test(run.error || ""), `agent.run answered ${JSON.stringify(run)}`);
    const chat = await bridge.chat([{ role: "user", content: "hello" }]);
    assert(chat && /data notice/.test(chat.error || "") && chat.code === "consent", `chat answered ${JSON.stringify(chat)}`);
    assert(!calls.some((u) => u.includes("/api/gateway")), `the gateway was called anyway: ${calls.join(", ")}`);
    assert(events.includes("crowe:consent-needed"), `the notice was not asked for; events: ${events.join(", ")}`);
    // Allowed with an OLDER notice version, it must still refuse: a notice that
    // named a new recipient has to be read again.
    const stale = loadMobileSurface(async (url) => { calls.push(String(url)); return new Response("{}", { status: 200 }); }, null, { consent: false });
    let refused = false;
    try { await loadMobileSurface.lastWindow.crowePhone.setConsent({ dataConsent: { version: NOTICE_VERSION - 1, at: "2026-09-01T00:00:00.000Z" } }, 0); } catch { refused = true; }
    assert(refused, "stale notice update was accepted");
    const again = await stale.chat([{ role: "user", content: "hello" }]);
    assert(again && again.code === "consent", `a stale consent was accepted: ${JSON.stringify(again)}`);
    assert(!calls.some((u) => u.includes("/api/gateway")), "the gateway was called on a stale consent");
    return "refused three times, zero gateway calls";
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
  await check("a plan-gate 403 falls to the free model once, with a plain notice and no error", async () => {
    const asked = [];
    const bridge = loadMobileSurface(async (url, init = {}) => {
      if (!String(url).includes("/api/gateway/chat")) return new Response("{}", { status: 200 });
      const model = JSON.parse(init.body || "{}").model;
      asked.push(model);
      if (model !== "crowelm-flash") {
        return new Response(JSON.stringify({ detail: `Model '${model}' requires personal plan or higher` }),
          { status: 403, headers: { "content-type": "application/json" } });
      }
      const body = [{ delta: { content: "Free tier answer." } }, { usage: { prompt_tokens: 20, completion_tokens: 4 } }]
        .map((d) => `data: ${JSON.stringify(d)}\n`).join("") + "data: [DONE]\n";
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    // Signed in with a tier the mirror accepts, so the 403 path is what gets exercised.
    await bridge.setConfig({ model: "crowelm", token: "header." + Buffer.from('{"email":"grower@example.com","crowe_tier":"pro","exp":9999999999}').toString("base64") + ".sig" });
    const seen = [];
    const off = await bridge.agent.onEvent((ev) => seen.push(ev));
    const result = await bridge.agent.run([{ role: "user", content: "what time is it" }]);
    off();
    assert(asked.join(",") === "crowelm,crowelm-flash", `asked the gateway for: ${asked.join(", ")}`);
    const types = seen.map((e) => e.type);
    assert(types.includes("plan"), `no plan notice — the stream was: ${types.join(", ")}`);
    assert(!types.includes("error"), "the plan gate surfaced as an error instead of a fallback");
    const plan = seen.find((e) => e.type === "plan");
    assert(/personal plan or higher/.test(plan.text) && !/—/.test(plan.text), "plan notice wording");
    assert(result && /Free tier answer/.test(result.text || ""), "the free model's answer did not land");
  });
  await check("a token with no tier claim routes to the free model before the first call", async () => {
    const asked = [];
    const bridge = loadMobileSurface(async (url, init = {}) => {
      if (String(url).includes("/api/gateway/catalog")) {
        return new Response(JSON.stringify({ models: [
          { model: "crowelm", name: "CroweLM", min_plan: "personal" },
          { model: "crowelm-mycelium", name: "CroweLM Mycelium", min_plan: "free-anonymous" },
        ] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (!String(url).includes("/api/gateway/chat")) return new Response("{}", { status: 200 });
      asked.push(JSON.parse(init.body || "{}").model);
      const body = [{ delta: { content: "ok" } }].map((d) => `data: ${JSON.stringify(d)}\n`).join("") + "data: [DONE]\n";
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    await bridge.setConfig({ model: "crowelm", token: "header." + Buffer.from('{"email":"grower@example.com","exp":9999999999}').toString("base64") + ".sig" });
    // catalog.get fires the fetch without awaiting it (the panel renders from
    // cache); give the scripted response a tick to land in the cache.
    await bridge.catalog.get();
    await new Promise((r) => setTimeout(r, 50));
    const seen = [];
    const off = await bridge.agent.onEvent((ev) => seen.push(ev));
    await bridge.agent.run([{ role: "user", content: "what time is it" }]);
    off();
    assert(asked.join(",") === "crowelm-mycelium", `asked the gateway for: ${asked.join(", ")}`);
    assert(seen.some((e) => e.type === "plan"), "no plan notice ahead of the route");
  });
  await check("connector tools ride along to the gateway and their calls are answered through it", async () => {
    // connectors.js exposes window.croweConnectors; the bridge widens the tool list
    // it sends and routes those calls back to the gateway, which holds the grant.
    const bodies = [];
    const gw = fakeGateway([
      [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "google_calendar_list_events", arguments: '{"query":"harvest"}' } }] } },
       { usage: { prompt_tokens: 50, completion_tokens: 10 } }],
      [{ delta: { content: "One event: Harvest at 9." } }, { usage: { prompt_tokens: 90, completion_tokens: 8 } }],
    ]);
    const bridge = loadMobileSurface(async (url, init = {}) => { if (String(url).includes("/api/gateway/chat")) bodies.push(JSON.parse(init.body)); return gw(url, init); });
    const win = loadMobileSurface.lastWindow;
    const acted = [];
    win.croweConnectors = {
      tools: async () => [{ type: "function", function: { name: "google_calendar_list_events", description: "list", parameters: { type: "object", properties: {} } } }],
      owns: (n) => n === "google_calendar_list_events",
      act: async (n, a) => { acted.push([n, a]); return JSON.stringify({ events: [{ summary: "Harvest" }], count: 1 }); },
    };
    await bridge.setConfig({ token: "header." + Buffer.from('{"email":"grower@example.com","exp":9999999999}').toString("base64") + ".sig" });
    const seen = [];
    const off = await bridge.agent.onEvent((ev) => seen.push(ev));
    const result = await bridge.agent.run([{ role: "user", content: "what is on my calendar about the harvest" }]);
    off();
    assert(result.done && /Harvest at 9/.test(result.text), `turn returned ${JSON.stringify(result)}`);
    const names = (bodies[0].tools || []).map((t) => t.function.name);
    assert(names.includes("google_calendar_list_events") && names.includes("open_url") && !names.includes("read_grow"), `tools sent: ${names.join(",")}`);
    assert(acted.length === 1 && acted[0][0] === "google_calendar_list_events" && acted[0][1].query === "harvest", `act saw ${JSON.stringify(acted)}`);
    const toolMsg = bodies[1].messages.find((m) => m.role === "tool");
    assert(toolMsg && /Harvest/.test(toolMsg.content), "the connector result did not go back to the model");
    const tr = seen.find((e) => e.type === "tool_result");
    assert(tr && tr.status === "ok", "no tool_result event for the connector call");
    delete win.croweConnectors;
    return "tools merged, call answered via the gateway, result fed back";
  });
  await check("the vault falls back to Preferences when the Keychain refuses, instead of signing the person out", async () => {
    // vault.js sits in front of the bridge's store for the "config" record. A
    // rejected Keychain read must answer from Preferences and leave the key
    // unmigrated; a rejected write must land in Preferences.
    const load = (vaultStub) => {
      const prefs = new Map([["config", JSON.stringify({ token: "t.o.k", refreshToken: "r" })]]);
      const Preferences = { get: async ({ key }) => ({ value: prefs.has(key) ? prefs.get(key) : null }), set: async ({ key, value }) => { prefs.set(key, value); }, remove: async ({ key }) => { prefs.delete(key); } };
      const win = { Capacitor: { isNativePlatform: () => true, Plugins: { CroweVault: vaultStub, Preferences } } };
      new Function("window", read("mobile/src/vault.js"))(win);
      assert(win.croweVault && win.croweVault.handles("config") && !win.croweVault.handles("grow"), "vault.js did not install croweVault for config only");
      return { vault: win.croweVault, prefs };
    };
    // 1. Keychain refuses every read: Preferences answers, and keeps the record.
    let calls = [];
    let { vault, prefs } = load({ get: async () => { calls.push("get"); throw new Error("keychain read failed: -25300"); }, set: async () => { calls.push("set"); }, remove: async () => {} });
    const v = await vault.get("config");
    assert(v && JSON.parse(v).token === "t.o.k", `a refused Keychain read did not fall back to Preferences: ${v}`);
    assert(prefs.has("config"), "the fallback read removed the record from Preferences");
    // 2. Keychain refuses the write: Preferences takes it.
    ({ vault, prefs } = load({ get: async () => ({ value: null }), set: async () => { throw new Error("keychain write failed: -34018"); }, remove: async () => {} }));
    await vault.set("config", JSON.stringify({ token: "new" }));
    assert(JSON.parse(prefs.get("config")).token === "new", "a refused Keychain write was lost");
    // 3. Healthy Keychain: the first read migrates Preferences into it and clears Preferences.
    const kc = new Map();
    ({ vault, prefs } = load({ get: async ({ key }) => ({ value: kc.has(key) ? kc.get(key) : null }), set: async ({ key, value }) => { kc.set(key, value); }, remove: async ({ key }) => { kc.delete(key); } }));
    const m = await vault.get("config");
    assert(m && JSON.parse(m).token === "t.o.k" && kc.has("config") && !prefs.has("config"), "a healthy Keychain did not take over the record on first read");
    return "refused read -> Preferences (kept); refused write -> Preferences; healthy -> migrated once";
  });

  await check("the share inbox reads the App Group natively and never switches the Preferences group", async () => {
    // The Capacitor Preferences plugin never opens a UserDefaults suite: its
    // "group" is a key prefix on the standard defaults, and configure() swaps
    // one shared instance. So the extension's note is read in Swift, and the
    // two sides must agree on the suite and the key.
    const inbox = read("mobile/src/share-inbox.js");
    const vaultSwift = read("mobile/ios/App/App/CroweVault.swift");
    const shareSwift = read("mobile/ios/App/CroweShare/ShareViewController.swift");
    assert(/Vault\.takeShared\(\)/.test(inbox), "share-inbox.js must read the note through CroweVault.takeShared");
    assert(!/Preferences\.configure/.test(inbox), "share-inbox.js must never call Preferences.configure");
    assert(/name: "takeShared"/.test(vaultSwift) && /UserDefaults\(suiteName: shareGroup\)/.test(vaultSwift), "CroweVault.swift must declare takeShared over the App Group suite");
    const group = /shareGroup = "([^"]+)"/.exec(vaultSwift), key = /shareKey = "([^"]+)"/.exec(vaultSwift);
    assert(group && shareSwift.includes(`"${group[1]}"`), "the extension and the vault name different App Groups");
    assert(key && shareSwift.includes(`"${key[1]}"`), "the extension and the vault name different keys");
    assert(/removeObject\(forKey: shareKey\)/.test(vaultSwift), "takeShared must remove the note as it reads it");
    return `${group[1]} / ${key[1]}, read natively, removed on read`;
  });

  await check("the speaker reads the Reply voice setting, keeps the phone's voice off the network, and notes what spoke", async () => {
    // speak.js and the Settings row share one key in localStorage; nothing in
    // the bridge carries the preference, so the contract is held here in text.
    const speak = read("mobile/src/speak.js"), ui = read("mobile/src/mobile-ui.js");
    assert(/localStorage\.getItem\("crowe-reply-voice"\)/.test(speak), "speak.js must read crowe-reply-voice");
    assert(/localStorage\.setItem\("crowe-reply-voice"/.test(ui), "the Settings row must write crowe-reply-voice");
    assert(/\["michael", "neural", "phone"\]/.test(speak) && /VOICES = \["michael", "neural", "phone"\]/.test(ui), "the two sides must agree on the three voices");
    assert(/if \(preferred === "phone"\) return fallback\(said\);/.test(speak), "the phone's own voice must never call the gateway");
    assert(/x-crowe-voice/.test(speak) && /x-crowe-chars/.test(speak) && /diag\.note\("speech"/.test(speak), "each gateway read must note the voice that spoke and the characters it cost");
    return "one localStorage key, three voices, phone stays local, speech noted in Diagnostics";
  });

  await check("a streamed turn with a tool call emits the events the UI reads", async () => {
    const bridge = loadMobileSurface(fakeGateway([
      // Round one: a little prose, then update an explicitly attached file.
      [{ delta: { content: "Updating the note. " } },
       { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file", arguments: '{"path":"phone:notes.txt","content":"The package weighs 4.2 lb."}' } }] } },
       { usage: { prompt_tokens: 120, completion_tokens: 40 } }],
      // Round two: the answer, no more tools.
      [{ delta: { content: "Updated. The package weighs 4.2 lb." } },
       { usage: { prompt_tokens: 260, completion_tokens: 22 } }],
    ]));
    await bridge.setConfig({ token: "header." + Buffer.from('{"email":"grower@example.com","exp":9999999999}').toString("base64") + ".sig" });

    const seen = [];
    const off = await bridge.agent.onEvent((ev) => seen.push(ev));
    await loadMobileSurface.lastWindow.crowePhone.add("notes.txt", "Old note");
    const result = await bridge.agent.run([{ role: "user", content: "Record the package weight, 4.2 lb, in my attached note." }]);
    off();

    const types = seen.map((e) => e.type);
    for (const want of ["route", "assistant_delta", "assistant", "tool_call", "tool_result", "telemetry", "final"]) {
      assert(types.includes(want), `no ${want} event — the stream was: ${types.join(", ")}`);
    }
    assert(seen.every((e) => e.agentId === "main"), "an event went out without an agentId; every surface filters on it");
    assert(result.done && /4\.2 lb/.test(result.text), `the turn returned ${JSON.stringify(result)}`);

    const call = seen.find((e) => e.type === "tool_call");
    assert(call.name === "write_file" && call.args.path === "phone:notes.txt", `tool_call carried ${JSON.stringify(call)}`);
    const toolResult = seen.find(e => e.type === "tool_result");
    assert(toolResult.status === "ok" && /updated phone:notes.txt/.test(toolResult.result), "the generic file update failed");
    const sessions = await bridge.sessions.list();
    assert(sessions.length === 1, "the turn was not persisted to a session");

    const telemetry = seen.filter((e) => e.type === "telemetry").pop();
    assert(telemetry.promptTokens === 380 && telemetry.completionTokens === 62,
      `the meter did not accumulate across rounds: ${JSON.stringify(telemetry)}`);
    return `${types.length} events over 2 rounds`;
  });

  await check("a restored cultivation pin normalizes to the general operator", async () => {
    const bridge = loadMobileSurface(fakeGateway([[{ delta: { content: "ok" } }]]));
    await bridge.setConfig({ token: "a.b.c" });
    const seen = [];
    const off = await bridge.agent.onEvent((ev) => seen.push(ev));
    await bridge.agent.run([{ role: "user", content: "how is the weather" }], "main", { role: "cultivation" });
    off();
    const route = seen.find((e) => e.type === "route");
    assert(route.model === "crowelm" && route.expert === "operator", `pinned cultivation routed to ${JSON.stringify(route)}`);
    assert(!/pinned/.test(route.reason), `a retired pin remained active: ${route.reason}`);
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

  await check("all tiers reject unsolicited growing calls before connector ownership or storage access", async () => {
    for (const autonomy of ["plan", "readonly", "edit", "execute"]) {
      const bodies = [], owned = [], acted = [];
      const gw = fakeGateway([
        [{ delta: { tool_calls: [
          { index: 0, id: "read", function: { name: "read_grow", arguments: '{"type":"log"}' } },
          { index: 1, id: "write", function: { name: "log_grow", arguments: '{"type":"log","record":{"entry":"overwrite"}}' } },
        ] } }],
        [{ delta: { content: "Those workflows are unavailable." } }],
      ]);
      const seed = Object.fromEntries(["grow:blocks", "grow:flushes", "grow:contam", "grow:env", "grow:strains", "grow:recipes", "grow:log", "camera-roll", "sense"]
        .map(key => ["crowe:" + key, '{ malformed legacy data ' + key]));
      const bridge = loadMobileSurface(async (url, init) => {
        if (String(url).includes("/api/gateway/chat")) bodies.push(JSON.parse(init.body));
        return gw(url, init);
      }, null, { seed });
      const win = loadMobileSurface.lastWindow, storage = loadMobileSurface.lastStore, access = loadMobileSurface.lastStorageAccess;
      win.croweConnectors = {
        tools: async () => ["read_grow", "log_grow"].map(name => ({ type: "function", function: { name } })),
        owns: name => { owned.push(name); return true; }, act: async name => { acted.push(name); return "bad"; },
      };
      // The public descriptor is not permission authority, even if replaced.
      win.crowe.edition = { capabilities: { grow: true, farm: true, sense: true } };
      await bridge.setConfig({ autonomy, token: "a.b.c", grow: true, capabilities: { grow: true } });
      const events = [], off = bridge.agent.onEvent(e => events.push(e));
      await bridge.agent.run([{ role: "user", content: "Use the old saved log." }]); off();
      assert(bodies.length === 2, "tool loop did not complete");
      assert(bodies.every(b => !b.tools.some(t => ["read_grow", "log_grow"].includes(t.function.name))), `${autonomy} offered a grow connector collision`);
      assert(events.filter(e => e.type === "tool_result" && e.status === "blocked").length === 2, `${autonomy} did not block both calls`);
      assert(!owned.length && !acted.length, `${autonomy} consulted a connector before denial`);
      assert(!(await bridge.grow.list("log")).length, "grow list exposed historical records");
      for (const response of [await bridge.grow.save("log", {}), await bridge.grow.delete("log", "x"), await bridge.grow.export("x", "private"), await bridge.camera.add({ thumb: "data:image/png;base64,eA==" }), await bridge.sense.configure({ source: "cloud" })]) {
        assert(response.ok === false && response.code === "UNAVAILABLE", `ordinary API allowed: ${JSON.stringify(response)}`);
      }
      assert(!(await bridge.camera.list()).length && !(await bridge.sense.status()).available, "journal or Sense remained active");
      assert(!access.some(([, key]) => Object.hasOwn(seed, key)), `${autonomy} accessed protected storage: ${JSON.stringify(access)}`);
      for (const [key, value] of Object.entries(seed)) assert(storage.get(key) === value, `changed ${key}`);
    }
    return "four tiers, connector collisions, malformed history, replaceable public descriptor";
  });

  await check("saved models, catalog aliases, role pins and the shared gateway keep the general boundary", async () => {
    let host, policy;
    const asked = [], originalConfig = JSON.stringify({ model: "crowelm-grower", token: "a.b.c" });
    const models = [
      { model: "crowelm-grower", role: "cultivation", min_plan: "free" },
      { model: "special-alias", role: "cultivation", min_plan: "free" },
      { model: "grow-coding-alias", role: "coding", id: "model-mycology", featured: true },
      { model: "crowelm", role: "default" },
      { model: "crowelm-vision", role: "vision" },
      { model: "crowelm-mycelium", role: "reasoning" },
    ];
    const bridge = loadMobileSurface(async (url, init) => {
      if (String(url).includes("/api/gateway/catalog")) return new Response(JSON.stringify({ models }));
      if (String(url).includes("/api/gateway/chat")) asked.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ content: "A general answer." }));
    }, null, { seed: { "crowe:config": originalConfig }, roomHost: (deps, activation) => { host = deps; policy = activation; return {}; } });
    const storage = loadMobileSurface.lastStore;
    await bridge.getConfig(); await new Promise(resolve => setTimeout(resolve, 0));
    const catalog = await bridge.catalog.get();
    assert(catalog.defaultModel === "crowelm", "saved specialist default was not normalized");
    assert(!catalog.models.some(m => ["crowelm-grower", "special-alias", "grow-coding-alias"].includes(m.model)), "specialist catalog choices survived");
    assert(catalog.models.some(m => m.model === "crowelm-vision") && catalog.models.some(m => m.model === "crowelm-mycelium"), "general vision or reasoning model was removed");
    assert(!catalog.resolved.cultivation, "cultivation role remained in picker");
    assert(policy.grow === false && policy.modelAllowed("") && !policy.modelAllowed("special-alias"), "Rooms did not receive closure-owned policy");
    for (const model of ["crowelm-grower", "provider/crowelm-grower", "special-alias", "model-mycology"]) {
      const result = await host.chat(model, [{ role: "user", content: "hello" }]);
      assert(result.code === "UNAVAILABLE", `common gateway accepted ${model}`);
    }
    assert(!asked.length, "blocked explicit model reached the network");
    await bridge.chat([{ role: "user", content: "Tell me about mushrooms" }]);
    const events = [], off = bridge.agent.onEvent(e => events.push(e));
    await bridge.agent.run([{ role: "user", content: "Tell me about mushrooms" }], "main", { role: "cultivation" }); off();
    assert(asked.length === 2 && asked.every(body => body.model === "crowelm"), "ordinary topical questions did not reach the general assistant");
    assert(events.some(e => e.type === "route" && e.expert === "operator"), "restored role remained specialized");
    assert(storage.get("crowe:config") === originalConfig, "runtime normalization rewrote saved config");
    const prompt = asked[1].messages[0].content;
    assert(!/read_grow|log_grow|grow room|mycelium|substrate|contaminat/i.test(prompt), "general system prompt retained cultivation defaults");
  });

  await check("cached specialist aliases cannot escape through the first offline saved default", async () => {
    const savedConfig = JSON.stringify({ model: "old-special-alias", token: "a.b.c" });
    const savedCatalog = JSON.stringify({ at: Date.now(), models: [
      { model: "old-special-alias", role: "cultivation", min_plan: "free" }, { model: "crowelm" },
    ] });
    const bodies = [];
    const bridge = loadMobileSurface(async (url, init) => {
      if (String(url).includes("/api/gateway/catalog")) throw new TypeError("offline catalog");
      if (String(url).includes("/api/gateway/chat")) bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ content: "General answer" }));
    }, null, { seed: { "crowe:config": savedConfig, "crowe:catalog": savedCatalog } });
    const storage = loadMobileSurface.lastStore;
    await bridge.chat([{ role: "user", content: "Hello" }]);
    assert(bodies.length === 1 && bodies[0].model === "crowelm", "the first chat used a cached specialist alias");
    assert(storage.get("crowe:config") === savedConfig && storage.get("crowe:catalog") === savedCatalog, "runtime filtering rewrote saved records");
  });

  await check("retired native intents never emit a grow workflow while generic Ask survives", async () => {
    for (const kind of ["log-block", "home", "camera", "grow", "ask"]) {
      const bridge = loadMobileSurface(null, null, { seed: { "crowe:intent": JSON.stringify({ kind, text: "historical handoff", at: Date.now() }) } });
      const win = loadMobileSurface.lastWindow, events = [];
      win.dispatchEvent = event => events.push(event);
      const result = await bridge.intents.take();
      assert(kind === "ask" ? result.kind === "ask" : result === null, `${kind} was not handled safely`);
      assert(kind === "ask" ? events.some(e => e.type === "crowe:intent" && e.detail.kind === "ask") : !events.length, `${kind} emitted a live intent`);
    }
  });

  await check("only positively identified native grow reminders are cancelled and legacy history is preserved", async () => {
    const saved = JSON.stringify([
      { id: 11, lot: "old-lot", title: "Legacy", at: Date.now() + 86400000 },
      { id: 12, lot: "", title: "Mushroom recipe", at: Date.now() + 86400000 },
      { id: "13", lot: "not-a-native-id" },
    ]);
    const prefs = new Map([["reminders", saved]]), cancelled = [], listeners = {}, notifications = [
      { id: 11 }, { id: 12, title: "Mushroom recipe", extra: { lot: "" } },
      { id: 13 }, { id: 14, extra: { lot: "positive-metadata" } },
      { id: "15", extra: { lot: "bad-id" } }, { id: 16, body: "Water the grow room" },
    ];
    const cap = { Plugins: {
      Preferences: { get: async ({ key }) => ({ value: prefs.get(key) ?? null }), set: async ({ key, value }) => prefs.set(key, value) },
      LocalNotifications: { getPending: async () => ({ notifications }), cancel: async ({ notifications: ns }) => cancelled.push(...ns.map(n => n.id)),
        addListener: (name, cb) => { listeners[name] = cb; return { remove() {} }; } },
    } };
    const bridge = loadMobileSurface(null, cap), events = [];
    loadMobileSurface.lastWindow.dispatchEvent = e => events.push(e);
    await bridge.getConfig(); await new Promise(resolve => setTimeout(resolve, 0));
    assert(cancelled.join(",") === "11,14", `cancelled unrelated reminders: ${cancelled}`);
    assert(prefs.get("reminders") === saved, "startup rewrote reminder history");
    assert(!(await bridge.reminders.add({ lot: "new-lot", at: Date.now() + 86400000 })).ok, "new lot reminder accepted");
    assert(!(await bridge.reminders.remove(11)).ok && prefs.get("reminders") === saved, "legacy reminder deletion changed history");
    assert((await bridge.reminders.list()).map(r => r.id).join(",") === "12", "normal list exposed legacy reminders");
    await listeners.localNotificationActionPerformed({ notification: { id: 11 } });
    await listeners.localNotificationActionPerformed({ notification: { id: 14, extra: { lot: "old-lot" } } });
    assert(!events.length, "legacy notification opened a workflow");
    await listeners.localNotificationActionPerformed({ notification: { id: 12 } });
    assert(events.length === 1 && events[0].detail.kind === "ask" && events[0].detail.text === "", "general notification did not open generic chat safely");
  });

  await check("a file handed to the phone answers at its phone: path, unpaired", async () => {
    // The picker grant: mobile-ui.js registers what the user chose, and the
    // file tools answer phone: paths from the store with no machine paired —
    // pairing is about reaching another computer, and this file never left
    // this one. The tier still gates: readonly may read, not write.
    const bridge = loadMobileSurface(fakeGateway([
      [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"phone:notes.md"}' } }] } }],
      [{ delta: { content: "The note says water block 12." } }],
    ]));
    const win = loadMobileSurface.lastWindow;
    assert(win.crowePhone, "mobile-bridge.js did not install window.crowePhone");
    win.crowePhone.add("notes.md", "water block 12 tomorrow");
    await bridge.setConfig({ token: "a.b.c", autonomy: "readonly" });
    const seen = [];
    const off = await bridge.agent.onEvent((ev) => seen.push(ev));
    const result = await bridge.agent.run([{ role: "user", content: "read my note" }]);
    off();
    const tr = seen.find((e) => e.type === "tool_result");
    assert(tr && /water block 12/.test(String(tr.result)), `read_file phone: answered ${JSON.stringify(tr)}`);
    assert(result.done, "the turn did not finish");
  });

  await check("a photo rides inside the turn as an image part and goes to Crowe Vision", async () => {
    // The camera grant: mobile-ui.js downsizes the picture and hands it over
    // as a data URL; the bridge puts it on the user's message as an image_url
    // part, routes that turn to crowelm-vision, announces it, and clears it.
    const asked = [], bodies = [];
    const bridge = loadMobileSurface(async (url, init = {}) => {
      if (!String(url).includes("/api/gateway/chat")) return new Response("{}", { status: 200 });
      const body = JSON.parse(init.body || "{}"); asked.push(body.model); bodies.push(body);
      return new Response(`data: ${JSON.stringify({ delta: { content: "Green Trichoderma, lower left corner. Isolate it." } })}\ndata: [DONE]\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const win = loadMobileSurface.lastWindow;
    assert(win.crowePhone.addImage("block.txt", "not an image").error, "a non-image was accepted as a photo");
    const r = win.crowePhone.addImage("block.jpg", "data:image/jpeg;base64,/9j/AAAA");
    assert(r.ok && win.crowePhone.images().length === 1, `the photo was not held: ${JSON.stringify(r)}`);
    await bridge.setConfig({ token: "header." + Buffer.from('{"email":"grower@example.com","tier":"pro","exp":9999999999}').toString("base64") + ".sig" });
    const seen = [];
    const off = await bridge.agent.onEvent((ev) => seen.push(ev));
    const result = await bridge.agent.run([{ role: "user", content: "Is this contamination?" }]);
    off();
    assert(asked.join(",") === "crowelm-vision", `asked the gateway for: ${asked.join(", ")}`);
    const last = bodies[0].messages.filter((m) => m.role === "user").pop();
    assert(Array.isArray(last.content) && last.content[0].type === "text" && last.content[0].text === "Is this contamination?"
      && last.content[1].type === "image_url" && /^data:image\/jpeg;base64,/.test(last.content[1].image_url.url),
      `the user turn was ${JSON.stringify(last.content).slice(0, 200)}`);
    assert(/An image is attached/.test(bodies[0].messages[0].content), "the system prompt did not carry the vision brief");
    assert(!/substrate|mycelium|Trichoderma|log_grow|contamination/i.test(bodies[0].messages[0].content), "generic vision retained mushroom-specific defaults");
    const defaultAsk = /PHOTO_DEFAULT_ASK = "([^"]+)"/.exec(read("mobile/src/mobile-bridge.js"));
    assert(defaultAsk && /image/.test(defaultAsk[1]) && !/contamination|mushroom/.test(defaultAsk[1]), "blank image questions lack a neutral default");
    const route = seen.find((e) => e.type === "route");
    assert(route && route.expert === "vision" && route.model === "crowelm-vision", `route was ${JSON.stringify(route)}`);
    const photos = seen.find((e) => e.type === "photos");
    assert(photos && photos.names[0] === "block.jpg" && photos.thumbs[0].startsWith("data:image/jpeg"), "no photos event for the transcript thumbnail");
    assert(win.crowePhone.images().length === 0, "the photo was not cleared after the turn");
    assert(result.done && /Trichoderma/.test(result.text), `the turn returned ${JSON.stringify(result)}`);
    return "image part sent, vision routed, photo cleared";
  });

  await check("general Vision preserves cross-domain questions and image order without growing access", async () => {
    // Synthetic gateway completions exercise transport, prompt neutrality and
    // display parsing only. These fixtures do NOT measure model inference/OCR.
    const cases = [
      { name: "screenshot E104", ask: "Explain error E104 in this screenshot.", images: ["screenshot.png"], reply: "Synthetic: E104 is visible.", label: "error panel" },
      { name: "invoice OCR", ask: "Read the invoice number and line-item text from this image.", images: ["invoice.png"], reply: "Synthetic: invoice INV-104, item cable.", label: "invoice text" },
      { name: "architecture arrows", ask: "Explain the arrow direction between the API and database in this architecture diagram.", images: ["architecture.png"], reply: "Synthetic: API points to database.", label: "API arrow" },
      { name: "equipment label", ask: "Read the voltage and model number printed on this equipment label.", images: ["equipment.png"], reply: "Synthetic: 120 V, model EQ-104.", label: "equipment label" },
      { name: "mushroom cap count", ask: "Count the visible mushroom caps in this photo; do not assume anything hidden.", images: ["mushrooms.png"], reply: "Synthetic: four visible mushroom caps.", label: "visible caps" },
      { name: "two-image ordering", ask: "Compare the first screenshot with the second screenshot and preserve that order.", images: ["before.png", "after.png"], reply: "Synthetic: first is before, second is after.", label: "comparison detail" },
    ];
    let baselinePrompt;
    for (const fixture of cases) {
      const seed = Object.fromEntries(["grow:blocks", "grow:flushes", "grow:contam", "grow:env", "grow:strains", "grow:recipes", "grow:log", "camera-roll", "sense"]
        .map(key => ["crowe:" + key, "raw private fixture: " + key]));
      const bodies = [], urls = [], events = [];
      const bridge = loadMobileSurface(async (url, init = {}) => {
        urls.push(String(url));
        if (!String(url).includes("/api/gateway/chat")) return new Response("{}");
        bodies.push(JSON.parse(init.body));
        const chunks = ["REGIONS: " + JSON.stringify([{ label: fixture.label, x: 0.1, y: 0.2, w: 0.3, h: 0.4 }]) + "\n\n", fixture.reply];
        return new Response(chunks.map(content => `data: ${JSON.stringify({ delta: { content } })}\n`).join("") + "data: [DONE]\n",
          { headers: { "content-type": "text/event-stream" } });
      }, null, { seed });
      const win = loadMobileSurface.lastWindow, storage = loadMobileSurface.lastStore, access = loadMobileSurface.lastStorageAccess;
      // Deliberately distinct synthetic payloads: no decoder or actual model is
      // used here. Exact equality tests ordered attachment transport.
      const imageUrls = fixture.images.map((name, i) => "data:image/png;base64," + Buffer.from(fixture.name + ":" + i).toString("base64"));
      fixture.images.forEach((name, i) => assert(win.crowePhone.addImage(name, imageUrls[i]).ok, `${fixture.name}: attachment refused`));
      await bridge.setConfig({ token: "h." + Buffer.from('{"email":"vision-fixture@example.com","tier":"pro","exp":9999999999}').toString("base64") + ".s" });
      const off = bridge.agent.onEvent(e => events.push(e));
      const result = await bridge.agent.run([{ role: "user", content: fixture.ask }]); off();
      assert(bodies.length === 1 && bodies[0].model === "crowelm-vision", `${fixture.name}: did not use general Vision exactly once`);
      const body = bodies[0], prompt = body.messages[0].content;
      if (baselinePrompt === undefined) baselinePrompt = prompt;
      assert(prompt === baselinePrompt && /An image is attached/.test(prompt), `${fixture.name}: subject changed the system prompt`);
      assert(!/substrate|mycelium|Trichoderma|read_grow|log_grow|grow room|contamination/i.test(prompt), `${fixture.name}: specialist instructions present`);
      const user = body.messages.filter(m => m.role === "user").pop();
      assert(user.content[0].type === "text" && user.content[0].text === fixture.ask, `${fixture.name}: user wording was changed`);
      assert(JSON.stringify(user.content.filter(p => p.type === "image_url").map(p => p.image_url.url)) === JSON.stringify(imageUrls), `${fixture.name}: image transport order or bytes changed`);
      assert(!body.tools.some(t => ["read_grow", "log_grow"].includes(t.function.name)), `${fixture.name}: growing tool offered`);
      assert(!events.some(e => e.type === "tool_call"), `${fixture.name}: unexpected workflow tool execution`);
      const photos = events.find(e => e.type === "photos"), regions = events.find(e => e.type === "vision_regions");
      assert(photos && JSON.stringify(photos.names) === JSON.stringify(fixture.images), `${fixture.name}: photo event order changed`);
      assert(regions && regions.regions[0].label === fixture.label, `${fixture.name}: arbitrary image region label lost`);
      assert(result.done && result.text === fixture.reply && !win.crowePhone.images().length, `${fixture.name}: completion or attachment cleanup failed`);
      assert(!access.some(([, key]) => Object.hasOwn(seed, key)), `${fixture.name}: accessed legacy growing storage`);
      for (const [key, value] of Object.entries(seed)) assert(storage.get(key) === value, `${fixture.name}: altered ${key}`);
      assert(!urls.some(url => /sense\.crowelogic|\/grow(?:\/|$)/.test(url)), `${fixture.name}: specialist network access`);
    }
    return "six synthetic transport cases; no inference-quality claim";
  });

  await check("the REGIONS line a vision reply opens with becomes its own event and never reaches the transcript", async () => {
    // The brief asks the model to open with one line naming the areas it examined.
    // Split across chunks the way a stream lands, that line must arrive as
    // vision_regions with parsed fractions, and neither the deltas nor the final
    // text may carry a character of it.
    const bridge = loadMobileSurface(async (url, init = {}) => {
      if (!String(url).includes("/api/gateway/chat")) return new Response("{}", { status: 200 });
      const chunks = ['REGIONS: [{"label": "green patch, lower left", "x": 0.05, "y": 0.6', ', "w": 0.3, "h": 0.3}, {"label": "healthy mycelium", "x": 0.4, "y": 0.1, "w": 0.5, "h": 0.4}]\n', "\nGreen Trichoderma in the lower left. ", "Isolate the block today."];
      return new Response(chunks.map((c) => `data: ${JSON.stringify({ delta: { content: c } })}\n`).join("") + "data: [DONE]\n",
        { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const win = loadMobileSurface.lastWindow;
    win.crowePhone.addImage("block.jpg", "data:image/jpeg;base64,/9j/AAAA");
    await bridge.setConfig({ token: "header." + Buffer.from('{"email":"grower@example.com","tier":"pro","exp":9999999999}').toString("base64") + ".sig" });
    const seen = [];
    const off = await bridge.agent.onEvent((ev) => seen.push(ev));
    const result = await bridge.agent.run([{ role: "user", content: "Is this contamination?" }]);
    off();
    const regions = seen.find((e) => e.type === "vision_regions");
    assert(regions && regions.regions.length === 2 && regions.regions[0].label === "green patch, lower left" && regions.regions[0].x === 0.05 && regions.regions[1].w === 0.5,
      `vision_regions was ${JSON.stringify(regions)}`);
    const deltas = seen.filter((e) => e.type === "assistant_delta").map((e) => e.text).join("");
    assert(!/REGIONS/.test(deltas) && /^Green Trichoderma/.test(deltas), `deltas carried: ${JSON.stringify(deltas).slice(0, 120)}`);
    const final = seen.find((e) => e.type === "assistant");
    assert(final && /^Green Trichoderma/.test(final.text) && !/REGIONS/.test(final.text), `final text was ${JSON.stringify(final && final.text).slice(0, 120)}`);
    assert(seen.findIndex((e) => e.type === "vision_regions") < seen.findIndex((e) => e.type === "assistant_delta"), "the regions arrived after the prose started");
    assert(result.done && /^Green Trichoderma/.test(result.text), `the turn returned ${JSON.stringify(result).slice(0, 120)}`);
    return "2 regions lifted before the first delta; transcript clean";
  });

  await check("the owner account is asked for a REASONING line and gets it as its own event; a customer is asked for neither", async () => {
    const mk = (email) => {
      const bodies = [];
      const bridge = loadMobileSurface(async (url, init = {}) => {
        if (!String(url).includes("/api/gateway/chat")) return new Response("{}", { status: 200 });
        bodies.push(JSON.parse(init.body || "{}"));
        const frames = ['REGIONS: [{"label":"Substrate face","x":0.1,"y":0.2,"w":0.5,"h":0.5}]\n', 'NOTES: The face is uniformly white with no ', 'green, so contamination is ruled out; the caps are still curled, so it is not past peak.\n\n', 'Healthy. Harvest today.'];
        return new Response(frames.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n`).join("") + "data: [DONE]\n", { status: 200, headers: { "content-type": "text/event-stream" } });
      });
      return { bridge, bodies, win: loadMobileSurface.lastWindow, tok: "header." + Buffer.from(JSON.stringify({ email, tier: "enterprise", exp: 9999999999 })).toString("base64") + ".sig" };
    };
    // owner
    let { bridge, bodies, win, tok } = mk("michael@crowelogic.com");
    win.crowePhone.addImage("block.jpg", "data:image/jpeg;base64,/9j/AAAA");
    await bridge.setConfig({ token: tok });
    let seen = []; let off = await bridge.agent.onEvent((ev) => seen.push(ev));
    let result = await bridge.agent.run([{ role: "user", content: "Look at this." }]); off();
    assert(/NOTES:/.test(bodies[0].messages[0].content) && !/REASONING:/.test(bodies[0].messages[0].content), "the owner's system prompt must ask for NOTES, never REASONING (the model answers empty to that word)");
    const reason = seen.find((e) => e.type === "vision_reasoning");
    assert(reason && /ruled out/.test(reason.text) && /not past peak/.test(reason.text), `no reasoning event for the owner: ${JSON.stringify(reason)}`);
    let deltas = seen.filter((e) => e.type === "assistant_delta").map((e) => e.text).join("");
    assert(!/NOTES|REASONING|REGIONS/.test(deltas) && deltas === "Healthy. Harvest today.", `owner transcript carried: ${JSON.stringify(deltas)}`);
    assert(result.text === "Healthy. Harvest today.", `owner final text: ${JSON.stringify(result.text)}`);
    // customer
    ({ bridge, bodies, win, tok } = mk("grower@example.com"));
    win.crowePhone.addImage("block.jpg", "data:image/jpeg;base64,/9j/AAAA");
    await bridge.setConfig({ token: tok });
    seen = []; off = await bridge.agent.onEvent((ev) => seen.push(ev));
    result = await bridge.agent.run([{ role: "user", content: "Look at this." }]); off();
    assert(!/NOTES:|REASONING:/.test(bodies[0].messages[0].content), "a customer's system prompt asked for notes or reasoning");
    assert(!seen.some((e) => e.type === "vision_reasoning"), "a customer received a reasoning event");
    deltas = seen.filter((e) => e.type === "assistant_delta").map((e) => e.text).join("");
    assert(!/REASONING|REGIONS/.test(deltas), `customer transcript carried: ${JSON.stringify(deltas)}`);
    return "owner: asked, lifted, shown; customer: not asked, nothing shown, transcript clean either way";
  });

  await check("an empty vision completion is asked once more, then reported as such, not as a blank answer", async () => {
    let asks = 0;
    const bridge = loadMobileSurface(async (url, init = {}) => {
      if (!String(url).includes("/api/gateway/chat")) return new Response("{}", { status: 200 });
      asks += 1;
      return new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4437,"completion_tokens":0}}\ndata: [DONE]\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const win = loadMobileSurface.lastWindow;
    win.crowePhone.addImage("block.jpg", "data:image/jpeg;base64,/9j/AAAA");
    await bridge.setConfig({ token: "header." + Buffer.from('{"email":"grower@example.com","tier":"pro","exp":9999999999}').toString("base64") + ".sig" });
    const seen = []; const off = await bridge.agent.onEvent((ev) => seen.push(ev));
    const result = await bridge.agent.run([{ role: "user", content: "Look at this." }]); off();
    const err = seen.find((e) => e.type === "error");
    assert(err && /returned nothing for this photo/.test(err.text), `no plain error for the empty completion: ${JSON.stringify(seen.map((e) => e.type))}`);
    assert(result.done === false, "an empty vision answer was treated as done");
    assert(asks === 2, `expected one retry (2 asks), got ${asks}`);
    return "0-token vision reply: asked twice, then a sentence the grower can act on";
  });

  await check("a vision reply with no REGIONS line streams untouched", async () => {
    const bridge = loadMobileSurface(async (url, init = {}) => {
      if (!String(url).includes("/api/gateway/chat")) return new Response("{}", { status: 200 });
      return new Response(["Regular ", "answer, no map."].map((c) => `data: ${JSON.stringify({ delta: { content: c } })}\n`).join("") + "data: [DONE]\n",
        { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const win = loadMobileSurface.lastWindow;
    win.crowePhone.addImage("block.jpg", "data:image/jpeg;base64,/9j/AAAA");
    await bridge.setConfig({ token: "header." + Buffer.from('{"email":"grower@example.com","tier":"pro","exp":9999999999}').toString("base64") + ".sig" });
    const seen = []; const off = await bridge.agent.onEvent((ev) => seen.push(ev));
    const result = await bridge.agent.run([{ role: "user", content: "What is this?" }]); off();
    assert(!seen.some((e) => e.type === "vision_regions"), "regions were invented");
    assert(seen.filter((e) => e.type === "assistant_delta").map((e) => e.text).join("") === "Regular answer, no map.", "the prose was altered");
    assert(result.text === "Regular answer, no map.", `final was ${JSON.stringify(result.text)}`);
    return "no line, nothing held back";
  });

  await check("a free account is told Crowe Vision needs a plan, and no text model is asked to see", async () => {
    const asked = [];
    const bridge = loadMobileSurface(async (url, init = {}) => {
      if (String(url).includes("/api/gateway/catalog")) {
        return new Response(JSON.stringify({ models: [
          { model: "crowelm-flash", name: "CroweLM Flash", min_plan: "free" },
          { model: "crowelm-vision", name: "CroweLM Vision", min_plan: "personal" },
        ] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (!String(url).includes("/api/gateway/chat")) return new Response("{}", { status: 200 });
      asked.push(JSON.parse(init.body || "{}").model);
      return new Response("data: [DONE]\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const win = loadMobileSurface.lastWindow;
    win.crowePhone.addImage("plate.jpg", "data:image/jpeg;base64,/9j/AAAA");
    await bridge.setConfig({ token: "header." + Buffer.from('{"email":"grower@example.com","exp":9999999999}').toString("base64") + ".sig" });
    await bridge.catalog.get();
    await new Promise((r) => setTimeout(r, 50));
    const seen = [];
    const off = await bridge.agent.onEvent((ev) => seen.push(ev));
    const result = await bridge.agent.run([{ role: "user", content: "what is this" }]);
    off();
    assert(asked.length === 0, `the gateway was asked anyway: ${asked.join(", ")}`);
    const err = seen.find((e) => e.type === "error");
    assert(err && /Crowe Vision reads photos on the personal plan/.test(err.text), `the refusal was ${JSON.stringify(err)}`);
    assert(!result.done && win.crowePhone.images().length === 0, "the photo should be cleared and the turn not done");
    return "refused in words, nothing sent";
  });

  await check("the native fallback never asks the gateway to stream, and still reads a stream if handed one", async () => {
    // Since control plane 0.2.17 the gateway honours stream:true. CapacitorHttp
    // hands back one finished body, so a fallback that forwards the fetch body
    // unchanged gets an event stream, fails to parse it as JSON, and shows the
    // user an empty answer ("Done. See the workspace."). This was every phone
    // reply on 2026-09-09 until it was fixed.
    const prefs = new Map();
    const seen = [];
    const capacitor = { Plugins: {
      Preferences: {
        get: async ({ key }) => ({ value: prefs.has(key) ? prefs.get(key) : null }),
        set: async ({ key, value }) => { prefs.set(key, value); },
        remove: async ({ key }) => { prefs.delete(key); },
      },
      CapacitorHttp: { request: async (opts) => { seen.push(opts); return { status: 200, data:
        'data: {"choices":[{"delta":{"content":"Whole "}}]}\ndata: {"choices":[{"delta":{"content":"answer."}}]}\ndata: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\ndata: [DONE]\n' }; } },
    } };
    const bridge = loadMobileSurface(() => Promise.reject(new TypeError("Failed to fetch")), capacitor);
    await bridge.setConfig({ token: "a.b.c" });
    const result = await bridge.agent.run([{ role: "user", content: "hi" }]);
    const chat = seen.find((o) => String(o.url).includes("/api/gateway/chat"));
    assert(chat, "the fallback never reached the gateway");
    assert(chat.data && chat.data.stream === undefined, `the native body still asked to stream: ${JSON.stringify(chat.data.stream)}`);
    assert(result.done && result.text === "Whole answer.", `the fallback returned ${JSON.stringify(result)}`);
    return "stream stripped from the native body; an SSE body is still read";
  });

  await check("general reminders schedule in order while the camera journal refuses writes", async () => {
    const scheduled = [], cancelled = []; const prefs = new Map();
    const cap = { Plugins: {
      Preferences: { get: async ({ key }) => ({ value: prefs.has(key) ? prefs.get(key) : null }), set: async ({ key, value }) => { prefs.set(key, value); }, remove: async ({ key }) => { prefs.delete(key); } },
      LocalNotifications: { checkPermissions: async () => ({ display: "granted" }), requestPermissions: async () => ({ display: "granted" }),
        schedule: async ({ notifications }) => { scheduled.push(...notifications); }, cancel: async ({ notifications }) => { cancelled.push(...notifications.map((n) => n.id)); },
        getPending: async () => ({ notifications: scheduled.filter((n) => !cancelled.includes(n.id)) }),
        addListener: () => ({ remove() {} }) },
    } };
    const bridge = loadMobileSurface(() => { throw new TypeError("no network in this check"); }, cap);
    const past = await bridge.reminders.add({ title: "Check package", at: Date.now() - 1000 });
    assert(past.ok === false && /past/.test(past.error), "a reminder in the past was accepted");
    const later = await bridge.reminders.add({ title: "Check package", body: "Ask for delivery status", at: Date.now() + 14 * 86400000 });
    const sooner = await bridge.reminders.add({ title: "Call courier", at: Date.now() + 3 * 86400000 });
    assert(later.ok && sooner.ok && later.native === true, `reminders were refused: ${JSON.stringify([later, sooner])}`);
    assert(scheduled.length === 2 && scheduled.every((n) => Number.isInteger(n.id) && n.id < 2 ** 31 && n.schedule && n.schedule.at instanceof Date), "the plugin did not get two int32-id notifications with a date");
    const list = await bridge.reminders.list();
    assert(list.length === 2 && list[0].title === "Call courier", `list is not soonest first: ${JSON.stringify(list.map((r) => r.lot))}`);
    // pending reads what the SYSTEM holds, soonest first, with a millisecond
    // time, so Diagnostics can show that iOS accepted the schedule.
    const pend = await bridge.reminders.pending();
    assert(pend.native === true && pend.notifications.length === 2 && pend.notifications[0].id === sooner.reminder.id && pend.notifications.every((n) => Number.isInteger(n.at)), `pending did not mirror the system: ${JSON.stringify(pend)}`);
    await bridge.reminders.remove(sooner.reminder.id);
    assert(cancelled.includes(sooner.reminder.id) && (await bridge.reminders.list()).length === 1, "remove did not cancel with the system and drop the row");
    assert((await bridge.reminders.pending()).notifications.length === 1, "pending still lists a cancelled notification");
    const noPlugin = loadMobileSurface(() => { throw new TypeError("no network"); }, { Plugins: { Preferences: cap.Plugins.Preferences } });
    const none = await noPlugin.reminders.pending();
    assert(none.native === false && none.notifications.length === 0, "without the plugin, pending must say so instead of failing");
    const c = await bridge.camera.add({ lot: "260910-01", verdict: "Healthy colonisation, no contamination. Move to fruiting in about a week.", thumb: "data:image/jpeg;base64,/9j/4AAQ" });
    assert(!c.ok && c.code === "UNAVAILABLE", "the retired journal accepted an image");
    const bad = await bridge.camera.add({ lot: "x", verdict: "v", thumb: "javascript:alert(1)" });
    assert(!bad.ok, "a non-image journal entry was accepted");
    const roll = await bridge.camera.list();
    assert(roll.length === 0 && !prefs.has("camera-roll"), "the disabled camera journal touched storage");
    return "2 general reminders scheduled, pending mirrors the system, 1 cancelled; journal writes refused";
  });

  await check("diagnostics record a run's request, response and ending, and a failed fetch names itself", async () => {
    const prefs = new Map();
    const cap = { Plugins: { Preferences: { get: async ({ key }) => ({ value: prefs.has(key) ? prefs.get(key) : null }), set: async ({ key, value }) => { prefs.set(key, value); }, remove: async ({ key }) => { prefs.delete(key); } } } };
    let mode = "ok";
    const bridge = loadMobileSurface(async (url, init = {}) => {
      if (!String(url).includes("/api/gateway/chat")) return new Response("{}", { status: 200 });
      if (mode === "down") throw new TypeError("Load failed");
      return new Response('data: {"choices":[{"delta":{"content":"Fine."}}]}\ndata: [DONE]\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    }, cap);
    await bridge.diag.clear();
    await bridge.setConfig({ token: "header." + Buffer.from('{"email":"grower@example.com","tier":"pro","exp":9999999999}').toString("base64") + ".sig" });
    await bridge.agent.run([{ role: "user", content: "hello" }]);
    let rows = await bridge.diag.list();
    const kinds = rows.map((r) => r.k);
    assert(kinds.includes("run:start") && kinds.includes("net:fetch") && kinds.includes("net:response") && kinds.includes("net:stream-end") && kinds.includes("run:final"), `a good run recorded ${JSON.stringify(kinds)}`);
    assert(rows[0].t >= rows[rows.length - 1].t, "the list is not newest first");
    mode = "down";
    const r = await bridge.agent.run([{ role: "user", content: "hello again" }]);
    rows = await bridge.diag.list();
    const threw = rows.find((x) => x.k === "net:fetch-threw");
    assert(threw && /Load failed/.test(threw.d), `the failed fetch was not recorded: ${JSON.stringify(rows.slice(0, 4))}`);
    assert(rows.some((x) => x.k === "run:error") && r.done === false, "the failed run did not end as an error");
    await bridge.diag.note("page:error", "something the page threw");
    assert((await bridge.diag.list())[0].k === "page:error", "a page note did not land on top");
    await bridge.diag.clear();
    assert((await bridge.diag.list()).length === 0, "clear left entries");
    return `${kinds.length} entries for a good run; a dead network shows as net:fetch-threw Load failed`;
  });

  await check("Delete account opens the Crowe ID account page and signs the phone out only once the account is gone", async () => {
    // App Store guideline 5.1.1(v). The deletion happens on the account page;
    // the bridge learns the outcome by asking the realm for a fresh token when
    // the browser sheet closes. Refused refresh = the user is gone = sign out.
    // A refresh that succeeds means they only looked, and they stay signed in.
    const makeCapacitor = (opened, fired) => { const prefs = new Map(); return { Plugins: {
      Preferences: {
        get: async ({ key }) => ({ value: prefs.has(key) ? prefs.get(key) : null }),
        set: async ({ key, value }) => { prefs.set(key, value); },
        remove: async ({ key }) => { prefs.delete(key); },
      },
      Browser: {
        open: async ({ url }) => { opened.push(url); },
        addListener: (name, cb) => { fired[name] = cb; return { remove() { fired[name] = null; } }; },
      },
    } }; };
    const tokenAnswer = (body, status = 200) => (url) => Promise.resolve({ status, text: async () => JSON.stringify(body), json: async () => body })
      .then((r) => { if (!String(url).includes("/protocol/openid-connect/token")) throw new TypeError("unexpected fetch " + url); return r; });

    // 1. The account was deleted: Keycloak refuses the refresh, the phone signs out.
    let opened = [], fired = {};
    let bridge = loadMobileSurface(tokenAnswer({ error: "invalid_grant", error_description: "Session not active" }, 400), makeCapacitor(opened, fired));
    await bridge.setConfig({ token: "a.b.c", refreshToken: "r1" });
    let pending = bridge.auth.deleteAccount();
    await new Promise((r) => setTimeout(r, 20));
    assert(opened.length === 1 && /\/realms\/crowe\/account\/$/.test(opened[0]), `opened ${JSON.stringify(opened)} instead of the account console`);
    assert(typeof fired.browserFinished === "function", "no browserFinished listener was registered before the sheet opened");
    fired.browserFinished();
    let r = await pending;
    assert(r.deleted === true, `expected deleted:true, got ${JSON.stringify(r)}`);
    assert((await bridge.auth.status()).user === null, "the phone is still signed in after the account was deleted");
    assert(!(await bridge.getConfig()).hasToken, "the access token survived the deletion");

    // 2. They only looked: the refresh succeeds and nothing is forgotten.
    opened = []; fired = {};
    bridge = loadMobileSurface(tokenAnswer({ access_token: "x.y.z", refresh_token: "r2" }), makeCapacitor(opened, fired));
    await bridge.setConfig({ token: "a.b.c", refreshToken: "r1" });
    pending = bridge.auth.deleteAccount();
    await new Promise((r) => setTimeout(r, 20));
    fired.browserFinished();
    r = await pending;
    assert(r.deleted === false, `expected deleted:false, got ${JSON.stringify(r)}`);
    assert((await bridge.getConfig()).hasToken, "a look at the account page signed the phone out");
    return "deleted -> signed out; looked -> still signed in";
  });

  await check("Delete account goes through the gateway when it can confirm the address, and falls back to the console on an older gateway", async () => {
    // Control plane 0.2.20: DELETE /api/auth/me with the typed email. The
    // harness has no window.prompt, which is why the check above still takes
    // the console route; here the prompt is supplied.
    const jwt = (claims) => "h." + Buffer.from(JSON.stringify(claims)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_") + ".s";
    const token = jwt({ email: "grower@example.com", exp: Math.floor(Date.now() / 1000) + 3600 });
    const makeCap = (opened) => ({ Plugins: {
      Preferences: (() => { const prefs = new Map(); return { get: async ({ key }) => ({ value: prefs.has(key) ? prefs.get(key) : null }), set: async ({ key, value }) => { prefs.set(key, value); }, remove: async ({ key }) => { prefs.delete(key); } }; })(),
      Browser: { open: async ({ url }) => { opened.push(url); }, addListener: (name, cb) => { setTimeout(() => cb(), 5); return { remove() {} }; } },
    } });
    const gateway = (status, body) => { const calls = []; const f = async (url, init = {}) => {
      if (String(url).includes("/api/auth/me")) { calls.push(init); return { status, ok: status >= 200 && status < 300, json: async () => body }; }
      if (String(url).includes("/protocol/openid-connect/token")) return { status: 400, text: async () => "{}", json: async () => ({ error: "invalid_grant" }) };
      throw new TypeError("unexpected fetch " + url); }; f.calls = calls; return f; };

    // 1. Confirmed and accepted: no browser sheet, tokens gone.
    let opened = []; let gw = gateway(200, { deleted: true });
    let bridge = loadMobileSurface(gw, makeCap(opened)); loadMobileSurface.lastWindow.prompt = () => "Grower@Example.com ";
    await bridge.setConfig({ token, refreshToken: "r1" });
    let r = await bridge.auth.deleteAccount();
    assert(r.deleted === true && r.opened === false, `native deletion did not report deleted: ${JSON.stringify(r)}`);
    assert(gw.calls.length === 1 && gw.calls[0].method === "DELETE" && /Bearer h\./.test(gw.calls[0].headers.Authorization) && JSON.parse(gw.calls[0].body).confirm === "Grower@Example.com", `the DELETE was not sent as expected: ${JSON.stringify(gw.calls)}`);
    assert(opened.length === 0, "the console opened although the gateway deleted the account");
    assert(!(await bridge.getConfig()).hasToken, "the access token survived a native deletion");

    // 2. The typed address does not match: nothing is sent, nothing opens.
    opened = []; gw = gateway(200, { deleted: true });
    bridge = loadMobileSurface(gw, makeCap(opened)); loadMobileSurface.lastWindow.prompt = () => "someone@else.com";
    await bridge.setConfig({ token, refreshToken: "r1" });
    r = await bridge.auth.deleteAccount();
    assert(r.deleted === false && /did not match/.test(r.error) && gw.calls.length === 0 && opened.length === 0, `a wrong address got through: ${JSON.stringify(r)}`);
    assert((await bridge.getConfig()).hasToken, "a refused confirmation signed the phone out");

    // 3. A protected account: the gateway's own words, still signed in.
    opened = []; gw = gateway(403, { detail: { message: "This account is protected while the app is in review." } });
    bridge = loadMobileSurface(gw, makeCap(opened)); loadMobileSurface.lastWindow.prompt = () => "grower@example.com";
    await bridge.setConfig({ token, refreshToken: "r1" });
    r = await bridge.auth.deleteAccount();
    assert(r.deleted === false && /protected/.test(r.error) && opened.length === 0, `the 403 was not surfaced in words: ${JSON.stringify(r)}`);
    assert((await bridge.getConfig()).hasToken, "a refused deletion signed the phone out");

    // 4. An older gateway (404): the console route, exactly as before.
    opened = []; gw = gateway(404, {});
    bridge = loadMobileSurface(gw, makeCap(opened)); loadMobileSurface.lastWindow.prompt = () => "grower@example.com";
    await bridge.setConfig({ token, refreshToken: "r1" });
    r = await bridge.auth.deleteAccount();
    assert(opened.length === 1 && /\/realms\/crowe\/account\/$/.test(opened[0]) && r.opened === true, `an older gateway did not fall back to the console: ${JSON.stringify({ r, opened })}`);
    return "200 -> deleted natively; mismatch -> nothing sent; 403 -> the gateway's words; 404 -> console fallback";
  });

  await check("a Shortcut's note is taken once, dispatched as crowe:intent, and stale notes are dropped", async () => {
    // CroweIntents.swift writes {kind, text, at} under the Preferences key
    // `intent`; the bridge reads it on launch and on foreground, clears it, and
    // hands it to the UI. A second read must find nothing.
    const prefs = new Map([["intent", JSON.stringify({ kind: "ask", text: "how wet should the substrate be", at: Date.now() })]]);
    const capacitor = { Plugins: { Preferences: {
      get: async ({ key }) => ({ value: prefs.has(key) ? prefs.get(key) : null }),
      set: async ({ key, value }) => { prefs.set(key, value); },
      remove: async ({ key }) => { prefs.delete(key); },
    } } };
    const bridge = loadMobileSurface(fakeGateway([]), capacitor);
    const win = loadMobileSurface.lastWindow;
    const seen = [];
    if (typeof win.addEventListener === "function") win.addEventListener("crowe:intent", (e) => seen.push(e.detail));
    await new Promise((r) => setTimeout(r, 30));      // the boot read
    let note = await bridge.intents.take();            // already taken at boot, or taken now
    assert(!prefs.has("intent"), "the note was not cleared after being taken");
    assert(seen.length === 1 || note, `expected one crowe:intent (saw ${seen.length}) or a direct note`);
    if (seen.length) assert(seen[0].kind === "ask" && /substrate/.test(seen[0].text), `wrong detail ${JSON.stringify(seen[0])}`);
    assert((await bridge.intents.take()) === null, "a second take found a note");
    prefs.set("intent", JSON.stringify({ kind: "ask", text: "old", at: Date.now() - 11 * 60 * 1000 }));
    assert((await bridge.intents.take()) === null && !prefs.has("intent"), "a stale note was not dropped");
    return "taken once, cleared, stale dropped";
  });

  await check("a write to a phone: path updates the app's copy and only that", async () => {
    const bridge = loadMobileSurface(fakeGateway([
      [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "write_file", arguments: '{"path":"phone:notes.md","content":"rewritten"}' } }] } }],
      [{ delta: { content: "Done." } }],
    ]));
    const win = loadMobileSurface.lastWindow;
    win.crowePhone.add("notes.md", "original");
    await bridge.setConfig({ token: "a.b.c", autonomy: "edit" });
    const off = await bridge.agent.onEvent(() => {});
    await bridge.agent.run([{ role: "user", content: "rewrite my note to say rewritten" }]);
    off();
    assert(win.crowePhone.get("notes.md") === "rewritten", "the store copy was not updated");
    // And below Edit, the same call is refused at the tool.
    const bridge2 = loadMobileSurface(fakeGateway([
      [{ delta: { tool_calls: [{ index: 0, id: "c2", function: { name: "write_file", arguments: '{"path":"phone:notes.md","content":"sneaky"}' } }] } }],
      [{ delta: { content: "understood" } }],
    ]));
    const win2 = loadMobileSurface.lastWindow;
    win2.crowePhone.add("notes.md", "original");
    await bridge2.setConfig({ token: "a.b.c", autonomy: "readonly" });
    const seen2 = [];
    const off2 = await bridge2.agent.onEvent((ev) => seen2.push(ev));
    await bridge2.agent.run([{ role: "user", content: "rewrite it" }]);
    off2();
    assert(win2.crowePhone.get("notes.md") === "original", "a read-only turn rewrote the copy");
    const refusal = seen2.find((e) => e.type === "tool_result");
    assert(refusal && /refused/.test(String(refusal.result)), `the write was not refused: ${JSON.stringify(refusal)}`);
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

  await check("general role classifiers match the harness, with cultivation intentionally excluded", () => {
    const fromHarness = roleLines(harnessSrc).filter(l => !l.includes('role: "cultivation"')), fromBridge = roleLines(bridgeSrc);
    assert(fromHarness.length, "no role table found in harness.js — this check has gone stale");
    assert(fromBridge.length === fromHarness.length,
      `harness has ${fromHarness.length} roles, mobile has ${fromBridge.length}`);
    for (let i = 0; i < fromHarness.length; i++) {
      assert(fromBridge[i] === fromHarness[i], `role ${i + 1} differs:\n  harness: ${fromHarness[i]}\n  mobile:  ${fromBridge[i]}`);
    }
    return `${fromHarness.length} roles`;
  });

  await check("general bridge model mappings match the harness without the grower specialist", () => {
    const grab = (src) => (src.match(/BRIDGE_ROLE_MODEL = (\{[^}]*\})/) || [])[1];
    assert(grab(harnessSrc), "BRIDGE_ROLE_MODEL not found in harness.js");
    const expected = new Function("return (" + grab(harnessSrc) + ")")();
    delete expected.cultivation;
    const actual = new Function("return (" + grab(bridgeSrc) + ")")();
    assert(JSON.stringify(actual) === JSON.stringify(expected), `harness: ${JSON.stringify(expected)} mobile: ${JSON.stringify(actual)}`);
  });

  await check("the routed-role list matches main except for the removed cultivation product", () => {
    // This one lives in main.js, not the harness: it is the list the desktop
    // resolves for the Home surface's routing card, which the phone renders too.
    const grab = (src) => (src.match(/ROUTED_ROLES = (\[[^\]]*\])/) || [])[1];
    const fromMain = grab(read("main.js"));
    assert(fromMain, "ROUTED_ROLES not found in main.js");
    const expected = JSON.parse(fromMain).filter(role => role !== "cultivation");
    assert(grab(bridgeSrc) === JSON.stringify(expected).replaceAll(',', ', '), `main.js: ${fromMain} mobile: ${grab(bridgeSrc)}`);
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
    /* Script TAGS, not filenames anywhere in the document. Matching the bare
       name meant any prose that named a script - an HTML comment explaining
       what renderer.js does was enough - counted as a load and put the order
       out. The tags are what the browser actually executes, and the optional
       query allows for the --dev cache-busting stamp. */
    const at = (file) => built.search(new RegExp(`<script src="${file.replace(/\./g, "\\.")}(\\?[^"]*)?"`));
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

  await check("no plugin listener is treated as a promise", () => {
    // window.Capacitor.Plugins is the bridge the native side injects, not the
    // @capacitor/* JS packages. Those packages resolve a handle from
    // addListener; the injected proxy returns the handle synchronously. So
    // `App.addListener(...).then(h => ...)` is a TypeError on a device and
    // nowhere else — not in a browser with the packages loaded, not in any
    // test that stubs the plugins.
    //
    // It cost a real bug: the sign-in listener chained .then, the TypeError
    // threw inside a `new Promise` executor two lines above Browser.open, and
    // the rejection had no handler. Tapping "Sign in with Crowe ID" did
    // nothing at all — no browser, no error, no log. Promise.resolve() around
    // the call takes both shapes; this keeps it that way.
    const end = (src, open) => {          // index just past the matching ")"
      let depth = 0, quote = null;
      for (let i = open; i < src.length; i++) {
        const c = src[i], prev = src[i - 1];
        if (quote) { if (c === quote && prev !== "\\") quote = null; continue; }
        if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
        if (c === "(") depth += 1;
        else if (c === ")") { depth -= 1; if (depth === 0) return i + 1; }
      }
      throw new Error("unbalanced parentheses after addListener");
    };
    const found = [];
    for (const file of ["mobile/src/mobile-bridge.js", "mobile/src/mobile-ui.js"]) {
      const src = read(file);
      for (const m of src.matchAll(/\b(\w+)\.addListener\s*\(/g)) {
        const open = m.index + m[0].length - 1;
        const after = src.slice(end(src, open)).trimStart();
        assert(!/^\.(then|catch|finally)\b/.test(after),
          `${file}: ${m[1]}.addListener(...) is chained with ${after.slice(0, 6)} — ` +
          "the injected bridge returns the handle synchronously, so this throws on a device. " +
          "Wrap it: Promise.resolve(" + m[1] + ".addListener(...)).then(...)");
        found.push(`${m[1]} in ${path.basename(file)}`);
      }
    }
    assert(found.length, "no addListener calls found — did the bridge stop listening?");
    return `${found.length} listener(s) checked`;
  });

  await check("single-use grants are redeemed natively, not fetch-first", () => {
    // The gateway calls try fetch and fall back to CapacitorHttp when CORS
    // blocks them. That pattern is wrong for the token endpoint and it cost a
    // whole evening: a form-encoded POST is a CORS "simple request", so there
    // is no preflight to stop it leaving. Cross-origin from capacitor://
    // localhost the POST IS delivered and Keycloak spends the authorization
    // code; only the response is withheld for want of an
    // Access-Control-Allow-Origin header. fetch rejects, the fallback replays a
    // code that no longer exists, and sign-in dies on "Code not valid" having
    // already succeeded at the server. Refresh tokens rotate, so they burn the
    // same way.
    const src = read("mobile/src/mobile-bridge.js");
    const start = src.indexOf("async function tokenRequest");
    assert(start > -1, "tokenRequest is gone from the bridge");
    let depth = 0, quote = null, end = -1;
    for (let i = src.indexOf("{", start); i < src.length; i++) {
      const c = src[i], prev = src[i - 1];
      if (quote) { if (c === quote && prev !== "\\") quote = null; continue; }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "{") depth += 1;
      else if (c === "}") { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    assert(end > -1, "could not find the end of tokenRequest");
    const body = src.slice(start, end);
    const native = body.indexOf("nativePost");
    const fetched = body.indexOf("fetch(");
    assert(native > -1, "tokenRequest no longer has a native path");
    assert(fetched === -1 || native < fetched,
      "tokenRequest reaches for fetch before the native stack. A cross-origin " +
      "POST still leaves the device and spends the code, so the native retry " +
      "then replays a code Crowe ID has already consumed. Redeem natively " +
      "whenever CapacitorHttp exists; keep fetch for `npm run serve` only.");
    return fetched === -1 ? "native only" : "native before fetch";
  });

  await check("cleartext is permitted to the tailnet and nowhere else", () => {
    /* Both platforms block plain HTTP by default, and the companion is the one
       exception: it is reached at a *.ts.net MagicDNS name, which resolves only
       inside the user's own tailnet, where WireGuard has already authenticated
       and encrypted the traffic.

       Each platform offers a one-line version of this fix that is the wrong
       one — NSAllowsArbitraryLoads on iOS, usesCleartextTraffic on Android —
       and both turn the protection off for every host, forever. They are easy
       to reach for, because the narrow fix looks like more work and the broad
       one makes the error go away just as fast. This fails on either.

       Learned on a device: an iOS pairing URL built from the 100.x address is
       refused whatever the plist says, because an exception domain matches
       names and never IP literals. */
    const plist = read("mobile/ios/App/App/Info.plist");
    assert(!/<key>NSAllowsArbitraryLoads<\/key>\s*<true\s*\/>/.test(plist),
      "Info.plist sets NSAllowsArbitraryLoads — that allows cleartext to every host. Scope it to ts.net instead.");
    assert(/<key>ts\.net<\/key>/.test(plist), "Info.plist has no ts.net exception; the companion cannot be reached over http");
    assert(/<key>NSIncludesSubdomains<\/key>\s*<true\s*\/>/.test(plist),
      "the ts.net exception does not include subdomains, so a MagicDNS name will not match");

    const manifest = read("mobile/android/app/src/main/AndroidManifest.xml");
    assert(!/android:usesCleartextTraffic="true"/.test(manifest),
      "AndroidManifest allows cleartext to every host. Use the network security config instead.");
    assert(/android:networkSecurityConfig="@xml\/network_security_config"/.test(manifest),
      "AndroidManifest does not reference the network security config, so its rules never apply");

    const netcfg = read("mobile/android/app/src/main/res/xml/network_security_config.xml");
    assert(/<base-config cleartextTrafficPermitted="false"/.test(netcfg),
      "the Android base config does not forbid cleartext, so the domain rule is not a narrowing");
    assert(/<domain includeSubdomains="true">ts\.net<\/domain>/.test(netcfg), "ts.net is not the permitted domain");
    return "ts.net only, on both platforms";
  });

    await check("the drawer stays open while typing a session name or brief", () => {
    // mobile-ui closes the drawer on any tap in the sessions list, so a row tap
    // navigates cleanly. The current session's name and brief fields live in
    // that same list (renderer.js drawSessionMeta) and must not close it.
    const ui = read("mobile/src/mobile-ui.js");
    const rr = read("renderer/renderer.js");
    assert(/className\s*=\s*"sess-meta"/.test(rr), "renderer no longer draws .sess-meta; update this check");
    assert(/closest\("\.sess-meta"\)/.test(ui), "mobile-ui closes the drawer on taps inside .sess-meta");
    return "editor taps ignored";
  });

console.log(failures ? `\n${failures} check(s) failed` : "\nall mobile bridge checks passed");
  process.exit(failures ? 1 : 0);
})();
