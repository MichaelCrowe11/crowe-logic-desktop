#!/usr/bin/env node
// The Postgres store, held to the same assertions as the memory one.
//
// Skips cleanly when DATABASE_URL is unset, because CI has no database and a
// test that fails for lack of a server teaches people to ignore red builds.
//
// The reason this file exists at all is the concurrency section. Everything
// else here is a consistency check between two implementations, but
// "ON CONFLICT (usage_id) DO NOTHING makes duplicate billing impossible" is a
// claim about what Postgres does when several connections race, and the only
// honest way to make that claim is to run the race.
//
//   docker run -d --name crowe-pg-test -e POSTGRES_PASSWORD=test \
//     -p 5434:5432 postgres:16
//   DATABASE_URL=postgres://postgres:test@127.0.0.1:5434/postgres \
//     node scripts/test-control-plane-pg.js

const assert = require("assert");

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("# control plane (postgres)");
  console.log("ok   skipped, DATABASE_URL is not set");
  process.exit(0);
}

let makePostgresStore;
try {
  // Resolved from control-plane/, not from here. `pg` is that package's
  // dependency and lives in its node_modules, so checking from scripts/ would
  // report it missing on a machine where it is installed and working.
  require.resolve("pg", { paths: [require("path").join(__dirname, "..", "control-plane")] });
  ({ makePostgresStore } = require("../control-plane/store-postgres"));
} catch {
  console.log("# control plane (postgres)");
  console.log("ok   skipped, the pg module is not installed");
  process.exit(0);
}

const { makeService } = require("../control-plane/service");
const { makeMemoryStore } = require("../control-plane/store-memory");
const contract = require("../cloud/contract");

let passed = 0;
let failed = 0;
async function checkAsync(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); passed++; }
  catch (e) { console.log(`FAIL ${name}\n     ${e.message}`); failed++; }
}

const insecure = /127\.0\.0\.1|localhost/.test(url);

async function main() {
  console.log("# control plane (postgres)");

  const store = makePostgresStore({
    connectionString: url,
    ssl: insecure ? false : { rejectUnauthorized: true },
  });

  // A dedicated schema, dropped first, so a rerun starts clean and nothing
  // touches whatever else lives in this database.
  await store.pool.query("DROP SCHEMA IF EXISTS crowe_test CASCADE");
  await store.pool.query("CREATE SCHEMA crowe_test");
  await store.pool.query("SET search_path TO crowe_test");
  // The pool hands out several connections and search_path is per-session, so
  // it has to be the default for the role rather than a one-off SET.
  await store.pool.query(`ALTER ROLE CURRENT_USER SET search_path TO crowe_test, public`);
  await store.pool.end();

  const live = makePostgresStore({
    connectionString: url,
    ssl: insecure ? false : { rejectUnauthorized: true },
  });
  await live.migrate();

  const service = makeService({ store: live });

  await checkAsync("the schema applies, and applies again without error", async () => {
    await live.migrate();   // every statement is IF NOT EXISTS, so boot is safe
    assert.strictEqual(await live.ping(), true);
  });

  await checkAsync("a tenant round-trips with its numeric quota intact", async () => {
    const t = await live.upsertTenant({
      tenant_id: "acme", plan: "pro", entitled: true, quota_usd: 10.5,
      allowed_models: ["gpt", "small"],
    });
    assert.strictEqual(t.quota_usd, 10.5, "NUMERIC must not come back as a string");
    assert.strictEqual(typeof t.quota_usd, "number");
    assert.deepStrictEqual(t.allowed_models, ["gpt", "small"]);
    const read = await live.getTenant("acme");
    assert.strictEqual(read.quota_usd, 10.5);
  });

  await checkAsync("an upsert updates rather than duplicating", async () => {
    await live.upsertTenant({ tenant_id: "acme", plan: "team", entitled: true, quota_usd: 20 });
    const t = await live.getTenant("acme");
    assert.strictEqual(t.plan, "team");
    assert.strictEqual(t.quota_usd, 20);
  });

  await checkAsync("a missing tenant is null, not a throw", async () => {
    assert.strictEqual(await live.getTenant("nobody"), null);
  });

  // ---- the guarantee ------------------------------------------------------

  const rows = contract.usageRows({
    tenantId: "acme", workspaceId: "w", turnId: "turn-1", model: "gpt",
    plan: "pro", stop: "done", verdict: "ok",
    meters: { cost_usd: 0.25, turns: 1, input_tokens: 100, output_tokens: 50 },
  });

  await checkAsync("a batch inserts and every id is reported accepted", async () => {
    const accepted = await live.insertUsage(rows);
    assert.strictEqual(accepted.length, rows.length);
    assert.deepStrictEqual(accepted.sort(), rows.map((r) => r.usage_id).sort());
  });

  await checkAsync("the same batch again is accepted and changes nothing", async () => {
    const accepted = await live.insertUsage(rows);
    assert.strictEqual(accepted.length, rows.length, "a duplicate must still be acknowledged");
    const { rows: count } = await live.pool.query(
      "SELECT count(*)::int AS n FROM usage_ledger WHERE turn_id = 'turn-1'");
    assert.strictEqual(count[0].n, rows.length, "the replay wrote extra rows");
    assert.strictEqual(await live.spentUsd("acme", new Date(0).toISOString()), 0.25);
  });

  /* Twenty connections, same batch, at once.

     This is the assertion the whole billing design rests on. If ON CONFLICT
     were not doing the work - if this were a read-then-write - some of these
     would interleave between the check and the insert and the customer would
     be charged several times for one turn. Postgres serializes them on the
     primary key index, so exactly one row survives and all twenty callers are
     told it is safe to stop sending. */
  await checkAsync("twenty concurrent writers of the same batch produce one charge", async () => {
    const concurrent = contract.usageRows({
      tenantId: "acme", workspaceId: "w", turnId: "turn-race", model: "gpt",
      meters: { cost_usd: 1.5, turns: 1 },
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => live.insertUsage(concurrent)));

    for (const r of results) {
      assert.strictEqual(r.length, concurrent.length,
        "every writer must be told its rows are stored, whoever stored them");
    }
    const { rows: count } = await live.pool.query(
      "SELECT count(*)::int AS n FROM usage_ledger WHERE turn_id = 'turn-race'");
    assert.strictEqual(count[0].n, concurrent.length,
      `twenty writers produced ${count[0].n} rows instead of ${concurrent.length}`);

    const spent = await live.spentUsd("acme", new Date(0).toISOString());
    assert.strictEqual(spent, 1.75, `charged ${spent} instead of 0.25 + 1.50`);
  });

  await checkAsync("distinct turns with identical meters are distinct charges", async () => {
    await live.insertUsage(contract.usageRows({
      tenantId: "acme", workspaceId: "w", turnId: "turn-2", meters: { cost_usd: 1.5 },
    }));
    assert.strictEqual(await live.spentUsd("acme", new Date(0).toISOString()), 3.25);
  });

  await checkAsync("a row for a tenant that does not exist is refused by the database", async () => {
    await assert.rejects(
      () => live.insertUsage(contract.usageRows({
        tenantId: "ghost", workspaceId: "w", turnId: "t", meters: { cost_usd: 1 },
      })),
      /foreign key|violates/i,
      "usage must not be recordable against a tenant with no entitlement row");
  });

  await checkAsync("a negative value is refused by the check constraint", async () => {
    await assert.rejects(
      () => live.insertUsage([{
        usage_id: "neg-1", tenant_id: "acme", workspace_id: "w", turn_id: "t",
        meter: "cost_usd", value: -5, occurred_at: new Date().toISOString(),
      }]),
      /check|violates/i);
  });

  await checkAsync("the quota window excludes spend from before the period", async () => {
    const since = new Date(Date.now() + 60000).toISOString();
    assert.strictEqual(await live.spentUsd("acme", since), 0);
  });

  // ---- the emitter outbox -------------------------------------------------

  await checkAsync("every row starts unemitted and marking is idempotent", async () => {
    const pending = await live.unemitted();
    assert.ok(pending.length >= 4, `expected pending rows, got ${pending.length}`);
    const ids = pending.map((p) => p.usage_id);
    const first = await live.markEmitted(ids);
    assert.strictEqual(first, ids.length);
    // Marking the same rows again must report nothing, because the emitter
    // uses this count to know what it actually reported.
    assert.strictEqual(await live.markEmitted(ids), 0, "a second mark must be a no-op");
    assert.strictEqual((await live.unemitted()).length, 0);
  });

  await checkAsync("a redelivered marketplace event is stored once", async () => {
    const e = { event_id: "11111111-1111-1111-1111-111111111111",
      subscription_id: "22222222-2222-2222-2222-222222222222",
      action: "Unsubscribe", payload: { a: 1 } };
    assert.strictEqual((await live.recordMarketplaceEvent(e)).stored, true);
    assert.strictEqual((await live.recordMarketplaceEvent(e)).stored, false,
      "the replay must be recognised, or the handler runs twice");
  });

  await checkAsync("a subscription resolves back to its tenant", async () => {
    await live.upsertTenant({
      tenant_id: "acme", plan: "team", entitled: true, quota_usd: 20,
      marketplace_subscription: "33333333-3333-3333-3333-333333333333",
    });
    const t = await live.tenantBySubscription("33333333-3333-3333-3333-333333333333");
    assert.strictEqual(t.tenant_id, "acme");
  });

  // ---- the two stores must not disagree -----------------------------------
  //
  // The same sequence against both, compared. Anywhere they differ is a place
  // where CI is proving something production does not do.
  await checkAsync("the memory store and Postgres reach the same decisions", async () => {
    const mem = makeMemoryStore();
    await mem.upsertTenant({ tenant_id: "cmp", plan: "pro", entitled: true, quota_usd: 2 });
    await live.upsertTenant({ tenant_id: "cmp", plan: "pro", entitled: true, quota_usd: 2 });

    const memSvc = makeService({ store: mem });
    const pgSvc = makeService({ store: live });
    const req = { tenantId: "cmp", workspaceId: "w", model: "gpt", turnId: "t" };

    const a1 = await memSvc.authorize(req);
    const b1 = await pgSvc.authorize(req);
    assert.deepStrictEqual(
      { allowed: a1.allowed, plan: a1.plan, remaining: a1.remainingUsd },
      { allowed: b1.allowed, plan: b1.plan, remaining: b1.remainingUsd });

    const usage = { tenantId: "cmp", workspaceId: "w", turnId: "t-cmp", meters: { cost_usd: 1.25 } };
    const memAcc = await memSvc.recordUsage(contract.usageRows(usage));
    const pgAcc = await pgSvc.recordUsage(contract.usageRows(usage));
    assert.deepStrictEqual(memAcc.accepted.sort(), pgAcc.accepted.sort());

    const a2 = await memSvc.authorize(req);
    const b2 = await pgSvc.authorize(req);
    assert.strictEqual(a2.remainingUsd, b2.remainingUsd, "the two stores disagree about what is left");

    // And both refuse at the same point, rather than one handing down a
    // ceiling of zero while the other refuses.
    const drain = { tenantId: "cmp", workspaceId: "w", turnId: "t-drain", meters: { cost_usd: 5 } };
    await memSvc.recordUsage(contract.usageRows(drain));
    await pgSvc.recordUsage(contract.usageRows(drain));
    const a3 = await memSvc.authorize(req);
    const b3 = await pgSvc.authorize(req);
    assert.strictEqual(a3.allowed, false);
    assert.strictEqual(b3.allowed, false);
    assert.strictEqual(a3.code, b3.code);
  });

  await live.pool.query("DROP SCHEMA IF EXISTS crowe_test CASCADE");
  await live.pool.query("ALTER ROLE CURRENT_USER RESET search_path");
  await live.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
