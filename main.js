// Crowe Logic desktop — main process.
// The operator engine: owns the window, the gateway bridge (token stays here),
// a real shell, the filesystem, and the agentic tool loop that lets CroweLM
// actually run commands, edit files, and drive the browser. The renderer is a
// thin surface; every privileged capability is here behind IPC.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, exec } = require("child_process");

const DEFAULTS = {
  baseUrl: "https://foundry-control-plane-production.up.railway.app",
  model: "crowelm", // the daily driver (gpt-5.6). Never surfaced raw in the UI.
  token: "",
  cwd: os.homedir(),
};

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}
function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath(), "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveConfig(patch) {
  const merged = { ...loadConfig(), ...patch };
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

// Workspace cwd for the shell + agent tools. Mutable across the session.
let CWD = loadConfig().cwd || os.homedir();

let mainWindow = null;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#f5f1e8",
    title: "Crowe Logic",
    icon: path.join(__dirname, "assets", "icon.icns"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // the in-app browser pane
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// ─── Gateway ────────────────────────────────────────────────────────────────
// Crowe ID tokens expire (~30 min); refresh transparently on a 401 so the app
// keeps working across a session without re-pasting a token.
async function refreshToken() {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/crowe-logic/auth.json"), "utf8"));
    if (!auth.refresh_token) return null;
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: "crowe-cli", refresh_token: auth.refresh_token });
    const r = await fetch("https://id.crowelogic.com/realms/crowe/protocol/openid-connect/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const d = await r.json();
    if (d.access_token) { saveConfig({ token: d.access_token }); return d.access_token; }
  } catch { /* fall through */ }
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
    if (resp.status === 401 && !_retried) {
      const t = await refreshToken();
      if (t) return gatewayChat(messages, tools, true);
    }
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { detail: text }; }
    if (!resp.ok) return { error: `HTTP ${resp.status}: ${(data.detail || text)}`.slice(0, 400) };
    return {
      content: data.content || "",
      tool_calls: data.tool_calls || [],
      model: data.model || cfg.model,
    };
  } catch (e) {
    return { error: `gateway unreachable: ${String(e).slice(0, 200)}` };
  }
}

// ─── Tools the agent can call ────────────────────────────────────────────────
const TOOLS = [
  { type: "function", function: {
    name: "run_shell", description: "Run a shell command in the workspace and return its output.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: {
    name: "read_file", description: "Read a UTF-8 text file. Path may be relative to the workspace.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: {
    name: "write_file", description: "Write (create/overwrite) a UTF-8 text file.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: {
    name: "list_dir", description: "List entries in a directory (defaults to the workspace).",
    parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: {
    name: "open_url", description: "Open a URL in the in-app browser pane.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
];

function resolvePath(p) {
  if (!p) return CWD;
  return path.isAbsolute(p) ? p : path.join(CWD, p);
}

function runShell(command, timeoutMs = 60000) {
  return new Promise((resolve) => {
    exec(command, { cwd: CWD, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: process.env.SHELL || "/bin/zsh" },
      (err, stdout, stderr) => {
        const out = (stdout || "") + (stderr || "");
        resolve(out.slice(0, 40000) || (err ? `(exit ${err.code ?? 1})` : "(no output)"));
      });
  });
}

async function execTool(name, args) {
  try {
    if (name === "run_shell") {
      // Track cd so the workspace persists across calls.
      const m = /^\s*cd\s+(.+)$/.exec(args.command || "");
      if (m) {
        const target = resolvePath(m[1].trim().replace(/^["']|["']$/g, ""));
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) { CWD = target; return `cwd -> ${CWD}`; }
        return `cd: no such directory: ${target}`;
      }
      if (mainWindow) mainWindow.webContents.send("crowe:term:echo", `$ ${args.command}\n`);
      const out = await runShell(args.command);
      if (mainWindow) mainWindow.webContents.send("crowe:term:data", out + "\n");
      return out;
    }
    if (name === "read_file") return fs.readFileSync(resolvePath(args.path), "utf8").slice(0, 60000);
    if (name === "write_file") { fs.writeFileSync(resolvePath(args.path), args.content ?? ""); return `wrote ${args.path} (${(args.content || "").length} bytes)`; }
    if (name === "list_dir") {
      const dir = resolvePath(args.path);
      return fs.readdirSync(dir, { withFileTypes: true })
        .map((d) => (d.isDirectory() ? d.name + "/" : d.name)).join("\n");
    }
    if (name === "open_url") {
      let url = args.url; if (!/^https?:\/\//.test(url)) url = "https://" + url;
      if (mainWindow) mainWindow.webContents.send("crowe:browser:navigate", url);
      return `opened ${url} in the browser pane`;
    }
    return `unknown tool: ${name}`;
  } catch (e) {
    return `error: ${String(e).slice(0, 300)}`;
  }
}

// ─── Agentic loop: chat -> tool_calls -> execute -> repeat ───────────────────
ipcMain.handle("crowe:agent:run", async (evt, { messages }) => {
  const send = (ev) => evt.sender.send("crowe:agent:event", ev);
  let msgs = messages.slice();
  for (let round = 0; round < 10; round++) {
    const r = await gatewayChat(msgs, TOOLS);
    if (r.error) { send({ type: "error", text: r.error }); return { done: true }; }
    if (r.content) send({ type: "assistant", text: r.content });
    const calls = r.tool_calls || [];
    if (!calls.length) { send({ type: "final" }); return { done: true }; }
    msgs.push({ role: "assistant", content: r.content || "", tool_calls: calls });
    for (const tc of calls) {
      let args = {}; try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
      send({ type: "tool_call", name: tc.function?.name, args });
      const result = await execTool(tc.function?.name, args);
      send({ type: "tool_result", name: tc.function?.name, result: String(result).slice(0, 4000) });
      msgs.push({ role: "tool", tool_call_id: tc.id, name: tc.function?.name, content: String(result) });
    }
  }
  send({ type: "final", note: "reached the 10-round tool limit" });
  return { done: true };
});

// Plain (non-agent) chat, kept for simple turns.
ipcMain.handle("crowe:chat", async (_e, { messages }) => gatewayChat(messages, null));

// ─── Terminal (command runner over the workspace shell) ──────────────────────
ipcMain.handle("crowe:term:run", async (evt, command) => {
  const m = /^\s*cd\s+(.*)$/.exec(command || "");
  if (m) {
    const raw = m[1].trim().replace(/^["']|["']$/g, "") || os.homedir();
    const target = resolvePath(raw.replace(/^~(?=$|\/)/, os.homedir()));
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) { CWD = target; return { cwd: CWD, output: "" }; }
    return { cwd: CWD, output: `cd: no such directory: ${target}\n` };
  }
  const output = await runShell(command);
  return { cwd: CWD, output: output + "\n" };
});
ipcMain.handle("crowe:term:cwd", () => ({ cwd: CWD }));

// ─── Filesystem for the file tree ────────────────────────────────────────────
ipcMain.handle("crowe:fs:list", (_e, dir) => {
  const target = dir ? resolvePath(dir) : CWD;
  try {
    const entries = fs.readdirSync(target, { withFileTypes: true })
      .filter((d) => !d.name.startsWith("."))
      .map((d) => ({ name: d.name, dir: d.isDirectory() }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { cwd: target, entries };
  } catch (e) { return { cwd: target, entries: [], error: String(e) }; }
});
ipcMain.handle("crowe:fs:read", (_e, p) => {
  try { return { content: fs.readFileSync(resolvePath(p), "utf8").slice(0, 200000) }; }
  catch (e) { return { error: String(e) }; }
});
ipcMain.handle("crowe:fs:setcwd", (_e, p) => { const t = resolvePath(p); if (fs.existsSync(t)) CWD = t; return { cwd: CWD }; });

// ─── Config ──────────────────────────────────────────────────────────────────
ipcMain.handle("crowe:get-config", () => {
  const c = loadConfig();
  return { baseUrl: c.baseUrl, model: c.model, hasToken: Boolean(c.token), cwd: CWD };
});
ipcMain.handle("crowe:set-config", (_e, patch) => {
  const c = saveConfig(patch || {});
  if (patch && patch.cwd) CWD = patch.cwd;
  return { baseUrl: c.baseUrl, model: c.model, hasToken: Boolean(c.token), cwd: CWD };
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
