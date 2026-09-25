'use strict';

// Fresh throwaway profile, real main/preload/renderer, development Electron only.
// Run with node_modules/.bin/electron scripts/test-mycology-messenger-live.js.
// No installed app, real identity, network, assistant, PTY or external processes.
// --keep-open leaves the isolated unauthenticated preview visible after checks.
const keepOpen = process.argv.includes('--keep-open');
const { app, BrowserWindow, session, ipcMain, shell, safeStorage, utilityProcess, dialog, net: electronNet } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-mycology-messenger-')));
const dirs = ['home', 'userData', 'sessionData', 'logs', 'cache', 'workspace', 'temp', 'appData', 'crashDumps', 'downloads', 'documents', 'desktop', 'music', 'pictures', 'videos'];
for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true });
const cleanEnv = { PATH: process.env.PATH || '', LANG: 'en_US.UTF-8', CROWE_EDITION: 'mycology', SHELL: '/bin/sh' };
if (process.env.DISPLAY) cleanEnv.DISPLAY = process.env.DISPLAY;
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, cleanEnv);
os.homedir = () => path.join(root, 'home');
process.env.HOME = process.env.USERPROFILE = os.homedir();
process.env.TMPDIR = process.env.TEMP = process.env.TMP = path.join(root, 'temp');
process.env.XDG_CONFIG_HOME = path.join(root, 'home', '.config');
process.env.XDG_CACHE_HOME = path.join(root, 'cache');
process.env.XDG_DATA_HOME = path.join(root, 'home', '.local', 'share');
for (const name of dirs.filter(name => !['logs', 'workspace'].includes(name))) app.setPath(name, path.join(root, name));
app.setAppLogsPath(path.join(root, 'logs'));
app.commandLine.appendSwitch('user-data-dir', path.join(root, 'userData'));
assert.equal(app.isPackaged, false, 'This test must not run an installed/packaged app');
assert.ok(!app.commandLine.hasSwitch('no-sandbox') && !app.commandLine.hasSwitch('disable-setuid-sandbox'));
process.chdir(path.join(root, 'workspace'));
fs.writeFileSync(path.join(root, 'userData', 'config.json'), JSON.stringify({
  cwd: path.join(root, 'workspace'), onboarded: false, telemetry: false, autonomy: 'readonly',
  mcpServers: {}, plugins: {}, sense: { source: 'off' }, controlPlane: 'off',
}), { mode: 0o600 });
safeStorage.isEncryptionAvailable = () => false;
safeStorage.encryptString = safeStorage.decryptString = () => { throw new Error('No credential storage in Messenger smoke'); };
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
dialog.showSaveDialog = async () => ({ canceled: true });
const processAttempts = [], networkAttempts = [], requests = [], rendererErrors = [];
const denyProcess = name => () => { processAttempts.push(name); throw new Error('Process disabled in Messenger smoke: ' + name); };
const cp = require('node:child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = denyProcess('child_process.' + name);
utilityProcess.fork = denyProcess('utilityProcess.fork');
try { require('node-pty').spawn = denyProcess('node-pty.spawn'); } catch { /* Native module is optional. */ }
const denyNetwork = name => (...args) => { networkAttempts.push({ name, address: typeof args[0] === 'string' ? args[0] : '' }); throw new Error('Network disabled in Messenger smoke: ' + name); };
global.fetch = async (...args) => denyNetwork('fetch')(...args);
for (const name of ['node:http', 'node:https']) { const transport = require(name); transport.request = denyNetwork(name); transport.get = denyNetwork(name); }
require('node:net').Socket.prototype.connect = denyNetwork('socket');
require('node:tls').connect = denyNetwork('tls');
electronNet.request = denyNetwork('electron.net.request');
electronNet.fetch = async (...args) => denyNetwork('electron.net.fetch')(...args);
shell.openExternal = async (...args) => denyNetwork('shell.openExternal')(...args);
function blockSession(s) {
  s.webRequest.onBeforeRequest((details, callback) => {
    const permitted = /^(file:|data:|blob:|devtools:)/.test(details.url);
    if (!permitted) networkAttempts.push({ name: 'chromium', address: details.url });
    callback({ cancel: !permitted });
  });
}
app.on('session-created', blockSession);
app.whenReady().then(() => blockSession(session.defaultSession));
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
});
// Observe actual IPC execution rather than replacing startup/edition/team handlers.
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => register(channel, (event, ...args) => {
  requests.push({ channel, action: channel === 'crowe:team:request' ? args[0] : undefined });
  return handler(event, ...args);
});
let shutdownNativeResources = async () => {}, failures = 0, checks = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, actual, expected) { assert.deepEqual(actual, expected, name); checks++; console.log('ok - ' + name); }
const timeout = setTimeout(() => { console.error('Messenger smoke timeout', root); app.exit(1); }, 45000);
({ shutdownNativeResources } = require('../main'));
async function until(win, expression, label) {
  for (let i = 0; i < 120; i++) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await sleep(100);
  }
  throw new Error('Timed out waiting for ' + label);
}
app.whenReady().then(async () => {
  try {
    for (let i = 0; i < 100 && !BrowserWindow.getAllWindows().length; i++) await sleep(50);
    const win = BrowserWindow.getAllWindows()[0]; assert.ok(win, 'real main window exists');
    await new Promise(resolve => win.webContents.isLoading() ? win.webContents.once('did-finish-load', resolve) : resolve());
    await until(win, 'document.body.classList.contains("booted") && !document.getElementById("launch")', 'natural launch completion');
    const prefs = win.webContents.getLastWebPreferences();
    check('sandboxed actual preload', [prefs.sandbox, prefs.contextIsolation, prefs.nodeIntegration], [true, true, false]);
    check('isolated userData', app.getPath('userData'), path.join(root, 'userData'));
    check('isolated Chromium storage', app.getPath('sessionData'), path.join(root, 'userData'));
    const initial = await win.webContents.executeJavaScript(`(() => ({
      edition: crowe.edition.id, defaultSpaces: crowe.edition.defaultSpaces,
      allowedSpaces: crowe.edition.allowedSpaces, space: document.body.dataset.space,
      profile: [...PROFILE], assistantStarted, panelCount: panels.length,
      workbenchHidden: document.getElementById('workbench').classList.contains('hidden'),
      visible: [...document.querySelectorAll('#spaces .seg-btn')].filter(b => !b.hidden && !b.classList.contains('hidden')).map(b => b.dataset.space),
      messengerMounted: document.querySelectorAll('#surface-messenger .farm-messenger').length,
      teamBridge: typeof crowe.team?.request,
      oldPreference: localStorage.getItem('crowe-spaces')
    }))()`);
    check('fresh Mycology edition', initial.edition, 'mycology');
    check('Messenger belongs to default spaces', initial.defaultSpaces, ['farm', 'cultivation', 'messenger']);
    check('assistant is optional, projects excluded', initial.allowedSpaces, ['farm', 'cultivation', 'messenger', 'chat']);
    check('fresh profile opens farm, not assistant', initial.space, 'farm');
    check('fresh visible rail includes Messenger', initial.visible, ['cultivation', 'messenger', 'farm']);
    check('assistant did not start', initial.assistantStarted, false);
    check('no restored workbench panels', initial.panelCount, 0);
    check('workbench hidden on startup', initial.workbenchHidden, true);
    check('Messenger loads on explicit selection only', initial.messengerMounted, 0);
    check('real team bridge exists', initial.teamBridge, 'function');
    check('fresh profile did not freeze defaults in storage', initial.oldPreference, null);
    check('no initial team request before entry', requests.filter(r => r.channel === 'crowe:team:request').length, 0);
    await win.webContents.executeJavaScript(`document.querySelector('#spaces [data-space="messenger"]').click()`);
    await until(win, `document.querySelector('[data-fm="status"]')?.textContent === 'Messenger unavailable'`, 'unauthenticated Messenger state');
    const messenger = await win.webContents.executeJavaScript(`(() => ({
      space: document.body.dataset.space, roots: document.querySelectorAll('#surface-messenger .farm-messenger').length,
      error: document.querySelector('[data-fm="error"]').textContent,
      sendDisabled: document.querySelector('[data-fm="send"]').disabled,
      newDisabled: document.querySelector('[data-fm="new"]').disabled,
      messages: document.querySelectorAll('.fm-message').length, conversations: document.querySelectorAll('[data-conversation]').length,
      assistantStarted, panelCount: panels.length, workbenchHidden: document.getElementById('workbench').classList.contains('hidden')
    }))()`);
    check('rail click opens real Messenger', messenger.space, 'messenger');
    check('one Messenger mount', messenger.roots, 1);
    assert.match(messenger.error, /Sign in with Crowe ID/); checks++; console.log('ok - real host explains sign-in requirement');
    check('unauthenticated send and new conversation disabled', [messenger.sendDisabled, messenger.newDisabled], [true, true]);
    check('no fabricated staff or messages', [messenger.messages, messenger.conversations], [0, 0]);
    check('Messenger does not start assistant or workbench', [messenger.assistantStarted, messenger.panelCount, messenger.workbenchHidden], [false, 0, true]);
    await sleep(500); // Let Chromium paint the selected surface before capturing evidence.
    const visible = await win.webContents.executeJavaScript(`(() => ({
      messenger: getComputedStyle(document.getElementById('surface-messenger')).display !== 'none' && document.querySelector('.farm-messenger').getClientRects().length > 0,
      farmHidden: getComputedStyle(document.getElementById('surface-farm')).display === 'none',
      bounds: (() => { const b = document.querySelector('.farm-messenger').getBoundingClientRect(); return { width:b.width, height:b.height, top:b.top, left:b.left, right:b.right, bottom:b.bottom }; })(),
      viewport: {width:innerWidth,height:innerHeight}
    }))()`);
    check('Messenger surface actually visible and farm hidden', [visible.messenger, visible.farmHidden], [true, true]);
    check('active Messenger has nonzero on-screen geometry', visible.bounds.width > 500 && visible.bounds.height > 200 && visible.bounds.right > 0 && visible.bounds.left < visible.viewport.width && visible.bounds.bottom > 0 && visible.bounds.top < visible.viewport.height, true);
    const screenshot = path.join(root, 'messenger-unauthenticated.png');
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    console.log('screenshot: ' + screenshot);
    for (const tab of ['hours', 'knowledge']) {
      await win.webContents.executeJavaScript(`document.querySelector('[data-team-tab="${tab}"]').click()`);
      const message = await win.webContents.executeJavaScript(`document.querySelector('[data-team-panel="${tab}"]').textContent`);
      assert.match(message, /Select your shared farm in Messages first/); checks++; console.log('ok - ' + tab + ' requires a selected shared farm');
    }
    await win.webContents.executeJavaScript(`document.querySelector('[data-team-tab="imports"]').click()`);
    const intake = await win.webContents.executeJavaScript(`(() => ({
      warning: document.querySelector('[data-team-panel="imports"]').textContent,
      enter: [...document.querySelectorAll('[data-team-panel="imports"] button')].map(b => b.textContent)
    }))()`);
    assert.match(intake.warning, /Anyone using this desktop profile can read retained originals, including after sign-out/); checks++; console.log('ok - local archive privacy boundary is visible');
    check('archive requires separate explicit entry', intake.enter, ['Open device-local staging archive']);
    check('tab navigation does not access originals', requests.filter(r => r.channel === 'crowe:imports:request'), []);
    await win.webContents.executeJavaScript(`document.querySelector('[data-team-tab="messages"]').click()`);
    await until(win, `document.querySelector('[data-fm="status"]')?.textContent === 'Messenger unavailable'`, 'Messenger returns after team tab navigation');
    const denied = await win.webContents.executeJavaScript(`crowe.team.request('message.send', {requestId:'fixture-offline-message',text:'Never dispatched'})`);
    check('real team host refuses unauthenticated write', denied.error?.code, 'AUTH_REQUIRED');
    await win.webContents.executeJavaScript(`document.querySelector('[data-fm="refresh"]').click()`);
    await until(win, `!document.querySelector('[data-fm="refresh"]').disabled`, 'refresh finishes without identity');
    check('team reads ran through actual IPC', requests.filter(r => r.channel === 'crowe:team:request' && r.action === 'farm.list').length >= 2, true);
    // Simulate an existing user's legitimate old navigation preference, then
    // reload the real renderer. This is not a privileged capability injection.
    await win.webContents.executeJavaScript(`localStorage.setItem('crowe-spaces', JSON.stringify(['farm','cultivation'])); localStorage.setItem('crowe-space','chat');`);
    const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.reload();
    await reloaded;
    await until(win, 'document.body.classList.contains("booted") && !document.getElementById("launch")', 'existing preference reload');
    const restored = await win.webContents.executeJavaScript(`(() => ({
      space: document.body.dataset.space, assistantStarted, panelCount:panels.length,
      reachable: !document.querySelector('#spaces [data-space="messenger"]').hidden,
      profile: [...PROFILE], stored: JSON.parse(localStorage.getItem('crowe-spaces'))
    }))()`);
    check('old profile cannot restore assistant at startup', [restored.space, restored.assistantStarted, restored.panelCount], ['farm', false, 0]);
    check('Messenger remains reachable for existing Mycology profile', restored.reachable, true);
    check('old stored preference gains mandatory Messenger', restored.stored.includes('messenger'), true);
    await win.webContents.executeJavaScript(`document.querySelector('#spaces [data-space="messenger"]').click()`);
    await until(win, `document.querySelector('[data-fm="status"]')?.textContent === 'Messenger unavailable'`, 'Messenger after old-profile reload');
    check('no assistant/PTY/workbench startup IPC', requests.filter(r => /crowe:(?:pty:start|workbench:|chat:send|agent:run|rooms:list|rooms:create|rooms:council-start)/.test(r.channel)), []);
    check('no Node/PTY/utility process attempts', processAttempts, []);
    check('no transport or external-browser calls', networkAttempts, []);
    check('no renderer errors', rendererErrors, []);
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'userData', 'config.json'), 'utf8'));
    check('fresh profile was not forcibly onboarded', cfg.onboarded, false);
    console.log(`mycology-messenger-live: ${checks} checks passed (${process.versions.electron}; Node ${process.version})`);
  } catch (error) { failures++; console.error(error.stack || error); }
  finally {
    clearTimeout(timeout);
    console.log('isolated profile: ' + root);
    if (keepOpen) {
      for (const win of BrowserWindow.getAllWindows()) {
        win.setTitle('Crowe Logic Mycology - isolated offline preview');
        if (win.isMinimized()) win.restore();
        win.show(); win.focus();
        win.once('closed', async () => {
          if (BrowserWindow.getAllWindows().length) return;
          try { await shutdownNativeResources(); } catch (error) { failures++; console.error(error); }
          app.exit(failures ? 1 : 0);
        });
      }
      console.log('Preview stays open for inspection. Synthetic profile; no sign-in, network or real shared farm. Close the window when finished.');
    } else {
      try { await shutdownNativeResources(); } catch (error) { failures++; console.error(error); }
      for (const win of BrowserWindow.getAllWindows()) win.destroy();
      await sleep(250);
      app.exit(failures ? 1 : 0);
    }
  }
});
