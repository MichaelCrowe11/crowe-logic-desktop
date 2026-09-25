#!/usr/bin/env node
// Validates the independently authored customer roster. The historical command
// name is retained, but importing a sibling/company registry is not supported.
//
//   node scripts/sync-agent-registry.js [--check]
//
// Edit rooms/agents.customer.json deliberately, then run rooms:web to refresh
// its browser copy. This script never reads or writes a private roster and
// never derives customer prompts by redacting company instructions.

const fs = require("fs");
const path = require("path");
const { CEILING, validCustomerRoster } = require("../rooms/registry");

const CUSTOMER_PATH = path.join(__dirname, "..", "rooms", "agents.customer.json");

// Compatibility is a deliberate contract, independent of any private file or
// checkout. Existing saved rooms must retain IDs, domains, model overrides and
// authority. A contract change requires explicit review, not a sync side effect.
const CONTRACT = Object.freeze({
  "crowe-logic": ["orchestration", "read_confirm", "gpt-5.5"],
  "crowelm-frontier": ["reasoning", "read_confirm"],
  operator: ["infrastructure", "read_confirm"],
  "compliance-audit": ["compliance", "read_confirm"],
  "commerce-support": ["commerce", "read_only"],
  "product-formulation": ["product", "advisory"],
  "drug-discovery": ["pharma", "advisory"],
  "ai-strategy": ["technology", "advisory"],
  "cultivation-intelligence": ["cultivation", "read_only"],
  "computational-chemist": ["chemistry", "advisory"],
  "extraction-formulation": ["extraction", "advisory"],
  "mycology-research": ["mycology", "advisory"],
  "regulatory-affairs": ["regulatory", "advisory"],
  "facility-design": ["engineering", "advisory"],
  scheduling: ["operations", "read_confirm"],
  sop: ["operations", "read_confirm"],
  revenue: ["operations", "read_only"],
  email: ["operations", "read_confirm"],
  auction: ["operations", "read_only"],
  studio: ["media", "read_only"],
});

// Diagnostics report a fixed rule ID and location, never matched text. This is
// a regression guard, not a claim to detect every possible private fact.
const PRIVACY_RULES = Object.freeze([
  ["person-or-company-context", /\b(?:michael|southwest\s+mushrooms|deepparallel|crowe(?:'s|’s)\s+(?:estate|own|business)|crowe\s+(?:estate|storefronts?|knowledge\s+base|skills\s+corpus|brand\s+canon))\b/i],
  ["company-infrastructure", /\b(?:crowelm-prod|swm-sops|foundry\s+agent\s+gateway|cloudflare\s+unified\s+billing|yellow-block)[a-z0-9-]*/i],
  ["email-address", /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i],
  ["network-or-storage-location", /(?:\b(?:https?|s3|r2|gs):\/\/|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|ai|cloud)\b)/i],
  ["local-or-internal-path", /(?:~[/\\]|\/(?:Users|home|workspace|tmp|var|etc)\/|[a-z]:\\|\b(?:SYSTEM_PROMPT|CLAUDE|MEMORY)\.md\b|\b(?:registry|crowe-agents)\/)/i],
  ["private-business-formula", /(?:1\.135|\bhammer\s*\+\s*175\b|\b17\s+PDFs\b|operating\s+since\s+2005)/i],
]);

function assertCustomerText(text, location = "customer-roster") {
  for (const [rule, pattern] of PRIVACY_RULES) {
    if (pattern.test(text)) throw new Error(`${location}: ${rule}`);
  }
}

function validateCustomerRoster(roster) {
  if (!validCustomerRoster(roster)) throw new Error("rooms/agents.customer.json: customer-schema");
  const ids = Object.keys(CONTRACT);
  if (roster.agents.length !== ids.length) throw new Error("rooms/agents.customer.json: stable-agent-ids");
  for (const agent of roster.agents) {
    const expected = CONTRACT[agent.id];
    if (!expected || agent.domain !== expected[0] || agent.authority !== expected[1] ||
        agent.autonomyCeiling !== CEILING[expected[1]] || agent.roomJoinable !== true ||
        agent.model !== expected[2] ||
        JSON.stringify(agent.tools) !== JSON.stringify(expected[1] === "advisory" ? [] : ["terminal"])) {
      throw new Error("rooms/agents.customer.json: stable-agent-contract");
    }
  }
  assertCustomerText(JSON.stringify(roster), "rooms/agents.customer.json");
  return roster;
}

function readCustomerRoster() {
  let roster;
  try { roster = JSON.parse(fs.readFileSync(CUSTOMER_PATH, "utf8")); }
  catch { throw new Error("rooms/agents.customer.json: unavailable-or-invalid-json"); }
  return validateCustomerRoster(roster);
}

function main(args = process.argv.slice(2)) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error("Only --check is supported. Author rooms/agents.customer.json directly; registry imports are disabled.");
  }
  const roster = readCustomerRoster();
  console.log(`Customer roster validated: ${roster.agents.length} agents. No files changed.`);
}

module.exports = { readCustomerRoster, validateCustomerRoster, assertCustomerText, CONTRACT, CEILING };

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
