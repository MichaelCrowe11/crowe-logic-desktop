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
// Usage: npx electron scripts/make-icons.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { app, BrowserWindow } = require("electron");

const ASSETS = path.join(__dirname, "..", "assets");
const SRC = path.join(ASSETS, "icon.svg");

// macOS wants the full Big Sur ladder; .ico covers the Windows shell sizes.
const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICNS_NAMES = {
  16: ["icon_16x16.png"],
  32: ["icon_16x16@2x.png", "icon_32x32.png"],
  64: ["icon_32x32@2x.png"],
  128: ["icon_128x128.png"],
  256: ["icon_128x128@2x.png", "icon_256x256.png"],
  512: ["icon_256x256@2x.png", "icon_512x512.png"],
  1024: ["icon_512x512@2x.png"],
};

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

  fs.writeFileSync(path.join(ASSETS, "icon.png"), png.get(1024));
  console.log("wrote assets/icon.png (1024)");

  // tray.png and mark.png had no generator at all, so they kept showing the
  // retired cube after the mark changed. They come off the same vectors now.
  // The tray source is oversized: main.js resizes it to 18px, and downsampling
  // a 44px render beats upscaling an 18px one on a Retina menu bar.
  for (const [out, src, size] of [
    ["tray.png", "mark-tray.svg", 44],
    ["tray-light.png", "mark-tray-light.svg", 44],
    ["mark.png", "mark.svg", 512],
  ]) {
    fs.writeFileSync(path.join(ASSETS, out), await render(win, path.join(ASSETS, src), size));
    console.log(`wrote assets/${out} (${size}, from ${src})`);
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
    const { png, width } = await renderWide(win, path.join(ASSETS, src), height);
    fs.writeFileSync(path.join(ASSETS, out), png);
    console.log(`wrote assets/${out} (${width}x${height}, from ${src})`);
  }

  fs.writeFileSync(path.join(ASSETS, "icon.ico"), buildIco(ICO_SIZES.map((size) => ({ size, png: png.get(size) }))));
  console.log(`wrote assets/icon.ico (${ICO_SIZES.join(", ")})`);

  if (process.platform === "darwin") {
    const iconset = fs.mkdtempSync(path.join(os.tmpdir(), "croweicon-")) + "/icon.iconset";
    fs.mkdirSync(iconset, { recursive: true });
    for (const size of ICNS_SIZES) {
      for (const name of ICNS_NAMES[size]) fs.writeFileSync(path.join(iconset, name), png.get(size));
    }
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(ASSETS, "icon.icns")]);
    fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
    console.log(`wrote assets/icon.icns (${ICNS_SIZES.join(", ")})`);
  } else {
    // iconutil is macOS-only. The committed .icns stays valid; only a mac can refresh it.
    console.log("skipped assets/icon.icns (iconutil needs macOS)");
  }

  win.destroy();
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
