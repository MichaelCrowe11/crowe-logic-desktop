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
// Serves the checkout itself on an ephemeral port unless PREVIEW_URL is set.

const { app, BrowserWindow } = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");

let server = null;

// This used to spawn `python3 -m http.server` on a fixed port. If something was
// already listening there - an orphan from a killed run, a second checkout, the
// `npm run preview` server - python exited with "address already in use" into a
// discarded stdio, the readiness poll got a 200 from the stranger, and the suite
// tested that stranger's files while reporting on this one's. It cost an hour of
// chasing a watermark failure in a worktree whose CSS was never being loaded.
//
// So: serve in-process on an ephemeral port. There is no port to collide with,
// nothing to leave orphaned, and the files served are this ROOT by construction.
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2",
};

function startServer() {
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    const file = path.join(ROOT, rel);
    // Climbing out of ROOT is the same defect the fixed port was: it would serve
    // bytes this checkout does not control.
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return res.writeHead(403).end();
    fs.readFile(file, (err, buf) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${server.address().port}/renderer/preview.html`));
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

  // Workbench helpers. __stubAgent swaps the bridge for a recorder so a run is
  // deterministic and the synthesis prompt can be inspected; the real shim
  // streams a scripted transcript that would make the assertions timing-bound.
  window.__workbench = async () => {
    const p = await addPanel("workbench");
    return panelDeck.querySelector('[data-id="' + p.id + '"]');
  };
  window.__mode = (el, mode, branches) => {
    el.querySelector(".awb-mode").value = mode;
    if (branches) el.querySelector(".awb-branches").value = String(branches);
    el.querySelector(".awb-mode").onchange();
  };
  window.__stubAgent = () => {
    const calls = [];
    window.crowe.agent.run = async (messages, id) => {
      const content = messages[0].content;
      const merge = /Merge the drafts/.test(content);
      calls.push({ id, content, merge });
      return { done: true, text: merge ? "MERGED" : "draft:" + id };
    };
    return calls;
  };
  window.__settle = () => new Promise((r) => setTimeout(r, 400));

  // The space profile lives in localStorage, which survives the process. A run
  // that sets a profile and removes it again can still leave it on disk, because
  // Chromium flushes localStorage lazily and the harness calls app.exit as soon
  // as the last test reports. The leftover then reappears at init on the next
  // run and quietly narrows PROFILE, so a space test asks for Cultivation and
  // silently gets Chat. That failed roughly one run in five and passed every
  // time it was run alone, which is the worst way for a test to be wrong.
  //
  // installSpaces is the same hazard one level up: a test that stands up a
  // narrowed build and does not put it back leaves every later test running
  // against an install missing two spaces, and they fail somewhere unrelated.
  window.__resetSpaces = () => {
    localStorage.removeItem("crowe-spaces");
    localStorage.removeItem("crowe-space");
    window.crowe.installSpaces = null;
    applySpaceProfile();
    projLane = "home";
    cultLane = "home";
    setSpace("chat");
  };
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
      const darkTheme = { ...t.options.theme };
      applyTheme(false);
      const lightTheme = { ...t.options.theme };
      applyTheme(true);
      return {
        // The accent is the half of the theme the console does follow, so this
        // is what proves the flip re-read the variables rather than keeping a
        // stale theme object.
        cursorChanged: darkTheme.cursor !== lightTheme.cursor,
        selectionChanged: darkTheme.selectionBackground !== lightTheme.selectionBackground,
        // The terminal is a console surface in both themes: same near-black
        // ground, same text on it. Its foreground used to be a warm cream in
        // light and a cool white in dark, which tinted identical output two
        // different colours depending on a theme the console does not follow.
        // Read the tokens rather than pinning hexes - the point is that the two
        // themes agree, not what they agreed on.
        consoleStable:
          darkTheme.background === lightTheme.background &&
          darkTheme.foreground === lightTheme.foreground,
      };`,
    expect: { cursorChanged: true, selectionChanged: true, consoleStable: true },
  },
  {
    name: "shortcut hints match the platform modifier key",
    body: `const mac = /mac/i.test(navigator.userAgent);
      const labelled = [...document.querySelectorAll("[title], [placeholder]")]
        .flatMap((el) => ["title", "placeholder"].map((a) => el.getAttribute(a)))
        .filter((v) => v && /\\b(Cmd|Ctrl)\\+/.test(v));
      const wrong = labelled.filter((v) => (mac ? v.includes("Ctrl+") : v.includes("Cmd+")));
      return { found: labelled.length >= 3, wrong: wrong.length,
        binding: MOD_LABEL === (mac ? "Cmd" : "Ctrl") };`,
    expect: { found: true, wrong: 0, binding: true },
  },
  {
    name: "parallel mode lays out a synthesis card plus one card per branch",
    body: `await __reset();
      const el = await __workbench();
      __mode(el, "parallel", 4);
      const cards = [...el.querySelectorAll(".awb-results article")];
      return { cards: cards.length, first: cards[0].classList.contains("awb-synthesis"),
        onlyOneSynthesis: cards.filter((c) => c.classList.contains("awb-synthesis")).length,
        branchesShown: !el.querySelector(".awb-branch-field").classList.contains("hidden") };`,
    expect: { cards: 5, first: true, onlyOneSynthesis: 1, branchesShown: true },
  },
  {
    name: "parallel synthesis merges every branch draft into one answer",
    body: `await __reset();
      const el = await __workbench();
      const calls = __stubAgent();
      __mode(el, "parallel", 3);
      el.querySelector(".awb-prompt").value = "Plan the spring harvest";
      el.querySelector(".awb-run").click();
      await __settle();
      const merge = calls.find((c) => c.merge), drafts = calls.filter((c) => !c.merge);
      const cards = [...el.querySelectorAll(".awb-output")];
      return { total: calls.length, drafts: drafts.length,
        distinctLenses: new Set(drafts.map((c) => c.content)).size,
        sawEveryDraft: Boolean(merge) && drafts.every((c) => merge.content.includes("draft:" + c.id)),
        keptTheTask: Boolean(merge) && merge.content.includes("Plan the spring harvest"),
        synthesised: cards[0].textContent.includes("MERGED"),
        branchesRendered: cards.slice(1).every((c) => c.textContent.startsWith("draft:")) };`,
    expect: { total: 4, drafts: 3, distinctLenses: 3, sawEveryDraft: true,
      keptTheTask: true, synthesised: true, branchesRendered: true },
  },
  {
    name: "single and compare modes run without a synthesis pass",
    body: `await __reset();
      const el = await __workbench();
      const runs = [];
      for (const m of ["single", "compare"]) {
        const calls = __stubAgent();
        __mode(el, m);
        el.querySelector(".awb-prompt").value = "Summarise the account";
        el.querySelector(".awb-run").click();
        await __settle();
        runs.push({ agents: calls.length, merges: calls.filter((c) => c.merge).length,
          cards: el.querySelectorAll(".awb-results article").length });
      }
      return { singleAgents: runs[0].agents, singleCards: runs[0].cards,
        compareAgents: runs[1].agents, compareCards: runs[1].cards,
        merges: runs[0].merges + runs[1].merges,
        branchFieldHidden: el.querySelector(".awb-branch-field").classList.contains("hidden") };`,
    expect: { singleAgents: 1, singleCards: 1, compareAgents: 2, compareCards: 2,
      merges: 0, branchFieldHidden: true },
  },

  // Spaces. The registry replaced an if/else whose branches could disagree —
  // a nav rail left open over the wrong space, a surface showing under the
  // workbench. These assert the shell is coherent for every space, not just
  // that setSpace ran.
  {
    // Deliberately leaves crowe-spaces behind. Without __resetSpaces the next
    // test asks for Cultivation, silently gets Chat, and fails - which is
    // exactly how this leaked between runs before anyone noticed.
    name: "a leaked space profile cannot poison the next test",
    body: `__resetSpaces();
      localStorage.setItem("crowe-spaces", JSON.stringify(["projects"]));
      applySpaceProfile();
      return { size: PROFILE.size, cultHidden: document.querySelector('#spaces .seg-btn[data-space="cultivation"]').classList.contains("hidden") };`,
    expect: { size: 2, cultHidden: true },
  },
  {
    name: "each space shows its own nav rail and no other",
    body: `__resetSpaces();
      const rails = {};
      for (const id of Object.keys(SPACES)) {
        setSpace(id);
        rails[id] = Object.values(SPACES).filter((s) => s.nav && !$(s.nav).classList.contains("hidden")).length;
      }
      setSpace("projects");
      const own = !$("space-nav").classList.contains("hidden") && $("cult-nav").classList.contains("hidden");
      setSpace("chat");
      return { chat: rails.chat, projects: rails.projects, studio: rails.studio,
        cultivation: rails.cultivation, own };`,
    expect: { chat: 0, projects: 1, studio: 0, cultivation: 1, own: true },
  },
  {
    name: "a space shows either the workbench or a surface, never both",
    body: `__resetSpaces();
      const both = [], neither = [];
      for (const id of Object.keys(SPACES)) {
        setSpace(id);
        const wb = !workbench.classList.contains("hidden");
        const surf = Object.values(SURFACES).some((s) => !s.classList.contains("hidden"));
        if (wb && surf) both.push(id);
        if (!wb && !surf) neither.push(id);
      }
      setSpace("chat");
      return { both: both.join(","), neither: neither.join(",") };`,
    expect: { both: "", neither: "" },
  },
  {
    name: "the deep work lane hands Projects the workbench",
    body: `__resetSpaces();
      projLane = "deepwork"; setSpace("projects");
      const wb = !workbench.classList.contains("hidden");
      projLane = "home"; setSpace("projects");
      const surf = !SURFACES.home.classList.contains("hidden");
      setSpace("chat");
      return { wb, surf };`,
    expect: { wb: true, surf: true },
  },
  {
    // Cultivation carries a watermark of the growers' badge. It is scoped to
    // body[data-space], not to #surface-cultivation, because Cultivation's lanes
    // render into the same #surface-lane element Projects uses - keying on the
    // element put the mark on the overview and dropped it on every lane.
    //
    // So the assertion that matters is the negative one: the SAME element, once
    // under each space. A test that only checked Cultivation would still pass if
    // the rule leaked onto Projects and watermarked the whole app.
    name: "the cultivation watermark follows the space, not the surface",
    body: `__resetSpaces();
      const read = () => {
        const s = [...document.querySelectorAll(".surface")].find((x) => !x.classList.contains("hidden"));
        const cs = s && getComputedStyle(s, "::before");
        return { id: s ? s.id : null, on: !!cs && cs.maskImage !== "none" && cs.maskImage !== "" };
      };
      cultLane = "flushes"; setSpace("cultivation");
      const cult = read();
      projLane = "sessions"; setSpace("projects");
      const proj = read();
      __resetSpaces();
      return { shared: cult.id === proj.id && cult.id === "surface-lane", cult: cult.on, proj: proj.on };`,
    expect: { shared: true, cult: true, proj: false },
  },
  {
    // The watermark is a float, because position:sticky has to be in the flow to
    // stick to anything. A float also shortens the line boxes beside it, and for
    // a while this one silently reset Cultivation's subtitle from two lines to
    // three - a watermark quietly editing the typography of the page it sits
    // behind. The test above passes either way: it only asks whether a mask is
    // present, which is exactly the blind spot that let this ship.
    name: "the cultivation watermark does not reflow the text it sits behind",
    body: `__resetSpaces(); setSpace("cultivation"); await __settle();
      const p = [...document.querySelectorAll(".sh-sub")].find((e) => e.offsetParent);
      const kill = document.createElement("style");
      document.head.appendChild(kill);
      const h = () => Math.round(p.getBoundingClientRect().height);
      const withMark = h();
      kill.textContent = 'body[data-space="cultivation"] .surface::before{display:none !important}';
      const without = h();
      kill.remove();
      // And it must not hang off the right edge: the badge is a closed drawing,
      // so a cropped one reads as a mistake rather than as a watermark.
      const s = [...document.querySelectorAll(".surface")].find((x) => !x.classList.contains("hidden"));
      const box = getComputedStyle(s, "::before");
      const overhang = parseFloat(box.marginRight) < 0;
      __resetSpaces();
      return { reflowed: withMark !== without, overhang };`,
    expect: { reflowed: false, overhang: false },
  },
  {
    // The mask shipped for months as an un-normalised edge-detect: nothing in it
    // exceeded alpha 153, most of the ink sat under 64, and against a .18 opacity
    // that put roughly 5% ink on screen. It was present, correctly scoped, and
    // invisible - so every assertion we had was green. Measure the file instead:
    // presence is meant to be set by the opacity here, which is only true if the
    // trace underneath it reaches full strength.
    name: "the cultivation mask is inked strongly enough to see",
    body: `const img = new Image();
      img.src = "../assets/cultivation-backdrop.png";
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let max = 0, sum = 0, n = 0, edge = 0;
      const w = c.width, hh = c.height;
      for (let i = 3, px = 0; i < d.length; i += 4, px++) {
        const a = d[i];
        if (a > max) max = a;
        if (a > 8) {
          sum += a; n++;
          const x = px % w, y = (px / w) | 0;
          if (x === 0 || y === 0 || x === w - 1 || y === hh - 1) edge++;
        }
      }
      return { peaks: max === 255, meanInk: Math.round(sum / n) >= 100, touchesEdge: edge > 0 };`,
    expect: { peaks: true, meanInk: true, touchesEdge: false },
  },
  {
    // The logotype is the only brand surface on every screen, and the whole
    // point of this cut is that it moves. It is also the easiest thing in the
    // app to silently kill: revert one CSS line to a background-image and the
    // header still LOOKS right in a screenshot while being a dead picture. So
    // assert the live swap happened, that the choreography is actually bound,
    // and that the ink layer stood in until it did.
    name: "the header logotype goes live instead of staying a picture",
    // Deliberately does NOT call liveLockups(): the thing that breaks is the
    // wiring at init, and a test that runs the swap itself would repair the very
    // regression it exists to catch. Waits instead, because the swap is a fetch.
    body: `const deadline = Date.now() + 3000;
      while (!document.querySelector(".lockup.live") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const els = [...document.querySelectorAll(".lockup")];
      const svgs = els.map((e) => e.querySelector("svg"));
      const anim = (sel) => {
        const el = svgs[0] && svgs[0].querySelector(sel);
        return el ? getComputedStyle(el).animationName : "none";
      };
      return {
        // not pinned to a count: the welcome hero is a lockup too, and earlier
        // tests may have cleared the welcome screen by then
        anyLockup: els.length > 0,
        allLive: els.every((e) => e.classList.contains("live")),
        allInlined: svgs.every(Boolean),
        // a background-image cannot produce these; only the inlined <style> can
        wordAnim: anim("#wordmark-letterforms"),
        bladeAnim: anim("#rotor-crowe-blades"),
        sporeAnim: anim("#gold-thinking-mark"),
        // ink is currentColor, so the logotype tracks the palette
        inherits: svgs[0].querySelector("#wordmark-letterforms path").getAttribute("fill"),
        // the static mask is the fallback and must be hidden once live, but
        // must still exist so a failed fetch leaves a logo on screen
        maskPresent: els.every((e) => !!e.querySelector(".lockup-ink")),
        maskHidden: getComputedStyle(els[0].querySelector(".lockup-ink")).display === "none",
      };`,
    expect: {
      anyLockup: true, allLive: true, allInlined: true,
      wordAnim: "wordmark-arrive", bladeAnim: "blades-arrive",
      sporeAnim: "thinking-mark-arrive",
      inherits: "currentColor", maskPresent: true, maskHidden: true,
    },
  },
  {
    // Two inlined copies of one SVG put every id in the file into the document
    // twice. Duplicated ids do not throw — the browser silently binds both
    // animations to whichever element it finds first, so the welcome hero would
    // drive the header's blades and one of them would sit still. The bug is
    // invisible without this check.
    name: "a second logotype does not collide ids with the first",
    // A second lockup is built here rather than leaned on: the welcome hero is
    // one, but earlier tests may have cleared the welcome screen, and a guard
    // against duplicate ids that only fires when some other test happens to
    // leave the right DOM behind is not a guard.
    body: `await liveLockups();
      const extra = document.createElement("span");
      extra.className = "lockup";
      extra.innerHTML = '<span class="lockup-ink"></span>';
      document.body.appendChild(extra);
      await liveLockups();
      const svgs = [...document.querySelectorAll(".lockup svg")];
      const ids = svgs.flatMap((s) => [...s.querySelectorAll("[id]")].map((e) => e.id));
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      // every animated element must resolve to one inside its OWN svg
      const bound = svgs.every((s) => {
        const blades = s.querySelector('[id^="rotor-crowe-blades"]');
        return blades && getComputedStyle(blades).animationName === "blades-arrive";
      });
      // calling twice must not stack a second copy inside the same wrapper
      const doubled = [...document.querySelectorAll(".lockup")].some((e) => e.querySelectorAll("svg").length > 1);
      extra.remove();
      return { multiple: svgs.length > 1, dupes: dupes.join(",") || "none", bound, doubled };`,
    expect: { multiple: true, dupes: "none", bound: true, doubled: false },
  },
  {
    // WELCOME_HTML is snapshotted at load, before liveLockups() has swapped the
    // static mask for the motion SVG. So every path that restores it — New chat,
    // and loading a session with nothing in it — was putting a dead logotype
    // back on screen: correctly drawn, permanently still. It looks fine in a
    // screenshot, which is exactly why it survived. Drives the real newChat()
    // rather than showWelcome(), because the defect was the caller, not the
    // restore, and a test that calls the helper would pass over the bug.
    name: "New chat restores a logotype that still moves",
    body: `const deadline = Date.now() + 3000;
      while (!document.querySelector(".lockup.live") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await newChat();
      // the restore is synchronous, the re-inline behind it is a fetch
      const until = Date.now() + 3000;
      let hero = null;
      while (Date.now() < until) {
        hero = document.querySelector("#transcript .lockup");
        if (hero && hero.classList.contains("live")) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const svg = hero && hero.querySelector("svg");
      const word = svg && svg.querySelector('[id^="wordmark-letterforms"]');
      // the header is still on screen alongside it, so this also covers the
      // restored copy scoping its ids away from the one that never left
      const ids = [...document.querySelectorAll(".lockup svg [id]")].map((e) => e.id);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      return {
        live: !!hero && hero.classList.contains("live"),
        inlined: !!svg,
        wordAnim: word ? getComputedStyle(word).animationName : "none",
        dupes: dupes.join(",") || "none",
        doubled: !!hero && hero.querySelectorAll("svg").length > 1,
      };`,
    expect: { live: true, inlined: true, wordAnim: "wordmark-arrive", dupes: "none", doubled: false },
  },
  {
    // The console is collapsed because the objective runs on the gateway agent,
    // not in this PTY - the shell was a second window onto something nobody was
    // driving. Two ways that regresses silently: the display rule gets dropped
    // and the terminal comes back for everyone, or the event stream keeps the
    // fixed basis it had when it was sharing height and the panel shows a 140px
    // log above dead space. Assert the collapsed geometry, not just the class.
    name: "the agent console is collapsed until it is asked for",
    body: `const host = document.createElement("div");
      host.className = "workspace-agent-node";
      host.innerHTML = '<div class="agent-event-stream"></div><div class="agent-terminal-slot"></div>';
      document.body.appendChild(host);
      const slot = host.querySelector(".agent-terminal-slot");
      const stream = host.querySelector(".agent-event-stream");
      const closed = { slot: getComputedStyle(slot).display, grow: getComputedStyle(stream).flexGrow };
      host.classList.add("console-open");
      const open = { slot: getComputedStyle(slot).display, grow: getComputedStyle(stream).flexGrow };
      host.remove();
      return { closedSlot: closed.slot, closedStreamGrows: closed.grow === "1",
        openSlot: open.slot, openStreamFixed: open.grow === "0" };`,
    expect: { closedSlot: "none", closedStreamGrows: true, openSlot: "block", openStreamFixed: true },
  },
  {
    name: "a profile hides the spaces it leaves out",
    body: `__resetSpaces();
      localStorage.setItem("crowe-spaces", JSON.stringify(["projects"]));
      applySpaceProfile();
      const btn = (id) => document.querySelector('#spaces .seg-btn[data-space="' + id + '"]').classList.contains("hidden");
      const pal = () => { renderPal("Space:"); return [...palList.querySelectorAll(".pal-row")].map((r) => r.textContent).join("|"); };
      const hidden = { chat: btn("chat"), projects: btn("projects"), studio: btn("studio"), cultivation: btn("cultivation") };
      const entries = pal();
      // A space outside the profile is still reachable by name; it must not open.
      setSpace("cultivation");
      const landed = document.body.dataset.space;
      localStorage.removeItem("crowe-spaces");
      applySpaceProfile();
      setSpace("chat");
      return { ...hidden, entries, landed, restored: PROFILE.size };`,
    expect: { chat: false, projects: false, studio: true, cultivation: true,
      entries: "Space: Chat|Space: Projects", landed: "chat", restored: 4 },
  },
  {
    // The profile above was only ever reachable by hand-editing localStorage.
    // These drive the settings control instead, because a picker that renders
    // correctly and writes nothing looks identical to one that works.
    name: "unchecking a space in the picker narrows the shell",
    body: `__resetSpaces();
      renderSpacePicker();
      const box = $("cfg-spaces");
      const cb = (id) => box.querySelector('input[data-space="' + id + '"]');
      // .click() runs the real activation behaviour - it toggles checked and
      // fires input and change itself - so this exercises what a mouse does
      // rather than a change event we handed the element ourselves.
      cb("studio").click(); cb("cultivation").click();
      const stored = localStorage.getItem("crowe-spaces"), size = PROFILE.size;
      const hidden = document.querySelector('#spaces .seg-btn[data-space="studio"]').classList.contains("hidden");
      // Re-enabling has to bring the tab back, not just stop hiding new ones.
      cb("studio").click();
      const back = !document.querySelector('#spaces .seg-btn[data-space="studio"]').classList.contains("hidden");
      __resetSpaces();
      return { stored, size, hidden, back };`,
    expect: { stored: '["chat","projects"]', size: 2, hidden: true, back: true },
  },
  {
    // Storing nothing when everything is on is what keeps a space added in a
    // later version from being invisible on every install that ever saved.
    name: "an all-on selection stores no profile at all",
    body: `__resetSpaces();
      localStorage.setItem("crowe-spaces", JSON.stringify(["chat","projects"]));
      applySpaceProfile();
      renderSpacePicker();
      const box = $("cfg-spaces");
      const cb = (id) => box.querySelector('input[data-space="' + id + '"]');
      for (const id of ["studio", "cultivation"]) cb(id).click();
      const stored = localStorage.getItem("crowe-spaces"), size = PROFILE.size;
      __resetSpaces();
      return { stored, size };`,
    expect: { stored: null, size: 4 },
  },
  {
    // The picker narrows an install someone already has. This is the other half:
    // a build that arrives narrowed, so a terminal-driving install never shows a
    // mushroom farm and a film studio to be turned off.
    name: "a build can ship fewer spaces than it has",
    body: `__resetSpaces();
      window.crowe.installSpaces = ["projects"];
      applySpaceProfile();
      const btn = (id) => document.querySelector('#spaces .seg-btn[data-space="' + id + '"]').classList.contains("hidden");
      const hidden = { chat: btn("chat"), projects: btn("projects"), studio: btn("studio"), cultivation: btn("cultivation") };
      // Nothing is written: this is the build talking, not a choice anyone made,
      // and storing it here would freeze the set against a later version.
      const stored = localStorage.getItem("crowe-spaces");
      __resetSpaces();
      return { ...hidden, stored, restored: PROFILE.size };`,
    expect: { chat: false, projects: false, studio: true, cultivation: true, stored: null, restored: 4 },
  },
  {
    // The regression the install default introduces, and the reason
    // setSpaceProfile compares against defaultSpaceIds() instead of the registry.
    //
    // On a build shipping Chat and Projects, ticking all four boxes is a real
    // choice - but measured against "is this everything?" it reads as a reset,
    // so the old rule stored nothing, and the next launch fell back to the
    // build's two and threw the choice away. Silently: the tabs appear, and
    // vanish again on restart.
    name: "a build's default does not swallow turning a space back on",
    body: `__resetSpaces();
      window.crowe.installSpaces = ["projects"];
      applySpaceProfile();
      renderSpacePicker();
      const box = $("cfg-spaces");
      for (const id of ["studio", "cultivation"]) box.querySelector('input[data-space="' + id + '"]').click();
      const stored = localStorage.getItem("crowe-spaces"), size = PROFILE.size;
      // What the next launch does: re-read storage against the same build.
      applySpaceProfile();
      const afterRelaunch = PROFILE.size;
      __resetSpaces();
      return { stored, size, afterRelaunch };`,
    expect: { stored: '["chat","projects","studio","cultivation"]', size: 4, afterRelaunch: 4 },
  },
  {
    // main.js ships the configured names through without checking them, so that
    // it needs no copy of the space list to drift from renderer.js. That makes
    // this the place a typo or a space dropped in a later version has to land.
    name: "a build naming a space that does not exist is ignored",
    body: `__resetSpaces();
      window.crowe.installSpaces = ["projects", "warehouse"];
      applySpaceProfile();
      const size = PROFILE.size, has = PROFILE.has("warehouse");
      const rail = [...document.querySelectorAll('#spaces .seg-btn')].filter((b) => !b.classList.contains("hidden")).length;
      __resetSpaces();
      return { size, has, rail };`,
    expect: { size: 2, has: false, rail: 2 },
  },
  {
    name: "the picker cannot turn chat off",
    body: `__resetSpaces();
      renderSpacePicker();
      const chat = $("cfg-spaces").querySelector('input[data-space="chat"]');
      // Belt and braces: the checkbox is disabled, and the writer re-adds chat
      // even when handed a list without it.
      setSpaceProfile(["projects"]);
      const kept = PROFILE.has("chat");
      __resetSpaces();
      return { disabled: chat.disabled, checked: chat.checked, kept };`,
    expect: { disabled: true, checked: true, kept: true },
  },
  {
    // The tests above call .click() on the element, which skips hit testing. A
    // row that has been laid out under something else still passes them and is
    // still dead to a mouse, so check each box is what the cursor would find at
    // the point it is drawn.
    name: "every space checkbox is reachable where it is drawn",
    body: `__resetSpaces();
      $("settings").classList.remove("hidden");
      renderSpacePicker();
      const covered = [];
      for (const i of $("cfg-spaces").querySelectorAll("input")) {
        const b = i.getBoundingClientRect();
        if (document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) !== i) covered.push(i.dataset.space);
      }
      $("settings").classList.add("hidden");
      return { covered: covered.join(",") };`,
    expect: { covered: "" },
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
    const url = process.env.PREVIEW_URL || (await startServer());
    const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { webviewTag: true } });
    const pageErrors = [];
    win.webContents.on("console-message", (_e, level, message) => {
      if (level >= 2 && !/Security Warning/.test(message)) pageErrors.push(message);
    });
    await win.loadURL(url + "?t=" + Date.now());
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

    /* Every check above reads the page and compares it to a file on disk, and all
       of them are worthless if the page came from a different checkout. The
       in-process server makes that impossible for the default path, but
       PREVIEW_URL can still point anywhere, so ask the page what it actually
       loaded rather than trusting the address. */
    const onDisk = fs.readFileSync(path.join(ROOT, "renderer", "renderer.js"), "utf8");
    const served = await win.webContents.executeJavaScript(
      `fetch(new URL("renderer.js", location.href)).then((r) => r.ok ? r.text() : null)`);
    if (served !== onDisk) {
      failures++;
      console.log("not ok  the page under test was served from this checkout");
      console.log(served === null ? "        the page's origin has no renderer/renderer.js"
        : `        served ${served.length} bytes, ${ROOT} has ${onDisk.length}`);
    } else {
      console.log("ok      the page under test was served from this checkout");
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

    /* The grow schema is declared twice: grow-schema.js for main and the harness,
       GROW in renderer.js for the form and the lanes. They cannot be one module -
       renderer.js is a plain script with no require, and grow-schema.js must not
       drag in labels and widths that only the DOM cares about.

       So the duplication is deliberate and this test is the price of it. A field
       on one side and not the other is silent data loss: the agent logs a key the
       lane never renders, or the grower types one that main refuses. */
    const laneKeys = (() => {
      const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "renderer.js"), "utf8");
      const table = src.match(/^const GROW = \{[\s\S]*?\n\};/m);
      if (!table) return null;
      return Object.fromEntries([...table[0].matchAll(/^  (\w+): \{([\s\S]*?)\n  \},/gm)]
        .map(([, lane, body]) => [lane, [...body.matchAll(/\{ k: "(\w+)"/g)].map((m) => m[1])]));
    })();
    const drift = [];
    if (!laneKeys) drift.push("could not parse the GROW table out of renderer.js");
    else {
      const { GROW_SCHEMA } = require(path.join(__dirname, "..", "grow-schema.js"));
      for (const lane of new Set([...Object.keys(GROW_SCHEMA), ...Object.keys(laneKeys)])) {
        const a = GROW_SCHEMA[lane] ? GROW_SCHEMA[lane].fields.map((f) => f.k) : null;
        const b = laneKeys[lane] || null;
        if (!a) { drift.push(`${lane}: in renderer.js, missing from grow-schema.js`); continue; }
        if (!b) { drift.push(`${lane}: in grow-schema.js, missing from renderer.js`); continue; }
        if (a.join() !== b.join()) drift.push(`${lane}: grow-schema.js has [${a}], renderer.js has [${b}]`);
      }
    }
    if (drift.length) {
      failures++;
      console.log("not ok  grow-schema.js matches the GROW table in renderer.js");
      drift.forEach((d) => console.log(`        ${d}`));
    } else {
      console.log("ok      grow-schema.js matches the GROW table in renderer.js");
    }

    if (pageErrors.length) {
      failures++;
      console.log("not ok  renderer logged no console errors");
      pageErrors.slice(0, 5).forEach((e) => console.log(`        ${e.split("\n")[0]}`));
    } else {
      console.log("ok      renderer logged no console errors");
    }

    const total = tests.length + 4;
    console.log(`\n${total - failures}/${total} passed`);
  } catch (error) {
    failures++;
    console.error("harness error:", error && error.stack ? error.stack : error);
  } finally {
    if (server) server.close();
    app.exit(failures ? 1 : 0);
  }
});
