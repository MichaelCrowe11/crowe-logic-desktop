# Farm & Compliance verification

Date: 2026-09-23
Branch: `feat/farm-compliance-workspace`
Base: `0198f15ce0b087a4c0694b4454e08f103593882a`

## Mycology edition verification in progress

The results below record the completed Farm baseline before the Mycology split. They are not blanket acceptance of the subsequent edition and transfer changes.

The current split has passed FarmStore (20), service (14), host (10), persistent retry (2), farm packaging (6), edition policy (22), notebook transfer (19), and transfer host (16) scoped groups/checks. The updated renderer fixture reports 23 checks; the panel/bridge suite reports 111. Security (145), harness (105), release channel (36), packaging (11), offline web deployment (7), and preview freshness passed locally.

Edition navigation passed eight isolated actual-main launches: all three edition defaults, narrowed Desktop, poisoned Developers preferences, and empty/chat-only/mixed Mycology preferences. The explicit user-data-dir runtime probe passed 3 checks, and the source-extracted profile matrix passed 12 cases. These are development/fixture tests, not packaged side-by-side installation verification.

Actual isolated app suites passed sequentially:

- Mycology owner workflows: create (67), reopen (9), restore (17), 93 total.
- Desktop explicit legacy lost-response recovery: 71 checks across two processes.
- Separate-profile notebook/ledger transfer: 120 checks across five processes, including both import orders and restarts. Source notebook and ledger file hashes remained unchanged across every destination stage.

Independent read-only notebook review found no confirmed defect within the cooperating-writer model. It does not establish packaged-platform or physical power-loss safety. Edition host review identified and fixed shared-plugin and council-activation regressions: shared Crowe Skills remains available, while grower-only plugins and council seats require Mycology. Five synthetic activation regression groups passed, including rechecks before inference and execution. Historical council state and stop access remain available.

Rerun after icon and Vision wiring: all 284 Farm/legacy-recovery/transfer checks passed again across ten stages. The first rerun failed at legacy-source lookup with `GROW_UNSAFE_PATH` because the fixture root used macOS's `/var` alias. The fixtures now canonicalize their own temporary roots with `realpathSync`; the product's symlink rejection was not changed. An explicit synthetic error assertion makes future lookup failures visible.

Latest parent rerun after customer-roster, bootstrap and auth-isolation integration: all 284 checks passed again (93 owner/reopen/restore, 71 lost-response/replay, 120 independent transfer). The same command also passed 40 separate-process Vision recovery checks. Injected lost-reply errors are intentional; the complete command exited 0.

Latest temporary evidence:

- `/private/var/folders/k4/yvk3yv8n7j7fbf9t0xltlq140000gn/T/crowe-farm-live-74oHyw`
- `/private/var/folders/k4/yvk3yv8n7j7fbf9t0xltlq140000gn/T/crowe-farm-recovery-Aoiqsl`
- `/private/var/folders/k4/yvk3yv8n7j7fbf9t0xltlq140000gn/T/crowe-mycology-live-xu13vl`
- `/private/var/folders/k4/yvk3yv8n7j7fbf9t0xltlq140000gn/T/crowe-vision-recovery-DsaZxd`

The latest source-packaging suite has 12 checks, including Vision dependency inputs and explicit exclusion of `farm/fixtures.js`. It regenerates ignored `mobile/www`; that is not an iOS build or customer installer.

The actual-app fixtures stub unrelated PTY/git and companion-status calls while retaining subprocess/network guards. Companion discovery in real Settings can still invoke Tailscale; these tests do not claim all Settings is subprocess-free. No farm, transfer, recovery, or authoritative storage handler is replaced by those stubs.

Publication remains held. The official secret-safety skill/runtime is now installed with explicit approval, but Secrets Manager access returns `SubscriptionRequiredException`. Mycology's home-global legacy-auth isolation is implemented with 29 synthetic checks and an independent review; native OAuth, safeStorage and signed-install acceptance remain open. No real-profile launch or migration is authorized by fixture test success. Packaged side-by-side profile behavior, signing, updater resolution, and customer archive inspection remain release gates. See `MYCOLOGY-TRANSFER.md` for the transfer contract.

## Historical Farm baseline status

The desktop-local implementation passes the scoped automated acceptance workflow through the actual application, including restart, backup restore and lost-shipment-response recovery. It has not been released. No commit, push, installed-app replacement, live migration, or publication was performed.

The cultivation notebook is unchanged. Selected harvests are explicitly reviewed and copied into a separate SQLite compliance ledger. Browser, preview, and mobile report UNAVAILABLE instead of creating disconnected records.

## Automated acceptance

Run from this worktree with its existing dependencies:

```sh
npm run test:farm
node scripts/test-farm-ui.js
npm run test:farm:live
```

If the invoking shell sets `ELECTRON_RUN_AS_NODE`, unset it for Electron tests. The live command creates fixture-only temporary profiles and launches five separate actual-app stages; it does not operate the installed app or any real farm database.

| Evidence | Result |
| --- | --- |
| FarmStore integrity | 20 groups passed |
| Worker lifecycle/service | 14 groups passed |
| Trusted host/preload/IPC | 10 groups passed |
| Real-store pending retry/reopen | 2 groups passed |
| Farm packaging/platform boundaries | 5 checks passed |
| Isolated Chromium renderer | 19 groups passed |
| Actual app create/owner workflows | 66 checks passed |
| Actual app reopen | 8 checks passed |
| Actual app empty-profile restore | 16 checks passed |
| Actual app committed-but-lost shipment reply | 27 checks passed |
| Actual app restart and unchanged retry | 30 checks passed |
| Electron security regression | 142 checks passed |

`npm run test:farm` covers 51 groups/checks. `npm run test:farm:live` covers 147 checks across five app stages. These counts describe different levels of evidence, not 198 distinct user scenarios.

FarmStore and trusted host tests also passed under both host Node 26.5.0 / SQLite 3.53.4 and Electron 43.4.0's bundled Node 24.18.1 / SQLite 3.53.1. Node 22 is configured for CI but has not been executed locally. No remote CI run is claimed.

General packaging, generated-preview freshness, and `git diff --check` passed. The staged package starts the actual SQLite worker. Earlier integration checks also passed panels (109), full/narrowed install spaces, mobile/web bridges, mobile generation and offline web deployment tests (6). The entire repository-wide `npm test` was not run.

## Final local evidence

- Actual owner workflow, reopen and restore: `/var/folders/k4/yvk3yv8n7j7fbf9t0xltlq140000gn/T/crowe-farm-live-BPSfnM`.
- Actual lost-response and new-process retry: `/var/folders/k4/yvk3yv8n7j7fbf9t0xltlq140000gn/T/crowe-farm-recovery-tgXrmW`.
- Renderer fixtures: `/var/folders/k4/yvk3yv8n7j7fbf9t0xltlq140000gn/T/crowe-farm-ui-C8Mkj3`.
- Final combined live, panel (109/109) and install-space run exited 0. The restored-dashboard screenshot was inspected after the startup-veil wait and shows the restored records unobscured.

These are temporary local evidence paths, not published artifacts or durable off-device backups.

## Five required integrity gates

1. Re-adopting the same source harvest is rejected, including competing transactional adoption tests.
2. Adoption preserves exact source ID, full bounded raw snapshot, reviewer, approval time and source hash. Nested extension fields, whitespace and nulls survive restart and restore.
3. Subsequent notebook edits do not mutate the adopted lot or immutable shipment-time facts.
4. Corrections preserve the original receipt and source evidence, with before/after facts, actor, time and reason. Quantity cannot drop below shipped inventory.
5. Recall links the shipped lot to its preserved source harvest and recorded shipment recipients, with exact shipped and remaining quantities.

The actual owner workflow uses the real forms and controls for facility, lots, reviewed adoption, customer, multi-lot shipment, correction, deviation resolution, document draft/review/attestation/approval/supersession, Blob backup download and local File-input restore. Direct IPC calls supplement these interactions with adversarial rejection and record-integrity assertions.

## Review findings addressed

### Complete source evidence

The initial store rejected additional raw legacy fields accepted by the host. Adoption now preserves bounded plain JSON source evidence without stripping or normalization. Source identity must match exactly. Renderer-supplied provenance remains rejected. Tests cover unsafe and oversized source JSON.

### Pending shipment recovery

Before dispatch, the renderer saves and reads back the exact immutable payload/request ID in versioned operator-scoped localStorage. Corrupt/unwritable/changed pending storage and operator mismatches fail closed. Uncertain writes freeze the form, block restore and offer only unchanged retry until the outcome is resolved.

The real-process test wraps the actual main IPC handler and discards one response only after the worker transaction commits. The real preload reports WRITE_OUTCOME_UNKNOWN. A new Electron process reopens the same isolated profile and recovers byte-identical intent. Owner retry returns the original shipment with one 7.125 lb allocation, 12.875 lb remaining and unchanged complete audit/tables. The logged TEST_ONLY_LOST_SHIPMENT_REPLY_AFTER_COMMIT exception is intentional fault injection.

This test uses an orderly owned-process exit and explicitly flushes Chromium storage. It does not establish durability against sudden power loss, an unflushed abrupt process kill, profile deletion or disk failure.

### Backup capacity

Mutations validate the complete export representation, including their audit event, before commit. BACKUP_CAPACITY rolls back a capacity-crossing change. Restore checks again after its receipt and leaves the target empty if capacity would be exceeded. Historical replay skips repeated capacity scans; final target checking is mandatory.

This is a bounded pilot ledger with a 10 MiB JSON recovery limit. Full audit copies consume capacity. No pruning/archive/compression feature is provided; a higher-capacity design is needed before long-term production retention.

### Visual verification

The original narrow-window test checked only horizontal overflow and missed a sidebar that squeezed the workspace. Farm now temporarily collapses navigation below 760px without changing the saved sidebar preference; the toolbar can reopen it. Live assertions check usable width and accessible navigation. The refresh button no longer shrinks into a narrow text column.

Screenshots are inspected separately from integrity assertions. Light/dark overview, narrow layout, owner attestation, approved successor and recall provenance have been inspected in the real app. Screenshot capture scrolls to its named subject. Live tests wait for the startup veil to naturally disappear before owner interactions; DOM readiness alone is insufficient visual evidence.

Earlier fixture screenshots mislabeled a light Overview frame as dark Recall. Frame/theme/pane checks corrected that fixture harness; old images are not used as evidence.

## Isolation and earlier failed attempts

The initial macOS sandbox-exec attempt failed before opening the application because Chromium could not initialize its nested sandbox. It established no live acceptance result. The user then approved the alternative test isolation on 2026-09-23.

The approved runs retain Chromium's renderer sandbox, context isolation, temporary home/profile/workspace paths, disabled credential access, disabled native child processes, blocked Node transports and a dead Chromium proxy configured before main startup. Unrelated PTY/Git startup handlers are stubbed, not permitted to spawn. Farm stages make no engine requests and import no real account. These guards prevent accidental interaction, not deliberate bypass; they are not OS-level containment.

The first alternative run correctly failed when unrelated Git startup attempted a blocked subprocess. Stubbing that fixture-only probe fixed it without weakening process guards. A later narrow-width assertion initially compared clientWidth with viewport width without allowing scrollbar width; the corrected geometric assertion passed with the sidebar visibly collapsed.

## Evidence limits and release boundary

- Local owner attribution is not verified identity, an externally trusted signature or regulatory approval.
- Recall covers only records in this local ledger; no recipient notifications are sent.
- Backup checksums detect corruption, not malicious replacement by a device administrator.
- Backup recovery is into an empty store, not a merge or live-data migration.
- No PDF/ZIP exports, automated plans, multi-farm permissions, sensors or accounting were added.
- No release binaries were built or installed, and no live records were migrated.
