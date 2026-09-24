# Connected farm operations - local continuation evidence

Date: 2026-09-24. Implementation worktree: `feat/farm-compliance-workspace`.
This is a local verification record, not a release or production readiness receipt.

## Recovered scope

The approved connected-farm plan is in the local plan file `wise-foraging-starlight.md`. Existing standalone records remain authoritative locally until explicit enrollment; the new shared farm service is separate. No production migration, publication, installed-app replacement, customer notification, private-document inference or payroll submission was performed.

## Baseline rerun

All results below were obtained with existing dependencies. Test data, identities and transport fixtures are synthetic unless stated otherwise. Existing personal profiles were not used.

- FarmStore: 20 groups; Farm service: 14; Farm host: 10; retry: 2.
- Farm packaging: five safe cases passed. The case invoking `mobile/scripts/build-www.js` was intentionally excluded; the aggregate `npm run test:farm` was not run because it regenerates `mobile/www`.
- Import parsers: 21 tests; local import archive/host: 11; isolated DOM choose/preview/revise/review flow passed.
- Team transport: 28; Sense: 35.
- Messenger fixture: 15 reported checks, including responsive layouts; workforce UI: 6; awareness UI: 9. These use mocked bridges, not deployed shared delivery.
- Edition policy: 23 checks; bootstrap: 25 synthetic groups; activation: 5 groups.
- Actual main/preload/renderer Messenger: original 33 checks passed; expanded team-tab boundary run passed 38. No inference, network, utility process, PTY or workbench activation occurred. The screenshot from the original run was opened and inspected.
- Actual app notebook/farm transfer: five separate processes passed (15 + 29 + 24 + 27 + 25 checks). Source record hashes remained unchanged.
- Farm live: create 67, reopen 9, restore 17. Farm lost-response recovery: 35 + 36. Injected lost replies were expected fixtures, not failed assertions.
- Vision: 63 offline checks; actual decoder/UI fixture: 25; lost-response/reconciliation: 21 + 19. Picker and gateway were synthetic; this does not qualify a live OCR route.
- Notebook transfer: 19; transfer host: 16 groups.
- Backend: 67 passed, no failures/skips (team 19, workforce 15, awareness 18, monitor 8, import promotion 7). Tests used disposable PostgreSQL 16.14 Unix-only clusters and a process-wide network/secret-access guard. Initial runs had 45 setup errors due to macOS PostgreSQL locale initialization; `LC_ALL=C LANG=C` resolved them without source edits. No operational migration or real database was touched.

## Continuation changes verified so far

- Farm selection changes destroy the document-intake child and invalidate its destination-bound UI state, while retaining the device-local archive. Returning to a prior farm requires explicit archive entry again.
- Synthetic `scripts/test-farm-team-ui.js` covers equal selection, changed farm, changed-back farm, lost membership, inactive container and teardown callbacks.
- The actual-app smoke now checks that Hours and Knowledge require a selected shared farm, local archive privacy is disclosed, and clicking Document intake alone does not access originals.
- Named commands `test:farm:team` and `test:mycology:messenger` expose the previously ungrouped team regressions. The former includes GUI fixture launchers; do not treat it as a non-window test command.

## Bounded shared-source staging continuation

Implemented the explicit local-original to authenticated shared-staging handoff. `main.js` passes the trusted `teamHost.imports` adapter to the import host; the generic renderer team API still excludes `import.stage`, `import.revise` and `import.promote`.

- Preparation authenticates the selected farm using server-returned membership and displays the member, server, farm, filename, media type, size and SHA-256 before a separate upload confirmation.
- Consent is short-lived and tied to the source reference, destination and current session/document. Farm changes tear down the import child; cancellation/sign-out invalidate consent. Already-dispatched requests cannot be rolled back and retain their original destination.
- An immutable destination/account/server-scoped intent is durable before dispatch. Explicit retries after timeout or restart reuse the exact bytes and request ID; they do not create replacement commands. The intent is not a durable server-success receipt.
- Only original bytes are sent. Local selections, notes and self-attributed review receipts remain local and confer no server authority. No enrollment, accepted log, approved SOP or model call occurs.
- Shared staging permits 1 to 262144 bytes (256 KiB), versus the local 8 MiB intake limit. CSV/text/PDF/DOCX/XLSX originals are supported; images and oversized sources are rejected without conversion or truncation. The UI stages farm-wide (`departmentId: null`).
- Source metadata, names and errors are rendered as text. Archive integrity hashes do not protect against an adversarial local writer. Shared retention/deletion is not managed by this handoff.

Parent reran `npm run test:farm:imports`: 21 parser tests, 11 archive/host tests, 11 shared-handoff groups, four synthetic-DOM shared UI groups and the FarmTeam lifecycle test all passed. `node scripts/test-team-host.js` passed all 28 groups. These runs were Node-only with synthetic identities and injected transport, not real uploads. Syntax checks for main, preload, the persistent-preview script, shared UI and archive store passed; `git diff --check` passed for tracked changes.

Read-only backend contract verification found no receipt-field mismatch: `control_plane/farm/imports.py:173-197` returns the matching original metadata/hash/size/scope, revision 1, staged status, empty candidates and `ledgerWriteAuthorized: false`, with a canonical revision hash. No real backend transport was used for that check.

Independent Astra design review found no blocking boundary defect under the trusted-host/backend and nonadversarial-local-writer assumptions. This is not end-to-end verification. Actual shared-backend/UI consent, upload, timeout-after-commit and restart reconciliation remain acceptance gates; the new shared UI has not been visually inspected in a persistent app preview.

## Interactive preview rule

Michael requested that app windows not open and disappear rapidly and that they be able to inspect anything opened. No further GUI test launches after that instruction. Use non-window checks during implementation. Announce any subsequent preview, bring it forward, and leave it open for inspection rather than automatically closing it.

`npm run preview:mycology:offline` adds `--keep-open` to the isolated actual-app Messenger script. This retains its network/subprocess guards and temporary empty profile, then leaves the window visible until manually closed. It is not a real signed-in shared farm. The keep-open path has been syntax checked but not yet launched.

## Unfinished acceptance

- Bounded shared-source staging is implemented and locally tested as recorded above; actual shared-backend/UI end-to-end acceptance remains open.
- Enrollment, account-scoped encrypted offline cache/outbox and one-way authority cutover are not complete.
- Local candidate revisions and self-attributed receipts are not authenticated shared review authorization. Shared source staging is not record promotion.
- PDF/handwriting OCR and production Vision routing remain unqualified.
- Dedicated staff client, real two-client authenticated end-to-end delivery, closed-owner-desktop operation and background notifications remain unverified.
- Monitoring tick functions are not an installed scheduler; queued notices are not delivered notifications.
- Physical Sense commissioning and named payroll-provider sandbox acceptance remain separate gates.
- No new candidate installer was built. Existing Sep 23 candidate is not evidence of Sep 24 source behavior. Disk headroom was roughly 6 GiB; no dependency installation or release build was attempted.
