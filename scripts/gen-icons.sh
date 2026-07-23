#!/usr/bin/env bash
# Builds the full app icon set from the generated mark SVGs.
# Requires: rsvg-convert, ImageMagick (magick), iconutil (macOS).
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/gen-mark.js

A=assets
TMP="$(mktemp -d)"
ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET"

# macOS iconset (squircle tile artwork)
for s in 16 32 128 256 512; do
  rsvg-convert -w "$s" -h "$s" "$A/icon.svg" -o "$ICONSET/icon_${s}x${s}.png"
  d=$((s * 2))
  rsvg-convert -w "$d" -h "$d" "$A/icon.svg" -o "$ICONSET/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$ICONSET" -o "$A/icon.icns"

# Windows ico + Linux png
rsvg-convert -w 1024 -h 1024 "$A/icon.svg" -o "$A/icon.png"
for s in 16 24 32 48 64 128 256; do
  rsvg-convert -w "$s" -h "$s" "$A/icon.svg" -o "$TMP/ico_$s.png"
done
magick "$TMP/ico_256.png" "$TMP/ico_128.png" "$TMP/ico_64.png" "$TMP/ico_48.png" "$TMP/ico_32.png" "$TMP/ico_24.png" "$TMP/ico_16.png" "$A/icon.ico"

# Brand glyphs: avatar (transparent, full mark), mark.png, tray (bold small glyph)
rsvg-convert -w 1024 -h 1024 "$A/mark.svg" -o "$A/avatar.png"
rsvg-convert -w 512 -h 512 "$A/mark.svg" -o "$A/mark.png"
rsvg-convert -w 36 -h 36 "$A/mark-tray.svg" -o "$A/tray.png"

rm -rf "$TMP"
echo "icons written: icon.icns icon.ico icon.png avatar.png mark.png tray.png"
