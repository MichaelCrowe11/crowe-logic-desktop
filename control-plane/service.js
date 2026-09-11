// The hosted control plane's decisions.
//
// This is the same two calls the desktop and the CLI already make against
// cloud/local.js, backed by a database instead of a file. It deliberately
// requires ../cloud/contract.js rather than restating it: the usage id has to
// be derived identically on both sides or idempotency silently stops working,
// and the only reliable way to guarantee that is one file, used by both.
//
// The storage is behind an interface with two implementations, an in-memory one
// and a Postgres one. That is not indirection for its own sake. It means the
// entire decision surface can be tested in CI with no database, while the
// Postgres implementation is held to the identical assertions whenever a real
// server is available.

const { METERS, usageRows, validateUsage, DENY, ALLOW } = require("../cloud/contract");

// Which refusals mean "pay" and which mean "your plan does not include this".
// The client treats 402 and 403 the same way - both are answers, both are
// honoured - but the distinction is what an operator reads in a log, and
// sending 403 for an exhausted wallet would be telling them the wrong thing.
const DENY_STATUS = {
  quota_exhausted: 402,
  no_tenant: 403,
  not_entitled: 403,
  model_not_in_plan: 403,
};
const denyStatus = (code) => DENY_STATUS[code] || 403;

function makeService({ store, clock = () => new Date() }) {
  /* Before the turn: may this tenant run it, and with how much left to spend.

     The order of these checks is the order of the questions, cheapest and most
     absolute first. Every one of them mirrors cloud/local.js, because a hosted
     plane that refused a different set of things than the local one would make
     the local stub a misleading thing to develop against. */
  async function authorize(req) {
    const tenantId = String(req.tenantId || "").trim();
    if (!tenantId) return DENY("a tenant id is required", "no_tenant");

    const tenant = await store.getTenant(tenantId);
    if (!tenant) return DENY(`no entitlement on record for tenant "${tenantId}"`, "no_tenant");
    if (!tenant.entitled) return DENY(`the entitlement for tenant "${tenantId}" is not active`, "not_entitled");

    // An allowlist, when present, is exhaustive; absent means the plane has no
    // opinion about models and routing stays the harness's decision.
    const models = tenant.allowed_models || [];
    if (models.length && req.model && !models.includes(req.model)) {
      return DENY(`the plan for tenant "${tenantId}" does not include model "${req.model}"`, "model_not_in_plan");
    }

    const quota = Number(tenant.quota_usd) || 0;
    if (!quota) return ALLOW({ plan: tenant.plan || "free", remainingUsd: null });

    const spent = await store.spentUsd(tenantId, tenant.quota_period_start);
    const remaining = quota - spent;
    /* An exhausted quota is refused here and never expressed as a ceiling.

       This is the one place where being clever would be a bug. Zero means "no
       ceiling" to the harness, so passing a remaining balance of 0 down as a
       budget would remove the limit at the exact moment it needs to bind. */
    if (remaining <= 0) {
      return DENY(`the $${quota.toFixed(2)} quota for tenant "${tenantId}" is spent`, "quota_exhausted");
    }
    return ALLOW({ plan: tenant.plan || "free", remainingUsd: remaining });
  }

  /* After the turn: what it cost.

     Answers with the ids it durably stored, which is the shape the client's
     outbox asks for. Anything not named stays queued there and is sent again,
     and sending it again is safe because the id is derived. A blanket "ok"
     would break that: the client would drop rows this never wrote. */
  async function recordUsage(events) {
    if (!Array.isArray(events) || !events.length) return { accepted: [] };
    const rows = [];
    const rejected = [];
    for (const ev of events) {
      // Rows arrive pre-flattened from the client (one per meter) but the
      // endpoint also accepts the unflattened form, so a caller that has a
      // usage object does not have to know how it is stored.
      if (ev && ev.usage_id && ev.meter) {
        if (!METERS.includes(ev.meter)) { rejected.push(ev.usage_id); continue; }
        const value = Number(ev.value);
        if (!Number.isFinite(value) || value < 0) { rejected.push(ev.usage_id); continue; }
        rows.push({ ...ev, value, occurred_at: ev.occurred_at || clock().toISOString() });
        continue;
      }
      const problems = validateUsage(ev);
      if (problems.length) continue;
      rows.push(...usageRows(ev));
    }
    if (!rows.length) return { accepted: [], rejected };

    const accepted = await store.insertUsage(rows);
    return { accepted, rejected };
  }

  return { authorize, recordUsage, denyStatus, store };
}

module.exports = { makeService, denyStatus, DENY_STATUS };
