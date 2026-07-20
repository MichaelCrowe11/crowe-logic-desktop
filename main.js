// Crowe Logic desktop — main process.
// Owns the window and the gateway bridge. The API token lives here, never in the
// renderer: the renderer calls window.crowe.chat() over IPC and the fetch to the
// CroweLM gateway happens in this process.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

const DEFAULTS = {
  // The CroweLM gateway (control plane). Override in Settings.
  baseUrl: "https://foundry-control-plane-production.up.railway.app",
  model: "crowelm-zenith", // the frontier tier by default
  token: "", // Crowe ID bearer token or API key
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: "#f5f1e8", // Crowe cream, so no white flash on load
    title: "Crowe Logic",
    icon: path.join(__dirname, "assets", "icon.icns"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// ── Gateway chat: forwards tools (native function calling) and returns
//    tool_calls for the renderer's agent loop to execute. ──
ipcMain.handle("crowe:chat", async (_evt, { messages, tools }) => {
  const cfg = loadConfig();
  if (!cfg.token) {
    return { error: "No token set. Open Settings and paste your Crowe ID token or API key." };
  }
  try {
    const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/api/gateway/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ model: cfg.model, messages, tools: tools || undefined }),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { detail: text }; }
    if (!resp.ok) {
      return { error: `HTTP ${resp.status}: ${data.detail || text}`.slice(0, 400) };
    }
    return {
      content: data.content || "",
      tool_calls: data.tool_calls || [],
      usage: data.usage || {},
      model: data.model || cfg.model,
    };
  } catch (e) {
    return { error: `gateway unreachable: ${String(e).slice(0, 200)}` };
  }
});

ipcMain.handle("crowe:get-config", () => {
  const c = loadConfig();
  return { baseUrl: c.baseUrl, model: c.model, hasToken: Boolean(c.token) };
});
ipcMain.handle("crowe:set-config", (_evt, patch) => {
  const c = saveConfig(patch || {});
  return { baseUrl: c.baseUrl, model: c.model, hasToken: Boolean(c.token) };
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
