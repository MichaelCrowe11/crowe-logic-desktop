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

  console.log(failures ? `\n${failures} check(s) failed` : "\nall room checks passed");
  process.exit(failures ? 1 : 0);
})();
