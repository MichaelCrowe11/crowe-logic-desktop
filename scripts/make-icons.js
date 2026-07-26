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

function svgAt(size) {
  const svg = fs.readFileSync(SRC, "utf8");
  // Give the root an intrinsic size so Chromium rasterizes at the target
  // resolution instead of rendering once and scaling a bitmap.
  return svg.replace(/<svg\b/, `<svg width="${size}" height="${size}"`);
}

async function render(win, size) {
  const b64 = Buffer.from(svgAt(size), "utf8").toString("base64");
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
  for (const size of sizes) png.set(size, await render(win, size));

  fs.writeFileSync(path.join(ASSETS, "icon.png"), png.get(1024));
  console.log("wrote assets/icon.png (1024)");

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
