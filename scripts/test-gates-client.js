// Tests for the runner side of the phone authority gate. Pure Node, no Electron.
//
//   node scripts/test-gates-client.js
//
// A fake relay implements the contract in memory (create, long-poll, decision,
// cancel, first answer wins) behind an injected fetch, so the whole race runs
// without a network: a local click that wins, a phone that wins first (409 with
// the winner in the body), a relay that is down, slow, or wrong, a timeout or a
// Stop that cancels, and an edit card whose relay window closes while the
// desktop card stays answerable. The rule under test throughout: nothing is
// ever approved except by an explicit answer, and a relay failure is the same
// as no relay.
"use strict";
const assert = require("assert");
const G = require("../gates-client");

let passed = 0, failed = 0;
const pending = [];
const test = (name, fn) => pending.push({ name, fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The relay. `down` makes every request reject, `slowCreate` delays POST /v1/gates,
   `status` overrides every response status (a wrong relay). */
function fakeRelay(opts = {}) {
  const gates = new Map();
  const waiters = new Map();
  const log = [];
  const relay = { gates, log, down: false, slowCreate: 0, forceStatus: 0, tokens: new Set(["good"]), requests: 0 };
  const settle = (g) => { (waiters.get(g.id) || []).forEach((w) => w()); waiters.delete(g.id); };
  relay.answer = (id, decision, via) => {           // the phone, or anything that is not this client
    const g = gates.get(id);
    if (!g || g.status !== "pending") return false;
    g.status = decision === "approve" ? "approved" : "denied"; g.decided_via = via; settle(g); return true;
  };
  relay.expire = (id) => { const g = gates.get(id); g.status = "expired"; settle(g); };
  const json = (status, body) => ({ status, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
  relay.fetch = async (url, init = {}) => {
    relay.requests++;
    if (relay.down) throw new TypeError("fetch failed");
    const u = new URL(url);
    const auth = (init.headers && init.headers.Authorization) || "";
    log.push(`${init.method} ${u.pathname}${u.search}`);
    if (!relay.tokens.has(auth.replace(/^Bearer /, ""))) return json(401, { error: "unauthorized" });
    if (relay.forceStatus) return json(relay.forceStatus, { error: "teapot" });
    const body = init.body ? JSON.parse(init.body) : {};
    let m;
    if (init.method === "POST" && u.pathname === "/v1/gates") {
      if (relay.slowCreate) await sleep(relay.slowCreate);
      const id = `g_${gates.size + 1}`;
      const g = { id, status: "pending", ...body, evidence_hash: `hash-${id}`, expires_at: Date.now() + (body.ttl_s || 300) * 1000 };
      gates.set(id, g);
      return json(201, g);
    }
    if ((m = u.pathname.match(/^\/v1\/gates\/([^/]+)$/)) && init.method === "GET") {
      const g = gates.get(m[1]);
      if (!g) return json(404, { error: "not_found" });
      const wait = Number(u.searchParams.get("wait") || 0);
      if (g.status === "pending" && wait > 0) {
        await new Promise((res, rej) => {
          const w = () => res();
          waiters.set(g.id, (waiters.get(g.id) || []).concat(w));
          const t = setTimeout(res, Math.min(wait * 1000, 200));            // a long poll that returns pending
          if (init.signal) init.signal.addEventListener("abort", () => { clearTimeout(t); rej(init.signal.reason || new Error("aborted")); }, { once: true });
        });
      }
      return json(200, g);
    }
    if ((m = u.pathname.match(/^\/v1\/gates\/([^/]+)\/decision$/)) && init.method === "POST") {
      const g = gates.get(m[1]);
      if (!g) return json(404, { error: "not_found" });
      if (g.status === "expired") return json(410, { error: "expired", gate: g });
      if (g.status !== "pending") return json(409, { error: "already_decided", gate: g });
      if (body.evidence_hash !== g.evidence_hash) return json(409, { error: "evidence_mismatch", gate: g });
      g.status = body.decision === "approve" ? "approved" : "denied"; g.decided_via = body.via; settle(g);
      return json(200, { gate: g });
    }
    if ((m = u.pathname.match(/^\/v1\/gates\/([^/]+)\/cancel$/)) && init.method === "POST") {
      const g = gates.get(m[1]);
      if (!g) return json(404, { error: "not_found" });
      if (g.status === "pending") { g.status = "cancelled"; g.cancel_reason = body.reason; settle(g); }
      return json(200, g);
    }
    return json(404, { error: "no_route" });
  };
  return relay;
}

const client = (relay, extra = {}) => G.createGatesClient({ baseUrl: "http://127.0.0.1:9", fetch: relay.fetch, getToken: () => "good", ...extra });
const FIELDS = { source: "desktop", machine: "Studio", kind: "run", title: "Run a command", detail: "ls", why: "runs a command", risk: "strict", evidence: { command: "ls" }, ttl_s: 300 };

// ---- URL, names, kinds
test("normalizeGatesUrl accepts https and loopback http only, and falls back to the relay", () => {
  assert.strictEqual(G.normalizeGatesUrl(""), "https://gates.crowelogic.com");
  assert.strictEqual(G.normalizeGatesUrl("https://gates.example.com/"), "https://gates.example.com");
  assert.strictEqual(G.normalizeGatesUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.strictEqual(G.normalizeGatesUrl("http://localhost:8787/x/"), "http://localhost:8787/x");
  assert.strictEqual(G.normalizeGatesUrl("http://evil.example.com"), G.DEFAULT_URL);
  assert.strictEqual(G.normalizeGatesUrl("file:///etc/passwd"), G.DEFAULT_URL);
  assert.strictEqual(G.normalizeGatesUrl("not a url"), G.DEFAULT_URL);
});
test("friendlyMachineName prefers the computer name and tidies a hostname", () => {
  assert.strictEqual(G.friendlyMachineName("Michaels-MacBook-Pro.local", "Michael's MacBook Pro"), "Michael's MacBook Pro");
  assert.strictEqual(G.friendlyMachineName("Michaels-MacBook-Pro.local", ""), "Michaels MacBook Pro");
  assert.strictEqual(G.friendlyMachineName("", ""), "This computer");
});
test("relayKind maps harness kinds onto the contract's kinds", () => {
  const want = { run_shell: "run", physical_write: "write", send_email: "mail", generate_image: "spend", share_preview: "share", open_url: "open", browser_open: "open", edit: "edit", nonsense: "other", "": "other" };
  for (const [k, v] of Object.entries(want)) assert.strictEqual(G.relayKind(k), v, k);
});

// ---- gate fields
test("fieldsForApproval carries the command and cwd for a run, the path for a write, and cuts over-long text", () => {
  const run = G.fieldsForApproval({ kind: "run_shell", title: "Run", detail: "rm -rf build", why: "deletes", risk: "strict" }, { machine: "Studio", cwd: "/work", mission: "Clean", runId: "r1" });
  assert.deepStrictEqual(run.evidence, { command: "rm -rf build", cwd: "/work" });
  assert.strictEqual(run.kind, "run"); assert.strictEqual(run.risk, "strict"); assert.strictEqual(run.mission, "Clean"); assert.strictEqual(run.run_id, "r1"); assert.strictEqual(run.ttl_s, 300);
  const write = G.fieldsForApproval({ kind: "physical_write", detail: "/tmp/a.txt\nmore" }, {});
  assert.deepStrictEqual(write.evidence, { path: "/tmp/a.txt" });
  assert.strictEqual(write.risk, "strict");
  const review = G.fieldsForApproval({ kind: "open_url", risk: "review", detail: "https://x" }, {});
  assert.strictEqual(review.risk, "review");
  const long = G.fieldsForApproval({ kind: "run_shell", detail: "x".repeat(9000), title: "t".repeat(900), why: "w".repeat(5000) }, { mission: "m".repeat(900) });
  assert.strictEqual(long.detail.length, 4000); assert.strictEqual(long.title.length, 200); assert.strictEqual(long.why.length, 1000); assert.strictEqual(long.mission.length, 300);
  assert.ok(!("mission" in G.fieldsForApproval({ kind: "run_shell" }, {})));
});
test("unifiedDiff keeps three lines of context, marks gaps with @@, and says so when it truncates", () => {
  const lines = Array.from({ length: 40 }, (_, i) => ({ t: " ", s: `l${i}` }));
  lines[5] = { t: "-", s: "old" }; lines.splice(6, 0, { t: "+", s: "new" });
  lines[30] = { t: "+", s: "added" };
  const out = G.unifiedDiff(lines).split("\n");
  assert.ok(out.includes("-old") && out.includes("+new") && out.includes("+added"));
  assert.ok(out.some((l) => l.startsWith("@@ ")), "a gap between hunks is marked");
  assert.ok(!out.includes(" l15"), "far-away context is dropped");
  assert.ok(out.includes(" l2") && out.includes(" l8") && !out.includes(" l9"), "three lines of context either side");
  const big = Array.from({ length: 5000 }, (_, i) => ({ t: "+", s: `line ${i} ${"x".repeat(40)}` }));
  const cut = G.unifiedDiff(big);
  assert.ok(Buffer.byteLength(cut) <= G.DIFF_CAP_BYTES, "capped at 48 KB");
  assert.ok(/diff truncated here/.test(cut.split("\n").pop()), "the last line says it was truncated");
  assert.strictEqual(G.unifiedDiff([]), "");
});
test("fieldsForEdit is an edit gate with the path, the diff, and the +/- counts", () => {
  const f = G.fieldsForEdit("src/a.js", [{ t: " ", s: "a" }, { t: "-", s: "b" }, { t: "+", s: "c" }, { t: "+", s: "d" }], { machine: "Studio", mission: "Fix", ttlS: 900 });
  assert.strictEqual(f.kind, "edit"); assert.strictEqual(f.risk, "review"); assert.strictEqual(f.title, "Edit src/a.js");
  assert.strictEqual(f.detail, "src/a.js  (+2 -1)"); assert.strictEqual(f.evidence.path, "src/a.js");
  assert.ok(f.evidence.diff.includes("+c") && f.evidence.diff.includes("-b")); assert.strictEqual(f.ttl_s, 900); assert.strictEqual(f.mission, "Fix");
});

// ---- raw client
test("createGate / waitGate / decide / cancel speak the contract with a Bearer token", async () => {
  const relay = fakeRelay(); const c = client(relay);
  const g = await c.createGate(FIELDS);
  assert.ok(g && g.id && g.evidence_hash);
  assert.strictEqual((await c.waitGate(g.id, 1)).status, "pending");
  const d = await c.decide(g.id, { decision: "approve", evidence_hash: g.evidence_hash });
  assert.ok(d.ok && d.gate.status === "approved" && d.gate.decided_via === "desktop");
  const again = await c.decide(g.id, { decision: "deny", evidence_hash: g.evidence_hash });
  assert.strictEqual(again.status, 409); assert.strictEqual(again.error, "already_decided"); assert.strictEqual(again.gate.status, "approved");
  const g2 = await c.createGate(FIELDS);
  assert.strictEqual((await c.cancel(g2.id, "timeout")).status, "cancelled");
  assert.ok(relay.log.includes("GET /v1/gates/g_1?wait=1"));
  const gone = await c.decide("g_99", { decision: "approve", evidence_hash: "x" });
  assert.strictEqual(gone.status, 404);
});
test("a missing token, a down relay, and a wrong relay all read as 'no relay' and never throw", async () => {
  const relay = fakeRelay();
  assert.strictEqual(await client(relay, { getToken: () => "" }).createGate(FIELDS), null);
  assert.strictEqual(relay.requests, 0, "no token, no request");
  relay.down = true; const c = client(relay);
  assert.strictEqual(await c.createGate(FIELDS), null);
  assert.strictEqual(await c.waitGate("g_1"), null);
  assert.strictEqual(await c.decide("g_1", { decision: "approve" }), null);
  assert.strictEqual(await c.cancel("g_1"), null);
  relay.down = false; relay.forceStatus = 500;
  assert.strictEqual(await c.createGate(FIELDS), null);
  assert.strictEqual(await G.createGatesClient({ baseUrl: "https://x", fetch: null, getToken: () => "t" }).createGate(FIELDS), null);
});
test("a 401 refreshes the token once and retries; a refresh that fails stays a failure", async () => {
  const relay = fakeRelay(); relay.tokens = new Set(["fresh"]);
  let refreshed = 0;
  const c = client(relay, { getToken: () => "stale", refreshToken: async () => { refreshed++; return "fresh"; } });
  assert.ok(await c.createGate(FIELDS)); assert.strictEqual(refreshed, 1);
  const c2 = client(relay, { getToken: () => "stale", refreshToken: async () => null });
  assert.strictEqual(await c2.createGate(FIELDS), null);
  const c3 = client(relay, { getToken: () => "stale", refreshToken: async () => { throw new Error("offline"); } });
  assert.strictEqual(await c3.createGate(FIELDS), null);
});

// ---- the race
test("race: a local approve is posted as via desktop with the relay's evidence hash, and the relay's verdict is obeyed", async () => {
  const relay = fakeRelay(); const s = client(relay).session(FIELDS, { waitS: 1 });
  assert.strictEqual(await s.ready, true);
  const out = await s.localDecision(true);
  assert.deepStrictEqual([out.approved, out.via, out.relayed], [true, "desktop", true]);
  const g = relay.gates.get("g_1");
  assert.strictEqual(g.status, "approved"); assert.strictEqual(g.decided_via, "desktop");
  assert.strictEqual(s.active, false, "the poll loop is closed");
});
test("race: a local deny is a deny", async () => {
  const relay = fakeRelay(); const s = client(relay).session(FIELDS, { waitS: 1 });
  await s.ready; const out = await s.localDecision(false);
  assert.strictEqual(out.approved, false); assert.strictEqual(relay.gates.get("g_1").status, "denied");
});
test("race: the phone answers first, onRemote fires once with the verdict and via", async () => {
  const relay = fakeRelay(); const seen = [];
  const s = client(relay).session(FIELDS, { waitS: 1, onRemote: (o) => seen.push(o) });
  await s.ready; relay.answer("g_1", "approve", "phone");
  for (let i = 0; i < 40 && !seen.length; i++) await sleep(25);
  assert.strictEqual(seen.length, 1); assert.deepStrictEqual([seen[0].approved, seen[0].via, seen[0].relayed], [true, "phone", true]);
  assert.strictEqual(s.active, false);
});
test("race: a phone deny is a deny, never an approval", async () => {
  const relay = fakeRelay(); const seen = [];
  const s = client(relay).session(FIELDS, { waitS: 1, onRemote: (o) => seen.push(o) });
  await s.ready; relay.answer("g_1", "deny", "phone");
  for (let i = 0; i < 40 && !seen.length; i++) await sleep(25);
  assert.deepStrictEqual([seen[0].approved, seen[0].via], [false, "phone"]);
});
test("race: the phone wins between the poll and the click, so the click gets 409 and obeys the phone", async () => {
  const relay = fakeRelay(); const seen = [];
  const s = client(relay).session(FIELDS, { retryMs: 5000, waitS: 1, onRemote: (o) => seen.push(o) });
  await s.ready;
  relay.answer("g_1", "deny", "phone");
  const out = await s.localDecision(true);          // person clicked Approve on the desktop a moment too late
  assert.strictEqual(out.approved, false, "the desktop obeys the phone's deny");
  assert.strictEqual(out.via, "phone"); assert.strictEqual(out.relayed, true);
});
test("race: the click on a gate the relay already expired reads as expired, which is a denial", async () => {
  const relay = fakeRelay();
  const s = client(relay).session(FIELDS, { retryMs: 5000, waitS: 1 });
  await s.ready; relay.expire("g_1");
  const out = await s.localDecision(true);
  assert.strictEqual(out.approved, false); assert.strictEqual(out.expired, true);
});
test("race: expiryStaysLocal keeps an edit card answerable after the relay window closes", async () => {
  const relay = fakeRelay(); const remote = [], expired = [];
  const s = client(relay).session(FIELDS, { waitS: 1, expiryStaysLocal: true, onRemote: (o) => remote.push(o), onRelayExpired: (g) => expired.push(g) });
  await s.ready; relay.expire("g_1");
  for (let i = 0; i < 40 && !expired.length; i++) await sleep(25);
  assert.strictEqual(remote.length, 0, "an expiry is not an answer");
  assert.strictEqual(expired.length, 1);
  const s2 = client(relay).session(FIELDS, { retryMs: 5000, waitS: 1, expiryStaysLocal: true });
  await s2.ready; relay.expire("g_2");
  const out = await s2.localDecision(true);
  assert.deepStrictEqual([out.approved, out.relayed], [true, false], "the person's own click on the desktop still stands");
});
test("race: with the relay down the click is local and nothing else changes", async () => {
  const relay = fakeRelay(); relay.down = true;
  const s = client(relay).session(FIELDS, { waitS: 1 });
  assert.strictEqual(await s.ready, false); assert.strictEqual(s.active, false);
  const yes = await s.localDecision(true); const no = await s.localDecision(false);
  assert.deepStrictEqual([yes.approved, yes.relayed, yes.via], [true, false, "desktop"]);
  assert.deepStrictEqual([no.approved, no.relayed], [false, false]);
});
test("race: a relay that answers 500 to create is the same as down", async () => {
  const relay = fakeRelay(); relay.forceStatus = 500;
  const s = client(relay).session(FIELDS, { waitS: 1 });
  assert.strictEqual(await s.ready, false);
  assert.strictEqual((await s.localDecision(true)).relayed, false);
});
test("race: a decision the relay refuses falls back to the local click and cancels the gate", async () => {
  const relay = fakeRelay(); const s = client(relay).session(FIELDS, { retryMs: 5000, waitS: 1 });
  await s.ready; relay.gates.get("g_1").evidence_hash = "changed underneath";
  const out = await s.localDecision(true);
  assert.deepStrictEqual([out.approved, out.relayed], [true, false]);
  assert.strictEqual(relay.gates.get("g_1").status, "cancelled");
});
test("race: a slow create never makes a click wait, and the gate is cancelled when it finally lands", async () => {
  const relay = fakeRelay(); relay.slowCreate = 1800;
  const s = client(relay).session(FIELDS, { waitS: 1 });
  const t0 = Date.now(); const out = await s.localDecision(true);
  assert.ok(Date.now() - t0 < 1800, "the click did not wait for the relay");
  assert.deepStrictEqual([out.approved, out.relayed], [true, false]);
  await s.ready; await sleep(50);
  assert.strictEqual(relay.gates.get("g_1").status, "cancelled", "a gate nobody can answer is withdrawn");
});
test("timeout or Stop cancels the gate with a reason, and a second cancel is a no-op", async () => {
  const relay = fakeRelay(); const remote = [];
  const s = client(relay).session(FIELDS, { waitS: 1, onRemote: (o) => remote.push(o) });
  await s.ready;
  const r = await s.cancel("timeout");
  assert.strictEqual(r.status, "cancelled"); assert.strictEqual(relay.gates.get("g_1").cancel_reason, "timeout");
  assert.strictEqual(await s.cancel("again"), null);
  await sleep(50); assert.strictEqual(remote.length, 0, "our own cancel is not a remote answer");
});
test("cancel before the gate exists withdraws it the moment it is created", async () => {
  const relay = fakeRelay(); relay.slowCreate = 60;
  const s = client(relay).session(FIELDS, { waitS: 1 });
  assert.strictEqual(await s.cancel("stop"), null);
  await s.ready; await sleep(50);
  assert.strictEqual(relay.gates.get("g_1").status, "cancelled");
});
test("a gate that disappears from the relay (404 twice) or a signed-out token stops the loop without an answer", async () => {
  const relay = fakeRelay(); const remote = [];
  const s = client(relay).session(FIELDS, { retryMs: 5, waitS: 1, onRemote: (o) => remote.push(o) });
  await s.ready; relay.gates.delete("g_1");
  for (let i = 0; i < 40 && s.active; i++) await sleep(25);
  assert.strictEqual(s.active, false); assert.strictEqual(remote.length, 0);
  const relay2 = fakeRelay(); const remote2 = [];
  const s2 = client(relay2).session(FIELDS, { retryMs: 5, waitS: 1, onRemote: (o) => remote2.push(o) });
  await s2.ready; relay2.tokens.clear();
  for (let i = 0; i < 40 && s2.active; i++) await sleep(25);
  assert.strictEqual(s2.active, false); assert.strictEqual(remote2.length, 0, "never an approval from a failed poll");
});
test("a transient poll failure is retried and a later phone answer still arrives", async () => {
  const relay = fakeRelay(); const seen = [];
  const s = client(relay).session(FIELDS, { retryMs: 10, waitS: 1, onRemote: (o) => seen.push(o) });
  await s.ready; relay.down = true; await sleep(60); relay.down = false;
  relay.answer("g_1", "approve", "phone");
  for (let i = 0; i < 60 && !seen.length; i++) await sleep(25);
  assert.strictEqual(seen.length, 1); assert.strictEqual(seen[0].approved, true);
});

(async () => {
  for (const { name, fn } of pending) {
    try { await fn(); passed++; console.log(`ok      ${name}`); }
    catch (e) { failed++; console.log(`not ok  ${name}\n        ${String(e && e.stack || e).split("\n").slice(0, 4).join("\n        ")}`); }
  }
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
