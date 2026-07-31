// Crowe Logic desktop — main process (operator engine).
// Owns the window, the gateway bridge (token stays here), a real PTY shell, the
// filesystem, an MCP client, and the agentic tool loop. File edits are gated
// through an approve/reject review unless auto-approve is on.
const { app, BrowserWindow, ipcMain, Menu, Tray, globalShortcut, nativeImage, shell, crashReporter, safeStorage, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const { spawn, exec } = require("child_process");
const { GROW_TYPES } = require("./grow-schema");

let pty = null;
try { pty = require("node-pty"); } catch { pty = null; }

// Auto-update (electron-updater over the generic R2 channel). Only in packaged
// builds; downloads are user-consented, never silent. See setupAutoUpdate().
let autoUpdater = null;
try { ({ autoUpdater } = require("electron-updater")); } catch { autoUpdater = null; }

const DEFAULTS = {
  baseUrl: "https://api.crowelogic.com",
  model: "crowelm",
  token: "",
  cwd: os.homedir(),
  autoApprove: false,     // when true, file edits apply without review
  autonomy: "edit",       // see TIERS: plan | readonly | edit | execute. Safe default: edit.
  mcpServers: {},         // { name: { command, args, env } }
  telemetry: true,        // minimal anonymous usage + crash metadata; off = local dumps only
  onboarded: false,       // set true after the first-run card has been shown
  licenseWorkspaceId: "", // selected Crowe Agents customer workspace
  // Which actions stop for an explicit yes, independently of the autonomy tier:
  // off | high-risk (irreversible only) | strict (anything past the working tree).
  approvals: "high-risk",
  verifier: true,         // check a mutating turn independently before reporting it done
  turnBudgetUsd: 2,       // hard ceiling on model spend per turn; 0 = no ceiling
  // Backstop for the ceiling above. Dollars are priced from display rates, so a
  // model whose rate this app does not know would otherwise run uncapped. Tokens
  // are the unit every provider agrees on. 0 = no backstop.
  turnTokenCap: 400000,
};
const APPROVAL_MODES = new Set(["off", "high-risk", "strict"]);

// ─── Crash reporting + minimal telemetry ─────────────────────────────────────
// Local crash dumps always write to userData/crashes so the user can inspect
// them. Network submission is opt-out via Settings (config.telemetry); when off,
// nothing leaves the machine. The report line carries no message content,
// paths, or tokens - only app/platform metadata.
function telemetryExtra() {
  return {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    channel: app.isPackaged ? "release" : "dev",
    model: (loadConfig().model || "crowelm"),
  };
}
function initCrashReporting() {
  const dumps = path.join(app.getPath("userData"), "crashes");
  try { app.setPath("crashDumps", dumps); } catch {}
  const enabled = Boolean(loadConfig().telemetry);
  try {
    crashReporter.start({
      productName: "Crowe Logic",
      companyName: "Crowe Logic, Inc.",
      submitURL: enabled ? `${(loadConfig().baseUrl || DEFAULTS.baseUrl).replace(/\/$/, "")}/api/telemetry/crash` : "",
      uploadToServer: enabled,
      ignoreSystemCrashHandler: false,
      extra: telemetryExtra(),
    });
  } catch { /* crash reporting must never block startup */ }
}
function postTelemetry(event, props) {
  if (!loadConfig().telemetry) return;
  try {
    const base = (loadConfig().baseUrl || DEFAULTS.baseUrl).replace(/\/$/, "");
    fetch(`${base}/api/telemetry/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, props: props || {}, ...telemetryExtra(), at: Date.now() }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } catch { /* best effort */ }
}

function configPath() { return path.join(app.getPath("userData"), "config.json"); }
function authStorePath() { return path.join(app.getPath("userData"), "auth.bin"); }
function readAuthStore() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return {};
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(authStorePath())));
  } catch { return {}; }
}
function writeAuthStore(store) {
  if (!safeStorage.isEncryptionAvailable()) {
    // Headless shells (CI, xdotool smoke runs, SSH sessions) have no keychain,
    // so they need somewhere to put a token. That fallback is plaintext, and it
    // holds the refresh token - the long-lived secret that mints new access
    // tokens - so it has to be opted into explicitly and can never be reachable
    // from a packaged build. app.isPackaged is the backstop: even if the env var
    // leaks into a user's shell, a shipped install still refuses.
    if (process.env.CROWE_ALLOW_PLAINTEXT_AUTH === "1" && !app.isPackaged) {
      fs.writeFileSync(authStorePath(), JSON.stringify(store), { mode: 0o600 });
      return;
    }
    throw new Error("Native credential encryption is unavailable");
  }
  fs.writeFileSync(authStorePath(), safeStorage.encryptString(JSON.stringify(store)), { mode: 0o600 });
}
/* The four tiers, and the one place a stored value becomes one of them.

   Spreading DEFAULTS does not settle this: a config carrying `"autonomy": null`
   or a tier name from a future version overrides the default with something no
   gate recognises, and the gates disagreed about what to do then. Most read
   `|| "edit"`; four read `|| "execute"`, including the harness check that is the
   only thing standing between the agent and a real shell. So an unreadable value
   showed the operator "Edit" in the badge while the agent ran commands.

   Normalising here makes the tier a closed set before any gate sees it, and the
   fallback is the safe end: an autonomy setting we cannot read is not consent. */
const TIERS = new Set(["plan", "readonly", "edit", "execute"]);
function loadConfig() {
  try {
    const stored = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    const auth = readAuthStore();
    const cfg = { ...DEFAULTS, ...stored, token: auth.token || "", refreshToken: auth.refreshToken || "" };
    // Guard: a stale localhost/loopback gateway URL (a dev artifact) must never
    // brick a member install - fall back to the real gateway.
    if (/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)\b/i.test(cfg.baseUrl || "")) cfg.baseUrl = DEFAULTS.baseUrl;
    if (!TIERS.has(cfg.autonomy)) cfg.autonomy = DEFAULTS.autonomy;
    // Same closed-set rule as the tier, and for the same reason: a value no gate
    // recognises must land on the safe end, not on whatever `||` reaches first.
    if (!APPROVAL_MODES.has(cfg.approvals)) cfg.approvals = DEFAULTS.approvals;
    if (typeof cfg.verifier !== "boolean") cfg.verifier = DEFAULTS.verifier;
    const budget = Number(cfg.turnBudgetUsd);
    cfg.turnBudgetUsd = Number.isFinite(budget) && budget >= 0 ? budget : DEFAULTS.turnBudgetUsd;
    const tokenCap = Number(cfg.turnTokenCap);
    cfg.turnTokenCap = Number.isFinite(tokenCap) && tokenCap >= 0 ? tokenCap : DEFAULTS.turnTokenCap;
    return cfg;
  } catch { return { ...DEFAULTS, ...readAuthStore() }; }
}
function saveConfig(patch) {
  const current = loadConfig();
  const merged = { ...current, ...patch };
  if (Object.hasOwn(patch, "token") || Object.hasOwn(patch, "refreshToken")) {
    writeAuthStore({ token: merged.token || "", refreshToken: merged.refreshToken || "" });
  }
  const persistable = { ...merged };
  delete persistable.token;
  delete persistable.refreshToken;
  fs.writeFileSync(configPath(), JSON.stringify(persistable, null, 2), { mode: 0o600 });
  return merged;
}

const KEY_PROVIDERS = {
  openai: { label: "OpenAI", url: "https://api.openai.com/v1/models", header: "Bearer" },
  anthropic: { label: "Anthropic", url: "https://api.anthropic.com/v1/models", header: "x-api-key" },
  openrouter: { label: "OpenRouter", url: "https://openrouter.ai/api/v1/models", header: "Bearer" },
  groq: { label: "Groq", url: "https://api.groq.com/openai/v1/models", header: "Bearer" },
};
function keyStorePath() { return path.join(app.getPath("userData"), "credentials.bin"); }
function readKeyStore() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return {};
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(keyStorePath())));
  } catch { return {}; }
}
function writeKeyStore(store) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Native credential encryption is unavailable");
  fs.writeFileSync(keyStorePath(), safeStorage.encryptString(JSON.stringify(store)), { mode: 0o600 });
}
function keyStatus() {
  const store = readKeyStore();
  return Object.entries(KEY_PROVIDERS).map(([id, spec]) => {
    const entry = store[id] || {};
    return { id, label: spec.label, configured: Boolean(entry.value), updatedAt: entry.updatedAt || 0, testedAt: entry.testedAt || 0, healthy: entry.healthy === true };
  });
}
ipcMain.handle("crowe:keys:list", () => ({ encrypted: safeStorage.isEncryptionAvailable(), providers: keyStatus() }));
ipcMain.handle("crowe:keys:set", (_e, { provider, key }) => {
  if (!KEY_PROVIDERS[provider] || typeof key !== "string" || !key.trim()) return { error: "Invalid provider or key" };
  const store = readKeyStore(); store[provider] = { value: key.trim(), updatedAt: Date.now() }; writeKeyStore(store);
  return { ok: true, providers: keyStatus() };
});
ipcMain.handle("crowe:keys:remove", (_e, { provider }) => {
  const store = readKeyStore(); delete store[provider]; writeKeyStore(store); return { ok: true, providers: keyStatus() };
});
ipcMain.handle("crowe:keys:test", async (_e, { provider }) => {
  const spec = KEY_PROVIDERS[provider], secret = readKeyStore()[provider]?.value;
  if (!spec || !secret) return { ok: false, error: "No key configured" };
  const headers = spec.header === "Bearer" ? { Authorization: `Bearer ${secret}` } : { "x-api-key": secret, "anthropic-version": "2023-06-01" };
  try {
    const r = await fetch(spec.url, { headers, signal: AbortSignal.timeout(10000) });
    const store = readKeyStore();
    if (store[provider]) { store[provider].testedAt = Date.now(); store[provider].healthy = r.ok; writeKeyStore(store); }
    return { ok: r.ok, status: r.status, error: r.ok ? "" : "Provider rejected the credential", providers: keyStatus() };
  } catch {
    const store = readKeyStore();
    if (store[provider]) { store[provider].testedAt = Date.now(); store[provider].healthy = false; writeKeyStore(store); }
    return { ok: false, error: "Provider could not be reached", providers: keyStatus() };
  }
});
ipcMain.handle("crowe:files:pick", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openFile", "multiSelections"], title: "Attach context files" });
  if (result.canceled) return [];
  return result.filePaths.map((filePath) => {
    try { const stat = fs.statSync(filePath); return { path: filePath, name: path.basename(filePath), size: stat.size }; }
    catch { return null; }
  }).filter(Boolean);
});
ipcMain.handle("crowe:files:read-context", (_e, filePaths) => (Array.isArray(filePaths) ? filePaths : []).slice(0, 12).map((filePath) => {
  try { return { path: filePath, content: fs.readFileSync(filePath, "utf8").slice(0, 100000) }; }
  catch { return { path: filePath, error: "File could not be read as text" }; }
}));

let CWD = loadConfig().cwd || os.homedir();
let mainWindow = null;

/* Which spaces this install ships with.

   The picker added in #12 lets someone narrow their own shell, but it writes to
   renderer localStorage, so there was no way to hand anyone a Chat-and-Projects
   install - every build shipped every space and the buyer had to go turn two
   off. This is the missing half: a default the build carries.

   It has to reach the renderer synchronously. applySpaceProfile() runs while the
   rail is being wired, and anything asynchronous means painting four tabs and
   then dropping two, which reads as a bug rather than as a build. A sandboxed
   preload can open neither the filesystem nor userData, but it can read
   process.argv - so the list rides in on additionalArguments.

   Deliberately a default and not a lock: the picker still wins, and someone who
   turns Cultivation back on keeps it. A hard lock is a different feature and
   would need the picker to stop offering what it cannot grant.

   No list of valid ids here on purpose. The registry lives in renderer.js and
   duplicating it is how the two drift; the renderer already filters against its
   own SPACES, so main passes the configured names through untouched. */
function installSpaces() {
  // The env var is for a one-off run or a CI check. The package.json key is for
  // a build handed to a customer - electron-builder's extraMetadata sets it at
  // package time without a patch to the source.
  let raw = process.env.CROWE_SPACES;
  if (raw == null) { try { raw = require("./package.json").croweSpaces; } catch {} }
  if (raw == null) return null;
  const ids = (Array.isArray(raw) ? raw : String(raw).split(",")).map((s) => String(s).trim()).filter(Boolean);
  return ids.length ? ids : null;
}

function createWindow() {
  const spaces = installSpaces();
  mainWindow = new BrowserWindow({
    width: 1280, height: 840, minWidth: 900, minHeight: 560,
    backgroundColor: "#f7f3ea", title: "Crowe Logic",
    // macOS ignores this and uses the bundle icon. Windows and Linux do read it,
    // and neither can decode .icns, so pointing at the icns left them on the
    // default Electron icon.
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, webviewTag: true,
      sandbox: true,
      additionalArguments: spaces ? [`--crowe-spaces=${spaces.join(",")}`] : [],
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) mainWindow.webContents.send("crowe:browser:navigate", url);
    return { action: "deny" };
  });
  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = details?.requestingUrl || wc.getURL();
    const trusted = url.startsWith("file://") || url.startsWith("https://croweagents.com") || url.startsWith("https://crowelogic.com");
    callback(trusted && ["media", "microphone", "notifications", "clipboard-sanitized-write"].includes(permission));
  });
  mainWindow.webContents.on("will-navigate", (event, url) => { if (!url.startsWith("file://")) { event.preventDefault(); if (/^https:\/\//i.test(url)) shell.openExternal(url); } });
}

// ─── Crowe ID auth (OAuth2 Authorization Code + PKCE, loopback redirect) ──────
// Public client `crowe-cli` must allow the loopback redirect http://127.0.0.1/*
// and have the standard (authorization code) flow enabled in Keycloak realm `crowe`.
const CROWE_ID = "https://id.crowelogic.com/realms/crowe";
const CROWE_ID_CLIENT = "crowe-cli";
const LEGACY_AUTH_JSON = path.join(os.homedir(), ".config", "crowe-logic", "auth.json");
function b64url(buf) { return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function decodeJwt(t) { try { return JSON.parse(Buffer.from(String(t).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); } catch { return {}; } }
function persistTokens(d) {
  saveConfig({ token: d.access_token, refreshToken: d.refresh_token || loadConfig().refreshToken || "" });
  try { fs.unlinkSync(LEGACY_AUTH_JSON); } catch {}
}
function migrateLegacyAuth() {
  const cfg = loadConfig();
  if (cfg.token || cfg.refreshToken) return;
  let legacy = {};
  try { legacy = JSON.parse(fs.readFileSync(LEGACY_AUTH_JSON, "utf8")); } catch {}
  let oldConfig = {};
  try { oldConfig = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch {}
  const token = legacy.access_token || oldConfig.token || "";
  const refreshToken = legacy.refresh_token || oldConfig.refreshToken || "";
  if (token || refreshToken) saveConfig({ token, refreshToken });
  try { fs.unlinkSync(LEGACY_AUTH_JSON); } catch {}
}
function currentUser() {
  const c = loadConfig(); if (!c.token) return null;
  const p = decodeJwt(c.token);
  return { email: p.email || p.preferred_username || "", name: p.name || p.given_name || "", tier: p.crowe_tier || p.tier || "", exp: p.exp || 0 };
}
async function refreshToken() {
  const cfg = loadConfig();
  const refresh = cfg.refreshToken;
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
ipcMain.handle("crowe:auth:login", async () => { const r = await signIn(); if (r && r.ok) fetchCatalog(); return r; });
ipcMain.handle("crowe:auth:logout", () => { saveConfig({ token: "", refreshToken: "" }); try { fs.unlinkSync(LEGACY_AUTH_JSON); } catch {} return { ok: true }; });
ipcMain.handle("crowe:auth:status", async () => {
  let u = currentUser();
  if (u && u.exp) {
    const expMs = u.exp * 1000, now = Date.now();
    if (expMs < now) { const t = await refreshToken(); u = t ? currentUser() : null; }  // expired: refresh or sign out
    else if (expMs < now + 60000) { refreshToken(); }                                    // near expiry: refresh in background
  }
  return { user: u };
});
async function licensedFetch(route, method = "GET") {
  let token = loadConfig().token;
  if (!token) return { status: 401, data: null };
  const request = () => fetch(`${loadConfig().baseUrl.replace(/\/$/, "")}${route}`, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
  let response = await request();
  if (response.status === 401) { token = await refreshToken(); if (token) response = await request(); }
  const text = await response.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: response.status, data };
}
async function licenseStatus() {
  if (!currentUser()) return { authenticated: false, workspaces: [], selectedWorkspaceId: "" };
  try {
    const result = await licensedFetch("/api/workspaces");
    if (result.status >= 400 || !Array.isArray(result.data)) return { authenticated: true, workspaces: [], selectedWorkspaceId: "", error: `License service returned HTTP ${result.status}` };
    const workspaces = await Promise.all(result.data.map(async (workspace) => {
      const [entitlement, usage] = await Promise.all([
        licensedFetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/entitlements/agents`),
        licensedFetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/usage`),
      ]);
      return { ...workspace, agents: entitlement.status < 400 ? entitlement.data : { allowed: false }, usage: usage.status < 400 ? usage.data : null };
    }));
    const configured = loadConfig().licenseWorkspaceId;
    const selectedWorkspaceId = workspaces.some((workspace) => workspace.id === configured) ? configured : (workspaces[0]?.id || "");
    return { authenticated: true, workspaces, selectedWorkspaceId };
  } catch { return { authenticated: true, workspaces: [], selectedWorkspaceId: "", error: "License service could not be reached" }; }
}
ipcMain.handle("crowe:license:status", licenseStatus);
ipcMain.handle("crowe:license:select", (_event, { workspaceId } = {}) => {
  if (typeof workspaceId !== "string" || workspaceId.length > 200) return { error: "Invalid workspace" };
  saveConfig({ licenseWorkspaceId: workspaceId });
  return { ok: true, selectedWorkspaceId: workspaceId };
});
ipcMain.handle("crowe:license:billing", async () => {
  try {
    const result = await licensedFetch("/api/billing/portal/self", "POST");
    if (result.status >= 400 || !result.data?.url) return { error: "Billing portal is unavailable" };
    const portal = new URL(result.data.url);
    if (portal.protocol !== "https:") return { error: "Billing portal returned an unsafe URL" };
    await shell.openExternal(portal.toString()); return { ok: true };
  } catch { return { error: "Billing portal could not be reached" }; }
});
async function requireAgentEntitlement(workspaceId) {
  const status = await licenseStatus();
  const id = workspaceId || status.selectedWorkspaceId;
  const workspace = status.workspaces.find((item) => item.id === id);
  return workspace?.agents?.allowed ? { ok: true, workspace } : { ok: false, error: status.authenticated ? "An active Crowe Agents entitlement is required" : "Sign in with Crowe ID to use licensed agents" };
}
async function gatewayChat(messages, tools, _retried, signal, model, onDelta) {
  const cfg = loadConfig();
  if (!cfg.token) return { error: "Not signed in. Click \"Sign in with Crowe ID\" to continue." };
  const useModel = model || cfg.model;
  const t0 = Date.now();
  try {
    const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/api/gateway/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ model: useModel, messages, tools: tools || undefined, stream: onDelta ? true : undefined }),
      signal,
    });
    if (resp.status === 401 && !_retried) { const t = await refreshToken(); if (t) return gatewayChat(messages, tools, true, signal, model, onDelta); }
    /* Streaming is decided by the response, not the request. stream:true is an
       ask; a gateway build that ignores it answers with JSON, and this path has
       to keep working against both - so the branch keys on content-type, and
       everything below the branch returns the same shape either way. */
    if (resp.ok && onDelta && String(resp.headers.get("content-type") || "").includes("text/event-stream")) {
      let content = "", usage = {}, gotModel = useModel, buf = "";
      const toolCalls = [];
      const handle = (payload) => {
        if (payload === "[DONE]") return;
        let d; try { d = JSON.parse(payload); } catch { return; }
        // The gateway's non-stream reply is its own shape ({content, tool_calls}),
        // so accept its delta both ways: OpenAI-style choices[0].delta, or the
        // same flat shape sliced thin. One handler, both dialects.
        const delta = (d.choices && d.choices[0] && d.choices[0].delta) || d.delta || d;
        const chunk = typeof delta.content === "string" ? delta.content : "";
        if (chunk) { content += chunk; onDelta(chunk); }
        for (const t of delta.tool_calls || []) {
          const i = Number.isInteger(t.index) ? t.index : toolCalls.length;
          const cur = toolCalls[i] || (toolCalls[i] = { id: "", type: "function", function: { name: "", arguments: "" } });
          if (t.id) cur.id = t.id;
          if (t.function?.name) cur.function.name = t.function.name;
          if (t.function?.arguments) cur.function.arguments += t.function.arguments;
        }
        if (d.usage) usage = d.usage;
        if (d.model) gotModel = d.model;
      };
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (line.startsWith("data:")) handle(line.slice(5).trim());
        }
      }
      return { content, tool_calls: toolCalls.filter(Boolean), model: gotModel,
               usage, elapsedMs: Date.now() - t0, streamed: content.length };
    }
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
    proc.on("exit", (code) => {
      // Identity check: a late exit from a superseded process must not
      // deregister a freshly reconnected server under the same name.
      if (MCP[name] === srv) { delete MCP[name]; PLUGIN_MANAGED.delete(name); }
      for (const p of srv.pending.values()) p.rej(new Error(`server exited (code ${code})`));
      srv.pending.clear();
    });
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
      } catch (e) { try { proc.kill(); } catch {} resolve({ error: String(e) }); }
    })();
  });
}
async function mcpConnectAll() {
  const { mcpServers } = loadConfig();
  for (const [name, spec] of Object.entries(mcpServers || {})) {
    // Official plugin ids are reserved: a hand-configured server may not claim
    // one, so Disable can only ever kill a plugin-spawned process.
    if (PLUGIN_IDS.has(name)) continue;
    if (spec && spec.command) await mcpConnect(name, spec);
  }
}
// ─── Official plugins (Phase 1: bundled manifest over the MCP client) ────────
// A plugin IS a manifest entry + an MCP server + declared tiers. Enable is one
// click, disable is one click, and a dead server never breaks the app.
// TRUST BOUNDARY: p.mcp.command/args are spawned verbatim. The ONLY acceptable
// manifest source is the bundled plugins.builtin.json, which shares the app's
// code-signature/asar integrity domain. Any non-bundled source (gateway,
// userData, download) MUST be signature- or pinned-hash-verified before
// parsing — a hostile mcp field is arbitrary code execution.
const BUILTIN_PLUGINS = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "plugins.builtin.json"), "utf8")).plugins || []; }
  catch { return []; }
})();
const PLUGIN_IDS = new Set(BUILTIN_PLUGINS.map((p) => p.id));
const PLUGIN_MANAGED = new Set();      // ids whose MCP[id] was started by the manager
const PLUGIN_GEN = Object.create(null); // id -> int; disable bumps to void in-flight connects
const PLUGIN_CONNECTING = new Set();
function pluginState() { return loadConfig().plugins || {}; }
function expandHome(s) { return String(s).replace(/^~(?=$|\/)/, os.homedir()); }
function pluginList() {
  const st = pluginState();
  return BUILTIN_PLUGINS.map((p) => {
    const connected = PLUGIN_MANAGED.has(p.id) && Boolean(MCP[p.id]);
    return {
      id: p.id, name: p.name, description: p.description, category: p.category,
      spaces: p.spaces || [], available: p.available !== false, envPrompts: p.envPrompts || [],
      glyph: p.glyph || "", chips: p.chips || [],
      enabled: Boolean(st[p.id] && st[p.id].enabled),
      connected,
      toolCount: connected ? MCP[p.id].tools.length : 0,
    };
  });
}
async function pluginConnect(p, env) {
  if (!p.mcp || !p.mcp.command) return { error: "no server declared for this plugin yet" };
  const gen = (PLUGIN_GEN[p.id] = (PLUGIN_GEN[p.id] || 0) + 1);
  const r = await mcpConnect(p.id, {
    command: expandHome(p.mcp.command),
    args: (p.mcp.args || []).map(expandHome),
    env: { ...(p.mcp.env || {}), ...(env || {}) },
  });
  if (PLUGIN_GEN[p.id] !== gen) {
    // Disabled (or superseded) while connecting: tear down our registration.
    const srv = MCP[p.id];
    if (srv) { try { srv.proc.kill(); } catch {} delete MCP[p.id]; }
    return { error: "plugin was disabled during connect" };
  }
  if (r && r.ok) PLUGIN_MANAGED.add(p.id);
  return r;
}
async function pluginsConnectAll() {
  const st = pluginState();
  for (const p of BUILTIN_PLUGINS) { const s = st[p.id]; if (s && s.enabled) await pluginConnect(p, s.env); }
}
ipcMain.handle("crowe:plugins:list", () => pluginList());
ipcMain.handle("crowe:plugins:enable", async (_e, { id, env }) => {
  const p = BUILTIN_PLUGINS.find((x) => x.id === id);
  if (!p) return { error: "unknown plugin" };
  if (p.available === false) return { error: "server pending — this plugin is not released yet" };
  if (PLUGIN_MANAGED.has(id) && MCP[id]) return { ok: true, tools: MCP[id].tools.length };
  if (PLUGIN_CONNECTING.has(id)) return { error: "already connecting" };
  PLUGIN_CONNECTING.add(id);
  try {
    const r = await pluginConnect(p, env);
    if (r && r.error) return { error: `could not start: ${String(r.error).slice(0, 160)}` };
    try {
      saveConfig({ plugins: { ...pluginState(), [id]: { enabled: true, env: env || {} } } });
    } catch (e) {
      const srv = MCP[id];
      if (srv) { try { srv.proc.kill(); } catch {} delete MCP[id]; }
      PLUGIN_MANAGED.delete(id);
      return { error: `could not save config: ${String(e).slice(0, 160)}` };
    }
    return { ok: true, tools: r.tools || 0 };
  } finally { PLUGIN_CONNECTING.delete(id); }
});
ipcMain.handle("crowe:plugins:disable", (_e, { id }) => {
  PLUGIN_GEN[id] = (PLUGIN_GEN[id] || 0) + 1; // void any in-flight connect
  PLUGIN_MANAGED.delete(id);
  const srv = MCP[id];
  if (srv) { try { srv.proc.kill(); } catch {} delete MCP[id]; }
  try { saveConfig({ plugins: { ...pluginState(), [id]: { enabled: false } } }); }
  catch (e) { return { error: `could not save config: ${String(e).slice(0, 160)}` }; }
  return { ok: true };
});

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

// ─── Action approval (approve/deny, expiring) ────────────────────────────────
/* The edit review above answers "do you want this diff". This answers a different
   question - "do you want this to happen at all" - and it is the only gate in
   front of an action that cannot be taken back. Three properties make it an
   approval rather than a wider tier: it names the exact action, it is used once,
   and it expires. An unanswered prompt is a denial, because a window left open
   overnight is not consent, and a turn that hangs forever waiting for one is a
   worse outcome than a turn that stopped and said why. */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
let approvalSeq = 0; const pendingApprovals = new Map();
ipcMain.handle("crowe:approval:decide", (_e, { id, approved }) => {
  const r = pendingApprovals.get(id);
  if (r) { pendingApprovals.delete(id); r({ approved: Boolean(approved) }); }
  return { ok: true };
});
// Stopping a run has to release whatever it was waiting on. A Stop that leaves
// the turn parked on an unanswered approval is a hang, and it looks like a bug in
// Stop rather than what it is.
function denyPendingApprovals(agentId) {
  for (const [id, done] of [...pendingApprovals]) {
    if (agentId && done.agentId && done.agentId !== agentId) continue;
    pendingApprovals.delete(id);
    if (mainWindow) mainWindow.webContents.send("crowe:agent:event", { type: "approval_expired", id, agentId: done.agentId || "main" });
    done({ approved: false });
  }
}
function requestApproval(req) {
  if (!mainWindow) return Promise.resolve({ approved: false });
  const id = ++approvalSeq;
  /* The agent id has to ride along. Without it the request cannot be routed to
     the surface that asked for it: the only listener that drew a card was the
     chat transcript's, registered per turn, so an approval raised by a workflow
     node or an agent panel had no consumer at all and sat unanswered until it
     expired - five minutes of "Running" and then a denial nobody chose. Worse
     when a chat turn happened to be open, since that transcript would draw
     another agent's card and grant an action the user was not looking at. */
  const agentId = req.agentId || "main";
  mainWindow.webContents.send("crowe:agent:event", {
    type: "approval_request", id, agentId, kind: req.kind, title: req.title,
    detail: req.detail, why: req.why, risk: req.risk, hash: req.hash,
    expiresInMs: APPROVAL_TIMEOUT_MS,
  });
  journalWrite({ event_type: "APPROVAL_PROMPTED", tool_id: req.kind, input_hash: req.hash, output_summary: `${req.risk}: ${req.why}` });
  return new Promise((resolve) => {
    const done = (v) => { pendingApprovals.delete(id); clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => {
      if (mainWindow) mainWindow.webContents.send("crowe:agent:event", { type: "approval_expired", id, agentId });
      done({ approved: false, expired: true });
    }, APPROVAL_TIMEOUT_MS);
    done.agentId = agentId;
    pendingApprovals.set(id, done);
  });
}

// ─── The journal (append-only, hash-chained) ─────────────────────────────────
/* What ran, what it was asked to run on, what came back, what the user allowed.
   Two rules keep it honest. It is never read back as state - the loop does not
   depend on it, so a missing or corrupt journal degrades to no journal and never
   to a wrong decision. And each line carries the digest of the line before it, so
   a file that has been edited or truncated in the middle stops verifying at that
   point. A receipt nobody can quietly rewrite is the only kind worth keeping. */
function journalDir() { const d = path.join(app.getPath("userData"), "journal"); try { fs.mkdirSync(d, { recursive: true }); } catch {} return d; }
let journalPrev = null, journalDay = "";
function journalWrite(event) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(journalDir(), `${day}.jsonl`);
    if (day !== journalDay) {
      journalDay = day;
      journalPrev = null;
      try {                                     // resume the chain across restarts
        const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
        const last = JSON.parse(lines[lines.length - 1]);
        journalPrev = last && last.hash ? last.hash : null;
      } catch { /* first line of the day */ }
    }
    const body = { event_id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...event, prev: journalPrev };
    const hash = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32);
    journalPrev = hash;
    fs.appendFileSync(file, JSON.stringify({ ...body, hash }) + "\n", { mode: 0o600 });
  } catch { /* a receipt that cannot be written must not break the turn */ }
}
// Spooled tool output, content-addressed. Pruned by age rather than on write, so
// a long turn never pays for housekeeping mid-loop.
function artifactDir() { const d = path.join(app.getPath("userData"), "artifacts"); try { fs.mkdirSync(d, { recursive: true }); } catch {} return d; }
function pruneArtifacts(maxAgeMs = 7 * 24 * 3600 * 1000) {
  try {
    const dir = artifactDir(), now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p); } catch {}
    }
  } catch {}
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
// Roles the router understands; the Home surface shows how each resolves today.
const ROUTED_ROLES = ["cultivation", "coding", "reasoning", "long-context"];
function resolveRoles() {
  const dflt = loadConfig().model || "crowelm";
  const out = {};
  for (const role of ROUTED_ROLES) {
    const dynamic = harness.catalogModelForRole(catalogCache.models, role);
    const bridge = harness.BRIDGE_ROLE_MODEL[role];
    out[role] = dynamic ? { model: dynamic, source: "catalog" }
      : bridge ? { model: bridge, source: "bridge" }
      : { model: dflt, source: "default" };
  }
  return out;
}
ipcMain.handle("crowe:catalog:get", () => ({ models: catalogCache.models, at: catalogCache.at, resolved: resolveRoles(), defaultModel: loadConfig().model || "crowelm" }));
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
  // The gate in front of anything that cannot be taken back, and the receipt
  // stream that records what was allowed. Both live here rather than in the
  // harness because both need the window and the user's own data directory.
  requestApproval,
  journal: journalWrite,
  artifactDir,
  mcpTools: () => Object.values(MCP).flatMap((s) => s.tools),
  mcpCall,
  openUrl: (u) => { if (mainWindow) mainWindow.webContents.send("crowe:browser:navigate", u); },
  // The Runbook lives in the renderer's store, so authoring is an event, not a
  // write from here: the renderer saves it and surfaces the canvas. Stamped
  // "main" because chat is the only surface that offers the tool.
  authorWorkflow: (wf) => { if (mainWindow) mainWindow.webContents.send("crowe:agent:event", { type: "workflow_authored", workflow: wf, agentId: "main" }); },
  getCatalog: () => catalogCache.models,
  // Only plugin-managed servers are tier-gated; hand-configured MCP servers
  // keep their historic ungated behavior even if named like a manifest id.
  getPlugins: () => BUILTIN_PLUGINS.filter((p) => PLUGIN_MANAGED.has(p.id)),
  // The grow store, so the cultivation expert can write the record the grower
  // just dictated instead of describing the row they should go and type. Same
  // function the form calls - one write path, so an agent-logged flush is
  // indistinguishable from a hand-logged one and both are equally correctable.
  growWrite: (type, record) => growWrite(type, record),
  growRead: (type) => growRead(type),
  rateIn: RATE_IN, rateOut: RATE_OUT,
};
const agentRuns = new Map();
ipcMain.handle("crowe:agent:stop", (_evt, { id = "main" } = {}) => {
  const run = agentRuns.get(id);
  if (run) { run.aborted = true; try { run.controller && run.controller.abort(); } catch {} }
  denyPendingApprovals(id);
  return { ok: true };
});
ipcMain.handle("crowe:agent:stop-all", () => {
  for (const run of agentRuns.values()) {
    run.aborted = true;
    try { if (run.controller) run.controller.abort(); } catch {}
  }
  denyPendingApprovals();
  return { ok: true, stopped: agentRuns.size };
});
ipcMain.handle("crowe:agent:run", async (evt, { messages, id = "main", licensed = false, workspaceId = "", role = "", context = "" }) => {
  if (licensed) {
    const entitlement = await requireAgentEntitlement(workspaceId);
    if (!entitlement.ok) return { done: false, error: entitlement.error, text: entitlement.error };
  }
  const run = { aborted: false, controller: null };
  agentRuns.set(id, run);
  postTelemetry("agent_turn", { turns: messages.length, agentId: id });
  try {
    const result = await harness.runAgent(harnessCtx, messages.slice(), {
      gatewayChat: (msgs, tools, signal, model, onDelta) => gatewayChat(msgs, tools, false, signal, model, onDelta),
      send: (ev) => evt.sender.send("crowe:agent:event", { ...ev, agentId: id }),
      isAborted: () => run.aborted,
      setController: (c) => { run.controller = c; },
      role: String(role || ""),
      agentId: String(id || "main"),
      // Per-turn situational state from the renderer - today the cultivation
      // records. Capped here rather than trusted from the caller: the renderer
      // decides what is worth saying, the main process decides how much of the
      // context window a caller may spend saying it.
      context: String(context || "").slice(0, 8000),
    });
    if (id === "main") {
      try { persistSession([...messages, { role: "assistant", content: result.text || "" }]); } catch {}
    }
    return { done: true, text: result.text || "" };
  } finally {
    agentRuns.delete(id);
  }
});
ipcMain.handle("crowe:chat", async (_e, { messages }) => gatewayChat(messages, null));

// ─── PTY terminal ────────────────────────────────────────────────────────────
const ptyProcs = new Map();
/* The shell is the one capability the autonomy menu names out loud: two of its
   four tiers say "no shell" in the label the user picked. Nothing enforced it -
   every tier opened a full login shell - so the promise was decoration, and the
   safe-by-default tier was the least safe thing in the app. Only Execute grants
   a shell. The env stays process.env: that is the operator's own login
   environment, the same one Terminal.app would give them, and the gateway token
   is not in it - it lives in the auth store. */
function shellBlocked() { return (loadConfig().autonomy || "edit") !== "execute"; }
ipcMain.handle("crowe:pty:start", (evt, { id = "main", cols, rows } = {}) => {
  if (!pty) return { ok: false, error: "pty unavailable in this build" };
  if (shellBlocked()) return { ok: false, error: `shell is off at "${loadConfig().autonomy || "edit"}" autonomy - switch to Execute to open a terminal` };
  if (ptyProcs.has(id)) return { ok: true, id };
  const proc = pty.spawn(process.env.SHELL || "/bin/zsh", [], { name: "xterm-color", cols: cols || 80, rows: rows || 24, cwd: CWD, env: process.env });
  ptyProcs.set(id, proc);
  proc.onData((data) => { try { evt.sender.send("crowe:pty:data", { id, data }); } catch {} });
  proc.onExit(() => { ptyProcs.delete(id); try { evt.sender.send("crowe:pty:exit", { id }); } catch {} });
  return { ok: true, id };
});
ipcMain.on("crowe:pty:input", (_e, { id = "main", data } = {}) => { const proc = ptyProcs.get(id); if (proc) proc.write(data || ""); });
ipcMain.on("crowe:pty:resize", (_e, { id = "main", cols, rows }) => { const proc = ptyProcs.get(id); if (proc) { try { proc.resize(cols, rows); } catch {} } });
ipcMain.handle("crowe:pty:close", (_e, { id = "main" } = {}) => { const proc = ptyProcs.get(id); if (proc) { try { proc.kill(); } catch {} ptyProcs.delete(id); } return { ok: true }; });
ipcMain.handle("crowe:operator:status", () => ({
  app: "running", agents: agentRuns.size,
  agentIds: [...agentRuns.keys()], terminals: ptyProcs.size, terminalIds: [...ptyProcs.keys()],
  mcpServers: Object.keys(MCP).length,
  mcpTools: Object.values(MCP).reduce((n, server) => n + server.tools.length, 0),
  cwd: CWD, autonomy: loadConfig().autonomy || "edit", version: app.getVersion(), uptime: Math.round(process.uptime()),
}));
ipcMain.handle("crowe:operator:stop-all", () => {
  for (const run of agentRuns.values()) { run.aborted = true; try { if (run.controller) run.controller.abort(); } catch {} }
  denyPendingApprovals();
  for (const [id, proc] of ptyProcs) { try { proc.kill(); } catch {} ptyProcs.delete(id); }
  return { ok: true };
});

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
// Bounded recursive listing for quick open (Cmd+P). Relative paths, files only.
const WALK_SKIP = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "__pycache__", ".venv", "venv", "target", ".cache"]);
ipcMain.handle("crowe:fs:walk", () => {
  const root = CWD, out = [], MAX = 2500;
  const rec = (dir, rel, depth) => {
    if (out.length >= MAX || depth > 6) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (out.length >= MAX) return;
      if (d.name.startsWith(".") || WALK_SKIP.has(d.name) || d.name.endsWith(".app")) continue;
      const r = rel ? rel + "/" + d.name : d.name;
      if (d.isDirectory()) rec(path.join(dir, d.name), r, depth + 1);
      else if (d.isFile()) out.push(r);
    }
  };
  rec(root, "", 0);
  return { root, files: out, truncated: out.length >= MAX };
});

// ─── Git (version control) ───────────────────────────────────────────────────
function gitRun(argStr) {
  return new Promise((resolve) => {
    exec(`git ${argStr}`, { cwd: CWD, timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: stdout || "", err: stderr || "" }));
  });
}
function gitWritesBlocked() { const t = loadConfig().autonomy || "edit"; return t === "readonly" || t === "plan"; }
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
ipcMain.handle("crowe:git:pull", async () => { if (gitWritesBlocked()) return { error: "read-only autonomy" }; const r = await gitRun("pull --ff-only"); return { ok: r.ok, out: (r.out || "") + (r.err || "") }; });
ipcMain.handle("crowe:git:push", async () => { if (gitWritesBlocked()) return { error: "read-only autonomy" }; const r = await gitRun("push"); return { ok: r.ok, out: (r.out || "") + (r.err || "") }; });

// ─── Config + status ─────────────────────────────────────────────────────────
ipcMain.handle("crowe:get-config", () => {
  const c = loadConfig();
  return { baseUrl: c.baseUrl, hasToken: Boolean(c.token), cwd: CWD, autoApprove: c.autoApprove, autonomy: c.autonomy,
    approvals: c.approvals, verifier: Boolean(c.verifier), turnBudgetUsd: c.turnBudgetUsd,
    telemetry: Boolean(c.telemetry), onboarded: Boolean(c.onboarded),
    mcp: Object.entries(MCP).map(([n, s]) => ({ name: n, tools: s.tools.length })), ptyAvailable: Boolean(pty),
    version: require("./package.json").version };
});
ipcMain.handle("crowe:set-config", async (_e, patch) => {
  const c = saveConfig(patch || {});
  if (patch && patch.cwd) CWD = patch.cwd;
  if (patch && patch.mcpServers) await mcpConnectAll();
  return { baseUrl: c.baseUrl, hasToken: Boolean(c.token), cwd: CWD, autoApprove: c.autoApprove, autonomy: c.autonomy,
    approvals: c.approvals, verifier: Boolean(c.verifier), turnBudgetUsd: c.turnBudgetUsd,
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

// ─── Cultivation records ─────────────────────────────────────────────────────
/* The farm's own notebook, on disk beside the sessions. No gateway and no
   network: a grow room loses its uplink at exactly the moment something is
   going wrong in it, and a log you cannot write then is not a log. Crowe Sense
   will sync into this store when it lands rather than replace it, so a row
   reads the same whether it was typed or measured.

   GROW_TYPES is an allowlist because `type` becomes a filename. A renderer the
   attacker controls must not be able to steer that path out of userData. It
   comes from grow-schema.js, which is also what tells the agent's log_grow tool
   which fields exist - one list, so the store, the form and the tool cannot
   drift apart. */
function growPath(type) {
  if (!GROW_TYPES.has(type)) return null;
  const d = path.join(app.getPath("userData"), "grow");
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return path.join(d, type + ".json");
}
function growRead(type) {
  const p = growPath(type); if (!p) return [];
  try { const v = JSON.parse(fs.readFileSync(p, "utf8")); return Array.isArray(v) ? v : []; } catch { return []; }
}
function growWrite(type, record) {
  const t = String(type || "");
  if (!GROW_TYPES.has(t)) return { ok: false, error: "unknown record type" };
  const rows = growRead(t);
  const rec = { ...(record || {}) };
  const now = Date.now();
  if (rec.id) {
    const i = rows.findIndex((r) => r && r.id === rec.id);
    if (i < 0) return { ok: false, error: "no such record" };
    rows[i] = { ...rows[i], ...rec, updatedAt: now };
  } else {
    rec.id = "g-" + now.toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    rec.createdAt = now; rec.updatedAt = now;
    rows.push(rec);
  }
  // Surface a failed write instead of swallowing it: a log that silently drops
  // the entry is worse than one that refuses it, because the grower walks away
  // believing the record exists.
  try { fs.writeFileSync(growPath(t), JSON.stringify(rows, null, 2)); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
  return { ok: true, id: rec.id, record: rows.find((r) => r.id === rec.id) };
}
/* ─── The phone companion ────────────────────────────────────────────────────
   This app already owns a shell, a file tree and a git checkout. The phone app
   owns none of them and cannot: iOS will not fork a process. So the desktop
   lends them over the tailnet, and pairing is a QR code drawn from qr.js rather
   than a token typed on a phone keyboard.

   Off until asked, every time — nothing listens on install, and starting it is
   a deliberate act with the address and the token shown. */
const { Companion } = require("./companion");
const qr = require("./qr");
let companion = null;
function companionInstance() {
  if (!companion) {
    companion = new Companion({
      tokenFile: path.join(app.getPath("userData"), "companion.token"),
      // Electron's own blocker: "prevent-app-suspension" keeps the system from
      // idling out while still letting the display sleep, which is what a
      // machine being driven from a phone wants.
      keepAwake: require("electron").powerSaveBlocker,
      // Every command the phone runs is announced to the window, so a shell
      // being driven remotely is never a silent one.
      onEvent: (e) => { try { mainWindow && mainWindow.webContents.send("crowe:companion:event", e); } catch { /* window gone */ } },
    });
  }
  return companion;
}
ipcMain.handle("crowe:companion:status", () => companionInstance().status());
ipcMain.handle("crowe:companion:start", async () => {
  try { return await companionInstance().start(); }
  catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle("crowe:companion:stop", () => companionInstance().stop());
ipcMain.handle("crowe:companion:devices", () => companionInstance().deviceList());
ipcMain.handle("crowe:companion:addDevice", (_e, { name } = {}) => {
  const c = companionInstance();
  const d = c.addDevice(name);
  // The token goes out as a drawn code, never as a string the renderer holds.
  return { id: d.id, name: d.name, svg: c.pairUrl() ? qr.toSvg(c.pairUrlFor(d), { scale: 6 }) : null };
});
ipcMain.handle("crowe:companion:revokeDevice", (_e, { id } = {}) => companionInstance().revokeDevice(id));
ipcMain.handle("crowe:companion:audit", (_e, { limit } = {}) => companionInstance().recentAudit(limit || 40));
ipcMain.handle("crowe:companion:rotate", () => {
  const c = companionInstance();
  c.rotateToken();
  return c.status();
});
/* The SVG is drawn here and handed over as markup, so the token reaches the
   screen without ever being a string the renderer holds and could log, copy or
   put in a crash report. */
ipcMain.handle("crowe:companion:pairSvg", () => {
  const c = companionInstance();
  const url = c.pairUrl();
  if (!url) return { error: "the companion is not running" };
  return { svg: qr.toSvg(url, { scale: 6 }), host: c.status().host, port: c.status().port };
});

ipcMain.handle("crowe:grow:list", (_e, { type } = {}) => growRead(String(type || "")));
ipcMain.handle("crowe:grow:save", (_e, { type, record } = {}) => growWrite(type, record));
/* A trace leaves the app through the OS save dialog, never to a path the
   renderer picked. The grower chooses where it lands and sees the filename, so
   an export is always something they did rather than something that happened to
   them - and no page-side string ever becomes a write path. */
ipcMain.handle("crowe:grow:export", async (_e, { name, text } = {}) => {
  const safe = String(name || "trace").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60) || "trace";
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Export lot trace",
    defaultPath: path.join(app.getPath("documents"), `lot-trace-${safe}.txt`),
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try { fs.writeFileSync(filePath, String(text || "")); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
  return { ok: true, path: filePath };
});
ipcMain.handle("crowe:grow:delete", (_e, { type, id } = {}) => {
  const t = String(type || "");
  if (!GROW_TYPES.has(t)) return { ok: false, error: "unknown record type" };
  try { fs.writeFileSync(growPath(t), JSON.stringify(growRead(t).filter((r) => r && r.id !== id), null, 2)); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
  return { ok: true };
});

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
    // macOS: tray.png is solid black + alpha and flagged as a template image,
    // so the menu bar recolours it for light/dark/tinted itself. Elsewhere the
    // white variant covers the (usually dark) taskbar.
    const trayFile = process.platform === "darwin" ? "tray.png" : "tray-light.png";
    const img = nativeImage.createFromPath(path.join(__dirname, "assets", trayFile)).resize({ width: 18, height: 18 });
    if (process.platform === "darwin") img.setTemplateImage(true);
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
  const tier = loadConfig().autonomy || "edit";
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

// ─── Auto-update ─────────────────────────────────────────────────────────────
// Manual-consent flow: check on launch + on demand, tell the renderer when an
// update is available, download only when the user asks, install on quit.
let updateState = { status: "idle", version: "", notes: "" };
let updateUserInitiated = false; // errors only surface for checks the user asked for
function relayUpdate() { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("crowe:update", updateState); }
function setupAutoUpdate() {
  if (!autoUpdater || !app.isPackaged) return;   // dev/unsigned runs never self-update
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", (info) => { updateState = { status: "available", version: info.version, notes: String(info.releaseNotes || "").slice(0, 500) }; relayUpdate(); });
  autoUpdater.on("update-not-available", () => { updateState = { status: "current", version: app.getVersion(), notes: "" }; relayUpdate(); });
  autoUpdater.on("download-progress", (p) => { updateState = { ...updateState, status: "downloading", percent: Math.round(p.percent) }; relayUpdate(); });
  autoUpdater.on("update-downloaded", (info) => { updateState = { status: "ready", version: info.version, notes: updateState.notes }; relayUpdate(); });
  autoUpdater.on("error", (e) => {
    // A silent launch check that 404s (unseeded channel) or fails offline must
    // not raise a red-herring banner on every start. Only surface user-asked errors.
    if (!updateUserInitiated) return;
    updateState = { status: "error", message: String(e).slice(0, 200) }; relayUpdate();
  });
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 4000);
}
ipcMain.handle("crowe:update:check", async () => { if (!autoUpdater || !app.isPackaged) return { status: "dev" }; updateUserInitiated = true; try { await autoUpdater.checkForUpdates(); } catch (e) { return { status: "error", message: String(e).slice(0, 200) }; } return updateState; });
ipcMain.handle("crowe:update:download", async () => { if (!autoUpdater) return { error: "unavailable" }; try { await autoUpdater.downloadUpdate(); } catch (e) { return { error: String(e).slice(0, 200) }; } return { ok: true }; });
ipcMain.handle("crowe:update:install", () => { if (autoUpdater) autoUpdater.quitAndInstall(); return { ok: true }; });
ipcMain.handle("crowe:update:state", () => updateState);

app.whenReady().then(async () => {
  migrateLegacyAuth();
  initCrashReporting();
  createWindow();
  buildMenu();
  createTray();
  setupAutoUpdate();
  postTelemetry("app_launch", { firstRun: !loadConfig().onboarded });
  process.on("uncaughtException", (e) => { postTelemetry("main_exception", { error: String(e && e.message || e).slice(0, 200) }); });
  try { globalShortcut.register("CommandOrControl+Shift+Space", () => { toggleWindow(); relayMenu("focus-composer"); }); } catch {}
  mcpConnectAll();
  pluginsConnectAll();
  pruneArtifacts();
  fetchCatalog(); setInterval(fetchCatalog, 10 * 60 * 1000);
  // Keep the Crowe ID session fresh while the app runs: refresh proactively
  // before expiry so a long-lived window never silently loses the harness.
  setInterval(() => {
    const u = currentUser();
    if (u && u.exp && u.exp * 1000 < Date.now() + 5 * 60 * 1000) refreshToken();
  }, 4 * 60 * 1000);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
// Native children outlive the window unless we kill them. node-pty in
// particular throws from its destructor if a PTY is still open at exit, which
// aborts the process with SIGABRT after the app has otherwise shut down
// cleanly. Tear both down on every quit path.
function shutdownNativeResources() {
  for (const [id, proc] of ptyProcs) { try { proc.kill(); } catch {} ptyProcs.delete(id); }
  for (const [id, srv] of Object.entries(MCP)) { try { srv.proc.kill(); } catch {} delete MCP[id]; }
}
app.on("before-quit", shutdownNativeResources);
app.on("will-quit", () => { shutdownNativeResources(); try { globalShortcut.unregisterAll(); } catch {} });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

module.exports = { shutdownNativeResources };
