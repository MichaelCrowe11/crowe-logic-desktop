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
function loadWebSurface({ fetchImpl, seedConfig } = {}) {
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
  new Function(...Object.keys(sandbox), read("renderer/web-bridge.js"))(...Object.values(sandbox));
  assert(win.crowe, "web-bridge.js did not install window.crowe");
  return { crowe: win.crowe, store };
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
