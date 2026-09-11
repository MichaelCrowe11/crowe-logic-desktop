// The headless runner: one turn of the harness, no Electron.
//
// The whole point of this file is that it adds a second caller to runAgent and
// changes nothing about it. Every guarantee the desktop gets - the tier gates,
// the risk classification, the one-shot expiring approvals, the secret scanner,
// the stale-read detection, the dual ceilings, the independent verifier, the
// hash-chained journal - is enforced inside the harness, on the harness side of
// the call. So the job here is only to supply an honest ctx and an honest set of
// deps. Where the desktop draws a card, this asks a terminal. Where the desktop
// has a Stop button, this has SIGINT. Nothing here is allowed to answer a gate
// on the user's behalf that the desktop would have asked about.

const fs = require("fs");
const path = require("path");

const harness = require("../harness");
const { loadConfig, RATE_IN, RATE_OUT } = require("./config");
const { makeGateway } = require("./gateway");
const { makeJournal, makeArtifactDir } = require("./journal");
const { askYesNo, lineDiff } = require("./prompt");

const EXIT = { ok: 0, error: 1, stopped: 2, failed: 3, usage: 4, capped: 5 };

function resolveIn(cwd, p) {
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

/* Approval policy, decided once at startup rather than at each prompt, so a run
   cannot drift between modes halfway through.

   "deny" is not an omission. A ctx with no requestApproval at all makes the
   harness block risky actions with "no way to ask", which reads like a bug; an
   explicit denial reads like the policy it is, and both refuse. */
function makeApprovalFn(policy, io) {
  return async function requestApproval(req) {
    if (policy === "auto") {
      io.note(`approved automatically (--yes): ${req.title}`);
      return { approved: true };
    }
    if (policy === "deny") {
      io.note(`denied (no terminal to ask): ${req.title}`);
      return { approved: false };
    }
    io.stderr.write([
      "",
      `  approval required: ${req.title}`,
      `  risk:   ${req.risk}`,
      `  why:    ${req.why}`,
      req.detail ? `  detail: ${String(req.detail).slice(0, 400)}` : "",
      "",
    ].filter(Boolean).join("\n"));
    return askYesNo("  allow this action?", { input: io.stdin, output: io.stderr });
  };
}

/* Edit review. autoApprove writes without asking, which is the desktop's own
   setting and the only sane default for CI. Otherwise a terminal gets the diff
   and a question, and a pipe gets a rejection - phrased exactly the way main.js
   phrases it, because the harness feeds that string back to the model and the
   model needs to understand it was refused rather than that it failed. */
function makeProposeEdit(ctx, cfgRef, policy, io) {
  return async function proposeEdit(relPath, newContent) {
    const abs = resolveIn(ctx.getCwd(), relPath);
    let oldContent = ""; try { oldContent = fs.readFileSync(abs, "utf8"); } catch {}
    const write = () => {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, newContent);
    };
    if (cfgRef().autoApprove) { write(); return `wrote ${relPath} (${newContent.length} bytes, auto-approved)`; }
    if (policy === "deny") return `the user REJECTED the edit to ${relPath}; do not reapply it unless they ask`;
    io.stderr.write(`\n  proposed edit: ${relPath}\n${lineDiff(oldContent, newContent)}\n\n`);
    const { approved } = await askYesNo("  apply this edit?", { input: io.stdin, output: io.stderr });
    if (approved) { write(); return `applied edit to ${relPath}`; }
    return `the user REJECTED the edit to ${relPath}; do not reapply it unless they ask`;
  };
}

function buildCtx({ cfg, cwd, policy, io, gateway, appVersion }) {
  let current = cwd;
  const journal = makeJournal(cfg.home);
  const artifactDir = makeArtifactDir(cfg.home);
  let catalog = [];
  const ctx = {
    getCwd: () => current,
    setCwd: (p) => { current = resolveIn(current, p); },
    loadConfig: () => cfg,
    requestApproval: makeApprovalFn(policy, io),
    // MCP is a desktop surface today. Declared absent rather than faked: the
    // harness only offers tools it can actually run, so an empty list means the
    // model never proposes one and never gets a lie back.
    mcpTools: () => [],
    mcpCall: async () => "blocked: MCP servers are not available in the CLI",
    openUrl: (u) => { io.note(`open: ${u}`); return `printed ${u} (the CLI does not open browsers)`; },
    growRead: () => null,
    growWrite: () => "blocked: the grow log is not available in the CLI",
    journal,
    artifactDir,
    getCatalog: () => catalog,
    planTier: () => null,
    getPlugins: () => [],
    rateIn: RATE_IN,
    rateOut: RATE_OUT,
    appVersion,
  };
  ctx.proposeEdit = makeProposeEdit(ctx, () => cfg, policy, io);
  ctx.primeCatalog = async () => { catalog = await gateway.getCatalog(); };
  return ctx;
}

// Reporters. --json is the contract for anything programmatic: one event per
// line, every event the harness emits, nothing interleaved. The human reporter
// is allowed to be lossy; the JSONL one is not.
function makeReporter({ mode, stdout, stderr }) {
  let streamed = false;
  if (mode === "json") {
    return (ev) => { stdout.write(JSON.stringify(ev) + "\n"); };
  }
  if (mode === "quiet") {
    return () => {};
  }
  return (ev) => {
    switch (ev.type) {
      case "route": stderr.write(`  route: ${ev.expert} via ${ev.model} (${ev.reason})\n`); break;
      case "plan": stderr.write(`  plan: ${ev.text}\n`); break;
      case "tool_call": stderr.write(`  tool: ${ev.name} ${summarizeArgs(ev.args)}\n`); break;
      case "tool_result": if (ev.status && ev.status !== "SUCCESS") stderr.write(`  ${String(ev.result || ev.status).slice(0, 200)}\n`); break;
      case "retry": stderr.write(`  retry: ${ev.reason || "transient"}\n`); break;
      case "budget": stderr.write(`  budget: ${ev.reason || "ceiling reached"}\n`); break;
      case "verdict": stderr.write(`  verdict: ${ev.status}${ev.reason ? ` (${ev.reason})` : ""}\n`); break;
      case "assistant_delta": stdout.write(ev.text || ""); streamed = true; break;
      case "assistant": if (!ev.streamed && ev.text) stdout.write(ev.text); break;
      case "stream_reset": if (streamed) { stdout.write("\n"); streamed = false; } break;
      case "error": stderr.write(`  error: ${ev.text || ev.error || "failed"}\n`); break;
      case "stopped": stderr.write("  stopped\n"); break;
      case "final": if (ev.note) stderr.write(`  ${ev.note}\n`); break;
      default: break;
    }
  };
}

function summarizeArgs(args) {
  try {
    const s = JSON.stringify(args || {});
    return s.length > 160 ? `${s.slice(0, 157)}...` : s;
  } catch { return ""; }
}

/* One turn. Returns an exit code rather than calling process.exit, so the tests
   can run it in-process and so a future embedder can call it as a function. */
async function runOnce(opts) {
  const {
    prompt, flags = {}, env = process.env,
    stdout = process.stdout, stderr = process.stderr, stdin = process.stdin,
    gatewayChat: injectedChat, getCatalog: injectedCatalog,
    appVersion = require("../package.json").version,
    onSignal,
  } = opts;

  const cfg = loadConfig({ env, flags: flags.config || {} });
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd();
  const isTty = flags.yes ? true : Boolean(stdin && stdin.isTTY);
  const policy = flags.yes ? "auto" : (isTty ? "prompt" : "deny");
  const io = {
    stdout, stderr, stdin,
    note: (m) => { if (flags.output !== "json") stderr.write(`  ${m}\n`); },
  };

  const gateway = injectedChat
    ? { gatewayChat: injectedChat, getCatalog: injectedCatalog || (async () => []) }
    : makeGateway({ baseUrl: cfg.baseUrl, token: cfg.token });

  const ctx = buildCtx({ cfg, cwd, policy, io, gateway, appVersion });
  if (flags.catalog !== false) await ctx.primeCatalog();

  const send = makeReporter({ mode: flags.output || "text", stdout, stderr });

  let aborted = false;
  let controller = null;
  const stop = () => {
    aborted = true;
    try { if (controller) controller.abort(); } catch {}
  };
  if (onSignal) onSignal(stop);

  const deps = {
    gatewayChat: gateway.gatewayChat,
    send,
    isAborted: () => aborted,
    setController: (c) => { controller = c; },
    role: flags.role || "",
    model: flags.config && flags.config.model ? flags.config.model : "",
    agentId: "cli",
  };

  const result = await harness.runAgent(ctx, [{ role: "user", content: prompt }], deps);

  if (flags.output === "json") {
    stdout.write(JSON.stringify({ type: "result", text: result.text || "", stop: result.stop,
      verdict: result.verdict ? result.verdict.status : undefined,
      cost: result.cost, mutations: (result.mutations || []).length }) + "\n");
  } else if (flags.output === "quiet") {
    stdout.write(`${result.text || ""}\n`);
  } else {
    stdout.write("\n");
  }

  if (result.error) return EXIT.error;
  if (result.stopped || result.stop === "aborted") return EXIT.stopped;
  if (result.verdict && result.verdict.status === "fail") return EXIT.failed;
  if (result.stop === "rounds" || result.stop === "budget") return EXIT.capped;
  return EXIT.ok;
}

module.exports = { runOnce, EXIT, makeReporter, buildCtx, lineDiff };
