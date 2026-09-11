// The hosted control plane, over HTTP.
//
// Same two calls as the local stub, same answers, same refusals. What it adds
// is everything a network makes true: a bounded deadline on every call, an
// explicit answer when the plane cannot be reached, and an outbox so a usage
// event survives the plane being down.
//
// The asymmetry between the two calls is on purpose. `authorize` happens before
// the turn, so it can fail the turn and the only question is which way it fails
// (see unreachable() in contract.js). `record` happens after, when there is
// nothing left to fail, so it never returns an error the caller has to handle:
// it either lands or it is queued.

const { usageRows, validateUsage, unreachable, DENY, ALLOW } = require("./contract");
const { makeOutbox } = require("./outbox");

const TIMEOUT_MS = 10000;

function makeRemotePlane({ baseUrl, token, dir, requirePlane = true, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const root = String(baseUrl || "").replace(/\/$/, "");
  const outbox = makeOutbox({ dir });

  async function call(pathname, body) {
    // Every call is bounded. An unbounded await on a control plane is how one
    // slow dependency becomes every turn hanging, and it is the same failure
    // the x402 facilitator sync produced: not an error, just never answering.
    const signal = AbortSignal.timeout(timeoutMs);
    const resp = await fetchImpl(`${root}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal,
    });
    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = { detail: text }; }
    return { status: resp.status, ok: resp.ok, data };
  }

  async function authorize(req) {
    if (!token) return requirePlane ? DENY("not signed in", "no_token") : ALLOW({ degraded: true, reason: "not signed in" });
    let r;
    try {
      r = await call("/api/control/authorize", {
        tenant_id: req.tenantId || "", workspace_id: req.workspaceId || "",
        model: req.model || "", turn_id: req.turnId || "",
      });
    } catch (e) {
      return unreachable(requirePlane, String((e && e.message) || e).slice(0, 200));
    }
    // A refusal is an answer, and it is honoured in both products. Only an
    // absence of an answer is subject to the degrade policy.
    if (r.status === 402 || r.status === 403) {
      return DENY(String(r.data.reason || r.data.detail || "the plan does not allow this turn"), String(r.data.code || "denied"));
    }
    if (r.status === 401) return DENY("the token was rejected by the control plane", "unauthorized");
    if (!r.ok) return unreachable(requirePlane, `HTTP ${r.status}`);
    return ALLOW({
      plan: r.data.plan || "",
      remainingUsd: typeof r.data.remaining_usd === "number" ? r.data.remaining_usd : null,
    });
  }

  async function record(usage) {
    const problems = validateUsage(usage);
    if (problems.length) return { ok: false, error: problems.join("; ") };
    const rows = usageRows(usage);
    if (!rows.length) return { ok: true, written: 0 };
    outbox.enqueue(rows);
    return flush();
  }

  async function flush() {
    const result = await outbox.flush(async (pending) => {
      const r = await call("/api/control/usage", { events: pending });
      if (!r.ok) return [];
      // The plane names what it stored. A plane that answers 200 with nothing
      // specific is taken at its word for the whole batch, which is the only
      // reading that does not queue the same rows forever.
      return Array.isArray(r.data.accepted) ? r.data.accepted : pending.map((p) => p.usage_id);
    });
    return { ok: true, ...result };
  }

  return { kind: "remote", authorize, record, flush, pending: outbox.pending, requirePlane };
}

module.exports = { makeRemotePlane, TIMEOUT_MS };
