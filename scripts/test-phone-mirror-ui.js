const { app, BrowserWindow, ipcMain } = require("electron");
// Exercise the real windows and IPC without taking focus from an operator's
// running preview or terminal. Rendering and capturePage still run normally.
BrowserWindow.prototype.show = function () {};
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TerminalSessions } = require("../terminal-sessions");
const { Companion } = require("../companion");
const { DraftBridge } = require("../draft-bridge");
const { installManagedDraftWindows } = require("../managed-draft-window");
const pty = require("node-pty");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-phone-ui-"));
app.setPath("userData", path.join(dir, "profile"));
let win, manager, companion, bridge;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, description) => { for (let i = 0; i < 80; i++) { if (await fn()) return; await delay(100); } throw new Error(`Timed out: ${description}`); };
app.whenReady().then(async () => {
  let okay = false;
  try {
    manager = new TerminalSessions(); bridge = new DraftBridge(manager); await bridge.start(); installManagedDraftWindows(manager);
    const s = manager.create("integration", state => pty.spawn("/bin/zsh", ["-f"], { cols: 80, rows: 24, cwd: dir, env: { ...process.env, ...bridge.env(state) } }), { cwd: dir, label: "Mirror integration" });
    companion = new Companion({ tokenFile: path.join(dir, "companion.token"), loopback: true, port: 0, sessions: manager }); await companion.start(); const phone = companion.addDevice("UI test phone");
    win = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { preload: path.join(__dirname, "phone-mirror-test-preload.js"), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    ipcMain.handle("mirror-test:request", async (event, route, body) => {
      if (event.sender !== win.webContents || !/^\/(sessions|draft)\//.test(route)) throw new Error("Invalid test request");
      const r = await fetch(`http://127.0.0.1:${companion.port}${route}`, { method: "POST", headers: { Authorization: `Bearer ${phone.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await r.json(); return r.ok ? { ok: true, data } : { error: data.detail, current: data.current, status: r.status };
    });
    await win.loadFile(path.join(__dirname, "fixtures/phone-mirror.html"));
    const js = source => win.webContents.executeJavaScript(source, true);
    await js('void window.crowePhoneMirror.mount(document.getElementById("phone"))');
    await until(() => js('document.querySelector("[data-sessions]").options.length > 1'), "session list");
    await js('document.querySelector("[data-sessions]").value="integration"; document.querySelector("[data-sessions]").dispatchEvent(new Event("change"))');
    manager.localInput(s.id, "printf 'PHONE_MIRROR_NATIVE_OK\\n'\r");
    await until(() => js('document.querySelector(".xterm-screen").innerText.includes("PHONE_MIRROR_NATIVE_OK")'), "real PTY output on phone");
    console.log("ok real PTY appears in phone terminal");
    await js('document.querySelector("[data-control]").click()');
    await until(() => Boolean(s.controller), "phone controller lease");
    manager.localInput(s.id, ""); await until(() => js('document.querySelector("[data-owner]").textContent === "Viewing only"'), "desktop reclaim");
    console.log("ok phone handoff and desktop reclaim");
    const filename = path.join(dir, "draft.md"); fs.writeFileSync(filename, "original draft\n");
    const helper = path.join(__dirname, "../bin/crowe-session-editor.py");
    const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
    manager.localInput(s.id, `python3 ${quote(helper)} ${quote(filename)}\r`);
    await until(() => s.draft?.status === "editing", "CLI broker registration");
    const desktop = BrowserWindow.getAllWindows().find(w => w !== win);
    await until(() => desktop.webContents.executeJavaScript('document.getElementById("draft")?.disabled === false'), "native editor read IPC");
    assert.equal(await desktop.webContents.executeJavaScript('document.getElementById("draft").value'), "original draft\n");
    await js('document.querySelector("[data-view=draft]").click()');
    await until(() => js('document.querySelector("[data-draft]").disabled === false'), "phone draft attached");
    const text = "Review reconnect after phone lock.\nPreserve the exact second line: 東京.\n";
    await js(`document.querySelector('[data-draft]').value=${JSON.stringify(text)}; document.querySelector('[data-draft]').dispatchEvent(new Event('input')); document.querySelector('[data-review]').click()`);
    await delay(150);
    const shot = await win.webContents.capturePage(); fs.writeFileSync(path.join(dir, "phone-review.png"), shot.toPNG());
    await js('document.querySelector("[data-return]").click()');
    await until(() => fs.readFileSync(filename, "utf8") === text, "exact draft return to helper file");
    assert.ok(desktop.isDestroyed());
    console.log("ok native editor and phone share draft; exact multiline return; native editor closes");
    const overflow = await js('document.querySelector(".phone-mirror").scrollWidth > document.querySelector(".phone-mirror").clientWidth');
    assert.equal(overflow, false, "phone content overflows horizontally");
    console.log(`PASS phone UI integration; screenshot ${path.join(dir, "phone-review.png")}`);
    okay = true;
  } catch (error) { console.error(error.stack); }
  finally {
    bridge?.stop(); manager?.closeAll(); await companion?.stop();
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.exit(okay ? 0 : 1);
  }
});
