// Real main -> sandboxed preload -> renderer edition contract.
// Run separately with CROWE_EDITION=desktop, developers, mycology, and with
// CROWE_SPACES=chat or CROWE_SPACES=projects,farm,cultivation to exercise narrowing.
// This launches main.js; do not run when actual-main launches are held.

const { app, BrowserWindow, session, ipcMain, shell, safeStorage, utilityProcess, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert/strict");

// main.js reads configuration at require time. Isolate every location BEFORE
// requiring it; no test may clear a real profile or import its legacy identity.
const isolated = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crowe-install-spaces-")));
for (const name of ["home", "userData", "sessionData", "logs", "cache", "workspace", "temp"]) {
  fs.mkdirSync(path.join(isolated, name), { recursive: true });
}
const inherited = { PATH: process.env.PATH || "", LANG: "en_US.UTF-8" };
for (const key of ["DISPLAY", "CROWE_EDITION", "CROWE_SPACES"]) if (Object.hasOwn(process.env, key)) inherited[key] = process.env[key];
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, inherited);
os.homedir = () => path.join(isolated, "home");
process.env.HOME = process.env.USERPROFILE = os.homedir();
process.env.TMPDIR = process.env.TMP = process.env.TEMP = path.join(isolated, "temp");
process.env.XDG_CONFIG_HOME = path.join(isolated, "home", ".config");
process.env.XDG_CACHE_HOME = path.join(isolated, "cache");
process.env.XDG_DATA_HOME = path.join(isolated, "home", ".local", "share");
process.env.SHELL = "/bin/sh";
for (const name of ["home", "userData", "sessionData", "cache"]) app.setPath(name, path.join(isolated, name));
app.setAppLogsPath(path.join(isolated, "logs"));
// Preserve this explicit isolated profile even for non-Desktop development.
app.commandLine.appendSwitch("user-data-dir", path.join(isolated, "userData"));
for (const name of ["appData", "crashDumps", "downloads", "documents", "temp", "desktop", "music", "pictures", "videos"]) {
  const dir = path.join(isolated, name); fs.mkdirSync(dir, { recursive: true }); app.setPath(name, dir);
}
process.chdir(path.join(isolated, "workspace"));
safeStorage.isEncryptionAvailable = () => false;
safeStorage.encryptString = safeStorage.decryptString = () => { throw new Error("Credential storage disabled by install-spaces test"); };
fs.writeFileSync(path.join(isolated, "userData", "config.json"), JSON.stringify({
  cwd: path.join(isolated, "workspace"), telemetry: false, onboarded: true,
  mcpServers: {}, plugins: {}, autonomy: "readonly", sense: { mode: "off" }, controlPlane: "off",
}));
assert.ok(!app.commandLine.hasSwitch("no-sandbox") && !app.commandLine.hasSwitch("disable-setuid-sandbox"), "Chromium sandbox must remain enabled");
const processAttempts = [];
const blockedProcess = api => () => { processAttempts.push(api); throw new Error("Subprocess disabled by install-spaces test: " + api); };
const childProcess = require("child_process");
for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[method] = blockedProcess("child_process." + method);
utilityProcess.fork = blockedProcess("utilityProcess.fork");
let nativePty;
try { nativePty = require("node-pty"); } catch { /* Native module is optional. */ }
if (nativePty) nativePty.spawn = blockedProcess("node-pty.spawn");
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
dialog.showSaveDialog = async () => ({ canceled: true });
// No internet, telemetry, gateway, updater or external-browser activity. Local
// file navigation and IPC remain real; no engine or shell is needed for this gate.
const offline = () => { throw new Error("Network disabled by install-spaces test"); };
// Empty catalog/status responses are synthetic and make offline UI reads
// deterministic. An engine call is never simulated as a successful request.
global.fetch = async url => {
  const address = String(url);
  if (/\/chat|\/responses|\/messages/.test(address)) return offline();
  return new Response(JSON.stringify(address.includes("/catalog") ? { models: [] } : {}), { status: 200, headers: { "Content-Type": "application/json" } });
};
for (const name of ["http", "https"]) {
  const transport = require(name); transport.request = offline; transport.get = offline;
}
require("net").Socket.prototype.connect = offline;
require("tls").connect = offline;
shell.openExternal = async () => offline();
app.on("session-created", (s) => s.webRequest.onBeforeRequest((details, callback) => {
  callback({ cancel: !/^(file:|data:|blob:|devtools:)/.test(details.url) });
}));
// Registered ahead of main's whenReady callback, before it creates a window.
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
  callback({ cancel: !/^(file:|data:|blob:|devtools:)/.test(details.url) });
}));
const timeout = setTimeout(() => { console.error("install-spaces timed out in isolated profile", isolated); app.exit(1); }, 30000);
const { shutdownNativeResources } = require(path.join(__dirname, "..", "main.js"));
ipcMain.removeHandler("crowe:pty:start");
ipcMain.handle("crowe:pty:start", () => ({ ok: false, error: "Terminal disabled by install-spaces test" }));
// Unrelated workspace/companion discovery is inert; edition, farm and transfer
// handlers remain real. This fixture does not prove git or Settings subprocess behavior.
ipcMain.removeHandler("crowe:git:status");
ipcMain.handle("crowe:git:status", () => ({ repo: false, cwd: path.join(isolated, "workspace") }));
ipcMain.removeHandler("crowe:companion:status");
ipcMain.handle("crowe:companion:status", () => ({ running: false, tailscale: null, devices: [], paired: false }));

// Independent contract table, not resolveEdition(): a resolver bug must not
// rewrite this test's expected answer to match itself.
const id = process.env.CROWE_EDITION || "desktop";
const policies = {
  desktop: { name: "Crowe Logic", allowed: ["chat", "projects"], defaults: ["chat", "projects"], landing: "chat", grow: false },
  developers: { name: "Crowe Logic for Developers", allowed: ["chat", "projects"], defaults: ["chat", "projects"], landing: "chat", grow: false },
  mycology: { name: "Crowe Logic Mycology", allowed: ["farm", "cultivation", "messenger", "chat"], defaults: ["farm", "cultivation", "messenger"], landing: "farm", grow: true },
};
const policy = policies[id];
if (!policy) throw new Error("Unknown test edition");
const requested = Object.hasOwn(process.env, "CROWE_SPACES")
  ? process.env.CROWE_SPACES.split(",").map(s => s.trim()) : policy.defaults;
const bridgedSpaces = policy.allowed.filter(s => s === policy.landing || requested.includes(s));
const expected = ["chat", "projects", "cultivation", "farm", "messenger"].filter(s => bridgedSpaces.includes(s) || (id === "mycology" && s === "messenger"));
const LABEL = `${id} ships its explicit allowed/default spaces and mandatory ${policy.landing} landing`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return;
  failures++;
  console.log(`        ${name}: expected ${e}, got ${a}`);
}

app.whenReady().then(async () => {
  try {
    await sleep(400);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("no window");
    await new Promise((res) => (win.webContents.isLoading() ? win.webContents.once("did-finish-load", res) : res()));
    await sleep(1200); // the rail is wired at load; give the renderer its first frame
    if (id === "mycology") {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        ready = await win.webContents.executeJavaScript('!document.getElementById("launch") && document.body.classList.contains("booted")');
        if (ready) break;
        await sleep(100);
      }
      assert.ok(ready, "Mycology launch veil naturally lifted");
      fs.writeFileSync(path.join(isolated, "mycology-farm-launch.png"), (await win.webContents.capturePage()).toPNG());
    }

    const prefs = win.webContents.getLastWebPreferences();
    check("sandboxed isolated preload", [prefs.sandbox, prefs.contextIsolation, prefs.nodeIntegration], [true, true, false]);
    // Read the real preload and shell in this run's throwaway profile. Never
    // clear storage belonging to an installed app.
    const seen = await win.webContents.executeJavaScript(`(async () => {
      const initialSpace = document.body.dataset.space;
      localStorage.removeItem("crowe-spaces");
      applySpaceProfile();
      const rail = [...document.querySelectorAll('#spaces .seg-btn')]
        .filter((b) => !b.classList.contains("hidden")).map((b) => b.dataset.space);
      // The two places the farm showed through on a narrowed build: the Home
      // card's "growing" row and the grower's line in Deployments.
      await refreshHome();
      const growing = [...document.querySelectorAll("#home-routing .k")].some((k) => k.textContent === "growing");
      await renderLane("deployments");
      const grower = [...document.querySelectorAll("#lane-body .m-id")].some((k) => k.textContent === "crowelm-grower");
      // Settings: the plugin list is drawn from the real manifest over the real
      // IPC, and the Crowe Sense section follows the same profile.
      await renderPlugins();
      const plugins = [...document.querySelectorAll("#cfg-plugins .plug-name")].map((n) => n.firstChild.textContent.trim());
      const senseHidden = document.getElementById("cfg-sense").classList.contains("hidden");
      return { initialSpace, edition: window.crowe.edition, bridged: window.crowe.installSpaces, profile: [...PROFILE], rail,
               stored: localStorage.getItem("crowe-spaces"), growing, grower, plugins, senseHidden };
    })()`);

    // The value crossed main -> argv -> preload intact.
    check("window.crowe.installSpaces", seen.bridged, bridgedSpaces);
    check("edition id", seen.edition.id, id);
    check("edition product", seen.edition.productName, policy.name);
    check("edition allowlist", seen.edition.allowedSpaces, policy.allowed);
    check("edition defaults", seen.edition.defaultSpaces, bridgedSpaces);
    check("edition capabilities", [seen.edition.capabilities.grow, seen.edition.capabilities.farm, seen.edition.capabilities.sense], [policy.grow, policy.grow, policy.grow]);
    check("no implicit legacy grant", seen.edition.legacyAccess, false);
    check("first-run landing", seen.initialSpace, policy.landing);
    const hasCultivation = expected.includes("cultivation");
    check("PROFILE", seen.profile, expected);
    check("visible rail buttons", seen.rail, ["chat", "projects", "cultivation", "messenger", "farm"].filter(s => expected.includes(s)));
    // A build default is the build talking, not a choice anyone made. Writing it
    // would freeze this install's set against every version that adds a space.
    check("stored profile", seen.stored, null);
    // The Home card names the grower through the bridge table whether or not
    // the gateway answered, so this half holds offline in both directions.
    check("home routing shows the grower", seen.growing, hasCultivation);
    // Deployments needs the live catalog. Offline the lane is empty and the
    // check is vacuous, so only the narrowed direction is asserted.
    if (!hasCultivation) check("deployments list the grower", seen.grower, false);
    // Crowe Sense declares only cultivation in plugins.builtin.json, so it is
    // the row that must go; Crowe Skills names chat and projects too, so it is
    // the row that must stay, in both directions.
    check("settings list Crowe Sense", seen.plugins.includes("Crowe Sense"), hasCultivation);
    check("settings list Crowe Skills", seen.plugins.includes("Crowe Skills"), expected.some(s => ["chat", "projects", "cultivation"].includes(s)));
    check("the Crowe Sense section is hidden", seen.senseHidden, !hasCultivation);
    check("isolated userData", app.getPath("userData"), path.join(isolated, "userData"));
    // Bootstrap binds Chromium storage to the same canonical explicit profile.
    check("isolated sessionData", app.getPath("sessionData"), path.join(isolated, "userData"));
    check("isolated home", os.homedir(), path.join(isolated, "home"));
    const farm = await win.webContents.executeJavaScript(`(() => {
      setSpace("farm");
      return { selected: document.body.dataset.space,
        bridge: typeof window.crowe.farm?.request === "function" && typeof window.crowe.farm?.legacyHarvests === "function",
        mounts: document.querySelectorAll("#surface-farm > .farm-compliance").length };
    })()`);
    check("farm bridge methods", farm.bridge, true);
    check("farm respects install profile", farm.selected, expected.includes("farm") ? "farm" : policy.landing);
    check("farm mounts only when enabled", farm.mounts, expected.includes("farm") ? 1 : 0);
    const poisoned = await win.webContents.executeJavaScript(`(() => {
      localStorage.setItem("crowe-spaces", JSON.stringify(["chat", "projects", "cultivation", "farm", "warehouse"]));
      applySpaceProfile(); renderSpacePicker();
      return { profile: [...PROFILE].sort(), picker: [...document.querySelectorAll('#cfg-spaces input[data-space]')].map(b => b.dataset.space).sort(),
        legacy: editionPolicy().legacyAccess, sense: hasEditionCapability("sense") };
    })()`);
    check("saved preferences stay within edition allowlist", poisoned.profile, [...policy.allowed].sort());
    check("picker cannot add another edition's spaces", poisoned.picker, [...policy.allowed].sort());
    check("preferences cannot grant legacy recovery", poisoned.legacy, false);
    check("preferences cannot grant Sense", poisoned.sense, policy.grow);

    const olderProfile = await win.webContents.executeJavaScript(`(() => {
      localStorage.setItem("crowe-spaces", JSON.stringify(["farm", "cultivation"]));
      applySpaceProfile();
      const entry = document.querySelector('#spaces [data-space="messenger"]');
      return { allowed: [...PROFILE], reachable: !!entry && !entry.hidden && !entry.classList.contains("hidden") };
    })()`);
    check("existing profile retains Messenger entry only in Mycology", olderProfile.reachable, id === "mycology");
    check("older preferences cannot broaden edition", olderProfile.allowed.every(s => policy.allowed.includes(s)), true);
    check("no attempted subprocess execution", processAttempts, []);
    console.log(`${failures ? "not ok" : "ok    "}  ${LABEL}`);
  } catch (error) {
    failures++;
    console.log(`not ok  ${LABEL}`);
    console.error("        harness error:", error && error.stack ? error.stack : error);
  } finally {
    // app.exit skips the quit events, so tear the native children down by hand
    // and give them a moment, the same way smoke-shot.js does.
    await shutdownNativeResources();
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    await sleep(250);
    console.log(`isolated profile: ${isolated}`);
    clearTimeout(timeout);
    app.exit(failures ? 1 : 0);
  }
});
