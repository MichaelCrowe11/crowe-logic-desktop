// The store interface, in memory.
//
// Not a mock. This is the reference implementation of what the Postgres store
// has to do, and both are driven by the same assertions in
// scripts/test-control-plane.js. Where the two could differ is precisely where
// the bugs would live, so the tests refuse to let them.
//
// It also means the whole decision surface runs in CI with no database, which
// is what keeps the billing path covered on every commit rather than only when
// someone remembers to start a server.

function makeMemoryStore({ tenants = {} } = {}) {
  const rows = new Map();            // usage_id -> row
  const events = new Map();          // event_id -> event
  const tenantRows = new Map();

  for (const [id, t] of Object.entries(tenants)) {
    tenantRows.set(id, {
      tenant_id: id, plan: "free", entitled: false, quota_usd: 0, allowed_models: [],
      quota_period_start: new Date(0).toISOString(), ...t,
    });
  }

  async function getTenant(tenantId) {
    return tenantRows.get(tenantId) || null;
  }

  async function upsertTenant(tenant) {
    const existing = tenantRows.get(tenant.tenant_id) || {
      plan: "free", entitled: false, quota_usd: 0, allowed_models: [],
      quota_period_start: new Date(0).toISOString(),
    };
    const merged = { ...existing, ...tenant };
    tenantRows.set(tenant.tenant_id, merged);
    return merged;
  }

  async function spentUsd(tenantId, since) {
    const from = since ? new Date(since).getTime() : 0;
    let total = 0;
    for (const row of rows.values()) {
      if (row.tenant_id !== tenantId || row.meter !== "cost_usd") continue;
      if (new Date(row.occurred_at).getTime() < from) continue;
      total += Number(row.value) || 0;
    }
    return total;
  }

  // The Map's key is the usage id, which is the same guarantee the Postgres
  // primary key gives: writing a row that is already there changes nothing and
  // is not an error. Returns everything it holds, whether this call stored it
  // or an earlier one did, because the client is asking "is it safe to stop
  // sending this", not "was I first".
  async function insertUsage(incoming) {
    const accepted = [];
    for (const row of incoming) {
      if (!rows.has(row.usage_id)) rows.set(row.usage_id, { ...row, emitted_at: null });
      accepted.push(row.usage_id);
    }
    return accepted;
  }

  async function recordMarketplaceEvent(event) {
    if (events.has(event.event_id)) return { stored: false };
    events.set(event.event_id, { ...event, received_at: new Date().toISOString(), processed_at: null });
    return { stored: true };
  }

  async function markEventProcessed(eventId, status) {
    const e = events.get(eventId);
    if (e) { e.processed_at = new Date().toISOString(); e.status = status; }
  }

  async function unemitted(limit = 500) {
    return [...rows.values()].filter((r) => !r.emitted_at).slice(0, limit);
  }

  async function markEmitted(ids) {
    const when = new Date().toISOString();
    for (const id of ids) { const r = rows.get(id); if (r) r.emitted_at = when; }
    return ids.length;
  }

  async function tenantBySubscription(subscriptionId) {
    for (const t of tenantRows.values()) {
      if (t.marketplace_subscription === subscriptionId) return t;
    }
    return null;
  }

  return {
    kind: "memory",
    getTenant, upsertTenant, spentUsd, insertUsage,
    recordMarketplaceEvent, markEventProcessed, tenantBySubscription,
    unemitted, markEmitted,
    ping: async () => true,
    close: async () => {},
    // Test affordances, not part of the interface the service uses.
    _rows: rows, _events: events, _tenants: tenantRows,
  };
}

module.exports = { makeMemoryStore };
