// Rooms read as domain templates; the rail now reads as conversations with
// workers. These pin the pure half: row models, times, the roster an edition
// shows, and the composer's words.
const assert = require("assert");
const M = require("../renderer/messages");

const now = new Date(2026, 8, 14, 12, 0, 0).getTime();
assert.strictEqual(M.relativeTime(now - 20e3, now), "now");
assert.strictEqual(M.relativeTime(now - 5 * 60e3, now), "5m");
assert.match(M.relativeTime(now - 3 * 3600e3, now), /\d/, "same day shows a clock time");
assert.strictEqual(M.relativeTime(now - 26 * 3600e3, now), "Yesterday");
assert.strictEqual(M.relativeTime(0, now), "");

let row = M.rowModel({ id: "r1", title: "Untitled room", agents: ["operator"], names: ["Operator"], preview: "Checked the crontab first.", unread: 2, updatedAt: now - 60e3 }, now);
assert.strictEqual(row.title, "Operator", "a one-worker thread is titled by the worker");
assert.strictEqual(row.preview, "Checked the crontab first.");
assert.strictEqual(row.unread, 2);
assert.strictEqual(row.solo, true);
assert.strictEqual(row.time, "1m");
row = M.rowModel({ id: "r2", title: "Ship It", agents: ["operator", "compliance-audit"], names: ["Operator", "Compliance & Audit"], openAsk: true, working: true }, now);
assert.strictEqual(row.title, "Ship It", "a named group keeps its name");
assert.strictEqual(row.preview, "Waiting on your decision", "an open question outranks working");
assert.strictEqual(row.state, "waiting");
row = M.rowModel({ id: "r3", agents: ["revenue"], names: ["Revenue Agent"], working: true }, now);
assert.strictEqual(row.preview, "Working…");
row = M.rowModel({ id: "r4", agents: ["revenue"], names: ["Revenue Agent"] }, now);
assert.strictEqual(row.preview, "Say hello", "a fresh one-worker thread invites the first message");

const agents = [
  { id: "operator", name: "Operator", domain: "infrastructure" },
  { id: "cultivation-intelligence", name: "Cultivation Intelligence", domain: "cultivation" },
  { id: "crowe-logic", name: "Orchestrator", domain: "orchestration" },
  { id: "retired", name: "Retired", domain: "orchestration", roomJoinable: false },
  { id: "compliance-audit", name: "Compliance & Audit", domain: "compliance" },
];
const dev = M.visibleWorkers(agents, { id: "developers" });
assert.deepStrictEqual(dev.map((a) => a.id), ["compliance-audit", "operator", "crowe-logic"], "the Developers edition hides estate specialists and retired seats, sorted by name");
const full = M.visibleWorkers(agents, { id: "desktop" });
assert.deepStrictEqual(full.map((a) => a.id).sort(), ["compliance-audit", "crowe-logic", "cultivation-intelligence", "operator"], "the full app shows every joinable worker");
assert.strictEqual(M.visibleWorkers(agents, ["chat", "projects"]).length, 4, "an older space-list adapter stays Desktop, not Developers");
assert.deepStrictEqual(M.visibleWorkers(agents, "developers").map((a) => a.id), ["compliance-audit", "operator", "crowe-logic"]);
const templates = [
  { id: "ship-it", name: "Ship It", agents: [{ id: "operator" }, { id: "compliance-audit" }, { id: "crowe-logic" }] },
  { id: "grow", name: "Grow Diagnosis", agents: [{ id: "cultivation-intelligence" }, { id: "operator" }] },
];
assert.deepStrictEqual(M.visibleTemplates(templates, dev).map((t) => t.id), ["ship-it"], "a group is offered only when every seat is visible");
assert.strictEqual(M.conversationTitle([{ name: "Operator" }]), "Operator");
assert.strictEqual(M.conversationTitle([{ name: "A" }, { name: "B" }]), "A and B");
assert.strictEqual(M.conversationTitle([{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }]), "A, B and 2 more");
assert.strictEqual(M.conversationTitle([]), "Conversation");
assert.strictEqual(M.composerPlaceholder(["Operator"]), "Message Operator");
assert.strictEqual(M.composerPlaceholder(["A", "B"]), "Message the group. @name to address one worker");
assert.deepStrictEqual(M.filterWorkers(agents, "audit").map((a) => a.id), ["compliance-audit"]);
assert.strictEqual(M.filterWorkers(agents, "").length, agents.length);

// ── the thread as texts ──
{
  const t0 = 1_000_000;
  const op = (id, at, extra) => ({ id, author: ":operator", kind: "say", content: "x", at, ...(extra || {}) });
  const w = (id, at, extra) => ({ id, author: "operator", kind: "reply", content: "y", at, ...(extra || {}) });
  const msgs = [op("a", t0), op("b", t0 + 1000), w("c", t0 + 5000, { kind: "progress" }), w("d", t0 + 6000), w("e", t0 + 6000 + 6 * 60e3),
    { id: "f", author: ":system", kind: "note", content: "n", at: t0 + 7 * 60e3 }, w("g", t0 + 7 * 60e3 + 10), w("h", t0 + 7 * 60e3 + 20, { kind: "critique" }), w("i", t0 + 7 * 60e3 + 30, { ask: { question: "q", options: [], state: "open" } }), w("j", t0 + 7 * 60e3 + 40)];
  const pos = msgs.map((_, i) => M.runPosition(msgs, i));
  assert.deepStrictEqual(pos[0], { first: true, last: false }, "two operator texts a second apart open a run");
  assert.deepStrictEqual(pos[1], { first: false, last: true }, "and close it");
  assert.deepStrictEqual(pos[2], { first: true, last: false }, "a progress note and the reply that follows are one run");
  assert.deepStrictEqual(pos[3], { first: false, last: true }, "the reply is the tail");
  assert.deepStrictEqual(pos[4], { first: true, last: true }, "six minutes later is a new run");
  assert.deepStrictEqual(pos[6], { first: true, last: true }, "a system note breaks the run on both sides");
  assert.deepStrictEqual(pos[7], { first: true, last: true }, "a critique stands alone");
  assert.deepStrictEqual(pos[8], { first: true, last: true }, "a question closes its run so its options are the tail");
  assert.deepStrictEqual(pos[9], { first: true, last: true }, "and nothing joins onto a question");
  assert.strictEqual(M.deliveryState([], []), null, "nothing sent, nothing to mark");
  let d = M.deliveryState([op("a", t0)], [{ agentId: "operator", state: "idle" }]);
  assert.deepStrictEqual(d, { id: "a", state: "delivered", at: t0 }, "a stored message is delivered");
  assert.strictEqual(M.deliveryLabel(d), "Delivered");
  d = M.deliveryState([op("a", t0)], [{ agentId: "operator", state: "working" }]);
  assert.deepStrictEqual(d, { id: "a", state: "read", at: null }, "a seat at work has read it");
  assert.strictEqual(M.deliveryLabel(d, () => "7:02 PM"), "Read", "no time when the read is the seat starting");
  d = M.deliveryState([op("a", t0), w("c", t0 + 5000, { kind: "progress" })], []);
  assert.deepStrictEqual(d, { id: "a", state: "read", at: t0 + 5000 }, "a progress note after it is a read, at that moment");
  assert.strictEqual(M.deliveryLabel(d, (at) => (at === t0 + 5000 ? "7:02 PM" : "?")), "Read 7:02 PM");
  d = M.deliveryState([op("a", t0), { id: "n", author: ":system", kind: "note", at: t0 + 1 }, op("b", t0 + 2)], []);
  assert.strictEqual(d.id, "b", "only the last operator message carries a state");
  assert.strictEqual(d.state, "delivered", "a system note is not a read");
  assert.deepStrictEqual(M.typingSeats([{ agentId: "a", state: "idle" }, { agentId: "b", state: "working" }, { agentId: "c", state: "queued" }, { agentId: "d", state: "done" }]), ["b", "c"]);
  assert.strictEqual(M.typingLabel(["Operator"]), "Operator is typing");
  assert.strictEqual(M.typingLabel(["Operator", "Studio Director"]), "Operator and Studio Director are typing");
  assert.strictEqual(M.typingLabel(["A", "B", "C", "D"]), "A, B and 2 more are typing");
  assert.strictEqual(M.typingLabel([]), "");
}


// ── reactions ──
{
  const E = require("../rooms/engine.js");
  assert.deepStrictEqual(M.REACTIONS.map((r) => r.kind), E.REACTIONS, "the bar offers exactly the words the engine accepts, in order");
  for (const r of M.REACTIONS) assert.strictEqual(r.label, E.REACTION_LABEL[r.kind], `one label for ${r.kind}`);
  assert.deepStrictEqual(M.reactionChips({}), [], "no reactions, no chips");
  assert.deepStrictEqual(M.reactionChips({ reactions: [{ by: ":operator", kind: "why", at: 1 }, { by: "studio", kind: "good", at: 2 }, { by: ":operator", kind: "good", at: 3 }] }),
    [{ kind: "good", label: "Good", count: 2, mine: true }, { kind: "why", label: "Why", count: 1, mine: true }], "chips in bar order, counted, mine when the operator put one there");
  assert.deepStrictEqual(M.reactionChips({ reactions: [{ by: "studio", kind: "no", at: 1 }] }), [{ kind: "no", label: "No", count: 1, mine: false }], "a seat's reaction is not mine");
}

console.log("ok      messages: rows, times, edition roster, composer words, runs, delivery, typing and reactions");
