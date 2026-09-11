# Crowe Logic (desktop)

Desktop app that chats with language models through the CroweLM gateway and lets you approve their edits, with a terminal, a browser, and git in the same window, for anyone with a Crowe ID.

## Status

working

Version 0.24.7 (`package.json`). The macOS and Linux update feeds serve 0.24.7. The Windows feed serves 0.24.0, dated 2026-08-03, so Windows is six patch releases behind. The phone app under `mobile/` is at 0.25.6 and has its own README.

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

The test suite that does not need a display, run today:

```
$ node scripts/test-harness.js
harness: 83 tests passed

$ node scripts/test-electron-security.js
electron-security: 102 checks passed

$ node scripts/test-sense.js
14 passed, 0 failed

$ node scripts/test-rooms.js
all room checks passed

$ node scripts/test-companion.js
all companion checks passed

$ node scripts/test-mobile-bridge.js
all mobile bridge checks passed

$ node scripts/test-brand-copy.js
ok      brand copy: 21 files, no em dashes, no emoji, rings on --focus
```

Also passed today: `test-plan.js`, `test-version-parity.js` (5/5), `test-qr.js`, `test-packaging.js`, `test-web-bridge.js`.

Not run today: `npm start`, the Electron-hosted tests (`test-panels.js`, `test-icons.js`, `test-mobile-shell.js`, `test-install-spaces.js`, `test-rooms-live.js`), and every `npm run build:*`. Building installers needs signing credentials; `docs/BUILD-AND-RELEASE.md` lists them.

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
- Rooms: several agents work the same repo on separate git worktrees and their results are merged or kept as branches. `rooms/engine.js`, `rooms/worktrees.js`, tested in `scripts/test-rooms.js`.
- Phone pairing over a QR code with per-device tokens that survive a restart. `companion.js`, `qr.js`, tested in `scripts/test-companion.js` and `scripts/test-qr.js`.
- Cultivation records and a poller for Crowe Sense readings. `grow-schema.js`, `sense.js`, tested in `scripts/test-sense.js`.
- Plugins declared in `plugins.builtin.json`, described in `docs/PLUGINS.md`.
- Install-time choice of spaces through `CROWE_SPACES` or `croweSpaces` in the packaged `package.json`. `main.js`.
- Update checks through `electron-updater` against the release feeds named under `build.publish` in `package.json`. `main.js`.
- A phone build of the same renderer in a Capacitor shell. `mobile/`.

## Roadmap

Not built. `docs/ROADMAP.md` carries the working list and says which rows were checked against code and when. Two items we can confirm are not done today: an automatic Windows build, and Windows code signing. The Windows feed is still on 0.24.0.

## Limits

This is a client. Without a Crowe ID and a reachable CroweLM gateway, chat does not work and the tiers do not unlock. The gateway, the models behind it, and Crowe ID are separate services not in this repository.

The app runs shell commands, edits files, and browses the web on the user's behalf when the autonomy tier allows it. The tier gates, the approval prompts, and the secret scan are tested in this repo and nowhere else. No outside review of the security of this app has been done. Do not point it at a machine or a repository you cannot afford to have changed.

Verified today only from this clone: dependency install, the Electron version, and the tests listed above. Not verified today: a launch of the window, an installer build, sign-in against the live gateway, the Windows build, or the phone build. The Windows installer on the update feed is 0.24.0 while macOS and Linux are on 0.24.7.

The old README compared this app with other agent tools and claimed a market position. Nothing in this repository measures that, so it is gone.

## License and contact

Proprietary. See `LICENSE` (`SPDX-License-Identifier: LicenseRef-Proprietary`); `package.json` carries the same identifier. Versions before 0.7.1 shipped under Apache License 2.0, and the LICENSE file says so. Third-party notices are in `THIRD_PARTY_NOTICES.md`.

Contact: michael@crowelogic.com
