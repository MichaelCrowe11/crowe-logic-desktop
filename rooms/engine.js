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
//   a message names its author  "operator", or an agent id, never a generic
//                               assistant label
//   every agent sees everything the shared transcript IS the feature. An agent
//                               that sees only its own turns is N sessions in
//                               one window wearing a costume
//   nobody speaks unaddressed   the single largest cost control here
//
// What this file deliberately does NOT do: write to the workspace. Gate 4 of
// the build order is worktree isolation, and until that lands `roomTier()`
// clamps every room to readonly. Three agents editing one tree is not a bug you
// recover from by looping.

const registry = require("./registry");

const MAX_CRITIQUE_ROUNDS = 2;
const DEFAULT_ROOM_BUDGET_USD = 1.0;

/* The human's author id, and why it is not "operator".

   The registry contains an agent whose id is exactly `operator` - Crowe
   Operator, the one that runs the estate. Using the bare word for the person as
   well made the two indistinguishable in the transcript: an agent's answer was
   attributed to the human, flattened into the session as a user message, and
   would have been fed back to the next turn as though the operator had said it.

   Registry ids are lowercase kebab, so a leading colon cannot collide with one
   now or later. Everything that decides "is this the person" asks this constant
   rather than comparing to a string. */
const HUMAN = ":operator";
const isHuman = (author) => author === HUMAN;

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

   The label is prose rather than a role field the gateway would have to
   understand, so this works on any OpenAI-compatible deployment. */
function viewFor(room, agentId) {
  const out = [];
  for (const m of room.messages) {
    if (isHuman(m.author)) {
      out.push({ role: "user", content: m.content });
    } else if (m.author === agentId) {
      out.push({ role: "assistant", content: m.content });
    } else {
      const who = displayName(m.author);
      const kind = m.kind === "critique" ? `${who}, reviewing` : who;
      out.push({ role: "user", content: `[${kind}]\n${m.content}` });
    }
  }
  return out;
}

function displayName(agentId) {
  if (isHuman(agentId)) return "Operator";
  const a = registry.getAgent(agentId);
  return a ? a.name : String(agentId);
}

/* The standing instruction an agent carries in a room, on top of whatever its
   registry role says. Rooms are a social setting and the model has to be told
   the rules of it, or it invents them - which in practice means thanking its
   colleagues for their thorough review. */
function roomBrief(room, agentId) {
  const me = registry.getAgent(agentId);
  const others = room.agents.filter((a) => a.agentId !== agentId).map((a) => displayName(a.agentId));
  return [
    me ? `You are ${me.name}. ${me.role}` : `You are ${agentId}.`,
    others.length
      ? `You are in a shared room with the operator and: ${others.join(", ")}. You can see their contributions and they can see yours.`
      : "You are in a room with the operator.",
    "Answer the operator and the room. Do not address the other participants directly, do not thank them, and do not comment on the quality of their work unless you are explicitly asked for a review.",
    "Speak from your own specialty. Where you disagree with what another participant concluded, say so plainly and give your reason.",
  ].join(" ");
}

// ─── Rooms ───────────────────────────────────────────────────────────────────

function createRoom({ id, title, agentIds, defaultAgent, budgetUsd, template } = {}) {
  // Only joinable agents are seated. An id that exists but is retired from
  // rooms is dropped here rather than at display time, so no caller - the
  // composer, a template, or a raw IPC create - can compose around the flag.
  const ids = (agentIds || []).filter((x) => registry.isJoinable(x));
  return {
    id: id || "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
    kind: "room",
    title: title || "Untitled room",
    template: template || "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    agents: ids.map((agentId) => ({ agentId, model: (registry.getAgent(agentId) || {}).model || "", state: "idle" })),
    defaultAgent: defaultAgent && ids.includes(defaultAgent) ? defaultAgent : ids[0] || "",
    messages: [],
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
   if it were work. */
async function runOne(room, agentId, deps, { kind = "reply", brief = "" } = {}) {
  setState(room, agentId, "working");
  const seat = room.agents.find((a) => a.agentId === agentId) || {};
  const messages = viewFor(room, agentId);
  if (brief) messages.push({ role: "user", content: brief });

  let res;
  try {
    res = await deps.runAgent({
      agentId,
      roomId: room.id,
      model: seat.model || "",
      systemBrief: roomBrief(room, agentId),
      messages,
      tier: room.tier || "readonly",
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

  const text = String(res.text || "").trim();
  if (!text) { setState(room, agentId, "failed"); return { agentId, ok: false, error: "empty answer" }; }

  const msg = { author: agentId, content: text, kind, at: Date.now(), replyTo: kind === "critique" ? res.replyTo || "" : "" };
  room.messages.push(msg);
  room.updatedAt = Date.now();
  setState(room, agentId, "done");
  return { agentId, ok: true, text, message: msg };
}

/* The operator says something; whoever is addressed answers.

   Concurrently, not round-robin: three specialists asked the same question
   should be able to think at once, and a room that serialises them for no
   reason feels broken in a way no amount of status text repairs. */
async function speak(room, text, deps, { author = HUMAN } = {}) {
  if (room.halted) return { halted: room.halted, ran: [] };
  const addr = parseAddress(text, room);
  room.messages.push({ author, content: String(text), kind: "say", at: Date.now(), to: addr.to.slice() });
  room.updatedAt = Date.now();

  // Everyone not addressed is explicitly idle rather than left on whatever they
  // were, so "queued" never lingers on an agent that is not going to run.
  for (const seat of room.agents) seat.state = addr.to.includes(seat.agentId) ? "queued" : "idle";

  if (overBudget(room)) { room.halted = "budget"; return { halted: "budget", ran: [], address: addr }; }

  const results = await Promise.all(addr.to.map((id) => runOne(room, id, deps, { kind: "reply" })));
  if (overBudget(room)) room.halted = "budget";
  return { ran: results, address: addr, halted: room.halted };
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
    id: room.id, kind: "room", title: room.title, updatedAt: room.updatedAt,
    room: {
      template: room.template, agents: room.agents, defaultAgent: room.defaultAgent,
      budgetUsd: room.budgetUsd, spentUsd: room.spentUsd, cost: room.cost,
      critiqueRounds: room.critiqueRounds, halted: room.halted,
    },
    messages: room.messages,
  };
}

function fromSession(d) {
  if (!d || d.kind !== "room" || !d.room) return null;
  return {
    id: d.id, kind: "room", title: d.title || "Untitled room",
    template: d.room.template || "", createdAt: d.createdAt || d.updatedAt || Date.now(),
    updatedAt: d.updatedAt || Date.now(),
    agents: (d.room.agents || []).map((a) => ({ ...a, state: "idle" })),
    defaultAgent: d.room.defaultAgent || "",
    messages: Array.isArray(d.messages) ? d.messages : [],
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
   operator thread would have persisted for the same conversation. */
function toPlainMessages(room) {
  return room.messages
    .filter((m) => m.kind !== "critique")
    .map((m) => ({ role: isHuman(m.author) ? "user" : "assistant", content: m.content }));
}

module.exports = {
  HUMAN, isHuman,
  createRoom, fromTemplate, parseAddress, viewFor, roomBrief, displayName,
  speak, critique, revise, runOne,
  noteCost, overBudget, projectRound, roomTier,
  toSession, fromSession, toPlainMessages,
  MAX_CRITIQUE_ROUNDS, DEFAULT_ROOM_BUDGET_USD,
};
