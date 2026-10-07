const test = require("node:test");
const assert = require("node:assert/strict");
const { Terminal } = require("@xterm/headless");
const { TerminalSessions } = require("../terminal-sessions");
const { FakePty } = require("./mirror-fixtures");
const write = (t, value) => new Promise(resolve => t.write(value, resolve));
const line = t => t.buffer.active.getLine(t.buffer.active.cursorY + t.buffer.active.baseY).translateToString(true);

test("snapshot and bounded replay reconstruct alternate screen, cursor and Unicode", async t => {
  const manager = new TerminalSessions({ historyBytes: 120 }); t.after(() => manager.closeAll());
  const proc = new FakePty(); const s = manager.create("console", () => proc);
  proc.emit("data", "normal screen\r\n\u001b[?1049h\u001b[2J\u001b[H你好 cortex\u001b[4DTEST");
  const first = await manager.poll(s.id, s.generation, -1);
  const viewer = new Terminal({ cols: first.cols, rows: first.rows, allowProposedApi: true }); t.after(() => viewer.dispose());
  await write(viewer, first.snapshot);
  assert.equal(line(viewer), line(s.screen));
  assert.equal(viewer.buffer.active.type, "alternate");
  assert.equal(viewer.buffer.active.cursorX, s.screen.buffer.active.cursorX);
  proc.emit("data", "\r\nnext");
  const next = await manager.poll(s.id, s.generation, first.seq);
  assert.equal(next.snapshot, null); assert.equal(next.events.length, 1);
  await write(viewer, next.events[0].data); assert.equal(line(viewer), line(s.screen));
  for (let i = 0; i < 40; i++) proc.emit("data", `\r\nline ${i}`);
  const resync = await manager.poll(s.id, s.generation, first.seq);
  assert.notEqual(resync.snapshot, null); assert.ok(s.bytes <= 120);
  viewer.reset(); await write(viewer, resync.snapshot); assert.equal(line(viewer), line(s.screen));
});

test("resize is sequenced with output; viewing never writes or resizes a PTY", async t => {
  const manager = new TerminalSessions(); t.after(() => manager.closeAll()); const proc = new FakePty();
  const s = manager.create("console", () => proc);
  proc.emit("data", "before"); await manager.resize(s.id, 100, 30); proc.emit("data", "after");
  const result = await manager.poll(s.id, s.generation, 0);
  assert.deepEqual(result.events.map(e => e.type), ["output", "resize", "output"]);
  assert.deepEqual([s.screen.cols, s.screen.rows], [100, 30]);
  assert.deepEqual(proc.inputs, []);
  assert.throws(() => manager.resize(s.id, 20000, 30), /dimensions/);
});

test("one controller, generation checks, deduplication, reclaim, expiry and revocation", t => {
  let now = 0; const manager = new TerminalSessions({ now: () => now }); t.after(() => manager.closeAll());
  const proc = new FakePty(); const s = manager.create("console", () => proc);
  const phone = { id: "phone", name: "Phone" }, other = { id: "other", name: "Other" };
  assert.throws(() => manager.input(s.id, s.generation, phone, 0, "input-0001", "x"), /Take control/);
  const lease = manager.acquire(s.id, s.generation, phone).controller.lease;
  assert.throws(() => manager.acquire(s.id, s.generation, other), /Another phone/);
  assert.throws(() => manager.input(s.id, "stale", phone, lease, "input-0001", "x"), /session ended/);
  manager.input(s.id, s.generation, phone, lease, "input-0001", "x");
  assert.equal(manager.input(s.id, s.generation, phone, lease, "input-0001", "x").duplicate, true);
  assert.throws(() => manager.input(s.id, s.generation, phone, lease, "input-0001", "y"), /already used/);
  manager.localResize(s.id, 120, 50); assert.equal(proc.cols, undefined);
  manager.localInput(s.id, "local"); assert.deepEqual(proc.inputs, ["x", "local"]);
  assert.throws(() => manager.input(s.id, s.generation, phone, lease, "input-0002", "x"), /Take control/);
  manager.acquire(s.id, s.generation, phone); now = 20000;
  assert.equal(manager.meta(s).controller, null);
  manager.acquire(s.id, s.generation, phone); manager.revoke(phone.id);
  assert.equal(manager.meta(s).controller, null);
});

test("draft conflicts, dirty desktop protection and idempotent return preserve exact text", t => {
  const manager = new TerminalSessions(); t.after(() => manager.closeAll()); const proc = new FakePty();
  const s = manager.create("console", () => proc); const draft = manager.openDraft(s.id, "original");
  const change = { baseRevision: 1, operationId: "save-0001", text: "Line one\n第二行\n", action: "save" };
  const saved = manager.changeDraft(s.id, draft.id, change);
  assert.equal(saved.revision, 2); assert.equal(manager.changeDraft(s.id, draft.id, change).revision, 2);
  assert.throws(() => manager.changeDraft(s.id, draft.id, { ...change, operationId: "save-0002" }), /draft changed/);
  s.draft.desktopDirty = true;
  assert.throws(() => manager.changeDraft(s.id, draft.id, { action: "return", baseRevision: 2, operationId: "return-0001" }), /draft changed/);
  s.draft.desktopDirty = false;
  const returning = { action: "return", baseRevision: 2, operationId: "return-0001" };
  assert.equal(manager.changeDraft(s.id, draft.id, returning).status, "returned");
  assert.equal(manager.changeDraft(s.id, draft.id, returning).text, change.text);
  assert.deepEqual(proc.inputs, []);
  const newer = manager.openDraft(s.id, "newer"); assert.notEqual(newer.id, draft.id);
  assert.throws(() => manager.changeDraft(s.id, draft.id, returning), /no longer attached/);
});

const { EngineTerminalProcess } = require("../engine-terminal-process");
function commandProcess(answers) {
  return new EngineTerminalProcess({ pty: { spawn(_shell, args) {
    const child = new FakePty();
    const [out, code, hang] = answers[args.at(-1)] || ["command not found", 127];
    setTimeout(() => { child.emit("data", out); if (!hang) child.emit("exit", { exitCode: code }); }, 5);
    return child;
  } } });
}

test("engines run commands side by side, reject raw input, and respect operator holds", async t => {
  let clock = 1000; const manager = new TerminalSessions({ now: () => clock }); t.after(() => manager.closeAll());
  const answers = { "git status": ["\u001b[1mOn branch main\u001b[0m\r\nnothing to commit", 0], "npm test": ["1 failing", 1], "npm run dev": ["listening on 5173", 0, true] };
  const a = manager.create("engine-a", () => commandProcess(answers), { openedBy: { id: "run:a", name: "Engine A", kind: "engine" } });
  const b = manager.create("engine-b", () => commandProcess(answers), { openedBy: { id: "run:b", name: "Engine B", kind: "engine" } });
  const [ra, rb] = await Promise.all([manager.exec(a.id, "run:a", "git status"), manager.exec(b.id, "run:b", "npm test")]);
  assert.deepEqual([ra.exitCode, ra.output], [0, "On branch main\nnothing to commit"]);
  assert.deepEqual([rb.exitCode, rb.output], [1, "1 failing"]);
  assert.equal(manager.meta(a).origin, "engine");
  assert.deepEqual(manager.engineList("run:a").map(s => s.id), ["engine-a"]);
  assert.throws(() => manager.engineInput(a.id, "run:b", "ls\r"), /not one this engine opened/);
  for (const data of ["echo hidden", "\r", "\u0003", "ls\n", 5]) {
    assert.throws(() => manager.engineInput(a.id, "run:a", data), /Raw engine terminal input is disabled/);
  }
  const dev = await manager.exec(a.id, "run:a", "npm run dev", { timeoutMs: 600 });
  assert.equal(dev.timedOut, true); assert.match(dev.output, /listening on 5173/);
  await assert.rejects(manager.exec(a.id, "run:a", "ls"), /still running/);
  manager.localInput(a.id, "x"); assert.equal(manager.meta(a).held, true);
  assert.throws(() => manager.engineClose(a.id, "run:a"), /operator is typing/);
  clock += 11000; manager.engineClose(a.id, "run:a");

  manager.acquire(b.id, b.generation, { id: "phone", name: "iPhone" });
  await assert.rejects(manager.exec(b.id, "run:b", "git status"), /iPhone has taken this terminal/);
  assert.throws(() => manager.engineClose(b.id, "run:b"), /iPhone has taken this terminal/);
  manager.reclaim(b.id);
  assert.equal((await manager.exec(b.id, "run:b", "git status")).exitCode, 0);
  assert.match((await manager.screenText(b.id)).text, /nothing to commit/);
});

test("companion shutdown closes only phone-origin terminals", t => {
  const manager = new TerminalSessions(); t.after(() => manager.closeAll());
  manager.create("desktop", () => new FakePty());
  manager.create("phone", () => new FakePty(), { openedBy: { id: "phone", name: "Phone" } });
  manager.create("engine", () => commandProcess({}), { openedBy: { id: "phone", name: "Engine", kind: "engine" } });
  manager.closeOpenedBy("phone");
  assert.deepEqual([...manager.sessions.keys()], ["desktop", "engine"]);
  manager.closeOpenedBy();
  assert.deepEqual([...manager.sessions.keys()], ["desktop", "engine"]);
});

test("Stop closes only that engine seat's terminals, including pending runs", async t => {
  const manager = new TerminalSessions(); t.after(() => manager.closeAll());
  for (const [id, owner] of [["a", "seat-a"], ["b", "seat-b"]]) {
    manager.create(id, () => commandProcess({ wait: ["waiting", 0, true] }), { openedBy: { id: owner, kind: "engine" } });
  }
  manager.create("operator", () => new FakePty());
  const pending = manager.exec("a", "seat-a", "wait");
  manager.closeEngineOwner("seat-a");
  assert.equal((await pending).ended, true);
  assert.deepEqual([...manager.sessions.keys()], ["b", "operator"]);
  manager.closeEngineOwner();
  assert.deepEqual([...manager.sessions.keys()], ["operator"]);
  assert.equal(manager.listenerCount("removed"), 0);
});

test("engine execution refuses an arbitrary interactive shell", async t => {
  const manager = new TerminalSessions(); t.after(() => manager.closeAll());
  const p = new FakePty(); manager.create("unsafe", () => p, { openedBy: { id: "engine", kind: "engine" } });
  await assert.rejects(manager.exec("unsafe", "engine", "echo safe"), /no controlled command channel/);
  assert.deepEqual(p.inputs, []);
});
