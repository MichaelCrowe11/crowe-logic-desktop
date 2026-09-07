# Crowe Logic desktop — roadmap & ship-readiness

Status: last verified 2026-09-07 while preparing 0.24.6. Companions: HARNESS-ARCHITECTURE.md,
PLUGINS.md, RESEARCH-PRODUCTIVITY.md (how we would measure whether any of this
helps anyone — a design, not a result).

**Read the CI and release rows below before trusting anything else here.** Every
GitHub Actions run in this repository has ended in `startup_failure` at 0s since
at least 2026-08-25, and so has every run in crowe-logic-foundry, including
Dependabot's own dynamic workflows (`"path": "BuildFailed"`, empty workflow
name). The workflow YAML parses and the repository's Actions permissions are
`enabled`, so this is account-level, not a file in this repo. Everything the
rail does is therefore not happening: no automatic Windows build, no test gate
on push, and no daily `verify-release.yml` proof that the live feeds resolve.
`npm test` is green locally, and the manual mac and linux release path is the
only verified publish path from this machine.

Every "done" below was re-checked against the code on 2026-08-11, with the
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
- 0.14.x–0.16.0: the release rail became real. Published releases are
  reachable (R2 objects keyed off the update feeds, not guessed names),
  uploads stream so big installers survive bad networks, publishes are pulled
  into R2 rather than pushed, and every publish ends by proving the live
  feeds resolve (`scripts/verify-release.js`, also on a daily cron).
- 0.17.0–0.19.0: the identity the app actually wears (mark, wordmark, icons
  with their own check suite), the agent panel stopped showing an unused
  shell, and workflows landed with honest state.
- 0.20.0–0.24.0: say the operation and agents build the workflow, replies
  stream, rooms (multi-agent threads) with live tests, the mobile companion
  (Capacitor iOS/Android under /mobile, paired over QR), a spaces registry
  with install-time selection, and shell/nav fixes each release.
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
| Auto-update (electron-updater to R2) | can't ship fixes to installed users | mac and linux feeds live on 0.24.4; **win feed frozen at 0.24.0**; the daily `verify-release.yml` proof has not run since CI died |
| Windows/Linux parity builds + smoke | half the audience | `release.yml` has the matrix, but it needs a runner: **no Windows build exists for 0.24.1-0.24.4** and the download page says "Not in this release" |
| ~~Crash reporting + minimal telemetry~~ | flying blind post-launch | done, `main.js:59`; network submission opt-out |
| ~~First-run onboarding (sign-in to first task)~~ | funnel dies without it | done; 3-step card with sign-in and explore |
| CI (smoke suite on push) | regressions ship silently | **broken since ~2026-08-25**: the workflow is correct and the suite is green locally, but no run starts. Account-level Actions problem, fix at github.com/settings/billing |
| R2 publish + live verification | a release that uploads but does not resolve fails on a user's machine | 0.24.6 preparation fixes a hard-coded temporary checkout in the rclone publisher and adds version/size/SHA-512 preflight before uploads; 0.24.5 is the last published release on the mac and linux channels, the win channel still serves 0.24.0 because CI never built it; the daily cron re-check is down with CI |
| ~~Dependency updates~~ | advisories accumulated with nothing filing fixes | done; dependabot files weekly grouped PRs, audit clean at 0 findings |
| Windows signing cert | SmartScreen warning kills trust | CI plumbing wired (`release.yml` reads WINDOWS_CERTIFICATE secrets, builds unsigned while unset); the cert itself is a vendor purchase (OV/EV or Azure Trusted Signing) |
| Gateway hardening: rate limits, plan enforcement, health endpoint | abuse + cost exposure | open, backend (not verifiable here) |
| Auth keepalive polish (refresh edge cases seen in testing) | silent sign-outs feel broken | open, refresh exists but edge cases unconfirmed |
| Legal/support: privacy policy, EULA surfacing, support channel | table stakes | drafts in `docs/legal/` grounded in actual app behaviour; needs counsel review, confirmed contact addresses, and surfacing in the installer/download page |
| ~~A way to pay from inside the app~~ | the installed app could not sell; every checkout surface was excluded from the package | done, on main and unreleased: `renderer/plan.js`, `crowe:billing:*` in main.js, Stripe opens in the system browser, tier picked up on focus via the refresh token. `scripts/test-plan.js` |
| One price ladder across Stripe and the catalog | the catalog Worker sells Pro at $99 while Stripe has a live "Crowe Logic Pro Monthly" at $149, among 23 overlapping recurring prices | open, vendor-side: archive the dead prices, one product per tier |
| Automated test coverage beyond the smoke suite | smoke asserts panels mount, not that they behave | largely closed, see below |

**On CI:** this table previously read "DONE" from the day the workflow file
landed, and then read "done and green" for three weeks after the runs had
stopped starting. Both times the row was describing the workflow file rather
than a run. The paragraph below is the history of the first version of that
mistake; the second is in the status note at the top.

The workflow existed but failed on every run for two separate reasons,
so nothing was actually being verified: Electron's `chrome-sandbox` ships
without the SUID bit and aborted before the app loaded, and once that was
fixed the suite passed and then crashed on quit because no one killed the PTYs.
Both are fixed and the run is green. Treat "the workflow exists" and "the
workflow passes" as different claims.

**On testing:** what was one smoke script is now a chained suite (`npm test`):
thirteen node checks (harness, rooms, mobile bridge, version sync and parity,
QR, packaging, companion, contrast, preview/mark drift, releases worker,
release verification) and six Electron suites that assert behaviour in a real
DOM (icons, panels: 67 checks, mobile shell: 22 checks, install-time spaces in
two configurations, live rooms). The panel system and the phone shell, the
most stateful code in the app, are the best-covered.

**Path to public beta.** Distribution is not continuously verified while CI
is down. Restore working runners and Windows parity, verify the published
update feeds, reconcile the price catalog, and close the vendor certificate,
backend limits, and legal review items before claiming public-launch readiness.

## Horizons

- **H1 (now → public beta):** the three open rows above — vendor cert,
  gateway limits, counsel sign-off — then open the download page.
- **H2 (1.0):** GitHub plugin GA + Git pane PR tab; gateway /plugins registry
  (Phase 2, Codex); health/evals lanes live; featured-role catalog flags
  live; Crowe Sense plugin server (first domain plugin).
- **H3 (differentiation):** Cortex-for-code on jj + turn-level provenance;
  Parallel Synth/Talon plugin servers (Studio becomes real production);
  surface contributions (Phase 3 plugins); team/multi-seat.
