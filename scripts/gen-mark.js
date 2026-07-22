#!/usr/bin/env node
// Generates the Crowe Logic mark: the corporate double-C hex cube (blue
// hexagonal C + right-face stub, interlocked with a gold inner C whose shaft
// fires an arrow out the upper-right edge), rebuilt as exact vector geometry
// from the canonical raster. Emits assets/mark.svg and renderer/mark-geometry.js.
// Run: node scripts/gen-mark.js
"use strict";
const fs = require("fs");
const path = require("path");

// ── Parameters (proportions measured off the canonical 1024 raster) ─────────
const VIEW = 120;
const CX = 60, CY = 60;
const R = 46;                 // hexagon circumradius (to band centerline)
const W1 = 14.4;              // blue band width (0.31R: the mark is bold)
const W2 = 13.6;              // gold band width
const LIP = 0.34;             // fold-shade lip fraction of band width
const CUT_A = 0.06;           // blue cut just past the apex, along T->UR
const CUT_B = 0.90;           // blue lower-right cut, along B->LR
const STUB_T0 = 0.28, STUB_T1 = 0.68;  // right-face stub span along UR->LR
const GOLD_X = -0.24 * R;     // gold vertical band centerline offset from CX
const GOLD_TOP = -0.24 * R;   // top fold y offset from CY
const GOLD_BOT = 0.43 * R;    // bottom fold y offset from CY
const FOOT_LEN = 0.52 * R;    // foot length along +30deg
const HEAD_BASE_X = 0.17 * R; // arrowhead base plane offset from CX
const HEAD_H = 0.58 * R;      // arrowhead base height
const HEAD_L = 0.84 * R;      // arrowhead length (tip pokes past the stub plane)

// Palette: the corporate royal blues and ambers, kept vibrant like the source.
const C = {
  blueLit: "#3766C0", blue: "#2E5AAD", blueDeep: "#274C97", blueLip: "#13294F",
  gold: "#EFA71B", goldFoot: "#CE8710", goldLip: "#A96F08",
};

// ── Geometry helpers ────────────────────────────────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const norm = (a) => { const l = Math.hypot(a[0], a[1]); return [a[0] / l, a[1] / l]; };
const perp = (a) => [a[1], -a[0]];
const lerp = (a, b, t) => add(a, mul(sub(b, a), t));
const fmt = (p) => `${(+p[0]).toFixed(2)},${(+p[1]).toFixed(2)}`;
const poly = (pts) => pts.map(fmt).join(" ");

// Miter-offset an open polyline by dist along the perp of travel.
function offsetLine(pts, dist) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) { const d = norm(sub(pts[1], pts[0])); out.push(add(pts[0], mul(perp(d), dist))); }
    else if (i === pts.length - 1) { const d = norm(sub(pts[i], pts[i - 1])); out.push(add(pts[i], mul(perp(d), dist))); }
    else {
      const d1 = norm(sub(pts[i], pts[i - 1])), d2 = norm(sub(pts[i + 1], pts[i]));
      const n1 = perp(d1), n2 = perp(d2), m = norm(add(n1, n2));
      const cos = m[0] * n1[0] + m[1] * n1[1];
      out.push(add(pts[i], mul(m, dist / Math.max(cos, 0.2))));
    }
  }
  return out;
}
// A band along a spine: outer/inner offset point arrays (inner = toward sign*perp).
// vertCutEnds: force the first/last end cuts vertical (like the source mark).
function band(spine, w, innerSign, vertCutEnds) {
  const outer = offsetLine(spine, -innerSign * (w / 2));
  const inner = offsetLine(spine, innerSign * (w / 2));
  const lipIn = offsetLine(spine, innerSign * (w / 2 - w * LIP));
  if (vertCutEnds) {
    const fix = (arr, i, j, px) => {
      const d = norm(sub(spine[j], spine[i]));
      if (Math.abs(d[0]) < 0.05) return; // already vertical edge, keep butt cap
      for (const line of [outer, inner, lipIn]) {
        const p = line[i === 0 ? 0 : line.length - 1];
        p[1] = p[1] + ((px - p[0]) * d[1]) / d[0];
        p[0] = px;
      }
    };
    fix(spine, 0, 1, spine[0][0]);
    fix(spine, spine.length - 1, spine.length - 2, spine[spine.length - 1][0]);
  }
  return { outer, inner, lipIn };
}
const segPoly = (b, i0, i1) => poly([...b.outer.slice(i0, i1 + 1), ...b.inner.slice(i0, i1 + 1).reverse()]);
const lipPoly = (b, i0, i1) => poly([...b.lipIn.slice(i0, i1 + 1), ...b.inner.slice(i0, i1 + 1).reverse()]);

// ── Hexagon (pointy-top) ────────────────────────────────────────────────────
const hexV = (deg, r = R) => [CX + r * Math.cos((deg * Math.PI) / 180), CY + r * Math.sin((deg * Math.PI) / 180)];
const T = hexV(-90), UR = hexV(-30), LR = hexV(30), B = hexV(90), LL = hexV(150), UL = hexV(210);

// ── Blue C ──────────────────────────────────────────────────────────────────
// Travel: cutA (just past apex) -> T -> UL -> LL -> B -> cutB (short of LR).
// Hex center sits LEFT of that travel direction: inner = +perp? Determined
// empirically: innerSign such that the lip lands toward the center.
const cutA = lerp(T, UR, CUT_A);
const cutB = lerp(B, LR, CUT_B);
const blueSpine = [cutA, T, UL, LL, B, cutB];
const blueBand = band(blueSpine, W1, 1, true);
// Segments: [0..2] top-left run (lit), [2..3] left vertical (base), [3..5] bottom (deep).
const blue = {
  segs: [
    { pts: segPoly(blueBand, 0, 2), fill: C.blueLit },
    { pts: segPoly(blueBand, 2, 3), fill: C.blue },
    { pts: segPoly(blueBand, 3, 5), fill: C.blueDeep },
  ],
  lip: { pts: lipPoly(blueBand, 0, 5), fill: C.blueLip },
};

// ── Blue right-face stub (implied edge behind the arrow) ────────────────────
// Parallelogram on the UR->LR edge, ends cut at -30deg, lip on the center side.
const RX = UR[0]; // right face plane x (band centered on it)
const stubY0 = UR[1] + STUB_T0 * (LR[1] - UR[1]);
const stubY1 = UR[1] + STUB_T1 * (LR[1] - UR[1]);
const half1 = W1 / 2, rise = W1 * Math.tan(Math.PI / 6);
const stubPts = [[RX - half1, stubY0 + rise / 2], [RX + half1, stubY0 - rise / 2], [RX + half1, stubY1 - rise / 2], [RX - half1, stubY1 + rise / 2]];
const stubLipW = W1 * LIP;
// Lip = strip along the stub's left (center-facing) edge, same slope caps.
const stub = {
  pts: poly(stubPts),
  lip: poly([[RX - half1, stubY0 + rise / 2], [RX - half1 + stubLipW, stubY0 + rise / 2 - stubLipW * 0.577], [RX - half1 + stubLipW, stubY1 - rise / 2 + (W1 - stubLipW) * 0.577], [RX - half1, stubY1 + rise / 2]]),
};

// ── Gold C + arrow ──────────────────────────────────────────────────────────
const gx = CX + GOLD_X;
const topFold = [gx, CY + GOLD_TOP];
const botFold = [gx, CY + GOLD_BOT];
const footDir = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
const footEnd = add(botFold, mul(footDir, FOOT_LEN));
const hbx = CX + HEAD_BASE_X;
const shaftDir = [Math.cos(-Math.PI / 6), Math.sin(-Math.PI / 6)];
const shaftEnd = [hbx, topFold[1] - (hbx - gx) * Math.tan(Math.PI / 6)];
const goldSpine = [footEnd, botFold, topFold, shaftEnd];
const goldBand = band(goldSpine, W2, -1, true);
const yh = shaftEnd[1];
const headTop = [hbx - 0.8, yh - HEAD_H / 2]; // 0.8 overlap onto the shaft end
const headBot = [hbx - 0.8, yh + HEAD_H / 2];
const tip = [hbx + HEAD_L, yh];
// Head bottom-edge lip (fold shadow along the underside).
const be = norm(sub(tip, headBot));
const bn = mul(perp(be), -1); // pointing up into the triangle
const hl = W2 * LIP * 0.55;
const gold = {
  segs: [
    { pts: segPoly(goldBand, 0, 1), fill: C.goldFoot },
    { pts: segPoly(goldBand, 1, 3), fill: C.gold },
  ],
  lip: { pts: lipPoly(goldBand, 1, 3), fill: C.goldLip },
  head: poly([headTop, tip, headBot]),
  headLip: poly([headBot, tip, add(tip, mul(bn, hl)), add(headBot, mul(bn, hl))]),
};

// ── Emit SVG ────────────────────────────────────────────────────────────────
function markSvg({ lips = true, pal = C } = {}) {
  const map = { [C.blueLit]: pal.blueLit, [C.blue]: pal.blue, [C.blueDeep]: pal.blueDeep, [C.blueLip]: pal.blueLip, [C.gold]: pal.gold, [C.goldFoot]: pal.goldFoot, [C.goldLip]: pal.goldLip };
  const f = (c) => map[c] || c;
  const rows = [
    ...blue.segs.map((s) => `<polygon points="${s.pts}" fill="${f(s.fill)}"/>`),
    lips ? `<polygon points="${blue.lip.pts}" fill="${f(blue.lip.fill)}"/>` : "",
    `<polygon points="${stub.pts}" fill="${f(C.blue)}"/>`,
    lips ? `<polygon points="${stub.lip}" fill="${f(C.blueLip)}"/>` : "",
    ...gold.segs.map((s) => `<polygon points="${s.pts}" fill="${f(s.fill)}"/>`),
    lips ? `<polygon points="${gold.lip.pts}" fill="${f(gold.lip.fill)}"/>` : "",
    `<polygon points="${gold.head}" fill="${f(C.gold)}"/>`,
    lips ? `<polygon points="${gold.headLip}" fill="${f(C.goldLip)}"/>` : "",
  ].filter(Boolean).join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}">\n  ${rows}\n</svg>\n`;
}
const A = (p) => path.join(__dirname, "..", "assets", p);
fs.writeFileSync(A("mark.svg"), markSvg());
fs.writeFileSync(A("mark-simple.svg"), markSvg({ lips: false }));
// Tray: simplified + brightened so it reads on a dark menu bar at 18px.
fs.writeFileSync(A("mark-tray.svg"), markSvg({ lips: false, pal: {
  blueLit: "#7FA6E8", blue: "#6b93dc", blueDeep: "#5b80c8", blueLip: "#2a4470",
  gold: "#F5B02F", goldFoot: "#DE9812", goldLip: "#B87E10",
} }));
// App icon tile: dark graphite-navy rounded square (Big Sur grid), mark centered.
const TILE = 1024, GRID = 824, RAD = 186, INSET = (TILE - GRID) / 2;
const MS = 5.05, MW = VIEW * MS; // mark scale in the tile
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
  <g transform="translate(${(TILE - MW) / 2 + 6} ${(TILE - MW) / 2}) scale(${MS})">${markSvg().replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "")}</g>
</svg>
`;
fs.writeFileSync(A("icon.svg"), iconSvg);

// Geometry module for the living mark (renderer/mark.js).
const geometry = {
  view: VIEW, cx: CX, cy: CY, r: R,
  hex: poly([T, UR, LR, B, LL, UL]),
  tip: tip.map((v) => +v.toFixed(2)),
  blue: { segs: blue.segs, lip: blue.lip, stub: { pts: stub.pts, lip: stub.lip } },
  gold: { segs: gold.segs, lip: gold.lip, head: gold.head, headLip: gold.headLip },
};
fs.writeFileSync(path.join(__dirname, "..", "renderer", "mark-geometry.js"),
  `// Generated by scripts/gen-mark.js - do not edit by hand.\nwindow.CROWE_MARK_GEOMETRY = ${JSON.stringify(geometry, null, 2)};\n`);
console.log("wrote assets/mark.svg + renderer/mark-geometry.js");
