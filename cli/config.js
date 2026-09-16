// Configuration for the headless runner.
//
// The desktop keeps its config in Electron's userData, which a CLI does not
// have. Same keys, different home: ~/.crowe/cli.json, or wherever CROWE_HOME
// points. Precedence is flags, then environment, then the file, then defaults,
// because a flag is the most specific thing a caller can say and a file is the
// least.
//
// The autonomy tier and the approval mode are normalised the way main.js
// normalises them: an unreadable value resolves to the safe end, never to the
// permissive one. A config we cannot parse is not consent.

const fs = require("fs");
const os = require("os");
const path = require("path");

const TIERS = new Set(["plan", "readonly", "edit", "execute"]);
const APPROVAL_MODES = new Set(["off", "high-risk", "strict"]);

const DEFAULTS = {
  baseUrl: "https://api.crowelogic.com",
  model: "crowelm",
  token: "",
  autonomy: "edit",
  approvals: "high-risk",
  autoApprove: false,
  verifier: true,
  turnBudgetUsd: 2,
  turnTokenCap: 400000,
  // The hosted control plane: off | local | remote. Off is the product as it
  // ships today, and it is the default because this must not change what an
  // existing install does.
  controlPlane: "off",
  tenantId: "local",
  workspaceId: "",
};

const PLANE_MODES = new Set(["off", "local", "remote"]);

// Display rates for the daily driver, mirrored from main.js. They price the
// dollar ceiling and the usage line; they are not billing.
const RATE_IN = 1.25 / 1e6;
const RATE_OUT = 10 / 1e6;

function homeDir(env = process.env) {
  return env.CROWE_HOME || path.join(os.homedir(), ".crowe");
}
function configPath(env = process.env) {
  return env.CROWE_CONFIG || path.join(homeDir(env), "cli.json");
}

function readFileConfig(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}

// Only the keys we understand, and only when they are actually set. An env var
// exported as an empty string is someone unsetting it, not someone choosing "".
function fromEnv(env = process.env) {
  const out = {};
  if (env.CROWE_BASE_URL) out.baseUrl = env.CROWE_BASE_URL;
  if (env.CROWE_TOKEN) out.token = env.CROWE_TOKEN;
  if (env.CROWE_MODEL) out.model = env.CROWE_MODEL;
  if (env.CROWE_AUTONOMY) out.autonomy = env.CROWE_AUTONOMY;
  if (env.CROWE_APPROVALS) out.approvals = env.CROWE_APPROVALS;
  if (env.CROWE_CONTROL_PLANE) out.controlPlane = env.CROWE_CONTROL_PLANE;
  if (env.CROWE_TENANT) out.tenantId = env.CROWE_TENANT;
  if (env.CROWE_WORKSPACE) out.workspaceId = env.CROWE_WORKSPACE;
  return out;
}

function stripUndefined(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined) out[k] = v;
  return out;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/* Merged, then normalised. The normalisation is the load-bearing half: every
   value that grants something has to fail closed, so an autonomy tier we do not
   recognise becomes "edit" rather than "execute", and an approval mode we do
   not recognise becomes "high-risk" rather than "off". */
function loadConfig({ env = process.env, flags = {}, file } = {}) {
  const target = file || configPath(env);
  const merged = { ...DEFAULTS, ...readFileConfig(target), ...fromEnv(env), ...stripUndefined(flags) };
  return {
    baseUrl: String(merged.baseUrl || DEFAULTS.baseUrl),
    model: String(merged.model || DEFAULTS.model),
    token: String(merged.token || ""),
    autonomy: TIERS.has(merged.autonomy) ? merged.autonomy : DEFAULTS.autonomy,
    approvals: APPROVAL_MODES.has(merged.approvals) ? merged.approvals : DEFAULTS.approvals,
    autoApprove: merged.autoApprove === true,
    verifier: merged.verifier !== false,
    turnBudgetUsd: num(merged.turnBudgetUsd, DEFAULTS.turnBudgetUsd),
    turnTokenCap: num(merged.turnTokenCap, DEFAULTS.turnTokenCap),
    controlPlane: PLANE_MODES.has(merged.controlPlane) ? merged.controlPlane : DEFAULTS.controlPlane,
    tenantId: String(merged.tenantId || DEFAULTS.tenantId),
    workspaceId: String(merged.workspaceId || ""),
    configFile: target,
    home: homeDir(env),
  };
}

module.exports = { loadConfig, configPath, homeDir, DEFAULTS, TIERS, APPROVAL_MODES, PLANE_MODES, RATE_IN, RATE_OUT };
