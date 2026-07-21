// Crowe Logic living mark — the single source of the app's identity.
// A hexagonal rotor built from the brand hex (6-fold, blue + gold). It breathes,
// blooms to a clean six-point star, flares on reasoning, and pulses a ring on
// each tool call. A shared metamorphosis engine drifts the palette across the
// brand family and writes it to :root living tokens, so every mark in the app
// evolves in unison. Structural UI keeps its fixed brand tokens; only marks and
// mark-adjacent accents read the living tokens.
//
// window.CroweMark:
//   svg()                     -> SVG markup string
//   mount(el, {state})        -> { el, setState(s), ping(), rest() }
//   setState(el, state)       -> 'idle' | 'reasoning' | 'rest'
//   ping(el)                  -> one-shot tool ring
//   start() / stop()          -> metamorphosis engine (auto-starts on first mount)
(function () {
  "use strict";

  // Palette family, theme-aware. Each entry: [blue, blueHot, gold, goldHot, ring].
  const DARK = [
    ["#0d5bc0", "#4d9fe8", "#c9a227", "#e0c15a", "#d4af37"], // signature
    ["#06337e", "#2f78e0", "#e8a52a", "#ffc24d", "#ffb347"], // ember
    ["#1566d6", "#5cc0ff", "#f0c24a", "#ffe08a", "#7fd0ff"], // electric
    ["#16276e", "#4d6fd6", "#d4af37", "#f4de8f", "#d4af37"], // regal
  ];
  const LIGHT = [
    ["#0054b2", "#2f7fd6", "#b7791f", "#c9a227", "#b7791f"], // signature (editorial)
    ["#16276e", "#3f63c8", "#a9781f", "#d4af37", "#a9781f"], // regal (editorial)
  ];
  const KEYS = ["--cl-blue", "--cl-bluehot", "--cl-gold", "--cl-goldhot", "--cl-ring"];
  const PERIOD_MS = 60000; // one full lap through the family; deliberately slow.

  function hx(h) { h = h.replace("#", ""); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function tx(a) { return "#" + a.map((v) => { const s = Math.max(0, Math.min(255, Math.round(v))).toString(16); return s.length < 2 ? "0" + s : s; }).join(""); }
  function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function isDark() { return document.body.classList.contains("dark"); }
  function reduced() { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } }

  function svg() {
    const cx = 60, cy = 60;
    const line = (angle, r0, r1, w, col, cls) => {
      const a = (angle - 90) * Math.PI / 180;
      const x1 = (cx + Math.cos(a) * r0).toFixed(2), y1 = (cy + Math.sin(a) * r0).toFixed(2);
      const x2 = (cx + Math.cos(a) * r1).toFixed(2), y2 = (cy + Math.sin(a) * r1).toFixed(2);
      const delay = (angle / 360 * -1.75).toFixed(2);
      return `<line class="cl-arm ${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="${w}" stroke-linecap="round" style="animation-delay:${delay}s"/>`;
    };
    let blueArms = "", goldArms = "";
    for (let i = 0; i < 6; i++) blueArms += line(i * 60, 14, 42, 6, "var(--cl-blue)", "cl-blue-arm");
    for (let i = 0; i < 6; i++) goldArms += line(30 + i * 60, 12, 29, 4.5, "var(--cl-gold)", "cl-gold-arm");
    const hex = [], ring = [];
    for (let i = 0; i < 6; i++) { const a = (i * 60 - 90) * Math.PI / 180; hex.push(`${(cx + Math.cos(a) * 13).toFixed(1)},${(cy + Math.sin(a) * 13).toFixed(1)}`); }
    for (let i = 0; i < 6; i++) { const a = (i * 60 - 90) * Math.PI / 180; ring.push(`${(cx + Math.cos(a) * 46).toFixed(1)},${(cy + Math.sin(a) * 46).toFixed(1)}`); }
    return `<svg class="cl-mk" viewBox="0 0 120 120" aria-hidden="true">`
      + `<polygon class="cl-ping" points="${ring.join(" ")}" fill="none" stroke="var(--cl-ring)" stroke-width="2"/>`
      + `<g class="cl-rotor"><g class="cl-breath">${goldArms}${blueArms}`
      + `<g class="cl-core"><polygon class="cl-heart" points="${hex.join(" ")}" fill="var(--cl-blue)"/>`
      + `<polygon points="${hex.join(" ")}" fill="none" stroke="var(--cl-goldhot)" stroke-width="1.5"/>`
      + `<circle cx="${cx}" cy="${cy}" r="4.2" fill="var(--cl-gold)"/></g>`
      + `</g></g></svg>`;
  }

  function ping(el) { if (!el) return; el.classList.remove("cl-ping-on"); void el.offsetWidth; el.classList.add("cl-ping-on"); }

  // ── Metamorphosis engine ──────────────────────────────────────────────────
  // The palette drifts through the brand family only WHILE the app is thinking,
  // then settles. Reasoning marks acquire the engine; when the last one rests it
  // stops, holding the palette where it landed. Ref-counted so overlapping runs
  // keep it alive, and paused when the window is hidden to spare battery.
  let rafId = null, t0 = null, elapsed = 0, active = 0;
  // Tokens are written to <body>, not <html>: the theme system declares the
  // dark palette on `body.dark`, so an inline value on <html> would be shadowed
  // for every descendant. An inline value on <body> overrides both.
  function writeStatic() {
    const p = (isDark() ? DARK : LIGHT)[0];
    KEYS.forEach((k, i) => document.body.style.setProperty(k, p[i]));
  }
  function frame(ts) {
    if (t0 === null) t0 = ts;
    const now = elapsed + (ts - t0);
    const pals = isDark() ? DARK : LIGHT;
    const seg = (now / PERIOD_MS * pals.length) % pals.length;
    const i = Math.floor(seg), f = seg - i, ease = (1 - Math.cos(f * Math.PI)) / 2;
    const A = pals[i], B = pals[(i + 1) % pals.length];
    KEYS.forEach((k, idx) => document.body.style.setProperty(k, tx(lerp(hx(A[idx]), hx(B[idx]), ease))));
    rafId = requestAnimationFrame(frame);
  }
  function run() { if (rafId === null && !reduced() && !document.hidden) { t0 = null; rafId = requestAnimationFrame(frame); } }
  function pause() { if (rafId !== null) { if (t0 !== null) elapsed += performance.now() - t0; cancelAnimationFrame(rafId); rafId = null; t0 = null; } }
  function acquire() { active += 1; run(); }
  function release() { active = Math.max(0, active - 1); if (active === 0) pause(); }
  document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); else if (active > 0) run(); });

  function setState(el, state) {
    if (!el) return;
    const was = el.dataset.state;
    el.dataset.state = state;
    if (state === "reasoning" && was !== "reasoning") acquire();
    else if (state !== "reasoning" && was === "reasoning") release();
  }

  function mount(el, opts) {
    opts = opts || {};
    el.classList.add("cl-mark");
    el.innerHTML = svg();
    setState(el, opts.state || "rest");
    return {
      el,
      setState: (s) => setState(el, s),
      ping: () => ping(el),
      rest: () => setState(el, "rest"),
    };
  }

  window.addEventListener("DOMContentLoaded", writeStatic);
  writeStatic();

  window.CroweMark = { svg, mount, setState, ping, start: run, stop: pause, reseed: writeStatic };
})();
