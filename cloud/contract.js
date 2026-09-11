// The control-plane contract: what a hosted plane is asked, and what it answers.
//
// Two calls, and the split between them is the whole design.
//
//   authorize(req)  before the turn. May the tenant run this, on this model,
//                   and with how much left to spend.
//   record(usage)   after it. What it actually cost.
//
// Everything here is pure: shapes, validation, the deterministic usage id and
// the quota arithmetic. No I/O, no clock beyond what is passed in. The local
// stub and the remote client both implement this, and both are held to it by
// the same tests, because the point of a contract nobody can run twice is that
// the stub and the real thing cannot drift.

const crypto = require("crypto");

// The meters a turn reports. Kept small and additive on purpose: a meter that
// can go down is a meter that cannot be summed from an append-only ledger.
const METERS = ["turns", "input_tokens", "output_tokens", "cost_usd", "mutations"];

/* A usage event's identity is derived, never generated.

   This is the load-bearing property of the whole billing path. If the id were
   random, a retry after a timeout we never saw the answer to would be a second
   event and a second charge; the customer is billed twice for one turn and the
   ledger cannot tell which one was real. Derived from the turn and the meter,
   a retry is byte-identical to the original, so the plane can accept it twice
   and store it once. At-least-once delivery plus a derived key is exactly-once
   billing, and it is the only combination that survives a network. */
function usageId(tenantId, turnId, meter) {
  return crypto.createHash("sha256")
    .update(`${String(tenantId)}\u0000${String(turnId)}\u0000${String(meter)}`)
    .digest("hex").slice(0, 32);
}

function newTurnId() { return crypto.randomUUID(); }

function isPlainObject(v) { return Boolean(v) && typeof v === "object" && !Array.isArray(v); }

// Validated rather than trusted. These cross a process boundary in the hosted
// shape, and a malformed usage event that is accepted is a wrong invoice.
function validateUsage(usage) {
  const problems = [];
  if (!isPlainObject(usage)) return ["usage must be an object"];
  if (!usage.tenantId) problems.push("tenantId is required");
  if (!usage.turnId) problems.push("turnId is required");
  if (!isPlainObject(usage.meters)) problems.push("meters must be an object");
  else {
    for (const [k, v] of Object.entries(usage.meters)) {
      if (!METERS.includes(k)) problems.push(`unknown meter "${k}"`);
      else if (typeof v !== "number" || !Number.isFinite(v) || v < 0) problems.push(`meter "${k}" must be a non-negative finite number`);
    }
  }
  return problems;
}

// One usage event fans out into one row per meter, each with its own derived
// id, so a plane can accept them independently and a partial write is still
// correct rather than half a turn.
function usageRows(usage) {
  const rows = [];
  for (const meter of METERS) {
    const value = usage.meters[meter];
    if (typeof value !== "number" || value <= 0) continue;
    rows.push({
      usage_id: usageId(usage.tenantId, usage.turnId, meter),
      tenant_id: usage.tenantId,
      workspace_id: usage.workspaceId || "",
      turn_id: usage.turnId,
      meter,
      value,
      model: usage.model || "",
      plan: usage.plan || "",
      stop: usage.stop || "",
      verdict: usage.verdict || "",
      occurred_at: usage.occurredAt || new Date().toISOString(),
    });
  }
  return rows;
}

/* Quota becomes the turn's spend ceiling rather than a second gate beside it.

   The harness already stops a turn that spends past `turnBudgetUsd`, with a
   journaled reserve and a closing call so the turn ends with an answer instead
   of a stack trace. Re-implementing that against a quota would mean two
   ceilings with two behaviours, and the second one would be worse. So the
   plane's remaining quota is expressed in the units the harness already
   enforces: whichever is smaller wins, and the reason travels with it so the
   operator is told which ceiling they hit.

   A remaining quota of zero is not a ceiling of zero. Zero already means "no
   ceiling" to the harness, so an exhausted quota has to be refused at
   authorize, never passed down as a budget. */
function clampCeiling(configured, remainingUsd) {
  const cfg = Number(configured) || 0;
  if (remainingUsd === null || remainingUsd === undefined) return { ceiling: cfg, source: "config" };
  const remaining = Number(remainingUsd);
  if (!Number.isFinite(remaining) || remaining < 0) return { ceiling: cfg, source: "config" };
  if (cfg === 0) return { ceiling: remaining, source: "quota" };
  return remaining < cfg ? { ceiling: remaining, source: "quota" } : { ceiling: cfg, source: "config" };
}

const DENY = (reason, code = "denied") => ({ allowed: false, code, reason });
const ALLOW = (extra = {}) => ({ allowed: true, code: "ok", reason: "", ...extra });

/* The answer when the plane cannot be reached.

   Two products live in this codebase and they need opposite defaults. The
   desktop is a local agent someone paid for once; a plane outage must not
   brick a laptop on a plane, so it degrades to allowed and says so. A hosted
   or marketplace seat is metered access, and serving it unmetered is giving
   the product away; that one fails closed. `requirePlane` is which product
   this is, and it is the only switch, because a fallback that is decided per
   call is a fallback nobody can reason about. */
function unreachable(requirePlane, detail) {
  return requirePlane
    ? DENY(`the control plane could not be reached: ${detail}`, "unreachable")
    : ALLOW({ degraded: true, reason: `the control plane could not be reached: ${detail}` });
}

module.exports = { METERS, usageId, newTurnId, validateUsage, usageRows, clampCeiling, DENY, ALLOW, unreachable };
