// Picking a control plane, and running a turn under it.
//
// The two callers - the desktop's main process and the headless runner - should
// not each grow their own copy of "authorize, clamp the ceiling, run, meter".
// It is four steps and every one of them is a place to be subtly wrong, so it
// lives here once and both call it.

const { makeLocalPlane } = require("./local");
const { makeRemotePlane } = require("./remote");
const { clampCeiling, newTurnId } = require("./contract");

/* Which plane, decided from configuration rather than guessed.

   `controlPlane: "off"` is the current product: no plane, no metering, the
   desktop exactly as it ships today. It is the default precisely because this
   slice must not change what an existing install does. */
function makeControlPlane({ mode = "off", baseUrl, token, dir, requirePlane, fetchImpl } = {}) {
  if (mode === "off") return null;
  if (mode === "local") return makeLocalPlane({ dir, requirePlane: requirePlane === true });
  return makeRemotePlane({ baseUrl, token, dir, requirePlane: requirePlane !== false, fetchImpl });
}

/* One turn under a plane.

   The shape worth noticing is that the plane's quota is not a new gate. It is
   converted into the ceiling the harness already enforces, so a tenant running
   out of quota mid-turn gets the same behaviour as a turn running out of
   budget: the reserve, the closing call, a real answer and a journal line. A
   second, separate quota check would have been a different and worse stop.

   `runTurn` also owns the metering call, because metering that the caller has
   to remember to do is metering that one caller will forget. */
async function runTurn({ plane, identity = {}, cfg, model, run, journal }) {
  const turnId = newTurnId();
  if (!plane) {
    const result = await run({ turnId, ceiling: cfg.turnBudgetUsd, ceilingSource: "config" });
    return { ...result, turnId, authorized: true };
  }

  const decision = await plane.authorize({
    tenantId: identity.tenantId || "local",
    workspaceId: identity.workspaceId || "",
    model, turnId,
  });

  if (!decision.allowed) {
    if (journal) journal({ event_type: "TURN_REFUSED", tool_id: "control-plane", output_summary: `${decision.code}: ${decision.reason}` });
    return { authorized: false, decision, turnId, text: decision.reason };
  }
  if (decision.degraded && journal) {
    journal({ event_type: "CONTROL_PLANE_DEGRADED", output_summary: decision.reason });
  }

  const { ceiling, source } = clampCeiling(cfg.turnBudgetUsd, decision.remainingUsd);
  const result = await run({ turnId, ceiling, ceilingSource: source, plan: decision.plan });

  // Metered from what the turn actually reported, after it ended, whatever way
  // it ended. A turn that was stopped or failed still consumed tokens, and a
  // meter that only counts clean finishes under-bills exactly the runs that
  // cost the most.
  const meters = {
    turns: 1,
    input_tokens: Number(result.inputTokens) || 0,
    output_tokens: Number(result.outputTokens) || 0,
    cost_usd: Number(result.cost) || 0,
    mutations: (result.mutations || []).length,
  };
  const recorded = await plane.record({
    tenantId: identity.tenantId || "local",
    workspaceId: identity.workspaceId || "",
    turnId, meters, model: result.model || model || "",
    plan: decision.plan || "", stop: result.stop || "",
    verdict: result.verdict ? result.verdict.status : "",
  });
  if (journal) {
    journal({ event_type: "USAGE_RECORDED", input_hash: turnId,
      output_summary: recorded.ok ? `$${meters.cost_usd.toFixed(4)} · ${recorded.written || 0} row(s)${recorded.pending ? ` · ${recorded.pending} queued` : ""}` : `not recorded: ${recorded.error}` });
  }

  return { ...result, turnId, authorized: true, decision, ceiling, ceilingSource: source, recorded };
}

module.exports = { makeControlPlane, runTurn, clampCeiling, newTurnId };
