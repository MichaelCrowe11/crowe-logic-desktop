# Phone launch candidate, 0.26.16

Prepared October 6, 2026. This branch is a development candidate. An installed
development build and passing local checks do not authorize a store submission.

## Multiple terminals

Open **Terminal**, then **New terminal**. Inside a shell, **+ New** opens another;
the title is a native picker for switching between phone, desktop and engine
sessions. Each shell keeps running on the computer while another is selected.
Output, control leases and unsaved drafts belong to their respective session.
**Close** closes only the selected phone shell; the back chevron returns to the
session list. The host retains its existing limit of 24 concurrent sessions.

The updated companion assigns distinct names and deduplicates repeated open
requests. Revoking terminal access, unpairing the phone or stopping the companion
while an open is pending prevents that shell from retaining control. Install the
matching desktop build before claiming these companion changes are active on the
operator's computer. An older companion can serve the new phone picker, but it
does not gain the new backend protections from a phone-only installation.

## SDK decisions

| Component | Candidate | Decision |
| --- | --- | --- |
| Capacitor core, CLI, iOS and Android | 8.5.2 | Current npm stable versions verified during this work. |
| Electron | 44.6.0 | Updated in the previous commit; applies when the desktop is rebuilt. |
| iOS app lifecycle | UIScene | Added SceneDelegate and URL/universal-link forwarding through SceneDelegateProxy; retained CroweBridgeViewController and its native plugins. |
| Local Apple toolchain | Xcode 26.2, iOS SDK 26.2 | Meets Apple's current Xcode 26/iOS 26 submission minimum. Xcode 27 is newer and needs a newer macOS installation. |
| Android target | API 36, minimum 24 | Matches Capacitor 8's documented baseline. |
| Android Gradle plugin | 8.13.2 | Latest patch of the compatible 8.13 line. |
| Gradle | 8.14.3 | Retained Capacitor's baseline; binary download now has a pinned SHA-256. |
| Google services plugin | 4.5.0 | Current stable version from Google's Maven metadata. |

AGP 9.4.1 and Android API 37 are newer. That migration needs Gradle 9.6 and
compatibility testing of Capacitor's Gradle scripts. It is deliberately not mixed
into an untested Android release: this Mac has neither a JDK nor an Android SDK.
The Android workflow must run on this exact commit before Android is ready.

Primary references, checked October 6, 2026:

- https://capacitorjs.com/docs/updating/8-5
- https://capacitorjs.com/docs/updating/8-0
- https://developer.apple.com/news/upcoming-requirements/
- https://developer.android.com/build/releases/agp-8-13-0-release-notes
- https://developer.android.com/build/releases/agp-9-4-0-release-notes
- https://dl.google.com/dl/android/maven2/com/google/gms/google-services/maven-metadata.xml

## Repeatable checks

```sh
npm run test:phone-mirror
npm run test:draft-editor
node --test scripts/test-session-editor-runtime.js
node --test scripts/test-mobile-release.js
python3 scripts/test-ios-bundle.py
node scripts/test-gates-client.js
node scripts/test-companion.js
node scripts/test-mobile-bridge.js
node mobile/scripts/sync-version.js --check
node scripts/test-version-parity.js
node scripts/test-packaging.js
node scripts/test-electron-security.js
node scripts/test-brand-copy.js
node scripts/check-contrast.js
node_modules/.bin/electron scripts/test-phone-mirror-ui.js
node_modules/.bin/electron scripts/test-mobile-shell.js
node_modules/.bin/electron scripts/test-mobile-product.js
node_modules/.bin/electron scripts/test-panels.js
```

Use the repository's Electron executable and isolated profiles. Keep the
operator's installed desktop and preview sessions open.

Before installation, run `python3 mobile/scripts/verify-ios-bundle.py /path/to/App.app`.
It verifies identity, app and share-extension versions, SDK minimum, scene
configuration, signatures, privacy-manifest presence and seven source-asset hashes.
After distribution export, repeat it with `--distribution` to reject development,
ad-hoc or enterprise provisioning. This check does not validate privacy claims.

Android CI now checks APK and AAB identity and versions, bundle integrity and signatures. Its
bundle metadata reader is bundletool 1.18.3, verified against the release SHA-256.
For local Android artifact verification, set `BUNDLETOOL_JAR` to that verified jar.
Unsigned
artifacts are explicitly labelled packaging-only. Partial signing credentials
fail the build; `CROWE_REQUIRE_ANDROID_SIGNING=1` also rejects absent signing.

## Verified candidate

Source commit `fb2455d` produced iPhone build **0.26.16 (2616)**. After the phone
was unlocked on October 6, 2026, a cold launch completed WebView navigation and
received native App, StatusBar and custom CroweChrome bridge calls. No WebView
failure, process termination or uncaught JavaScript error signal appeared during
the 35-second observation. A subsequent activation and process inventory confirmed
the app remained running. This verifies startup; physical phone interaction and
paired-host checks below remain outstanding.

The signed Debug app, Release archive and locally exported distribution IPA passed
the iOS bundle verifier. The matching desktop diagnostic package passed isolated
startup, runtime fuse, utility-process handshake and shutdown checks. It was not
installed over an operator session. No store upload or public release occurred.

Local results for this source: terminal/backend **34/34**, panels **100/100**,
mobile shell **43/43**, draft editor **5/5**, and gate-client fixtures **24/24**.
Phone UI integration passed with isolated real PTYs, independent shells and draft
switching. Release, packaging, security, version, brand and contrast checks passed.
Those results describe the installed October 6 candidate. Later validation is
recorded separately below.

## PR review follow-up, October 7

The follow-up fixes interrupted speech requests, Unicode paste byte limits,
Settings plan navigation, late terminal-start cleanup, large desktop terminal
dimensions and web look-layer delivery. Session audit records retain control
changes without a record for every keystroke, renewal or resize. The shared draft
editor now uses the application's bundled runtime and preserves file concurrency
checks and line endings, without requiring system Python.

The full `npm test` suite passed locally. Focused checks passed for panels
**103/103**, mobile shell **43/43**, draft editor **10/10**, the real editor entry
point **1/1**, and malformed iOS SDK metadata. The real-PTY phone fixture passed,
including a large Unicode paste with a retained control lease. The updated iOS
source compiled successfully with signing disabled; this is compile evidence,
not a newly installed or distribution-signed build.

The live relay E2E passed **8/8** with this branch's gate client and phone bridge
and the isolated CLI gate worktree. It verified phone approval, denial, the first
answer winning, edit evidence, cancellation, expiry and an unreachable relay.
The clients used isolated test state; these checks do not establish physical
phone pairing or device revocation. Driver receipts include source hashes.

The October 6 Android workflow passed for `4d8f76a`. The updated workflow also
verifies AAB metadata against the APK; check its result on the final PR commit.
The iPhone still carries the earlier `fb2455d` application sources. Rebuild and
install the reviewed sources before claiming these follow-up fixes on the phone.

Follow-up evidence is stored in `~/crowe-evidence/2026-10-07-pr134-followup/`.

## Remaining distribution gates

- Verify sign-in deep links on cold and warm launches, foreground/background
  recovery, native Settings sheets and terminal switching on the physical phone.
- Verify the matching desktop companion with the actually paired device,
  including terminal revocation. Do not replace a running operator session.
- Confirm gateway retention and reconcile the privacy manifest's currently empty
  collected-data declaration with App Store privacy answers. An empty declaration
  is not proof that no data is collected.
- Review store metadata and screenshots against the final product surfaces after
  the separate surface-removal branch is merged.
- Rebuild and verify distribution exports if the source changes after the tested
  candidate. No upload, release or store submission is part of this local task.
- Run Android CI and a real Android device pass. Local source checks cannot stand
  in for an Android build.
- Track the eight moderate development-only npm findings in electron-builder's
  sprintf-js dependency chain. The previous audit found no fixed upstream
  sprintf-js release; do not accept npm audit's unrelated builder downgrade.

Build receipts, test logs and rendered fixtures for this iteration are stored in
`~/crowe-evidence/2026-10-06-multi-terminal-launch/`. Fixture screenshots are layout
evidence, not physical iPhone screenshots.
