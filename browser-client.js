// Crowe Browser, the cloud browser for agents. Client for the v1 contract in
// crowe-browser/docs/API.md: create a session, drive it one action at a time,
// keep it alive, end it. Pure Node with an injectable fetch, so the harness
// tests run it against a fake server and nothing here needs Electron.
//
// Two authorities, never mixed. The service key creates and lists sessions and
// is the only thing this file holds that outlives a session; it goes into one
// request header and nowhere else. Everything on a session takes that
// session's own token, which the service mints at creation. The token also
// rides inside live_view_url and thumb_url, so those two strings are bearer
// credentials: the renderer needs them to draw the card and open the live
// view, the model and the journal never do.
"use strict";

const DEFAULT_URL = "https://browser.crowelogic.com";
const REQUEST_TIMEOUT_MS = 45000;      // the first action waits for the container, up to 30 s by contract
const END_TIMEOUT_MS = 4000;           // ending is best effort; the server's idle timer is the real cleanup
const MAX_TTL_SECONDS = 3600;
const MIN_TTL_SECONDS = 60;

class BrowserError extends Error {
  constructor(message, { status = 0, code = "", state = null, result = null } = {}) {
    super(message);
    this.name = "BrowserError";
    this.status = status;
    this.code = code || (status === 410 ? "session_ended" : status === 401 ? "unauthorized" : status === 404 ? "not_found"
      : status === 422 ? "action_failed" : status === 504 ? "timeout" : status === 400 ? "bad_request" : "");
    this.state = state;      // the browser state a 422 carries, so the card still updates
    this.result = result;
  }
}

/* The base URL is normalised once: https only (or plain http on the loopback,
   for a fake server in a test), no trailing slash, nothing but the origin and
   an optional path prefix. A URL that fails this is not a Crowe Browser. */
function normalizeBaseUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  let u;
  try { u = new URL(s); } catch { return ""; }
  const loop = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loop)) return "";
  if (u.username || u.password || u.search || u.hash) return "";
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

function clampTtl(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.round(n)));
}

async function readJson(res) {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 400) }; }
}

class CroweBrowserClient {
  constructor({ url = DEFAULT_URL, key = "", fetch: fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.baseUrl = normalizeBaseUrl(url);
    this.key = String(key || "");
    this.fetch = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
    if (!this.baseUrl) throw new BrowserError("Crowe Browser URL is not an https address", { code: "bad_request" });
    if (typeof this.fetch !== "function") throw new BrowserError("no fetch available for Crowe Browser", { code: "bad_request" });
  }

  async request(method, path, { body, token, timeoutMs } = {}) {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    // The session token where one is given; the service key otherwise. Never both.
    if (token) headers.authorization = `Bearer ${token}`;
    else if (this.key) headers.authorization = `Bearer ${this.key}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || this.timeoutMs);
    let res;
    try {
      res = await this.fetch(this.baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      clearTimeout(timer);
      const aborted = e && (e.name === "AbortError" || ctl.signal.aborted);
      throw new BrowserError(aborted ? `Crowe Browser did not answer within ${Math.round((timeoutMs || this.timeoutMs) / 1000)} s` : `Crowe Browser is unreachable: ${String((e && e.message) || e).slice(0, 200)}`,
        { code: aborted ? "timeout" : "unreachable" });
    }
    clearTimeout(timer);
    if (res.status === 204) return null;
    const data = await readJson(res);
    if (!res.ok) {
      const err = data && data.error && typeof data.error === "object" ? data.error : {};
      throw new BrowserError(String(err.message || (data && data.raw) || `HTTP ${res.status}`).slice(0, 400),
        { status: res.status, code: err.code, state: data && data.state ? data.state : null, result: data && data.result ? data.result : null });
    }
    return data;
  }

  /* POST /v1/sessions. Returns the session record as the service shaped it:
     id, token, state, connect_url, live_view_url, thumb_url, expires_at. */
  async createSession({ owner, ttlSeconds, viewport, startUrl } = {}) {
    const body = {};
    if (owner) body.owner = String(owner).slice(0, 200);
    const ttl = clampTtl(ttlSeconds); if (ttl) body.ttl_seconds = ttl;
    if (viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height)) body.viewport = { width: viewport.width, height: viewport.height };
    if (startUrl) body.start_url = String(startUrl);
    const s = await this.request("POST", "/v1/sessions", { body });
    if (!s || typeof s.id !== "string" || typeof s.token !== "string") throw new BrowserError("Crowe Browser returned a session without an id or token", { code: "bad_request" });
    return s;
  }

  getSession(session) { return this.request("GET", `/v1/sessions/${encodeURIComponent(session.id)}`, { token: session.token }); }
  keepalive(session) { return this.request("POST", `/v1/sessions/${encodeURIComponent(session.id)}/keepalive`, { token: session.token }); }

  /* DELETE /v1/sessions/:id. A 404 or a 410 means it is already gone, which is
     the outcome wanted; anything else is reported and the caller moves on. */
  async endSession(session) {
    try {
      await this.request("DELETE", `/v1/sessions/${encodeURIComponent(session.id)}`, { token: session.token, timeoutMs: END_TIMEOUT_MS });
      return true;
    } catch (e) {
      if (e && (e.status === 404 || e.status === 410)) return true;
      throw e;
    }
  }

  /* One action per request. `type` is the action name from the table in
     API.md and `fields` its arguments. Resolves to { ok, result, state,
     duration_ms }; a 422 rejects with a BrowserError carrying `state`. */
  action(session, type, fields = {}) {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(session.id)}/actions`, { token: session.token, body: { type, ...fields } });
  }
}

/* One session per owner. The owner is the turn's agentId ("main", a workflow
   node, "room:<id>:<agent>"), which is the same identity every event on the
   agent channel already carries, so the card and the session line up without
   a second key. Sessions are created lazily on the first browser tool and
   reused across turns while the server keeps them; the owner's last known URL
   and last snapshot refs ride on the entry so a session that idled out can be
   put back on its page and a typed field can be recognised for what it is.

   `clientFor` is read at creation time and the client is pinned to the entry,
   so a URL or key changed in Settings applies to the next session and never
   to a live one. Creation is serialised per owner: two tool calls in one round
   must not open two browsers for one seat. */
class BrowserSessions {
  constructor({ clientFor, now = Date.now } = {}) {
    this.clientFor = typeof clientFor === "function" ? clientFor : () => null;
    this.now = now;
    this.entries = new Map();     // owner -> { client, session, lastUrl, lastTitle, refs, createdAt }
    this.pending = new Map();     // owner -> Promise<entry>
  }

  configured() { try { return Boolean(this.clientFor()); } catch { return false; } }
  peek(owner) { return this.entries.get(String(owner)) || null; }
  owners() { return [...this.entries.keys()]; }

  async ensure(owner, { startUrl } = {}) {
    const key = String(owner || "main");
    const have = this.entries.get(key);
    if (have) return have;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const p = (async () => {
      const client = this.clientFor();
      if (!client) throw new BrowserError("Crowe Browser is not set up", { code: "unconfigured" });
      const session = await client.createSession({ owner: key, startUrl });
      const entry = { client, session, lastUrl: startUrl || "", lastTitle: "", refs: new Map(), createdAt: this.now() };
      this.entries.set(key, entry);
      return entry;
    })();
    this.pending.set(key, p);
    try { return await p; } finally { this.pending.delete(key); }
  }

  // Forget the owner's session and end it on the server. Ending is best
  // effort: the server's idle timer finishes what a lost request could not.
  async drop(owner, { end = true } = {}) {
    const key = String(owner || "main");
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (!entry || !end) return Boolean(entry);
    try { await entry.client.endSession(entry.session); } catch { /* the server's idle timer takes it */ }
    return true;
  }

  async dropWhere(pred) {
    const gone = [];
    for (const owner of this.owners()) if (pred(owner)) { gone.push(owner); await this.drop(owner); }
    return gone;
  }

  async endAll() {
    const owners = this.owners();
    await Promise.all(owners.map((o) => this.drop(o)));
    return owners.length;
  }
}

module.exports = { CroweBrowserClient, BrowserSessions, BrowserError, normalizeBaseUrl, clampTtl, DEFAULT_URL };
