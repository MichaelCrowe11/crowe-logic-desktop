// The receipt stream and the artifact store, the CLI's half.
//
// Same two properties main.js holds the desktop journal to, and for the same
// reason: it is never read back as state, so a missing or corrupt journal
// degrades to no journal rather than to a wrong decision; and every line
// carries the digest of the line before it, so a file edited or truncated in
// the middle stops verifying at that point.
//
// This matters more for the CLI than for the desktop. A run in CI has no window
// to watch, so the journal is the only account of what the agent was allowed to
// do, and it is the record a hosted control plane will eventually collect.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function makeJournal(home) {
  const dir = path.join(home, "journal");
  let prev = null;
  let day = "";
  return function write(event) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const file = path.join(dir, `${today}.jsonl`);
      if (today !== day) {
        day = today;
        prev = null;
        try {                                   // resume the chain across runs
          const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
          const last = JSON.parse(lines[lines.length - 1]);
          prev = last && last.hash ? last.hash : null;
        } catch { /* first line of the day */ }
      }
      const body = { event_id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...event, prev };
      const hash = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32);
      prev = hash;
      fs.appendFileSync(file, JSON.stringify({ ...body, hash }) + "\n", { mode: 0o600 });
    } catch { /* a receipt that cannot be written must not break the turn */ }
  };
}

// Spooled tool output, content-addressed by the harness. Pruned by age on the
// way in rather than on every write, so a long turn never pays for housekeeping
// in the middle of a tool loop.
function makeArtifactDir(home, maxAgeMs = 7 * 24 * 3600 * 1000) {
  const dir = path.join(home, "artifacts");
  let pruned = false;
  return function artifactDir() {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    if (!pruned) {
      pruned = true;
      try {
        const now = Date.now();
        for (const f of fs.readdirSync(dir)) {
          const p = path.join(dir, f);
          try { if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p); } catch {}
        }
      } catch {}
    }
    return dir;
  };
}

module.exports = { makeJournal, makeArtifactDir };
