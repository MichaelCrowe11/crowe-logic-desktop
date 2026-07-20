// Crowe Logic desktop — preload. Safe, explicit surface for the renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("crowe", {
  // Agentic loop: streams {assistant|tool_call|tool_result|final|error} events.
  agent: {
    run: (messages) => ipcRenderer.invoke("crowe:agent:run", { messages }),
    onEvent: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on("crowe:agent:event", h);
      return () => ipcRenderer.removeListener("crowe:agent:event", h);
    },
  },
  // Simple one-shot chat (no tools).
  chat: (messages) => ipcRenderer.invoke("crowe:chat", { messages }),
  // Terminal: run a command, get {cwd, output}. Agent shell output also streams here.
  term: {
    run: (command) => ipcRenderer.invoke("crowe:term:run", command),
    cwd: () => ipcRenderer.invoke("crowe:term:cwd"),
    onData: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on("crowe:term:data", h); return () => ipcRenderer.removeListener("crowe:term:data", h); },
    onEcho: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on("crowe:term:echo", h); return () => ipcRenderer.removeListener("crowe:term:echo", h); },
  },
  // Filesystem for the tree/editor.
  fs: {
    list: (dir) => ipcRenderer.invoke("crowe:fs:list", dir),
    read: (p) => ipcRenderer.invoke("crowe:fs:read", p),
    setcwd: (p) => ipcRenderer.invoke("crowe:fs:setcwd", p),
  },
  // Browser pane control (agent open_url pushes here).
  onBrowserNavigate: (cb) => { const h = (_e, url) => cb(url); ipcRenderer.on("crowe:browser:navigate", h); return () => ipcRenderer.removeListener("crowe:browser:navigate", h); },
  getConfig: () => ipcRenderer.invoke("crowe:get-config"),
  setConfig: (patch) => ipcRenderer.invoke("crowe:set-config", patch),
});
