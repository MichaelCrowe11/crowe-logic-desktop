// The panel beside the chat did not show the agent's work; the Output pane
// logged it a line at a time. These pin the pure half of the Activity view:
// events become cards, and each card names the pane that should come forward.
const assert = require("assert");
const A = require("../renderer/activity");

let s = A.newActivity();
let r = A.reduceActivity(s, { type: "tool_call", name: "run_shell", args: { command: "pytest tests/test_cache.py" }, id: "c1" }, 1000);
assert.strictEqual(r.card.status, "running");
assert.strictEqual(r.card.verb, "ran");
assert.strictEqual(r.card.detail, "pytest tests/test_cache.py");
assert.deepStrictEqual(r.target, { pane: "activity" }, "a shell command is watched on the activity pane, not the user's terminal");

r = A.reduceActivity(s, { type: "tool_result", name: "run_shell", id: "c1", result: "1 passed in 0.02s" }, 1500);
assert.strictEqual(r.card.status, "done");
assert.strictEqual(r.card.output, "1 passed in 0.02s");
assert.strictEqual(r.card.endedAt, 1500);
assert.strictEqual(r.target, null, "a finished command does not switch panes again");

r = A.reduceActivity(s, { type: "tool_call", name: "edit_file", args: { path: "cache.py" } }, 2000);
assert.deepStrictEqual(r.target, { pane: "git", path: "cache.py" }, "an edit brings the Changes pane forward");
r = A.reduceActivity(s, { type: "tool_result", name: "edit_file", result: "ok: 2 lines changed" }, 2100);
assert.deepStrictEqual(r.target, { pane: "git", path: "cache.py" }, "the landed edit asks for its diff");

r = A.reduceActivity(s, { type: "tool_call", name: "open_url", args: { url: "https://example.com/docs" } }, 3000);
assert.deepStrictEqual(r.target, { pane: "browser", url: "https://example.com/docs" });
r = A.reduceActivity(s, { type: "tool_result", name: "open_url", result: "error: 404" }, 3100);
assert.strictEqual(r.card.status, "error", "an error result marks the card");

r = A.reduceActivity(s, { type: "tool_call", name: "read_file", args: { path: "README.md" } }, 4000);
assert.deepStrictEqual(r.target, { pane: "files", path: "README.md" });
r = A.reduceActivity(s, { type: "tool_call", name: "search", args: { query: "expires_at" } }, 4100);
assert.strictEqual(r.card.detail, "expires_at");
assert.strictEqual(r.target.pane, "files");

r = A.reduceActivity(s, { type: "edit_proposal", id: "p1", path: "cache.py", diff: "-a\n+b" }, 5000);
assert.strictEqual(r.card.status, "waiting");
assert.strictEqual(r.card.output, "-a\n+b");
assert.deepStrictEqual(r.target, { pane: "git", path: "cache.py" });

r = A.reduceActivity(s, { type: "approval_request", id: "ap1", kind: "run_shell", title: "rm -rf build" }, 6000);
assert.strictEqual(r.card.status, "waiting");
assert.deepStrictEqual(r.target, { pane: "activity" }, "a pending approval is shown where the user can see it");
assert.strictEqual(A.summary(s), "2 waiting for you");
r = A.reduceActivity(s, { type: "approval_expired", id: "ap1" }, 6500);
assert.strictEqual(r.card.status, "expired");

for (const t of ["assistant_delta", "assistant", "route", "telemetry"]) {
  r = A.reduceActivity(s, { type: t, text: "hello", expert: "x", model: "y" }, 7000);
  assert.strictEqual(r.card, null, `${t} is not a card`);
  assert.strictEqual(r.target, null, `${t} does not move panes`);
}
assert.strictEqual(A.reduceActivity(s, null).card, null);

assert.strictEqual(A.nextPane({ pane: "git" }, true), "git");
assert.strictEqual(A.nextPane({ pane: "git" }, false), null, "follow off keeps the user's pane");
assert.strictEqual(A.nextPane(null, true), null);

const big = A.newActivity();
for (let i = 0; i < 260; i++) A.reduceActivity(big, { type: "tool_call", name: "read_file", args: { path: `f${i}` } }, i);
assert.strictEqual(big.cards.length, 200, "the list is capped");
const long = A.newActivity();
A.reduceActivity(long, { type: "tool_call", name: "run_shell", args: { command: "x" } }, 1);
const res = A.reduceActivity(long, { type: "tool_result", name: "run_shell", result: "a".repeat(10000) }, 2);
assert.strictEqual(res.card.output.length, 4000, "output keeps the tail");

assert.deepStrictEqual(A.describeCall("unknown_tool", {}), { verb: "called", detail: "unknown_tool" });
console.log("ok      activity: events become cards, each naming the pane to bring forward");
