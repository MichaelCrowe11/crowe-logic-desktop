// The desktop half of "Crowe Logic on your phone drives Crowe Logic on your
// desktop": a small authenticated HTTP listener that hands the phone the three
// things a phone cannot have — a shell, a file tree, and somewhere to write.
//
// This exists because the phone app was first pointed at Crowe Terminal, a
// separate FastAPI process the author happened to run under launchd. That works
// for one person and for nobody else: a customer would have to install a second
// server, find a tailnet address, and copy a token out of a dotfile. The desktop
// app already owns a shell, a file tree and a git checkout — it is the thing
// customers install — so the endpoint belongs here, and pairing becomes a QR
// code the desktop draws.
//
// Three properties this has to hold, because it is a remote shell:
//
//   bound narrowly   Tailscale by default. The tailnet is authenticated at the
//                    network layer and is not the public internet, so there is
//                    no port to forward and no listener a stranger can reach.
//                    Binding 0.0.0.0 would also put it on every coffee-shop LAN.
//   never open       The token is minted here, required on every call, and
//                    compared in constant time. No token, no listener: the
//                    server refuses to start rather than starting unguarded.
//   off by default   Nothing listens until the user turns it on. An app that
//                    silently opens a shell port on install is not one to trust.
//
// The request and response shapes match Crowe Terminal's deliberately, so a
// phone paired with either cannot tell the difference and mobile/src needs no
// second code path.

const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, execFileSync } = require("child_process");

const PORT = 8787;              // not 8765: that is the OAuth loopback's, and Crowe Terminal's
const MAX_STDOUT = 200_000;
const MAX_STDERR = 50_000;

/* Tailscale hands every device an address in 100.64.0.0/10, the CGNAT range.
   Reading it off the interface list rather than shelling out to `tailscale`
   means this works whether the CLI is on PATH, whether the app was launched
   from Finder with a minimal environment, and whether Tailscale was installed
   from the App Store (where the binary lives somewhere else entirely). */
function tailscaleAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const [x, y] = a.address.split(".").map(Number);
      if (x === 100 && y >= 64 && y <= 127) return a.address;
    }
  }
  return null;
}

/* The tailnet's own DNS name for this machine, e.g.
   michaels-macbook-pro.tailae09af.ts.net.

   Preferred over the bare 100.x address for one hard reason: iOS App Transport
   Security refuses cleartext HTTP, and the way to allow it for exactly this
   traffic is an NSExceptionDomains entry — which matches on domain names, not
   IP literals. A pairing URL built from the IP saves fine on the phone and then
   cannot be loaded at all ("the App Transport Security policy requires the use
   of a secure connection"), which is a failure that only appears on a device.

   The name is also the better identifier anyway: it survives a tailnet address
   changing, and it tells the user which machine they are pairing with.

   This one does need the CLI, since a DNS name is not readable off an
   interface. Absent it — Tailscale installed from the App Store puts the binary
   somewhere else, or MagicDNS is off — the address is the fallback, and the
   phone will say what ATS did rather than failing silently. */
function magicDnsName() {
  const candidates = [
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ];
  for (const bin of candidates) {
    try {
      if (!fs.existsSync(bin)) continue;
      const out = execFileSync(bin, ["status", "--json"], { encoding: "utf8", timeout: 4000 });
      const self = JSON.parse(out).Self || {};
      const name = String(self.DNSName || "").replace(/\.$/, "");
      if (name && name.includes(".")) return name;
    } catch { /* not this path, or Tailscale is not up */ }
  }
  return null;
}

// Constant-time compare, so a wrong token cannot be discovered a byte at a time
// by measuring how fast it is rejected.
function tokenMatches(given, expected) {
  const a = Buffer.from(String(given || ""), "utf8");
  const b = Buffer.from(String(expected || ""), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readJson(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

class Companion {
  constructor({ tokenFile, onEvent } = {}) {
    this.tokenFile = tokenFile;
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
    this.server = null;
    this.host = null;
    this.token = "";
  }

  /* The token outlives a restart, because a phone paired last week should not
     be silently unpaired by quitting the app. 0600 so it is not readable by
     other accounts on a shared machine. */
  loadOrMintToken() {
    if (this.token) return this.token;
    try {
      const saved = fs.readFileSync(this.tokenFile, "utf8").trim();
      if (saved.length >= 32) { this.token = saved; return this.token; }
    } catch { /* no token yet, or unreadable — mint a new one below */ }
    this.token = crypto.randomBytes(32).toString("hex");
    try {
      fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true });
      fs.writeFileSync(this.tokenFile, this.token, { mode: 0o600 });
    } catch { /* in-memory only; pairing still works until the app quits */ }
    return this.token;
  }

  // Rotating invalidates every paired phone, which is the point: it is what you
  // press when one is lost.
  rotateToken() {
    this.token = "";
    try { fs.unlinkSync(this.tokenFile); } catch { /* already gone */ }
    return this.loadOrMintToken();
  }

  status() {
    return {
      running: Boolean(this.server && this.server.listening),
      host: this.host, port: PORT,
      tailscale: tailscaleAddress(),
      name: this.name || magicDnsName(),
      paired: Boolean(this.token),
    };
  }

  // What the phone scans. The token travels inside the QR because the QR is on
  // the user's own screen for a few seconds — the same trust model as a printed
  // pairing code, and far better than typing 64 hex characters on a phone.
  pairUrl() {
    if (!this.host) return null;
    const reachable = this.name || this.host;
    const q = new URLSearchParams({ url: `http://${reachable}:${PORT}`, token: this.loadOrMintToken() });
    return `com.crowelogic.mobile://pair?${q.toString()}`;
  }

  async start() {
    if (this.server && this.server.listening) return this.status();
    const host = tailscaleAddress();
    if (!host) {
      return { error: "No Tailscale address on this machine. Install Tailscale and sign in, then try again — the phone reaches this app over the tailnet, not the open internet." };
    }
    this.loadOrMintToken();
    if (!this.token) return { error: "could not mint a pairing token" };

    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(PORT, host, resolve);
    }).catch((e) => {
      this.server = null;
      throw new Error(`could not listen on ${host}:${PORT} — ${String(e.message || e)}`);
    });
    this.host = host;
    this.name = magicDnsName();     // resolved once, while Tailscale is known up
    this.onEvent({ type: "started", host, name: this.name, port: PORT });
    return this.status();
  }

  async stop() {
    if (!this.server) return this.status();
    await new Promise((r) => this.server.close(r));
    this.server = null;
    this.host = null;
    this.onEvent({ type: "stopped" });
    return this.status();
  }

  send(res, code, body) {
    const text = JSON.stringify(body);
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://${this.host}`);

    // Health is the one unauthenticated route, and it says nothing: a caller
    // who cannot present the token learns that something is here and no more.
    if (url.pathname === "/health") return this.send(res, 200, { status: "ok", service: "crowe-logic-companion" });

    const auth = String(req.headers.authorization || "");
    if (!tokenMatches(auth.replace(/^Bearer\s+/i, ""), this.token)) {
      return this.send(res, 401, { detail: "invalid or missing bearer token" });
    }
    if (req.method !== "POST") return this.send(res, 405, { detail: "POST only" });

    let body;
    try { body = await readJson(req); }
    catch (e) { return this.send(res, 400, { detail: String(e.message || e) }); }

    try {
      if (url.pathname === "/run") return this.send(res, 200, await this.run(body));
      if (url.pathname === "/read_file") return this.send(res, 200, this.readFile(body));
      if (url.pathname === "/write_file") return this.send(res, 200, this.writeFile(body));
    } catch (e) {
      return this.send(res, e.status || 400, { detail: String(e.message || e) });
    }
    return this.send(res, 404, { detail: `no such route: ${url.pathname}` });
  }

  run(body) {
    const command = String(body.command || "").trim();
    if (!command) throw Object.assign(new Error("no command given"), { status: 400 });
    const timeout = Math.max(1, Math.min(600, Number(body.timeout) || 60)) * 1000;
    const cwd = body.cwd ? String(body.cwd).replace(/^~/, os.homedir()) : os.homedir();
    this.onEvent({ type: "run", command });
    return new Promise((resolve) => {
      // The user's login shell, so their PATH, aliases and version managers are
      // the ones in play — a command that works in their terminal works here.
      const shellPath = process.env.SHELL || "/bin/zsh";
      execFile(shellPath, ["-lc", command], { cwd, timeout, maxBuffer: MAX_STDOUT + MAX_STDERR },
        (err, stdout, stderr) => {
          const killed = err && (err.killed || err.signal);
          resolve({
            exit_code: killed ? 124 : (err && typeof err.code === "number" ? err.code : 0),
            stdout: String(stdout || "").slice(-MAX_STDOUT),
            stderr: killed ? `command exceeded ${timeout / 1000}s` : String(stderr || "").slice(-MAX_STDERR),
          });
        });
    });
  }

  readFile(body) {
    const p = String(body.path || "").replace(/^~/, os.homedir());
    if (!p) throw Object.assign(new Error("no path given"), { status: 400 });
    let stat;
    try { stat = fs.statSync(p); } catch { throw Object.assign(new Error(`not a file: ${p}`), { status: 404 }); }
    if (!stat.isFile()) throw Object.assign(new Error(`not a file: ${p}`), { status: 404 });
    const max = Math.max(1, Math.min(1_000_000, Number(body.max_bytes) || 100_000));
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(Math.min(max, stat.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return { path: p, truncated: stat.size > buf.length, content: buf.toString("utf8") };
    } finally { fs.closeSync(fd); }
  }

  writeFile(body) {
    const p = String(body.path || "").replace(/^~/, os.homedir());
    if (!p) throw Object.assign(new Error("no path given"), { status: 400 });
    const content = String(body.content ?? "");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    this.onEvent({ type: "write", path: p });
    return { path: p, bytes_written: Buffer.byteLength(content) };
  }
}

module.exports = { Companion, tailscaleAddress, magicDnsName, tokenMatches, PORT };
