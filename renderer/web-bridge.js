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

  // Attached to every turn. Retrieval is scoped to these rather than to
  // everything, so a cultivation question is not answered out of the Peoria Ford
  // or ToxicTee packs.
  const COLLECTIONS = [
    "823ed7f7-e461-42c7-8df2-ed0402086d05", // Southwest Mushrooms full video library (69)
    "8fc1da01-89e4-49e1-8353-d21d15b5a125", // Southwest Mushrooms video transcripts (15)
    "4308671c-c5ca-48ef-9bff-c685eaeb1bdf", // Crowe Logic Context
  ];

  const unsupported = (surface) => () =>
    Promise.reject(
      new Error(
        `${surface} is not available in the browser build. It needs a local ` +
          `filesystem, shell or OS integration; use the desktop app.`,
      ),
    );

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

  // Sessions live in localStorage rather than on the server. That is a real
  // limitation and it is stated rather than hidden: history is per-browser and
  // does not follow the user to another device. Server-side sessions are the
  // next step, not a missing detail.
  // The renderer reads `updatedAt` (renderer.js:1970, 2247, 2296) and formats it
  // with `new Date(...)`. Returning `at` instead rendered every row as
  // "Invalid Date".
  const sessions = {
    list: async () =>
      readJSON(KEY_SESSIONS, []).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
    load: async (id) => readJSON(KEY_SESSIONS, []).find((s) => s.id === id) || null,
    new: async () => {
      const all = readJSON(KEY_SESSIONS, []);
      const s = { id: `s-${Date.now()}`, title: "Untitled", updatedAt: Date.now(), messages: [] };
      all.unshift(s);
      writeJSON(KEY_SESSIONS, all.slice(0, 200));
      return s;
    },
    delete: async (id) => {
      writeJSON(KEY_SESSIONS, readJSON(KEY_SESSIONS, []).filter((s) => s.id !== id));
      return true;
    },
  };

  /* ----------------------------------------------------------------- catalog */

  // The renderer expects rows of [model, display, featured, role, available, tools].
  async function catalogGet() {
    const r = await fetch(`${GW}/models`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`Catalog unavailable (${r.status}).`);
    const body = await r.json();
    const rows = body.data || [];
    return rows.map((m) => {
      const id = m.id;
      const display = id
        .replace(/^crowelm-/, "CroweLM ")
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      const featured = /apex|parallel|flash/.test(id);
      return [id, display, featured, "", true, true];
    });
  }

  /* -------------------------------------------------------------------- run */

  const controllers = new Map();

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
      const res = await fetch(`${OWUI}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: wire,
          stream: true,
          max_tokens: options.maxTokens || 2048,
          // Scopes retrieval to the operator's own corpus for this turn.
          files: COLLECTIONS.map((cid) => ({ type: "collection", id: cid })),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Gateway returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
      }
      if (!res.body) throw new Error("Gateway returned no body.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let usage = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Hold the trailing partial line back so a chunk boundary landing
        // mid-JSON does not throw away a frame.
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let chunk;
          try { chunk = JSON.parse(payload); } catch (_) { continue; }
          if (chunk.usage) usage = chunk.usage;
          const delta = ((chunk.choices || [])[0] || {}).delta || {};
          if (delta.content) {
            text += delta.content;
            send({ type: "assistant_delta", text: delta.content });
          }
        }
      }

      if (usage) {
        send({
          type: "telemetry",
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          cost: 0, // Priced by the gateway's ledger, not guessed here.
        });
      }

      // A 200 that streamed nothing is a real outcome, not an empty answer.
      if (!text) {
        send({ type: "error", text: "The model returned no content." });
        return { text: "" };
      }

      send({ type: "final", text });
      return { text };
    } catch (err) {
      if (err && err.name === "AbortError") return { text, aborted: true };
      send({ type: "error", text: err.message || String(err) });
      throw err;
    } finally {
      controllers.delete(id);
    }
  }

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
    auth: {
      login: async () => ({ ok: true }),
      logout: async () => ({
        ok: false,
        error: "Sign-out is handled by the browser for this deployment. Close the window or clear saved credentials.",
      }),
      status: async () => {
        let who = "";
        try {
          const r = await fetch("/app/whoami", { headers: { accept: "text/plain" } });
          if (r.ok) who = (await r.text()).trim();
        } catch (_) {}
        return who ? { user: { email: who, tier: "Web" } } : { user: null };
      },
    },

    // Shape per renderer.js:1098, which reads `authenticated`, `workspaces[]`
    // and `workspace.agents.allowed`. `allowed` is false on purpose: the agent
    // fleet needs entitlements this build does not have, and reporting it as
    // licensed would unlock buttons that then fail.
    license: {
      status: async () => ({
        authenticated: true,
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

    pty: {
      start: unsupported("The terminal"),
      input: () => {},
      resize: () => {},
      close: unsupported("The terminal"),
      onData: () => () => {},
    },
    fs: {
      list: unsupported("The file browser"),
      read: unsupported("File reading"),
      walk: unsupported("Workspace indexing"),
      pick: unsupported("The file picker"),
      readContext: unsupported("File context"),
    },
    git: {
      status: unsupported("Git"), diff: unsupported("Git"), stage: unsupported("Git"),
      unstage: unsupported("Git"), commit: unsupported("Git"), log: unsupported("Git"),
      branches: unsupported("Git"), checkout: unsupported("Git"),
      pull: unsupported("Git"), push: unsupported("Git"),
    },

    sessions,

    rooms: {
      agents: async () => [],
      list: async () => [],
      create: unsupported("Rooms"), load: unsupported("Rooms"), delete: unsupported("Rooms"),
      join: unsupported("Rooms"), leave: unsupported("Rooms"),
      setAgentModel: unsupported("Rooms"), say: unsupported("Rooms"),
      critique: unsupported("Rooms"), revise: unsupported("Rooms"), project: unsupported("Rooms"),
    },

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

    update: {
      check: async () => ({ available: false }),
      download: unsupported("Updates"), install: unsupported("Updates"),
      state: async () => ({ state: "web" }),
      onChange: () => () => {},
    },

    plugins: { list: async () => [], enable: unsupported("Plugins"), disable: unsupported("Plugins") },
    keys: {
      list: async () => [],
      set: unsupported("Provider keys"), remove: unsupported("Provider keys"), test: unsupported("Provider keys"),
    },
    operator: { status: async () => ({ running: 0 }), stopAll: async () => true },

    getConfig: async () => readJSON(KEY_CONFIG, { theme: "system", model: "crowelm-apex" }),
    setConfig: async (patch) => {
      const next = Object.assign(readJSON(KEY_CONFIG, {}), patch || {});
      writeJSON(KEY_CONFIG, next);
      return next;
    },
  };
})();
