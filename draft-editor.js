const { app, BrowserWindow, ipcMain, Menu, dialog, session } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { openDocument } = require("./draft-document");

function start() {
  let profile, win, document, resultPath;
  let finishing = false;
  let closing = false;
  const page = path.join(__dirname, "renderer", "draft-editor.html");
  function finish(code, error) {
    finishing = true;
    if (resultPath) {
      try { fs.writeFileSync(resultPath, JSON.stringify({ version: 1, code, error }), { flag: "wx", mode: 0o600 }); }
      catch (writeError) { console.error(writeError.message); code = 1; }
    }
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(code);
  }
  try {
    const index = process.argv.indexOf("--edit-draft");
    if (index < 0 || ![index + 2, index + 4].includes(process.argv.length)) throw new Error("Use --edit-draft /absolute/path/to/file [--edit-result /absolute/result.json].");
    if (process.argv.length === index + 4) {
      if (process.argv[index + 2] !== "--edit-result" || !path.isAbsolute(process.argv[index + 3])) throw new Error("Invalid editor result path.");
      resultPath = process.argv[index + 3];
      if (fs.existsSync(resultPath)) throw new Error("Editor result already exists.");
    }
    document = openDocument(process.argv[index + 1]);
    // An editor invocation owns one file and one process. Separate Chromium
    // storage lets multiple terminals edit without sharing a workspace lock.
    profile = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-draft-window-"));
    app.setPath("userData", profile);
    process.on("exit", () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} });
  } catch (error) { console.error(error.message); finish(1, error.message); return; }

  const trusted = event => win && !win.isDestroyed() && event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === pathToFileURL(page).href;
  function handle(channel, fn) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trusted(event)) throw new Error("Untrusted draft window.");
      try { return await fn(...args); } catch (error) { return { error: error.message }; }
    });
  }
  handle("crowe:draft:read", () => ({ name: document.name, text: document.text }));
  handle("crowe:draft:save", (text, done) => {
    document.save(text);
    win.setDocumentEdited(false);
    if (done === true) setImmediate(() => finish(0));
    return { ok: true };
  });
  handle("crowe:draft:close", async text => {
    if (closing) return { ok: false };
    closing = true;
    try {
      if (!document.changed(text)) { setImmediate(() => finish(0)); return { ok: true }; }
      const { response } = await dialog.showMessageBox(win, {
        type: "question", title: "Return to Crowe Logic CLI",
        message: "Save your draft before returning?",
        detail: "The CLI keeps the original draft if you discard these changes.",
        buttons: ["Save and return", "Keep editing", "Discard changes"],
        defaultId: 0, cancelId: 1, noLink: true,
      });
      if (response === 0) { document.save(text); setImmediate(() => finish(0)); }
      if (response === 2) setImmediate(() => finish(2));
      return { ok: response !== 1 };
    } finally { closing = false; }
  });
  handle("crowe:draft:dirty", dirty => { win.setDocumentEdited(Boolean(dirty)); return { ok: true }; });

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    win = new BrowserWindow({
      title: "Crowe Logic · CLI draft", width: 980, height: 740,
      minWidth: 560, minHeight: 420, backgroundColor: "#0b0e12", show: false,
      webPreferences: { preload: path.join(__dirname, "draft-preload.js"), contextIsolation: true,
        nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: "appMenu" },
      { label: "File", submenu: [
        { label: "Save draft", accelerator: "CmdOrCtrl+S", click: () => win.webContents.send("crowe:draft:save-request") },
        { label: "Save and return", accelerator: "CmdOrCtrl+Return", click: () => win.webContents.send("crowe:draft:done-request") },
        { role: "close" },
      ] },
      { role: "editMenu" }, { role: "windowMenu" },
    ]));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.webContents.on("render-process-gone", () => finish(1, "Crowe Logic draft window closed unexpectedly."));
    win.on("close", event => { if (!finishing) { event.preventDefault(); win.webContents.send("crowe:draft:close-request"); } });
    win.once("ready-to-show", () => { win.show(); win.focus(); app.focus({ steal: true }); });
    win.loadFile(page).catch(error => finish(1, error.message));
  }).catch(error => finish(1, error.message));
  app.on("before-quit", event => { if (!finishing && win) { event.preventDefault(); win.close(); } });
}

module.exports = { start };
