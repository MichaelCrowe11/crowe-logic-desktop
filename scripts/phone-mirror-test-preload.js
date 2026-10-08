const { contextBridge, ipcRenderer } = require("electron");
const storage = new Map();
contextBridge.exposeInMainWorld("croweMirrorTransport", {
  call: (route, body) => ipcRenderer.invoke("mirror-test:request", route, body),
  storage: { get: async key => storage.get(key), set: async (key, value) => { storage.set(key, value); return true; } },
});
