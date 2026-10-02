// The gateway call, without Electron.
//
// Shape-for-shape the same request main.js makes, and the same tolerance on the
// way back: streaming is decided by the response rather than the request, so a
// gateway build that ignores stream:true answers with JSON and this still works.
// Both branches return the same object, because the harness above does not want
// to know which one happened.
//
// One deliberate difference. The desktop can refresh an expired token because it
// owns the sign-in window. A CLI cannot, so a 401 comes back as a plain error
// telling the caller how to supply a fresh one. Silently continuing unauthorised
// is not a thing to offer.

function makeGateway({ baseUrl, token, fetchImpl = fetch }) {
  const root = String(baseUrl || "").replace(/\/$/, "");

  async function gatewayChat(messages, tools, signal, model, onDelta) {
    if (!token) return { error: "Not signed in. Set CROWE_TOKEN or run with --token." };
    const useModel = model || undefined;
    const t0 = Date.now();
    try {
      const resp = await fetchImpl(`${root}/api/gateway/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: useModel, messages, tools: tools || undefined, stream: onDelta ? true : undefined }),
        signal,
      });
      if (resp.status === 401) {
        return { error: "HTTP 401: the token was rejected. Supply a current one with CROWE_TOKEN or --token." };
      }
      const ctype = String((resp.headers && resp.headers.get && resp.headers.get("content-type")) || "");
      if (resp.ok && onDelta && ctype.includes("text/event-stream") && resp.body) {
        return await readStream(resp, useModel, onDelta, t0);
      }
      const text = await resp.text();
      let data; try { data = JSON.parse(text); } catch { data = { detail: text }; }
      if (!resp.ok) return { error: `HTTP ${resp.status}: ${(data.detail || text)}`.slice(0, 400) };
      return {
        content: data.content || "", tool_calls: data.tool_calls || [],
        model: data.model || useModel, usage: data.usage || {}, elapsedMs: Date.now() - t0,
      };
    } catch (e) {
      return { error: `gateway unreachable: ${String(e).slice(0, 200)}`, aborted: Boolean(e && e.name === "AbortError") };
    }
  }

  async function readStream(resp, useModel, onDelta, t0) {
    let content = "", usage = {}, gotModel = useModel, buf = "";
    const toolCalls = [];
    const handle = (payload) => {
      if (payload === "[DONE]") return;
      let d; try { d = JSON.parse(payload); } catch { return; }
      // Accept the delta in either dialect: OpenAI-style choices[0].delta, or
      // the gateway's own flat shape sliced thin.
      const delta = (d.choices && d.choices[0] && d.choices[0].delta) || d.delta || d;
      const chunk = typeof delta.content === "string" ? delta.content : "";
      if (chunk) { content += chunk; onDelta(chunk); }
      for (const t of delta.tool_calls || []) {
        const i = Number.isInteger(t.index) ? t.index : toolCalls.length;
        const cur = toolCalls[i] || (toolCalls[i] = { id: "", type: "function", function: { name: "", arguments: "" } });
        if (t.id) cur.id = t.id;
        if (t.function && t.function.name) cur.function.name = t.function.name;
        if (t.function && t.function.arguments) cur.function.arguments += t.function.arguments;
      }
      if (d.usage) usage = d.usage;
      if (d.model) gotModel = d.model;
    };
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line.startsWith("data:")) handle(line.slice(5).trim());
      }
    }
    return {
      content, tool_calls: toolCalls.filter(Boolean), model: gotModel,
      usage, elapsedMs: Date.now() - t0, streamed: content.length,
    };
  }

  /* The catalog decides which deployment a role resolves to. It is advisory:
     when it cannot be fetched the harness falls back to its bridge table, so a
     gateway that is briefly unreachable costs routing precision, not the run. */
  async function getCatalog() {
    if (!token) return [];
    try {
      const resp = await fetchImpl(`${root}/api/gateway/catalog`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      const models = Array.isArray(data) ? data : (data.models || data.data || []);
      return Array.isArray(models) ? models : [];
    } catch { return []; }
  }

  return { gatewayChat, getCatalog };
}

module.exports = { makeGateway };
