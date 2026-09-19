# Council autopilot

Implemented on `feat/rooms-council-autopilot`, based on desktop 0.24.14.
This is a local development implementation, not a published release.

## Operator workflow

1. Open Messages and start a conversation with a catalog model, or select several
   model contacts for a group. Specialists remain available beside models.
2. For autopilot, use at least three participants with distinct catalog engine
   identities. Known aliases of the same engine cannot count as separate voters.
   Where the catalog supplies no underlying engine identity, its model ID is the
   identity available to this client. Distinct IDs do not prove independent weights.
3. Open **Council**. Specify the goal, authority, quorum, maximum steps, maximum
   model calls and expiry. Check the explicit authorization box and start.
4. Watch the proposal, safety classification, independent votes, execution receipt
   and verification. The proposer rotates between steps and never votes on its
   own proposal. Reviewers cannot see one another's votes before deciding.
5. Pause or revoke at any time. A paused or interrupted run needs a new explicit
   operating agreement, never an automatic retry of a possibly completed action.
   Previous agreements, ballots and recovery snapshots remain in the Room.

## Authority and execution

The protocol is `propose -> classify -> vote -> execute -> verify`.

- Advisory authority records a council-approved result, with no external action.
- Desktop file authority permits only full-text replacements of explicitly
  selected, existing UTF-8 files inside the current workspace. At most 12 files,
  each up to 60 KB. The entire selected context must fit the protocol's 200k
  character envelope, so choosing 12 large files can exceed that envelope.
- Secret-like content, sensitive paths, policy/build configuration, symlinks,
  hardlinks, outside-workspace paths, deletions and file creation are refused.
- No shell, MCP calls, browser actions, purchases, publication, or permission
  changes can be requested through the council protocol. Existing ordinary
  harness controls are not relaxed and ordinary Room seats remain read-only.
- The mandatory model safety classifier may allow, block or escalate. Missing,
  malformed, or uncertain decisions fail closed. Any reviewer rejection stops the
  cycle; abstentions do not count toward the quorum. Voting cannot widen scope.
- SHA-256 binds each approval to the operating agreement, full selected-file
  snapshot and normalized proposal. Files, authority and roster/model pins are
  checked again before execution. Changed evidence invalidates the vote.
- The host persists intent and the recovery snapshot before writing. The file
  executor checks inode identity, avoids following final-component symlinks,
  writes, syncs and reads back the result. This is not a hostile-process sandbox
  or an atomic multi-file transaction. A partial write escalates with the saved
  snapshot; it is not blindly rolled back over another editor's work.
- The verifier gets a fresh context and no tools. It checks supplied evidence.
  Content read-back is deterministic; model verification remains fallible.
  Neither is a claim that a project's runtime tests were executed.

## Limits and persistence

A complete cycle's call allowance is checked before starting it. Calls are
reserved before each request. Limits are 1 to 10 steps, 5 to 100 logical model
requests, and 1 to 60 minutes. Each request also has a two-minute timeout.
A logical request can involve the gateway's normal authentication refresh.
These are not a hard dollar ceiling or guaranteed upstream token reservation.

Desktop persists council state in the Room's session record. The web keeps
Rooms in browser-local storage; mobile keeps them in the app's Preferences.
This implementation does not add cross-device synchronization. On reload,
active council states become paused and no in-flight action is replayed.

Browser and mobile support direct/group model messaging and advisory councils.
Only desktop supports scoped file execution. Browser/mobile routines require
an open, foreground-capable application; mobile OS suspension is not an
always-on scheduler. Remote machine pairing does not grant council file access.

## Architecture

- `rooms/council.js`: shared, dependency-injected protocol and grant validation.
- `rooms/council-host.js`: desktop IPC, pinned tool-free inference, room queue,
  current-authority checks, cancellation and persistence.
- `rooms/council-files.js`: deterministic scoped file classification/execution.
- `rooms/registry.js`: catalog models as first-class Room contacts.
- `renderer/rooms-local.js`: mobile Rooms adapter and shared advisory council host.
- `renderer/council-ui.js`, `renderer/council.css`: operating agreement, workflow
  phases, ballots, before/after recovery views and durable receipts.
- `scripts/build-rooms-web.js`: generated browser copies, checked for drift.

The design retains Crowe's existing wordmark and Coalesce worker mark, paper/ink
palette, gold accent, Fraunces/Inter/JetBrains Mono typography. The mark moves
only during activity, phases have text as well as color, and motion is disabled
under `prefers-reduced-motion`. Forms use explicit labels and focus outlines;
phone-width fields use 16px text to avoid iOS zoom.

## Verification

`npm test` includes the existing suite and these new checks:

- `npm run test:council`: protocol and real scoped-filesystem checks, including
  vetoes, abstention, scope violations, revocation, expiry, stale evidence,
  duplicate engines, interrupted recovery and storage failure.
- `npm run test:council:live`: real Electron renderer -> preload -> IPC ->
  council -> file executor -> read-back, driven through the UI on an isolated
  profile. Model inference is stubbed; the file write and persistence are real.
- `npm run test:council:browser`: a loopback dev server serves this checkout's
  web and generated mobile UI in Chromium. Exercises group model messaging,
  advisory councils, voting receipts and reload persistence in both surfaces.

Screenshots and test artifacts stay under the ignored `.council-test/` directory.
No real provider credentials are required by the new tests. They do not establish
live model output quality, classifier calibration, production account access,
Windows filesystem behavior, native iOS/Android packaging or app-store readiness.

Before production release: exercise supported real providers against the JSON
contract, measure false approvals/refusals and correlated reviewer failures,
validate native builds, and review the security boundary independently.
