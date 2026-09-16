#!/bin/bash
# Smoke a packaged build of this checkout without touching your profile (macOS).
#
#   scripts/smoke-packaged-mac.sh          build, launch, check, clean up
#   scripts/smoke-packaged-mac.sh --keep   leave the build and the profile for a look
#
# What it proves that `npm test` cannot: the app as electron-builder lays it
# out, fuses flipped (RunAsNode off, app only from the asar), starts the
# bundled Channel Analytics server as a utility process from app.asar.unpacked
# and keeps it. The dev Electron in node_modules has its fuses on and hides
# that whole class; the 2026-09-15 review of PR 82 is the case it exists for.
#
# Unsigned (identity null) and unnotarized, so it is for a local look only; the
# fuse flip and the file layout are the release build's. The launch sits on a
# throwaway profile through CROWE_TEST_PROFILE (main.js honours it only inside
# the temp folder), so the installed app's profile is never opened; HOME does
# not do that on macOS. --use-mock-keychain keeps an ad-hoc-signed build away
# from the real Keychain item, which would otherwise prompt.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ "$(uname -s)" = Darwin ] || { echo "macOS only"; exit 2; }
ARCH=$(uname -m); [ "$ARCH" = arm64 ] || ARCH=x64
KEEP=0; [ "${1:-}" = --keep ] && KEEP=1
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

# The same files, asarUnpack and afterPack fuse flip as package.json's build;
# only the signing, the target and the output folder differ.
node -e '
const [root, out] = process.argv.slice(1);
const base = require(root + "/package.json").build;
process.stdout.write("module.exports = " + JSON.stringify({ ...base, directories: { output: out }, mac: { ...base.mac, identity: null, target: ["dir"] }, publish: null }, null, 1) + ";\n");
' "$ROOT" "$OUT" > "$WORK/builder.config.js"
# electron-builder resolves the hooks (build/fuses.js) against the project dir,
# so the config can live outside it.
echo "building an unsigned $ARCH dir build of $ROOT (a minute or two)"
( cd "$ROOT" && CROWE_SKIP_NOTARIZE=1 CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac "--$ARCH" --dir --config "$WORK/builder.config.js" > "$WORK/build.log" 2>&1 ) || { tail -20 "$WORK/build.log"; fail "build"; }
APP=$(ls -d "$OUT"/mac*/*.app | head -1)
BIN="$APP/Contents/MacOS/$(defaults read "$APP/Contents/Info.plist" CFBundleExecutable)"
pass "built $APP"

FUSES=$(cd "$ROOT" && npx electron-fuses read --app "$APP" 2>&1)
echo "$FUSES" | grep -q 'RunAsNode is Disabled' || { echo "$FUSES"; fail "RunAsNode is not off in the build"; }
echo "$FUSES" | grep -q 'OnlyLoadAppFromAsar is Enabled' || { echo "$FUSES"; fail "OnlyLoadAppFromAsar is not on in the build"; }
pass "fuses: RunAsNode off, app only from the asar"
[ -f "$APP/Contents/Resources/app.asar.unpacked/plugins/channel-analytics/server.js" ] || fail "server.js is not unpacked beside the asar"
pass "bundled server sits in app.asar.unpacked"

# A profile with the plugin already enabled, so the connect happens at boot
# with nothing to click, and a manager fixture so the server has state to read.
echo '[{"id":"packaged-smoke","value":0.9,"done":false,"title":"read in the packaged app"}]' > "$MANAGER/hand_tasks.json"
node -e 'process.stdout.write(JSON.stringify({ cwd: process.argv[1], telemetry: false, onboarded: true, plugins: { "channel-analytics": { enabled: true } } }))' "$WS" > "$PROFILE/config.json"

echo "launching on the throwaway profile $PROFILE"
CROWE_TEST_PROFILE="$PROFILE" SWM_CHANNEL_MANAGER_DIR="$WORK/manager" SWM_CHANNEL_EVIDENCE_DIR="$WORK/manager" \
  "$BIN" --use-mock-keychain > "$WORK/app.log" 2>&1 &
APP_PID=$!
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
[ "$(ls "$PROFILE" | wc -l | tr -d ' ')" -gt 1 ] || fail "the throwaway profile did not fill; the launch ran on some other profile"
pass "the launch filled the throwaway profile, not another one"

kill "$APP_PID"; APP_PID=""
sleep 2
LEFT=$(ps -eo args | grep -F "$OUT" | grep -c 'node.mojom.NodeService' || true)
[ "$LEFT" = 0 ] || fail "$LEFT utility process(es) outlived the app"
pass "the utility process ended with the app"
echo
echo "packaged smoke: all checks passed"
