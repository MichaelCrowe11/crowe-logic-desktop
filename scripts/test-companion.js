#!/usr/bin/env node
// The companion, exercised as a running server rather than as source.
//
//   node scripts/test-companion.js
//
// This is a remote shell. The properties below are the ones that keep it from
// being a liability, and each is checked against a live instance on loopback —
// bound there rather than the tailnet so the suite does not depend on the
// machine running it being on one, and on port 0 so it never collides with a
// companion the user has actually started.
//
// What is deliberately NOT here: the phone half. scripts/test-mobile-shell.js
// drives the built bridge in a page, and the pieces that only exist on a device
// — iOS's native HTTP stack, App Transport Security — cannot be tested off one
// at all. That gap is real and is why the pairing failed twice on hardware
// while everything here was green.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Companion } = require("../companion");

let failures = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${String(e.message || e).split("\n").join("\n       ")}`);
  }
}
function assert(cond, message) { if (!cond) throw new Error(message); }

(async () => {
  console.log("companion");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-companion-"));
  const c = new Companion({ tokenFile: path.join(dir, "companion.token"), loopback: true, port: 0 });
  const started = await c.start();
  assert(!started.error, `could not start: ${started.error}`);
  const base = `http://127.0.0.1:${started.port}`;

  const post = async (route, body, token) => {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(base + route, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const phone = c.addDevice("iPhone");
  const ipad = c.addDevice("iPad");

  await check("health answers without a token and says nothing else", async () => {
    const r = await fetch(`${base}/health`);
    const body = await r.json();
    assert(r.status === 200, `health returned ${r.status}`);
    // A caller who cannot present a token should learn that something is here
    // and no more: no hostname, no version, no device list.
    assert(!JSON.stringify(body).match(/token|device|user|home/i), `health leaks detail: ${JSON.stringify(body)}`);
    return JSON.stringify(body);
  });

  await check("no token is 401, and a wrong one is too", async () => {
    assert((await post("/run", { command: "echo x" })).status === 401, "ran with no token");
    assert((await post("/run", { command: "echo x" }, "not-a-real-token")).status === 401, "ran with a bad token");
    return "both refused";
  });

  await check("a paired device runs a command and gets both streams", async () => {
    const r = await post("/run", { command: "printf out; printf err >&2; exit 3" }, phone.token);
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.stdout === "out", `stdout was ${JSON.stringify(r.body.stdout)}`);
    assert(r.body.stderr === "err", `stderr was ${JSON.stringify(r.body.stderr)}`);
    // The exit code is the part a model reads to know it failed. Swallowing it
    // makes a failed command look like a successful one with no output.
    assert(r.body.exit_code === 3, `exit code was ${r.body.exit_code}`);
    return "stdout, stderr, exit 3";
  });

  await check("stdin is at EOF, so a program that reads it does not hang", async () => {
    const began = Date.now();
    const r = await post("/run", { command: "cat", timeout: 20 }, phone.token);
    const took = Date.now() - began;
    assert(r.status === 200 && r.body.exit_code === 0, `cat exited ${r.body && r.body.exit_code}`);
    // `cat` with an open stdin pipe waits for the timeout. This is the fix that
    // took a bare `claude` from a 120-second freeze to under a second.
    assert(took < 5000, `cat took ${took}ms — stdin is not closed`);
    return `${took}ms`;
  });

  await check("a pipe inside the command still works", async () => {
    const r = await post("/run", { command: "printf 'b\\na\\n' | sort | tr -d '\\n'" }, phone.token);
    assert(r.body.stdout === "ab", `got ${JSON.stringify(r.body.stdout)}`);
    return "ab";
  });

  await check("revoking one device leaves the others alone", async () => {
    const gone = c.revokeDevice(phone.id);
    assert(gone.ok, `revoke failed: ${gone.error}`);
    assert((await post("/run", { command: "echo x" }, phone.token)).status === 401, "a revoked device still ran a command");
    assert((await post("/run", { command: "echo x" }, ipad.token)).status === 200, "revoking one device broke another");
    return "iPhone refused, iPad unaffected";
  });

  await check("the log says which device did what, and records refusals", async () => {
    const log = c.recentAudit(20);
    const ran = log.filter((e) => e.kind === "run");
    assert(ran.length >= 3, `only ${ran.length} runs logged`);
    assert(ran.every((e) => e.device), "a run was logged with no device name");
    assert(log.some((e) => e.kind === "denied"), "a rejected token left no trace");
    assert(log.every((e) => !JSON.stringify(e).includes(ipad.token)), "the audit log contains a live token");
    return `${log.length} entries`;
  });

  await check("files are read and written where asked", async () => {
    const target = path.join(dir, "note.txt");
    const w = await post("/write_file", { path: target, content: "hello" }, ipad.token);
    assert(w.body.bytes_written === 5, `wrote ${w.body.bytes_written} bytes`);
    const r = await post("/read_file", { path: target }, ipad.token);
    assert(r.body.content === "hello", `read back ${JSON.stringify(r.body.content)}`);
    const missing = await post("/read_file", { path: path.join(dir, "nope.txt") }, ipad.token);
    assert(missing.status === 404, `a missing file returned ${missing.status}`);
    return "write, read, 404";
  });

  await check("devices survive a restart, and their tokens keep working", async () => {
    // Counted rather than hardcoded: start() mints a first device so there is
    // something for the pairing code to carry, so the total is not just the
    // ones added here. An expectation of "1" was wrong about the code, not the
    // other way round.
    const before = c.deviceList().length;
    await c.stop();
    const again = new Companion({ tokenFile: path.join(dir, "companion.token"), loopback: true, port: 0 });
    const s = await again.start();
    const r = await fetch(`http://127.0.0.1:${s.port}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ipad.token}` },
      body: JSON.stringify({ command: "echo still-here" }),
    });
    assert(r.status === 200, `a device paired before the restart got ${r.status}`);
    // Quitting the app must not silently unpair a phone in someone's pocket.
    assert(again.deviceList().length === before,
      `${before} devices before the restart, ${again.deviceList().length} after`);
    await again.stop();
    return `${before} devices, still authorised`;
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) failed` : "\nall companion checks passed");
  process.exit(failures ? 1 : 0);
})();
