# Building, signing, and releasing

Everything here was verified on a machine on 2026-08-05 unless it says otherwise.
Where something could not be verified, it says so and says why — a runbook that
quietly guesses is worse than one with a hole in it, because you find the hole
during a release.

## What ships

One Electron app, `com.crowelogic.desktop`, product name **Crowe Logic**. It also
ships as a phone app from the same renderer through a Capacitor shell in
`mobile/`.

**This is not Crowe Logic Cortex.** That is a separate Electron app in a separate
repo (`crowe-cortex`, `io.crowelogic.cortex`). The README states the division:
this one is Electron on Windows, Linux and macOS, covering the gap Cortex leaves
as a macOS-only app. Worth knowing before you go looking for a build rail in the
wrong repo, and worth confirming with Michael before writing it into anything
customer-facing, since the two names overlap in a way the products do not.

| Target | Command | Artifacts |
| --- | --- | --- |
| macOS | `npm run build:mac` | `CroweLogic-<version>-{arm64,x64}.{dmg,zip}` |
| Windows | `npm run build:win` | `Crowe Logic Setup <version>.exe` (nsis) |
| Linux | `npm run build:linux` | `Crowe Logic-<version>.AppImage`, `crowe-logic-desktop_<version>_amd64.deb` |
| iOS | `cd mobile && npm run ios` | Xcode archive, exported with `ios/ExportOptions.plist` |
| Android | `cd mobile && npm run android` | APK/AAB from Gradle |

Output lands in `release/`. `npm start` runs the app from source.

## Run the tests first

```
npm install
npm test
```

Green baseline on macOS as of 2026-08-05 is **exit 0**. Several steps in the chain
run under `electron`, not `node`, so a headless box needs a display server for
them. If something is red before you start, note it before you change anything —
attributing a pre-existing failure to your own diff wastes an afternoon.

## Version: one place, derived outward

The desktop version lives in `package.json`. The phone version lives in
`mobile/package.json`, and everything else is derived from it.

The store build number is `major * 10000 + minor * 100 + patch`. `0.24.0` becomes
`2400`. It must be a single ascending integer because Play refuses a `versionCode`
it has already seen and App Store Connect refuses a build number it has already
seen — and both refusals arrive *after* the upload.

- **Android** derives it live in `mobile/android/app/build.gradle`, so it cannot
  drift from `mobile/package.json`.
- **iOS cannot**, because `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` are
  build settings inside `project.pbxproj`. `mobile/scripts/sync-version.js` writes
  them; `--check` runs in `npm test`.

Bump a version by editing `mobile/package.json` and running
`node mobile/scripts/sync-version.js`, then commit the `project.pbxproj` change.

The derivation only ascends while minor and patch each stay under 100. Both sides
assert that rather than assume it.

> The formula is written twice, in two languages. `scripts/test-version-parity.js`
> compares the constants both sides use, anchors them to the number
> `sync-version.js --check` actually reports, and asserts the guard equals the
> carry — so widening both guards to 999 fails rather than silently encoding
> `0.100.0` as `1.0.0`. It runs in `npm test`.

## Signing and submission

### macOS

Signed as `Developer ID Application: Michael Crowe (6QLMV9UCPP)` with hardened
runtime and the entitlements in `build/`. That identity **is** present in the
keychain on this machine (verified).

Notarization runs from the `afterSign` hook, `build/notarize.js`, which shells out
to `xcrun notarytool submit --keychain-profile <profile> --wait`. The profile name
comes from `CROWE_NOTARY_PROFILE` and defaults to **`crowe-notary`**.

**Verified gotcha: no notarytool credential profile is stored on this machine.**
`crowe-notary` does not exist, and neither does any other. A `build:mac` will get
through signing and then fail at the hook. Two ways forward:

```
# Store the credential once (needs an App Store Connect API key or an app-specific password)
xcrun notarytool store-credentials crowe-notary --key ... --key-id ... --issuer ...

# Or build without notarizing, for a local smoke test only — never for distribution
CROWE_SKIP_NOTARIZE=1 npm run build:mac
```

A build made with `CROWE_SKIP_NOTARIZE=1` is not shippable. Gatekeeper will refuse
it on any machine but the one that built it.

### iOS

`mobile/ios/ExportOptions.plist` selects the App Store channel: method
`app-store-connect`, team `6QLMV9UCPP`, automatic signing, `uploadSymbols` on so a
user's crash report arrives symbolicated instead of as addresses.

The archive is signed with whatever identity the build machine has, which is a
development one. **Export is where it gets re-signed for distribution.** With an
App Store Connect API key, `xcodebuild` creates the Apple Distribution certificate
and the store provisioning profile itself — this was demonstrated from a machine
with no distribution certificate in its keychain at all.

The API key is read from the environment:

```
APP_STORE_CONNECT_KEY_ID
APP_STORE_CONNECT_ISSUER_ID
APP_STORE_CONNECT_API_KEY_PATH     # a .p8 under ~/.appstoreconnect/private_keys/
```

All three were set and the `.p8` files present as of 2026-08-05, so an export is
reproducible here. **Actual submission to App Store Connect is a separate,
outward-facing step and is Michael's call, not an automated one.**

### Android

Release signing reads `mobile/android/keystore.properties` (git-ignored) or the
environment:

```
CROWE_ANDROID_KEYSTORE
CROWE_ANDROID_KEYSTORE_PASSWORD
CROWE_ANDROID_KEY_ALIAS
CROWE_ANDROID_KEY_PASSWORD
```

With none of it present the release build goes **unsigned** rather than failing.
That is deliberate: an unsigned release still catches a packaging regression, and
Play refuses it long before anyone could mistake it for shippable.

`.gitignore` keeps the keystore and any `.jks` out of history. The keystore is the
one secret that, leaked, lets someone else ship an update to your users.

**Verified gotcha: Android cannot be built on this Mac.** No JDK, no Gradle, no
Android SDK. Installing the toolchain runs 4-6GB against a disk that has a
documented history of filling up and killing sessions with `ENOSPC`. Build Android
in CI — ubuntu runners already ship a JDK — or on a machine with headroom. The
Gradle derivation has therefore never actually been executed; it has only been
read.

## Icons

```
npm run icons          # regenerate
npm run icons:check    # verify committed art matches the vectors
```

`gen-mark.js` draws the house mark and everything derived from it. `make-icons.js`
renders the raster ladder — `.ico` rungs, `.icns`, the iOS app icon, every Android
mipmap — and `--check` holds the committed files against a fresh render.

### What the drift gate proves, and what it does not

This gate was wrong twice, and both fixes are worth understanding before touching
it.

**It used to compare two renderers and call the difference staleness.** The check
was exact byte equality on the decoded bitmap, on the theory that this let it run
on a Linux CI box against art rendered on a Mac. That was never true: Skia does
not rasterise antialiased vectors to identical bitmaps across platforms. The
assumption survived while the ladder covered 14 files and broke the moment it
covered 41 — every `.ico` rung, the iOS icon and every Android mipmap came back
stale on Linux against art a Mac calls current.

**It also measured `.icns` against a renderer that cannot write it.** `iconutil` is
macOS-only, so the committed container holds macOS renders and CI was comparing
them to a Linux rasterisation of the same vector. The `.icns` is now checked only
where it can be authored. That does not put it beyond checking — a Mac holds it to
the vectors in full, and a Mac is the only place it can be regenerated, so a
drifted `.icns` cannot reach a release without the machine cutting that release
saying so. The count drops from 42 rasters to 41 on Linux, so the total never
claims more than it looked at.

Comparison is now a **shaped tolerance**, not equality. Renderer noise lives on the
edges of shapes: a thin band of pixels whose coverage rounded the other way, each
off by a little. A real change moves or recolours area — many pixels off by a lot.

The threshold is **8%**, and it was measured rather than guessed. The first attempt
was 3%, picked before any data existed, and it sat where no small raster could
pass. CI then supplied the data: renderer noise tops out at **4.80%** (on the 16px
rung, where almost every pixel is an edge), and two genuinely different mipmaps
measure **53%** and **62%**. The valley between those populations is wide, and 8%
sits in it.

**A future run landing between 5% and 50% is art that changed, not a threshold to
widen.**

What the gate does not prove: that the icons look right. It proves the committed
rasters still correspond to the vectors they were rendered from.

## Releasing

Tag-triggered. `.github/workflows/release.yml` fires on `v*` tags and on manual
dispatch. `scripts/publish-r2.sh` pushes artifacts to R2 and reads
`GITHUB_REF_NAME` for the version — correct there, because on a tag-triggered run
that variable *is* the tag.

Updates are served by a Cloudflare Worker, not by GitHub:

```
https://crowe-releases.yellow-block-3adc.workers.dev/desktop/channel/${os}
```

### Verifying a release

```
npm run verify:release              # the version in package.json
npm run verify:release -- 0.24.0
npm run verify:release -- 0.24.0 --full   # also downloads each artifact, ~0.5 GB
```

This exists because **a broken release fails silently**. A feed naming a file the
bucket does not have reports nothing to anyone: the updater 404s in the background
and the user simply stays on the old version forever. Nothing surfaces that — not
the build, not the publish, not the download page. It has nearly shipped twice.

The checks run over the network, the way a client meets the release: fetch each
channel feed, then ask for every file it names, by the exact URL it names, through
the channel prefix the updater resolves against. Range requests rather than HEADs,
because a 206 proves differential updates will work and a HEAD proves only that the
object exists.

`.github/workflows/verify-release.yml` also runs this on a daily cron.

**Gotcha, now fixed — worth knowing because the shape recurs.** The scheduled run
was red every morning from
2026-08-03 against a release that was healthy the whole time. `verify-release.js`
resolved the version as `argv || GITHUB_REF_NAME || pkg.version`, and on a
scheduled run `GITHUB_REF_NAME` is the *branch* — so it verified a release called
`main` and 404'd on everything. The lesson generalises: `GITHUB_REF_NAME` is a ref,
not a version, and it only names a release on a tag-triggered run.

## Gotchas, collected

- **No notarytool profile on this machine.** `build:mac` fails at the `afterSign`
  hook. Store credentials or use `CROWE_SKIP_NOTARIZE=1` for local builds only.
- **Android is unbuildable here.** No JDK, no SDK; installing them risks filling
  the disk. Use CI.
- **A stale screenshot is the product.** Store screenshots that show an old version
  string in the UI have to be recaptured on a version bump. Play also caps a phone
  screenshot at 2:1, and the iOS device capture is 2.17:1, so the iOS set is
  refused by Play — `gen-store-frames.js` insets the same captures on a 1080x1920
  canvas rather than cropping them.
- **Every path in the app's own in-app browser returns 200** on the chat surfaces
  it points at, so a URL loading proves nothing about content existing.
- **Commit messages here state the problem in past tense** ("The drawer opened
  underneath the scrim"), not conventional-commit prefixes. The bodies carry the
  reasoning, including what was *not* verified. They are the real documentation;
  read them before changing something that looks arbitrary.
