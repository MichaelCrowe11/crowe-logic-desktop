#!/usr/bin/env node
// Builds mobile/resources — the launch art the native projects are generated
// from — out of the same brand source everything else uses.
//
//   node scripts/gen-mobile-assets.js
//   npx @capacitor/assets generate        # fans resources/ into ios/ and android/
//
// LAUNCH ART ONLY. The app icons used to come through here too, and that is
// where the drift came from: this script composed them correctly and then
// printed an instruction for a human to run @capacitor/assets by hand, and
// nobody ran it after #34 — so the phone and every Android launcher spent two
// brand revisions showing an icon the generator had already moved past. The
// icons are `npm run icons` now, drawn straight from assets/icon-ios.svg and
// assets/icon-android-*.svg by scripts/make-icons.js, and checked by
// `npm run icons:check`.
//
// The icon sources are gone from SOURCES below rather than merely unused, and
// that is deliberate: leaving them would mean the printed command overwrites all
// thirty pipeline-generated mipmaps with a stale hand-run composition, and the
// only thing that would notice is a red icons:check.
//
// Splash art stays because @capacitor/assets is genuinely good at the thing it
// is good at — fanning one image across twenty-five orientation, density and
// night buckets — and a launch screen is not a masked launcher icon.
//
// Composition is pure Node and always runs: the SVGs below are written from
// assets/mark-simple.svg, so the launch screen cannot drift from the mark.
// Rasterizing needs rsvg-convert, the same dependency scripts/gen-icons.sh
// takes for the desktop icons — when it is missing the script says which files
// it could not write and stops short of pretending it did.
//
// @capacitor/assets is deliberately not a dependency of this project. It pulls
// an older Capacitor CLI, sharp, and a vulnerable tar transitively; running it
// through npx keeps that out of the lockfile of an app that ships to a store.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const mobileDir = path.join(__dirname, "..");
const root = path.join(mobileDir, "..");
const assets = path.join(root, "assets");
const out = path.join(mobileDir, "resources");

const CREAM = "#f7f3ea";
const INK = "#16130f";

// The mark's own viewBox, and the fraction of the canvas it should cover.
// A launch screen wants the mark small and centred — big enough to read at
// arm's length, far enough from the edges that a notch never crops it.
const MARK_BOX = { x: 15.93, y: 15.93, w: 88.14, h: 88.14 };

function markBody(file) {
  const svg = fs.readFileSync(path.join(assets, file), "utf8");
  const open = svg.indexOf(">", svg.indexOf("<svg")) + 1;
  const close = svg.lastIndexOf("</svg>");
  return svg.slice(open, close).trim();
}

// A canvas with the mark centred at `scale` of the shorter side. Nested <svg>
// rather than a <use> or a transform: the inner viewBox does the arithmetic,
// so the mark stays centred whatever size the outer canvas is asked for.
function compose({ size, background, mark, scale }) {
  const side = Math.round(size * scale);
  const offset = Math.round((size - side) / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
${background ? `  <rect width="${size}" height="${size}" fill="${background}"/>\n` : ""}  <svg x="${offset}" y="${offset}" width="${side}" height="${side}" viewBox="${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.w} ${MARK_BOX.h}">
${markBody(mark).replace(/^/gm, "    ")}
  </svg>
</svg>
`;
}

const SOURCES = [
  // [file, contents]
  ["splash.svg", () => compose({ size: 2732, background: CREAM, mark: "mark-simple.svg", scale: 0.17 })],
  ["splash-dark.svg", () => compose({ size: 2732, background: INK, mark: "mark-simple-dark.svg", scale: 0.17 })],
];

// [svg, png, pixel size]
const RASTERS = [
  ["splash.svg", "splash.png", 2732],
  ["splash-dark.svg", "splash-dark.png", 2732],
];

function haveRsvg() {
  try { execFileSync("rsvg-convert", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

function main() {
  fs.mkdirSync(out, { recursive: true });

  for (const [name, build] of SOURCES) fs.writeFileSync(path.join(out, name), build());

  const wrote = [...SOURCES.map(([n]) => n)];
  if (haveRsvg()) {
    for (const [svg, png, size] of RASTERS) {
      execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), path.join(out, svg), "-o", path.join(out, png)]);
      wrote.push(png);
    }
  }

  console.log(`resources/: ${wrote.join(" ")}`);
  if (!haveRsvg()) {
    console.log("\nrsvg-convert is not installed, so the PNGs were not rasterized.");
    console.log("  macOS: brew install librsvg     Debian/Ubuntu: apt install librsvg2-bin");
    console.log("The launch screen falls back to a flat brand colour.");
  }
  console.log("\nNext: npx @capacitor/assets generate \\\n        --splashBackgroundColor '#f7f3ea' --splashBackgroundColorDark '#16130f'");
  console.log("\nThat command touches the splash art only, because resources/ now holds only");
  console.log("splashes. The launcher icons are `npm run icons`; if a stale icon.png ever");
  console.log("reappears in resources/, delete it rather than letting that command place it.");
}

main();
