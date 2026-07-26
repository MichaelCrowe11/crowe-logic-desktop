#!/usr/bin/env bash
set -euo pipefail
root="${1:-release}"
# Locally there is no ref, so fall back to the version being built. CI passes
# the tag it was triggered by.
version="${GITHUB_REF_NAME:-}"
version="${version#v}"
if [ -z "$version" ] && [ -f package.json ]; then
  version=$(node -p "require('./package.json').version")
fi

if [ -z "$version" ]; then
  echo "publish-r2: set GITHUB_REF_NAME to a tag such as v0.14.0" >&2
  exit 1
fi
echo "publish-r2: publishing $version from $root"

# Uploads to the R2 API fail intermittently regardless of file size, so a single
# attempt is not enough to get a release out. Observed on a run where a 20 MB
# object failed and a 110 MB object immediately after it succeeded.
put() {
  local key="$1" file="$2" attempt=1
  until npx wrangler r2 object put "crowe-releases/$key" --file "$file" --remote --config deploy/releases-worker/wrangler.jsonc; do
    if [ "$attempt" -ge 5 ]; then
      echo "publish-r2: giving up on $key after $attempt attempts" >&2
      return 1
    fi
    echo "publish-r2: $key failed, retrying ($attempt)" >&2
    attempt=$((attempt + 1))
    sleep $((attempt * 5))
  done
}

# Installers and their blockmaps are stored once per release. The updater asks
# for them relative to the channel prefix; the releases worker maps that back
# onto these keys rather than storing a second copy per channel.
installers=()
while IFS= read -r -d '' file; do
  put "desktop/$version/$(basename "$file")" "$file"
  case "$file" in *.blockmap) ;; *) installers+=("$file") ;; esac
done < <(find "$root" -type f \( -name '*.exe' -o -name '*.dmg' -o -name '*.zip' -o -name '*.deb' -o -name '*.AppImage' -o -name '*.blockmap' \) -print0)

# The download page tells people to run `sha256sum -c SHA256SUMS`, so the file
# has to exist. Names are basenames because that is what lands in a download
# folder, and the artifacts arrive here in per-platform subdirectories.
if [ ${#installers[@]} -gt 0 ]; then
  sums=$(mktemp)
  for file in "${installers[@]}"; do
    if command -v sha256sum >/dev/null; then
      printf '%s  %s\n' "$(sha256sum "$file" | cut -d' ' -f1)" "$(basename "$file")" >> "$sums"
    else
      printf '%s  %s\n' "$(shasum -a 256 "$file" | cut -d' ' -f1)" "$(basename "$file")" >> "$sums"
    fi
  done
  sort -k2 -o "$sums" "$sums"
  put "desktop/$version/SHA256SUMS" "$sums"
  rm -f "$sums"
fi

for spec in "windows/latest.yml" "darwin/latest-mac.yml" "linux/latest-linux.yml"; do
  os=${spec%%/*}; name=${spec#*/}; file=$(find "$root" -type f -name "$name" -print -quit)
  [ -z "$file" ] || put "desktop/channel/$os/$name" "$file"
done
