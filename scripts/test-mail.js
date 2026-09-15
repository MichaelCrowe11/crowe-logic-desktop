// Tests for the Mail connector. Pure Node, no Electron.
//
//   node scripts/test-mail.js
//
// Three layers. The manifest: the Mail entry declares no server to spawn, names
// exactly the credentials mail.js reads, and gates everything at Execute. The
// client: real frames against a scripted SMTP server on 127.0.0.1, with a real
// STARTTLS upgrade and a real implicit-TLS listener under a certificate minted
// for this run (openssl is required; CI runs on ubuntu, where it is present).
// The harness: send_email is offered only while Mail is on, refused below
// Execute, stopped at an approval card whose hash is bound to the message, and
// reported as "possibly sent" when the server's verdict never arrives.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const tls = require("tls");
const { execFileSync } = require("child_process");
const mail = require("../mail");
const H = require("../harness");
const { sanitizePluginEnv } = require("../main-security");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const manifest = JSON.parse(read("plugins.builtin.json"));
const MAIL = manifest.plugins.find((p) => p.id === mail.PLUGIN_ID);
const GITHUB = manifest.plugins.find((p) => p.id === "github");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const noop = () => {};
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// ─── A certificate for this run ──────────────────────────────────────────────
function mintCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-mail-cert-"));
  const key = path.join(dir, "key.pem"), cert = path.join(dir, "cert.pem");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
      "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    console.error("test-mail: openssl is needed to mint the run's certificate and it failed or is missing:", String((e && e.message) || e).split("\n")[0]);
    process.exit(1);
  }
  const out = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
const CERT = mintCert();

// ─── The scripted server ─────────────────────────────────────────────────────
/* A submission server that records what it saw, split by whether TLS was up.
   opts: implicit (listen with TLS), starttls (offer it; default true), auth
   (mechanisms after TLS; default ["LOGIN"]), authInClear (also advertise AUTH
   before TLS, which a client must ignore), password (what AUTH must match),
   rcpt(addr) -> reply line, afterData: "accept" | "drop" | "echo" | "odd" |
   "reject", hangAfterEhlo, bareLf, leakAfterStarttls, silent (accept TCP and
   say nothing). */
function smtpServer(opts = {}) {
  const seen = { plain: [], secure: [], data: null, closed: false, tlsUp: false };
  const password = opts.password || "";
  function handle(sock, secure, greet) {
    let buf = "", inData = false, dataBuf = "", authStep = 0;
    const log = secure ? seen.secure : seen.plain;
    const send = (s) => { try { sock.write(`${s}\r\n`); } catch {} };
    const ehlo = () => {
      const ext = [];
      if (!secure && opts.starttls !== false) ext.push("STARTTLS");
      if (secure || opts.authInClear) ext.push(`AUTH ${(opts.auth || ["LOGIN"]).join(" ")}`);
      ext.push("8BITMIME");
      const all = ["fake.example at your service", ...ext];
      send(all.map((l, i) => `250${i < all.length - 1 ? "-" : " "}${l}`).join("\r\n"));
    };
    sock.on("error", noop);
    sock.on("close", () => { seen.closed = true; });
    if (greet) {
      // A silent server still reads, so the client's close is seen and the
      // connection does not outlive the test.
      if (opts.silent) { sock.resume(); return; }
      if (opts.bareLf) { try { sock.write("220 fake.example\n"); } catch {} } else send("220 fake.example ESMTP");
    }
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        if (inData) {
          if (line !== ".") { dataBuf += `${line}\r\n`; continue; }
          inData = false; seen.data = dataBuf;
          if (opts.afterData === "drop") { sock.destroy(); return; }
          if (opts.afterData === "echo") { send(`550 5.7.1 rejected, you sent ${password} as the password`); continue; }
          if (opts.afterData === "odd") { send("354 go on"); continue; }
          if (opts.afterData === "reject") { send("552 5.3.4 message too big"); continue; }
          send("250 2.0.0 OK queued as ABC123"); continue;
        }
        log.push(line);
        const up = line.toUpperCase();
        if (authStep === 1) { authStep = 2; send("334 UGFzc3dvcmQ6"); continue; }
        if (authStep === 2) { authStep = 0; send(line === b64(password) ? "235 2.7.0 Accepted" : "535 5.7.8 Username and Password not accepted"); continue; }
        if (up.startsWith("EHLO")) { if (opts.hangAfterEhlo) continue; ehlo(); continue; }
        if (up === "STARTTLS") {
          if (secure || opts.starttls === false) { send("454 4.7.0 TLS not available"); continue; }
          send(opts.leakAfterStarttls ? "220 2.0.0 Ready to start TLS\r\n250 leftover" : "220 2.0.0 Ready to start TLS");
          sock.removeAllListeners("data");
          const up2 = new tls.TLSSocket(sock, { isServer: true, secureContext: tls.createSecureContext({ key: CERT.key, cert: CERT.cert }) });
          up2.on("error", noop);
          up2.once("secure", () => { seen.tlsUp = true; handle(up2, true, false); });
          return;
        }
        if (up === "AUTH LOGIN") { authStep = 1; send("334 VXNlcm5hbWU6"); continue; }
        if (up.startsWith("AUTH PLAIN ")) {
          const [, , pass] = Buffer.from(line.slice(11), "base64").toString("utf8").split("\x00");
          send(pass === password ? "235 2.7.0 Accepted" : "535 5.7.8 Username and Password not accepted"); continue;
        }
        if (up.startsWith("MAIL FROM:")) { send("250 2.1.0 OK"); continue; }
        if (up.startsWith("RCPT TO:")) { const addr = line.slice(8).replace(/[<>\s]/g, ""); send(opts.rcpt ? opts.rcpt(addr) : "250 2.1.5 OK"); continue; }
        if (up === "DATA") { inData = true; dataBuf = ""; send("354 Go ahead"); continue; }
        if (up === "QUIT") { send("221 2.0.0 Bye"); sock.end(); continue; }
        send("502 5.5.2 Command not implemented");
      }
    });
  }
  const server = opts.implicit
    ? tls.createServer({ key: CERT.key, cert: CERT.cert }, (s) => { seen.tlsUp = true; handle(s, true, true); })
    : net.createServer((s) => handle(s, false, true));
  server.on("error", noop);
  const conns = new Set();
  server.on("connection", (s) => { conns.add(s); s.once("close", () => conns.delete(s)); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    // Lingering connections are destroyed first: server.close waits for them.
    resolve({ seen, port, close: () => { for (const s of conns) s.destroy(); return new Promise((r) => { server.close(() => r()); }); } });
  }));
}
/* The account names localhost so the certificate's name is what TLS checks;
   the injected connect goes to the loopback port the server actually got. */
function accountFor(srv, extra = {}) {
  return mail.accountFromEnv({ SMTP_HOST: extra.implicit ? "localhost:465" : "localhost", SMTP_USER: "me@example.com", SMTP_PASSWORD: extra.password || "app-pass-w0rd", ...(extra.env || {}) });
}
function ioFor(srv, extra = {}) {
  const wire = [];
  return {
    wire,
    connect: () => net.connect(srv.port, "127.0.0.1"),
    tlsOptions: extra.untrusted ? undefined : { ca: CERT.cert },
    timeoutMs: extra.timeoutMs || 5000,
    onWire: (f) => wire.push(f),
    date: new Date(Date.UTC(2026, 8, 14, 12, 0, 0)),
    messageId: "fixed-id@example.com",
    mailer: "Crowe Logic test",
  };
}
const MSG = { to: ["a@example.com"], cc: ["b@example.com"], subject: "Hello there", body: "Line one.\n.starts with a dot\nLine three." };
const PASS = "app-pass-w0rd";
async function withServer(opts, fn) {
  const srv = await smtpServer(opts);
  try { return await fn(srv); } finally { await srv.close(); }
}
async function rejects(p) {
  try { await p; } catch (e) { return e; }
  throw new Error("expected a rejection");
}

// ─── The manifest ────────────────────────────────────────────────────────────
test("the Mail entry exists, is official, and lives in the communication category for chat and projects", () => {
  assert.ok(MAIL, "plugins.builtin.json has a mail entry");
  assert.strictEqual(MAIL.name, "Mail");
  assert.strictEqual(MAIL.official, true);
  assert.strictEqual(MAIL.available, true);
  assert.strictEqual(MAIL.category, "communication");
  assert.deepStrictEqual([...MAIL.spaces].sort(), ["chat", "projects"]);
});
test("Mail spawns nothing: no server command, and its tools are the built-ins mail.js owns", () => {
  // No trustworthy MCP email server exists on npm (see the header of mail.js),
  // so the entry must not name a package to run. The GitHub entry is the shape
  // a spawned plugin has, kept here so the contrast is checked, not assumed.
  assert.strictEqual(MAIL.mcp, null);
  assert.strictEqual(GITHUB.mcp.command, "npx");
  assert.ok(GITHUB.mcp.args.includes("-y"));
  assert.deepStrictEqual(MAIL.builtin.tools, mail.TOOLS);
  assert.deepStrictEqual(mail.TOOLS, ["send_email"]);
  assert.strictEqual(H.MAIL_TOOL.function.name, "send_email");
});
test("the credential prompts are exactly the variables mail.js reads, and only the password is hidden", () => {
  assert.deepStrictEqual(MAIL.envPrompts.map((e) => e.key), mail.ENV_KEYS);
  assert.deepStrictEqual(mail.ENV_KEYS, ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD"]);
  const byKey = Object.fromEntries(MAIL.envPrompts.map((e) => [e.key, e]));
  assert.strictEqual(byKey.SMTP_HOST.secret, false);
  assert.strictEqual(byKey.SMTP_USER.secret, false);
  assert.notStrictEqual(byKey.SMTP_PASSWORD.secret, false, "the app password stays a password field");
  for (const e of MAIL.envPrompts) assert.ok(e.label && e.label.length < 80, `${e.key} has a short label`);
});
test("sanitizePluginEnv keeps the three declared variables and nothing else", () => {
  const clean = sanitizePluginEnv(MAIL, { SMTP_HOST: "smtp.example.com:465", SMTP_USER: "me@example.com", SMTP_PASSWORD: "p", PATH: "/x", NODE_OPTIONS: "--require=/tmp/x", FROM: "x" });
  assert.deepStrictEqual(Object.keys(clean).sort(), ["SMTP_HOST", "SMTP_PASSWORD", "SMTP_USER"]);
  const acct = mail.accountFromEnv(clean);
  assert.strictEqual(acct.port, 465);
  assert.strictEqual(acct.implicitTls, true);
  assert.strictEqual(acct.from, "me@example.com");
});
test("every Mail tool is gated at Execute and the description says so", () => {
  assert.ok(Array.isArray(MAIL.tools) && MAIL.tools.length);
  for (const r of MAIL.tools) assert.strictEqual(r.tier, "execute", `${r.match} is execute`);
  assert.ok(MAIL.tools.some((r) => r.match === "*"), "a catch-all rule exists");
  assert.match(MAIL.description, /Execute autonomy/);
  assert.match(MAIL.description, /approval/);
  assert.strictEqual(H.deliveryOf({}, "send_email", {}), "irreversible");
});
test("user-facing Mail copy follows the brand rules", () => {
  const copy = [MAIL.description, ...MAIL.envPrompts.map((e) => e.label), ...MAIL.chips, H.MAIL_TOOL.function.description];
  for (const s of copy) {
    assert.ok(!s.includes("—"), `no em dash in: ${s}`);
    assert.ok(!/\bAI\b/.test(s), `no standalone two-letter word in: ${s}`);
    assert.ok(!/[\u{1F000}-\u{1FAFF}]/u.test(s), `no emoji in: ${s}`);
  }
});
test("main.js wires Mail as a built-in plugin with no IPC road to sending", () => {
  const main = read("main.js");
  assert.match(main, /const BUILTIN_PLUGIN_TOOLS = \{ \[mail\.PLUGIN_ID\]: mail\.TOOLS \}/, "tool names come from mail.js, not the manifest");
  assert.match(main, /function pluginBuiltinTools\(p\) \{ return p && !p\.mcp && BUILTIN_PLUGIN_TOOLS\[p\.id\]/, "an entry that names a server is never a built-in");
  assert.match(main, /sendMail: \(message\) => mail\.sendMail\(mail\.accountFromEnv\(pluginEnv\(mail\.PLUGIN_ID\)\)/, "credentials are read from the encrypted store at send time");
  assert.match(main, /mailConfigured: \(\) => PLUGIN_MANAGED\.has\(mail\.PLUGIN_ID\) && mail\.isConfigured/, "the tool is offered only while Mail is on");
  assert.ok(!/ipcMain\.handle\("crowe:mail/.test(main), "no renderer channel sends mail; the harness gate is the only road");
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.build.files.includes("mail.js"), "mail.js ships in the build");
  assert.ok(pkg.scripts.test.includes("node scripts/test-mail.js"), "this test is in npm test");
  assert.ok(read(".github/workflows/ci.yml").includes("node scripts/test-mail.js"), "this test runs in CI (the rule in ci.yml)");
});

// ─── Addresses, endpoints, the message ───────────────────────────────────────
test("isAddress accepts one bare mailbox and refuses display names, address literals, and bare hosts", () => {
  assert.ok(mail.isAddress("first.last+tag@sub.example.com"));
  assert.ok(!mail.isAddress("Name <a@example.com>"));
  assert.ok(!mail.isAddress("a@localhost"));
  assert.ok(!mail.isAddress("a@[10.0.0.1]"));
  assert.ok(!mail.isAddress("a@@example.com"));
  assert.ok(!mail.isAddress("a@example.123"));
  assert.ok(!mail.isAddress("\"quoted\"@example.com"));
});
test("parseEndpoint reads host, host:port, IPv4 and bracketed IPv6, and refuses schemes and paths", () => {
  assert.deepStrictEqual(mail.parseEndpoint("smtp.example.com"), { host: "smtp.example.com", port: 587 });
  assert.deepStrictEqual(mail.parseEndpoint(" smtp.example.com:465 "), { host: "smtp.example.com", port: 465 });
  assert.deepStrictEqual(mail.parseEndpoint("10.0.0.5:2525"), { host: "10.0.0.5", port: 2525 });
  assert.deepStrictEqual(mail.parseEndpoint("[::1]:2525"), { host: "::1", port: 2525 });
  for (const bad of ["smtp://x.example.com", "x.example.com/path", "user@x.example.com", "x.example.com:0", "x.example.com:70000", "x example.com", "", null])
    assert.strictEqual(mail.parseEndpoint(bad), null, `refuses ${JSON.stringify(bad)}`);
});
test("accountFromEnv needs all three pieces and a sender that is a full address", () => {
  const ok = { SMTP_HOST: "smtp.example.com", SMTP_USER: "me@example.com", SMTP_PASSWORD: "pw" };
  assert.ok(mail.isConfigured(ok));
  assert.ok(!mail.isConfigured({ ...ok, SMTP_USER: "me" }), "a relay user name is not a From");
  assert.ok(!mail.isConfigured({ ...ok, SMTP_PASSWORD: "" }));
  assert.ok(!mail.isConfigured({ ...ok, SMTP_PASSWORD: "a\nb" }));
  assert.ok(!mail.isConfigured({ ...ok, SMTP_HOST: "" }));
  assert.ok(!mail.isConfigured(null));
});
test("normalizeMessage refuses header injection, display names, and too many recipients; de-duplicates the rest", () => {
  assert.match(mail.normalizeMessage({ to: ["a@example.com"], subject: "x\r\nBcc: c@example.com", body: "b" }).error, /control characters/);
  assert.match(mail.normalizeMessage({ to: ["A <a@example.com>"], subject: "x", body: "b" }).error, /not bare mail addresses/);
  assert.match(mail.normalizeMessage({ to: [], subject: "x", body: "b" }).error, /at least one recipient/);
  assert.match(mail.normalizeMessage({ to: ["a@example.com"], subject: " ", body: "b" }).error, /needs a subject/);
  assert.match(mail.normalizeMessage({ to: ["a@example.com"], subject: "x", body: "  " }).error, /needs a body/);
  const many = Array.from({ length: 21 }, (_, i) => `u${i}@example.com`);
  assert.match(mail.normalizeMessage({ to: many, subject: "x", body: "b" }).error, /too many recipients/);
  const m = mail.normalizeMessage({ to: "a@example.com, a@example.com; b@example.com", cc: ["b@example.com", "c@example.com"], subject: " Hi ", text: "body" });
  assert.deepStrictEqual(m, { to: ["a@example.com", "b@example.com"], cc: ["c@example.com"], subject: "Hi", text: "body" });
});
test("buildMessage writes CRLF headers, a folded address list, an encoded subject, a base64 body, and a Message-ID under the sender's domain", () => {
  const date = new Date(Date.UTC(2026, 8, 14, 12, 0, 0));
  const { raw, messageId } = mail.buildMessage({ from: "me@example.com", to: ["a@example.com"], cc: ["b@example.com"], subject: "Grüße aus Phoenix", text: "one\ntwo\r\nthree" }, { date, mailer: "Crowe Logic test" });
  const [head, body] = raw.split("\r\n\r\n");
  const lines = head.split("\r\n");
  assert.strictEqual(lines[0], "From: me@example.com");
  assert.strictEqual(lines[1], "To: a@example.com");
  assert.strictEqual(lines[2], "Cc: b@example.com");
  assert.match(lines[3], /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.strictEqual(Buffer.from(lines[3].slice("Subject: =?UTF-8?B?".length, -2), "base64").toString("utf8"), "Grüße aus Phoenix");
  assert.strictEqual(lines[4], "Date: Mon, 14 Sep 2026 12:00:00 +0000");
  assert.match(messageId, /^[0-9a-f-]{36}@example\.com$/);
  assert.strictEqual(lines[5], `Message-ID: <${messageId}>`);
  assert.ok(lines.includes("Content-Transfer-Encoding: base64"));
  assert.ok(lines.includes("X-Mailer: Crowe Logic test"));
  assert.ok(!raw.includes("\n") || !/[^\r]\n/.test(raw), "every line break is CRLF");
  assert.strictEqual(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), "one\r\ntwo\r\nthree");
  assert.ok(raw.endsWith("\r\n"), "ends with CRLF so the terminator can follow");
});
test("subjects fold under 78 columns, encoded words stay under 75, and an ASCII subject that looks like an encoded word is encoded", () => {
  const long = mail.subjectHeader("word ".repeat(40).trim());
  for (const l of long.split("\r\n")) assert.ok(l.length <= 78, `folded line is ${l.length} wide`);
  const enc = mail.subjectHeader("ü".repeat(60));
  for (const l of enc.split("\r\n")) {
    assert.ok(l.length <= 76, `a line holding an encoded word is ${l.length} wide, over RFC 2047's 76`);
    assert.ok(l.replace(/^Subject: | /, "").length <= 75, `the encoded word itself is over 75`);
  }
  assert.match(mail.subjectHeader("=?UTF-8?B?SGk=?="), /^Subject: =\?UTF-8\?B\?PT9VVEYtOD9CP1NHaz0/);
  const many = mail.addressHeader("To", Array.from({ length: 12 }, (_, i) => `recipient${i}@example.com`));
  for (const l of many.split("\r\n")) assert.ok(l.length <= 78, `address line is ${l.length} wide`);
  assert.strictEqual(many.split("\r\n").slice(1).every((l) => l.startsWith(" ")), true, "continuation lines are indented");
});
test("dotStuff doubles a leading period so the terminator cannot appear inside the text", () => {
  assert.strictEqual(mail.dotStuff("a\r\n.\r\n..b\r\nc."), "a\r\n..\r\n...b\r\nc.");
});

// ─── The client against the scripted server ──────────────────────────────────
test("STARTTLS then AUTH LOGIN: the frames arrive in order, and no credential byte crosses the wire in the clear", () => withServer({ password: PASS }, async (srv) => {
  const io = ioFor(srv);
  const r = await mail.sendMail(accountFor(srv), MSG, io);
  assert.strictEqual(r.outcome, "accepted");
  assert.deepStrictEqual(r.accepted, ["a@example.com", "b@example.com"]);
  assert.strictEqual(r.messageId, "fixed-id@example.com");
  assert.strictEqual(srv.seen.tlsUp, true);
  // What the client wrote, in order.
  const w = io.wire;
  assert.match(w[0], /^EHLO \[127\.0\.0\.1\]$/);
  assert.strictEqual(w[1], "STARTTLS");
  assert.match(w[2], /^EHLO \[127\.0\.0\.1\]$/);
  assert.strictEqual(w[3], "AUTH LOGIN");
  assert.strictEqual(w[4], b64("me@example.com"));
  assert.strictEqual(w[5], b64(PASS));
  assert.strictEqual(w[6], "MAIL FROM:<me@example.com>");
  assert.strictEqual(w[7], "RCPT TO:<a@example.com>");
  assert.strictEqual(w[8], "RCPT TO:<b@example.com>");
  assert.strictEqual(w[9], "DATA");
  assert.ok(w[10].startsWith("From: me@example.com\r\n"), "the message follows DATA");
  assert.ok(w[10].endsWith("\r\n.\r\n"), "the terminator closes it");
  assert.strictEqual(w[11], "QUIT");
  assert.strictEqual(w.length, 12);
  // What the server saw before TLS was two lines and no secret.
  assert.deepStrictEqual(srv.seen.plain.map((l) => l.split(" ")[0]), ["EHLO", "STARTTLS"]);
  for (const l of srv.seen.plain) { assert.ok(!l.includes(PASS) && !l.includes(b64(PASS)), "no password in the clear"); }
  assert.ok(srv.seen.secure.includes(b64(PASS)), "the password travelled inside TLS");
  // The body arrived dot-stuffed, and decodes back to the text the user approved.
  assert.ok(srv.seen.data.includes("Content-Transfer-Encoding: base64"));
  const body = srv.seen.data.split("\r\n\r\n")[1].replace(/\r\n/g, "");
  assert.strictEqual(Buffer.from(body, "base64").toString("utf8"), "Line one.\r\n.starts with a dot\r\nLine three.");
}));
test("AUTH PLAIN is used when the server offers only PLAIN, and only the in-TLS list counts", () => withServer({ password: PASS, auth: ["PLAIN"], authInClear: true }, async (srv) => {
  const io = ioFor(srv);
  const r = await mail.sendMail(accountFor(srv), MSG, io);
  assert.strictEqual(r.outcome, "accepted");
  const auth = io.wire.find((f) => f.startsWith("AUTH "));
  assert.strictEqual(auth, `AUTH PLAIN ${b64(`\x00me@example.com\x00${PASS}`)}`);
  assert.strictEqual(io.wire.indexOf(auth) > io.wire.indexOf("STARTTLS"), true, "AUTH came after STARTTLS even though it was advertised before");
}));
test("implicit TLS on 465: no STARTTLS frame, the handshake comes first, then EHLO and AUTH", () => withServer({ password: PASS, implicit: true }, async (srv) => {
  const io = ioFor(srv, { implicit: true });
  const acct = accountFor(srv, { implicit: true });
  assert.strictEqual(acct.implicitTls, true);
  const r = await mail.sendMail(acct, MSG, io);
  assert.strictEqual(r.outcome, "accepted");
  assert.ok(!io.wire.includes("STARTTLS"));
  assert.match(io.wire[0], /^EHLO /);
  assert.strictEqual(io.wire[1], "AUTH LOGIN");
  assert.deepStrictEqual(srv.seen.plain, []);
}));
test("a server without STARTTLS gets no password: the attempt ends before AUTH", () => withServer({ password: PASS, starttls: false, authInClear: true }, async (srv) => {
  const io = ioFor(srv);
  const e = await rejects(mail.sendMail(accountFor(srv), MSG, io));
  assert.strictEqual(e.outcome, "not_sent");
  assert.match(e.message, /did not offer STARTTLS, so the password was not sent/);
  assert.ok(!io.wire.some((f) => f.startsWith("AUTH") || f === b64(PASS)), "no AUTH frame was written");
  assert.deepStrictEqual(io.wire.slice(-1), ["QUIT"]);
}));
test("an untrusted certificate ends the attempt at the handshake, before any credential", () => withServer({ password: PASS }, async (srv) => {
  const io = ioFor(srv, { untrusted: true });
  const e = await rejects(mail.sendMail(accountFor(srv), MSG, io));
  assert.strictEqual(e.outcome, "not_sent");
  assert.match(e.message, /^TLS to localhost failed: /);
  assert.ok(!io.wire.some((f) => f.startsWith("AUTH")), "no AUTH frame was written");
  assert.deepStrictEqual(srv.seen.secure, [], "the server's TLS side never saw a command");
}));
test("plaintext leaking across the STARTTLS boundary is refused", () => withServer({ password: PASS, leakAfterStarttls: true }, async (srv) => {
  const io = ioFor(srv);
  const e = await rejects(mail.sendMail(accountFor(srv), MSG, io));
  assert.match(e.message, /across the STARTTLS boundary/);
  assert.ok(!io.wire.some((f) => f.startsWith("AUTH")));
}));
test("rejected credentials name the code, never the password or its base64", () => withServer({ password: "the-real-one" }, async (srv) => {
  const io = ioFor(srv);
  const e = await rejects(mail.sendMail(accountFor(srv), MSG, io));
  assert.strictEqual(e.outcome, "not_sent");
  assert.match(e.message, /rejected the credentials \(535 5\.7\.8\)/);
  assert.ok(!e.message.includes(PASS) && !e.message.includes(b64(PASS)));
  assert.ok(!io.wire.includes("MAIL FROM:<me@example.com>"), "nothing past AUTH");
}));
test("a server that echoes the password in a refusal has it redacted, and the refusal is not_sent", () => withServer({ password: PASS, afterData: "echo" }, async (srv) => {
  const e = await rejects(mail.sendMail(accountFor(srv), MSG, ioFor(srv)));
  assert.strictEqual(e.outcome, "not_sent");
  assert.strictEqual(e.code, 550);
  assert.ok(e.message.includes("[redacted]"), e.message);
  assert.ok(!e.message.includes(PASS));
}));
test("a refused recipient is named and nothing is submitted", () => withServer({ password: PASS, rcpt: (a) => (a === "b@example.com" ? "550 5.1.1 no such user" : "250 OK") }, async (srv) => {
  const io = ioFor(srv);
  const e = await rejects(mail.sendMail(accountFor(srv), MSG, io));
  assert.match(e.message, /refused recipient b@example\.com \(550 5\.1\.1 no such user\)/);
  assert.ok(!io.wire.includes("DATA"));
  assert.strictEqual(srv.seen.data, null);
}));
test("a connection dropped after the terminator and before the verdict is unknown, not not_sent", () => withServer({ password: PASS, afterData: "drop" }, async (srv) => {
  const e = await rejects(mail.sendMail(accountFor(srv), MSG, ioFor(srv)));
  assert.strictEqual(e.outcome, "unknown");
  assert.match(e.message, /submitted and the server never confirmed it/);
  assert.match(e.message, /may have been sent/);
  assert.ok(srv.seen.data, "the server did receive the message");
}));
test("a final reply that is neither 250 nor a refusal is unknown; a 5xx after the terminator is not_sent", async () => {
  await withServer({ password: PASS, afterData: "odd" }, async (srv) => {
    const e = await rejects(mail.sendMail(accountFor(srv), MSG, ioFor(srv)));
    assert.strictEqual(e.outcome, "unknown");
    assert.strictEqual(e.code, 354);
  });
  await withServer({ password: PASS, afterData: "reject" }, async (srv) => {
    const e = await rejects(mail.sendMail(accountFor(srv), MSG, ioFor(srv)));
    assert.strictEqual(e.outcome, "not_sent");
    assert.strictEqual(e.code, 552);
    assert.match(e.message, /did not accept the message \(552/);
  });
});
test("a server that stops answering times out, and the time is bounded", () => withServer({ password: PASS, hangAfterEhlo: true }, async (srv) => {
  const t0 = Date.now();
  const e = await rejects(mail.sendMail(accountFor(srv), MSG, ioFor(srv, { timeoutMs: 400 })));
  assert.match(e.message, /timed out after 0s/);
  assert.strictEqual(e.outcome, "not_sent");
  assert.ok(Date.now() - t0 < 3000, "the attempt ended near the deadline");
}));
test("an implicit-TLS handshake that never completes ends at the deadline instead of hanging", () => withServer({ silent: true }, async (srv) => {
  const t0 = Date.now();
  const io = ioFor(srv, { implicit: true, timeoutMs: 400 });
  const e = await rejects(mail.sendMail(accountFor(srv, { implicit: true }), MSG, io));
  assert.ok(Date.now() - t0 < 3000, `ended in ${Date.now() - t0}ms`);
  assert.match(e.message, /TLS to localhost failed|timed out/);
  assert.strictEqual(e.outcome, "not_sent");
  assert.deepStrictEqual(io.wire, [], "nothing was written to a socket that never became TLS");
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(srv.seen.closed, true, "the client destroyed its socket");
}));
test("a bare line feed from the server is a malformed reply", () => withServer({ bareLf: true }, async (srv) => {
  const e = await rejects(mail.sendMail(accountFor(srv), MSG, ioFor(srv)));
  assert.match(e.message, /bare line feed/);
}));
test("a closed port is one clear error", async () => {
  const srv = await smtpServer({});
  await srv.close();
  const e = await rejects(mail.sendMail(accountFor(srv), MSG, ioFor(srv)));
  assert.match(e.message, /could not connect: ECONNREFUSED/);
  assert.strictEqual(e.outcome, "not_sent");
});
test("sendMail refuses an incomplete account and a malformed message before touching the network", async () => {
  let connects = 0;
  const io = { connect: () => { connects += 1; return net.connect(1, "127.0.0.1"); } };
  await assert.rejects(mail.sendMail(null, MSG, io), /no complete account/);
  await assert.rejects(mail.sendMail({ host: "h", from: "me@example.com", password: "p" }, { to: ["bad"], subject: "s", body: "b" }, io), /not bare mail addresses/);
  assert.strictEqual(connects, 0);
});

// ─── The harness gate ────────────────────────────────────────────────────────
function harnessCtx(cfgPatch = {}, hooks = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-mail-harness-"));
  const cfg = { autonomy: "execute", approvals: "high-risk", verifier: false, turnBudgetUsd: 0, autoApprove: true, model: "test-model", ...cfgPatch };
  const ctx = {
    dir, sent: [], journalEvents: [], approvalsSeen: [],
    getCwd: () => dir, setCwd: noop,
    loadConfig: () => cfg,
    proposeEdit: async () => "applied edit",
    mcpTools: () => [], mcpCall: async () => "mcp result",
    openUrl: noop,
    journal: (ev) => ctx.journalEvents.push(ev),
    artifactDir: () => path.join(dir, ".artifacts"),
    rateIn: 0, rateOut: 0,
    mailConfigured: () => true,
    mailFrom: () => "me@example.com",
    sendMail: async (m) => { ctx.sent.push(m); return { outcome: "accepted", accepted: [...m.to, ...m.cc], messageId: "id-1@example.com" }; },
    ...hooks,
  };
  if (hooks.approve !== undefined) ctx.requestApproval = async (req) => { ctx.approvalsSeen.push(req); return { approved: hooks.approve }; };
  return ctx;
}
const stateFor = (ctx, deps = {}) => H.newState(ctx, ctx.loadConfig(), deps, { expert: "operator", model: "m" });
const OP = { expert: "operator" };
const names = (tools) => tools.map((t) => t.function.name);

test("send_email is offered only while Mail is on with a complete account, and never as a built-in", () => {
  assert.ok(!names(H.BUILTIN_TOOLS).includes("send_email"));
  assert.ok(names(H.allTools(harnessCtx(), OP)).includes("send_email"));
  assert.ok(!names(H.allTools(harnessCtx({}, { mailConfigured: () => false }), OP)).includes("send_email"));
  const noSender = harnessCtx(); delete noSender.sendMail;
  assert.ok(!names(H.allTools(noSender, OP)).includes("send_email"));
  assert.ok(!names(H.verifierTools(harnessCtx())).includes("send_email"), "the verifier never gets it");
});
test("below Execute the call is refused and nothing is sent or asked", async () => {
  for (const tier of ["plan", "readonly", "edit"]) {
    const ctx = harnessCtx({ autonomy: tier }, { approve: true });
    const out = await H.execTool(ctx, "send_email", MSG, OP, stateFor(ctx));
    assert.match(out, /^blocked: sending mail requires Execute autonomy/, tier);
    assert.match(out, new RegExp(`"${tier}"`));
    assert.strictEqual(ctx.sent.length, 0);
    assert.strictEqual(ctx.approvalsSeen.length, 0);
  }
});
test("a call that arrives while Mail is off is refused, even at Execute", async () => {
  const ctx = harnessCtx({}, { approve: true, mailConfigured: () => false });
  const out = await H.execTool(ctx, "send_email", MSG, OP, stateFor(ctx));
  assert.match(out, /^blocked: the Mail plugin is not enabled/);
  assert.strictEqual(ctx.sent.length, 0);
});
test("the verifier may not send", async () => {
  const ctx = harnessCtx({}, { approve: true });
  const out = await H.execTool(ctx, "send_email", MSG, { expert: "operator", verify: true }, stateFor(ctx));
  assert.match(out, /^blocked: the verifier does not change anything/);
  assert.strictEqual(ctx.sent.length, 0);
});
test("at Execute the message stops at an approval card that carries the whole message, bound by hash", async () => {
  const ctx = harnessCtx({}, { approve: false });
  const out = await H.execTool(ctx, "send_email", MSG, OP, stateFor(ctx));
  assert.match(out, /^blocked: the user DENIED this action/);
  assert.strictEqual(ctx.sent.length, 0);
  assert.strictEqual(ctx.approvalsSeen.length, 1);
  const req = ctx.approvalsSeen[0];
  assert.strictEqual(req.kind, "send_email");
  assert.strictEqual(req.risk, "strict");
  assert.strictEqual(req.title, "Send an email");
  assert.ok(req.detail.includes("From: me@example.com"));
  assert.ok(req.detail.includes("To: a@example.com"));
  assert.ok(req.detail.includes("Cc: b@example.com"));
  assert.ok(req.detail.includes("Subject: Hello there"));
  assert.ok(req.detail.includes(MSG.body), "the full body is on the card");
  assert.ok(req.why.includes("a@example.com, b@example.com") && req.why.includes("cannot be recalled"));
  assert.strictEqual(req.hash, H.inputHash("send_email", { from: "me@example.com", to: MSG.to, cc: MSG.cc, subject: MSG.subject, text: MSG.body }));
  assert.ok(ctx.journalEvents.some((e) => e.event_type === "APPROVAL_REQUESTED" && e.tool_id === "send_email"));
  assert.ok(ctx.journalEvents.some((e) => e.event_type === "APPROVAL_DENIED"));
});
test("an approved send hands exactly the normalized message to main and reports the acceptance", async () => {
  const ctx = harnessCtx({}, { approve: true });
  const st = stateFor(ctx);
  const r = await H.callTool(ctx, "send_email", { ...MSG, to: "a@example.com" }, OP, st);
  const out = r.text;
  assert.match(out, /^sent to a@example\.com, b@example\.com with subject "Hello there": the server accepted it for delivery as <id-1@example\.com>\.$/);
  assert.strictEqual(r.status, "SUCCESS");
  assert.strictEqual(r.delivery, "irreversible");
  assert.deepStrictEqual(ctx.sent, [{ to: ["a@example.com"], cc: ["b@example.com"], subject: "Hello there", text: MSG.body }]);
  assert.strictEqual(H.didMutate(ctx, "send_email", MSG, out), true);
  assert.strictEqual(st.mutated, true, "the turn is marked as having mutated");
  const called = ctx.journalEvents.find((e) => e.event_type === "TOOL_CALLED");
  assert.strictEqual(called.delivery, "irreversible");
  assert.match(called.output_summary, /^SUCCESS: sent to/);
  assert.ok(ctx.journalEvents.some((e) => e.event_type === "APPROVAL_GRANTED"));
});
test("strict approvals also stop it; approvals off skips the card and says so in the journal", async () => {
  const strict = harnessCtx({ approvals: "strict" }, { approve: false });
  assert.match(await H.execTool(strict, "send_email", MSG, OP, stateFor(strict)), /^blocked:/);
  assert.strictEqual(strict.sent.length, 0);
  const off = harnessCtx({ approvals: "off" }, { approve: false });
  const out = await H.execTool(off, "send_email", MSG, OP, stateFor(off));
  assert.match(out, /^sent to/);
  assert.strictEqual(off.approvalsSeen.length, 0);
  assert.ok(off.journalEvents.some((e) => e.event_type === "APPROVAL_SKIPPED" && e.tool_id === "send_email"));
});
test("a malformed message is refused before any card is shown", async () => {
  const ctx = harnessCtx({}, { approve: true });
  const out = await H.execTool(ctx, "send_email", { to: ["Someone <a@example.com>"], subject: "x", body: "b" }, OP, stateFor(ctx));
  assert.match(out, /^error: these are not bare mail addresses/);
  assert.strictEqual(ctx.approvalsSeen.length, 0);
  assert.strictEqual(ctx.sent.length, 0);
});
test("a build with no way to ask blocks the send", async () => {
  const ctx = harnessCtx();
  const out = await H.execTool(ctx, "send_email", MSG, OP, stateFor(ctx));
  assert.match(out, /^blocked: this action sends mail to .* and this build has no way to ask for it/);
  assert.strictEqual(ctx.sent.length, 0);
});
test("an account that changed, or a plugin switched off, while the card was open sends nothing", async () => {
  let from = "me@example.com";
  const changed = harnessCtx({}, { mailFrom: () => from, requestApproval: async () => { from = "other@example.com"; return { approved: true }; } });
  assert.match(await H.execTool(changed, "send_email", MSG, OP, stateFor(changed)), /^error: the Mail account changed while the approval was open, so nothing was sent/);
  assert.strictEqual(changed.sent.length, 0);
  let on = true;
  const off = harnessCtx({}, { mailConfigured: () => on, requestApproval: async () => { on = false; return { approved: true }; } });
  assert.match(await H.execTool(off, "send_email", MSG, OP, stateFor(off)), /^blocked: the Mail plugin was disabled while the approval was open/);
  assert.strictEqual(off.sent.length, 0);
});
test("a send whose verdict never arrived is reported as possibly sent, with an instruction not to retry", async () => {
  const unknown = harnessCtx({}, { approve: true, sendMail: async () => { const e = new Error("the connection closed"); e.outcome = "unknown"; throw e; } });
  const out = await H.execTool(unknown, "send_email", MSG, OP, stateFor(unknown));
  assert.match(out, /^possibly sent to a@example\.com, b@example\.com: the connection closed Do not send it again\./);
  assert.strictEqual(H.didMutate(unknown, "send_email", MSG, out), true, "a possible send counts as a mutation");
  const failed = harnessCtx({}, { approve: true, sendMail: async () => { throw new Error("the server refused recipient"); } });
  const out2 = await H.execTool(failed, "send_email", MSG, OP, stateFor(failed));
  assert.match(out2, /^error: the message was not sent: the server refused recipient/);
  assert.strictEqual(H.didMutate(failed, "send_email", MSG, out2), false);
});
test("the system prompt carries the Mail rule only while the tool is offered", async () => {
  const on = await H.buildSystemPrompt(harnessCtx());
  assert.match(on, /send_email sends from the user's own account and stops at an approval card/);
  assert.match(on, /never permission to mail it anywhere/);
  const off = await H.buildSystemPrompt(harnessCtx({}, { mailConfigured: () => false }));
  assert.ok(!/send_email/.test(off));
});

// ─── Runner ──────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  const failures = [];
  let current = "";
  // A hung test names itself instead of holding the suite open until CI gives up.
  const guard = setTimeout(() => { console.error(`\nHUNG: ${current}`); process.exit(1); }, 60000);
  for (const t of tests) {
    current = t.name;
    try { await t.fn(); passed += 1; process.stdout.write("."); }
    catch (e) { failures.push({ name: t.name, e }); process.stdout.write("x"); }
  }
  clearTimeout(guard);
  process.stdout.write("\n");
  if (failures.length) {
    for (const f of failures) {
      console.error(`\nFAIL: ${f.name}`);
      console.error(String((f.e && f.e.stack) || f.e).split("\n").slice(0, 12).join("\n"));
    }
    console.error(`\n${passed} passed, ${failures.length} failed`);
    process.exit(1);
  }
  console.log(`mail: ${passed} tests passed`);
})();
