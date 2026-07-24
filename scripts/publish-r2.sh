#!/usr/bin/env bash
set -euo pipefail
root="${1:-release}"
version="${GITHUB_REF_NAME#v}"
put() { npx wrangler r2 object put "crowe-releases/$1" --file "$2" --remote --config deploy/releases-worker/wrangler.jsonc; }
while IFS= read -r -d '' file; do put "desktop/$version/$(basename "$file")" "$file"; done < <(find "$root" -type f \( -name '*.exe' -o -name '*.dmg' -o -name '*.zip' -o -name '*.deb' -o -name '*.AppImage' \) -print0)
for spec in "windows/latest.yml" "darwin/latest-mac.yml" "linux/latest-linux.yml"; do
  os=${spec%%/*}; name=${spec#*/}; file=$(find "$root" -type f -name "$name" -print -quit)
  [ -z "$file" ] || put "desktop/channel/$os/$name" "$file"
done
