// No shell, MCP, network actions, deletes or implicit file scope in this executor.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const H = require("../harness");
const C = require("./council");
function makeFileExecutor(root, allowed) {
  const workspace = fs.realpathSync(root);
  function target(rel) {
    if (!allowed.includes(rel) || path.isAbsolute(rel) || rel.split(/[\\/]/).some(p => !p || p === "." || p === ".." || p.startsWith("."))) throw new Error("Path is not an explicitly allowed workspace file.");
    if (H.isSecretPath(rel) || H.RISK_PATH_RE.test(rel) || H.SENSITIVE_PATH_RE.test(rel)) throw new Error("Sensitive or execution-policy files require manual review.");
    const full = path.join(workspace, rel);
    const st = fs.lstatSync(full);
    const real = fs.realpathSync(full);
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1 || real !== full || !real.startsWith(workspace + path.sep) || st.size > 60000) throw new Error("Only ordinary existing workspace text files up to 60 KB are allowed; no links.");
    return { full, st };
  }
  function snapshot() {
    const result = Object.create(null);
    for (const rel of allowed) {
      const { full } = target(rel);
      const bytes = fs.readFileSync(full);
      const text = bytes.toString("utf8");
      if (text.includes("\0") || !Buffer.from(text).equals(bytes)) throw new Error("Council edits require UTF-8 text.");
      if (H.scanForSecrets(text).length) throw new Error("Selected file contains credential-like material; it will not be sent to models.");
      result[rel] = text;
    }
    return result;
  }
  function classify(proposal) {
    for (const c of proposal.changes) {
      target(c.path);
      if (Buffer.byteLength(c.content) > 60000 || H.scanForSecrets(c.content).length) throw new Error("Replacement is too large or contains credential-like material.");
    }
  }
  function execute(proposal, before, grant, stillAuthorized) {
    if (!stillAuthorized()) throw new Error("Authority was revoked or expired before execution.");
    classify(proposal);
    if (C.canonical(snapshot()) !== C.canonical(before)) throw new Error("Workspace changed after voting.");
    const paths = proposal.changes.map(c => ({ ...target(c.path), ...c }));
    const done = [];
    try {
      for (const c of paths) {
        if (!stillAuthorized()) throw new Error("Authority expired before the next write.");
        // O_NOFOLLOW and inode checks close the final-component link race.
        const fd = fs.openSync(c.full, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
        try {
          const st = fs.fstatSync(fd);
          if (st.ino !== c.st.ino || st.dev !== c.st.dev || st.nlink !== 1 || fs.realpathSync(c.full) !== c.full) throw new Error("File identity changed after review.");
          done.push(c);
          fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, c.content); fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
      }
    } catch (e) {
      // Preserve the pre-write snapshot in the council record. Do not silently
      // overwrite concurrent external edits in an attempted rollback.
      throw new Error(`${e.message} ${done.length} file(s) may have changed; use the saved recovery snapshot.`);
    }
    const after = snapshot();
    if (paths.some(c => after[c.path] !== c.content)) throw new Error("Read-back did not match approved content. Inspect recovery snapshots.");
    return { summary: `${paths.length} scoped file(s) written and read back. Runtime tests were not run.`, files: paths.map(c => ({ path: c.path, sha256: crypto.createHash("sha256").update(c.content).digest("hex") })), at: Date.now() };
  }
  return { snapshot, classify, execute, workspace };
}
module.exports = { makeFileExecutor };
