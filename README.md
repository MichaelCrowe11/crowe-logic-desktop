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

## Architecture

- `main.js` — window + the gateway bridge. Holds the token; POSTs to
  `{baseUrl}/api/gateway/chat`, forwarding `tools` and returning `tool_calls`.
- `preload.js` — exposes `window.crowe.{agent,auth,git,pty,fs,sessions,chat,getConfig,setConfig}` (contextIsolation on, nodeIntegration off).
- `renderer/` — the Crowe editorial UI (cream/ink/gold, self-hosted
  Fraunces/Inter/JetBrains Mono), chat loop, tool-call cards, settings.
- `assets/` — brand assets, all derived from one source of truth.

## Brand assets (one source of truth)

The mark is the corporate double-C hex cube (blue hexagonal C + gold inner C
firing an arrow out the upper-right edge), generated as exact vector geometry:

```bash
node scripts/gen-mark.js    # mark.svg, mark-simple.svg, mark-tray.svg, icon.svg,
                            # renderer/mark-geometry.js (living mark polygons)
scripts/gen-icons.sh        # icon.icns / icon.ico / icon.png / avatar.png /
                            # mark.png / tray.png (needs rsvg-convert + magick)
```

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
