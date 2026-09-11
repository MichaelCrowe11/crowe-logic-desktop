// Tests for the control-plane contract, the local stub, the outbox and the
// remote client. Pure Node, no network: the remote plane is driven through an
// injected fetch, so its timeout, its refusals and its degrade policy are all
// exercised without a socket.
//
//   node scripts/test-cloud.js
//
// The thing under test is money. Two properties matter more than the rest and
// most of these checks exist to hold them: a turn is never billed twice, and a
// plane that cannot be reached fails the way its product needs it to.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const C = require("../cloud/contract");
const { makeLocalPlane } = require("../cloud/local");
const { makeOutbox } = require("../cloud/outbox");
const { makeRemotePlane } = require("../cloud/remote");
const { makeControlPlane, runTurn } = require("../cloud");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "crowe-cloud-"));

function seed(dir, tenants) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "control-plane.json"), JSON.stringify({ tenants }));
}
const usage = (over = {}) => ({
  tenantId: "acme", turnId: "turn-1",
  meters: { turns: 1, input_tokens: 100, output_tokens: 50, cost_usd: 0.25, mutations: 1 },
  model: "crowelm", plan: "pro", stop: "done", verdict: "pass", ...over,
});

// ─── The derived usage id ────────────────────────────────────────────────────
test("a usage id is derived, so the same turn and meter always collide", () => {
  assert.strictEqual(C.usageId("t", "turn", "cost_usd"), C.usageId("t", "turn", "cost_usd"));
});
test("a usage id separates its fields, so concatenation cannot collide them", () => {
  assert.notStrictEqual(C.usageId("a", "bc", "m"), C.usageId("ab", "c", "m"));
  assert.notStrictEqual(C.usageId("t", "turn", "cost_usd"), C.usageId("t", "turn", "turns"));
  assert.notStrictEqual(C.usageId("t1", "turn", "turns"), C.usageId("t2", "turn", "turns"));
});

// ─── Validation ──────────────────────────────────────────────────────────────
test("a malformed usage event is refused rather than billed", () => {
  assert.ok(C.validateUsage(null).length);
  assert.ok(C.validateUsage({ turnId: "t", meters: {} }).length, "missing tenant");
  assert.ok(C.validateUsage({ tenantId: "t", meters: {} }).length, "missing turn");
  assert.ok(C.validateUsage({ tenantId: "t", turnId: "x", meters: { nope: 1 } }).length, "unknown meter");
  assert.ok(C.validateUsage({ tenantId: "t", turnId: "x", meters: { turns: -1 } }).length, "negative");
  assert.ok(C.validateUsage({ tenantId: "t", turnId: "x", meters: { turns: NaN } }).length, "NaN");
  assert.strictEqual(C.validateUsage(usage()).length, 0);
});
test("zero-valued meters produce no rows, so an empty turn bills nothing", () => {
  const rows = C.usageRows({ tenantId: "t", turnId: "x", meters: { turns: 0, cost_usd: 0 } });
  assert.strictEqual(rows.length, 0);
});

// ─── Quota as a ceiling ──────────────────────────────────────────────────────
test("quota clamps the configured ceiling only when it is lower", () => {
  assert.deepStrictEqual(C.clampCeiling(2, 5), { ceiling: 2, source: "config" });
  assert.deepStrictEqual(C.clampCeiling(2, 0.5), { ceiling: 0.5, source: "quota" });
});
test("an uncapped config takes the quota as its ceiling", () => {
  assert.deepStrictEqual(C.clampCeiling(0, 3), { ceiling: 3, source: "quota" });
});
test("no quota leaves the configured ceiling alone", () => {
  assert.deepStrictEqual(C.clampCeiling(2, null), { ceiling: 2, source: "config" });
  assert.deepStrictEqual(C.clampCeiling(2, undefined), { ceiling: 2, source: "config" });
  assert.deepStrictEqual(C.clampCeiling(2, NaN), { ceiling: 2, source: "config" });
});

// ─── The local plane ─────────────────────────────────────────────────────────
test("an unknown tenant is refused", async () => {
  const dir = tmp(); seed(dir, {});
  const r = await makeLocalPlane({ dir }).authorize({ tenantId: "nobody" });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.code, "no_tenant");
});
test("an inactive entitlement is refused", async () => {
  const dir = tmp(); seed(dir, { acme: { entitled: false } });
  const r = await makeLocalPlane({ dir }).authorize({ tenantId: "acme" });
  assert.strictEqual(r.code, "not_entitled");
});
test("a model outside the plan is refused, and one inside is allowed", async () => {
  const dir = tmp(); seed(dir, { acme: { entitled: true, models: ["crowelm-flash"] } });
  const plane = makeLocalPlane({ dir });
  assert.strictEqual((await plane.authorize({ tenantId: "acme", model: "gpt-5.6-sol" })).code, "model_not_in_plan");
  assert.strictEqual((await plane.authorize({ tenantId: "acme", model: "crowelm-flash" })).allowed, true);
});
test("an empty model allowlist means the plane has no opinion", async () => {
  const dir = tmp(); seed(dir, { acme: { entitled: true, models: [] } });
  assert.strictEqual((await makeLocalPlane({ dir }).authorize({ tenantId: "acme", model: "anything" })).allowed, true);
});
test("remaining quota is reported, and an exhausted one is refused", async () => {
  const dir = tmp(); seed(dir, { acme: { entitled: true, quotaUsd: 1 } });
  const plane = makeLocalPlane({ dir });
  const first = await plane.authorize({ tenantId: "acme" });
  assert.strictEqual(first.remainingUsd, 1);
  await plane.record(usage({ turnId: "a", meters: { cost_usd: 0.75 } }));
  assert.strictEqual((await plane.authorize({ tenantId: "acme" })).remainingUsd, 0.25);
  await plane.record(usage({ turnId: "b", meters: { cost_usd: 0.5 } }));
  const spent = await plane.authorize({ tenantId: "acme" });
  assert.strictEqual(spent.allowed, false);
  assert.strictEqual(spent.code, "quota_exhausted");
});

// ─── Idempotency, the part that is actually about money ──────────────────────
test("recording the same turn twice writes one set of rows", async () => {
  const dir = tmp(); seed(dir, { acme: { entitled: true } });
  const plane = makeLocalPlane({ dir });
  const a = await plane.record(usage());
  const b = await plane.record(usage());
  assert.strictEqual(a.written, 5);
  assert.strictEqual(b.written, 0);
  assert.strictEqual(b.deduped, 5);
  assert.deepStrictEqual(plane.usage("acme"),
    { turns: 1, input_tokens: 100, output_tokens: 50, cost_usd: 0.25, mutations: 1 });
});
test("a replayed event does not move the quota", async () => {
  const dir = tmp(); seed(dir, { acme: { entitled: true, quotaUsd: 1 } });
  const plane = makeLocalPlane({ dir });
  await plane.record(usage({ meters: { cost_usd: 0.4 } }));
  await plane.record(usage({ meters: { cost_usd: 0.4 } }));
  assert.strictEqual((await plane.authorize({ tenantId: "acme" })).remainingUsd, 0.6);
});
test("two different turns are two charges", async () => {
  const dir = tmp(); seed(dir, { acme: { entitled: true } });
  const plane = makeLocalPlane({ dir });
  await plane.record(usage({ turnId: "one", meters: { cost_usd: 0.1 } }));
  await plane.record(usage({ turnId: "two", meters: { cost_usd: 0.1 } }));
  assert.ok(Math.abs(plane.usage("acme").cost_usd - 0.2) < 1e-9);
});
test("a corrupt ledger line is skipped rather than read as a charge", async () => {
  const dir = tmp(); seed(dir, { acme: { entitled: true } });
  const plane = makeLocalPlane({ dir });
  await plane.record(usage({ meters: { cost_usd: 0.1 } }));
  fs.appendFileSync(plane.ledgerFile, "{ not json\n");
  assert.ok(Math.abs(plane.usage("acme").cost_usd - 0.1) < 1e-9);
});

// ─── The outbox ──────────────────────────────────────────────────────────────
test("an event survives a failed delivery and is redelivered", async () => {
  const dir = tmp();
  const box = makeOutbox({ dir });
  box.enqueue(C.usageRows(usage()));
  assert.strictEqual(box.pending(), 5);
  const down = await box.flush(async () => { throw new Error("network"); });
  assert.strictEqual(down.delivered, 0);
  assert.strictEqual(box.pending(), 5);
  const up = await box.flush(async (rows) => rows.map((r) => r.usage_id));
  assert.strictEqual(up.delivered, 5);
  assert.strictEqual(box.pending(), 0);
});
test("a partial acceptance leaves exactly the unaccepted rows queued", async () => {
  const dir = tmp();
  const box = makeOutbox({ dir });
  const rows = C.usageRows(usage());
  box.enqueue(rows);
  const r = await box.flush(async (pending) => pending.slice(0, 2).map((p) => p.usage_id));
  assert.strictEqual(r.delivered, 2);
  assert.strictEqual(r.pending, 3);
});
test("enqueueing the same rows twice queues them once", () => {
  const dir = tmp();
  const box = makeOutbox({ dir });
  box.enqueue(C.usageRows(usage()));
  box.enqueue(C.usageRows(usage()));
  assert.strictEqual(box.pending(), 5);
});
test("the outbox is bounded", () => {
  const dir = tmp();
  const box = makeOutbox({ dir });
  const many = Array.from({ length: box.MAX_PENDING + 50 }, (_, i) => ({ usage_id: `id-${i}`, value: 1 }));
  box.enqueue(many);
  assert.strictEqual(box.pending(), box.MAX_PENDING);
});

// ─── The remote plane ────────────────────────────────────────────────────────
const resp = (status, data) => ({
  status, ok: status < 400,
  headers: { get: () => "application/json" },
  text: async () => JSON.stringify(data),
});

test("a 402 is a refusal that is honoured in both products", async () => {
  for (const requirePlane of [true, false]) {
    const plane = makeRemotePlane({ baseUrl: "https://x", token: "t", dir: tmp(), requirePlane,
      fetchImpl: async () => resp(402, { reason: "quota spent", code: "quota_exhausted" }) });
    const r = await plane.authorize({ tenantId: "acme" });
    assert.strictEqual(r.allowed, false, `requirePlane=${requirePlane}`);
    assert.strictEqual(r.code, "quota_exhausted");
  }
});
test("an unreachable plane fails closed when it is required", async () => {
  const plane = makeRemotePlane({ baseUrl: "https://x", token: "t", dir: tmp(), requirePlane: true,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  const r = await plane.authorize({ tenantId: "acme" });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.code, "unreachable");
});
test("an unreachable plane degrades to allowed when it is not required", async () => {
  const plane = makeRemotePlane({ baseUrl: "https://x", token: "t", dir: tmp(), requirePlane: false,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  const r = await plane.authorize({ tenantId: "acme" });
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.degraded, true);
});
test("a 5xx is an absence of an answer, not a refusal", async () => {
  const closed = makeRemotePlane({ baseUrl: "https://x", token: "t", dir: tmp(), requirePlane: true,
    fetchImpl: async () => resp(503, { detail: "down" }) });
  assert.strictEqual((await closed.authorize({ tenantId: "a" })).code, "unreachable");
  const open = makeRemotePlane({ baseUrl: "https://x", token: "t", dir: tmp(), requirePlane: false,
    fetchImpl: async () => resp(503, { detail: "down" }) });
  assert.strictEqual((await open.authorize({ tenantId: "a" })).allowed, true);
});
test("usage survives a plane that is down and lands when it returns", async () => {
  const dir = tmp();
  let up = false;
  const seen = [];
  const plane = makeRemotePlane({ baseUrl: "https://x", token: "t", dir, requirePlane: true,
    fetchImpl: async (url, init) => {
      if (!up) throw new Error("ECONNREFUSED");
      seen.push(...JSON.parse(init.body).events);
      return resp(200, { accepted: JSON.parse(init.body).events.map((e) => e.usage_id) });
    } });
  const first = await plane.record(usage());
  assert.strictEqual(first.delivered, 0);
  assert.strictEqual(plane.pending(), 5);
  up = true;
  const second = await plane.flush();
  assert.strictEqual(second.delivered, 5);
  assert.strictEqual(plane.pending(), 0);
  assert.strictEqual(new Set(seen.map((s) => s.usage_id)).size, 5);
});
test("a remote call is bounded by a deadline", async () => {
  let sawSignal = false;
  // A real fetch holds a socket open. The fake one does not, and the timer
  // behind AbortSignal.timeout is unref'd, so without this the event loop
  // drains and the process leaves before the deadline ever fires.
  const keepAlive = setInterval(() => {}, 1000);
  const plane = makeRemotePlane({ baseUrl: "https://x", token: "t", dir: tmp(), timeoutMs: 20,
    fetchImpl: async (url, init) => {
      sawSignal = Boolean(init.signal);
      return new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    } });
  try {
    const r = await plane.authorize({ tenantId: "a" });
    assert.strictEqual(sawSignal, true);
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.code, "unreachable");
  } finally { clearInterval(keepAlive); }
});
test("a remote plane with no token refuses when it is required", async () => {
  const plane = makeRemotePlane({ baseUrl: "https://x", token: "", dir: tmp(), requirePlane: true });
  assert.strictEqual((await plane.authorize({ tenantId: "a" })).code, "no_token");
});

// ─── runTurn: the four steps, in one place ───────────────────────────────────
test("no plane runs the turn untouched, with the configured ceiling", async () => {
  let saw = null;
  const r = await runTurn({ plane: null, cfg: { turnBudgetUsd: 2 },
    run: async (a) => { saw = a; return { text: "ok", cost: 0.1 }; } });
  assert.strictEqual(r.authorized, true);
  assert.strictEqual(saw.ceiling, 2);
  assert.strictEqual(saw.ceilingSource, "config");
});
test("a refusal never runs the turn and is journaled", async () => {
  const events = [];
  let ran = false;
  const plane = { authorize: async () => C.DENY("nope", "not_entitled"), record: async () => ({ ok: true }) };
  const r = await runTurn({ plane, cfg: { turnBudgetUsd: 2 }, journal: (e) => events.push(e),
    run: async () => { ran = true; return {}; } });
  assert.strictEqual(ran, false);
  assert.strictEqual(r.authorized, false);
  assert.ok(events.some((e) => e.event_type === "TURN_REFUSED"));
});
test("quota becomes the ceiling the harness enforces", async () => {
  let saw = null;
  const plane = { authorize: async () => C.ALLOW({ remainingUsd: 0.3, plan: "pro" }), record: async () => ({ ok: true }) };
  await runTurn({ plane, cfg: { turnBudgetUsd: 2 }, run: async (a) => { saw = a; return { cost: 0.1 }; } });
  assert.strictEqual(saw.ceiling, 0.3);
  assert.strictEqual(saw.ceilingSource, "quota");
});
test("a turn is metered after it ends, however it ended", async () => {
  const dir = tmp(); seed(dir, { acme: { entitled: true } });
  const plane = makeLocalPlane({ dir });
  await runTurn({ plane, cfg: { turnBudgetUsd: 2 }, identity: { tenantId: "acme" },
    run: async () => ({ stop: "aborted", cost: 0.05, inputTokens: 10, outputTokens: 4, mutations: [] }) });
  const totals = plane.usage("acme");
  assert.strictEqual(totals.turns, 1);
  assert.strictEqual(totals.input_tokens, 10);
  assert.ok(Math.abs(totals.cost_usd - 0.05) < 1e-9);
});
test("the same turn id recorded twice still bills once", async () => {
  const dir = tmp(); seed(dir, { acme: { entitled: true } });
  const plane = makeLocalPlane({ dir });
  const run = async () => ({ cost: 0.2, inputTokens: 5, outputTokens: 5, mutations: [] });
  const a = await runTurn({ plane, cfg: { turnBudgetUsd: 0 }, identity: { tenantId: "acme" }, run });
  await plane.record({ tenantId: "acme", turnId: a.turnId,
    meters: { turns: 1, input_tokens: 5, output_tokens: 5, cost_usd: 0.2 } });
  assert.ok(Math.abs(plane.usage("acme").cost_usd - 0.2) < 1e-9);
});
test("a degraded plane runs the turn and says so in the journal", async () => {
  const events = [];
  const plane = { authorize: async () => C.ALLOW({ degraded: true, reason: "unreachable" }), record: async () => ({ ok: true }) };
  const r = await runTurn({ plane, cfg: { turnBudgetUsd: 1 }, journal: (e) => events.push(e),
    run: async () => ({ text: "ran anyway", cost: 0 }) });
  assert.strictEqual(r.authorized, true);
  assert.ok(events.some((e) => e.event_type === "CONTROL_PLANE_DEGRADED"));
});

// ─── Selection ───────────────────────────────────────────────────────────────
test("the default is no plane at all, so an existing install is unchanged", () => {
  assert.strictEqual(makeControlPlane({}), null);
  assert.strictEqual(makeControlPlane({ mode: "off" }), null);
});
test("local and remote are selected by mode", () => {
  assert.strictEqual(makeControlPlane({ mode: "local", dir: tmp() }).kind, "local");
  assert.strictEqual(makeControlPlane({ mode: "remote", dir: tmp(), baseUrl: "https://x" }).kind, "remote");
});
test("a remote plane defaults to requiring itself; a local one does not", () => {
  assert.strictEqual(makeControlPlane({ mode: "remote", dir: tmp(), baseUrl: "https://x" }).requirePlane, true);
  assert.strictEqual(makeControlPlane({ mode: "local", dir: tmp() }).requirePlane, false);
});

// ─── Runner ──────────────────────────────────────────────────────────────────
(async () => {
  let failures = 0;
  console.log("cloud");
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok   ${t.name}`); }
    catch (e) { failures++; console.log(`  FAIL ${t.name}\n       ${String((e && e.message) || e).split("\n").join("\n       ")}`); }
  }
  console.log(failures ? `\n${failures} of ${tests.length} failed` : `\nall ${tests.length} cloud checks passed`);
  process.exit(failures ? 1 : 0);
})();
