"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("../harness");

function rig(tier = "execute") {
  const calls = [];
  const ctx = {
    getCwd: () => process.cwd(), loadConfig: () => ({ autonomy: tier, approvals: "high-risk" }),
    mcpTools: () => [], journal() {},
    requestApproval: async request => { calls.push(["approval", request]); return false; },
    terminals: {
      open() { calls.push(["open"]); return { id: "term", label: "tests" }; },
      run(owner, id, command) { calls.push(["run", owner, id, command]); return { exitCode: 0, output: "ok" }; },
      send() { calls.push(["send"]); throw new Error("Raw adapter must never be reached"); },
      close() { calls.push(["close"]); },
      list() { return []; },
      read() { return { text: "output", cursor: { x: 0, y: 0 } }; },
    },
  };
  const state = { agentId: "engine-a", journal() {}, send() {} };
  return { ctx, calls, call: (name, args = {}) => H.execTool(ctx, name, args, null, state) };
}

test("raw terminal input is absent from schemas and stale calls fail closed", async () => {
  const r = rig();
  assert.equal(H.allTools(r.ctx, null, {}).some(t => t.function.name === "terminal_send"), false);
  for (const args of [
    { text: "echo staged" }, { key: "enter" }, { text: "echo embedded\n" },
    { text: "echo carriage\r" }, { key: "up" }, { key: "ctrl_c" },
    { key: "ctrl_d" }, { text: "q" }, { text: "", key: "enter" },
  ]) assert.match(await r.call("terminal_send", { id: "term", ...args }), /^blocked: raw engine terminal input/);
  assert.deepEqual(r.calls, [], "raw input must not reach an adapter or approval fallback");
});

test("denied commands never reach the execution adapter", async () => {
  const r = rig();
  const result = await r.call("terminal_run", { id: "term", command: "git push --force origin main" });
  assert.doesNotMatch(result, /^exit/);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0][0], "approval");
  assert.equal(r.calls.some(c => c[0] === "run"), false);
});

test("read-only tiers cannot close processes or inject input", async () => {
  for (const tier of ["edit", "plan", "ask"]) {
    const r = rig(tier);
    for (const name of ["terminal_open", "terminal_run", "terminal_close", "terminal_send"])
      assert.match(await r.call(name, { id: "term", command: "echo ok", key: "enter" }), /^blocked:/);
    assert.match(await r.call("terminal_list"), /No terminals open/);
    assert.match(await r.call("terminal_read", { id: "term" }), /^output/);
    assert.deepEqual(r.calls, []);
  }
});

test("Stop while approval is pending prevents later execution", async () => {
  const r = rig(); let stopped = false;
  r.ctx.requestApproval = async () => { stopped = true; return true; };
  const result = await H.execTool(r.ctx, "terminal_run", { id: "term", command: "git push --force origin main" }, null,
    { agentId: "engine-a", isAborted: () => stopped, journal() {}, send() {} });
  assert.match(result, /^blocked: this engine turn was stopped/);
  assert.deepEqual(r.calls, []);
});

test("approved read-only command reaches the adapter exactly once", async () => {
  const r = rig();
  assert.equal(await r.call("terminal_run", { id: "term", command: "pwd" }), "exit 0\nok");
  assert.deepEqual(r.calls, [["run", "engine-a", "term", "pwd"]]);
});
