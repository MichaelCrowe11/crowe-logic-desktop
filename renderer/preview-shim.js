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
    ["crowelm-scout", "CroweLM Scout", false, "", true, true],
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

  // GENERATED from rooms/registry.js by scripts/gen-preview.js consumers; the
  // browser composer must offer what the product offers, not a hand-kept subset.
  const DEMO_REGISTRY = [
    {
      "id": "crowe-logic",
      "name": "Crowe Logic",
      "domain": "orchestration",
      "autonomyCeiling": "edit",
      "role": "The orchestrating intelligence of the estate. Plans, dispatches a fleet of workers, verifies adversarially across model families, and synthesizes one result."
    },
    {
      "id": "crowelm-frontier",
      "name": "CroweLM Frontier",
      "domain": "reasoning",
      "autonomyCeiling": "edit",
      "role": "The estate's flagship reasoning tier. Runs on Fable 5 through Cloudflare unified billing with the Crowe Skills corpus and the Crowe knowledge base mounted as tools, grounding every answer in Crowe's own playbooks and data."
    },
    {
      "id": "operator",
      "name": "Crowe Operator",
      "domain": "infrastructure",
      "autonomyCeiling": "edit",
      "role": "Operates and inspects the Crowe estate across cloud, code, and services."
    },
    {
      "id": "compliance-audit",
      "name": "Compliance & Audit",
      "domain": "compliance",
      "autonomyCeiling": "edit",
      "role": "NIST 800-171 / CMMC audits, gap detection, SSP and POA&M evidence."
    },
    {
      "id": "commerce-support",
      "name": "Commerce & Support",
      "domain": "commerce",
      "autonomyCeiling": "readonly",
      "role": "B2B sales, order management, customer support across the Crowe storefronts."
    },
    {
      "id": "product-formulation",
      "name": "Product & Formulation",
      "domain": "product",
      "autonomyCeiling": "plan",
      "role": "Product development and formulation for mushroom-derived products."
    },
    {
      "id": "drug-discovery",
      "name": "Drug Discovery Specialist",
      "domain": "pharma",
      "autonomyCeiling": "plan",
      "role": "Target identification, ADMET, molecular modeling."
    },
    {
      "id": "ai-strategy",
      "name": "AI Strategy Advisor",
      "domain": "technology",
      "autonomyCeiling": "plan",
      "role": "Enterprise AI strategy, LLM and agent architecture."
    },
    {
      "id": "cultivation-intelligence",
      "name": "Cultivation Intelligence",
      "domain": "cultivation",
      "autonomyCeiling": "readonly",
      "role": "Mushroom cultivation, contamination control, grow-room automation."
    },
    {
      "id": "computational-chemist",
      "name": "Computational Chemist",
      "domain": "chemistry",
      "autonomyCeiling": "plan",
      "role": "DFT, molecular dynamics, computer-aided drug design."
    },
    {
      "id": "extraction-formulation",
      "name": "Extraction & Formulation Scientist",
      "domain": "extraction",
      "autonomyCeiling": "plan",
      "role": "CO2 extraction, purification, formulation."
    },
    {
      "id": "mycology-research",
      "name": "Mycology Research Specialist",
      "domain": "mycology",
      "autonomyCeiling": "plan",
      "role": "Fungal biology, bioactive compound discovery."
    },
    {
      "id": "regulatory-affairs",
      "name": "Regulatory Affairs Specialist",
      "domain": "regulatory",
      "autonomyCeiling": "plan",
      "role": "FDA, cGMP, supplement and food compliance."
    },
    {
      "id": "facility-design",
      "name": "Facility Design Engineer",
      "domain": "engineering",
      "autonomyCeiling": "plan",
      "role": "Grow rooms, extraction labs, cleanroom design."
    },
    {
      "id": "scheduling",
      "name": "Scheduling Agent",
      "domain": "operations",
      "autonomyCeiling": "edit",
      "role": "Calendar and Calendly scheduling."
    },
    {
      "id": "sop",
      "name": "SOP Agent",
      "domain": "operations",
      "autonomyCeiling": "edit",
      "role": "Procedure drafting, revision review, and document organization."
    },
    {
      "id": "revenue",
      "name": "Revenue Agent",
      "domain": "operations",
      "autonomyCeiling": "readonly",
      "role": "Revenue and funnel briefing across Stripe and YouTube."
    },
    {
      "id": "email",
      "name": "Email Agent",
      "domain": "operations",
      "autonomyCeiling": "edit",
      "role": "Draft and review email for the user's explicitly configured identity."
    },
    {
      "id": "auction",
      "name": "Auction Agent",
      "domain": "operations",
      "autonomyCeiling": "readonly",
      "role": "Auction valuation and max-bid discipline (read-only)."
    },
    {
      "id": "studio",
      "name": "Crowe Studio Director",
      "domain": "media",
      "autonomyCeiling": "readonly",
      "role": "Grounded script, storyboard, and film direction."
    }
  ];
  const DEMO_TEMPLATES = [
    {
      "id": "product-review",
      "name": "Product Review",
      "purpose": "A formulation, argued against the rules it has to clear and the customers it has to reach.",
      "agents": [
        {
          "id": "product-formulation",
          "name": "Product & Formulation"
        },
        {
          "id": "regulatory-affairs",
          "name": "Regulatory Affairs Specialist"
        },
        {
          "id": "commerce-support",
          "name": "Commerce & Support"
        }
      ],
      "defaultAgent": "product-formulation"
    },
    {
      "id": "grow-diagnosis",
      "name": "Grow Diagnosis",
      "purpose": "A room that is underperforming, read by the people who know the organism, the literature, and the building.",
      "agents": [
        {
          "id": "cultivation-intelligence",
          "name": "Cultivation Intelligence"
        },
        {
          "id": "mycology-research",
          "name": "Mycology Research Specialist"
        },
        {
          "id": "facility-design",
          "name": "Facility Design Engineer"
        }
      ],
      "defaultAgent": "cultivation-intelligence"
    },
    {
      "id": "ship-it",
      "name": "Ship It",
      "purpose": "A change, checked by the operator who runs the estate and the auditor who has to evidence it.",
      "agents": [
        {
          "id": "operator",
          "name": "Crowe Operator"
        },
        {
          "id": "compliance-audit",
          "name": "Compliance & Audit"
        },
        {
          "id": "crowe-logic",
          "name": "Crowe Logic"
        }
      ],
      "defaultAgent": "operator"
    },
    {
      "id": "launch-review",
      "name": "Launch Review",
      "purpose": "A price, a funnel and an announcement, argued by the three people who each own one of them.",
      "agents": [
        {
          "id": "revenue",
          "name": "Revenue Agent"
        },
        {
          "id": "commerce-support",
          "name": "Commerce & Support"
        },
        {
          "id": "email",
          "name": "Email Agent"
        }
      ],
      "defaultAgent": "revenue"
    },
    {
      "id": "security-posture",
      "name": "Security Posture",
      "purpose": "What the framework demands, against what the estate actually runs.",
      "agents": [
        {
          "id": "compliance-audit",
          "name": "Compliance & Audit"
        },
        {
          "id": "operator",
          "name": "Crowe Operator"
        },
        {
          "id": "crowe-logic",
          "name": "Crowe Logic"
        }
      ],
      "defaultAgent": "compliance-audit"
    },
    {
      "id": "molecule-triage",
      "name": "Molecule Triage",
      "purpose": "Worth pursuing, possible to model, and possible to actually extract. Three different answers.",
      "agents": [
        {
          "id": "drug-discovery",
          "name": "Drug Discovery Specialist"
        },
        {
          "id": "computational-chemist",
          "name": "Computational Chemist"
        },
        {
          "id": "extraction-formulation",
          "name": "Extraction & Formulation Scientist"
        }
      ],
      "defaultAgent": "drug-discovery"
    },
    {
      "id": "the-week",
      "name": "The Week",
      "purpose": "What is booked, what is unanswered, and what actually earns. The three rarely agree.",
      "agents": [
        {
          "id": "scheduling",
          "name": "Scheduling Agent"
        },
        {
          "id": "email",
          "name": "Email Agent"
        },
        {
          "id": "revenue",
          "name": "Revenue Agent"
        }
      ],
      "defaultAgent": "scheduling"
    },
    {
      "id": "bake-off",
      "name": "Bake-off",
      "purpose": "One task, three deployments, no domain claim. Useful for comparing models and nothing else.",
      "agents": [
        {
          "id": "crowe-logic",
          "name": "Crowe Logic"
        },
        {
          "id": "crowelm-frontier",
          "name": "CroweLM Frontier"
        },
        {
          "id": "operator",
          "name": "Crowe Operator"
        }
      ],
      "defaultAgent": "crowe-logic"
    }
  ];

  /* The demo room the rooms.* namespace below drives.

     Three specialists over one SKU, which is the argument the Product Review
     template exists to have. The canned answers are authored, not generated -
     the shim has no gateway - but the mechanics around them are the real ones:
     who is addressed decides who answers, a critique hands each agent the
     others' positions and never its own, and every call bills the room. */
  const DEMO_ROOM_AGENTS = [
    { id: "product-formulation", name: "Product & Formulation", domain: "product", autonomyCeiling: "plan" },
    { id: "regulatory-affairs", name: "Regulatory Affairs", domain: "regulatory", autonomyCeiling: "plan" },
    { id: "commerce-support", name: "Commerce & Support", domain: "commerce", autonomyCeiling: "readonly" },
  ];
  const DEMO_SAY = {
    "product-formulation": {
      say: "Two grams of lion's mane extract per serving, marketed for cognitive performance.",
      critique: "Regulatory is reading the rodent work as if it were the label. Commerce is pricing a formulation nobody has costed at volume.",
      revise: "Revised: 500 mg per capsule, two daily. The substantiation point holds and the label drops to structure/function wording.",
    },
    "regulatory-affairs": {
      say: "A cognitive-performance claim needs substantiation on file before the label prints.",
      critique: "Contesting the 2 g cognitive claim: that is disease-adjacent structure/function wording requiring competent and reliable scientific evidence, and the dose exceeds the intake in the cited work.",
      revise: "Position unchanged. The revised dose is defensible; the claim wording still decides whether this ships.",
    },
    "commerce-support": {
      say: "Buyers compare this against a $29 shelf; anything above that needs a story.",
      critique: "The formulation position prices itself out at 2 g per serving, and the regulatory caution under-states what a label rewrite costs in packaging.",
      revise: "Holding: 500 mg lands on the shelf, so the objection is answered rather than argued.",
    },
  };
  const zeroCost = () => ({ usd: 0, promptTokens: 0, completionTokens: 0, calls: 0 });
  let DEMO_ROOM = null;

  function newDemoRoom(ids, title, budgetUsd) {
    const seatIds = ids && ids.length ? ids : DEMO_ROOM_AGENTS.map((a) => a.id);
    return {
      id: "r-demo", title: title || "Product Review", template: "",
      agents: seatIds.map((id) => {
        const meta = DEMO_REGISTRY.find((a) => a.id === id) || { id, name: id, domain: "", autonomyCeiling: "plan" };
        return { agentId: id, name: meta.name, domain: meta.domain, ceiling: meta.autonomyCeiling, model: "", state: "idle", cost: zeroCost() };
      }),
      defaultAgent: seatIds[0], messages: [], brief: "", routines: [], readSeq: 0,
      budgetUsd: typeof budgetUsd === "number" ? budgetUsd : 0.5, spentUsd: 0, critiqueRounds: 0, halted: "",
    };
  }
  // The rail's inbox view, as main.js answers it: seats by name, the last thing
  // said, what is unread, whether anyone is working.
  const demoUnread = () => DEMO_ROOM.messages.filter((m, i) => i >= (DEMO_ROOM.readSeq || 0) && m.author !== ":operator").length;
  const demoPreview = () => { const m = DEMO_ROOM.messages[DEMO_ROOM.messages.length - 1]; return m ? String(m.content || "").slice(0, 120) : ""; };
  const demoRoomSummary = () => ({ id: DEMO_ROOM.id, title: DEMO_ROOM.title, updatedAt: Date.now(),
    template: DEMO_ROOM.template, agents: DEMO_ROOM.agents.map((a) => a.agentId), names: DEMO_ROOM.agents.map((a) => a.name),
    spentUsd: DEMO_ROOM.spentUsd, halted: DEMO_ROOM.halted, unread: demoUnread(), preview: demoPreview(),
    working: DEMO_ROOM.agents.some((a) => a.state === "working" || a.state === "queued"),
    routines: (DEMO_ROOM.routines || []).filter((r) => r.enabled).length, openAsk: DEMO_ROOM.messages.some((m) => m.ask && m.ask.state === "open") });
  const demoRoomState = () => (DEMO_ROOM ? {
    id: DEMO_ROOM.id, title: DEMO_ROOM.title, template: DEMO_ROOM.template,
    agents: DEMO_ROOM.agents, defaultAgent: DEMO_ROOM.defaultAgent,
    tier: "readonly",   // rooms do not write until worktree isolation lands
    budgetUsd: DEMO_ROOM.budgetUsd, spentUsd: DEMO_ROOM.spentUsd,
    critiqueRounds: DEMO_ROOM.critiqueRounds, maxCritiqueRounds: 2, halted: DEMO_ROOM.halted,
    brief: DEMO_ROOM.brief || "", routines: DEMO_ROOM.routines || [], unread: demoUnread(),
  } : null);

  // Who a message is for: @room is everyone, @handle is one, bare is the
  // default agent alone. The same rule the engine applies, so an unaddressed
  // agent visibly costs nothing here too.
  function demoAddress(text) {
    const roster = DEMO_ROOM.agents.map((a) => a.agentId);
    const at = (text.match(/@[A-Za-z0-9][\w.-]*/g) || []).map((m) => m.slice(1).toLowerCase());
    if (at.includes("room")) return roster;
    const hit = roster.filter((id) => at.includes(id) || at.includes(id.replace(/-/g, "")));
    return hit.length ? hit : [DEMO_ROOM.defaultAgent];
  }

  async function demoRound(kind, text) {
    if (!DEMO_ROOM) DEMO_ROOM = newDemoRoom();
    if (kind === "say") DEMO_ROOM.messages.push({ author: ":operator", content: text, kind: "say", at: Date.now() });
    if (kind === "critique") DEMO_ROOM.critiqueRounds += 1;

    const who = kind === "say" ? demoAddress(text) : DEMO_ROOM.agents.map((a) => a.agentId);
    for (const seat of DEMO_ROOM.agents) seat.state = who.includes(seat.agentId) ? "queued" : "idle";
    await sleep(260);

    const ran = [];
    for (const id of who) {
      const seat = DEMO_ROOM.agents.find((a) => a.agentId === id);
      seat.state = "done";
      seat.cost.calls += 1; seat.cost.usd += 0.012;
      seat.cost.promptTokens += 900; seat.cost.completionTokens += 220;
      DEMO_ROOM.spentUsd = DEMO_ROOM.agents.reduce((s, a) => s + a.cost.usd, 0);
      const content = (DEMO_SAY[id] || {})[kind === "say" ? "say" : kind] || `${id} answers.`;
      const msg = { author: id, content, kind: kind === "critique" ? "critique" : "reply", at: Date.now() };
      DEMO_ROOM.messages.push(msg);
      ran.push({ agentId: id, ok: true, text: content, message: msg });
    }
    return { ran, room: demoRoomState() };
  }

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
    // Non-desktop shells use ordinary Desktop navigation, never local farm access.
    installSpaces: null,
    edition: Object.freeze({
      id: "desktop", productName: "Crowe Logic",
      allowedSpaces: Object.freeze(["chat", "projects"]),
      defaultSpaces: Object.freeze(["chat", "projects"]), landingSpace: "chat",
      capabilities: Object.freeze({ grow: false, farm: false, sense: false, legacyAccess: false }),
      legacyAccess: false,
    }),
    editionAccess: {
      async enterLegacy() { return { ok: false, error: { code: "UNAVAILABLE", message: "Legacy farm recovery requires the source desktop installation. No local records are accessed here." } }; },
      async leaveLegacy() { return { ok: false, error: { code: "UNAVAILABLE", message: "Legacy farm recovery is unavailable in this runtime." } }; },
      async openWorkbench() { return { ok: false, error: { code: "UNAVAILABLE", message: "Opening the local desktop workbench is unavailable in this runtime." } }; },
    },
    vision: { async request() { return { ok: false, error: { code: "UNAVAILABLE", message: "Notebook photo inspection requires the Mycology desktop app. No image is read or sent here." } }; } },
    transfer: {
      async request() { return { ok: false, error: { code: "UNAVAILABLE", message: "Notebook and compliance transfers require the local desktop app. No records are imported or exported here." } }; },
    },
    // Preview never creates a second compliance store or simulates a write.
    farm: {
      async request() { return { ok: false, error: { code: "UNAVAILABLE", message: "Farm & Compliance is available in the local desktop app, not this preview. No farm records are stored here." } }; },
      async legacyHarvests() { return { ok: false, error: { code: "UNAVAILABLE", message: "Legacy harvest adoption is available only in the local desktop Farm & Compliance workspace." } }; },
    },
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
    /* Repositories, as crowe:repos:* return them: three remembered folders with
       their git state, and a token that can see four GitHub repositories. One
       default branch is red so the marker has something to draw. Tests swap
       githubStatus and githubRepos for the empty states. */
    repos: {
      async recent() {
        const remote = { host: "github.com", owner: "MichaelCrowe11", name: "crowe-logic-desktop", full: "MichaelCrowe11/crowe-logic-desktop", github: true };
        return [
          { path: "/Users/crowelogic/Projects/crowe-logic-desktop", name: "crowe-logic-desktop", openedAt: Date.now() - 12 * 60e3, exists: true, current: true, repo: true, branch: "main", dirty: 3, remote },
          { path: "/Users/crowelogic/Projects/crowe-logic-foundry", name: "crowe-logic-foundry", openedAt: Date.now() - 26 * 3600e3, exists: true, current: false, repo: true, branch: "feat/control-plane", dirty: 0,
            remote: { host: "github.com", owner: "MichaelCrowe11", name: "crowe-logic-foundry", full: "MichaelCrowe11/crowe-logic-foundry", github: true } },
          { path: "/Users/crowelogic/Notes", name: "Notes", openedAt: Date.now() - 4 * 86400e3, exists: true, current: false, repo: false, branch: "", dirty: 0, remote: null },
        ];
      },
      async open(p) { return { ok: true, cwd: p }; },
      async pick() { return { canceled: true }; },
      async forget() { return { ok: true }; },
      async remote() {
        return { cwd: "/Users/crowelogic/Projects/crowe-logic-desktop", repo: true, branch: "main",
          remote: { host: "github.com", owner: "MichaelCrowe11", name: "crowe-logic-desktop", full: "MichaelCrowe11/crowe-logic-desktop", github: true } };
      },
      async githubStatus() { return { configured: true }; },
      async githubRepos() {
        const row = (owner, name, openPulls, checks, extra = {}) => ({ owner, name, full: `${owner}/${name}`, url: `https://github.com/${owner}/${name}`,
          private: false, archived: false, pushedAt: Date.now() - 3 * 3600e3, openPulls, defaultBranch: "main", checks, localPath: "", ...extra });
        return { configured: true, login: "MichaelCrowe11", total: 4, warning: "", repos: [
          row("MichaelCrowe11", "crowe-logic-desktop", 2, "passed", { localPath: "/Users/crowelogic/Projects/crowe-logic-desktop" }),
          row("MichaelCrowe11", "crowe-logic-foundry", 1, "failed", { private: true, localPath: "/Users/crowelogic/Projects/crowe-logic-foundry", pushedAt: Date.now() - 26 * 3600e3 }),
          row("MichaelCrowe11", "crowe-agents", 0, "none", { pushedAt: Date.now() - 6 * 86400e3 }),
          row("crowe-logic", "crowe-x402", 4, "pending", { pushedAt: Date.now() - 40 * 60e3 }),
        ] };
      },
      async githubWork(owner, name) {
        const full = `${owner}/${name}`;
        return { configured: true, full, url: `https://github.com/${full}`, pullCount: 2, issueCount: 3, warning: "",
          pulls: [
            { kind: "pull", number: 74, title: "Repositories in the sidebar: local checkouts, GitHub repos, PR and issue lanes", url: `https://github.com/${full}/pull/74`, draft: true,
              updatedAt: Date.now() - 20 * 60e3, author: "MichaelCrowe11", head: "feat/repositories-sidebar", base: "main", body: "Local checkouts and GitHub repositories listed in the Projects sidebar." },
            { kind: "pull", number: 72, title: "Linux: read the fuses path from the unpacked AppImage", url: `https://github.com/${full}/pull/72`, draft: false,
              updatedAt: Date.now() - 3 * 86400e3, author: "MichaelCrowe11", head: "fix/linux-fuses-path", base: "main", body: "" },
          ],
          issues: [
            { kind: "issue", number: 61, title: "Terminal panel loses scrollback after a theme switch", url: `https://github.com/${full}/issues/61`, updatedAt: Date.now() - 2 * 3600e3, author: "MichaelCrowe11", labels: ["bug"], body: "Switching Dark to Light while a terminal is open resets its buffer." },
            { kind: "issue", number: 58, title: "Rooms: land agent worktrees one at a time", url: `https://github.com/${full}/issues/58`, updatedAt: Date.now() - 5 * 86400e3, author: "MichaelCrowe11", labels: ["rooms", "gate-4"], body: "" },
            { kind: "issue", number: 49, title: "Deployments lane: show the routed model per role", url: `https://github.com/${full}/issues/49`, updatedAt: Date.now() - 9 * 86400e3, author: "", labels: [], body: "" },
          ] };
      },
      async clone(owner, name) { return { ok: true, cwd: `/Users/crowelogic/Crowe/repos/${owner}/${name}`, cloned: true }; },
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
    // Crowe Sense in the preview: no node, so the card reads "not paired" and
    // the settings fields round-trip in memory.
    sense: {
      _cfg: { source: "off", url: "", node: "", relay: "https://sense.crowelogic.com" },
      async status() { return { config: { ...this._cfg }, health: null, lastPoll: 0, lastError: "", stale: false, running: false }; },
      async configure(patch) { Object.assign(this._cfg, patch || {}); return this.status(); },
      onChange() { return () => {}; },
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
    /* A paying member, matching the license stub above, which answers with a
       real workspace and an allowed entitlement. The preview is what the app
       looks like to somebody who is in, so plan.js draws no Upgrade pill and
       adds nothing to the transcript here. The catalog stub is still real
       enough to price the card for anyone who raises crowe:paywall by hand
       while working on it; prices in it are the preview's own props, not the
       ladder, and this file never reaches a build. */
    billing: {
      async plan() { return { email: "you@crowelogic.com", tier: "pro", known: true, paid: true }; },
      async catalog() {
        return { ladder: [
          { slug: "pro", name: "Crowe Logic Pro", amount: 9900, interval: "month", available: true, contactOnly: false,
            features: ["Everything in Personal", "CroweLM frontier models", "Crowe Nimbus managed cloud", "DeepParallel reasoning engine"] },
          { slug: "scale", name: "Crowe Logic Scale", amount: 24900, interval: "month", available: true, contactOnly: false, features: ["API and compute at scale"] },
          { slug: "studio", name: "Crowe Logic Studio", amount: 29900, interval: "month", available: true, contactOnly: false, features: ["The production surfaces"] },
          { slug: "business", name: "Crowe Logic Business", amount: 49900, interval: "month", available: true, contactOnly: false, features: ["Seats, SSO and support"] },
        ] };
      },
      async checkout() { return { ok: false, error: "The preview does not sell." }; },
      async refresh() { return { ok: true, plan: { email: "you@crowelogic.com", tier: "pro", known: true, paid: true } }; },
    },
    update: {
      async check() { return { status: "dev" }; },
      async download() { return { status: "dev" }; },
      async install() { return { ok: true }; },
      async state() { return { status: "dev" }; },
      onChange() { return () => {}; },
    },
    /* Rooms, as a working demo rather than empty stubs.

       The shim exists so the whole UI can be driven in a browser, and a room
       surface fed empty arrays would look built while proving nothing. This
       runs one Product Review room off the real template roster: addressing
       decides who answers, critique gives each agent the others' positions and
       never its own, revise moves one of them, and every call bills the room
       so the cost strip has something true to show.

       DEMO_ROOM is module state on purpose - a room is a conversation, and one
       that forgot its transcript between calls would not exercise the surface
       that renders it. */
    rooms: {
      async agents() {
        // The whole roster and every template, so the composer in the browser
        // shows what the product actually offers rather than the one argument
        // the demo happens to script.
        return { agents: DEMO_REGISTRY, templates: DEMO_TEMPLATES };
      },
      async list() { return DEMO_ROOM ? [demoRoomSummary()] : []; },
      async create(opts = {}) {
        // Compose from a template or from a hand-picked roster, the same two
        // paths main.js offers. An agent with no scripted answer still speaks:
        // demoRound falls back to a line naming the seat, so a room composed
        // out of any three agents is drivable here.
        const t = opts.template ? DEMO_TEMPLATES.find((x) => x.id === opts.template) : null;
        const ids = t ? t.agents.map((a) => a.id) : (opts.agentIds || []).filter((id) => DEMO_REGISTRY.some((a) => a.id === id));
        if (!ids.length) return { error: "a room needs at least one agent from the registry" };
        DEMO_ROOM = newDemoRoom(ids, opts.title || (t ? t.name : "Room"), opts.budgetUsd);
        return { room: demoRoomState() };
      },
      async load() { if (!DEMO_ROOM) DEMO_ROOM = newDemoRoom(); return { room: demoRoomState(), messages: DEMO_ROOM.messages }; },
      async delete() { DEMO_ROOM = null; return { ok: true }; },
      async join(_id, agentId) {
        if (DEMO_ROOM && !DEMO_ROOM.agents.some((a) => a.agentId === agentId)) {
          const meta = DEMO_ROOM_AGENTS.find((a) => a.id === agentId);
          if (meta) DEMO_ROOM.agents.push({ agentId, name: meta.name, domain: meta.domain, ceiling: meta.autonomyCeiling, model: "", state: "idle", cost: zeroCost() });
        }
        return { room: demoRoomState() };
      },
      async leave(_id, agentId) {
        if (DEMO_ROOM) DEMO_ROOM.agents = DEMO_ROOM.agents.filter((a) => a.agentId !== agentId);
        return { room: demoRoomState() };
      },
      async setAgentModel(_id, agentId, model) {
        const seat = DEMO_ROOM && DEMO_ROOM.agents.find((a) => a.agentId === agentId);
        if (seat) seat.model = String(model || "");
        return { room: demoRoomState() };
      },
      async project(_id, kind) {
        const live = DEMO_ROOM ? DEMO_ROOM.agents.filter((a) => a.state !== "failed").length : 0;
        return { calls: live, agents: live, note: kind === "critique" ? `${live} reviews, each agent over the others' work` : `${live} replies` };
      },
      async say(_id, text) { return demoRound("say", String(text || "")); },
      async critique() { return demoRound("critique"); },
      async revise() { return demoRound("revise"); },
      // The room as a standing colleague: brief and title, the read mark, a tap
      // on an option, a forward, and routines. The preview has no clock, so a
      // routine here runs only when pressed.
      async update(_id, patch = {}) {
        if (!DEMO_ROOM) DEMO_ROOM = newDemoRoom();
        if (patch.title && String(patch.title).trim()) DEMO_ROOM.title = String(patch.title).trim().slice(0, 80);
        if (Object.prototype.hasOwnProperty.call(patch, "brief")) DEMO_ROOM.brief = String(patch.brief || "").slice(0, 4000);
        if (Number.isFinite(Number(patch.budgetUsd)) && Number(patch.budgetUsd) >= 0) DEMO_ROOM.budgetUsd = Number(patch.budgetUsd);
        return { room: demoRoomState(), changed: Object.keys(patch) };
      },
      async markRead() { if (DEMO_ROOM) DEMO_ROOM.readSeq = DEMO_ROOM.messages.length; return { unread: 0 }; },
      async answer(_id, messageId, optionId) {
        const m = DEMO_ROOM && DEMO_ROOM.messages.find((x) => x.id === messageId);
        if (!m || !m.ask) return { error: "that message is not a question" };
        if (m.ask.state !== "open") return { error: "that question was already " + m.ask.state };
        const opt = (m.ask.options || []).find((o) => o.id === optionId);
        if (!opt) return { error: "no such option" };
        m.ask.state = "answered"; m.ask.chosen = opt.id; m.ask.answer = opt.label;
        return demoRound("say", "@" + m.author + " " + opt.label);
      },
      async forward() { return { error: "The preview has one demo room; there is nowhere to forward to." }; },
      async routineAdd(_id, spec = {}) {
        if (!DEMO_ROOM) DEMO_ROOM = newDemoRoom();
        if (!String(spec.text || "").trim()) return { error: "a routine needs the message it will send" };
        const r = { id: "rt-" + Math.random().toString(36).slice(2, 7), agentId: spec.agentId || DEMO_ROOM.defaultAgent, text: String(spec.text).trim(),
          every: spec.every || "daily", at: spec.at || "07:00", minutes: Number(spec.minutes) || 60, weekday: Number(spec.weekday) || 0,
          enabled: true, lastRunAt: 0, lastStatus: "", runs: 0, nextRunAt: Date.now() + 60 * 60 * 1000 };
        DEMO_ROOM.routines.push(r);
        return { routine: r, room: demoRoomState() };
      },
      async routineUpdate(_id, routineId, patch = {}) {
        const r = DEMO_ROOM && DEMO_ROOM.routines.find((x) => x.id === routineId);
        if (!r) return { error: "no such routine" };
        if (Object.prototype.hasOwnProperty.call(patch, "enabled")) r.enabled = Boolean(patch.enabled);
        return { routine: r, room: demoRoomState() };
      },
      async routineRemove(_id, routineId) {
        if (DEMO_ROOM) DEMO_ROOM.routines = DEMO_ROOM.routines.filter((x) => x.id !== routineId);
        return { removed: true, room: demoRoomState() };
      },
      async routineRun(_id, routineId) {
        const r = DEMO_ROOM && DEMO_ROOM.routines.find((x) => x.id === routineId);
        if (!r) return { error: "no such routine" };
        r.lastRunAt = Date.now(); r.runs += 1; r.lastStatus = "ran";
        return demoRound("say", "@" + r.agentId + " " + r.text);
      },
      onChanged() { return () => {}; },
      onOpen() { return () => {}; },
    },

    plugins: {
      // The same shape pluginList() in main.js returns: a bare array, each row
      // carrying the manifest's spaces, which renderPlugins() filters on.
      async list() { return [
        { id: "crowe-skills", name: "Crowe Skills", description: "The Crowe skills corpus.", spaces: ["chat", "projects", "cultivation"], available: true, envPrompts: [], enabled: true, connected: true, toolCount: 6 },
        { id: "crowe-sense", name: "Crowe Sense", description: "Grow-room telemetry and farmlog for the Cultivation space.", spaces: ["cultivation"], available: false, envPrompts: [], enabled: false, connected: false, toolCount: 0 },
        { id: "github", name: "GitHub", description: "Repositories, issues and pull requests.", spaces: ["projects", "chat"], available: true, envPrompts: [], enabled: false, connected: false, toolCount: 0 },
      ]; },
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
    async getConfig() { return { baseUrl: "https://api.crowelogic.com", hasToken: true, cwd: "/Users/crowelogic/Projects/crowe-logic-desktop", autoApprove: false, autonomy: "edit", approvals: "high-risk", verifier: true, turnBudgetUsd: 2, version: "0.7.0", mcp: [{ name: "filesystem", tools: 11 }], ptyAvailable: false, croweBrowser: { url: "https://browser.crowelogic.com" }, croweBrowserAuth: "none" }; },
    async setConfig() { return this.getConfig(); },
    onBrowserNavigate() {}, onMenuAction() {},
  };
})();
