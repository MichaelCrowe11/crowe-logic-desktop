// Crowe Logic desktop — main process (operator engine).
// Owns the window, the gateway bridge (token stays here), a real PTY shell, the
// filesystem, an MCP client, and the agentic tool loop. File edits are gated
// through an approve/reject review unless auto-approve is on.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, exec } = require("child_process");

let pty = null;
try { pty = require("node-pty"); } catch { pty = null; }

const DEFAULTS = {
  baseUrl: "https://foundry-control-plane-production.up.railway.app",
  model: "crowelm",
  token: "",
  cwd: os.homedir(),
  autoApprove: false,     // when true, file edits apply without review
  mcpServers: {},         // { name: { command, args, env } }
};

function configPath() { return path.join(app.getPath("userData"), "config.json"); }
function loadConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath(), "utf8")) }; }
  catch { return { ...DEFAULTS }; }
}
function saveConfig(patch) {
  const merged = { ...loadConfig(), ...patch };
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

let CWD = loadConfig().cwd || os.homedir();
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 840, minWidth: 900, minHeight: 560,
    backgroundColor: "#f5f1e8", title: "Crowe Logic",
    icon: path.join(__dirname, "assets", "icon.icns"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, webviewTag: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// ─── Gateway (with token auto-refresh on 401) ────────────────────────────────
async function refreshToken() {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/crowe-logic/auth.json"), "utf8"));
    if (!auth.refresh_token) return null;
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: "crowe-cli", refresh_token: auth.refresh_token });
    const r = await fetch("https://id.crowelogic.com/realms/crowe/protocol/openid-connect/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const d = await r.json();
    if (d.access_token) { saveConfig({ token: d.access_token }); return d.access_token; }
  } catch { /* noop */ }
  return null;
}
async function gatewayChat(messages, tools, _retried) {
  const cfg = loadConfig();
  if (!cfg.token) return { error: "No token set. Open Settings and paste your Crowe ID token." };
  try {
    const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/api/gateway/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ model: cfg.model, messages, tools: tools || undefined }),
    });
    if (resp.status === 401 && !_retried) { const t = await refreshToken(); if (t) return gatewayChat(messages, tools, true); }
    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = { detail: text }; }
    if (!resp.ok) return { error: `HTTP ${resp.status}: ${(data.detail || text)}`.slice(0, 400) };
    return { content: data.content || "", tool_calls: data.tool_calls || [], model: data.model || cfg.model };
  } catch (e) { return { error: `gateway unreachable: ${String(e).slice(0, 200)}` }; }
}

// ─── MCP client (stdio, newline-delimited JSON-RPC) ──────────────────────────
const MCP = {}; // name -> { proc, tools, send, pending, nextId }
function mcpConnect(name, spec) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn(spec.command, spec.args || [], { env: { ...process.env, ...(spec.env || {}) }, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { return resolve({ error: String(e) }); }
    const srv = { proc, tools: [], pending: new Map(), nextId: 1, buf: "" };
    const send = (msg) => proc.stdin.write(JSON.stringify(msg) + "\n");
    srv.request = (method, params) => new Promise((res, rej) => {
      const id = srv.nextId++; srv.pending.set(id, { res, rej });
      send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => { if (srv.pending.has(id)) { srv.pending.delete(id); rej(new Error("timeout")); } }, 15000);
    });
    srv.notify = (method, params) => send({ jsonrpc: "2.0", method, params });
    proc.stdout.on("data", (chunk) => {
      srv.buf += chunk.toString();
      let i;
      while ((i = srv.buf.indexOf("\n")) >= 0) {
        const line = srv.buf.slice(0, i).trim(); srv.buf = srv.buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && srv.pending.has(msg.id)) {
          const p = srv.pending.get(msg.id); srv.pending.delete(msg.id);
          msg.error ? p.rej(new Error(msg.error.message || "rpc error")) : p.res(msg.result);
        }
      }
    });
    proc.on("error", () => resolve({ error: "spawn failed" }));
    proc.on("exit", () => { delete MCP[name]; });
    (async () => {
      try {
        await srv.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "crowe-logic", version: "0.2" } });
        srv.notify("notifications/initialized", {});
        const list = await srv.request("tools/list", {});
        srv.tools = (list.tools || []).map((t) => ({
          type: "function",
          function: { name: `mcp__${name}__${t.name}`, description: t.description || "", parameters: t.inputSchema || { type: "object", properties: {} } },
        }));
        MCP[name] = srv;
        resolve({ ok: true, tools: srv.tools.length });
      } catch (e) { resolve({ error: String(e) }); }
    })();
  });
}
async function mcpConnectAll() {
  const { mcpServers } = loadConfig();
  for (const [name, spec] of Object.entries(mcpServers || {})) {
    if (spec && spec.command) await mcpConnect(name, spec);
  }
}
async function mcpCall(fullName, args) {
  const [, server, ...rest] = fullName.split("__");
  const tool = rest.join("__");
  const srv = MCP[server];
  if (!srv) return `MCP server '${server}' not connected`;
  const r = await srv.request("tools/call", { name: tool, arguments: args });
  if (Array.isArray(r?.content)) return r.content.map((c) => c.text || JSON.stringify(c)).join("\n").slice(0, 8000);
  return JSON.stringify(r).slice(0, 8000);
}

// ─── Built-in tools ──────────────────────────────────────────────────────────
const BUILTIN_TOOLS = [
  { type: "function", function: { name: "run_shell", description: "Run a shell command in the workspace and return its output.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "read_file", description: "Read a UTF-8 text file (path may be relative to the workspace).", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Create or overwrite a UTF-8 text file. The user reviews the diff before it is applied.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "list_dir", description: "List entries in a directory (defaults to the workspace).", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "open_url", description: "Open a URL in the in-app browser pane.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
];
function allTools() { return [...BUILTIN_TOOLS, ...Object.values(MCP).flatMap((s) => s.tools)]; }

function resolvePath(p) { if (!p) return CWD; p = p.replace(/^~(?=$|\/)/, os.homedir()); return path.isAbsolute(p) ? p : path.join(CWD, p); }
function runShell(command, timeoutMs = 60000) {
  return new Promise((resolve) => {
    exec(command, { cwd: CWD, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: process.env.SHELL || "/bin/zsh" },
      (err, stdout, stderr) => resolve(((stdout || "") + (stderr || "")).slice(0, 40000) || (err ? `(exit ${err.code ?? 1})` : "(no output)")));
  });
}

// ─── Edit review (approve/reject) ────────────────────────────────────────────
let editSeq = 0; const pendingEdits = new Map();
ipcMain.handle("crowe:edit:decide", (_e, { id, approved }) => { const r = pendingEdits.get(id); if (r) { r(approved); pendingEdits.delete(id); } });
function lineDiff(oldStr, newStr) {
  const a = oldStr.split("\n"), b = newStr.split("\n");
  const n = a.length, m = b.length, lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: " ", s: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ t: "-", s: a[i] }); i++; }
    else { out.push({ t: "+", s: b[j] }); j++; }
  }
  while (i < n) out.push({ t: "-", s: a[i++] });
  while (j < m) out.push({ t: "+", s: b[j++] });
  return out;
}
async function proposeEdit(filePath, newContent) {
  const abs = resolvePath(filePath);
  let oldContent = ""; try { oldContent = fs.readFileSync(abs, "utf8"); } catch {}
  if (loadConfig().autoApprove) { fs.writeFileSync(abs, newContent); return `wrote ${filePath} (${newContent.length} bytes, auto-approved)`; }
  const id = ++editSeq;
  if (mainWindow) mainWindow.webContents.send("crowe:agent:event", { type: "edit_proposal", id, path: filePath, diff: lineDiff(oldContent, newContent) });
  const approved = await new Promise((res) => pendingEdits.set(id, res));
  if (approved) { fs.writeFileSync(abs, newContent); return `applied edit to ${filePath}`; }
  return `the user REJECTED the edit to ${filePath}; do not reapply it unless they ask`;
}

async function execTool(name, args) {
  try {
    if (name && name.startsWith("mcp__")) return await mcpCall(name, args);
    if (name === "run_shell") {
      const m = /^\s*cd\s+(.+)$/.exec(args.command || "");
      if (m) { const t = resolvePath(m[1].trim().replace(/^["']|["']$/g, "")); if (fs.existsSync(t) && fs.statSync(t).isDirectory()) { CWD = t; return `cwd -> ${CWD}`; } return `cd: no such directory: ${t}`; }
      return await runShell(args.command);
    }
    if (name === "read_file") return fs.readFileSync(resolvePath(args.path), "utf8").slice(0, 60000);
    if (name === "write_file") return await proposeEdit(args.path, args.content ?? "");
    if (name === "list_dir") return fs.readdirSync(resolvePath(args.path), { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + "/" : d.name)).join("\n");
    if (name === "open_url") { let u = args.url; if (!/^https?:\/\//.test(u)) u = "https://" + u; if (mainWindow) mainWindow.webContents.send("crowe:browser:navigate", u); return `opened ${u}`; }
    return `unknown tool: ${name}`;
  } catch (e) { return `error: ${String(e).slice(0, 300)}`; }
}

// ─── Agentic loop ────────────────────────────────────────────────────────────
ipcMain.handle("crowe:agent:run", async (evt, { messages }) => {
  const send = (ev) => evt.sender.send("crowe:agent:event", ev);
  let msgs = messages.slice();
  for (let round = 0; round < 12; round++) {
    const r = await gatewayChat(msgs, allTools());
    if (r.error) { send({ type: "error", text: r.error }); return { done: true }; }
    if (r.content) send({ type: "assistant", text: r.content });
    const calls = r.tool_calls || [];
    if (!calls.length) { send({ type: "final" }); return { done: true }; }
    msgs.push({ role: "assistant", content: r.content || "", tool_calls: calls });
    for (const tc of calls) {
      let a = {}; try { a = JSON.parse(tc.function?.arguments || "{}"); } catch {}
      send({ type: "tool_call", name: tc.function?.name, args: a });
      const result = await execTool(tc.function?.name, a);
      send({ type: "tool_result", name: tc.function?.name, result: String(result).slice(0, 4000) });
      msgs.push({ role: "tool", tool_call_id: tc.id, name: tc.function?.name, content: String(result) });
    }
  }
  send({ type: "final", note: "reached the tool-round limit" });
  return { done: true };
});
ipcMain.handle("crowe:chat", async (_e, { messages }) => gatewayChat(messages, null));

// ─── PTY terminal ────────────────────────────────────────────────────────────
let ptyProc = null;
ipcMain.handle("crowe:pty:start", (evt, { cols, rows } = {}) => {
  if (!pty) return { ok: false, error: "pty unavailable" };
  if (ptyProc) return { ok: true };
  ptyProc = pty.spawn(process.env.SHELL || "/bin/zsh", [], { name: "xterm-color", cols: cols || 80, rows: rows || 24, cwd: CWD, env: process.env });
  ptyProc.onData((d) => { try { evt.sender.send("crowe:pty:data", d); } catch {} });
  ptyProc.onExit(() => { ptyProc = null; });
  return { ok: true };
});
ipcMain.on("crowe:pty:input", (_e, d) => { if (ptyProc) ptyProc.write(d); });
ipcMain.on("crowe:pty:resize", (_e, { cols, rows }) => { if (ptyProc) { try { ptyProc.resize(cols, rows); } catch {} } });

// ─── Filesystem ──────────────────────────────────────────────────────────────
ipcMain.handle("crowe:fs:list", (_e, dir) => {
  const target = dir ? resolvePath(dir) : CWD;
  try {
    const entries = fs.readdirSync(target, { withFileTypes: true }).filter((d) => !d.name.startsWith("."))
      .map((d) => ({ name: d.name, dir: d.isDirectory() })).sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { cwd: path.resolve(target), entries };
  } catch (e) { return { cwd: target, entries: [], error: String(e) }; }
});
ipcMain.handle("crowe:fs:read", (_e, p) => { try { return { content: fs.readFileSync(resolvePath(p), "utf8").slice(0, 200000) }; } catch (e) { return { error: String(e) }; } });

// ─── Config + status ─────────────────────────────────────────────────────────
ipcMain.handle("crowe:get-config", () => {
  const c = loadConfig();
  return { baseUrl: c.baseUrl, hasToken: Boolean(c.token), cwd: CWD, autoApprove: c.autoApprove,
    mcp: Object.entries(MCP).map(([n, s]) => ({ name: n, tools: s.tools.length })), ptyAvailable: Boolean(pty) };
});
ipcMain.handle("crowe:set-config", async (_e, patch) => {
  const c = saveConfig(patch || {});
  if (patch && patch.cwd) CWD = patch.cwd;
  if (patch && patch.mcpServers) await mcpConnectAll();
  return { baseUrl: c.baseUrl, hasToken: Boolean(c.token), cwd: CWD, autoApprove: c.autoApprove,
    mcp: Object.entries(MCP).map(([n, s]) => ({ name: n, tools: s.tools.length })), ptyAvailable: Boolean(pty) };
});

app.whenReady().then(async () => {
  createWindow();
  mcpConnectAll();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
