#!/usr/bin/env bash
# Deploy the web build to crowelm.com/app.
#
#   bash scripts/deploy-web.sh            deploy the committed renderer files
#   bash scripts/deploy-web.sh --verify   only check what is served against HEAD
#   bash scripts/deploy-web.sh --rollback restore the newest dated backup
#
# This is docs/WEB-DEPLOY.md as a command. The first deploy was four lines run
# by hand from a session transcript; the second was the same four lines pasted
# again. A procedure that lives in a document is a procedure that drifts, so
# the document now points here and this script is what the document says.
#
# What it refuses to do: ship an uncommitted renderer file (the desktop and
# mobile suites hold renderer.js to their own contracts and only the committed
# bytes have passed them), or ship a stale rooms bundle (npm test would fail on
# it, and so does this).
#
# What it proves afterwards: the served rooms-web.js carries the same engine
# hash as the local bundle, and the served app.html carries the local stamp,
# read through the same edge a browser reads. A deploy that cannot be verified
# from outside is a copy, not a deploy.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${HOST:-crowelogic@crowelm-chat}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/google_compute_engine}"
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 "$HOST")
SCP=(scp -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15)
DEST=/var/lib/docker/volumes/caddy_config/_data/crowe-app/renderer
FILES=(app.html web-bridge.js rooms-web.js renderer.js)
PUBLIC="${PUBLIC:-https://crowelm.com/app/renderer}"

stamp_local() { grep -oE '\?v=[0-9]+' "$ROOT/renderer/app.html" | head -1; }
engine_local() { grep -oE 'engine [0-9a-f]{12}  registry [0-9a-f]{12}  roster [0-9a-f]{12}' "$ROOT/renderer/rooms-web.js"; }

verify() {
  # The edge asks for credentials; a 401 here means the files are behind auth,
  # which is expected. Verification that needs the content goes through an
  # authenticated fetch. HEAD without credentials still proves the route.
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC/rooms-web.js")"
  echo "edge: $PUBLIC/rooms-web.js -> HTTP $code"
  if [ -n "${CROWE_APP_AUTH:-}" ]; then
    # CROWE_APP_AUTH="user:pass" is only ever set in the caller's shell for
    # this one command; it is not read from any file here.
    local served_engine served_stamp
    served_engine="$(curl -s -u "$CROWE_APP_AUTH" "$PUBLIC/rooms-web.js" | grep -oE 'engine [0-9a-f]{12}  registry [0-9a-f]{12}  roster [0-9a-f]{12}' || true)"
    served_stamp="$(curl -s -u "$CROWE_APP_AUTH" "$PUBLIC/app.html" | grep -oE '\?v=[0-9]+' | head -1 || true)"
    echo "served engine: ${served_engine:-none}"
    echo "local  engine: $(engine_local)"
    echo "served stamp:  ${served_stamp:-none}"
    echo "local  stamp:  $(stamp_local)"
    [ "$served_engine" = "$(engine_local)" ] && [ "$served_stamp" = "$(stamp_local)" ] \
      && echo "verified: served build matches HEAD" \
      || { echo "MISMATCH: served build does not match HEAD" >&2; return 1; }
  else
    echo "set CROWE_APP_AUTH=user:pass in your shell for a content-level check; route check only."
  fi
}

rollback() {
  "${SSH[@]}" "D=$DEST; B=\$(ls -d \$D/.bak-* 2>/dev/null | tail -1); [ -n \"\$B\" ] || { echo 'no backup found' >&2; exit 1; }; sudo cp -a \$B/* \$D/ && sudo docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 && echo \"rolled back to \$B\""
}

case "${1:-}" in
  --verify)   verify; exit $? ;;
  --rollback) rollback; exit $? ;;
  "") ;;
  *) echo "usage: $0 [--verify|--rollback]" >&2; exit 2 ;;
esac

cd "$ROOT"

# Refuse to ship anything but committed bytes.
if [ -n "$(git status --porcelain -- renderer/)" ]; then
  echo "renderer/ has uncommitted changes; commit them first (only committed bytes have passed the suites):" >&2
  git status --short -- renderer/ >&2
  exit 1
fi
node scripts/build-rooms-web.js --check >/dev/null || { echo "renderer/rooms-web.js is stale; run npm run rooms:web and commit" >&2; exit 1; }
node scripts/test-web-bridge.js >/dev/null || { echo "test-web-bridge.js failing; not deploying" >&2; exit 1; }

echo "shipping $(git log -1 --format='%h %s') stamp $(stamp_local)"
"${SCP[@]}" "${FILES[@]/#/renderer/}" "$HOST:/tmp/"

"${SSH[@]}" "D=$DEST; B=\$D/.bak-\$(date +%Y%m%d-%H%M%S); sudo mkdir -p \$B && sudo cp -a \$D/*.js \$D/*.html \$B/ 2>/dev/null || true; for f in ${FILES[*]}; do sudo install -m 0644 -o root -g root /tmp/\$f \$D/\$f && rm -f /tmp/\$f; done && sudo docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 && echo \"installed; backup \$B\""

verify || true
echo "rollback: bash scripts/deploy-web.sh --rollback"
