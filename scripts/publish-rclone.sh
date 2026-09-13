#!/usr/bin/env bash
# Mirrors scripts/publish-r2.sh key-for-key, but uploads with rclone (swmr2:)
# because wrangler's sized PUT dies with "fetch failed" on the >100MB artifacts.
#
#   scripts/publish-rclone.sh                                          # release/, latest
#   scripts/publish-rclone.sh --config electron-builder.developer.js   # release-developers/, developers
#   DRY_RUN=1 scripts/publish-rclone.sh ...                            # preflight only
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
resolved=$(node "$repo/scripts/release-channel.js" --shell "$@") || exit 1
eval "$resolved"
root=$(cd "${root:-$repo/$dir}" && pwd)
cd "$repo"
version=$(node -p "require('./package.json').version")
node scripts/preflight-release.js "$root" "$version" --channel "$channel"
if [ "${DRY_RUN:-0}" = 1 ]; then
  echo "publish-rclone: dry run passed for the $channel channel; nothing uploaded"
  exit 0
fi
BUCKET=swmr2:crowe-releases
echo "publish-rclone: publishing $version from $root to the $channel channel ($prefix/)"

put() {  # key file
  local key="$1" file="$2" attempt=1
  until rclone copyto --s3-storage-class STANDARD --retries 3 "$file" "$BUCKET/$key"; do
    [ "$attempt" -ge 5 ] && { echo "giving up on $key" >&2; return 1; }
    echo "$key failed, retrying ($attempt)" >&2; attempt=$((attempt+1)); sleep $((attempt*5))
  done
  echo "PUT ok: $key"
}

feeds=()
for os in win mac linux; do
  var="feed_$os"; name="${!var}"
  file=$(find "$root" -type f -name "$name" -print -quit)
  [ -z "$file" ] || feeds+=("$file")
done
[ ${#feeds[@]} -eq 0 ] && { echo "no $channel feeds under $root" >&2; exit 1; }

wanted=$(mktemp)
for file in "${feeds[@]}"; do
  node -e 'const fs=require("fs"),yaml=require("js-yaml"); for(const f of yaml.load(fs.readFileSync(process.argv[1],"utf8")).files) console.log(f.url)' "$file" >> "$wanted"
done
sort -u -o "$wanted" "$wanted"

resolve() {
  local want="$1" hit
  hit=$(find "$root" -type f -name "$want" -print -quit)
  [ -n "$hit" ] || hit=$(find "$root" -type f -name "${want// /.}" -print -quit)
  printf '%s' "$hit"
}

installers=() names=() missing=()
while IFS= read -r url; do
  [ -n "$url" ] || continue
  file=$(resolve "$url")
  if [ -z "$file" ]; then missing+=("$url"); continue; fi
  put "$prefix/$version/$url" "$file"
  installers+=("$file"); names+=("$url")
  bmap=$(resolve "$url.blockmap")
  [ -z "$bmap" ] || put "$prefix/$version/$url.blockmap" "$bmap"
done < "$wanted"
rm -f "$wanted"

if [ ${#missing[@]} -gt 0 ]; then
  echo "named in a feed but absent:"; printf '  %s\n' "${missing[@]}"; exit 1
fi

sums=$(mktemp)
for i in "${!installers[@]}"; do
  printf '%s  %s\n' "$(shasum -a 256 "${installers[$i]}" | cut -d' ' -f1)" "${names[$i]}" >> "$sums"
done
sort -k2 -o "$sums" "$sums"
cat "$sums"
put "$prefix/$version/SHA256SUMS" "$sums"
rm -f "$sums"

# Feeds LAST: an artifact must exist before a feed advertises it.
for os in win mac linux; do
  var="feed_$os"; name="${!var}"
  file=$(find "$root" -type f -name "$name" -print -quit)
  [ -z "$file" ] || put "$prefix/channel/$os/$name" "$file"
done
echo "PUBLISH_UPLOADS_DONE"
node scripts/verify-release.js "$version" --channel "$channel"
