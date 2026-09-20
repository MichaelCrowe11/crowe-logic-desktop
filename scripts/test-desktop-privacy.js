// Real renderer -> preload -> IPC -> persisted settings and crashReporter.
// Only network calls are stubbed. No member credentials or live services.
const { app, BrowserWindow, crashReporter } = require('electron');
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const root = path.join(__dirname, '..');
const proofRoot = path.join(root, '.council-test');
fs.mkdirSync(proofRoot, { recursive: true });
const proof = fs.mkdtempSync(path.join(proofRoot, 'desktop-privacy-'));
const home = path.join(proof, 'home');
const profile = path.join(proof, 'profile');
fs.mkdirSync(home); fs.mkdirSync(profile);
process.env.HOME = home;
// Prevent legacy sign-in migration from looking in the operator's home.
os.homedir = () => home;
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.commandLine.appendSwitch('use-mock-keychain');
const requests = [];
global.fetch = async (url, init = {}) => {
  requests.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
  return new Response(JSON.stringify({ models: [] }), { headers: { 'Content-Type': 'application/json' } });
};
const { shutdownNativeResources } = require('../main');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const timer = setTimeout(() => { console.error('FAIL privacy test timed out'); shutdownNativeResources(); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  let code = 0;
  try {
    const win = BrowserWindow.getAllWindows()[0];
    assert(win, 'app opens a window');
    if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await sleep(1200);
    const js = async code => { try { return await win.webContents.executeJavaScript(code); } catch (error) { throw new Error(code + ": " + error.message); } };
    assert.equal((await js('window.crowe.auth.status()')).user, null, 'fresh profile has no member session');
    assert(await js('document.querySelector(".onboarding-actions") !== null'), 'fresh onboarding is shown');
    assert(await js(`[...document.querySelectorAll('.said a')].some(a => a.href === 'https://crowelogic.com/privacy')`), 'onboarding links privacy');
    assert(requests.some(r => r.body?.event === 'app_launch'), 'default-on launch event is observed');
    assert.equal(crashReporter.getUploadToServer(), true, 'initial native crash upload state');
    await js('document.getElementById("settings-btn").click()');
    await sleep(300);
    assert(await js('!document.getElementById("cfg-privacy").classList.contains("hidden")'), 'desktop privacy setting is exposed');
    assert(await js('document.getElementById("cfg-telemetry").checked'), 'switch shows the stored value');
    await js('document.getElementById("cfg-telemetry").click(); document.getElementById("cfg-save").click()');
    await sleep(300);
    assert.equal((await js('window.crowe.getConfig()')).telemetry, false, 'renderer saves through IPC');
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'config.json'))).telemetry, false, 'opt-out persists');
    assert.equal(crashReporter.getUploadToServer(), false, 'native crash uploads stop without restart');
    const count = requests.filter(r => r.url.includes('/api/telemetry/')).length;
    process.emit('uncaughtException', new Error('privacy-fixture-must-not-leave'));
    await sleep(30);
    assert.equal(requests.filter(r => r.url.includes('/api/telemetry/')).length, count, 'no exception event while opted out');
    await js('document.getElementById("settings-btn").click()');
    await sleep(200);
    assert.equal(await js('document.getElementById("cfg-telemetry").checked'), false, 'reopening settings retains the opt-out');
    await js('document.getElementById("cfg-privacy").scrollIntoView()');
    fs.writeFileSync(path.join(proof, 'settings.png'), (await win.webContents.capturePage()).toPNG());
    await js('document.getElementById("cfg-telemetry").click(); document.getElementById("cfg-save").click()');
    await sleep(200);
    assert.equal(crashReporter.getUploadToServer(), true, 'explicit re-enable reaches native crash reporting');
    process.emit('uncaughtException', new Error('privacy-fixture-must-not-leave'));
    await sleep(30);
    const event = requests.findLast(r => r.body?.event === 'main_exception');
    assert(event, 'exception occurrence can be counted');
    assert.deepEqual(event.body.props, {}, 'exception text is not uploaded');
    assert(!JSON.stringify(requests).includes('privacy-fixture-must-not-leave'), 'raw error stays local');
    console.log('PASS desktop privacy: fresh onboarding, live switch, persistence, immediate crash opt-out, no raw exception text');
    console.log('Screenshot: ' + path.join(proof, 'settings.png'));
  } catch (error) {
    code = 1; console.error('FAIL ' + error.message);
  } finally {
    clearTimeout(timer); shutdownNativeResources(); app.exit(code);
  }
});
