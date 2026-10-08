# Crowe Logic phone mirror and draft editor

Implementation status, October 6, 2026. The first desktop-hosted version is implemented. Crowe Logic mobile 0.26.9 (2609) was built, signed, installed and launched on Michael's iPhone. The signed desktop app and its real Control+G roundtrip were verified. Companion pairing and native HTTP over Tailscale were verified on the physical iPhone. Its live terminal displayed the running Crowe Logic CLI, and a two-line phone draft returned to that same waiting prompt without submission.

## Installed local build

- Desktop source: `/Users/crowelogic/Projects/crowe-logic-desktop-cli-editor`.
- Desktop app: `~/.local/share/crowe-editors/Crowe Logic.app`, with the existing CLI editor bundle identity. The previous app is backed up beside its installation receipt.
- Phone source: `/Users/crowelogic/Projects/crowe-logic-phone-mirror`, based on `119984b` and preserving 0.26.8's native tabs, web upgrade and authority gates. The older mobile directory in the desktop worktree is not the source installed on the phone.
- Phone navigation: Home → Shared terminal and drafts, after pairing. Choose a session, then Terminal, Draft or Review. Take control requires Execute mode on both ends. Draft writes require Edit or Execute.
- Start a CLI in the desktop app's terminal. Control+G opens a shared Crowe Logic draft; Save and return restores its exact text to the waiting CLI prompt without submitting it.
- Companion remains opt-in in desktop Settings. Both devices must be on the private Tailscale network. The desktop app must keep running and the Mac must stay awake.
- Existing unrelated terminals cannot be adopted retroactively. Hypheus and DeepParallel keep their own installed visual editor routing; shared draft registration currently covers Crowe Logic CLI.

## Verification

Eight terminal/draft integration tests, the real PTY and phone-sized UI roundtrip, the companion regressions, 141 Electron security checks, packaging checks and the standalone draft tests pass. The mobile bridge tests pass, including the preserved authority gates and native tab behaviors. Native iOS build, device install/launch and installed-version readback succeeded. The installed desktop CLI opened its shared editor and received the exact two-line draft without inference submission.

Physical-device acceptance completed: pairing, native HTTP over Tailscale, live terminal rendering and phone Draft → Review → Save and return. The exact text `One\nTwo` reached the desktop prompt; the verification text was then cleared without submission. Fast synthetic typing through Apple iPhone Mirroring dropped keystrokes; paced input worked. The final mobile rebuild disables draft autocorrection, capitalization and spellchecking, and distinguishes an empty draft from no open draft. Home waits for saved pairing settings at cold start; pairing persisted across the app update. Explicit phone lock/unlock and physical phone controller handoff remain untested. The background execution service and backend-hosted sessions remain future work.

## Current foundation

- `companion.js` provides opt-in private-network pairing, per-device bearer authentication, revocation, tier checks and bounded authenticated session/draft HTTP routes.
- `terminal-sessions.js` owns managed PTYs, xterm state, sequenced output, bounded replay, controller leases and draft revisions. `main.js` attaches the desktop client.
- `draft-bridge.js` accepts per-session capabilities on loopback. The packaged Python helper retains the actual draft file; remote clients receive only a scoped draft handle.
- `managed-draft-window.js` renders the shared draft in the native Crowe Logic window and validates every IPC sender.
- The phone bundles xterm plus `phone-mirror.js` and `phone-mirror.css`. Its transport uses the existing Capacitor native HTTP connection and Keychain-backed pairing credential.

## Product outcome

One execution host owns each session. Desktop and phone attach to that session. The phone has Terminal, Draft and Review views, with explicit connection state and a single active terminal controller.

Preserve product identity: Crowe Logic opens Crowe Logic, Hypheus opens Hypheus, and DeepParallel opens Cortex. Share transport and draft contracts beneath the product interfaces.

Use the existing companion pairing and private network for the first version. Add Crowe ID discovery and an authenticated relay later if needed. A relay carries traffic; it does not keep a sleeping computer's processes running.

## Implementation sequence

1. **Implemented: session ownership.** Move the PTY map and lifecycle into a session manager with stable IDs, metadata and multiple subscribers. Keep the existing Electron UI as one client. New shareable CLI sessions must launch through this manager. `crowe-logic --phone` is a possible future command, not an existing feature. Arbitrary processes already running in another terminal cannot be retroactively adopted by this design.
2. **Implemented: phone observation.** Add an authenticated streaming attachment to managed sessions, including terminal snapshots, bounded replay and reconnect. Retain terminal geometry and provide pan/zoom on the phone. An optional structured Activity view can reflow text separately.
3. **Implemented: shared drafts.** Register Control+G drafts with a session-scoped broker. Open the same draft in the desktop or phone editor. Review and return the accepted revision to the originating prompt without submitting it.
4. **Implemented: phone control.** Implement explicit controller acquisition, desktop reclaim and host-enforced leases. Add mobile Esc, Tab, arrows, Ctrl and Interrupt controls. Viewing remains the initial mode.
5. **Next: separate host lifetime.** Move the session manager into a local background service so closing the desktop UI does not kill managed sessions. The first Electron-hosted slice can survive phone disconnection but cannot survive desktop app termination.
6. **Later: backend execution.** Run sessions on an always-on execution host for workflows that must continue while the Mac sleeps or is off. Treat local and backend sessions as different hosts with explicit workspace and credential boundaries.

## Transport contract

- Every output event identifies the session, host generation and monotonically increasing sequence. Resume from the last applied sequence when replay is available.
- For a replay gap, obtain an authoritative terminal-emulator snapshot at a sequence boundary followed by subsequent events. An arbitrary tail of ANSI bytes cannot reliably reconstruct cursor position, alternate screen or screen erasure.
- Bound every subscriber queue. A slow or suspended phone must not stall the desktop; drop that subscriber's backlog and require resynchronization. Manage producer flow control independently.
- Only the current controller lease may send input or resize. A lease generation rejects stale input after handoff. Recheck authorization and autonomy tier on the host. Revocation immediately terminates attachments.
- The controller determines PTY columns and rows. Viewer rotation or keyboard appearance must not resize everyone else's session.
- Input messages have unique IDs and acceptance acknowledgments. Deduplicate uncertain retries; never blindly resend keystrokes after reconnect. Acceptance is not evidence that a command succeeded.
- This version uses bounded HTTP polling every 350 ms while the mirror is visible, with at most one poll in flight. Native HTTP carries the existing bearer header. A future WebSocket transport would need a short-lived one-use ticket, origin validation and an authentication timeout; it is not required by this implementation.
- Expect iOS suspension. Persist local drafts; keep the current cursor in memory and request a new snapshot on foreground or app relaunch. Do not assume a socket stays active while the phone is locked.

## Draft contract

The local editor helper registers `{sessionId, draftId, revision, text}` and retains ownership of the actual temporary file and return receipt. Remote clients receive a scoped draft handle, not an arbitrary filesystem write capability.

Saving includes `baseRevision` and an idempotency key. Reject stale updates with both revisions available for comparison. Never silently overwrite a desktop edit with an offline phone draft.

Returning is a separate operation against an accepted revision and the original waiting prompt. Write exactly that revision through the helper's existing result path. Guard against return to a different session, closed editor or newer prompt. Retried return requests must not apply twice.

Keep these states distinct: edited locally, saving, saved on host, reconnecting, conflict, returned and discarded. Offline content is labelled local until acknowledged by the host. Returning a draft never submits the prompt.

## Editor design

### Desktop

- Show the project, host and destination session in the title area.
- Use a roomy primary text editor with optional Markdown preview and a changes view.
- Keep selected context in a collapsed list; show only context the user explicitly includes.
- Show save state near the primary action. Use **Return to session** for the existing Control+G workflow, with submission remaining a separate terminal action.

### Phone

- Keep Terminal, Draft and Review as the three main views.
- Display host, project, connection and current controller above the views.
- Open a full-width draft editor with a bottom primary action and at least 44-point touch targets. Support platform text scaling, safe areas and keyboard avoidance.
- Begin with the operating system's keyboard dictation. No new transcription provider is needed for the first implementation.
- Review the destination and draft changes before returning. Offline editing remains available; returning waits for synchronization.
- Show terminal accessory keys only when the phone holds control. Make Interrupt visibly distinct from typing.

The accompanying design preview is simulated and makes no network connections.

## Acceptance checks

1. Desktop and phone render the same managed interactive session, including cursor movements, Unicode and alternate-screen programs.
2. Phone lock/unlock and network switching recover output without replaying input.
3. A slow viewer cannot freeze the host; viewers cannot input or resize; only one controller lease is valid.
4. Token revocation and autonomy-tier changes take effect during an open connection.
5. Control+G returns exact multiline content without submission. Cancellation and failed saves preserve the original draft.
6. Conflicting revisions and retried return requests cannot overwrite a later edit or target a different prompt.
7. Verify phone disconnection, desktop UI close, service termination and host sleep separately. State exactly which lifetimes are supported in each release.

## Use cases

- Watch a coding run away from the desk, review a failure, then dictate a follow-up draft.
- Begin a detailed prompt on the phone and return it to the same desktop session for execution.
- Review selected logs while troubleshooting equipment in the field, with the execution host and control state always visible.
- Follow a DeepParallel run in Cortex using the same session infrastructure and Cortex's own interface.
- Continue long work on a backend execution host when the local computer cannot remain awake.

## Technical references

- Apple app lifecycle: https://developer.apple.com/documentation/uikit/managing-your-app-s-life-cycle
- xterm.js flow control: https://xtermjs.org/docs/guides/flowcontrol/
- xterm.js terminal serialization: https://github.com/xtermjs/xterm.js/

Verification receipts: `~/.local/share/crowe-editors/phone-mirror-verification-2026-10-06/`. Mobile shell checks: 42/42. Companion pairing, live physical-phone terminal rendering and a two-line shared-draft return passed.
