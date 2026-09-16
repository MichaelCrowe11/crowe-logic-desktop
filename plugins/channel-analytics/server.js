#!/usr/bin/env node
/* Channel Analytics: a read-only MCP server over the Southwest Mushrooms channel
   manager's state.

   The channel manager (~/swm-channel-manager/manager.py, launchd 00:02 and
   07:25) already reads the YouTube Data API, the YouTube Analytics API and
   Stripe every night and writes what it found: state/snapshot-<date>.json, the
   hand-task register, the finishing queue, and a daily brief under
   ~/crowe-evidence/swm-channel. This server does not talk to YouTube. It reads
   those files, so a room seat asking for the morning numbers costs no quota,
   needs no credential, and sees exactly what the brief saw.

   Every tool but one only reads; run_collect asks the manager to collect now
   and is declared at the edit tier in plugins.builtin.json, so a read-only
   room cannot trigger it. Nothing here opens ~/.swm-yt-creds.

   Stdio, newline-delimited JSON-RPC, the same wire mcp-demo-server.js speaks.
   Environment (each optional, ~ expands):
     SWM_CHANNEL_MANAGER_DIR     default ~/swm-channel-manager
     SWM_CHANNEL_EVIDENCE_DIR    default ~/crowe-evidence/swm-channel
     SWM_CHANNEL_MANAGER_PYTHON  default ~/Projects/crowe-logic-foundry/.venv/bin/python3 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const HOME = os.homedir();
const expand = (s) => String(s || "").replace(/^~(?=$|\/)/, HOME);
const MANAGER_DIR = expand(process.env.SWM_CHANNEL_MANAGER_DIR || "~/swm-channel-manager");
const EVIDENCE_DIR = expand(process.env.SWM_CHANNEL_EVIDENCE_DIR || "~/crowe-evidence/swm-channel");
const PYTHON = expand(process.env.SWM_CHANNEL_MANAGER_PYTHON || "~/Projects/crowe-logic-foundry/.venv/bin/python3");
const STATE = path.join(MANAGER_DIR, "state");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const MAX_TEXT = 12000;
const MAX_SECTION = 30000;

// ─── Reading the manager's state ─────────────────────────────────────────────

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function snapshotFile(date) {
  if (date != null && date !== "") {
    if (!DATE_RE.test(String(date))) throw new Error("date must be YYYY-MM-DD");
    return path.join(STATE, `snapshot-${date}.json`);
  }
  return path.join(STATE, "snapshot-latest.json");
}
function loadSnapshot(date) {
  const file = snapshotFile(date);
  const s = readJson(file);
  if (!s) throw new Error(`no snapshot at ${file}. The channel manager writes one at 00:02 and 07:25; run_collect makes one now.`);
  return s;
}
function snapshotDates() {
  let names = [];
  try { names = fs.readdirSync(STATE); } catch { return []; }
  return names.map((n) => (n.match(/^snapshot-(\d{4}-\d{2}-\d{2})\.json$/) || [])[1]).filter(Boolean).sort().reverse();
}
const voicedIds = () => new Set((readJson(path.join(STATE, "voiced_ids.json")) || []).map(String));
const handTasks = () => readJson(path.join(STATE, "hand_tasks.json")) || [];

const n0 = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const usd = (v) => `$${n0(v).toFixed(2)}`;
const int = (v) => n0(v).toLocaleString("en-US");
const pct = (now, prev) => {
  const a = n0(now), b = n0(prev);
  if (!b) return a ? "new" : "flat";
  const d = Math.round(((a - b) / b) * 100);
  return d === 0 ? "flat" : `${d > 0 ? "up" : "down"} ${Math.abs(d)} percent`;
};
const hoursAgo = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? Math.round((Date.now() - t) / 36e5) : null;
};
const cut = (text, max) => (text.length > max ? text.slice(0, max) + `\n\n[cut at ${max} characters]` : text);

// ─── Tools ───────────────────────────────────────────────────────────────────

function summarize(s) {
  const L = [];
  const age = hoursAgo(s.pulled_at);
  L.push(`Snapshot ${s.date || "?"}, pulled ${s.pulled_at || "?"}${age != null ? ` (${age} h ago)` : ""}. Analytics carries a two-day lag; the window is ${(s.analytics_28d && s.analytics_28d.window || []).join(" to ") || "unknown"}.`);
  if (Array.isArray(s.errors) && s.errors.length) L.push(`Collect errors: ${s.errors.slice(0, 5).map(String).join("; ")}`);
  const c = s.channel || {};
  L.push(`Channel: ${int(c.subs)} subscribers, ${int(c.videos)} videos, ${int(c.views)} lifetime views.`);
  const a = s.analytics_28d || {}, p = s.analytics_prev_28d || {};
  L.push("", "Trailing 28 days against the prior 28:");
  L.push(`- Estimated revenue ${usd(a.estimatedRevenue)} (${pct(a.estimatedRevenue, p.estimatedRevenue)}, prior ${usd(p.estimatedRevenue)})`);
  L.push(`- Ad revenue ${usd(a.estimatedAdRevenue)} (${pct(a.estimatedAdRevenue, p.estimatedAdRevenue)})`);
  L.push(`- Views ${int(a.views)} (${pct(a.views, p.views)}); watch time ${int(a.estimatedMinutesWatched)} minutes`);
  L.push(`- Monetized playbacks ${int(a.monetizedPlaybacks)} (${pct(a.monetizedPlaybacks, p.monetizedPlaybacks)}). "Monetized" is only ever stated from this number.`);
  L.push(`- Subscribers net ${int(n0(a.subscribersGained) - n0(a.subscribersLost))} (gained ${int(a.subscribersGained)}, lost ${int(a.subscribersLost)}); prior net ${int(n0(p.subscribersGained) - n0(p.subscribersLost))}`);
  const types = Array.isArray(s.content_type_28d) ? s.content_type_28d : [];
  if (types.length) {
    L.push("", "By format, 28 days:");
    for (const t of types) {
      const name = t.type === "shorts" ? "Shorts" : t.type === "videoOnDemand" ? "Long-form" : String(t.type || "other");
      L.push(`- ${name}: ${int(t.views)} views, ${usd(t.revenue)}, ${int(t.monetized_playbacks)} monetized playbacks`);
    }
  }
  const traffic = (Array.isArray(s.traffic_28d) ? s.traffic_28d : []).slice().sort((x, y) => n0(y.views) - n0(x.views)).slice(0, 5);
  if (traffic.length) L.push("", `Traffic, top sources: ${traffic.map((t) => `${t.source} ${int(t.views)}`).join("; ")}`);
  const top = (Array.isArray(s.top_videos_28d) ? s.top_videos_28d : []).slice(0, 5);
  if (top.length) {
    const titles = new Map((s.uploads_recent || []).map((u) => [u.id, u.title]));
    L.push("", "Top videos, 28 days:");
    for (const v of top) L.push(`- ${v.id}${titles.has(v.id) ? ` "${String(titles.get(v.id)).slice(0, 60)}"` : ""}: ${int(v.views)} views, ${usd(v.revenue)}, ${int(v.watch_min)} watch minutes`);
  }
  const st = s.stripe || {};
  if (st.paid_7d || st.yt_7d) {
    L.push("", `Stripe (${st.business || st.account || "account"}): ${int((st.paid_7d || {}).count)} paid checkouts for ${usd((st.paid_7d || {}).usd)} in 7 days, ${int((st.yt_7d || {}).count)} carrying a YouTube attribution tag for ${usd((st.yt_7d || {}).usd)}; last 24 hours ${int((st.paid_24h || {}).count)} paid, ${int((st.yt_24h || {}).count)} YouTube-attributed.`);
  }
  const cm = s.comments || {};
  if (cm.recent_total != null) L.push(`Comments: ${int(cm.recent_total)} recent, ${int(cm.awaiting_reply)} awaiting a channel reply.`);
  const ms = Array.isArray(s.machine_shorts) ? s.machine_shorts : [];
  if (ms.length) {
    const last = ms.slice().sort((x, y) => String(y.published).localeCompare(String(x.published)))[0];
    L.push(`Machine Shorts (unvoiced, machine-titled) on the channel: ${ms.length}, latest ${last.id} "${String(last.title).slice(0, 50)}" at ${last.published}.`);
  }
  const sched = s.scheduled || {};
  if (sched.private_total != null) L.push(`Private videos: ${int(sched.private_total)}${Array.isArray(sched.scheduled) && sched.scheduled.length ? `, ${sched.scheduled.length} scheduled` : ""}.`);
  const open = handTasks().filter((t) => !t.done).sort((x, y) => n0(y.value) - n0(x.value));
  if (open.length) L.push("", `Open hand tasks (Studio only, by value): ${open.slice(0, 3).map((t) => `${t.title} (${t.value})`).join("; ")}${open.length > 3 ? `; ${open.length - 3} more` : ""}. list_hand_tasks has the register.`);
  if (s.quota_units_used != null) L.push("", `API quota used by the last collect: ${int(s.quota_units_used)} units.`);
  return L.join("\n");
}

const TOOLS = [
  { name: "list_snapshot_dates",
    description: "Which nightly snapshots the channel manager has on disk, when the latest was pulled, and how old it is. Start here if a number looks stale.",
    inputSchema: { type: "object", properties: {} } },
  { name: "get_channel_snapshot",
    description: "The Southwest Mushrooms channel in one read: subscribers, 28-day revenue, ad revenue, views and monetized playbacks against the prior 28 days, the Shorts and long-form split, top traffic sources and videos, Stripe checkouts carrying a YouTube tag, comments awaiting reply, machine Shorts on the channel, and the open Studio-only tasks. Read from the manager's nightly snapshot; costs no quota. Pass a date for an earlier snapshot.",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD; default the latest snapshot" }, format: { type: "string", enum: ["text", "json"], description: "text (default) or the compact json" } } } },
  { name: "get_snapshot_section",
    description: "One raw section of a snapshot as JSON: channel, analytics_28d, analytics_prev_28d, daily_7, content_type_28d, traffic_28d, top_videos_28d, uploads_recent, scheduled, per_video_28d, captions, comments, playlists, sweeps, memberships, fourthwall, stripe, machine_shorts, errors.",
    inputSchema: { type: "object", properties: { section: { type: "string" }, date: { type: "string" } }, required: ["section"] } },
  { name: "list_recent_uploads",
    description: "Uploads from the last days with privacy, duration, views, whether each is Shorts-like, whether it is voiced, whether it is on the machine Shorts list, and which description checks failed. Use unvoiced_only to find machine Shorts that slipped through.",
    inputSchema: { type: "object", properties: {
      days: { type: "integer", description: "Look back this many days; default 14" },
      shorts_only: { type: "boolean" }, unvoiced_only: { type: "boolean" },
      privacy: { type: "string", enum: ["public", "private", "unlisted"] } } } },
  { name: "list_machine_shorts",
    description: "The unvoiced, machine-titled Shorts the manager has identified on the channel: ids, titles, publish times, views, how many in the last 14 days, and the hours of day they land, which is how a live uploader shows itself.",
    inputSchema: { type: "object", properties: { days: { type: "integer", description: "Only those published in the last N days; default all" } } } },
  { name: "get_video_performance",
    description: "One video: its upload record, its 28-day views, revenue and monetized playbacks, its rank among the top videos, captions on file, and whether it is voiced or a machine Short.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "YouTube video id" } }, required: ["id"] } },
  { name: "list_hand_tasks",
    description: "The register of tasks only a person can do in YouTube Studio, ordered by value, each with why it matters, how to do it, and the probe that closes it. open_only defaults to true.",
    inputSchema: { type: "object", properties: { open_only: { type: "boolean" } } } },
  { name: "read_daily_brief",
    description: "The channel manager's daily brief as it was emailed: the morning note, the money table and the ordered hand list. Latest by default, or a date.",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" } } } },
  { name: "get_stripe_attribution",
    description: "Paid checkouts on the Crowe Logic Stripe account in the last 7 days and 24 hours, and how many carry a YouTube attribution tag, with the recent tagged ones.",
    inputSchema: { type: "object", properties: {} } },
  { name: "run_collect",
    description: "Ask the channel manager to collect now: a fresh snapshot from the Data API, the Analytics API and Stripe. Spends API quota and takes a minute or two. Declared at the edit tier; a read-only room cannot call it.",
    inputSchema: { type: "object", properties: {} } },
];

async function call(name, args) {
  const a = args || {};
  switch (name) {
    case "list_snapshot_dates": {
      const dates = snapshotDates();
      const latest = readJson(path.join(STATE, "snapshot-latest.json"));
      const finish = readJson(path.join(STATE, "finish-latest.json"));
      return {
        managerDir: MANAGER_DIR, dates,
        latest: latest ? { date: latest.date, pulledAt: latest.pulled_at, hoursAgo: hoursAgo(latest.pulled_at), errors: (latest.errors || []).length } : null,
        nightFinish: finish ? { ran: finish.ran, open: finish.open } : null,
        note: dates.length ? undefined : `no snapshots under ${STATE}`,
      };
    }
    case "get_channel_snapshot": {
      const s = loadSnapshot(a.date);
      if (a.format === "json") {
        const { uploads_recent, per_video_28d, captions, playlists, machine_shorts, ...rest } = s;
        return { ...rest, uploads_recent_count: (uploads_recent || []).length, machine_shorts_count: (machine_shorts || []).length };
      }
      return summarize(s);
    }
    case "get_snapshot_section": {
      const s = loadSnapshot(a.date);
      const allowed = ["channel", "analytics_28d", "analytics_prev_28d", "daily_7", "content_type_28d", "traffic_28d", "top_videos_28d",
        "uploads_recent", "scheduled", "per_video_28d", "captions", "comments", "playlists", "sweeps", "memberships", "fourthwall", "stripe", "machine_shorts", "errors", "quota_units_used"];
      const sec = String(a.section || "");
      if (!allowed.includes(sec)) throw new Error(`unknown section "${sec}"; one of ${allowed.join(", ")}`);
      return sec in s ? s[sec] : null;
    }
    case "list_recent_uploads": {
      const s = loadSnapshot();
      const days = Math.min(365, Math.max(1, Number(a.days) || 14));
      const since = Date.now() - days * 864e5;
      const voiced = voicedIds();
      const machine = new Set((s.machine_shorts || []).map((m) => m.id));
      let rows = (Array.isArray(s.uploads_recent) ? s.uploads_recent : []).filter((u) => {
        const t = Date.parse(u.published_at || "");
        return !Number.isFinite(t) || t >= since;
      });
      if (a.shorts_only) rows = rows.filter((u) => u.shorts_like);
      if (a.privacy) rows = rows.filter((u) => u.privacy === a.privacy);
      rows = rows.map((u) => ({
        id: u.id, title: u.title, published_at: u.published_at, privacy: u.privacy, duration_s: u.duration_s,
        shorts_like: Boolean(u.shorts_like), views: u.views, comments: u.comments, likes: u.likes, tags: u.tags,
        voiced: voiced.has(u.id), machine_short: machine.has(u.id),
        failed_checks: Object.entries(u.checks || {}).filter(([, v]) => v === true).map(([k]) => k),
      }));
      if (a.unvoiced_only) rows = rows.filter((u) => !u.voiced);
      rows.sort((x, y) => String(y.published_at).localeCompare(String(x.published_at)));
      return { days, count: rows.length, voiced_ids_known: voiced.size, uploads: rows };
    }
    case "list_machine_shorts": {
      const s = loadSnapshot();
      const all = Array.isArray(s.machine_shorts) ? s.machine_shorts.slice() : [];
      const when = (m) => Date.parse(m.published || "");
      const days = a.days ? Math.max(1, Number(a.days)) : null;
      const rows = (days ? all.filter((m) => when(m) >= Date.now() - days * 864e5) : all)
        .sort((x, y) => String(y.published).localeCompare(String(x.published)));
      // The cadence is always the last 14 days of everything the manager knows,
      // whatever window the caller asked to list; a 7-day list must not report a
      // 7-day count under a 14-day name.
      const last14 = all.filter((m) => when(m) >= Date.now() - 14 * 864e5).length;
      const hours = {};
      for (const m of rows) { const h = String(m.published || "").slice(11, 13); if (h) hours[h] = (hours[h] || 0) + 1; }
      return { count: rows.length, days, last_14_days: last14, latest: rows[0] || null, publish_hours_utc: hours, shorts: rows.slice(0, 60) };
    }
    case "get_video_performance": {
      const id = String(a.id || "");
      if (!VIDEO_ID_RE.test(id)) throw new Error("id must be a YouTube video id");
      const s = loadSnapshot();
      const upload = (s.uploads_recent || []).find((u) => u.id === id) || null;
      const perf = (s.per_video_28d || {})[id] || null;
      const rank = (s.top_videos_28d || []).findIndex((v) => v.id === id);
      return {
        id, upload, performance_28d: perf, top_rank_28d: rank >= 0 ? rank + 1 : null,
        captions: Array.isArray((s.captions || {})[id]) ? s.captions[id].length : 0,
        voiced: voicedIds().has(id), machine_short: (s.machine_shorts || []).some((m) => m.id === id),
        note: !upload && !perf ? "not in the recent uploads or the 28-day per-video table; it may be older than the snapshot covers" : undefined,
      };
    }
    case "list_hand_tasks": {
      const openOnly = a.open_only !== false;
      const rows = handTasks().filter((t) => !openOnly || !t.done).sort((x, y) => n0(y.value) - n0(x.value))
        .map((t) => ({ id: t.id, value: t.value, done: Boolean(t.done), title: t.title, why: t.why, how: t.how, probe: t.probe && t.probe.kind, closed_at: t.closed_at || null, closed_by: t.closed_by || null }));
      return { count: rows.length, open_only: openOnly, tasks: rows };
    }
    case "read_daily_brief": {
      let date = a.date;
      if (date != null && date !== "" && !DATE_RE.test(String(date))) throw new Error("date must be YYYY-MM-DD");
      if (!date) {
        let names = []; try { names = fs.readdirSync(EVIDENCE_DIR); } catch {}
        date = names.map((n) => (n.match(/^brief-(\d{4}-\d{2}-\d{2})\.md$/) || [])[1]).filter(Boolean).sort().pop();
        if (!date) throw new Error(`no brief under ${EVIDENCE_DIR}`);
      }
      const file = path.join(EVIDENCE_DIR, `brief-${date}.md`);
      let text; try { text = fs.readFileSync(file, "utf8"); } catch { throw new Error(`no brief for ${date} at ${file}`); }
      return cut(text, MAX_SECTION);
    }
    case "get_stripe_attribution": {
      const s = loadSnapshot();
      return s.stripe || { note: "the snapshot carries no Stripe block" };
    }
    case "run_collect": {
      const manager = path.join(MANAGER_DIR, "manager.py");
      if (!fs.existsSync(manager)) throw new Error(`no channel manager at ${manager}`);
      if (!fs.existsSync(PYTHON)) throw new Error(`no python at ${PYTHON}; set SWM_CHANNEL_MANAGER_PYTHON`);
      return await new Promise((resolve) => {
        let out = "";
        const proc = spawn(PYTHON, [manager, "collect"], { cwd: MANAGER_DIR, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
        const timer = setTimeout(() => { try { proc.kill(); } catch {} out += "\n[collect stopped after 15 minutes]"; }, 15 * 60 * 1000);
        proc.stdout.on("data", (d) => { out += d; });
        proc.stderr.on("data", (d) => { out += d; });
        proc.on("error", (e) => { clearTimeout(timer); resolve(`collect could not start: ${e.message}`); });
        proc.on("exit", (code) => {
          clearTimeout(timer);
          const tail = out.split("\n").slice(-40).join("\n");
          resolve(`collect exited ${code}. ${code === 0 ? "A new snapshot is on disk; read get_channel_snapshot." : "See the manager's log."}\n\n${tail}`);
        });
      });
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ─── The wire ────────────────────────────────────────────────────────────────

const render = (out) => {
  const text = typeof out === "string" ? out : JSON.stringify(out, null, 1);
  return cut(text, typeof out === "string" ? MAX_SECTION : MAX_TEXT);
};

/* One request, one reply, whichever wire carried it. A notification (no id)
   wants no answer. */
let inflight = 0, ended = false;
const maybeExit = () => { if (ended && inflight === 0) process.exit(0); };
async function handle(msg, reply) {
  if (!msg || typeof msg !== "object" || msg.id === undefined || msg.id === null) return;
  const answer = (result) => reply({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method === "initialize") answer({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "channel-analytics", version: "0.1.0" } });
  else if (msg.method === "tools/list") answer({ tools: TOOLS });
  else if (msg.method === "tools/call") {
    inflight++;
    try { const out = await call((msg.params || {}).name, (msg.params || {}).arguments || {}); answer({ content: [{ type: "text", text: render(out) }] }); }
    catch (e) { answer({ content: [{ type: "text", text: "error: " + String((e && e.message) || e) }], isError: true }); }
    finally { inflight--; maybeExit(); }
  } else if (msg.method === "ping") answer({});
  else answer({});
}

if (process.parentPort) {
  /* Inside the app: an Electron utility process, the Node runtime a packaged
     build carries (its binary has the RunAsNode fuse off, so it will not run a
     script as plain Node). Such a process has no stdin to read (Electron only
     lets it be ignored), so requests arrive as objects on the port to the
     parent and the replies go back the same way. */
  process.parentPort.on("message", (e) => { handle(e.data, (m) => process.parentPort.postMessage(m)); });
} else if (require.main === module) {
  /* Plain node (the wire test, a hand run): newline-delimited JSON on stdio,
     the same wire mcp-demo-server.js speaks. */
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      handle(msg, (m) => process.stdout.write(JSON.stringify(m) + "\n"));
    }
  });
  process.stdin.on("end", () => { ended = true; maybeExit(); });
}

module.exports = { TOOLS, call, summarize, snapshotDates };
