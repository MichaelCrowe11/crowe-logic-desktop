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

  let shape = "", current = null;
  async function sync() {
    const items = read();
    const nextShape = items.map((i) => i.id + ":" + i.label).join("|") + "#" + tint();
    const now = (items.find((i) => i.current) || {}).id || null;
    if (nextShape !== shape) {
      shape = nextShape; current = now;
      const r = await chrome.setTabs({ items: items.map(({ id, label, symbol }) => ({ id, label, symbol })), current: now || undefined, tint: tint() });
      if (r && r.height) body.style.setProperty("--native-tab-h", Math.round(r.height) + "px");
      body.classList.add("native-tabs");
    } else if (now !== current) {
      current = now;
      await chrome.setCurrent({ id: now || "" });
    }
  }

  chrome.addListener("tabSelected", ({ id }) => {
    const tab = tabs.querySelector(`.m-tab[data-id="${CSS.escape(id)}"]`);
    if (tab) tab.click();
    // The web tab may decline (or land on a different pane); re-read either way.
    setTimeout(() => sync().catch(() => {}), 0);
  });

  // The keyboard is the toolbar while it is up, as it is for the web bar.
  new MutationObserver(() => { chrome.setHidden({ hidden: body.classList.contains("kb-open") }).catch(() => {}); sync().catch(() => {}); })
    .observe(body, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(() => sync().catch(() => {}))
    .observe(tabs, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-current"] });
  sync().catch(() => {});

  // A light tick on the moments that land: a sent message and a finished reply.
  window.croweHaptic = (style) => { chrome.haptic({ style: style || "selection" }).catch(() => {}); };
})();
