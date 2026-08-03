# Crowe Logic (desktop)

A cross-platform agentic reasoning and coding console over the CroweLM gateway.
Electron, so it runs the same on **Windows, Linux, and macOS** — the gap Cortex
(macOS-only) leaves open. Branded with the Crowe Logic avatar.

## Why this exists

Members on Windows/Linux had no first-class app, and the competitive agentic
CLIs each leave a wedge:

- **OpenAI Codex** over-reaches on edits and has no Linux desktop.
- **Claude Code** is locked to one model vendor + subscription.
- **Hermes** (Nous) is model-agnostic with great tool calling, but has no
  sandbox and rougher UX.

Crowe Logic desktop takes the best of all three: **model-agnostic** (any CroweLM
tier through the gateway), **native OpenAI-compatible tool calling**, and a
**GUI-native cross-platform** experience.

## Run it

```bash
npm install
npm start
```

Click **Sign in with Crowe ID** and complete sign-in in your browser (OAuth2
Authorization Code + PKCE). Your Pro entitlement unlocks the full CroweLM tiers.
Tokens are stored in the app's userData config (mode 600) and never leave the
main process; the renderer only ever sees your decoded email and tier.

## Build installers

```bash
npm run build:mac     # dmg + zip
npm run build:win     # NSIS .exe   (build on Windows or an ephemeral Windows VM)
npm run build:linux   # AppImage + deb
```

### Shipping a narrower build

Every build shows all four spaces by default. To hand someone an install that
opens with only the spaces their job needs — no mushroom farm, no film studio on
a machine bought to drive a terminal — name them at package time:

```bash
npx electron-builder --mac --config.extraMetadata.croweSpaces=chat,projects
```

Call electron-builder directly rather than `npm run build:mac -- …`: that script
is `electron-builder --mac && node scripts/staple-dmg.js release`, and npm
appends extra arguments to the end of the whole string, so the flag would reach
the stapler instead of the builder and be silently ignored.

Chat is never optional and is added back whether or not it is listed. Unknown
names are ignored, so a build outliving a space that gets removed still opens.

This is the install's **default**, not a lock: Settings › Spaces still offers the
full set, and someone who turns Studio back on keeps it across restarts. To try
a profile without building, set the same list in the environment:

```bash
CROWE_SPACES=chat,projects npm start
```

## iOS and Android

The same UI, in a Capacitor shell, over the same gateway:

```bash
cd mobile
npm install
npm run ios       # or: npm run android
```

`renderer/` is copied into the mobile build rather than forked — a change to the
desktop UI reaches the phone by rebuilding. What differs is underneath it: a
bridge that talks to the gateway over HTTPS instead of to a Node main process,
Capacitor Preferences instead of `userData`, and honest refusals for the shell,
the file tree and git, which iOS and Android do not allow. See
[`mobile/README.md`](mobile/README.md) — in particular the Crowe ID redirect URI,
which has to be registered before sign-in works on a device.

## Architecture

- `main.js` — window + the gateway bridge. Holds the token; POSTs to
  `{baseUrl}/api/gateway/chat`, forwarding `tools` and returning `tool_calls`.
- `preload.js` — exposes `window.crowe.{agent,auth,git,pty,fs,sessions,chat,getConfig,setConfig,installSpaces}` (contextIsolation on, nodeIntegration off).
- `renderer/` — the Crowe editorial UI (cream/ink/gold, self-hosted
  Fraunces/Inter/JetBrains Mono), chat loop, tool-call cards, settings.
- `assets/` — brand assets, all derived from one source of truth.

## Brand assets (one source of truth)

The mark is a chiral spore-whorl: a gold hexagonal core — the inoculum — with
six ink hyphae on the hex axes, every one curling the same rotational
direction. Gold appears in exactly one place, the core. The curl is what keeps
it out of other people's symbols: a straight six-fold radial is
mirror-symmetric, and mirror-symmetric six-fold forms are already the AI
sparkle and the snowflake. It replaced an isometric double-C hex cube, which
spoke freight and ERP and collapsed into mud below about 24px.

Everything derives from one generator, and nothing is drawn by hand:

```bash
npm run icons         # 24 vectors + renderer/mark-geometry.js, then every
                      # raster: icon.png/.ico/.icns, tray, mark, avatar,
                      # wordmarks, the iOS app icon, the Android mipmaps
npm run icons:check   # fail if any committed asset is not what the vectors
                      # draw today. Writes nothing.
```

`icons:check` exists because the assets drifted from the vectors four separate
times, and `scripts/test-icons.js` reported 14/14 through every one of them.
Its assertions are properties of the drawing — corner alpha, tile extent, the
macOS ladder — and those hold across brand revisions, so a render from an older
run of the same generator satisfies all of them. Re-rendering and comparing is
the only question staleness answers differently. It runs in `npm test` and CI.

There is no separate icon shell script. `scripts/gen-icons.sh` used to build
half this set with rsvg-convert and ImageMagick; it needed tools nobody had
installed, so it went unrun and `avatar.png` — which only it produced — sat at
the retired cube for months. Chromium does the rasterizing now, so there is
nothing to install.

Tune proportions in `scripts/gen-mark.js` and rerun; the in-app living mark
(`renderer/mark.js`) animates the same geometry (idle breath, reasoning drive,
tool-call ring). After changing `mark.png`, re-upload `/brand/mark.png` in the
releases Worker R2 bucket so the download page matches.

## Native tool calling

Send an OpenAI-format `tools` array and the model's `tool_calls` come back for
the app to execute; results go back as `tool` messages. The gateway forwards the
definitions and returns the calls but does not execute them, so the app keeps
full control. This is the capability power users asked for.

## Shipped (v0.4.0)

- Crowe ID sign-in (OAuth2 Authorization Code + PKCE) — no token pasting.
- Agentic tool loop with reviewable edit diffs (approve/reject) and a Stop button.
- Graduated autonomy tiers (read-only / edit / execute) in the header.
- Activity rail, sessions browser, and a built-in git version-control pane.
- Real PTY terminal, in-app browser, file tree; MCP client support.
- Glass-box HUD (live tokens / cost / tok-s) and a Cmd+K command palette.

## Roadmap

- Streaming token responses + a live reasoning strip.
- Total Rewind: checkpoint code + shell + chat, one-click restore.
- Syntax highlighting + copy on code blocks; per-hunk git staging.
- Auto-update via electron-updater; Windows code-signing.
