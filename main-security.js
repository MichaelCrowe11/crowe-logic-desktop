"use strict";

const path = require("path");
const { fileURLToPath } = require("url");
const { normalizeSense } = require("./sense");

const TRUSTED_WEB_ORIGINS = new Set([
  "https://crowelogic.com",
  "https://croweagents.com",
]);
const BLOCKED_ENV_KEY_RE = /^(?:BASH_ENV|ENV|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|GIT_ASKPASS|SSH_ASKPASS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.+|PATH)$/i;
const AUTONOMY = new Set(["plan", "readonly", "edit", "execute"]);
const APPROVALS = new Set(["off", "high-risk", "strict"]);

function parsedUrl(raw) {
  try { return new URL(String(raw || "")); } catch { return null; }
}

function isAppDocument(raw, entryPath) {
  const url = parsedUrl(raw);
  if (!url || url.protocol !== "file:") return false;
  try { return path.resolve(fileURLToPath(url)) === path.resolve(entryPath); }
  catch { return false; }
}

function isTrustedPermissionUrl(raw, entryPath) {
  const url = parsedUrl(raw);
  if (!url) return false;
  if (url.protocol === "file:") return isAppDocument(raw, entryPath);
  return TRUSTED_WEB_ORIGINS.has(url.origin);
}

function isSafeGuestUrl(raw) {
  const url = parsedUrl(raw);
  if (!url) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost");
}

function isTrustedIpcSender(event, window, entryPath) {
  if (!event || !window || window.isDestroyed?.()) return false;
  const sender = event.sender;
  const frame = event.senderFrame;
  if (!sender || sender !== window.webContents || sender.isDestroyed?.()) return false;
  if (!frame || frame !== sender.mainFrame) return false;
  return isAppDocument(frame.url, entryPath);
}

function isSafeRecordId(raw) {
  return /^(?:s|r)-[A-Za-z0-9_-]{1,120}$/.test(String(raw || ""));
}

function hardenGuestPreferences(webPreferences) {
  delete webPreferences.preload;
  delete webPreferences.session;
  // A guest naming its own partition would land in a session that carries none
  // of the permission handlers registered on the default one.
  delete webPreferences.partition;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
}

function sanitizePluginEnv(plugin, raw) {
  const allowed = new Set((plugin && plugin.envPrompts || []).map((item) => item && item.key).filter(Boolean));
  const clean = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return clean;
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key) || BLOCKED_ENV_KEY_RE.test(key) || typeof value !== "string") continue;
    clean[key] = value.slice(0, 8192);
  }
  return clean;
}

function sanitizeMcpServers(raw) {
  const clean = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return clean;
  for (const [name, spec] of Object.entries(raw).slice(0, 20)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || !spec || typeof spec !== "object" || Array.isArray(spec)) continue;
    if (typeof spec.command !== "string" || !spec.command.trim()) continue;
    const next = { command: spec.command.trim().slice(0, 4096) };
    if (Array.isArray(spec.args)) next.args = spec.args.filter((arg) => typeof arg === "string").slice(0, 64).map((arg) => arg.slice(0, 8192));
    if (spec.env && typeof spec.env === "object" && !Array.isArray(spec.env)) {
      next.env = {};
      for (const [key, value] of Object.entries(spec.env).slice(0, 64)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || BLOCKED_ENV_KEY_RE.test(key) || typeof value !== "string") continue;
        next.env[key] = value.slice(0, 8192);
      }
    }
    clean[name] = next;
  }
  return clean;
}

function sanitizeConfigPatch(raw) {
  const patch = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  if (typeof patch.baseUrl === "string") {
    const url = parsedUrl(patch.baseUrl.trim());
    if (url && isSafeGuestUrl(url.toString())) out.baseUrl = url.toString().replace(/\/$/, "").slice(0, 2048);
  }
  for (const key of ["cwd", "model", "licenseWorkspaceId"]) {
    if (typeof patch[key] === "string") out[key] = patch[key].slice(0, key === "cwd" ? 4096 : 256);
  }
  // No token. Sign-in writes it in main; nothing in the renderer has a reason
  // to, and a document that could would be choosing where the bearer goes.
  for (const key of ["autoApprove", "telemetry", "onboarded", "verifier"]) {
    if (typeof patch[key] === "boolean") out[key] = patch[key];
  }
  if (AUTONOMY.has(patch.autonomy)) out.autonomy = patch.autonomy;
  if (APPROVALS.has(patch.approvals)) out.approvals = patch.approvals;
  if (["reading", "brisk", "instant"].includes(patch.textPace)) out.textPace = patch.textPace;
  for (const [key, max] of [["turnBudgetUsd", 10000], ["turnTokenCap", 10000000]]) {
    const value = Number(patch[key]);
    if (Number.isFinite(value) && value >= 0) out[key] = Math.min(value, max);
  }
  if (Object.hasOwn(patch, "mcpServers")) out.mcpServers = sanitizeMcpServers(patch.mcpServers);
  if (patch.sense && typeof patch.sense === "object") out.sense = normalizeSense(patch.sense);
  return out;
}

const MAX_MESSAGE_CHARS = 50000;
function sanitizeAgentMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-128).filter((message) => message && ["user", "assistant"].includes(message.role))
    // The cap matches the composer's maxlength (50,000). A lower cap here cut
    // long pastes silently, after the renderer had accepted them in full.
    .map((message) => ({ role: message.role, content: String(message.content || "").slice(0, MAX_MESSAGE_CHARS) }));
}

module.exports = {
  isAppDocument,
  isTrustedPermissionUrl,
  isSafeGuestUrl,
  isTrustedIpcSender,
  isSafeRecordId,
  hardenGuestPreferences,
  sanitizePluginEnv,
  sanitizeMcpServers,
  sanitizeConfigPatch,
  sanitizeAgentMessages,
  MAX_MESSAGE_CHARS,
};
