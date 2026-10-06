const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDocument, MAX_BYTES } = require("../draft-document");

function fixture(t, text = "original draft") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-editor-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "draft with spaces.md");
  fs.writeFileSync(file, text, { mode: 0o600 });
  return { dir, file };
}
test("saves Unicode, multiline and empty drafts, retaining private file mode", t => {
  const { file } = fixture(t);
  const doc = openDocument(file);
  assert.equal(doc.changed(doc.text), false);
  for (const text of ["Crowe Logic\nMycelium café 🍄\n", "short", ""]) {
    doc.save(text);
    assert.equal(fs.readFileSync(file, "utf8"), text);
    assert.equal(doc.changed(text), false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});
test("closing without save leaves disk untouched; CRLF survives textarea normalization", t => {
  const { file } = fixture(t, "first\r\nsecond\r\n");
  const doc = openDocument(file);
  assert.equal(doc.changed("first\nsecond\n"), false);
  assert.equal(doc.changed("new draft"), true);
  assert.equal(fs.readFileSync(file, "utf8"), "first\r\nsecond\r\n");
  doc.save("first\nthird\n");
  assert.equal(fs.readFileSync(file, "utf8"), "first\r\nthird\r\n");
});
test("refuses to overwrite a concurrent edit or replacement", t => {
  const { file } = fixture(t);
  const doc = openDocument(file);
  fs.writeFileSync(file, "external edit");
  assert.throws(() => doc.save("new"), /changed outside/);
  assert.equal(fs.readFileSync(file, "utf8"), "external edit");
  const fresh = openDocument(file);
  fs.renameSync(file, file + ".original");
  fs.writeFileSync(file, "external edit");
  assert.throws(() => fresh.save("new"), /changed outside/);
});
test("rejects symlinks and hardlinks at open and after a swap", t => {
  const { file, dir } = fixture(t);
  fs.symlinkSync(file, path.join(dir, "alias"));
  assert.throws(() => openDocument(path.join(dir, "alias")));
  const doc = openDocument(file);
  fs.renameSync(file, file + ".original");
  fs.symlinkSync(file + ".original", file);
  assert.throws(() => doc.save("new"));
  assert.equal(fs.readFileSync(file, "utf8"), "original draft");
  fs.linkSync(file + ".original", path.join(dir, "hardlink"));
  assert.throws(() => openDocument(path.join(dir, "hardlink")), /one link/);
});
test("oversized and invalid UTF-8 files fail; oversized edits can still be discarded", t => {
  const { file } = fixture(t);
  const doc = openDocument(file);
  const huge = "x".repeat(MAX_BYTES + 1);
  assert.equal(doc.changed(huge), true);
  assert.throws(() => doc.save(huge), /exceeds/);
  assert.equal(fs.readFileSync(file, "utf8"), "original draft");
  fs.writeFileSync(file, huge);
  assert.throws(() => openDocument(file), /exceeds/);
  fs.writeFileSync(file, Buffer.from([0xff]));
  assert.throws(() => openDocument(file));
});
