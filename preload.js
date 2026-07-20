// Crowe Logic desktop — preload. Safe, explicit surface for the renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("crowe", {
  // Agentic loop: streams {assistant|tool_call|tool_result|edit_proposal|final|error}.
  agent: {
    run: (messages) => ipcRenderer.invoke("crowe:agent:run", { messages }),
    onEvent: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on("crowe:agent:event", h); return () => ipcRenderer.removeListener("crowe:agent:event", h); },
  },
  chat: (messages) => ipcRenderer.invoke("crowe:chat", { messages }),
  // Approve/reject a proposed file edit.
  edit: { decide: (id, approved) => ipcRenderer.invoke("crowe:edit:decide", { id, approved }) },
  // Real PTY terminal.
  pty: {
    start: (size) => ipcRenderer.invoke("crowe:pty:start", size),
    input: (d) => ipcRenderer.send("crowe:pty:input", d),
    resize: (size) => ipcRenderer.send("crowe:pty:resize", size),
    onData: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on("crowe:pty:data", h); return () => ipcRenderer.removeListener("crowe:pty:data", h); },
  },
  fs: { list: (dir) => ipcRenderer.invoke("crowe:fs:list", dir), read: (p) => ipcRenderer.invoke("crowe:fs:read", p) },
  // Conversation history (persisted on disk in the main process).
  sessions: {
    list: () => ipcRenderer.invoke("crowe:sessions:list"),
    load: (id) => ipcRenderer.invoke("crowe:sessions:load", id),
    new: () => ipcRenderer.invoke("crowe:sessions:new"),
    delete: (id) => ipcRenderer.invoke("crowe:sessions:delete", id),
  },
  onBrowserNavigate: (cb) => { const h = (_e, url) => cb(url); ipcRenderer.on("crowe:browser:navigate", h); return () => ipcRenderer.removeListener("crowe:browser:navigate", h); },
  // Native menu / tray / global-shortcut actions: new-chat, palette, focus-composer, toggle-theme, pane:term|browser|files.
  onMenuAction: (cb) => { const h = (_e, a) => cb(a); ipcRenderer.on("crowe:menu", h); return () => ipcRenderer.removeListener("crowe:menu", h); },
  getConfig: () => ipcRenderer.invoke("crowe:get-config"),
  setConfig: (patch) => ipcRenderer.invoke("crowe:set-config", patch),
});
