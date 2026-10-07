const { app, BrowserWindow, ipcMain } = require("electron");
// Exercise the real windows and IPC without taking focus from an operator's
// running preview or terminal. Rendering and capturePage still run normally.
BrowserWindow.prototype.show = function () {};
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TerminalSessions } = require("../terminal-sessions");
const { EngineTerminalProcess } = require("../engine-terminal-process");
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
    let opened = 0;
    const openShell = async ({ cols, rows, device }) => manager.create(`phone-${++opened}`, state => pty.spawn("/bin/zsh", ["-f"], { cols, rows, cwd: dir, env: { ...process.env, ...bridge.env(state) } }), { cols, rows, cwd: dir, label: `${device.name} shell`, openedBy: device });
    companion = new Companion({ tokenFile: path.join(dir, "companion.token"), loopback: true, port: 0, sessions: manager, openShell, hostName: () => "Test Mac" }); await companion.start(); const phone = companion.addDevice("UI test phone", { terminal: true });
    win = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { preload: path.join(__dirname, "phone-mirror-test-preload.js"), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    ipcMain.handle("mirror-test:request", async (event, route, body) => {
      if (event.sender !== win.webContents || !/^\/(sessions|draft)\//.test(route)) throw new Error("Invalid test request");
      const r = await fetch(`http://127.0.0.1:${companion.port}${route}`, { method: "POST", headers: { Authorization: `Bearer ${phone.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await r.json(); return r.ok ? { ok: true, data } : { error: data.detail, current: data.current, status: r.status };
    });
    await win.loadFile(path.join(__dirname, "fixtures/phone-mirror.html"));
    const js = source => win.webContents.executeJavaScript(source, true);
    // The iPhone recogniser, stood in for: it hears one phrase, as prose.
    await js(`window.Capacitor = { isNativePlatform: () => true, Plugins: { CroweSpeech: (() => { const on = {};
      let sessionId;
      return { addListener: (n, f) => { on[n] = f; return { remove() { if (on[n] === f) delete on[n]; } }; }, requestPermissions: async () => ({ speechRecognition: "granted" }), available: async () => ({ available: true, sessionIds: true }),
        start: async (opts) => { sessionId = opts.sessionId; const id = sessionId; setTimeout(() => on.partialResults?.({ matches: ["Git status."], sessionId: id }), 30); }, stop: async () => { on.listeningState?.({ status: "stopped", sessionId }); } }; })() } }; void 0`);
    await js('void window.crowePhoneMirror.mount(document.getElementById("phone"))');
    await until(() => js('Boolean(document.querySelector("[data-session-row=integration]"))'), "session list");
    assert.equal(await js('document.querySelector("[data-host-name]").textContent'), "Test Mac");
    await js('document.querySelector("[data-session-row=integration]").click()');
    assert.equal(await js('document.querySelector("[data-term]").hidden'), false, "tapping a session does not open the terminal screen");
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
    // New terminal: a shell of the phone's own, sized to the phone, held from
    // the start, with the key bar up and only its owner able to close it.
    await js('document.querySelector("[data-back]").click()');
    await until(() => js('document.querySelector("[data-open]").disabled === false'), "New terminal offered");
    await delay(150);
    const hosts_shot = await win.webContents.capturePage(); fs.writeFileSync(path.join(dir, "phone-hosts.png"), hosts_shot.toPNG());
    await js('document.querySelector("[data-open]").click()');
    await until(() => manager.sessions.has("phone-1") && manager.sessions.get("phone-1").controller !== null, "phone shell opened and held");
    const own = manager.sessions.get("phone-1");
    assert.ok(own.cols < 80 && own.cols >= 20, `phone shell is not sized to the phone: ${own.cols} columns`);
    await until(() => js('document.querySelector("[data-keys]").hidden === false && document.querySelector("[data-close]").hidden === false'), "Crowe keyboard and close for own shell");
    assert.equal(await js('document.querySelector(".xterm-helper-textarea").getAttribute("inputmode")'), "none", "the phone keyboard would rise over the Crowe keyboard");
    // Keys act on release, like the phone's own.
    const tap = key => js(`(() => { const b = document.querySelector('[data-kb-key="${key}"]'); const o = { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 };
      b.dispatchEvent(new PointerEvent("pointerdown", o)); b.dispatchEvent(new PointerEvent("pointerup", o)); })()`);
    for (const ch of "echo kbok") await tap(ch === " " ? "space" : ch);
    await tap("enter");
    await until(async () => (await manager.screenText(own.id)).text.split("\n").filter(l => l.trim() === "kbok").length === 1, "typed on the Crowe keyboard and ran");
    await until(() => js('[...document.querySelectorAll("[data-kb-chip]")].some(b => b.dataset.kbChip === "echo kbok")'), "the command is remembered in the strip");
    await tap("ctrl");
    assert.equal(await js('document.querySelector(\'[data-kb-key="ctrl"]\').getAttribute("aria-pressed")'), "true");
    await tap("c");
    assert.equal(await js('document.querySelector(\'[data-kb-key="ctrl"]\').getAttribute("aria-pressed")'), "false", "Ctrl stays armed after a key");
    // The mic: what was heard shows for review and is typed without return.
    await tap("mic");
    await until(() => js('document.querySelector("[data-kb-heard]")?.textContent === "git status"'), "heard text shown for review, as a command");
    await js('document.querySelector(\'[data-kb-voice="type"]\').click()');
    await until(async () => / git status\s*$/m.test((await manager.screenText(own.id)).text), "spoken command typed into the shell");
    await delay(400);
    assert.doesNotMatch((await manager.screenText(own.id)).text, /not a git repository/, "the spoken command was run without return");
    await tap("intr");
    await tap("mic");
    await until(() => js('document.querySelector("[data-kb-heard]")?.textContent === "git status"'), "second dictation is reviewed");
    await tap("hide");
    assert.equal(await js('Boolean(document.querySelector("[data-kb-heard]"))'), false, "hiding the keyboard discards dictation");
    await until(() => js('window.__croweSpeechOwner === null'), "hidden keyboard releases recognizer");
    await js('document.querySelector("[data-kb-show]").click()');
    assert.equal(await js('localStorage.getItem("crowe-term-history")'), null, "commands must not be persisted");
    console.log("ok Crowe keyboard types, remembers only in memory, arms Ctrl; reviewed mic text never presses return and hiding cancels it");
    await delay(150);
    const own_shot = await win.webContents.capturePage(); fs.writeFileSync(path.join(dir, "phone-shell.png"), own_shot.toPNG());
    await js('document.querySelector("[data-close]").click()');
    await until(() => !manager.sessions.has("phone-1"), "own shell closed from the phone");
    await until(() => js('document.querySelector("[data-hosts]").hidden === false'), "back to sessions after close");
    console.log("ok New terminal opens a phone-sized shell with control, key bar, and owner close");
    // An engine's shell: listed first, watched live, taken over (the engine
    // waits) and handed back by leaving it.
    const eng = manager.create("engine-ui", () => new EngineTerminalProcess({ pty, cols: 100, rows: 30, cwd: dir, env: process.env }), { cols: 100, rows: 30, cwd: dir, label: "tests", openedBy: { id: "run:ui", name: "Test engine", kind: "engine" } });
    await delay(300);
    await js('document.querySelector("[data-refresh]").click()');
    await until(() => js('document.querySelector("[data-session-list] .mirror-session")?.dataset.sessionRow === "engine-ui"'), "engine shell listed first");
    assert.match(await js('document.querySelector("[data-session-row=engine-ui]").textContent'), /Test engine is working here/);
    await js('document.querySelector("[data-session-row=engine-ui]").click()');
    const ran = await manager.exec(eng.id, "run:ui", "printf 'ENGINE_LIVE_%s\\n' ok", { timeoutMs: 5000 });
    assert.equal(ran.exitCode, 0); assert.match(ran.output, /ENGINE_LIVE_ok/);
    await until(() => js('document.querySelector(".xterm-screen").innerText.includes("ENGINE_LIVE_ok")'), "engine work shows live on the phone");
    assert.equal(await js('document.querySelector("[data-control]").textContent'), "Take over");
    await js('document.querySelector("[data-control]").click()');
    await until(() => js('document.querySelector("[data-control]").textContent === "Hand back"'), "phone took the engine shell");
    await assert.rejects(manager.exec(eng.id, "run:ui", "true"), /UI test phone has taken this terminal/);
    await js('document.querySelector("[data-back]").click()');
    await until(() => eng.controller === null, "leaving hands the shell back");
    assert.equal((await manager.exec(eng.id, "run:ui", "true", { timeoutMs: 5000 })).exitCode, 0);
    console.log("ok engine shells are listed, watched live, taken over and handed back");
    companion.setTerminal(phone.id, false);
    await js('document.querySelector("[data-refresh]").click()');
    await until(() => js('document.querySelector("[data-grant]").hidden === false && document.querySelector("[data-open]").disabled'), "grant notice when terminal access is off");
    assert.match(await js('document.querySelector("[data-grant]").textContent'), /Terminal access is off for UI test phone\. On Test Mac/);
    console.log("ok phone names the missing grant and where to give it");
    console.log(`PASS phone UI integration; screenshot ${path.join(dir, "phone-review.png")}`);
    okay = true;
  } catch (error) { console.error(error.stack); }
  finally {
    bridge?.stop(); manager?.closeAll(); await companion?.stop();
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.exit(okay ? 0 : 1);
  }
});
