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

/* Two targets, because the stores do not take the same picture.
 *
 * App Store Connect accepts the device capture itself, so the iOS panel keeps
 * 1320x2868 and nothing is resized on the way up.
 *
 * Play caps a phone screenshot at 2:1. The raw capture is 2868/1320 = 2.17:1
 * and would be refused, which is the kind of thing you find out at the end of
 * an upload. Its panel is a 16:9 canvas with the same capture inset — a
 * reframing rather than a crop, so nothing in the shot is lost. */
const TARGETS = [
  {
    label: "App Store 6.9\"",
    out: path.join(ROOT, "marketing/ios/6.9/framed"),
    w: 1320, h: 2868, margin: 96,
    rule_y: 196, rule_w: 76,
    head_size: 92, head_y: 252, head_step: 104,
    sub_size: 36, sub_gap: 24, sub_step: 52,
    shot_w: 1040, shot_top: 700,
  },
  {
    label: "Play phone 16:9",
    out: path.join(ROOT, "marketing/android/phone"),
    w: 1080, h: 1920, margin: 78,
    rule_y: 150, rule_w: 62,
    head_size: 72, head_y: 196, head_step: 82,
    sub_size: 29, sub_gap: 20, sub_step: 42,
    shot_w: 700, shot_top: 470,
  },
];

/* No em dashes, no emojis, and nothing that describes the app as an "AI".
   Each line says what the surface under it actually does. */
const PANELS = [
  { file: "01-home.png", head: "What are we\nworking on?", sub: "Understand a problem, review a file, plan a change, or try a model. Start from Home." },
  { file: "02-chat.png", head: "Your operator,\nin your pocket.", sub: "Ask it to reason, look things up, and keep track of what you are working on." },
  { file: "03-playground.png", head: "Try the models\nside by side.", sub: "Text and image models in a scratch space. Compare two, and nothing is saved to your chats." },
  { file: "04-messages.png", head: "Every thread,\nand who answered it.", sub: "Group conversations with the models and the people you work with." },
  { file: "05-home-dark.png", head: "Pair your own\ncomputer.", sub: "Read files and run commands on your Mac from here, over your private Tailscale network. Chat works without it." },
];

const PY = path.join(__dirname, "gen-store-frames.py");

function main() {
  const missing = PANELS.filter((p) => !fs.existsSync(path.join(RAW, p.file)));
  if (missing.length) {
    console.error(`missing raw captures: ${missing.map((m) => m.file).join(", ")}`);
    console.error(`capture them into ${RAW} first`);
    process.exit(1);
  }
  for (const t of TARGETS) fs.mkdirSync(t.out, { recursive: true });
  const spec = JSON.stringify({ raw: RAW, targets: TARGETS, panels: PANELS });
  const res = execFileSync("python3", [PY], { input: spec, encoding: "utf8" });
  process.stdout.write(res);
}

main();
