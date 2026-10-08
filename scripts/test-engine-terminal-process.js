const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pty = require("node-pty");
const { EngineTerminalProcess } = require("../engine-terminal-process");
const { TerminalSessions } = require("../terminal-sessions");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await delay(20); } throw new Error("Timed out waiting for terminal state"); };
function rig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-command-channel-"));
  let clock = 1000;
  const manager = new TerminalSessions({ now: () => clock });
  const s = manager.create("engine", () => new EngineTerminalProcess({ pty, cwd: dir, env: { PATH: process.env.PATH, HOME: dir, LANG: "en_US.UTF-8" } }), {
    cwd: dir, openedBy: { id: "owner", kind: "engine", name: "Test engine" },
  });
  t.after(() => { manager.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { manager, s, dir, advance: () => { clock += 11000; }, run: (command, options) => manager.exec(s.id, "owner", command, options) };
}

test("fresh command channel uses argv and real process exits", { skip: process.platform === "win32" }, async t => {
  const { manager, s, dir, advance, run } = rig(t);
  assert.deepEqual((await run("printf 'hello\\n'" )).output, "hello");
  assert.equal((await run("exit 7")).exitCode, 7);
  assert.equal((await run("exec /bin/sh -c 'exit 9'")).exitCode, 9);
  assert.notEqual((await run("if then")).exitCode, 0);
  assert.equal((await run("printf '%s\\n' after")).output, "after");
  await run("cd /; export PREVIOUS_COMMAND=hidden");
  const next = await run("pwd -P; printf '%s\\n' \"${PREVIOUS_COMMAND-unset}\"");
  assert.equal(next.output, `${fs.realpathSync(dir)}\nunset`);
  assert.throws(() => manager.localInput(s.id, "echo STALE_COMMAND\r"), /No command is running/);
  advance();
  assert.equal((await run("printf '%s\\n' clean")).output, "clean");
  assert.doesNotMatch((await manager.screenText(s.id)).text, /STALE_COMMAND/);
});

test("operator input cannot be retained for the next command", { skip: process.platform === "win32" }, async t => {
  const { manager, s, advance, run } = rig(t);
  const first = run("printf 'ready\\n'; read -r answer; printf '%s\\n' \"$answer\"");
  await until(async () => (await manager.screenText(s.id)).text.includes("ready"));
  manager.localInput(s.id, "operator answer\rprintf STALE_BUFFER\r");
  assert.equal((await first).exitCode, 0);
  advance();
  assert.equal((await run("printf clean")).output, "clean");
});

test("timeout keeps the child busy until actual exit, and close resolves a pending run", { skip: process.platform === "win32" }, async t => {
  const { manager, s, run } = rig(t);
  const timed = await run("printf 'waiting\\n'; sleep 0.8; printf 'done\\n'", { timeoutMs: 500 });
  assert.equal(timed.timedOut, true); assert.match(timed.output, /waiting/);
  assert.equal(manager.meta(s).busy, true);
  await assert.rejects(run("true"), /still running/);
  await until(() => !manager.meta(s).busy);
  assert.equal((await run("true")).exitCode, 0);
  const pending = run("sleep 30");
  manager.close(s.id);
  assert.equal((await pending).ended, true);
  assert.equal(manager.listenerCount("removed"), 0);
});

test("Windows is explicitly refused instead of sending POSIX framing to PowerShell", () => {
  assert.throws(() => new EngineTerminalProcess({ pty, platform: "win32" }), /not supported on Windows/);
});
