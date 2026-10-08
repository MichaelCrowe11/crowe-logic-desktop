const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("croweDraft", {
  read: () => ipcRenderer.invoke("crowe:draft:read"),
  save: (text, done, revision) => ipcRenderer.invoke("crowe:draft:save", text, done, revision),
  close: (text, revision) => ipcRenderer.invoke("crowe:draft:close", text, revision),
  onChanged: fn => ipcRenderer.on("crowe:draft:changed", (_event, value) => fn(value)),
  dirty: dirty => ipcRenderer.invoke("crowe:draft:dirty", dirty),
  onSave: fn => ipcRenderer.on("crowe:draft:save-request", () => fn()),
  onDone: fn => ipcRenderer.on("crowe:draft:done-request", () => fn()),
  onClose: fn => ipcRenderer.on("crowe:draft:close-request", () => fn()),
});
