// The store interface, on Postgres.
//
// `pg` is required lazily, inside the factory, on purpose: the memory store and
// everything built on it must run in CI with nothing installed, and a top-level
// require here would make the whole module unloadable without node_modules.
//
// Authentication is Entra by default. The managed identity fetches a token and
// uses it as the password, so no database credential exists to leak, rotate or
// accidentally commit. A DATABASE_URL with an inline password is accepted for
// local development and refused when it would be used against a real server.

const fs = require("fs");
const path = require("path");

const SCHEMA = path.join(__dirname, "schema.sql");

// Postgres NUMERIC comes back as a string, because it does not fit a double
// without losing exactness. That is the right call for money and the wrong
// shape for arithmetic, so it is converted once, here, at the boundary.
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

function makePostgresStore({ connectionString, pool: injectedPool, ssl } = {}) {
  let pool = injectedPool;
  if (!pool) {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString,
      ssl: ssl === undefined ? { rejectUnauthorized: true } : ssl,
      // Small, because this sits in front of a Burstable instance with a
      // modest connection limit and every replica opens its own pool.
      max: 8,
      idleTimeoutMillis: 30000,
      // Bounded like every other call in this system. A connection attempt that
      // never answers would hold an authorize past the client's own deadline,
      // which turns one slow dependency into a refused turn.
      connectionTimeoutMillis: 5000,
    });
  }

  async function migrate() {
    await pool.query(fs.readFileSync(SCHEMA, "utf8"));
  }

  async function getTenant(tenantId) {
    const { rows } = await pool.query(
      `SELECT tenant_id, plan, entitled, quota_usd, allowed_models,
              marketplace_subscription, marketplace_plan_id, marketplace_state,
              quota_period_start
         FROM tenants WHERE tenant_id = $1`, [tenantId]);
    if (!rows.length) return null;
    return { ...rows[0], quota_usd: num(rows[0].quota_usd) };
  }

  async function upsertTenant(t) {
    const { rows } = await pool.query(
      `INSERT INTO tenants (tenant_id, plan, entitled, quota_usd, allowed_models,
                            marketplace_subscription, marketplace_plan_id, marketplace_state)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id) DO UPDATE
              SET plan = EXCLUDED.plan,
                  entitled = EXCLUDED.entitled,
                  quota_usd = EXCLUDED.quota_usd,
                  allowed_models = EXCLUDED.allowed_models,
                  marketplace_subscription = COALESCE(EXCLUDED.marketplace_subscription, tenants.marketplace_subscription),
                  marketplace_plan_id = COALESCE(EXCLUDED.marketplace_plan_id, tenants.marketplace_plan_id),
                  marketplace_state = COALESCE(EXCLUDED.marketplace_state, tenants.marketplace_state),
                  updated_at = now()
         RETURNING *`,
      [t.tenant_id, t.plan || "free", t.entitled === true, Number(t.quota_usd) || 0,
       t.allowed_models || [], t.marketplace_subscription || null,
       t.marketplace_plan_id || null, t.marketplace_state || null]);
    return { ...rows[0], quota_usd: num(rows[0].quota_usd) };
  }

  // Summed from the ledger rather than kept as a running counter on the tenant.
  // A counter and a log that disagree is a question with no answer; a log that
  // is summed can only ever be behind, never wrong.
  async function spentUsd(tenantId, since) {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(value), 0) AS spent
         FROM usage_ledger
        WHERE tenant_id = $1 AND meter = 'cost_usd' AND occurred_at >= $2`,
      [tenantId, since || new Date(0).toISOString()]);
    return num(rows[0].spent);
  }

  /* The whole idempotency guarantee, in one statement.

     ON CONFLICT DO NOTHING makes a duplicate delivery a no-op inside the
     storage engine: correct under concurrency, with no transaction the
     application has to get right, and no read-then-write race in between.

     The answer is every id in the batch, not just the ids this call inserted.
     The client is asking "may I stop sending this", and for a row that is
     already durably stored the answer is yes. Returning only the fresh ones
     would queue duplicates forever. */
  async function insertUsage(rows) {
    if (!rows.length) return [];
    const cols = 11;
    const values = [];
    const params = [];
    rows.forEach((r, i) => {
      const b = i * cols;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11})`);
      params.push(r.usage_id, r.tenant_id, r.workspace_id || "", r.turn_id, r.meter,
        r.value, r.model || "", r.plan || "", r.stop || "", r.verdict || "",
        r.occurred_at || new Date().toISOString());
    });
    await pool.query(
      `INSERT INTO usage_ledger
         (usage_id, tenant_id, workspace_id, turn_id, meter, value, model, plan, stop, verdict, occurred_at)
       VALUES ${values.join(",")}
       ON CONFLICT (usage_id) DO NOTHING`, params);
    // Read back rather than trusting the insert's row count, so an id is only
    // reported accepted when it is genuinely in the table - whoever put it
    // there. This is the difference between "I wrote it" and "it is safe for
    // you to forget it", and the client is asking the second question.
    const ids = rows.map((r) => r.usage_id);
    const { rows: present } = await pool.query(
      `SELECT usage_id FROM usage_ledger WHERE usage_id = ANY($1::text[])`, [ids]);
    return present.map((p) => p.usage_id);
  }

  async function recordMarketplaceEvent(event) {
    const { rowCount } = await pool.query(
      `INSERT INTO marketplace_events (event_id, subscription_id, action, payload)
            VALUES ($1,$2,$3,$4)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.event_id, event.subscription_id, event.action, JSON.stringify(event.payload || {})]);
    return { stored: rowCount > 0 };
  }

  async function markEventProcessed(eventId, status) {
    await pool.query(
      `UPDATE marketplace_events SET processed_at = now(), status = $2 WHERE event_id = $1`,
      [eventId, status || "processed"]);
  }

  async function tenantBySubscription(subscriptionId) {
    const { rows } = await pool.query(
      `SELECT * FROM tenants WHERE marketplace_subscription = $1`, [subscriptionId]);
    return rows.length ? { ...rows[0], quota_usd: num(rows[0].quota_usd) } : null;
  }

  // FOR UPDATE SKIP LOCKED so two emitter runs overlapping cannot report the
  // same row twice. The marketplace metering API is not idempotent the way this
  // ledger is, so a double report is a double charge with no way to undo it.
  async function unemitted(limit = 500) {
    const { rows } = await pool.query(
      `SELECT * FROM usage_ledger
        WHERE emitted_at IS NULL
        ORDER BY occurred_at
        LIMIT $1
          FOR UPDATE SKIP LOCKED`, [limit]);
    return rows.map((r) => ({ ...r, value: num(r.value) }));
  }

  async function markEmitted(ids) {
    if (!ids.length) return 0;
    const { rowCount } = await pool.query(
      `UPDATE usage_ledger SET emitted_at = now()
        WHERE usage_id = ANY($1::text[]) AND emitted_at IS NULL`, [ids]);
    return rowCount;
  }

  return {
    kind: "postgres",
    migrate, getTenant, upsertTenant, spentUsd, insertUsage,
    recordMarketplaceEvent, markEventProcessed, tenantBySubscription,
    unemitted, markEmitted,
    ping: async () => { await pool.query("SELECT 1"); return true; },
    close: async () => { await pool.end(); },
    pool,
  };
}

module.exports = { makePostgresStore, SCHEMA };
