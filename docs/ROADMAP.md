# Crowe Logic desktop — roadmap & ship-readiness

Status: written 2026-07-22 at 0.9.0. Companions: HARNESS-ARCHITECTURE.md, PLUGINS.md.

## Where we are (shipped, verified)

- 0.7.x: four spaces (Chat/Projects/Studio/Cultivation), live Home control
  surface, catalog-driven expert routing, chat markdown + chronological
  character streaming + stage-aware thinking glyphs.
- 0.8.0: official plugins (manifest over MCP, tier-gated, provenance-tracked;
  crowe-skills live, GitHub next).
- 0.9.0: workbench ergonomics — bottom terminal drawer (Ctrl+`), app-wide
  status bar (branch/dirty/plugins), Cmd+P quick open, Output event stream,
  git pull/push, GitHub official plugin entry.
- Loop discipline: every release = implement → adversarial review workflow →
  fix → screenshot/e2e smoke → build → asar check → install → commit.

## Market position (mid-2026 climate)

The agentic-coding market has consolidated into three bands: AI IDEs
(Cursor, Windsurf — editor-first, massive adoption), agent CLIs/apps
(Claude Code, OpenAI Codex — operator-first, terminal DNA), and
platform-native (GitHub Copilot Workspace). Competing head-on as an
"AI code editor" is a losing race against nine-figure R&D budgets.

Crowe Logic's defensible lanes are different:
1. **Operator, not editor** — the desktop drives work through a reviewed
   agent loop with receipts; edits are diffs you approve, not autocomplete.
2. **Own model plane** — CroweLM routing over owned Azure/Cloudflare
   deployments = cost control + model mix nobody can clone from an API key.
3. **Vertical depth** — Cultivation is a real domain expert (crowelm-grower,
   Crowe Sense) serving a market (commercial mycology) no general tool touches.
4. **Converged company OS** — one surface for chat, code, film (Parallel
   Synth), music (Talon), commerce analytics; the plugin catalog makes each
   sibling product a one-click capability.
5. **Provenance (Cortex lane)** — turn-level version control (jj-backed,
   receipts attached to revisions) is an open lane none of the incumbents own.

## Are we ready to ship? Honest verdict

**Private/invited beta: yes, today.** The core loop is real, reviewed, and
stable; sign-in, routing, plugins, and the workbench all work end to end.

**Public: no — the gaps are distribution-grade, not product-grade:**

| Gap | Why it blocks public | Size |
|---|---|---|
| ~~mac code signing + notarization~~ ✅ DONE (0.9.0) | — app is Notarized Developer ID, auto-notarize hook wired | done |
| Windows signing cert | SmartScreen warning kills trust | needs MS/EV cert (user) |
| Auto-update (electron-updater → R2) | can't ship fixes to installed users | days — NEXT |
| Windows/Linux parity builds + smoke | half the audience | days |
| Crash reporting + minimal telemetry | flying blind post-launch | 1-2 days |
| First-run onboarding (sign-up → sign-in → first task) | funnel dies without it | 2-3 days |
| Gateway hardening: rate limits, plan enforcement, health endpoint (Codex, in flight) | abuse + cost exposure | backend, in flight |
| Auth keepalive polish (refresh edge cases seen in testing) | silent sign-outs feel broken | 1 day |
| CI (smoke suite on push; it exists, runs local-only) | regressions ship silently | 1 day |
| Legal/support: privacy policy, EULA surfacing, support channel | table stakes | 1-2 days |

**Path: ~2–4 focused weeks to public beta.** Order: signing → auto-update →
CI → crash reporting → Windows build → onboarding → gateway limits land →
public beta announce with the releases page.

## Horizons

- **H1 (now → public beta):** the table above, plus R2 publish of 0.9.x.
- **H2 (1.0):** GitHub plugin GA + Git pane PR tab; gateway /plugins registry
  (Phase 2, Codex); health/evals lanes live; featured-role catalog flags
  live; Crowe Sense plugin server (first domain plugin).
- **H3 (differentiation):** Cortex-for-code on jj + turn-level provenance;
  Parallel Synth/Talon plugin servers (Studio becomes real production);
  surface contributions (Phase 3 plugins); team/multi-seat.
