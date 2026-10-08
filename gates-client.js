// The runner side of the phone authority gate (relay contract v1, 2026-10-05).
//
// An authority gate that appears on the desktop can also appear on the phone,
// and whichever answer lands first wins. The relay (a Cloudflare Worker, one
// Durable Object per Crowe ID subject) decides which one that was; this module
// is only the client: create a gate, long-poll it, post a local click as a
// decision, cancel it. Plain Node, no electron, fetch injectable, so the whole
// race runs against a fake relay in scripts/test-gates-client.js.
//
// Three rules shape every line here.
//   1. It never throws to the caller. A relay that is down, slow, or wrong is
//      the same thing as no relay: the local prompt behaves exactly as it did
//      before this module existed.
//   2. It never approves anything by itself. The only "approved" this module
//      produces is one the relay returned, or one the person clicked on this
//      machine. A timeout, a failed poll, or a missing gate is a denial or a
//      silence, never a yes.
//   3. The relay's answer is the answer. A local click is posted as a decision
//      and the runner obeys what comes back (a 409 means the phone got there
//      first, and gate.status says what it decided).
"use strict";

const DEFAULT_URL = "https://gates.crowelogic.com";
const CREATE_TIMEOUT_MS = 5000;
const DECIDE_TIMEOUT_MS = 5000;
const CANCEL_TIMEOUT_MS = 3000;
const WAIT_SLACK_MS = 6000;
const SLOW_CREATE_MS = 1500;       // a click never waits longer than this on the relay
const POLL_RETRY_MS = 3000;
const DIFF_CAP_BYTES = 48 * 1024;
const TERMINAL = new Set(["approved", "denied", "expired", "cancelled"]);

// Contract field limits. Over-long text is cut here rather than rejected there,
// because a 400 would silently cost the person the phone path.
const LIMITS = { machine: 120, mission: 300, run_id: 120, title: 200, detail: 4000, why: 1000 };
const KINDS = new Set(["run", "write", "edit", "open", "mail", "spend", "share", "other"]);

/* The relay URL carries the bearer, so it is held to the same rule as the
   gateway URL: https, or loopback http for a local fake. Anything else (a
   hand-edited config, a typo) falls back to the real relay. */
function normalizeGatesUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    const loopback = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname);
    if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) return u.origin + u.pathname.replace(/\/+$/, "");
  } catch { /* fall through */ }
  return DEFAULT_URL;
}

const clip = (s, n) => String(s == null ? "" : s).slice(0, n);

// "Michaels-MacBook-Pro.local" reads as a hostname; the phone card should read as a name.
function friendlyMachineName(hostname, computerName) {
  const named = String(computerName || "").trim();
  if (named) return clip(named, LIMITS.machine);
  const h = String(hostname || "").replace(/\.(local|lan|home|localdomain)$/i, "").replace(/[-_]+/g, " ").trim();
  return clip(h || "This computer", LIMITS.machine);
}

const KIND_OF = {
  run_shell: "run", physical_write: "write", send_email: "mail", generate_image: "spend",
  share_preview: "share", open_url: "open", browser_open: "open",
};
function relayKind(kind) {
  const k = String(kind || "");
  if (KINDS.has(k)) return k;
  return KIND_OF[k] || "other";
}

/* The gate the relay stores for a desktop approval request. The evidence is what
   the person is shown to approve against, and the relay hashes it, so it carries
   what the harness already put on the local card and nothing else. */
function fieldsForApproval(req, ctx = {}) {
  const kind = relayKind(req.kind);
  const detail = clip(req.detail, LIMITS.detail);
  const evidence = {};
  if (kind === "run") { evidence.command = detail; if (ctx.cwd) evidence.cwd = clip(ctx.cwd, 1000); }
  else if (kind === "write" && detail) evidence.path = clip(detail.split("\n")[0], 1000);
  if (req.meta && typeof req.meta === "object" && !Array.isArray(req.meta) && Object.keys(req.meta).length) evidence.args = req.meta;
  const fields = {
    source: "desktop",
    machine: clip(ctx.machine || "This computer", LIMITS.machine),
    kind,
    title: clip(req.title || req.kind || "An action needs your authorization", LIMITS.title),
    detail,
    why: clip(req.why || "", LIMITS.why),
    risk: req.risk === "review" ? "review" : "strict",
    evidence,
    ttl_s: ctx.ttlS || 300,
  };
  if (ctx.mission) fields.mission = clip(ctx.mission, LIMITS.mission);
  if (ctx.runId) fields.run_id = clip(ctx.runId, LIMITS.run_id);
  return fields;
}

/* A readable diff from the editor's [{t, s}] line list: changed lines with three
   lines of context, "@@" between hunks, capped at 48 KB. If the cap bites, the
   last line says so, so nobody approves on the phone believing they saw it all. */
function unifiedDiff(lines, { context = 3, cap = DIFF_CAP_BYTES } = {}) {
  const list = Array.isArray(lines) ? lines : [];
  const keep = new Array(list.length).fill(false);
  list.forEach((d, i) => {
    if (d.t === " ") return;
    for (let j = Math.max(0, i - context); j <= Math.min(list.length - 1, i + context); j++) keep[j] = true;
  });
  const out = []; let bytes = 0, truncated = false, skipped = 0, gap = false;
  for (let i = 0; i < list.length; i++) {
    if (!keep[i]) { gap = out.length > 0; continue; }
    if (gap) { out.push(`@@ line ${i + 1} @@`); gap = false; }
    const text = `${list[i].t === "+" || list[i].t === "-" ? list[i].t : " "}${list[i].s}`;
    const size = Buffer.byteLength(text) + 1;
    if (bytes + size > cap - 200) { truncated = true; skipped = list.slice(i).filter((d, k) => keep[i + k]).length; break; }
    out.push(text); bytes += size;
  }
  if (truncated) out.push(`... diff truncated here (${skipped} more changed or context lines not sent). Review the rest on your computer.`);
  return out.join("\n");
}

function fieldsForEdit(filePath, diffLines, ctx = {}) {
  const diff = unifiedDiff(diffLines);
  const adds = (diffLines || []).filter((d) => d.t === "+").length;
  const dels = (diffLines || []).filter((d) => d.t === "-").length;
  const fields = {
    source: "desktop",
    machine: clip(ctx.machine || "This computer", LIMITS.machine),
    kind: "edit",
    title: clip(`Edit ${filePath}`, LIMITS.title),
    detail: clip(`${filePath}  (+${adds} -${dels})`, LIMITS.detail),
    why: "changes a file in your workspace",
    risk: "review",
    evidence: { path: clip(filePath, 1000), diff },
    ttl_s: ctx.ttlS || 900,
  };
  if (ctx.mission) fields.mission = clip(ctx.mission, LIMITS.mission);
  return fields;
}

function createGatesClient(opts = {}) {
  const baseUrl = normalizeGatesUrl(opts.baseUrl);
  const doFetch = opts.fetch || (typeof fetch === "function" ? fetch : null);
  const getToken = opts.getToken || (() => "");
  const refreshToken = opts.refreshToken || (async () => null);

  /* One request, one 401 retry through the token refresh (the licensedFetch
     pattern). Resolves {status, data}, or null when nothing came back at all. */
  async function call(method, path, body, { timeoutMs = CREATE_TIMEOUT_MS, signal } = {}) {
    if (!doFetch) return null;
    let token = getToken();
    if (!token) return null;
    const once = async () => {
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (signal) signals.push(signal);
      const r = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any(signals),
      });
      const text = await r.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      return { status: r.status, data };
    };
    try {
      let res = await once();
      if (res.status === 401) {
        const fresh = await refreshToken().catch(() => null);
        if (fresh) { token = fresh; res = await once(); }
      }
      return res;
    } catch { return null; }
  }

  async function createGate(fields) {
    const r = await call("POST", "/v1/gates", fields, { timeoutMs: CREATE_TIMEOUT_MS });
    return r && r.status === 201 && r.data && r.data.id ? r.data : null;
  }
  async function waitRaw(id, waitS, signal) {
    const s = Math.max(0, Math.min(25, Number(waitS) || 0));
    return call("GET", `/v1/gates/${encodeURIComponent(id)}?wait=${s}`, null, { timeoutMs: s * 1000 + WAIT_SLACK_MS, signal });
  }
  async function waitGate(id, waitS = 25) {
    const r = await waitRaw(id, waitS);
    return r && r.status === 200 && r.data ? r.data : null;
  }
  /* {ok, status, gate, error} for any answer the relay gave, null for none.
     200 won the race; 409 already_decided carries the winner in gate; 410 expired. */
  async function decide(id, { decision, evidence_hash, via = "desktop", note } = {}) {
    const body = { decision, evidence_hash, via };
    if (note) body.note = clip(note, 500);
    const r = await call("POST", `/v1/gates/${encodeURIComponent(id)}/decision`, body, { timeoutMs: DECIDE_TIMEOUT_MS });
    if (!r) return null;
    const d = r.data || {};
    if (r.status === 200) return { ok: true, status: 200, gate: d.gate || d };
    return { ok: false, status: r.status, error: d.error || "", gate: d.gate || null };
  }
  async function cancel(id, reason) {
    const r = await call("POST", `/v1/gates/${encodeURIComponent(id)}/cancel`, reason ? { reason: clip(reason, 200) } : {}, { timeoutMs: CANCEL_TIMEOUT_MS });
    return r && r.status === 200 && r.data ? r.data : null;
  }

  /* One gate's life on the runner. Created in the background so the local card
     never waits for the relay; polled until somebody answers; closed the moment
     this machine does. The caller supplies onRemote(outcome), fired once when a
     terminal answer arrives from somewhere else. */
  function session(fields, hooks = {}) {
    const ac = new AbortController();
    let gate = null, closed = false, deciding = false, abandoned = false, timer = null, wake = null;
    const sleep = (ms) => new Promise((res) => { wake = res; timer = setTimeout(res, ms); });
    const retryMs = hooks.retryMs == null ? POLL_RETRY_MS : hooks.retryMs;
    const waitS = hooks.waitS == null ? 25 : hooks.waitS;

    const outcomeOf = (g, via) => {
      const status = g && g.status;
      return {
        approved: status === "approved",
        expired: status === "expired",
        cancelled: status === "cancelled",
        via: (g && g.decided_via) || via || null,
        relayed: true,
        gate: g,
      };
    };
    const close = () => {
      closed = true; ac.abort();
      if (timer) clearTimeout(timer);
      if (wake) wake();
    };

    async function loop() {
      let missing = 0;
      while (!closed) {
        const r = await waitRaw(gate.id, waitS, ac.signal);
        if (closed) return;
        if (r && r.status === 200 && r.data) {
          if (TERMINAL.has(r.data.status)) {
            if (deciding) return;                       // our own click settles it
            if (r.data.status === "expired" && hooks.expiryStaysLocal) {
              // An edit card has no local timer. The relay's window closed; the
              // desktop card is still the person's to answer.
              close(); if (hooks.onRelayExpired) hooks.onRelayExpired(r.data); return;
            }
            close();
            if (hooks.onRemote) hooks.onRemote(outcomeOf(r.data));
            return;
          }
          missing = 0; continue;
        }
        if (r && (r.status === 404 || r.status === 403)) { if (++missing >= 2) { close(); return; } }
        else if (r && r.status === 401) { close(); return; }
        await sleep(retryMs);
      }
    }

    const ready = createGate(fields).then((g) => {
      if (!g) { closed = true; return false; }
      gate = g;
      if (closed || abandoned) { cancel(g.id, "runner moved on"); closed = true; return false; }
      if (hooks.onCreated) { try { hooks.onCreated(g); } catch { /* a listener must not break the gate */ } }
      loop().catch(() => {});
      return true;
    }).catch(() => { closed = true; return false; });

    return {
      ready,
      get gate() { return gate; },
      get active() { return !closed; },
      /* A click on this machine. Resolves {approved, expired?, via, relayed}: the
         relay's verdict when it gave one, the click itself when it did not. The
         click is the person's own explicit act, so falling back to it is today's
         behaviour, not an auto-approval. */
      async localDecision(approved) {
        const local = { approved: Boolean(approved), via: "desktop", relayed: false };
        if (closed && !gate) return local;
        if (!gate) {
          let t; const slow = new Promise((res) => { t = setTimeout(() => res("slow"), SLOW_CREATE_MS); });
          const state = await Promise.race([ready, slow]);
          clearTimeout(t);
          if (state === "slow" || state === false || !gate) { abandoned = true; return local; }
        }
        if (closed) return local;
        deciding = true;
        const res = await decide(gate.id, { decision: approved ? "approve" : "deny", evidence_hash: gate.evidence_hash, via: "desktop" });
        close();
        if (!res) return local;
        if (res.ok && res.gate && TERMINAL.has(res.gate.status)) return outcomeOf(res.gate, "desktop");
        if (res.status === 409 && res.error === "already_decided" && res.gate && TERMINAL.has(res.gate.status)) return outcomeOf(res.gate);
        if (res.status === 410 && hooks.expiryStaysLocal) return local;
        if (res.status === 410) return { approved: false, expired: true, via: null, relayed: true, gate: res.gate };
        cancel(gate.id, "the relay refused the decision");
        return local;
      },
      /* Timeout, Stop, or the turn ending: the gate stops being answerable. */
      async cancel(reason) {
        if (!gate) { abandoned = true; close(); return null; }
        if (closed && deciding) return null;
        const was = closed; close();
        return was ? null : cancel(gate.id, reason);
      },
      close,
    };
  }

  return { baseUrl, createGate, waitGate, decide, cancel, session };
}

module.exports = {
  DEFAULT_URL, DIFF_CAP_BYTES, TERMINAL,
  normalizeGatesUrl, friendlyMachineName, relayKind, fieldsForApproval, fieldsForEdit, unifiedDiff,
  createGatesClient,
};
