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

  await check("a shell that cannot start reports failure, not success", async () => {
    const saved = process.env.SHELL;
    process.env.SHELL = path.join(dir, "no-such-shell");
    try {
      const r = await post("/run", { command: "echo x" }, phone.token);
      assert(r.status === 200, `status ${r.status}`);
      // ENOENT used to fall through the numeric-code check to exit 0 with no
      // output — the one shape a model reads as "worked, nothing to say".
      assert(r.body.exit_code === 127, `spawn failure exited ${r.body.exit_code}`);
      assert(/could not start/.test(r.body.stderr), `stderr says: ${JSON.stringify(r.body.stderr)}`);
    } finally {
      if (saved === undefined) delete process.env.SHELL; else process.env.SHELL = saved;
    }
    return "exit 127, stderr names the shell";
  });

  await check("output past the cap does not masquerade as a spawn failure", async () => {
    // ERR_CHILD_PROCESS_STDIO_MAXBUFFER is also a string err.code on a command
    // that plainly ran. The first version of the spawn-failure fix read any
    // string code as "shell could not start" and turned a long build log into
    // exit 127 with a false diagnosis.
    const r = await post("/run", { command: "head -c 300000 /dev/zero | tr '\\0' a" }, phone.token);
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.exit_code !== 127, `maxBuffer overflow reported exit ${r.body.exit_code}`);
    assert((r.body.stdout || "").length > 100000, `the output that did arrive was discarded (${(r.body.stdout || "").length} bytes)`);
    assert(!/could not start/.test(r.body.stderr || ""), `stderr claims a spawn failure: ${r.body.stderr}`);
    return `exit ${r.body.exit_code}, ${r.body.stdout.length} bytes kept`;
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

  await check("the phone's file tools never hand over a credential, at any tier", async () => {
    const home = os.homedir();
    const key = await post("/read_file", { path: "~/.ssh/id_ed25519" }, ipad.token);
    assert(key.status === 403, `reading an ssh key got ${key.status}`);
    const aws = await post("/read_file", { path: path.join(home, ".aws", "credentials") }, ipad.token);
    assert(aws.status === 403, `reading aws credentials got ${aws.status}`);
    // A symlink the agent made in an innocent folder must not be a way round.
    const link = path.join(dir, "innocent");
    fs.symlinkSync(path.join(home, ".ssh"), link);
    const via = await post("/read_file", { path: path.join(link, "id_ed25519") }, ipad.token);
    assert(via.status === 403, `reading through a symlink to ~/.ssh got ${via.status}`);
    const own = await post("/read_file", { path: c.devicesPath() }, ipad.token);
    assert(own.status === 403, `reading the companion's device tokens got ${own.status}`);
    assert(!JSON.stringify(own.body).includes(ipad.token), "a refusal echoed a live token");
    const plant = await post("/write_file", { path: "~/.ssh/crowe-test-should-not-exist", content: "x" }, ipad.token);
    assert(plant.status === 403, `writing into ~/.ssh got ${plant.status}`);
    assert(!fs.existsSync(path.join(home, ".ssh", "crowe-test-should-not-exist")), "the refused write landed in ~/.ssh");
    const rel = await post("/read_file", { path: "notes.txt" }, ipad.token);
    assert(rel.status === 400, `a relative path got ${rel.status}`);
    assert(c.recentAudit(10).some((e) => e.kind === "denied" && e.reason === "path guard"), "the refusals left no trace in the log");
    return "keys, cloud creds, symlink, own tokens refused and logged";
  });

  await check("the guard cannot be talked round by case, a dangling link or the app's own folder", async () => {
    const { resolveForPhone } = require("../companion.js");
    const status = (p, opts) => { try { resolveForPhone(p, opts); return 200; } catch (e) { return e.status; } };
    // macOS volumes ignore case; so must the guard.
    if (process.platform === "darwin") {
      assert(status("~/.SSH/id_ed25519") === 403, "~/.SSH slipped past the guard");
      assert(status("~/library/keychains/login.keychain-db") === 403, "a lowercased Keychains path slipped past");
    }
    // A link to a file that does not exist yet still lands the write there.
    const dangling = path.join(dir, "later");
    fs.symlinkSync(path.join(os.homedir(), ".ssh", "crowe-test-not-there"), dangling);
    assert(status(dangling) === 403, "a dangling link into ~/.ssh was allowed");
    const app = path.join(dir, "userData");
    fs.mkdirSync(app);
    assert(status(path.join(app, "config.json"), { ownFiles: [app] }) === 403, "the app's own config was reachable");
    assert(status("~/.config/crowe-logic/auth.json") === 403, "the CLI sign-in store was reachable");
    return "case, dangling link, userData, CLI sign-in refused";
  });

  await check("writes stay in home and temp, and autorun files need Execute", async () => {
    const outside = await post("/write_file", { path: "/etc/crowe-test-should-not-exist", content: "x" }, ipad.token);
    assert(outside.status === 403, `writing to /etc got ${outside.status}`);
    const gated = new Companion({ tokenFile: path.join(dir, "companion.token"), loopback: true, port: 0,
      tierAllows: (kind) => kind !== "run" });
    const s = await gated.start();
    const agent = path.join(os.homedir(), "Library", "LaunchAgents", "com.crowelogic.test-should-not-exist.plist");
    const r = await fetch(`http://127.0.0.1:${s.port}/write_file`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ipad.token}` },
      body: JSON.stringify({ path: agent, content: "<plist/>" }) });
    const ordinary = await fetch(`http://127.0.0.1:${s.port}/write_file`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ipad.token}` },
      body: JSON.stringify({ path: path.join(dir, "fine.txt"), content: "ok" }) });
    // A git hook runs on the next commit, so it is a command, whatever the tier
    // calls it. Asked of the same server: restarting it reuses the port, and
    // fetch can hand the new server a pooled socket the old one just closed.
    const hook = path.join(dir, "repo", ".git", "hooks", "pre-commit");
    const h = await fetch(`http://127.0.0.1:${s.port}/write_file`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ipad.token}` },
      body: JSON.stringify({ path: hook, content: "#!/bin/sh" }) });
    await gated.stop();
    assert(r.status === 403, `a LaunchAgent under Edit got ${r.status}`);
    assert(!fs.existsSync(agent), "the refused LaunchAgent was written");
    assert(/Execute/.test((await r.json()).detail || ""), "the refusal must name the tier");
    assert(ordinary.status === 200, `an ordinary write under Edit got ${ordinary.status}`);
    assert(h.status === 403 && !fs.existsSync(hook), `a git hook under Edit got ${h.status}`);
    return "/etc refused; LaunchAgent and git hook refused under Edit; ordinary write fine";
  });

  await check("a phone reads its own receipts and no other device's", async () => {
    const r = await post("/audit", { limit: 100 }, ipad.token);
    assert(r.status === 200, `/audit got ${r.status}`);
    const e = r.body.entries || [];
    assert(e.length > 0, "no entries for a device that has run commands");
    assert(e.some((x) => x.kind === "run" && x.command), "no run receipt with its command");
    assert(e.some((x) => x.kind === "denied"), "the path-guard refusals are missing from the device's own record");
    const others = c.recentAudit(500).filter((x) => x.deviceId && x.deviceId !== ipad.id);
    assert(others.length > 0, "the test needs another device's lines to prove filtering");
    assert(!e.some((x) => others.some((o) => o.at === x.at && o.command === x.command && x.command)), "another device's command leaked into this one's receipts");
    assert(!JSON.stringify(r.body).includes(ipad.token), "receipts carry a live token");
    const after = c.recentAudit(500).length;
    await post("/audit", {}, ipad.token);
    assert(c.recentAudit(500).length === after, "reading receipts wrote a receipt");
    return `${e.length} receipts, own device only`;
  });

  await check("a socket error after startup is announced, not fatal", async () => {
    const events = [];
    c.onEvent = (e) => events.push(e);
    // With no listener this emit throws out of the suite — which is the bug:
    // one network hiccup and the desktop app is gone.
    c.server.emit("error", new Error("synthetic ENETDOWN"));
    assert(events.some((e) => e.type === "error"), "no error event announced to the window");
    assert(c.recentAudit(5).some((e) => e.kind === "server-error"), "the audit has no server-error line");
    assert(c.status().running, "the listener stopped over a non-fatal error");
    return "logged, announced, still listening";
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

  await check("a paired phone gets no more than the composer's tier allows", async () => {
    // Read-only on the desktop has to mean read-only from the phone. The
    // companion asks main before every run and write; here main says no.
    const gated = new Companion({ tokenFile: path.join(dir, "companion.token"), loopback: true, port: 0,
      tierAllows: (kind) => kind !== "run" && kind !== "write" });
    const s = await gated.start();
    const hit = (route, body) => fetch(`http://127.0.0.1:${s.port}${route}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ipad.token}` }, body: JSON.stringify(body) });
    const run = await hit("/run", { command: "echo should-not-run" });
    const write = await hit("/write_file", { path: path.join(dir, "no.txt"), content: "no" });
    await gated.stop();
    assert(run.status === 403, `/run under a read-only tier got ${run.status}`);
    assert(write.status === 403, `/write_file under a read-only tier got ${write.status}`);
    assert(!fs.existsSync(path.join(dir, "no.txt")), "the refused write still landed");
    const detail = (await run.json()).detail || "";
    assert(/Execute/.test(detail), `the refusal must say which tier: ${detail}`);
    return "run and write refused with the tier named";
  });

  await check("a phone opens its own shell, holds it, and only it can close it", async () => {
    // A stand-in process: the ownership rules are the companion's, not the PTY's.
    const { TerminalSessions } = require("../terminal-sessions");
    const sessions = new TerminalSessions();
    const fakeProc = () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} });
    let tier = true;
    const opener = new Companion({ tokenFile: path.join(dir, "companion.token"), loopback: true, port: 0, sessions,
      tierAllows: () => tier, hostName: () => "Studio Mac",
      openShell: async ({ cols, rows, device }) => sessions.create(`phone-${device.id.slice(0, 4)}`, fakeProc, { cols, rows, label: `${device.name} shell`, openedBy: device }) });
    const s = await opener.start();
    const phone = opener.addDevice("iPhone"), ipad = opener.addDevice("iPad");
    const hit = async (route, body, token) => {
      const r = await fetch(`http://127.0.0.1:${s.port}${route}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    try {
      const listed = await hit("/sessions/list", {}, phone.token);
      assert(listed.body.canOpen === true && listed.body.host === "Studio Mac", `list did not offer a shell: ${JSON.stringify(listed.body)}`);
      const opened = await hit("/sessions/open", { cols: 9999, rows: 40 }, phone.token);
      assert(opened.status === 200, `open returned ${opened.status}: ${JSON.stringify(opened.body)}`);
      assert(opened.body.cols === 300 && opened.body.rows === 40, `size not clamped: ${opened.body.cols}x${opened.body.rows}`);
      assert(opened.body.origin === "phone" && opened.body.mine === true, "the shell is not marked as the phone's own");
      assert(opened.body.controller?.deviceId === phone.id, "the opening phone does not hold control");
      const seen = (await hit("/sessions/list", {}, ipad.token)).body.sessions.find(x => x.id === opened.body.id);
      assert(seen && seen.mine === false && seen.openedBy === "iPhone", `another device sees it as its own: ${JSON.stringify(seen)}`);
      const ref = { sessionId: opened.body.id, generation: opened.body.generation };
      const stranger = await hit("/sessions/close", ref, ipad.token);
      assert(stranger.status === 403 && sessions.sessions.has(opened.body.id), `another device closed the shell (${stranger.status})`);
      const closed = await hit("/sessions/close", ref, phone.token);
      assert(closed.status === 200 && !sessions.sessions.has(opened.body.id), `the owner could not close it (${closed.status})`);
      tier = false;
      const refused = await hit("/sessions/open", {}, phone.token);
      assert(refused.status === 403 && /Execute/.test(refused.body.detail) && sessions.sessions.size === 0, `opened outside Execute (${refused.status})`);
      tier = true;
      await hit("/sessions/open", {}, phone.token);
      opener.revokeDevice(phone.id);
      assert(sessions.sessions.size === 0, "revoking the phone left its shell running");
      return "opened at phone size, owner-only close, tier and revoke enforced";
    } finally { sessions.closeAll(); await opener.stop(); }
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) failed` : "\nall companion checks passed");
  process.exit(failures ? 1 : 0);
})();
