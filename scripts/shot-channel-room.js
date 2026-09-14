#!/usr/bin/env node
/* A room seat reads the channel through the bundled plugin, in the real app.

   Boots the app on an isolated profile, enables Channel Analytics through the
   same IPC the Settings switch uses (so the manifest placeholders, the
   Electron-as-node spawn and the tools/list handshake all run for real),
   opens a one-seat room, and drives a turn in which the seat calls
   get_channel_snapshot, then tries run_collect, then answers. Reads the
   machine's real channel-manager state, read-only; the gateway is stubbed.

     CROWE_ALLOW_PLAINTEXT_AUTH=1 npx electron scripts/shot-channel-room.js

   Prints what the seat saw. Exit 1 if the read did not reach the seat or the
   collect was not blocked by the room's tier. */
const { app, BrowserWindow, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-shot-channel-profile-"));
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-shot-channel-workspace-"));
app.setPath("userData", PROFILE);
app.setPath("sessionData", PROFILE);
fs.writeFileSync(path.join(PROFILE, "config.json"), JSON.stringify({ cwd: WORKSPACE, telemetry: false, onboarded: true, autonomy: "execute" }), { mode: 0o600 });

function writeTestSession() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const token = `${b64({ alg: "none", typ: "JWT" })}.${b64({ email: "rooms-shot@example.com", crowe_tier: "pro", tier: "pro", exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
  const store = JSON.stringify({ token, refreshToken: "" });
  const file = path.join(PROFILE, "auth.bin");
  if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(file, safeStorage.encryptString(store), { mode: 0o600 });
  else if (process.env.CROWE_ALLOW_PLAINTEXT_AUTH === "1" && !app.isPackaged) fs.writeFileSync(file, store, { mode: 0o600 });
  else throw new Error("no credential encryption here and CROWE_ALLOW_PLAINTEXT_AUTH is not set");
}

/* The stub seat: read the snapshot, then try to collect, then answer. What it
   is offered is checked too: the plugin's tools must be in the tools array. */
const seen = [];
global.fetch = async (url, init = {}) => {
  const u = String(url);
  let payload = {}; try { payload = JSON.parse(init.body || "{}"); } catch {}
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  if (u.includes("/api/gateway/catalog")) return json({ models: [] });
  if (!u.includes("/api/gateway/chat")) return json({});
  const usage = { prompt_tokens: 200, completion_tokens: 40 };
  const toolNames = (payload.tools || []).map((t) => t.function && t.function.name);
  const toolMsgs = (payload.messages || []).filter((m) => m && m.role === "tool");
  seen.push({ tools: toolNames, toolMsgs: toolMsgs.map((m) => String(m.content || "").slice(0, 200)) });
  if (toolMsgs.length === 0) {
    return json({ content: "Reading the channel manager's snapshot.", tool_calls: [{ id: "c1", type: "function", function: { name: "mcp__channel-analytics__get_channel_snapshot", arguments: "{}" } }], usage });
  }
  if (toolMsgs.length === 1) {
    return json({ content: "Numbers in hand. Trying a fresh collect.", tool_calls: [{ id: "c2", type: "function", function: { name: "mcp__channel-analytics__run_collect", arguments: "{}" } }], usage });
  }
  return json({ content: "Snapshot read; the collect was refused by the room's tier, as it should be. One next action: decide the Shorts automation.", usage });
};

require(path.join(__dirname, "..", "main.js"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    if (!cfg || !cfg.hasToken) throw new Error("main.js does not see the test session");

    const enabled = await js(`window.crowe.plugins.enable("channel-analytics", {})`);
    console.log("enable:", JSON.stringify(enabled));
    const listed = (await js(`window.crowe.plugins.list()`)).find((p) => p.id === "channel-analytics");
    console.log("plugin:", JSON.stringify({ enabled: listed.enabled, connected: listed.connected, toolCount: listed.toolCount, available: listed.available }));
    if (!listed.connected || listed.toolCount !== 10) throw new Error("the plugin did not connect with its ten tools");

    const made = await js(`window.crowe.rooms.create({ title: "SWM Ops", agentIds: ["operator"], brief: "Run Southwest Mushrooms channel operations. Read the channel manager's snapshot before you say a number." })`);
    const id = made.room.id;
    const events = [];
    // Tool traffic is read off the same event stream the room panel uses.
    await js(`window.__ev = []; window.crowe.agent.onEvent((e) => { if (e.roomId === ${JSON.stringify(id)} && (e.type === "tool_call" || e.type === "tool_result")) window.__ev.push({ type: e.type, name: e.name, result: String(e.result || "").slice(0, 400) }); }); true`);
    const out = await js(`window.crowe.rooms.say(${JSON.stringify(id)}, "morning snapshot")`);
    await sleep(500);
    events.push(...(await js(`window.__ev`)));

    console.log("tier:", out.room && out.room.tier, "| seat offered plugin tools:", seen[0].tools.filter((t) => t.startsWith("mcp__channel-analytics__")).length);
    const read = events.find((e) => e.type === "tool_result" && e.name === "mcp__channel-analytics__get_channel_snapshot");
    const collect = events.find((e) => e.type === "tool_result" && e.name === "mcp__channel-analytics__run_collect");
    console.log("snapshot result head:", read ? read.result.slice(0, 220).replace(/\n/g, " | ") : "none");
    console.log("collect result:", collect ? collect.result.slice(0, 160) : "none");
    const kinds = (await js(`window.crowe.rooms.load(${JSON.stringify(id)})`)).messages.map((m) => m.kind).join(",");
    console.log("room messages:", kinds);
    ok = Boolean(read && /subscribers/.test(read.result) && collect && /^blocked: this plugin tool requires "edit"/.test(collect.result) && /progress/.test(kinds));
    console.log(ok ? "CHANNEL ROOM OK" : "CHANNEL ROOM NOT AS EXPECTED");
  } catch (e) {
    console.error("shot-channel-room failed:", e && e.stack || e);
  } finally {
    try { require(path.join(__dirname, "..", "main.js")).shutdownNativeResources(); } catch {}
    setTimeout(() => app.exit(ok ? 0 : 1), 300);
  }
});
