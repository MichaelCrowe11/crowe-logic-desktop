"use strict";
/* Mail connector: password-based SMTP submission with no dependencies.

   Why a module and not an MCP server. plugins.builtin.json spawns a plugin's
   command verbatim, so a manifest entry is a statement of trust in a package.
   Every email server on npm at the time of writing failed that bar: the
   official-looking @modelcontextprotocol/server-email does not exist,
   mcp-server-email is a 0.0.1 with no README, smtp-mcp and email-mcp are
   single-maintainer releases with no repository field, and imap-mcp has one
   release whose only tool writes a draft. Rather than invent a package name,
   the Mail plugin's "server" is this file: the manifest still declares the
   credentials and the tier, main.js still holds the credentials, and the
   harness offers one tool, send_email.

   The profile is deliberately narrow. Submission only (RFC 5321 client, RFC
   4954 AUTH LOGIN or PLAIN), plain-text bodies, bare ASCII addresses. TLS is
   never optional: port 465 is implicit TLS, every other port must offer
   STARTTLS before a single credential byte leaves, and a failed handshake
   ends the attempt instead of falling back to plaintext. The password never
   appears in any error this module throws, even when a server echoes it.

   Outcomes are three, not two. A message is accepted when the final 250
   arrives after the terminator, not sent when anything fails before the
   terminator is written or the server answers it with a 4xx or 5xx, and
   unknown when the connection dies between the two or the final reply is not
   a verdict at all. Unknown is reported as such so nobody retries a message
   that may already be in the recipient's inbox. */
const net = require("net");
const tls = require("tls");
const crypto = require("crypto");

const PLUGIN_ID = "mail";
const TOOLS = ["send_email"];
const ENV = { host: "SMTP_HOST", user: "SMTP_USER", password: "SMTP_PASSWORD" };
const DEFAULT_PORT = 587;
const IMPLICIT_TLS_PORT = 465;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RECIPIENTS = 20;
const MAX_SUBJECT_CHARS = 200;
const MAX_BODY_CHARS = 20000;
const MAX_PASSWORD_CHARS = 1024;
const MAX_REPLY_LINE = 2048;
const MAX_REPLY_LINES = 64;
const MAX_HOST_CHARS = 253;
const HEADER_FOLD_AT = 78;
const ENCODED_WORD_BYTES = 39;      // 39 bytes -> 52 base64 chars + 12 of wrapper = 64: with "Subject: " in front the line stays under RFC 2047's 76 columns
const CONTROL_RE = /[\x00-\x1f\x7f]/;

const noop = () => {};
const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");

// ─── Addresses and endpoints ─────────────────────────────────────────────────
/* One local part, one @, a dotted domain, nothing else. Display names, quoted
   local parts, comments, and address literals are refused on purpose: a bare
   mailbox cannot smuggle a second header or a second recipient, and it is what
   an approval card can show without ambiguity. */
const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function isLabelSequence(s, minLabels) {
  if (typeof s !== "string" || !s || s.length > MAX_HOST_CHARS) return false;
  const labels = s.split(".");
  if (labels.length < minLabels) return false;
  return labels.every((l) => LABEL_RE.test(l)) && !/^\d+$/.test(labels[labels.length - 1]);
}
function isAddress(s) {
  if (typeof s !== "string" || s.length > 254) return false;
  const at = s.lastIndexOf("@");
  if (at < 1) return false;
  const local = s.slice(0, at), domain = s.slice(at + 1);
  return local.length <= 64 && LOCAL_RE.test(local) && isLabelSequence(domain, 2);
}
/* host, host:port, IPv4[:port], or [IPv6][:port]. Schemes, paths, user info,
   whitespace, and control characters are all refused rather than trimmed. */
function parseEndpoint(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s || CONTROL_RE.test(s) || /[\s/\\@]/.test(s)) return null;
  let host, portStr, m;
  if ((m = /^\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?$/.exec(s))) {
    host = m[1]; portStr = m[2];
    if (net.isIP(host) !== 6) return null;
  } else if ((m = /^([^:[\]]+)(?::(\d{1,5}))?$/.exec(s))) {
    host = m[1]; portStr = m[2];
    if (net.isIP(host) !== 4 && !isLabelSequence(host, 1)) return null;
  } else return null;
  const port = portStr ? Number(portStr) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}
/* The account the plugin env describes, or null when any piece is missing or
   malformed. The user must be a full address because it is also the envelope
   sender: a relay user name that is not a mailbox cannot be a From. */
function accountFromEnv(env) {
  const e = env && typeof env === "object" && !Array.isArray(env) ? env : {};
  const endpoint = parseEndpoint(e[ENV.host]);
  const user = String(e[ENV.user] == null ? "" : e[ENV.user]).trim();
  const password = typeof e[ENV.password] === "string" ? e[ENV.password] : "";
  if (!endpoint || !isAddress(user)) return null;
  if (!password || password.length > MAX_PASSWORD_CHARS || /[\x00\r\n]/.test(password)) return null;
  return { host: endpoint.host, port: endpoint.port, implicitTls: endpoint.port === IMPLICIT_TLS_PORT, user, password, from: user };
}
function isConfigured(env) { return accountFromEnv(env) !== null; }

// ─── The message ─────────────────────────────────────────────────────────────
/* Normalize the tool's arguments into exactly what will be sent, or say why it
   cannot be. Every refusal is a sentence the model can act on. Control
   characters in a subject are refused, not stripped: stripping would send
   something other than what the user approved. */
function normalizeMessage(args) {
  const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const list = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;\s]+/) : [])
    .map((s) => String(s == null ? "" : s).trim()).filter(Boolean);
  const to = [...new Set(list(a.to))];
  const cc = [...new Set(list(a.cc))].filter((c) => !to.includes(c));
  if (!to.length) return { error: "send_email needs at least one recipient in `to`." };
  const bad = [...to, ...cc].filter((s) => !isAddress(s));
  if (bad.length) return { error: `these are not bare mail addresses: ${bad.join(", ")}. Use user@example.com with no display name.` };
  if (to.length + cc.length > MAX_RECIPIENTS) return { error: `too many recipients (${to.length + cc.length}); the limit is ${MAX_RECIPIENTS} per message.` };
  if (typeof a.subject !== "string" || !a.subject.trim()) return { error: "send_email needs a subject." };
  const subject = a.subject.trim();
  if (CONTROL_RE.test(subject)) return { error: "the subject contains control characters (a line break or similar); write it on one line." };
  if (subject.length > MAX_SUBJECT_CHARS) return { error: `the subject is ${subject.length} characters; the limit is ${MAX_SUBJECT_CHARS}.` };
  const text = typeof a.body === "string" ? a.body : typeof a.text === "string" ? a.text : "";
  if (!text.trim()) return { error: "send_email needs a body." };
  if (text.includes("\x00")) return { error: "the body contains a NUL character." };
  if (text.length > MAX_BODY_CHARS) return { error: `the body is ${text.length} characters; the limit is ${MAX_BODY_CHARS}.` };
  return { to, cc, subject, text };
}

/* RFC 2047 for anything outside printable ASCII, one encoded word per 39 bytes
   of UTF-8 split on character boundaries so no word passes 75 characters and
   no line, the first one with its field name included, passes 76.
   Plain ASCII folds at spaces so the raw source stays readable. */
function subjectHeader(subject) {
  // Plain ASCII travels as written, unless it contains the "=?" that opens an
  // encoded word: a literal "=?UTF-8?B?SGk=?=" would otherwise display as "Hi".
  if (/^[\x20-\x7e]*$/.test(subject) && !subject.includes("=?")) return foldAtSpaces(`Subject: ${subject}`);
  const words = [];
  let chunk = "";
  for (const ch of subject) {
    if (chunk && Buffer.byteLength(chunk + ch, "utf8") > ENCODED_WORD_BYTES) { words.push(chunk); chunk = ""; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return "Subject: " + words.map((w) => `=?UTF-8?B?${b64(w)}?=`).join("\r\n ");
}
function foldAtSpaces(line) {
  const out = [];
  let cur = "";
  for (const word of line.split(" ")) {
    if (cur && cur.length + 1 + word.length > HEADER_FOLD_AT) { out.push(cur); cur = ` ${word}`; }
    else cur = cur ? `${cur} ${word}` : word;
  }
  out.push(cur);
  return out.join("\r\n");
}
function addressHeader(name, addrs) {
  const lines = [];
  let cur = `${name}:`;
  addrs.forEach((addr, i) => {
    const piece = ` ${addr}${i < addrs.length - 1 ? "," : ""}`;
    if (cur !== `${name}:` && cur.length + piece.length > HEADER_FOLD_AT) { lines.push(cur); cur = piece; }
    else cur += piece;
  });
  lines.push(cur);
  return lines.join("\r\n");
}
function rfc5322Date(d) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}
/* The wire form: CRLF throughout, a base64 body so no 8BITMIME negotiation is
   needed and no line can exceed the limit, and a Message-ID under the sender's
   own domain. Ends with CRLF so the DATA terminator can follow directly. */
function buildMessage(msg, opts = {}) {
  const domain = String(msg.from).split("@")[1] || "localhost";
  const messageId = opts.messageId || `${crypto.randomUUID()}@${domain}`;
  const canonical = String(msg.text).replace(/\r\n|\r|\n/g, "\r\n");
  const body = b64(canonical).replace(/(.{76})(?=.)/g, "$1\r\n");
  const headers = [
    `From: ${msg.from}`,
    addressHeader("To", msg.to),
    msg.cc && msg.cc.length ? addressHeader("Cc", msg.cc) : null,
    subjectHeader(msg.subject),
    `Date: ${rfc5322Date(opts.date || new Date())}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    opts.mailer && !CONTROL_RE.test(opts.mailer) ? `X-Mailer: ${opts.mailer}` : null,
  ].filter(Boolean);
  return { messageId, raw: `${headers.join("\r\n")}\r\n\r\n${body}\r\n` };
}
// RFC 5321 4.5.2: a line that begins with a period gets a second one, so the
// lone-period terminator cannot occur inside the text.
function dotStuff(raw) {
  return String(raw).split("\r\n").map((l) => (l.startsWith(".") ? `.${l}` : l)).join("\r\n");
}

// ─── The reply reader ────────────────────────────────────────────────────────
class SmtpError extends Error {
  constructor(message, { code = 0, outcome = "not_sent" } = {}) {
    super(message);
    this.name = "SmtpError";
    this.code = code;
    this.outcome = outcome;
  }
}
/* Replies are read by grammar, not by hope. CRLF only, a bounded line, a
   bounded number of continuation lines, one code per reply, and a complete
   reply is one whose last line has a space (or nothing) after the code. Any
   byte the grammar does not allow fails the attempt: the STARTTLS boundary in
   particular is where a lenient parser turns leftover plaintext into "the next
   reply", and this one refuses to. The buffer holds bytes, not decoded text,
   so "nothing buffered" at that boundary means no bytes at all, not "no
   complete characters". The first failure wins and is remembered, so a close
   that follows a timeout does not rewrite the reason. Every socket the attempt
   opens is tracked from the moment it exists, so the one timer can end a
   connect or a TLS handshake that never completes. */
function conversation(timeoutMs, onWire) {
  let socket = null, buf = Buffer.alloc(0), partial = [], failure = null, waiting = null, timer = null;
  const queue = [];
  const sockets = [];
  const track = (s) => { if (s && !sockets.includes(s)) { sockets.push(s); s.on("error", noop); } };
  const fail = (err) => {
    if (failure) return;
    failure = err;
    if (waiting) { const w = waiting; waiting = null; w.reject(err); }
  };
  const deliver = (reply) => {
    if (waiting) { const w = waiting; waiting = null; w.resolve(reply); }
    else queue.push(reply);
  };
  const onData = (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    buf = buf.length ? Buffer.concat([buf, bytes]) : bytes;
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > MAX_REPLY_LINE) fail(new SmtpError("the server sent a reply line longer than allowed"));
        return;
      }
      if (nl === 0 || buf[nl - 1] !== 0x0d) return fail(new SmtpError("the server sent a bare line feed"));
      const line = buf.subarray(0, nl - 1).toString("utf8");
      buf = buf.subarray(nl + 1);
      if (line.length > MAX_REPLY_LINE) return fail(new SmtpError("the server sent a reply line longer than allowed"));
      const m = /^(\d{3})(?:([ -])(.*))?$/.exec(line);
      if (!m) return fail(new SmtpError("the server sent a malformed reply"));
      if (partial.length && partial[0].code !== m[1]) return fail(new SmtpError("the server changed the code inside one reply"));
      partial.push({ code: m[1], text: m[3] || "" });
      if (partial.length > MAX_REPLY_LINES) return fail(new SmtpError("the server sent more reply lines than allowed"));
      if (m[2] === "-") continue;
      const lines = partial.map((p) => p.text);
      partial = [];
      deliver({ code: Number(m[1]), lines, text: lines.join(" ") });
    }
  };
  const onError = (e) => fail(new SmtpError(`connection error: ${(e && (e.code || e.message)) || "unknown"}`));
  const onClose = () => fail(new SmtpError("the server closed the connection"));
  return {
    track,
    attach(s) {
      socket = s; buf = Buffer.alloc(0); partial = [];
      track(s);
      s.on("data", onData); s.on("error", onError); s.on("close", onClose);
    },
    detach() {
      if (!socket) return;
      socket.off("data", onData); socket.off("error", onError); socket.off("close", onClose);
      socket = null;
    },
    attached() { return Boolean(socket) && !socket.destroyed && socket.writable; },
    clean() { return buf.length === 0 && partial.length === 0 && queue.length === 0; },
    read() {
      return new Promise((resolve, reject) => {
        if (queue.length) return resolve(queue.shift());
        if (failure) return reject(failure);
        waiting = { resolve, reject };
      });
    },
    // Both return whether anything was handed to the socket, so the caller
    // can tell "the line was down before the message" from "the message went
    // out and the line then died".
    write(line) {
      if (!this.attached()) return false;
      if (onWire) onWire(line);
      socket.write(`${line}\r\n`);
      return true;
    },
    writeRaw(data) {
      if (!this.attached()) return false;
      if (onWire) onWire(data);
      socket.write(data);
      return true;
    },
    fail,
    start() {
      timer = setTimeout(() => {
        fail(new SmtpError(`timed out after ${Math.round(timeoutMs / 1000)}s`));
        for (const s of sockets) { try { s.destroy(); } catch {} }
      }, timeoutMs);
    },
    stop() { clearTimeout(timer); },
    destroyAll() { for (const s of sockets) { try { s.destroy(); } catch {} } },
  };
}

// ─── Transport defaults (all injectable for tests) ───────────────────────────
function defaultConnect(host, port) {
  const s = net.connect({ host, port });
  s.setNoDelay(true);
  return s;
}
/* Waits for the raw connection before anything is layered on it, so a refused
   port is one clear error and not a handshake that never starts. */
function connected(socket) {
  return new Promise((resolve, reject) => {
    socket.on("error", noop);
    if (!socket.connecting && socket.readyState === "open") return resolve(socket);
    const off = () => { socket.off("connect", onOk); socket.off("error", onErr); socket.off("close", onErr); };
    const onOk = () => { off(); resolve(socket); };
    const onErr = (e) => { off(); reject(new SmtpError(`could not connect: ${(e && (e.code || e.message)) || "the connection closed"}`)); };
    socket.once("connect", onOk);
    socket.once("error", onErr);
    socket.once("close", onErr);
  });
}
/* Certificate verification is on and the expected identity is the configured
   host: SNI carries the name for host names and is omitted for IP endpoints,
   where the certificate must carry the address itself. tlsOptions exists for
   the test suite's own certificate authority and is not reachable from a
   manifest, a config file, or a tool call. */
function defaultUpgradeTls(socket, host, tlsOptions) {
  return new Promise((resolve, reject) => {
    const opts = { socket, host, minVersion: "TLSv1.2", rejectUnauthorized: true, ...(tlsOptions || {}) };
    if (!net.isIP(host)) opts.servername = host;
    let s;
    try { s = tls.connect(opts); } catch (e) { return reject(new SmtpError(`TLS to ${host} failed: ${e.code || e.message}`)); }
    s.on("error", noop);
    let settled = false;
    const settle = (fn) => (v) => { if (settled) return; settled = true; socket.off("close", closed); fn(v); };
    const closed = settle(() => reject(new SmtpError(`TLS to ${host} failed: the connection closed during the handshake`)));
    s.once("secureConnect", settle(() => resolve(s)));
    s.once("error", settle((e) => reject(new SmtpError(`TLS to ${host} failed: ${(e && (e.code || e.message)) || "unknown"}`))));
    s.once("close", closed);
    // The plain socket underneath is the one the attempt's timer destroys.
    socket.once("close", closed);
  });
}
/* EHLO names the client. An address literal built from the socket's own
   address says nothing false and discloses no internal host name. */
function clientNameFor(socket) {
  const a = socket && socket.localAddress;
  const v4 = String(a || "").replace(/^::ffff:/i, "");
  if (net.isIP(v4) === 4) return `[${v4}]`;
  if (net.isIP(a) === 6) return `[IPv6:${a}]`;
  return "[127.0.0.1]";
}
function parseExtensions(lines) {
  const map = new Map();
  for (const l of lines.slice(1)) {
    const [kw, ...params] = String(l).trim().split(/\s+/);
    if (kw) map.set(kw.toUpperCase(), params.map((p) => p.toUpperCase()));
  }
  return map;
}

// ─── Sending ─────────────────────────────────────────────────────────────────
/* account comes from accountFromEnv; message is the tool's arguments; io is
   for tests (connect, upgradeTls, tlsOptions, timeoutMs, clientName, onWire,
   date, messageId) and for main.js (mailer). onWire sees every frame the
   client writes, credentials included, and exists for the test suite alone:
   nothing in the app passes it. Resolves to
   { outcome: "accepted", accepted, from, messageId, response } or throws an
   SmtpError whose .outcome is "not_sent" or "unknown". */
async function sendMail(account, message, io = {}) {
  if (!account || !account.host || !account.from || !account.password)
    throw new SmtpError("the Mail plugin has no complete account: it needs the SMTP host, the mail address, and the app password");
  const m = normalizeMessage(message);
  if (m.error) throw new SmtpError(m.error);
  const rcpts = [...m.to, ...m.cc];
  const timeoutMs = Number(io.timeoutMs) > 0 ? Number(io.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const connect = io.connect || defaultConnect;
  const upgrade = io.upgradeTls || defaultUpgradeTls;
  const conv = conversation(timeoutMs, io.onWire || null);
  /* Server text is untrusted input and a server may echo what it was sent.
     Anything derived from the password is scrubbed from every message that
     leaves this function, and AUTH replies are never quoted at all. */
  const secrets = [account.password, b64(account.password), b64(`\x00${account.user}\x00${account.password}`)];
  const redact = (text) => {
    let out = String(text == null ? "" : text);
    for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
    // Bounded after the scrub, not before: a cut through the middle of a
    // secret would otherwise leave its first half in the message.
    return out.slice(0, 300).replace(/[\x00-\x1f\x7f]/g, " ").trim();
  };
  let submitted = false, confirmed = false;
  const expect = async (codes, what) => {
    const r = await conv.read();
    if (!codes.includes(r.code)) throw new SmtpError(`${what} (${r.code} ${redact(r.text)})`, { code: r.code });
    return r;
  };
  const authExpect = async (code) => {
    const r = await conv.read();
    if (r.code !== code) {
      const enhanced = /\b[245]\.\d{1,3}\.\d{1,3}\b/.exec(r.text);
      throw new SmtpError(`the server rejected the credentials (${r.code}${enhanced ? ` ${enhanced[0]}` : ""}). Check the mail address and the app password.`, { code: r.code });
    }
    return r;
  };
  conv.start();
  let socket = null, connectTimer = null;
  try {
    const raw = connect(account.host, account.port);
    conv.track(raw);
    socket = await Promise.race([
      connected(raw),
      new Promise((_, reject) => { connectTimer = setTimeout(() => reject(new SmtpError(`timed out after ${Math.round(timeoutMs / 1000)}s connecting to ${account.host}:${account.port}`)), timeoutMs); }),
    ]);
    clearTimeout(connectTimer);
    if (account.implicitTls) socket = await upgrade(socket, account.host, io.tlsOptions);
    conv.attach(socket);
    await expect([220], "the server did not greet");
    const clientName = io.clientName || clientNameFor(socket);
    conv.write(`EHLO ${clientName}`);
    let ehlo = await expect([250], "the server refused EHLO");
    if (!account.implicitTls) {
      if (!parseExtensions(ehlo.lines).has("STARTTLS"))
        throw new SmtpError(`${account.host}:${account.port} did not offer STARTTLS, so the password was not sent. Use a host and port that support TLS (587 with STARTTLS or 465).`);
      conv.write("STARTTLS");
      await expect([220], "the server refused STARTTLS");
      if (!conv.clean()) throw new SmtpError("the server sent data across the STARTTLS boundary");
      conv.detach();
      socket = await upgrade(socket, account.host, io.tlsOptions);
      conv.attach(socket);
      // Capabilities seen in the clear are forgotten: only what the server says
      // inside TLS decides how the credentials travel.
      conv.write(`EHLO ${clientName}`);
      ehlo = await expect([250], "the server refused EHLO after STARTTLS");
    }
    const mechs = parseExtensions(ehlo.lines).get("AUTH") || [];
    if (mechs.includes("LOGIN")) {
      conv.write("AUTH LOGIN");
      await authExpect(334);
      conv.write(b64(account.user));
      await authExpect(334);
      conv.write(b64(account.password));
      await authExpect(235);
    } else if (mechs.includes("PLAIN")) {
      conv.write(`AUTH PLAIN ${b64(`\x00${account.user}\x00${account.password}`)}`);
      await authExpect(235);
    } else {
      throw new SmtpError("the server offers no password sign-in (AUTH LOGIN or PLAIN) inside TLS, so this account cannot be used here.");
    }
    conv.write(`MAIL FROM:<${account.from}>`);
    await expect([250], "the server refused the sender");
    for (const rcpt of rcpts) {
      conv.write(`RCPT TO:<${rcpt}>`);
      const r = await conv.read();
      if (r.code !== 250 && r.code !== 251) throw new SmtpError(`the server refused recipient ${rcpt} (${r.code} ${redact(r.text)})`, { code: r.code });
    }
    conv.write("DATA");
    await expect([354], "the server refused DATA");
    const built = buildMessage({ from: account.from, to: m.to, cc: m.cc, subject: m.subject, text: m.text },
      { date: io.date, messageId: io.messageId, mailer: io.mailer });
    submitted = conv.writeRaw(`${dotStuff(built.raw)}.\r\n`);
    if (!submitted) throw new SmtpError("the connection was gone before the message was written");
    const fin = await conv.read();
    // Only 250 is acceptance. A 4xx or 5xx is a refusal; any other code is a
    // server speaking outside the grammar, and the message's fate is unknown.
    if (fin.code !== 250) throw new SmtpError(`the server did not accept the message (${fin.code} ${redact(fin.text)})`, { code: fin.code, outcome: fin.code >= 400 ? "not_sent" : "unknown" });
    confirmed = true;
    // Accepted is accepted: a QUIT that goes wrong, or is never answered,
    // changes nothing about it and gets two seconds, not the whole deadline.
    try {
      conv.write("QUIT");
      await Promise.race([conv.read(), new Promise((r) => setTimeout(r, 2000).unref())]);
    } catch {}
    return { outcome: "accepted", accepted: rcpts, from: account.from, messageId: built.messageId, response: redact(fin.text) };
  } catch (e) {
    const err = e instanceof SmtpError ? e : new SmtpError(`connection failed: ${redact((e && (e.code || e.message)) || "unknown")}`);
    err.message = redact(err.message) || "the send failed";
    if (submitted && !confirmed) {
      if (!err.code) err.outcome = "unknown";
      if (err.outcome === "unknown") err.message = `the message was submitted and the server never confirmed it (${err.message}). It may have been sent.`;
    }
    if (!submitted) { try { conv.write("QUIT"); } catch {} }
    throw err;
  } finally {
    clearTimeout(connectTimer);
    conv.stop();
    conv.detach();
    conv.destroyAll();
  }
}

module.exports = {
  PLUGIN_ID, TOOLS, ENV, ENV_KEYS: Object.values(ENV),
  DEFAULT_PORT, IMPLICIT_TLS_PORT, MAX_RECIPIENTS, MAX_SUBJECT_CHARS, MAX_BODY_CHARS,
  isAddress, parseEndpoint, accountFromEnv, isConfigured,
  normalizeMessage, buildMessage, dotStuff, subjectHeader, addressHeader, rfc5322Date, parseExtensions, clientNameFor,
  sendMail, SmtpError,
};
