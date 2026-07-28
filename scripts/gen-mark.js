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
const HEART = 15.0;       // gold core circumradius

// Arms: radius in/out, width in/out. Blue arms start inside the core radius so
// they tuck under it and read as emerging from behind, not butting against it.
// w1 is the tip width and it wants to be nearly nothing: the polygon caps
// square, so any real width there is a flat perpendicular cut, and twelve
// scissor-cut filaments is the one detail that still read as manufactured at
// icon size. Only the primary can afford this — every small variant eases the
// taper back off (see `taper` below), which is what keeps the tips visible at
// 16px instead of vanishing.
const BLUE = { r0: 8.0, r1: 41.0, w0: 9.4, w1: 0.8 };

// Degrees of clockwise drift a hypha accumulates root-to-tip. 22 was chosen
// against 0/14/32 at five sizes on both grounds: 14 still whispers crystal,
// 32 is a pinwheel. Fork branches curl proportionally so the whole mark
// shares one hand.
const CURL = 22;

// Each blue arm forks — branching is the one thing in this drawing that is
// literally true of the subject. Branches spring from the parent's tangent,
// so they inherit the curl instead of fighting it.
//
// The branch point is the whole difference between a mycelium and a bug. It sat
// at 58% of the run, which put a joint in the middle of every arm: six limbs
// with knees around a bright bulb, and the mark read as a tick at any size big
// enough to see. Hyphae branch APICALLY — near the advancing tip, off a
// filament that is already fine — so moving it to 82% both matches the organism
// and removes the knee. The spore shrank with it, because a large bright centre
// ringed by limbs is an abdomen no matter how the limbs are drawn.
const FORK = { at: 0.78, angle: 32, len: 0.30, w: 0.5, side: 1 };

// Mono-plus-spore palette. The hyphae are ink — the mark must survive in one
// colour, Nike-style, or it isn't a mark — and gold appears in exactly one
// place: the spore. One meaning per colour. Royal blue left the identity with
// the cube; it survives only as the reasoning flash inside the app (see
// --cm-blue-hot in styles.css), which is a better story anyway: blue is the
// thought, not the letterhead. The key is still named `blue` because the
// geometry contract (arms.blue) is shared with renderer/mark.js.
const C = { blue: "#1a1714", gold: "#EFA71B" };

// The tonal scale. Flat two-colour was the right call for a tray icon and the
// wrong one for a 104px hero: six thin near-white arms around a flat mustard
// hexagon read as a spider, not an organism. The scale fixes that without
// inventing a second identity, because it runs along the axis the mark already
// means — spore at the centre, hyphae growing outward. Colour is the growth.
//
// It is a single userSpaceOnUse RADIAL gradient centred on the spore, so all
// six arms and both forks inherit it from their own distance out. One gradient,
// no per-arm alignment, and the drawing stays polygons the animator can keep
// treating identically.
//
// Anything that has to survive small stays flat: the tray, the mono cuts and
// mark-simple pass no scale at all and are byte-for-byte what they always were.
const SCALE = {
  // On paper: gold root cooling to ink, so the tips land on the body text colour.
  paper: { root: "#F5B01D", mid: "#A9702A", tip: "#241F19", core: "#FFC94A", coreEdge: "#D9911A" },
  // On a dark ground the same ramp has to end light or the tips vanish, so it
  // runs bronze -> bone. It used to start at #FFC247, which is the spore's own
  // colour, and six arms 9.4 wide at the root fill about 60% of the circle at
  // the core's radius — so the ramp painted a gold ring immediately around a
  // gold hexagon and the two fused into one bright blob. The spore stopped
  // being a spore and the mark read as a starfish. Starting the arms in deep
  // bronze gives the core a dark collar to sit against, and it re-states the
  // rule the palette is built on: gold appears in exactly one place, the
  // inoculum. Still monotonic — dark at the root, pale at the tip.
  dark: { root: "#7E5A2A", mid: "#A87F45", tip: "#F0EADC", core: "#FFD264", coreEdge: "#DA9A1E" },
};

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
// Every variant meant for small sizes passes fork: false. That sentence was
// here before the code did it, and mark-simple.svg spent a release forked.
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
    /* One branch, not two, and always on the same side. A symmetric pair at the
       tip is a trident — six of them is a claw per arm, which is the creature
       read the apical move was meant to end. Lateral branching is one-sided in
       the organism too, and taking the curl's own side makes the whole mark
       lean one way: the same chirality argument as CURL, now told twice. */
    blue.push({
      deg: deg + FORK.side * FORK.angle,
      pts: bent(p, dir + FORK.side * FORK.angle, 0, span * FORK.len, bw, tipW * 0.82, CURL * 0.9),
    });
  }
  // gold stays as an (empty) list so the animator's contract doesn't change:
  // gold is only the spore core now, drawn separately as the heart.
  return { blue, gold: [] };
}

// The arms reach about 81 of the 120 canvas, so a third of every rendered pixel
// was margin the mark had already paid for: at a 16px tray slot only ~11px was
// artwork. The box below is the ink, not the canvas.
//
// It is one box shared by every variant, not a per-variant fit. Easing the taper
// widens the tips, so the small variants actually reach *further* than the
// primary — fitting each one to itself would make the mark change size the
// moment you swapped mark.svg for mark-simple.svg in the same slot. Taking the
// union and squaring it about the centre keeps the family interchangeable.
const INK_PAD = 1; // keeps tip antialiasing off the viewBox edge
function inkBox() {
  let far = 0;
  // Extent is driven by taper (tip width) and fork; the corners of that space
  // bound everything between them.
  for (const taper of [0, 1]) {
    for (const fork of [false, true]) {
      for (const a of arms(taper, fork).blue) {
        for (const pair of a.pts.trim().split(/\s+/)) {
          const [x, y] = pair.split(",").map(Number);
          far = Math.max(far, Math.abs(x - CX), Math.abs(y - CY));
        }
      }
    }
  }
  const half = far + INK_PAD, side = half * 2;
  return `${(CX - half).toFixed(2)} ${(CY - half).toFixed(2)} ${side.toFixed(2)} ${side.toFixed(2)}`;
}
const INK_VIEWBOX = inkBox();

// Draw order: blue hyphae first, then the gold core on top — the spore sits
// over the roots of the arms so they read as emerging from behind it.
// `scale` opts into the tonal ramp above. `id` prefixes the gradient ids, which
// matters because the lockup and the icon tile inline this markup inside a
// larger document - two marks on one page sharing an id would silently paint
// the second one with the first one's stops.
function markSvg(opts) {
  const { taper = 1, pal = C, ring = false, fork = true, scale = null, id = "cl" } = opts || {};
  const A = arms(taper, fork);
  const hy = scale ? `url(#${id}-hy)` : pal.blue;
  const co = scale ? `url(#${id}-co)` : pal.gold;
  // Radial, user-space, centred on the spore and reaching the arm tips: every
  // arm is warm where it leaves the core and cool where it ends, from one def.
  // The core's own gradient is offset up-left so the spore reads lit rather
  // than printed.
  const defs = scale ? `<defs>
    <radialGradient id="${id}-hy" gradientUnits="userSpaceOnUse" cx="${CX}" cy="${CY}" r="${BLUE.r1}">
      <stop offset="0.10" stop-color="${scale.root}"/>
      <stop offset="0.42" stop-color="${scale.mid}"/>
      <stop offset="1" stop-color="${scale.tip}"/>
    </radialGradient>
    <radialGradient id="${id}-co" gradientUnits="userSpaceOnUse" cx="${CX - HEART * 0.34}" cy="${CY - HEART * 0.38}" r="${HEART * 1.55}">
      <stop offset="0" stop-color="${scale.core}"/>
      <stop offset="1" stop-color="${scale.coreEdge}"/>
    </radialGradient>
  </defs>\n  ` : "";
  const rows = [
    ring ? `<polygon points="${hex(RING)}" fill="none" stroke="${pal.blue}" stroke-width="1.6" opacity="0.35"/>` : "",
    ...A.blue.map((a) => `<polygon points="${a.pts}" fill="${hy}"/>`),
    ...A.gold.map((a) => `<polygon points="${a.pts}" fill="${co}"/>`),
    `<polygon points="${hex(HEART)}" fill="${co}"/>`,
  ].filter(Boolean).join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${INK_VIEWBOX}">\n  ${defs}${rows}\n</svg>\n`;
}

// ── Emit ────────────────────────────────────────────────────────────────────
const A = (p) => path.join(__dirname, "..", "assets", p);
// Writes and records the name, so the summary line below cannot drift out of
// step with what actually landed on disk — the same drift this whole pipeline
// exists to prevent, one level up.
const wrote = [];
const emit = (name, body) => { fs.writeFileSync(A(name), body); wrote.push(name); };
emit("mark.svg", markSvg({ scale: SCALE.paper, id: "m" }));
// Simple: the small-size variant, and it has to actually be simple. It kept the
// fork while claiming not to, which is why it read no better than the primary —
// rendered at true 16px the branches broke into detached specks and the gold
// core was the only thing left. Same geometry the tray has always used, because
// the tray was the only variant that survived that test, but in full colour: the
// core is what carries the brand once the arms go thin.
emit("mark-simple.svg", markSvg({ taper: 0.2, fork: false }));
// Dark surfaces need more mass than light ones at the same size — ink on a dark
// ground loses a half-pixel of stroke to antialiasing that light never gives
// back. Parallel-sided arms are the widest this geometry offers, so the dark
// small variant takes them.
emit("mark-simple-dark.svg", markSvg({ taper: 0, fork: false, pal: { blue: "#f5f2ea", gold: C.gold } }));
// Strict one-colour versions — the Nike test. If the silhouette doesn't carry
// the mark without the gold, the mark is wrong; these are also what goes on
// anything printed, engraved, or embroidered.
emit("mark-mono.svg", markSvg({ pal: { blue: C.blue, gold: C.blue } }));
// Dark-surface version: white hyphae, gold spore intact.
emit("mark-dark.svg", markSvg({ scale: SCALE.dark, id: "md" }));
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

// App icon tile: warm graphite rounded square (Big Sur grid), mark centred.
// It was graphite-navy, which put a cool blue tile under a warm gold mark and
// made the gold look dirty; the tile is now the same warm charcoal the app's
// dark theme uses, so icon and window agree.
const TILE = 1024, GRID = 824, RAD = 186, INSET = (TILE - GRID) / 2;
// The whorl's ink box is ~81x81 of the 120 canvas — narrower than the cube it
// replaced, which spanned nearly edge to edge. Scale is set from the ink width,
// not the canvas, so the glyph keeps the ~47% presence scripts/test-icons.js
// requires. The mark is symmetric about (60,60), so no centring fudge.
const MS = 5.95, MW = VIEW * MS; // mark scale in the tile
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b2620"/><stop offset="0.55" stop-color="#1a1713"/><stop offset="1" stop-color="#0e0c0a"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgba(255,255,255,0.14)"/><stop offset="0.2" stop-color="rgba(255,255,255,0.03)"/><stop offset="1" stop-color="rgba(255,255,255,0)"/>
    </linearGradient>
  </defs>
  <rect x="${INSET}" y="${INSET}" width="${GRID}" height="${GRID}" rx="${RAD}" fill="url(#bg)"/>
  <rect x="${INSET + 2}" y="${INSET + 2}" width="${GRID - 4}" height="${GRID - 4}" rx="${RAD - 2}" fill="none" stroke="url(#rim)" stroke-width="4"/>
  <g transform="translate(${(TILE - MW) / 2} ${(TILE - MW) / 2}) scale(${MS})">${
  // Eased taper, not the full one. This single SVG is rasterised down to the
  // 32px and 16px rungs of the .icns and .ico, and a tip that tapers to 0.8 of
  // a 120 canvas is a fifth of a pixel there - the outer third of every
  // filament washes into the tile and the mark measurably shrinks (see the
  // "still reads at 32px" check in scripts/test-icons.js, which caught exactly
  // this). The icon is a small variant at its bottom rungs and takes the same
  // treatment the tray does; mark.svg and the lockups keep the fine tips.
  markSvg({ taper: 0.62, scale: SCALE.dark, id: "ic" })
    .replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "")
}</g>
</svg>
`;
emit("icon.svg", iconSvg);

// The wordmark is outlines, not <text>. It used to be a <text> element naming
// the family, which meant assets/lockup.svg — the logo — rendered in Georgia on
// every machine without Fraunces installed: GitHub, npm, print, anyone opening
// the file on its own. Only make-icons.js ever saw the real letters, because it
// loads the bundled woff2 before rasterising. Outlines have no such dependency.
// Regenerate with `python3 scripts/gen-wordmark.py` (see that file for why the
// artefact is committed rather than built).
const WM = require("./wordmark-data.js");

// Strips the wrapper so a mark can be inlined into a larger document.
const markInner = (opts) =>
  markSvg(opts).replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

// The ink box is centred on (CX, CY) by construction, so a mark is placed by
// moving that centre to the target and scaling the box to the wanted size.
const [IBX, IBY, IBW, IBH] = INK_VIEWBOX.split(/\s+/).map(Number);
const placeMark = (cx, cy, size, opts) =>
  `<g transform="translate(${cx} ${cy}) scale(${(size / IBW).toFixed(5)}) ` +
  `translate(${-(IBX + IBW / 2)} ${-(IBY + IBH / 2)})">${markInner(opts)}</g>`;

// Horizontal lockup: mark + words, single ink colour. Keeps the i's own dot —
// the spore is already present at full size on the left, and printing it twice
// would break the rule the palette runs on, that gold appears in exactly one
// place.
function lockupSvg(ink, markOpts) {
  const H = 120, MK = 96, MX = 4, GAP = 26;
  const s = 52 / WM.size;                       // wordmark drawn at 52px em
  const TX = MX + MK * (IBW / VIEW) + GAP;      // gap measured from painted ink
  const baseline = H / 2 + (WM.capHeight * s) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(TX + WM.width * s + MX)} ${H}">
  ${placeMark(MX + (MK * (IBW / VIEW)) / 2, H / 2, MK * (IBW / VIEW), markOpts)}
  <g transform="translate(${TX} ${baseline.toFixed(2)}) scale(${s})"><path d="${WM.d}" fill="${ink}"/></g>
</svg>
`;
}
emit("lockup.svg", lockupSvg("#1a1714", { scale: SCALE.paper, id: "lp" }));
emit("lockup-dark.svg", lockupSvg("#f5f2ea", { scale: SCALE.dark, id: "ld" }));

// Logotype: the words alone, with the spore standing in for the tittle of the
// "i". This is the cut that has to work as a logo — one lockup, no separate
// mark to lose — so the dot is removed from the outline rather than covered.
const SPORE = 46;   // ink width of the spore, in wordmark em units
function wordmarkSvg(ink, markOpts) {
  const t = WM.tittle;
  const top = Math.min(t.cy - SPORE / 2, -WM.capHeight) - 5;
  const bottom = -WM.descent + 5;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-5} ${top.toFixed(2)} ${(WM.width + 10).toFixed(2)} ${(bottom - top).toFixed(2)}">
  <path d="${WM.dDotless}" fill="${ink}"/>
  ${placeMark(t.cx, t.cy, SPORE, markOpts)}
</svg>
`;
}
emit("wordmark.svg", wordmarkSvg("#1a1714", { scale: SCALE.paper, id: "wm" }));
emit("wordmark-dark.svg", wordmarkSvg("#f5f2ea", { scale: SCALE.dark, id: "wd" }));

// Geometry module for the living mark (renderer/mark.js). Arms carry their
// angle so the animator can stagger them around the ring instead of pulsing
// all twelve in lockstep.
const geometry = {
  view: VIEW, cx: CX, cy: CY, r: RING,
  // The same ink box every static cut uses. The live mark drew itself on the raw
  // 120 canvas, which meant a third of every mounted pixel was the margin the
  // static family had already trimmed: the 26px header mark was painting about
  // 19px of artwork inside a 26px slot while assets/mark.svg at the same size
  // painted 26. One box for both, and the live mark grows ~36% in place.
  viewBox: INK_VIEWBOX,
  ring: hex(RING),
  heart: hex(HEART),
  arms: arms(1, true),
  // The small cut, and the reason it exists: every *static* variant destined for
  // a small slot eases the taper off (mark-simple and the tray at 0.2, the icon
  // tile at 0.62) because a tip 0.8 wide on a 120 canvas is a fifth of a pixel
  // down there and simply is not drawn. The live mark never got that treatment,
  // so the 26px header and avatar mounts rendered six filaments that faded to
  // nothing two-thirds of the way out — the arms read as scratches around the
  // spore rather than as hyphae. 0.45 puts the tip at ~1.6px in a 26px slot:
  // still visibly tapered, no longer a rounding error. Fork drops for the usual
  // reason — a 0.9px branch stub is a blur that costs contrast for nothing.
  armsSmall: arms(0.45, false),
  // The gradient geometry, emitted rather than restated. renderer/mark.js had
  // its own copies of these numbers and they had drifted: the live core ramp
  // still used a radius sized for the larger spore, so the app's mark was lit
  // differently from the icon it is supposed to be continuous with.
  ramp: {
    hy: { cx: CX, cy: CY, r: BLUE.r1 },
    co: { cx: +(CX - HEART * 0.34).toFixed(2), cy: +(CY - HEART * 0.38).toFixed(2), r: +(HEART * 1.55).toFixed(2) },
  },
  palette: { blue: C.blue, gold: C.gold, blueHot: "#4D9FE8", goldHot: "#F7C75A" },
};
fs.writeFileSync(path.join(__dirname, "..", "renderer", "mark-geometry.js"),
  `// Generated by scripts/gen-mark.js - do not edit by hand.\nwindow.CROWE_MARK_GEOMETRY = ${JSON.stringify(geometry, null, 2)};\n`);

// The Tauri app bundles whatever sits under its frontendDist, so it cannot
// reference ../assets and needs its own copies. Mirroring them here rather than
// copying by hand is the same lesson the lockup PNGs taught: a second hand-made
// copy of the logo is a copy that will silently fall behind the first.
const MIRROR = path.join(__dirname, "..", "mobile", "src", "brand");
const mirrored = [];
if (fs.existsSync(MIRROR)) {
  for (const name of ["mark.svg", "mark-dark.svg", "wordmark.svg", "wordmark-dark.svg"]) {
    fs.copyFileSync(A(name), path.join(MIRROR, name));
    mirrored.push(name);
  }
}

console.log(`wrote ${wrote.length} vectors to assets/ (${wrote.join(", ")}) + renderer/mark-geometry.js`);
if (mirrored.length) console.log(`mirrored ${mirrored.length} to mobile/src/brand/ (${mirrored.join(", ")})`);
