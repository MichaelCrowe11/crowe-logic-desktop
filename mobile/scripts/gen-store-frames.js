#!/usr/bin/env node
/* Builds the framed App Store panels from the raw device captures.
 *
 * The raw set under marketing/ios/6.9/raw is the source of truth: straight
 * simctl framebuffer grabs at 1320x2868, which is exactly the 6.9" slot App
 * Store Connect asks for. This composites each one onto the editorial cream
 * surface with a Fraunces headline, and writes the result at the same size, so
 * either set can be uploaded without resizing anything.
 *
 * The headline copy lives here rather than in a JSON file beside it: it is five
 * lines, and a caption that drifts from the screenshot under it is the failure
 * this file exists to prevent. Read them next to the shots they sit on.
 *
 * Rendering is done by a Python helper (Pillow) because the brand faces ship as
 * variable woff2 and Pillow is the one thing on this machine that will rasterise
 * a variable axis. Node does the orchestration and the copy; Python does pixels.
 */
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const RAW = path.join(ROOT, "marketing/ios/6.9/raw");
const OUT = path.join(ROOT, "marketing/ios/6.9/framed");

/* No em dashes, no emojis, and nothing that describes the app as an "AI".
   Each line says what the surface under it actually does. */
const PANELS = [
  { file: "01-chat.png", head: "Your operator,\nin your pocket.", sub: "Ask it to reason, look things up, and keep track of what you are working on." },
  { file: "02-projects.png", head: "Every thread,\nand who answered it.", sub: "Coding, development and research, run by the operator." },
  { file: "03-studio.png", head: "Film, music,\nand the studio.", sub: "The creative house, under one roof." },
  { file: "04-cultivation.png", head: "The grower's\nspace.", sub: "Questions go straight to the mycology expert, with no need to phrase them for a router." },
  { file: "05-panels.png", head: "Operator control,\nfrom the phone.", sub: "See what is running, and stop it from here." },
];

const PY = path.join(__dirname, "gen-store-frames.py");

function main() {
  const missing = PANELS.filter((p) => !fs.existsSync(path.join(RAW, p.file)));
  if (missing.length) {
    console.error(`missing raw captures: ${missing.map((m) => m.file).join(", ")}`);
    console.error(`capture them into ${RAW} first`);
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const spec = JSON.stringify({ raw: RAW, out: OUT, panels: PANELS });
  const res = execFileSync("python3", [PY], { input: spec, encoding: "utf8" });
  process.stdout.write(res);
}

main();
