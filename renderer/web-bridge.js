// Web implementation of the `window.crowe` bridge.
//
// The renderer was written against an Electron preload that speaks IPC to a main
// process holding a filesystem, a git checkout, a PTY and a model client. On the
// web only the last of those exists, reached over HTTP. This file provides the
// same object shape so the renderer is COPIED, NEVER FORKED — the same bargain
// mobile/scripts/build-www.js already makes for iOS and Android.
//
// Two rules it follows deliberately:
//
//   1. It never holds a provider credential. Requests go to a same-origin path
//      that the edge authenticates and decorates. A token in browser JavaScript
//      is a token you have published.
//   2. Capabilities that cannot exist in a browser REJECT with a clear reason
//      rather than returning plausible-looking empty data. A silent empty file
//      list reads as "no files"; an explicit refusal reads as what it is.

(function () {
  "use strict";

  // Same-origin. The edge attaches credentials and proxies onward, so nothing
  // secret is reachable from here.
  //
  // GW  is the bare model gateway: routing only, NO retrieval.
  // OWUI is Open WebUI's chat API, which owns the knowledge collections and the
  //      embeddings over them. Chat goes through OWUI so answers come from
  //      Michael's own transcripts rather than from the model's general
  //      training. Going straight to GW is what made it cite Penn State and
  //      Stamets while 69 of his own videos sat unread.
  const GW = "/app/gw/v1";
  const OWUI = "/app/owui/api";
  // Open WebUI is retired across the estate (Michael, 2026-08-28). The probes
  // below are kept for shape but short-circuited: chat, the catalog, and the
  // session store all go straight to the gateway and localStorage without ever
  // sending a request to the OWUI paths.
  const OWUI_RETIRED = true;

  // Attached to every turn. Retrieval is scoped to these rather than to
  // everything, so a cultivation question is not answered out of the Peoria Ford
  // or ToxicTee packs.
  const COLLECTIONS = [
    "823ed7f7-e461-42c7-8df2-ed0402086d05", // Southwest Mushrooms full video library (69)
    "8fc1da01-89e4-49e1-8353-d21d15b5a125", // Southwest Mushrooms video transcripts (15)
    "4308671c-c5ca-48ef-9bff-c685eaeb1bdf", // Crowe Logic Context
  ];

  /* Three answers a capability can give here, and the shape each one takes.

     Rule 2 at the top of this file says a capability the browser cannot have
     refuses with a stated reason. Two things about how it used to refuse were
     wrong, and both were found by running the renderer against it. It
     REJECTED, and the renderer awaits pty.start (renderer.js:724) and fs.list
     (renderer.js:1651) without a catch, so opening a terminal panel on the web
     threw and the panel sat on "starting". The mobile bridge, which the same
     renderer already runs against, resolves with an `error` field in the shape
     each call site reads, and that is the contract kept here now.

     And it stopped at "use the desktop app", when the thing it was refusing
     exists one domain over: Crowe Workspaces is a real streamed Linux desktop
     with a shell, a filesystem and git. So a refusal that a Workspace can
     satisfy carries a `remedy`, an offer to open one, and the renderer shows
     it. A refusal that carries a reason is one field away from carrying a
     remedy; a silent empty array would have had nowhere to put one.

     `remedy` is additive. The desktop never sets it and the renderer only
     reads it when present, so nothing on Electron changes shape. */
  // croweos.com, which this once pointed at, is dark (see web-ui.js), so the
  // default is the web app itself. window.CROWE_WORKSPACES_URL still overrides.
  const WORKSPACES_URL =
    (typeof window !== "undefined" && window.CROWE_WORKSPACES_URL) || "https://crowelogic.com/app";

  // A remedy that opens the page it is shown on is no remedy. When the
  // Workspace URL is this very app (the default, at crowelogic.com/app) the
  // refusal carries none and reads like `unsupported` below.
  const workspaceIsHere = () => {
    try {
      const u = new URL(WORKSPACES_URL, location.href);
      return u.origin === location.origin && location.pathname.startsWith(u.pathname.replace(/\/$/, ""));
    } catch (_) { return false; }
  };

  const workspaceRemedy = (surface) => ({
    kind: "workspace",
    label: "Open in your Workspace",
    url: WORKSPACES_URL,
    detail: `${surface} runs in your Crowe Workspace.`,
  });

  // A refusal a Workspace can satisfy. `shape` is merged in so each call site
  // gets the fields it reads (entries, cwd, repo, ok) alongside the reason.
  const escalate = (surface, shape = {}) => async () => {
    const here = workspaceIsHere();
    return Object.assign({}, shape, {
      error: `${surface} is not available in the browser build. ` +
        (here ? "It needs a local filesystem, shell or OS integration; use the desktop app." : "Open a Workspace to use it."),
    }, here ? {} : { remedy: workspaceRemedy(surface) });
  };

  // A refusal nothing here can satisfy: no remedy, same resolved shape.
  const unsupported = (surface, shape = {}) => async () =>
    Object.assign({}, shape, {
      error: `${surface} is not available in the browser build. It needs a local ` +
        `filesystem, shell or OS integration; use the desktop app.`,
    });

  /* -------------------------------------------------------------- identity */

  // One source of truth for "who did the edge let in", because two of them
  // disagreed. `auth.status()` asked /app/whoami and could report a null user,
  // while `license.status()` returned `authenticated: true` unconditionally —
  // and the renderer decides the "Sign in with your Crowe ID" state from the
  // license one (renderer.js:1098) while the composer reads the auth one
  // (renderer.js:3425). An unreachable /app/whoami therefore produced a signed
  // out composer inside a signed in shell.
  /* Who the edge let in, and what that Crowe ID is entitled to.

     /app/whoami answers JSON once the plan is at the edge: {"email", "tier"},
     where `tier` is the Keycloak `crowe_tier` attribute carried by oauth2-proxy
     as the groups claim and copied onto the request. Before that line is
     applied it answers the bare email as text, and both shapes are read so a
     page served ahead of its edge still knows who is signed in. A tier the
     edge did not state is "" and is reported as unknown, not as free: the edge
     decides what a turn may do (it answers 402), this only decides what to
     say. Vocabulary per crowe-logic-foundry control_plane/plans.py. */
  const PAID_TIERS = ["personal", "pro", "team", "max", "enterprise", "byok"];
  async function whoami() {
    try {
      const r = await fetch("/app/whoami", { headers: { accept: "application/json, text/plain" } });
      if (!r.ok) return { email: "", tier: "" };
      const raw = (await r.text()).trim();
      if (raw.startsWith("{")) {
        try {
          const j = JSON.parse(raw);
          const tier = String(j.tier || "").split(",")[0].trim().toLowerCase();
          return { email: String(j.email || "").trim(), tier };
        } catch (_) { /* not JSON after all; read it as the text shape */ }
      }
      return { email: raw.includes("@") ? raw : "", tier: "" };
    } catch (_) {
      return { email: "", tier: "" };
    }
  }
  const tierLabel = (tier) => (tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : "");

  /* The plan, and the way up.

     The edge answers 402 on the model paths when the signed-in Crowe ID is on
     the free tier. The way up is the estate's one ladder, the crowe-checkout
     Worker: GET /v1/catalog is the price list and the ONLY source of a price
     this build will show; POST /v1/checkout {slug, email} mints a Stripe
     Checkout session whose metadata names the Crowe ID to upgrade; and the
     control plane's Stripe webhook (api.crowelogic.com/api/billing/webhook)
     stamps `crowe_tier` on that account when payment lands. Stripe returns the
     buyer to crowelm.com/welcome, which the edge turns into a fresh sign-in so
     the session carries the new tier. Nothing here touches a card or a key. */
  const CHECKOUT_URL =
    (typeof window !== "undefined" && window.CROWE_CHECKOUT_URL) || "https://crowe-checkout.yellow-block-3adc.workers.dev";
  const PAYWALL_TEXT = "This Crowe ID is on the free plan. Pro unlocks the operator, the rooms and the named agents.";
  function paywall(detail) {
    try { window.dispatchEvent(new CustomEvent("crowe:paywall", { detail: detail || {} })); } catch (_) {}
  }

  // Whether Crowe ID sits at the edge: oauth2-proxy answers /oauth2/auth with
  // 202 (signed in) or 401 (not), and a JSON body or none; a bare Caddy 404
  // means the identity edge has not been applied and basic auth still guards
  // this page. Asked once per load.
  let oidcPromise = null;
  function oidcAtEdge() {
    if (oidcPromise) return oidcPromise;
    oidcPromise = (async () => {
      try {
        const r = await fetch("/oauth2/auth", { headers: { accept: "application/json" }, redirect: "manual" });
        if (r.status === 404 && (!r.headers.get("content-type") || /^caddy/i.test(r.headers.get("server") || ""))) return false;
        return r.status === 202 || r.status === 401 || r.status === 200;
      } catch (_) {
        return false;
      }
    })();
    return oidcPromise;
  }

  /* ---------------------------------------------------------------- events */

  const listeners = [];
  const emit = (ev) => listeners.forEach((fn) => { try { fn(ev); } catch (_) {} });
  const onEvent = (cb) => {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  };

  /* ------------------------------------------------------------- local store */

  const KEY_SESSIONS = "crowe.web.sessions";
  const KEY_CONFIG = "crowe.web.config";

  const readJSON = (k, fallback) => {
    try {
      const raw = localStorage.getItem(k);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  };
  const writeJSON = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {}
  };

  /* Sessions: two stores behind one seam, and a transcript that is actually
     written.

     The first web build created a session on New chat and never wrote a
     message into it, so every thread was "Untitled" with nothing inside and a
     reload lost the conversation. The desktop persists after every run
     (main.js:894, persistSession: title from the first user message, the
     messages plus the answer, one file per session). agentRun does the same
     here now, through `store`.

     `store` is the seam. `localStore` is localStorage: per-browser, stated as
     such. `remoteStore` is Open WebUI's chats API at /app/owui/api/v1/chats,
     which is per-user and follows the person to another device, and which the
     edge does not expose yet: it answers a bare Caddy 404 there today. So the
     seam probes once per page load and takes the remote store only on a clean
     200; anything else is local, exactly as before, and the moment the edge
     line lands the next load is server-side with no change here. Rooms stay
     on the local record for now (their sessions ride the same key), which is
     why the seam is a function and not a swap of `readJSON`.

     The remote record keeps this bridge's own message shape under
     `chat.crowe`, beside the title OWUI reads for its own list, so an OWUI
     upgrade that reshapes its history cannot reach into a Crowe transcript.

     The renderer reads `updatedAt` (renderer.js:1970, 2247, 2296) and formats
     it with `new Date(...)`; OWUI reports seconds, so it is scaled here. Rooms
     share the local key (kind:"room") but are listed by rooms.list, as on the
     desktop where the sessions rail and the rooms rail are two views of one
     directory. */

  const localStore = {
    kind: "local",
    list: async () =>
      readJSON(KEY_SESSIONS, [])
        .filter((s) => s && s.kind !== "room")
        .map(({ id, title, updatedAt, name }) => ({ id, title, updatedAt, name: name || "" })),
    get: async (id) => readJSON(KEY_SESSIONS, []).find((s) => s && s.id === id && s.kind !== "room") || null,
    put: async (record) => {
      const all = readJSON(KEY_SESSIONS, []).filter((s) => !s || s.id !== record.id);
      all.unshift(record);
      writeJSON(KEY_SESSIONS, all.slice(0, 200));
      return record;
    },
    delete: async (id) => {
      writeJSON(KEY_SESSIONS, readJSON(KEY_SESSIONS, []).filter((s) => !s || s.id !== id));
    },
  };

  const remoteStore = {
    kind: "remote",
    list: async () => {
      const r = await fetch(`${OWUI}/v1/chats/?page=1`, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`sessions list ${r.status}`);
      const rows = await r.json();
      return (Array.isArray(rows) ? rows : [])
        // The list endpoint carries no body, so `title` here is name-or-title
        // and the rail shows it as such; load() separates the two.
        .map((c) => ({ id: c.id, title: c.title || "Untitled", name: "", updatedAt: Number(c.updated_at || 0) * 1000 }));
    },
    get: async (id) => {
      const r = await fetch(`${OWUI}/v1/chats/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`session load ${r.status}`);
      const c = await r.json();
      const own = (c.chat && c.chat.crowe) || {};
      return { id: c.id, serverId: c.id, title: own.title || c.title || (c.chat && c.chat.title) || "Untitled",
        name: own.name || "", brief: own.brief || "",
        updatedAt: Number(c.updated_at || 0) * 1000, messages: Array.isArray(own.messages) ? own.messages : [] };
    },
    put: async (record) => {
      // A record with a server id updates in place; without one it is created
      // and takes the id the server minted, which is why put returns the record.
      // OWUI's own list shows `title`, so it gets the name when there is one and
      // the auto title otherwise; the auto title, name and brief all ride in
      // `crowe` so nothing is lost to that choice.
      const chat = {
        title: record.name || record.title,
        crowe: { messages: record.messages, updatedAt: record.updatedAt, title: record.title, name: record.name || "", brief: record.brief || "" },
      };
      const url = record.serverId
        ? `${OWUI}/v1/chats/${encodeURIComponent(record.serverId)}`
        : `${OWUI}/v1/chats/new`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify({ chat }),
      });
      if (!r.ok) throw new Error(`session save ${r.status}`);
      const saved = await r.json();
      return Object.assign({}, record, { id: saved.id || record.serverId, serverId: saved.id || record.serverId });
    },
    delete: async (id) => {
      await fetch(`${OWUI}/v1/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  };

  let storePromise = null;
  function store() {
    if (storePromise) return storePromise;
    storePromise = (async () => {
      try {
        if (OWUI_RETIRED) return localStore;
        const r = await fetch(`${OWUI}/v1/chats/?page=1`, { headers: { accept: "application/json" } });
        if (r.ok && /json/.test(r.headers.get("content-type") || "")) return remoteStore;
      } catch (_) {}
      return localStore;
    })();
    return storePromise;
  }

  // The thread the operator is in, as on the desktop (main.js:1034). Set by
  // sessions.new and sessions.load, consumed by persistSession after a run.
  let currentSession = null;
  const newSessionId = () => "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);

  async function persistSession(messages) {
    if (!messages || !messages.length) return;
    const s = await store();
    const firstUser = messages.find((m) => m.role === "user");
    const title = String((firstUser && firstUser.content) || "Untitled").replace(/\s+/g, " ").slice(0, 60);
    const existing = currentSession ? await s.get(currentSession).catch(() => null) : null;
    // Read-merge-write: the name and the brief were set before this run and
    // must outlive it. A write of {id, title, messages} alone would drop them,
    // which is the one way a session could stop being an agent by being used.
    const record = {
      id: currentSession || newSessionId(),
      serverId: existing && existing.serverId ? existing.serverId : (s.kind === "remote" && existing ? existing.id : undefined),
      title, updatedAt: Date.now(), messages,
      name: (existing && existing.name) || "",
      brief: (existing && existing.brief) || "",
    };
    const saved = await s.put(record);
    currentSession = saved.id;
  }

  /* What a session may be told about itself. A name replaces the auto title in
     the rail; a brief is a standing instruction sent as the first system
     message of every turn in that session (web-bridge agentRun; the desktop
     hands it to the harness as `persona`, the phone as its own system line).
     Allowlisted, so nothing else rides in through this door, and capped, so a
     brief cannot quietly become the whole context window. */
  const SESSION_FIELDS = { name: 80, brief: 4000 };
  function sessionPatch(patch) {
    const out = {};
    for (const key of Object.keys(SESSION_FIELDS)) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
        out[key] = String(patch[key] == null ? "" : patch[key]).slice(0, SESSION_FIELDS[key]);
      }
    }
    return out;
  }

  const sessions = {
    list: async () => {
      const s = await store();
      const rows = await s.list();
      return rows
        .map((row) => Object.assign({}, row, { current: row.id === currentSession }))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
    load: async (id) => {
      const s = await store();
      const rec = await s.get(id);
      if (!rec) return null;
      currentSession = rec.id;
      return { id: rec.id, title: rec.title, name: rec.name || "", brief: rec.brief || "",
        updatedAt: rec.updatedAt, messages: rec.messages || [] };
    },
    // Name and brief for a session, before or after it has any messages. A
    // session that has been created but not yet run has no record; update
    // makes one, so the agent exists before its first turn does.
    update: async (id, patch) => {
      const s = await store();
      const fields = sessionPatch(patch);
      const existing = (await s.get(id).catch(() => null)) || null;
      const record = Object.assign(
        { id, title: "Untitled", updatedAt: Date.now(), messages: [], name: "", brief: "" },
        existing || {},
        fields,
        { updatedAt: Date.now() },
      );
      const saved = await s.put(record);
      // A remote store mints the id on first write; the current thread follows it.
      if (currentSession === id || !currentSession) currentSession = saved.id;
      return { ok: true, id: saved.id, name: saved.name || "", brief: saved.brief || "" };
    },
    // As on the desktop, a new session is an id and nothing else until the
    // first run writes into it; an empty record in the rail is a row that
    // opens onto nothing.
    new: async () => { currentSession = newSessionId(); return { id: currentSession }; },
    delete: async (id) => {
      const s = await store();
      await s.delete(id);
      if (currentSession === id) currentSession = null;
      return true;
    },
  };

  /* ----------------------------------------------------------------- catalog */

  /* Named agents, from the models the edge lets this user see.

     Open WebUI's custom models are already the thing the agent platforms are
     converging on this month: a name, a description that works as a standing
     brief, and the knowledge collections that scope its retrieval. Two of them
     serve paying customers today. What the web build lacked was any way to
     reach them: it listed the bare gateway lanes and pinned retrieval to three
     collection ids written into this file.

     So the catalog asks Open WebUI first and the gateway second. Rows that
     carry `info` are custom models, surfaced with their own name and their
     description in the role column, and marked as agents so a run against one
     sends no `files`: the agent's knowledge IS its scope, and pinning the SWM
     collections on top would answer a Peoria Ford question out of a mushroom
     transcript. Rows without `info` are the plain lanes, and get the pinned
     collections as before.

     Until the edge exposes /app/owui/api/models it answers 404 there, and the
     catalog falls back to the gateway list exactly as it did, so nothing
     regresses while that line waits to be applied. */
  const agentModels = new Set();

  const laneRow = (id) => {
    const display = id
      .replace(/^crowelm-/, "CroweLM ")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return [id, display, /apex|parallel|flash/.test(id), "", true, true];
  };

  // The renderer expects rows of [model, display, featured, role, available, tools].
  async function catalogGet() {
    agentModels.clear();
    try {
      if (OWUI_RETIRED) throw new Error("owui retired");
      const r = await fetch(`${OWUI}/models`, { headers: { accept: "application/json" } });
      if (r.ok) {
        const body = await r.json();
        const rows = (body && body.data) || [];
        if (rows.length) {
          return rows.map((m) => {
            const info = m.info || null;
            if (!info) return laneRow(m.id);
            agentModels.add(m.id);
            const meta = info.meta || {};
            const knowledge = Array.isArray(meta.knowledge) ? meta.knowledge.length : 0;
            const role = String(meta.description || "").trim() || (knowledge ? `Agent over ${knowledge} knowledge collection${knowledge === 1 ? "" : "s"}` : "Agent");
            return [m.id, m.name || m.id, true, role, true, true];
          });
        }
      }
    } catch (_) {
      // Fall through to the gateway list; the reason is the same either way.
    }
    const r = await fetch(`${GW}/models`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`Catalog unavailable (${r.status}).`);
    const body = await r.json();
    return ((body && body.data) || []).map((m) => laneRow(m.id));
  }

  /* -------------------------------------------------------------------- run */

  const controllers = new Map();

  /* One streamed completion against the edge.

     Shared by the operator thread and by every seat in a room, so there is
     exactly one place that knows the wire format, the SSE framing and the
     usage frame. Before rooms this lived inside agentRun; a second copy for the
     room runner would have been the second SSE parser to keep in step, and the
     one this file already had drifted from the gateway's once. Emits nothing
     itself: `onDelta` and the returned usage are the caller's to attribute. */
  /* Whether the edge has opened the Open WebUI path at all.

     It has not, as of 2026-08-15: /app/owui/api/chat/completions answers a bare
     Caddy 404 for every model, while /app/gw/v1/chat/completions answers 200.
     The switch to OWUI for retrieval was made in this file before the line
     that exposes it was applied on the VM, so every chat on the web build has
     failed since. This bridge cannot fix the edge; what it can do is refuse to
     be broken by it. A bare 404 there (no body, no content type: Caddy, not
     OWUI, which answers JSON) marks OWUI as unopened for this page load and
     routes to the gateway, which is the same OpenAI-shaped stream without the
     collections. Retrieval is unscoped on that path and it is said so once in
     the console. The moment the edge line lands, the first call succeeds and
     OWUI carries traffic again with no code change here. */
  let owuiUnopened = OWUI_RETIRED;

  async function streamCompletion({ model, messages, maxTokens, signal, onDelta }) {
    const body = { model, messages, stream: true, max_tokens: maxTokens || 2048 };
    // A named agent carries its own knowledge; pinning the operator's corpus on
    // top would let one customer's question retrieve from another's pack. A
    // plain lane has no scope of its own, so it gets the operator's.
    if (!agentModels.has(model)) {
      body.files = COLLECTIONS.map((cid) => ({ type: "collection", id: cid }));
    }

    const post = (base) =>
      fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });

    // Caddy's own 404 has no content type and names itself in `server`; OWUI's
    // 404 for an unknown model is JSON with a detail. Only the first means the
    // path is unopened.
    const unopened = (r) =>
      r.status === 404 &&
      (!r.headers.get("content-type") || /^caddy/i.test(r.headers.get("server") || ""));

    let res = owuiUnopened ? null : await post(OWUI);
    if (!res || unopened(res)) {
      if (!owuiUnopened) {
        owuiUnopened = true;
        try {
          console.warn(
            "[crowe] The edge has not opened /app/owui/api yet; answering through the gateway " +
              "without the operator's collections. Retrieval is unscoped until that line is applied.",
          );
        } catch (_) {}
      }
      // The gateway ignores `files`; sent anyway so the wire is identical and
      // OWUI picks it up unchanged when it takes over.
      res = await post(GW);
    }

    if (res.status === 402) {
      // The edge refused the turn on the plan, not on the request. Said once
      // in the transcript, and announced so web-ui.js can put the way up
      // next to it.
      let detail = {};
      try { detail = await res.json(); } catch (_) {}
      paywall(detail);
      throw new Error(PAYWALL_TEXT);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Gateway returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }
    if (!res.body) throw new Error("Gateway returned no body.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage = null;
    let text = "";

    const frame = (line) => {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let chunk;
      try { chunk = JSON.parse(payload); } catch (_) { return; }
      if (chunk.usage) usage = chunk.usage;
      const delta = ((chunk.choices || [])[0] || {}).delta || {};
      if (delta.content) {
        text += delta.content;
        if (onDelta) onDelta(delta.content);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush the decoder and read the residue as a last frame. The final
        // event is the one carrying usage, and a stream that ends without a
        // trailing newline would otherwise drop it and report zero tokens.
        buffer += decoder.decode();
        frame(buffer.trim());
        buffer = "";
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // Hold the trailing partial line back so a chunk boundary landing
      // mid-JSON does not throw away a frame.
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        frame(line);
      }
    }

    return {
      text,
      usage: usage
        ? { promptTokens: usage.prompt_tokens || 0, completionTokens: usage.completion_tokens || 0 }
        : null,
    };
  }

  async function agentRun(messages, id = "main", options = {}) {
    const model = options.model || "crowelm-apex";
    const controller = new AbortController();
    controllers.set(id, controller);

    const send = (ev) => emit(Object.assign({ agentId: id }, ev));
    let text = "";

    // The desktop passes the farm's own records on every turn (renderer.js:637,
    // "Every turn carries the farm's own records"). Dropping it silently meant
    // the model answered cultivation questions with no knowledge of this grow.
    const wire = [];
    // The session's standing brief, first, as the harness does with `persona`:
    // who is speaking before what the world looks like.
    if (options.brief) wire.push({ role: "system", content: String(options.brief).slice(0, 4000) });
    if (options.context) {
      wire.push({
        role: "system",
        content:
          "The operator's current cultivation records follow. Prefer them over " +
          "general knowledge when they conflict.\n\n" +
          (typeof options.context === "string"
            ? options.context
            : JSON.stringify(options.context)),
      });
    }
    for (const m of messages) wire.push({ role: m.role, content: m.content });

    try {
      const out = await streamCompletion({
        model,
        messages: wire,
        maxTokens: options.maxTokens,
        signal: controller.signal,
        onDelta: (piece) => { text += piece; send({ type: "assistant_delta", text: piece }); },
      });

      if (out.usage) {
        send({
          type: "telemetry",
          promptTokens: out.usage.promptTokens,
          completionTokens: out.usage.completionTokens,
          cost: 0, // Priced by the gateway's ledger, not guessed here.
        });
      }

      // A 200 that streamed nothing is a real outcome, not an empty answer.
      if (!text) {
        send({ type: "error", text: "The model returned no content." });
        return { text: "" };
      }

      send({ type: "final", text });
      // The operator thread is persisted after every run, as main.js:894 does.
      // Rooms carry their own record and never come through this path with the
      // "main" id. A failed write must not fail a run that already answered.
      if (id === "main") {
        try { await persistSession([...messages, { role: "assistant", content: text }]); } catch (_) {}
      }
      return { text };
    } catch (err) {
      if (err && err.name === "AbortError") return { text, aborted: true };
      send({ type: "error", text: err.message || String(err) });
      throw err;
    } finally {
      // Only retract our OWN registration. An unconditional delete(id) meant a
      // second run started under the same id had its controller removed by the
      // first run finishing, so agent.stop(id) then aborted nothing and the
      // stream ran to completion with no way to interrupt it.
      if (controllers.get(id) === controller) controllers.delete(id);
    }
  }

  /* ------------------------------------------------------------------ rooms */

  // The same engine the desktop runs, bundled by scripts/build-rooms-web.js
  // and loaded by app.html ahead of this file. Absent (an old app.html, or the
  // script failing to load) the rooms surface answers in the shape its caller
  // expects with a stated reason, the contract every refusal in this file keeps.
  const ROOMS = (typeof window !== "undefined" && window.CroweRooms) || null;
  const ROOMS_OFF = "Rooms are unavailable: the room engine did not load in this build.";

  // Rooms ride the sessions store, as they do on the desktop: same key, told
  // apart by kind:"room", so a room written here is a session with a roster.
  const liveRooms = new Map();
  const readRoomRecords = () => readJSON(KEY_SESSIONS, []).filter((s) => s && s.kind === "room" && s.room);
  function saveRoom(room) {
    const all = readJSON(KEY_SESSIONS, []).filter((s) => !s || s.id !== room.id);
    all.unshift(ROOMS.engine.toSession(room));
    writeJSON(KEY_SESSIONS, all.slice(0, 200));
  }
  function loadRoom(id) {
    if (liveRooms.has(id)) return liveRooms.get(id);
    const rec = readRoomRecords().find((s) => s.id === id);
    const room = rec ? ROOMS.engine.fromSession(rec) : null;
    if (room) liveRooms.set(id, room);
    return room;
  }

  // What the renderer is told about a room. Mirrors main.js roomState: the
  // tier is computed rather than stored, and on the web the configured tier is
  // whatever getConfig reports, which is readonly, so Gate 4 holds twice.
  function roomState(room) {
    const cfg = readJSON(KEY_CONFIG, {});
    return {
      id: room.id, title: room.title, template: room.template,
      agents: room.agents.map((a) => {
        const meta = ROOMS.registry.getAgent(a.agentId) || {};
        return { agentId: a.agentId, name: meta.name || a.agentId, domain: meta.domain || "",
          ceiling: meta.autonomyCeiling || "plan", model: a.model, state: a.state,
          cost: room.cost[a.agentId] || { usd: 0, promptTokens: 0, completionTokens: 0, calls: 0 } };
      }),
      defaultAgent: room.defaultAgent,
      tier: ROOMS.engine.roomTier(room, cfg.autonomy || "readonly"),
      budgetUsd: room.budgetUsd, spentUsd: room.spentUsd,
      critiqueRounds: room.critiqueRounds, maxCritiqueRounds: ROOMS.engine.MAX_CRITIQUE_ROUNDS,
      halted: room.halted,
    };
  }

  const roomSeatId = (roomId, agentId) => `room:${roomId}:${agentId}`;

  /* The runner a room's seats call. This is the whole difference between the
     desktop and the web: main.js hands the engine the harness, this hands it
     the edge. Everything the engine decides, addressing, visibility, the
     budget, the critique loop, is untouched.

     Every event a seat produces is stamped with roomId and roomAgent, because
     the renderer's roster (renderer.js:1397) reads seat states off the same
     stream the transcript uses rather than guessing who was addressed. */
  function roomRunner(room) {
    return {
      runAgent: async ({ agentId, model, systemBrief, messages }) => {
        const seatId = roomSeatId(room.id, agentId);
        const controller = new AbortController();
        controllers.set(seatId, controller);
        const send = (ev) => emit(Object.assign({ agentId: seatId, roomId: room.id, roomAgent: agentId }, ev));
        let usage = { usd: 0, promptTokens: 0, completionTokens: 0 };
        try {
          send({ type: "route", model: model || "" });
          const wire = [{ role: "system", content: systemBrief }, ...messages];
          const out = await streamCompletion({
            model: model || "crowelm-apex",
            messages: wire,
            signal: controller.signal,
            onDelta: (piece) => send({ type: "assistant_delta", text: piece }),
          });
          if (out.usage) {
            usage = { usd: 0, promptTokens: out.usage.promptTokens, completionTokens: out.usage.completionTokens };
            send({ type: "telemetry", promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, cost: 0 });
          }
          if (!out.text) { send({ type: "error", text: "The model returned no content." }); return { text: "", error: "empty answer", usage }; }
          send({ type: "final", text: out.text });
          return { text: out.text, usage };
        } catch (err) {
          if (err && err.name === "AbortError") { send({ type: "stopped" }); return { stopped: true, usage }; }
          send({ type: "error", text: (err && err.message) || String(err) });
          return { text: "", error: (err && err.message) || String(err), usage };
        } finally {
          if (controllers.get(seatId) === controller) controllers.delete(seatId);
        }
      },
    };
  }

  async function runRoomTurn(id, fn) {
    const room = loadRoom(id);
    if (!room) return { error: "no such room" };
    room.tier = ROOMS.engine.roomTier(room, readJSON(KEY_CONFIG, {}).autonomy || "readonly");
    const out = await fn(room, roomRunner(room));
    saveRoom(room);
    return Object.assign({}, out, { room: roomState(room) });
  }

  const rooms = ROOMS
    ? {
        agents: async () => ({ agents: ROOMS.registry.listAgents(), templates: ROOMS.registry.listTemplates() }),
        list: async () =>
          readRoomRecords()
            .map((d) => ({ id: d.id, title: d.title, updatedAt: d.updatedAt, template: d.room.template || "",
              agents: (d.room.agents || []).map((a) => a.agentId), spentUsd: d.room.spentUsd || 0, halted: d.room.halted || "" }))
            .sort((a, b) => b.updatedAt - a.updatedAt),
        create: async ({ template = "", title = "", agentIds = [], budgetUsd } = {}) => {
          const room = template
            ? ROOMS.engine.fromTemplate(template, { title, budgetUsd })
            : ROOMS.engine.createRoom({ title, agentIds, budgetUsd });
          if (!room || !room.agents.length) return { error: "a room needs at least one agent from the registry" };
          liveRooms.set(room.id, room);
          saveRoom(room);
          return { room: roomState(room) };
        },
        load: async (id) => {
          const room = loadRoom(id);
          return room ? { room: roomState(room), messages: room.messages } : { error: "no such room" };
        },
        delete: async (id) => {
          liveRooms.delete(id);
          writeJSON(KEY_SESSIONS, readJSON(KEY_SESSIONS, []).filter((s) => !s || s.id !== id));
          return { ok: true };
        },
        join: async (id, agentId) => {
          const room = loadRoom(id); if (!room) return { error: "no such room" };
          if (!ROOMS.registry.getAgent(agentId)) return { error: "no such agent" };
          if (!ROOMS.registry.isJoinable(agentId)) return { error: "that agent has been retired from rooms" };
          if (room.agents.some((a) => a.agentId === agentId)) return { room: roomState(room) };
          room.agents.push({ agentId, model: (ROOMS.registry.getAgent(agentId) || {}).model || "", state: "idle" });
          if (!room.defaultAgent) room.defaultAgent = agentId;
          saveRoom(room);
          return { room: roomState(room) };
        },
        leave: async (id, agentId) => {
          const room = loadRoom(id); if (!room) return { error: "no such room" };
          room.agents = room.agents.filter((a) => a.agentId !== agentId);
          if (room.defaultAgent === agentId) room.defaultAgent = room.agents[0] ? room.agents[0].agentId : "";
          saveRoom(room);
          return { room: roomState(room) };
        },
        setAgentModel: async (id, agentId, model) => {
          const room = loadRoom(id); if (!room) return { error: "no such room" };
          const seat = room.agents.find((a) => a.agentId === agentId);
          if (!seat) return { error: "that agent is not in this room" };
          seat.model = String(model || "");
          saveRoom(room);
          return { room: roomState(room) };
        },
        say: async (id, text) => runRoomTurn(id, (room, deps) => ROOMS.engine.speak(room, String(text || ""), deps)),
        critique: async (id) => runRoomTurn(id, (room, deps) => ROOMS.engine.critique(room, deps)),
        revise: async (id) => runRoomTurn(id, (room, deps) => ROOMS.engine.revise(room, deps)),
        // Calls rather than dollars, as on the desktop: the price depends on a
        // transcript nobody has generated yet.
        project: async (id, kind = "critique") => {
          const room = loadRoom(id);
          return room ? ROOMS.engine.projectRound(room, kind) : { error: "no such room" };
        },
      }
    : {
        agents: async () => ({ agents: [], templates: [] }),
        list: async () => [],
        create: async () => ({ error: ROOMS_OFF }),
        load: async () => ({ error: ROOMS_OFF }),
        delete: async () => ({ ok: true }),
        join: async () => ({ error: ROOMS_OFF }),
        leave: async () => ({ error: ROOMS_OFF }),
        setAgentModel: async () => ({ error: ROOMS_OFF }),
        say: async () => ({ error: ROOMS_OFF }),
        critique: async () => ({ error: ROOMS_OFF }),
        revise: async () => ({ error: ROOMS_OFF }),
        project: async () => ({ calls: 0, agents: 0, note: ROOMS_OFF }),
      };

  /* ----------------------------------------------------------------- config */

  // Only these may be written. An allowlist rather than a denylist because the
  // failure it prevents is silent: `setConfig` used to Object.assign the whole
  // patch into localStorage, so `setConfig({ token })` published a credential
  // into browser storage — the exact thing rule 1 at the top of this file says
  // this bridge never does. A denylist would have to be updated every time a
  // new secret-bearing key is invented; this refuses everything not named.
  const WRITABLE = [
    "theme", "model", "autonomy", "onboarded",
    "autoApprove", "approvals", "turnBudgetUsd", "telemetry",
  ];

  // Mirrors main.js:1017, which is the shape the renderer was written against.
  // It reports `hasToken`, never `token` — the desktop has never handed the
  // renderer a credential and the web build must not be the first to.
  //
  // `baseUrl` is a real value rather than undefined: renderer.js:2267 does
  // `new URL(cfg.baseUrl).host` for the status line, and undefined threw into
  // its catch and rendered the literal string "undefined".
  function projectConfig(c) {
    return {
      baseUrl: location.origin + "/app",
      hasToken: false,
      cwd: "",
      autoApprove: false,
      // "edit" and "execute" claim a filesystem and a shell this build refuses
      // to provide, so the honest default is the one that matches what a
      // browser can actually do.
      autonomy: c.autonomy || "readonly",
      approvals: c.approvals || {},
      verifier: false,
      turnBudgetUsd: c.turnBudgetUsd,
      telemetry: false,
      onboarded: Boolean(c.onboarded),
      mcp: [],
      ptyAvailable: false,
      theme: c.theme || "system",
      model: c.model || "crowelm-apex",
      version: window.CROWE_VERSION || "",
    };
  }

  // Anything the shipped build already wrote stays in that browser's storage
  // until something removes it, and a credential does not expire because the
  // code that stored it was fixed. So the first load after this change drops
  // every key the allowlist does not name, which includes any `token` the
  // previous `Object.assign` persisted.
  (function purgeStoredConfig() {
    const stored = readJSON(KEY_CONFIG, null);
    if (!stored || typeof stored !== "object") return;
    let dropped = false;
    for (const key of Object.keys(stored)) {
      if (!WRITABLE.includes(key)) { delete stored[key]; dropped = true; }
    }
    if (dropped) writeJSON(KEY_CONFIG, stored);
  })();

  /* ----------------------------------------------------------------- expose */

  window.crowe = {
    installSpaces: null,

    agent: {
      run: agentRun,
      stop: async (id = "main") => { controllers.get(id)?.abort(); return true; },
      stopAll: async () => { controllers.forEach((c) => c.abort()); controllers.clear(); return true; },
      onEvent,
    },

    chat: async (messages) => agentRun(messages, "main"),

    // The whole /app surface sits behind edge authentication, so the caller is
    // already authenticated by the time this runs. Rather than invent an
    // identity, this asks the edge who it let in: /app/whoami echoes Caddy's
    // authenticated user. refreshAuth() (renderer.js:3425) reads `user.email`
    // and treats anything falsy as signed out, which is what kept the composer
    // showing "Sign in with your Crowe ID to start".
    /* Sign-in and sign-out, and what they do depends on what the edge is.

       Behind basic auth (today) the browser holds the credential and there is
       nothing for the shell to do: login is a no-op that succeeds, logout is a
       stated refusal. Behind Crowe ID (the identity edge, once applied) the
       sidecar answers /oauth2/auth, and then the shell's "Sign in with Crowe ID"
       button is real: it sends the browser to /oauth2/start with a return to
       this page, and sign-out clears the session cookie at /oauth2/sign_out.
       Which world this is gets asked once per page load, and the answer is read
       the same way the OWUI probe reads it: a bare Caddy 404 means not there. */
    // Web-only. The desktop's license.billing opens the workspace portal; this
    // is the member's own plan and the one ladder, read from the checkout
    // Worker so no price is written into this file.
    billing: {
      plan: async () => {
        const who = await whoami();
        return { email: who.email, tier: who.tier, known: Boolean(who.tier), paid: PAID_TIERS.includes(who.tier) };
      },
      catalog: async () => {
        const r = await fetch(`${CHECKOUT_URL}/v1/catalog`, { headers: { accept: "application/json" } });
        if (!r.ok) return { error: `Catalog unavailable (${r.status}).` };
        return r.json();
      },
      checkout: async (slug = "pro") => {
        const who = await whoami();
        if (!who.email) return { ok: false, error: "Sign in with Crowe ID first, so the upgrade lands on the right account." };
        const r = await fetch(`${CHECKOUT_URL}/v1/checkout`, {
          method: "POST",
          headers: { "Content-Type": "application/json", accept: "application/json" },
          body: JSON.stringify({ slug, email: who.email }),
        });
        let j = {};
        try { j = await r.json(); } catch (_) {}
        if (!r.ok || !j.url) return { ok: false, error: j.error || `Checkout unavailable (${r.status}).` };
        return { ok: true, url: j.url };
      },
    },
    auth: {
      login: async () => {
        if (await oidcAtEdge()) {
          const back = (typeof location !== "undefined" && location.pathname + location.search) || "/app/renderer/app.html";
          if (typeof location !== "undefined") location.assign("/oauth2/start?rd=" + encodeURIComponent(back));
          return { ok: true, redirecting: true };
        }
        return { ok: true };
      },
      logout: async () => {
        if (await oidcAtEdge()) {
          const back = (typeof location !== "undefined" && location.pathname) || "/app/renderer/app.html";
          if (typeof location !== "undefined") location.assign("/oauth2/sign_out?rd=" + encodeURIComponent(back));
          return { ok: true, redirecting: true };
        }
        return {
          ok: false,
          error: "Sign-out is handled by the browser for this deployment. Close the window or clear saved credentials.",
        };
      },
      status: async () => {
        const who = await whoami();
        if (!who.email) return { user: null };
        // `tier` is what the badge prints after the email (renderer.js:3505):
        // the plan name when the edge stated one, nothing when it did not,
        // rather than a word invented here. `plan` and `paid` are for web-ui.js.
        return { user: { email: who.email, tier: tierLabel(who.tier), plan: who.tier, paid: PAID_TIERS.includes(who.tier) } };
      },
    },

    // Shape per renderer.js:1098, which reads `authenticated`, `workspaces[]`
    // and `workspace.agents.allowed`. `allowed` is false on purpose: the agent
    // fleet needs entitlements this build does not have, and reporting it as
    // licensed would unlock buttons that then fail.
    license: {
      // `authenticated` is derived rather than asserted. Hardcoding true here
      // let the shell claim a signed in user while `auth.status()` reported
      // none, which is the disagreement the renderer cannot resolve.
      status: async () => ({
        authenticated: Boolean((await whoami()).email),
        selectedWorkspaceId: "web",
        workspaces: [
          {
            id: "web",
            name: "Web",
            plan_id: "web",
            agents: { allowed: false },
            usage: { agent_jobs: 0 },
          },
        ],
      }),
      billing: unsupported("Billing"),
      select: async () => ({ ok: true, selectedWorkspaceId: "web" }),
    },

    edit: { decide: async () => ({ ok: false }) },
    approval: { decide: async () => ({ ok: false }) },

    // The three a Workspace satisfies. Shapes per call site, as the mobile
    // bridge keeps them: pty.start reads ok/error (renderer.js:724); fs.list
    // iterates entries and reads cwd (renderer.js:1651); git.status reads repo.
    // Arrays stay arrays: a list that answered with an object drew nothing and
    // said nothing.
    pty: {
      start: escalate("The terminal", { ok: false }),
      input: () => {},
      resize: () => {},
      close: async () => ({ ok: true }),
      onData: () => () => {},
    },
    fs: {
      list: escalate("The file browser", { cwd: "", entries: [] }),
      read: escalate("File reading", {}),
      walk: async () => [],
      pick: async () => [],
      readContext: async () => [],
    },
    git: {
      status: escalate("Git", { repo: false, cwd: "" }),
      diff: async () => "",
      stage: escalate("Git", {}), unstage: escalate("Git", {}),
      commit: escalate("Git", {}), log: async () => [], branches: async () => [],
      checkout: escalate("Git", {}), pull: escalate("Git", {}), push: escalate("Git", {}),
    },

    sessions,

    rooms,

    grow: {
      list: async () => [],
      save: unsupported("Cultivation records"),
      delete: unsupported("Cultivation records"),
      export: unsupported("Export"),
    },

    companion: {
      status: async () => ({ running: false }),
      start: unsupported("The phone companion"), stop: unsupported("The phone companion"),
      rotate: unsupported("The phone companion"), devices: async () => [],
      addDevice: unsupported("The phone companion"), revokeDevice: unsupported("The phone companion"),
      audit: async () => [], pairSvg: unsupported("Pairing"),
      onEvent: () => () => {},
    },

    onBrowserNavigate: () => () => {},
    onMenuAction: () => () => {},

    catalog: { get: catalogGet },

    // The renderer reads `status` (renderer.js renderUpdate) and hides the
    // banner for idle, current and dev; anything else shows it. The first web
    // build answered {state:"web"}, a field the renderer never reads, so every
    // page load opened an update banner with no text and a "Later" button.
    // The web build updates by deploy, which is "current" from where the shell
    // stands, and the palette's "Check for updates" says so.
    update: {
      check: async () => ({ status: "current", version: window.CROWE_VERSION || "" }),
      download: unsupported("Updates"), install: unsupported("Updates"),
      state: async () => ({ status: "current", version: window.CROWE_VERSION || "" }),
      onChange: () => () => {},
    },

    plugins: { list: async () => [], enable: unsupported("Plugins"), disable: unsupported("Plugins") },
    keys: {
      list: async () => [],
      set: unsupported("Provider keys"), remove: unsupported("Provider keys"), test: unsupported("Provider keys"),
    },
    operator: { status: async () => ({ running: 0 }), stopAll: async () => true },

    getConfig: async () => projectConfig(readJSON(KEY_CONFIG, {})),
    setConfig: async (patch) => {
      const stored = readJSON(KEY_CONFIG, {});
      for (const key of WRITABLE) {
        if (patch && Object.prototype.hasOwnProperty.call(patch, key)) stored[key] = patch[key];
      }
      writeJSON(KEY_CONFIG, stored);
      return projectConfig(stored);
    },
  };
})();
