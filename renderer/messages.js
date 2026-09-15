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
    const title = r.title && r.title !== "Untitled room" && r.title !== "Room" ? r.title : (names.join(", ") || "Conversation");
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
    const shown = developers ? list.filter((a) => DEVELOPER_DOMAINS.has(String(a.domain || "").toLowerCase())) : list;
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
  return { DEVELOPER_DOMAINS, relativeTime, rowModel, visibleWorkers, visibleTemplates, conversationTitle, composerPlaceholder, filterWorkers };
});
