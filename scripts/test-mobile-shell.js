// Behavioural tests for the phone shell — mobile/www, in a phone-sized window.
//
//   npm test
//
// test-mobile-bridge.js checks the surface underneath the UI: that every method
// exists, that the routing matches, that the agent loop emits what the
// transcript reads. This checks the part only a browser can answer — that the
// layer over the desktop layout actually lays out.
//
// Everything asserted here was first found by hand, and four of the checks
// exist because the hand pass caught the bug: a stub that returned an object
// where the renderer awaited a promise, a Key Manager drawn with no rows, an
// update status that painted an empty banner across the top of the app, and a
// Panels tab undone a microtask after it was set. None of those are visible to
// a Node test, and all four were at load or on the first tap.
//
// Same idiom as test-panels.js — Electron for a real DOM, an in-process server
// on an ephemeral port so the bytes served are this checkout's by construction,
// and no extra dependency. The window is sized to an iPhone 13's viewport
// because the layout switches on width: at 1280 this file would test the
// desktop shell and pass.

const { app, BrowserWindow } = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const PHONE = { width: 390, height: 844 };   // iPhone 13 CSS viewport

let server = null;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".woff2": "font/woff2",
};

function startServer() {
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    const file = path.join(ROOT, rel);
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
      resolve(`http://127.0.0.1:${server.address().port}/mobile/www/index.html`));
  });
}

// Helpers evaluated in the page. Geometry is read rather than computed: the
// question these tests answer is what a thumb can reach, and a rule that
// resolves to the right value while the element sits under the tab bar is not
// the same as a control being on screen.
const PRELUDE = `
  /* Every transition and animation off, first thing.

     The window is created with show:false, and Chromium does not advance
     animations on a window it is not painting. So the drawer read as still
     off screen after being opened, and the Settings sheet read as 4px below
     the bottom of the screen — both were the "from" frame of an animation
     that had not moved, not a layout fault. These tests are about where
     things settle; removing the motion makes the settled state the only
     state there is, and takes every timing flake out with it. */
  (() => {
    const style = document.createElement("style");
    style.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
    document.head.appendChild(style);
  })();

  window.__box = (sel) => {
    const el = typeof sel === "string" ? document.querySelector(sel) : sel;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left),
             right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) };
  };
  /* checkVisibility, not display !== "none". Three of the rows this hides are
     hidden by putting a class on the <label> around them, so the input itself
     still computes to display:block and a naive check called it visible. */
  window.__shown = (sel) => {
    const el = document.querySelector(sel);
    return Boolean(el) && el.checkVisibility();
  };
  window.__tabs = () => [...document.querySelectorAll("#m-tabs .m-tab")].map((t) => t.textContent.trim());
  window.__current = () => [...document.querySelectorAll('#m-tabs .m-tab[aria-current="true"]')]
    .map((t) => t.textContent.trim());
  window.__tap = (label) => {
    const tab = [...document.querySelectorAll("#m-tabs .m-tab")]
      .find((t) => t.textContent.trim() === label);
    if (!tab) throw new Error("no tab labelled " + label);
    tab.click();
  };
  // The pane swap and the drawer are both transitioned, and one of them lands a
  // macrotask late by design — see the Panels handler in mobile-ui.js.
  window.__settle = (ms) => new Promise((r) => setTimeout(r, ms || 400));
  window.__drawerOpen = () => !document.body.classList.contains("sidebar-collapsed");
  true;   // executeJavaScript clones what the script evaluates to, and a function cannot be cloned
`;

const tests = [
  {
    name: "the bridge is installed and the phone chrome is applied",
    body: `return { bridge: typeof window.crowe, mobile: document.body.classList.contains("mobile"),
                    pane: document.body.dataset.pane, tabBar: __shown("#m-tabs") };`,
    expect: { bridge: "object", mobile: true, pane: "agent", tabBar: true },
  },
  {
    name: "the tab bar is built from the rail's spaces, plus Panels",
    body: `return { tabs: __tabs().join(","), current: __current().join(",") };`,
    expect: { tabs: "Chat,Projects,Studio,Cultivation,Panels", current: "Chat" },
  },
  {
    name: "the drawer starts off screen and the app is not behind it",
    // Restored from a desktop-shaped preference, the rail would open across the
    // whole app on first launch. The bridge seeds the collapsed default before
    // renderer.js reads it, so this asserts the state, not just the class.
    body: `return { collapsed: !__drawerOpen(), offscreen: __box("#sidebar").right <= 1,
                    barVisible: __box("#bar").width > 300 };`,
    expect: { collapsed: true, offscreen: true, barVisible: true },
  },
  {
    name: "the header toggle opens the drawer and the scrim closes it",
    body: `document.getElementById("sidebar-toggle").click();
      await __settle();
      const open = __box("#sidebar").left >= -1 && __drawerOpen();
      document.getElementById("m-scrim").click();
      await __settle();
      return { open, closed: __box("#sidebar").right <= 1 };`,
    expect: { open: true, closed: true },
  },
  {
    name: "nothing pushes the page sideways",
    // A horizontal body scroll on a phone reads as a broken layout rather than
    // as more content, so wide things scroll inside their own box or not at all.
    body: `return { overflow: document.documentElement.scrollWidth - window.innerWidth, width: window.innerWidth };`,
    expect: { overflow: 0, width: 390 },
  },
  {
    name: "the composer and the HUD sit above the tab bar",
    body: `const composer = __box("#composer"), hud = __box("#hud"), tabs = __box("#m-tabs");
      return { composerAbove: composer.bottom <= hud.top + 1, hudAbove: hud.bottom <= tabs.top + 1,
               tabsOnScreen: tabs.bottom <= window.innerHeight + 1 };`,
    expect: { composerAbove: true, hudAbove: true, tabsOnScreen: true },
  },
  {
    name: "the composer shows its whole placeholder before anything is typed",
    // The textarea grows with content, but a placeholder does not trigger that,
    // so at 390px the tier hint wrapped and was clipped by a one-row box.
    body: `const input = document.getElementById("input");
      return { fits: input.scrollHeight <= input.clientHeight + 1, min: __box(input).height >= 44 };`,
    expect: { fits: true, min: true },
  },
  {
    name: "Panels swaps the workbench pane, and a space tab swaps it back",
    body: `__tap("Panels");
      await __settle();
      const onPanels = { pane: document.body.dataset.pane, agentHidden: !__shown("#agent"),
                         workspaceShown: __shown("#workspace"), current: __current().join(",") };
      __tap("Cultivation");
      await __settle();
      const back = { pane: document.body.dataset.pane, current: __current().join(",") };
      __tap("Chat");
      await __settle();
      return { ...onPanels, backPane: back.pane, backCurrent: back.current };`,
    expect: { pane: "workspace", agentHidden: true, workspaceShown: true, current: "Panels",
              backPane: "agent", backCurrent: "Cultivation" },
  },
  {
    name: "the workspace opens on Operator Control, not a terminal that cannot start",
    body: `__tap("Panels");
      await __settle();
      // .panel-title is an <input> — a panel's name is editable in place — so
      // the title is its value, not its text.
      const titles = [...document.querySelectorAll("#panel-deck .workspace-panel")]
        .map((p) => (p.querySelector(".panel-title") || {}).value || "").join(",");
      __tap("Chat");
      await __settle();
      return { titles, terminals: /Terminal/.test(titles) };`,
    expect: { titles: "Operator Control", terminals: false },
  },
  {
    name: "a tap in the drawer closes it on the way to where it goes",
    body: `document.getElementById("sidebar-toggle").click();
      await __settle();
      document.querySelector('#spaces .seg-btn[data-space="cultivation"]').click();
      await __settle();
      const state = { space: document.body.dataset.space, closed: !__drawerOpen() };
      __tap("Chat");
      await __settle();
      return state;`,
    expect: { space: "cultivation", closed: true },
  },
  {
    name: "what this device cannot do is not offered",
    // Settings has to be open for its own rows to be asked about — inside a
    // closed modal everything is invisible, and the check would pass by
    // accident whether the rows were hidden or not.
    body: `const composer = { execTier: __shown('#autonomy .seg-btn[data-tier="execute"]'),
                          editTier: __shown('#autonomy .seg-btn[data-tier="edit"]') };
      // The dock bar lives inside the workspace column, so its controls have to
      // be asked about while that column is the one on screen.
      __tap("Panels");
      await __settle();
      const dock = { gitTab: __shown('.dock-tab[data-pane="git"]'),
                     filesTab: __shown('.dock-tab[data-pane="files"]'),
                     outputTab: __shown('.dock-tab[data-pane="output"]'),
                     cliAgent: __shown("#glass-launcher") };
      __tap("Chat");
      await __settle();
      // Same for Settings: inside a closed modal everything is invisible, and
      // the check would pass whether the rows were hidden or not.
      document.getElementById("settings-btn").click();
      await __settle();
      const settings = { cwdRow: __shown("#cfg-cwd"), mcpRow: __shown("#cfg-mcp"),
                         autoApproveRow: __shown("#cfg-auto"), gatewayRow: __shown("#cfg-base") };
      document.getElementById("cfg-cancel").click();
      await __settle(120);
      return { ...composer, ...dock, ...settings };`,
    // The two trues are the control: they prove this check can still see a row
    // that is meant to be there, rather than reporting everything as hidden.
    expect: { execTier: false, editTier: true, gitTab: false, filesTab: false, outputTab: true,
              cliAgent: false, cwdRow: false, mcpRow: false, autoApproveRow: false, gatewayRow: true },
  },
  {
    /* The case above proves Execute is hidden with nothing paired. This proves
       it comes back, which is the half that was missing and the half that bit.

       Execute was hidden outright when the phone layer was written, because iOS
       cannot run a shell and the tier was decoration. The companion made that
       false — the phone drives a real shell on a paired machine — and the CSS
       did not move, so the tier that runs commands could not be selected. A
       test asserting only `execTier: false` is happy either way: it cannot tell
       "correctly hidden while unpaired" from "hidden forever". */
    name: "pairing a machine brings the Execute tier back",
    body: `const unpaired = __shown('#autonomy .seg-btn[data-tier="execute"]');
      document.body.classList.add("m-paired");
      await __settle();
      const paired = __shown('#autonomy .seg-btn[data-tier="execute"]');
      // Left as it was found, so the order these cases run in cannot matter.
      document.body.classList.remove("m-paired");
      await __settle();
      const restored = __shown('#autonomy .seg-btn[data-tier="execute"]');
      return { unpaired, paired, restored };`,
    expect: { unpaired: false, paired: true, restored: false },
  },
  {
    name: "the terminal pane explains itself instead of loading xterm",
    body: `return { stub: typeof window.Terminal, xterm: Boolean(window.Terminal && window.Terminal.prototype.parser),
                    ptyAvailable: (await window.crowe.getConfig()).ptyAvailable };`,
    expect: { stub: "function", xterm: false, ptyAvailable: false },
  },
  {
    name: "the first thing the app says is something it can do",
    body: `const text = document.getElementById("transcript").textContent;
      return { desktopPromise: /summarize this repo|run the tests|project folder|a real terminal/.test(text),
               grower: /grow log|contamination|flush/i.test(text) };`,
    expect: { desktopPromise: false, grower: true },
  },
  {
    name: "the Key Manager renders its providers and says where the keys live",
    // keys.list answering with a bare array drew the section, the heading and
    // the badge with no rows under them, which reads as "no providers exist".
    body: `document.getElementById("settings-btn").click();
      await __settle();
      const rows = document.querySelectorAll("#key-provider-list .key-provider").length;
      const badge = document.getElementById("key-vault-state").textContent.trim();
      const blurb = document.querySelector(".key-manager .settings-section-head span").textContent;
      document.getElementById("cfg-cancel").click();
      await __settle(120);
      return { rows, badge, claimsOsVault: /encrypted by the operating system/.test(blurb) };`,
    expect: { rows: 4, badge: "Device storage", claimsOsVault: false },
  },
  {
    name: "Settings opens as a sheet that fits the screen with its buttons reachable",
    body: `document.getElementById("settings-btn").click();
      await __settle();
      const card = __box("#settings .modal-card");
      const save = __box("#cfg-save");
      const state = { onScreen: card.bottom <= window.innerHeight + 1 && card.top >= 0,
                      fullWidth: card.width >= window.innerWidth - 1,
                      saveReachable: save.bottom <= window.innerHeight + 1 && save.top >= 0 };
      document.getElementById("cfg-cancel").click();
      await __settle(120);
      return state;`,
    expect: { onScreen: true, fullWidth: true, saveReachable: true },
  },
  {
    name: "no field is small enough to make iOS zoom the page",
    // Under 16px, focusing a field zooms the viewport, and an app that cannot
    // zoom back out leaves the user magnified with no way home.
    body: `const small = [...document.querySelectorAll("input, textarea, select")]
        .filter((el) => el.offsetParent !== null || el.closest(".modal"))
        .filter((el) => el.type !== "checkbox" && el.type !== "radio")
        .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
        .map((el) => el.id || el.className || el.tagName);
      return { small: small.join(","), count: small.length };`,
    expect: { small: "", count: 0 },
  },
  {
    name: "the update banner stays down",
    body: `return { hidden: document.getElementById("update-banner").classList.contains("hidden") };`,
    expect: { hidden: true },
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

app.whenReady().then(async () => {
  let failures = 0;
  try {
    /* www/ is generated and git-ignored, so a fresh checkout has none. Build it
       here rather than depending on another script having run first: a suite
       that only passes in a particular order is a suite that fails in CI.

       Required, not spawned. process.execPath inside Electron is the Electron
       binary rather than node, so shelling out to it launched a second Electron
       with the build script as its app — which has no window to close and never
       exits. The run hung with no output at all. */
    require(path.join(ROOT, "mobile", "scripts", "build-www.js"));

    const url = process.env.MOBILE_URL || (await startServer());
    // useContentSize, so the numbers above are the viewport and not the
    // viewport plus whatever frame this platform draws around it.
    const win = new BrowserWindow({ ...PHONE, useContentSize: true, show: false });
    const pageErrors = [];
    // Electron 43 passes an event object here and deprecates the old positional
    // (event, level, message). Both are read so this file does not start
    // printing a deprecation notice per page load, and does not go silent
    // whenever the positional form is finally removed.
    win.webContents.on("console-message", (...args) => {
      const event = args[0] || {};
      const level = typeof args[1] === "number" ? args[1] : event.level;
      const message = typeof args[2] === "string" ? args[2] : event.message || "";
      const serious = level === "error" || level === "warning" || (typeof level === "number" && level >= 2);
      if (serious && !/Security Warning|Failed to load resource/.test(message)) pageErrors.push(message);
    });
    await win.loadURL(url + "?t=" + Date.now());
    await new Promise((r) => setTimeout(r, 2500));
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

    /* The page has to be the www this checkout just built. MOBILE_URL can point
       anywhere, and www/ is a copy of renderer.js rather than the file itself,
       so ask the page for both: that it is serving what was built, and that
       what was built is what renderer/ currently says. */
    const served = await win.webContents.executeJavaScript(
      `fetch(new URL("renderer.js", location.href)).then((r) => r.ok ? r.text() : null)`);
    const built = fs.readFileSync(path.join(ROOT, "mobile", "www", "renderer.js"), "utf8");
    const source = fs.readFileSync(path.join(ROOT, "renderer", "renderer.js"), "utf8");
    if (served !== built) {
      failures++;
      console.log("not ok  the page under test is the www this run built");
    } else if (built !== source) {
      failures++;
      console.log("not ok  mobile/www carries the current renderer.js");
      console.log("        build-www.js copied something other than renderer/renderer.js");
    } else {
      console.log("ok      the page under test is this checkout's renderer, through the www build");
    }

    /* A console error at load is the whole class of bug this file exists for:
       it is invisible to a Node test, it happens before anyone taps anything,
       and it takes a surface down with it. Resource 404s are filtered above —
       the favicon this shell has no need for, and the gateway, which is
       unreachable from a test runner by design. */
    if (pageErrors.length) {
      failures++;
      console.log("not ok  the shell logged no console errors");
      pageErrors.slice(0, 5).forEach((e) => console.log(`        ${e.split("\n")[0]}`));
    } else {
      console.log("ok      the shell logged no console errors");
    }

    const total = tests.length + 2;
    console.log(`\n${total - failures}/${total} passed`);
  } catch (error) {
    failures++;
    console.error("harness error:", error && error.stack ? error.stack : error);
  } finally {
    if (server) server.close();
    app.exit(failures ? 1 : 0);
  }
});
