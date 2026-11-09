const MODEL_EDGE = "https://models.crowelogic.com";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-expose-headers": "x-crowe-edge, x-crowe-model, x-crowe-upstream-model, x-crowe-principal, x-crowe-id-tier, x-crowe-grounded",
  "access-control-max-age": "86400",
  "cache-control": "no-store"
};

const CATALOG = [
  { model: "crowelm-flash", label: "CroweLM Flash", role: "default", featured: true, available: true, gateway_tool_calling: true, min_plan: "free" },
  { model: "crowelm-grower", label: "CroweLM Grower", role: "cultivation", featured: true, available: true, gateway_tool_calling: true, min_plan: "free" },
  { model: "crowelm-coder", label: "CroweLM Coder", role: "coding", featured: true, available: true, gateway_tool_calling: true, min_plan: "free" },
  { model: "gpt-6-sol", label: "GPT-6 Sol", role: "reasoning", featured: true, available: true, gateway_tool_calling: true, min_plan: "pro" },
  { model: "crowelm-kb", label: "CroweLM Knowledge", role: "long-context", featured: true, available: true, gateway_tool_calling: true, min_plan: "free" },
  { model: "crowelm-vision", label: "CroweLM Vision", role: "vision", featured: true, available: true, gateway_tool_calling: true, min_plan: "free" }
];

function json(body, status = 200, extra = {}) {
  return Response.json(body, { status, headers: { ...CORS, ...extra } });
}

function normalizeCompletion(data, requestedModel) {
  const choice = data?.choices?.[0];
  const message = choice?.message || {};
  return {
    content: typeof message.content === "string" ? message.content : "",
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    model: data?.model || requestedModel || "",
    usage: data?.usage || {}
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/health" || url.pathname === "/") {
      return json({ ok: true, service: "crowe-mobile-gateway-staging", upstream: MODEL_EDGE, production_cutover: false });
    }

    if (url.pathname === "/api/gateway/catalog" && request.method === "GET") {
      return json({ models: CATALOG });
    }

    if (url.pathname !== "/api/gateway/chat") return json({ detail: "not found" }, 404);
    if (request.method !== "POST") return json({ detail: "method not allowed" }, 405);

    const authorization = request.headers.get("authorization") || "";
    if (!/^Bearer\s+\\S+/i.test(authorization)) {
      return json({ detail: "Crowe ID sign-in is required." }, 401);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ detail: "Request body must be valid JSON." }, 400);
    }
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages)) {
      return json({ detail: "A messages array is required." }, 400);
    }

    const upstreamUrl = MODEL_EDGE + "/v1/chat/completions";
    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "authorization": authorization,
          "content-type": "application/json",
          "accept": request.headers.get("accept") || (payload.stream ? "text/event-stream" : "application/json")
        },
        body: JSON.stringify(payload),
        redirect: "manual"
      });
    } catch {
      return json({ detail: "The model gateway could not be reached." }, 502);
    }

    const headers = new Headers(CORS);
    for (const name of ["content-type", "x-crowe-edge", "x-crowe-model", "x-crowe-upstream-model", "x-crowe-principal", "x-crowe-id-tier", "x-crowe-grounded", "retry-after"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }

    const contentType = upstream.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    const raw = await upstream.text();
    let data;
    try { data = JSON.parse(raw); }
    catch { return new Response(JSON.stringify({ detail: raw.slice(0, 1200) || "Model gateway returned an unreadable response." }), { status: upstream.status, headers: { ...Object.fromEntries(headers), "content-type": "application/json; charset=utf-8" } }); }

    if (!upstream.ok) {
      const message = data?.error?.message || data?.message || data?.detail || "Model request failed.";
      return new Response(JSON.stringify({ detail: message, error: data?.error || undefined }), { status: upstream.status, headers: { ...Object.fromEntries(headers), "content-type": "application/json; charset=utf-8" } });
    }

    return new Response(JSON.stringify(normalizeCompletion(data, payload.model)), {
      status: upstream.status,
      headers: { ...Object.fromEntries(headers), "content-type": "application/json; charset=utf-8" }
    });
  }
};