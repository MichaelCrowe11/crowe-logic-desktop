// Crowe Logic desktop — main process (operator engine).
// Owns the window, the gateway bridge (token stays here), a real PTY shell, the
// filesystem, an MCP client, and the agentic tool loop. File edits are gated
// through an approve/reject review unless auto-approve is on.
const { app, BrowserWindow, ipcMain, Menu, Tray, globalShortcut, nativeImage, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const { spawn, exec } = require("child_process");

let pty = null;
try { pty = require("node-pty"); } catch { pty = null; }

const DEFAULTS = {
  baseUrl: "https://api.crowelogic.com",
  model: "crowelm",
  token: "",
  cwd: os.homedir(),
  autoApprove: false,     // when true, file edits apply without review
  autonomy: "edit",       // "readonly" (no shell/writes) | "edit" (reviewed writes, no shell) | "execute" (all). Safe default: edit.
  mcpServers: {},         // { name: { command, args, env } }
};

function configPath() { return path.join(app.getPath("userData"), "config.json"); }
function loadConfig() {
  try {
    const cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath(), "utf8")) };
    // Guard: a stale localhost/loopback gateway URL (a dev artifact) must never
    // brick a member install — fall back to the real gateway.
    if (/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)\b/i.test(cfg.baseUrl || "")) cfg.baseUrl = DEFAULTS.baseUrl;
    return cfg;
  } catch { return { ...DEFAULTS }; }
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
    backgroundColor: "#f7f3ea", title: "Crowe Logic",
    icon: path.join(__dirname, "assets", "icon.icns"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, webviewTag: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// ─── Crowe ID auth (OAuth2 Authorization Code + PKCE, loopback redirect) ──────
// Public client `crowe-cli` must allow the loopback redirect http://127.0.0.1/*
// and have the standard (authorization code) flow enabled in Keycloak realm `crowe`.
const CROWE_ID = "https://id.crowelogic.com/realms/crowe";
const CROWE_ID_CLIENT = "crowe-cli";
const AUTH_JSON = path.join(os.homedir(), ".config", "crowe-logic", "auth.json");
function b64url(buf) { return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function decodeJwt(t) { try { return JSON.parse(Buffer.from(String(t).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); } catch { return {}; } }
function persistTokens(d) {
  saveConfig({ token: d.access_token, refreshToken: d.refresh_token || loadConfig().refreshToken || "" });
  try { fs.mkdirSync(path.dirname(AUTH_JSON), { recursive: true }); fs.writeFileSync(AUTH_JSON, JSON.stringify({ access_token: d.access_token, refresh_token: d.refresh_token }, null, 2), { mode: 0o600 }); } catch {}
}
function currentUser() {
  const c = loadConfig(); if (!c.token) return null;
  const p = decodeJwt(c.token);
  return { email: p.email || p.preferred_username || "", name: p.name || p.given_name || "", tier: p.crowe_tier || p.tier || "", exp: p.exp || 0 };
}
async function refreshToken() {
  const cfg = loadConfig();
  let refresh = cfg.refreshToken;
  if (!refresh) { try { refresh = JSON.parse(fs.readFileSync(AUTH_JSON, "utf8")).refresh_token; } catch {} }
  if (!refresh) return null;
  try {
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: CROWE_ID_CLIENT, refresh_token: refresh });
    const r = await fetch(`${CROWE_ID}/protocol/openid-connect/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const d = await r.json();
    if (d.access_token) { persistTokens(d); return d.access_token; }
  } catch { /* noop */ }
  return null;
}
function signIn() {
  return new Promise((resolve) => {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    let redirect = "", settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
      const code = u.searchParams.get("code"), st = u.searchParams.get("state");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end('<!doctype html><meta charset="utf-8"><body style="font-family:-apple-system,Segoe UI,Inter,sans-serif;background:#f7f3ea;color:#1a1714;text-align:center;padding-top:14vh"><h2 style="color:#96702c;font-family:Fraunces,Georgia,serif">Crowe Logic</h2><p>You are signed in. You can close this window and return to the app.</p></body>');
      try { server.close(); } catch {}
      if (!code || st !== state) return finish({ error: "sign-in was cancelled" });
      try {
        const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: CROWE_ID_CLIENT, code_verifier: verifier });
        const r = await fetch(`${CROWE_ID}/protocol/openid-connect/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
        const d = await r.json();
        if (d.access_token) { persistTokens(d); return finish({ ok: true, user: currentUser() }); }
        return finish({ error: d.error_description || d.error || "token exchange failed" });
      } catch (e) { return finish({ error: String(e).slice(0, 200) }); }
    });
    // Must match the crowe-cli client's registered loopback redirect URIs.
    const PORTS = [8765, 9275];
    let pIdx = 0;
    server.on("error", (e) => {
      if (e && e.code === "EADDRINUSE" && pIdx < PORTS.length - 1) { pIdx += 1; setTimeout(() => server.listen(PORTS[pIdx], "127.0.0.1"), 40); return; }
      finish({ error: "could not open a loopback port (8765/9275 in use): " + String(e).slice(0, 100) });
    });
    server.on("listening", () => {
      redirect = `http://127.0.0.1:${server.address().port}/callback`;
      const authUrl = `${CROWE_ID}/protocol/openid-connect/auth?` + new URLSearchParams({
        client_id: CROWE_ID_CLIENT, response_type: "code", scope: "openid profile email offline_access",
        redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: "S256",
      }).toString();
      shell.openExternal(authUrl);
    });
    server.listen(PORTS[pIdx], "127.0.0.1");
    setTimeout(() => { try { server.close(); } catch {} finish({ error: "sign-in timed out" }); }, 300000);
  });
}
ipcMain.handle("crowe:auth:login", () => signIn());
ipcMain.handle("crowe:auth:logout", () => { saveConfig({ token: "", refreshToken: "" }); try { fs.unlinkSync(AUTH_JSON); } catch {} return { ok: true }; });
ipcMain.handle("crowe:auth:status", async () => {
  let u = currentUser();
  if (u && u.exp) {
    const expMs = u.exp * 1000, now = Date.now();
    if (expMs < now) { const t = await refreshToken(); u = t ? currentUser() : null; }  // expired: refresh or sign out
    else if (expMs < now + 60000) { refreshToken(); }                                    // near expiry: refresh in background
  }
  return { user: u };
});
async function gatewayChat(messages, tools, _retried, signal, model) {
  const cfg = loadConfig();
  if (!cfg.token) return { error: "Not signed in. Click \"Sign in with Crowe ID\" to continue." };
  const useModel = model || cfg.model;
  const t0 = Date.now();
  try {
    const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/api/gateway/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ model: useModel, messages, tools: tools || undefined }),
      signal,
    });
    if (resp.status === 401 && !_retried) { const t = await refreshToken(); if (t) return gatewayChat(messages, tools, true, signal, model); }
    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = { detail: text }; }
    if (!resp.ok) return { error: `HTTP ${resp.status}: ${(data.detail || text)}`.slice(0, 400) };
    return { content: data.content || "", tool_calls: data.tool_calls || [], model: data.model || useModel,
             usage: data.usage || {}, elapsedMs: Date.now() - t0 };
  } catch (e) { return { error: `gateway unreachable: ${String(e).slice(0, 200)}`, aborted: e && e.name === "AbortError" }; }
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
        await srv.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "crowe-logic", version: app.getVersion() } });
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

// ─── Agent harness (tools, system prompt, loop) — see harness.js ─────────────
const harness = require("./harness");
function resolvePath(p) { if (!p) return CWD; p = p.replace(/^~(?=$|\/)/, os.homedir()); return path.isAbsolute(p) ? p : path.join(CWD, p); }

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

// Rough per-1M-token cost for the CroweLM daily driver (gpt-5.6 class), for the
// HUD/status bar. Display only; not billing.
const RATE_IN = 1.25 / 1e6, RATE_OUT = 10 / 1e6;

// ─── Agentic loop (delegates to harness.js) ──────────────────────────────────
// ─── Model catalog (public endpoint; drives dynamic routing) ─────────────────
// Cached so the router reads it per-turn without a network hop. Refreshed on
// startup, after sign-in, and on a timer. If it can't be fetched the router
// falls back to the default model, so a missing catalog never breaks a turn.
let catalogCache = { models: [], at: 0 };
async function fetchCatalog() {
  try {
    const base = loadConfig().baseUrl.replace(/\/$/, "");
    const resp = await fetch(`${base}/api/gateway/catalog`, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data && Array.isArray(data.models)) catalogCache = { models: data.models, at: Date.now() };
  } catch { /* keep last good; the router degrades to the default model */ }
}

const harnessCtx = {
  getCwd: () => CWD,
  setCwd: (p) => { CWD = p; },
  loadConfig,
  proposeEdit,
  mcpTools: () => Object.values(MCP).flatMap((s) => s.tools),
  mcpCall,
  openUrl: (u) => { if (mainWindow) mainWindow.webContents.send("crowe:browser:navigate", u); },
  getCatalog: () => catalogCache.models,
  rateIn: RATE_IN, rateOut: RATE_OUT,
};
let agentRun = { aborted: false, controller: null };
ipcMain.handle("crowe:agent:stop", () => { agentRun.aborted = true; try { agentRun.controller && agentRun.controller.abort(); } catch {} return { ok: true }; });
ipcMain.handle("crowe:agent:run", async (evt, { messages }) => {
  agentRun = { aborted: false, controller: null };
  const result = await harness.runAgent(harnessCtx, messages.slice(), {
    gatewayChat: (msgs, tools, signal, model) => gatewayChat(msgs, tools, false, signal, model),
    send: (ev) => evt.sender.send("crowe:agent:event", ev),
    isAborted: () => agentRun.aborted,
    setController: (c) => { agentRun.controller = c; },
  });
  // Persist the turn to the current session.
  try { persistSession([...messages, { role: "assistant", content: result.text || "" }]); } catch {}
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

// ─── Git (version control) ───────────────────────────────────────────────────
function gitRun(argStr) {
  return new Promise((resolve) => {
    exec(`git ${argStr}`, { cwd: CWD, timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: stdout || "", err: stderr || "" }));
  });
}
function gitWritesBlocked() { return (loadConfig().autonomy || "edit") === "readonly"; }
function shq(p) { return "'" + String(p == null ? "" : p).replace(/'/g, "'\\''") + "'"; }
ipcMain.handle("crowe:git:status", async () => {
  const probe = await gitRun("rev-parse --is-inside-work-tree");
  if (!probe.ok) return { repo: false, cwd: CWD };
  const branch = (await gitRun("rev-parse --abbrev-ref HEAD")).out.trim() || "(detached)";
  const raw = await gitRun("status --porcelain=v1");
  const files = raw.out.split("\n").filter(Boolean).map((l) => ({
    index: l[0], work: l[1], path: l.slice(3),
    staged: l[0] !== " " && l[0] !== "?", untracked: l[0] === "?",
  }));
  return { repo: true, branch, files, cwd: CWD };
});
ipcMain.handle("crowe:git:diff", async (_e, { path: p, staged }) => {
  const r = await gitRun(`diff ${staged ? "--staged " : ""}-- ${shq(p || ".")}`);
  return r.out || r.err || "(no textual diff)";
});
ipcMain.handle("crowe:git:stage", async (_e, { path: p }) => { if (gitWritesBlocked()) return { error: "read-only autonomy" }; return await gitRun(`add -- ${shq(p)}`); });
ipcMain.handle("crowe:git:unstage", async (_e, { path: p }) => { if (gitWritesBlocked()) return { error: "read-only autonomy" }; return await gitRun(`restore --staged -- ${shq(p)}`); });
ipcMain.handle("crowe:git:commit", async (_e, { message }) => {
  if (gitWritesBlocked()) return { error: "read-only autonomy" };
  if (!message || !message.trim()) return { error: "empty commit message" };
  const r = await gitRun(`commit -m ${shq(message)}`);
  return { ok: r.ok, out: (r.out || "") + (r.err || "") };
});
ipcMain.handle("crowe:git:log", async () => {
  const r = await gitRun('log -20 --pretty=format:"%h%x1f%an%x1f%ar%x1f%s"');
  return r.out.split("\n").filter(Boolean).map((l) => { const [hash, author, when, subject] = l.split(""); return { hash, author, when, subject }; });
});
ipcMain.handle("crowe:git:branches", async () => {
  const cur = (await gitRun("rev-parse --abbrev-ref HEAD")).out.trim();
  const r = await gitRun("branch --format=%(refname:short)");
  return { current: cur, branches: r.out.split("\n").map((s) => s.trim()).filter(Boolean) };
});
ipcMain.handle("crowe:git:checkout", async (_e, { branch }) => { if (gitWritesBlocked()) return { error: "read-only autonomy" }; return await gitRun(`checkout ${shq(branch)}`); });

// ─── Config + status ─────────────────────────────────────────────────────────
ipcMain.handle("crowe:get-config", () => {
  const c = loadConfig();
  return { baseUrl: c.baseUrl, hasToken: Boolean(c.token), cwd: CWD, autoApprove: c.autoApprove, autonomy: c.autonomy,
    mcp: Object.entries(MCP).map(([n, s]) => ({ name: n, tools: s.tools.length })), ptyAvailable: Boolean(pty) };
});
ipcMain.handle("crowe:set-config", async (_e, patch) => {
  const c = saveConfig(patch || {});
  if (patch && patch.cwd) CWD = patch.cwd;
  if (patch && patch.mcpServers) await mcpConnectAll();
  return { baseUrl: c.baseUrl, hasToken: Boolean(c.token), cwd: CWD, autoApprove: c.autoApprove, autonomy: c.autonomy,
    mcp: Object.entries(MCP).map(([n, s]) => ({ name: n, tools: s.tools.length })), ptyAvailable: Boolean(pty) };
});

// ─── Session persistence ─────────────────────────────────────────────────────
function sessionsDir() { const d = path.join(app.getPath("userData"), "sessions"); try { fs.mkdirSync(d, { recursive: true }); } catch {} return d; }
let currentSession = null;
function newSessionId() { return "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7); }
function persistSession(messages) {
  if (!messages || !messages.length) return;
  if (!currentSession) currentSession = newSessionId();
  const firstUser = messages.find((m) => m.role === "user");
  const title = String(firstUser?.content || "Untitled").replace(/\s+/g, " ").slice(0, 60);
  fs.writeFileSync(path.join(sessionsDir(), currentSession + ".json"),
    JSON.stringify({ id: currentSession, title, updatedAt: Date.now(), messages }, null, 2));
}
ipcMain.handle("crowe:sessions:list", () => {
  try {
    return fs.readdirSync(sessionsDir()).filter((f) => f.endsWith(".json")).map((f) => {
      try { const d = JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), "utf8")); return { id: d.id, title: d.title, updatedAt: d.updatedAt, current: d.id === currentSession }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch { return []; }
});
ipcMain.handle("crowe:sessions:load", (_e, id) => {
  try { const d = JSON.parse(fs.readFileSync(path.join(sessionsDir(), id + ".json"), "utf8")); currentSession = id; return { messages: d.messages || [], title: d.title }; }
  catch (e) { return { error: String(e) }; }
});
ipcMain.handle("crowe:sessions:new", () => { currentSession = newSessionId(); return { id: currentSession }; });
ipcMain.handle("crowe:sessions:delete", (_e, id) => { try { fs.unlinkSync(path.join(sessionsDir(), id + ".json")); } catch {} if (currentSession === id) currentSession = null; return { ok: true }; });

// ─── Window chrome: menu, tray, global summon (Hypheus/Cortex-style) ─────────
function relayMenu(action) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("crowe:menu", action); }
function setAutonomy(tier) { saveConfig({ autonomy: tier }); buildMenu(); relayMenu("autonomy:" + tier); }
function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return createWindow();
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else { mainWindow.show(); mainWindow.focus(); }
}
function showWindow() { if (!mainWindow || mainWindow.isDestroyed()) createWindow(); else { mainWindow.show(); mainWindow.focus(); } }

let tray = null;
function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png")).resize({ width: 18, height: 18 });
    tray = new Tray(img);
    tray.setToolTip("Crowe Logic");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Show Crowe Logic", click: showWindow },
      { label: "New Chat", click: () => { showWindow(); relayMenu("new-chat"); } },
      { label: "Quick Ask", accelerator: "CmdOrCtrl+Shift+Space", click: () => { showWindow(); relayMenu("focus-composer"); } },
      { type: "separator" },
      { label: "Quit Crowe Logic", role: "quit" },
    ]));
    tray.on("click", toggleWindow);
  } catch { /* tray optional */ }
}

function buildMenu() {
  const mac = process.platform === "darwin";
  const tier = loadConfig().autonomy || "execute";
  const crowe = (label, action, accel) => ({ label, accelerator: accel, click: () => { showWindow(); relayMenu(action); } });
  const template = [
    ...(mac ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [
      crowe("New Chat", "new-chat", "CmdOrCtrl+N"),
      { type: "separator" },
      mac ? { role: "close" } : { role: "quit" },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [
      crowe("Command Palette", "palette", "CmdOrCtrl+K"),
      crowe("Focus Composer", "focus-composer", "CmdOrCtrl+L"),
      crowe("Toggle Dark Mode", "toggle-theme", "CmdOrCtrl+Shift+D"),
      { type: "separator" },
      crowe("Terminal", "pane:term", "CmdOrCtrl+1"),
      crowe("Browser", "pane:browser", "CmdOrCtrl+2"),
      crowe("Files", "pane:files", "CmdOrCtrl+3"),
      { type: "separator" },
      { label: "Autonomy", submenu: [
        { label: "Plan (explore read-only, then propose a plan)", type: "radio", checked: tier === "plan", click: () => setAutonomy("plan") },
        { label: "Read-only (no shell, no writes)", type: "radio", checked: tier === "readonly", click: () => setAutonomy("readonly") },
        { label: "Edit (reviewed writes, no shell)", type: "radio", checked: tier === "edit", click: () => setAutonomy("edit") },
        { label: "Execute (shell + writes)", type: "radio", checked: tier === "execute", click: () => setAutonomy("execute") },
      ] },
      { type: "separator" },
      { role: "reload" }, { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
      { type: "separator" }, { role: "togglefullscreen" },
    ] },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  createWindow();
  buildMenu();
  createTray();
  try { globalShortcut.register("CommandOrControl+Shift+Space", () => { toggleWindow(); relayMenu("focus-composer"); }); } catch {}
  mcpConnectAll();
  fetchCatalog(); setInterval(fetchCatalog, 10 * 60 * 1000);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("will-quit", () => { try { globalShortcut.unregisterAll(); } catch {} });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
