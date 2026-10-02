# Crowe Logic (desktop)

Desktop app that chats with language models through the CroweLM gateway and lets you approve their edits, with a terminal, a browser, and git in the same window, for anyone with a Crowe ID.

## Status

working

Version 0.24.13 (`package.json`), released 2026-09-17. All six update feeds serve 0.24.13: the stable channel and the Crowe Logic for Developers channel, each for macOS, Windows and Linux. Windows and Linux installers are built on CI for every tag; the Windows installer has been signed through Azure Trusted Signing since 0.24.9. The phone app under `mobile/` is at 0.25.7 and has its own README.

## Install and first run

Run on 2026-09-10 in a fresh clone on macOS (Darwin 25.5.0). Output is copied from the run.

```
$ node --version
v26.5.0

$ npm --version
11.17.0

$ npm install --no-audit --no-fund
added 285 packages in 1s
npm warn allow-scripts 2 packages have install scripts not yet covered by allowScripts:
npm warn allow-scripts   electron-winstaller@5.4.0 (install: node ./script/select-7z-arch.js)
npm warn allow-scripts   node-pty@1.1.0 (install: node scripts/prebuild.js || node-gyp rebuild; postinstall: node scripts/post-install.js)

$ npx electron --version
v43.4.0
```

The `node-pty` warning is this machine's npm policy, not a fault in the repo. The terminal panel needs that native build; on a machine without the policy, `npm install` builds it.

Then start the app:

```
npm start
```

We did not run `npm start` for this README, so there is no output to show. The window asks you to sign in with a Crowe ID; the browser opens for the sign-in and the app stores the token in its own config directory.

### Headless

The same agent runs without the window, for CI, SSH and scheduled work:

```bash
export CROWE_TOKEN=...
node bin/crowe.js --tier execute --yes --json "run the tests and fix what fails"
```

Same harness, same tiers, same gates, same verifier, same journal. It denies
approvals when there is no terminal to ask, and it exits non-zero on a failed
verdict. See [docs/CLI.md](docs/CLI.md).

The test suite that does not need a display, run on 2026-09-17 against 0.24.13:

```
$ node scripts/test-harness.js
harness: 105 tests passed

$ node scripts/test-electron-security.js
electron-security: 122 checks passed

$ node scripts/test-sense.js
14 passed, 0 failed

$ node scripts/test-rooms.js
all room checks passed

$ node scripts/test-companion.js
all companion checks passed

$ node scripts/test-mobile-bridge.js
all mobile bridge checks passed

$ node scripts/test-brand-copy.js
ok      brand copy: 25 files, no em dashes, no emoji, rings on --focus
```

Also passed that day: `test-plan.js`, `test-version-parity.js` (5/5), `test-qr.js`, `test-packaging.js`, `test-web-bridge.js`, `test-cli.js` (31), `test-cloud.js` (37), `test-mail.js` (47), `test-export-document.js` (30), `test-generate-image.js` (21), `test-share-preview.js` (40), `test-channel-analytics.js`, `test-marks.js`, `test-messages.js`, `test-activity.js`, `test-repos.js`. The Electron-hosted suites ran on the same Mac: `test-panels.js` 104/104, `test-mobile-shell.js` 29/29, `test-icons.js` 17/17.

Not run that day: `npm start`, `test-install-spaces.js`, `test-rooms-live.js`, and every `npm run build:*`. Building installers needs signing credentials; `docs/BUILD-AND-RELEASE.md` lists them. The installed 0.24.13 apps, stable and Developers, were launched instead on a throwaway profile with `scripts/smoke-packaged-mac.sh --app`, which checks the fuses, the bundled server's utility process and that the live profile is never opened.

## What runs today

Each item names the file that holds it.

- Sign-in with a Crowe ID using OAuth2 authorization code with PKCE and a loopback redirect. The main process holds the token; the renderer gets only your email and tier. `main.js`, `preload.js`.
- Chat posted to `{baseUrl}/api/gateway/chat` with an OpenAI-format `tools` array; the gateway returns `tool_calls` and the app executes them. `main.js`.
- Four autonomy tiers, `plan`, `readonly`, `edit`, `execute`, gating which tools the model may call. `main.js`, `harness.js`, tested in `scripts/test-harness.js`.
- Proposed edits shown as diffs you approve or reject, plus a separate approval gate for actions you list. `harness.js`, `preload.js`.
- A scan for secrets (private key blocks, Stripe live keys, Google keys, and others) in text before it leaves the app. `harness.js` `scanForSecrets`, tested in `scripts/test-harness.js`.
- A terminal panel on `node-pty` and xterm. `main.js`, `package.json`.
- A browser panel in a `<webview>` with permission requests refused by the main process. `main.js`, `renderer/renderer.js`, tested in `scripts/test-electron-security.js`.
- A file tree, a git pane, and a sessions browser. `preload.js` (`fs`, `git`, `sessions`), `main.js`.
- MCP client: servers listed in the config are launched and their tools appear to the model as `mcp__<server>__<tool>`. `main.js` `mcpConnect`.
- Rooms: several named agents and you in one thread, kept as standing colleagues. A room has a brief, routines that let it speak first, seats that work out loud and ask with tappable options, per-seat cost, and critique and revise rounds. Seats run read-only until worktree isolation lands; the isolation module exists and is tested but not switched on. `rooms/engine.js`, `rooms/worktrees.js`, tested in `scripts/test-rooms.js`, `docs/ROOMS-REPORT.md`.
- A headless runner, `bin/crowe.js`: the same harness in a terminal, exit codes as the contract. `cli/`, `docs/CLI.md`, tested in `scripts/test-cli.js`.
- A control-plane boundary, off by default: authorize before a turn, record after it. `cloud/`, tested in `scripts/test-cloud.js`.
- Phone pairing over a QR code with per-device tokens that survive a restart. `companion.js`, `qr.js`, tested in `scripts/test-companion.js` and `scripts/test-qr.js`.
- Cultivation records and a poller for Crowe Sense readings. `grow-schema.js`, `sense.js`, tested in `scripts/test-sense.js`.
- Plugins declared in `plugins.builtin.json`, described in `docs/PLUGINS.md`.
- Mail: a `send_email` tool that submits over SMTP with STARTTLS or implicit TLS and an app password, offered only while the Mail plugin is on, gated at Execute behind an approval card that shows the whole message and names the sender and the SMTP server, both re-checked at send time. `mail.js`, tested in `scripts/test-mail.js`.
- Install-time choice of spaces through `CROWE_SPACES` or `croweSpaces` in the packaged `package.json`. `main.js`.
- Update checks through `electron-updater` against the release feeds named under `build.publish` in `package.json`. `main.js`.
- A phone build of the same renderer in a Capacitor shell. `mobile/`.
- Messages: Rooms read as conversations with workers. A worker's bubbles carry its mark, texts group into runs, your last text shows Delivered and Read, a typing bubble shows while a worker works, and a reaction (Good, More, No, Why) on a worker's bubble is read by that worker on its next turn. Workers are named as colleagues: Operator, Studio Director, Orchestrator. `renderer/messages.js`, `renderer/renderer.js`, tested in `scripts/test-messages.js` and `scripts/test-panels.js`.
- Worker marks: each worker wears one of eight thinking marks as vector, animated only while it reasons and still under reduced motion. The mark at the head of a turn rides beside the newest block while the turn runs and goes home when it lands. `renderer/marks.js`, `renderer/renderer.js` `followMark`, tested in `scripts/test-marks.js` and `scripts/test-panels.js`.
- An Activity pane beside the chat that shows the agent's work as it happens, with a Follow mode. `renderer/activity.js`, tested in `scripts/test-activity.js`.
- The chat seat can read Rooms: `list_rooms` and `read_room`, read-only, offered to your own seat and never to a room seat, so one room learns of another only through your relay. `harness.js`, `main.js` `roomsForHarness`, tested in `scripts/test-harness.js` and pinned in `scripts/test-electron-security.js`.
- Tools that always ask before they act: `export_document` (Markdown in, a PDF, HTML or Markdown file out under `exports/`), `generate_image` (a picture from a prompt through your own image key, saved under `assets/generated/`), `share_preview` (a temporary public link to a folder or a local port, with an expiry and a stop). `export-document.js`, `share-preview.js`, `harness.js`, each tested in its `scripts/test-*.js`.
- Channel Analytics: the first server bundled in the app, a read-only connector over a channel manager's state, started as a utility process from the packaged app. `plugins/channel-analytics/server.js`, tested in `scripts/test-channel-analytics.js` and `scripts/test-plugin-fork.js`.
- A Repositories lane in Projects: the workspace's GitHub remote, its pull requests and issues, every call a read. `repos.js`, `renderer/renderer.js`, tested in `scripts/test-repos.js`.
- Terminals are plain shells: every terminal-backed panel opens your login shell at its prompt and types nothing. `main.js`, `renderer/renderer.js`.
- The release rail: `release.yml` builds Windows and Linux on every tag and signs the Windows installer through Azure Trusted Signing behind a `Get-AuthenticodeSignature` gate; the macOS build is notarized and stapled on the release machine; `scripts/publish-rclone.sh` publishes to R2 with a version, size and SHA-512 preflight; `scripts/verify-release.js` proves every feed and every named file resolve, after each publish and daily on a schedule. `scripts/smoke-packaged-mac.sh` launches a packaged build on a throwaway profile.

## Roadmap

Not built. `docs/ROADMAP.md` carries the working list and says which rows were checked against code and when. The two items an earlier README named as not done, an automatic Windows build and Windows code signing, are done: `release.yml` builds Windows and Linux on every tag and the Windows installer is signed through Azure Trusted Signing. What the roadmap still lists as open is backend and legal work, not distribution: gateway limits and plan enforcement, auth keepalive edge cases, counsel review of the legal drafts, and the price ladder.

## Limits

This is a client. Without a Crowe ID and a reachable CroweLM gateway, chat does not work and the tiers do not unlock. The gateway, the models behind it, and Crowe ID are separate services not in this repository.

The app runs shell commands, edits files, and browses the web on the user's behalf when the autonomy tier allows it. The tier gates, the approval prompts, and the secret scan are tested in this repo and nowhere else. No outside review of the security of this app has been done. Do not point it at a machine or a repository you cannot afford to have changed.

Verified on 2026-09-17 from this clone and this Mac: dependency install, the Electron version, the tests listed above, a launch of the installed 0.24.13 apps on a throwaway profile, and the published release itself: `scripts/verify-release.js 0.24.13 --full` passed for both channels, every installer matching its feed's SHA-512; the macOS app assessed by Gatekeeper as Notarized Developer ID with a stapled ticket; the Windows installer's Authenticode signature reported Valid in the v0.24.13 release run, signer Michael Crowe, timestamped by Microsoft. Not verified that day: sign-in against the live gateway, a Windows or Linux launch, or the phone build. Linux artifacts are not code-signed; their integrity rests on the feed's SHA-512 and `SHA256SUMS`.

The old README compared this app with other agent tools and claimed a market position. Nothing in this repository measures that, so it is gone.

## License and contact

Proprietary. See `LICENSE` (`SPDX-License-Identifier: LicenseRef-Proprietary`); `package.json` carries the same identifier. Versions before 0.7.1 shipped under Apache License 2.0, and the LICENSE file says so. Third-party notices are in `THIRD_PARTY_NOTICES.md`.

Contact: michael@crowelogic.com
