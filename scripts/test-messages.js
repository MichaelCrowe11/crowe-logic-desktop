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

let row = M.rowModel({ id: "r1", title: "Untitled room", agents: ["operator"], names: ["Crowe Operator"], preview: "Checked the crontab first.", unread: 2, updatedAt: now - 60e3 }, now);
assert.strictEqual(row.title, "Crowe Operator", "a one-worker thread is titled by the worker");
assert.strictEqual(row.preview, "Checked the crontab first.");
assert.strictEqual(row.unread, 2);
assert.strictEqual(row.solo, true);
assert.strictEqual(row.time, "1m");
row = M.rowModel({ id: "r2", title: "Ship It", agents: ["operator", "compliance-audit"], names: ["Crowe Operator", "Compliance & Audit"], openAsk: true, working: true }, now);
assert.strictEqual(row.title, "Ship It", "a named group keeps its name");
assert.strictEqual(row.preview, "Waiting on your decision", "an open question outranks working");
assert.strictEqual(row.state, "waiting");
row = M.rowModel({ id: "r3", agents: ["revenue"], names: ["Revenue Agent"], working: true }, now);
assert.strictEqual(row.preview, "Working…");
row = M.rowModel({ id: "r4", agents: ["revenue"], names: ["Revenue Agent"] }, now);
assert.strictEqual(row.preview, "Say hello", "a fresh one-worker thread invites the first message");

const agents = [
  { id: "operator", name: "Crowe Operator", domain: "infrastructure" },
  { id: "cultivation-intelligence", name: "Cultivation Intelligence", domain: "cultivation" },
  { id: "crowe-logic", name: "Crowe Logic", domain: "orchestration" },
  { id: "retired", name: "Retired", domain: "orchestration", roomJoinable: false },
  { id: "compliance-audit", name: "Compliance & Audit", domain: "compliance" },
];
const dev = M.visibleWorkers(agents, ["chat", "projects"]);
assert.deepStrictEqual(dev.map((a) => a.id), ["compliance-audit", "crowe-logic", "operator"], "the Developers edition hides estate specialists and retired seats, sorted by name");
const full = M.visibleWorkers(agents, ["chat", "projects", "cultivation"]);
assert.deepStrictEqual(full.map((a) => a.id).sort(), ["compliance-audit", "crowe-logic", "cultivation-intelligence", "operator"], "the full app shows every joinable worker");
assert.strictEqual(M.visibleWorkers(agents, []).length, 4, "no space list means the full roster");
const templates = [
  { id: "ship-it", name: "Ship It", agents: [{ id: "operator" }, { id: "compliance-audit" }, { id: "crowe-logic" }] },
  { id: "grow", name: "Grow Diagnosis", agents: [{ id: "cultivation-intelligence" }, { id: "operator" }] },
];
assert.deepStrictEqual(M.visibleTemplates(templates, dev).map((t) => t.id), ["ship-it"], "a group is offered only when every seat is visible");
assert.strictEqual(M.conversationTitle([{ name: "Crowe Operator" }]), "Crowe Operator");
assert.strictEqual(M.conversationTitle([{ name: "A" }, { name: "B" }]), "A and B");
assert.strictEqual(M.conversationTitle([{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }]), "A, B and 2 more");
assert.strictEqual(M.conversationTitle([]), "Conversation");
assert.strictEqual(M.composerPlaceholder(["Crowe Operator"]), "Message Crowe Operator");
assert.strictEqual(M.composerPlaceholder(["A", "B"]), "Message the group. @name to address one worker");
assert.deepStrictEqual(M.filterWorkers(agents, "audit").map((a) => a.id), ["compliance-audit"]);
assert.strictEqual(M.filterWorkers(agents, "").length, agents.length);
console.log("ok      messages: rows, times, edition roster and composer words");
