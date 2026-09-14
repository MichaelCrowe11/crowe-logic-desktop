# Official plugins — Crowe Logic desktop

Status: Phase 1 shipped in 0.8.0 (2026-07-22); Phase 2 (gateway registry) next. Companion to HARNESS-ARCHITECTURE.md.

## The insight

The desktop already runs a proto-plugin system: the MCP client in main.js
(stdio JSON-RPC, `tools/list`, namespaced `mcp__<name>__<tool>`) plus the raw
JSON textarea in Settings. Every "official plugin" question reduces to
formalizing what exists — the same move as catalog-driven routing: **the
gateway serves a curated manifest, the desktop renders a one-click picker,
and everything degrades gracefully when the catalog is unreachable.**

A plugin IS a manifest entry + an MCP server + declared surface hooks.
No new runtime, no plugin VM, no API sprawl.

## Manifest shape (v1)

Served by `GET /api/gateway/plugins` (Phase 2) and bundled in-app as
`plugins.builtin.json` (Phase 1). Pure data, no code:

```json
{
  "id": "crowe-sense",
  "name": "Crowe Sense",
  "description": "Grow-room telemetry and farmlog for the Cultivation space.",
  "category": "cultivation",            // cultivation | studio | projects | ops | data
  "spaces": ["cultivation"],            // where the desktop suggests it
  "official": true,
  "mcp": { "command": "npx", "args": ["-y", "@crowelogic/sense-mcp"], "env": {} },
  "envPrompts": [{ "key": "SENSE_API_KEY", "label": "Crowe Sense API key" }],
  "tools": [                            // tier gating, applied by the harness
    { "match": "read_*",  "tier": "readonly" },
    { "match": "log_*",   "tier": "edit" }
  ],
  "glyph": "mycelial",                  // thinking glyph while its tools run
  "chips": ["Chart the last 72h of fruiting-room humidity"]
}
```

Rules: `official: true` entries come only from the gateway manifest or the
bundled copy; env secrets are collected via `envPrompts` at enable time and
stored in the plugin's config section — never inline in manifest JSON; a
plugin with no `tools` tier list defaults to `edit` (never `execute`).

A tool rule may add `"physical": true` for a tool that changes something in the
world outside the machine. Such a tool runs only at Execute and only after a
one-shot approval bound to its exact arguments, and `approvals: off` does not
silence the question. See HARDWARE.md. The Crowe Sense plugin's
`request_operation` is the first.

## How it lands on the 62 features

Ground-truth inventory (3-agent sweep, 2026-07-22): 17 main-process,
14 harness, 31 renderer features. The plugin system touches them in
four places only — everything else stays closed:

1. **Main: MCP client → plugin manager.** `mcpConnect` gains manifest
   awareness: enable writes `config.plugins.<id>` + spawns; disable kills.
   Status per plugin (connected, tool count, last error) in `get-config`.
2. **Harness: tier gating for `mcp__` tools.** execTool applies the
   manifest's per-tool tier exactly like built-ins (plan blocks writes,
   readonly blocks edit-tier plugin tools). Secret guard already applies.
3. **Renderer: picker + suggestions + status.** Settings' raw MCP JSON
   textarea becomes "Advanced"; above it, the official picker (toggle per
   plugin, env prompts on enable). Each space surface suggests its
   category's plugins; `toolGlyph()` reads the manifest glyph; the MCP
   badge expands to a per-plugin status popover; palette gains
   "Plugins: enable <name>".
4. **Explicitly NOT extensible:** the hex-cube mark (identity), auth/token
   handling (host-only facade), window webPreferences hardening, the
   autonomy tier semantics themselves.

## Launch catalog — the official nine

| Plugin | Space | Backing asset (exists today) |
|---|---|---|
| Crowe CLI | Projects | crowe-cli MCP server (execute_python, files, web) — reference impl |
| Crowe Sense | Cultivation | Crowe Sense telemetry + farmlog APIs |
| Parallel Synth | Studio | psynth JSON project doc — built for LLM co-editing |
| Talon Music | Studio | crowe-talon agent + talon_music.py in crowe-nimbus |
| Gateway Ops | Projects/Models | /health + /evals endpoints (Codex, in flight) |
| R2 Storage | Projects/Data | crowe-releases + dataset buckets |
| SWM Commerce | Projects | Shopify/Stripe read-only analytics |
| Channel Analytics | Projects | Shipped: `plugins/channel-analytics/server.js`, a read-only server over the channel manager's nightly state (snapshot, uploads, machine Shorts, hand tasks, brief, Stripe attribution); `run_collect` at edit |
| Crowe Skills | all | crowe-skills corpus server (skill_search/show) |

Third-party official (later, curated): GitHub, Slack, Notion — via the same
manifest, `official: true`, vetted commands only.

## Phases

- **P1 — desktop-only (no backend dependency).** Bundled manifest, Settings
  picker, enable/disable + env prompts, per-space suggestion chips, status
  popover. Ship with Crowe CLI + one domain plugin. Raw JSON stays as
  Advanced.
- **P2 — registry (Codex, crowe-nimbus).** `GET /api/gateway/plugins`
  (public, versioned, additive-only like /catalog); desktop fetches with
  the catalog-cache pattern; harness tier gating for plugin tools.
- **P3 — surface contributions.** Manifest-declared Home cards, lane
  content (Crowe Sense telemetry card in Cultivation), colophon counters,
  per-plugin thinking glyphs.

## Invariants

- Enable is one click; remove is one click; the app never breaks when a
  plugin's server dies (same graceful-degrade discipline as the router).
- Official manifest is additive-only: never remove an id a shipped desktop
  references (the MODEL_PLAN_ACCESS lesson).
- A plugin can add capability, never widen autonomy: tier gates and the
  secret guard apply to plugin tools with no opt-out.

## Channel Analytics: the first bundled server

The channel manager (`~/swm-channel-manager/manager.py`, launchd 00:02 and
07:25) already reads the YouTube Data API, the Analytics API and Stripe every
night and writes what it found. The plugin does not talk to YouTube; it reads
those files. A room seat asking for the morning numbers therefore costs no
quota, needs no credential, and sees exactly what the emailed brief saw.

Tools, all read-only by manifest rule except the last: `list_snapshot_dates`,
`get_channel_snapshot` (the brief's numbers in one read, text or json),
`get_snapshot_section`, `list_recent_uploads` (voiced and machine flags,
failed description checks), `list_machine_shorts` (with the hours of day they
land), `get_video_performance`, `list_hand_tasks`, `read_daily_brief`,
`get_stripe_attribution`, and `run_collect` at the edit tier, so a read-only
room cannot spend quota.

It is the first server that ships inside the app. The manifest names it with
two placeholders the loader resolves and nothing else does: `${APP}` is the
app's directory (`plugins/` is unpacked from the asar so a child process can
read it) and `${NODE}` as the command is the app's own Electron binary run as
plain Node, so no node is needed on the machine. Dates and video ids are
validated before they touch a path; sections are allowlisted; the two folders
it reads are the only two it opens, and `~/.swm-yt-creds` is never one of
them. `scripts/test-channel-analytics.js` drives it over its own wire.
