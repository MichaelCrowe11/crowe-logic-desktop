"use strict";
// Run with Node (under xvfb on Linux). The child is the actual Electron entry
// point, with no Python and without enabling the RunAsNode fuse.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { TerminalSessions } = require("../terminal-sessions");
const { DraftBridge } = require("../draft-bridge");
const { FakePty } = require("./mirror-fixtures");

test("application entry point returns a shared draft using the bundled runtime", { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-editor-runtime-"));
  const file = path.join(dir, "draft with spaces.md"); fs.writeFileSync(file, "original", { mode: 0o600 });
  const manager = new TerminalSessions(), session = manager.create("runtime", () => new FakePty());
  const bridge = new DraftBridge(manager); await bridge.start();
  let child;
  t.after(() => { if (child?.exitCode === null) child.kill(); bridge.stop(); manager.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); });
  manager.once("draft-open", ({ draft }) => {
    manager.changeDraft(session.id, draft.id, { text: "returned from Crowe Logic", baseRevision: 1, operationId: "save-runtime", action: "save", local: true });
    manager.changeDraft(session.id, draft.id, { baseRevision: 2, operationId: "return-runtime", action: "return", local: true });
  });
  const env = { ...process.env, ...bridge.env(session) }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require("electron"), [path.resolve(__dirname, ".."), "--session-draft", file], { env, stdio: ["ignore", "ignore", "pipe"] });
  let error = ""; child.stderr.on("data", data => { error = (error + data).slice(-2000); });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, error);
  assert.equal(fs.readFileSync(file, "utf8"), "returned from Crowe Logic");
  assert.equal(session.draft, null);
});
