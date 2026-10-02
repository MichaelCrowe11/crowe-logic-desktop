#!/bin/bash
# Smoke a packaged build without touching your profile (macOS).
#
#   scripts/smoke-packaged-mac.sh                      build this checkout unsigned, launch, check, clean up
#   scripts/smoke-packaged-mac.sh --app "/x/Y.app"     smoke an existing build instead: the installed app, or a release unzipped from the feed
#   scripts/smoke-packaged-mac.sh --keep               leave the build and the profile for a look
#
# What it proves that `npm test` cannot: the app as electron-builder lays it
# out, fuses flipped (RunAsNode off, app only from the asar), starts the
# bundled Channel Analytics server as a utility process from app.asar.unpacked
# and keeps it. The dev Electron in node_modules has its fuses on and hides
# that whole class; the 2026-09-15 review of PR 82 is the case it exists for.
#
# A build made here is unsigned (identity null) and unnotarized, for a local
# look only; the fuse flip and the file layout are the release build's. With
# --app the binary is whatever you point at, a shipped one included.
#
# The launch sits on a throwaway profile through --user-data-dir, the Chromium
# switch Electron maps onto userData, so the installed app's live profile is
# never opened. HOME= does not do that on macOS (2026-09-15: three launches
# landed on the live profile beside the running app that way). If the
# throwaway has not filled within 5 s the app is killed and the run fails, so
# a binary that ignored the switch could not sit on the live profile for
# long. --use-mock-keychain keeps the launch away from the real Keychain item,
# which an ad-hoc-signed build would otherwise prompt for.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ "$(uname -s)" = Darwin ] || { echo "macOS only"; exit 2; }
ARCH=$(uname -m); [ "$ARCH" = arm64 ] || ARCH=x64
APP_GIVEN=""; KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP_GIVEN="${2:-}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown argument: $1"; exit 2 ;;
  esac
done
WORK=$(mktemp -d "${TMPDIR:-/tmp}/crowe-packaged-smoke-XXXXXX")
OUT="$WORK/release"; PROFILE="$WORK/profile"; WS="$WORK/workspace"; MANAGER="$WORK/manager/state"
mkdir -p "$PROFILE" "$WS" "$MANAGER"
APP_PID=""
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  if [ "$KEEP" = 1 ]; then echo "kept $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT
fail() { echo "FAIL $1"; exit 1; }
pass() { echo "  ok   $1"; }

if [ -n "$APP_GIVEN" ]; then
  APP="$APP_GIVEN"
  [ -d "$APP/Contents/MacOS" ] || fail "$APP is not an app bundle"
  pass "smoking the given build $APP ($(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString))"
else
  # The same files, asarUnpack and afterPack fuse flip as package.json's build;
  # only the signing, the target and the output folder differ. electron-builder
  # resolves the hooks (build/fuses.js) against the project dir, so the config
  # can live outside it.
  node -e '
const [root, out] = process.argv.slice(1);
const base = require(root + "/package.json").build;
process.stdout.write("module.exports = " + JSON.stringify({ ...base, directories: { output: out }, mac: { ...base.mac, identity: null, target: ["dir"] }, publish: null }, null, 1) + ";\n");
' "$ROOT" "$OUT" > "$WORK/builder.config.js"
  echo "building an unsigned $ARCH dir build of $ROOT (a minute or two)"
  ( cd "$ROOT" && CROWE_SKIP_NOTARIZE=1 CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac "--$ARCH" --dir --config "$WORK/builder.config.js" > "$WORK/build.log" 2>&1 ) || { tail -20 "$WORK/build.log"; fail "build"; }
  APP=$(ls -d "$OUT"/mac*/*.app | head -1)
  pass "built $APP"
fi
BIN="$APP/Contents/MacOS/$(defaults read "$APP/Contents/Info.plist" CFBundleExecutable)"

FUSES=$(cd "$ROOT" && npx electron-fuses read --app "$APP" 2>&1)
echo "$FUSES" | grep -q 'RunAsNode is Disabled' || { echo "$FUSES"; fail "RunAsNode is not off in this build"; }
echo "$FUSES" | grep -q 'OnlyLoadAppFromAsar is Enabled' || { echo "$FUSES"; fail "OnlyLoadAppFromAsar is not on in this build"; }
pass "fuses: RunAsNode off, app only from the asar"
[ -f "$APP/Contents/Resources/app.asar.unpacked/plugins/channel-analytics/server.js" ] || fail "no bundled Channel Analytics server beside the asar (a build older than 0.24.10?)"
pass "bundled server sits in app.asar.unpacked"

# A profile with the plugin already enabled, so the connect happens at boot
# with nothing to click, and a manager fixture so the server has state to read.
echo '[{"id":"packaged-smoke","value":0.9,"done":false,"title":"read in the packaged app"}]' > "$MANAGER/hand_tasks.json"
node -e 'process.stdout.write(JSON.stringify({ cwd: process.argv[1], telemetry: false, onboarded: true, plugins: { "channel-analytics": { enabled: true } } }))' "$WS" > "$PROFILE/config.json"

# The live profile this binary would otherwise open, for the report at the end.
LIVE="$HOME/Library/Application Support/$(defaults read "$APP/Contents/Info.plist" CFBundleName)"
live_stamp() { for f in config.json auth.bin Preferences; do [ -e "$LIVE/$f" ] && stat -f "$f=%m" "$LIVE/$f"; done | tr '\n' ' '; }
BEFORE=$(live_stamp || true)

echo "launching on the throwaway profile $PROFILE"
SWM_CHANNEL_MANAGER_DIR="$WORK/manager" SWM_CHANNEL_EVIDENCE_DIR="$WORK/manager" \
  "$BIN" --user-data-dir="$PROFILE" --use-mock-keychain > "$WORK/app.log" 2>&1 &
APP_PID=$!
FILLED=""
for i in $(seq 1 10); do
  if ls "$PROFILE" | grep -q 'Local State\|Preferences\|Cache'; then FILLED=$((i * 500)); break; fi
  sleep 0.5
done
[ -n "$FILLED" ] || { kill "$APP_PID" 2>/dev/null || true; APP_PID=""; fail "the throwaway profile did not fill in 5 s; the app was killed. It may have opened another profile: check $LIVE"; }
pass "the launch filled the throwaway profile at t=${FILLED}ms, not another one"

helpers() { ps -eo ppid,args | awk -v p="$APP_PID" '$1==p' | { grep -c 'node.mojom.NodeService' || true; }; }
FIRST=""
for i in $(seq 1 40); do
  n=$(helpers)
  if [ "$n" != 0 ] && [ -z "$FIRST" ]; then FIRST=$((i * 500)); fi
  sleep 0.5
done
kill -0 "$APP_PID" 2>/dev/null || { tail -5 "$WORK/app.log"; fail "the app did not stay up for 20 s"; }
[ -n "$FIRST" ] || { tail -5 "$WORK/app.log"; fail "no node utility process appeared under the app in 20 s"; }
pass "node utility process forked under the app at t=${FIRST}ms"
# A failed handshake is killed by main.js within 15 s, so alive at 20 s means connected.
[ "$(helpers)" = 1 ] || fail "the utility process did not survive to t=20s (handshake failed or the server exited)"
pass "still there at t=20s, past the 15 s handshake timeout"

kill "$APP_PID"; APP_PID=""
sleep 2
LEFT=$(ps -eo args | grep -F "$BIN" | grep -c 'node.mojom.NodeService' || true)
[ "$LEFT" = 0 ] || fail "$LEFT utility process(es) outlived the app"
pass "the utility process ended with the app"
if [ -d "$LIVE" ]; then
  AFTER=$(live_stamp || true)
  if [ "$BEFORE" = "$AFTER" ]; then pass "the live profile at $LIVE did not move during the run"
  else echo "  note the live profile at $LIVE changed during the run ($AFTER); the running app rewrites config.json and auth.bin every 4 minutes on its own, so read the times before reading anything into it"; fi
fi
echo
echo "packaged smoke: all checks passed"
