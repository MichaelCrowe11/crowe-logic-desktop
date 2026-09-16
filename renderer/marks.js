// Worker marks: eight animated marks, one per worker, drawn as vector.
//
// In July 2026 the CLI consoles got eight "thinking marks", each a single
// terminal glyph animated on its own idea of motion: Mycelial Pulse breathes on
// two periods that never quite line up, Hexbloom opens through a glyph ladder,
// Hex Iris steps an aperture, Meshwork turns at a constant rate, Facet-Fold
// folds quadrants, Convergent circles a dot, Meridian sweeps a head across five
// cells, Coalesce flies particles in to land on a diamond. They lived only in
// cli/pui/marks.py. This module is the same eight as inline SVG for the desktop
// app, faithful to each ancestor's motion and period, in the house palette.
//
// Every worker in the Rooms registry carries one (rooms/registry.js sets the
// `mark` field; markFor hashes the id into the eight for any worker without
// one), so a row in the Messages rail, a seat in a room, a bubble in a thread
// and the avatar in the main chat all wear the worker's own mark instead of a
// repeated Crowe Logic whorl. A mark animates only while its worker reasons;
// at rest it holds a still frame, and under prefers-reduced-motion it holds
// that frame always (styles.css, the .wm- rules).
//
// The markup is a pure string with no style attributes: the shells run under a
// Content Security Policy that forbids inline styles, so every colour, delay
// and motion is a class resolved by styles.css. The un-animated attribute
// values ARE the still frame: turn the animations off and what remains is the
// rest state by construction.
//
// window.CroweMarks / module.exports:
//   MARKS                 the eight definitions: id, name, motion, period (s)
//   MARK_IDS              their ids, in the CLI's rotation order
//   markSvg(id, {size, state})  -> SVG string with data-mark and data-state
//   markFor(worker)       -> mark id: the worker's `mark` field, else a
//                            deterministic hash of the worker id into the eight
//   setMarkState(el, state)  rest | reasoning | done (brief flourish, then rest)
//   mount(host, worker, {state}) -> { el, svg, id, setState, done, rest, retarget }
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CroweMarks = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // Order is the CLI rotation order. Periods are the terminal's, in seconds.
  const MARKS = Object.freeze([
    { id: "mycelial", name: "Mycelial Pulse", motion: "Organic: a diamond breathing on two periods that never line up", period: 2.4 },
    { id: "hexbloom", name: "Hexbloom", motion: "Breathing bloom: a hexagon opens out to its ring and closes again", period: 2.0 },
    { id: "iris", name: "Hex Iris", motion: "Aperture: a shutter stepping open and shut inside a hexagonal ring", period: 1.8 },
    { id: "meshwork", name: "Meshwork", motion: "Precision gear: a half disc turning at a constant rate inside a toothed ring", period: 1.2 },
    { id: "facet", name: "Facet-Fold", motion: "Origami: four quadrants folding around the square in turn", period: 1.6 },
    { id: "convergent", name: "Convergent", motion: "Orbital: a satellite circling a still centre", period: 1.0 },
    { id: "meridian", name: "Meridian", motion: "Phase sweep: a bright head travelling five bars and wrapping", period: 2.0 },
    { id: "coalesce", name: "Coalesce", motion: "Assembly: two particles fly in from the edges and land on the diamond", period: 2.2 },
  ].map(Object.freeze));
  const MARK_IDS = Object.freeze(MARKS.map((m) => m.id));
  const BY_ID = new Map(MARKS.map((m) => [m.id, m]));

  const STATES = new Set(["rest", "reasoning", "done", "failed"]);
  const DONE_MS = 640;

  // A regular hexagon, point up, as a points string. Half-integer vertices keep
  // the edges on device pixels at 16, 24 and 32.
  function hex(cx, cy, r) {
    const pts = [];
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 180) * (90 + 60 * k);
      pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy - r * Math.sin(a)).toFixed(2)}`);
    }
    return pts.join(" ");
  }

  // Each drawing sits on a 32 x 32 canvas centred at 16,16. Class names carry
  // the palette (wm-g gold, wm-b blue, wm-a accent) and the moving part.
  const DRAW = {
    // Two nested breaths, 2.4s over 0.83s, so the pulse reads as alive rather
    // than as a metronome. Four hyphal dots breathe on the fast period.
    mycelial: () =>
      `<g class="wm-slow"><g class="wm-fast">` +
      `<circle class="wm-hypha wm-b" cx="7.5" cy="7.5" r="1.6" opacity=".45"/>` +
      `<circle class="wm-hypha wm-b" cx="24.5" cy="7.5" r="1.6" opacity=".45"/>` +
      `<circle class="wm-hypha wm-b" cx="7.5" cy="24.5" r="1.6" opacity=".45"/>` +
      `<circle class="wm-hypha wm-b" cx="24.5" cy="24.5" r="1.6" opacity=".45"/>` +
      `<path class="wm-core wm-g" d="M16 6.5 L25.5 16 L16 25.5 L6.5 16 Z"/>` +
      `</g></g>`,
    // The ring is the bloom's full extent; the filled hexagon grows from a
    // point to the ring and back on a triangle wave, the glyph ladder made
    // continuous.
    hexbloom: () =>
      `<polygon class="wm-ring wm-bs" points="${hex(16, 16, 11)}" fill="none" stroke-width="1.75" opacity=".7"/>` +
      `<polygon class="wm-bloom wm-g" points="${hex(16, 16, 6)}"/>`,
    // Ring, blade ring, pupil. The pupil steps rather than glides: six clicks
    // per cycle, the way the terminal walked its ladder.
    iris: () =>
      `<polygon class="wm-ring wm-bs" points="${hex(16, 16, 12)}" fill="none" stroke-width="1.75" opacity=".8"/>` +
      `<polygon class="wm-blade wm-gs" points="${hex(16, 16, 8.5)}" fill="none" stroke-width="1.25" opacity=".45"/>` +
      `<polygon class="wm-pupil wm-g" points="${hex(16, 16, 5)}"/>`,
    // Eight teeth on a ring, a half disc turning inside at a constant rate.
    // Constant tone, constant speed: machinery, not breath.
    meshwork: () => {
      let teeth = "";
      for (let k = 0; k < 8; k++) {
        const a = (Math.PI / 4) * k;
        const x1 = 16 + 11 * Math.cos(a), y1 = 16 + 11 * Math.sin(a);
        const x2 = 16 + 14 * Math.cos(a), y2 = 16 + 14 * Math.sin(a);
        teeth += `M${x1.toFixed(2)} ${y1.toFixed(2)} L${x2.toFixed(2)} ${y2.toFixed(2)} `;
      }
      return `<g class="wm-teeth"><circle class="wm-bs" cx="16" cy="16" r="11" fill="none" stroke-width="1.75"/>` +
        `<path class="wm-bs" d="${teeth.trim()}" fill="none" stroke-width="2.2"/></g>` +
        `<g class="wm-rotor"><path class="wm-disc wm-g" d="M16 7.5 A8.5 8.5 0 0 1 16 24.5 Z"/></g>` +
        `<circle class="wm-pin wm-a" cx="16" cy="16" r="1.75"/>`;
    },
    // Four corner triangles lit one at a time in the terminal's order (lower
    // right, lower left, upper left, upper right), alternating gold and blue,
    // over a faint square and its fold line.
    facet: () =>
      `<rect class="wm-bs" x="6" y="6" width="20" height="20" fill="none" stroke-width="1.25" opacity=".35"/>` +
      `<path class="wm-face wm-g" d="M6 26 L26 26 L26 6 Z" opacity="1"/>` +
      `<path class="wm-face wm-b" d="M6 6 L6 26 L26 26 Z" opacity="0"/>` +
      `<path class="wm-face wm-g" d="M6 6 L26 6 L6 26 Z" opacity="0"/>` +
      `<path class="wm-face wm-b" d="M6 6 L26 6 L26 26 Z" opacity="0"/>`,
    // A still centre, a thin orbit, one satellite going round once a second.
    convergent: () =>
      `<circle class="wm-orbit-ring wm-bs" cx="16" cy="16" r="11" fill="none" stroke-width="1.25" opacity=".55"/>` +
      `<circle class="wm-centre wm-g" cx="16" cy="16" r="3.25"/>` +
      `<g class="wm-orbit"><circle class="wm-sat wm-a" cx="16" cy="5" r="2.4"/></g>`,
    // Five bars; the head lights each in turn left to right and wraps. At
    // rest the head sits on the centre bar with its tail either side.
    meridian: () =>
      `<rect class="wm-bar wm-b" x="4.5" y="8" width="3" height="16" rx="1.5" opacity=".3"/>` +
      `<rect class="wm-bar wm-g" x="9.5" y="8" width="3" height="16" rx="1.5" opacity=".55"/>` +
      `<rect class="wm-bar wm-a" x="14.5" y="8" width="3" height="16" rx="1.5" opacity="1"/>` +
      `<rect class="wm-bar wm-g" x="19.5" y="8" width="3" height="16" rx="1.5" opacity=".55"/>` +
      `<rect class="wm-bar wm-b" x="24.5" y="8" width="3" height="16" rx="1.5" opacity=".3"/>`,
    // Two particles come in from the edges and land; the diamond lights on
    // landing, holds, and lets go for the next run in. At rest: assembled.
    coalesce: () =>
      `<path class="wm-core wm-g" d="M16 9 L23 16 L16 23 L9 16 Z"/>` +
      `<circle class="wm-particle wm-p-l wm-b" cx="6.5" cy="16" r="2"/>` +
      `<circle class="wm-particle wm-p-r wm-b" cx="25.5" cy="16" r="2"/>`,
  };

  function markSvg(id, opts) {
    opts = opts || {};
    const mark = BY_ID.get(String(id)) || MARKS[0];
    const state = STATES.has(opts.state) ? opts.state : "rest";
    const size = Number(opts.size) > 0 ? ` width="${Number(opts.size)}" height="${Number(opts.size)}"` : "";
    return `<svg class="wm-mark wm-${mark.id}" data-mark="${mark.id}" data-state="${state}" viewBox="0 0 32 32"${size}` +
      ` aria-hidden="true" focusable="false"><g class="wm-root">${DRAW[mark.id]()}</g>` +
      `<circle class="wm-halo wm-gs" cx="16" cy="16" r="13" fill="none" stroke-width="1.5" opacity="0"/></svg>`;
  }

  // FNV-1a over the id, folded into the eight. Deterministic and spread, so
  // two workers with neighbouring ids do not walk the list in order.
  function hashMark(id) {
    let h = 0x811c9dc5;
    const s = String(id || "");
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return MARK_IDS[h % MARK_IDS.length];
  }

  function markFor(worker) {
    if (typeof worker === "string") return hashMark(worker);
    const explicit = worker && String(worker.mark || "");
    if (explicit && BY_ID.has(explicit)) return explicit;
    return hashMark(worker && (worker.id || worker.agentId || worker.name));
  }

  const svgOf = (el) => (!el ? null : el.matches && el.matches("svg.wm-mark") ? el : el.querySelector ? el.querySelector("svg.wm-mark") : null);

  // `done` plays once and settles to rest. Re-applying done restarts it: the
  // state is dropped to rest first so the animation has a fresh start.
  function setMarkState(el, state) {
    const svg = svgOf(el);
    if (!svg) return null;
    const next = STATES.has(state) ? state : "rest";
    if (next === "done") {
      svg.dataset.state = "rest";
      void svg.getBoundingClientRect();
      svg.dataset.state = "done";
      const stamp = String(Date.now());
      svg.dataset.doneAt = stamp;
      setTimeout(() => { if (svg.dataset.state === "done" && svg.dataset.doneAt === stamp) svg.dataset.state = "rest"; }, DONE_MS + 80);
      return svg;
    }
    svg.dataset.state = next;
    return svg;
  }

  function mount(host, worker, opts) {
    opts = opts || {};
    if (!host) return null;
    host.classList.add("wm-host");
    let id = markFor(worker);
    host.innerHTML = markSvg(id, { state: opts.state || "rest", size: opts.size });
    host.dataset.mark = id;
    const handle = {
      el: host,
      get svg() { return svgOf(host); },
      get id() { return id; },
      setState: (s) => setMarkState(host, s),
      done: () => setMarkState(host, "done"),
      rest: () => setMarkState(host, "rest"),
      // Kept for parity with CroweMark.mount: a tool landing is not a state
      // of these marks, so a ping does nothing here.
      ping: () => {},
      // Swap to another worker's mark and keep the current state, for an
      // avatar whose turn is routed to a different expert mid run.
      retarget: (w) => {
        const nextId = markFor(w);
        if (nextId === id) return handle;
        const cur = svgOf(host);
        const state = cur ? cur.dataset.state : "rest";
        id = nextId;
        host.innerHTML = markSvg(id, { state: state === "done" ? "rest" : state, size: opts.size });
        host.dataset.mark = id;
        return handle;
      },
    };
    return handle;
  }

  return { MARKS, MARK_IDS, markSvg, markFor, setMarkState, mount };
});
