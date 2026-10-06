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
