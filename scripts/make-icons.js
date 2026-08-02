// Rasterizes assets/icon.svg into the icon files electron-builder ships.
//
// gen-mark.js draws icon.svg on the Big Sur grid (an 824px rounded tile
// centered in a 1024px canvas, so the corners stay transparent), but it stopped
// at the vector. The .icns/.ico/.png that were actually being packaged had been
// made some other way: a hard-edged opaque square with the mark at 26% of the
// canvas, which reads as a black tile in the Dock and as a smudge at 32px.
// This script closes that gap so the rasters cannot drift from the brand source.
//
// Chromium does the rasterizing, so there is no image dependency to install. The
// SVG is re-rendered at each target size rather than downsampled from 1024, so
// small sizes stay crisp.
//
//   npx electron scripts/make-icons.js             rasterize
//   npx electron scripts/make-icons.js --check     fail if a raster is stale
//
// --check is the half of `npm run icons:check` that catches the bug this whole
// pipeline exists for. scripts/test-icons.js claimed for two releases that it
// failed when someone forgot to re-run `npm run icons`, and it does not: every
// assertion it makes is a property of the DRAWING — corner alpha, tile extent,
// mark extent, the macOS ladder, ICO directory validity — and those are all
// invariant across brand revisions, so a render from an older run of this very
// script satisfies every one of them. It reported 14/14 on the stale rasters
// #44 then had to fix by hand.
//
// Re-rendering and comparing is the only question staleness answers differently:
// not "is this the right kind of picture" but "is this the picture today's
// vectors draw". Both halves are needed — replaying #44 showed the SVGs were
// all correct and only the rasters were stale, so the vector check in
// gen-mark.js would have been green on its own.
//
// Usage: npx electron scripts/make-icons.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const { app, BrowserWindow, nativeImage } = require("electron");

const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");
const SRC = path.join(ASSETS, "icon.svg");
const CHECK = process.argv.includes("--check");

// macOS wants the full Big Sur ladder; .ico covers the Windows shell sizes.
const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// What --check can compare inside the .icns. iconutil emits the 16px rung as
// ARGB (ic04) rather than PNG, so there is no 16px image in there to decode;
// that rung's presence is asserted by the ladder check in test-icons.js instead.
const ICNS_PNG_SIZES = ICNS_SIZES.filter((s) => s >= 32);
const ICNS_NAMES = {
  16: ["icon_16x16.png"],
  32: ["icon_16x16@2x.png", "icon_32x32.png"],
  64: ["icon_32x32@2x.png"],
  128: ["icon_128x128.png"],
  256: ["icon_128x128@2x.png", "icon_256x256.png"],
  512: ["icon_256x256@2x.png", "icon_512x512.png"],
  1024: ["icon_512x512@2x.png"],
};

// ── The write funnel ────────────────────────────────────────────────────────
// Every raster this script produces goes through put(). That is the whole
// coverage mechanism: there is no inventory of checked files to forget to
// extend, because the only way to write one is to hand it to the comparator.
// The day something writes the Play Store listing icon, it is checked.
const rel = (p) => path.relative(ROOT, p);
const touched = [];   // every path the funnel saw, written or compared
const stale = [];     // pixels differ from what the vectors draw now
const reencoded = []; // same picture, different bytes — see compare() below

function put(file, buf, note) {
  touched.push(rel(file));
  if (CHECK) { compare(file, buf); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log(`wrote ${rel(file)}${note ? ` (${note})` : ""}`);
}

function bitmap(buf, what) {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) throw new Error(`${what} did not decode as an image`);
  const { width, height } = img.getSize();
  return { width, height, bmp: img.toBitmap() };
}
const sameImage = (a, b) => a.width === b.width && a.height === b.height && a.bmp.equals(b.bmp);

// Bytes first, pixels second, and that order is the whole portability story.
//
// A byte match is proof and costs nothing, so a clean tree never decodes
// anything. A byte mismatch is not proof of staleness: PNG bytes depend on the
// encoder, and this file's output crosses two of them (Chromium's canvas for
// the RGBA rasters, our own zlib for the opaque ones). If the pixels agree, the
// committed file IS the picture today's vectors draw and only its packing is
// from another machine — passing that with a printed note is what lets the
// check run on a Linux CI box against art rendered on a Mac.
//
// The concession is real and worth stating: bytes may lag the current encoder
// indefinitely without anything going red. It is acceptable only because the
// image itself is verified exact — a stale raster can be pixel-identical to a
// fresh one only if the vector change did not alter the drawing at all, which
// is not drift that matters.
// PNG colour type, or null for anything that is not a PNG. Byte 25 of the
// signature+IHDR prologue, which is fixed-position in every PNG.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const colourType = (b) => (b.length > 25 && b.subarray(0, 8).equals(PNG_SIG) ? b[25] : null);

function compare(file, fresh) {
  const name = rel(file);
  if (!fs.existsSync(file)) { stale.push(`${name} (missing)`); return; }
  const current = fs.readFileSync(file);
  if (current.equals(fresh)) return;
  let a, b;
  try {
    a = bitmap(current, name);
    b = bitmap(fresh, `the fresh render of ${name}`);
  } catch (err) {
    stale.push(`${name} (${err.message})`);
    return;
  }
  if (!sameImage(a, b)) {
    stale.push(`${name} (${a.width}x${a.height} committed, ${b.width}x${b.height} fresh)`);
    return;
  }
  // Same picture, but "same picture" is not the whole contract for every target.
  //
  // The pixel comparison above is deliberately blind to encoding, which is what
  // lets a Mac-rendered raster pass on a Linux runner. For the iOS app icon that
  // blindness is a hole big enough to fail an upload through: an RGBA encoding
  // with alpha=255 everywhere decodes to bitmap-identical pixels, so it passes
  // as "re-encoded", and App Store Connect rejects it as ITMS-90717 (an icon
  // carrying an alpha channel). renderOpaque asserts opacity at GENERATION time
  // and emits colour type 2, but nothing was checking what is actually
  // committed — so a hand-edit, a lossless optimiser pass, or a tool that
  // helpfully "fixed" the file could put alpha back and every check stayed green.
  //
  // Comparing the colour type against the fresh render closes it without
  // hardcoding which files are opaque: the generator already encodes each target
  // the way that target requires, so the fresh render is the specification.
  const ca = colourType(current), cb = colourType(fresh);
  if (ca !== null && cb !== null && ca !== cb) {
    stale.push(`${name} (PNG colour type ${ca} committed, ${cb} fresh${cb === 2 ? " — an alpha channel here is an App Store rejection" : ""})`);
    return;
  }
  reencoded.push(name);
}

// The containers are checked by their contents, never by their bytes.
//
// .icns cannot be byte-compared at all. iconutil re-encodes every PNG it is
// handed — measured: 99,781 bytes at the 1024 rung where the input was 159,091
// — while leaving the bitmaps alone, so a fresh .icns and the committed one
// disagree on bytes and agree on pixels at every rung. And iconutil is
// macOS-only, so building one in order to compare would make this check skip on
// the Linux runner, which is the silent hole that lets stale art through in the
// first place.
//
// So --check cracks the committed container open and compares each PNG rung
// against the render already sitting in `png`. No macOS tooling, identical
// behaviour on both platforms, and a stricter question than the bytes: it asks
// whether the picture Windows and macOS will actually show is the one today's
// vectors draw. The two smallest .icns rungs are ARGB rather than PNG and stay
// covered by the ladder assertion in scripts/test-icons.js.
function checkContainer(file, embedded, png, want) {
  const name = rel(file);
  touched.push(name);
  if (!fs.existsSync(file)) { stale.push(`${name} (missing)`); return; }
  const held = embedded(fs.readFileSync(file));
  for (const size of want) {
    const blob = held.get(size);
    if (!blob) { stale.push(`${name} (no ${size}px entry)`); continue; }
    if (blob.equals(png.get(size))) continue;
    try {
      if (sameImage(bitmap(blob, `${name} @${size}`), bitmap(png.get(size), `the fresh ${size}px render`))) {
        reencoded.push(`${name} @${size}px`);
      } else {
        stale.push(`${name} (the ${size}px entry is not what icon.svg draws)`);
      }
    } catch (err) {
      stale.push(`${name} @${size}px (${err.message})`);
    }
  }
}

// The PNG rungs inside an ICO directory, keyed by pixel size.
function icoPngs(d) {
  const out = new Map();
  if (d.readUInt16LE(0) !== 0 || d.readUInt16LE(2) !== 1) throw new Error("not an ICO header");
  const count = d.readUInt16LE(4);
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const len = d.readUInt32LE(e + 8), off = d.readUInt32LE(e + 12);
    if (off + len > d.length) continue;
    const blob = d.subarray(off, off + len);
    if (blob.length > 24 && blob.readUInt32BE(0) === 0x89504e47) out.set(blob.readUInt32BE(16), blob);
  }
  return out;
}

// The PNG rungs inside an ICNS container: 'icns', big-endian total length, then
// typed chunks whose length field includes the 8-byte header.
function icnsPngs(d) {
  const out = new Map();
  if (d.toString("ascii", 0, 4) !== "icns") throw new Error("not an ICNS container");
  const total = d.readUInt32BE(4);
  let off = 8;
  while (off + 8 <= Math.min(total, d.length)) {
    const len = d.readUInt32BE(off + 4);
    if (len < 8 || off + len > d.length) break;
    const blob = d.subarray(off + 8, off + len);
    if (blob.length > 24 && blob.readUInt32BE(0) === 0x89504e47) out.set(blob.readUInt32BE(16), blob);
    off += len;
  }
  return out;
}

function svgAt(src, size) {
  const svg = fs.readFileSync(src, "utf8");
  // Give the root an intrinsic size so Chromium rasterizes at the target
  // resolution instead of rendering once and scaling a bitmap.
  return svg.replace(/<svg\b/, `<svg width="${size}" height="${size}"`);
}

async function render(win, src, size) {
  const b64 = Buffer.from(svgAt(src, size), "utf8").toString("base64");
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = "data:image/svg+xml;base64,${b64}";
    await img.decode();
    const c = document.createElement("canvas");
    c.width = ${size}; c.height = ${size};
    const g = c.getContext("2d");
    g.clearRect(0, 0, ${size}, ${size});
    g.drawImage(img, 0, 0, ${size}, ${size});
    return c.toDataURL("image/png");
  })()`);
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

// Non-square rasteriser for the wide assets (lockup, wordmark), sized off the
// SVG's own viewBox so the PNG cannot come out a different shape than the vector.
//
// This used to compose the lockup on a canvas: draw mark.svg, register the
// bundled woff2 via FontFace, then fillText("Crowe Logic"). That made the PNG
// and the SVG two independent drawings of the same logo, and they drifted the
// moment the SVG switched to outlines — the vector carries opsz 144 while the
// bundled subset is pinned at opsz 9, so the two disagreed on letterforms.
// The SVG is the single source now; this only rasterizes it.
async function renderWide(win, src, height) {
  const svg = fs.readFileSync(src, "utf8");
  const vb = svg.match(/viewBox="([-\d.]+)\s+([-\d.]+)\s+([\d.]+)\s+([\d.]+)"/);
  if (!vb) throw new Error(`${path.basename(src)} has no viewBox to size from`);
  const width = Math.round((Number(vb[3]) / Number(vb[4])) * height);
  const b64 = Buffer.from(
    svg.replace(/<svg\b/, `<svg width="${width}" height="${height}"`), "utf8").toString("base64");
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = "data:image/svg+xml;base64,${b64}";
    await img.decode();
    const c = document.createElement("canvas");
    c.width = ${width}; c.height = ${height};
    const g = c.getContext("2d");
    g.clearRect(0, 0, ${width}, ${height});
    g.drawImage(img, 0, 0, ${width}, ${height});
    return c.toDataURL("image/png");
  })()`);
  return { png: Buffer.from(dataUrl.split(",")[1], "base64"), width };
}

// The two layers that must carry no alpha channel, which cannot go through
// render() above.
//
// App Store Connect rejects an app icon that carries an alpha channel, and a
// canvas toDataURL("image/png") is always RGBA — Chromium has no way to emit a
// truecolour PNG. So this pulls the raw pixels back instead of a PNG, drops the
// alpha byte, and encodes colour type 2 here. Compositing over an opaque
// backdrop first is what keeps that drop lossless: icon-ios.svg paints its own
// full-bleed background, so every pixel is already opaque and discarding the
// channel changes nothing about the image.
//
// Android's adaptive background layer wants the same treatment for a different
// reason, which is why the assertion below names its source rather than iOS.
// That layer slides under the launcher's mask during the parallax, so a hole in
// it shows the user's wallpaper through the middle of the icon — "opaque or
// throw" is exactly the invariant it has to hold, and holding it at build time
// beats discovering it on one OEM's launcher.
//
// Doing it in-process rather than shelling out to sips or ImageMagick keeps the
// promise the header makes: no image dependency to install, same output on any
// machine that can run Electron.
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodeRgbPng(rgba, size) {
  // Filter byte 0 (None) per scanline. The artwork is a smooth gradient behind
  // flat shapes, so the fancier filters buy little and cost correctness risk.
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4, d = y * stride + 1 + x * 3;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type 2 = truecolour, no alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
async function renderOpaque(win, src, size) {
  const b64 = Buffer.from(svgAt(src, size), "utf8").toString("base64");
  const px = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = "data:image/svg+xml;base64,${b64}";
    await img.decode();
    const c = document.createElement("canvas");
    c.width = ${size}; c.height = ${size};
    const g = c.getContext("2d", { alpha: false });
    g.drawImage(img, 0, 0, ${size}, ${size});
    return Array.from(g.getImageData(0, 0, ${size}, ${size}).data);
  })()`);
  const rgba = Buffer.from(px);
  // Cheap assertion rather than a silent bad upload: if the SVG ever stops
  // painting its own background, this catches it here instead of at review.
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      throw new Error(`${path.basename(src)} produced a transparent pixel at ${size}px. ` +
        "It feeds a target that must carry no alpha channel — the iOS icon (App Store " +
        "Connect rejects one) or Android's adaptive background (the launcher parallaxes " +
        "it under the mask and a hole shows the wallpaper). Give that SVG a full-bleed " +
        "background rect.");
    }
  }
  return encodeRgbPng(rgba, size);
}

// ICO with PNG-compressed entries (supported since Windows Vista), which keeps
// the 256px entry from bloating the file the way a raw BMP would.
function buildIco(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const table = [];
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256 in the ICO header
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    table.push(e);
    offset += png.length;
  }
  return Buffer.concat([dir, ...table, ...entries.map((e) => e.png)]);
}

async function main() {
  if (!fs.existsSync(SRC)) throw new Error(`missing ${SRC}, run scripts/gen-mark.js first`);

  const win = new BrowserWindow({ show: false, width: 64, height: 64 });
  await win.loadURL("data:text/html,<!doctype html><meta charset=utf-8><title>icons</title>");

  const sizes = [...new Set([...ICNS_SIZES, ...ICO_SIZES])].sort((a, b) => a - b);
  const png = new Map();
  for (const size of sizes) png.set(size, await render(win, SRC, size));

  put(path.join(ASSETS, "icon.png"), png.get(1024), "1024");

  // tray.png and mark.png had no generator at all, so they kept showing the
  // retired cube after the mark changed. They come off the same vectors now.
  // The tray source is oversized: main.js resizes it to 18px, and downsampling
  // a 44px render beats upscaling an 18px one on a Retina menu bar.
  for (const [out, src, size] of [
    ["tray.png", "mark-tray.svg", 44],
    ["tray-light.png", "mark-tray-light.svg", 44],
    ["mark.png", "mark.svg", 512],
  ]) {
    put(path.join(ASSETS, out), await render(win, path.join(ASSETS, src), size), `${size}, from ${src}`);
  }

  // Wide renders, straight off the vectors. Loading an SVG as an <img> cannot
  // fetch an external font, which is why these once had to be re-typeset on a
  // canvas — but gen-wordmark.py bakes "Crowe Logic" to outlines, so there is
  // no font left to resolve and the raster matches the vector exactly.
  for (const [out, src, height] of [
    ["lockup.png", "lockup.svg", 240],
    ["lockup-dark.png", "lockup-dark.svg", 240],
    ["wordmark.png", "wordmark.svg", 240],
    ["wordmark-dark.png", "wordmark-dark.svg", 240],
  ]) {
    const wide = await renderWide(win, path.join(ASSETS, src), height);
    put(path.join(ASSETS, out), wide.png, `${wide.width}x${height}, from ${src}`);
  }

  const ICO = path.join(ASSETS, "icon.ico");
  if (CHECK) checkContainer(ICO, icoPngs, png, ICO_SIZES);
  else put(ICO, buildIco(ICO_SIZES.map((size) => ({ size, png: png.get(size) }))), ICO_SIZES.join(", "));

  // The native projects are committed, but this script has to keep working in a
  // checkout that does not have them, so the two blocks below are guarded.
  //
  // A guard is a hole in --check mode, which is why it is on the project root
  // and nothing finer. Once mobile/ios/App or mobile/android/app exists, every
  // path underneath it is mandatory: delete mipmap-ldpi/ and the funnel reports
  // four missing files rather than quietly checking twenty instead of
  // twenty-four. The path count in the summary is the other half of that — a
  // coverage drop is a number that moved, not a silence.
  const iosProject = path.join(ROOT, "mobile", "ios", "App");
  const androidRes = path.join(ROOT, "mobile", "android", "app", "src", "main", "res");
  const skipped = [];

  // The phone. Until now this file was placed by hand and never regenerated, so
  // it froze at the mark as it stood in #34 while the desktop rasters moved
  // twice — the same drift this script was written to end, just one directory
  // further out. Xcode's modern appiconset takes a single 1024 and derives the
  // rest, so there is one file to write.
  if (fs.existsSync(iosProject)) {
    put(path.join(iosProject, "App", "Assets.xcassets", "AppIcon.appiconset", "AppIcon-512@2x.png"),
      await renderOpaque(win, path.join(ASSETS, "icon-ios.svg"), 1024),
      "1024, opaque, no alpha");
  } else skipped.push("mobile/ios");

  // Android's launcher icons, which came off @capacitor/assets by hand until
  // now and had not been re-run since #34 — the same commit that hand-placed the
  // iOS icon, and the same two brand revisions behind. Two ladders, because an
  // adaptive layer is 108dp and a legacy icon is 48dp; the layers were being
  // written at the 48dp ladder with a 16.7% inset in the anydpi XML papering
  // over the difference, which threw away a third of the resolution (18 pixels
  // of artwork at ldpi) on top of drawing the mark too small. Emitting true
  // 108dp assets and deleting that inset fixes both in one move — and the two
  // halves have to land together, because 108dp art under the old inset renders
  // at 44% of where it belongs and 48dp art without it renders at 150% and gets
  // its edges cut.
  const ADAPTIVE = { ldpi: 81, mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
  const LEGACY = { ldpi: 36, mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  // Which renderer a layer takes is not a style choice, and getting it backwards
  // is loud in one direction and silent in the other: renderOpaque on the
  // foreground throws on its first transparent pixel, while render() on the
  // background writes an RGBA PNG that looks identical everywhere except under
  // a launcher's parallax on a real device.
  const ANDROID = [
    ["ic_launcher_background.png", "icon-android-background.svg", ADAPTIVE, renderOpaque],
    ["ic_launcher_foreground.png", "icon-android-foreground.svg", ADAPTIVE, render],
    ["ic_launcher_monochrome.png", "icon-android-mono.svg", ADAPTIVE, render],
    ["ic_launcher.png", "icon-android-legacy.svg", LEGACY, render],
    ["ic_launcher_round.png", "icon-android-round.svg", LEGACY, render],
  ];
  if (fs.existsSync(androidRes)) {
    for (const [out, src, ladder, draw] of ANDROID) {
      for (const [bucket, size] of Object.entries(ladder)) {
        put(path.join(androidRes, `mipmap-${bucket}`, out),
          await draw(win, path.join(ASSETS, src), size), `${size}, from ${src}`);
      }
    }
  } else skipped.push("mobile/android");

  const ICNS = path.join(ASSETS, "icon.icns");
  if (CHECK) {
    // Deliberately not built here — see checkContainer above for why running
    // iconutil in --check mode would both lie about the bytes and skip on Linux.
    checkContainer(ICNS, icnsPngs, png, ICNS_PNG_SIZES);
  } else if (process.platform === "darwin") {
    const iconset = fs.mkdtempSync(path.join(os.tmpdir(), "croweicon-")) + "/icon.iconset";
    fs.mkdirSync(iconset, { recursive: true });
    for (const size of ICNS_SIZES) {
      for (const name of ICNS_NAMES[size]) fs.writeFileSync(path.join(iconset, name), png.get(size));
    }
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", ICNS]);
    fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
    touched.push(rel(ICNS));
    console.log(`wrote ${rel(ICNS)} (${ICNS_SIZES.join(", ")})`);
  } else {
    // iconutil is macOS-only. The committed .icns stays valid; only a mac can
    // refresh it — but --check above reads it on every platform, so Linux is
    // still holding it to the vectors.
    console.log("skipped assets/icon.icns (iconutil needs macOS)");
  }

  win.destroy();

  if (!CHECK) return 0;
  for (const name of reencoded) {
    console.log(`ok      ${name} — same picture, different bytes (another encoder wrote it)`);
  }
  // A skip is fine when generating — a checkout without mobile/ still wants its
  // desktop icons — but in --check mode a skip is the failure this whole file
  // exists to prevent, one level up. Renaming mobile/android/app/src/main/res
  // dropped 30 of 41 files from coverage and the run still exited 0, printing a
  // note nobody reads in CI. The check would then be green precisely because it
  // had stopped looking, which is how test-icons.js got to 14/14 on stale art.
  for (const name of skipped) {
    if (CHECK) stale.push(`${name} is missing from this checkout, so its icons went unchecked — a check that stops looking is not a passing check`);
    else console.log(`note    ${name} is not in this checkout, so its icons were not checked`);
  }
  if (stale.length) {
    console.error(`\n${stale.length} of ${touched.length} committed raster${stale.length > 1 ? "s are" : " is"} not what the vectors draw:`);
    for (const name of stale) console.error(`  ${name}`);
    console.error("\nRun `npm run icons` and commit the result.");
    // Said out loud because otherwise this reads as a mysterious CI failure and
    // gets deleted, which is how the repo ends up back where it started.
    console.error("If you did not touch the mark: `electron` is a caret range, and a Chromium");
    console.error("bump changes what the canvas rasterizes. Regenerating and committing is the");
    console.error("right fix there too — the shipped art should be what today's renderer draws.");
    return 1;
  }
  console.log(`\nchecked ${touched.length} committed rasters against the vectors; all current.`);
  return 0;
}

// The exit code is main's return value rather than an app.exit() inside it.
// Calling app.exit(1) from the middle of the promise chain does not stop the
// chain, so the app.exit(0) below landed on top of it and a --check run that had
// just printed a stale-file list exited 0 — a drift check that reports failure
// and then tells CI it passed. Caught by actually watching it go red.
app.whenReady()
  .then(main)
  .then((code) => app.exit(code))
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
