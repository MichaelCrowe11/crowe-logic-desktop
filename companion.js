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
  /* `loopback` and `port` exist for scripts/test-companion.js, which drives the
     real bridge against a real instance of this and cannot depend on the
     machine running it being on a tailnet. Loopback is the one address that is
     safe to bind unconditionally — it is not reachable from another machine at
     all — and port 0 lets the OS pick a free one so a test never collides with
     a companion the user has actually started. */
  constructor({ tokenFile, onEvent, loopback = false, port = PORT, keepAwake = null } = {}) {
    this.tokenFile = tokenFile;
    /* A phone can only reach a machine that is awake. A closed laptop answers
       nothing, and the phone's only clue is a timeout — which is the feature's
       most ordinary failure and looked, all night, exactly like a bug.

       So while the companion is listening, the machine is held awake. Injected
       rather than imported because this file is plain node and testable that
       way; main.js passes Electron's powerSaveBlocker. It stops the moment the
       companion does, and it is worth saying in the UI, because a laptop that
       will not sleep is a battery complaint waiting to happen. */
    this.keepAwake = keepAwake;
    this.awakeId = null;
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
    this.loopback = Boolean(loopback);
    this.port = port;
    this.server = null;
    this.host = null;
    this.token = "";
  }

  /* One token per device, not one token.

     A single shared secret made "I lost my phone" and "unpair everything I own"
     the same action. With a device each, revoking the lost one leaves the iPad
     and the second Mac working, and the log can say which device ran what
     rather than only that something did.

     The tokens are stored as written rather than hashed, which is the weaker of
     the two options and chosen deliberately: hashing would mean a pairing code
     could never be shown twice, and a QR you cannot redisplay is a QR people
     photograph. The file is 0600 in userData — the same exposure the single
     token already had, and the same as every other credential this app keeps.

     Devices outlive a restart, because a phone paired last week should not be
     silently unpaired by quitting the app. */
  devicesPath() { return this.tokenFile.replace(/\.token$/, "") + ".devices.json"; }

  loadDevices() {
    if (this.devices) return this.devices;
    try {
      const raw = JSON.parse(fs.readFileSync(this.devicesPath(), "utf8"));
      if (Array.isArray(raw)) { this.devices = raw; return this.devices; }
    } catch { /* none yet, or unreadable */ }
    // A single token from before this existed becomes the first device, so an
    // upgrade does not silently unpair the phone already in someone's pocket.
    this.devices = [];
    try {
      const legacy = fs.readFileSync(this.tokenFile, "utf8").trim();
      if (legacy.length >= 32) {
        this.devices.push({ id: crypto.randomUUID(), name: "Paired device", token: legacy, created: Date.now(), lastSeen: null });
        this.saveDevices();
      }
    } catch { /* nothing to carry over */ }
    return this.devices;
  }

  saveDevices() {
    try {
      fs.mkdirSync(path.dirname(this.devicesPath()), { recursive: true });
      fs.writeFileSync(this.devicesPath(), JSON.stringify(this.devices, null, 1), { mode: 0o600 });
    } catch { /* in memory only; pairing still works until the app quits */ }
  }

  addDevice(name) {
    const devices = this.loadDevices();
    const device = {
      id: crypto.randomUUID(),
      name: String(name || "").trim() || `Device ${devices.length + 1}`,
      token: crypto.randomBytes(32).toString("hex"),
      created: Date.now(),
      lastSeen: null,
    };
    devices.push(device);
    this.saveDevices();
    this.onEvent({ type: "device-added", id: device.id, name: device.name });
    return device;
  }

  revokeDevice(id) {
    const devices = this.loadDevices();
    const at = devices.findIndex((d) => d.id === id);
    if (at < 0) return { error: "no such device" };
    const [gone] = devices.splice(at, 1);
    this.saveDevices();
    this.onEvent({ type: "device-revoked", id: gone.id, name: gone.name });
    return { ok: true, name: gone.name };
  }

  // Never the tokens. This is what the Settings pane lists.
  deviceList() {
    return this.loadDevices().map(({ id, name, created, lastSeen }) => ({ id, name, created, lastSeen }));
  }

  // Constant-time against every device, and the loop does not stop early: a
  // wrong token should cost the same whether it nearly matched the first
  // device or none of them.
  deviceFor(bearer) {
    let found = null;
    for (const d of this.loadDevices()) if (tokenMatches(bearer, d.token)) found = d;
    return found;
  }

  loadOrMintToken() {
    const devices = this.loadDevices();
    const device = devices[devices.length - 1] || this.addDevice("First device");
    return device.token;
  }

  // Kept for the case the device list cannot answer: revoke everything at once.
  rotateToken() {
    this.devices = [];
    this.saveDevices();
    try { fs.unlinkSync(this.tokenFile); } catch { /* already gone */ }
    return this.loadOrMintToken();
  }

  /* What ran, when, and which device asked.

     A shell drivable from a pocket needs a record its owner can read. Events
     already went to the window, where they scrolled past and were gone; this
     survives a restart and can be read the morning after. JSONL so it can be
     grepped with the same shell it is recording. */
  auditPath() { return this.tokenFile.replace(/\.token$/, "") + ".audit.jsonl"; }

  audit(entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
    try {
      fs.mkdirSync(path.dirname(this.auditPath()), { recursive: true });
      fs.appendFileSync(this.auditPath(), line, { mode: 0o600 });
    } catch { /* the log is not worth failing a command over */ }
  }

  recentAudit(limit = 50) {
    try {
      const lines = fs.readFileSync(this.auditPath(), "utf8").trim().split("\n");
      return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    } catch { return []; }
  }

  status() {
    return {
      running: Boolean(this.server && this.server.listening),
      host: this.host, port: this.port,
      tailscale: tailscaleAddress(),
      name: this.name || magicDnsName(),
      keepingAwake: this.awakeId !== null,
      devices: this.deviceList(),
      paired: this.loadDevices().length > 0,
    };
  }

  // What the phone scans. The token travels inside the QR because the QR is on
  // the user's own screen for a few seconds — the same trust model as a printed
  // pairing code, and far better than typing 64 hex characters on a phone.
  pairUrl() {
    const devices = this.loadDevices();
    return this.pairUrlFor(devices[devices.length - 1] || this.addDevice("First device"));
  }

  // The code for one named device, so two phones never share a credential.
  pairUrlFor(device) {
    if (!this.host || !device) return null;
    const reachable = this.name || this.host;
    const q = new URLSearchParams({ url: `http://${reachable}:${this.port}`, token: device.token });
    return `com.crowelogic.mobile://pair?${q.toString()}`;
  }

  async start() {
    if (this.server && this.server.listening) return this.status();
    const host = this.loopback ? "127.0.0.1" : tailscaleAddress();
    if (!host) {
      return { error: "No Tailscale address on this machine. Install Tailscale and sign in, then try again — the phone reaches this app over the tailnet, not the open internet." };
    }
    // Asks the device registry, not the old single-token field: nothing writes
    // this.token any more, so guarding on it refused to start every time.
    if (!this.loadOrMintToken()) return { error: "could not mint a pairing token" };

    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, host, resolve);
    }).catch((e) => {
      this.server = null;
      throw new Error(`could not listen on ${host}:${this.port} — ${String(e.message || e)}`);
    });
    this.host = host;
    this.port = this.server.address().port;   // port 0 means the OS chose one
    this.name = this.loopback ? null : magicDnsName();
    if (this.keepAwake) {
      try { this.awakeId = this.keepAwake.start("prevent-app-suspension"); }
      catch { this.awakeId = null; }      // not fatal: the phone still reaches it while awake
    }
    this.onEvent({ type: "started", host, name: this.name, port: this.port, keepingAwake: this.awakeId !== null });
    return this.status();
  }

  async stop() {
    if (!this.server) return this.status();
    await new Promise((r) => this.server.close(r));
    this.server = null;
    this.host = null;
    if (this.keepAwake && this.awakeId !== null) {
      try { this.keepAwake.stop(this.awakeId); } catch { /* already released */ }
      this.awakeId = null;
    }
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
    const device = this.deviceFor(auth.replace(/^Bearer\s+/i, ""));
    if (!device) {
      // Logged, because repeated failures from inside a tailnet are worth
      // seeing: it means a revoked device is still trying, or one that never
      // should have had a token.
      this.audit({ kind: "denied", path: url.pathname, reason: "bad or missing token" });
      return this.send(res, 401, { detail: "invalid or missing bearer token" });
    }
    device.lastSeen = Date.now();
    this.saveDevices();
    if (req.method !== "POST") return this.send(res, 405, { detail: "POST only" });

    let body;
    try { body = await readJson(req); }
    catch (e) { return this.send(res, 400, { detail: String(e.message || e) }); }

    try {
      if (url.pathname === "/run") {
        const result = await this.run(body);
        this.audit({ kind: "run", device: device.name, deviceId: device.id,
                     command: String(body.command || "").slice(0, 500), exit: result.exit_code });
        return this.send(res, 200, result);
      }
      if (url.pathname === "/read_file") {
        const result = this.readFile(body);
        this.audit({ kind: "read", device: device.name, deviceId: device.id, path: result.path });
        return this.send(res, 200, result);
      }
      if (url.pathname === "/write_file") {
        const result = this.writeFile(body);
        this.audit({ kind: "write", device: device.name, deviceId: device.id,
                     path: result.path, bytes: result.bytes_written });
        return this.send(res, 200, result);
      }
    } catch (e) {
      this.audit({ kind: "error", device: device.name, path: url.pathname, detail: String(e.message || e).slice(0, 200) });
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
      /* stdin is /dev/null, not an open pipe.

         With a pipe nobody writes to, a program that reads stdin waits forever
         and only the timeout ends it — which is how `claude` on a phone became
         two minutes of a frozen console. Closed, it gets EOF immediately and
         exits like any other command run without a terminal. The guard on the
         phone is then a courtesy that explains the failure early rather than
         the only thing between the user and a hang. */
      // `exec < /dev/null` first, so stdin is already at EOF when the command
      // starts rather than a descriptor it has to probe. Closing the pipe alone
      // still cost three seconds per command on anything that waits politely
      // for input before giving up. Pipes inside the command are unaffected —
      // this sets the shell's own stdin, not theirs.
      execFile(shellPath, ["-lc", `exec < /dev/null; ${command}`], { cwd, timeout, maxBuffer: MAX_STDOUT + MAX_STDERR,
                                              stdio: ["ignore", "pipe", "pipe"] },
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
