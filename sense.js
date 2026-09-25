/* Crowe Sense telemetry-v1 adapter. Network reachability and quality:"ok" do
   not prove physical hardware. Preserve per-sensor observations separately from
   the legacy env projection; never alter the grow/farm log schema. */
const RELAY_DEFAULT = "https://sense.crowelogic.com";
const SOURCES = new Set(["off", "direct", "cloud"]);
const SENSE_DEFAULTS = Object.freeze({ source: "off", url: "", node: "", relay: RELAY_DEFAULT });
const STALE_S = 180;
const POLL_MS = 60 * 1000;
const TIMEOUT_MS = 10 * 1000;
const NODE = /^cs-[0-9a-f]{6}$/;
const QUALITIES = new Set(["ok", "warming", "stale", "est", "fault"]);
// Documented presenter fixtures, not evidence of deployed physical sensors.
const SCRIPTED_NODES = new Set(["cs-7a1f04", "cs-3c9e22", "cs-b5d810"]);
const ROOM_METRICS = { temperature_c: "C", humidity_pct: "%", co2_ppm: "ppm" };
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const text = (v, max = 200) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const timestamp = (v) => finite(v) && v > 0 && v * 1000 <= 8640000000000000;
const round1 = (v) => String(Math.round(v * 10) / 10);

function baseURL(value, cloud = false) {
  try {
    const u = new URL(value);
    if (u.username || u.password || u.search || u.hash || !["http:", "https:"].includes(u.protocol)) return null;
    // A fixed origin, not a suffix match or a renderer-controlled allowlist.
    if (cloud && (u.origin !== RELAY_DEFAULT || u.pathname !== "/")) return null;
    return u.href.replace(/\/+$/, "");
  } catch { return null; }
}
function normalizeSense(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = { ...SENSE_DEFAULTS };
  out.source = SOURCES.has(r.source) ? r.source : "off";
  out.url = typeof r.url === "string" ? r.url.trim().replace(/\/+$/, "") : "";
  out.node = typeof r.node === "string" ? r.node.trim().toLowerCase() : "";
  out.relay = typeof r.relay === "string" && r.relay.trim() ? r.relay.trim().replace(/\/+$/, "") : RELAY_DEFAULT;
  if (out.source === "direct") {
    const url = baseURL(out.url);
    if (!url) out.source = "off";
    else out.url = url;
  }
  if (out.source === "cloud") {
    const relay = baseURL(out.relay, true);
    if (!relay || !NODE.test(out.node)) out.source = "off";
    else out.relay = relay;
  }
  return out;
}
function endpoint(cfg, path) {
  const c = normalizeSense(cfg);
  const p = String(path || "/health");
  // No absolute URLs, traversal or URL-parser normalization at this boundary.
  if (!/^\/(?:health|api\/data|v1\/(?:latest|history))(?:\?[^#\\\s]*)?$/.test(p)) throw new Error("Unsupported Crowe Sense read path");
  if (c.source === "direct") return c.url + p;
  if (c.source === "cloud") return `${c.relay}/v1/nodes/${c.node}${p.replace(/^\/v1(?=\/)/, "")}`;
  return null;
}
function isRoomZone(zone) {
  if (!text(zone)) return false;
  return !zone.endsWith("-derived") && zone !== "pi" && !zone.endsWith("-pi") && !zone.startsWith("hood");
}
function provenanceFor(reading, context) {
  const raw = reading.provenance ?? context.provenance;
  const reported = typeof raw === "string" ? raw.slice(0, 200) :
    raw && typeof raw === "object" ? [raw.kind, raw.source, raw.label, raw.reported].filter((v) => typeof v === "string").join(" / ").slice(0, 600) : "";
  const scripted = SCRIPTED_NODES.has(reading.node) || /\b(scripted|synthetic|simulated|simulation|demo|fixture)\b/i.test(reported);
  return { kind: scripted ? "scripted" : "unknown", reported,
    transport: ["direct", "cloud"].includes(context.transport) ? context.transport : "unknown" };
}
function observationStale(o, now) {
  return !timestamp(o.ts) || !finite(now) || o.ts * 1000 > now || now / 1000 - o.ts > STALE_S || o.quality === "stale" || o.quality === "fault";
}
/* Returns validated contract readings, preserving sensor identity and source ts.
   Missing/invalid readings are omitted, not coerced to zero. Expected `node`
   is optional; if supplied a mismatched node is rejected. `provenance` is only
   a reported label, never a trusted hardware attestation. */
function toObservations(readings, context = {}) {
  const now = context.now ?? Date.now();
  if (!Array.isArray(readings)) return [];
  const out = [];
  for (const r of readings) {
    if (!r || typeof r !== "object" || typeof r.node !== "string" || !NODE.test(r.node) || (context.node && r.node !== context.node) ||
        !text(r.zone) || !text(r.sensor) || !text(r.metric) || typeof r.unit !== "string" || r.unit.length > 40 ||
        !finite(r.value) || !timestamp(r.ts) || !QUALITIES.has(r.quality)) continue;
    const o = { ts: r.ts, node: r.node, zone: r.zone, sensor: r.sensor, metric: r.metric,
      value: r.value, unit: r.unit, quality: r.quality, provenance: provenanceFor(r, context) };
    o.id = `sense-observation:${[o.node, o.zone, o.sensor, o.metric, String(o.ts)].map(encodeURIComponent).join(":")}`;
    o.age_s = now / 1000 - o.ts;
    o.stale = observationStale(o, now);
    out.push(o);
  }
  return out;
}
/* Legacy snapshot compatibility requires an actual source timestamp: either a
   metric's ts or envelope.generated minus metric.age. Poll time is NOT a source
   timestamp. Snapshot's missing sensor identity is explicitly "unknown". */
function snapshotObservations(input, node, now, context) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const envelope = input.snapshot && typeof input.snapshot === "object" ? input : null;
  const snapshot = envelope ? envelope.snapshot : input;
  const generated = envelope ? envelope.generated : context.generated;
  const readings = [];
  for (const [zone, metrics] of Object.entries(snapshot)) {
    if (!metrics || typeof metrics !== "object") continue;
    for (const [metric, r] of Object.entries(metrics)) {
      if (!r || typeof r !== "object") continue;
      const ts = timestamp(r.ts) ? r.ts : timestamp(generated) && finite(r.age) && r.age >= 0 ? generated - r.age : null;
      readings.push({ ...r, ts, node: r.node || node || (envelope && envelope.node), zone, metric, sensor: r.sensor || "unknown" });
    }
  }
  return toObservations(readings, { ...context, provenance: context.provenance ?? (envelope && envelope.provenance), node: node || (envelope && envelope.node), now });
}
/* Existing env field set only. One row per node/room/source UTC hour; select
   the newest usable reading per metric (sensor-name tie break). All individual
   sensors remain in toObservations/status, even if they share a room/metric. */
function usableRoomObservation(o, now) {
  return isRoomZone(o.zone) && o.sensor !== "derived" && o.sensor !== "pi" && o.quality === "ok" && !observationStale(o, now) &&
    Object.hasOwn(ROOM_METRICS, o.metric) && ROOM_METRICS[o.metric] === o.unit &&
    finite(o.metric === "temperature_c" ? (o.value * 9 / 5 + 32) * 10 : o.value * 10);
}
function observationsToEnvRecords(observations, now) {
  const groups = new Map();
  for (const o of observations) {
    if (!usableRoomObservation(o, now)) continue;
    const d = new Date(o.ts * 1000).toISOString();
    const id = `sense:${encodeURIComponent(o.node)}:${encodeURIComponent(o.zone)}:${d.slice(0, 10)}-${d.slice(11, 13)}`;
    if (!groups.has(id)) groups.set(id, { id, zone: o.zone, date: d.slice(0, 10), node: o.node, metrics: new Map() });
    const g = groups.get(id), old = g.metrics.get(o.metric);
    if (!old || o.ts > old.ts || (o.ts === old.ts && o.sensor < old.sensor)) g.metrics.set(o.metric, o);
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)).map((g) => {
    const t = g.metrics.get("temperature_c"), rh = g.metrics.get("humidity_pct"), co2 = g.metrics.get("co2_ppm");
    const selected = [...g.metrics.values()].sort((a, b) => a.metric.localeCompare(b.metric));
    const kind = selected.some((o) => o.provenance.kind === "scripted") ? "scripted" : "unknown";
    return { id: g.id, room: g.zone, date: g.date,
      temp: t ? round1(t.value * 9 / 5 + 32) : "", rh: rh ? round1(rh.value) : "", co2: co2 ? String(Math.round(co2.value)) : "", fae: "",
      notes: `Crowe Sense ${g.node}; provenance: ${kind}; ${selected.map((o) => `${o.metric}=${o.sensor} (${o.quality}, ${new Date(o.ts * 1000).toISOString()})`).join("; ")}`,
      source: "crowe-sense" };
  });
}
function toEnvRecords(input, node, now = Date.now(), context = {}) {
  const observations = Array.isArray(input) ? toObservations(input, { ...context, node, now }) : snapshotObservations(input, node, now, context);
  return observationsToEnvRecords(observations, now);
}
function isStale(health, now = Date.now()) {
  if (!health || typeof health !== "object" || health.ok === false || !finite(now)) return true;
  // last_ts is authoritative over an age captured on a prior poll.
  if (timestamp(health.last_ts)) return health.last_ts * 1000 > now || now / 1000 - health.last_ts > STALE_S;
  if (health.last_ts !== undefined && health.last_ts !== null) return true;
  return !finite(health.age_s) || health.age_s < 0 || health.age_s > STALE_S;
}
function fmtAge(seconds) {
  if (!finite(seconds) || seconds < 0) return "unknown age";
  const s = Math.round(seconds);
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/* Injected deps: loadConfig, saveConfig, fetchImpl, onRecords; optional
   onObservations(observations, {signal,isCurrent}), onChange, now and timers.
   Sinks are invoked only while current; asynchronous sinks must honor signal /
   isCurrent before committing. Already committed external writes cannot be undone. */
class SensePoller {
  constructor(deps) {
    this.deps = { now: () => Date.now(), setInterval, clearInterval, onChange: () => {}, onObservations: () => {}, ...deps };
    this.timer = null;
    this.health = null;
    this.healthReceivedAt = null;
    this.observations = [];
    this.lastPoll = 0;
    this.lastError = "";
    this.polling = false;
    this.generation = 0;
    this.active = null;
  }
  config() { return normalizeSense((this.deps.loadConfig() || {}).sense); }
  async get(path, run) {
    const url = endpoint(run.cfg, path);
    if (!url) throw new Error("Crowe Sense is off");
    const headers = { accept: "application/json" };
    if (run.cfg.source === "cloud" && run.token) headers.authorization = `Bearer ${run.token}`;
    const signal = AbortSignal.any([run.controller.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    const r = await this.deps.fetchImpl(url, { headers, signal, redirect: "error", credentials: "omit" });
    if (r.redirected || (r.status >= 300 && r.status < 400)) throw new Error("Crowe Sense redirects are not allowed");
    if (!r.ok) throw new Error(`Crowe Sense answered ${r.status} for ${path}`);
    return r.json();
  }
  async poll() {
    if (this.polling) return this.status();
    const appConfig = this.deps.loadConfig() || {};
    const cfg = normalizeSense(appConfig.sense);
    if (cfg.source === "off") return this.status();
    const run = { cfg, token: cfg.source === "cloud" ? appConfig.token : undefined, generation: this.generation, controller: new AbortController() };
    this.active = run;
    this.polling = true;
    const current = () => this.active === run && this.generation === run.generation && !run.controller.signal.aborted && JSON.stringify(this.config()) === JSON.stringify(cfg);
    const sinkContext = { signal: run.controller.signal, isCurrent: current };
    try {
      const health = await this.get("/health", run);
      if (!current()) return this.status();
      const receivedAt = this.deps.now();
      if (!health || typeof health !== "object" || Array.isArray(health) || typeof health.node !== "string" || !NODE.test(health.node)) throw new Error("Crowe Sense health has no valid node identity");
      if (cfg.node && health.node !== cfg.node) throw new Error("Crowe Sense node identity mismatch");
      const data = await this.get("/v1/latest", run);
      if (!current()) return this.status();
      if (!Array.isArray(data)) throw new Error("Crowe Sense latest readings must be an array");
      if (data.some((r) => r && r.node && r.node !== health.node)) throw new Error("Crowe Sense node identity mismatch");
      const observations = toObservations(data, { node: health.node, now: this.deps.now(), transport: cfg.source });
      this.health = { ...health };
      this.healthReceivedAt = receivedAt;
      this.observations = observations;
      await this.deps.onObservations(this.status().observations, sinkContext);
      if (!current()) return this.status();
      // Freshness is per reading, never inferred from a healthy Pi/other sensor.
      const records = observationsToEnvRecords(observations, this.deps.now());
      if (records.length) await this.deps.onRecords(records, sinkContext);
      if (!current()) return this.status();
      this.lastError = "";
    } catch (e) {
      if (current()) this.lastError = String((e && e.message) || e);
    } finally {
      if (this.active === run) {
        if (current()) this.lastPoll = this.deps.now();
        this.active = null;
        this.polling = false;
      }
    }
    const s = this.status();
    if (this.generation === run.generation && JSON.stringify(this.config()) === JSON.stringify(cfg)) {
      try { this.deps.onChange(s); } catch { /* listeners do not own polling */ }
    }
    return s;
  }
  start() {
    this.stop();
    if (this.config().source === "off") return;
    const generation = this.generation;
    this.poll();
    this.timer = this.deps.setInterval(() => { if (this.generation === generation) this.poll(); }, POLL_MS);
    if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
  }
  stop() {
    this.generation++;
    if (this.timer !== null) { this.deps.clearInterval(this.timer); this.timer = null; }
    if (this.active) this.active.controller.abort();
    this.active = null;
    this.polling = false;
    this.health = null;
    this.healthReceivedAt = null;
    this.observations = [];
    this.lastPoll = 0;
    this.lastError = "";
  }
  status() {
    const config = this.config(), now = this.deps.now();
    const health = this.health ? { ...this.health } : null;
    if (health && !timestamp(health.last_ts) && finite(health.age_s) && this.healthReceivedAt !== null) {
      health.age_s += Math.max(0, now - this.healthReceivedAt) / 1000;
    }
    const observations = config.source === "off" ? [] : this.observations.map((o) => ({ ...o, provenance: { ...o.provenance }, age_s: now / 1000 - o.ts, stale: observationStale(o, now) }));
    return { config, health, observations, lastPoll: this.lastPoll, lastError: this.lastError,
      stale: config.source === "off" ? false : isStale(health, now) || !observations.some((o) => usableRoomObservation(o, now)),
      running: this.timer !== null };
  }
  configure(patch) {
    const merged = normalizeSense({ ...this.config(), ...(patch || {}) });
    this.stop();
    this.deps.saveConfig({ sense: merged });
    this.start();
    return this.status();
  }
}
module.exports = { SENSE_DEFAULTS, RELAY_DEFAULT, STALE_S, POLL_MS, normalizeSense, endpoint, isRoomZone, toObservations, toEnvRecords, isStale, fmtAge, SensePoller };
