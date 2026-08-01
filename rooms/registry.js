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

let cache = null;
function loadAgents() {
  if (cache) return cache;
  try {
    const d = JSON.parse(fs.readFileSync(VENDORED, "utf8"));
    cache = Array.isArray(d.agents) ? d.agents : [];
  } catch {
    // A missing snapshot means no rooms, not a crash on boot. The caller shows
    // an empty roster and the rest of the app is untouched.
    cache = [];
  }
  return cache;
}

function listAgents() { return loadAgents().filter((a) => a.roomJoinable !== false); }
function getAgent(id) { return loadAgents().find((a) => a.id === String(id)) || null; }

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
  return TEMPLATES.map((t) => ({ ...t, agents: t.agents.map(getAgent).filter(Boolean) }))
    .filter((t) => t.agents.length);
}
function getTemplate(id) { return listTemplates().find((t) => t.id === String(id)) || null; }

module.exports = {
  listAgents, getAgent, listTemplates, getTemplate,
  roomCeiling, effectiveTier, writeCapable, tierRank, TIERS,
  _resetCache: () => { cache = null; },
};
