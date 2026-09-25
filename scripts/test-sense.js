// Offline scripted contract fixtures only. No hardware or live service claims.
// Run: node scripts/test-sense.js
const assert = require("node:assert/strict");
const S = require("../sense");
let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`ok      ${name}`); }
  catch (e) { fail++; console.error(`not ok  ${name}\n${e.stack}`); }
}
const NOW = Date.UTC(2026, 8, 1, 14, 37, 12);
const NODE = "cs-a1b2c3", OTHER = "cs-d4e5f6";
const reading = (patch = {}) => ({ ts: NOW / 1000 - 4, node: NODE, zone: "tent-1", sensor: "sht45", metric: "temperature_c", value: 21, unit: "C", quality: "ok", ...patch });
const READINGS = [reading(), reading({ metric: "humidity_pct", value: 85.06, unit: "%" }),
  reading({ sensor: "scd41", metric: "co2_ppm", value: 812.4, unit: "ppm" }),
  reading({ zone: "tent-2", value: 18 }), reading({ zone: "tent-2", metric: "humidity_pct", value: 91.94, unit: "%" }),
  reading({ zone: "tent-1-derived", sensor: "derived", metric: "vpd_kpa", value: 0.37, unit: "kPa", quality: "est" }),
  reading({ zone: "hood-1", metric: "prefilter_dp_pa", value: 42, unit: "Pa" }),
  reading({ zone: "pi", sensor: "pi", metric: "soc_temp_c", value: 51.2 }),
  reading({ zone: "incubation", metric: "light_lux", value: 12, unit: "lux" })];
const SNAPSHOT = { generated: NOW / 1000, node: NODE, snapshot: {
  "tent-1": { temperature_c: { value: 21, unit: "C", quality: "ok", age: 4 }, humidity_pct: { value: 85.06, unit: "%", quality: "ok", age: 4 } },
  "tent-2": { temperature_c: { value: 18, unit: "C", quality: "ok", age: 5 } }
} };
const response = (data) => ({ ok: true, status: 200, json: async () => data });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((r) => setImmediate(r));
async function settled(p) { for (let i = 0; i < 100 && p.polling; i++) await tick(); assert.equal(p.polling, false, "poll must finish"); }
function harness(overrides = {}) {
  let clock = NOW;
  let cfg = overrides.config || { sense: { source: "cloud", node: NODE }, token: "offline-test-token" };
  const calls = [], written = [], observed = [], changed = [], timers = new Map();
  let nextTimer = 0;
  const p = new S.SensePoller({
    loadConfig: () => cfg, saveConfig: (patch) => { cfg = { ...cfg, ...patch }; }, now: () => clock,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return overrides.fetchImpl ? overrides.fetchImpl(url, init) : response(url.endsWith("/health") ? { ok: true, node: NODE, last_ts: NOW / 1000 - 4, age_s: 4 } : READINGS);
    },
    onRecords: overrides.onRecords || ((rows) => written.push(...rows)),
    onObservations: overrides.onObservations || ((rows) => observed.push(...rows)),
    onChange: (s) => changed.push(s),
    setInterval: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearInterval: (id) => timers.delete(id),
  });
  return { p, calls, written, observed, changed, timers, setNow: (n) => { clock = n; }, config: () => cfg, setConfig: (c) => { cfg = c; } };
}
(async () => {
  console.log("crowe sense (offline contract fixtures)");
  await check("configuration is closed, URLs parsed, node canonicalized", () => {
    assert.deepEqual(S.normalizeSense(undefined), S.SENSE_DEFAULTS);
    assert.equal(S.normalizeSense({ source: "bogus" }).source, "off");
    assert.equal(S.normalizeSense({ source: "direct", url: "http://" }).source, "off");
    assert.equal(S.normalizeSense({ source: "direct", url: "http://user:password@node/" }).source, "off");
    assert.equal(S.normalizeSense({ source: "direct", url: "http://node/?redirect=evil" }).source, "off");
    assert.equal(S.normalizeSense({ source: "cloud", node: "nope" }).source, "off");
    assert.equal(S.normalizeSense({ source: "cloud", node: "CS-A1B2C3" }).node, NODE);
    assert.equal(S.normalizeSense({ source: "direct", url: "http://100.1.2.3:8078/" }).url, "http://100.1.2.3:8078");
  });
  await check("only documented HTTPS relay origin accepts bearer configuration", () => {
    for (const relay of ["https://relay.test", "http://sense.crowelogic.com", "https://sense.crowelogic.com.evil.test", "https://sense.crowelogic.com@evil.test", "https://evil.test@sense.crowelogic.com", "https://sense.crowelogic.com:8443", "https://sense.crowelogic.com/redirect", "https://sense.crowelogic.com?to=evil", "https://sense.crowelogic.com#evil", "https://sense.crowelogic.com.", "file:///tmp/node"]) {
      assert.equal(S.normalizeSense({ source: "cloud", node: NODE, relay }).source, "off", relay);
      assert.equal(S.endpoint({ source: "cloud", node: NODE, relay }, "/health"), null, relay);
    }
    assert.equal(S.normalizeSense({ source: "cloud", node: NODE, relay: "https://SENSE.CROWELOGIC.COM:443/" }).relay, S.RELAY_DEFAULT);
  });
  await check("direct and cloud contract paths; no arbitrary endpoint paths", () => {
    const cfg = { source: "cloud", node: NODE };
    assert.equal(S.endpoint(cfg, "/health"), `${S.RELAY_DEFAULT}/v1/nodes/${NODE}/health`);
    assert.equal(S.endpoint(cfg, "/v1/latest"), `${S.RELAY_DEFAULT}/v1/nodes/${NODE}/latest`);
    assert.equal(S.endpoint(cfg, "/v1/history?metric=co2_ppm"), `${S.RELAY_DEFAULT}/v1/nodes/${NODE}/history?metric=co2_ppm`);
    assert.equal(S.endpoint(cfg, "/api/data?hours=1"), `${S.RELAY_DEFAULT}/v1/nodes/${NODE}/api/data?hours=1`);
    assert.equal(S.endpoint({ source: "direct", url: "http://node:8078" }, "/v1/latest"), "http://node:8078/v1/latest");
    assert.equal(S.endpoint({ source: "off" }, "/health"), null);
    for (const path of ["https://evil.test", "//evil.test", "/../../secret", "/v1/latest/../secret", "/v1/latest#evil", "/v1/ingest"]) assert.throws(() => S.endpoint(cfg, path), /Unsupported/);
  });
  await check("validated observations retain node/sensor/unit/quality/source timestamp independently", () => {
    const rs = [reading(), reading({ sensor: "scd41", value: 22 }), reading({ node: OTHER })];
    const obs = S.toObservations(rs, { now: NOW, transport: "direct" });
    assert.equal(obs.length, 3);
    assert.equal(new Set(obs.map((o) => o.id)).size, 3);
    for (let i = 0; i < obs.length; i++) {
      for (const key of ["node", "zone", "sensor", "metric", "ts", "value", "unit", "quality"]) assert.equal(obs[i][key], rs[i][key]);
      assert.deepEqual(obs[i].provenance, { kind: "unknown", reported: "", transport: "direct" });
      assert.equal(obs[i].age_s, 4);
    }
    assert.equal(S.toObservations(rs, { now: NOW, node: NODE }).length, 2);
  });
  await check("null, whitespace, booleans, arrays and numeric strings never become measurements", () => {
    for (const value of [null, undefined, "", " ", "21", true, false, [], {}, NaN, Infinity, -Infinity]) {
      assert.deepEqual(S.toObservations([reading({ value })], { now: NOW }), [], String(value));
      assert.deepEqual(S.toEnvRecords({ generated: NOW / 1000, snapshot: { room: { temperature_c: { value, quality: "ok", unit: "C", age: 0 } } } }, NODE, NOW), []);
    }
    assert.equal(S.toEnvRecords([reading({ value: 0 })], NODE, NOW)[0].temp, "32", "real zero is valid");
    assert.equal(S.toEnvRecords([reading({ value: -2 })], NODE, NOW)[0].temp, "28.4");
  });
  await check("malformed identity, timestamp, quality and fields are omitted without mutation", () => {
    const source = Object.freeze(reading());
    assert.equal(S.toObservations([source], { now: NOW }).length, 1);
    for (const patch of [{ ts: null }, { ts: "123" }, { ts: 0 }, { ts: Infinity }, { ts: 9e99 }, { node: "" }, { node: "CS-A1B2C3" }, { sensor: "" }, { zone: "a\nb" }, { metric: "" }, { quality: "great" }, { unit: null }]) assert.deepEqual(S.toObservations([reading(patch)], { now: NOW }), [], JSON.stringify(patch));
    assert.deepEqual(S.toObservations(null), []);
    assert.deepEqual(S.toEnvRecords(null, NODE, NOW), []);
  });
  await check("unknown hardware remains unknown; reported real is not an attestation", () => {
    for (const provenance of [undefined, "real", "hardware", { kind: "measured", label: "real sensor" }]) {
      const [o] = S.toObservations([reading({ provenance })], { now: NOW });
      assert.equal(o.provenance.kind, "unknown");
      assert.match(S.toEnvRecords([reading({ provenance })], NODE, NOW)[0].notes, /provenance: unknown/);
    }
  });
  await check("scripted provenance retained and known presenter nodes never labeled hardware", () => {
    for (const provenance of ["scripted", "synthetic demo", { kind: "simulated", label: "fixture" }]) {
      const [o] = S.toObservations([reading({ provenance })], { now: NOW });
      assert.equal(o.provenance.kind, "scripted");
      assert.ok(o.provenance.reported);
      assert.match(S.toEnvRecords([o], NODE, NOW)[0].notes, /provenance: scripted/);
    }
    for (const node of ["cs-7a1f04", "cs-3c9e22", "cs-b5d810"]) assert.equal(S.toObservations([reading({ node, provenance: "physical" })], { now: NOW })[0].provenance.kind, "scripted");
    assert.equal(S.toObservations([reading()], { now: NOW, provenance: "scripted" })[0].provenance.kind, "scripted");
  });
  await check("env projection preserves exactly legacy fields, Fahrenheit/RH/CO2, and excludes pseudo rooms", () => {
    const rows = S.toEnvRecords(READINGS, NODE, NOW);
    assert.deepEqual(rows.map((r) => r.room), ["tent-1", "tent-2"]);
    assert.deepEqual(Object.keys(rows[0]).sort(), ["id", "room", "date", "temp", "rh", "co2", "fae", "notes", "source"].sort());
    assert.equal(rows[0].temp, "69.8"); assert.equal(rows[0].rh, "85.1"); assert.equal(rows[0].co2, "812");
    assert.equal(rows[0].fae, ""); assert.equal(rows[0].source, "crowe-sense");
    assert.match(rows[0].notes, /sht45 \(ok, 2026-09-01T14:37:08.000Z\)/);
    assert.equal(rows[1].temp, "64.4"); assert.equal(rows[1].rh, "91.9"); assert.equal(rows[1].co2, "");
    assert.deepEqual(S.toEnvRecords([reading({ sensor: "derived" }), reading({ sensor: "pi" })], NODE, NOW), []);
  });
  await check("node-scoped env IDs do not collide in a shared room/hour", () => {
    const rows = S.toEnvRecords([reading(), reading({ node: OTHER })], undefined, NOW);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, `sense:${NODE}:tent-1:2026-09-01-14`);
    assert.equal(rows[1].id, `sense:${OTHER}:tent-1:2026-09-01-14`);
    assert.equal(S.toObservations([reading({ zone: "a:b", sensor: "c" }), reading({ zone: "a", sensor: "b:c" })], { now: NOW }).map((o) => o.id).length, 2);
    const ids = S.toObservations([reading({ zone: "a:b", sensor: "c" }), reading({ zone: "a", sensor: "b:c" })], { now: NOW }).map((o) => o.id);
    assert.notEqual(ids[0], ids[1]);
  });
  await check("source timestamps choose UTC hour/day, never poll timestamp", () => {
    const ts = Date.UTC(2026, 7, 31, 23, 59, 50) / 1000;
    const r = reading({ ts });
    const first = S.toEnvRecords([r], NODE, ts * 1000 + 5000)[0];
    const afterMidnight = S.toEnvRecords([r], NODE, ts * 1000 + 60000)[0];
    assert.equal(first.id, `sense:${NODE}:tent-1:2026-08-31-23`);
    assert.deepEqual(first, afterMidnight);
    assert.equal(first.date, "2026-08-31");
    assert.deepEqual(S.toEnvRecords([r], NODE, ts * 1000 + 181000), [], "cached readings do not create fresh rows indefinitely");
  });
  await check("snapshot envelope uses generated minus age; bare poll-relative age is not evidence", () => {
    assert.equal(S.toEnvRecords(SNAPSHOT, NODE, NOW).length, 2);
    assert.match(S.toEnvRecords({ ...SNAPSHOT, provenance: "scripted" }, NODE, NOW)[0].notes, /provenance: scripted/);
    assert.match(S.toEnvRecords(SNAPSHOT, NODE, NOW)[0].notes, /unknown \(ok, 2026-09-01T14:37:08.000Z\)/);
    assert.deepEqual(S.toEnvRecords(SNAPSHOT.snapshot, NODE, NOW), []);
    assert.equal(S.toEnvRecords(SNAPSHOT.snapshot, NODE, NOW, { generated: NOW / 1000 }).length, 2);
    assert.deepEqual(S.toEnvRecords(SNAPSHOT, NODE, NOW + 181000), []);
    for (const age of [null, undefined, "", "4", false, -1, Infinity]) assert.deepEqual(S.toEnvRecords({ generated: NOW / 1000, snapshot: { room: { temperature_c: { value: 21, quality: "ok", unit: "C", age } } } }, NODE, NOW), []);
    assert.equal(S.toEnvRecords({ room: { temperature_c: reading() } }, NODE, NOW).length, 1);
  });
  await check("per-sensor stale, future, quality and unit validation leave missing metrics blank", () => {
    for (const quality of ["warming", "stale", "est", "fault"]) {
      const o = S.toObservations([reading({ quality })], { now: NOW });
      assert.equal(o.length, 1, "preserve flagged observations separately");
      assert.equal(o[0].quality, quality);
      assert.deepEqual(S.toEnvRecords(o, NODE, NOW), [], quality);
    }
    for (const patch of [{ ts: NOW / 1000 - 181 }, { ts: NOW / 1000 + 1 }, { unit: "F" }]) assert.deepEqual(S.toEnvRecords([reading(patch)], NODE, NOW), []);
    assert.equal(S.toEnvRecords([reading({ ts: NOW / 1000 - 180 })], NODE, NOW).length, 1);
    const rows = S.toEnvRecords([reading({ ts: NOW / 1000 - 181 }), reading({ metric: "humidity_pct", value: 80, unit: "%" })], NODE, NOW);
    assert.equal(rows[0].temp, ""); assert.equal(rows[0].rh, "80");
  });
  await check("all sensors preserved; env chooses latest usable metric deterministically", () => {
    const rs = [reading({ sensor: "bme688", value: 20 }), reading({ sensor: "sht45", value: 22 }), reading({ sensor: "scd41", ts: NOW / 1000 - 3, value: 23 })];
    assert.equal(S.toObservations(rs, { now: NOW }).length, 3);
    assert.deepEqual(S.toEnvRecords(rs, NODE, NOW), S.toEnvRecords([...rs].reverse(), NODE, NOW));
    assert.equal(S.toEnvRecords(rs, NODE, NOW)[0].temp, "73.4");
    assert.match(S.toEnvRecords(rs.slice(0, 2), NODE, NOW)[0].notes, /bme688/);
    rs[2].quality = "fault";
    assert.equal(S.toEnvRecords(rs, NODE, NOW)[0].temp, "68");
  });
  await check("health null/coercion/future/contradiction cannot mask staleness", () => {
    for (const health of [null, {}, { age_s: null }, { age_s: "" }, { age_s: "0" }, { age_s: false }, { age_s: -1 }, { age_s: NaN }, { last_ts: null }, { last_ts: 0, age_s: 0 }, { last_ts: NOW / 1000 + 1 }, { ok: false, age_s: 0 }, { last_ts: NOW / 1000 - 600, age_s: 0 }]) assert.equal(S.isStale(health, NOW), true, JSON.stringify(health));
    assert.equal(S.isStale({ age_s: 0 }, NOW), false);
    assert.equal(S.isStale({ last_ts: null, age_s: 4 }, NOW), false);
    assert.equal(S.isStale({ last_ts: NOW / 1000 - 180 }, NOW), false);
    assert.equal(S.isStale({ last_ts: NOW / 1000 - 181 }, NOW), true);
    assert.equal(S.isStale({ last_ts: NOW / 1000 - 4, age_s: null }, NOW), false);
  });
  await check("poller reads health/latest, retains observations and backwards-compatible env sink", async () => {
    const h = harness(); h.p.start(); await settled(h.p);
    assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].ms, S.POLL_MS);
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls[0].url.endsWith("/health")); assert.ok(h.calls[1].url.endsWith("/latest"));
    assert.equal(h.calls[0].init.headers.authorization, "Bearer offline-test-token");
    assert.equal(h.calls[0].init.redirect, "error"); assert.equal(h.calls[0].init.credentials, "omit");
    assert.equal(h.written.length, 2); assert.equal(h.observed.length, READINGS.length);
    const s = h.p.status(); assert.equal(s.health.node, NODE); assert.equal(s.observations.length, READINGS.length);
    assert.equal(s.lastPoll, NOW); assert.equal(s.lastError, ""); assert.equal(s.stale, false); assert.equal(s.running, true);
    // Returned DTOs cannot mutate retained observations.
    s.observations[0].value = 900; s.observations[0].provenance.kind = "hardware"; s.health.node = OTHER;
    assert.equal(h.p.status().observations[0].value, 21); assert.equal(h.p.status().observations[0].provenance.kind, "unknown"); assert.equal(h.p.status().health.node, NODE);
    h.p.stop(); assert.equal(h.p.status().running, false); assert.equal(h.timers.size, 0);
  });
  await check("health and observation freshness age without another poll, including age-only health", async () => {
    for (const last_ts of [undefined, NOW / 1000 - 4]) {
      const h = harness({ fetchImpl: async (url) => response(url.endsWith("/health") ? { node: NODE, ok: true, age_s: 4, last_ts } : READINGS) });
      await h.p.poll(); assert.equal(h.p.status().stale, false);
      h.setNow(NOW + 177000);
      assert.equal(h.p.status().stale, true); assert.equal(h.p.status().observations[0].stale, true);
      assert.equal(h.p.status().observations[0].age_s, 181);
    }
  });
  await check("healthy controller never freshens stale/missing room sensors", async () => {
    for (const rs of [[], [reading({ ts: NOW / 1000 - 181 })], [reading({ value: null })], [reading({ sensor: "pi", zone: "pi", metric: "soc_temp_c" })]]) {
      const h = harness({ fetchImpl: async (url) => response(url.endsWith("/health") ? { node: NODE, ok: true, age_s: 0, last_ts: NOW / 1000 } : rs) });
      await h.p.poll(); assert.equal(h.p.status().stale, true); assert.equal(h.written.length, 0);
    }
  });
  await check("503 and malformed latest response fail visibly, never write", async () => {
    const h = harness({ fetchImpl: async () => ({ ok: false, status: 503 }) });
    assert.match((await h.p.poll()).lastError, /503/); assert.equal(h.written.length, 0); assert.equal(h.p.status().stale, true);
    const m = harness({ fetchImpl: async (url) => response(url.endsWith("/health") ? { node: NODE, age_s: 0 } : { snapshot: {} }) });
    assert.match((await m.p.poll()).lastError, /array/); assert.equal(m.written.length, 0);
  });
  await check("direct mode sends no bearer; rejected cloud origins never reach fetch", async () => {
    const direct = harness({ config: { sense: { source: "direct", url: "http://node:8078" }, token: "offline-test-token" } });
    await direct.p.poll(); assert.equal(direct.calls.length, 2);
    for (const c of direct.calls) assert.equal(c.init.headers.authorization, undefined);
    for (const relay of ["https://evil.test", "http://sense.crowelogic.com", "https://sense.crowelogic.com.evil.test"]) {
      const h = harness({ config: { sense: { source: "cloud", node: NODE, relay }, token: "offline-test-token" } });
      await h.p.poll(); h.p.start(); assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0);
    }
  });
  await check("redirected and 30x responses rejected with no followup request", async () => {
    for (const res of [{ status: 302, ok: false }, { status: 200, ok: true, redirected: true }]) {
      const h = harness({ fetchImpl: async (_url, init) => {
        assert.equal(init.redirect, "error");
        return { ...res, json: () => { throw new Error("redirect body must not be read"); } };
      } });
      assert.match((await h.p.poll()).lastError, /redirects/); assert.equal(h.calls.length, 1); assert.equal(h.written.length, 0);
    }
  });
  await check("node mismatch rejected both in health and latest, including direct configured identity", async () => {
    for (const config of [{ source: "cloud", node: NODE }, { source: "direct", url: "http://node:8078", node: NODE }]) {
      const h = harness({ config: { sense: config }, fetchImpl: async () => response({ node: OTHER, age_s: 0 }) });
      assert.match((await h.p.poll()).lastError, /identity mismatch/); assert.equal(h.calls.length, 1);
    }
    const h = harness({ fetchImpl: async (url) => response(url.endsWith("/health") ? { node: NODE, age_s: 0 } : [reading({ node: OTHER })]) });
    assert.match((await h.p.poll()).lastError, /identity mismatch/); assert.equal(h.written.length, 0);
  });
  await check("stop during health request aborts and suppresses subsequent fetch/write/status publication", async () => {
    const d = deferred(); const h = harness({ fetchImpl: () => d.promise });
    const pending = h.p.poll(); assert.equal(h.p.polling, true);
    h.p.stop(); assert.equal(h.calls[0].init.signal.aborted, true);
    d.resolve(response({ node: NODE, age_s: 0 })); await pending;
    assert.equal(h.calls.length, 1); assert.equal(h.written.length, 0); assert.equal(h.observed.length, 0); assert.equal(h.changed.length, 0);
    assert.equal(h.p.status().health, null); assert.equal(h.p.status().lastPoll, 0);
  });
  await check("stop during latest JSON decode suppresses writes even if fetch ignores AbortSignal", async () => {
    const d = deferred();
    const h = harness({ fetchImpl: async (url) => url.endsWith("/health") ? response({ node: NODE, age_s: 0 }) : { ok: true, json: () => d.promise } });
    const pending = h.p.poll(); await tick(); assert.equal(h.calls.length, 2);
    h.p.stop(); d.resolve(READINGS); await pending;
    assert.equal(h.calls[1].init.signal.aborted, true); assert.equal(h.written.length, 0); assert.equal(h.observed.length, 0); assert.equal(h.changed.length, 0);
  });
  await check("configure off cancels in-flight request and old rejection cannot set errors", async () => {
    const d = deferred(); const h = harness({ fetchImpl: () => d.promise });
    h.p.start(); const timer = [...h.timers.values()][0].fn;
    h.p.configure({ source: "off" }); d.reject(new Error("old request rejected")); await tick();
    timer(); assert.equal(h.calls.length, 1, "an already queued timer must be invalidated");
    assert.equal(h.timers.size, 0); assert.equal(h.p.status().lastError, ""); assert.equal(h.p.status().lastPoll, 0);
    assert.equal(h.p.status().health, null); assert.equal(h.p.status().stale, false); assert.equal(h.written.length, 0);
  });
  await check("reconfigure starts new generation immediately, stale completion cannot overwrite it", async () => {
    const old = deferred();
    const h = harness({ fetchImpl: async (url) => {
      if (url.includes(NODE)) return old.promise;
      return response(url.endsWith("/health") ? { node: OTHER, age_s: 0, last_ts: NOW / 1000 } : [reading({ node: OTHER })]);
    } });
    const pending = h.p.poll(); h.p.configure({ node: OTHER }); await settled(h.p);
    assert.equal(h.p.status().health.node, OTHER); assert.equal(h.written.length, 1);
    old.resolve(response({ node: NODE, age_s: 0 })); await pending;
    assert.equal(h.p.status().health.node, OTHER); assert.equal(h.written.length, 1); assert.equal(h.changed.length, 1);
    assert.equal(h.calls[0].init.signal.aborted, true); h.p.stop();
  });
  await check("old finally cannot clear active replacement poll's lock", async () => {
    const old = deferred(), next = deferred();
    const h = harness({ fetchImpl: (url) => url.includes(NODE) ? old.promise : next.promise });
    const pending = h.p.poll(); h.p.configure({ node: OTHER }); old.resolve(response({ node: NODE, age_s: 0 })); await pending;
    assert.equal(h.p.polling, true);
    await h.p.poll(); assert.equal(h.calls.length, 2, "replacement is not duplicated");
    h.p.stop(); next.resolve(response({ node: OTHER, age_s: 0 })); await tick();
  });
  await check("external configuration mutation cannot splice old health to new endpoint/token", async () => {
    const d = deferred(); const h = harness({ fetchImpl: () => d.promise });
    const pending = h.p.poll(); h.setConfig({ sense: { source: "cloud", node: OTHER }, token: "other-offline-token" });
    d.resolve(response({ node: NODE, age_s: 0 })); await pending;
    assert.equal(h.calls.length, 1); assert.equal(h.written.length, 0); assert.equal(h.changed.length, 0);
  });
  await check("cancellable async observation sink cannot proceed to env after stop", async () => {
    const d = deferred(); let context;
    const h = harness({ onObservations: (_rows, c) => { context = c; return d.promise; } });
    const pending = h.p.poll(); await tick(); assert.equal(context.isCurrent(), true);
    h.p.stop(); assert.equal(context.signal.aborted, true); assert.equal(context.isCurrent(), false);
    d.resolve(); await pending; assert.equal(h.written.length, 0); assert.equal(h.changed.length, 0);
  });
  await check("sink failure is visible; sink/reentrant configure cannot resurrect old state", async () => {
    const broken = harness({ onRecords: () => { throw new Error("local sink unavailable"); } });
    assert.match((await broken.p.poll()).lastError, /local sink unavailable/);
    let h; h = harness({ onObservations: () => h.p.configure({ source: "off" }) });
    await h.p.poll(); assert.equal(h.written.length, 0); assert.equal(h.changed.length, 0); assert.equal(h.p.status().lastPoll, 0);
  });
  await check("reconfigure persists canonical defaults and zero-valued timer handles clear", async () => {
    const h = harness({ config: { sense: { source: "off" } } });
    h.p.configure({ source: "cloud", node: "CS-A1B2C3" });
    assert.deepEqual(h.config().sense, { ...S.SENSE_DEFAULTS, source: "cloud", node: NODE });
    assert.equal(h.timers.size, 1); assert.equal(h.p.status().running, true);
    h.p.configure({ source: "off" }); assert.equal(h.timers.size, 0); await tick();
  });
  await check("overflow cannot enter env strings or report a usable room reading", async () => {
    assert.deepEqual(S.toObservations([reading({ node: [NODE] })], { now: NOW }), []);
    assert.deepEqual(S.toEnvRecords([reading({ value: Number.MAX_VALUE })], NODE, NOW), []);
    for (const r of [reading({ value: Number.MAX_VALUE }), reading({ sensor: "derived" }), reading({ sensor: "pi" })]) {
      const h = harness({ fetchImpl: async (url) => response(url.endsWith("/health") ? { node: NODE, age_s: 0 } : [r]) });
      await h.p.poll(); assert.equal(h.p.status().stale, true); assert.equal(h.written.length, 0);
    }
  });
  await check("reconfigure during data request cannot write previous-node readings", async () => {
    const oldData = deferred();
    const h = harness({ fetchImpl: async (url) => {
      if (url.includes(NODE)) return url.endsWith("/health") ? response({ node: NODE, age_s: 0 }) : oldData.promise;
      return response(url.endsWith("/health") ? { node: OTHER, age_s: 0 } : [reading({ node: OTHER })]);
    } });
    const pending = h.p.poll(); await tick(); assert.equal(h.calls.length, 2);
    h.p.configure({ node: OTHER }); await settled(h.p);
    oldData.resolve(response(READINGS)); await pending;
    assert.equal(h.written.length, 1); assert.match(h.written[0].id, new RegExp(OTHER));
    assert.equal(h.p.status().health.node, OTHER); assert.equal(h.changed.length, 1); h.p.stop();
  });
  await check("async record sink receives cancellation guard and late failure stays invalidated", async () => {
    const sink = deferred(); let context;
    const h = harness({ onRecords: (_rows, c) => { context = c; return sink.promise; } });
    const pending = h.p.poll(); await tick(); assert.equal(context.isCurrent(), true);
    h.p.stop(); assert.equal(context.signal.aborted, true); assert.equal(context.isCurrent(), false);
    sink.reject(new Error("old sink rejected")); await pending;
    assert.equal(h.changed.length, 0); assert.equal(h.p.status().lastError, ""); assert.equal(h.p.status().lastPoll, 0);
  });
  await check("fmtAge does not label unknown ages as zero", () => {
    assert.equal(S.fmtAge(4.2), "4 s ago"); assert.equal(S.fmtAge(600), "10 min ago"); assert.equal(S.fmtAge(7200), "2 h ago");
    for (const v of [null, undefined, "", "0", -1, Infinity, NaN]) assert.equal(S.fmtAge(v), "unknown age");
  });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
