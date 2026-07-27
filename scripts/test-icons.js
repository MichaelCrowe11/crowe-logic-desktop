// Guards the app icon against the failure that shipped in 0.14.0 and earlier:
// assets/icon.icns, .ico and .png had been produced outside the brand pipeline,
// so they were a hard-edged opaque square with the mark at 26% of the canvas.
// In the Dock that reads as a black tile, and at 32px it is an unrecognizable
// smudge. gen-mark.js was drawing a correct icon.svg the whole time; nothing
// ever rasterized it.
//
// These checks decode the real files, so they fail if someone hand-edits an
// icon or forgets to re-run `npm run icons` after changing the mark.
//
// Usage: npx electron scripts/test-icons.js

const fs = require("fs");
const path = require("path");
const { app, nativeImage } = require("electron");

const ASSETS = path.join(__dirname, "..", "assets");
let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`ok      ${name}`);
  } catch (err) {
    fail++;
    console.log(`FAIL    ${name}\n        ${err.message}`);
  }
}

// Measures two things at a given render size: the extent of the drawn tile
// (alpha) and the extent of the brand mark inside it (chroma). Alpha alone
// cannot catch a mark that is too small, because a fully opaque square trivially
// covers the whole canvas, which is exactly what the old art did.
function probe(image, size) {
  const resized = image.resize({ width: size, height: size, quality: "best" });
  const { width, height } = resized.getSize();
  const bmp = resized.toBitmap(); // BGRA, 4 bytes per pixel
  const at = (x, y) => bmp[(y * width + x) * 4 + 3];

  const span = { minX: width, maxX: -1 };
  const mark = { minX: width, maxX: -1 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [b, g, r, a] = [bmp[i], bmp[i + 1], bmp[i + 2], bmp[i + 3]];
      if (a <= 8) continue;
      if (x < span.minX) span.minX = x;
      if (x > span.maxX) span.maxX = x;
      // The tile is a dark near-neutral navy (peak channel < ~60, chroma ~32).
      // The mark is cream hyphae plus a gold spore: the cream is bright but
      // unsaturated, the gold saturated — so a mark pixel is either high
      // chroma or bright. The rim highlight is 14% white over the dark tile
      // and stays well under both thresholds.
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (chroma > 70 || Math.max(r, g, b) > 150) {
        if (x < mark.minX) mark.minX = x;
        if (x > mark.maxX) mark.maxX = x;
      }
    }
  }
  const width_of = (s) => (s.maxX < 0 ? 0 : (s.maxX - s.minX + 1) / width);
  return {
    width,
    corners: [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)],
    center: at(width >> 1, height >> 1),
    tile: width_of(span),
    mark: width_of(mark),
  };
}

// The chunk types iconutil emits for a complete iconset, and the pixel size each
// one represents. The two smallest are ARGB rather than PNG, which is why this
// checks types instead of just scanning for PNG payloads.
const ICNS_LADDER = {
  ic04: 16, ic05: 32, ic11: 32, ic12: 64, ic07: 128,
  ic13: 256, ic08: 256, ic14: 512, ic09: 512, ic10: 1024,
};

// Minimal ICNS reader: 'icns', big-endian total length, then typed chunks whose
// length field includes the 8-byte header.
function readIcns(file) {
  const d = fs.readFileSync(file);
  if (d.toString("ascii", 0, 4) !== "icns") throw new Error(`${file} is not an ICNS container`);
  const total = d.readUInt32BE(4);
  const types = new Set();
  const pngs = new Map();
  let off = 8;
  while (off + 8 <= Math.min(total, d.length)) {
    const type = d.toString("ascii", off, off + 4);
    const len = d.readUInt32BE(off + 4);
    if (len < 8 || off + len > d.length) break;
    const blob = d.subarray(off + 8, off + len);
    types.add(type);
    if (blob.length > 24 && blob.readUInt32BE(0) === 0x89504e47) pngs.set(blob.readUInt32BE(16), blob);
    off += len;
  }
  return { types, pngs };
}

function main() {
  const svg = fs.readFileSync(path.join(ASSETS, "icon.svg"), "utf8");

  check("the vector source is drawn on the Big Sur grid", () => {
    // An 824px tile centered in 1024 is what leaves the corners transparent.
    const tile = svg.match(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" rx="(\d+)"/);
    if (!tile) throw new Error("no tile rect in icon.svg");
    const [, x, y, w, h, rx] = tile.map(Number);
    if (w !== h) throw new Error(`tile is not square: ${w}x${h}`);
    if (x !== (1024 - w) / 2 || y !== (1024 - h) / 2) throw new Error(`tile is not centered: ${x},${y}`);
    if (w / 1024 < 0.78 || w / 1024 > 0.83) throw new Error(`tile is ${((w / 1024) * 100).toFixed(0)}% of canvas, want ~80%`);
    if (rx < w * 0.2 || rx > w * 0.25) throw new Error(`corner radius ${rx} is off the Big Sur proportion`);
  });

  const icns = readIcns(path.join(ASSETS, "icon.icns"));

  check("icon.icns carries the full macOS size ladder", () => {
    const missing = Object.entries(ICNS_LADDER)
      .filter(([type]) => !icns.types.has(type))
      .map(([type, px]) => `${type} (${px}px)`);
    if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
  });

  const subjects = [
    ["icon.png", nativeImage.createFromPath(path.join(ASSETS, "icon.png"))],
    // nativeImage cannot open .icns, so probe the largest image inside it.
    ["icon.icns", nativeImage.createFromBuffer(icns.pngs.get(Math.max(...icns.pngs.keys())))],
  ];

  for (const [file, image] of subjects) {
    check(`${file} decodes`, () => {
      if (image.isEmpty()) throw new Error("decoded to an empty image");
    });
    if (image.isEmpty()) continue;

    check(`${file} has transparent corners, not a hard square`, () => {
      const { corners } = probe(image, 256);
      const opaque = corners.filter((a) => a > 8);
      if (opaque.length) throw new Error(`${opaque.length} of 4 corners are opaque (alpha ${corners.join(", ")})`);
    });

    check(`${file} draws a rounded tile on the Big Sur grid`, () => {
      const { tile } = probe(image, 256);
      // ~80% is the grid. Materially less is a floating stamp; 100% is the hard
      // square the old art shipped as.
      if (tile < 0.74 || tile > 0.88) {
        throw new Error(`tile spans ${(tile * 100).toFixed(0)}% of the canvas, want ~80%`);
      }
    });

    check(`${file} shows the mark at a legible size`, () => {
      const { mark } = probe(image, 256);
      // The old art put the mark at 26% of the canvas. The grid puts it near 47%.
      if (mark < 0.4) throw new Error(`mark spans ${(mark * 100).toFixed(0)}% of the canvas, want ~47%`);
    });

    check(`${file} still reads at 32px`, () => {
      const { center, mark } = probe(image, 32);
      if (center <= 8) throw new Error("center pixel is transparent at 32px");
      if (mark < 0.35) throw new Error(`mark spans only ${(mark * 100).toFixed(0)}% at 32px`);
    });
  }

  check("icon.ico is a valid multi-size PNG icon directory", () => {
    const d = fs.readFileSync(path.join(ASSETS, "icon.ico"));
    if (d.readUInt16LE(0) !== 0 || d.readUInt16LE(2) !== 1) throw new Error("not an ICO header");
    const count = d.readUInt16LE(4);
    const sizes = [];
    for (let i = 0; i < count; i++) {
      const e = 6 + i * 16;
      const size = d.readUInt8(e) || 256;
      const len = d.readUInt32LE(e + 8);
      const off = d.readUInt32LE(e + 12);
      if (off + len > d.length) throw new Error(`entry ${size} runs past end of file`);
      const blob = d.subarray(off, off + len);
      if (blob.readUInt32BE(0) !== 0x89504e47) throw new Error(`entry ${size} is not PNG encoded`);
      if (blob.readUInt32BE(16) !== size) throw new Error(`entry ${size} actually contains ${blob.readUInt32BE(16)}px`);
      sizes.push(size);
    }
    for (const want of [16, 32, 256]) {
      if (!sizes.includes(want)) throw new Error(`missing the ${want}px entry Windows asks for`);
    }
  });

  check("the window icon is a format Windows and Linux can decode", () => {
    // .icns is macOS-only; Electron silently falls back to its default icon.
    const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    const m = main.match(/icon:\s*path\.join\(__dirname,\s*"assets",\s*"([^"]+)"\)/);
    if (!m) throw new Error("no BrowserWindow icon found in main.js");
    if (!/\.(png|ico)$/.test(m[1])) throw new Error(`BrowserWindow icon is ${m[1]}`);
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});
