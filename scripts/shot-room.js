#!/usr/bin/env node
/* Boot the real app against a stubbed gateway, drive one room the way the
   founder would, and photograph it. The stub answers like a seat that works
   out loud: a progress line and a read-only tool call first, then a reply that
   ends on a question with options. Nothing here is a test; it is eyes.

     CROWE_ALLOW_PLAINTEXT_AUTH=1 npx electron scripts/shot-room.js

   Prints the screenshot paths. Isolated profile and workspace; no member
   credentials; the network is replaced at fetch, as scripts/test-rooms-live.js
   does, so every line of the product runs untouched. */
const { app, BrowserWindow, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-shot-room-profile-"));
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-shot-room-workspace-"));
const OUT = process.env.CROWE_SHOT_OUT || fs.mkdtempSync(path.join(os.tmpdir(), "crowe-room-shots-"));
fs.mkdirSync(OUT, { recursive: true });
app.setPath("userData", PROFILE);
app.setPath("sessionData", PROFILE);
fs.writeFileSync(path.join(PROFILE, "config.json"), JSON.stringify({ cwd: WORKSPACE, telemetry: false, onboarded: true, autonomy: "edit" }), { mode: 0o600 });
fs.writeFileSync(path.join(WORKSPACE, "README.md"), "# scratch\n");

function writeTestSession() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const token = `${b64({ alg: "none", typ: "JWT" })}.${b64({ email: "rooms-shot@example.com", crowe_tier: "pro", tier: "pro", exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
  const store = JSON.stringify({ token, refreshToken: "" });
  const file = path.join(PROFILE, "auth.bin");
  if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(file, safeStorage.encryptString(store), { mode: 0o600 });
  else if (process.env.CROWE_ALLOW_PLAINTEXT_AUTH === "1" && !app.isPackaged) fs.writeFileSync(file, store, { mode: 0o600 });
  else throw new Error("no credential encryption here and CROWE_ALLOW_PLAINTEXT_AUTH is not set");
}

/* The stub seat. Call one: a progress line and a list_dir. Call two: the
   finding, and a question put through propose_options. Every call after: a
   short reply, so the tap and the routine both get an answer. */
const calls = [];
global.fetch = async (url, init = {}) => {
  const u = String(url);
  let payload = {}; try { payload = JSON.parse(init.body || "{}"); } catch {}
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  if (u.includes("/api/gateway/catalog")) return json({ models: [] });
  if (!u.includes("/api/gateway/chat")) return json({});
  calls.push(payload);
  const usage = { prompt_tokens: 140, completion_tokens: 40 };
  const hasTool = (payload.messages || []).some((m) => m && m.role === "tool");
  const lastUser = String(([...(payload.messages || [])].reverse().find((m) => m && m.role === "user") || {}).content || "");
  if (/snapshot/i.test(lastUser) && !hasTool) {
    return json({ content: "Checking the crontab and launchd on this Mac first, then the channel for a new public Short.",
      tool_calls: [{ id: "c1", type: "function", function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) } }], usage });
  }
  if (/snapshot/i.test(lastUser) && hasTool) {
    return json({ content: "195k subs, 741 videos. Trailing 28 days: $276.49, down 5 percent. Shorts did 164k views and earned nothing monetized. A live uploader is still dropping two unvoiced, machine-titled Shorts a day around 09:00 and 18:00; it is not on this Mac's crontab or launchd. Next drop is likely around 9:00. I will not touch Studio, visibility or settings unless you ask.",
      tool_calls: [{ id: "c2", type: "function", function: { name: "propose_options", arguments: JSON.stringify({ question: "Stop the machine Shorts job?", options: ["Stop the shorts job", "Leave it running, keep watching"] }) } }], usage });
  }
  if (/Stop the shorts job/i.test(lastUser)) {
    return json({ content: "Stopping it. Next drop is about five minutes out. Hunting anything that can still fire, including the other Pro on Tailscale.", usage });
  }
  return json({ content: "Nothing uploading on this Mac right now. The 9am launchd here is sales, outreach and shipping, not Shorts. Checking the channel for a new public Short and hunting off-box.", usage });
};

require(path.join(__dirname, "..", "main.js"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    await sleep(600);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("no window");
    win.setContentSize(1500, 940);
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once("did-finish-load", r));
    await sleep(1200);
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => { const img = await win.webContents.capturePage(); const p = path.join(OUT, name + ".png"); fs.writeFileSync(p, img.toPNG()); console.log("shot:", p); };
    writeTestSession();
    const cfg = await js(`window.crowe.getConfig()`);
    if (!cfg || !cfg.hasToken) throw new Error("main.js does not see the test session");

    const made = await js(`window.crowe.rooms.create({ title: "SWM Ops", agentIds: ["operator"], brief: "Run Southwest Mushrooms channel operations. Voiced Shorts only since Sep 2. Never touch Studio, visibility or settings unless asked." })`);
    if (!made || !made.room) throw new Error("create failed: " + JSON.stringify(made));
    const id = made.room.id;
    await js(`window.crowe.rooms.routineAdd(${JSON.stringify(id)}, { agentId: "operator", every: "daily", at: "07:00", text: "Morning snapshot of the channel: subs, revenue, anything unvoiced that slipped through, and one next action." })`);
    // A second room, so the forward chooser has somewhere to point.
    await js(`window.crowe.rooms.create({ title: "SWM Content", agentIds: ["studio"], brief: "Films and Shorts for the channel." })`);

    // The panel object holds functions, which IPC cannot clone; resolve to a flag.
    await js(`openRoomPanel(${JSON.stringify(id)}, "SWM Ops").then(() => true)`);
    await sleep(800);
    // Show the rooms drawer if the rail is on sessions.
    await js(`(function(){ const d=document.getElementById("rooms-drawer"); if(d) d.classList.remove("hidden"); const s=document.getElementById("sessions-drawer"); if(s) s.classList.add("hidden"); })()`);
    const say = await js(`window.crowe.rooms.say(${JSON.stringify(id)}, "morning snapshot please")`);
    await sleep(900);
    await shot("01-room-ask-open");
    const msgs = (await js(`window.crowe.rooms.load(${JSON.stringify(id)})`)).messages;
    const asked = msgs.find((m) => m.ask);
    console.log("kinds:", msgs.map((m) => m.kind).join(","), "| ask:", asked ? asked.ask.question : "none", "| calls:", calls.length);
    if (asked) {
      await js(`document.querySelector('.ask-opt')?.click()`);
      await sleep(1500);
    }
    // A gate raised by main for a room seat carries only the seat's composite
    // id. The room thread must draw it, and expiry must close it.
    win.webContents.send("crowe:agent:event", { type: "approval_request", id: 424242, agentId: "room:" + id + ":operator", kind: "room_connector",
      title: "Let a room seat act through a connector", risk: "review", expiresInMs: 60000,
      why: "calls a connected server's tool (youtube: set_video_visibility) from a room that may only read, and the tool's name does not say it only looks",
      detail: 'youtube set_video_visibility {"id":"FD0hpJzKKec","visibility":"private"}',
      meta: { seat: "room:" + id + ":operator", connector: "youtube", tool: "set_video_visibility" } });
    await sleep(500);
    const drawn = await js(`(function(){ const c=document.querySelector('.room-thread .rmsg.is-gate .gatecard'); return c ? { ok:true, title:c.querySelector('.ec-title').textContent, label:c.querySelector('.ec-path').textContent, why:c.querySelector('.gc-why').textContent.slice(0,80) } : { ok:false }; })()`);
    console.log("approval card in room thread:", JSON.stringify(drawn));
    await shot("03-room-approval-card");
    win.webContents.send("crowe:agent:event", { type: "approval_expired", id: 424242, agentId: "room:" + id + ":operator" });
    await sleep(300);
    const expired = await js(`(function(){ const c=document.querySelector('.room-thread .gatecard'); return c ? c.classList.contains('rejected') + ' ' + (c.querySelector('.ec-status')||{}).textContent : 'no card'; })()`);
    console.log("after expiry:", expired);
    await js(`document.querySelector('.room-details')?.click()`);
    await sleep(700);
    await shot("02-room-answered-details");
    const rail = await js(`[...document.querySelectorAll('#room-list .room-row')].map(r => r.textContent.replace(/\\s+/g,' ').trim())`);
    console.log("rail rows:", JSON.stringify(rail));
    const after = (await js(`window.crowe.rooms.load(${JSON.stringify(id)})`));
    console.log("after tap kinds:", after.messages.map((m) => m.kind + (m.quote ? "(quoted)" : "")).join(","), "| unread:", after.room.unread, "| routines:", after.room.routines.length);
    const errors = await js(`window.__consoleErrors || []`);
    console.log("console errors:", JSON.stringify(errors));
    console.log("out:", OUT);
  } catch (e) {
    console.error("shot-room failed:", e && e.stack || e);
    process.exitCode = 1;
  } finally {
    try { require(path.join(__dirname, "..", "main.js")).shutdownNativeResources(); } catch {}
    setTimeout(() => app.exit(process.exitCode || 0), 300);
  }
});
