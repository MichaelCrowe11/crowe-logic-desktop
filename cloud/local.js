// The local control plane: the contract, backed by a file instead of a service.
//
// This exists so that entitlement, quota and metering are testable and
// demonstrable before a single Azure resource exists, and so the desktop has
// something real to talk to offline. It is not a billing system and does not
// pretend to be one; it is the same interface the hosted plane exposes, with
// the same refusals and the same idempotency, so code written against it does
// not change when the remote one arrives.
//
// The ledger is append-only and keyed by the derived usage id, which is what
// makes replay safe: writing the same event twice leaves one row, so the
// retrying outbox above it can be as noisy as the network requires.

const fs = require("fs");
const path = require("path");

const { METERS, usageRows, validateUsage, clampCeiling, DENY, ALLOW } = require("./contract");

const DEFAULT_STATE = {
  tenants: {
    // The shape, and the default a fresh install gets: allowed, no quota.
    local: { plan: "local", entitled: true, quotaUsd: 0, models: [] },
  },
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function makeLocalPlane({ dir, requirePlane = false } = {}) {
  const stateFile = path.join(dir, "control-plane.json");
  const ledgerFile = path.join(dir, "usage-ledger.jsonl");

  function state() {
    const raw = readJson(stateFile, null);
    return raw && typeof raw === "object" && raw.tenants ? raw : DEFAULT_STATE;
  }

  // Summed from the ledger rather than kept as a counter. A counter and a log
  // that disagree is a question with no answer; a log that is summed can only
  // be behind, never wrong.
  function spent(tenantId) {
    let total = 0;
    const seen = new Set();
    try {
      for (const line of fs.readFileSync(ledgerFile, "utf8").split("\n")) {
        if (!line) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row.tenant_id !== tenantId || row.meter !== "cost_usd") continue;
        if (seen.has(row.usage_id)) continue;   // a replayed row is still one row
        seen.add(row.usage_id);
        total += Number(row.value) || 0;
      }
    } catch { /* no ledger yet */ }
    return total;
  }

  async function authorize(req) {
    const tenantId = req.tenantId || "local";
    const tenant = state().tenants[tenantId];
    if (!tenant) return DENY(`no entitlement on record for tenant "${tenantId}"`, "no_tenant");
    if (tenant.entitled === false) return DENY(`the entitlement for tenant "${tenantId}" is not active`, "not_entitled");
    // An allowlist, when present, is exhaustive. Absent means the plane has no
    // opinion about models and routing stays the harness's decision.
    if (Array.isArray(tenant.models) && tenant.models.length && req.model && !tenant.models.includes(req.model)) {
      return DENY(`the plan for tenant "${tenantId}" does not include model "${req.model}"`, "model_not_in_plan");
    }
    const quota = Number(tenant.quotaUsd) || 0;
    if (!quota) return ALLOW({ plan: tenant.plan || "local", remainingUsd: null });
    const remaining = quota - spent(tenantId);
    if (remaining <= 0) {
      return DENY(`the $${quota.toFixed(2)} quota for tenant "${tenantId}" is spent`, "quota_exhausted");
    }
    return ALLOW({ plan: tenant.plan || "local", remainingUsd: remaining });
  }

  async function record(usage) {
    const problems = validateUsage(usage);
    if (problems.length) return { ok: false, error: problems.join("; ") };
    const rows = usageRows(usage);
    if (!rows.length) return { ok: true, written: 0 };
    // Read the ids already present and skip them, so the same event recorded
    // twice is one row rather than two. The remote plane does this with a
    // unique index; here it is a set, and the observable behaviour matches.
    const have = new Set();
    try {
      for (const line of fs.readFileSync(ledgerFile, "utf8").split("\n")) {
        if (!line) continue;
        try { have.add(JSON.parse(line).usage_id); } catch {}
      }
    } catch {}
    const fresh = rows.filter((r) => !have.has(r.usage_id));
    if (fresh.length) {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(ledgerFile, fresh.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
    }
    return { ok: true, written: fresh.length, deduped: rows.length - fresh.length };
  }

  function usage(tenantId = "local") {
    const totals = Object.fromEntries(METERS.map((m) => [m, 0]));
    const seen = new Set();
    try {
      for (const line of fs.readFileSync(ledgerFile, "utf8").split("\n")) {
        if (!line) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row.tenant_id !== tenantId || seen.has(row.usage_id)) continue;
        seen.add(row.usage_id);
        if (row.meter in totals) totals[row.meter] += Number(row.value) || 0;
      }
    } catch {}
    return totals;
  }

  return { kind: "local", authorize, record, usage, requirePlane, stateFile, ledgerFile, clampCeiling };
}

module.exports = { makeLocalPlane, DEFAULT_STATE };
