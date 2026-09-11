// The usage outbox: at-least-once delivery over a network that is allowed to fail.
//
// Metering has an awkward property. The turn is already over by the time we
// know what it cost, so there is nothing left to fail: refusing the answer
// because the usage POST timed out would punish the customer for our network,
// and dropping the event silently is revenue that never existed. The only
// honest answer is to persist the event first and deliver it whenever the plane
// comes back.
//
// That makes delivery at-least-once, which would be a double-billing bug on its
// own. It is safe only because every event carries a derived id (see
// contract.js): the plane stores the second copy on top of the first. The
// outbox and the derived key are two halves of one mechanism and neither is
// correct without the other.

const fs = require("fs");
const path = require("path");

// A bound, because an outbox that grows without one turns a week of downtime
// into a full disk. Oldest goes first: recent usage is the usage most likely to
// still matter, and anything this far behind has been superseded by a
// reconciliation run anyway.
const MAX_PENDING = 5000;

function makeOutbox({ dir, file = "usage-outbox.jsonl" } = {}) {
  const outFile = path.join(dir, file);

  function readAll() {
    try {
      return fs.readFileSync(outFile, "utf8").split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  function writeAll(rows) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (!rows.length) { try { fs.unlinkSync(outFile); } catch {} return; }
      const keep = rows.slice(-MAX_PENDING);
      // Written beside and renamed over, so an interrupted flush leaves the
      // previous queue intact rather than half a file.
      const tmp = `${outFile}.tmp`;
      fs.writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
      fs.renameSync(tmp, outFile);
    } catch { /* an outbox that cannot be written must not break the turn */ }
  }

  function enqueue(rows) {
    if (!rows || !rows.length) return 0;
    const existing = readAll();
    const have = new Set(existing.map((r) => r.usage_id));
    const fresh = rows.filter((r) => !have.has(r.usage_id));
    if (fresh.length) writeAll(existing.concat(fresh));
    return fresh.length;
  }

  /* Delivery. `deliver` is given the whole pending batch and answers with the
     ids it durably accepted; anything it does not name stays queued. Phrasing
     it as "what did you accept" rather than "did it work" is deliberate: a
     partial success is the common case on a flaky link, and a boolean would
     force us to choose between re-sending everything or dropping the tail. */
  async function flush(deliver) {
    const pending = readAll();
    if (!pending.length) return { delivered: 0, pending: 0 };
    let accepted = [];
    try {
      accepted = (await deliver(pending)) || [];
    } catch { return { delivered: 0, pending: pending.length, error: true }; }
    const done = new Set(accepted);
    const left = pending.filter((r) => !done.has(r.usage_id));
    writeAll(left);
    return { delivered: pending.length - left.length, pending: left.length };
  }

  return { enqueue, flush, pending: () => readAll().length, file: outFile, MAX_PENDING };
}

module.exports = { makeOutbox, MAX_PENDING };
