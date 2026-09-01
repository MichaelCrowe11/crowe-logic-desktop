#!/usr/bin/env bash
# Mirrors scripts/publish-r2.sh key-for-key, but uploads with rclone (swmr2:)
# because wrangler's sized PUT dies with "fetch failed" on the >100MB artifacts.
set -euo pipefail
cd /private/tmp/claude-501/-Users-crowelogic/58717804-8e4d-40b8-bd7e-75c479a036a6/scratchpad/desktop-0.24.4
root=release
version=$(node -p "require('./package.json').version")
BUCKET=swmr2:crowe-releases
echo "publish-rclone: publishing $version from $root"

put() {  # key file
  local key="$1" file="$2" attempt=1
  until rclone copyto --s3-storage-class STANDARD --retries 3 "$file" "$BUCKET/$key"; do
    [ "$attempt" -ge 5 ] && { echo "giving up on $key" >&2; return 1; }
    echo "$key failed, retrying ($attempt)" >&2; attempt=$((attempt+1)); sleep $((attempt*5))
  done
  echo "PUT ok: $key"
}

feeds=()
for spec in "win/latest.yml" "mac/latest-mac.yml" "linux/latest-linux.yml"; do
  file=$(find "$root" -type f -name "${spec#*/}" -print -quit)
  [ -z "$file" ] || feeds+=("$file")
done
[ ${#feeds[@]} -eq 0 ] && { echo "no feeds" >&2; exit 1; }

wanted=$(mktemp)
for file in "${feeds[@]}"; do
  sed -n 's/^[[:space:]]*-[[:space:]]*url:[[:space:]]*//p' "$file" >> "$wanted"
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
  put "desktop/$version/$url" "$file"
  installers+=("$file"); names+=("$url")
  bmap=$(resolve "$url.blockmap")
  [ -z "$bmap" ] || put "desktop/$version/$url.blockmap" "$bmap"
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
put "desktop/$version/SHA256SUMS" "$sums"
rm -f "$sums"

# Feeds LAST: an artifact must exist before a feed advertises it.
for spec in "win/latest.yml" "mac/latest-mac.yml" "linux/latest-linux.yml"; do
  os=${spec%%/*}; name=${spec#*/}; file=$(find "$root" -type f -name "$name" -print -quit)
  [ -z "$file" ] || put "desktop/channel/$os/$name" "$file"
done
echo "PUBLISH_UPLOADS_DONE"
