// Dev-only shim: lets renderer/index.html run in a plain browser for design work.
// Stubs window.crowe (the Electron preload bridge) with canned data and a demo
// agent run so the full transcript UI can be exercised without the app.
(function () {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let agentListeners = [];
  const emit = (ev) => agentListeners.forEach((f) => f(ev));

  const DEMO_FILES = [
    { name: "assets", dir: true }, { name: "renderer", dir: true }, { name: "deploy", dir: true },
    { name: "harness.js", dir: false }, { name: "main.js", dir: false }, { name: "package.json", dir: false },
  ];

  // Gateway catalog, as crowe:catalog:get returns it: 22 deployments with the
  // flags the Deployments lane renders, plus the resolved role routing the
  // Home surface shows. [model, display, featured, role, available, tools]
  const DEMO_CATALOG = [
    ["crowelm", "CroweLM", true, "", true, true],
    ["crowelm-grower", "CroweLM Grower", true, "cultivation", true, true],
    ["Kimi-K2.5", "Kimi K2.5", true, "reasoning", true, true],
    ["GLM-4.7", "GLM 4.7", true, "", true, true],
    ["crowelm-talon", "Crowe Talon", false, "", true, true],
    ["crowelm-mini", "CroweLM Mini", false, "", true, true],
    ["GLM-4.7-Flash", "GLM 4.7 Flash", false, "", true, true],
    ["GLM-4.6V", "GLM 4.6V", false, "", true, false],
    ["Kimi-K2", "Kimi K2", false, "", true, true],
    ["Qwen3-Coder-480B", "Qwen3 Coder 480B", false, "", true, true],
    ["Qwen3-235B-A22B", "Qwen3 235B A22B", false, "", true, true],
    ["Qwen3-VL-72B", "Qwen3 VL 72B", false, "", true, false],
    ["DeepSeek-V3.2", "DeepSeek V3.2", false, "", true, true],
    ["DeepSeek-R1-0528", "DeepSeek R1", false, "", true, false],
    ["Llama-4-Maverick", "Llama 4 Maverick", false, "", true, true],
    ["Llama-3.3-70B", "Llama 3.3 70B", false, "", true, true],
    ["Mistral-Large-3", "Mistral Large 3", false, "", true, true],
    ["gpt-oss-120b", "GPT-OSS 120B", false, "", true, true],
    ["gemma-3-27b", "Gemma 3 27B", false, "", true, true],
    ["crowelm-embed", "CroweLM Embed", false, "", true, false],
    ["whisper-large-v3", "Whisper Large v3", false, "", false, false],
    ["crowelm-guard", "CroweLM Guard", false, "", false, true],
  ].map(([model, display, featured, role, available, gateway_tool_calling]) =>
    ({ model, display, featured, role, available, gateway_tool_calling }));

  // xterm ships from ../node_modules, which http.server rooted at renderer/
  // cannot serve; a text-only stand-in keeps initTerm() alive so the terminal
  // pane still shows its "PTY unavailable" line instead of throwing.
  if (!window.Terminal) {
    window.Terminal = class {
      constructor() { this.cols = 80; this.rows = 24; }
      loadAddon() {}
      open(el) {
        this._pre = document.createElement("pre");
        this._pre.style.cssText = "margin:0;padding:10px 12px;font:12.5px/1.5 'JetBrains Mono',ui-monospace,Menlo,monospace;color:inherit;";
        el.appendChild(this._pre);
      }
      write(s) { if (this._pre) this._pre.textContent += String(s).replace(/\r/g, ""); }
      onData() {}
    };
    window.FitAddon = { FitAddon: class { fit() {} } };
  }

  window.crowe = {
    agent: {
      onEvent(fn) { agentListeners.push(fn); return () => { agentListeners = agentListeners.filter((f) => f !== fn); }; },
      async run(messages) {
        const last = (messages || []).filter((m) => m.role === "user").pop();
        const grow = /substrate|spawn|mold|fruiting|mycelium|oyster|lion's mane|martha/i.test((last && last.content) || "");
        emit(grow ? { type: "route", expert: "cultivation", model: "crowelm-grower" }
                  : { type: "route", expert: "coding", model: "crowelm" });
        emit({ type: "telemetry", promptTokens: 1204, completionTokens: 0, cost: 0.0015 });
        await sleep(500);
        emit({ type: "assistant_delta", text: "Looking at the repo now. I'll check the working tree, then run the test suite and report what fails." });
        await sleep(700);
        emit({ type: "tool_call", name: "run_shell", args: { command: "git status --short" } });
        await sleep(800);
        emit({ type: "tool_result", name: "run_shell", result: " M renderer/styles.css\n M renderer/index.html\n?? renderer/preview-shim.js" });
        emit({ type: "telemetry", promptTokens: 2412, completionTokens: 186, cost: 0.0071, tps: 41 });
        await sleep(500);
        emit({ type: "tool_call", name: "run_shell", args: { command: "npm test" } });
        await sleep(900);
        emit({ type: "tool_result", name: "run_shell", result: "> crowe-logic-desktop@0.5.1 test\n\n  harness\n    system prompt      ok\n    edit_file          ok\n    search             ok\n    secret guard       1 failing\n\n  1) blocks .env.local via search results" });
        emit({ type: "telemetry", promptTokens: 4831, completionTokens: 402, cost: 0.0143, tps: 44 });
        await sleep(600);
        emit({ type: "edit_proposal", id: 1, path: "harness.js", diff: [
          { t: " ", s: "function isSecretPath(p) {" },
          { t: "-", s: "  return /\\.env$|id_rsa|auth\\.json/.test(p);" },
          { t: "+", s: "  return /\\.env(\\.|$)|id_rsa|auth\\.json/.test(p);" },
          { t: " ", s: "}" },
        ] });
        await sleep(900);
        emit({ type: "assistant_delta", text: "\n\nThe secret guard misses `.env.local`: the pattern anchors at `.env` end-of-string. The fix above widens it to any `.env.*` file. One reviewed edit, tests green after." });
        emit({ type: "telemetry", promptTokens: 6120, completionTokens: 512, cost: 0.0182, tps: 46 });
        await sleep(400);
      },
      async stop() {},
    },
    auth: {
      async status() { return { user: { email: "michael@crowelogic.com", tier: "Pro" } }; },
      async login() { return { ok: true }; },
      async logout() { return { ok: true }; },
    },
    edit: { decide() {} },
    git: {
      async status() {
        return { repo: true, branch: "main", files: [
          { index: "M", work: " ", path: "renderer/styles.css", staged: true, untracked: false },
          { index: " ", work: "M", path: "renderer/index.html", staged: false, untracked: false },
          { index: "?", work: "?", path: "renderer/preview-shim.js", staged: false, untracked: true },
        ] };
      },
      async diff() { return "@@ -1,4 +1,4 @@\n-  --gold: #b7791f;\n+  --gold: #c49a3c;\n   --blue: #0054b2;"; },
      async stage() { return { ok: true }; }, async unstage() { return { ok: true }; }, async commit() { return { ok: true, out: "ok" }; },
    },
    pty: {
      async start() { return { ok: false, error: "preview" }; },
      onData() {}, input() {}, resize() {},
    },
    fs: {
      async list(dir) { return { cwd: dir || "/Users/crowelogic/Projects/crowe-logic-desktop", entries: DEMO_FILES }; },
      async read() { return { content: "// preview" }; },
    },
    sessions: {
      async list() { return [
        { id: "a", title: "Fix the secret guard regression", updatedAt: Date.now() - 3600e3, current: true },
        { id: "b", title: "Route cultivation questions to the grower", updatedAt: Date.now() - 5 * 3600e3, current: false },
        { id: "c", title: "Wire the catalog into per-turn routing", updatedAt: Date.now() - 86400e3, current: false },
        { id: "d", title: "Design the four-space shell", updatedAt: Date.now() - 3 * 86400e3, current: false },
      ]; },
      async load() { return { messages: [] }; }, async new() { return { id: "x" }; }, async delete() { return { ok: true }; },
    },
    catalog: {
      async get() { return {
        models: DEMO_CATALOG,
        at: Date.now(),
        resolved: {
          cultivation: { model: "crowelm-grower", source: "bridge" },
          coding: { model: "crowelm", source: "default" },
          reasoning: { model: "Kimi-K2.5", source: "bridge" },
          "long-context": { model: "crowelm", source: "default" },
        },
        defaultModel: "crowelm",
      }; },
    },
    async chat() { return { content: "" }; },
    async getConfig() { return { baseUrl: "https://api.crowelogic.com", hasToken: true, cwd: "/Users/crowelogic/Projects/crowe-logic-desktop", autoApprove: false, autonomy: "edit", version: "0.7.0", mcp: [{ name: "filesystem", tools: 11 }], ptyAvailable: false }; },
    async setConfig() { return this.getConfig(); },
    onBrowserNavigate() {}, onMenuAction() {},
  };
})();
