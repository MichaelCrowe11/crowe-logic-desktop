#!/usr/bin/env node
/* Headless council host.
 *
 * Runs the same council protocol the desktop app runs (rooms/council.js) and
 * the same scoped file executor (rooms/council-files.js), outside Electron,
 * against Crowe Logic's local model runtime: the foundry's `cli.headless`
 * runner, spawned per request with --no-tools. The host holds no credential;
 * the runner reads the operator's own provider configuration from its own
 * environment, exactly as the interactive CLI does.
 *
 * Differences from the desktop host, stated plainly:
 * - The runner keeps only user and assistant turns, so each protocol prompt is
 *   folded into the user turn ahead of the JSON evidence.
 * - The model is pinned by --model on the runner; there is no gateway that
 *   could substitute another model, and no model label comes back to compare.
 * - Engine identity per model comes from the ENGINES table below, taken from
 *   the foundry MODEL_CHAIN on 2026-09-19, not from a live catalog.
 * - Operator controls are files in the run directory: PAUSE and REVOKE.
 *
 * Usage:
 *   node scripts/council-run.js --goal-file goal.txt --mode advisory \
 *     --seats crowelm-zenith,crowelm-kernel,crowelm-depth,crowelm-coder,deepseek-v4-pro \
 *     --context rooms/council.js,docs/COUNCIL-AUTOPILOT.md --quorum 3 --steps 6 --calls 50 --minutes 60 \
 *     --out .council-test/runs/first
 *   Add --files a,b --autonomy edit for scoped file authority (mode files);
 *   without --autonomy the run is read-only. Add --dry-run to validate the
 *   grant and snapshot without any model call. --request-timeout is in
 *   milliseconds and defaults to 120000; the value in effect is recorded.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const C = require("../rooms/council");
const { makeFileExecutor } = require("../rooms/council-files");
const H = require("../harness");
const registry = require("../rooms/registry");

const ENGINES = {
  "crowelm": "GPT-5.6 Terra", "crowelm-zenith": "GPT-6 Astra", "crowelm-depth": "Grok 4.6",
  "crowelm-coder": "GPT-5.6 Sol", "crowelm-kernel": "Claude Fable 5.1", "crowelm-grower": "Claude Fable 5.1",
  "crowelm-vision": "Claude Fable 5.1", "gpt-6-astra": "GPT-6 Astra", "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna", "gpt-5.5": "GPT-5.5", "deepseek-v4-pro": "DeepSeek V4 Pro",
  "kimi-k3": "Kimi K3", "claude-sonnet-5": "Claude Sonnet 5", "claude-opus-4-8": "Claude Opus 4.8",
};
// Events the tool-free runner emits. Anything else means a tool or approval
// path was reached, and the response is refused.
const INFO_EVENTS = new Set(["ready", "token", "reasoning", "segment_end", "spinner", "done", "error"]);

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key === "dry-run") { out[key] = true; continue; }
    out[key] = argv[++i];
  }
  return out;
}
const list = (s) => String(s || "").split(",").map(x => x.trim()).filter(Boolean);
const iso = (t) => new Date(t).toISOString();

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", text, { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}

function askModel(seat, task, data, opt) {
  return new Promise((resolve, reject) => {
    const content = `${C.PROMPTS[task]}\n\nInput (JSON):\n${JSON.stringify(data)}`;
    const payload = JSON.stringify({ messages: [{ role: "user", content }], model: seat.model, session: opt.session });
    const proc = spawn(opt.python, ["-m", "cli.headless", "--no-tools", "--model", seat.model], { cwd: opt.foundry, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", killed = false;
    const kill = () => { killed = true; try { proc.kill("SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(kill, opt.timeoutMs);
    if (opt.signal) opt.signal.addEventListener("abort", kill, { once: true });
    proc.stdout.on("data", d => { out += d; });
    proc.stderr.on("data", d => { err += d; });
    proc.on("error", e => { clearTimeout(timer); reject(e); });
    proc.on("close", code => {
      clearTimeout(timer);
      if (killed) return reject(new Error("Model request interrupted or timed out."));
      const events = out.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const foreign = events.find(e => !INFO_EVENTS.has(e.type));
      if (foreign) return reject(new Error(`Council requests cannot execute model tools (runner event: ${foreign.type}).`));
      const failure = events.find(e => e.type === "error");
      if (failure) return reject(new Error(H.redactSecrets(String(failure.message || "model error")).slice(0, 400)));
      const done = events.find(e => e.type === "done");
      if (!done) return reject(new Error(`Model run ended without completion (exit ${code}). ${H.redactSecrets(err.slice(-300))}`));
      const text = events.filter(e => e.type === "token").map(e => e.delta || "").join("");
      if (H.scanForSecrets(text).length) return reject(new Error("Model response contained credential-like material; response withheld."));
      resolve({ text, done });
    });
    proc.stdin.end(payload);
  });
}

async function main() {
  const a = args(process.argv.slice(2));
  const workspace = fs.realpathSync(a.workspace || process.cwd());
  const foundry = fs.realpathSync(a.foundry || path.join(os.homedir(), "Projects", "crowe-logic-foundry"));
  const python = a.python || path.join(foundry, ".venv", "bin", "python");
  const goal = a["goal-file"] ? fs.readFileSync(a["goal-file"], "utf8") : (a.goal || "");
  const mode = a.mode || "advisory";
  const files = list(a.files);
  const context = list(a.context);
  const models = list(a.seats);
  const runId = a.id || new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const outDir = path.resolve(a.out || path.join(workspace, ".council-test", "runs", runId));
  const timeoutMs = Number(a["request-timeout"] || 120000);
  // The operator's autonomy for this run, stated on the command line. File
  // authority is the intersection of it and the seats' own ceiling, exactly
  // as the desktop host computes it; missing or invalid fails closed.
  const autonomy = registry.TIERS.includes(String(a.autonomy)) ? String(a.autonomy) : "readonly";
  if (!fs.existsSync(python)) throw new Error(`Model runtime not found at ${python}.`);
  if (models.length < 3) throw new Error("Name at least three catalog models with --seats.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error("--request-timeout is milliseconds, at least 1000.");

  const seats = models.map(model => {
    const agent = registry.modelAgent(model);
    if (!agent) throw new Error(`Not a valid catalog model id: ${model}`);
    const engine = ENGINES[model];
    if (!engine) throw new Error(`No engine identity is known for ${model}; add it to ENGINES after checking the catalog.`);
    return { id: agent.id, model, engine };
  });
  const spec = { goal, mode, files, quorum: Number(a.quorum || 2), maxSteps: Number(a.steps || 1), maxCalls: Number(a.calls || 10), minutes: Number(a.minutes || 30), workspace };
  const contract = C.grant(spec, seats);
  const tier = registry.effectiveTier(seats.map(s => s.id), autonomy);
  if (contract.mode === "files" && !registry.writeCapable(tier)) throw new Error(`Scoped file autopilot requires --autonomy edit or execute with an edit-capable roster; the effective tier is ${tier}.`);
  if (H.scanForSecrets(contract.goal).length) throw new Error("Remove credential-like material from the goal.");

  // Evidence the council reads: the writable scope plus read-only context.
  // Writes stay limited to contract.files by normalize() and classify().
  const readable = [...new Set([...contract.files, ...context])];
  const executor = readable.length ? makeFileExecutor(workspace, readable) : null;
  if (executor) contract.workspace = executor.workspace;
  const snapshot = () => (executor ? executor.snapshot() : {});
  const before = snapshot();
  const state = C.create(contract);

  fs.mkdirSync(outDir, { recursive: true });
  const stateFile = path.join(outDir, "state.json");
  const ledger = path.join(outDir, "ledger.md");
  const save = () => writeAtomic(stateFile, JSON.stringify(state));
  const log = (line) => { fs.appendFileSync(ledger, line + "\n"); process.stdout.write(line + "\n"); };
  log(`# Council run ${runId}`);
  log(`- started ${iso(Date.now())} · mode ${contract.mode} · quorum ${contract.quorum} of ${seats.length - 1} reviewers · steps ${contract.maxSteps} · calls ${contract.maxCalls} · expires ${iso(contract.expiresAt)}`);
  log(`- workspace ${contract.workspace} · operator autonomy ${autonomy} · effective tier ${tier} · request timeout ${timeoutMs} ms`);
  log(`- seats: ${seats.map(s => `${s.model} (${s.engine})`).join(", ")}`);
  log(`- writable scope: ${contract.files.length ? contract.files.join(", ") : "none (advisory)"}`);
  log(`- read-only context: ${context.length ? context.join(", ") : "none"} · evidence ${C.canonical(before).length} chars`);
  save();
  if (a["dry-run"]) { log("- dry run: grant validated, evidence snapshot taken, no model call made."); return; }

  const controller = new AbortController();
  let seen = state.events.length;
  const authorized = () => {
    if (fs.existsSync(path.join(outDir, "REVOKE"))) { C.stop(state, true); controller.abort(); throw new Error(state.reason); }
    if (fs.existsSync(path.join(outDir, "PAUSE"))) { C.stop(state, false); controller.abort(); throw new Error(state.reason); }
    if (contract.mode === "files" && (fs.realpathSync(workspace) !== contract.workspace || !registry.writeCapable(registry.effectiveTier(seats.map(s => s.id), autonomy)))) throw new Error("Workspace or authority changed; a new grant is required.");
  };
  const watch = setInterval(() => { try { if (state.status !== "paused" && state.status !== "revoked") authorized(); } catch { /* the protocol records it on its next check */ } }, 2000);
  let n = 0;
  const deps = {
    authorized: async () => authorized(),
    save: async () => { save(); for (; seen < state.events.length; seen++) { const e = state.events[seen]; log(`- ${iso(e.at)} **${e.kind}** ${String(e.detail).replace(/\s+/g, " ").slice(0, 600)}`); } },
    snapshot: async () => snapshot(),
    classify: async (proposal) => { if (H.scanForSecrets(proposal.summary).length) throw new Error("Proposal contains credential-like material."); if (executor) executor.classify(proposal); },
    ask: async (seat, task, data) => {
      const { text, done } = await askModel(seat, task, data, { python, foundry, timeoutMs: Math.min(timeoutMs, Math.max(1, contract.expiresAt - Date.now())), session: `council-${runId}-${++n}`, signal: controller.signal });
      fs.writeFileSync(path.join(outDir, `call-${String(n).padStart(3, "0")}-${task}-${seat.model}.json`), JSON.stringify({ seat, task, elapsedMs: done.elapsed_ms, tokens: done.tokens, reasoning: done.reasoning_tokens, text }, null, 1), { mode: 0o600 });
      return text;
    },
    execute: async (proposal, prior, grant, live) => {
      authorized();
      if (contract.mode === "files") return executor.execute(proposal, prior, grant, () => { authorized(); return live(); });
      // An advisory result is the record itself. The receipt carries the
      // recorded text so the verifier has evidence to compare, not a bare claim.
      return { summary: "Council-approved advisory result recorded. No external action or workspace write. The recorded text is reproduced in this receipt as `recorded`; verification is that it equals the approved proposal summary.", recorded: proposal.summary, kind: proposal.kind, at: Date.now() };
    },
  };
  try { await C.run(state, deps); } finally { clearInterval(watch); save(); }
  await deps.save();

  const lines = [`# Council receipt ${runId}`, "", `Status: **${state.status}**. ${state.reason || ""}`, "", `Goal: ${contract.goal}`, "", `Mode ${contract.mode}; operator autonomy ${autonomy}; effective tier ${tier}; request timeout ${timeoutMs} ms; quorum ${contract.quorum}; steps ${state.steps}/${contract.maxSteps}; calls ${state.calls}/${contract.maxCalls}.`, `Seats: ${seats.map(s => `${s.model} (${s.engine})`).join(", ")}.`, `Writable scope: ${contract.files.join(", ") || "none"}. Read-only context: ${context.join(", ") || "none"}.`, ""];
  state.proposals.forEach((p, i) => {
    const who = seats.find(s => s.id === p.proposer);
    const classifier = seats.find(s => s.id !== p.proposer);
    lines.push(`## Proposal ${i + 1} · ${p.status} · proposed by ${who ? who.model : p.proposer}`, "", p.proposal.summary, "");
    if (p.proposal.changes.length) lines.push(`Changes: ${p.proposal.changes.map(c => c.path).join(", ")}`, "");
    if (p.safety) lines.push(`Safety (${classifier ? classifier.model : "classifier"}): ${p.safety.decision}. ${p.safety.reason}`, "");
    for (const v of p.votes) lines.push(`- Vote ${v.model}: **${v.decision}**. ${v.reason}`);
    if (p.receipt) lines.push("", `Receipt: ${p.receipt.summary}`);
    if (p.verification) lines.push("", `Verification: **${p.verification.decision}**. ${p.verification.reason}`);
    lines.push("");
  });
  writeAtomic(path.join(outDir, "receipt.md"), lines.join("\n"));
  log(`- finished ${iso(Date.now())} · status ${state.status} · ${state.reason}`);
  log(`- receipt ${path.join(outDir, "receipt.md")}`);
  if (state.status !== "completed") process.exitCode = 2;
}

main().catch(e => { console.error("council-run:", e.message || e); process.exit(1); });
