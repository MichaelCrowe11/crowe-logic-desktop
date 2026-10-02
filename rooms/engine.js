// The room engine: several named agents and the operator in one thread.
//
// Everything here is pure orchestration over an injected runner. `runAgent` is
// supplied by the caller - main.js hands it the real harness, scripts/test-rooms.js
// hands it a fake - so addressing, visibility, concurrency, attribution, the
// budget and the critique loop can all be exercised without a gateway. The
// alternative is a feature whose only proof is a screenshot of it working once.
//
// The shape of the thing:
//
//   a room is a session         with a roster and a per-message author, stored
//                               by the existing sessions store, not a new one
//   a room is a colleague       it has a standing brief, an inbox with unread
//                               marks, and routines that let it speak first
//   a message names its author  "operator", or an agent id, never a generic
//                               assistant label
//   every agent sees everything the shared transcript IS the feature. An agent
//                               that sees only its own turns is N sessions in
//                               one window wearing a costume
//   nobody speaks unaddressed   the single largest cost control here. A routine
//                               is addressed too: it names the one seat it wakes
//   a seat works out loud       what it says between tool rounds lands as short
//                               progress messages; the last thing it says is
//                               its reply
//   a seat asks, it does not act the operator decides with one tap; the choice
//                               comes back as an ordinary addressed message and
//                               grants nothing the tool gate would not
//
// What this file deliberately does NOT do: write to the workspace. Gate 4 of
// the build order is worktree isolation, and until that lands `roomTier()`
// clamps every room to readonly. Three agents editing one tree is not a bug you
// recover from by looping.
//
// Nothing here reads a clock or a file at module level. The same bytes run in
// the desktop, in the browser bundle (scripts/build-rooms-web.js) and under the
// fake runner, so time is a parameter wherever it matters.

const registry = require("./registry");

const MAX_CRITIQUE_ROUNDS = 2;
const DEFAULT_ROOM_BUDGET_USD = 1.0;
const MAX_BRIEF_CHARS = 4000;
const MAX_TITLE_CHARS = 80;
const MAX_ASK_OPTIONS = 4;
const PREVIEW_CHARS = 120;

/* The human's author id, and why it is not "operator".

   The registry contains an agent whose id is exactly `operator` - Crowe
   Operator, the one that runs the estate. Using the bare word for the person as
   well made the two indistinguishable in the transcript: an agent's answer was
   attributed to the human, flattened into the session as a user message, and
   would have been fed back to the next turn as though the operator had said it.

   Registry ids are lowercase kebab, so a leading colon cannot collide with one
   now or later. Everything that decides "is this the person" asks this constant
   rather than comparing to a string. The two other reserved authors follow the
   same rule: a routine speaks for the operator's standing orders, and the
   system speaks only in notes that no model ever reads. */
const HUMAN = ":operator";
const ROUTINE = ":routine";
const SYSTEM = ":system";
const isHuman = (author) => author === HUMAN;
const isReserved = (author) => author === HUMAN || author === ROUTINE || author === SYSTEM;

/* Reactions: the tapbacks a phone puts on a bubble, as words a worker can act
   on rather than pictures. Four, fixed. A reaction lives on the message it
   answers, one per (who, kind), toggled. It is not a message: it does not move
   the room in the rail and does not count as unread. The seat whose message it
   is reads it on its next turn as a line after that message, which is how
   "Why" becomes an instruction without anyone typing a sentence. The renderer
   keeps the same four in renderer/messages.js; scripts/test-messages.js holds
   the two lists to each other. */
const REACTIONS = ["good", "more", "no", "why"];
const REACTION_LABEL = { good: "Good", more: "More", no: "No", why: "Why" };
function react(room, messageId, kind, by = HUMAN) {
  const k = String(kind || "").toLowerCase();
  if (!REACTIONS.includes(k)) return { error: `unknown reaction; one of ${REACTIONS.join(", ")}` };
  const m = byId(room, messageId);
  if (!m) return { error: "no such message" };
  if (isReserved(m.author)) return { error: "a reaction goes on a worker's message" };
  const list = Array.isArray(m.reactions) ? m.reactions : (m.reactions = []);
  const i = list.findIndex((r) => r && r.by === by && r.kind === k);
  const on = i < 0;
  if (on) list.push({ by, kind: k, at: Date.now() }); else list.splice(i, 1);
  if (!list.length) delete m.reactions;
  return { ok: true, on, message: m };
}
// What the operator said about a message, in words, for the seat that wrote it.
function reactionLine(m) {
  const mine = (Array.isArray(m.reactions) ? m.reactions : []).filter((r) => r && r.by === HUMAN && REACTION_LABEL[r.kind]);
  if (!mine.length) return "";
  return `[Reaction to your last message: ${mine.map((r) => REACTION_LABEL[r.kind]).join(", ")}]`;
}

// ─── Messages ────────────────────────────────────────────────────────────────

/* One door for every message. A stable id and a sequence number are what let
   the operator answer a question by id rather than by index (an index moves
   the moment another seat posts), and what let the rail count unread without
   a counter that drifts. Anything that pushes onto room.messages goes here. */
function pushMessage(room, msg) {
  room.seq = (room.seq || 0) + 1;
  const m = { id: "m" + room.seq.toString(36) + "-" + Math.random().toString(36).slice(2, 6), seq: room.seq, at: Date.now(), ...msg };
  room.messages.push(m);
  room.updatedAt = m.at;
  return m;
}

const byId = (room, messageId) => room.messages.find((m) => m.id === messageId) || null;

/* What the rail shows under the title. The last thing anyone said, minus
   system housekeeping, cut to one line. Derived, never stored, so it cannot
   disagree with the transcript. */
function preview(room) {
  for (let i = room.messages.length - 1; i >= 0; i--) {
    const m = room.messages[i];
    if (m.author === SYSTEM) continue;
    const text = String(m.content || "").replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
    if (!text && m.ask) return String(m.ask.question || "").slice(0, PREVIEW_CHARS);
    if (text) return text.slice(0, PREVIEW_CHARS);
  }
  return "";
}

/* Unread is a comparison, not a counter: messages after the operator's read
   mark that the operator did not write. A counter incremented on arrival
   and decremented on view is the kind of state that ends up at -1. */
function unreadCount(room) {
  const mark = room.readSeq || 0;
  // The operator's own words, a routine firing on the operator's own schedule
  // and system housekeeping are not news; what the seats said back is.
  return room.messages.filter((m) => (m.seq || 0) > mark && !isReserved(m.author)).length;
}
function markRead(room) { room.readSeq = room.seq || 0; return room.readSeq; }

// ─── Addressing ──────────────────────────────────────────────────────────────

/* Who a message is for.

   @room, or @<agent-id>, or nothing. Unaddressed goes to the room's default
   agent alone, never to everyone: a room where every stray message costs N
   calls is a room nobody can afford to think out loud in.

   Matching is on registry ids and on the agent's display name reduced to
   alphanumerics, because a handle cannot contain a space or an ampersand: what
   a person types for "Compliance & Audit" is "@ComplianceAudit", and the file
   calls it "compliance-audit". Both resolve. Unknown handles are reported
   rather than silently dropped, so a typo is visible instead of expensive. */
function parseAddress(text, room) {
  const raw = String(text || "");
  const roster = room.agents.map((a) => a.agentId);
  const handles = new Map();
  for (const id of roster) {
    const agent = registry.getAgent(id);
    handles.set(id.toLowerCase(), id);
    if (agent) handles.set(String(agent.name).replace(/[^a-z0-9]/gi, "").toLowerCase(), id);
  }

  const mentions = raw.match(/@[A-Za-z0-9][\w.-]*/g) || [];
  if (mentions.some((m) => m.slice(1).toLowerCase() === "room")) {
    return { to: roster.slice(), broadcast: true, unknown: [] };
  }
  const to = [], unknown = [];
  for (const m of mentions) {
    const key = m.slice(1).toLowerCase();
    const id = handles.get(key);
    if (id) { if (!to.includes(id)) to.push(id); }
    else unknown.push(m);
  }
  if (to.length) return { to, broadcast: false, unknown };
  const fallback = room.defaultAgent && roster.includes(room.defaultAgent) ? room.defaultAgent : roster[0];
  return { to: fallback ? [fallback] : [], broadcast: false, unknown, defaulted: true };
}

// ─── The transcript one agent sees ───────────────────────────────────────────

/* Every agent reads the whole room, including what the others produced and the
   tools they ran. That shared view is the entire point of the feature.

   Two framing rules, both about keeping an agent honest about its own place in
   the conversation:

     its own past turns come back as `assistant`, because they are its memory;
     every other agent's turn comes back as `user`, labelled with the speaker,
     because a model handed someone else's words as its own assistant history
     will continue them as if it had said them.

   Progress is memory only for the seat that produced it: an agent's own
   progress lines are joined back onto its reply so it remembers what it found
   on the way, and nobody else pays context for another seat's working notes.
   System notes are for the person and never enter a model's view. A routine's
   text is the operator's standing order and reads as the operator's turn. A
   relayed message is attributed context, never an instruction.

   The label is prose rather than a role field the gateway would have to
   understand, so this works on any OpenAI-compatible deployment. */
function viewFor(room, agentId) {
  const out = [];
  const progressOf = progressByRun(room);
  for (const m of room.messages) {
    if (m.author === SYSTEM || m.kind === "progress") continue;
    if (isHuman(m.author)) {
      out.push({ role: "user", content: m.content });
    } else if (m.author === ROUTINE) {
      out.push({ role: "user", content: `[Scheduled routine]\n${m.content}` });
    } else if (m.kind === "relay") {
      const who = displayName(m.author);
      const where = m.from && m.from.roomTitle ? `, from the room "${m.from.roomTitle}"` : ", relayed from another room";
      out.push({ role: "user", content: `[${who}${where}]\n${m.content}` });
    } else if (m.author === agentId) {
      out.push({ role: "assistant", content: withOwnProgress(m, progressOf) + askText(m) });
      const rx = reactionLine(m);
      if (rx) out.push({ role: "user", content: rx });
    } else {
      const who = displayName(m.author);
      const kind = m.kind === "critique" ? `${who}, reviewing` : who;
      out.push({ role: "user", content: `[${kind}]\n${m.content}${askText(m)}` });
    }
  }
  return out;
}

function progressByRun(room) {
  const map = new Map();
  for (const m of room.messages) {
    if (m.kind === "progress" && m.runId) (map.get(m.runId) || map.set(m.runId, []).get(m.runId)).push(m.content);
  }
  return map;
}
function withOwnProgress(m, progressOf) {
  const notes = m.runId ? progressOf.get(m.runId) : null;
  return notes && notes.length ? [...notes, m.content].filter(Boolean).join("\n\n") : m.content;
}
// A question an agent put to the operator, restated so the model remembers
// it asked and what the choices were.
function askText(m) {
  if (!m.ask || !m.ask.question) return "";
  const opts = (m.ask.options || []).map((o, i) => `${String.fromCharCode(65 + i)}) ${o.label}`).join("  ");
  return `\n\n[Asked the operator: ${m.ask.question}${opts ? "  Options: " + opts : ""}]`;
}

function displayName(agentId) {
  if (isHuman(agentId)) return "Operator";
  if (agentId === ROUTINE) return "Routine";
  if (agentId === SYSTEM) return "System";
  const a = registry.getAgent(agentId);
  return a ? a.name : String(agentId);
}

/* The standing instruction an agent carries in a room, on top of whatever its
   registry role says. Rooms are a social setting and the model has to be told
   the rules of it, or it invents them - which in practice means thanking its
   colleagues for their thorough review.

   The working rules at the end are what make a room read like a colleague
   rather than an essay: short messages, one proposed next action, a question
   with options when the operator has to decide, and the boundary said out
   loud. A proposal is a question, not a permission: choosing an option comes
   back as an ordinary message and the tool gate still decides what may run. */
function roomBrief(room, agentId) {
  const me = registry.getAgent(agentId);
  const others = room.agents.filter((a) => a.agentId !== agentId).map((a) => displayName(a.agentId));
  return [
    me ? `You are ${me.name}. ${me.role}` : `You are ${agentId}.`,
    others.length
      ? `You are in a shared room with the operator and: ${others.join(", ")}. You can see their contributions and they can see yours.`
      : "You are in a room with the operator.",
    room.brief ? `The room's standing brief, set by the operator: ${String(room.brief).trim()}` : "",
    "Answer the operator and the room. Do not address the other participants directly, do not thank them, and do not comment on the quality of their work unless you are explicitly asked for a review.",
    "Speak from your own specialty. Where you disagree with what another participant concluded, say so plainly and give your reason.",
    "Work in short messages, the way a colleague reports in: what you checked, what you found, what you will do next. Lead with the answer. Close with one proposed next action when there is one.",
    "When the operator has to decide, call propose_options with one plain question and up to four short options, then stop; the answer arrives as the operator's next message. If tools are unavailable to you, end your message with a fenced block whose language tag is ask: the question on the first line, then one option per line starting with a dash.",
    "Default to reading. Say plainly what you will not touch unless asked, and never claim an action you did not take.",
  ].filter(Boolean).join(" ");
}

// ─── Rooms ───────────────────────────────────────────────────────────────────

function createRoom({ id, title, agentIds, defaultAgent, budgetUsd, template, brief } = {}) {
  // Only joinable agents are seated. An id that exists but is retired from
  // rooms is dropped here rather than at display time, so no caller - the
  // composer, a template, or a raw IPC create - can compose around the flag.
  const ids = [...new Set(agentIds || [])].filter((x) => registry.isJoinable(x));
  return {
    id: id || "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
    kind: "room",
    title: String(title || "Untitled room").slice(0, MAX_TITLE_CHARS),
    template: template || "",
    brief: String(brief || "").slice(0, MAX_BRIEF_CHARS),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    agents: ids.map((agentId) => ({ agentId, model: (registry.getAgent(agentId) || {}).model || "", state: "idle" })),
    defaultAgent: defaultAgent && ids.includes(defaultAgent) ? defaultAgent : ids[0] || "",
    messages: [],
    seq: 0,
    readSeq: 0,
    routines: [],
    budgetUsd: typeof budgetUsd === "number" ? budgetUsd : DEFAULT_ROOM_BUDGET_USD,
    spentUsd: 0,
    cost: {},           // agentId -> { usd, promptTokens, completionTokens, calls }
    critiqueRounds: 0,
    halted: "",
  };
}

function fromTemplate(templateId, opts = {}) {
  const t = registry.getTemplate(templateId);
  if (!t) return null;
  return createRoom({
    ...opts,
    title: opts.title || t.name,
    template: t.id,
    agentIds: t.agents.map((a) => a.id),
    defaultAgent: t.defaultAgent,
  });
}

/* What the operator may change about a standing room, and how much of it.
   Allowlisted and capped, the same way a session's name and brief are: a
   brief is the persona every seat carries on every turn, so a runaway one
   would quietly become the whole context window. */
function updateRoom(room, patch = {}) {
  const changed = [];
  if (Object.prototype.hasOwnProperty.call(patch, "title")) {
    const t = String(patch.title == null ? "" : patch.title).trim().slice(0, MAX_TITLE_CHARS);
    if (t) { room.title = t; changed.push("title"); }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "brief")) {
    room.brief = String(patch.brief == null ? "" : patch.brief).slice(0, MAX_BRIEF_CHARS); changed.push("brief");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "budgetUsd")) {
    const b = Number(patch.budgetUsd);
    if (Number.isFinite(b) && b >= 0) {
      room.budgetUsd = b; changed.push("budgetUsd");
      // Raising the cap above what was spent un-halts a room the cap stopped.
      if (room.halted === "budget" && !overBudget(room)) room.halted = "";
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "defaultAgent")) {
    const d = String(patch.defaultAgent || "");
    if (room.agents.some((a) => a.agentId === d)) { room.defaultAgent = d; changed.push("defaultAgent"); }
  }
  if (changed.length) room.updatedAt = Date.now();
  return changed;
}

/* The tier a room may actually run at.

   Three clamps, and the order matters. The roster's minimum ceiling, then the
   app's configured autonomy, then the Gate 4 guard: until agents get isolated
   worktrees, no room writes anything, no matter who is in it or what the
   operator set. `allowWrites` is the switch that gate flips, and it defaults
   off so forgetting to pass it fails closed. */
function roomTier(room, configuredTier, { allowWrites = false } = {}) {
  const ids = room.agents.map((a) => a.agentId);
  const tier = registry.effectiveTier(ids, configuredTier);
  if (!allowWrites && registry.writeCapable(tier)) return "readonly";
  return tier;
}

// ─── Cost ────────────────────────────────────────────────────────────────────

function noteCost(room, agentId, { usd = 0, promptTokens = 0, completionTokens = 0 } = {}) {
  const c = room.cost[agentId] || (room.cost[agentId] = { usd: 0, promptTokens: 0, completionTokens: 0, calls: 0 });
  c.usd += usd || 0;
  c.promptTokens += promptTokens || 0;
  c.completionTokens += completionTokens || 0;
  c.calls += 1;
  // The room total is the sum of its parts by construction rather than by
  // coincidence: there is one place that adds, and it adds to both.
  room.spentUsd = Object.values(room.cost).reduce((s, x) => s + x.usd, 0);
  return c;
}

const overBudget = (room) => room.budgetUsd > 0 && room.spentUsd >= room.budgetUsd;

/* What a round is about to cost, before it runs.

   Calls, not dollars, is the honest unit here: the price of a call depends on
   the deployment and the length of a transcript nobody has generated yet. A
   projected dollar figure would be a guess wearing a decimal point. The
   estimate is shown on the button, and the operator can cancel. */
function projectRound(room, kind) {
  const live = room.agents.filter((a) => a.state !== "failed").length;
  if (kind === "critique") return { calls: live, agents: live, note: `${live} reviews, each agent over the others' work` };
  if (kind === "revise") return { calls: live, agents: live, note: `${live} revisions` };
  return { calls: live, agents: live, note: `${live} replies` };
}

// ─── Proposals ───────────────────────────────────────────────────────────────

/* A question with options, as the seat's tool call produced it or as the
   fenced fallback spelled it. Both arrive here and both are held to the same
   shape: one question, one to four short distinct options, nothing else.
   Anything malformed is not a half-actionable card; it is dropped and the
   text stands as ordinary text. */
function normalizeAsk(raw) {
  if (!raw || typeof raw !== "object") return null;
  const question = String(raw.question || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const seen = new Set();
  const options = [];
  for (const o of Array.isArray(raw.options) ? raw.options : []) {
    const label = String(typeof o === "object" && o ? o.label : o).replace(/\s+/g, " ").trim().slice(0, 120);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    options.push({ id: String.fromCharCode(97 + options.length), label });
    if (options.length >= MAX_ASK_OPTIONS) break;
  }
  if (!question || !options.length) return null;
  return { question, options, state: "open", chosen: "", answer: "" };
}

/* The fallback for a deployment that ignores tool schemas: a fenced block
   tagged `ask`, and only when it is the last thing in the message. A block in
   the middle of the text, text after the block, or two blocks all mean the
   model was not actually ending its turn on a question, and the whole message
   is left as prose. */
const ASK_FENCE = /```ask[ \t]*\n([\s\S]*?)\n```[ \t]*$/;
function extractAsk(text) {
  const src = String(text || "").trimEnd();
  const m = src.match(ASK_FENCE);
  if (!m) return { text: src, ask: null };
  if ((src.match(/```ask\b/g) || []).length > 1) return { text: src, ask: null };
  const lines = m[1].split("\n").map((l) => l.trim()).filter(Boolean);
  const question = lines.shift() || "";
  const options = lines.filter((l) => /^[-*]\s+/.test(l)).map((l) => l.replace(/^[-*]\s+/, ""));
  const ask = normalizeAsk({ question, options });
  if (!ask) return { text: src, ask: null };
  return { text: src.slice(0, m.index).trimEnd(), ask };
}

/* The operator's tap on an option. Check, then mark, then speak, with nothing
   awaited between the check and the mark: two windows or a double-click must
   not run the same decision twice. The choice becomes an ordinary message
   addressed to the seat that asked, so the model reads it exactly as it would
   read the operator typing the same words. */
async function answerAsk(room, messageId, optionId, deps) {
  const m = byId(room, messageId);
  if (!m || !m.ask) return { error: "that message is not a question" };
  if (m.ask.state !== "open") return { error: `that question was already ${m.ask.state}` };
  const opt = (m.ask.options || []).find((o) => o.id === optionId);
  if (!opt) return { error: "no such option" };
  // A halted room cannot speak, so the card must not be marked answered: the
  // tap would vanish and the card would say the decision was taken.
  if (room.halted) return { error: `this room is halted (${room.halted}); raise its budget or clear the halt, then answer`, halted: room.halted, ran: [] };
  m.ask.state = "answered"; m.ask.chosen = opt.id; m.ask.answer = opt.label; m.ask.answeredAt = Date.now();
  return speak(room, opt.label, deps, { to: [m.author], quote: m.ask.question, quoteOf: m.id });
}

// The operator typed instead of tapping. Every open question from the seats
// this message reaches is closed with the text as its answer, so a stale card
// cannot be tapped later and re-decide something the operator already said.
function closeOpenAsks(room, to, text) {
  const closed = [];
  for (const m of room.messages) {
    if (m.ask && m.ask.state === "open" && to.includes(m.author)) {
      m.ask.state = "answered"; m.ask.chosen = ""; m.ask.answer = String(text).slice(0, 300); m.ask.answeredAt = Date.now();
      closed.push(m.id);
    }
  }
  return closed;
}

// ─── Running a turn ──────────────────────────────────────────────────────────

const setState = (room, agentId, state) => {
  const seat = room.agents.find((a) => a.agentId === agentId);
  if (seat) seat.state = state;
};

/* One addressed agent, one call.

   Failure is contained here rather than thrown: one agent failing marks that
   seat failed and leaves the room running. The status it lands on is the one
   thing this function must never lie about - a seat that errored says failed,
   and its output does not enter the transcript, so it cannot be critiqued as
   if it were work.

   Progress lands live. The runner calls `onProgress` with each complete thing
   the seat said between tool rounds, and each lands as its own message while
   the turn is still running, which is what lets the operator watch a seat
   work instead of waiting for an essay. The harness returns the whole turn's
   text; when that text ends with the last progress note, the note is promoted
   to the reply rather than posted twice. */
async function runOne(room, agentId, deps, { kind = "reply", brief = "" } = {}) {
  setState(room, agentId, "working");
  const seat = room.agents.find((a) => a.agentId === agentId) || {};
  const messages = viewFor(room, agentId);
  if (brief) messages.push({ role: "user", content: brief });
  const runId = "run-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  const onProgress = (text) => {
    const t = String(text || "").trim();
    if (!t) return null;
    return pushMessage(room, { author: agentId, content: t, kind: "progress", runId });
  };

  let res;
  try {
    res = await deps.runAgent({
      agentId,
      roomId: room.id,
      runId,
      model: seat.model || "",
      systemBrief: roomBrief(room, agentId),
      messages,
      tier: room.tier || "readonly",
      onProgress,
    });
  } catch (e) {
    setState(room, agentId, "failed");
    return { agentId, ok: false, error: String((e && e.message) || e) };
  }

  if (res && res.usage) noteCost(room, agentId, res.usage);

  if (!res || res.error || res.stopped) {
    setState(room, agentId, res && res.stopped ? "stopped" : "failed");
    return { agentId, ok: false, error: (res && (res.error || "stopped")) || "no result", stopped: !!(res && res.stopped) };
  }

  let text = String(res.text || "").trim();
  // A proposal from the tool wins; the fenced fallback is read only when the
  // tool was not used, so a model that did both is not asked twice.
  let ask = normalizeAsk(res.proposal);
  if (!ask) { const f = extractAsk(text); text = f.text; ask = f.ask; }
  if (!text && !ask) { setState(room, agentId, "failed"); return { agentId, ok: false, error: "empty answer" }; }

  const notes = room.messages.filter((m) => m.kind === "progress" && m.runId === runId);
  const last = notes[notes.length - 1];
  let msg;
  if (last && (text === last.content || text.endsWith(last.content))) {
    // The final text is the notes joined; the last note IS the reply.
    msg = last; msg.kind = kind;
  } else {
    msg = pushMessage(room, { author: agentId, content: text, kind, runId });
  }
  if (ask) msg.ask = ask;
  if (kind === "critique") msg.replyTo = res.replyTo || "";
  room.updatedAt = Date.now();
  setState(room, agentId, "done");
  return { agentId, ok: true, text: msg.content, message: msg, ask: ask || null };
}

/* The operator says something; whoever is addressed answers.

   Concurrently, not round-robin: three specialists asked the same question
   should be able to think at once, and a room that serialises them for no
   reason feels broken in a way no amount of status text repairs.

   `to` overrides the mentions in the text. A routine names the one seat it
   wakes, and an answered question goes back to the seat that asked, whatever
   handles the text happens to contain. */
async function speak(room, text, deps, { author = HUMAN, to = null, kind = "say", quote = "", quoteOf = "", routineId = "" } = {}) {
  if (room.halted) return { halted: room.halted, ran: [] };
  const roster = room.agents.map((a) => a.agentId);
  const addr = Array.isArray(to)
    ? { to: to.filter((id) => roster.includes(id)), broadcast: false, unknown: [], explicit: true }
    : parseAddress(text, room);
  const msg = { author, content: String(text), kind, to: addr.to.slice() };
  if (quote) { msg.quote = String(quote).slice(0, 300); if (quoteOf) msg.quoteOf = quoteOf; }
  if (routineId) msg.routineId = routineId;
  if (isHuman(author)) msg.closedAsks = closeOpenAsks(room, addr.to, text);
  pushMessage(room, msg);

  // Everyone not addressed is explicitly idle rather than left on whatever they
  // were, so "queued" never lingers on an agent that is not going to run.
  for (const seat of room.agents) seat.state = addr.to.includes(seat.agentId) ? "queued" : "idle";

  if (overBudget(room)) { room.halted = "budget"; return { halted: "budget", ran: [], address: addr }; }

  const results = await Promise.all(addr.to.map((id) => runOne(room, id, deps, { kind: "reply" })));
  if (overBudget(room)) room.halted = "budget";
  return { ran: results, address: addr, halted: room.halted };
}

// ─── Relays between rooms ────────────────────────────────────────────────────

/* A message carried from one room into another, by the operator.

   Rooms are colleagues, and colleagues hand each other things - but a seat
   that could message another room on its own would be a cost multiplier with
   no one addressed, and a loop waiting to happen. So the hand-off is the
   operator's act: the message lands in the target room attributed to who said
   it and where, and the target room's default seat (or whoever the operator
   names) answers it as it would answer anything else. */
async function forward(fromRoom, toRoom, messageId, deps, { to = null } = {}) {
  const src = byId(fromRoom, messageId);
  if (!src) return { error: "no such message" };
  if (fromRoom.id === toRoom.id) return { error: "a message cannot be forwarded to its own room" };
  if (toRoom.halted) return { halted: toRoom.halted, ran: [] };
  const roster = toRoom.agents.map((a) => a.agentId);
  const targets = (Array.isArray(to) && to.length ? to : [toRoom.defaultAgent || roster[0]]).filter((id) => roster.includes(id));
  if (!targets.length) return { error: "the target room has no seat to address" };
  pushMessage(toRoom, {
    author: src.author, kind: "relay", content: String(src.content || ""), to: targets.slice(),
    from: { roomId: fromRoom.id, roomTitle: fromRoom.title, agentId: src.author, messageId: src.id },
  });
  for (const seat of toRoom.agents) seat.state = targets.includes(seat.agentId) ? "queued" : "idle";
  if (overBudget(toRoom)) { toRoom.halted = "budget"; return { halted: "budget", ran: [] }; }
  const results = await Promise.all(targets.map((id) => runOne(toRoom, id, deps, { kind: "reply" })));
  if (overBudget(toRoom)) toRoom.halted = "budget";
  return { ran: results, to: targets, halted: toRoom.halted };
}

// ─── Routines ────────────────────────────────────────────────────────────────

/* Recurring tasks a room runs on a schedule. This is how a room speaks first:
   a routine is a standing message from the operator, addressed to one seat,
   delivered at a time. The scheduler that decides "now" lives in main.js and
   owns the clock; everything here takes `now` as an argument so the rules can
   be checked against fixed instants.

   Schedules are deliberately few: every N minutes, daily, weekdays, weekly.
   Local time, in whatever zone the machine is in, because "07:00" to the
   person means the clock on the wall. Daylight saving is handled by the
   platform's own local Date arithmetic: a time that does not exist that day
   moves forward to the first instant that does, and a time that happens twice
   runs once, at the first. */
const EVERY = ["minutes", "daily", "weekdays", "weekly"];
const MIN_MINUTES = 5, MAX_MINUTES = 7 * 24 * 60;

function parseAt(at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || "").trim());
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

function nextRunAt(routine, from) {
  const t = Number(from);
  if (routine.every === "minutes") {
    const n = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Number(routine.minutes) || 60));
    return t + n * 60 * 1000;
  }
  const at = parseAt(routine.at) || { hh: 7, mm: 0 };
  const d = new Date(t);
  for (let day = 0; day < 8; day++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + day, at.hh, at.mm, 0, 0);
    if (c.getTime() <= t) continue;
    const wd = c.getDay();
    if (routine.every === "weekdays" && (wd === 0 || wd === 6)) continue;
    if (routine.every === "weekly" && wd !== (Number(routine.weekday) || 0)) continue;
    return c.getTime();
  }
  return t + 24 * 60 * 60 * 1000;
}

// The window inside which a late routine still runs. Past it, the run is
// skipped and said so, not replayed: an app opened at noon must not deliver
// five overnight briefs in a burst.
function graceMs(routine) {
  if (routine.every === "minutes") return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Number(routine.minutes) || 60)) * 60 * 1000;
  return 2 * 60 * 60 * 1000;
}

function addRoutine(room, spec = {}, now = Date.now()) {
  const agentId = String(spec.agentId || room.defaultAgent || "");
  if (!room.agents.some((a) => a.agentId === agentId)) return { error: "that agent is not in this room" };
  const text = String(spec.text || "").trim().slice(0, 4000);
  if (!text) return { error: "a routine needs the message it will send" };
  const every = EVERY.includes(spec.every) ? spec.every : "daily";
  if (every !== "minutes" && !parseAt(spec.at)) return { error: "a daily, weekdays or weekly routine needs a time as HH:MM" };
  const routine = {
    id: "rt-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
    agentId, text, every,
    at: every === "minutes" ? "" : String(spec.at).trim(),
    minutes: every === "minutes" ? Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Number(spec.minutes) || 60)) : 0,
    weekday: every === "weekly" ? Math.min(6, Math.max(0, Number(spec.weekday) || 0)) : 0,
    enabled: spec.enabled !== false,
    createdAt: now, lastRunAt: 0, lastStatus: "", runs: 0, nextRunAt: 0,
  };
  routine.nextRunAt = nextRunAt(routine, now);
  room.routines = room.routines || [];
  room.routines.push(routine);
  room.updatedAt = now;
  return { routine };
}

function updateRoutine(room, routineId, patch = {}, now = Date.now()) {
  const r = (room.routines || []).find((x) => x.id === routineId);
  if (!r) return { error: "no such routine" };
  let reschedule = false;
  if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
    const on = Boolean(patch.enabled);
    // A routine paused past its due time must not fire the moment it resumes
    // and then be skipped as "the app was not running": resuming schedules
    // the next run from now.
    if (on && (!r.enabled || !r.nextRunAt || r.nextRunAt <= now)) reschedule = true;
    r.enabled = on;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "text")) { const t = String(patch.text || "").trim().slice(0, 4000); if (t) r.text = t; }
  if (Object.prototype.hasOwnProperty.call(patch, "agentId") && room.agents.some((a) => a.agentId === patch.agentId)) r.agentId = String(patch.agentId);
  if (EVERY.includes(patch.every)) { r.every = patch.every; reschedule = true; }
  if (Object.prototype.hasOwnProperty.call(patch, "at") && parseAt(patch.at)) { r.at = String(patch.at).trim(); reschedule = true; }
  if (Object.prototype.hasOwnProperty.call(patch, "minutes")) { r.minutes = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Number(patch.minutes) || 60)); reschedule = true; }
  if (Object.prototype.hasOwnProperty.call(patch, "weekday")) { r.weekday = Math.min(6, Math.max(0, Number(patch.weekday) || 0)); reschedule = true; }
  if (reschedule || r.enabled && !r.nextRunAt) r.nextRunAt = nextRunAt(r, now);
  room.updatedAt = now;
  return { routine: r };
}

function removeRoutine(room, routineId) {
  const before = (room.routines || []).length;
  room.routines = (room.routines || []).filter((x) => x.id !== routineId);
  return { removed: before !== room.routines.length };
}

function dueRoutines(room, now = Date.now()) {
  return (room.routines || []).filter((r) => r.enabled && r.nextRunAt && r.nextRunAt <= now);
}

/* Taking a run. The claim is written before the run happens, and the caller
   persists it before the model is called, so a crash mid-run cannot make the
   same scheduled instant fire again on restart. A run that is too late is
   skipped with a note the operator can read, and the next one is scheduled
   from now, not from the missed time. */
function claimRoutine(room, routineId, now = Date.now()) {
  const r = (room.routines || []).find((x) => x.id === routineId);
  if (!r) return { error: "no such routine" };
  if (!r.enabled) return { skip: "disabled" };
  if (!r.nextRunAt || r.nextRunAt > now) return { skip: "not due" };
  const late = now - r.nextRunAt;
  const scheduledFor = r.nextRunAt;
  r.nextRunAt = nextRunAt(r, now);
  if (late > graceMs(r)) {
    r.lastStatus = "skipped: the app was not running at " + new Date(scheduledFor).toLocaleString([], { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
    pushMessage(room, { author: SYSTEM, kind: "note", content: `Skipped a scheduled routine for ${displayName(r.agentId)}: it was due ${Math.round(late / 60000)} minutes ago and the app was not running. Next run is scheduled.`, routineId: r.id });
    return { skip: "too late", late, scheduledFor };
  }
  r.lastRunAt = now; r.runs = (r.runs || 0) + 1; r.lastStatus = "running";
  return { run: true, scheduledFor, late };
}

/* One routine, delivered. The room's budget is the only cap here and it is
   honoured before the call rather than after: a room the cap halted at three
   in the morning gets one note saying so, not a failed call and no note. */
async function runRoutine(room, routineId, deps, now = Date.now()) {
  const r = (room.routines || []).find((x) => x.id === routineId);
  if (!r) return { error: "no such routine" };
  if (room.halted) {
    r.lastStatus = `skipped: room halted (${room.halted})`;
    pushMessage(room, { author: SYSTEM, kind: "note", content: `The scheduled routine for ${displayName(r.agentId)} did not run: this room is halted (${room.halted}). Raise the budget or clear the halt to resume.`, routineId: r.id });
    return { skip: "halted", halted: room.halted };
  }
  if (!room.agents.some((a) => a.agentId === r.agentId)) {
    r.lastStatus = "skipped: agent left the room";
    pushMessage(room, { author: SYSTEM, kind: "note", content: `The scheduled routine could not run: ${displayName(r.agentId)} is no longer in this room.`, routineId: r.id });
    return { skip: "no seat" };
  }
  const out = await speak(room, r.text, deps, { author: ROUTINE, to: [r.agentId], kind: "routine", routineId: r.id });
  const ok = (out.ran || []).some((x) => x.ok);
  r.lastStatus = ok ? "ran" : `failed: ${((out.ran || [])[0] || {}).error || out.halted || "no answer"}`;
  r.lastRunAt = now;
  return { ...out, ok };
}

// ─── Critique and revise ─────────────────────────────────────────────────────

const lastRoundBy = (room, kind) => {
  const out = new Map();
  for (const m of room.messages) if (m.kind === kind) out.set(m.author, m);
  return out;
};

/* The move worth stealing, promoted from a prompt to a primitive.

   Each participating agent reviews the OTHERS' last outputs and is told not to
   review its own. That instruction is the whole mechanism: the round where
   agents looked at each other's work is where quality came from, and an agent
   grading its own paper is where it does not.

   A failed agent's output is excluded - both from what gets reviewed and from
   who reviews - because critiquing an error message teaches nobody anything. */
async function critique(room, deps) {
  if (room.halted) return { halted: room.halted, ran: [] };
  if (room.critiqueRounds >= (room.maxCritiqueRounds || MAX_CRITIQUE_ROUNDS)) {
    return { capped: true, ran: [], rounds: room.critiqueRounds, max: room.maxCritiqueRounds || MAX_CRITIQUE_ROUNDS };
  }
  if (overBudget(room)) { room.halted = "budget"; return { halted: "budget", ran: [] }; }

  const round = lastRoundBy(room, "reply");
  const authors = [...round.keys()].filter((id) => (room.agents.find((a) => a.agentId === id) || {}).state !== "failed");
  if (authors.length < 2) return { ran: [], note: "critique needs at least two standing positions" };

  room.critiqueRounds += 1;
  for (const seat of room.agents) seat.state = authors.includes(seat.agentId) ? "queued" : "idle";

  const results = await Promise.all(authors.map((id) => {
    const others = authors.filter((o) => o !== id)
      .map((o) => `--- ${displayName(o)} ---\n${round.get(o).content}`).join("\n\n");
    const brief = [
      `Review the following contributions from the other participants. Do not review your own; it is not included.`,
      ``, others, ``,
      `For each one: name what is wrong, what is missing, and what would have to be true for it to hold. Be specific and cite the claim you are contesting. Where it is right, say so briefly and move on. Do not summarise, do not compliment, and do not restate your own position.`,
    ].join("\n");
    return runOne(room, id, deps, { kind: "critique", brief });
  }));

  if (overBudget(room)) room.halted = "budget";
  return { ran: results, round: room.critiqueRounds, halted: room.halted };
}

/* The other half of the loop. Each agent is handed the critiques written about
   it and asked to act on them, including the option of holding its position
   with a reason - a revision that caves to every note is as useless as one that
   ignores them. */
async function revise(room, deps) {
  if (room.halted) return { halted: room.halted, ran: [] };
  if (overBudget(room)) { room.halted = "budget"; return { halted: "budget", ran: [] }; }

  const critiques = room.messages.filter((m) => m.kind === "critique");
  if (!critiques.length) return { ran: [], note: "nothing to revise: run a critique round first" };

  const positions = lastRoundBy(room, "reply");
  const targets = [...positions.keys()].filter((id) => (room.agents.find((a) => a.agentId === id) || {}).state !== "failed");
  for (const seat of room.agents) seat.state = targets.includes(seat.agentId) ? "queued" : "idle";

  const results = await Promise.all(targets.map((id) => {
    const about = critiques.filter((c) => c.author !== id)
      .map((c) => `--- ${displayName(c.author)} ---\n${c.content}`).join("\n\n");
    const brief = [
      `The other participants reviewed your position. Their reviews:`, ``, about, ``,
      `Give your position again, revised. Where a review changed your mind, change it and say which point did. Where you are holding your position, say that plainly and give the reason the review did not move you. Do not thank anyone.`,
    ].join("\n");
    return runOne(room, id, deps, { kind: "reply", brief });
  }));

  if (overBudget(room)) room.halted = "budget";
  return { ran: results, halted: room.halted };
}

// ─── Persistence shape ───────────────────────────────────────────────────────

/* A room is a session. It rides the existing sessions store rather than a
   second database, so it inherits its listing, deletion and backup for free.
   `kind: "room"` is what tells them apart, and its absence is what makes every
   session written before rooms existed still load as an ordinary thread. */
function toSession(room) {
  return {
    id: room.id, kind: "room", title: room.title, updatedAt: room.updatedAt, createdAt: room.createdAt,
    room: {
      template: room.template, brief: room.brief || "", agents: room.agents, defaultAgent: room.defaultAgent,
      budgetUsd: room.budgetUsd, spentUsd: room.spentUsd, cost: room.cost,
      critiqueRounds: room.critiqueRounds, halted: room.halted,
      seq: room.seq || 0, readSeq: room.readSeq || 0, routines: room.routines || [], council: room.council || null, councilHistory: room.councilHistory || [],
    },
    messages: room.messages,
  };
}

function fromSession(d) {
  if (!d || d.kind !== "room" || !d.room) return null;
  const messages = Array.isArray(d.messages) ? d.messages : [];
  // A room saved before messages carried ids gets them now, in order, so an
  // old transcript can be answered and counted like a new one.
  let seq = 0;
  for (const m of messages) {
    if (typeof m.seq === "number" && m.seq > seq) seq = m.seq;
  }
  for (const m of messages) {
    if (typeof m.seq !== "number") m.seq = ++seq;
    if (!m.id) m.id = "m" + m.seq.toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  }
  seq = Math.max(seq, d.room.seq || 0);
  return {
    id: d.id, kind: "room", title: d.title || "Untitled room",
    template: d.room.template || "", brief: String(d.room.brief || "").slice(0, MAX_BRIEF_CHARS),
    createdAt: d.createdAt || d.updatedAt || Date.now(),
    updatedAt: d.updatedAt || Date.now(),
    agents: (d.room.agents || []).map((a) => ({ ...a, state: "idle" })),
    defaultAgent: d.room.defaultAgent || "",
    messages,
    councilHistory: d.room.councilHistory || [],
    council: d.room.council ? { ...d.room.council, status: ["proposing", "classifying", "voting", "executing", "verifying", "ready"].includes(d.room.council.status) ? "paused" : d.room.council.status } : null,
    seq,
    // A room from before read marks existed loads as read: nothing in it is
    // news to the person who was there for all of it.
    readSeq: typeof d.room.readSeq === "number" ? d.room.readSeq : seq,
    routines: Array.isArray(d.room.routines) ? d.room.routines : [],
    budgetUsd: typeof d.room.budgetUsd === "number" ? d.room.budgetUsd : DEFAULT_ROOM_BUDGET_USD,
    spentUsd: d.room.spentUsd || 0,
    cost: d.room.cost || {},
    critiqueRounds: d.room.critiqueRounds || 0,
    halted: d.room.halted || "",
  };
}

/* The transcript as an ordinary session would have written it.

   This is what makes the one-agent parity claim checkable rather than asserted:
   a room with a single agent, flattened, must be exactly the message list the
   operator thread would have persisted for the same conversation. A seat's
   progress notes are rejoined onto its reply, because the operator thread
   would have held the whole turn's text as one assistant message. */
function toPlainMessages(room) {
  const progressOf = progressByRun(room);
  return room.messages
    .filter((m) => m.kind !== "critique" && m.kind !== "progress" && m.author !== SYSTEM)
    .map((m) => ({ role: isHuman(m.author) || m.author === ROUTINE ? "user" : "assistant",
      content: isReserved(m.author) ? m.content : withOwnProgress(m, progressOf) }));
}

/* What the rail needs to show a room as a colleague with an inbox: who is in
   it, the last thing said, how many things the operator has not seen, and
   whether anyone is working right now. */
function summary(room) {
  return {
    id: room.id, title: room.title, template: room.template || "", updatedAt: room.updatedAt,
    agents: room.agents.map((a) => a.agentId),
    names: room.agents.map((a) => displayName(a.agentId)),
    spentUsd: room.spentUsd || 0, halted: room.halted || "",
    unread: unreadCount(room), preview: preview(room),
    working: room.agents.some((a) => a.state === "working" || a.state === "queued"),
    workingAgents: room.agents.filter((a) => a.state === "working" || a.state === "queued").map((a) => a.agentId),
    routines: (room.routines || []).filter((r) => r.enabled).length,
    openAsk: room.messages.some((m) => m.ask && m.ask.state === "open"),
  };
}

module.exports = {
  HUMAN, ROUTINE, SYSTEM, isHuman, isReserved,
  createRoom, fromTemplate, updateRoom, parseAddress, viewFor, roomBrief, displayName,
  speak, critique, revise, runOne, forward,
  pushMessage, byId, preview, unreadCount, markRead, summary,
  normalizeAsk, extractAsk, answerAsk,
  REACTIONS, REACTION_LABEL, react, reactionLine,
  addRoutine, updateRoutine, removeRoutine, dueRoutines, claimRoutine, runRoutine, nextRunAt, graceMs, EVERY,
  noteCost, overBudget, projectRound, roomTier,
  toSession, fromSession, toPlainMessages,
  MAX_CRITIQUE_ROUNDS, DEFAULT_ROOM_BUDGET_USD, MAX_BRIEF_CHARS,
};
