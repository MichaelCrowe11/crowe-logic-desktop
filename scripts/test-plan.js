#!/usr/bin/env node
// The desktop's way from free to paid, kept honest.
//
//   node scripts/test-plan.js
//
// renderer/plan.js exists because for twenty-four releases the installed app
// was the one surface in the estate that could not sell. The plan card and the
// Stripe hand-off lived in renderer/web-ui.js and renderer/web-bridge.js, and
// package.json build.files excludes both from the package, so a free account
// in the DMG could see it was free, be routed to the free model, and have
// nowhere to go. Zero live subscriptions is the number that says so.
//
// These checks are about the ways that regresses quietly:
//
//   · the script stops being loaded, and the pill silently never appears;
//   · a price gets written into the file, and the app and the Worker drift
//     into two price lists;
//   · the two paid-tier lists fall out of step, and a paying account is told
//     to upgrade;
//   · the transcript's markup changes and the card starts rendering like a
//     message from an older version of the app;
//   · the auth events collapse into one name and refreshAuth answers its own
//     announcement forever.
//
// Run under plain node; no Electron, no browser, no network.

const fs = require("fs");
const path = require("path");
const Module = require("module");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let failures = 0;
function check(name, fn) {
  try {
    const detail = fn();
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${String(e.message || e).split("\n").join("\n       ")}`);
  }
}
function assert(cond, message) { if (!cond) throw new Error(message); }

// preload.js runs in Electron. Feed it a contextBridge that keeps what it is
// handed, the way scripts/test-web-bridge.js does, so the surface can be read
// without a renderer to expose it to.
function loadPreloadSurface() {
  let exposed = null;
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
    ipcRenderer: { invoke: async () => ({}), on: () => {}, send: () => {} },
  };
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return electron;
    return original.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve(path.join(root, "preload.js"))];
    require(path.join(root, "preload.js"));
  } finally {
    Module._load = original;
  }
  return exposed;
}

console.log("plan:");

const plan = read("renderer/plan.js");
const rendererJs = read("renderer/renderer.js");
const indexHtml = read("renderer/index.html");
const mainJs = read("main.js");
const webBridge = read("renderer/web-bridge.js");
const mobileBridge = read("mobile/src/mobile-bridge.js");
const pkg = JSON.parse(read("package.json"));

check("index.html loads plan.js, after renderer.js", () => {
  const r = indexHtml.indexOf('src="renderer.js"');
  const p = indexHtml.indexOf('src="plan.js"');
  assert(r !== -1, "index.html must load renderer.js");
  assert(p !== -1, "index.html must load plan.js, or the app has no way to sell");
  assert(p > r, "plan.js must load after renderer.js; it reads #transcript and #userbadge");
  return "ordered";
});

check("plan.js ships in the package and the web sellers stay out of it", () => {
  const files = pkg.build.files;
  assert(files.includes("renderer/**"), "build.files must include renderer/**, which is how plan.js ships");
  assert(files.includes("!renderer/web-ui.js"), "web-ui.js must stay out of the package");
  assert(files.includes("!renderer/web-bridge.js"), "web-bridge.js must stay out of the package");
  assert(!files.includes("!renderer/plan.js"), "plan.js must not be excluded; it is the desktop's only path to checkout");
  return "renderer/** in, web sellers out";
});

check("the card's markup is the transcript's markup", () => {
  // renderer.js addAssistant is not exported, so plan.js reproduces it. If the
  // shape over there changes, this fails rather than letting the card render
  // like a message from an older build.
  const needle = '<div class="who"><span class="who-mark" role="img" aria-label="Crowe Logic"></span></div><div class="body"></div>';
  assert(rendererJs.includes(needle), "renderer.js addAssistant markup moved; update plan.js say() to match");
  assert(plan.includes(needle), "plan.js say() must reproduce renderer.js addAssistant markup");
  assert(/className = "msg assistant"/.test(plan), "plan.js must use the assistant message class");
  return "matched";
});

check("no price is written into plan.js", () => {
  assert(!/\$\s*\d/.test(plan.replace(/\$\{[^}]*\}/g, "")), "no price literal may appear in plan.js; every number comes from /v1/catalog");
  assert(/billing\.catalog\(\)/.test(plan), "plan.js must read the price from the catalog");
  return "catalog is the only source";
});

check("the bridge exposes the whole billing surface", () => {
  const api = loadPreloadSurface();
  assert(api && api.billing, "preload must expose window.crowe.billing");
  for (const m of ["plan", "catalog", "checkout", "refresh"]) {
    assert(typeof api.billing[m] === "function", `window.crowe.billing.${m} must be a function`);
  }
  for (const m of ["plan", "catalog", "checkout", "refresh"]) {
    assert(mainJs.includes(`ipcMain.handle("crowe:billing:${m}"`), `main.js must handle crowe:billing:${m}`);
  }
  return "4 methods, 4 handlers";
});

check("Stripe opens in the browser, never in a window this app controls", () => {
  assert(/shell\.openExternal/.test(mainJs.slice(mainJs.indexOf('crowe:billing:checkout'))), "the checkout handler must hand the URL to the system browser");
  assert(!/location\.assign|window\.open/.test(plan), "plan.js must never navigate to a checkout URL itself; a card field must not render in this app");
  assert(/protocol !== "https:"/.test(mainJs.slice(mainJs.indexOf('crowe:billing:checkout'))), "the checkout handler must refuse a non-https URL");
  assert(/\^\[a-z0-9-\]\{1,40\}\$/.test(mainJs), "the checkout handler must validate the slug before sending it");
  return "external, https, validated";
});

check("one ladder: all three bridges agree on who is paying", () => {
  const list = (src) => {
    const m = src.match(/PAID_TIERS = \[([^\]]*)\]/);
    assert(m, "PAID_TIERS not found");
    return m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean).sort();
  };
  const surfaces = { desktop: list(mainJs), web: list(webBridge), mobile: list(mobileBridge) };
  const [first, ...rest] = Object.entries(surfaces);
  for (const [name, tiers] of rest) {
    assert(JSON.stringify(tiers) === JSON.stringify(first[1]),
      `${first[0]} and ${name} disagree on who is paying:\n  ${first[0]} ${first[1].join(" ")}\n  ${name} ${tiers.join(" ")}`);
  }
  for (const slug of ["scale", "studio", "business"]) {
    assert(first[1].includes(slug), `${slug} is a live tier in the catalog; leaving it out tells a paying account it is free`);
  }
  return first[1].join(" ");
});

check("the phone build strips the plan tag rather than 404ing on it", () => {
  // plan.js is not in build-www's COPY list and must not be: the phone has its
  // own chrome and its own answer about buying. Leaving the tag in cost a real
  // failure once, where the missing script delayed the load enough that
  // mobile-ui.js had not rewritten the welcome by the time the shell suite read
  // it, and the phone claimed a project folder and a terminal it does not have.
  const build = read("mobile/scripts/build-www.js");
  assert(/must\(html, '<script src="plan\.js"><\/script>'/.test(build), "build-www must assert the plan tag is there before removing it, so a rename fails loudly");
  assert(/html\.replace\('  <script src="plan\.js"><\/script>\\n', ""\)/.test(build), "build-www must strip the plan tag from the phone page");
  assert(!/\["renderer\/plan\.js"/.test(build), "plan.js must not be copied into www");
  const www = path.join(root, "mobile", "www", "index.html");
  if (fs.existsSync(www)) {
    assert(!fs.readFileSync(www, "utf8").includes("plan.js"), "the built phone page still references plan.js; rebuild with node mobile/scripts/build-www.js");
  }
  return "stripped";
});

check("the phone refuses to sell, and says why", () => {
  // Not a gap to be filled later: selling digital content in-app is the store's
  // own purchase API, and the catalog Worker's CORS allowlist does not name
  // capacitor://localhost. Both refusals must stay stated rather than becoming
  // calls that fail silently.
  const billing = mobileBridge.slice(mobileBridge.indexOf("    billing: {"));
  assert(/billing: \{/.test(mobileBridge), "mobile must expose billing for bridge parity");
  assert(/catalog: async \(\) => \(\{ error:/.test(billing), "mobile catalog must be a stated refusal, not a fetch the browser will block");
  assert(/checkout: async \(\) => \(\{[\s\S]{0,80}ok: false/.test(billing), "mobile checkout must refuse rather than send a buyer to Stripe from in-app");
  assert(/crowelogic\.com/.test(billing), "the refusals must name where subscribing does work");
  assert(/plan: async/.test(billing) && /refresh: async/.test(billing), "plan and refresh are the token's own claim and must be real on the phone");
  return "2 refused, 2 real";
});

check("the auth events run one way each", () => {
  // Two names on purpose. One shared name would have refreshAuth answering its
  // own announcement forever.
  assert(/dispatchEvent\(new CustomEvent\("crowe:auth-changed"\)\)/.test(rendererJs), "refreshAuth must announce crowe:auth-changed");
  assert(/addEventListener\("crowe:auth-recheck"/.test(rendererJs), "renderer.js must listen for crowe:auth-recheck");
  assert(!/dispatchEvent\(new CustomEvent\("crowe:auth-recheck"\)\)/.test(rendererJs), "renderer.js must not send crowe:auth-recheck; it receives it");
  assert(/dispatchEvent\(new CustomEvent\("crowe:auth-recheck"\)\)/.test(plan), "plan.js must ask for a re-read with crowe:auth-recheck");
  assert(!/dispatchEvent\(new CustomEvent\("crowe:auth-changed"\)\)/.test(plan), "plan.js must not send crowe:auth-changed; it listens for it");
  assert(/addEventListener\("crowe:auth-changed"/.test(plan), "plan.js must follow sign-in and sign-out rather than polling");
  return "recheck out, changed in";
});

check("the free account is offered the card once, and the paywall opens it", () => {
  assert(/addEventListener\("crowe:paywall"/.test(plan), "plan.js must open the card on crowe:paywall");
  assert(/let offered = false/.test(plan) && /!offered/.test(plan), "the card must be offered once per session, not on every focus");
  assert(/upgradePill\(signedIn && free\)/.test(plan), "the pill must track the signed-in free account");
  return "once per session";
});

check("the higher tiers come from the catalog, and Enterprise is not a button", () => {
  assert(/\["scale", "studio", "business"\]/.test(plan), "the card must offer the tiers above Pro");
  assert(/data-slug/.test(plan) && /dataset\.slug/.test(plan), "each chip must check out its own slug");
  assert(/contactOnly/.test(plan), "a contactOnly tier has no Checkout session to mint and must not be offered as a button");
  return "3 chips";
});

check("the app watches for the tier instead of asking the user to sign out", () => {
  assert(/billing\.refresh\(\)/.test(plan), "the card must spend the refresh token to pick up the new claim");
  assert(/addEventListener\("focus"/.test(plan), "the check must run when the browser gives the window back");
  assert(/removeEventListener\("focus"/.test(plan), "the watch must stop once the tier lands");
  return "focus-driven";
});

console.log(failures ? `\n${failures} failed` : "\nall plan checks passed");
process.exit(failures ? 1 : 0);
