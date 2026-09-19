// What the agent is doing, as a live list beside the chat.
//
// The Output pane logs every event as one line, which is a record, not a view.
// Michael's ask was the other thing: when the model edits a file, runs a
// command, or opens a page, the panel next to the chat should show that work
// as it happens. This module is the pure half: it turns the agent event stream
// into cards and says which pane should be in front. The renderer draws the
// cards and does the switching. It runs in both node (for tests) and the
// renderer (as window.CroweActivity).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CroweActivity = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // Where each tool's work is visible. run_shell stays on the activity pane
  // because the command and its output are the thing to watch; a PTY panel is
  // the user's terminal, not the agent's.
  const PANE_FOR = {
    run_shell: "activity",
    read_file: "files", list_dir: "files", search: "files",
    edit_file: "git", write_file: "git",
    open_url: "browser",
  };
  const MAX_CARDS = 200;
  const TAIL_CHARS = 4000;

  function short(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function firstString(args, keys) {
    for (const k of keys) if (args && typeof args[k] === "string" && args[k]) return args[k];
    return "";
  }
  function describeCall(name, args) {
    args = args || {};
    switch (name) {
      case "run_shell": return { verb: "ran", detail: firstString(args, ["command", "cmd"]) || "a command" };
      case "read_file": return { verb: "read", detail: firstString(args, ["path", "file"]) || "a file" };
      case "list_dir": return { verb: "listed", detail: firstString(args, ["path", "dir"]) || "." };
      case "search": return { verb: "searched", detail: firstString(args, ["query", "pattern", "q"]) || "the workspace" };
      case "edit_file": return { verb: "edited", detail: firstString(args, ["path", "file"]) || "a file" };
      case "write_file": return { verb: "wrote", detail: firstString(args, ["path", "file"]) || "a file" };
      case "open_url": return { verb: "opened", detail: firstString(args, ["url", "href"]) || "a page" };
      default: return { verb: "called", detail: name || "a tool" };
    }
  }
  function targetFor(name, args) {
    const pane = PANE_FOR[name] || null;
    if (!pane) return null;
    const t = { pane };
    if (pane === "git" || pane === "files") { const p = firstString(args, ["path", "file", "dir"]); if (p) t.path = p; }
    if (pane === "browser") { const u = firstString(args, ["url", "href"]); if (u) t.url = u; }
    return t;
  }
  // main.js emits an edit proposal's diff as rows {t: " " | "-" | "+", s: line}
  // (lineDiff); a string is accepted too. Rows become unified-diff text so the
  // card colours them like the Changes pane does.
  function diffText(diff) {
    if (diff == null) return "";
    if (typeof diff === "string") return diff;
    if (Array.isArray(diff)) return diff.map((r) => (r && typeof r === "object") ? `${r.t == null ? " " : r.t}${r.s == null ? "" : r.s}` : String(r)).join("\n");
    return String(diff);
  }
  function newActivity() { return { cards: [], seq: 0 }; }
  function pending(state, name) {
    for (let i = state.cards.length - 1; i >= 0; i--) {
      const c = state.cards[i];
      if (c.status === "running" && (!name || c.tool === name)) return c;
    }
    return null;
  }
  function push(state, card) {
    card.id = card.id || `act-${++state.seq}`;
    state.cards.push(card);
    if (state.cards.length > MAX_CARDS) state.cards.splice(0, state.cards.length - MAX_CARDS);
    return card;
  }
  // Returns { state, card, target }. target is null when the event is not
  // something the side pane should follow (assistant text, telemetry, routes).
  function reduceActivity(state, ev, now) {
    now = now || Date.now();
    if (!ev || typeof ev !== "object") return { state, card: null, target: null };
    if (ev.type === "tool_call") {
      const d = describeCall(ev.name, ev.args);
      const card = push(state, { kind: "tool", tool: ev.name, callId: ev.id || null, verb: d.verb, detail: d.detail, args: ev.args || {}, status: "running", output: "", startedAt: now, endedAt: null, agentId: ev.agentId || "main" });
      return { state, card, target: targetFor(ev.name, ev.args) };
    }
    if (ev.type === "tool_result") {
      const card = (ev.id && state.cards.find((c) => c.callId === ev.id && c.status === "running")) || pending(state, ev.name);
      if (!card) return { state, card: null, target: null };
      const text = String(ev.result == null ? "" : ev.result);
      card.output = text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text;
      card.status = /^(error|blocked|denied)\b/i.test(text) || ev.error ? "error" : "done";
      card.endedAt = now;
      // An edit is worth showing as a diff once it has landed, not before.
      const target = (card.tool === "edit_file" || card.tool === "write_file") && card.status === "done" ? { pane: "git", path: card.args.path || card.args.file || "" } : null;
      return { state, card, target };
    }
    if (ev.type === "edit_proposal") {
      const card = push(state, { kind: "proposal", tool: "edit_file", callId: ev.id || null, verb: "proposed an edit to", detail: ev.path || "a file", args: { path: ev.path }, status: "waiting", output: diffText(ev.diff), startedAt: now, endedAt: null, agentId: ev.agentId || "main" });
      return { state, card, target: { pane: "git", path: ev.path || "" } };
    }
    if (ev.type === "approval_request") {
      const card = push(state, { kind: "approval", tool: ev.kind || "action", callId: ev.id || null, verb: "is waiting for authorization:", detail: ev.title || ev.kind || "an action", args: {}, status: "waiting", output: ev.why || "", startedAt: now, endedAt: null, agentId: ev.agentId || "main" });
      return { state, card, target: { pane: "activity" } };
    }
    if (ev.type === "approval_expired" || ev.type === "approval_resolved") {
      const card = state.cards.find((c) => c.callId === ev.id && c.status === "waiting");
      if (card) { card.status = ev.type === "approval_expired" ? "expired" : (ev.allowed === false ? "denied" : "done"); card.endedAt = now; }
      return { state, card: card || null, target: null };
    }
    return { state, card: null, target: null };
  }
  // The pane to bring forward, or null. Follow is the user's switch; a pane
  // the user pinned by hand stays put when follow is off.
  function nextPane(target, followOn) {
    if (!followOn || !target || !target.pane) return null;
    return target.pane;
  }
  function summary(state) {
    const running = state.cards.filter((c) => c.status === "running").length;
    const waiting = state.cards.filter((c) => c.status === "waiting").length;
    if (waiting) return `${waiting} waiting for you`;
    if (running) return `${running} in progress`;
    const last = state.cards[state.cards.length - 1];
    return last ? `last: ${last.verb} ${short(last.detail, 48)}` : "idle";
  }
  return { PANE_FOR, describeCall, targetFor, newActivity, reduceActivity, nextPane, summary, short, diffText };
});
