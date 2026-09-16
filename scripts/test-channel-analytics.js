#!/usr/bin/env node
// The Channel Analytics plugin server, driven over its own wire against a
// fixture of the channel manager's state.
//
//   node scripts/test-channel-analytics.js
//
// What is decidable here: every tool answers in the shape the room seat will
// read, the read tools never leave the two configured folders, the write tool
// refuses plainly when the manager is not there, and the manifest declares
// every read tool read-only and the collect at edit. What is not: the numbers
// themselves, which come from the manager's nightly run and are its to prove.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const SERVER = path.join(root, "plugins", "channel-analytics", "server.js");
let failures = 0;
const check = (name, fn) => Promise.resolve().then(fn).then((d) => console.log(`  ok   ${name}${d ? ` — ${d}` : ""}`))
  .catch((e) => { failures += 1; console.log(`  FAIL ${name}\n       ${String(e && e.message || e).split("\n").join("\n       ")}`); });
const assert = (c, m) => { if (!c) throw new Error(m); };

// ── fixture: the manager's state, as manager.py writes it ──────────────────
const manager = fs.mkdtempSync(path.join(os.tmpdir(), "swm-manager-"));
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "swm-evidence-"));
fs.mkdirSync(path.join(manager, "state"));
const today = new Date();
const iso = (d) => d.toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 864e5);
const snapshot = {
  pulled_at: (() => { const d = new Date(Date.now() - 2 * 36e5); const z = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; })(),
  date: today.toISOString().slice(0, 10), errors: [],
  channel: { id: "UCx", title: "Southwest Mushrooms", subs: 195000, videos: 742, views: 12783597 },
  analytics_28d: { views: 201665, estimatedMinutesWatched: 300000, subscribersGained: 400, subscribersLost: 143, estimatedRevenue: 274.32, estimatedAdRevenue: 128.54, monetizedPlaybacks: 11515, window: ["2026-08-16", "2026-09-12"] },
  analytics_prev_28d: { views: 197000, estimatedMinutesWatched: 290000, subscribersGained: 300, subscribersLost: 194, estimatedRevenue: 298.25, estimatedAdRevenue: 108.0, monetizedPlaybacks: 10000, window: ["2026-07-19", "2026-08-15"] },
  daily_7: [], content_type_28d: [
    { type: "shorts", views: 165605, revenue: 21.55, monetized_playbacks: 0 },
    { type: "videoOnDemand", views: 34000, revenue: 188.62, monetized_playbacks: 11515 },
  ],
  traffic_28d: [{ source: "SHORTS", views: 150000 }, { source: "YT_SEARCH", views: 20000 }],
  top_videos_28d: [{ id: "longform01", views: 6032, revenue: 90.1, watch_min: 40000 }],
  uploads_recent: [
    { id: "machine0001", title: "Contamination control is best treated as", published_at: iso(daysAgo(0.5)), privacy: "public", publish_at: null, duration_s: 21, shorts_like: true, views: 1194, comments: 0, likes: 19, tags: 0, checks: { join_line: false, price: true } },
    { id: "voiced00001", title: "Lion's mane on supplemented hardwood, voiced", published_at: iso(daysAgo(1)), privacy: "public", publish_at: null, duration_s: 45, shorts_like: true, views: 800, comments: 2, likes: 40, tags: 3, checks: { join_line: false } },
    { id: "longform01", title: "Chestnut, Reishi and Lion's Mane: 10 Growing Days", published_at: iso(daysAgo(5)), privacy: "public", publish_at: null, duration_s: 1306, shorts_like: false, views: 6032, comments: 30, likes: 400, tags: 12, checks: {} },
    { id: "oldshort001", title: "An old one", published_at: iso(daysAgo(40)), privacy: "public", publish_at: null, duration_s: 20, shorts_like: true, views: 10, comments: 0, likes: 0, tags: 0, checks: {} },
  ],
  scheduled: { private_total: 3, scheduled: [] },
  per_video_28d: { longform01: { views: 6032, revenue: 90.1, monetized_playbacks: 300 } },
  captions: { longform01: [{ lang: "en" }] },
  comments: { recent_total: 40, awaiting_reply: 8, top: [] },
  playlists: [], quota_units_used: 812,
  sweeps: {}, memberships: { csv_imported: true, imports: [] }, fourthwall: { walled: true },
  stripe: { account: "acct_x", business: "Crowe Logic", paid_7d: { count: 2, usd: 158 }, yt_7d: { count: 2, usd: 158 }, paid_24h: { count: 0, usd: 0 }, yt_24h: { count: 0, usd: 0 }, yt_recent: [{ amount: 79, via: "yt-lm-substrate-desc", when: iso(daysAgo(1)) }] },
  machine_shorts: [
    { id: "machine0001", title: "Contamination control is best treated as", published: iso(daysAgo(0.5)).slice(0, 16), views: 1194 },
    // Same hour of day, three weeks back: outside any 14-day cadence, inside a 30-day list.
    { id: "machine0000", title: "Mycelium is best understood as", published: iso(daysAgo(20.5)).slice(0, 16), views: 402 },
  ],
};
fs.writeFileSync(path.join(manager, "state", "snapshot-latest.json"), JSON.stringify(snapshot));
fs.writeFileSync(path.join(manager, "state", `snapshot-${snapshot.date}.json`), JSON.stringify(snapshot));
fs.writeFileSync(path.join(manager, "state", "voiced_ids.json"), JSON.stringify(["voiced00001"]));
fs.writeFileSync(path.join(manager, "state", "hand_tasks.json"), JSON.stringify([
  { id: "publish-decisions", value: 0.95, done: false, title: "Publish the private 21:46 video", why: "long-form is the only format producing monetized plays", how: "Studio > Content", probe: { kind: "video_public" } },
  { id: "members-csv", value: 0.9, done: true, title: "Export the members CSV", why: "x", how: "y", probe: { kind: "members_csv_imported" }, closed_at: "2026-09-11", closed_by: "probe" },
]));
fs.writeFileSync(path.join(evidence, `brief-${snapshot.date}.md`), "# Southwest Mushrooms channel brief\n\nMorning Michael. Numbers are in.\n");

// ── the wire ────────────────────────────────────────────────────────────────
function serve(env) {
  const proc = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, HOME: os.homedir(), ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map(); let buf = "", id = 0;
  proc.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m.result); } }
  });
  const request = (method, params) => new Promise((res, rej) => { const my = ++id; pending.set(my, res); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n"); setTimeout(() => { if (pending.has(my)) { pending.delete(my); rej(new Error(`${method} timed out`)); } }, 8000); });
  const tool = async (name, args) => { const r = await request("tools/call", { name, arguments: args || {} }); const text = r.content[0].text; return { text, isError: Boolean(r.isError), json: (() => { try { return JSON.parse(text); } catch { return null; } })() }; };
  return { proc, request, tool, close: () => { try { proc.stdin.end(); proc.kill(); } catch {} } };
}

(async () => {
  console.log("channel analytics plugin");
  const env = { SWM_CHANNEL_MANAGER_DIR: manager, SWM_CHANNEL_EVIDENCE_DIR: evidence, SWM_CHANNEL_MANAGER_PYTHON: path.join(manager, "no-such-python") };
  const srv = serve(env);
  try {
    let tools = [];
    await check("the server initialises and lists its tools, every read named as one", async () => {
      const init = await srv.request("initialize", {});
      assert(init.serverInfo && init.serverInfo.name === "channel-analytics", "wrong server");
      tools = (await srv.request("tools/list", {})).tools.map((t) => t.name);
      const reads = tools.filter((t) => t !== "run_collect");
      assert(reads.length >= 9 && reads.every((t) => /^(get|list|read)_/.test(t)), `a read tool is not named as one: ${reads.join(", ")}`);
      assert(tools.includes("run_collect"), "the collect tool is missing");
      return `${tools.length} tools`;
    });

    await check("the snapshot summary carries the numbers a morning brief needs", async () => {
      const r = await srv.tool("get_channel_snapshot", {});
      assert(!r.isError, r.text);
      for (const must of ["195,000 subscribers", "$274.32", "down 8 percent", "Monetized playbacks 11,515", "Shorts: 165,605 views", "0 monetized playbacks", "Long-form", "2 carrying a YouTube attribution tag", "8 awaiting a channel reply", "Machine Shorts", "Publish the private 21:46 video", "two-day lag"])
        assert(r.text.includes(must), `summary lacks "${must}"\n${r.text}`);
      const j = await srv.tool("get_channel_snapshot", { format: "json" });
      assert(j.json && j.json.channel.subs === 195000 && j.json.uploads_recent === undefined && j.json.uploads_recent_count === 4, "the compact json still carried the long tables");
      return "text and json";
    });

    await check("recent uploads carry voiced and machine flags, and unvoiced_only finds the machine Short", async () => {
      const all = await srv.tool("list_recent_uploads", { days: 14 });
      assert(all.json.count === 3, `expected 3 uploads in 14 days, got ${all.json.count}`);
      const m = all.json.uploads.find((u) => u.id === "machine0001");
      assert(m.machine_short === true && m.voiced === false && m.failed_checks.join() === "price", `machine short flags ${JSON.stringify(m)}`);
      assert(all.json.uploads.find((u) => u.id === "voiced00001").voiced === true, "the voiced id was not flagged");
      const un = await srv.tool("list_recent_uploads", { days: 14, shorts_only: true, unvoiced_only: true });
      assert(un.json.count === 1 && un.json.uploads[0].id === "machine0001", `unvoiced shorts: ${JSON.stringify(un.json.uploads.map((u) => u.id))}`);
      const ms = await srv.tool("list_machine_shorts", {});
      assert(ms.json.count === 2 && ms.json.last_14_days === 1 && ms.json.days === null && Object.keys(ms.json.publish_hours_utc).length === 1, `machine shorts cadence: ${JSON.stringify(ms.json)}`);
      // The 14-day count names a fixed window; a narrower or wider list must not move it.
      const week = await srv.tool("list_machine_shorts", { days: 7 });
      assert(week.json.count === 1 && week.json.days === 7 && week.json.last_14_days === 1, `a 7-day list changed the 14-day count: ${JSON.stringify(week.json)}`);
      const month = await srv.tool("list_machine_shorts", { days: 30 });
      assert(month.json.count === 2 && month.json.last_14_days === 1 && month.json.latest.id === "machine0001", `a 30-day list: ${JSON.stringify(month.json)}`);
      return "3 uploads, 2 machine (1 in 14 days), 1 voiced";
    });

    await check("a video's performance joins the upload, the 28-day table and the rank", async () => {
      const r = await srv.tool("get_video_performance", { id: "longform01" });
      assert(r.json.performance_28d.monetized_playbacks === 300 && r.json.top_rank_28d === 1 && r.json.captions === 1 && r.json.upload.duration_s === 1306, JSON.stringify(r.json));
      const bad = await srv.tool("get_video_performance", { id: "../../etc/passwd" });
      assert(bad.isError && /video id/.test(bad.text), "a path was accepted as a video id");
      return "joined";
    });

    await check("hand tasks come ordered by value, open by default", async () => {
      const r = await srv.tool("list_hand_tasks", {});
      assert(r.json.count === 1 && r.json.tasks[0].id === "publish-decisions" && r.json.tasks[0].probe === "video_public", JSON.stringify(r.json));
      const all = await srv.tool("list_hand_tasks", { open_only: false });
      assert(all.json.count === 2 && all.json.tasks[1].done === true, "closed tasks did not come back when asked");
      return "1 open of 2";
    });

    await check("the brief reads by date or latest, and a date is a date, not a path", async () => {
      const latest = await srv.tool("read_daily_brief", {});
      assert(!latest.isError && /Morning Michael/.test(latest.text), latest.text);
      const dated = await srv.tool("read_daily_brief", { date: snapshot.date });
      assert(!dated.isError && dated.text === latest.text, "the dated brief differs from the latest");
      for (const evil of ["../snapshot-latest", "2026-09-14/../x", "brief"]) {
        const r = await srv.tool("read_daily_brief", { date: evil });
        assert(r.isError && /YYYY-MM-DD/.test(r.text), `a bad date was accepted: ${evil}`);
      }
      const missing = await srv.tool("read_daily_brief", { date: "2001-01-01" });
      assert(missing.isError && /no brief for 2001-01-01/.test(missing.text), "a missing brief did not say so");
      return "latest, dated, three bad dates refused";
    });

    await check("sections and dates are allowlisted; stripe attribution is its own read", async () => {
      const ok = await srv.tool("get_snapshot_section", { section: "stripe" });
      assert(ok.json && ok.json.yt_7d.count === 2, "stripe section missing");
      const no = await srv.tool("get_snapshot_section", { section: "__proto__" });
      assert(no.isError && /unknown section/.test(no.text), "an unknown section was served");
      const dated = await srv.tool("get_snapshot_section", { section: "channel", date: "../x" });
      assert(dated.isError && /YYYY-MM-DD/.test(dated.text), "a bad snapshot date was accepted");
      const st = await srv.tool("get_stripe_attribution", {});
      assert(st.json.yt_recent[0].via === "yt-lm-substrate-desc", "attribution rows missing");
      const dates = await srv.tool("list_snapshot_dates", {});
      assert(dates.json.dates[0] === snapshot.date && dates.json.latest.hoursAgo === 2, JSON.stringify(dates.json));
      return "allowlisted";
    });

    await check("run_collect refuses plainly when the manager or its python is not there", async () => {
      const r = await srv.tool("run_collect", {});
      assert(r.isError && /no channel manager at|no python at/.test(r.text), r.text);
      return r.text.slice(0, 60);
    });
  } finally { srv.close(); }

  await check("with no state at all, every read says where it looked instead of failing empty", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "swm-empty-"));
    const s2 = serve({ SWM_CHANNEL_MANAGER_DIR: empty, SWM_CHANNEL_EVIDENCE_DIR: empty });
    try {
      await s2.request("initialize", {});
      const r = await s2.tool("get_channel_snapshot", {});
      assert(r.isError && r.text.includes(empty) && /run_collect/.test(r.text), r.text);
      const d = await s2.tool("list_snapshot_dates", {});
      assert(!d.isError && d.json.dates.length === 0 && /no snapshots/.test(d.json.note), JSON.stringify(d.json));
      return "named the folder";
    } finally { s2.close(); }
  });

  await check("the manifest declares every read tool read-only and the collect at edit, resolvable in the app", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugins.builtin.json"), "utf8")).plugins.find((p) => p.id === "channel-analytics");
    assert(manifest && manifest.available === true, "the plugin is still marked unavailable");
    assert(manifest.mcp.command === "${NODE}" && manifest.mcp.args[0] === "${APP}/plugins/channel-analytics/server.js", "the manifest does not point at the bundled server");
    const H = require(path.join(root, "harness.js"));
    const ctx = { getPlugins: () => [manifest] };
    const { TOOLS } = require(SERVER);
    for (const t of TOOLS) {
      const rule = H.pluginToolRule(ctx, `mcp__channel-analytics__${t.name}`);
      assert(rule, `no rule for ${t.name}`);
      if (t.name === "run_collect") assert(rule.tier === "edit", "run_collect is not at edit");
      else assert(rule.tier === "readonly" && rule.physical === false, `${t.name} is not read-only`);
      // Even as an unmanaged server the read names would pass the room heuristic.
      if (t.name !== "run_collect") assert(H.mcpReadLike(t.name), `${t.name} would ask under the unmanaged heuristic`);
    }
    const pkg = require(path.join(root, "package.json"));
    assert(pkg.build.files.includes("plugins/**") && (pkg.build.asarUnpack || []).includes("plugins/**"), "the server is not packaged and unpacked");
    return `${TOOLS.length} tools, ${TOOLS.length - 1} read-only`;
  });

  console.log(failures ? `\n${failures} check(s) failed` : "\nall channel analytics checks passed");
  process.exit(failures ? 1 : 0);
})();
