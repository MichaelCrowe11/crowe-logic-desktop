const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const crypto = require("node:crypto");
const http = require("node:http");
const { TerminalSessions } = require("../terminal-sessions");
const { Companion } = require("../companion");
const { DraftBridge } = require("../draft-bridge");
const { FakePty } = require("./mirror-fixtures");

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-mirror-test-"));
  const manager = new TerminalSessions(); const proc = new FakePty(); const session = manager.create("test", () => proc);
  // The agent's tier refuses everything: the terminal answers to the
  // device's own grant, not to it.
  const companion = new Companion({ tokenFile: path.join(dir, "companion.token"), loopback: true, port: 0, sessions: manager, tierAllows: () => false });
  await companion.start(); const phone = companion.addDevice("Test phone", { terminal: true });
  const bridge = new DraftBridge(manager); await bridge.start();
  t.after(async () => { bridge.stop(); manager.closeAll(); await companion.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = async (route, body = {}, token = phone.token) => {
    const r = await fetch(`http://127.0.0.1:${companion.port}${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, generation: session.generation, ...body }) });
    return { status: r.status, body: await r.json() };
  };
  return { dir, manager, proc, session, companion, phone, bridge, post, deny: () => companion.setTerminal(phone.id, false) };
}

test("live HTTP mirror requires pairing and rechecks the terminal grant and revoked devices", async t => {
  const f = await setup(t);
  assert.equal((await f.post("/sessions/list", {}, "bad")).status, 401);
  const listed = await f.post("/sessions/list"); assert.equal(listed.body.sessions.length, 1);
  assert.ok(!JSON.stringify(listed.body).includes(f.session.secret));
  f.proc.emit("data", "private terminal output");
  assert.match((await f.post("/sessions/poll", { after: -1 })).body.snapshot, /private terminal output/);
  const lease = (await f.post("/sessions/control")).body.controller.lease;
  assert.equal((await f.post("/sessions/input", { lease, inputId: crypto.randomUUID(), data: "x" })).status, 200);
  f.deny(); assert.equal((await f.post("/sessions/input", { lease, inputId: crypto.randomUUID(), data: "y" })).status, 403);
  assert.deepEqual(f.proc.inputs, ["x"]);
  f.companion.revokeDevice(f.phone.id); assert.equal((await f.post("/sessions/poll")).status, 401);
});

test("revoking an active controller removes its lease and leaves other devices paired", async t => {
  const f = await setup(t);
  const other = f.companion.addDevice("Second test phone", { terminal: true });
  const lease = (await f.post("/sessions/control")).body.controller.lease;
  assert.equal(f.session.controller.deviceId, f.phone.id);
  f.companion.revokeDevice(f.phone.id);
  assert.equal(f.session.controller, null);
  for (const route of ["/sessions/renew", "/sessions/input", "/sessions/resize"]) {
    assert.equal((await f.post(route, { lease, inputId: crypto.randomUUID(), data: "revoked", cols: 40, rows: 10 })).status, 401);
  }
  assert.deepEqual(f.proc.inputs, []);
  assert.equal((await f.post("/sessions/list", {}, other.token)).status, 200);
  const next = await f.post("/sessions/control", {}, other.token);
  assert.equal(next.body.controller.deviceId, other.id);
  assert.notEqual(next.body.controller.lease, lease);
});

test("multiple phone shells stay independent and repeated opens create only one shell", async t => {
  const f = await setup(t); let opened = 0;
  f.companion.openShell = async ({ cols, rows, device, label }) => f.manager.create(`phone-${++opened}`, () => new FakePty(), { cols, rows, openedBy: device, label });
  const operationId = crypto.randomUUID();
  const [a, duplicate] = await Promise.all([f.post("/sessions/open", { operationId }), f.post("/sessions/open", { operationId })]);
  assert.equal(a.status, 200); assert.equal(duplicate.body.id, a.body.id); assert.equal(opened, 1);
  const b = await f.post("/sessions/open", { operationId: crypto.randomUUID() });
  assert.notEqual(a.body.id, b.body.id); assert.notEqual(a.body.label, b.body.label);
  for (const [session, text] of [[a.body, "first"], [b.body, "second"]]) {
    assert.equal((await f.post("/sessions/input", { sessionId: session.id, generation: session.generation, lease: session.controller.lease, inputId: crypto.randomUUID(), data: text })).status, 200);
    assert.deepEqual(f.manager.get(session.id).proc.inputs, [text]);
  }
  assert.equal((await f.post("/sessions/close", { sessionId: b.body.id, generation: b.body.generation })).status, 200);
  assert.ok(f.manager.sessions.has(a.body.id)); assert.ok(!f.manager.sessions.has(b.body.id));
  f.manager.reclaim(a.body.id);
  const retried = await f.post("/sessions/open", { operationId });
  assert.equal(retried.body.controller, null, "a retry resurrected a stale control lease");
  assert.equal(opened, 2);
});

test("revocation during asynchronous shell creation closes that shell and returns no lease", async t => {
  const f = await setup(t); let finish, began;
  const started = new Promise(resolve => { began = resolve; });
  const wait = new Promise(resolve => { finish = resolve; });
  f.companion.openShell = async ({ device }) => { began(); await wait; return f.manager.create("late-phone", () => new FakePty(), { openedBy: device }); };
  const response = f.post("/sessions/open", { operationId: crypto.randomUUID() });
  await started; f.companion.revokeDevice(f.phone.id); finish();
  assert.equal((await response).status, 401);
  assert.equal(f.manager.sessions.has("late-phone"), false);
  assert.equal(f.manager.sessions.has("test"), true, "revocation closed an unrelated terminal");
});

test("revocation while a request body arrives prevents a queued draft write", { timeout: 10000 }, async t => {
  const f = await setup(t);
  const draft = f.manager.openDraft(f.session.id, "original");
  const body = JSON.stringify({ sessionId: f.session.id, generation: f.session.generation,
    draftId: draft.id, baseRevision: draft.revision, text: "revoked write", operationId: crypto.randomUUID() });
  const acceptedHeaders = once(f.companion.server, "request");
  const request = http.request({ hostname: "127.0.0.1", port: f.companion.port, path: "/draft/save", method: "POST",
    headers: { Authorization: `Bearer ${f.phone.token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } });
  t.after(() => request.destroy());
  const response = new Promise((resolve, reject) => {
    request.once("error", reject);
    request.once("response", res => { res.resume(); res.once("end", () => resolve(res.statusCode)); });
  });
  request.write(body.slice(0, 1));
  await acceptedHeaders;
  f.companion.revokeDevice(f.phone.id);
  request.end(body.slice(1));
  assert.equal(await response, 401);
  assert.equal(f.manager.draft(f.session.id, draft.id).text, "original");
});

test("stopping the companion cannot leave a pending phone shell running", async t => {
  const f = await setup(t); let finish, began;
  const started = new Promise(resolve => { began = resolve; });
  const wait = new Promise(resolve => { finish = resolve; });
  f.companion.openShell = async ({ device }) => { began(); await wait; return f.manager.create("late-stop", () => new FakePty(), { openedBy: device }); };
  const response = f.post("/sessions/open", { operationId: crypto.randomUUID() });
  await started;
  const stopped = f.companion.stop(); finish();
  assert.equal((await response).status, 503);
  await stopped;
  assert.equal(f.manager.sessions.has("late-stop"), false);
  assert.ok(f.manager.sessions.has("test"));
});

test("real CLI helper returns the phone's exact multiline draft without sending PTY input", { timeout: 15000 }, async t => {
  const f = await setup(t); const filename = path.join(f.dir, "draft.md"); fs.writeFileSync(filename, "original\n");
  const opened = once(f.manager, "draft-open");
  const child = spawn("python3", [path.join(__dirname, "../bin/crowe-session-editor.py"), filename], { env: { ...process.env, ...f.bridge.env(f.session) }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const done = once(child, "exit"); let errors = ""; child.stderr.on("data", data => { errors += data; });
  const [{ draft }] = await opened;
  const text = "Review the reconnect failure.\nKeep the exact second line: 東京.\n";
  const save = await f.post("/draft/save", { draftId: draft.id, baseRevision: 1, text, operationId: crypto.randomUUID() });
  assert.equal(save.status, 200);
  const returned = await f.post("/draft/return", { draftId: draft.id, baseRevision: save.body.revision, operationId: crypto.randomUUID() });
  assert.equal(returned.status, 200); assert.equal((await done)[0], 0, errors);
  assert.equal(fs.readFileSync(filename, "utf8"), text); assert.deepEqual(f.proc.inputs, []);
});

test("helper cannot overwrite an externally modified draft", { timeout: 15000 }, async t => {
  const f = await setup(t); const filename = path.join(f.dir, "draft.md"); fs.writeFileSync(filename, "original");
  const opened = once(f.manager, "draft-open");
  const child = spawn("python3", [path.join(__dirname, "../bin/crowe-session-editor.py"), filename], { env: { ...process.env, ...f.bridge.env(f.session) }, stdio: "ignore" });
  t.after(() => { if (child.exitCode === null) child.kill(); }); const done = once(child, "exit");
  const [{ draft }] = await opened;
  fs.writeFileSync(filename, "outside edit");
  f.manager.changeDraft(f.session.id, draft.id, { action: "return", baseRevision: 1, operationId: crypto.randomUUID() });
  assert.equal((await done)[0], 1); assert.equal(fs.readFileSync(filename, "utf8"), "outside edit");
});


test("discarding a managed draft leaves the CLI original and exits successfully", { timeout: 15000 }, async t => {
  const f = await setup(t); const filename = path.join(f.dir, "cancel.md"); fs.writeFileSync(filename, "original\r\n");
  const opened = once(f.manager, "draft-open");
  const child = spawn("python3", [path.join(__dirname, "../bin/crowe-session-editor.py"), filename], { env: { ...process.env, ...f.bridge.env(f.session) }, stdio: "ignore" });
  t.after(() => { if (child.exitCode === null) child.kill(); }); const done = once(child, "exit");
  const [{ draft }] = await opened;
  f.manager.cancelDraft(f.session.id, draft.id);
  assert.equal((await done)[0], 0); assert.equal(fs.readFileSync(filename, "utf8"), "original\r\n");
  assert.deepEqual(f.proc.inputs, []);
});
