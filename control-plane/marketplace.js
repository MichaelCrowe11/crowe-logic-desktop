// Azure Marketplace: the fulfillment side and the metering side.
//
// Fulfillment is how a subscription becomes an entitlement. A buyer lands on
// the landing page with a token, this resolves the token, activates the
// subscription, and writes a tenant row. Everything after that reads the tenant
// row, so the marketplace is consulted once and never on the critical path.
//
// Metering is how usage becomes money. It is the one place in this system that
// is not idempotent - Microsoft has no derived key to deduplicate against - so
// the ledger's emitted_at column is what stops a retry becoming a second
// charge, and it is set only after the API has answered.

const RESOURCE = "20e940b3-4c77-4b0b-9a53-9e16a1b010a7";  // the marketplace API's audience, fixed
const API = "https://marketplaceapi.microsoft.com/api";
const API_VERSION = "2018-08-31";

// Token acquisition against Entra's client credentials flow. Written out rather
// than pulled from a library because it is twelve lines, and a dependency in
// the billing path is a dependency that can break the billing path.
function makeTokenSource({ tenantId, clientId, clientSecret, fetchImpl = globalThis.fetch, clock = Date.now }) {
  let token = null;
  let until = 0;
  return async function get() {
    // Refreshed a minute early, because a token that expires in flight fails a
    // metering call that will then be retried, and retries here cost money.
    if (token && clock() < until - 60000) return token;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      resource: RESOURCE,
    });
    const res = await fetchImpl(`https://login.microsoftonline.com/${tenantId}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`marketplace token failed: ${res.status}`);
    const json = await res.json();
    token = json.access_token;
    until = clock() + (Number(json.expires_in) || 3600) * 1000;
    return token;
  };
}

function makeMarketplace({ tokenSource, fetchImpl = globalThis.fetch, api = API } = {}) {
  async function call(method, path, body, { timeoutMs = 15000 } = {}) {
    const token = await tokenSource();
    const res = await fetchImpl(`${api}${path}${path.includes("?") ? "&" : "?"}api-version=${API_VERSION}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-ms-requestid": globalThis.crypto.randomUUID(),
        "x-ms-correlationid": globalThis.crypto.randomUUID(),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error bodies happen */ }
    return { ok: res.ok, status: res.status, body: json, text };
  }

  /* The landing page token is single-use and short-lived. This turns it into
     the subscription it stands for.

     Written out instead of going through call() because the token travels in a
     header rather than the body, and bending call() to carry it would make the
     common path stranger to serve the uncommon one. */
  async function resolveToken(marketplaceToken) {
    const token = await tokenSource();
    const res = await fetchImpl(`${api}/saas/subscriptions/resolve?api-version=${API_VERSION}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-ms-marketplace-token": marketplaceToken,
        "x-ms-requestid": globalThis.crypto.randomUUID(),
        "x-ms-correlationid": globalThis.crypto.randomUUID(),
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, body: await res.json() };
  }

  const activate = (subscriptionId, planId, quantity) =>
    call("POST", `/saas/subscriptions/${subscriptionId}/activate`, { planId, quantity });

  const getSubscription = (subscriptionId) =>
    call("GET", `/saas/subscriptions/${subscriptionId}`);

  const acknowledgeOperation = (subscriptionId, operationId, status, planId) =>
    call("PATCH", `/saas/subscriptions/${subscriptionId}/operations/${operationId}`,
      { status, planId });

  /* Report usage. Single events, not the batch endpoint, deliberately.

     The batch endpoint answers per-event but a partial failure inside a batch
     leaves you reconciling which half landed. One event, one answer, one
     emitted_at write is slower and has no ambiguity, and the volumes here are
     nowhere near the rate that would make the tradeoff go the other way. */
  const emitUsage = (event) =>
    call("POST", "/usageEvent", {
      resourceId: event.resourceId,
      quantity: event.quantity,
      dimension: event.dimension,
      effectiveStartTime: event.effectiveStartTime,
      planId: event.planId,
    });

  return { resolveToken, activate, getSubscription, acknowledgeOperation, emitUsage, call };
}

/* Apply a webhook to the tenant table.

   Every branch ends in an entitlement decision, because entitlement is the only
   thing authorize reads. A subscription that is suspended, unsubscribed or
   mid-operation is not entitled; everything else is. Being conservative here
   means an unrecognised action leaves the tenant alone rather than guessing. */
const ENTITLING_STATES = new Set(["Subscribed"]);

async function applyWebhook({ store, event, plans = {} }) {
  const { stored } = await store.recordMarketplaceEvent({
    event_id: event.id,
    subscription_id: event.subscriptionId,
    action: event.action,
    payload: event,
  });
  // Already seen. Delivery is at-least-once and the id is Microsoft's, so this
  // is the same trick the usage ledger uses, applied to a different table.
  if (!stored) return { applied: false, reason: "duplicate" };

  const tenant = await store.tenantBySubscription(event.subscriptionId);
  if (!tenant) {
    await store.markEventProcessed(event.id, "no_tenant");
    return { applied: false, reason: "no_tenant" };
  }

  const action = String(event.action || "");
  let update = null;
  if (action === "Unsubscribe" || action === "Suspend") {
    update = { entitled: false, marketplace_state: action === "Suspend" ? "Suspended" : "Unsubscribed" };
  } else if (action === "Reinstate") {
    update = { entitled: true, marketplace_state: "Subscribed" };
  } else if (action === "ChangePlan") {
    const plan = plans[event.planId] || {};
    update = {
      plan: event.planId || tenant.plan,
      marketplace_plan_id: event.planId || null,
      quota_usd: plan.quotaUsd !== undefined ? plan.quotaUsd : tenant.quota_usd,
      allowed_models: plan.models || tenant.allowed_models,
      entitled: true,
      marketplace_state: "Subscribed",
    };
  } else if (action === "ChangeQuantity" || action === "Renew") {
    update = { entitled: true, marketplace_state: "Subscribed" };
  }

  if (!update) {
    await store.markEventProcessed(event.id, "ignored");
    return { applied: false, reason: "unhandled_action" };
  }

  await store.upsertTenant({ ...tenant, ...update });
  await store.markEventProcessed(event.id, "processed");
  return { applied: true, action, entitled: update.entitled };
}

module.exports = {
  makeMarketplace, makeTokenSource, applyWebhook,
  RESOURCE, API, API_VERSION, ENTITLING_STATES,
};
