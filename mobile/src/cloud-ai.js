/* The Crowe Logic AI worker, for the phone's read-aloud and the playground.
 *
 * A Cloudflare Worker (crowe-ai, ~/Projects/crowe-ai-worker) running Workers AI:
 * Deepgram Aura-2 voices for read-aloud and a short list of text and image
 * models for the playground. It takes the same bearer token the control plane
 * issues and checks it against /api/auth/me, so only a signed-in person spends
 * the account's credits. This file is the one place that knows its address. */
(() => {
  const BASE = "https://crowe-ai.yellow-block-3adc.workers.dev";
  async function bearer() {
    // auth.status() refreshes a stale token before the bridge hands it out.
    const st = window.crowe && window.crowe.auth ? await window.crowe.auth.status().catch(() => null) : null;
    if (!st || !st.user) return null;
    return window.crowePhone && window.crowePhone.accessToken ? window.crowePhone.accessToken() : null;
  }
  async function call(path, init = {}) {
    const tok = await bearer();
    if (!tok) { const e = new Error("Sign in to use this"); e.status = 401; throw e; }
    init.signal?.throwIfAborted();
    const headers = { Authorization: `Bearer ${tok}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) };
    const r = await fetch(BASE + path, { ...init, headers });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      const e = new Error(d.error || `The speech and model service answered ${r.status}`); e.status = r.status; throw e;
    }
    return r;
  }
  window.croweCloud = { base: BASE, call };
})();
