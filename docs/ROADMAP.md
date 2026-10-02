# Crowe Logic desktop — roadmap & ship-readiness

Status: last verified 2026-09-17 against the 0.24.13 release, its release run and the live feeds. Companions: HARNESS-ARCHITECTURE.md,
PLUGINS.md, RESEARCH-PRODUCTIVITY.md (how we would measure whether any of this
helps anyone — a design, not a result).

**CI is back, and the rail runs.** The account-level Actions outage that began
around 2026-08-25 (every run `startup_failure` at 0s, here and in
crowe-logic-foundry) had ended by 2026-09-10. Since then `ci.yml` has gated
every pull request, `release.yml` has built Windows and Linux for every tag from
0.24.8 and signed the Windows installer from 0.24.9, and the daily
`verify-release.yml` schedule has passed every day since at least 2026-09-14.
The paragraph that stood here through 0.24.6 said none of that was happening.
It was true when written; its history is kept under "On CI" below.

Every row below was re-checked on 2026-09-17 against the code, the v0.24.13
release run and the live feeds, with the source noted. Rows that cannot be
verified from this repo (anything backend or vendor-side) say so rather than
claiming a state.

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
- 0.24.1–0.24.13: the release rail on CI (Windows and Linux built for every tag
  from 0.24.8, the Windows installer signed through Azure Trusted Signing from
  0.24.9, feeds verified after each publish and daily), a Crowe Logic for
  Developers channel with its own feeds on all three platforms, Rooms rebuilt
  as colleagues you message (the Messages rail, bubbles and runs, Delivered and
  Read, reactions the seat reads, worker marks that ride the turn), an Activity
  pane, tools that always ask (export_document, generate_image, share_preview,
  send_email), the Channel Analytics connector as a utility process, a
  Repositories lane, plain-shell terminals, a headless CLI, and the chat seat
  reading Rooms (0.24.13).
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

**Public: close. The distribution gaps below are closed; what remains is
backend, vendor and legal work:**

| Gap | Why it blocks public | State |
|---|---|---|
| ~~mac code signing + notarization~~ | app is Notarized Developer ID, auto-notarize hook wired | done (0.9.0) |
| ~~Auto-update (electron-updater to R2)~~ | can't ship fixes to installed users | done: all six feeds (stable and Developers, mac, win, linux) serve 0.24.13; `verify-release.js 0.24.13 --full` passed for both channels on 2026-09-17; the daily `verify-release.yml` schedule green since at least 2026-09-14 |
| ~~Windows/Linux parity builds~~ + smoke | half the audience | builds done: `release.yml` builds both on every tag since 0.24.8 and the v0.24.13 run's `Get-AuthenticodeSignature` gate read Valid; the download page offers all three. Launch smoke is macOS only (`scripts/smoke-packaged-mac.sh --app`); a Windows or Linux launch of the packaged app is still by hand |
| ~~Crash reporting + minimal telemetry~~ | flying blind post-launch | done, `main.js:59`; network submission opt-out |
| ~~First-run onboarding (sign-in to first task)~~ | funnel dies without it | done; 3-step card with sign-in and explore |
| ~~CI (smoke suite on push)~~ | regressions ship silently | done: runs start and pass again since 2026-09-10 (the outage was account-level); every pull request merged for 0.24.9 through 0.24.13 waited on a green `ci.yml` |
| ~~R2 publish + live verification~~ | a release that uploads but does not resolve fails on a user's machine | done: `publish-rclone.sh` runs a version, size and SHA-512 preflight, `verify-release.js` runs after every publish and daily; 0.24.13 verified on both channels 2026-09-17, every file matching its feed hash and `SHA256SUMS` covering every artifact |
| ~~Dependency updates~~ | advisories accumulated with nothing filing fixes | done; dependabot files weekly grouped PRs, audit clean at 0 findings |
| ~~Windows signing cert~~ | SmartScreen warning kills trust | done: Azure Trusted Signing (`win.azureSignOptions`, signer CN Michael Crowe, Microsoft timestamp) on every release from 0.24.9. SmartScreen reputation accrues per certificate, so a warning may still show until it does; organization validation would name the company instead of the person |
| Gateway hardening: rate limits, plan enforcement, health endpoint | abuse + cost exposure | open, backend (not verifiable here) |
| Auth keepalive polish (refresh edge cases seen in testing) | silent sign-outs feel broken | open, refresh exists but edge cases unconfirmed |
| Legal/support: privacy policy, EULA surfacing, support channel | table stakes | support page live at crowelogic.com/support (2026-09-14); drafts in `docs/legal/` grounded in actual app behaviour still need counsel review, confirmed contact addresses, and surfacing in the installer/download page |
| ~~A way to pay from inside the app~~ | the installed app could not sell; every checkout surface was excluded from the package | done and shipped since 0.24.7: `renderer/plan.js`, `crowe:billing:*` in main.js, Stripe opens in the system browser, tier picked up on focus via the refresh token. `scripts/test-plan.js` |
| One price ladder across Stripe and the catalog | the catalog Worker sells Pro at $99 while Stripe has a live "Crowe Logic Pro Monthly" at $149, among 23 overlapping recurring prices | open, vendor-side, not re-checked from this repo on 2026-09-17: archive the dead prices, one product per tier |
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
workflow passes" as different claims. The second outage was account-level and
ran from about 2026-08-25 to 2026-09-10; the status note at the top of this
file described it while it lasted, and runs have started and passed since.

**On testing:** what was one smoke script is now a chained suite (`npm test`):
some thirty node checks (harness 105, electron security 122, rooms, mobile
bridge, CLI 31, cloud 37, mail 47, export document 30, generate image 21, share
preview 40, channel analytics, repositories, messages, marks, activity, version
sync and parity, QR, packaging, companion, contrast, preview/mark drift,
releases worker, release verification) and seven Electron suites that assert
behaviour in a real DOM (icons 17, panels 104, mobile shell 29, install-time
spaces in two configurations, live rooms, the plugin fork). Beyond `npm test`,
`scripts/smoke-packaged-mac.sh` launches a packaged build on a throwaway
profile and `scripts/verify-release.js` meets a published release the way an
updater does. The panel system and the phone shell, the most stateful code in
the app, are the best-covered.

**Path to public beta.** Distribution is continuously verified again: CI gates
every pull request, `release.yml` builds and signs all three platforms, and the
feeds are proven daily. Left before claiming public-launch readiness: gateway
limits and plan enforcement (backend), auth keepalive edge cases, counsel
sign-off on the legal drafts, the price ladder, and SmartScreen reputation for
the Windows certificate.

## Horizons

- **H1 (now → public beta):** the open rows above, gateway limits, auth
  keepalive, counsel sign-off and the price ladder; the download page is
  already open.
- **H2 (1.0):** GitHub plugin GA + Git pane PR tab; gateway /plugins registry
  (Phase 2, Codex); health/evals lanes live; featured-role catalog flags
  live; Crowe Sense plugin server (first domain plugin).
- **H3 (differentiation):** Cortex-for-code on jj + turn-level provenance;
  Parallel Synth/Talon plugin servers (Studio becomes real production);
  surface contributions (Phase 3 plugins); team/multi-seat.
