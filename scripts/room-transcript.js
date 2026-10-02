#!/usr/bin/env node
/* Render a saved room session as a markdown transcript whose seat table is read
   from the room's own cost map, not typed in. The transcript Alex received on
   2026-09-11 had a hand-built header that read 0 calls / $0.000 for every seat
   while the footer said $0.147 spent; this exists so that cannot happen again.
   Usage: node scripts/room-transcript.js <room-id | path/to/r-*.json> [--out file.md] */
const fs = require("fs");
const os = require("os");
const path = require("path");

const RATE_IN = 1.25 / 1e6, RATE_OUT = 10 / 1e6;   // main.js display rates; not billing
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : null;
const ref = args.find((a, i) => !a.startsWith("--") && i !== outIdx + 1);
if (!ref) { console.error("usage: room-transcript <room-id|path> [--out file]"); process.exit(1); }
const sessionsDir = path.join(os.homedir(), "Library", "Application Support", "Crowe Logic", "sessions");
const file = ref.endsWith(".json") ? ref : path.join(sessionsDir, `${ref}.json`);
const s = JSON.parse(fs.readFileSync(file, "utf8"));
const room = s.room || s;
let names = {};
try {
  const v = require("../rooms/agents.vendored.json");
  const list = Array.isArray(v) ? v : (v.agents || Object.values(v));
  for (const a of list) if (a && a.id) names[a.id] = a.name || a.id;
} catch {}
const seatName = (id) => id === ":operator" ? "Operator (human)" : (names[id] || id);
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const usd = (n) => `$${Number(n || 0).toFixed(4)}`;

const agents = room.agents || [];
const cost = room.cost || {};
const rows = agents.map((a) => {
  const c = cost[a.agentId] || { usd: 0, promptTokens: 0, completionTokens: 0, calls: 0 };
  return { id: a.agentId, name: seatName(a.agentId), model: a.model || "room default", ...c };
});
for (const id of Object.keys(cost)) if (!rows.find((r) => r.id === id)) rows.push({ id, name: seatName(id), model: "?", ...cost[id] });
const sum = rows.reduce((t, r) => t + (r.usd || 0), 0);
const calls = rows.reduce((t, r) => t + (r.calls || 0), 0);
const spent = Number(room.spentUsd || 0);
const reconciles = Math.abs(sum - spent) < 1e-6;
const recomputed = rows.reduce((t, r) => t + (r.promptTokens || 0) * RATE_IN + (r.completionTokens || 0) * RATE_OUT, 0);

const L = [];
L.push(`# Crowe Logic room transcript: ${s.title || s.id}`);
L.push("");
L.push(`Room \`${s.id}\`. Budget ${usd(room.budgetUsd)}. Spent ${usd(spent)} over ${calls} model calls. Critique rounds: ${room.critiqueRounds || 0}. Halted: ${room.halted || "no"}. Saved ${iso(s.updatedAt || Date.now())}.`);
L.push("");
L.push("| Seat | Model | Calls | Prompt tokens | Completion tokens | USD |");
L.push("|---|---|---:|---:|---:|---:|");
for (const r of rows) L.push(`| ${r.name} | ${r.model} | ${r.calls || 0} | ${r.promptTokens || 0} | ${r.completionTokens || 0} | ${usd(r.usd)} |`);
L.push(`| **Total** | | **${calls}** | | | **${usd(sum)}** |`);
L.push("");
L.push(reconciles
  ? `Seat total equals the room's recorded spend (${usd(spent)}).`
  : `WARNING: seat total ${usd(sum)} does not equal the room's recorded spend ${usd(spent)}.`);
L.push(`Cost basis: prompt tokens x $1.25 per million plus completion tokens x $10 per million, the app's flat display rate for every model (recomputed here: ${usd(recomputed)}). This is a metering estimate, not a vendor invoice.`);
L.push("");
for (const m of s.messages || []) {
  const to = Array.isArray(m.to) && m.to.length ? ` to ${m.to.join(", ")}` : "";
  L.push(`## ${seatName(m.author)} [${m.kind}]${to} at ${iso(m.at)}`);
  L.push("");
  L.push(String(m.content || "").trim());
  L.push("");
}
const md = L.join("\n");
if (out) { fs.writeFileSync(out, md); console.log(`wrote ${out} (${rows.length} seats, ${calls} calls, ${usd(sum)}${reconciles ? "" : ", DOES NOT RECONCILE"})`); }
else process.stdout.write(md);
