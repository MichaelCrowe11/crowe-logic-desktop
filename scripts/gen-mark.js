#!/usr/bin/env node
// Draws the Crowe Logic house mark and everything derived from it.
//
// The mark is a chiral whorl: a gold hexagonal core — the spore, the piece of
// tissue everything grows from — with six blue hyphae on the hex axes, every
// one curling the same rotational direction. Gold is reserved for the core
// alone: it is the inoculum, not an ornament. The curl is the other trick — a
// straight six-fold radial is mirror-symmetric, and mirror-symmetric six-fold
// forms already belong to other symbols (straight thin arms are the ✨ AI
// sparkle, straight forked arms are a snowflake). Chirality is the property
// neither of those can have, and it happens to be the honest one: hyphae bend
// as they grow. The mark reads as growth mid-motion, which is also why the
// idle rotation in the app looks native instead of applied.
//
// It replaced an isometric double-C cube. The cube was well drawn but it spoke
// logistics — an arrow through a shaded box is the visual language of freight
// and ERP — and its three blue tones plus fold-shade lips collapsed into mud
// below about 24px. This mark is two flat colours with no gradients, so the
// 18px tray icon and the 1024px installer icon are the same drawing.
//
// Emits assets/mark.svg, mark-simple.svg, mark-tray.svg, icon.svg and
// renderer/mark-geometry.js. That geometry module is what renderer/mark.js
// animates, so the static identity and the live thinking state are one shape:
// the icon spins up into the running state without a cut.
// Run: node scripts/gen-mark.js
"use strict";
const fs = require("fs");
const path = require("path");

// ── Parameters ──────────────────────────────────────────────────────────────
const VIEW = 120;
const CX = 60, CY = 60;
const RING = 46;          // bounding hexagon; the tool-call ping rides this
const HEART = 15.8;       // gold core circumradius

// Arms: radius in/out, width in/out. Blue arms start inside the core radius so
// they tuck under it and read as emerging from behind, not butting against it.
const BLUE = { r0: 9.0, r1: 40.0, w0: 8.8, w1: 3.1 };

// Degrees of clockwise drift a hypha accumulates root-to-tip. 22 was chosen
// against 0/14/32 at five sizes on both grounds: 14 still whispers crystal,
// 32 is a pinwheel. Fork branches curl proportionally so the whole mark
// shares one hand.
const CURL = 22;

// Each blue arm forks — branching is the one thing in this drawing that is
// literally true of the subject. Branches spring from the parent's tangent,
// so they inherit the curl instead of fighting it.
const FORK = { at: 0.58, angle: 26, len: 0.44, w: 0.60 };

// Mono-plus-spore palette. The hyphae are ink — the mark must survive in one
// colour, Nike-style, or it isn't a mark — and gold appears in exactly one
// place: the spore. One meaning per colour. Royal blue left the identity with
// the cube; it survives only as the reasoning flash inside the app (see
// --cm-blue-hot in styles.css), which is a better story anyway: blue is the
// thought, not the letterhead. The key is still named `blue` because the
// geometry contract (arms.blue) is shared with renderer/mark.js.
const C = { blue: "#1a1714", gold: "#EFA71B" };

// ── Geometry helpers ────────────────────────────────────────────────────────
const P = Math.PI;
const pt = (x, y) => `${x.toFixed(2)},${y.toFixed(2)}`;

// Hexagon with a vertex straight up. The core, the ring and the arm directions
// share this orientation, which is why the blue arms exit through the corners.
const hex = (r) => Array.from({ length: 6 }, (_, i) => {
  const a = (i * 60 - 90) * P / 180;
  return pt(CX + Math.cos(a) * r, CY + Math.sin(a) * r);
}).join(" ");

// A curved tapered arm as a closed polygon. The centerline spirals: radius
// grows linearly from d0 to d1 while the angle drifts by curl*t² — straight
// at the root, curling toward the tip, which is how a hypha actually bends.
// Width tapers w0→w1 along the way. Polygon (not path) so the animator keeps
// treating every part of the mark identically.
function bent(o, deg, d0, d1, w0, w1, curl, N) {
  N = N || 12;
  const C2 = [], L = [], R = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, a = (deg + curl * t * t - 90) * P / 180, d = d0 + (d1 - d0) * t;
    C2.push([o[0] + Math.cos(a) * d, o[1] + Math.sin(a) * d, w0 + (w1 - w0) * t]);
  }
  for (let i = 0; i <= N; i++) {
    const p = C2[i], q = C2[Math.min(i + 1, N)], r = C2[Math.max(i - 1, 0)];
    let tx = q[0] - r[0], ty = q[1] - r[1];
    const m = Math.hypot(tx, ty) || 1; tx /= m; ty /= m;
    const nx = -ty, ny = tx, w = p[2] / 2;
    L.push([p[0] + nx * w, p[1] + ny * w]);
    R.push([p[0] - nx * w, p[1] - ny * w]);
  }
  return L.concat(R.reverse()).map((p) => pt(p[0], p[1])).join(" ");
}

// Point and tangent direction on that same centerline at parameter t — the
// fork branches launch from here so they inherit the parent's curl.
function along(o, deg, d0, d1, curl, t) {
  const at = (u) => {
    const a = (deg + curl * u * u - 90) * P / 180, d = d0 + (d1 - d0) * u;
    return [o[0] + Math.cos(a) * d, o[1] + Math.sin(a) * d];
  };
  const p = at(t), q = at(t + 0.02);
  return { p, dir: Math.atan2(q[1] - p[1], q[0] - p[0]) * 180 / P + 90 };
}

// taper 1 = full taper as designed, 0 = parallel-sided arms. The small variants
// ease it off: a tip that tapers to 3.4 of a 120 canvas is under half a pixel
// at 16px and simply disappears. `fork` is dropped for the same reason — below
// about 20px the branches merge into a blur and cost legibility for nothing.
function arms(taper, fork) {
  const w = (a) => a.w0 + (a.w1 - a.w0) * taper;
  const blue = [];
  for (let i = 0; i < 6; i++) {
    const deg = i * 60;
    const tipW = w(BLUE);
    blue.push({ deg, pts: bent([CX, CY], deg, BLUE.r0, BLUE.r1, BLUE.w0, tipW, CURL) });
    if (!fork) continue;
    // Fork off the parent's tangent at 58% of its run, so the branches clear
    // the core, inherit the curl, and still finish inside the ring.
    const span = BLUE.r1 - BLUE.r0;
    const { p, dir } = along([CX, CY], deg, BLUE.r0, BLUE.r1, CURL, FORK.at);
    const bw = (BLUE.w0 + (tipW - BLUE.w0) * FORK.at) * FORK.w;
    for (const side of [-1, 1]) {
      blue.push({
        deg: deg + side * FORK.angle,
        pts: bent(p, dir + side * FORK.angle, 0, span * FORK.len, bw, tipW * 0.82, CURL * 0.9),
      });
    }
  }
  // gold stays as an (empty) list so the animator's contract doesn't change:
  // gold is only the spore core now, drawn separately as the heart.
  return { blue, gold: [] };
}

// Draw order: blue hyphae first, then the gold core on top — the spore sits
// over the roots of the arms so they read as emerging from behind it.
function markSvg(opts) {
  const { taper = 1, pal = C, ring = false, fork = true } = opts || {};
  const A = arms(taper, fork);
  const rows = [
    ring ? `<polygon points="${hex(RING)}" fill="none" stroke="${pal.blue}" stroke-width="1.6" opacity="0.35"/>` : "",
    ...A.blue.map((a) => `<polygon points="${a.pts}" fill="${pal.blue}"/>`),
    ...A.gold.map((a) => `<polygon points="${a.pts}" fill="${pal.gold}"/>`),
    `<polygon points="${hex(HEART)}" fill="${pal.gold}"/>`,
  ].filter(Boolean).join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}">\n  ${rows}\n</svg>\n`;
}

// ── Emit ────────────────────────────────────────────────────────────────────
const A = (p) => path.join(__dirname, "..", "assets", p);
// Writes and records the name, so the summary line below cannot drift out of
// step with what actually landed on disk — the same drift this whole pipeline
// exists to prevent, one level up.
const wrote = [];
const emit = (name, body) => { fs.writeFileSync(A(name), body); wrote.push(name); };
emit("mark.svg", markSvg());
// Simple: taper eased off so the tips still carry mass in the low twenties.
emit("mark-simple.svg", markSvg({ taper: 0.45 }));
// Same taper for dark surfaces. Without this the small-size variant is the one
// hole in the matrix: ink hyphae on a dark ground disappear at the exact sizes
// this file exists to survive.
emit("mark-simple-dark.svg", markSvg({ taper: 0.45, pal: { blue: "#f5f2ea", gold: C.gold } }));
// Strict one-colour versions — the Nike test. If the silhouette doesn't carry
// the mark without the gold, the mark is wrong; these are also what goes on
// anything printed, engraved, or embroidered.
emit("mark-mono.svg", markSvg({ pal: { blue: C.blue, gold: C.blue } }));
// Dark-surface version: white hyphae, gold spore intact.
emit("mark-dark.svg", markSvg({ pal: { blue: "#f5f2ea", gold: C.gold } }));
emit("mark-mono-inverse.svg", markSvg({ pal: { blue: "#f5f2ea", gold: "#f5f2ea" } }));
// Tray: near-parallel arms, no fork, solid black — a macOS template image
// (main.js flags it) so the menu bar recolours it for light/dark itself.
// tray-light.png is the white fallback for non-mac dark taskbars.
emit("mark-tray.svg", markSvg({
  taper: 0.2, fork: false, pal: { blue: "#000000", gold: "#000000" },
}));
emit("mark-tray-light.svg", markSvg({
  taper: 0.2, fork: false, pal: { blue: "#f5f2ea", gold: "#f5f2ea" },
}));

// App icon tile: dark graphite-navy rounded square (Big Sur grid), mark centred.
// The blue lifts on the tile because #2E5AAD on near-black loses its edge.
const TILE = 1024, GRID = 824, RAD = 186, INSET = (TILE - GRID) / 2;
// The whorl's ink box is ~81x81 of the 120 canvas — narrower than the cube it
// replaced, which spanned nearly edge to edge. Scale is set from the ink width,
// not the canvas, so the glyph keeps the ~47% presence scripts/test-icons.js
// requires. The mark is symmetric about (60,60), so no centring fudge.
const MS = 5.95, MW = VIEW * MS; // mark scale in the tile
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#182338"/><stop offset="0.55" stop-color="#101828"/><stop offset="1" stop-color="#0a0e18"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgba(255,255,255,0.14)"/><stop offset="0.2" stop-color="rgba(255,255,255,0.03)"/><stop offset="1" stop-color="rgba(255,255,255,0)"/>
    </linearGradient>
  </defs>
  <rect x="${INSET}" y="${INSET}" width="${GRID}" height="${GRID}" rx="${RAD}" fill="url(#bg)"/>
  <rect x="${INSET + 2}" y="${INSET + 2}" width="${GRID - 4}" height="${GRID - 4}" rx="${RAD - 2}" fill="none" stroke="url(#rim)" stroke-width="4"/>
  <g transform="translate(${(TILE - MW) / 2} ${(TILE - MW) / 2}) scale(${MS})">${
  markSvg({ pal: { blue: "#EDE8DC", gold: "#F5B02F" } })
    .replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "")
}</g>
</svg>
`;
emit("icon.svg", iconSvg);

// Horizontal lockup: mark + "Crowe Logic" in Fraunces, single ink colour —
// the wordmark is the brand, the mark is its signature. The SVG references
// the family by name (viewers without Fraunces fall back to Georgia); the
// pixel-true renders come from make-icons.js, which loads the bundled woff2.
function lockupSvg(ink, markPal) {
  const H = 120, MK = 96, MX = 4, TX = MX + MK + 26;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 470 ${H}">
  <g transform="translate(${MX} ${(H - MK) / 2}) scale(${MK / VIEW})">${
    markSvg({ pal: markPal }).replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "")
  }</g>
  <text x="${TX}" y="${H / 2}" dominant-baseline="central" fill="${ink}"
    font-family="Fraunces, Georgia, serif" font-weight="600" font-size="52"
    letter-spacing="0.2">Crowe Logic</text>
</svg>
`;
}
emit("lockup.svg", lockupSvg("#1a1714", C));
emit("lockup-dark.svg", lockupSvg("#f5f2ea", { blue: "#f5f2ea", gold: C.gold }));

// Geometry module for the living mark (renderer/mark.js). Arms carry their
// angle so the animator can stagger them around the ring instead of pulsing
// all twelve in lockstep.
const geometry = {
  view: VIEW, cx: CX, cy: CY, r: RING,
  ring: hex(RING),
  heart: hex(HEART),
  arms: arms(1, true),
  palette: { blue: C.blue, gold: C.gold, blueHot: "#4D9FE8", goldHot: "#F7C75A" },
};
fs.writeFileSync(path.join(__dirname, "..", "renderer", "mark-geometry.js"),
  `// Generated by scripts/gen-mark.js - do not edit by hand.\nwindow.CROWE_MARK_GEOMETRY = ${JSON.stringify(geometry, null, 2)};\n`);
console.log(`wrote ${wrote.length} vectors to assets/ (${wrote.join(", ")}) + renderer/mark-geometry.js`);
