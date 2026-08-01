// Dev-only shim: lets renderer/index.html run in a plain browser for design work.
// Stubs window.crowe (the Electron preload bridge) with canned data and a demo
// agent run so the full transcript UI can be exercised without the app.
(function () {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let agentListeners = [];
  /* Every event carries the agent it came from, because the real IPC does:
     main.js stamps `agentId` on the way out and every surface filters on it. A
     shim that emits bare events lets a panel look correct here and receive
     nothing in the product - which is how the Workflows surface shipped.
     Bound per run rather than held in a variable, because a workflow runs its
     nodes concurrently and a shared "current agent" would mislabel every event
     that lands after another node's await. */
  const emitAs = (id) => (ev) => { const e = { agentId: id, ...ev }; agentListeners.forEach((f) => f(e)); };
  const emit = emitAs("main");

  const DEMO_FILES = [
    { name: "assets", dir: true }, { name: "renderer", dir: true }, { name: "deploy", dir: true },
    { name: "harness.js", dir: false }, { name: "main.js", dir: false }, { name: "package.json", dir: false },
  ];

  // Gateway catalog, as crowe:catalog:get returns it: 21 deployments with the
  // flags the Deployments lane renders, plus the resolved role routing the
  // Home surface shows. [model, display, featured, role, available, tools]
  const DEMO_CATALOG = [
    ["crowelm", "CroweLM", true, "", true, true],
    ["crowelm-grower", "CroweLM Grower", true, "cultivation", true, true],
    ["GPT-5.6-Sol", "GPT 5.6 Sol", true, "reasoning", true, true],
    ["GLM-4.7", "GLM 4.7", true, "", true, true],
    ["crowelm-talon", "Crowe Talon", false, "", true, true],
    ["crowelm-mini", "CroweLM Mini", false, "", true, true],
    ["GLM-4.7-Flash", "GLM 4.7 Flash", false, "", true, true],
    ["GLM-4.6V", "GLM 4.6V", false, "", true, false],
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
    // Null is an ordinary install: every space. A test narrows it by assigning
    // here and calling applySpaceProfile(), which is what a packaged build with
    // a croweSpaces key looks like from the renderer's side.
    installSpaces: null,
    agent: {
      onEvent(fn) { agentListeners.push(fn); return () => { agentListeners = agentListeners.filter((f) => f !== fn); }; },
      async run(messages, id) {
        const emit = emitAs(id || "main");
        const last = (messages || []).filter((m) => m.role === "user").pop();
        const asked = (last && last.content) || "";
        // The compose brief gets a compose answer. Without this branch the shim
        // replies to "design a workflow" with the canned coding demo, the parse
        // fails, and the one feature this surface leads with looks broken in
        // the browser - the exact gap that let Workflows ship dead.
        if (/^Design an agent workflow for this operation:/.test(asked)) {
          const want = (asked.match(/operation: ([^\n]*)/) || [, "the operation"])[1].trim();
          emit({ type: "route", expert: "planning", model: "crowelm" });
          await sleep(600);
          emit({ type: "assistant", text: JSON.stringify({
            name: want.split(/\s+/).slice(0, 4).join(" ") || "Composed workflow",
            nodes: [
              { name: "Scope", prompt: `Break "${want}" into the concrete facts, constraints, and inputs an operator would need. Output a short brief.` },
              { name: "Execution Plan", prompt: `Design the fastest complete way to carry out "${want}", with owners and order of operations. Output a numbered plan.` },
              { name: "Risk Check", prompt: `Audit "${want}" for what could go wrong, what cannot be undone, and what to verify afterward. Output a checklist.` },
            ],
          }) });
          emit({ type: "telemetry", promptTokens: 640, completionTokens: 210, cost: 0.0011 });
          return {};
        }
        const grow = /substrate|spawn|mold|fruiting|mycelium|oyster|lion's mane|martha/i.test(asked);
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
        await sleep(600);
        // The gate and the receipt, so both can be reviewed in a browser.
        emit({ type: "approval_request", id: 1, kind: "run_shell", risk: "strict",
          why: "rewrites a remote branch's history",
          detail: "git push --force origin main", expiresInMs: 300000 });
        await sleep(900);
        emit({ type: "verdict", status: "pass", model: "crowelm-fast",
          summary: "The widened pattern blocks .env.local, and the rest of the suite still passes.",
          checks: [
            { name: "npm test", result: "pass", evidence: "46 passing, 0 failing" },
            { name: "re-read harness.js:33", result: "pass", evidence: "return /\\.env(\\.|$)|id_rsa|auth\\.json/.test(p);" },
            { name: "search for other callers of isSecretPath", result: "pass", evidence: "3 call sites, all read-path guards" },
          ] });
        emit({ type: "telemetry", promptTokens: 7340, completionTokens: 604, cost: 0.0219, tps: 46 });
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
    approval: { decide() {} },
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
      async close() { return { ok: true }; },
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
    /* The phone companion. Reported as off and refusing to start: the preview
       runs in a plain browser with no main process to open a socket, and a
       preview that drew a pairing code would be drawing one for a machine that
       is not listening — a QR that fails to pair, with no way to tell why. */
    companion: {
      async status() { return { running: false, host: null, port: 8787, tailscale: null, paired: false }; },
      async start() { return { error: "The companion needs the desktop app; this is the browser preview." }; },
      async stop() { return { running: false }; },
      async rotate() { return { running: false, paired: false }; },
      async devices() { return []; },
      async addDevice() { return { error: "The companion needs the desktop app; this is the browser preview." }; },
      async revokeDevice() { return { error: "The companion is not running." }; },
      async audit() { return []; },
      async pairSvg() { return { error: "The companion is not running." }; },
      onEvent() { return () => {}; },
    },
    // Cultivation records. In-memory rather than canned returns, so the preview
    // exercises add and delete for real — the list is only half the surface.
    grow: {
      _db: {
        blocks: [
          { id: "b1", code: "260722-01", species: "Oyster", strain: "Blue PO", substrate: "Masters mix", count: "40", room: "Fruiting A", spawned: "2026-07-22", stage: "colonizing", notes: "Second run on the new sawdust supplier.", createdAt: Date.now() - 5 * 86400e3 },
          { id: "b2", code: "260718-01", species: "Lion's mane", strain: "H. erinaceus CS", substrate: "Supplemented sawdust", count: "24", room: "Fruiting A", spawned: "2026-07-18", stage: "fruiting", createdAt: Date.now() - 9 * 86400e3 },
        ],
        flushes: [{ id: "f1", block: "260718-01", n: "1", date: "2026-07-26", weight: "18.4", grade: "A", notes: "Clean pins, tight clusters.", createdAt: Date.now() - 86400e3 }],
        contam: [{ id: "c1", block: "260722-01", organism: "Trichoderma", stage: "grain spawn", date: "2026-07-25", action: "discarded", notes: "Two jars from the same PC load.", createdAt: Date.now() - 2 * 86400e3 }],
        env: [{ id: "e1", room: "Fruiting A", date: "2026-07-27", temp: "64", rh: "88", co2: "780", fae: "4/hr", createdAt: Date.now() - 43200e3 }],
        strains: [{ id: "s1", name: "Blue PO", species: "P. ostreatus", source: "in-house isolate", gen: "3", acquired: "2026-03-02", createdAt: Date.now() - 120 * 86400e3 }],
        recipes: [{ id: "r1", name: "Masters mix", base: "Hardwood sawdust", supplement: "Soy hulls 1:1", hydration: "60", process: "Sterilize 2.5h @ 15psi", createdAt: Date.now() - 200 * 86400e3 }],
        log: [{ id: "l1", date: "2026-07-27", subject: "Swapped the HEPA prefilter", entry: "Fruiting A prefilter was loading up faster than the schedule assumes.", createdAt: Date.now() - 86400e3 }],
      },
      async list(type) { return (this._db[type] || []).slice(); },
      // The preview has no OS save dialog, so an export reports as cancelled -
      // the same shape the real bridge returns when the user backs out of it.
      async export() { return { ok: false, canceled: true }; },
      async save(type, record) {
        if (!this._db[type]) return { ok: false, error: "unknown record type" };
        const id = record.id || "p-" + Math.random().toString(36).slice(2, 8);
        const i = this._db[type].findIndex((r) => r.id === id);
        if (i >= 0) this._db[type][i] = { ...this._db[type][i], ...record };
        else this._db[type].push({ ...record, id, createdAt: Date.now() });
        return { ok: true, id };
      },
      async delete(type, id) { if (this._db[type]) this._db[type] = this._db[type].filter((r) => r.id !== id); return { ok: true }; },
    },
    catalog: {
      async get() { return {
        models: DEMO_CATALOG,
        at: Date.now(),
        resolved: {
          cultivation: { model: "crowelm-grower", source: "bridge" },
          coding: { model: "crowelm", source: "default" },
          reasoning: { model: "GPT-5.6-Sol", source: "bridge" },
          "long-context": { model: "crowelm", source: "default" },
        },
        defaultModel: "crowelm",
      }; },
    },
    // These five mirror the preload namespaces of the same name. The panel
    // suite asserts the shim covers every namespace preload exposes, since a
    // missing one throws only at runtime, inside whichever panel touches it.
    operator: {
      async status() { return {
        app: "running", agents: 0, agentIds: [], terminals: 1, terminalIds: ["preview"],
        mcpServers: 1, mcpTools: 11, cwd: "/Users/crowelogic/Projects/crowe-logic-desktop",
        autonomy: "edit", version: "0.13.0", uptime: 42,
      }; },
      async stopAll() { return { ok: true }; },
    },
    license: {
      async status() { return {
        authenticated: true, selectedWorkspaceId: "ws-demo",
        workspaces: [{ id: "ws-demo", name: "Crowe Logic", plan_id: "Managed",
          agents: { allowed: true }, usage: { agent_jobs: 12 } }],
      }; },
      async billing() { return { portalUrl: "" }; },
      async select() { return { ok: true }; },
    },
    update: {
      async check() { return { status: "dev" }; },
      async download() { return { status: "dev" }; },
      async install() { return { ok: true }; },
      async state() { return { status: "dev" }; },
      onChange() { return () => {}; },
    },
    plugins: {
      async list() { return { plugins: [
        { id: "crowe-skills", name: "Crowe Skills", official: true, enabled: true, tools: 6 },
        { id: "github", name: "GitHub", official: true, enabled: false, tools: 9 },
      ] }; },
      async enable() { return { ok: true }; },
      async disable() { return { ok: true }; },
    },
    keys: {
      async list() { return { providers: [
        { id: "openai", label: "OpenAI", configured: false, healthy: false },
        { id: "anthropic", label: "Anthropic", configured: false, healthy: false },
      ] }; },
      async set() { return { ok: true }; },
      async remove() { return { ok: true }; },
      async test() { return { ok: true, healthy: true }; },
    },
    async chat() { return { content: "" }; },
    async getConfig() { return { baseUrl: "https://api.crowelogic.com", hasToken: true, cwd: "/Users/crowelogic/Projects/crowe-logic-desktop", autoApprove: false, autonomy: "edit", approvals: "high-risk", verifier: true, turnBudgetUsd: 2, version: "0.7.0", mcp: [{ name: "filesystem", tools: 11 }], ptyAvailable: false }; },
    async setConfig() { return this.getConfig(); },
    onBrowserNavigate() {}, onMenuAction() {},
  };
})();
