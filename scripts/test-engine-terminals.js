// Engine terminals through the harness: terminal_* tools against fresh bash
// processes in TerminalSessions, with the desktop's wiring stood in by a small
// adapter. Two engines work at once, each in its own terminals; neither can
// reach the other's; commands pass the run_shell risk gate; tiers below
// Execute may read but not type; a person at the keys pauses the engine.
//
//   node --test scripts/test-engine-terminals.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pty = require("node-pty");
const H = require("../harness");
const { TerminalSessions } = require("../terminal-sessions");
const { EngineTerminalProcess } = require("../engine-terminal-process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-engine-terms-"));
function rig({ tier = "execute", approve = true } = {}) {
  const sessions = new TerminalSessions(); let n = 0; const asked = [];
  const terminals = {
    open: (owner, { label, cwd, engine }) => sessions.meta(sessions.create(`engine-${++n}`, () => new EngineTerminalProcess({ pty, cols: 100, rows: 30, cwd, env: { ...process.env, PAGER: "cat" } }),
      { cols: 100, rows: 30, cwd, label: label || "terminal", openedBy: { id: owner, name: engine || owner, kind: "engine" } })),
    run: (owner, id, command, ms) => sessions.exec(id, owner, command, { timeoutMs: ms }),
    send: (owner, id, data) => sessions.engineInput(id, owner, data),
    read: (owner, id) => { sessions.engineSession(id, owner); return sessions.screenText(id); },
    list: owner => sessions.engineList(owner),
    close: (owner, id) => sessions.engineClose(id, owner),
  };
  const ctx = { getCwd: () => dir, setCwd() {}, loadConfig: () => ({ autonomy: tier, approvals: "high-risk" }), mcpTools: () => [], terminals,
    requestApproval: async req => { asked.push(req); return approve; }, journal() {} };
  const call = (agentId, name, args) => H.execTool(ctx, name, args, null, { agentId, journal() {}, send() {} });
  return { sessions, ctx, call, asked };
}
const idOf = text => /opened (engine-\d+)/.exec(text)[1];

test("two engines work side by side in terminals of their own", async t => {
  const { sessions, ctx, call } = rig(); t.after(() => sessions.closeAll());
  assert.ok(H.allTools(ctx, null, {}).some(x => x.function.name === "terminal_run"));
  const a1 = idOf(await call("main", "terminal_open", { label: "server" }));
  const a2 = idOf(await call("main", "terminal_open", { label: "tests" }));
  const b1 = idOf(await call("room:r1:qa", "terminal_open", {}));
  await new Promise(r => setTimeout(r, 400));
  const [x, y, z] = await Promise.all([
    call("main", "terminal_run", { id: a1, command: "cd /tmp && export MARK=persisted" }),
    call("main", "terminal_run", { id: a2, command: "sleep 0.3; echo tests-done" }),
    call("room:r1:qa", "terminal_run", { id: b1, command: "false" }),
  ]);
  assert.match(x, /^exit 0/); assert.match(y, /^exit 0\ntests-done$/); assert.match(z, /^exit 1/);
  // The display persists, but interpreter state does not cross command gates.
  const fresh = await call("main", "terminal_run", { id: a1, command: "pwd; echo ${MARK-unset}" });
  assert.ok(fresh.includes(dir));
  assert.match(fresh, /\nunset$/);
  assert.match(await call("room:r1:qa", "terminal_run", { id: a1, command: "ls" }), /not one this engine opened/);
  assert.match(await call("main", "terminal_list", {}), /server[\s\S]*tests/);
  assert.doesNotMatch(await call("main", "terminal_list", {}), new RegExp(b1));
  // A long runner keeps going; the engine reads and stops it.
  assert.match(await call("main", "terminal_run", { id: a2, command: "echo waiting; sleep 30", timeout_seconds: 1 }), /^still running[\s\S]*waiting/);
  assert.match(await call("main", "terminal_run", { id: a2, command: "true" }), /still running the last command/);
  assert.match(await call("main", "terminal_send", { id: a2, key: "ctrl_c" }), /^blocked:/);
  assert.match(await call("main", "terminal_read", { id: a2 }), /waiting/);
  assert.match(await call("main", "terminal_close", { id: a2 }), /^closed/);
  // A person types: the engine waits and is told why.
  assert.throws(() => sessions.localInput(a1, ""), /No command is running/);
  assert.match(await call("main", "terminal_run", { id: a1, command: "true" }), /operator is typing/);
  assert.match(await call("main", "terminal_close", { id: a1 }), /operator is typing/);
  assert.equal(sessions.sessions.has(a2), false);
});

test("commands in a terminal pass the same gate as run_shell", async t => {
  const r = rig({ approve: false }); t.after(() => r.sessions.closeAll());
  const id = idOf(await r.call("main", "terminal_open", {}));
  await new Promise(res => setTimeout(res, 300));
  const out = await r.call("main", "terminal_run", { id, command: "git push --force origin main" });
  assert.ok(r.asked.length === 1 && /force/i.test(r.asked[0].detail), "no approval card for a force push");
  assert.doesNotMatch(out, /^exit/);
  const sent = await r.call("main", "terminal_send", { id, text: "rm -rf ~/somewhere", key: "enter" });
  assert.equal(r.asked.length, 1, "raw input must not reach approval or execution"); assert.match(sent, /^blocked: raw engine terminal input/);
  assert.match(await r.call("main", "terminal_run", { id, command: "cat ~/.ssh/id_ed25519" }), /^blocked/);
});

test("below Execute an engine may read its terminals but not open or type", async t => {
  const r = rig({ tier: "edit" }); t.after(() => r.sessions.closeAll());
  assert.match(await r.call("main", "terminal_open", {}), /^blocked: terminals run commands/);
  assert.match(await r.call("main", "terminal_list", {}), /No terminals open/);
});
