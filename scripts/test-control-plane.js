#!/usr/bin/env node
// The hosted control plane, over real HTTP, with no database.
//
// The point of this file is not that the routes return 200. It is that the
// hosted plane refuses exactly the things cloud/local.js refuses, and accepts
// exactly the things it accepts. A hosted plane that behaved differently from
// the stub would make the stub a lie to develop against, and the divergence
// would only surface in production.
//
// Everything runs against the in-memory store so it needs nothing installed.
// scripts/test-control-plane-pg.js holds the Postgres store to the same
// assertions whenever a real server is available.

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { makeService } = require("../control-plane/service");
const { makeMemoryStore } = require("../control-plane/store-memory");
const { makeAuth, sha256 } = require("../control-plane/auth");
const { makeApp } = require("../control-plane/http");
const { applyWebhook } = require("../control-plane/marketplace");
const { emitPending, usdToQuantity } = require("../control-plane/emitter");
const { makeRemotePlane } = require("../cloud/remote");
const contract = require("../cloud/contract");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`ok   ${name}`); passed++; }
  catch (e) { console.log(`FAIL ${name}\n     ${e.message}`); failed++; }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); passed++; }
  catch (e) { console.log(`FAIL ${name}\n     ${e.message}`); failed++; }
}

const KEY = "sk-test-abcdefghijklmnop";
const OTHER_KEY = "sk-other-qrstuvwxyz";

function boot({ tenants, webhookSecret = "", marketplace = null, plans = {} } = {}) {
  const store = makeMemoryStore({ tenants });
  const service = makeService({ store });
  const auth = makeAuth({
    store,
    apiKeys: { [sha256(KEY)]: "acme", [sha256(OTHER_KEY)]: "globex" },
  });
  const app = makeApp({ service, auth, marketplace, webhookSecret, plans });
  return { store, service, auth, app };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

async function post(base, path, body, token = KEY) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function main() {
  console.log("# control plane");

  // ---- authorize ----------------------------------------------------------
  {
    const { app } = boot({ tenants: { acme: { entitled: true, plan: "pro", quota_usd: 10 } } });
    const s = await listen(app);

    await checkAsync("an entitled tenant is allowed and told what remains", async () => {
      const r = await post(s.base, "/api/control/authorize", { model: "gpt", turn_id: "t1" });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.plan, "pro");
      assert.strictEqual(r.body.remaining_usd, 10);
    });

    await checkAsync("a missing credential is 401, not 403", async () => {
      const r = await post(s.base, "/api/control/authorize", {}, null);
      assert.strictEqual(r.status, 401);
      assert.strictEqual(r.body.code, "unauthorized");
    });

    await checkAsync("an unknown key is refused", async () => {
      const r = await post(s.base, "/api/control/authorize", {}, "sk-not-a-key");
      assert.strictEqual(r.status, 401);
    });

    // The important one. A valid credential for globex must not be able to
    // spend acme's quota by naming acme in the body.
    await checkAsync("the credential decides the tenant, not the body", async () => {
      const r = await post(s.base, "/api/control/authorize", { tenant_id: "acme" }, OTHER_KEY);
      assert.strictEqual(r.status, 403);
      assert.strictEqual(r.body.code, "tenant_mismatch");
    });

    await checkAsync("a tenant with no row is refused with 403 and a reason", async () => {
      const r = await post(s.base, "/api/control/authorize", {}, OTHER_KEY);
      assert.strictEqual(r.status, 403);
      assert.strictEqual(r.body.code, "no_tenant");
      assert.ok(r.body.reason.includes("globex"));
    });

    await s.close();
  }

  {
    const { app } = boot({ tenants: { acme: { entitled: false, plan: "pro", quota_usd: 10 } } });
    const s = await listen(app);
    await checkAsync("an inactive entitlement is refused", async () => {
      const r = await post(s.base, "/api/control/authorize", {});
      assert.strictEqual(r.status, 403);
      assert.strictEqual(r.body.code, "not_entitled");
    });
    await s.close();
  }

  {
    const { app } = boot({ tenants: { acme: { entitled: true, allowed_models: ["small"] } } });
    const s = await listen(app);
    await checkAsync("a model outside the plan is refused", async () => {
      const r = await post(s.base, "/api/control/authorize", { model: "huge" });
      assert.strictEqual(r.status, 403);
      assert.strictEqual(r.body.code, "model_not_in_plan");
    });
    await checkAsync("a model inside the plan is allowed", async () => {
      const r = await post(s.base, "/api/control/authorize", { model: "small" });
      assert.strictEqual(r.status, 200);
    });
    await s.close();
  }

  {
    const { app } = boot({ tenants: { acme: { entitled: true, quota_usd: 0 } } });
    const s = await listen(app);
    // Zero quota means uncapped, matching clampCeiling on the client. This is
    // the pair of assertions that keeps the two meanings of zero apart.
    await checkAsync("a quota of zero means uncapped, and remaining is null", async () => {
      const r = await post(s.base, "/api/control/authorize", {});
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.remaining_usd, null);
    });
    await s.close();
  }

  // ---- quota, end to end --------------------------------------------------
  {
    const { app, store } = boot({ tenants: {
      acme: { entitled: true, plan: "pro", quota_usd: 1 },
      // Present because usage_ledger has a foreign key to tenants. Leaving it
      // out would let the memory store accept a row Postgres would refuse,
      // which is exactly the divergence these two stores must not have.
      globex: { entitled: true, plan: "pro", quota_usd: 100 },
    } });
    const s = await listen(app);

    await checkAsync("recorded cost reduces what the next authorize offers", async () => {
      const usage = {
        tenantId: "acme", workspaceId: "w", turnId: "turn-a", model: "gpt",
        plan: "pro", stop: "done", verdict: "ok",
        meters: { cost_usd: 0.25, turns: 1 },
      };
      const rows = contract.usageRows(usage);
      const r = await post(s.base, "/api/control/usage", { events: rows });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.accepted.length, rows.length);

      const a = await post(s.base, "/api/control/authorize", {});
      assert.strictEqual(a.body.remaining_usd, 0.75);
    });

    // The central guarantee. The same turn reported twice must not be charged
    // twice, and the id doing the work is the one the client derived.
    await checkAsync("a replayed batch is accepted again but charged once", async () => {
      const rows = contract.usageRows({
        tenantId: "acme", workspaceId: "w", turnId: "turn-a", model: "gpt",
        plan: "pro", stop: "done", verdict: "ok",
        meters: { cost_usd: 0.25, turns: 1 },
      });
      const r = await post(s.base, "/api/control/usage", { events: rows });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.accepted.length, rows.length, "a duplicate is still acknowledged");
      const a = await post(s.base, "/api/control/authorize", {});
      assert.strictEqual(a.body.remaining_usd, 0.75, "but the balance did not move");
    });

    await checkAsync("a different turn with identical meters is a different charge", async () => {
      const rows = contract.usageRows({
        tenantId: "acme", workspaceId: "w", turnId: "turn-b", model: "gpt",
        plan: "pro", stop: "done", verdict: "ok",
        meters: { cost_usd: 0.25, turns: 1 },
      });
      await post(s.base, "/api/control/usage", { events: rows });
      const a = await post(s.base, "/api/control/authorize", {});
      assert.strictEqual(a.body.remaining_usd, 0.5);
    });

    await checkAsync("an exhausted quota is refused, never handed down as a ceiling of zero", async () => {
      await post(s.base, "/api/control/usage", {
        events: contract.usageRows({
          tenantId: "acme", workspaceId: "w", turnId: "turn-c",
          meters: { cost_usd: 0.6 },
        }),
      });
      const a = await post(s.base, "/api/control/authorize", {});
      assert.strictEqual(a.status, 402, "an exhausted wallet is payment required, not forbidden");
      assert.strictEqual(a.body.code, "quota_exhausted");
      assert.strictEqual(a.body.remaining_usd, undefined);
    });

    await checkAsync("usage naming another tenant is re-attributed, not stored as theirs", async () => {
      const rows = contract.usageRows({
        tenantId: "globex", workspaceId: "w", turnId: "turn-x",
        meters: { cost_usd: 1 },
      });
      await post(s.base, "/api/control/usage", { events: rows }, OTHER_KEY);
      // Only this turn's rows, because acme has legitimate rows from the
      // assertions above and scanning all of them would always find one.
      const stored = [...store._rows.values()].filter((r) => r.turn_id === "turn-x");
      assert.ok(stored.length, "the batch was dropped entirely");
      for (const row of stored) {
        assert.strictEqual(row.tenant_id, "globex", "acme was billed for globex's turn");
      }
    });

    await s.close();
  }

  // ---- the client, unmodified, against the real server --------------------
  //
  // cloud/remote.js is the shipped client. Pointing it at this server is the
  // only assertion that proves the wire shapes actually match, rather than
  // matching a second description of them written in this file.
  {
    const { app } = boot({ tenants: { acme: { entitled: true, plan: "pro", quota_usd: 5 } } });
    const s = await listen(app);
    // The client keeps an outbox on disk, so it needs somewhere to keep it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-plane-"));
    const plane = makeRemotePlane({ baseUrl: s.base, token: KEY, dir, requirePlane: true });

    await checkAsync("the shipped client authorizes against the real server", async () => {
      const d = await plane.authorize({ tenantId: "acme", workspaceId: "w", model: "gpt", turnId: "t" });
      assert.strictEqual(d.allowed, true);
      assert.strictEqual(d.plan, "pro");
      assert.strictEqual(d.remainingUsd, 5);
    });

    await checkAsync("the shipped client records usage and the outbox drains", async () => {
      const usage = {
        tenantId: "acme", workspaceId: "w", turnId: "t-remote",
        meters: { cost_usd: 0.1, turns: 1, input_tokens: 20, output_tokens: 5 },
      };
      const res = await plane.record(usage);
      assert.strictEqual(res.ok, true);
      // The client reports what it delivered and what is still queued. Nothing
      // may remain queued against a server that answered, or the same rows are
      // resent forever.
      assert.strictEqual(res.delivered, contract.usageRows(usage).length);
      assert.strictEqual(res.pending, 0);
      assert.strictEqual(plane.pending(), 0);
    });

    await checkAsync("the shipped client sees the refusal when the quota is gone", async () => {
      await plane.record({ tenantId: "acme", workspaceId: "w", turnId: "t-drain", meters: { cost_usd: 99 } });
      const d = await plane.authorize({ tenantId: "acme", workspaceId: "w", model: "gpt", turnId: "t2" });
      assert.strictEqual(d.allowed, false);
      assert.strictEqual(d.code, "quota_exhausted");
    });

    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- input handling -----------------------------------------------------
  {
    const { app } = boot({ tenants: { acme: { entitled: true } } });
    const s = await listen(app);

    await checkAsync("an oversized body is refused rather than buffered", async () => {
      const res = await fetch(`${s.base}/api/control/usage`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ events: [], pad: "x".repeat(2 * 1024 * 1024) }),
      }).catch((e) => ({ status: 0, err: e }));
      // Either a 400 or a destroyed socket is correct; silently accepting two
      // megabytes is not.
      assert.ok(res.status === 400 || res.status === 0, `got ${res.status}`);
    });

    await checkAsync("malformed json is a 400, not a 500", async () => {
      const res = await fetch(`${s.base}/api/control/usage`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: "{not json",
      });
      assert.strictEqual(res.status, 400);
    });

    await checkAsync("an unknown route is a 404", async () => {
      const res = await fetch(`${s.base}/api/control/whatever`, { method: "POST" });
      assert.strictEqual(res.status, 404);
    });

    await checkAsync("health does not require a credential", async () => {
      const res = await fetch(`${s.base}/health`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual((await res.json()).store, "memory");
    });

    await checkAsync("a meter the contract does not define is rejected, not stored", async () => {
      const r = await post(s.base, "/api/control/usage", {
        events: [{ usage_id: "x1", tenant_id: "acme", turn_id: "t", meter: "invented", value: 5 }],
      });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body.accepted, []);
    });

    await checkAsync("a negative value is rejected", async () => {
      const r = await post(s.base, "/api/control/usage", {
        events: [{ usage_id: "x2", tenant_id: "acme", turn_id: "t", meter: "cost_usd", value: -1 }],
      });
      assert.deepStrictEqual(r.body.accepted, []);
    });

    await s.close();
  }

  // ---- marketplace webhooks ----------------------------------------------
  {
    const store = makeMemoryStore({
      acme: { entitled: true, plan: "pro", quota_usd: 10, marketplace_subscription: "sub-1" },
    });
    await store.upsertTenant({
      tenant_id: "acme", entitled: true, plan: "pro", quota_usd: 10,
      marketplace_subscription: "sub-1",
    });

    await checkAsync("an unsubscribe revokes entitlement", async () => {
      const r = await applyWebhook({
        store, event: { id: "e1", subscriptionId: "sub-1", action: "Unsubscribe" },
      });
      assert.strictEqual(r.applied, true);
      assert.strictEqual((await store.getTenant("acme")).entitled, false);
    });

    await checkAsync("a redelivered webhook is a no-op", async () => {
      await store.upsertTenant({ tenant_id: "acme", entitled: true, marketplace_subscription: "sub-1" });
      const r = await applyWebhook({
        store, event: { id: "e1", subscriptionId: "sub-1", action: "Unsubscribe" },
      });
      assert.strictEqual(r.applied, false);
      assert.strictEqual(r.reason, "duplicate");
      assert.strictEqual((await store.getTenant("acme")).entitled, true, "the replay must not revoke again");
    });

    await checkAsync("a plan change moves the quota and the model allowlist", async () => {
      const r = await applyWebhook({
        store,
        event: { id: "e2", subscriptionId: "sub-1", action: "ChangePlan", planId: "team" },
        plans: { team: { quotaUsd: 250, models: ["gpt", "small"] } },
      });
      assert.strictEqual(r.applied, true);
      const t = await store.getTenant("acme");
      assert.strictEqual(t.quota_usd, 250);
      assert.deepStrictEqual(t.allowed_models, ["gpt", "small"]);
      assert.strictEqual(t.entitled, true);
    });

    await checkAsync("an unrecognised action leaves the tenant alone", async () => {
      const before = await store.getTenant("acme");
      const r = await applyWebhook({
        store, event: { id: "e3", subscriptionId: "sub-1", action: "SomethingNew" },
      });
      assert.strictEqual(r.applied, false);
      assert.deepStrictEqual(await store.getTenant("acme"), before);
    });

    await checkAsync("a webhook for an unknown subscription is recorded and ignored", async () => {
      const r = await applyWebhook({
        store, event: { id: "e4", subscriptionId: "sub-nope", action: "Unsubscribe" },
      });
      assert.strictEqual(r.reason, "no_tenant");
    });
  }

  // The secret in the URL is a filter, not authentication, and it has to
  // actually filter.
  {
    const { app } = boot({ tenants: { acme: { entitled: true } }, webhookSecret: "s3cret" });
    const s = await listen(app);
    await checkAsync("a webhook without the shared secret gets a 404", async () => {
      const res = await fetch(`${s.base}/marketplace/webhook`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "e9", subscriptionId: "sub-1", action: "Unsubscribe" }),
      });
      assert.strictEqual(res.status, 404, "a wrong secret must not reveal that the route exists");
    });
    await s.close();
  }

  // ---- the emitter --------------------------------------------------------
  {
    check("dollars become integer cents, so a sub-cent turn is not rounded away", () => {
      assert.strictEqual(usdToQuantity(0.25), 25);
      assert.strictEqual(usdToQuantity(1), 100);
      assert.strictEqual(usdToQuantity(0.004), 0);
      assert.strictEqual(usdToQuantity(0.006), 1);
    });

    const store = makeMemoryStore();
    await store.upsertTenant({
      tenant_id: "acme", entitled: true, plan: "pro",
      marketplace_subscription: "sub-1", marketplace_plan_id: "pro",
    });
    await store.insertUsage(contract.usageRows({
      tenantId: "acme", workspaceId: "w", turnId: "t-emit",
      meters: { cost_usd: 0.5, turns: 1, input_tokens: 10 },
    }));

    const calls = [];
    const marketplace = {
      emitUsage: async (e) => { calls.push(e); return { ok: true, status: 200 }; },
    };

    await checkAsync("only cost rows are reported, and the rest are marked done", async () => {
      const r = await emitPending({ store, marketplace });
      assert.strictEqual(calls.length, 1, "turns and tokens are not billable dimensions");
      assert.strictEqual(calls[0].quantity, 50);
      assert.strictEqual(calls[0].resourceId, "sub-1");
      assert.strictEqual(r.sent.length, 1);
      assert.strictEqual((await store.unemitted()).length, 0, "nothing is left to drag along forever");
    });

    await checkAsync("a second run has nothing to send", async () => {
      const before = calls.length;
      await emitPending({ store, marketplace });
      assert.strictEqual(calls.length, before);
    });

    // A crash between reporting and marking replays the row. The marketplace
    // answers 409, which is it confirming the usage is already there, and that
    // has to end the retry rather than extend it forever.
    await checkAsync("a 409 from the marketplace is treated as already recorded", async () => {
      await store.insertUsage(contract.usageRows({
        tenantId: "acme", workspaceId: "w", turnId: "t-dup", meters: { cost_usd: 0.2 },
      }));
      const conflicting = { emitUsage: async () => ({ ok: false, status: 409 }) };
      const r = await emitPending({ store, marketplace: conflicting });
      assert.strictEqual(r.sent.length, 1);
      assert.strictEqual((await store.unemitted()).length, 0);
    });

    await checkAsync("a 5xx leaves the row unmarked for the next run", async () => {
      await store.insertUsage(contract.usageRows({
        tenantId: "acme", workspaceId: "w", turnId: "t-fail", meters: { cost_usd: 0.3 },
      }));
      const broken = { emitUsage: async () => ({ ok: false, status: 503 }) };
      const r = await emitPending({ store, marketplace: broken });
      assert.strictEqual(r.failed.length, 1);
      assert.strictEqual((await store.unemitted()).length, 1, "revenue must not be dropped on a 503");
    });

    await checkAsync("usage from a tenant with no subscription is not sent to Microsoft", async () => {
      await store.upsertTenant({ tenant_id: "direct", entitled: true });
      await store.insertUsage(contract.usageRows({
        tenantId: "direct", workspaceId: "w", turnId: "t-direct", meters: { cost_usd: 0.4 },
      }));
      calls.length = 0;
      await emitPending({ store, marketplace });
      // Asserted on content, not on a count. The previous run left a row
      // unemitted after its 503 and this run correctly retries it, so a count
      // would be measuring the retry rather than the thing under test.
      for (const c of calls) {
        assert.notStrictEqual(c.resourceId, undefined, "a call with no subscription was made");
      }
      assert.ok(!calls.some((c) => c.quantity === 40), "a direct customer was billed through the marketplace");
      const left = await store.unemitted();
      assert.ok(!left.some((r) => r.turn_id === "t-direct"), "the direct row must still be marked done");
    });
  }

  // ---- auth ---------------------------------------------------------------
  {
    const auth = makeAuth({ apiKeys: { [sha256(KEY)]: "acme" } });
    await checkAsync("a bare token without the Bearer scheme is refused", async () => {
      assert.strictEqual(await auth.identify({ headers: { authorization: KEY } }), null);
    });
    await checkAsync("an alg=none token is refused outright", async () => {
      const header = Buffer.from(JSON.stringify({ alg: "none", kid: "k" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ tid: "acme" })).toString("base64url");
      const jwks = async () => ({ kty: "RSA", kid: "k", n: "x", e: "AQAB" });
      const a2 = makeAuth({ apiKeys: {}, jwks });
      const id = await a2.identify({ headers: { authorization: `Bearer ${header}.${payload}.` } });
      assert.strictEqual(id, null);
    });
    await checkAsync("anonymous access is off unless explicitly enabled", async () => {
      assert.strictEqual(await auth.identify({ headers: {} }), null);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
