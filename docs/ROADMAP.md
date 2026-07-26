# Crowe Logic desktop — roadmap & ship-readiness

Status: last verified 2026-07-25 at 0.13.0. Companions: HARNESS-ARCHITECTURE.md, PLUGINS.md.

Every "done" below was re-checked against the code on 2026-07-25, with the
source noted. Rows that cannot be verified from this repo (anything backend or
vendor-side) say so rather than claiming a state.

## Where we are (shipped, verified)

- 0.7.x: four spaces (Chat/Projects/Studio/Cultivation), live Home control
  surface, catalog-driven expert routing, chat markdown + chronological
  character streaming + stage-aware thinking glyphs.
- 0.8.0: official plugins (manifest over MCP, tier-gated, provenance-tracked;
  crowe-skills live, GitHub next).
- 0.9.0: workbench ergonomics — bottom terminal drawer (Ctrl+`), app-wide
  status bar (branch/dirty/plugins), Cmd+P quick open, Output event stream,
  git pull/push, GitHub official plugin entry.
- 0.13.0: shell rework — one sidebar replaces four competing navigations, the
  workspace toolbar becomes a dock tab strip with an add-panel palette, stack
  is the default panel layout, and the type scale collapses to five tokens.
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

| Gap | Why it blocks public | State |
|---|---|---|
| ~~mac code signing + notarization~~ | app is Notarized Developer ID, auto-notarize hook wired | done (0.9.0) |
| ~~Auto-update (electron-updater to R2)~~ | can't ship fixes to installed users | done, `main.js:853`; skipped on dev/unsigned runs |
| ~~Windows/Linux parity builds + smoke~~ | half the audience | done, `release.yml` matrix builds win/linux/mac |
| ~~Crash reporting + minimal telemetry~~ | flying blind post-launch | done, `main.js:34`; network submission opt-out |
| ~~First-run onboarding (sign-in to first task)~~ | funnel dies without it | done, `renderer.js:1251`; 3-step card with sign-in and explore |
| ~~CI (smoke suite on push)~~ | regressions ship silently | done and green as of 2026-07-25, see note below |
| Windows signing cert | SmartScreen warning kills trust | open, needs EV cert (vendor, not verifiable here) |
| Gateway hardening: rate limits, plan enforcement, health endpoint | abuse + cost exposure | open, backend (not verifiable here) |
| Auth keepalive polish (refresh edge cases seen in testing) | silent sign-outs feel broken | open, refresh exists but edge cases unconfirmed |
| Legal/support: privacy policy, EULA surfacing, support channel | table stakes | open, nothing in `docs/` yet |
| Automated test coverage beyond the smoke suite | smoke asserts panels mount, not that they behave | open, see below |

**On CI:** this table previously read "DONE" from the day the workflow file
landed. The workflow existed but failed on every run for two separate reasons,
so nothing was actually being verified: Electron's `chrome-sandbox` ships
without the SUID bit and aborted before the app loaded, and once that was
fixed the suite passed and then crashed on quit because no one killed the PTYs.
Both are fixed and the run is green. Treat "the workflow exists" and "the
workflow passes" as different claims.

**On testing:** `scripts/smoke-shot.js` is the only automated coverage, and it
asserts that panels mount rather than that they behave. The quit crash above
shipped undetected under it. The panel system is the most stateful code in the
renderer and the place to start.

**Path to public beta.** The distribution work is now largely done; what is
left is the vendor cert, the backend limits, legal docs, and test depth.

## Horizons

- **H1 (now → public beta):** the table above, plus R2 publish of 0.9.x.
- **H2 (1.0):** GitHub plugin GA + Git pane PR tab; gateway /plugins registry
  (Phase 2, Codex); health/evals lanes live; featured-role catalog flags
  live; Crowe Sense plugin server (first domain plugin).
- **H3 (differentiation):** Cortex-for-code on jj + turn-level provenance;
  Parallel Synth/Talon plugin servers (Studio becomes real production);
  surface contributions (Phase 3 plugins); team/multi-seat.
