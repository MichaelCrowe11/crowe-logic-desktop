#!/usr/bin/env bash
# Deploy the web build to crowelm.com/app. The procedure is docs/WEB-DEPLOY.md;
# this runs it and then proves it by hashing what the VM now serves against the
# working tree, because `scp` exiting 0 says a copy happened, not that the edge
# serves it.
#
#   scripts/deploy-web.sh            deploy + verify
#   scripts/deploy-web.sh --check    verify only (what is live vs this tree)
set -euo pipefail
cd "$(dirname "$0")/.."
KEY="${SSH_KEY:-$HOME/.ssh/google_compute_engine}"
HOST="${HOST:-crowelogic@crowelm-chat}"
D=/var/lib/docker/volumes/caddy_config/_data/crowe-app/renderer
# [local path]=[served name]
FILES=(renderer/app.html renderer/web-bridge.js renderer/web-ui.js renderer/rooms-web.js renderer/renderer.js renderer/styles.css mobile/src/mobile.css mobile/src/mobile-ui.js)

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
echo "shipping $(git log -1 --format='%h %s')"
scp -i "$KEY" "${FILES[@]}" "$HOST:/tmp/"
ssh -i "$KEY" -o BatchMode=yes "$HOST" "D=$D; B=\$D/.bak-\$(date +%Y%m%d-%H%M%S); sudo mkdir -p \$B && sudo cp -a \$D/*.js \$D/*.html \$D/*.css \$B/ 2>/dev/null; for f in $(for f in "${FILES[@]}"; do basename "$f"; done | tr '\n' ' '); do sudo install -m 0644 -o root -g root /tmp/\$f \$D/\$f && rm -f /tmp/\$f; done && sudo docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile && echo \"installed; backup \$B\""
echo "verifying what the VM serves:"
verify
