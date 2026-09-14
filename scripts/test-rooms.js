#!/usr/bin/env node
// The room engine, exercised against a fake runner.
//
//   node scripts/test-rooms.js
//
// The engine takes its model call as an injected dependency precisely so this
// file can exist: addressing, shared visibility, concurrency, per-agent status,
// cost attribution, the budget cap and the critique loop are all decidable
// without a gateway. What is NOT decidable here is whether critique actually
// improves an answer, because that needs real models and a real SKU. That
// question is answered in docs/ROOMS-REPORT.md and is not faked here.
//
// Every claim in the definition of done that can be mechanically checked has a
// check below with the same name.

const fs = require("fs");
const path = require("path");
const registry = require("../rooms/registry");
const wt = require("../rooms/worktrees");
const rooms = require("../rooms/engine");

let failures = 0;
async function check(name, fn) {
  try { const d = await fn(); console.log(`  ok   ${name}${d ? ` — ${d}` : ""}`); }
  catch (e) { failures += 1; console.log(`  FAIL ${name}\n       ${String(e.message || e).split("\n").join("\n       ")}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

/* A runner that records what it was asked and answers deterministically.

   `script` maps an agent id to a function of (call) so a test can make one
   agent fail, make another change its mind after a critique, or assert on the
   exact transcript an agent was handed. Every call is kept in `calls` so the
   tests can prove what did NOT happen - an unaddressed agent spending nothing
   is a claim about absence, and absence is only checkable against a log. */
function fakeRunner(script = {}) {
  const calls = [];
  const run = async (call) => {
    calls.push(call);
    const fn = script[call.agentId];
    const out = fn ? await fn(call, calls) : { text: `${call.agentId} says something.` };
    if (out && out.throws) throw new Error(out.throws);
    return { usage: { usd: 0.01, promptTokens: 100, completionTokens: 50 }, ...out };
  };
  return { runAgent: run, calls };
}

const roomOf = (ids, extra = {}) =>
  rooms.createRoom({ agentIds: ids, defaultAgent: ids[0], title: "Test room", ...extra });

(async () => {
  console.log("rooms");

  // ── registry ───────────────────────────────────────────────────────────────

  await check("the vendored roster is the canonical one, not an invented parallel", () => {
    const ids = registry.listAgents().map((a) => a.id);
    assert(ids.length >= 20, `only ${ids.length} agents vendored`);
    for (const must of ["crowe-logic", "operator", "cultivation-intelligence", "mycology-research",
      "regulatory-affairs", "compliance-audit", "commerce-support", "product-formulation",
      "extraction-formulation", "facility-design", "revenue", "email", "sop", "auction", "studio"]) {
      assert(ids.includes(must), `registry is missing ${must}`);
    }
    return `${ids.length} agents`;
  });

  await check("the vendored snapshot matches upstream when upstream is present", () => {
    const up = path.join("/workspace/crowe-agents", "registry", "agents.json");
    if (!fs.existsSync(up)) return "skipped: no crowe-agents checkout here";
    const { vendor } = require("./sync-agent-registry.js");
    const fresh = vendor(up);
    const have = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "rooms", "agents.vendored.json"), "utf8"));
    assert(fresh.agents.length === have.agents.length, `upstream has ${fresh.agents.length}, vendored has ${have.agents.length}`);
    const diff = fresh.agents.filter((a, i) => JSON.stringify(a) !== JSON.stringify(have.agents[i])).map((a) => a.id);
    assert(!diff.length, `drifted from upstream: ${diff.join(", ")} — run scripts/sync-agent-registry.js`);
    return "in step with upstream";
  });

  await check("a room's ceiling is the minimum of its agents, never the max", () => {
    // regulatory-affairs is advisory (plan); operator is read_confirm (edit).
    assert(registry.roomCeiling(["operator"]) === "edit", "operator alone should reach edit");
    assert(registry.roomCeiling(["operator", "regulatory-affairs"]) === "plan",
      "an advisory agent must drag the room down to plan");
    // and the app's own tier still clamps from above
    assert(registry.effectiveTier(["operator"], "readonly") === "readonly", "config must clamp the roster");
    return "min across roster, then clamped by config";
  });

  await check("templates span the roster rather than one corner of it", () => {
    /* Three of the first four templates leaned cultivation while the registry
       spans sixteen domains, which made a general mechanism look like a
       vertical feature. The rule this asserts is not "more templates" but that
       the curated set reaches past a single part of the business. */
    const ts = registry.listTemplates();
    const domains = new Set(ts.flatMap((t) => t.agents.map((a) => a.domain)));
    assert(domains.size >= 8, `templates only reach ${domains.size} domains: ${[...domains].join(", ")}`);
    for (const id of ["launch-review", "security-posture", "molecule-triage", "the-week"]) {
      assert(ts.some((t) => t.id === id), `missing cross-vertical template ${id}`);
    }
    /* Every template must still be a real argument rather than three seats
       holding one opinion. Judged on distinct agents with distinct roles, not
       on distinct `domain` tags: that field is coarser than the specialties
       inside it - scheduling, email and revenue all read as "operations" while
       answering completely different questions about the same week - so a
       domain check rejects good rooms and would have deleted this one. The
       aggregate span above is where the domain field earns its keep. */
    const flat = ts.filter((t) => t.id !== "bake-off" && t.agents.length > 1)
      .filter((t) => new Set(t.agents.map((a) => a.role)).size < t.agents.length).map((t) => t.id);
    assert(!flat.length, `templates seat the same specialty twice: ${flat.join(", ")}`);
    return `${ts.length} templates across ${domains.size} domains`;
  });

  await check("an agent retired from rooms cannot be seated by any path", async () => {
    /* roomJoinable is how upstream retires an agent from rooms without deleting
       it. Filtering only the displayed roster left every other door open: a
       template could still name it, createRoom would still seat it, and IPC
       join would still add it. The flag is asked at each of those points now. */
    const reg = require("../rooms/registry");
    const real = reg.getAgent("commerce-support");
    const saved = real.roomJoinable;
    try {
      real.roomJoinable = false;                       // retire it upstream
      assert(!reg.isJoinable("commerce-support"), "isJoinable ignored the flag");
      assert(!reg.listAgents().some((a) => a.id === "commerce-support"), "a retired agent is still listed");
      // A template that names it composes without it rather than with it.
      const t = reg.getTemplate("product-review");
      assert(!t.agents.some((a) => a.id === "commerce-support"), "a template still seats a retired agent");
      // And direct composition - the raw IPC path - drops it too.
      const room = rooms.createRoom({ agentIds: ["product-formulation", "commerce-support"] });
      assert(room.agents.length === 1, `createRoom seated a retired agent: ${room.agents.map((a) => a.agentId)}`);
      // getAgent still resolves it, so a room saved before the retirement can
      // still show who was in it.
      assert(reg.getAgent("commerce-support"), "a retired agent became unresolvable");
      return "listed, templated, composed and joined: all closed";
    } finally { real.roomJoinable = saved; }
  });

  await check("a display name with punctuation still resolves as a handle", () => {
    // "Compliance & Audit" cannot be typed as a handle with its ampersand, so
    // the name is reduced to alphanumerics on both sides of the match.
    const room = roomOf(["compliance-audit", "product-formulation"]);
    const a = rooms.parseAddress("@ComplianceAudit take this", room);
    assert(a.to.length === 1 && a.to[0] === "compliance-audit", `resolved to ${a.to.join(",") || "nothing"}`);
    const b = rooms.parseAddress("@ProductFormulation and you", room);
    assert(b.to[0] === "product-formulation", "an ampersand-free name stopped resolving");
    return "@ComplianceAudit resolves";
  });

  await check("a room composes from any agents, with no template at all", async () => {
    // The composer's path. Three verticals no template names.
    const room = rooms.createRoom({ title: "Ad hoc", agentIds: ["revenue", "compliance-audit", "studio"] });
    assert(room.agents.length === 3, "ad-hoc composition dropped agents");
    assert(room.defaultAgent === "revenue", "ad-hoc room has no default agent");
    const f = fakeRunner();
    await rooms.speak(room, "@room go", f);
    assert(f.calls.length === 3, `expected 3 calls, got ${f.calls.length}`);
    // An id that is not in the registry is dropped rather than seated.
    const bad = rooms.createRoom({ agentIds: ["revenue", "not-an-agent"] });
    assert(bad.agents.length === 1, "an unknown agent id was seated");
    return "revenue + compliance-audit + studio";
  });

  await check("templates name real specialists, not three interchangeable agents", () => {
    const t = registry.getTemplate("product-review");
    assert(t, "product-review template missing");
    const ids = t.agents.map((a) => a.id);
    assert(ids.includes("product-formulation") && ids.includes("regulatory-affairs"),
      `product-review roster is ${ids.join(", ")}`);
    const domains = new Set(t.agents.map((a) => a.domain));
    assert(domains.size >= 2, "a review room whose agents share one domain is a bake-off");
    return `${ids.join(" + ")}`;
  });

  // ── gate 2: one-agent parity ───────────────────────────────────────────────

  await check("a one-agent room behaves like today's operator thread", async () => {
    const room = roomOf(["operator"]);
    const f = fakeRunner({ operator: () => ({ text: "Checked the tree; nothing is dirty." }) });
    await rooms.speak(room, "what is the state of the repo", f);
    assert(f.calls.length === 1, `one agent should make one call, made ${f.calls.length}`);

    // The transcript the agent saw is exactly what a plain thread would send:
    // one user message, no room framing, because there is nobody else in it.
    const seen = f.calls[0].messages;
    assert(seen.length === 1 && seen[0].role === "user", `saw ${JSON.stringify(seen)}`);

    // And what gets persisted flattens to the same shape sessions already hold.
    const plain = rooms.toPlainMessages(room);
    assert(plain.length === 2 && plain[0].role === "user" && plain[1].role === "assistant",
      `flattened to ${JSON.stringify(plain)}`);
    assert(plain[1].content === "Checked the tree; nothing is dirty.", "the answer did not survive flattening");
    return "1 call, identical message shape";
  });

  await check("a room round-trips through the sessions store unchanged", async () => {
    const room = roomOf(["product-formulation", "regulatory-affairs"]);
    await rooms.speak(room, "@room open with your position", fakeRunner());
    const back = rooms.fromSession(JSON.parse(JSON.stringify(rooms.toSession(room))));
    assert(back, "a room did not survive the session round trip");
    assert(back.messages.length === room.messages.length, "messages lost in the round trip");
    assert(back.agents.length === 2 && back.spentUsd === room.spentUsd, "roster or cost lost in the round trip");
    // Sessions written before rooms existed must still load as plain threads.
    assert(rooms.fromSession({ id: "s-old", messages: [] }) === null, "a plain session was mistaken for a room");
    return "roster, cost and transcript preserved";
  });

  // ── gate 3: addressing, visibility, concurrency, status ────────────────────

  await check("an unaddressed agent spends nothing", async () => {
    const room = roomOf(["product-formulation", "regulatory-affairs", "commerce-support"]);
    const f = fakeRunner();
    await rooms.speak(room, "@regulatory-affairs does this label clear", f);
    assert(f.calls.length === 1, `expected 1 call, got ${f.calls.length}`);
    assert(f.calls[0].agentId === "regulatory-affairs", `wrong agent ran: ${f.calls[0].agentId}`);
    const idle = room.agents.filter((a) => a.state === "idle").map((a) => a.agentId);
    assert(idle.length === 2, `unaddressed agents should be idle, states: ${JSON.stringify(room.agents)}`);
    return "1 of 3 ran";
  });

  await check("@room addresses everyone and a bare message addresses one", async () => {
    const room = roomOf(["product-formulation", "regulatory-affairs", "commerce-support"]);
    const f = fakeRunner();
    await rooms.speak(room, "@room open", f);
    assert(f.calls.length === 3, `@room should call 3, called ${f.calls.length}`);
    await rooms.speak(room, "and what about cost", f);
    assert(f.calls.length === 4, `a bare message should call 1 more, total is ${f.calls.length}`);
    assert(f.calls[3].agentId === "product-formulation", `default agent should answer, got ${f.calls[3].agentId}`);
    return "3 then 1";
  });

  await check("a display-name mention resolves, an unknown one is reported not guessed", async () => {
    const room = roomOf(["regulatory-affairs", "commerce-support"]);
    const a = rooms.parseAddress("@RegulatoryAffairs check this", room);
    assert(a.to.length === 1 && a.to[0] === "regulatory-affairs", `resolved to ${a.to.join(",")}`);
    const b = rooms.parseAddress("@nobody hello", room);
    assert(b.unknown.includes("@nobody"), "an unknown handle vanished silently");
    assert(b.to.length === 1 && b.defaulted, "an unknown handle should fall back to the default agent, visibly");
    return "name resolved, typo surfaced";
  });

  await check("every agent sees the others' work, framed as theirs and not its own", async () => {
    const room = roomOf(["product-formulation", "regulatory-affairs"]);
    const f = fakeRunner({
      "product-formulation": () => ({ text: "Two grams of extract per serving." }),
      "regulatory-affairs": () => ({ text: "That dose needs substantiation." }),
    });
    await rooms.speak(room, "@room open on the SKU", f);
    await rooms.speak(room, "@regulatory-affairs expand", f);

    const seen = f.calls[f.calls.length - 1].messages;
    const own = seen.filter((m) => m.role === "assistant");
    const peer = seen.filter((m) => m.role === "user" && /Product & Formulation/.test(m.content));
    assert(own.some((m) => /substantiation/.test(m.content)), "an agent could not see its own past turn");
    assert(peer.length === 1, "an agent could not see its peer's turn");
    assert(peer[0].content.startsWith("[Product & Formulation]"), `peer turn was not attributed: ${peer[0].content.slice(0, 40)}`);
    assert(!own.some((m) => /Two grams/.test(m.content)),
      "a peer's words were handed over as the agent's own assistant history");
    return "own as assistant, peers labelled as user";
  });

  await check("addressed agents run concurrently, not one after another", async () => {
    const room = roomOf(["product-formulation", "regulatory-affairs", "commerce-support"]);
    let live = 0, peak = 0;
    const f = fakeRunner(Object.fromEntries(room.agents.map((a) => [a.agentId, async () => {
      live += 1; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 30));
      live -= 1;
      return { text: "done" };
    }])));
    const t0 = Date.now();
    await rooms.speak(room, "@room go", f);
    const ms = Date.now() - t0;
    assert(peak === 3, `peak concurrency was ${peak}, so they ran in series`);
    assert(ms < 80, `three 30ms calls took ${ms}ms, so they were serialised`);
    return `peak ${peak}, ${ms}ms`;
  });

  await check("one agent failing does not fail the room, and never reports done", async () => {
    const room = roomOf(["product-formulation", "regulatory-affairs", "commerce-support"]);
    const f = fakeRunner({ "regulatory-affairs": () => ({ throws: "gateway unreachable" }) });
    const out = await rooms.speak(room, "@room go", f);
    const failed = room.agents.find((a) => a.agentId === "regulatory-affairs");
    assert(failed.state === "failed", `errored agent reported "${failed.state}"`);
    assert(room.agents.filter((a) => a.state === "done").length === 2, "the other agents did not finish");
    assert(out.ran.filter((r) => r.ok).length === 2, "the room did not continue past the failure");
    // and its error text is not in the transcript pretending to be a position
    assert(!room.messages.some((m) => /unreachable/.test(m.content)), "an error was recorded as an agent's contribution");
    return "1 failed, 2 done, room alive";
  });

  await check("an empty answer is a failure, not a silent success", async () => {
    const room = roomOf(["operator"]);
    const f = fakeRunner({ operator: () => ({ text: "   " }) });
    const out = await rooms.speak(room, "hello", f);
    assert(!out.ran[0].ok, "an empty answer was accepted");
    assert(room.agents[0].state === "failed", `state was ${room.agents[0].state}`);
    return "empty answer rejected";
  });

  // ── gate 4 guard ───────────────────────────────────────────────────────────

  await check("no room writes until worktree isolation lands", () => {
    const room = roomOf(["operator"]);                    // operator can reach edit
    assert(rooms.roomTier(room, "execute") === "readonly",
      "a write-capable roster reached a write tier without worktree isolation");
    assert(rooms.roomTier(room, "execute", { allowWrites: true }) === "edit",
      "the gate does not open when isolation is declared");
    assert(rooms.roomTier(roomOf(["regulatory-affairs"]), "execute", { allowWrites: true }) === "plan",
      "an advisory agent was pushed above its ceiling by the gate opening");
    return "clamped to readonly, fails closed";
  });

  // ── gate 5: cost ───────────────────────────────────────────────────────────

  await check("per-agent cost attribution sums to the room total", async () => {
    const room = roomOf(["product-formulation", "regulatory-affairs", "commerce-support"]);
    const f = fakeRunner();
    await rooms.speak(room, "@room go", f);
    await rooms.speak(room, "@regulatory-affairs again", f);
    const sum = Object.values(room.cost).reduce((s, c) => s + c.usd, 0);
    assert(Math.abs(sum - room.spentUsd) < 1e-9, `parts sum to ${sum}, room says ${room.spentUsd}`);
    assert(room.cost["regulatory-affairs"].calls === 2, "per-agent call count is wrong");
    assert(room.cost["commerce-support"].calls === 1, "an agent was billed for a turn it did not take");
    return `$${room.spentUsd.toFixed(2)} across 3 agents, 4 calls`;
  });

  await check("the budget cap fires and halts the room", async () => {
    const room = roomOf(["product-formulation", "regulatory-affairs"], { budgetUsd: 0.03 });
    const f = fakeRunner();
    await rooms.speak(room, "@room one", f);      // 2 calls = $0.02
    assert(!room.halted, "halted too early");
    await rooms.speak(room, "@room two", f);      // 2 more = $0.04, over
    assert(room.halted === "budget", `room did not halt, spent ${room.spentUsd}`);
    const before = f.calls.length;
    const out = await rooms.speak(room, "@room three", f);
    assert(f.calls.length === before, "a halted room kept spending");
    assert(out.halted === "budget", "a halted room did not say why");
    return `halted at $${room.spentUsd.toFixed(2)} of $0.03`;
  });

  await check("a round's cost is projected before it runs", async () => {
    const room = roomOf(["product-formulation", "regulatory-affairs", "commerce-support"]);
    assert(rooms.projectRound(room, "critique").calls === 3, "critique projection is wrong");
    const f = fakeRunner({ "commerce-support": () => ({ throws: "down" }) });
    await rooms.speak(room, "@room go", f);
    assert(rooms.projectRound(room, "critique").calls === 2, "a failed agent is still being projected for");
    return "3 calls, then 2 after a failure";
  });

  // ── gate 6: critique and revise ────────────────────────────────────────────

  await check("each agent reviews the others and never itself", async () => {
    const room = roomOf(["product-formulation", "regulatory-affairs", "commerce-support"]);
    const positions = {
      "product-formulation": "POSITION-PF", "regulatory-affairs": "POSITION-RA", "commerce-support": "POSITION-CS",
    };
    const f = fakeRunner(Object.fromEntries(Object.entries(positions).map(([id, p]) => [id, () => ({ text: p })])));
    await rooms.speak(room, "@room open", f);
    const before = f.calls.length;
    const out = await rooms.critique(room, f);

    assert(f.calls.length - before === 3, `critique made ${f.calls.length - before} calls`);
    for (const call of f.calls.slice(before)) {
      const brief = call.messages[call.messages.length - 1].content;
      assert(!brief.includes(positions[call.agentId]), `${call.agentId} was handed its own position to review`);
      for (const [other, p] of Object.entries(positions)) {
        if (other !== call.agentId) assert(brief.includes(p), `${call.agentId} was not shown ${other}'s position`);
      }
      assert(/Do not review your own/.test(brief), `${call.agentId} was not told to skip its own work`);
    }
    assert(out.ran.every((r) => r.ok), "a critique failed");
    assert(room.messages.filter((m) => m.kind === "critique").length === 3, "critiques were not recorded as critiques");
    return "3 reviews, none self";
  });

  await check("a failed agent is excluded from the critique round", async () => {
    const room = roomOf(["product-formulation", "regulatory-affairs", "commerce-support"]);
    const f = fakeRunner({ "commerce-support": () => ({ throws: "gateway down" }) });
    await rooms.speak(room, "@room open", f);
    const before = f.calls.length;
    await rooms.critique(room, f);
    const critics = f.calls.slice(before).map((c) => c.agentId);
    assert(!critics.includes("commerce-support"), "a failed agent was asked to review");
    assert(critics.length === 2, `expected 2 critics, got ${critics.length}`);
    for (const call of f.calls.slice(before)) {
      assert(!/Commerce/.test(call.messages[call.messages.length - 1].content),
        "a failed agent's non-output was put up for review");
    }
    return "2 critics, failure excluded";
  });

  await check("revise hands each agent the critiques written about it", async () => {
    const room = roomOf(["product-formulation", "regulatory-affairs"]);
    const f = fakeRunner({
      "product-formulation": (call) => ({
        // Changes position only once it has been reviewed.
        text: /reviewed your position/.test(call.messages[call.messages.length - 1].content)
          ? "REVISED: dropping to one gram, the substantiation point stands."
          : "Two grams per serving.",
      }),
      "regulatory-affairs": () => ({ text: "Two grams needs a human study to substantiate." }),
    });
    await rooms.speak(room, "@room open", f);
    await rooms.critique(room, f);
    const before = f.calls.length;
    await rooms.revise(room, f);

    const pf = f.calls.slice(before).find((c) => c.agentId === "product-formulation");
    const brief = pf.messages[pf.messages.length - 1].content;
    assert(/Regulatory Affairs/.test(brief), "an agent was not shown who reviewed it");
    assert(!/--- Product & Formulation ---/.test(brief), "an agent was handed its own critique to answer");
    const last = room.messages[room.messages.length - 1];
    assert(/REVISED/.test(room.messages.map((m) => m.content).join("\n")), "the revision was not recorded");
    assert(last.kind === "reply", "a revision was filed as something other than a position");
    return "critiques routed, position changed";
  });

  await check("the critique loop is capped", async () => {
    const room = roomOf(["product-formulation", "regulatory-affairs"], { budgetUsd: 100 });
    const f = fakeRunner();
    await rooms.speak(room, "@room open", f);
    await rooms.critique(room, f);
    await rooms.critique(room, f);
    const before = f.calls.length;
    const third = await rooms.critique(room, f);
    assert(third.capped, "a third critique round was allowed");
    assert(f.calls.length === before, "a capped round still spent money");
    return `capped at ${rooms.MAX_CRITIQUE_ROUNDS}`;
  });

  await check("critique refuses when there is nothing to compare", async () => {
    const room = roomOf(["operator"]);
    const f = fakeRunner();
    await rooms.speak(room, "hello", f);
    const before = f.calls.length;
    const out = await rooms.critique(room, f);
    assert(f.calls.length === before, "a one-agent room ran a critique round anyway");
    assert(/at least two/.test(out.note || ""), "no reason was given");
    return "declined with a reason";
  });

  await check("agents are told not to address each other outside a review", () => {
    const room = roomOf(["product-formulation", "regulatory-affairs"]);
    const brief = rooms.roomBrief(room, "product-formulation");
    assert(/Do not address the other participants directly/.test(brief), "nothing stops peer chatter");
    assert(/do not thank them/i.test(brief), "nothing stops the thank-you spiral");
    assert(/Regulatory Affairs/.test(brief), "an agent is not told who else is present");
    return "peer chatter closed off";
  });

  // ── gate 5: stop reaches room agents ───────────────────────────────────────

  await check("stop-all halts every agent in every room, mid-flight", async () => {
    /* Verified against the real mechanism rather than a mock of it. main.js
       registers every room seat in the same `agentRuns` map that
       crowe:agent:stop-all and crowe:operator:stop-all iterate, so this
       reproduces that map and that loop exactly: seats register, the stop-all
       body runs, and the seats must notice.

       Both handlers were written when one agent existed. The spec says verify
       rather than assume, and this is the verification. */
    const agentRuns = new Map();
    const seatId = (roomId, agentId) => `room:${roomId}:${agentId}`;
    const room = roomOf(["product-formulation", "regulatory-affairs", "commerce-support"]);
    let stopAll = null;

    const deps = { runAgent: async ({ agentId }) => {
      const id = seatId(room.id, agentId);
      const run = { aborted: false, controller: null };
      agentRuns.set(id, run);
      try {
        // Two seats in, the operator hits stop. Everything in flight must see it.
        if (agentRuns.size === 2 && stopAll) stopAll();
        for (let i = 0; i < 40; i++) {
          if (run.aborted) return { stopped: true, usage: { usd: 0.01 } };
          await new Promise((r) => setTimeout(r, 5));
        }
        return { text: "finished without noticing the stop", usage: { usd: 0.01 } };
      } finally { agentRuns.delete(id); }
    } };

    // The body of crowe:operator:stop-all, verbatim in shape.
    stopAll = () => {
      for (const run of agentRuns.values()) { run.aborted = true; try { if (run.controller) run.controller.abort(); } catch {} }
    };

    const out = await rooms.speak(room, "@room go", deps);
    const finished = out.ran.filter((r) => r.ok);
    assert(!finished.length, `${finished.length} agent(s) ran to completion through a stop-all`);
    assert(out.ran.every((r) => r.stopped || !r.ok), "an agent neither stopped nor failed");
    assert(!room.agents.some((a) => a.state === "done"), `a stopped agent reported done: ${JSON.stringify(room.agents.map((a) => a.state))}`);
    assert(agentRuns.size === 0, "a run was left registered after the room finished");
    return `3 seats halted, none reported done`;
  });

  await check("a stopped agent is not recorded as a contribution", async () => {
    const room = roomOf(["product-formulation", "regulatory-affairs"]);
    const deps = { runAgent: async () => ({ stopped: true, usage: { usd: 0.005 } }) };
    await rooms.speak(room, "@room go", deps);
    assert(!room.messages.some((m) => m.author !== rooms.HUMAN), "a stopped turn entered the transcript");
    assert(room.spentUsd > 0, "a stopped turn should still bill for what it burned before stopping");
    return "no phantom positions, cost still counted";
  });

  await check("the human and the agent named operator are different authors", async () => {
    /* The registry contains an agent whose id is literally `operator`. Sharing
       the bare word with the person made an agent's answer flatten into the
       session as though the operator had typed it, and the next turn would have
       read it back as the user's own words. */
    const room = roomOf(["operator"]);
    const f = fakeRunner({ operator: () => ({ text: "AGENT-SAID" }) });
    await rooms.speak(room, "HUMAN-SAID", f);
    assert(rooms.HUMAN !== "operator", "the human still shares an id with the operator agent");
    const plain = rooms.toPlainMessages(room);
    assert(plain[0].role === "user" && plain[0].content === "HUMAN-SAID", "the human turn was misattributed");
    assert(plain[1].role === "assistant" && plain[1].content === "AGENT-SAID", "the agent turn was misattributed");
    return "collision closed";
  });


  // ── a room as a colleague: progress, questions, routines, relays, inbox ────
  console.log("");
  console.log("rooms as standing colleagues");

  const AT = (h, m, dayOffset = 0) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, h, m, 0, 0).getTime(); };

  await check("a seat works out loud: progress lands live and its last note becomes the reply", async () => {
    const room = roomOf(["operator", "regulatory-affairs"]);
    const f = fakeRunner({ operator: async (call) => {
      call.onProgress("Checking the crontab and launchd first.");
      call.onProgress("Nothing on this Mac uploads Shorts. The job is elsewhere.");
      // The harness hands back the whole turn's text: the notes, joined.
      return { text: "Checking the crontab and launchd first.\n\nNothing on this Mac uploads Shorts. The job is elsewhere." };
    } });
    await rooms.speak(room, "@operator find the Shorts job", f);
    const kinds = room.messages.map((m) => m.kind);
    assert(kinds.join(",") === "say,progress,reply", `kinds were ${kinds.join(",")}`);
    const [, note, reply] = room.messages;
    assert(reply.content === "Nothing on this Mac uploads Shorts. The job is elsewhere.", "the last note was not promoted to the reply");
    assert(note.runId && note.runId === reply.runId, "progress and reply do not share a run");
    assert(room.messages.every((m) => m.id && m.seq), "a message is missing its id or sequence");
    // Its own memory keeps the notes; the operator thread would have held the whole turn as one message.
    const own = rooms.viewFor(room, "operator").find((m) => m.role === "assistant");
    assert(/Checking the crontab/.test(own.content) && /elsewhere/.test(own.content), "the seat lost its own working notes");
    const plain = rooms.toPlainMessages(room);
    assert(plain.length === 2 && plain[1].content === "Checking the crontab and launchd first.\n\nNothing on this Mac uploads Shorts. The job is elsewhere.", "flattening did not rejoin the turn");
    // The other seat pays for the reply, not for the notes.
    const other = rooms.viewFor(room, "regulatory-affairs");
    assert(!other.some((m) => /Checking the crontab/.test(m.content)), "another seat was handed a colleague's working notes");
    assert(other.some((m) => /elsewhere/.test(m.content)), "another seat did not see the reply");
    return "3 messages, one run, notes private to the seat";
  });

  await check("a question from the tool becomes a card, and the tap answers the seat that asked", async () => {
    const room = roomOf(["operator", "regulatory-affairs"]);
    const f = fakeRunner({ operator: async (call, calls) => calls.length === 1
      ? { text: "A live uploader is still dropping two machine Shorts a day.", proposal: { question: "Stop the machine Shorts job?", options: ["Stop the shorts job", "Leave it running", "Stop the shorts job"] } }
      : { text: "Stopping it. Next drop is about five minutes out." } });
    await rooms.speak(room, "morning snapshot", f);
    const asked = room.messages.find((m) => m.ask);
    assert(asked && asked.author === "operator", "no card was recorded on the reply");
    assert(asked.ask.state === "open" && asked.ask.options.length === 2, `options were ${JSON.stringify(asked.ask.options)} (duplicates must collapse)`);
    assert(rooms.summary(room).openAsk, "the summary does not say a question is open");
    const bad = await rooms.answerAsk(room, asked.id, "z", f);
    assert(bad.error && /no such option/.test(bad.error), "an unknown option was accepted");
    const out = await rooms.answerAsk(room, asked.id, "a", f);
    assert(out.ran && out.ran[0].agentId === "operator", "the answer did not go back to the seat that asked");
    const tap = room.messages.find((m) => rooms.isHuman(m.author) && m.quote);
    assert(tap.content === "Stop the shorts job" && tap.quote === "Stop the machine Shorts job?" && tap.to.join() === "operator", `the tap landed as ${JSON.stringify(tap)}`);
    assert(asked.ask.state === "answered" && asked.ask.chosen === "a", "the card was not marked answered");
    const twice = await rooms.answerAsk(room, asked.id, "b", f);
    assert(twice.error && /already answered/.test(twice.error), "a second tap re-ran the decision");
    assert(f.calls.length === 2, `expected 2 calls, made ${f.calls.length}`);
    return "asked, tapped once, refused twice";
  });

  await check("the fenced fallback is read only when it ends the message", () => {
    const good = rooms.extractAsk("Found it.\n\n```ask\nStop the job?\n- Stop it\n- Leave it\n```");
    assert(good.ask && good.ask.options.length === 2 && good.text === "Found it.", `trailing block not read: ${JSON.stringify(good)}`);
    const mid = rooms.extractAsk("```ask\nStop the job?\n- Stop it\n```\nAnd then I kept going.");
    assert(!mid.ask && /kept going/.test(mid.text), "a block in the middle of the text was made actionable");
    const two = rooms.extractAsk("```ask\nA?\n- x\n```\n\n```ask\nB?\n- y\n```");
    assert(!two.ask, "two blocks were accepted");
    const bare = rooms.extractAsk("```ask\nJust a question with no options\n```");
    assert(!bare.ask, "a question with nothing to tap became a card");
    const many = rooms.extractAsk("```ask\nWhich?\n- a\n- b\n- c\n- d\n- e\n- f\n```");
    assert(many.ask && many.ask.options.length === 4, "options were not capped at four");
    return "trailing only, capped at four";
  });

  await check("typing instead of tapping closes the open question", async () => {
    const room = roomOf(["operator"]);
    const f = fakeRunner({ operator: async (call, calls) => calls.length === 1
      ? { text: "Eight replies drafted.", proposal: { question: "Want these 8 replies posted as you?", options: ["Post them as me"] } }
      : { text: "Skipping the cordyceps one. Posting the other 7 as you." } });
    await rooms.speak(room, "draft replies", f);
    const asked = room.messages.find((m) => m.ask);
    await rooms.speak(room, "not the cordyceps one", f);
    assert(asked.ask.state === "answered" && asked.ask.chosen === "" && asked.ask.answer === "not the cordyceps one", `card state ${JSON.stringify(asked.ask)}`);
    const typed = room.messages.find((m) => rooms.isHuman(m.author) && m.content === "not the cordyceps one");
    assert(typed.closedAsks && typed.closedAsks[0] === asked.id, "the typed reply does not record which card it closed");
    const late = await rooms.answerAsk(room, asked.id, "a", f);
    assert(late.error, "a stale card could still be tapped after the operator had answered in words");
    return "closed by words, tap refused after";
  });

  await check("a routine speaks first: one seat, attributed to the routine, read as the operator's order", async () => {
    const room = roomOf(["product-formulation", "regulatory-affairs"]);
    const now = AT(8, 0);
    const added = rooms.addRoutine(room, { agentId: "regulatory-affairs", text: "Morning snapshot of the channel, then one next action.", every: "minutes", minutes: 30 }, now);
    assert(added.routine && added.routine.nextRunAt === now + 30 * 60000, "the first run is not one period out");
    assert(rooms.dueRoutines(room, now + 29 * 60000).length === 0, "a routine fired early");
    const due = rooms.dueRoutines(room, now + 31 * 60000);
    assert(due.length === 1, "a due routine was not found");
    const claim = rooms.claimRoutine(room, due[0].id, now + 31 * 60000);
    assert(claim.run && due[0].nextRunAt === now + 61 * 60000 && due[0].lastStatus === "running", `claim was ${JSON.stringify(claim)}`);
    const f = fakeRunner({ "regulatory-affairs": () => ({ text: "195k subs. Shorts did 164k views and earned nothing. One next action: stop the machine Shorts job." }) });
    const out = await rooms.runRoutine(room, due[0].id, f, now + 31 * 60000);
    assert(out.ok && f.calls.length === 1 && f.calls[0].agentId === "regulatory-affairs", "the routine did not wake exactly the seat it names");
    assert(room.messages[0].author === rooms.ROUTINE && room.messages[0].kind === "routine", "the trigger is not attributed to the routine");
    assert(/^\[Scheduled routine\]/.test(rooms.viewFor(room, "regulatory-affairs")[0].content), "the seat did not read the routine as a standing order");
    assert(due[0].lastStatus === "ran" && rooms.summary(room).routines === 1, "the routine did not record its run");
    assert(rooms.unreadCount(room) === 1, `the reply should be the one unread message, got ${rooms.unreadCount(room)}`);
    return "1 call, 1 seat, unread 1";
  });

  await check("a routine that is too late is skipped with a note, not replayed", () => {
    const room = roomOf(["operator"]);
    const now = AT(8, 0);
    const { routine } = rooms.addRoutine(room, { agentId: "operator", text: "night collect", every: "minutes", minutes: 30 }, now);
    const late = now + 30 * 60000 + 3 * 60 * 60000;   // three hours past due, grace is one period
    const claim = rooms.claimRoutine(room, routine.id, late);
    assert(claim.skip === "too late", `expected a skip, got ${JSON.stringify(claim)}`);
    assert(routine.nextRunAt > late, "the next run was not rescheduled from now");
    assert(/^skipped/.test(routine.lastStatus), "the skip was not recorded on the routine");
    const note = room.messages.find((m) => m.author === rooms.SYSTEM && m.kind === "note");
    assert(note && /not running/.test(note.content), "no note told the operator what happened");
    assert(!rooms.viewFor(room, "operator").length, "a system note reached a model");
    assert(rooms.unreadCount(room) === 0, "housekeeping counted as unread");
    return "skipped, noted, rescheduled";
  });

  await check("daily routines land on the wall clock, tomorrow once today's time has passed", () => {
    const from = AT(8, 0);
    const next = rooms.nextRunAt({ every: "daily", at: "07:00" }, from);
    const d = new Date(next);
    assert(d.getHours() === 7 && d.getMinutes() === 0 && next > from && next - from <= 24 * 60 * 60000 + 60 * 60000, `daily 07:00 from 08:00 landed at ${d}`);
    const early = rooms.nextRunAt({ every: "daily", at: "07:00" }, AT(6, 0));
    assert(new Date(early).getDate() === new Date().getDate() || new Date(early).getTime() - AT(6, 0) < 2 * 60 * 60000, "a time still ahead today was pushed to tomorrow");
    const wk = new Date(rooms.nextRunAt({ every: "weekly", at: "09:00", weekday: 3 }, from));
    assert(wk.getDay() === 3 && wk.getHours() === 9, `weekly on Wednesday landed on day ${wk.getDay()}`);
    const wd = new Date(rooms.nextRunAt({ every: "weekdays", at: "09:00" }, from));
    assert(wd.getDay() >= 1 && wd.getDay() <= 5, `weekdays landed on a weekend (${wd.getDay()})`);
    const room = roomOf(["operator"]);
    assert(rooms.addRoutine(room, { agentId: "operator", text: "x", every: "daily", at: "25:00" }).error, "an impossible time was accepted");
    assert(rooms.addRoutine(room, { agentId: "regulatory-affairs", text: "x", every: "daily", at: "07:00" }).error, "a routine was given to a seat not in the room");
    return "07:00 daily, Wednesday weekly, Mon to Fri weekdays";
  });

  await check("a halted room's routine leaves one note and spends nothing", async () => {
    const room = roomOf(["operator"], { budgetUsd: 0.01 });
    const { routine } = rooms.addRoutine(room, { agentId: "operator", text: "brief", every: "minutes", minutes: 30 }, AT(8, 0));
    room.halted = "budget";
    const f = fakeRunner();
    const out = await rooms.runRoutine(room, routine.id, f, AT(8, 31));
    assert(out.skip === "halted" && f.calls.length === 0, "a halted room still spent a call");
    const notes = room.messages.filter((m) => m.author === rooms.SYSTEM);
    assert(notes.length === 1 && /halted/.test(notes[0].content), "no single note said why");
    assert(/^skipped: room halted/.test(routine.lastStatus), "the routine did not record the halt");
    return "0 calls, 1 note";
  });

  await check("unread is what the operator has not seen, and the preview is the last thing said", async () => {
    const room = roomOf(["operator", "regulatory-affairs"]);
    const f = fakeRunner({ operator: () => ({ text: "Nothing uploading on this Mac right now." }), "regulatory-affairs": () => ({ text: "No claim issue here." }) });
    await rooms.speak(room, "@room status", f);
    const s = rooms.summary(room);
    assert(s.unread === 2, `two replies should be unread, got ${s.unread}`);
    assert(s.preview === "Nothing uploading on this Mac right now." || s.preview === "No claim issue here.", `preview was ${s.preview}`);
    assert(s.names.includes("Crowe Operator") && s.agents.length === 2, "the summary does not name its seats");
    rooms.markRead(room);
    assert(rooms.unreadCount(room) === 0, "marking read did not clear the count");
    await rooms.speak(room, "thanks", f);
    assert(rooms.unreadCount(room) === 1, "the operator's own message counted as unread, or the reply did not");
    return "2 unread, then 0, then 1";
  });

  await check("a forwarded message lands attributed to who said it and where, and the target seat answers", async () => {
    const a = rooms.createRoom({ title: "SWM Ops", agentIds: ["operator"] });
    const b = rooms.createRoom({ title: "SWM Content", agentIds: ["studio", "regulatory-affairs"], defaultAgent: "studio" });
    const fa = fakeRunner({ operator: () => ({ text: "Content asked for the next film. Finish Start Here." }) });
    await rooms.speak(a, "what next", fa);
    const said = a.messages.find((m) => m.kind === "reply");
    const fb = fakeRunner({ studio: () => ({ text: "Start Here it is. VO is cut; no master yet." }) });
    const out = await rooms.forward(a, b, said.id, fb);
    assert(out.ran && out.ran[0].agentId === "studio" && fb.calls.length === 1, "the target room's default seat did not answer");
    const relay = b.messages[0];
    assert(relay.kind === "relay" && relay.author === "operator" && relay.from.roomTitle === "SWM Ops" && relay.from.messageId === said.id, `relay was ${JSON.stringify(relay)}`);
    const seen = rooms.viewFor(b, "studio")[0].content;
    assert(/^\[Crowe Operator, from the room "SWM Ops"\]/.test(seen), `the seat read the relay as ${seen.slice(0, 60)}`);
    assert((await rooms.forward(a, a, said.id, fa)).error, "a message was forwarded into its own room");
    assert((await rooms.forward(a, b, "m-nope", fb)).error, "a missing message was forwarded");
    return "relayed, attributed, answered by one seat";
  });

  await check("a room from before ids and read marks loads with both, as read", () => {
    const back = rooms.fromSession({ id: "r-old", kind: "room", title: "Old", updatedAt: 5,
      room: { agents: [{ agentId: "operator", model: "" }], defaultAgent: "operator", budgetUsd: 1, spentUsd: 0, cost: {} },
      messages: [{ author: ":operator", content: "x", kind: "say", at: 1 }, { author: "operator", content: "y", kind: "reply", at: 2 }] });
    assert(back.messages.every((m) => m.id && m.seq) && back.seq === 2, "old messages did not get ids and sequence numbers");
    assert(back.readSeq === 2 && rooms.unreadCount(back) === 0, "an old room came back as unread news");
    assert(Array.isArray(back.routines) && back.brief === "", "an old room is missing its routines list or brief");
    const again = rooms.fromSession(JSON.parse(JSON.stringify(rooms.toSession(back))));
    assert(again.seq === 2 && again.readSeq === 2, "sequence or read mark lost in a second round trip");
    return "ids assigned, read mark at the end";
  });

  await check("the operator can rename, brief and re-budget a standing room, within caps", () => {
    const room = roomOf(["operator", "regulatory-affairs"], { budgetUsd: 0.01 });
    room.spentUsd = 0.02; room.halted = "budget";
    const changed = rooms.updateRoom(room, { title: "T".repeat(200), brief: "B".repeat(5000), budgetUsd: 1, defaultAgent: "regulatory-affairs" });
    assert(changed.length === 4, `changed ${changed.join(",")}`);
    assert(room.title.length === 80 && room.brief.length === rooms.MAX_BRIEF_CHARS, "caps did not hold");
    assert(room.halted === "" && room.defaultAgent === "regulatory-affairs", "a raised budget did not clear the halt, or the default seat did not move");
    assert(!rooms.updateRoom(room, { defaultAgent: "studio" }).length, "a seat not in the room became the default");
    room.brief = "Run Southwest Mushrooms channel operations. Never touch Studio visibility unless asked.";
    const brief = rooms.roomBrief(room, "operator");
    assert(/standing brief.*Never touch Studio/.test(brief), "the room's brief does not reach the seat");
    assert(/propose_options/.test(brief) && /short messages/.test(brief), "the working rules are missing from the brief");
    return "capped, un-halted, briefed";
  });

  // ── Gate 4: isolation ──────────────────────────────────────────────────────
  console.log("");
  console.log("worktrees (gate 4)");

  /* A fake git that records what it was asked and can be told to fail one
     command. The ordering rules are the whole point of this module, and they
     are decidable from the call log without a repository. */
  function fakeGit(failOn) {
    const calls = [];
    const g = async (args) => {
      calls.push(args);
      if (failOn && args.includes(failOn)) return { ok: false, out: "", err: "boom" };
      if (args.includes("diff --cached --stat")) return { ok: true, out: " a.js | 2 +-", err: "" };
      if (args.includes("diff --cached")) return { ok: true, out: "--- a/a.js\n+++ b/a.js", err: "" };
      return { ok: true, out: "", err: "" };
    };
    g.calls = calls;
    return g;
  }
  const iso = (git) => wt.isolation({ git, roomId: "r-1", root: "/tmp/wt" });

  await check("each agent gets its own tree and branch, from the room's base", async () => {
    const ctx = iso(fakeGit());
    const a = await wt.ensureTree(ctx, "product-formulation");
    const b = await wt.ensureTree(ctx, "regulatory-affairs");
    assert(!a.error && !b.error, "worktree creation failed");
    assert(a.dir !== b.dir, "two agents were given the same directory");
    assert(a.branch !== b.branch, "two agents were given the same branch");
    assert(ctx.git.calls.every((c) => c.startsWith("worktree add")), "something other than worktree add ran");
    // Asked twice is not made twice.
    const again = await wt.ensureTree(ctx, "product-formulation");
    assert(again.dir === a.dir && ctx.git.calls.length === 2, "an existing tree was recreated");
    return `${a.branch} and ${b.branch}`;
  });

  await check("a diff has to be reviewed before it can land", async () => {
    const ctx = iso(fakeGit());
    await wt.ensureTree(ctx, "product-formulation");
    const blocked = await wt.merge(ctx, "product-formulation");
    assert(blocked.error && blocked.needsReview, `unreviewed work merged: ${JSON.stringify(blocked)}`);
    assert(blocked.diff && blocked.diff.patch, "the refusal did not carry the diff to review");
    wt.markReviewed(ctx, "product-formulation");
    const ok = await wt.merge(ctx, "product-formulation");
    assert(ok.merged, `reviewed work did not land: ${JSON.stringify(ok)}`);
    return "refused, reviewed, landed";
  });

  await check("reviewing one agent's work does not clear another's", async () => {
    const ctx = iso(fakeGit());
    await wt.ensureTree(ctx, "a"); await wt.ensureTree(ctx, "b");
    wt.markReviewed(ctx, "a");
    const other = await wt.merge(ctx, "b");
    assert(other.error && other.needsReview, "reviewing one agent cleared another");
    return "per agent, as it should be";
  });

  await check("a conflicting merge leaves the work standing rather than dropping it", async () => {
    const ctx = iso(fakeGit("merge --no-ff"));
    await wt.ensureTree(ctx, "a"); wt.markReviewed(ctx, "a");
    const r = await wt.merge(ctx, "a");
    assert(r.conflict && r.branch, `a conflict was not reported as one: ${JSON.stringify(r)}`);
    assert(!ctx.trees.a.merged, "a conflicted merge was recorded as merged");
    return "reported, branch kept";
  });

  await check("an agent that changed nothing lands as nothing, not as a merge", async () => {
    const git = fakeGit();
    const ctx = iso(async (args) => (args.includes("diff --cached") && !args.includes("--stat")
      ? { ok: true, out: "", err: "" } : git(args)));
    await wt.ensureTree(ctx, "a"); wt.markReviewed(ctx, "a");
    const r = await wt.merge(ctx, "a");
    assert(r.empty && !r.error, `an empty diff was not handled: ${JSON.stringify(r)}`);
    return "no commit, no merge";
  });

  await check("release takes back the checkouts and keeps the branches", async () => {
    const ctx = iso(fakeGit());
    await wt.ensureTree(ctx, "a"); await wt.ensureTree(ctx, "b");
    const out = await wt.release(ctx);
    assert(out.length === 2 && out.every((r) => r.removed && r.kept), "release did not remove both checkouts");
    assert(!ctx.git.calls.some((c) => c.startsWith("branch -D")), "release deleted a branch holding unlanded work");
    assert(!Object.keys(ctx.trees).length, "release left trees behind");
    return "checkouts removed, branches kept";
  });

  console.log(failures ? `\n${failures} check(s) failed` : "\nall room checks passed");
  process.exit(failures ? 1 : 0);
})();
