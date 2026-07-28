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
# request, and a stale artifact no feed mentions is simply never uploaded.
feeds=()
for spec in "win/latest.yml" "mac/latest-mac.yml" "linux/latest-linux.yml"; do
  file=$(find "$root" -type f -name "${spec#*/}" -print -quit)
  [ -z "$file" ] || feeds+=("$file")
done
if [ ${#feeds[@]} -eq 0 ]; then
  echo "publish-r2: no latest*.yml under $root - nothing to publish" >&2
  exit 1
fi

wanted=$(mktemp)
for file in "${feeds[@]}"; do
  sed -n 's/^[[:space:]]*-[[:space:]]*url:[[:space:]]*//p' "$file" >> "$wanted"
done
sort -u -o "$wanted" "$wanted"

# The name in the feed may not be the name on disk. Try it verbatim, then the
# dotted form GitHub hands back.
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
  # Blockmaps are requested as <url>.blockmap, so they follow the feed's naming
  # too, not the local file's.
  bmap=$(resolve "$url.blockmap")
  [ -z "$bmap" ] || put "desktop/$version/$url.blockmap" "$bmap"
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
  put "desktop/$version/SHA256SUMS" "$sums"
  rm -f "$sums"
fi

# The channel directory has to match electron-builder's ${os} macro in the
# publish url, which expands to mac, win and linux (Platform.MAC is
# new Platform("mac", "mac", "darwin"), so it is the build key, not the node
# platform). Writing to darwin/ and windows/ instead is why macOS clients sat on
# 0.12.0 and Windows never had a feed at all.
for spec in "win/latest.yml" "mac/latest-mac.yml" "linux/latest-linux.yml"; do
  os=${spec%%/*}; name=${spec#*/}; file=$(find "$root" -type f -name "$name" -print -quit)
  [ -z "$file" ] || put "desktop/channel/$os/$name" "$file"
done

# Uploading is not publishing. A feed that names a file the bucket does not have
# reports nothing to anyone - the updater 404s in the background and users simply
# never move off the old version. So prove the release over the network before
# calling it done, from here, where there is still someone watching.
echo "publish-r2: verifying the published release"
node scripts/verify-release.js "$version"
