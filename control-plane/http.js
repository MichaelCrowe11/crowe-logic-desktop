// The HTTP surface.
//
// Plain node:http, no framework, for the same reason the rest of this repo has
// almost no dependencies: the routes are four, the middleware is none, and a
// framework here would be a supply chain in exchange for syntax.
//
// The two /api/control paths are not free to change. cloud/remote.js already
// calls them with a fixed body shape and reads a fixed answer shape, and a
// shipped desktop client cannot be asked to upgrade in step with the server.
// The contract there is: authorize answers {plan, remaining_usd} or refuses
// with 402/403 {reason, code}; usage answers {accepted:[usage_id,...]}.

const http = require("http");
const { applyWebhook } = require("./marketplace");

const MAX_BODY = 1024 * 1024;  // a usage batch is small; anything larger is not a usage batch

function send(res, status, body, headers = {}) {
  const payload = body === null ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    // This API is called by a desktop client and a CLI, never by a browser
    // origin, so none of these need to be permissive.
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

/* Read a bounded body.

   Bounded because an unbounded read is a memory exhaustion primitive that any
   unauthenticated caller can reach, and this endpoint is on the public
   internet by definition. The socket is destroyed rather than politely
   answered: a client that is 1MB into ignoring the limit is not listening. */
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) { resolve({}); return; }
      try { resolve(JSON.parse(text)); } catch { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}

function makeApp({
  service,
  auth,
  marketplace = null,
  webhookSecret = "",
  plans = {},
  log = () => {},
}) {
  async function route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;
    const method = req.method;

    // Liveness, and deliberately not a database check. A plane that reports
    // unhealthy because Postgres blinked gets restarted by the platform, which
    // does not fix Postgres and does discard warm connections.
    if (method === "GET" && (path === "/health" || path === "/healthz")) {
      return send(res, 200, { ok: true, store: service.store.kind });
    }
    // Readiness, which is where the database check belongs: it takes a replica
    // out of rotation without killing it.
    if (method === "GET" && path === "/ready") {
      try { await service.store.ping(); return send(res, 200, { ok: true }); }
      catch (e) { return send(res, 503, { ok: false, error: String(e.message || e) }); }
    }

    if (method === "POST" && path === "/api/control/authorize") {
      const identity = await auth.identify(req);
      if (!identity) return send(res, 401, { reason: "unauthenticated", code: "unauthorized" });
      const body = await readBody(req);

      /* The credential decides the tenant, not the body.

         A client may name a tenant, and it is only honoured when it is the one
         the credential already proves. Otherwise anyone with a valid key could
         spend someone else's quota by changing a string. */
      const claimed = String(body.tenant_id || "").trim();
      if (claimed && claimed !== identity.tenantId) {
        return send(res, 403, { reason: "the credential does not cover that tenant", code: "tenant_mismatch" });
      }

      const decision = await service.authorize({
        tenantId: identity.tenantId,
        workspaceId: String(body.workspace_id || ""),
        model: String(body.model || ""),
        turnId: String(body.turn_id || ""),
      });

      if (!decision.allowed) {
        log("authorize.deny", { tenant: identity.tenantId, code: decision.code });
        return send(res, service.denyStatus(decision.code), { reason: decision.reason, code: decision.code });
      }
      return send(res, 200, {
        plan: decision.plan,
        // Explicit null rather than an omitted key: the client reads absence as
        // "uncapped", and an omitted key that was meant to be a number is the
        // kind of ambiguity that removes a limit by accident.
        remaining_usd: decision.remainingUsd === null || decision.remainingUsd === undefined
          ? null : Number(decision.remainingUsd),
      });
    }

    if (method === "POST" && path === "/api/control/usage") {
      const identity = await auth.identify(req);
      if (!identity) return send(res, 401, { reason: "unauthenticated", code: "unauthorized" });
      const body = await readBody(req);
      const events = Array.isArray(body.events) ? body.events : [];

      // Same rule as authorize. A usage row is a charge, so a row naming
      // someone else's tenant is dropped rather than stored and argued about
      // later. Dropping is safe: the id is derived, so nothing is lost that a
      // correctly attributed retry would not carry.
      const mine = events.filter((e) => !e.tenant_id || e.tenant_id === identity.tenantId);
      const result = await service.recordUsage(
        mine.map((e) => ({ ...e, tenant_id: identity.tenantId })));

      log("usage.record", { tenant: identity.tenantId, sent: events.length, accepted: result.accepted.length });
      return send(res, 200, { accepted: result.accepted });
    }

    /* The marketplace webhook.

       Unauthenticated in the HTTP sense - Microsoft does not sign these - so
       the payload is treated as a claim and never as a fact. The shared secret
       in the path is a cheap filter against drive-by traffic, and the real
       verification is the GET back to the fulfillment API below. */
    if (method === "POST" && path === "/marketplace/webhook") {
      if (webhookSecret) {
        const given = url.searchParams.get("secret") || req.headers["x-webhook-secret"] || "";
        if (!auth.constantTimeEqual(given, webhookSecret)) return send(res, 404, null);
      }
      let event;
      try { event = await readBody(req); }
      catch { return send(res, 400, { error: "invalid body" }); }
      if (!event || !event.id || !event.subscriptionId) return send(res, 400, { error: "malformed event" });

      /* Confirm the event against the API before acting on it.

         Anyone who learns the URL can POST an "Unsubscribe". Asking Microsoft
         what the subscription actually says turns a forged notification into a
         no-op, and the check is one call on a path that fires a few times per
         customer per year. */
      if (marketplace) {
        const check = await marketplace.getSubscription(event.subscriptionId);
        if (!check.ok) {
          log("webhook.unverified", { id: event.id, status: check.status });
          return send(res, 202, { accepted: false, reason: "unverified" });
        }
      }

      const applied = await applyWebhook({ store: service.store, event, plans });
      if (applied.applied && marketplace && event.operationId) {
        await marketplace.acknowledgeOperation(
          event.subscriptionId, event.operationId, "Success", event.planId);
      }
      log("webhook", { id: event.id, action: event.action, ...applied });
      // 200 regardless of whether it changed anything. A duplicate and an
      // unknown action are both "received and dealt with", and answering
      // anything else asks Microsoft to redeliver something already handled.
      return send(res, 200, { accepted: true, ...applied });
    }

    // Where a buyer arrives from the marketplace. Resolves the one-time token
    // into a subscription and provisions the tenant.
    if (method === "GET" && path === "/marketplace/landing") {
      const token = url.searchParams.get("token");
      if (!token) return send(res, 400, { error: "missing token" });
      if (!marketplace) return send(res, 503, { error: "fulfillment not configured" });

      const resolved = await marketplace.resolveToken(token);
      if (!resolved.ok) return send(res, 400, { error: "token could not be resolved" });
      const sub = resolved.body;
      const plan = plans[sub.planId] || {};

      await service.store.upsertTenant({
        tenant_id: sub.subscription?.beneficiary?.tenantId || sub.id,
        plan: sub.planId || "free",
        entitled: true,
        quota_usd: plan.quotaUsd || 0,
        allowed_models: plan.models || [],
        marketplace_subscription: sub.id,
        marketplace_plan_id: sub.planId,
        marketplace_state: "PendingFulfillmentStart",
      });
      const activated = await marketplace.activate(sub.id, sub.planId, sub.quantity);
      if (activated.ok) {
        await service.store.upsertTenant({
          tenant_id: sub.subscription?.beneficiary?.tenantId || sub.id,
          plan: sub.planId || "free",
          entitled: true,
          quota_usd: plan.quotaUsd || 0,
          allowed_models: plan.models || [],
          marketplace_subscription: sub.id,
          marketplace_plan_id: sub.planId,
          marketplace_state: "Subscribed",
        });
      }
      log("landing", { subscription: sub.id, plan: sub.planId, activated: activated.ok });
      return send(res, 200, { subscription: sub.id, plan: sub.planId, activated: activated.ok });
    }

    return send(res, 404, { error: "not found" });
  }

  // One error boundary around every route. An unhandled rejection inside a
  // request handler takes the process down in Node, and a billing service that
  // exits on a malformed body is a denial of service with extra steps.
  const handler = (req, res) => {
    route(req, res).catch((err) => {
      const bad = /body too large|invalid json/.test(String(err.message));
      log("error", { path: req.url, error: String(err.message || err) });
      if (!res.headersSent) send(res, bad ? 400 : 500, { error: bad ? String(err.message) : "internal error" });
    });
  };

  return { handler, createServer: () => http.createServer(handler) };
}

module.exports = { makeApp, readBody, send, MAX_BODY };
