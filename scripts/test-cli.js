// Tests for the headless runner. Pure Node, no Electron and no network: the
// gateway is scripted, the workspace is a temp directory, and the config lives
// under a temp CROWE_HOME so nothing here can read or write the real one.
//
//   node scripts/test-cli.js
//
// What these are actually checking is the seam. runAgent is already covered by
// test-harness.js; the risk in this layer is that the CLI quietly answers a
// question the desktop would have asked - auto-approving in a pipe, treating a
// missing terminal as consent, or dropping an event that a script depends on.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Writable, Readable } = require("stream");

const { runOnce, EXIT } = require("../cli/run");
const { loadConfig } = require("../cli/config");
const { lineDiff } = require("../cli/prompt");
const { parseArgs } = require("../bin/crowe");
const { makeLocalPlane } = require("../cloud/local");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── Fixtures ────────────────────────────────────────────────────────────────
function sink() {
  const chunks = [];
  const s = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
  s.text = () => chunks.join("");
  return s;
}
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-cli-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "alpha\nbeta\n");
  return dir;
}
function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crowe-home-"));
}
// The journal is a file per day under the home, so a test reads the lot.
function journalText(h) {
  const dir = path.join(h, "journal");
  return fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("");
}
const call = (name, args, id = "c" + Math.random().toString(36).slice(2, 7)) =>
  ({ id, function: { name, arguments: JSON.stringify(args) } });
const reply = (tool_calls, content = "", usage = { prompt_tokens: 10, completion_tokens: 5 }) =>
  ({ content, tool_calls, usage, elapsedMs: 1 });
const isVerify = (tools) => (tools || []).some((t) => t.function && t.function.name === "submit_verdict");

// A run with everything injected: scripted gateway, temp home, temp workspace,
// captured streams. `stdin` defaults to a non-TTY so the default policy under
// test is the one CI would get.
async function run(script, { flags = {}, env = {}, cwd, stdin, plane } = {}) {
  const dir = cwd || workspace();
  const h = home();
  const out = sink(), err = sink();
  const counts = { execute: 0, verify: 0 };
  const calls = [];
  const code = await runOnce({
    prompt: "do the thing",
    flags: { output: "json", catalog: false, cwd: dir, ...flags, config: { token: "t", model: "test-model", verifier: false, ...(flags.config || {}) } },
    env: { CROWE_HOME: h, CROWE_CONFIG: path.join(h, "cli.json"), ...env },
    stdout: out, stderr: err,
    controlPlane: plane,
    stdin: stdin || Object.assign(Readable.from([]), { isTTY: false }),
    gatewayChat: async (msgs, tools, _signal, model, onDelta) => {
      const stage = isVerify(tools) ? "verify" : "execute";
      calls.push({ stage, tools, model });
      const r = await script(stage, counts[stage]++, msgs, tools, model, onDelta);
      return r || reply([], "done");
    },
    appVersion: "0.0.0-test",
  });
  const json = (flags.output || "json") === "json";
  const events = json ? out.text().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { code, events, dir, home: h, out: out.text(), err: err.text(), calls,
           ofType: (t) => events.filter((e) => e.type === t) };
}

// ─── Argument parsing ────────────────────────────────────────────────────────
test("parseArgs maps flags onto the config patch", () => {
  const { flags, prompt } = parseArgs(["--tier", "execute", "--approvals", "strict", "--budget", "5",
    "--token-cap", "1000", "--model", "m1", "--json", "--yes", "fix", "the", "bug"]);
  assert.strictEqual(prompt, "fix the bug");
  assert.strictEqual(flags.config.autonomy, "execute");
  assert.strictEqual(flags.config.approvals, "strict");
  assert.strictEqual(flags.config.turnBudgetUsd, 5);
  assert.strictEqual(flags.config.turnTokenCap, 1000);
  assert.strictEqual(flags.config.model, "m1");
  assert.strictEqual(flags.output, "json");
  assert.strictEqual(flags.yes, true);
});
test("parseArgs rejects an unknown tier rather than downgrading it", () => {
  assert.throws(() => parseArgs(["--tier", "root", "x"]), /unknown tier/);
  assert.throws(() => parseArgs(["--approvals", "none", "x"]), /unknown approval mode/);
  assert.throws(() => parseArgs(["--nope"]), /unknown option/);
  assert.throws(() => parseArgs(["--tier"]), /needs a value/);
});
test("parseArgs rejects a negative or unparseable ceiling", () => {
  assert.throws(() => parseArgs(["--budget", "-1", "x"]), /non-negative/);
  assert.throws(() => parseArgs(["--token-cap", "abc", "x"]), /non-negative/);
});

// ─── Config ──────────────────────────────────────────────────────────────────
test("config precedence is flags over env over file over defaults", () => {
  const h = home();
  const file = path.join(h, "cli.json");
  fs.writeFileSync(file, JSON.stringify({ model: "from-file", baseUrl: "https://file", autonomy: "readonly" }));
  const cfg = loadConfig({ env: { CROWE_HOME: h, CROWE_MODEL: "from-env" }, flags: { baseUrl: "https://flag" }, file });
  assert.strictEqual(cfg.model, "from-env");
  assert.strictEqual(cfg.baseUrl, "https://flag");
  assert.strictEqual(cfg.autonomy, "readonly");
});
test("an unrecognised tier or approval mode falls back to the safe value", () => {
  const cfg = loadConfig({ env: {}, flags: { autonomy: "root", approvals: "whatever" }, file: "/nonexistent" });
  assert.strictEqual(cfg.autonomy, "edit");
  assert.strictEqual(cfg.approvals, "high-risk");
});
test("an unreadable config file degrades to defaults instead of throwing", () => {
  const h = home();
  const file = path.join(h, "cli.json");
  fs.writeFileSync(file, "{ not json");
  const cfg = loadConfig({ env: { CROWE_HOME: h }, file });
  assert.strictEqual(cfg.model, "crowelm");
  assert.strictEqual(cfg.autonomy, "edit");
});

// ─── The JSONL event contract ────────────────────────────────────────────────
test("--json emits one parseable event per line, ending with a result", async () => {
  const r = await run(async (stage, n) => (n === 0 ? reply([], "finished") : reply([], "")));
  assert.strictEqual(r.code, EXIT.ok);
  assert.ok(r.events.length >= 3, r.out);
  assert.ok(r.ofType("route").length === 1);
  assert.ok(r.ofType("assistant").length >= 1);
  const last = r.events[r.events.length - 1];
  assert.strictEqual(last.type, "result");
  assert.strictEqual(last.text, "finished");
});
test("tool calls and results appear in the stream", async () => {
  const r = await run(async (stage, n, msgs, tools) => {
    if (n === 0) return reply([call("list_dir", { path: "." })]);
    return reply([], "listed");
  }, { flags: { config: { autonomy: "readonly" } } });
  assert.strictEqual(r.ofType("tool_call")[0].name, "list_dir");
  assert.ok(r.ofType("tool_result").length === 1);
});

// ─── Approvals: the part that must not get friendlier headless ───────────────
test("without a terminal a risky action is denied, not auto-approved", async () => {
  const dir = workspace();
  const r = await run(async (stage, n) => {
    if (n === 0) return reply([call("run_shell", { command: "rm -rf build" })]);
    return reply([], "done");
  }, { cwd: dir, flags: { config: { autonomy: "execute", approvals: "high-risk" } } });
  const result = r.ofType("tool_result")[0];
  assert.match(String(result.result), /denied|blocked/i);
});
test("--yes approves the prompt but the tier gate still refuses", async () => {
  const dir = workspace();
  const r = await run(async (stage, n) => {
    if (n === 0) return reply([call("run_shell", { command: "echo hi" })]);
    return reply([], "done");
  }, { cwd: dir, flags: { yes: true, config: { autonomy: "edit" } } });
  const result = r.ofType("tool_result")[0];
  assert.match(String(result.result), /blocked/i);
  assert.match(String(result.result), /execute/i);
});
test("--yes does not let an edit-tier run reach the shell", async () => {
  const dir = workspace();
  const r = await run(async (stage, n) => {
    if (n === 0) return reply([call("run_shell", { command: "git push --force" })]);
    return reply([], "done");
  }, { cwd: dir, flags: { yes: true, config: { autonomy: "edit" } } });
  assert.match(String(r.ofType("tool_result")[0].result), /blocked/i);
});

// ─── Edits ───────────────────────────────────────────────────────────────────
test("an edit is refused in a pipe and the model is told it was refused", async () => {
  const dir = workspace();
  const r = await run(async (stage, n) => {
    if (n === 0) return reply([call("write_file", { path: "new.txt", content: "hello\n" })]);
    return reply([], "done");
  }, { cwd: dir, flags: { config: { autonomy: "edit", autoApprove: false } } });
  assert.match(String(r.ofType("tool_result")[0].result), /REJECTED/);
  assert.strictEqual(fs.existsSync(path.join(dir, "new.txt")), false);
});
test("--auto-approve applies the edit and reports a mutation", async () => {
  const dir = workspace();
  const r = await run(async (stage, n) => {
    if (n === 0) return reply([call("write_file", { path: "new.txt", content: "hello\n" })]);
    return reply([], "done");
  }, { cwd: dir, flags: { config: { autonomy: "edit", autoApprove: true } } });
  assert.strictEqual(fs.readFileSync(path.join(dir, "new.txt"), "utf8"), "hello\n");
  const last = r.events[r.events.length - 1];
  assert.strictEqual(last.mutations, 1);
});
test("the secret blocklist still holds through the CLI ctx", async () => {
  const dir = workspace();
  fs.writeFileSync(path.join(dir, ".env"), "SECRET=shhh\n");
  const r = await run(async (stage, n) => {
    if (n === 0) return reply([call("read_file", { path: ".env" })]);
    return reply([], "done");
  }, { cwd: dir, flags: { config: { autonomy: "readonly" } } });
  assert.match(String(r.ofType("tool_result")[0].result), /blocked/i);
});

// ─── Exit codes ──────────────────────────────────────────────────────────────
test("a gateway error exits 1", async () => {
  const r = await run(async () => ({ error: "HTTP 500: boom" }));
  assert.strictEqual(r.code, EXIT.error);
});
test("a failed verdict exits 3", async () => {
  const dir = workspace();
  const r = await run(async (stage, n, msgs, tools) => {
    if (stage === "verify") {
      return reply([call("submit_verdict", { status: "fail", reason: "the file was not changed", evidence: "read_file shows the old text" })]);
    }
    if (n === 0) return reply([call("write_file", { path: "new.txt", content: "hello\n" })]);
    return reply([], "claimed done");
  }, { cwd: dir, flags: { config: { autonomy: "edit", autoApprove: true, verifier: true } } });
  assert.strictEqual(r.code, EXIT.failed, r.out);
  assert.strictEqual(r.ofType("verdict").length >= 1, true);
});
test("the verifier runs on its own tool list, without the write tools", async () => {
  const dir = workspace();
  let verifierTools = null;
  await run(async (stage, n, msgs, tools) => {
    if (stage === "verify") {
      verifierTools = (tools || []).map((t) => t.function.name);
      return reply([call("submit_verdict", { status: "pass", reason: "ok", evidence: "read_file confirms" })]);
    }
    if (n === 0) return reply([call("write_file", { path: "new.txt", content: "hello\n" })]);
    return reply([], "done");
  }, { cwd: dir, flags: { config: { autonomy: "edit", autoApprove: true, verifier: true } } });
  assert.ok(verifierTools, "the verifier never ran");
  assert.ok(verifierTools.includes("submit_verdict"));
  assert.ok(!verifierTools.includes("write_file"));
  assert.ok(!verifierTools.includes("edit_file"));
});
test("an aborted run exits 2 and says it stopped", async () => {
  const dir = workspace();
  const out = sink(), err = sink();
  const h = home();
  let stop = null;
  const code = await runOnce({
    prompt: "go",
    flags: { output: "json", catalog: false, config: { token: "t", verifier: false, autonomy: "readonly" } },
    env: { CROWE_HOME: h, CROWE_CONFIG: path.join(h, "cli.json") },
    stdout: out, stderr: err,
    stdin: Object.assign(Readable.from([]), { isTTY: false }),
    onSignal: (fn) => { stop = fn; },
    gatewayChat: async () => { stop(); return { error: "aborted", aborted: true }; },
    appVersion: "0.0.0-test",
  });
  assert.strictEqual(code, EXIT.stopped);
  assert.match(out.text(), /"type":"stopped"/);
});

// ─── The journal ─────────────────────────────────────────────────────────────
test("a run writes a hash-chained journal under CROWE_HOME", async () => {
  const r = await run(async (stage, n) => (n === 0 ? reply([], "done") : reply([], "")));
  const dir = path.join(r.home, "journal");
  const files = fs.readdirSync(dir);
  assert.strictEqual(files.length, 1);
  const lines = fs.readFileSync(path.join(dir, files[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.length >= 2);
  assert.strictEqual(lines[0].prev, null);
  for (let i = 1; i < lines.length; i++) assert.strictEqual(lines[i].prev, lines[i - 1].hash);
  assert.ok(lines.some((l) => l.event_type === "TURN_STARTED"));
  assert.ok(lines.some((l) => l.event_type === "TURN_FINISHED"));
});

// ─── Output modes ────────────────────────────────────────────────────────────
test("--quiet prints only the answer on stdout", async () => {
  const r = await run(async (stage, n) => (n === 0 ? reply([], "just this") : reply([], "")),
    { flags: { output: "quiet" } });
  assert.strictEqual(r.out.trim(), "just this");
});
test("the text reporter keeps the answer on stdout and the trace on stderr", async () => {
  const r = await run(async (stage, n) => (n === 0 ? reply([], "the answer") : reply([], "")),
    { flags: { output: "text" } });
  assert.match(r.out, /the answer/);
  assert.match(r.err, /route:/);
  assert.ok(!/route:/.test(r.out));
});

// ─── The diff shown at a review prompt ───────────────────────────────────────
test("lineDiff marks removals and additions and stays bounded", () => {
  const d = lineDiff("a\nb\nc\n", "a\nB\nc\n");
  assert.match(d, /^- b$|\n- b$/m);
  assert.match(d, /\+ B/);
  const big = lineDiff("", Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"), 10);
  assert.ok(big.split("\n").length <= 11, big.split("\n").length);
  assert.match(big, /more changed line/);
});

// ─── The control plane, through the runner ───────────────────────────────────
test("the control-plane flags parse, and a bad mode is refused", () => {
  const { flags } = parseArgs(["--control-plane", "local", "--tenant", "acme", "--workspace", "w1", "go"]);
  assert.strictEqual(flags.config.controlPlane, "local");
  assert.strictEqual(flags.config.tenantId, "acme");
  assert.strictEqual(flags.config.workspaceId, "w1");
  assert.throws(() => parseArgs(["--control-plane", "maybe", "go"]), /unknown control plane/);
});

test("the plane is off by default, so an existing install is unchanged", async () => {
  const r = await run(async () => reply([], "answer"));
  assert.strictEqual(r.code, EXIT.ok);
  const [result] = r.ofType("result");
  assert.strictEqual(result.metered, undefined);
});

test("a refusal exits 6 and never reaches the gateway", async () => {
  const plane = {
    authorize: async () => ({ allowed: false, code: "quota_exhausted", reason: "the quota is spent" }),
    record: async () => ({ ok: true }),
  };
  const r = await run(async () => reply([], "should not happen"), { plane });
  assert.strictEqual(r.code, EXIT.denied);
  assert.strictEqual(r.calls.length, 0, "the turn must not run");
  const [denied] = r.ofType("denied");
  assert.strictEqual(denied.code, "quota_exhausted");
  assert.match(denied.reason, /quota is spent/);
});

test("a real turn is metered against the local plane, tokens included", async () => {
  const h = home();
  fs.writeFileSync(path.join(h, "control-plane.json"),
    JSON.stringify({ tenants: { acme: { plan: "pro", entitled: true } } }));
  const plane = makeLocalPlane({ dir: h });
  const r = await run(async () => reply([], "answer", { prompt_tokens: 120, completion_tokens: 34 }),
    { plane, flags: { config: { tenantId: "acme" } } });
  assert.strictEqual(r.code, EXIT.ok);
  const totals = plane.usage("acme");
  assert.strictEqual(totals.turns, 1);
  assert.strictEqual(totals.input_tokens, 120, "tokens come off the telemetry the harness emits");
  assert.strictEqual(totals.output_tokens, 34);
  assert.ok(totals.cost_usd > 0, "a turn that used tokens cost something");
});

test("a mutating turn meters its mutations", async () => {
  const h = home();
  fs.writeFileSync(path.join(h, "control-plane.json"),
    JSON.stringify({ tenants: { acme: { entitled: true } } }));
  const plane = makeLocalPlane({ dir: h });
  const r = await run(async (stage, n) => (n === 0
    ? reply([call("write_file", { path: "new.txt", content: "hello\n" })])
    : reply([], "wrote it")),
    { plane, flags: { config: { tenantId: "acme", autonomy: "edit", autoApprove: true } } });
  assert.strictEqual(r.code, EXIT.ok);
  assert.strictEqual(plane.usage("acme").mutations, 1);
});

test("remaining quota becomes the turn's ceiling", async () => {
  const seen = [];
  const plane = {
    authorize: async () => ({ allowed: true, code: "ok", plan: "pro", remainingUsd: 0.0001 }),
    record: async (u) => { seen.push(u); return { ok: true, written: 1 }; },
  };
  // A tool call on the first reply, so the loop reaches a second round and the
  // ceiling is tested where the harness tests it: at the top of the round.
  const r = await run(async (stage, n) => (n === 0
    ? reply([call("read_file", { path: "a.txt" })], "", { prompt_tokens: 900000, completion_tokens: 900000 })
    : reply([], "answer")),
    { plane, flags: { config: { turnBudgetUsd: 50 } } });
  const budget = r.ofType("budget").find((e) => e.source === "control-plane");
  assert.ok(budget, "the operator is told which ceiling is in force");
  assert.strictEqual(r.code, EXIT.capped, "the quota ends the turn the way a budget does");
  assert.strictEqual(seen.length, 1, "a capped turn is still metered");
});

test("a plane that cannot be reached still runs the turn when it is not required", async () => {
  const plane = {
    requirePlane: false,
    authorize: async () => ({ allowed: true, code: "ok", degraded: true, reason: "the control plane could not be reached" }),
    record: async () => ({ ok: true, written: 0, pending: 5 }),
  };
  const r = await run(async () => reply([], "answer"), { plane });
  assert.strictEqual(r.code, EXIT.ok);
  assert.match(journalText(r.home), /CONTROL_PLANE_DEGRADED/);
});

test("metering is journaled next to the rest of the turn", async () => {
  const h = home();
  fs.writeFileSync(path.join(h, "control-plane.json"), JSON.stringify({ tenants: { acme: { entitled: true } } }));
  const r = await run(async () => reply([], "answer"),
    { plane: makeLocalPlane({ dir: h }), flags: { config: { tenantId: "acme" } } });
  assert.match(journalText(r.home), /USAGE_RECORDED/);
});

// ─── Runner ──────────────────────────────────────────────────────────────────
(async () => {
  let failures = 0;
  console.log("cli");
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok   ${t.name}`); }
    catch (e) { failures++; console.log(`  FAIL ${t.name}\n       ${String(e && e.message || e).split("\n").join("\n       ")}`); }
  }
  console.log(failures ? `\n${failures} of ${tests.length} failed` : `\nall ${tests.length} cli checks passed`);
  process.exit(failures ? 1 : 0);
})();
