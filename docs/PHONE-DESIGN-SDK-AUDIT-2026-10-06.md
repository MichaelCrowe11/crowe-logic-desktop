# Phone design and SDK audit

Verified October 6, 2026 in `feat/phone-instrument-integration`. This audit covers the desktop harness and its Capacitor mobile shell.

## Dependency state

| Scope | Package | Before | Updated | Registry latest stable |
| --- | --- | --- | --- | --- |
| desktop | `@xterm/addon-fit` | 0.11.0 | 0.11.0 | 0.11.0 |
| desktop | `@xterm/addon-serialize` | 0.14.0 | 0.14.0 | 0.14.0 |
| desktop | `@xterm/headless` | 6.0.0 | 6.0.0 | 6.0.0 |
| desktop | `@xterm/xterm` | 6.0.0 | 6.0.0 | 6.0.0 |
| desktop | `electron-updater` | 6.8.9 | 6.8.9 | 6.8.9 |
| desktop | `node-pty` | 1.1.0 | 1.1.0 | 1.1.0 |
| desktop | `@electron/fuses` | 2.1.3 | 2.1.3 | 2.1.3 |
| desktop | `electron` | 43.4.0 | 44.6.0 | 44.6.0 |
| desktop | `electron-builder` | 26.15.3 | 26.15.3 | 26.15.3 |
| desktop | `js-yaml` | 4.3.2 | 5.4.3 | 5.4.3 |
| mobile | `@capacitor/android` | 8.4.2 | 8.5.2 | 8.5.2 |
| mobile | `@capacitor/app` | 8.1.1 | 8.1.2 | 8.1.2 |
| mobile | `@capacitor/browser` | 8.0.4 | 8.0.5 | 8.0.5 |
| mobile | `@capacitor/core` | 8.4.2 | 8.5.2 | 8.5.2 |
| mobile | `@capacitor/ios` | 8.4.2 | 8.5.2 | 8.5.2 |
| mobile | `@capacitor/keyboard` | 8.0.5 | 8.0.6 | 8.0.6 |
| mobile | `@capacitor/local-notifications` | 8.0.0 | 8.3.1 | 8.3.1 |
| mobile | `@capacitor/preferences` | 8.0.1 | 8.0.1 | 8.0.1 |
| mobile | `@capacitor/share` | 8.0.1 | 8.0.3 | 8.0.3 |
| mobile | `@capacitor/splash-screen` | 8.0.2 | 8.0.2 | 8.0.2 |
| mobile | `@capacitor/status-bar` | 8.0.3 | 8.0.4 | 8.0.4 |
| mobile | `@capacitor/cli` | 8.4.2 | 8.5.2 | 8.5.2 |

Both direct-dependency `npm outdated --json` checks return `{}` after the update. These versions apply to this checkout; a running installed desktop app keeps its existing runtime until replaced.

## Native platform tooling

- This Mac has Xcode 26.2, iOS SDK 26.2 and macOS 26.5.1. Apple lists Xcode 27 with iOS SDK 27 as stable, requiring macOS 26.6 or later. Xcode 26.6 is the newest listed toolchain compatible with this Mac's current operating system. The operating system and Xcode have not been upgraded in this change.
- Android still compiles and targets API 36 with Android Gradle Plugin 8.13.0. Google has released Android 17 / API 37. That native target migration and Android device validation remain separate work; updating Capacitor does not update the target SDK automatically.

## Security results

- Mobile full dependency audit: 3 findings before (2 critical, 1 high), zero after.
- Desktop full dependency audit: 13 findings before (4 high, 9 moderate), 8 moderate after. All remaining findings flow through Electron Builder's development dependency chain to `sprintf-js` (GHSA-hp3w-g68c-fv3c). There is no patched current `sprintf-js` release. Do not force the audit's suggested Electron Builder downgrade merely to make the count zero.
- Desktop production dependency audit (`npm audit --omit=dev`): zero findings.
- Capacitor 8.5.2 removes the vulnerable internal HTTP proxy versions covered by GHSA-rvm3-566m-v7fv. Electron 44.6.0 removes the advisories reported against the previous 43.4.0 install.
- Capacitor CLI's `xcode` dependency otherwise pulls a vulnerable uuid 7 release. A scoped override selects uuid 11.1.1, which retains CommonJS compatibility. `xcode` only uses `uuid.v4()`; parsing the real project, generating 25 IDs, serializing and reparsing the project, and Capacitor sync all pass. Revisit this override when upstream `xcode` updates its dependency.

## Design and interaction changes

- Clear host and session hierarchy, separate ownership and path labels, accessible session buttons, and focus-preserving refresh.
- Larger draft field, word count, persistence state, separate host/local review cards and visible return action. Editorial light, dark and Instrument label contrast is checked against 4.5:1.
- Compact portrait keys and a side-by-side landscape terminal and keyboard. Geometry checks include the Return row and command strip, plus horizontal overflow and minimum terminal height.
- Clipboard text is shown for review. Line breaks and terminal control characters become spaces; typing never implicitly presses Return.
- Session close responses are tied to their original selection. Hidden panes release control and drop queued input. Draft persistence failures are reported and the persistence queue can recover. Resize and transport failures no longer create unhandled promise rejections.

## Validation and limits

- Real PTY, native draft editor, engine takeover/handback, clipboard review, delayed close, queued input after hiding, all three looks and compact/landscape phone fixtures pass on Electron 44.6.0.
- Panels: 100/100; mobile shell: 43/43; backend terminal/draft/speech/gate checks: 31/31; draft-file checks: 5/5.
- Gates client, companion, mobile bridge, Electron security, packaging, brand copy, contrast, release preflight/verification, release channel, version parity and user-data-directory isolation pass.
- The first backend run overlapped several browser suites and missed early output within a one-second timing assertion. The isolated rerun passed 31/31 without changing that test. Both logs are retained.
- Screenshots are renders of this checkout's test fixtures, not captures from the physical phone. Native-device installation and launch results are recorded separately in the evidence receipt.
- No store submission, push, public release or relay deployment is part of this change. The Android native build and an Xcode 27 build have not been validated here.

## Sources and evidence

- npm registry version snapshots and before/after audit JSON are in `/Users/crowelogic/crowe-evidence/2026-10-06-phone-polish-sdk/`.
- Apple toolchain matrix: https://developer.apple.com/xcode/system-requirements
- Capacitor release: https://github.com/ionic-team/capacitor/releases/tag/8.5.2
- Capacitor security advisory: https://github.com/advisories/GHSA-rvm3-566m-v7fv
- Electron release: https://github.com/electron/electron/releases/tag/v44.6.0
- Android 17 release: https://developer.android.com/blog/posts/android-17-is-here
- Android target migration: https://developer.android.com/about/versions/17/setup-sdk
