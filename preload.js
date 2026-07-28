// Crowe Logic desktop — preload. Safe, explicit surface for the renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("crowe", {
  // Agentic loop: streams {assistant|tool_call|tool_result|edit_proposal|final|error}.
  agent: {
    run: (messages, id = "main", options = {}) => ipcRenderer.invoke("crowe:agent:run", { messages, id, ...options }),
    stop: (id = "main") => ipcRenderer.invoke("crowe:agent:stop", { id }),
    stopAll: () => ipcRenderer.invoke("crowe:agent:stop-all"),
    onEvent: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on("crowe:agent:event", h); return () => ipcRenderer.removeListener("crowe:agent:event", h); },
  },
  chat: (messages) => ipcRenderer.invoke("crowe:chat", { messages }),
  // Crowe ID sign-in (OAuth2 PKCE, browser-based).
  auth: {
    login: () => ipcRenderer.invoke("crowe:auth:login"),
    logout: () => ipcRenderer.invoke("crowe:auth:logout"),
    status: () => ipcRenderer.invoke("crowe:auth:status"),
  },
  license: {
    status: () => ipcRenderer.invoke("crowe:license:status"),
    billing: () => ipcRenderer.invoke("crowe:license:billing"),
    select: (workspaceId) => ipcRenderer.invoke("crowe:license:select", { workspaceId }),
  },
  // Approve/reject a proposed file edit.
  edit: { decide: (id, approved) => ipcRenderer.invoke("crowe:edit:decide", { id, approved }) },
  // Real PTY terminal.
  pty: {
    start: (size) => ipcRenderer.invoke("crowe:pty:start", size),
    input: (id, data) => ipcRenderer.send("crowe:pty:input", { id, data }),
    resize: (size) => ipcRenderer.send("crowe:pty:resize", size),
    close: (id) => ipcRenderer.invoke("crowe:pty:close", { id }),
    onData: (cb) => { const h = (_e, payload) => cb(payload); ipcRenderer.on("crowe:pty:data", h); return () => ipcRenderer.removeListener("crowe:pty:data", h); },
  },
  fs: {
    list: (dir) => ipcRenderer.invoke("crowe:fs:list", dir),
    read: (p) => ipcRenderer.invoke("crowe:fs:read", p),
    walk: () => ipcRenderer.invoke("crowe:fs:walk"),
    pick: () => ipcRenderer.invoke("crowe:files:pick"),
    readContext: (paths) => ipcRenderer.invoke("crowe:files:read-context", paths),
  },
  // Version control (git, run in the workspace).
  git: {
    status: () => ipcRenderer.invoke("crowe:git:status"),
    diff: (path, staged) => ipcRenderer.invoke("crowe:git:diff", { path, staged }),
    stage: (path) => ipcRenderer.invoke("crowe:git:stage", { path }),
    unstage: (path) => ipcRenderer.invoke("crowe:git:unstage", { path }),
    commit: (message) => ipcRenderer.invoke("crowe:git:commit", { message }),
    log: () => ipcRenderer.invoke("crowe:git:log"),
    branches: () => ipcRenderer.invoke("crowe:git:branches"),
    checkout: (branch) => ipcRenderer.invoke("crowe:git:checkout", { branch }),
    pull: () => ipcRenderer.invoke("crowe:git:pull"),
    push: () => ipcRenderer.invoke("crowe:git:push"),
  },
  // Conversation history (persisted on disk in the main process).
  sessions: {
    list: () => ipcRenderer.invoke("crowe:sessions:list"),
    load: (id) => ipcRenderer.invoke("crowe:sessions:load", id),
    new: () => ipcRenderer.invoke("crowe:sessions:new"),
    delete: (id) => ipcRenderer.invoke("crowe:sessions:delete", id),
  },
  // Cultivation records — blocks, flushes, contamination, environment, strains,
  // recipes, grow log. Persisted on disk in the main process, like sessions.
  grow: {
    list: (type) => ipcRenderer.invoke("crowe:grow:list", { type }),
    save: (type, record) => ipcRenderer.invoke("crowe:grow:save", { type, record }),
    delete: (type, id) => ipcRenderer.invoke("crowe:grow:delete", { type, id }),
  },
  onBrowserNavigate: (cb) => { const h = (_e, url) => cb(url); ipcRenderer.on("crowe:browser:navigate", h); return () => ipcRenderer.removeListener("crowe:browser:navigate", h); },
  // Native menu / tray / global-shortcut actions: new-chat, palette, focus-composer, toggle-theme, pane:term|browser|files.
  onMenuAction: (cb) => { const h = (_e, a) => cb(a); ipcRenderer.on("crowe:menu", h); return () => ipcRenderer.removeListener("crowe:menu", h); },
  // Model catalog (cached in main; drives the router and the Home surface).
  catalog: { get: () => ipcRenderer.invoke("crowe:catalog:get") },
  // Auto-update (packaged builds only; downloads are user-consented).
  update: {
    check: () => ipcRenderer.invoke("crowe:update:check"),
    download: () => ipcRenderer.invoke("crowe:update:download"),
    install: () => ipcRenderer.invoke("crowe:update:install"),
    state: () => ipcRenderer.invoke("crowe:update:state"),
    onChange: (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on("crowe:update", h); return () => ipcRenderer.removeListener("crowe:update", h); },
  },
  // Official plugins (bundled manifest, Phase 1).
  plugins: {
    list: () => ipcRenderer.invoke("crowe:plugins:list"),
    enable: (id, env) => ipcRenderer.invoke("crowe:plugins:enable", { id, env }),
    disable: (id) => ipcRenderer.invoke("crowe:plugins:disable", { id }),
  },
  keys: {
    list: () => ipcRenderer.invoke("crowe:keys:list"),
    set: (provider, key) => ipcRenderer.invoke("crowe:keys:set", { provider, key }),
    remove: (provider) => ipcRenderer.invoke("crowe:keys:remove", { provider }),
    test: (provider) => ipcRenderer.invoke("crowe:keys:test", { provider }),
  },
  operator: {
    status: () => ipcRenderer.invoke("crowe:operator:status"),
    stopAll: () => ipcRenderer.invoke("crowe:operator:stop-all"),
  },
  getConfig: () => ipcRenderer.invoke("crowe:get-config"),
  setConfig: (patch) => ipcRenderer.invoke("crowe:set-config", patch),
});
