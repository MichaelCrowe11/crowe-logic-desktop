/* The native tab bar, mirrored from the web one.
 *
 * mobile-ui.js still builds #m-tabs and owns what each tab does. When the app
 * runs inside the iOS shell with the CroweChrome plugin, this file hands the
 * same tabs to a UITabBar (SF Symbols, Liquid Glass on iOS 26), keeps its
 * selection in step with aria-current, and turns a native tap into a click on
 * the matching web tab. The web bar stays in the layout as an empty spacer of
 * the native bar's height, so nothing scrolls under it. Anywhere else (the
 * browser build, the shell tests, an older binary) the plugin is absent and
 * this file does nothing. */
(() => {
  const cap = window.Capacitor;
  const chrome = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.CroweChrome;
  const tabs = document.getElementById("m-tabs");
  if (!chrome || !tabs) return;
  const body = document.body;

  // SF Symbols for the tabs mobile-ui.js can build; anything new falls back to a circle.
  const SYMBOL = { home: "house", chat: "bubble.left", messages: "bubble.left.and.bubble.right", camera: "camera", workspace: "rectangle.split.2x1", playground: "sparkles", cultivation: "leaf" };

  const read = () => [...tabs.querySelectorAll(".m-tab")].map((t) => ({
    id: t.dataset.id, label: (t.textContent || "").trim(), symbol: SYMBOL[t.dataset.id] || "circle", current: t.getAttribute("aria-current") === "true",
  }));

  // The brand accent for the selected tab, resolved by the browser so light
  // and dark themes each hand over their own brass.
  const probe = document.createElement("i");
  probe.style.cssText = "position:absolute;width:0;height:0;color:var(--gold-text)";
  body.appendChild(probe);
  const tint = () => (getComputedStyle(probe).color.match(/\d+(\.\d+)?/g) || []).slice(0, 3).join(",");

  /* What the native bar is known to show. Written only after the bridge call
     that put it there resolved: a rejected setTabs used to leave `shape`
     claiming a bar that was never drawn, and nothing ever tried again. */
  let shape = "", current = null, hidden = null;
  const setHeight = (h) => { if (h > 0) body.style.setProperty("--native-tab-h", Math.round(h) + "px"); };
  // Until the native bar has drawn once, the web bar is the navigation. A
  // failure after that hands the job back to it rather than leaving a spacer
  // over nothing.
  const fallBack = () => { shape = ""; current = null; body.classList.remove("native-tabs"); };

  async function syncOnce() {
    const items = read();
    const nextShape = items.map((i) => i.id + ":" + i.label).join("|") + "#" + tint();
    const now = (items.find((i) => i.current) || {}).id || null;
    if (nextShape !== shape) {
      try {
        const r = await chrome.setTabs({ items: items.map(({ id, label, symbol }) => ({ id, label, symbol })), current: now || undefined, tint: tint() });
        shape = nextShape; current = now;
        if (r) setHeight(r.height);
        body.classList.add("native-tabs");
      } catch (e) { fallBack(); throw e; }
    } else if (now !== current) {
      await chrome.setCurrent({ id: now || "" });
      current = now;
    }
    const wantHidden = body.classList.contains("kb-open");
    if (wantHidden !== hidden) { await chrome.setHidden({ hidden: wantHidden }); hidden = wantHidden; }
  }

  /* One sync in flight at a time. Observers fire in bursts (a tab tap changes
     aria-current, the pane class and the tab list together) and overlapping
     bridge calls can land out of order, so a later state was sometimes
     overwritten by an earlier one. A request during a run marks it dirty and
     the run goes round again with whatever the DOM says by then. */
  let running = null, dirty = false, failures = 0;
  function sync() {
    dirty = true;
    if (running) return running;
    running = (async () => {
      try {
        while (dirty) { dirty = false; await syncOnce(); }
        failures = 0;
      } catch {
        // Retried with backoff a few times, then left to the next DOM change.
        if (++failures <= 3) setTimeout(sync, 250 * 2 ** failures);
      } finally { running = null; }
    })();
    return running;
  }

  chrome.addListener("tabSelected", ({ id }) => {
    const tab = tabs.querySelector(`.m-tab[data-id="${CSS.escape(id)}"]`);
    if (tab) tab.click();
    // The web tab may decline (or land on a different pane); the native bar was
    // already moved by the tap, so forget what it shows and re-assert the DOM.
    current = undefined;
    setTimeout(sync, 0);
  });
  // Rotation, a size-class change or a new safe-area inset changes the bar's
  // height without any call from here; the spacer follows it.
  Promise.resolve(chrome.addListener("geometry", ({ height }) => setHeight(height))).catch(() => {});

  // The keyboard is the toolbar while it is up, as it is for the web bar.
  new MutationObserver(sync).observe(body, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(sync).observe(tabs, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-current"] });
  // Theme changes move the brass, which is part of the shape.
  if (window.matchMedia) matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => setTimeout(sync, 0));
  sync();

  // A light tick on the moments that land: a sent message and a finished reply.
  window.croweHaptic = (style) => { chrome.haptic({ style: style || "selection" }).catch(() => {}); };
})();
