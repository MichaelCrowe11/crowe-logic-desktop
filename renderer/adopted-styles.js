"use strict";

/* Styles that script writes, under a CSP that forbids inline styles.

   style-src is 'self' plus the hash of an empty style element, and nothing
   else: no 'unsafe-inline', no nonce, no hash of any real rule. That closes
   the classic CSS-injection foothold (an attacker who can land markup in the
   document cannot land a stylesheet with it), and scripts/test-electron-
   security.js holds the line. It also means a <style> element that script
   fills at runtime is dropped by the browser with a console error, however
   trusted the script that wrote it. Two things in this app do exactly that:

   - xterm's DOM renderer writes its theme, row and dimension rules into
     <style> elements it creates itself; without them the console has no
     colours, no cell geometry, no cursor.
   - the motion logotype ships its choreography as a <style> block inside the
     SVG (assets/wordmark-motion.svg), inlined by renderer.js.

   The CSS Object Model is exempt from style-src by design: a constructed
   CSSStyleSheet adopted by the document can only be created by script that
   is already running, and script-src governs that. So this file gives the
   page two things, both loaded before any other script:

   croweAdoptStyle(cssText)
     Adopts a stylesheet built from the text, once per distinct text. The
     logotype inliner hands it the SVG's <style> content and inserts the SVG
     without the block.

   a redirect on document.createElement("style")
     The element xterm gets back is a real, empty <style>. Whatever it writes
     to textContent / innerHTML / innerText lands in a constructed sheet that
     is adopted while the element carries text, and released when the element
     is removed or emptied. The element itself stays empty, which is what the
     one hash in style-src permits, so nothing is blocked and nothing is
     logged. Markup-injected <style> tags never pass through createElement and
     stay blocked, which is the point.

   Runs in every shell: desktop (index.html), web (app.html) and the phone
   bundle (mobile/scripts/build-www.js copies it). Where constructed sheets
   are missing it does nothing, and renderer.js falls back to inline styles,
   which those environments do not police. */
(() => {
  const supported = typeof CSSStyleSheet === "function"
    && typeof CSSStyleSheet.prototype.replaceSync === "function"
    && Array.isArray(document.adoptedStyleSheets);

  function adoptSheet(sheet) {
    if (!document.adoptedStyleSheets.includes(sheet)) {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }
  }
  function releaseSheet(sheet) {
    if (document.adoptedStyleSheets.includes(sheet)) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    }
  }

  // ── croweAdoptStyle ──
  const byText = new Map();
  function croweAdoptStyle(css) {
    const text = String(css == null ? "" : css);
    if (!text.trim()) return null;
    if (byText.has(text)) return byText.get(text);
    if (!supported) return null;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    adoptSheet(sheet);
    byText.set(text, sheet);
    return sheet;
  }

  // ── the createElement("style") redirect ──
  // sheet -> its placeholder element, so a placeholder that left the document
  // by any route (removeChild, replaceChildren, a parent being torn down) has
  // its sheet released the next time any redirected style is written. The
  // common route, element.remove(), releases immediately.
  const placeholders = new Map();
  function prune() {
    for (const [sheet, el] of placeholders) {
      if (!el.isConnected) { releaseSheet(sheet); placeholders.delete(sheet); }
    }
  }
  function redirect(el) {
    const sheet = new CSSStyleSheet();
    let text = "";
    const write = (value) => {
      text = value == null ? "" : String(value);
      try { sheet.replaceSync(text); } catch { sheet.replaceSync(""); }
      prune();
      if (text.trim()) { placeholders.set(sheet, el); adoptSheet(sheet); }
      else { placeholders.delete(sheet); releaseSheet(sheet); }
    };
    for (const key of ["textContent", "innerHTML", "innerText"]) {
      Object.defineProperty(el, key, { configurable: true, enumerable: true, get: () => text, set: write });
    }
    Object.defineProperty(el, "remove", {
      configurable: true, writable: true,
      value() { placeholders.delete(sheet); releaseSheet(sheet); Element.prototype.remove.call(this); },
    });
    // The constructed sheet is the one that applies; hand it to anyone who
    // asks the element for its sheet, which is where its rules actually live.
    Object.defineProperty(el, "sheet", { configurable: true, get: () => sheet });
  }
  if (supported) {
    const create = Document.prototype.createElement;
    Document.prototype.createElement = function createElement(name, ...rest) {
      const el = create.call(this, name, ...rest);
      if (this === document && String(name).toLowerCase() === "style") redirect(el);
      return el;
    };
  }

  Object.defineProperty(window, "croweAdoptStyle", { value: croweAdoptStyle, configurable: false, writable: false });
  Object.defineProperty(window, "croweAdoptedStylesActive", { value: supported, configurable: false, writable: false });
})();
