#!/usr/bin/env bash
# Deploy the web build to crowelm.com/app. The procedure is docs/WEB-DEPLOY.md;
# this runs it and then proves it by hashing what the VM now serves against the
# working tree, because `scp` exiting 0 says a copy happened, not that the edge
# serves it.
#
#   scripts/deploy-web.sh                      deploy + verify
#   scripts/deploy-web.sh --check              verify only (what is live vs this tree)
#   scripts/deploy-web.sh --stamped-app-html   print the app.html that would ship
set -euo pipefail
cd "$(dirname "$0")/.."
KEY="${SSH_KEY:-$HOME/.ssh/google_compute_engine}"
HOST="${HOST:-crowelogic@crowelm-chat}"
D=/var/lib/docker/volumes/caddy_config/_data/crowe-app/renderer

# app.html loads each asset as name.js?v=<stamp>. The committed stamp is fixed
# (it last moved on 2026-09-07), so every deploy since shipped a new renderer.js
# and styles.css to browsers that kept serving the old ones from cache; raised
# on PR 102. The app.html that ships is rewritten with HEAD's commit time: one
# stamp per committed tree, so a browser fetches the assets once per deploy,
# and --check rebuilds the same file from the same commit for its comparison.
STAMP="$(git log -1 --format=%ct)"
TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT
sed -E "s/\?v=[0-9]+/?v=$STAMP/g" renderer/app.html > "$TMPD/app.html"
if [ "${1:-}" = "--stamped-app-html" ]; then cat "$TMPD/app.html"; exit 0; fi

# [local path]=[served name]; app.html ships from $TMPD in its stamped form.
FILES=("$TMPD/app.html" renderer/adopted-styles.js renderer/web-bridge.js renderer/web-ui.js renderer/mobile-gate.js renderer/theme-bootstrap.js renderer/mark-geometry.js renderer/mark.js renderer/rooms-web.js renderer/activity.js renderer/first-run.js renderer/messages.js renderer/marks.js renderer/renderer.js renderer/styles.css mobile/src/mobile.css mobile/src/mobile-ui.js)

local_hash() { shasum -a 256 "$1" | cut -c1-16; }
verify() {
  local names=() ok=1
  for f in "${FILES[@]}"; do names+=("$(basename "$f")"); done
  # The served directory is root-owned and not world-searchable, so every path
  # is absolute and read through sudo; a `cd` there fails for the login user.
  local paths=(); for n in "${names[@]}"; do paths+=("$D/$n"); done
  local live; live="$(ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "sudo sha256sum ${paths[*]} 2>/dev/null" || true)"
  for f in "${FILES[@]}"; do
    local n; n="$(basename "$f")"
    local want; want="$(local_hash "$f")"
    local got; got="$(printf '%s\n' "$live" | awk -v n="$D/$n" '$2==n {print substr($1,1,16)}')"
    if [ "$want" = "$got" ]; then echo "  live  $n  $got"; else echo "  DIFF  $n  live=${got:-missing} tree=$want"; ok=0; fi
  done
  [ "$ok" = 1 ]
}

if [ "${1:-}" = "--check" ]; then verify; exit $?; fi

if [ -n "$(git status --short renderer/ mobile/src/)" ]; then
  echo "refusing: uncommitted changes under renderer/ or mobile/src/ (ship what is committed)" >&2
  git status --short renderer/ mobile/src/ >&2; exit 1
fi
node scripts/build-rooms-web.js --check
echo "shipping $(git log -1 --format='%h %s') (asset stamp $STAMP)"
scp -i "$KEY" "${FILES[@]}" "$HOST:/tmp/"
ssh -i "$KEY" -o BatchMode=yes "$HOST" "D=$D; B=\$D/.bak-\$(date +%Y%m%d-%H%M%S); sudo mkdir -p \$B && sudo cp -a \$D/*.js \$D/*.html \$D/*.css \$B/ 2>/dev/null; for f in $(for f in "${FILES[@]}"; do basename "$f"; done | tr '\n' ' '); do sudo install -m 0644 -o root -g root /tmp/\$f \$D/\$f && rm -f /tmp/\$f; done && sudo docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile && echo \"installed; backup \$B\""
echo "verifying what the VM serves:"
verify
