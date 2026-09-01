/* Crowe Sense in the desktop app: a node's readings, written into the grower's
   own environment log as measured rows.

   The Cultivation space has said since 0.8 that "Crowe Sense will write room
   readings into this same store when it lands". This is that write. Nothing
   here replaces the hand-entered rows; a measured row sits beside them with
   `source: "crowe-sense"`, and the lane marks it, so a grower reading the
   Environment lane can tell what a person typed from what an instrument saw.

   Contract: ~/crowe-sense/contracts/telemetry-v1.md. Two ways to reach a node:
     direct  the node's own API on the LAN or tailnet, `url + path`, no auth
     cloud   the relay, `relay/v1/nodes/<node>` + path, with the Crowe ID bearer
   The per-node reads on the relay drop the leading `/v1` of the contract's
   `/v1/latest` and `/v1/history`, because the node id already sits under /v1.

   Pure functions first (endpoint, toEnvRecords, isStale) so scripts/test-sense.js
   can run them in plain node; the poller takes its fetch, config store and clock
   as dependencies for the same reason. */

const RELAY_DEFAULT = "https://sense.crowelogic.com";
const SOURCES = new Set(["off", "direct", "cloud"]);
const SENSE_DEFAULTS = Object.freeze({ source: "off", url: "", node: "", relay: RELAY_DEFAULT });
// The contract's /health calls a node down past 180 s without a reading.
const STALE_S = 180;
const POLL_MS = 60 * 1000;
const TIMEOUT_MS = 10 * 1000;

/* A closed set before anything reads it, the same rule loadConfig applies to
   the autonomy tier: a stored value nobody recognises lands on "off", not on
   whatever `||` reaches first. */
function normalizeSense(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = { ...SENSE_DEFAULTS };
  out.source = SOURCES.has(r.source) ? r.source : "off";
  out.url = String(r.url || "").trim().replace(/\/+$/, "");
  out.node = String(r.node || "").trim().toLowerCase();
  out.relay = String(r.relay || RELAY_DEFAULT).trim().replace(/\/+$/, "") || RELAY_DEFAULT;
  if (out.source === "direct" && !/^https?:\/\//i.test(out.url)) out.source = "off";
  if (out.source === "cloud" && !/^cs-[0-9a-f]{6}$/.test(out.node)) out.source = "off";
  return out;
}

function endpoint(cfg, path) {
  const c = normalizeSense(cfg);
  const p = String(path || "/health");
  if (c.source === "direct") return c.url + p;
  if (c.source === "cloud") return `${c.relay}/v1/nodes/${encodeURIComponent(c.node)}${p.replace(/^\/v1(?=\/)/, "")}`;
  return null;
}

/* Not rooms: the derived pseudo-zones the node API appends, the controller's
   own health, and the flow hood. A hood reading in the Environment lane would
   be a room that does not exist. */
function isRoomZone(zone) {
  const z = String(zone || "");
  if (!z) return false;
  if (z.endsWith("-derived")) return false;
  if (z === "pi" || z.endsWith("-pi")) return false;
  if (z === "hood-1" || z.startsWith("hood")) return false;
  return true;
}

const num = (o) => (o && typeof o === "object" && Number.isFinite(Number(o.value)) ? Number(o.value) : null);
const round1 = (v) => String(Math.round(v * 10) / 10);

/* One env record per room zone in a /api/data snapshot, keyed to the UTC hour
   so a minute-by-minute poll rewrites the hour's row instead of stacking sixty
   of them. Temperature is stored in Fahrenheit because that is what the lane
   and the grower's other rows use. */
function toEnvRecords(snapshot, node, now = Date.now()) {
  const out = [];
  if (!snapshot || typeof snapshot !== "object") return out;
  const d = new Date(now);
  const ymd = d.toISOString().slice(0, 10);
  const hour = String(d.getUTCHours()).padStart(2, "0");
  for (const zone of Object.keys(snapshot)) {
    if (!isRoomZone(zone)) continue;
    const s = snapshot[zone] || {};
    const t = num(s.temperature_c), rh = num(s.humidity_pct), co2 = num(s.co2_ppm);
    if (t === null && rh === null && co2 === null) continue;
    out.push({
      id: `sense:${zone}:${ymd}-${hour}`,
      room: zone,
      date: ymd,
      temp: t === null ? "" : round1(t * 9 / 5 + 32),
      rh: rh === null ? "" : round1(rh),
      co2: co2 === null ? "" : String(Math.round(co2)),
      fae: "",
      notes: `Crowe Sense ${node || "node"}`,
      source: "crowe-sense",
    });
  }
  return out;
}

function isStale(health, now = Date.now()) {
  if (!health || typeof health !== "object") return true;
  if (Number.isFinite(Number(health.age_s))) return Number(health.age_s) > STALE_S;
  if (Number.isFinite(Number(health.last_ts))) return now / 1000 - Number(health.last_ts) > STALE_S;
  return true;
}

function fmtAge(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/* The poller. `deps`:
     loadConfig()  -> the app config; reads .sense and, in cloud mode, .token
     saveConfig(p) -> persists a patch
     fetchImpl     -> fetch
     onRecords(rs) -> where the env rows go (main.js writes them to the store)
     onChange(s)   -> optional, told after every poll with status()
     now()         -> clock, for tests
     setInterval / clearInterval -> timers, for tests */
class SensePoller {
  constructor(deps) {
    this.deps = { now: () => Date.now(), setInterval, clearInterval, onChange: () => {}, ...deps };
    this.timer = null;
    this.health = null;
    this.lastPoll = 0;
    this.lastError = "";
    this.polling = false;
  }
  config() { return normalizeSense((this.deps.loadConfig() || {}).sense); }
  headers() {
    const h = { accept: "application/json" };
    if (this.config().source === "cloud") {
      const token = (this.deps.loadConfig() || {}).token;
      if (token) h.authorization = `Bearer ${token}`;
    }
    return h;
  }
  async get(path) {
    const url = endpoint(this.config(), path);
    if (!url) throw new Error("Crowe Sense is off");
    const r = await this.deps.fetchImpl(url, { headers: this.headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new Error(`Crowe Sense answered ${r.status} for ${path}`);
    return r.json();
  }
  async poll() {
    if (this.polling) return this.status();
    this.polling = true;
    const cfg = this.config();
    try {
      if (cfg.source === "off") { this.health = null; return this.status(); }
      const health = await this.get("/health");
      this.health = health && typeof health === "object" ? health : null;
      const data = await this.get("/api/data?hours=1");
      const records = toEnvRecords(data && data.snapshot, cfg.node || (health && health.node), this.deps.now());
      if (records.length) await this.deps.onRecords(records);
      this.lastError = "";
    } catch (e) {
      this.lastError = String((e && e.message) || e);
    } finally {
      this.lastPoll = this.deps.now();
      this.polling = false;
    }
    const s = this.status();
    try { this.deps.onChange(s); } catch { /* a listener's failure is not the poller's */ }
    return s;
  }
  start() {
    this.stop();
    if (this.config().source === "off") return;
    this.poll();
    this.timer = this.deps.setInterval(() => this.poll(), POLL_MS);
    if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
  }
  stop() {
    if (this.timer) { this.deps.clearInterval(this.timer); this.timer = null; }
  }
  status() {
    const config = this.config();
    return {
      config,
      health: this.health,
      lastPoll: this.lastPoll,
      lastError: this.lastError,
      stale: config.source === "off" ? false : isStale(this.health, this.deps.now()),
      running: Boolean(this.timer),
    };
  }
  configure(patch) {
    const merged = normalizeSense({ ...this.config(), ...(patch || {}) });
    this.deps.saveConfig({ sense: merged });
    this.health = null; this.lastError = ""; this.lastPoll = 0;
    this.start();
    return this.status();
  }
}

module.exports = { SENSE_DEFAULTS, RELAY_DEFAULT, STALE_S, POLL_MS, normalizeSense, endpoint, isRoomZone, toEnvRecords, isStale, fmtAge, SensePoller };
