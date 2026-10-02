#!/usr/bin/env node
/* The scheduler, end to end: a room saved to disk with a routine already due
   is booted into the real app, and the first tick has to claim it, run it
   through the real IPC-less path (main owns the room), persist the reply and
   move the rail. Eyes, not a suite; prints what it found.

     CROWE_ALLOW_PLAINTEXT_AUTH=1 npx electron scripts/shot-routine.js */
const { app, BrowserWindow, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-shot-routine-profile-"));
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-shot-routine-workspace-"));
app.setPath("userData", PROFILE);
app.setPath("sessionData", PROFILE);
fs.writeFileSync(path.join(PROFILE, "config.json"), JSON.stringify({ cwd: WORKSPACE, telemetry: false, onboarded: true, autonomy: "edit" }), { mode: 0o600 });

// A room from "yesterday" whose daily routine came due three minutes ago:
// inside the grace window, so the tick must run it rather than skip it.
const engine = require(path.join(__dirname, "..", "rooms", "engine.js"));
const room = engine.createRoom({ id: "r-routine-check", title: "Crowe Logic scheduler check", agentIds: ["operator"], brief: "A test room. Answer in one line." });
const added = engine.addRoutine(room, { agentId: "operator", every: "daily", at: "07:00", text: "Morning snapshot: one line, then one next action." }, Date.now());
added.routine.nextRunAt = Date.now() - 3 * 60 * 1000;
// And one that is far too late: it must be skipped with a note, not run.
const late = engine.addRoutine(room, { agentId: "operator", every: "daily", at: "06:00", text: "Night collect." }, Date.now());
late.routine.nextRunAt = Date.now() - 5 * 60 * 60 * 1000;
fs.mkdirSync(path.join(PROFILE, "sessions"), { recursive: true });
fs.writeFileSync(path.join(PROFILE, "sessions", room.id + ".json"), JSON.stringify(engine.toSession(room), null, 2));

function writeTestSession() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const token = `${b64({ alg: "none", typ: "JWT" })}.${b64({ email: "rooms-shot@example.com", crowe_tier: "pro", tier: "pro", exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
  const store = JSON.stringify({ token, refreshToken: "" });
  const file = path.join(PROFILE, "auth.bin");
  if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(file, safeStorage.encryptString(store), { mode: 0o600 });
  else if (process.env.CROWE_ALLOW_PLAINTEXT_AUTH === "1" && !app.isPackaged) fs.writeFileSync(file, store, { mode: 0o600 });
  else throw new Error("no credential encryption here and CROWE_ALLOW_PLAINTEXT_AUTH is not set");
}

const calls = [];
global.fetch = async (url, init = {}) => {
  const u = String(url);
  let payload = {}; try { payload = JSON.parse(init.body || "{}"); } catch {}
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  if (u.includes("/api/gateway/catalog")) return json({ models: [] });
  if (!u.includes("/api/gateway/chat")) return json({});
  calls.push(payload);
  return json({ content: "195k subs, revenue flat. One next action: stop the machine Shorts job.", usage: { prompt_tokens: 100, completion_tokens: 20 } });
};

require(path.join(__dirname, "..", "main.js"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  try {
    await sleep(600);
    const win = BrowserWindow.getAllWindows()[0];
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once("did-finish-load", r));
    const js = (code) => win.webContents.executeJavaScript(code);
    // After ready, so safeStorage can encrypt it the way main.js will read it;
    // the scheduler's first tick is five seconds after ready.
    writeTestSession();
    const cfg = await js(`window.crowe.getConfig()`);
    if (!cfg || !cfg.hasToken) throw new Error("main.js does not see the test session");
    // The scheduler's first tick is five seconds after ready.
    const t0 = Date.now();
    let loaded = null;
    while (Date.now() - t0 < 25000) {
      await sleep(1000);
      loaded = await js(`window.crowe.rooms.load("r-routine-check")`);
      if (loaded && loaded.messages && loaded.messages.some((m) => m.kind === "reply")) break;
    }
    const kinds = (loaded.messages || []).map((m) => `${m.author}:${m.kind}`);
    console.log("messages:", kinds.join(", "));
    console.log("gateway calls:", calls.length, "(must be 1: the due routine ran, the late one did not)");
    for (const r of loaded.room.routines) console.log(`routine ${r.at}: status "${r.lastStatus}", next ${new Date(r.nextRunAt).toLocaleString()}, runs ${r.runs}`);
    const onDisk = JSON.parse(fs.readFileSync(path.join(PROFILE, "sessions", "r-routine-check.json"), "utf8"));
    console.log("persisted messages:", onDisk.messages.length, "| unread:", loaded.room.unread);
    const rail = await js(`[...document.querySelectorAll('#room-list .room-row')].map(r => r.className + ' :: ' + r.textContent.replace(/\\s+/g,' ').trim())`);
    console.log("rail:", JSON.stringify(rail));
    const ran = loaded.room.routines.find((r) => r.at === "07:00"), stale = loaded.room.routines.find((r) => r.at === "06:00");
    const diskKinds = onDisk.messages.map((m) => `${m.author}:${m.kind}`);
    const routineMsg = onDisk.messages.find((m) => m.kind === "routine");
    const ok = calls.length === 1
      && kinds.includes(":routine:routine") && kinds.includes("operator:reply") && kinds.includes(":system:note")
      && diskKinds.join() === kinds.join()                                   // what the window shows is what is on disk
      && ran && ran.lastStatus === "ran" && ran.runs === 1                   // the due routine ran once
      && routineMsg && routineMsg.routineId === ran.id                        // and it is the one that posted
      && stale && /^skipped/.test(stale.lastStatus) && stale.runs === 0;      // the stale one did not
    if (!ok) console.log("detail:", JSON.stringify({ diskKinds, ran: ran && ran.lastStatus, stale: stale && stale.lastStatus, routineId: routineMsg && routineMsg.routineId }));
    console.log(ok ? "SCHEDULER OK" : "SCHEDULER NOT AS EXPECTED");
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    console.error("shot-routine failed:", e && e.stack || e);
    process.exitCode = 1;
  } finally {
    try { require(path.join(__dirname, "..", "main.js")).shutdownNativeResources(); } catch {}
    setTimeout(() => app.exit(process.exitCode || 0), 300);
  }
});
