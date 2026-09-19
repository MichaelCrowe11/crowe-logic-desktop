// Messages: conversations with workers, the way a phone shows texts.
//
// Rooms were framed as domain templates: pick "Grow Diagnosis" and enter a
// room with three seats. Michael's ask was the other frame: the rail lists the
// workers you talk to, like iMessage contacts, and the work shows up in the
// thread. This module is the pure half of that rail: row models, relative
// times, the worker roster an edition may show, and the words the composer
// uses. It runs in node (tests) and the renderer (window.CroweMessages).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CroweMessages = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // Worker domains the Developers edition shows. The full app shows every
  // domain. Cultivation, chemistry and commerce specialists are the estate's
  // own colleagues and have no place in a coding tool's contact book.
  const DEVELOPER_DOMAINS = new Set(["orchestration", "reasoning", "infrastructure", "technology", "compliance"]);

  function relativeTime(at, now) {
    now = now == null ? Date.now() : now;
    if (!at) return "";
    const d = new Date(at), n = new Date(now);
    const diff = Math.max(0, now - at);
    if (diff < 60e3) return "now";
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)}m`;
    const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    if (sameDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const y = new Date(n); y.setDate(n.getDate() - 1);
    if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) return "Yesterday";
    if (diff < 7 * 86400e3) return d.toLocaleDateString([], { weekday: "short" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  // One rail row from one rooms.list() summary.
  function rowModel(r, now) {
    r = r || {};
    const names = r.names || [];
    const solo = (r.agents || []).length === 1;
    const title = r.title && r.title !== "Untitled room" && r.title !== "Room" ? r.title : conversationTitle(names.map((n) => ({ name: n })));
    const state = r.openAsk ? "waiting" : r.working ? "working" : "idle";
    const preview = r.openAsk ? "Waiting on your decision" : r.working ? "Working…" : (r.preview || (solo ? "Say hello" : names.join(", ")));
    return { id: r.id, title, preview, time: relativeTime(r.updatedAt, now), unread: Number(r.unread) || 0, state, solo, agents: r.agents || [], names };
  }

  // Which workers an edition lists. spaces is the install's space list
  // (main.js installSpaces): a build without the cultivation space is the
  // Developers edition.
  function visibleWorkers(agents, spaces) {
    const list = (agents || []).filter((a) => a && a.roomJoinable !== false);
    const developers = Array.isArray(spaces) && spaces.length && !spaces.includes("cultivation");
    const shown = developers ? list.filter((a) => (a.domain === "models" || DEVELOPER_DOMAINS.has(String(a.domain || "").toLowerCase()))) : list;
    return shown.slice().sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  }
  // A template is offered only when every seat in it is a visible worker.
  function visibleTemplates(templates, workers) {
    const ids = new Set((workers || []).map((w) => w.id));
    return (templates || []).filter((t) => (t.agents || []).length && (t.agents || []).every((a) => ids.has(a.id || a)));
  }
  function conversationTitle(workers) {
    const names = (workers || []).map((w) => w.name || w.id).filter(Boolean);
    if (!names.length) return "Conversation";
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
  }
  function composerPlaceholder(names) {
    names = (names || []).filter(Boolean);
    if (names.length === 1) return `Message ${names[0]}`;
    return "Message the group. @name to address one worker";
  }
  function filterWorkers(workers, query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return workers || [];
    return (workers || []).filter((w) => [w.name, w.id, w.role, w.domain].some((f) => String(f || "").toLowerCase().includes(q)));
  }

  /* ── the thread, as texts ──────────────────────────────────────────────────
     The rules a phone applies without saying so: consecutive bubbles from one
     sender within a few minutes read as one run, the sender's mark sits by the
     last bubble of the run, "Delivered" and "Read" sit under the last thing you
     sent and nowhere else, and a typing bubble stands in for a seat that is
     working and has not answered yet. Pure, so the renderer draws what these
     say and the tests can say it back. */
  const OPERATOR = ":operator";
  const RUN_GAP_MS = 5 * 60 * 1000;
  // Housekeeping lines (a routine firing, a system note) break runs and never
  // count as a reply.
  const isAside = (m) => !m || m.author === ":system" || m.author === ":routine";
  // A critique or a relay is its own beat and never joins the bubble before it.
  const standsAlone = (m) => Boolean(m && (m.kind === "critique" || m.kind === "relay"));
  function sameRun(prev, m) {
    if (!prev || !m || isAside(prev) || isAside(m)) return false;
    if (prev.author !== m.author) return false;
    if (standsAlone(prev) || standsAlone(m)) return false;
    if (prev.ask) return false;                      // a question closes the run: its options are the tail
    return (Number(m.at) || 0) - (Number(prev.at) || 0) < RUN_GAP_MS;
  }
  // Where a message sits in its run: first, middle, last, or alone (both).
  function runPosition(messages, i) {
    const m = messages[i];
    const first = !sameRun(messages[i - 1], m);
    const last = !sameRun(m, messages[i + 1]);
    return { first, last };
  }
  /* Delivery. The room stores a message the moment it is said, so "Delivered"
     is true as soon as it is drawn. "Read" is the seat taking it up: a worker
     message after it, or a seat working or queued right now. Only the last
     operator message carries a state, the way a phone marks only the last
     text you sent. */
  function deliveryState(messages, agents) {
    const list = messages || [];
    let li = -1;
    for (let i = 0; i < list.length; i++) if (list[i] && list[i].author === OPERATOR) li = i;
    if (li < 0) return null;
    const mine = list[li];
    const reply = list.slice(li + 1).find((m) => m && !isAside(m) && m.author !== OPERATOR);
    if (reply) return { id: mine.id, state: "read", at: Number(reply.at) || null };
    const busy = (agents || []).some((a) => a && (a.state === "working" || a.state === "queued"));
    if (busy) return { id: mine.id, state: "read", at: null };
    return { id: mine.id, state: "delivered", at: Number(mine.at) || null };
  }
  function deliveryLabel(d, fmtTime) {
    if (!d) return "";
    if (d.state === "delivered") return "Delivered";
    return d.at && typeof fmtTime === "function" ? `Read ${fmtTime(d.at)}` : "Read";
  }
  /* Reactions: the same four words rooms/engine.js accepts, in the order the
     bar offers them. A bubble wears one chip per kind present, counted, and
     marked mine when the operator put it there so a second tap takes it off. */
  const REACTIONS = [{ kind: "good", label: "Good" }, { kind: "more", label: "More" }, { kind: "no", label: "No" }, { kind: "why", label: "Why" }];
  function reactionChips(m, me) {
    me = me || OPERATOR;
    const list = Array.isArray(m && m.reactions) ? m.reactions.filter(Boolean) : [];
    if (!list.length) return [];
    return REACTIONS.filter((r) => list.some((x) => x.kind === r.kind))
      .map((r) => ({ kind: r.kind, label: r.label, count: list.filter((x) => x.kind === r.kind).length, mine: list.some((x) => x.kind === r.kind && x.by === me) }));
  }
  // Seats that should show a typing bubble: working or queued, in roster order.
  function typingSeats(agents) {
    return (agents || []).filter((a) => a && (a.state === "working" || a.state === "queued")).map((a) => a.agentId || a.id);
  }
  function typingLabel(names) {
    names = (names || []).filter(Boolean);
    if (!names.length) return "";
    if (names.length === 1) return `${names[0]} is typing`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
    return `${names[0]}, ${names[1]} and ${names.length - 2} more are typing`;
  }
  return { DEVELOPER_DOMAINS, relativeTime, rowModel, visibleWorkers, visibleTemplates, conversationTitle, composerPlaceholder, filterWorkers,
    sameRun, runPosition, deliveryState, deliveryLabel, typingSeats, typingLabel, REACTIONS, reactionChips };
});
