#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# Publication always requires the accepted platform/architecture inventory.
# Explicit root/config paths are resolved against the caller before cd.
#   scripts/publish-r2.sh --matrix mac:arm64:dmg+zip,mac:x64:dmg+zip
#   scripts/publish-r2.sh --config electron-builder.mycology.js --matrix mac:arm64:dmg+zip
#   DRY_RUN=1 scripts/publish-r2.sh ...   # local strict preflight only
resolved=$(node "$here/publish-args.js" "$@") || exit 1
eval "$resolved"
cd "$here/.."
node "$here/preflight-release.js" "$root" "$version" "${validation_args[@]}"
if [ "${DRY_RUN:-0}" = 1 ]; then
  echo "publish-r2: strict dry run passed for the $channel channel; nothing uploaded"
  exit 0
fi
echo "publish-r2: publishing $version from $root to the $channel channel ($prefix/)"

# Uploads to the R2 API fail intermittently regardless of file size, so a single
# attempt is not enough to get a release out. Observed on a run where a 20 MB
# object failed and a 110 MB object immediately after it succeeded.
#
# Large bodies are also streamed rather than sent with --file: a sized single
# PUT above ~60-90 MB can die instantly ("fetch failed" in under 200ms, before
# anything is sent) on networks that a streamed body crosses fine. Measured on
# the same connection, same day: 90 MB --file failed five times running, 90 MB
# --pipe passed first try. Streaming costs nothing on good networks, so it is
# not worth keying on size.
#
# Streaming raises that ceiling but does not remove it. If an object still will
# not go up - the tell is "fetch failed" a few hundred ms in, the same every
# time, which is a connection refusing the transfer rather than losing it - stop
# retrying and reverse the direction:
#
#   INGEST_TOKEN=... scripts/ingest-release.sh v0.21.0
#   CHANNEL=developers INGEST_TOKEN=... scripts/ingest-release.sh v0.24.7
#
# That has the releases worker pull the artifacts from the GitHub release over
# Cloudflare's own network. v0.21.0's three largest macOS artifacts failed
# sixteen times from here and published first try that way.
put() {
  local key="$1" file="$2" attempt=1
  until npx wrangler r2 object put "crowe-releases/$key" --pipe --remote --config deploy/releases-worker/wrangler.jsonc < "$file"; do
    if [ "$attempt" -ge 5 ]; then
      echo "publish-r2: giving up on $key after $attempt attempts" >&2
      return 1
    fi
    echo "publish-r2: $key failed, retrying ($attempt)" >&2
    attempt=$((attempt + 1))
    sleep $((attempt * 5))
  done
}

# What gets uploaded is decided by the update feeds, not by globbing the release
# directory, because the two disagree in ways that break updates silently.
#
# GitHub rewrites spaces to dots in release asset names, so a file downloaded
# back with `gh release download` arrives as Crowe.Logic.Setup.0.16.0.exe while
# latest.yml still advertises "Crowe Logic Setup 0.16.0.exe". Uploading under
# basename put the object at the dotted key, the updater asked for the spaced
# one, and every Windows and Linux client got a 404 it had no way to report.
# Nobody sees a failed background update.
#
# Globbing also swept up artifacts from previous releases still sitting in the
# directory and republished them under this version's prefix, and into this
# version's SHA256SUMS.
#
# Reading the feeds fixes both: the key is the url the updater will actually
# request, and a stale artifact no feed mentions is simply never uploaded. The
# feeds read are the channel's own, so the other edition's build in the same
# directory is not a feed here and is never published under this channel.
feeds=()
for os in win mac linux; do
  var="feed_$os"; name="${!var}"
  file=$(find "$root" -type d -name '*.app' -prune -o -type f -name "$name" -print -quit)
  [ -z "$file" ] || feeds+=("$file")
done
if [ ${#feeds[@]} -eq 0 ]; then
  echo "publish-r2: no $channel feeds ($feed_win, $feed_mac, $feed_linux) under $root - nothing to publish" >&2
  exit 1
fi

wanted=$(mktemp)
for file in "${feeds[@]}"; do
  node -e 'const fs=require("fs"),yaml=require("js-yaml"); for(const f of yaml.load(fs.readFileSync(process.argv[1],"utf8")).files) console.log(f.url)' "$file" >> "$wanted"
done
sort -u -o "$wanted" "$wanted"

# The name in the feed may not be the name on disk. Try it verbatim, then the
# dotted form GitHub hands back.
resolve() {
  local want="$1" hit
  hit=$(find "$root" -type d -name '*.app' -prune -o -type f -name "$want" -print -quit)
  [ -n "$hit" ] || hit=$(find "$root" -type d -name '*.app' -prune -o -type f -name "${want// /.}" -print -quit)
  printf '%s' "$hit"
}

installers=() names=() missing=()
while IFS= read -r url; do
  [ -n "$url" ] || continue
  file=$(resolve "$url")
  if [ -z "$file" ]; then missing+=("$url"); continue; fi
  put "$prefix/$version/$url" "$file"
  installers+=("$file"); names+=("$url")
  # Blockmaps are requested as <url>.blockmap, so they follow the feed's naming
  # too, not the local file's.
  bmap=$(resolve "$url.blockmap")
  [ -z "$bmap" ] || put "$prefix/$version/$url.blockmap" "$bmap"
done < "$wanted"
rm -f "$wanted"

# A feed that names a file we cannot find is exactly the failure this script
# used to ship silently. Refuse to leave a half-published channel behind.
if [ ${#missing[@]} -gt 0 ]; then
  echo "publish-r2: these files are named in a feed but absent from $root:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi

# The download page tells people to run `sha256sum -c SHA256SUMS`, so the file
# has to exist. The name listed is the feed's, which is both what the object is
# keyed on and what lands in a download folder - checking a file against a line
# naming some other spelling of it is worse than having no checksum at all.
if [ ${#installers[@]} -gt 0 ]; then
  sums=$(mktemp)
  for i in "${!installers[@]}"; do
    file="${installers[$i]}"
    if command -v sha256sum >/dev/null; then
      printf '%s  %s\n' "$(sha256sum "$file" | cut -d' ' -f1)" "${names[$i]}" >> "$sums"
    else
      printf '%s  %s\n' "$(shasum -a 256 "$file" | cut -d' ' -f1)" "${names[$i]}" >> "$sums"
    fi
  done
  sort -k2 -o "$sums" "$sums"
  put "$prefix/$version/SHA256SUMS" "$sums"
  rm -f "$sums"
fi

# The channel directory has to match electron-builder's ${os} macro in the
# publish url, which expands to mac, win and linux (Platform.MAC is
# new Platform("mac", "mac", "darwin"), so it is the build key, not the node
# platform). Writing to darwin/ and windows/ instead is why macOS clients sat on
# 0.12.0 and Windows never had a feed at all. Feeds last: an artifact must exist
# before a feed advertises it.
for os in win mac linux; do
  var="feed_$os"; name="${!var}"
  file=$(find "$root" -type d -name '*.app' -prune -o -type f -name "$name" -print -quit)
  [ -z "$file" ] || put "$prefix/channel/$os/$name" "$file"
done

# Uploading is not publishing. A feed that names a file the bucket does not have
# reports nothing to anyone - the updater 404s in the background and users simply
# never move off the old version. So prove the release over the network before
# calling it done, from here, where there is still someone watching.
echo "publish-r2: verifying the published release"
node "$here/verify-release.js" "$version" "${validation_args[@]}" --full
