// Asking a human something when there is a terminal, and knowing when there is not.
//
// The harness has one rule about approvals that this file exists to honour: an
// unanswered prompt is a denial. In a terminal that means a question with a
// default of no. Outside one (CI, a pipe, a cron job) it means we do not pretend
// to ask at all, we deny immediately and say why, because a build that hangs for
// five minutes waiting for a keystroke nobody is there to press is worse than a
// build that stops and explains.
//
// --yes flips the policy to auto, and that is the only thing it flips. It does
// not widen the autonomy tier and it does not skip a gate. Every check in the
// harness still runs; this only answers the question at the end of them.

const readline = require("readline");

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

function askYesNo(question, { input = process.stdin, output = process.stderr, timeoutMs = APPROVAL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { rl.close(); } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => { output.write("\n  no answer within the window, treating as denied\n"); done({ approved: false, expired: true }); }, timeoutMs);
    if (timer.unref) timer.unref();
    rl.question(`${question} [y/N] `, (answer) => done({ approved: /^y(es)?$/i.test(String(answer).trim()) }));
    rl.on("close", () => done({ approved: false }));
  });
}

// Enough of a diff to decide with. Not a patch format, and not trying to be one:
// the question at a review prompt is "is this the change you meant", and for
// that a changed-line summary beats a full unified hunk in a narrow terminal.
function lineDiff(before, after, maxLines = 60) {
  const a = String(before || "").split("\n");
  const b = String(after || "").split("\n");
  const out = [];
  let i = 0, j = 0;
  while ((i < a.length || j < b.length) && out.length < maxLines) {
    if (a[i] === b[j]) { i++; j++; continue; }
    const nextMatch = b.indexOf(a[i], j);
    if (i < a.length && nextMatch === -1) { out.push(`- ${a[i]}`); i++; continue; }
    if (j < b.length && nextMatch > j) { out.push(`+ ${b[j]}`); j++; continue; }
    if (j < b.length) { out.push(`+ ${b[j]}`); j++; }
    if (i < a.length) { out.push(`- ${a[i]}`); i++; }
  }
  if (i < a.length || j < b.length) out.push(`  ... ${(a.length - i) + (b.length - j)} more changed line(s)`);
  return out.join("\n");
}

module.exports = { askYesNo, lineDiff, APPROVAL_TIMEOUT_MS };
