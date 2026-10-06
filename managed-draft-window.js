const { BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

function installManagedDraftWindows(sessions, registerHandler = ipcMain.handle.bind(ipcMain)) {
  const page = path.join(__dirname, "renderer", "draft-editor.html");
  const windows = new Map();
  const change = (w, action, revision, text) => sessions.changeDraft(w.sessionId, w.draftId,
    { action, baseRevision: revision, text, operationId: crypto.randomUUID() }, true);
  function handle(channel, fn) {
    registerHandler(channel, async (event, ...args) => {
      const w = windows.get(event.sender.id);
      if (!w || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== pathToFileURL(page).href) throw new Error("Untrusted draft window.");
      try { return await fn(w, ...args); } catch (error) { return { error: error.message, current: error.current }; }
    });
  }
  handle("crowe:draft:read", w => ({ name: `${sessions.get(w.sessionId).label} · shared CLI draft`, ...sessions.draft(w.sessionId, w.draftId) }));
  handle("crowe:draft:save", (w, text, done, revision) => {
    const result = change(w, "save", revision, text);
    if (done) change(w, "return", result.revision);
    return { ok: true, revision: result.revision };
  });
  handle("crowe:draft:dirty", (w, dirty) => {
    const s = sessions.get(w.sessionId); if (s.draft?.id === w.draftId) s.draft.desktopDirty = Boolean(dirty);
    w.win.setDocumentEdited(Boolean(dirty)); return { ok: true };
  });
  handle("crowe:draft:close", async (w, text, revision) => {
    if (w.closing) return { ok: false }; w.closing = true;
    try {
      const current = sessions.draft(w.sessionId, w.draftId);
      const { response } = await dialog.showMessageBox(w.win, { type: "question", message: "Return this draft to its CLI session?",
        buttons: ["Save and return", "Keep editing", "Discard changes"], defaultId: 0, cancelId: 1, noLink: true });
      if (response === 0) { const saved = change(w, "save", revision, text); change(w, "return", saved.revision); }
      if (response === 2) change(w, "discard", current.revision);
      return { ok: response !== 1 };
    } finally { w.closing = false; }
  });
  sessions.on("draft-open", ({ session, draft }) => {
    const win = new BrowserWindow({ title: "Crowe Logic · Shared CLI draft", width: 980, height: 740, minWidth: 560, minHeight: 420,
      backgroundColor: "#0b0e12", show: false,
      webPreferences: { preload: path.join(__dirname, "draft-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
    const w = { win, sessionId: session.id, draftId: draft.id }; windows.set(win.webContents.id, w);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.webContents.on("render-process-gone", () => {
      try { sessions.cancelDraft(w.sessionId, w.draftId); } catch {}
      if (!win.isDestroyed()) win.destroy();
    });
    win.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && (input.meta || input.control) && ["s", "Enter"].includes(input.key)) {
        event.preventDefault(); win.webContents.send(input.key === "s" ? "crowe:draft:save-request" : "crowe:draft:done-request");
      }
    });
    win.on("close", event => { if (!w.finished) { event.preventDefault(); win.webContents.send("crowe:draft:close-request"); } });
    const webContentsId = win.webContents.id;
    win.on("closed", () => { windows.delete(webContentsId); if (!w.finished) { try { sessions.cancelDraft(w.sessionId, w.draftId); } catch {} } });
    win.once("ready-to-show", () => win.show());
    win.loadFile(page).catch(() => { sessions.cancelDraft(w.sessionId, w.draftId); });
  });
  sessions.on("draft-change", ({ sessionId, draft, local }) => {
    for (const w of windows.values()) if (w.sessionId === sessionId && w.draftId === draft.id) {
      if (draft.status !== "editing") { w.finished = true; setImmediate(() => { if (!w.win.isDestroyed()) w.win.destroy(); }); }
      else if (!local) w.win.webContents.send("crowe:draft:changed", draft);
    }
  });
  sessions.on("removed", ({ id }) => { for (const w of windows.values()) if (w.sessionId === id) { w.finished = true; w.win.destroy(); } });
}
module.exports = { installManagedDraftWindows };
