#!/usr/bin/env node
// The chain, in one piece: renderer -> preload -> ipcMain -> rooms engine ->
// harness -> gateway.
//
//   xvfb-run -a npx electron scripts/test-rooms-live.js
//
// Everything else that tests rooms cuts the chain somewhere. scripts/test-rooms.js
// injects a fake runner, so it proves the engine's rules and never touches IPC.
// The browser preview drives the renderer against a shim, so it proves the
// surface and never reaches main.js. Both were green while `crowe:rooms:say`
// had never once been called through a live ipcMain, which is exactly the kind
// of gap two green suites can hide between them.
//
// So this boots the real app the way scripts/smoke-shot.js does, points it at a
// gateway running on loopback, and drives the room from inside the renderer
// through the same window.crowe the product uses. The only fake left is the
// network, which is the one piece that cannot be honest in CI.

const { app, BrowserWindow } = require("electron");
const path = require("path");

/* The gateway is replaced at the process's own fetch, before main.js is loaded.

   Pointing baseUrl at a loopback server was the obvious way and it is the wrong
   one: loadConfig() rewrites any loopback gateway back to the real host on
   purpose, so that a stale dev URL cannot brick a member install. Weakening
   that guard to make a test pass would trade a real protection for a
   convenience. Patching fetch leaves every line of the product intact - the
   config, the guard, the harness, the IPC - and fakes only the network, which
   is the one thing that cannot be honest in CI anyway. */
const seen = [];
global.fetch = async (url, init = {}) => {
  const u = String(url);
  let payload = {}; try { payload = JSON.parse(init.body || "{}"); } catch {}
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  if (u.includes("/api/gateway/catalog")) return json({ models: [] });
  if (!u.includes("/api/gateway/chat")) return json({});
  seen.push(payload);
  // The persona rides in as a system message, so the answer can name the seat
  // it came from without the test guessing at call order.
  const sys = (payload.messages || []).find((m) => m && m.role === "system");
  /* The last "You are", not the first. harness.js appends the seat's persona to
     the operator prompt, which opens with "You are Crowe Logic, the operator" -
     so reading the first match makes every seat answer as the operator, and the
     attribution this whole feature rests on would look broken when it is not. */
  const all = String(sys && sys.content || "").match(/You are ([^.\n]+)/g) || [];
  const who = all.length ? all[all.length - 1].replace(/^You are /, "").trim() : "an agent";
  return json({ content: `Position from ${who}.`, usage: { prompt_tokens: 120, completion_tokens: 30 } });
};

const { shutdownNativeResources } = require(path.join(__dirname, "..", "main.js"));

let failures = 0;
const check = async (name, fn) => {
  try {
    const detail = await fn();
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${String(e && e.message || e).split("\n").join("\n       ")}`);
  }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  let win;
  try {
    await sleep(600);
    win = BrowserWindow.getAllWindows()[0];
    assert(win, "the app did not open a window");
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once("did-finish-load", r));
    await sleep(1200);
    const js = (code) => win.webContents.executeJavaScript(code);

    console.log("rooms, end to end");

    // Only a token and a tier: the gateway host stays exactly what the product
    // ships, because fetch is what has been replaced.
    await js(`window.crowe.setConfig(${JSON.stringify({ token: "test-token", autonomy: "edit" })})`);

    await check("the roster and templates come back through ipcMain", async () => {
      const r = await js(`window.crowe.rooms.agents()`);
      assert(r && Array.isArray(r.agents) && r.agents.length >= 20, `roster returned ${r && r.agents && r.agents.length}`);
      assert(r.templates.some((t) => t.id === "product-review"), "product-review missing from templates");
      return `${r.agents.length} agents, ${r.templates.length} templates`;
    });

    await check("a room is created and persists through the sessions store", async () => {
      const made = await js(`window.crowe.rooms.create({ template: "product-review" })`);
      assert(made && made.room && made.room.id, `create failed: ${JSON.stringify(made)}`);
      await js(`window.__roomId = ${JSON.stringify(made.room.id)}`);
      const listed = await js(`window.crowe.rooms.list()`);
      assert(listed.some((r) => r.id === made.room.id), "the created room is not in the list");
      assert(made.room.agents.length === 3, `expected 3 seats, got ${made.room.agents.length}`);
      // The clamp is the safety promise, and it has to survive the real path.
      /* The minimum of the seats' ceilings, not a fixed value: Product Review
         seats two plan-tier specialists and one readonly, so plan is correct
         and readonly would have been the bug. */
      assert(made.room.tier === "plan", `a live room came back at tier ${made.room.tier}`);
      return `${made.room.id} at ${made.room.tier}`;
    });

    await check("addressing one agent spends one call, not three", async () => {
      const before = seen.length;
      const out = await js(`window.crowe.rooms.say(window.__roomId, "@regulatory-affairs does this claim clear?")`);
      assert(!out.error, `say failed: ${out.error}`);
      const bad = (out.ran || []).filter((r) => !r.ok);
      assert(!bad.length, `a seat failed: ${JSON.stringify(bad)}`);
      const ran = (out.ran || []).filter((r) => r.ok);
      assert(ran.length === 1, `expected 1 agent to run, got ${ran.length} of ${JSON.stringify(out.ran)}`);
      assert(seen.length - before === 1, `expected 1 gateway call, the gateway saw ${seen.length - before}`);
      assert(ran[0].agentId === "regulatory-affairs", `the wrong seat answered: ${ran[0].agentId}`);
      // The other two seats must have no record of having spoken.
      const st = await js(`window.crowe.rooms.load(window.__roomId)`);
      const spoke = st.room.agents.filter((a) => (a.cost && a.cost.calls) > 0).map((a) => a.agentId);
      assert(spoke.length === 1 && spoke[0] === "regulatory-affairs", `unaddressed seats spent money: ${spoke.join(", ")}`);
      return `1 call, answered by ${ran[0].agentId}`;
    });

    await check("@room reaches every seat, and the answers are attributed", async () => {
      const before = seen.length;
      const out = await js(`window.crowe.rooms.say(window.__roomId, "@room open with your position on the SKU")`);
      const ran = (out.ran || []).filter((r) => r.ok);
      assert(ran.length === 3, `expected 3 agents, got ${ran.length}`);
      assert(seen.length - before === 3, `expected 3 gateway calls, saw ${seen.length - before}`);
      const authors = new Set(ran.map((r) => r.agentId));
      assert(authors.size === 3, `three seats produced ${authors.size} distinct authors`);
      return [...authors].join(", ");
    });

    await check("a critique round reviews the others and never itself", async () => {
      const before = seen.length;
      const out = await js(`window.crowe.rooms.critique(window.__roomId)`);
      const ran = (out.ran || []).filter((r) => r.ok);
      assert(ran.length === 3, `expected 3 critiques, got ${ran.length}`);
      assert(seen.length - before === 3, `expected 3 gateway calls, saw ${seen.length - before}`);
      // The prompt each critic received must not contain its own position.
      const rounds = seen.slice(before);
      for (const payload of rounds) {
        const sys = (payload.messages || []).find((m) => m.role === "system");
        const all = String(sys && sys.content || "").match(/You are ([^.\n]+)/g) || [];
        const me = all.length ? all[all.length - 1].replace(/^You are /, "").trim() : "";
        const user = (payload.messages || []).filter((m) => m.role === "user").map((m) => m.content).join("\n");
        assert(!new RegExp(`Position from ${me.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`).test(user),
          `${me} was handed its own position to review`);
      }
      return "three critics, none reviewing itself";
    });

    await check("cost is attributed per seat and sums to the room total", async () => {
      const state = await js(`window.crowe.rooms.load(window.__roomId)`);
      const room = state.room, messages = state.messages || [];
      const sum = room.agents.reduce((s, a) => s + (a.cost && a.cost.usd || 0), 0);
      const calls = room.agents.reduce((s, a) => s + (a.cost && a.cost.calls || 0), 0);
      assert(calls === seen.length, `seats recorded ${calls} calls, the gateway answered ${seen.length}`);
      assert(Math.abs(sum - room.spentUsd) < 1e-9, `parts ${sum} do not sum to the room total ${room.spentUsd}`);
      const expected = 2 + 4 + 3;   // operator turns, replies, critiques
      assert(messages.length === expected, `expected ${expected} messages, got ${messages.length}`);
      return `${calls} calls across ${room.agents.length} seats, $${room.spentUsd.toFixed(4)}`;
    });

    await check("a reloaded room restores every agent's view of the transcript", async () => {
      const again = await js(`window.crowe.rooms.load(window.__roomId)`);
      assert(again.messages.length === 9, `a reload changed the transcript: ${again.messages.length} messages`);
      const authors = new Set(again.messages.map((m) => m.author));
      assert(authors.has(":operator"), "the operator's own messages did not survive the round trip");
      assert(authors.size >= 4, `expected the operator and three agents, got ${authors.size} authors`);
      return `${again.messages.length} messages, ${authors.size} authors`;
    });

    await check("stop-all halts the room's agents through the real handler", async () => {
      const r = await js(`window.crowe.agent.stopAll ? window.crowe.agent.stopAll() : window.crowe.stopAll ? window.crowe.stopAll() : "no-stop-all"`);
      assert(r !== "no-stop-all", "the renderer has no stop-all to call");
      // Nothing is in flight here, so the assertion is that it is reachable and
      // does not throw with rooms registered - the failure this guards is a
      // stop-all that cannot see room agents at all.
      const state = await js(`window.crowe.rooms.load(window.__roomId)`);
      assert(!state.error, "the room was destroyed by stop-all");
      return "reachable, room intact";
    });
  } catch (e) {
    failures += 1;
    console.log(`  FAIL harness\n       ${String(e && e.stack || e)}`);
  } finally {
    console.log(failures ? `\n${failures} check(s) failed` : "\nall live room checks passed");
    try { shutdownNativeResources && shutdownNativeResources(); } catch {}
    app.exit(failures ? 1 : 0);
  }
});
