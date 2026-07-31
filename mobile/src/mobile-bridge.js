// Crowe Logic mobile — the bridge the renderer talks to on a phone.
//
// On the desktop, window.crowe is preload.js forwarding IPC to a Node main
// process that owns a workspace: a shell, a file tree, a git checkout, an MCP
// client. None of that exists inside an iOS or Android webview, and pretending
// otherwise is how a port ships a Files pane that lists nothing and a terminal
// that hangs. So this file re-implements the same surface with three honest
// classes of answer:
//
//   real     — the gateway (chat, the agent loop, the catalog), Crowe ID,
//              sessions, the grower's records, provider keys, settings.
//   local    — persisted through Capacitor Preferences instead of userData,
//              so the phone keeps its own sessions and its own grow log.
//   refused  — the workspace capabilities, which return a stated reason
//              rather than an empty success. A pane that says "no shell on
//              iOS" is usable; one that spins forever is not.
//
// Every method keeps the desktop's return shape, because the renderer is
// copied here unmodified and reads those shapes directly. When you change a
// handler in main.js, change its twin here — scripts/test-mobile-bridge.js
// fails the build if the two surfaces drift apart.

(function () {
  "use strict";

  const CAP = window.Capacitor || null;
  const NATIVE = Boolean(CAP && typeof CAP.isNativePlatform === "function" && CAP.isNativePlatform());
  const PLATFORM = (CAP && CAP.getPlatform && CAP.getPlatform()) || "web";
  const plugin = (name) => (CAP && CAP.Plugins && CAP.Plugins[name]) || null;

  const CROWE_ID = "https://id.crowelogic.com/realms/crowe";
  const CROWE_ID_CLIENT = "crowe-cli";
  // The redirect the authorization server sends the code back to. A custom
  // scheme rather than a loopback port: a phone has no localhost the browser
  // and the app agree on, and App.addListener("appUrlOpen") is how the code
  // gets home. Overridable from settings so a build using its own Crowe ID
  // client can point at whatever that client has registered.
  const DEFAULT_REDIRECT = "com.crowelogic.mobile://auth/callback";

  const RATE_IN = 1.25 / 1e6, RATE_OUT = 10 / 1e6;   // same display rates as main.js
  const MAX_ROUNDS = 12;        // half the desktop's: no shell means far shorter loops
  const TOOL_RESULT_MAX = 4000;
  const CONTEXT_BUDGET_CHARS = 120000;

  // ─── Storage ───────────────────────────────────────────────────────────────
  // Preferences on a device, localStorage in a plain browser (`npm run serve`).
  // Both are async here so the caller cannot come to depend on the synchronous
  // one and then break on the platform that is actually shipped.
  const Preferences = plugin("Preferences");
  const store = {
    async get(key) {
      try {
        if (Preferences) { const { value } = await Preferences.get({ key }); return value ? JSON.parse(value) : null; }
        const raw = localStorage.getItem("crowe:" + key);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    },
    async set(key, value) {
      const json = JSON.stringify(value);
      try {
        if (Preferences) await Preferences.set({ key, value: json });
        else localStorage.setItem("crowe:" + key, json);
        return true;
      } catch { return false; }
    },
    async remove(key) {
      try {
        if (Preferences) await Preferences.remove({ key });
        else localStorage.removeItem("crowe:" + key);
      } catch { /* nothing to remove is not a failure */ }
    },
  };

  // ─── Config ────────────────────────────────────────────────────────────────
  // Mirrors DEFAULTS in main.js, minus the fields that describe a workspace.
  // autonomy defaults a tier lower than the desktop's: "edit" there means the
  // agent may write files in a folder you chose, and there is no such folder
  // here — on a phone the only thing it can write is the grow log, which is
  // what the tier now gates.
  const DEFAULTS = {
    baseUrl: "https://api.crowelogic.com",
    model: "crowelm",
    token: "",
    refreshToken: "",
    authRedirect: DEFAULT_REDIRECT,
    autonomy: "edit",
    autoApprove: false,
    approvals: "high-risk",
    verifier: false,          // the verifier is a second full turn; too expensive on cellular by default
    turnBudgetUsd: 2,
    telemetry: true,
    onboarded: false,
    licenseWorkspaceId: "",
    keys: {},
  };
  const TIERS = new Set(["plan", "readonly", "edit", "execute"]);
  let config = { ...DEFAULTS };
  let BUILD = { version: "0.0.0" };

  const ready = (async () => {
    const saved = await store.get("config");
    if (saved && typeof saved === "object") config = { ...DEFAULTS, ...saved };
    if (!TIERS.has(config.autonomy)) config.autonomy = DEFAULTS.autonomy;
    if (!/^https?:\/\//i.test(config.baseUrl || "")) config.baseUrl = DEFAULTS.baseUrl;
    try { BUILD = await (await fetch("build.json")).json(); } catch { /* dev serve without a build stamp */ }
  })();

  async function saveConfig(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === "autonomy" && !TIERS.has(v)) continue;
      if (k === "token" && v === "") continue;        // blank means "keep current", as Settings promises
      config[k] = v;
    }
    await store.set("config", config);
    return config;
  }
  const base = () => String(config.baseUrl || DEFAULTS.baseUrl).replace(/\/$/, "");

  // What the renderer is told about this install. ptyAvailable is false and
  // stays false: it is the flag the terminal pane reads before it tries.
  function publicConfig() {
    return {
      baseUrl: config.baseUrl, hasToken: Boolean(config.token), cwd: "",
      autoApprove: Boolean(config.autoApprove), autonomy: config.autonomy,
      approvals: config.approvals, verifier: Boolean(config.verifier),
      turnBudgetUsd: config.turnBudgetUsd, telemetry: Boolean(config.telemetry),
      onboarded: Boolean(config.onboarded), mcp: [], ptyAvailable: false,
      version: BUILD.version, platform: PLATFORM, mobile: true,
    };
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────────
  /* Two ways out of a Capacitor webview, and the app needs both.

     window.fetch is the real thing: it streams, which is the whole point of a
     token-by-token reply. But the page origin is capacitor://localhost or
     https://localhost, so every gateway call is cross-origin and dies unless
     api.crowelogic.com sends CORS headers back to those origins.

     CapacitorHttp goes through the native HTTP stack, where same-origin policy
     does not apply — and cannot stream, because the plugin hands back one
     finished body.

     So: stream over fetch, and if the network layer itself refuses (which is
     what a blocked preflight looks like from in here — a TypeError, no status),
     repeat the call natively and return it whole. The reply arrives in one
     piece instead of a word at a time, which is a visible downgrade and a
     working app, in that order. */
  const CapHttp = (CAP && CAP.CapacitorHttp) || plugin("CapacitorHttp");
  function corsBlocked(e) {
    return e instanceof TypeError || /Failed to fetch|Load failed|NetworkError|CORS/i.test(String(e || ""));
  }
  async function nativePost(url, headers, body) {
    if (!CapHttp) return null;
    const res = await CapHttp.request({ url, method: "POST", headers, data: body, responseType: "text" });
    const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? "");
    return { ok: res.status >= 200 && res.status < 300, status: res.status, text };
  }

  // ─── Crowe ID ──────────────────────────────────────────────────────────────
  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  function decodeJwt(t) {
    try {
      const part = String(t).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(decodeURIComponent(escape(atob(part))));
    } catch { return {}; }
  }
  function currentUser() {
    if (!config.token) return null;
    const p = decodeJwt(config.token);
    return { email: p.email || p.preferred_username || "", name: p.name || p.given_name || "",
             tier: p.crowe_tier || p.tier || "", exp: p.exp || 0 };
  }
  async function tokenRequest(params) {
    const body = new URLSearchParams(params).toString();
    const url = `${CROWE_ID}/protocol/openid-connect/token`;
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    try {
      const r = await fetch(url, { method: "POST", headers, body });
      return JSON.parse(await r.text() || "{}");
    } catch (e) {
      if (!corsBlocked(e)) return { error: String(e).slice(0, 200) };
      const r = await nativePost(url, headers, body);
      if (!r) return { error: "sign-in could not reach Crowe ID" };
      try { return JSON.parse(r.text || "{}"); } catch { return { error: `HTTP ${r.status}` }; }
    }
  }
  let refreshing = null;
  async function refreshToken() {
    if (!config.refreshToken) return null;
    // One refresh in flight at a time. Two 401s landing together used to send
    // two refreshes, and the second one redeemed a rotated token that the first
    // had already spent — signing the user out mid-turn.
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const d = await tokenRequest({ grant_type: "refresh_token", client_id: CROWE_ID_CLIENT, refresh_token: config.refreshToken });
      if (d && d.access_token) {
        await saveConfig({ token: d.access_token, refreshToken: d.refresh_token || config.refreshToken });
        return d.access_token;
      }
      return null;
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }

  async function signIn() {
    await ready;
    const App = plugin("App"), Browser = plugin("Browser");
    if (!NATIVE || !App || !Browser) {
      return { error: "Sign-in needs the installed app. In a browser, paste a Crowe ID token in Settings." };
    }
    if (!(window.crypto && window.crypto.subtle)) return { error: "This webview has no WebCrypto, so PKCE cannot be used." };

    const verifier = b64url(window.crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = b64url(window.crypto.getRandomValues(new Uint8Array(16)));
    const redirect = config.authRedirect || DEFAULT_REDIRECT;

    return new Promise((resolve) => {
      let settled = false, handle = null, timer = null;
      const finish = async (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (handle) handle.remove(); } catch { /* listener already gone */ }
        try { await Browser.close(); } catch { /* the user may have closed it themselves */ }
        resolve(value);
      };
      // Promise.resolve, not .then() on the return value. The JS packages
      // resolve a handle from addListener, but window.Capacitor.Plugins is the
      // bridge the native side injects, and its proxy returns the handle
      // synchronously. Calling .then() on it throws a TypeError inside this
      // executor, which rejects sign-in before Browser.open is ever reached —
      // the browser simply never appears. Promise.resolve takes both shapes.
      Promise.resolve(App.addListener("appUrlOpen", async ({ url }) => {
        if (!url || url.indexOf(redirect) !== 0) return;    // some other deep link
        let params;
        try { params = new URL(url).searchParams; } catch { return finish({ error: "sign-in returned an unreadable URL" }); }
        const code = params.get("code");
        if (params.get("state") !== state) return finish({ error: "sign-in was cancelled" });
        if (!code) return finish({ error: params.get("error_description") || params.get("error") || "sign-in was cancelled" });
        const d = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirect,
                                       client_id: CROWE_ID_CLIENT, code_verifier: verifier });
        if (d && d.access_token) {
          await saveConfig({ token: d.access_token, refreshToken: d.refresh_token || "" });
          fetchCatalog();
          return finish({ ok: true, user: currentUser() });
        }
        return finish({ error: (d && (d.error_description || d.error)) || "token exchange failed" });
      })).then((h) => { handle = h; if (settled) try { h.remove(); } catch { /* raced with finish */ } });

      const authUrl = `${CROWE_ID}/protocol/openid-connect/auth?` + new URLSearchParams({
        client_id: CROWE_ID_CLIENT, response_type: "code", scope: "openid profile email offline_access",
        redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: "S256",
      }).toString();
      Browser.open({ url: authUrl, presentationStyle: "popover" }).catch((e) => finish({ error: String(e).slice(0, 160) }));
      timer = setTimeout(() => finish({ error: "sign-in timed out" }), 300000);
    });
  }

  async function licensedFetch(route, method = "GET") {
    await ready;
    if (!config.token) return { status: 401, data: null };
    const call = async () => {
      const url = `${base()}${route}`;
      const headers = { Authorization: `Bearer ${config.token}` };
      try {
        const r = await fetch(url, { method, headers });
        return { status: r.status, text: await r.text() };
      } catch (e) {
        if (!corsBlocked(e) || !CapHttp) throw e;
        const r = await CapHttp.request({ url, method, headers, responseType: "text" });
        return { status: r.status, text: typeof r.data === "string" ? r.data : JSON.stringify(r.data ?? "") };
      }
    };
    try {
      let res = await call();
      if (res.status === 401 && await refreshToken()) res = await call();
      let data = null; try { data = res.text ? JSON.parse(res.text) : null; } catch { data = null; }
      return { status: res.status, data };
    } catch { return { status: 0, data: null }; }
  }

  async function licenseStatus() {
    await ready;
    if (!currentUser()) return { authenticated: false, workspaces: [], selectedWorkspaceId: "" };
    const result = await licensedFetch("/api/workspaces");
    if (result.status >= 400 || !Array.isArray(result.data)) {
      return { authenticated: true, workspaces: [], selectedWorkspaceId: "",
               error: result.status ? `License service returned HTTP ${result.status}` : "License service could not be reached" };
    }
    const workspaces = await Promise.all(result.data.map(async (workspace) => {
      const [entitlement, usage] = await Promise.all([
        licensedFetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/entitlements/agents`),
        licensedFetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/usage`),
      ]);
      return { ...workspace, agents: entitlement.status < 400 ? entitlement.data : { allowed: false },
               usage: usage.status < 400 ? usage.data : null };
    }));
    const configured = config.licenseWorkspaceId;
    const selectedWorkspaceId = workspaces.some((w) => w.id === configured) ? configured : (workspaces[0]?.id || "");
    return { authenticated: true, workspaces, selectedWorkspaceId };
  }

  // A licensed agent is one the Agent Fleet launches against a paid workspace,
  // and main.js refuses to start one without an entitlement. The check has to
  // live on this side of the call too: leaving it out would make the phone the
  // one client that runs them unlicensed.
  async function requireAgentEntitlement(workspaceId) {
    const status = await licenseStatus();
    const id = workspaceId || status.selectedWorkspaceId;
    const workspace = status.workspaces.find((item) => item.id === id);
    return workspace?.agents?.allowed
      ? { ok: true, workspace }
      : { ok: false, error: status.authenticated ? "An active Crowe Agents entitlement is required" : "Sign in with Crowe ID to use licensed agents" };
  }

  // ─── Gateway ───────────────────────────────────────────────────────────────
  async function gatewayChat(messages, tools, signal, model, onDelta, _retried) {
    await ready;
    if (!config.token) return { error: 'Not signed in. Tap "Sign in with Crowe ID" to continue.' };
    const useModel = model || config.model;
    const t0 = Date.now();
    const url = `${base()}/api/gateway/chat`;
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` };
    const body = JSON.stringify({ model: useModel, messages, tools: tools || undefined, stream: onDelta ? true : undefined });
    const done = (data, streamed) => ({
      content: data.content || "", tool_calls: data.tool_calls || [], model: data.model || useModel,
      usage: data.usage || {}, elapsedMs: Date.now() - t0, streamed,
    });

    let resp;
    try {
      resp = await fetch(url, { method: "POST", headers, body, signal });
    } catch (e) {
      if (e && e.name === "AbortError") return { error: "stopped", aborted: true };
      if (!corsBlocked(e)) return { error: `gateway unreachable: ${String(e).slice(0, 200)}` };
      const r = await nativePost(url, headers, JSON.parse(body));
      if (!r) return { error: `gateway unreachable: ${String(e).slice(0, 200)}` };
      if (r.status === 401 && !_retried && await refreshToken()) return gatewayChat(messages, tools, signal, model, onDelta, true);
      let data; try { data = JSON.parse(r.text); } catch { data = { detail: r.text }; }
      if (!r.ok) return { error: `HTTP ${r.status}: ${data.detail || r.text}`.slice(0, 400) };
      return done(data, 0);
    }

    if (resp.status === 401 && !_retried && await refreshToken()) return gatewayChat(messages, tools, signal, model, onDelta, true);

    // Streaming is decided by the response, not the request — same contract as
    // main.js, so a gateway build that answers JSON to stream:true still works.
    if (resp.ok && onDelta && String(resp.headers.get("content-type") || "").includes("text/event-stream") && resp.body) {
      let content = "", usage = {}, gotModel = useModel, buf = "";
      const toolCalls = [];
      const handle = (payload) => {
        if (payload === "[DONE]") return;
        let d; try { d = JSON.parse(payload); } catch { return; }
        const delta = (d.choices && d.choices[0] && d.choices[0].delta) || d.delta || d;
        const chunk = typeof delta.content === "string" ? delta.content : "";
        if (chunk) { content += chunk; onDelta(chunk); }
        for (const t of delta.tool_calls || []) {
          const i = Number.isInteger(t.index) ? t.index : toolCalls.length;
          const cur = toolCalls[i] || (toolCalls[i] = { id: "", type: "function", function: { name: "", arguments: "" } });
          if (t.id) cur.id = t.id;
          if (t.function?.name) cur.function.name = t.function.name;
          if (t.function?.arguments) cur.function.arguments += t.function.arguments;
        }
        if (d.usage) usage = d.usage;
        if (d.model) gotModel = d.model;
      };
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { done: eof, value } = await reader.read();
          if (eof) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (line.startsWith("data:")) handle(line.slice(5).trim());
          }
        }
      } catch (e) {
        if (e && e.name === "AbortError") return { error: "stopped", aborted: true, content, streamed: content.length };
        return { error: `stream broke: ${String(e).slice(0, 160)}`, content, streamed: content.length };
      }
      return { content, tool_calls: toolCalls.filter(Boolean), model: gotModel, usage,
               elapsedMs: Date.now() - t0, streamed: content.length };
    }

    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = { detail: text }; }
    if (!resp.ok) return { error: `HTTP ${resp.status}: ${data.detail || text}`.slice(0, 400) };
    return done(data, 0);
  }

  let catalogCache = { models: [], at: 0 };
  async function fetchCatalog() {
    await ready;
    const url = `${base()}/api/gateway/catalog`;
    try {
      let text;
      try { text = await (await fetch(url)).text(); }
      catch (e) {
        if (!corsBlocked(e) || !CapHttp) throw e;
        const r = await CapHttp.request({ url, method: "GET", responseType: "text" });
        text = typeof r.data === "string" ? r.data : JSON.stringify(r.data ?? "");
      }
      const data = JSON.parse(text);
      if (data && Array.isArray(data.models)) {
        catalogCache = { models: data.models, at: Date.now() };
        store.set("catalog", catalogCache);
      }
    } catch { /* keep the last good catalog; routing falls back to the default model */ }
  }

  // ─── Routing ───────────────────────────────────────────────────────────────
  /* Copied from harness.js rather than imported: the harness is Node — fs, and
     child_process at the top of the file — so it cannot be loaded in here at
     all. The copy is the cost of that, and test-mobile-bridge.js pays it down
     by comparing these regexes against the harness's source, so a role added
     over there fails the build until it is added over here. Route the same way
     or the phone quietly asks a different expert than the desktop does. */
  const ROLE_MATCH = [
    { role: "cultivation", match: /\b(cultivat\w*|mycolog\w*|substrate|myceli\w*|grow(?:er|ing)?|inocula\w*|fruit(?:ing)?|spawn|agar|petri|contaminat\w*|harvest|strain|mushroom|coloniz\w*|sterili[sz]\w*)\b/i },
    { role: "coding", match: /\b(refactor\w*|implement|debug\w*|stack ?trace|compile|pytest|unit test|API endpoint|migration|typescript|rust|golang)\b/i },
    { role: "reasoning", match: /\b(architect\w*|redesign|prove|reason through|algorithm\w*|optimi[sz]e|trade-?off|concurren\w*|race condition|root cause|complexity)\b/i },
    { role: "long-context", match: /\b(summari[sz]e (?:this|the (?:whole|entire))|entire (?:repo|codebase|document|file)|long document|across all files)\b/i },
  ];
  const ROUTED_ROLES = ["cultivation", "coding", "reasoning", "long-context"];
  const BRIDGE_ROLE_MODEL = { cultivation: "crowelm-grower", reasoning: "Kimi-K2.5" };
  const classifyRole = (text) => (ROLE_MATCH.find((r) => r.match.test(text)) || { role: "default" }).role;
  function catalogModelForRole(role) {
    const m = catalogCache.models.find((x) => x && x.featured && x.available !== false
      && x.gateway_tool_calling !== false && x.role === role);
    return m ? m.model : null;
  }
  function routeTurn(messages, pin) {
    const dflt = config.model || "crowelm";
    const last = [...(messages || [])].reverse().find((m) => m && m.role === "user");
    const role = pin && pin !== "default" ? pin : classifyRole(String((last && last.content) || ""));
    if (role === "default") return { expert: "operator", model: dflt, reason: "default operator" };
    const dynamic = catalogModelForRole(role);
    const model = dynamic || BRIDGE_ROLE_MODEL[role] || dflt;
    const src = dynamic ? "catalog" : (BRIDGE_ROLE_MODEL[role] ? "bridge" : "default");
    return { expert: role, model, reason: `${role} · ${src}${pin ? " · pinned" : ""}` };
  }
  function resolveRoles() {
    const dflt = config.model || "crowelm";
    const out = {};
    for (const role of ROUTED_ROLES) {
      const dynamic = catalogModelForRole(role);
      const bridge = BRIDGE_ROLE_MODEL[role];
      out[role] = dynamic ? { model: dynamic, source: "catalog" }
        : bridge ? { model: bridge, source: "bridge" }
        : { model: dflt, source: "default" };
    }
    return out;
  }

  // ─── The grower's records ──────────────────────────────────────────────────
  // Same schema the desktop validates against, wrapped out of grow-schema.js by
  // the www build. Same store semantics too: ids, createdAt/updatedAt, and a
  // refused write rather than a silently dropped field.
  const GROW = window.CROWE_GROW || { GROW_SCHEMA: {}, GROW_TYPES: new Set(), growValidate: () => ({ ok: false, error: "grow schema missing" }) };
  const growKey = (type) => `grow:${type}`;
  async function growRead(type) {
    if (!GROW.GROW_TYPES.has(String(type || ""))) return [];
    return (await store.get(growKey(type))) || [];
  }
  async function growWrite(type, record) {
    const t = String(type || "");
    if (!GROW.GROW_TYPES.has(t)) return { ok: false, error: "unknown record type" };
    const rows = await growRead(t);
    const rec = { ...(record || {}) };
    const now = Date.now();
    if (rec.id) {
      const i = rows.findIndex((r) => r && r.id === rec.id);
      if (i < 0) return { ok: false, error: "no such record" };
      rows[i] = { ...rows[i], ...rec, updatedAt: now };
    } else {
      rec.id = "g-" + now.toString(36) + "-" + Math.random().toString(36).slice(2, 7);
      rec.createdAt = now; rec.updatedAt = now;
      rows.push(rec);
    }
    if (!await store.set(growKey(t), rows)) return { ok: false, error: "the record could not be saved to this device" };
    return { ok: true, id: rec.id, record: rows.find((r) => r.id === rec.id) };
  }

  // ─── Tools ─────────────────────────────────────────────────────────────────
  /* The desktop offers ten tools, eight of which are a workspace: shell, read,
     edit, write, search, list. Handing those to the model here and answering
     every call with "not available" would burn a round per attempt and teach it
     nothing. So the phone advertises only what it can actually do, and the
     system prompt says so in the first line. */
  function growToolSpec() {
    const types = Object.entries(GROW.GROW_SCHEMA).map(([t, def]) =>
      `${t} (${def.what}): ${def.fields.map((f) => `${f.k} — ${f.d}`).join("; ")}`).join("\n");
    return {
      type: "function",
      function: {
        name: "log_grow",
        description: `Write a record into the grower's own log on this device. Types and their fields:\n${types}\nPass id to correct an existing row.`,
        parameters: {
          type: "object",
          properties: {
            type: { type: "string", enum: Object.keys(GROW.GROW_SCHEMA), description: "which record type" },
            record: { type: "object", description: "the fields for this record" },
          },
          required: ["type", "record"],
        },
      },
    };
  }
  const READ_GROW = {
    type: "function",
    function: {
      name: "read_grow",
      description: "Read back rows the grower has logged on this device, newest first. Use it before answering anything about this farm's own blocks, flushes, contamination, environment, strains, recipes or journal.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", description: "record type: blocks, flushes, contam, env, strains, recipes, log" },
          limit: { type: "number", description: "how many rows, default 20" },
        },
        required: ["type"],
      },
    },
  };
  const OPEN_URL = {
    type: "function",
    function: {
      name: "open_url",
      description: "Open a web page for the user, in the phone's in-app browser.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  };

  // The tier the user picked in the composer decides whether the model may
  // write. Plan and Read look at the log; Edit and Execute may add to it.
  const mayWrite = () => config.autonomy === "edit" || config.autonomy === "execute";
  function toolsForTurn() {
    const tools = [READ_GROW, OPEN_URL];
    if (mayWrite() && Object.keys(GROW.GROW_SCHEMA).length) tools.push(growToolSpec());
    return tools;
  }

  async function execTool(name, args) {
    if (name === "read_grow") {
      const rows = await growRead(String(args.type || ""));
      if (!rows.length) return { text: `no ${args.type || "records"} logged on this device yet`, status: "empty" };
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
      const recent = rows.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit);
      return { text: `${rows.length} ${args.type} row(s); showing ${recent.length}:\n${JSON.stringify(recent, null, 1)}`, status: "ok" };
    }
    if (name === "log_grow") {
      if (!mayWrite()) return { text: "blocked: the autonomy tier is read-only. Ask the grower to switch to Edit to log records.", status: "blocked" };
      const v = GROW.growValidate(String(args.type || ""), args.record || {});
      if (!v.ok) return { text: `refused: ${v.error}`, status: "error" };
      const w = await growWrite(args.type, v.record);
      return w.ok
        ? { text: `${args.record && args.record.id ? "corrected" : "logged"} ${args.type} ${w.id}`, status: "ok" }
        : { text: `refused: ${w.error}`, status: "error" };
    }
    if (name === "open_url") {
      const url = String(args.url || "");
      if (!/^https?:\/\//i.test(url)) return { text: "refused: only http(s) URLs can be opened", status: "error" };
      const Browser = plugin("Browser");
      if (Browser) await Browser.open({ url }).catch(() => {});
      else window.open(url, "_blank", "noopener");
      return { text: `opened ${url}`, status: "ok" };
    }
    return { text: `unknown tool ${name}`, status: "error" };
  }

  function systemPrompt(route) {
    const user = currentUser();
    return [
      "You are Crowe Logic, running on the user's phone. This is the mobile app, not the desktop one:",
      "there is no shell, no file tree, no git checkout and no MCP server here. Do not offer to run commands,",
      "read files, or edit code — say plainly that those live in the desktop app, and answer what you can.",
      "",
      "Your tools on this device are the grower's own log (read_grow, and log_grow when the tier allows it)",
      "and open_url. Answers about this farm's blocks, flushes, contamination, rooms, strains, recipes or",
      "journal must come from read_grow, not from memory.",
      "",
      "Write for a small screen held in one hand, often in a grow room: short paragraphs, the answer first,",
      "no long tables, no ASCII diagrams. Give the number or the action before the reasoning.",
      route.expert && route.expert !== "operator" ? `You are answering as the ${route.expert} expert.` : "",
      user && user.email ? `The signed-in user is ${user.email}.` : "",
      `Today is ${new Date().toISOString().slice(0, 10)}.`,
    ].filter(Boolean).join("\n");
  }

  // Keep the conversation inside a phone's patience and the model's window:
  // drop the oldest tool traffic first, since a summary of what a tool said
  // survives in the assistant turn that followed it.
  function compact(messages) {
    let total = messages.reduce((n, m) => n + String(m.content || "").length, 0);
    if (total <= CONTEXT_BUDGET_CHARS) return messages.slice();
    const out = messages.slice();
    for (let i = 0; i < out.length - 6 && total > CONTEXT_BUDGET_CHARS; i++) {
      if (out[i] && out[i].role === "tool") {
        total -= String(out[i].content || "").length;
        out[i] = { ...out[i], content: "[earlier tool result elided to fit the context window]" };
      }
    }
    return out;
  }

  // ─── The agent loop ────────────────────────────────────────────────────────
  const listeners = new Set();
  const emit = (ev) => { for (const fn of listeners) { try { fn(ev); } catch { /* one bad listener must not stop the rest */ } } };
  const runs = new Map();

  async function runAgent(messages, id, opts) {
    await ready;
    const run = { aborted: false, controller: null };
    runs.set(id, run);
    const send = (ev) => emit({ ...ev, agentId: id });
    const meter = { in: 0, out: 0, ms: 0, cost: 0 };
    const budget = Number(config.turnBudgetUsd) > 0 ? Number(config.turnBudgetUsd) : 0;
    let text = "";

    try {
      const route = routeTurn(messages, String(opts.role || ""));
      send({ type: "route", expert: route.expert, model: route.model, reason: route.reason });

      const convo = [{ role: "system", content: systemPrompt(route) }];
      if (opts.context) convo.push({ role: "system", content: `Situation on this device:\n${String(opts.context).slice(0, 8000)}` });
      convo.push(...compact(messages));

      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (run.aborted) { send({ type: "stopped" }); send({ type: "final", note: "stopped" }); return { done: false, text }; }
        if (budget && meter.cost >= budget) {
          send({ type: "budget", spent: meter.cost, ceiling: budget, stage: "answer", stopped: true });
          send({ type: "final", note: "turn budget reached" });
          return { done: true, text };
        }

        run.controller = new AbortController();
        const r = await gatewayChat(convo, toolsForTurn(), run.controller.signal, route.model,
          (chunk) => send({ type: "assistant_delta", text: chunk }));

        if (r.usage || r.elapsedMs) {
          meter.in += r.usage?.prompt_tokens || 0;
          meter.out += r.usage?.completion_tokens || 0;
          meter.ms += r.elapsedMs || 0;
          meter.cost = meter.in * RATE_IN + meter.out * RATE_OUT;
          send({ type: "telemetry", promptTokens: meter.in, completionTokens: meter.out, elapsedMs: meter.ms,
                 tps: r.elapsedMs ? Math.round(((r.usage?.completion_tokens || 0) / r.elapsedMs) * 1000) : 0,
                 lastMs: r.elapsedMs || 0, cost: meter.cost, budget });
        }
        if (r.aborted || run.aborted) { send({ type: "stopped" }); send({ type: "final", note: "stopped" }); return { done: false, text }; }
        if (r.error) { send({ type: "error", text: r.error }); send({ type: "final", note: "the gateway call failed" }); return { done: false, error: r.error, text }; }

        if (r.content) {
          send({ type: "assistant", text: r.content, streamed: Boolean(r.streamed) });
          text += (text ? "\n\n" : "") + r.content;
        }
        const calls = r.tool_calls || [];
        if (!calls.length) { send({ type: "final", note: "answered" }); return { done: true, text }; }

        convo.push({ role: "assistant", content: r.content || "", tool_calls: calls });
        for (const call of calls) {
          if (run.aborted) break;
          const name = call.function?.name || "";
          let args = {};
          try { args = JSON.parse(call.function?.arguments || "{}"); } catch { args = {}; }
          send({ type: "tool_call", name, args });
          const out = await execTool(name, args);
          send({ type: "tool_result", name, result: String(out.text).slice(0, TOOL_RESULT_MAX), status: out.status });
          convo.push({ role: "tool", tool_call_id: call.id || name, name, content: String(out.text).slice(0, TOOL_RESULT_MAX) });
        }
      }
      send({ type: "final", note: `stopped after ${MAX_ROUNDS} rounds` });
      return { done: true, text };
    } finally {
      runs.delete(id);
    }
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────
  let currentSession = null;
  const newSessionId = () => "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  async function sessionIndex() { return (await store.get("sessions")) || []; }
  async function persistSession(messages) {
    if (!messages || !messages.length) return;
    if (!currentSession) currentSession = newSessionId();
    const firstUser = messages.find((m) => m.role === "user");
    const title = String(firstUser?.content || "Untitled").replace(/\s+/g, " ").slice(0, 60);
    const updatedAt = Date.now();
    await store.set(`session:${currentSession}`, { id: currentSession, title, updatedAt, messages });
    const index = (await sessionIndex()).filter((s) => s.id !== currentSession);
    index.unshift({ id: currentSession, title, updatedAt });
    // 200 threads is more history than a phone has any use for, and Preferences
    // is not a database — trimming here keeps the list read cheap.
    const keep = index.slice(0, 200);
    for (const dropped of index.slice(200)) await store.remove(`session:${dropped.id}`);
    await store.set("sessions", keep);
  }

  // ─── Provider keys ─────────────────────────────────────────────────────────
  /* The desktop encrypts these with the OS keychain through safeStorage. There
     is no safeStorage in a webview, so they live in Preferences — which is
     UserDefaults on iOS and SharedPreferences on Android: private to the app
     and included in device backups, but not hardware-encrypted. The Key
     Manager says so on screen rather than implying a vault that is not here. */
  const KEY_PROVIDERS = {
    openai: { label: "OpenAI", url: "https://api.openai.com/v1/models", header: "Bearer" },
    anthropic: { label: "Anthropic", url: "https://api.anthropic.com/v1/models", header: "x-api-key" },
    openrouter: { label: "OpenRouter", url: "https://openrouter.ai/api/v1/models", header: "Bearer" },
    groq: { label: "Groq", url: "https://api.groq.com/openai/v1/models", header: "Bearer" },
  };
  const keyStatus = () => Object.entries(KEY_PROVIDERS).map(([id, spec]) => {
    const entry = (config.keys || {})[id] || {};
    return { id, label: spec.label, configured: Boolean(entry.value), updatedAt: entry.updatedAt || 0,
             testedAt: entry.testedAt || 0, healthy: entry.healthy === true, storage: "device" };
  });

  // ─── Refused capabilities ──────────────────────────────────────────────────
  // One sentence each, naming the platform rather than the symptom, so the pane
  // that renders it can be read as an explanation instead of a bug.
  const NO_WORKSPACE = "There is no workspace on mobile — files, git and the terminal live in the desktop app.";
  const NO_SHELL = "iOS and Android do not let an app run a shell. Use Crowe Logic on the desktop for terminal work.";
  // Built per call, not once: BUILD is filled in by the async boot, and a
  // literal captured at load would report 0.0.0 forever.
  const updateState = () => ({ status: "idle", version: BUILD.version,
    notes: "Updates for the mobile app come from the App Store and Google Play." });

  const terminalStub = () => {
    if (window.Terminal) return;
    window.Terminal = class {
      constructor() { this.cols = 80; this.rows = 24; }
      loadAddon() {}
      open(el) {
        const pre = document.createElement("pre");
        pre.className = "term-stub";
        pre.textContent = NO_SHELL;
        el.appendChild(pre);
      }
      write() {} writeln() {} focus() {} dispose() {} onData() { return { dispose() {} }; }
      onResize() { return { dispose() {} }; }
    };
    window.FitAddon = { FitAddon: class { activate() {} fit() {} dispose() {} } };
  };
  terminalStub();

  // ─── The surface ───────────────────────────────────────────────────────────
  /* Every method below answers with a Promise, because ipcRenderer.invoke does
     and the renderer was written against that. A stub that returned its object
     outright looked correct in isolation and threw
     "…state(...).then is not a function" the moment the update banner asked the
     app for its version — at load, before anything else had a chance to run.

     Rather than remember to mark two dozen one-line stubs async, the rule is
     applied here, once: a method whose name begins with "on" is a subscription
     and must return its unsubscribe function synchronously; everything else is
     a call and comes back as a Promise. */
  function promisify(surface) {
    for (const [group, value] of Object.entries(surface)) {
      if (typeof value === "function") {
        if (!/^on[A-Z]/.test(group)) surface[group] = (...args) => Promise.resolve(value(...args));
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      for (const [name, fn] of Object.entries(value)) {
        if (typeof fn !== "function" || /^on[A-Z]/.test(name)) continue;
        value[name] = (...args) => Promise.resolve(fn(...args));
      }
    }
    return surface;
  }

  const noop = () => () => {};
  window.crowe = promisify({
    // Every space ships on mobile; the phone chrome decides how they are reached.
    installSpaces: null,
    mobile: { platform: PLATFORM, native: NATIVE },

    agent: {
      run: async (messages, id = "main", options = {}) => {
        if (options && options.licensed) {
          const gate = await requireAgentEntitlement(options.workspaceId);
          if (!gate.ok) return { done: false, error: gate.error, text: gate.error };
        }
        const result = await runAgent(messages.slice(), String(id || "main"), options || {});
        if (id === "main") { try { await persistSession([...messages, { role: "assistant", content: result.text || "" }]); } catch { /* history is not worth failing a turn over */ } }
        return { done: Boolean(result.done), text: result.text || "", error: result.error };
      },
      stop: (id = "main") => { const r = runs.get(id); if (r) { r.aborted = true; try { r.controller?.abort(); } catch { /* already finished */ } } return { ok: true }; },
      stopAll: () => { for (const r of runs.values()) { r.aborted = true; try { r.controller?.abort(); } catch { /* already finished */ } } return { ok: true, stopped: runs.size }; },
      onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    },
    chat: async (messages) => gatewayChat(messages, null, undefined, undefined, undefined),

    auth: {
      login: signIn,
      logout: async () => { await saveConfig({ refreshToken: "" }); config.token = ""; await store.set("config", config); return { ok: true }; },
      status: async () => {
        await ready;
        let u = currentUser();
        if (u && u.exp) {
          const expMs = u.exp * 1000, now = Date.now();
          if (expMs < now) { const t = await refreshToken(); u = t ? currentUser() : null; }
          else if (expMs < now + 60000) { refreshToken(); }
        }
        return { user: u };
      },
    },
    license: {
      status: licenseStatus,
      select: async (workspaceId) => {
        if (typeof workspaceId !== "string" || workspaceId.length > 200) return { error: "Invalid workspace" };
        await saveConfig({ licenseWorkspaceId: workspaceId });
        return { ok: true, selectedWorkspaceId: workspaceId };
      },
      billing: async () => {
        const result = await licensedFetch("/api/billing/portal/self", "POST");
        if (result.status >= 400 || !result.data?.url) return { error: "Billing portal is unavailable" };
        let portal; try { portal = new URL(result.data.url); } catch { return { error: "Billing portal returned an unreadable URL" }; }
        if (portal.protocol !== "https:") return { error: "Billing portal returned an unsafe URL" };
        const Browser = plugin("Browser");
        if (Browser) await Browser.open({ url: portal.toString() });
        else window.open(portal.toString(), "_blank", "noopener");
        return { ok: true };
      },
    },

    // No edit or approval gate can fire on this device: the tools that would
    // raise one do not exist here. The methods stay so the renderer's handlers
    // resolve, and answer the only truthful thing.
    edit: { decide: () => ({ ok: false, error: NO_WORKSPACE }) },
    approval: { decide: () => ({ ok: false, error: NO_WORKSPACE }) },

    pty: {
      start: () => ({ error: NO_SHELL }),
      input: () => {}, resize: () => {},
      close: () => ({ ok: true }),
      onData: noop,
    },
    fs: {
      list: () => ({ cwd: "", entries: [], error: NO_WORKSPACE }),
      read: () => ({ error: NO_WORKSPACE }),
      walk: () => [],
      pick: () => [],
      readContext: () => [],
    },
    git: {
      status: () => ({ repo: false, cwd: "", error: NO_WORKSPACE }),
      diff: () => NO_WORKSPACE,
      stage: () => ({ error: NO_WORKSPACE }), unstage: () => ({ error: NO_WORKSPACE }),
      commit: () => ({ error: NO_WORKSPACE }), log: () => [], branches: () => [],
      checkout: () => ({ error: NO_WORKSPACE }), pull: () => ({ error: NO_WORKSPACE }),
      push: () => ({ error: NO_WORKSPACE }),
    },

    sessions: {
      list: async () => (await sessionIndex()).map((s) => ({ ...s, current: s.id === currentSession })),
      load: async (id) => {
        const d = await store.get(`session:${id}`);
        if (!d) return { error: "no such session" };
        currentSession = id;
        return { messages: d.messages || [], title: d.title };
      },
      new: () => { currentSession = newSessionId(); return { id: currentSession }; },
      delete: async (id) => {
        await store.remove(`session:${id}`);
        await store.set("sessions", (await sessionIndex()).filter((s) => s.id !== id));
        if (currentSession === id) currentSession = null;
        return { ok: true };
      },
    },

    grow: {
      list: (type) => growRead(String(type || "")),
      save: (type, record) => {
        const v = GROW.growValidate(String(type || ""), record || {});
        return v.ok ? growWrite(type, v.record) : Promise.resolve({ ok: false, error: v.error });
      },
      delete: async (type, id) => {
        const t = String(type || "");
        if (!GROW.GROW_TYPES.has(t)) return { ok: false, error: "unknown record type" };
        await store.set(growKey(t), (await growRead(t)).filter((r) => r && r.id !== id));
        return { ok: true };
      },
      // The desktop writes a trace to a file the user picks. A phone has no such
      // dialog, so the trace goes to the share sheet — mail it, message it, drop
      // it in Files — and falls back to the clipboard when sharing is refused.
      export: async (name, text) => {
        const Share = plugin("Share");
        if (Share) {
          try { await Share.share({ title: name, text, dialogTitle: "Export lot trace" }); return { ok: true, shared: true }; }
          catch { /* the user dismissed the sheet, or the plugin is not installed */ }
        }
        try { await navigator.clipboard.writeText(text); return { ok: true, copied: true }; }
        catch { return { ok: false, error: "This device would not share or copy the trace." }; }
      },
    },

    onBrowserNavigate: noop,
    onMenuAction: noop,

    catalog: {
      get: async () => {
        await ready;
        if (!catalogCache.models.length) {
          const cached = await store.get("catalog");
          if (cached && Array.isArray(cached.models)) catalogCache = cached;
          fetchCatalog();
        } else if (Date.now() - catalogCache.at > 3600000) fetchCatalog();
        return { models: catalogCache.models, at: catalogCache.at, resolved: resolveRoles(), defaultModel: config.model || "crowelm" };
      },
    },

    /* The store, not electron-updater, decides when this app updates.
       "idle" is the desktop's own word for an app with nothing to report, and
       it is what the update banner checks for before staying hidden — a status
       of its own invention ("store") slipped past every branch in
       renderRefresh() and drew an empty gold banner across the top of the app
       on first launch. The note travels with it for anything that asks. */
    update: {
      check: updateState,
      download: updateState,
      install: updateState,
      state: updateState,
      onChange: noop,
    },

    // Plugins are stdio MCP servers the desktop spawns. A phone cannot spawn a
    // process, so the manifest is not even fetched: an empty list renders the
    // Settings section's own empty state.
    plugins: {
      list: () => [],
      enable: () => ({ error: "Plugins run MCP servers as local processes, which mobile does not allow." }),
      disable: () => ({ ok: true }),
    },

    keys: {
      // { encrypted, providers } — not the bare array keyStatus() returns. The
      // Key Manager reads result.providers, and a list that answered with the
      // array drew the section with its heading, its badge and no rows at all.
      // encrypted is false and says so: Preferences is private app storage, not
      // the OS keychain safeStorage gives the desktop.
      list: async () => { await ready; return { encrypted: false, providers: keyStatus() }; },
      set: async (provider, key) => {
        if (!KEY_PROVIDERS[provider] || typeof key !== "string" || !key.trim()) return { error: "Invalid provider or key" };
        const keys = { ...(config.keys || {}) };
        keys[provider] = { value: key.trim(), updatedAt: Date.now() };
        await saveConfig({ keys });
        return { ok: true, providers: keyStatus() };
      },
      remove: async (provider) => {
        const keys = { ...(config.keys || {}) };
        delete keys[provider];
        await saveConfig({ keys });
        return { ok: true, providers: keyStatus() };
      },
      test: async (provider) => {
        const spec = KEY_PROVIDERS[provider];
        const entry = (config.keys || {})[provider];
        if (!spec || !entry?.value) return { ok: false, error: "no key set" };
        const headers = spec.header === "Bearer"
          ? { Authorization: `Bearer ${entry.value}` }
          : { "x-api-key": entry.value, "anthropic-version": "2023-06-01" };
        try {
          const r = await fetch(spec.url, { headers });
          const healthy = r.ok;
          const keys = { ...(config.keys || {}) };
          keys[provider] = { ...entry, testedAt: Date.now(), healthy };
          await saveConfig({ keys });
          return { ok: healthy, status: r.status, error: healthy ? "" : "Provider rejected the credential", providers: keyStatus() };
        } catch { return { ok: false, error: "the provider could not be reached from this device", providers: keyStatus() }; }
      },
    },

    operator: {
      status: () => ({
        app: "running", agents: runs.size, agentIds: [...runs.keys()],
        terminals: 0, terminalIds: [], mcpServers: 0, mcpTools: 0,
        cwd: "", autonomy: config.autonomy || "edit", version: BUILD.version,
        uptime: Math.round(performance.now() / 1000), platform: PLATFORM,
      }),
      stopAll: () => { for (const r of runs.values()) { r.aborted = true; try { r.controller?.abort(); } catch { /* already finished */ } } return { ok: true }; },
    },

    getConfig: async () => { await ready; return publicConfig(); },
    setConfig: async (patch) => { await ready; await saveConfig(patch || {}); return publicConfig(); },
  });

  /* ─── Boot defaults the renderer reads before mobile-ui.js exists ──────────
     Both of these are localStorage keys renderer.js consults while it builds
     the shell, which is over before the phone chrome loads. Seeded only when
     the user has no preference of their own, so neither one overrides a choice.

     The workspace deck defaults to a terminal — reasonable on a workstation,
     and on a phone it opened the Panels tab onto a dead pane whose toolbar
     offered to restart a shell that had never started. Operator Control is
     what a phone actually wants there: what is running, and the button that
     stops it.

     The rail defaults to open, which on a phone is a drawer across the app.
     Collapsing it here rather than from mobile-ui means it is never painted
     open and then shut in front of the user. */
  try {
    if (!localStorage.getItem("crowe-workspace-panels")) {
      localStorage.setItem("crowe-workspace-panels", JSON.stringify({ layout: "stack", panels: [{ type: "operator" }] }));
    }
    if (!localStorage.getItem("crowe-sidebar")) localStorage.setItem("crowe-sidebar", "collapsed");
  } catch { /* a webview with storage disabled still boots, just without the defaults */ }

  // Warm the catalog so the first Home render has models in it, and so routing
  // is not stuck on the default model for the first turn of the session.
  ready.then(() => { if (config.token) fetchCatalog(); });
})();
