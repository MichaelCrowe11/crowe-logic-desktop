// Behavioural tests for the modular workspace panel system.
//
//   npm test
//
// The renderer is a single classic script that wires ~100 elements at load, so
// it cannot be imported into a bare node:test process. These tests instead run
// against the real renderer inside Electron, using renderer/preview.html, which
// loads preview-shim.js to stub the window.crowe bridge. That gives a real DOM
// and the real code path, and needs no extra dependencies.
//
// Scope is deliberately the panel system: add, close, focus, reorder, layout
// visibility, dock tabs, and persistence. That is the most stateful code in the
// renderer, and the place where a regression is least likely to be visible in
// scripts/smoke-shot.js, which asserts that panels mount rather than that they
// behave.
//
// Requires the preview server. Started automatically unless PREVIEW_URL is set.

const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = process.env.PREVIEW_PORT || "8743";
const URL = process.env.PREVIEW_URL || `http://127.0.0.1:${PORT}/renderer/preview.html`;

let server = null;

function startServer() {
  server = spawn("python3", ["-m", "http.server", PORT, "--directory", ROOT], { stdio: "ignore" });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    (function poll() {
      fetch(URL).then(resolve).catch(() => {
        if (Date.now() > deadline) reject(new Error("preview server did not start"));
        else setTimeout(poll, 150);
      });
    })();
  });
}

// Each test body is evaluated in the page. `reset` gives it a clean deck so
// tests cannot leak panel state into each other.
const PRELUDE = `
  window.__reset = async (layout) => {
    for (const p of [...panels]) closePanel(p.id);
    $("panel-layout").value = layout || "stack";
    panelDeck.className = "panel-deck " + (layout || "stack");
    activePanelId = null;
    activeLegacy = null;
    localStorage.removeItem("crowe-workspace-panels");
    applyStackVisibility();
    renderDockTabs();
  };
  window.__ids = () => panels.map((p) => p.id);
  window.__visible = () => [...panelDeck.querySelectorAll(".workspace-panel.stack-active")].length;
  window.__tabs = () => [...panelDeck.parentNode.querySelectorAll(".dock-tab.panel-tab")];
  true;
`;

const tests = [
  {
    name: "addPanel appends a panel and makes it active",
    body: `await __reset();
      const a = await addPanel("operator");
      const b = await addPanel("operator");
      return { count: panels.length, active: activePanelId === b.id, order: __ids().indexOf(a.id) === 0 };`,
    expect: { count: 2, active: true, order: true },
  },
  {
    name: "addPanel honours a seeded id, title and url",
    body: `await __reset();
      const p = await addPanel("browser", { id: "seed-1", title: "Docs", url: "https://example.com/x" });
      return { id: p.id, title: p.title, url: p.url };`,
    expect: { id: "seed-1", title: "Docs", url: "https://example.com/x" },
  },
  {
    name: "closePanel removes the panel and its element",
    body: `await __reset();
      const a = await addPanel("operator");
      await addPanel("operator");
      closePanel(a.id);
      return { count: panels.length, gone: !panelDeck.querySelector('[data-id="' + a.id + '"]') };`,
    expect: { count: 1, gone: true },
  },
  {
    name: "closing the active panel promotes a neighbour",
    body: `await __reset();
      const a = await addPanel("operator");
      const b = await addPanel("operator");
      const c = await addPanel("operator");
      focusPanel(b.id);
      closePanel(b.id);
      return { active: activePanelId === c.id, alive: panels.length === 2, hasA: __ids().includes(a.id) };`,
    expect: { active: true, alive: true, hasA: true },
  },
  {
    name: "closing the last panel clears the active id",
    body: `await __reset();
      const a = await addPanel("operator");
      closePanel(a.id);
      return { count: panels.length, active: activePanelId };`,
    expect: { count: 0, active: null },
  },
  {
    name: "closePanel ignores an unknown id",
    body: `await __reset();
      await addPanel("operator");
      closePanel("does-not-exist");
      return { count: panels.length };`,
    expect: { count: 1 },
  },
  {
    name: "stack layout shows exactly one panel",
    body: `await __reset("stack");
      await addPanel("operator"); await addPanel("operator"); await addPanel("operator");
      applyStackVisibility();
      return { visible: __visible(), total: panels.length };`,
    expect: { visible: 1, total: 3 },
  },
  {
    name: "columns layout shows every panel",
    body: `await __reset("columns");
      await addPanel("operator"); await addPanel("operator"); await addPanel("operator");
      applyStackVisibility();
      return { visible: __visible() };`,
    expect: { visible: 3 },
  },
  {
    name: "focusPanel swaps which panel is visible in stack",
    body: `await __reset("stack");
      const a = await addPanel("operator");
      await addPanel("operator");
      focusPanel(a.id);
      const el = panelDeck.querySelector('[data-id="' + a.id + '"]');
      return { visible: __visible(), shown: el.classList.contains("stack-active"), active: activePanelId === a.id };`,
    expect: { visible: 1, shown: true, active: true },
  },
  {
    name: "a stale active id falls back to the last panel",
    body: `await __reset("stack");
      await addPanel("operator");
      const b = await addPanel("operator");
      activePanelId = "ghost";
      applyStackVisibility();
      return { active: activePanelId === b.id, visible: __visible() };`,
    expect: { active: true, visible: 1 },
  },
  {
    name: "dock renders one tab per panel and marks the active one",
    body: `await __reset();
      await addPanel("operator");
      const b = await addPanel("operator");
      focusPanel(b.id);
      const tabs = __tabs();
      const current = tabs.filter((t) => t.getAttribute("aria-current") === "true");
      return { tabs: tabs.length, current: current.length, currentIsB: current[0] && current[0].dataset.id === b.id };`,
    expect: { tabs: 2, current: 1, currentIsB: true },
  },
  {
    name: "renaming a panel retitles its dock tab",
    body: `await __reset();
      const a = await addPanel("operator");
      const input = panelDeck.querySelector('[data-id="' + a.id + '"] .panel-title');
      input.value = "Renamed";
      input.dispatchEvent(new Event("change"));
      const tab = __tabs().find((t) => t.dataset.id === a.id);
      return { label: tab.querySelector(".dock-tab-label").textContent, model: panels[0].title };`,
    expect: { label: "Renamed", model: "Renamed" },
  },
  {
    name: "reorderPanel moves a panel and reorders the DOM",
    body: `await __reset("columns");
      const a = await addPanel("operator");
      const b = await addPanel("operator");
      const c = await addPanel("operator");
      reorderPanel(c.id, a.id);
      const dom = [...panelDeck.querySelectorAll(".workspace-panel")].map((e) => e.dataset.id);
      return { model: __ids().join(",") === [c.id, a.id, b.id].join(","), dom: dom.join(",") === __ids().join(",") };`,
    expect: { model: true, dom: true },
  },
  {
    name: "reorderPanel ignores unknown or identical ids",
    body: `await __reset();
      const a = await addPanel("operator");
      const b = await addPanel("operator");
      const before = __ids().join(",");
      reorderPanel(a.id, a.id); reorderPanel("nope", b.id); reorderPanel(a.id, "nope");
      return { unchanged: __ids().join(",") === before };`,
    expect: { unchanged: true },
  },
  {
    name: "duplicating a panel copies its url and history",
    body: `await __reset();
      const a = await addPanel("browser", { url: "https://example.com/a", history: ["https://example.com/a"] });
      panelDeck.querySelector('[data-id="' + a.id + '"] .panel-dup').click();
      await new Promise((r) => setTimeout(r, 120));
      const copy = panels[panels.length - 1];
      return { count: panels.length, url: copy.url, history: copy.history.length, distinct: copy.id !== a.id,
               sharedRef: copy.history === a.history };`,
    expect: { count: 2, url: "https://example.com/a", history: 1, distinct: true, sharedRef: false },
  },
  {
    name: "panel state persists to localStorage",
    body: `await __reset("columns");
      await addPanel("browser", { url: "https://example.com/p" });
      const raw = JSON.parse(localStorage.getItem("crowe-workspace-panels"));
      return { layout: raw.layout, count: raw.panels.length, type: raw.panels[0].type, url: raw.panels[0].url };`,
    expect: { layout: "columns", count: 1, type: "browser", url: "https://example.com/p" },
  },
  {
    name: "applyPanelState restores a saved deck",
    body: `await __reset();
      await applyPanelState({ layout: "columns", panels: [
        { type: "browser", title: "One", url: "https://example.com/1" },
        { type: "operator", title: "Two" } ] });
      return { count: panels.length, layout: $("panel-layout").value,
               titles: panels.map((p) => p.title).join(","), deck: panelDeck.className.includes("columns") };`,
    expect: { count: 2, layout: "columns", titles: "One,Two", deck: true },
  },
  {
    name: "applyPanelState with no panels falls back to a terminal",
    body: `await __reset();
      await applyPanelState({ layout: "stack", panels: [] });
      return { count: panels.length, type: panels[0].type };`,
    expect: { count: 1, type: "terminal" },
  },
  {
    // Regression: showPane("term") looked for a panel of type "term", never
    // matched, and fell through addPanel's type chain to mount the operator.
    name: 'showPane("term") focuses a terminal, not an operator',
    body: `await __reset();
      showPane("term");
      await new Promise((r) => setTimeout(r, 250));
      return { count: panels.length, type: panels[0] && panels[0].type };`,
    expect: { count: 1, type: "terminal" },
  },
  {
    name: "showPane reuses an existing panel instead of stacking duplicates",
    body: `await __reset();
      const a = await addPanel("browser");
      showPane("browser");
      await new Promise((r) => setTimeout(r, 200));
      return { count: panels.length, active: activePanelId === a.id };`,
    expect: { count: 1, active: true },
  },
  {
    name: "a legacy pane hides the deck and drops the active tab",
    body: `await __reset();
      const a = await addPanel("operator");
      focusPanel(a.id);
      showPane("files");
      const current = __tabs().filter((t) => t.getAttribute("aria-current") === "true");
      return { legacy: activeLegacy, hidden: panelDeck.style.display === "none", current: current.length };`,
    expect: { legacy: "files", hidden: true, current: 0 },
  },
  {
    name: "adding a panel leaves a legacy pane and shows the deck again",
    body: `await __reset();
      showPane("files");
      await addPanel("operator");
      return { legacy: activeLegacy, shown: panelDeck.style.display !== "none", visible: __visible() };`,
    expect: { legacy: null, shown: true, visible: 1 },
  },
  {
    name: "panel ids stay unique across rapid creation",
    body: `await __reset();
      for (let i = 0; i < 8; i++) await addPanel("operator");
      return { count: panels.length, unique: new Set(__ids()).size };`,
    expect: { count: 8, unique: 8 },
  },
  {
    name: "the sidebar collapses to zero width and restores",
    body: `const settle = async () => {
        let last = -1, same = 0;
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => requestAnimationFrame(r));
          const w = Math.round($("sidebar").getBoundingClientRect().width);
          same = w === last ? same + 1 : 0;
          last = w;
          if (same >= 3) break;
        }
        return last;
      };
      applySidebarCollapsed(false);
      const open = await settle();
      applySidebarCollapsed(true);
      const shut = await settle();
      const flag = localStorage.getItem("crowe-sidebar");
      const aria = $("sidebar-toggle").getAttribute("aria-expanded");
      applySidebarCollapsed(false);
      const back = await settle();
      return { opened: open > 200, shut, flag, aria, restored: back === open };`,
    expect: { opened: true, shut: 0, flag: "collapsed", aria: "false", restored: true },
  },
  {
    name: "the terminal repaints when the theme flips",
    body: `await __reset();
      await addPanel("terminal");
      const t = [...terminalPanels.values()][0].term;
      applyTheme(true);
      const dark = t.options.theme.background;
      applyTheme(false);
      const light = t.options.theme.background;
      applyTheme(true);
      return { changed: dark !== light, darkIsDark: dark.toLowerCase() === "#0b0e12" };`,
    expect: { changed: true, darkIsDark: true },
  },
];

function compare(actual, expected) {
  const bad = [];
  for (const key of Object.keys(expected)) {
    const a = actual ? actual[key] : undefined;
    if (a !== expected[key]) bad.push(`${key}: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(a)}`);
  }
  return bad;
}

// preview-shim.js hand-stubs the preload bridge, so it drifts silently: a
// namespace preload gained but the shim lacks throws only when a panel happens
// to call it. Read the namespaces preload exposes and require the shim to have
// them all.
function preloadNamespaces() {
  const src = require("fs").readFileSync(path.join(ROOT, "preload.js"), "utf8");
  const body = src.match(/exposeInMainWorld\([^,]+,\s*\{([\s\S]*)\}\s*\)/);
  if (!body) throw new Error("could not parse preload.js");
  const names = [];
  let depth = 0;
  for (const line of body[1].split("\n")) {
    if (depth === 0) {
      const key = line.trim().match(/^([a-zA-Z_$][\w$]*)\s*:/);
      if (key) names.push(key[1]);
    }
    depth += (line.match(/[{([]/g) || []).length - (line.match(/[})\]]/g) || []).length;
  }
  return names;
}

app.whenReady().then(async () => {
  let failures = 0;
  try {
    if (!process.env.PREVIEW_URL) await startServer();
    const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { webviewTag: true } });
    const pageErrors = [];
    win.webContents.on("console-message", (_e, level, message) => {
      if (level >= 2 && !/Security Warning/.test(message)) pageErrors.push(message);
    });
    await win.loadURL(URL + "?t=" + Date.now());
    await new Promise((r) => setTimeout(r, 3000));
    await win.webContents.executeJavaScript(PRELUDE);

    for (const t of tests) {
      let bad;
      try {
        const actual = await win.webContents.executeJavaScript(`(async () => { ${t.body} })()`);
        bad = compare(actual, t.expect);
      } catch (error) {
        bad = [`threw: ${error && error.message ? error.message : error}`];
      }
      if (bad.length) {
        failures++;
        console.log(`not ok  ${t.name}`);
        bad.forEach((b) => console.log(`        ${b}`));
      } else {
        console.log(`ok      ${t.name}`);
      }
    }

    const want = preloadNamespaces();
    const have = await win.webContents.executeJavaScript("Object.keys(window.crowe)");
    const missing = want.filter((k) => !have.includes(k));
    if (missing.length) {
      failures++;
      console.log("not ok  preview shim covers every preload namespace");
      console.log(`        missing from preview-shim.js: ${missing.join(", ")}`);
    } else {
      console.log("ok      preview shim covers every preload namespace");
    }

    if (pageErrors.length) {
      failures++;
      console.log("not ok  renderer logged no console errors");
      pageErrors.slice(0, 5).forEach((e) => console.log(`        ${e.split("\n")[0]}`));
    } else {
      console.log("ok      renderer logged no console errors");
    }

    const total = tests.length + 2;
    console.log(`\n${total - failures}/${total} passed`);
  } catch (error) {
    failures++;
    console.error("harness error:", error && error.stack ? error.stack : error);
  } finally {
    if (server) server.kill();
    app.exit(failures ? 1 : 0);
  }
});
