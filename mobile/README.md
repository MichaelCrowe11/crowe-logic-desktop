# Crowe Logic for iOS and Android

The same app, on a phone. `renderer/` is copied here unchanged and a mobile
bridge is put underneath it, so the conversation, the router, the spaces and the
grower's records look and behave the way they do on the desktop — and the three
things a phone genuinely cannot do say so instead of failing quietly.

```
mobile/
  capacitor.config.json   app id, webDir, plugin config
  src/
    mobile-bridge.js      window.crowe over HTTPS + Capacitor (replaces preload.js)
    mobile-ui.js          bottom tab bar, drawer, keyboard, back button, mobile copy
    mobile.css            phone layout: safe areas, one column, touch sizing
  scripts/
    build-www.js          assembles www/ from renderer/ + assets/ + src/
    gen-mobile-assets.js  draws resources/ (icon, launch art) from the brand SVGs
    serve.js              serves www/ for a desktop browser's device emulator
  ios/  android/          the native projects (committed — they carry the URL scheme)
  www/                    generated. Do not edit.
```

## Build and run

```bash
cd mobile
npm install
npm run www                # assemble www/ from the desktop renderer
npx cap sync               # copy it into ios/ and android/

npm run ios                # www + sync + open Xcode        (macOS, Xcode 15+)
npm run android            # www + sync + open Android Studio
npm run serve              # www on :8732, for a browser's device emulator
```

`npm run www` is not optional after a change to `renderer/` — the phone runs the
copy in `www/`, not the original. Two suites in the repo root's `npm test` cover
this directory, and both rebuild `www/` first, so neither depends on you having
remembered:

- `scripts/test-mobile-bridge.js` — plain Node. The bridge surface against
  `preload.js`, the routing table against `harness.js`, the rewritten copy
  against `renderer.js`, and the agent loop against a mocked SSE gateway.
- `scripts/test-mobile-shell.js` — Electron, in a 390×844 window. The part only
  a browser can answer: the tab bar, the drawer, the pane swap, sheet geometry,
  what is hidden, and no console errors at load.

Icons and launch art are generated, not committed:

```bash
node scripts/gen-mobile-assets.js     # resources/ from assets/*.svg (needs rsvg-convert)
npx @capacitor/assets generate \
  --iconBackgroundColor '#f7f3ea' --iconBackgroundColorDark '#16130f' \
  --splashBackgroundColor '#f7f3ea' --splashBackgroundColorDark '#16130f'
```

`@capacitor/assets` is run through `npx` rather than depended on: it pulls an
older Capacitor CLI, `sharp`, and a vulnerable `tar` transitively, and none of
that belongs in the lockfile of an app that ships to a store.

## What the phone does, and what it does not

**Real.** Chat and the agent loop against the CroweLM gateway, with streaming,
the same role routing as the desktop (cultivation, coding, reasoning,
long-context), the model catalog, Crowe ID sign-in, workspace licensing, the
cost and token HUD, the Workflows / Agent Fleet / Operator Control panels, and
provider keys.

**Local.** Sessions and the grower's records live in Capacitor Preferences
instead of `userData` — the phone keeps its own history and its own grow log,
validated against the same `grow-schema.js` the desktop store uses. A lot trace
exports to the share sheet rather than to a file dialog. The agent's tools here
are `read_grow`, `log_grow` (gated on the Edit tier) and `open_url`.

**Handed over, per file.** iOS and Android do not give an app the filesystem;
they give it a document picker. The paperclip in the composer is that picker,
and whatever the user chooses becomes readable to the agent at a `phone:<name>`
path — paired or not, at any tier above Plan. `write_file` to a `phone:` path
updates the app's copy (Edit and above); the platforms offer a webview no way
to overwrite the original where it lives, so a changed copy leaves through the
share sheet, from the chips row above the composer. Text files, 512 KB cap,
held in memory for the session only.

**Refused, with a reason.** The shell, the file tree, git, and MCP plugins.
There is no PTY on iOS or Android, no workspace folder to point at, and no way
to spawn a plugin server. Those panes state that rather than showing an empty
list, and the Settings rows that configure them are hidden.

## Crowe ID sign-in

The desktop's OAuth flow parks a loopback server on `127.0.0.1:8765` and hands
that to the browser as its redirect. A phone has no such port, so this app uses
a custom scheme instead:

```
com.crowelogic.mobile://auth/callback
```

registered in `ios/App/App/Info.plist` (`CFBundleURLTypes`) and in
`android/app/src/main/AndroidManifest.xml` (a `VIEW` intent-filter on the
`MainActivity`, which is `singleTask` so the redirect resumes the app rather
than starting a second copy of it).

**This URI has to be registered on the Crowe ID client** (`crowe-cli`, at
`https://id.crowelogic.com/realms/crowe`) as a valid redirect, alongside the two
loopback ports the desktop uses. Until it is, sign-in ends at the authorization
server with an `invalid_redirect_uri`. Two ways forward, either is fine:

- add `com.crowelogic.mobile://auth/callback` to the `crowe-cli` client, or
- register a separate public client for mobile and point the app at it by
  changing `CROWE_ID_CLIENT` and `DEFAULT_REDIRECT` in `src/mobile-bridge.js`.
  `scripts/test-mobile-bridge.js` checks the scheme in the redirect still
  matches the app id in `capacitor.config.json` and the two native projects.

Until either lands, Settings → **Token (Crowe ID)** takes a pasted access token
and everything else works.

## CORS, and why streaming has a fallback

The webview's page origin is `capacitor://localhost` on iOS and
`https://localhost` on Android, so every gateway call is cross-origin.

- `window.fetch` streams, which is what makes a reply arrive word by word. It
  needs `api.crowelogic.com` to answer a preflight from those two origins.
- `CapacitorHttp` goes through the native HTTP stack, where same-origin policy
  does not apply — and returns one finished body, so it cannot stream.

The bridge streams over `fetch`, and if the network layer refuses outright —
which is what a blocked preflight looks like from inside the page: a `TypeError`
with no status — it repeats the call natively and returns the reply whole. The
app works either way; with CORS configured it works better. The origins to allow
are `capacitor://localhost` and `https://localhost`.

## Storage, plainly

Tokens, provider keys, sessions and grow records go through Capacitor
Preferences: `UserDefaults` on iOS, `SharedPreferences` on Android. That is
private to the app and separate from every other app on the device. It is *not*
the hardware-backed keychain `safeStorage` gives the desktop, and it is included
in an unencrypted device backup. The Key Manager says exactly that on screen
rather than repeating the desktop's promise of a vault.

## Layout notes

- One column below 820px: the rail becomes a drawer, and the workbench's two
  panes become a tab each. Above that width the desktop layout is kept, so an
  iPad in landscape is the app you already know.
- `100dvh` minus a `--kb` the keyboard publishes — the column shrinks above the
  keyboard rather than the composer being translated over the transcript.
- Safe-area insets on the header, the drawer and the tab bar.
- Every focusable field is 16px, because iOS zooms a page with anything smaller
  and gives the user no way back out.
