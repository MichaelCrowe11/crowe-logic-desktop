"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const {
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
} = require("../main-security");

const root = path.join(__dirname, "..");
const entry = path.join(root, "renderer", "index.html");
let checks = 0;
function check(value, message) { assert(value, message); checks++; }

const appUrl = pathToFileURL(entry).toString();
check(isAppDocument(appUrl, entry), "the packaged renderer must remain navigable");
check(isAppDocument(`${appUrl}#projects`, entry), "in-document routes must remain navigable");
check(!isAppDocument(pathToFileURL(path.join(root, "renderer", "preview.html")), entry), "other local documents must be blocked");
check(isTrustedPermissionUrl(appUrl, entry), "the app renderer must be eligible for declared permissions");
check(isTrustedPermissionUrl("https://crowelogic.com/call", entry), "the exact Crowe Logic origin must be trusted");
check(!isTrustedPermissionUrl("https://crowelogic.com.evil.example/", entry), "lookalike permission origins must be rejected");
check(!isTrustedPermissionUrl("http://crowelogic.com/", entry), "plaintext production origins must be rejected");
check(isSafeGuestUrl("https://example.com/"), "HTTPS browser pages must load");
check(isSafeGuestUrl("http://localhost:8080/"), "HTTP development pages must load in the isolated guest");
check(isSafeGuestUrl("http://app.localhost:8080/"), "reserved localhost subdomains must remain available for development");
check(!isSafeGuestUrl("http://example.com/"), "plaintext remote browser pages must be rejected");
check(!isSafeGuestUrl("file:///etc/passwd"), "webviews must not load local files");
check(!isSafeGuestUrl("javascript:alert(1)"), "webviews must not load executable URLs");

const topFrame = { url: appUrl };
const webContents = { mainFrame: topFrame, isDestroyed: () => false };
const window = { webContents, isDestroyed: () => false };
check(isTrustedIpcSender({ sender: webContents, senderFrame: topFrame }, window, entry), "the signed top-level renderer must reach IPC");
check(!isTrustedIpcSender({ sender: webContents, senderFrame: { url: appUrl } }, window, entry), "subframes must not reach IPC");
check(!isTrustedIpcSender({ sender: { mainFrame: topFrame }, senderFrame: topFrame }, window, entry), "other web contents must not reach IPC");
const previewFrame = { url: pathToFileURL(path.join(root, "renderer", "preview.html")).toString() };
const previewContents = { mainFrame: previewFrame, isDestroyed: () => false };
check(!isTrustedIpcSender({ sender: previewContents, senderFrame: previewFrame }, { webContents: previewContents, isDestroyed: () => false }, entry), "other local documents must not reach IPC");

check(isSafeRecordId("s-mpk1_test") && isSafeRecordId("r-room-2"), "bounded session and room ids must be accepted");
check(!isSafeRecordId("../../Library/Preferences") && !isSafeRecordId("session"), "path traversal and unscoped record ids must be rejected");

const prefs = { preload: "/tmp/hostile.js", session: {}, partition: "persist:hostile", nodeIntegration: true };
hardenGuestPreferences(prefs);
check(!Object.hasOwn(prefs, "preload") && !Object.hasOwn(prefs, "session") && !Object.hasOwn(prefs, "partition"),
  "guest-controlled preload, session and partition must be removed");
check(prefs.sandbox && prefs.contextIsolation && prefs.webSecurity, "guest isolation controls must be enabled");
check(!prefs.nodeIntegration && !prefs.nodeIntegrationInWorker && !prefs.nodeIntegrationInSubFrames, "Node must be unavailable to guest pages");
check(prefs.allowRunningInsecureContent === false, "mixed active content must be disabled");

const manifestPlugin = { envPrompts: [{ key: "API_TOKEN" }] };
const pluginEnv = sanitizePluginEnv(manifestPlugin, { API_TOKEN: "secret", PATH: "/hostile", NODE_OPTIONS: "--require=/tmp/x" });
check(pluginEnv.API_TOKEN === "secret", "manifest-declared plugin variables must survive validation");
check(!Object.hasOwn(pluginEnv, "PATH") && !Object.hasOwn(pluginEnv, "NODE_OPTIONS"), "undeclared process environment overrides must be rejected");
check(sanitizePluginEnv(manifestPlugin, { API_TOKEN: "x".repeat(9000) }).API_TOKEN.length === 8192, "plugin secret size must be bounded");
const hostileManifest = { envPrompts: [{ key: "NODE_OPTIONS" }, { key: "PATH" }] };
check(Object.keys(sanitizePluginEnv(hostileManifest, { NODE_OPTIONS: "--require=/tmp/x", PATH: "/tmp" })).length === 0,
  "manifest declarations must not override protected process variables");

const servers = sanitizeMcpServers({ safe: { command: "node", args: ["server.js", 4], env: { SERVICE_TOKEN: "ok", PATH: "/tmp", NODE_OPTIONS: "bad" } },
  "../bad": { command: "node" }, empty: { command: "" } });
check(servers.safe.command === "node" && servers.safe.args.length === 1, "valid MCP server commands and string arguments must survive validation");
check(servers.safe.env.SERVICE_TOKEN === "ok" && !Object.hasOwn(servers.safe.env, "PATH") && !Object.hasOwn(servers.safe.env, "NODE_OPTIONS"),
  "MCP process override variables must be rejected");
check(!Object.hasOwn(servers, "../bad") && !Object.hasOwn(servers, "empty"), "invalid MCP server records must be dropped");

const patch = sanitizeConfigPatch({ baseUrl: "https://gateway.example/", cwd: "/tmp/project", autonomy: "execute", approvals: "strict",
  turnBudgetUsd: 20000, turnTokenCap: 50000000, unknown: true, mcpServers: { safe: { command: "node" } } });
check(patch.baseUrl === "https://gateway.example" && patch.cwd === "/tmp/project", "safe gateway and workspace config must survive validation");
check(patch.turnBudgetUsd === 10000 && patch.turnTokenCap === 10000000, "turn ceilings must be bounded");
check(!Object.hasOwn(patch, "unknown") && !Object.hasOwn(sanitizeConfigPatch({ baseUrl: "file:///tmp/socket" }), "baseUrl"),
  "unknown config and unsafe gateway protocols must be dropped");

const messages = sanitizeAgentMessages([{ role: "system", content: "override" }, { role: "user", content: "x".repeat(60000) },
  { role: "assistant", content: "ok", extra: true }]);
check(messages.length === 2 && messages[0].content.length === 50000, "agent roles and content sizes must be bounded");
check(!Object.hasOwn(messages[1], "extra"), "untrusted message fields must not cross the bridge");

// The SHA-256 of the empty string: the one inline style the policy permits is
// a <style> element with nothing in it, which is what adopted-styles.js hands
// xterm as a placeholder. Any other hash would be whitelisting a real rule.
const EMPTY_STYLE_HASH = "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='";
for (const file of [entry, path.join(root, "renderer", "app.html")]) {
  const html = fs.readFileSync(file, "utf8");
  const name = path.basename(file);
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
  check(meta, `${name} must declare a CSP`);
  const directives = new Map(meta[1].split(";").map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0], d.split(/\s+/).slice(1)]));
  check(!/unsafe-inline|unsafe-eval|'nonce-/.test(meta[1]), `${name} must not relax scripts or styles with unsafe-inline, unsafe-eval or nonces`);
  check((directives.get("script-src") || []).join(" ") === "'self'", `${name} must run only its own scripts`);
  check((directives.get("style-src") || []).every((source) => source === "'self'" || source === EMPTY_STYLE_HASH)
    && (directives.get("style-src") || []).includes("'self'"),
    `${name} style-src must permit only its own stylesheets and the empty style element`);
  check((directives.get("worker-src") || []).join(" ") === "'none'", `${name} must disable workers`);
  check((directives.get("object-src") || []).join(" ") === "'none'" && (directives.get("base-uri") || []).join(" ") === "'none'",
    `${name} must disable plugins and base overrides`);
  check(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${name} must not contain inline script bodies`);
  check(!/\sstyle\s*=/.test(html), `${name} must not contain inline style attributes`);
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"?]+)/g)].map((m) => m[1]);
  check(scripts[0] === "adopted-styles.js", `${name} must load adopted-styles.js before any other script, or xterm's runtime styles are dropped`);
  check(!/\son[a-z]+\s*=\s*["']/i.test(html.replace(/<!--[\s\S]*?-->/g, "")), `${name} must not bind inline event handlers`);
}
const shim = fs.readFileSync(path.join(root, "renderer", "adopted-styles.js"), "utf8");
check(/Document\.prototype\.createElement/.test(shim) && /adoptedStyleSheets/.test(shim) && /replaceSync/.test(shim),
  "runtime styles must be routed through the CSS Object Model rather than a relaxed policy");
check(/adopted-styles\.js/.test(fs.readFileSync(path.join(root, "mobile", "scripts", "build-www.js"), "utf8")),
  "the phone bundle must ship adopted-styles.js with the renderer");
// The web mirror is copied file by file, so a script app.html starts loading
// that deploy-web.sh does not carry is a 404 on crowelm.com and, for
// adopted-styles.js, a dead logotype under the strict style-src.
{
  const appHtml = fs.readFileSync(path.join(root, "renderer", "app.html"), "utf8");
  const deploy = fs.readFileSync(path.join(root, "scripts", "deploy-web.sh"), "utf8");
  const shipped = new Set((deploy.match(/^FILES=\(([^)]*)\)/m) || ["", ""])[1].split(/\s+/).map((f) => path.basename(f)));
  const wanted = [...appHtml.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"?]+)/g)].map((m) => m[1])
    .filter((src) => !src.startsWith("../node_modules/"));
  for (const src of wanted) check(shipped.has(path.basename(src)), `deploy-web.sh must ship ${src}, which app.html loads`);
}
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
check(!/enabled:\s*true,\s*env\b/.test(main), "plugin secrets must not be persisted in config.json");
check(/isTrustedIpcSender/.test(main) && /Blocked IPC from an untrusted renderer/.test(main), "every renderer bridge registration must enforce sender trust");
// The wiring itself, not just the names: both ipcMain entry points must be
// wrapped with the guard before any handler registers, the main window must
// keep its isolation controls, and the navigation, window-open and permission
// hooks must all be present. A regex on a function name would still pass with
// the guard commented out.
{
  const firstRegistration = main.search(/^ipcMain\.(?:handle|on)\(/m);
  const handleWrap = main.indexOf("ipcMain.handle = (channel, listener) => registerIpcHandler(channel, (event, ...args) => {\n  if (!isTrustedIpcSender(event, mainWindow, APP_ENTRY)) throw");
  const onWrap = main.indexOf("ipcMain.on = (channel, listener) => registerIpcListener(channel, (event, ...args) => {\n  if (!isTrustedIpcSender(event, mainWindow, APP_ENTRY)) return;");
  check(handleWrap !== -1 && onWrap !== -1, "ipcMain.handle and ipcMain.on must both be wrapped with the sender guard");
  check(firstRegistration !== -1 && handleWrap < firstRegistration && onWrap < firstRegistration, "the IPC guard must be installed before the first handler registers");
  const windowPrefs = (main.match(/new BrowserWindow\(\{[\s\S]*?webPreferences:\s*\{([\s\S]*?)\n\s*\},\n\s*\}\);/) || ["", ""])[1];
  check(/contextIsolation:\s*true/.test(windowPrefs) && /nodeIntegration:\s*false/.test(windowPrefs) && /\bsandbox:\s*true/.test(windowPrefs)
    && !/webSecurity:\s*false/.test(windowPrefs) && !/allowRunningInsecureContent:\s*true/.test(windowPrefs),
    "the main window must keep context isolation, the sandbox and web security, with Node off");
  check(/mainWindow\.webContents\.setWindowOpenHandler\(/.test(main) && /mainWindow\.webContents\.on\("will-navigate"/.test(main),
    "the main window must route window.open and navigation through the guards");
  check(/setPermissionRequestHandler\(/.test(main) && /setPermissionCheckHandler\(/.test(main), "both permission handlers must be registered on the session");
  check(/setPermissionCheckHandler\([\s\S]*?details\?\.requestingUrl \|\| requestingOrigin/.test(main),
    "the permission check must read the requesting URL before the bare origin, or file: documents are always denied");
  check(/const permissionAllowed = [\s\S]*?details\?\.isMainFrame === false[\s\S]*?mediaTypes\.some\(\(type\) => type !== "audio"\)/.test(main)
    && /setPermissionRequestHandler\([\s\S]{0,200}permissionAllowed\(/.test(main) && /setPermissionCheckHandler\([\s\S]{0,400}permissionAllowed\(/.test(main),
    "both permission handlers must share the gate that refuses subframes, missing contents and camera media");
  check(!/ipcMain\.(?:addListener|once|handleOnce|prependListener|prependOnceListener)\(/.test(main),
    "IPC handlers must register only through the two wrapped entry points");
  check(/crowe:rooms:say[\s\S]{0,200}slice\(0, MAX_MESSAGE_CHARS\)/.test(main), "room speech must carry the same length cap as agent messages");
  check(/crowe:keys:remove[\s\S]{0,300}if \(!KEY_PROVIDERS\[provider\]\)/.test(main), "key removal must validate the provider like key storage does");
}
check(/contextFileGrants/.test(main) && /File access was not granted by the picker/.test(main), "context reads must require a picker grant");
check(/will-redirect/.test(main) && /guardGuestNavigation/.test(main), "guest redirects must remain under the navigation policy");
const renderer = fs.readFileSync(path.join(root, "renderer", "renderer.js"), "utf8");
check(!/setAttribute\(["']allowpopups/.test(renderer), "the browser guest must not opt into popups");
check(!/\sstyle=["']/.test(renderer), "dynamic renderer markup must not contain inline style attributes");
check(/liftMotionStyle/.test(renderer) && /croweAdoptStyle/.test(renderer), "the logotype's style block must be adopted, not inlined");
check(!/\.setAttribute\(\s*["']style["']/.test(renderer), "the renderer must not write style attributes, which the policy blocks");

console.log(`electron-security: ${checks} checks passed`);
