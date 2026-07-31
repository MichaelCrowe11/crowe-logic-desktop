#!/usr/bin/env bash
set -euo pipefail

# Publish release objects into R2 by having the worker pull them from the
# GitHub release, instead of pushing them up from here.
#
# Use this when publish-r2.sh cannot get the big installers up. The Cloudflare
# object API refuses large bodies on some networks - see the note above the
# ingest handler in deploy/releases-worker/src/index.js - and no amount of
# retrying fixes a connection that fails before it sends anything. Uploading the
# artifacts to the GitHub release works from the same machine at the same
# moment, so let Cloudflare fetch them from there.
#
#   scripts/ingest-release.sh v0.21.0 CroweLogic-0.21.0-x64.dmg ...
#
# With no names it publishes every asset of the tag that is not a feed manifest.
# Names are the names the object gets in the bucket, which is the name the feed
# advertises - GitHub rewrites spaces to dots on upload, so the asset is looked
# up under both spellings, the same way publish-r2.sh resolves files on disk.
#
# Requires INGEST_TOKEN (the secret set on the worker) and a gh login that can
# read the repo's releases.

tag="${1:-}"
if [ -z "$tag" ]; then
  echo "usage: scripts/ingest-release.sh <tag> [object name ...]" >&2
  exit 1
fi
shift || true

: "${INGEST_TOKEN:?set INGEST_TOKEN to the secret set on the worker}"
host="${RELEASES_HOST:-https://crowe-releases.yellow-block-3adc.workers.dev}"
version="${tag#v}"
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh_token=$(gh auth token)

assets=$(gh api "repos/$repo/releases/tags/$tag" -q '.assets[] | "\(.name)\t\(.id)\t\(.size)"')
if [ -z "$assets" ]; then
  echo "ingest-release: $tag has no assets" >&2
  exit 1
fi

if [ "$#" -gt 0 ]; then
  names=("$@")
else
  names=()
  while IFS=$'\t' read -r name _ _; do
    case "$name" in latest*.yml) continue ;; esac
    names+=("$name")
  done <<< "$assets"
fi

lookup() {
  local want="$1" dotted="${1// /.}"
  awk -F'\t' -v a="$want" -v b="$dotted" '$1==a || $1==b { print $2 "\t" $3; exit }' <<< "$assets"
}

failed=()
for name in "${names[@]}"; do
  hit=$(lookup "$name")
  if [ -z "$hit" ]; then
    echo "ingest-release: $tag has no asset named $name" >&2
    failed+=("$name")
    continue
  fi
  id=${hit%%$'\t'*}
  size=${hit##*$'\t'}
  key="desktop/$version/$name"

  printf '%-44s ' "$name"
  code=$(curl -sS -o /tmp/ingest-reply.$$ -w '%{http_code}' -X POST "$host/_ingest" \
    -H "x-ingest-token: $INGEST_TOKEN" \
    -H "x-github-token: $gh_token" \
    -H "content-type: application/json" \
    -d "{\"key\":\"$key\",\"assetId\":$id,\"size\":$size}") || code=000

  if [ "$code" != "200" ]; then
    echo "ingest failed ($code): $(cat /tmp/ingest-reply.$$)"
    failed+=("$name")
    rm -f /tmp/ingest-reply.$$
    continue
  fi
  rm -f /tmp/ingest-reply.$$

  # Uploading is not publishing. Ask the public url for the last byte: that
  # proves the object is readable at the key the updater will request and that
  # it is as long as the release says it is.
  served=$(curl -s -o /dev/null -w '%{http_code}' -r "$((size - 1))-$((size - 1))" "$host/$key")
  if [ "$served" = "206" ]; then
    echo "published $size bytes"
  else
    echo "wrote but serves $served"
    failed+=("$name")
  fi
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "ingest-release: these did not publish:" >&2
  printf '  %s\n' "${failed[@]}" >&2
  exit 1
fi
