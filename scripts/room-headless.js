#!/usr/bin/env node
/* A room from the terminal: the rooms engine on the CLI's context builder.

   The desktop app is the product surface for rooms; this exists so a room can
   be run, journaled and saved without Electron, against a scratch CROWE_HOME,
   with the seats' tier binding at the tool gate (harness capTier) rather than
   on a label. Every seat's events go to a JSONL file beside the saved session so
   the per-seat cost table can be checked against the raw telemetry.

   node scripts/room-headless.js --title "…" --agents a,b,c [--pin a=model]…
        --script actions.json --out DIR [--budget 1] [--stop-after-ms N] [--dry]

   actions.json: [{"say":"@room …"},{"critique":true},{"revise":true},{"say":"@a …"}]
   Token: CROWE_TOKEN, or the Bearer in ~/.claude.json mcpServers["crowe-logic"]
   (read at run time, never printed, never written). */
const fs = require("fs");
const os = require("os");
const path = require("path");

function tokenFromClaudeJson() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    const h = (((c.mcpServers || {})["crowe-logic"] || {}).headers || {}).Authorization || "";
    return String(h).replace(/^Bearer\s+/i, "").trim();
  } catch { return ""; }
}
if (!process.env.CROWE_TOKEN) { const t = tokenFromClaudeJson(); if (t) process.env.CROWE_TOKEN = t; }

const harness = require("../harness");
const engine = require("../rooms/engine");
const registry = require("../rooms/registry");
const { loadConfig } = require("../cli/config");
const { makeGateway } = require("../cli/gateway");
const { buildCtx } = require("../cli/run");

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const title = flag("--title", "Headless room");
const agentIds = String(flag("--agents", "")).split(",").map((s) => s.trim()).filter(Boolean);
const pins = {}; argv.forEach((a, i) => { if (a === "--pin") { const [id, m] = String(argv[i + 1]).split("="); pins[id] = m; } });
const budgetUsd = Number(flag("--budget", "1")) || 1;
const scriptFile = flag("--script", "");
const out = flag("--out", process.cwd());
const stopAfterMs = Number(flag("--stop-after-ms", "0")) || 0;
const dry = has("--dry");
fs.mkdirSync(out, { recursive: true });

const cfg = loadConfig({ env: process.env, flags: {} });
const cwd = flag("--cwd", process.cwd());
const io = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, note: (m) => process.stderr.write(`  ${m}\n`) };
const gateway = makeGateway({ baseUrl: cfg.baseUrl, token: cfg.token });
const ctx = buildCtx({ cfg, cwd, policy: "deny", io, gateway, appVersion: require("../package.json").version });

const room = engine.createRoom({ title, agentIds, budgetUsd });
for (const [id, m] of Object.entries(pins)) { const s = room.agents.find((a) => a.agentId === id); if (s) s.model = m; }
room.tier = engine.roomTier(room, cfg.autonomy || "edit");
const seated = room.agents.map((a) => `${a.agentId}${a.model ? `=${a.model}` : ""}`).join(", ");
process.stderr.write(`room ${room.id}: seats [${seated}] app autonomy ${cfg.autonomy || "edit"} -> room tier ${room.tier}; budget $${budgetUsd}; home ${cfg.home}\n`);
if (!room.agents.length) { process.stderr.write("no joinable agents; check --agents ids\n"); process.exit(1); }
if (dry) process.exit(0);
if (!cfg.token) { process.stderr.write("no token: set CROWE_TOKEN\n"); process.exit(6); }

const eventsPath = path.join(out, `${room.id}.events.jsonl`);
const events = fs.createWriteStream(eventsPath, { flags: "a", mode: 0o600 });
const runs = new Map();
const stopState = { all: false, at: 0 };
const deps = {
  runAgent: async ({ agentId, model, systemBrief, messages, tier }) => {
    const run = { aborted: false, controller: null };
    runs.set(agentId, run);
    let usage = { usd: 0, promptTokens: 0, completionTokens: 0 };
    const started = Date.now();
    try {
      const result = await harness.runAgent(ctx, messages.slice(), {
        gatewayChat: gateway.gatewayChat,
        send: (ev) => {
          if (ev && ev.type === "telemetry") usage = { usd: ev.cost || 0, promptTokens: ev.promptTokens || 0, completionTokens: ev.completionTokens || 0 };
          try { events.write(JSON.stringify({ at: new Date().toISOString(), roomId: room.id, seat: agentId, ...ev }) + "\n"); } catch {}
        },
        isAborted: () => run.aborted || stopState.all,
        setController: (c) => { run.controller = c; },
        agentId: `room:${room.id}:${agentId}`,
        persona: systemBrief,
        model: model || "",
        tier,
      });
      if (run.aborted || stopState.all) return { stopped: true, usage };
      process.stderr.write(`  ${agentId}: ${result.error ? "error " + result.error : "done"} in ${((Date.now() - started) / 1000).toFixed(1)}s, ${usage.promptTokens}+${usage.completionTokens} tok, $${usage.usd.toFixed(4)}\n`);
      return { text: result.text || "", error: result.error, usage };
    } finally { runs.delete(agentId); }
  },
};
function stopAll(reason) {
  stopState.all = true; stopState.at = Date.now();
  for (const r of runs.values()) { r.aborted = true; try { if (r.controller) r.controller.abort(); } catch {} }
  events.write(JSON.stringify({ at: new Date().toISOString(), roomId: room.id, type: "stop_all", reason, seatsRunning: [...runs.keys()] }) + "\n");
  process.stderr.write(`  stop-all (${reason}); seats running: ${[...runs.keys()].join(", ") || "none"}\n`);
}
process.on("SIGINT", () => { stopAll("SIGINT"); });

function save() {
  const sess = engine.toSession(room);
  const p = path.join(out, `${room.id}.json`);
  fs.writeFileSync(p, JSON.stringify(sess, null, 2), { mode: 0o600 });
  try { fs.mkdirSync(path.join(cfg.home, "sessions"), { recursive: true }); fs.writeFileSync(path.join(cfg.home, "sessions", `${room.id}.json`), JSON.stringify(sess, null, 2), { mode: 0o600 }); } catch {}
  return p;
}

(async () => {
  try { await ctx.primeCatalog(); } catch (e) { process.stderr.write(`  catalog unavailable: ${String(e && e.message || e)}\n`); }
  const actions = scriptFile ? JSON.parse(fs.readFileSync(scriptFile, "utf8")) : [];
  for (const act of actions) {
    if (stopState.all) break;
    room.tier = engine.roomTier(room, cfg.autonomy || "edit");
    let timer = null;
    if (act.stop_after_ms || (stopAfterMs && act.stop_here)) timer = setTimeout(() => stopAll(`timer ${act.stop_after_ms || stopAfterMs}ms`), act.stop_after_ms || stopAfterMs);
    const t0 = Date.now();
    let res;
    if (act.say) { process.stderr.write(`> say: ${String(act.say).slice(0, 80).replace(/\n/g, " ")}…\n`); res = await engine.speak(room, act.say, deps); }
    else if (act.critique) { process.stderr.write("> critique round\n"); res = await engine.critique(room, deps); }
    else if (act.revise) { process.stderr.write("> revise round\n"); res = await engine.revise(room, deps); }
    if (timer) clearTimeout(timer);
    events.write(JSON.stringify({ at: new Date().toISOString(), roomId: room.id, type: "round_done", action: Object.keys(act)[0], ms: Date.now() - t0, ran: (res && res.ran || []).map((r) => ({ seat: r.agentId, ok: r.ok, error: r.error || "" })), halted: room.halted, spentUsd: room.spentUsd }) + "\n");
    save();
    if (room.halted) { process.stderr.write(`  room halted: ${room.halted}\n`); break; }
  }
  const p = save();
  const seats = room.agents.map((a) => `${a.agentId}: ${(room.cost[a.agentId] || {}).calls || 0} calls $${((room.cost[a.agentId] || {}).usd || 0).toFixed(4)}`).join("; ");
  process.stderr.write(`saved ${p}\n  spent $${room.spentUsd.toFixed(4)} of $${room.budgetUsd}; ${seats}\n  events ${eventsPath}\n`);
  events.end();
  process.exit(stopState.all ? 2 : 0);
})().catch((e) => { process.stderr.write(`fatal: ${String(e && e.stack || e)}\n`); process.exit(1); });
