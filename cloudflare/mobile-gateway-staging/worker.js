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
  { model: "crowelm-kb", label: "CroweLM KB", role: "long-context", featured: true, available: true, gateway_tool_calling: true, min_plan: "free" },
  { model: "crowelm-vision", label: "CroweLM Vision", role: "vision", featured: true, available: true, gateway_tool_calling: true, min_plan: "free" },
  { model: "crowelm-apex", label: "CroweLM Apex", role: "frontier", featured: false, available: true, gateway_tool_calling: true, min_plan: "free" },
  { model: "crowelm-titan", label: "CroweLM Titan", role: "frontier", featured: false, available: true, gateway_tool_calling: true, min_plan: "free" },
  { model: "crowelm-reason", label: "CroweLM Reason", role: "frontier", featured: false, available: true, gateway_tool_calling: true, min_plan: "free" },
  { model: "crowelm-kernel", label: "CroweLM Kernel", role: "frontier", featured: false, available: true, gateway_tool_calling: true, min_plan: "free" },
  { model: "gpt-6-luna", label: "GPT-6 Luna", role: "frontier", featured: false, available: true, gateway_tool_calling: true, min_plan: "pro" },
  { model: "gpt-6-astra", label: "GPT-6 Astra", role: "frontier", featured: false, available: true, gateway_tool_calling: true, min_plan: "pro" },
  { model: "glm-5.3-flash", label: "GLM 5.3 Flash", role: "frontier", featured: false, available: true, gateway_tool_calling: true, min_plan: "pro" },
  { model: "glm-5.3", label: "GLM 5.3", role: "frontier", featured: false, available: true, gateway_tool_calling: true, min_plan: "pro" },
  { model: "deepseek-v4-pro", label: "DeepSeek V4 Pro", role: "frontier", featured: false, available: true, gateway_tool_calling: true, min_plan: "pro" },
  { model: "kimi-k2.7-code", label: "Kimi K2.7 Code", role: "frontier", featured: false, available: true, gateway_tool_calling: true, min_plan: "pro" }
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
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/health" || url.pathname === "/") {
      return json({ ok: true, service: "crowe-mobile-gateway-staging", upstream: "crowe-models-edge", inference_checked: false, production_cutover: false });
    }

    if (url.pathname === "/health/upstream" && request.method === "GET") {
      try {
        const target = new Request("https://crowe-models-edge.internal/health", { method: "GET" });
        const upstream = env.MODELS_EDGE ? await env.MODELS_EDGE.fetch(target) : await fetch(MODEL_EDGE + "/health");
        const body = await upstream.text();
        return new Response(body, { status: upstream.status, headers: { ...CORS, "content-type": upstream.headers.get("content-type") || "application/json" } });
      } catch {
        return json({ ok: false, detail: "The model Worker service binding is unavailable." }, 502);
      }
    }

    if (url.pathname === "/api/gateway/catalog" && request.method === "GET") {
      return json({ models: CATALOG });
    }

    if (url.pathname !== "/api/gateway/chat") return json({ detail: "not found" }, 404);
    if (request.method !== "POST") return json({ detail: "method not allowed" }, 405);

    const authorization = request.headers.get("authorization") || "";
    if (!/^Bearer\s+\S+/i.test(authorization)) {
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
      const upstreamRequest = new Request("https://crowe-models-edge.internal/v1/chat/completions", {
        method: "POST",
        headers: {
          "authorization": authorization,
          "content-type": "application/json",
          "accept": request.headers.get("accept") || (payload.stream ? "text/event-stream" : "application/json")
        },
        body: JSON.stringify(payload),
        redirect: "manual"
      });
      upstream = env.MODELS_EDGE
        ? await env.MODELS_EDGE.fetch(upstreamRequest)
        : await fetch(upstreamUrl, upstreamRequest);
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