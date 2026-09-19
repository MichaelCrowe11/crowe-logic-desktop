#!/usr/bin/env node
/* Eyes on the cloud browser. Boots the real app on an empty profile with a
   Crowe Browser key in its config, then drives the app's own browser tools
   (harness.execTool, the same code a turn runs) against the live service, so
   the Cloud browser card, its thumbnail and the live view panel are real. The
   model is the one thing not in the loop: the turn is started from the composer
   and the tool calls are issued by this script, in the order a model would.
     CROWE_BROWSER_KEY="$(security find-generic-password -s crowe-browser-key -a crowelogic -w)" \
       CROWE_SHOT_OUT=docs/design/cloud-browser-2026-09-18 npx electron scripts/shot-cloud-browser.js
   CROWE_SHOT_RESOLVE=host=ip pins a name for a machine whose resolver has not
   caught up with a new record. Prints the screenshot paths and the facts read
   back from the DOM and from the service. Exit 1 if a fact is wrong. */
const { app, BrowserWindow, ipcMain, webContents } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const dns = require("dns");
const KEY = process.env.CROWE_BROWSER_KEY || "";
if (!KEY) { console.error("CROWE_BROWSER_KEY is not set"); process.exit(2); }
const SERVICE = process.env.CROWE_BROWSER_URL || "https://browser.crowelogic.com";
const PIN = /^([^=]+)=(.+)$/.exec(process.env.CROWE_SHOT_RESOLVE || "");
if (PIN) {
  app.commandLine.appendSwitch("host-resolver-rules", `MAP ${PIN[1]} ${PIN[2]}`);
  const orig = dns.lookup;
  dns.lookup = function (host, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    if (host !== PIN[1]) return orig.call(dns, host, opts, cb);
    if (opts && opts.all) return process.nextTick(cb, null, [{ address: PIN[2], family: 4 }]);
    return process.nextTick(cb, null, PIN[2], 4);
  };
}
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-shot-cloud-browser-profile-"));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-shot-cloud-browser-"));
const OUT = process.env.CROWE_SHOT_OUT || fs.mkdtempSync(path.join(os.tmpdir(), "crowe-cloud-browser-shots-"));
fs.mkdirSync(OUT, { recursive: true });
app.setPath("userData", PROFILE);
app.setPath("sessionData", PROFILE);
fs.writeFileSync(path.join(PROFILE, "config.json"), JSON.stringify({
  telemetry: false, cwd: PROJECT, autonomy: "execute", approvals: "high-risk",
  croweBrowser: { url: SERVICE, key: KEY },
}), { mode: 0o600 });
fs.writeFileSync(path.join(PROJECT, "README.md"), "# demo project\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The service is reached for real; everything else the app asks for on boot comes back empty.
const realFetch = globalThis.fetch.bind(globalThis);
const serviceHost = new URL(SERVICE).host;
global.fetch = (u, o) => (String(u && u.url ? u.url : u).includes(serviceHost) ? realFetch(u, o)
  : Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })));
require(path.join(__dirname, "..", "main.js"));
const harness = require(path.join(__dirname, "..", "harness.js"));
const Browser = require(path.join(__dirname, "..", "browser-client.js"));
const pool = new Browser.BrowserSessions({ clientFor: () => new Browser.CroweBrowserClient({ url: SERVICE, key: KEY, fetch: global.fetch }) });
const ctx = {
  getCwd: () => PROJECT, setCwd() {}, browser: pool,
  loadConfig: () => ({ autonomy: "execute", approvals: "high-risk", croweBrowser: { url: SERVICE, key: KEY } }),
  proposeEdit: async () => "blocked", requestApproval: async () => true, journal() {}, artifactDir: () => OUT,
  mcpTools: () => [], mcpCall: async () => "", openUrl() {}, appVersion: "shot",
};
const facts = [];
const check = (ok, what) => { facts.push((ok ? "ok   " : "FAIL ") + what); if (!ok) process.exitCode = 1; };
let releaseTurn = null, driven = null;
const drivenP = new Promise((r) => { driven = r; });
// The turn the composer starts lands here instead of at a model. The tools are
// the app's own; the events are the ones a turn emits.
ipcMain.removeHandler("crowe:agent:run");
ipcMain.handle("crowe:agent:run", async (evt) => {
  const send = (ev) => evt.sender.send("crowe:agent:event", { ...ev, agentId: "main" });
  const state = { agentId: "main", send, journal() {} };
  const results = {};
  for (const [name, args] of [["browser_open", { url: "https://example.com" }], ["browser_read", {}]]) {
    send({ type: "tool_call", name, args });
    const t0 = Date.now();
    const out = await harness.execTool(ctx, name, args, null, state);
    results[name] = { text: String(out), ms: Date.now() - t0 };
    send({ type: "tool_result", name, result: String(out).slice(0, 4000), status: /^(blocked|rejected|error)/.test(String(out)) ? "fail" : "ok" });
  }
  driven(results);
  await new Promise((r) => { releaseTurn = r; });
  return { done: true, text: "" };
});
app.whenReady().then(async () => {
  try {
    await sleep(600);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("no window");
    win.setContentSize(1440, 900);
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once("did-finish-load", r));
    await sleep(1800);
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => { const img = await win.webContents.capturePage(); const p = path.join(OUT, name + ".png"); fs.writeFileSync(p, img.toPNG()); console.log("shot:", p); };
    const cfg = await js(`window.crowe.getConfig()`);
    check(cfg && cfg.croweBrowserKeySet === true && !("key" in (cfg.croweBrowser || {})), "the renderer knows a key is set and never sees it");
    // Start a turn from the composer, the way a person does. Sign-in is stubbed
    // here only so the turn can begin without a Crowe ID session on this profile.
    await js(`refreshAuth = async () => true; true`);
    await js(`(function(){ const i = document.getElementById("input"); i.value = "Open example.com in the cloud browser and read the page"; i.dispatchEvent(new Event("input")); document.getElementById("composer").requestSubmit(); return true; })()`);
    const results = await Promise.race([drivenP, sleep(90000).then(() => null)]);
    check(!!results, "the turn reached the tools");
    if (results) {
      check(!/^(blocked|rejected|error)/.test(results.browser_open.text), `browser_open answered (${results.browser_open.text.slice(0, 80)}) in ${results.browser_open.ms} ms`);
      check(/Example Domain/.test(results.browser_read.text) && !/data:image/.test(results.browser_read.text), "browser_read carries the page text and no image data");
    }
    await sleep(800);
    const card = await js(`(function(){
      const c = document.querySelector("#transcript .msg.assistant .browsercard"); if (!c) return null;
      const img = c.querySelector(".bc-thumb");
      return { session: c.dataset.session, chip: c.querySelector(".bc-url").textContent, title: c.querySelector(".bc-title").textContent,
        thumb: !img.hidden && img.naturalWidth > 0, thumbW: img.naturalWidth, openEnabled: !c.querySelector(".bc-open").disabled,
        cards: document.querySelectorAll("#transcript .browsercard").length, tools: document.querySelectorAll("#transcript .msg.assistant .toolcard").length };
    })()`);
    check(card && /^s_/.test(card.session || ""), `one Cloud browser card for the session (${card && card.session})`);
    check(card && card.cards === 1, `one card, updated in place across two tool calls (${card && card.cards})`);
    check(card && card.thumb && card.thumbW >= 400, `the thumbnail is a real image (${card && card.thumbW} px wide)`);
    check(card && card.chip === "example.com", `the chip names the host (${card && card.chip})`);
    check(card && card.title === "Example Domain", `the title is the page's (${card && card.title})`);
    check(card && card.openEnabled, "Open is enabled once the live view address is known");
    await js(`(function(){ const c = document.querySelector("#transcript .browsercard"); if (c) c.scrollIntoView({ block: "center" }); return true; })()`); await sleep(300);
    await shot("01-cloud-browser-card-light");
    await js(`applyTheme(true); true`); await sleep(400);
    await shot("01b-cloud-browser-card-dark");
    await js(`applyTheme(false); true`); await sleep(300);
    // Open: the live view in a panel, a real page from the service.
    const clicked = await js(`(function(){ try { const b = document.querySelector("#transcript .browsercard .bc-open"); if (!b) return "no button"; b.click(); return "clicked"; } catch (e) { return "error: " + (e && e.stack || e); } })()`);
    check(clicked === "clicked", `Open was pressed (${clicked})`);
    let guest = null;
    for (let i = 0; i < 60 && !guest; i++) {
      await sleep(500);
      guest = webContents.getAllWebContents().find((w) => /\/v1\/sessions\/[^/]+\/view/.test(w.getURL()) && !w.isLoading()) || null;
    }
    await sleep(3000);
    const panel = await js(`(function(){ try { const p = panels.find((x) => x.type === "cloud-browser"); if (!p) return { error: "no cloud-browser panel", types: panels.map((x) => x.type) };
      const el = [...document.querySelectorAll(".workspace-panel")].find((s) => String(s.dataset.id) === String(p.id)) || document.querySelector(".cloud-browser-host") && document.querySelector(".cloud-browser-host").closest(".workspace-panel");
      const v = el && el.querySelector("webview"); const chipEl = el && el.querySelector(".cb-url");
      return { id: String(p.id), found: !!el, session: p.sessionId, chip: chipEl ? chipEl.textContent : "", hasView: !!v, tokenInSrc: !!(v && v.getAttribute("src") && v.getAttribute("src").indexOf("/view?token=") > 0), panelsInDom: document.querySelectorAll(".workspace-panel").length }; } catch (e) { return { error: String(e && e.stack || e) }; } })()`);
    if (panel && panel.error) check(false, `panel state (${panel.error} ${JSON.stringify(panel.types || [])})`);
    check(panel && panel.hasView && panel.tokenInSrc, `the panel hosts the live view address in a webview (panel ${panel && panel.id}, found ${panel && panel.found}, ${panel && panel.panelsInDom} panels in the deck)`);
    check(panel && panel.chip === "example.com", `the panel bar names the page (${panel && panel.chip})`);
    check(!!guest, `the live view page loaded in the panel (${guest ? guest.getTitle() : "no guest"})`);
    await shot("02-cloud-browser-live-view-light");
    console.log(facts.join("\n"));
  } catch (e) {
    console.error("shot failed:", e && e.stack ? e.stack : e);
    process.exitCode = 1;
  } finally {
    try { if (releaseTurn) releaseTurn(); } catch {}
    try { await pool.endAll(); } catch {}
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); fs.rmSync(PROJECT, { recursive: true, force: true }); } catch {}
    app.exit(process.exitCode || 0);
  }
});
