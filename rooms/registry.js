// The room roster: which agents exist, and what each is allowed to be.
//
// Reads rooms/agents.vendored.json, the snapshot of the canonical registry in
// michaelcrowe11/crowe-agents. Plain node, no Electron, no network, so the room
// engine and its tests can load it anywhere.
//
// Room templates are named here rather than in the UI because a template is a
// claim about which specialists belong in a conversation, and that is domain
// knowledge, not layout. Each one is a real disagreement worth having: a
// formulator against a regulator over a SKU, a grower against a facility
// engineer over a room. A template of three interchangeable agents would be a
// model bake-off wearing a product's clothes.

const fs = require("fs");
const path = require("path");

const VENDORED = path.join(__dirname, "agents.vendored.json");

// Ordered weakest to strongest. Rooms take the MINIMUM ceiling across their
// roster, so this order is load-bearing rather than cosmetic.
const TIERS = ["plan", "readonly", "edit", "execute"];
const tierRank = (t) => { const i = TIERS.indexOf(String(t)); return i < 0 ? 0 : i; };

/* The mark each worker wears: one of the eight CLI thinking marks, drawn by
   renderer/marks.js. Named here rather than in the vendored roster because
   which motion suits which colleague is a reading of the worker, not a fact
   the upstream registry records, and the snapshot is regenerated. Chosen so
   no template seats two workers with the same mark (scripts/test-marks.js
   holds that), and by what each motion says: the organism breathes, the
   auditor is an aperture, infrastructure is a gear, orchestration assembles,
   reasoning orbits, a schedule sweeps, a formulation folds, a market blooms.
   A worker missing here still gets a mark: markFor hashes the id into the
   eight, deterministically, so nothing ever shows the house whorl by
   accident. */
const MARKS = {
  "crowe-logic": "coalesce",            // orchestration assembles the pieces
  "crowelm-frontier": "convergent",     // reasoning circles the problem
  operator: "meshwork",                 // infrastructure is machinery
  "compliance-audit": "iris",           // the auditor's aperture
  "commerce-support": "hexbloom",       // the customer reach opens out
  "product-formulation": "facet",       // a formulation folded together
  "drug-discovery": "convergent",       // molecules in orbit
  "ai-strategy": "facet",               // options folded into a plan
  "cultivation-intelligence": "mycelial", // the organism, breathing
  "computational-chemist": "coalesce",  // a model assembled
  "extraction-formulation": "meridian", // a separation is a phase sweep
  "mycology-research": "hexbloom",      // fruiting
  "regulatory-affairs": "iris",         // the rule reads you
  "facility-design": "facet",           // architecture folds
  scheduling: "meridian",               // the week swept end to end
  sop: "coalesce",                      // a procedure assembled step by step
  revenue: "meshwork",                  // what actually earns, ticking over
  email: "convergent",                  // messages that come back round
  auction: "convergent",                // bids converging
  studio: "iris",                       // a camera's aperture
};
const markOf = (id) => MARKS[String(id)] || "";
/* What a worker is called in the app. The upstream registry names its agents
   with the company in front (Crowe Operator, Crowe Studio Director), which is
   right in a catalogue and wrong in a contact list inside an app already
   called Crowe Logic: every row would begin with the same word. The company
   prefix comes off here, once, so the engine, the rail, the thread and the web
   bundle all agree. The orchestrator would be left as "Logic", which reads as
   the app rather than a colleague, so it is named for what it does. CroweLM is
   a product name, not the prefix, and stays. The vendored snapshot is not
   edited: it is regenerated from upstream and this rule survives that. */
const NAMES = { "crowe-logic": "Orchestrator" };
function displayName(a) {
  if (!a) return "";
  if (NAMES[a.id]) return NAMES[a.id];
  const stripped = String(a.name || "").replace(/^Crowe\s+/, "").trim();
  return stripped || String(a.name || a.id || "");
}

let cache = null;
function loadAgents() {
  if (cache) return cache;
  try {
    const d = JSON.parse(fs.readFileSync(VENDORED, "utf8"));
    cache = (Array.isArray(d.agents) ? d.agents : []).map((a) => (a && a.id ? { ...a, name: displayName(a), ...(markOf(a.id) ? { mark: markOf(a.id) } : {}) } : a));
  } catch {
    // A missing snapshot means no rooms, not a crash on boot. The caller shows
    // an empty roster and the rest of the app is untouched.
    cache = [];
  }
  return cache;
}

function listAgents() { return loadAgents().filter((a) => a.roomJoinable !== false); }
function modelAgent(model, name) {
  if (typeof model !== "string" || !/^[a-zA-Z0-9_./:-]{1,120}$/.test(model)) return null;
  const id = "model-" + Array.from(model).map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  return { id, name: name || model, model, domain: "models", role: `Direct conversation with ${model}.`, autonomyCeiling: "edit", roomJoinable: true };
}
function getAgent(id) {
  const found = loadAgents().find((a) => a.id === String(id));
  if (found) return found;
  const encoded = String(id).match(/^model-((?:[0-9a-f]{4}){1,120})$/);
  if (!encoded) return null;
  return modelAgent(encoded[1].match(/.{4}/g).map(c => String.fromCharCode(parseInt(c, 16))).join(""));
}
// roomJoinable is the mechanism for retiring an agent from rooms, so it has to
// be asked at every point that seats one - composition, join, templates - not
// only where the roster is listed. getAgent still returns a retired agent, so a
// room saved before the retirement keeps showing who was in it.
function isJoinable(id) { const a = getAgent(id); return Boolean(a) && a.roomJoinable !== false; }

/* The ceiling a room may run at: the minimum across its roster, never the max.
   Stated as its own function because it is the one rule that must not be
   convenient. A room containing one advisory agent is an advisory room, even
   if the other two could write, because the alternative is that adding a
   cautious participant silently raises everyone else's authority. */
function roomCeiling(agentIds) {
  const agents = (agentIds || []).map(getAgent).filter(Boolean);
  if (!agents.length) return "plan";
  return agents.reduce((low, a) => (tierRank(a.autonomyCeiling) < tierRank(low) ? a.autonomyCeiling : low), "execute");
}

/* The tier a room actually runs at: its own ceiling, further clamped by the
   app's configured autonomy. Both directions matter. The roster can never
   exceed what the operator set globally, and the operator's setting can never
   push an advisory agent into writing. */
function effectiveTier(agentIds, configuredTier) {
  const ceiling = roomCeiling(agentIds);
  const cfg = TIERS.includes(String(configuredTier)) ? String(configuredTier) : "edit";
  return tierRank(cfg) < tierRank(ceiling) ? cfg : ceiling;
}

const writeCapable = (tier) => tierRank(tier) >= tierRank("edit");

/* Templates are domain arguments, not agent counts.

   Each names agents by registry id. An id that no longer exists is dropped at
   compose time rather than throwing, so retiring an agent upstream degrades a
   template instead of breaking room creation. */
const TEMPLATES = [
  {
    id: "product-review",
    name: "Product Review",
    purpose: "A formulation, argued against the rules it has to clear and the customers it has to reach.",
    agents: ["product-formulation", "regulatory-affairs", "commerce-support"],
    defaultAgent: "product-formulation",
  },
  {
    id: "grow-diagnosis",
    name: "Grow Diagnosis",
    purpose: "A room that is underperforming, read by the people who know the organism, the literature, and the building.",
    agents: ["cultivation-intelligence", "mycology-research", "facility-design"],
    defaultAgent: "cultivation-intelligence",
  },
  {
    id: "ship-it",
    name: "Ship It",
    purpose: "A change, checked by the operator who runs the estate and the auditor who has to evidence it.",
    agents: ["operator", "compliance-audit", "crowe-logic"],
    defaultAgent: "operator",
  },
  {
    id: "launch-review",
    name: "Launch Review",
    purpose: "A price, a funnel and an announcement, argued by the three people who each own one of them.",
    agents: ["revenue", "commerce-support", "email"],
    defaultAgent: "revenue",
  },
  {
    id: "security-posture",
    name: "Security Posture",
    purpose: "What the framework demands, against what the estate actually runs.",
    agents: ["compliance-audit", "operator", "crowe-logic"],
    defaultAgent: "compliance-audit",
  },
  {
    id: "molecule-triage",
    name: "Molecule Triage",
    purpose: "Worth pursuing, possible to model, and possible to actually extract. Three different answers.",
    agents: ["drug-discovery", "computational-chemist", "extraction-formulation"],
    defaultAgent: "drug-discovery",
  },
  {
    id: "the-week",
    name: "The Week",
    purpose: "What is booked, what is unanswered, and what actually earns. The three rarely agree.",
    agents: ["scheduling", "email", "revenue"],
    defaultAgent: "scheduling",
  },
  {
    id: "bake-off",
    name: "Bake-off",
    purpose: "One task, three deployments, no domain claim. Useful for comparing models and nothing else.",
    agents: ["crowe-logic", "crowelm-frontier", "operator"],
    defaultAgent: "crowe-logic",
  },
];

// Agents come back resolved rather than as ids: every caller - the composer,
// the room builder, the roster strip - wants the name and domain, and resolving
// once here is what keeps a retired id from reaching any of them.
function listTemplates() {
  return TEMPLATES.map((t) => ({ ...t, agents: t.agents.map(getAgent).filter((a) => a && a.roomJoinable !== false) }))
    .filter((t) => t.agents.length);
}
function getTemplate(id) { return listTemplates().find((t) => t.id === String(id)) || null; }

module.exports = {
  displayName, modelAgent,
  listAgents, getAgent, isJoinable, listTemplates, getTemplate,
  roomCeiling, effectiveTier, writeCapable, tierRank, TIERS,
  MARKS, markOf,
  _resetCache: () => { cache = null; },
};
