# Mycology release and App Store readiness

Checked 2026-09-23. This is a local readiness record, not a release receipt.

## Product identities

| Product | Bundle/application ID | Distribution configured here |
| --- | --- | --- |
| Crowe Logic | com.crowelogic.desktop | Developer ID macOS DMG/ZIP; Windows/Linux installers |
| Crowe Logic for Developers | com.crowelogic.desktop.developers | Separate desktop installer/channel |
| Crowe Logic Mycology | com.crowelogic.desktop.mycology | Separate desktop installer/channel, unpublished |
| Crowe Logic for iPhone | com.crowelogic.mobile | iOS App Store Connect export |

The Mycology Electron config is not a Mac App Store target. Notarization does not constitute App Review approval. The existing iOS app must not be renamed, withdrawn, or repurposed implicitly while editing its submission.

## Desktop gates

- Farm/transfer baseline: recorded in `FARM-COMPLIANCE-VERIFICATION.md`; all 284 actual-app checks across ten isolated stages passed again after customer-roster, bootstrap and auth-isolation integration. Temporary fixture roots were canonicalized after macOS alias rejection; product path protections remain unchanged.
- Mycology icon: separate SVG/PNG/ICO/ICNS, selected by edition in packaging and runtime. Generic Desktop, Developers and mobile art is unchanged. Generator freshness and 30 container/geometry/runtime-selection checks pass locally. Desktop and Mycology isolated navigation launch checks pass after icon wiring. This is not packaged installer proof.
- Vision: dedicated review-only host, sandboxed decoder and notebook-save UI implemented. Independent source review and an offline reproduction verified fixes for uncertain-save duplication and pending-controller cleanup; no remaining verified defect was reported within that scope. Production deliberately returns UNAVAILABLE before picking or sending a photo because no verified gateway adapter is configured. The final 63-check offline suite passed, as did mobile/web bridge parity, deployment assets, security, panel 111 and Farm UI 23 checks. Do not advertise live desktop inspection until actual metered routing, response limits, recipients and engine provenance are verified. Offline injected responses cannot establish service availability or image interpretation quality.
- CI now includes Vision unit/actual-app fixture commands and separate Developers/Mycology navigation launches. CI itself has not run in this session.
- Packaging tests regenerate ignored `mobile/www` (44 files). This is a local generated web bundle, not an iOS binary, archive, upload or store edit.
- Auth isolation: implemented in profile-local storage and main OAuth/refresh wiring; 29 synthetic checks passed in both implementation and independent review. Mycology/Developers do not consult global legacy credentials; explicit Desktop profiles do not import global credentials. Default Desktop compatibility reads without deleting the CLI file. Logout/new sign-in invalidate stale refresh/exchange commits. Real safeStorage, token rotation, callback-port contention and signed installed editions remain unverified. The genuine `aws-secrets-manager` skill and wrapper from official AWS commit `af9a95cce54248a338f9be95f8ebd41ceafa3b73` were hash-verified, installed after explicit user approval and the skill loaded. No settings/hooks were changed. `crowe-admin` authenticated to account 310297108447; a names-only Secrets Manager list in us-east-1 failed with `SubscriptionRequiredException`. No secret value was fetched and no wrapper resolution has run. Backend availability remains blocked; do not bypass runtime references with local credential-file reads.
- Bootstrap now selects canonical edition userData/sessionData before app-service imports and acquires a same-profile native singleton lock. A losing process exits before writers. Independent review found an early-activation first-frame race; it is fixed with per-window readiness gates. 24 unit groups and 20 native-process checks pass locally. Native tests use synthetic windows and packaged-policy facades; actual signed installed default-profile isolation remains unverified.
- Build environment: shared `node_modules` symlink is for local tests, not production packaging. About 11 GiB disk free at the latest inspection. Use isolated lockfile-resolved dependencies and sufficient space; never delete unrelated files for a build.
- Release numbering: the public Desktop macOS feed was read as 0.24.16 (release date 2026-09-21T02:10:32.696Z), listing arm64/x64 DMG and ZIP. This is the existing feed, not this worktree's publication. Ownership of 0.24.17 remains unresolved. The contacted release-reconciliation peer works on Cortex 0.17.1 and does not reserve desktop 0.24.x; this does not prove the version is available. Previously held binaries must not be distributed. Reconcile current source/version and remote artifacts before choosing a number.
- Customer roster: separately authored customer-only source now drives runtime/browser/mobile; private original is unchanged and excluded. Validation rejects schema/authority/compatibility drift and known private references. 21 isolated roster checks and 16 synthetic ASAR/web audit checks pass, including rejection of a package missing the profile-auth runtime. Generated mobile payload passes the scoped audit (44 files). No customer desktop package has been inspected. Audit includes physically unpacked orphan files, declared-unpacked existence/size checks and fresh source-derived bundle comparison, but is not a complete secret audit or installer/signature acceptance. Packaged JavaScript is inspectable.
- Signatures, notarization, stapling, updater feed promotion and advertised-platform installation: not done.
- Local regression rerun: edition policy 22, activation 5 groups, release-channel 44, release-worker 56, notebook transfer 19, transfer host 16 groups, FarmStore 20, service 14, Farm host 10, retry 2, Farm packaging 6 and Electron security 145 checks passed. This run used host Node 26.5.0, not CI Node 22.

### Vision verification scope

- Final offline actual-app fixture: 25 checks passed. Real main, preload, renderer and sandboxed Chromium decoder; picker and gateway are synthetic. Light/dark and 900px-wide screenshots were inspected. The dialog scrolls vertically at the minimum supported window width.
- Latest 25-check rerun evidence: `/private/var/folders/k4/yvk3yv8n7j7fbf9t0xltlq140000gn/T/crowe-vision-fixture-Qc3Mzu`. The latest light and 900px dark preview screenshots were opened and visually inspected. Synthetic image/route labels remain explicit; these are not live inference evidence.
- Analysis alone creates no notebook entry. Explicit save retains separate model findings/reviewer notes and no image bytes. Ordinary edits/deletes cannot replace generated provenance. Farm snapshot/audit remained unchanged in the fixture.
- Uncertain-save replacement is blocked; reconciliation returns the original saved row and retires transient review state. New full-process coverage passed 21 + 19 checks: committed reply lost, Chromium storage flushed, orderly exit, separate Electron process reconciles via actual UI/preload with production Vision unavailable. Original row ID, notebook hashes and Farm snapshot/audit stay unchanged; no new picker/model/save. Evidence: `/private/var/folders/k4/yvk3yv8n7j7fbf9t0xltlq140000gn/T/crowe-vision-recovery-DsaZxd`. This is not crash, physical-power-loss or installed-package proof.
- Decoder has source/pixel/output bounds, Chromium sandbox isolation and a timeout. This is not an OS-enforced RSS ceiling.
- Remaining live gate: verified recipient/alias/engine/provider/revision, bounded transport read, enforced no-tools/no-fallback, existing authenticated metering and explicit plan/quota/timeout handling without uncertain-call retry. No live Vision request was made.

### Final-artifact acceptance still required

- Neither `release/` nor `release-mycology/` existed at the release-gate inspection. Source allowlists and staged-worker checks do not prove a customer installer.
- Use `dist:mycology:mac` for the macOS release path. The generic `dist:mycology` command does not run the final DMG stapler. Verify tickets and the refreshed feed hashes after stapling.
- Strict preflight/verification now require an explicit platform/architecture/artifact matrix, including macOS DMG and updater ZIP per advertised architecture. Use `npm run preflight:mycology -- --matrix '<accepted inventory>'` and `npm run verify:release:mycology -- --matrix '<accepted inventory>'`. Strict verification requires full artifact hashing, SHA256SUMS and valid blockmaps. Independent review found missing blockmap file-name validation; fixed against actual builder/updater output. Latest targeted results: 39 matrix, 45 preflight, 45 verifier checks on host Node 26.5.0. These are synthetic/localhost checks, not signed-installer acceptance.
- Existing nonstrict commands remain for diagnostic compatibility. Both R2/rclone publisher paths now require an explicit matrix, run strict local preflight before uploader execution, preserve edition/config/matrix into full remote verification, and support credential-free dry runs. 51 synthetic publisher and 56 worker checks pass. Publication still writes artifacts then feeds before remote verification, not an atomic promotion. Immutable-version protection and concurrent-file mutation exclusion remain acceptance gaps. No publisher was run against production. Signature, notarization, fuses and advertised-platform startup checks remain separate requirements.
- The locked updater dependency closure is covered by the source allowlist, including nested updater semver. Actual packaged updater initialization remains unverified.
- `farm/fixtures.js` is explicitly excluded; source packaging tests now check that exclusion. Inspect the actual ASAR and unpacked files for broader private instructions, fixtures and accidental data before publication.
- New manual `mycology-candidate.yml` requires a private repository snapshot, builds Linux x64 with `--publish never`, audits the actual ASAR, and strictly preflights AppImage/deb before staging two hash-rechecked installers for a three-day private artifact. Eight offline workflow contract groups pass; the workflow was not dispatched. Visibility checks and known-marker scanning are not complete privacy or installer acceptance.
- `publish-feed.yml` now takes explicit edition/matrix/tag, uses protected default-dispatch gate code separately from candidate metadata, rejects version mismatch, and fails unconditionally until approved runtime-secret-reference access is wired. Its 29 offline checks pass. It no longer executes older tagged publisher code or retains the previous secret-environment upload path. This deliberately prevents publication, not a claim the release path is operational. No release-worker deployment or feed mutation was performed.

## Existing iOS submission

### Connected iPhone check (2026-09-23)

The user requested an update with the iPhone unlocked. `devicectl` reports a paired iPhone 16 Pro Max, with `com.crowelogic.mobile` 0.26.0/build 2600 and a distinct `com.crowelogic.ai` Mycology 1.2.0/build 10. A bounded search found no newer qualified device-installable artifact. The 2509 archive is a downgrade despite carrying the later privacy-consent fix; the 2600 archive is the same installed version and lacks those consent assets. No app was installed, removed or launched. A new forward-versioned build must combine the correct iOS lineage with privacy fixes, and pass signing/device acceptance before installation. These device facts do not establish App Store review state.

### Installed forward update (2026-09-23)

The user explicitly approved local Xcode signing for this installation, without reading or exporting private keys. Xcode signed App and CroweShare 0.26.1/2601 using the existing development identity. Deep/strict signature verification passed; both provisioning profiles include the connected device, the expected team and App Group, and expire in September 2027. Signed web resources match the verified source. `devicectl` installed the app in place and read back `com.crowelogic.mobile` 0.26.1/2601. No uninstall or data-clearing operation ran. All 193 inventoried app-container files remain present; one has changed size or modification time, so this metadata check is not a byte-for-byte data-integrity claim. The separate `com.crowelogic.ai` installation metadata is unchanged at 1.2.0/10. The first launch was refused because the phone was locked. After the user requested another attempt, `devicectl` successfully launched `com.crowelogic.mobile` at 19:39:53 local time; receipt `launch-retry-receipt.json`. Full native interactive feature acceptance was not performed. Receipts: `/private/tmp/crowe-ios-2601-unsigned.uaih87/{install-receipt,device-after,mycology-after,container-before,container-after,launch-receipt}.json`. Despite the historical directory name, this candidate is now signed and installed. This is a development installation, not an App Store release. Earlier blocked/unsigned observations below are historical.

### Selective forward integration

Consent and complete multi-round camera behavior were selectively ported into current source, preserving native share/vault and reply-voice work. Independent review found six defects: legacy vault grants could return after withdrawal, stale dictation callbacks could resume, photo replacement could retain an old finding, incomplete runs could offer a log action, failed withdrawal disabled retry, and shared-image import used the wrong argument signature. All six are fixed and the independent reviewer reran their original reproductions successfully. The parent reran the full mobile bridge, ten synthetic privacy groups, isolated Electron real-DOM workflow and generated customer-payload audit; the combined command exited 0. Notice and failed-withdraw retry screenshots were inspected. Latest parent UI evidence: `/var/folders/k4/yvk3yv8n7j7fbf9t0xltlq140000gn/T/crowe-mobile-privacy-evidence-vIFwqz`. Root test commands and CI include these suites. The guarded generator produced 45 mobile files; the scoped customer-payload audit passed with no findings. No native version, Xcode project or privacy manifest was changed. Usage strings no longer promise unsupported photo/audio non-retention.

The public gateway catalog was read without authentication on 2026-09-23. It advertises CroweLM/Zenith as OpenAI on Azure, Flash as Z.ai on Cloudflare, and Vision/Grower/Kernel as Anthropic on Azure. This contradicts the September 19 public privacy page and the former notice. Local base routing declarations agree with the new catalog, but effective deployed overrides, actual request routing and retention remain unverified. The notice now labels the observed mappings as advertised metadata, removes retired Mycelium, and explains local camera-thumbnail persistence and model-bound tool results. Its main consent version is now 3; the eleven-group regression suite verifies that prior version-2 allowances do not silently cover the changed disclosure. Feature notices remain version 2 and the independent consent storage key is unchanged. No public policy or Apple manifest was edited.

The initial native prerequisite inspection found missing dependencies and generated iOS resources. Subsequently `npm ci --prefix mobile --ignore-scripts --no-audit --no-fund` succeeded, and Capacitor sync generated the native web/config resources and registered all eight plugins. App and CroweShare Debug/Release versions are now 0.26.1/2601; version parity passes. Bundle IDs, team, App Group, Keychain service and native entitlements are unchanged. The unsigned iPhone-target Debug build succeeded with Xcode 26.2, two jobs and signing disabled in `/private/tmp/crowe-ios-2601-unsigned.uaih87`. Inspection of the actual App.app and embedded CroweShare.appex confirms arm64, iOS 15 minimum, correct bundle IDs and 0.26.1/2601 for both. All 47 synchronized native web files match their compiled-bundle copies byte-for-byte; consent/camera/dictation/share fixes are present. Native web payload audit and all eleven privacy regression groups pass. `codesign -dv` confirms the app is not signed, and no provisioning profile is embedded: it is not device-installable. Signing remains blocked under the required runtime-secret workflow by the previously observed AWS `SubscriptionRequiredException`; no alternate credential access was attempted. Approximately 4.5 GiB remained free after compilation. Consent UI and source declarations do not establish production privacy acceptance. The installed app remains unchanged.

### Verified locally

- This checkout is now mobile 0.26.1 / build 2601, `com.crowelogic.mobile`; CroweShare carries the same version/build. This is not an installed-version claim.
- `mobile/ios/ExportOptions.plist` exports for App Store Connect. It does not submit a build or change review state.
- The current mobile bridge does not expose the new desktop farm ledger or record-transfer workflow.
- No current App Store Connect app-record ID, selected-build receipt, editable-version snapshot or review-state evidence is present in this worktree.

### Baseline warning, not a claim about the selected store build

A historical record points to a later privacy-corrected build 2509. Its prior review status is not current evidence. Do not upload this older 2507 tree over that lineage.

Before selective integration, the local photo usage string promised photos were not stored, although explicit mobile camera-check logging retains a thumbnail. That string is now corrected in source, not in the installed or selected store binary. The local privacy manifest still contains an unresolved collected-data declaration. Verify the selected build's actual behavior before preparing a replacement binary. Preserve later consent, account-deletion, purchase-policy and recipient-disclosure fixes.

### Authorized edit procedure, currently blocked on safe access

1. Load the required secret-safety skill and use its approved runtime resolution method. No credential values in logs, files, screenshots, prompts or reports.
2. Read live app ID/bundle ID/platform, selected build, version and review state, localizations, screenshots, privacy URL and review details. Save a redacted before snapshot.
3. Verify the selected build's source and actual capabilities. Draft a field-level patch against the current remote values, not assumed marketing copy.
4. Only edit fields allowed in that live state, and only with supported statements. Recheck remote values immediately before each write to detect another session's edits.
5. Read back every edited field and record timestamp, app/version/build IDs, changed field names and redacted before/after values. Do not include reviewer login credentials in the receipt.
6. Stop if the operation would require review withdrawal, a new app identity, pricing changes, binary replacement or public release. Those are not harmless metadata edits.

Apple explains that removing a submission changes its app version to Developer Rejected, removes all submitted items from the queue and restarts the review process when resubmitted. Some metadata remains editable without removing the submission.

Source: [Apple: Remove a submission from review](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/remove-a-submission-from-review/).

## Wording restrictions for the eventual metadata patch

- Do not claim that desktop Farm & Compliance or independent record transfer exists in the iOS binary.
- Do not claim automated food-safety approval, certification, contamination clearance or edibility assessment.
- Do not claim local-only photo processing when a photo is sent to a remote engine.
- Do not promise no photo retention if a user-selected logging action retains thumbnails.
- Do not invent provider, engine, retention, pricing or approval facts.
- Use screenshots from the selected platform/build, not desktop mockups.

No exact remote metadata patch can be truthfully finalized before the selected build and current field values are inspected. No store edit, upload, withdrawal, resubmission, approval or publication has been performed by this worktree's release work.
