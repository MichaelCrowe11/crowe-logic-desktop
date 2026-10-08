"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { TerminalSessions } = require("../terminal-sessions");
const { DraftBridge } = require("../draft-bridge");
const { FakePty } = require("./mirror-fixtures");
const { edit, editorCommand } = require("../session-editor");

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-session-client-"));
  const file = path.join(dir, "draft with spaces.md"); fs.writeFileSync(file, "first\r\nsecond\r\n", { mode: 0o600 });
  const sessions = new TerminalSessions(), session = sessions.create("test", () => new FakePty());
  const broker = new DraftBridge(sessions); await broker.start();
  t.after(() => { broker.stop(); sessions.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, sessions, session, broker, env: broker.env(session) };
}

test("bundled session editor returns Unicode through the authenticated broker and retains CRLF", async t => {
  const f = await setup(t);
  f.sessions.once("draft-open", ({ draft }) => {
    f.sessions.changeDraft(f.session.id, draft.id, { text: "café\nnew", baseRevision: 1, operationId: "save-test", action: "save", local: true });
    f.sessions.changeDraft(f.session.id, draft.id, { baseRevision: 2, operationId: "return-test", action: "return", local: true });
  });
  assert.equal(await edit(f.file, f.env, { pollMs: 1 }), 0);
  assert.equal(fs.readFileSync(f.file, "utf8"), "café\r\nnew");
  assert.equal(f.session.draft, null);
});

test("discard preserves the file and a concurrent file change prevents return", async t => {
  const f = await setup(t);
  f.sessions.once("draft-open", ({ draft }) => f.sessions.cancelDraft(f.session.id, draft.id));
  assert.equal(await edit(f.file, f.env, { pollMs: 1 }), 0);
  assert.equal(fs.readFileSync(f.file, "utf8"), "first\r\nsecond\r\n");
  f.sessions.once("draft-open", ({ draft }) => {
    fs.writeFileSync(f.file, "external edit");
    f.sessions.changeDraft(f.session.id, draft.id, { baseRevision: 1, operationId: "return-test", action: "return", local: true });
  });
  await assert.rejects(edit(f.file, f.env, { pollMs: 1 }), /changed outside/);
  assert.equal(fs.readFileSync(f.file, "utf8"), "external edit");
});

test("missing credentials, oversize files and symbolic links fail without opening a draft", async t => {
  const f = await setup(t);
  await assert.rejects(edit(f.file, {}), /no shared draft broker/);
  fs.writeFileSync(f.file, "x".repeat(256 * 1024 + 1));
  await assert.rejects(edit(f.file, f.env), /256 KiB/);
  const alias = path.join(f.dir, "alias"); fs.symlinkSync(f.file, alias);
  await assert.rejects(edit(alias, f.env));
  assert.equal(f.session.draft, null);
});

test("restoring CRLF cannot exceed the shared draft file limit", async t => {
  const f = await setup(t);
  const original = fs.readFileSync(f.file, "utf8");
  f.sessions.once("draft-open", ({ draft }) => {
    f.sessions.changeDraft(f.session.id, draft.id, { text: "\n".repeat(128 * 1024 + 1), baseRevision: 1, operationId: "large-save", action: "save", local: true });
    f.sessions.changeDraft(f.session.id, draft.id, { baseRevision: 2, operationId: "large-return", action: "return", local: true });
  });
  await assert.rejects(edit(f.file, f.env, { pollMs: 1 }), /after restoring line endings/);
  assert.equal(fs.readFileSync(f.file, "utf8"), original);
});

test("editor command preserves paths containing spaces, quotes and shell substitutions", { skip: process.platform === "win32" }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-command-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "draft ' $HOME `echo no` $(echo no).js");
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  const command = editorCommand({ executable: process.execPath, appPath: script, packaged: false });
  assert.deepEqual(JSON.parse(execSync(command, { encoding: "utf8" })), ["--session-draft"]);
});

test("packaged editor command uses the bundled app runtime", () => {
  assert.equal(editorCommand({
    executable: "/Applications/Crowe Logic.app/Contents/MacOS/Crowe Logic",
    appPath: "/resources/app.asar",
    packaged: true,
    platform: "darwin",
  }), "'/Applications/Crowe Logic.app/Contents/MacOS/Crowe Logic' '--session-draft'");
});
