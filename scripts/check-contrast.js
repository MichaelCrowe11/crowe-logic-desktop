#!/usr/bin/env node
// Reads the palette tokens straight out of styles.css and checks every
// foreground/background pair we actually render against WCAG 2.1 contrast.
//
// Body text and UI labels need 4.5:1. Borders and other non-text UI parts need
// 3:1, and are listed separately because gold is deliberately used as a hairline
// accent where it would be too light to set type in.
//
// Run: node scripts/check-contrast.js

const fs = require("fs");
const path = require("path");

const cssPath = path.join(__dirname, "..", "renderer", "styles.css");
const css = fs.readFileSync(cssPath, "utf8");

function tokensIn(block) {
  const out = {};
  for (const m of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

// Resolve var() indirection so --gold-text lands on a real colour.
function resolve(set) {
  for (const key of Object.keys(set)) {
    let value = set[key];
    for (let i = 0; i < 6 && value.includes("var("); i++) {
      value = value.replace(/var\((--[\w-]+)\)/g, (m, name) => set[name] || m);
    }
    set[key] = value;
  }
  return set;
}

const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("body.dark {"));
const darkBlock = css.slice(css.indexOf("body.dark {"), css.indexOf("* { box-sizing"));
const rootRaw = tokensIn(rootBlock);
const light = resolve({ ...rootRaw });
const dark = resolve({ ...rootRaw, ...tokensIn(darkBlock) });

function parse(color) {
  if (!color) return null;
  const c = color.trim();
  if (c.startsWith("#")) {
    const h = c.slice(1);
    const full = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
    if (full.length < 6) return null;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).concat(1);
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(",").map((s) => parseFloat(s));
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
}

// Composite a translucent colour onto whatever sits behind it.
const flatten = (c, behind) =>
  c[3] === 1 ? c.slice(0, 3) : [0, 1, 2].map((i) => c[i] * c[3] + behind[i] * (1 - c[3]));

const channel = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (c) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
const contrast = (a, b) => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

// [foreground, background, label]
const TEXT = [
  ["--ink", "--cream", "body text on the base"],
  ["--ink", "--panel", "body text on a panel"],
  ["--ink", "--raised", "body text on a raised card"],
  ["--muted", "--cream", "secondary text on the base"],
  ["--muted", "--panel", "secondary text on a panel"],
  ["--muted", "--raised", "secondary text on a raised card"],
  ["--gold-text", "--cream", "gold text on the base"],
  ["--gold-text", "--panel", "gold text on a panel"],
  ["--gold-text", "--raised", "gold text on a raised card"],
  ["--blue", "--panel", "link blue on a panel"],
  ["--ok", "--panel", "success text on a panel"],
  ["--err-fg", "--panel", "error text on a panel"],
  ["--err-fg", "--err-bg", "error text on its own tint"],
  ["--term-fg", "--term-bg", "terminal text"],
  ["--diff-add-fg", "--diff-bg", "diff addition"],
  ["--diff-del-fg", "--diff-bg", "diff deletion"],
  ["--diff-add-fg", "--diff-add-bg", "diff addition on its tint"],
  ["--diff-del-fg", "--diff-del-bg", "diff deletion on its tint"],
  ["--on-gold", "--gold", "text on a gold fill"],
  ["--on-danger", "--danger", "text on a destructive fill"],
  // The approval gate's own buttons. Gated here because the one before it was
  // picked by eye, rendered wrong in dark, and no check would have caught it.
  ["--cream", "--gold-deep", "text on the review-risk approve button"],
  ["--ink", "--glass", "text on the command palette"],
];

// Non-text, WCAG 1.4.11 / 2.4.11. Only things that carry meaning belong here.
// Decorative hairlines (--line, --line-strong) are deliberately absent: the
// surfaces they separate are already distinguished by a lightness step, so the
// border is not the thing conveying the boundary and is exempt.
const NON_TEXT = [
  ["--focus", "--panel", "focus ring against a panel"],
  ["--focus", "--raised", "focus ring against a raised field"],
  ["--focus", "--cream", "focus ring against the base"],
];

let failures = 0;

for (const [themeName, set] of [["light", light], ["dark", dark]]) {
  console.log(`\n${themeName}`);
  const base = parse(set["--cream"]).slice(0, 3);

  const run = (pairs, threshold, kind) => {
    for (const [fgName, bgName, label] of pairs) {
      const bgRaw = parse(set[bgName]);
      const fgRaw = parse(set[fgName]);
      if (!bgRaw || !fgRaw) {
        failures++;
        console.log(`  UNREADABLE  ${label} (${fgName} on ${bgName})`);
        continue;
      }
      const bg = flatten(bgRaw, base);
      const fg = flatten(fgRaw, bg);
      const ratio = contrast(fg, bg);
      const pass = ratio >= threshold;
      if (!pass) failures++;
      const mark = pass ? "ok    " : "FAIL  ";
      console.log(
        `  ${mark} ${ratio.toFixed(2).padStart(5)}:1  (needs ${threshold})  ${label}  [${kind}]`
      );
    }
  };

  run(TEXT, 4.5, "text");
  run(NON_TEXT, 3, "non-text");
}

if (failures) {
  console.error(`\n${failures} contrast check(s) failed.`);
  process.exit(1);
}
console.log("\nAll contrast checks passed.");
