// Crowe Logic desktop — preload. Exposes a minimal, safe surface to the renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("crowe", {
  // chat({messages, tools}) -> {content, tool_calls, usage, model} | {error}
  chat: (payload) => ipcRenderer.invoke("crowe:chat", payload),
  getConfig: () => ipcRenderer.invoke("crowe:get-config"),
  setConfig: (patch) => ipcRenderer.invoke("crowe:set-config", patch),
});
