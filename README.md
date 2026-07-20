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

Then open **Settings**, paste your Crowe ID token (or API key), pick a model
(default `crowelm-zenith`, the frontier tier), and chat. The token is stored in
the app's userData config (mode 600) and never leaves the main process.

## Build installers

```bash
npm run build:mac     # dmg + zip
npm run build:win     # NSIS .exe   (build on Windows or an ephemeral Windows VM)
npm run build:linux   # AppImage + deb
```

## Architecture

- `main.js` — window + the gateway bridge. Holds the token; POSTs to
  `{baseUrl}/api/gateway/chat`, forwarding `tools` and returning `tool_calls`.
- `preload.js` — exposes `window.crowe.{chat,getConfig,setConfig}` (contextIsolation on, nodeIntegration off).
- `renderer/` — the Crowe editorial UI (cream/ink/gold, Fraunces/Inter), chat
  loop, tool-call cards, settings.
- `assets/` — Crowe Logic avatar + mark + app icon.

## Native tool calling

Send an OpenAI-format `tools` array and the model's `tool_calls` come back for
the app to execute; results go back as `tool` messages. The gateway forwards the
definitions and returns the calls but does not execute them, so the app keeps
full control. This is the capability power users asked for.

## Roadmap (scaffold -> product)

- Streaming responses + a live reasoning strip.
- The agentic edit-run-verify loop with reviewable diffs and one-key approve/reject.
- Graduated autonomy tiers (read-only / edit / execute) surfaced in the UI.
- A built-in terminal and file tree; MCP client support.
- Crowe ID OIDC sign-in (replace the paste-a-token step).
- Auto-update via electron-updater.
