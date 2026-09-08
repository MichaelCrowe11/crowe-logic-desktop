#!/usr/bin/env node
// Brand copy guard. The house rules for anything a person reads in the product:
// no em dashes and no emoji in the renderer, the web shell, or the phone shell,
// and every keyboard focus ring drawn from --focus, which is the one gold step
// that clears 3:1 on paper. Comments are exempt, and so is the bare "—" a
// table cell shows for a value that was never recorded.
//
// Run: node scripts/test-brand-copy.js

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const files = [
  ...fs.readdirSync(path.join(root, "renderer")).filter((f) => /\.(js|html|css)$/.test(f) && f !== "preview.html")
    .map((f) => path.join("renderer", f)),
  ...fs.readdirSync(path.join(root, "mobile", "src")).filter((f) => /\.(js|html|css)$/.test(f))
    .map((f) => path.join("mobile", "src", f)),
];

// Comments carry prose about the code and are not the product's voice.
// Comments come out with their line breaks kept, so a report points at the
// line the author will open.
const blank = (m) => m.replace(/[^\n]/g, "");
const stripComments = (src, ext) => ext === ".html"
  ? src.replace(/<!--[\s\S]*?-->/g, blank)
  : src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

// Pictographs, emoticons, transport, flags and the variation selector that
// turns a glyph into one. Dingbats and arrows are typography and stay legal.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{FE0F}]/u;

let failures = 0;
const fail = (msg) => { failures++; console.log("not ok  " + msg); };

for (const rel of files) {
  const ext = path.extname(rel);
  const src = stripComments(fs.readFileSync(path.join(root, rel), "utf8"), ext);
  src.split("\n").forEach((line, i) => {
    const bare = line.replace(/(["'`])—\1/g, "");
    if (bare.includes("—")) fail(`${rel}:${i + 1} em dash in copy: ${line.trim().slice(0, 110)}`);
    if (EMOJI.test(line)) fail(`${rel}:${i + 1} emoji in copy: ${line.trim().slice(0, 110)}`);
  });
}

const css = fs.readFileSync(path.join(root, "renderer", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
for (const m of css.matchAll(/outline(?:-color)?:\s*([^;]*var\(--gold[^)]*\)[^;]*);/g)) {
  fail(`renderer/styles.css: a focus ring is drawn from ${m[1].trim()}; rings use var(--focus)`);
}

if (failures) { console.log(`${failures} brand copy failure(s)`); process.exit(1); }
console.log(`ok      brand copy: ${files.length} files, no em dashes, no emoji, rings on --focus`);
