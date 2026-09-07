// Crowe Sense in the desktop app, tested in plain node: the endpoint the two
// sources resolve to, the env rows a snapshot becomes, staleness, and the
// poller writing through its record sink with a scripted node.
//
//   node scripts/test-sense.js
const assert = require("assert");
const S = require("../sense");

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`ok      ${name}`); }
  catch (e) { fail++; console.log(`not ok  ${name}\n        ${e.message}`); }
}

// A snapshot in the /api/data shape of the contract, with every zone kind the
// node API emits: two rooms, their derived twins, the hood, the controller.
const SNAPSHOT = {
  "tent-1": { temperature_c: { value: 21.0, unit: "C", quality: "ok", age: 4.2 }, humidity_pct: { value: 85.06, unit: "%", quality: "ok", age: 4.2 }, co2_ppm: { value: 812.4, unit: "ppm", quality: "ok", age: 4.2 } },
  "tent-2": { temperature_c: { value: 18.0, unit: "C", quality: "ok", age: 5 }, humidity_pct: { value: 91.94, unit: "%", quality: "ok", age: 5 } },
  "tent-1-derived": { vpd_kpa: { value: 0.37, unit: "kPa", quality: "est", age: 4 }, fruiting_score: { value: 88, unit: "", quality: "est", age: 4 } },
  "hood-1": { prefilter_dp_pa: { value: 42, unit: "Pa", quality: "ok", age: 3 } },
  "hood-1-derived": { hood_laminar_ok: { value: 1, unit: "", quality: "est", age: 3 } },
  pi: { soc_temp_c: { value: 51.2, unit: "C", quality: "ok", age: 2 } },
  incubation: { light_lux: { value: 12, unit: "lux", quality: "ok", age: 2 } },
};
const NOW = Date.UTC(2026, 8, 1, 14, 37, 12); // 2026-09-01T14:37:12Z

(async () => {
  console.log("crowe sense");

  await check("normalizeSense is a closed set and falls to off", () => {
    assert.deepStrictEqual(S.normalizeSense(undefined), { source: "off", url: "", node: "", relay: "https://sense.crowelogic.com" });
    assert.strictEqual(S.normalizeSense({ source: "bogus" }).source, "off");
    assert.strictEqual(S.normalizeSense({ source: "direct", url: "" }).source, "off", "direct without a URL is off");
    assert.strictEqual(S.normalizeSense({ source: "cloud", node: "not-an-id" }).source, "off", "cloud without a node id is off");
    assert.strictEqual(S.normalizeSense({ source: "cloud", node: "CS-A1B2C3" }).node, "cs-a1b2c3", "node ids are lowercased");
    assert.strictEqual(S.normalizeSense({ source: "direct", url: "http://100.1.2.3:8078/" }).url, "http://100.1.2.3:8078", "trailing slash dropped");
  });

  await check("endpoint: direct is url + path", () => {
    const cfg = { source: "direct", url: "http://100.123.229.57:8078" };
    assert.strictEqual(S.endpoint(cfg, "/health"), "http://100.123.229.57:8078/health");
    assert.strictEqual(S.endpoint(cfg, "/api/data?hours=1"), "http://100.123.229.57:8078/api/data?hours=1");
    assert.strictEqual(S.endpoint(cfg, "/v1/latest"), "http://100.123.229.57:8078/v1/latest");
  });

  await check("endpoint: cloud is relay/v1/nodes/<node> + path, with a per-node read's /v1 dropped", () => {
    const cfg = { source: "cloud", node: "cs-a1b2c3" };
    assert.strictEqual(S.endpoint(cfg, "/health"), "https://sense.crowelogic.com/v1/nodes/cs-a1b2c3/health");
    assert.strictEqual(S.endpoint(cfg, "/api/data?hours=1"), "https://sense.crowelogic.com/v1/nodes/cs-a1b2c3/api/data?hours=1");
    assert.strictEqual(S.endpoint(cfg, "/v1/latest"), "https://sense.crowelogic.com/v1/nodes/cs-a1b2c3/latest");
    assert.strictEqual(S.endpoint(cfg, "/v1/history?metric=co2_ppm"), "https://sense.crowelogic.com/v1/nodes/cs-a1b2c3/history?metric=co2_ppm");
    assert.strictEqual(S.endpoint({ ...cfg, relay: "https://relay.test/" }, "/health"), "https://relay.test/v1/nodes/cs-a1b2c3/health");
  });

  await check("endpoint: off resolves to nothing", () => {
    assert.strictEqual(S.endpoint({ source: "off" }, "/health"), null);
  });

  await check("toEnvRecords: one row per room, none for derived, hood or pi", () => {
    const rows = S.toEnvRecords(SNAPSHOT, "cs-a1b2c3", NOW);
    assert.deepStrictEqual(rows.map((r) => r.room), ["tent-1", "tent-2"], `rooms were ${rows.map((r) => r.room)}`);
  });

  await check("toEnvRecords: id is sense:<zone>:<UTC hour>, date is the UTC day", () => {
    const [t1] = S.toEnvRecords(SNAPSHOT, "cs-a1b2c3", NOW);
    assert.strictEqual(t1.id, "sense:tent-1:2026-09-01-14");
    assert.strictEqual(t1.date, "2026-09-01");
    // A poll six minutes later lands on the same id: the hour's row is rewritten, not stacked.
    assert.strictEqual(S.toEnvRecords(SNAPSHOT, "cs-a1b2c3", NOW + 6 * 60000)[0].id, t1.id);
    // The next hour gets a new id.
    assert.strictEqual(S.toEnvRecords(SNAPSHOT, "cs-a1b2c3", NOW + 30 * 60000)[0].id, "sense:tent-1:2026-09-01-15");
  });

  await check("toEnvRecords: Fahrenheit to 0.1, RH to 0.1, CO2 whole, source marked", () => {
    const [t1, t2] = S.toEnvRecords(SNAPSHOT, "cs-a1b2c3", NOW);
    assert.strictEqual(t1.temp, "69.8", `21.0 C should be 69.8 F, got ${t1.temp}`);
    assert.strictEqual(t1.rh, "85.1");
    assert.strictEqual(t1.co2, "812");
    assert.strictEqual(t1.fae, "");
    assert.strictEqual(t1.notes, "Crowe Sense cs-a1b2c3");
    assert.strictEqual(t1.source, "crowe-sense");
    assert.strictEqual(t2.temp, "64.4", `18.0 C should be 64.4 F, got ${t2.temp}`);
    assert.strictEqual(t2.rh, "91.9");
    assert.strictEqual(t2.co2, "", "a zone without CO2 leaves the field blank rather than inventing a value");
  });

  await check("toEnvRecords: a zone with none of the three room metrics is skipped", () => {
    const rows = S.toEnvRecords({ incubation: SNAPSHOT.incubation }, "cs-a1b2c3", NOW);
    assert.strictEqual(rows.length, 0);
    assert.deepStrictEqual(S.toEnvRecords(null, "x", NOW), []);
  });

  await check("isStale: past 180 s without a reading, or with no health at all", () => {
    assert.strictEqual(S.isStale({ age_s: 4.2 }), false);
    assert.strictEqual(S.isStale({ age_s: 181 }), true);
    assert.strictEqual(S.isStale({ last_ts: NOW / 1000 - 30 }, NOW), false);
    assert.strictEqual(S.isStale({ last_ts: NOW / 1000 - 600 }, NOW), true);
    assert.strictEqual(S.isStale(null), true);
    assert.strictEqual(S.isStale({}), true);
  });

  await check("poller: polls health and data, writes rows through the sink, reports status", async () => {
    let saved = null;
    const cfg = { sense: { source: "cloud", node: "cs-a1b2c3" }, token: "tok-123" };
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, auth: init.headers.authorization });
      if (url.endsWith("/health")) return { ok: true, json: async () => ({ ok: true, node: "cs-a1b2c3", zone: "tent-1", age_s: 4.2 }) };
      if (url.includes("/api/data")) return { ok: true, json: async () => ({ snapshot: SNAPSHOT }) };
      return { ok: false, status: 404 };
    };
    const written = [];
    const timers = [];
    const p = new S.SensePoller({
      loadConfig: () => ({ ...cfg, ...(saved || {}) }),
      saveConfig: (patch) => { saved = { ...(saved || {}), ...patch }; },
      fetchImpl,
      onRecords: (rs) => { written.push(...rs); },
      now: () => NOW,
      setInterval: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
      clearInterval: () => { timers.length = 0; },
    });
    p.start();
    // start() polls at once, then arms the interval.
    await new Promise((r) => setTimeout(r, 0));
    while (p.polling) await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(timers.length, 1, "one interval armed");
    assert.strictEqual(timers[0].ms, S.POLL_MS);
    assert.strictEqual(calls[0].url, "https://sense.crowelogic.com/v1/nodes/cs-a1b2c3/health");
    assert.strictEqual(calls[0].auth, "Bearer tok-123", "cloud mode carries the Crowe ID bearer");
    assert.strictEqual(calls[1].url, "https://sense.crowelogic.com/v1/nodes/cs-a1b2c3/api/data?hours=1");
    assert.strictEqual(written.length, 2);
    assert.strictEqual(written[0].id, "sense:tent-1:2026-09-01-14");
    const st = p.status();
    assert.strictEqual(st.health.node, "cs-a1b2c3");
    assert.strictEqual(st.stale, false);
    assert.strictEqual(st.lastError, "");
    assert.strictEqual(st.lastPoll, NOW);
    assert.strictEqual(st.running, true);
    p.stop();
    assert.strictEqual(p.status().running, false);
  });

  await check("poller: a node that answers 503 is reported as an error, not thrown", async () => {
    const p = new S.SensePoller({
      loadConfig: () => ({ sense: { source: "direct", url: "http://10.0.0.9:8078" } }),
      saveConfig: () => {},
      fetchImpl: async () => ({ ok: false, status: 503 }),
      onRecords: () => { throw new Error("must not be reached"); },
      now: () => NOW,
    });
    const st = await p.poll();
    assert.match(st.lastError, /503/);
    assert.strictEqual(st.stale, true, "no health means stale");
  });

  await check("poller: direct mode sends no bearer", async () => {
    const calls = [];
    const p = new S.SensePoller({
      loadConfig: () => ({ sense: { source: "direct", url: "http://10.0.0.9:8078" }, token: "tok-123" }),
      saveConfig: () => {},
      fetchImpl: async (url, init) => { calls.push(init.headers); return { ok: true, json: async () => ({ ok: true, age_s: 1, snapshot: {} }) }; },
      onRecords: () => {},
      now: () => NOW,
    });
    await p.poll();
    assert.strictEqual(calls[0].authorization, undefined);
  });

  await check("poller: configure persists a normalised config and turning it off stops polling", async () => {
    let saved = null;
    const timers = [];
    const p = new S.SensePoller({
      loadConfig: () => ({ sense: saved ? saved.sense : { source: "off" } }),
      saveConfig: (patch) => { saved = patch; },
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, age_s: 1, snapshot: {} }) }),
      onRecords: () => {},
      now: () => NOW,
      setInterval: (fn, ms) => { timers.push(ms); return { unref() {} }; },
      clearInterval: () => { timers.length = 0; },
    });
    p.configure({ source: "cloud", node: "CS-A1B2C3", url: "" });
    assert.deepStrictEqual(saved, { sense: { source: "cloud", url: "", node: "cs-a1b2c3", relay: "https://sense.crowelogic.com" } });
    assert.strictEqual(timers.length, 1, "configuring a source starts the poller");
    p.configure({ source: "off" });
    assert.strictEqual(saved.sense.source, "off");
    assert.strictEqual(timers.length, 0, "off stops it");
    assert.strictEqual(p.status().running, false);
    // A stale flag never survives an off config.
    assert.strictEqual(p.status().stale, false);
  });

  await check("fmtAge reads like a person would say it", () => {
    assert.strictEqual(S.fmtAge(4.2), "4 s ago");
    assert.strictEqual(S.fmtAge(600), "10 min ago");
    assert.strictEqual(S.fmtAge(7200), "2 h ago");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
