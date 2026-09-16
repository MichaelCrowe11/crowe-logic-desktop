#!/usr/bin/env node
/* The bundled plugin server, forked the way the packaged app forks it.

     CROWE_ALLOW_PLAINTEXT_AUTH=1 npx electron scripts/test-plugin-fork.js

   scripts/test-channel-analytics.js drives the server as `node server.js` over
   stdio. That is not how the app runs it: a packaged build has the RunAsNode
   fuse off, so its binary will not run a script as plain Node, and the one Node
   runtime it carries is an Electron utility process, which has no stdin. This
   boots the real main.js on an isolated profile, enables Channel Analytics
   through the Settings IPC, and checks what only that path can answer:

   - the ${NODE} manifest command becomes a utility process, visible to the app
     as such, and not a second Electron under ELECTRON_RUN_AS_NODE;
   - a room seat's read comes back through that process's message port with
     the payload the fixture planted, and its collect is still held at the tier;
   - Disable ends the process and Enable forks a fresh one under the same name.

   The state the server reads is a fixture: the folder rides in on the app's
   environment, the same way a shell variable would reach any plugin server.
   Exit 1 on the first check that fails. */
const { app, BrowserWindow, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-fork-profile-"));
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-fork-workspace-"));
const MANAGER = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-fork-manager-"));
app.setPath("userData", PROFILE);
app.setPath("sessionData", PROFILE);
fs.writeFileSync(path.join(PROFILE, "config.json"), JSON.stringify({ cwd: WORKSPACE, telemetry: false, onboarded: true, autonomy: "execute" }), { mode: 0o600 });

// The fixture: one open hand task with a name nothing real would carry.
fs.mkdirSync(path.join(MANAGER, "state"));
fs.writeFileSync(path.join(MANAGER, "state", "hand_tasks.json"), JSON.stringify([
  { id: "fork-proof-task", value: 0.9, done: false, title: "Read through the port", why: "the seat must see this", how: "n/a", probe: { kind: "none" } },
]));
process.env.SWM_CHANNEL_MANAGER_DIR = MANAGER;
process.env.SWM_CHANNEL_EVIDENCE_DIR = MANAGER;
delete process.env.ELECTRON_RUN_AS_NODE;

const SERVICE = "crowe-plugin-channel-analytics";
let checks = 0;
const check = (cond, what) => { if (!cond) throw new Error(what); checks += 1; console.log(`  ok   ${what}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const utilityProcesses = () => app.getAppMetrics().filter((m) => m.type === "Utility" && m.name === SERVICE);

function writeTestSession() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const token = `${b64({ alg: "none", typ: "JWT" })}.${b64({ email: "fork-test@example.com", crowe_tier: "pro", tier: "pro", exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
  const store = JSON.stringify({ token, refreshToken: "" });
  const file = path.join(PROFILE, "auth.bin");
  if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(file, safeStorage.encryptString(store), { mode: 0o600 });
  else if (process.env.CROWE_ALLOW_PLAINTEXT_AUTH === "1" && !app.isPackaged) fs.writeFileSync(file, store, { mode: 0o600 });
  else throw new Error("no credential encryption here and CROWE_ALLOW_PLAINTEXT_AUTH is not set");
}

/* The stub seat: list the hand tasks, then try to collect, then answer. */
const seen = [];
global.fetch = async (url, init = {}) => {
  const u = String(url);
  let payload = {}; try { payload = JSON.parse(init.body || "{}"); } catch {}
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  if (u.includes("/api/gateway/catalog")) return json({ models: [] });
  if (!u.includes("/api/gateway/chat")) return json({});
  const usage = { prompt_tokens: 100, completion_tokens: 20 };
  const toolMsgs = (payload.messages || []).filter((m) => m && m.role === "tool");
  seen.push((payload.tools || []).map((t) => t.function && t.function.name));
  if (toolMsgs.length === 0) return json({ content: "Reading the task register.", tool_calls: [{ id: "c1", type: "function", function: { name: "mcp__channel-analytics__list_hand_tasks", arguments: "{}" } }], usage });
  if (toolMsgs.length === 1) return json({ content: "Trying a collect.", tool_calls: [{ id: "c2", type: "function", function: { name: "mcp__channel-analytics__run_collect", arguments: "{}" } }], usage });
  return json({ content: "Register read; the collect was refused by the tier.", usage });
};

require(path.join(__dirname, "..", "main.js"));
app.whenReady().then(async () => {
  let ok = false;
  try {
    await sleep(600);
    const win = BrowserWindow.getAllWindows()[0];
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once("did-finish-load", r));
    await sleep(800);
    const js = (code) => win.webContents.executeJavaScript(code);
    writeTestSession();
    const cfg = await js(`window.crowe.getConfig()`);
    check(cfg && cfg.hasToken, "main.js sees the test session");
    check(utilityProcesses().length === 0, "no plugin utility process exists before Enable");

    const enabled = await js(`window.crowe.plugins.enable("channel-analytics", {})`);
    check(enabled && enabled.ok && enabled.tools === 10, `Enable connects the bundled server with its ten tools (${JSON.stringify(enabled)})`);
    const listed = (await js(`window.crowe.plugins.list()`)).find((p) => p.id === "channel-analytics");
    check(listed.connected && listed.toolCount === 10, "the plugin list reads it as connected");
    const forked = utilityProcesses();
    check(forked.length === 1 && forked[0].pid > 0, `the server runs as an Electron utility process named ${SERVICE} (pid ${forked[0] && forked[0].pid})`);
    const firstPid = forked[0].pid;

    const made = await js(`window.crowe.rooms.create({ title: "Fork proof", agentIds: ["operator"], brief: "Read the channel manager's task register." })`);
    const id = made.room.id;
    await js(`window.__ev = []; window.crowe.agent.onEvent((e) => { if (e.roomId === ${JSON.stringify(id)} && (e.type === "tool_call" || e.type === "tool_result")) window.__ev.push({ type: e.type, name: e.name, result: String(e.result || "") }); }); true`);
    const out = await js(`window.crowe.rooms.say(${JSON.stringify(id)}, "what is open")`);
    await sleep(500);
    const events = await js(`window.__ev`);
    check(seen[0] && seen[0].includes("mcp__channel-analytics__list_hand_tasks"), "the seat was offered the plugin's tools");
    const read = events.find((e) => e.type === "tool_result" && e.name === "mcp__channel-analytics__list_hand_tasks");
    let tasks = null; try { tasks = JSON.parse(read.result); } catch {}
    check(tasks && tasks.count === 1 && tasks.tasks[0].id === "fork-proof-task", "the seat's read came back through the port with the fixture's task");
    const collect = events.find((e) => e.type === "tool_result" && e.name === "mcp__channel-analytics__run_collect");
    check(collect && /^blocked: this plugin tool requires "edit"/.test(collect.result), `the collect was held at the room's tier (${out.room && out.room.tier})`);

    const disabled = await js(`window.crowe.plugins.disable("channel-analytics")`);
    check(disabled && disabled.ok, "Disable answers ok");
    for (let i = 0; i < 40 && utilityProcesses().length; i++) await sleep(100);
    check(utilityProcesses().length === 0, "Disable ends the utility process");
    check(!(await js(`window.crowe.plugins.list()`)).find((p) => p.id === "channel-analytics").connected, "the plugin list reads it as disconnected");

    const again = await js(`window.crowe.plugins.enable("channel-analytics", {})`);
    const second = utilityProcesses();
    check(again && again.ok && again.tools === 10 && second.length === 1 && second[0].pid !== firstPid, `Enable again forks a fresh process (pid ${second[0] && second[0].pid})`);

    ok = true;
    console.log(`\nplugin fork: ${checks} checks passed`);
  } catch (e) {
    console.error("plugin fork: FAIL", e && e.stack || e);
  } finally {
    try { require(path.join(__dirname, "..", "main.js")).shutdownNativeResources(); } catch {}
    setTimeout(() => app.exit(ok ? 0 : 1), 300);
  }
});
