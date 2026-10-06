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
  // 1.1: the workspace pane is reached through the Machine tab, which exists only
  // once a machine is paired. Tests pair by class and rebuild the bar.
  window.__pair = (on) => { document.body.classList.toggle("m-paired", on); window.dispatchEvent(new Event("crowe:remote")); };
  true;   // executeJavaScript clones what the script evaluates to, and a function cannot be cloned
`;

const tests = [
  {
    name: "Look switches to Instrument and restores the Editorial theme",
    body: `const oldLook = localStorage.getItem("crowe-look");
      const oldTheme = localStorage.getItem("crowe-theme");
      applyLook("editorial"); applyTheme(false);
      const field = document.getElementById("cfg-look");
      field.value = "instrument"; field.dispatchEvent(new Event("change"));
      const instrument = document.body.dataset.look === "instrument" && document.body.classList.contains("dark");
      const remembered = localStorage.getItem("crowe-theme") === "light" && localStorage.getItem("crowe-look") === "instrument";
      field.value = "editorial"; field.dispatchEvent(new Event("change"));
      const restored = document.body.dataset.look === "editorial" && !document.body.classList.contains("dark");
      const lastStylesheet = [...document.querySelectorAll('link[rel="stylesheet"]')].at(-1).getAttribute("href").split("?")[0];
      localStorage.setItem("crowe-theme", oldTheme || "dark"); applyLook(oldLook || "editorial");
      if (oldLook === null) localStorage.removeItem("crowe-look");
      if (oldTheme === null) localStorage.removeItem("crowe-theme");
      return { instrument, remembered, restored, lastStylesheet };`,
    expect: { instrument: true, remembered: true, restored: true, lastStylesheet: "look.css" },
  },
  {
    name: "Home reads loaded pairing, opens the shared terminal and reuses it",
    body: `const getConfig = window.crowe.getConfig;
      window.crowe.getConfig = async () => ({ ...await getConfig(), remote: { configured: true } });
      let result;
      try {
        __pair(true); await __settle();
        // Reproduce native cold start: saved pairing is ready, the CSS
        // pairing class has not caught up when Home first renders.
        document.body.classList.remove("m-paired"); __tap("Home"); await __settle();
        const button = document.getElementById("m-home-mirror");
        const available = !!button && button.checkVisibility();
        if (!button) throw new Error("Shared terminal entry is missing from Home");
        __pair(true); await __settle();
        button.click(); await __settle();
        const first = document.querySelectorAll(".phone-mirror").length;
        const visible = document.querySelector(".phone-mirror")?.checkVisibility();
        const pane = document.body.dataset.pane;
        __tap("Home"); await __settle(); document.getElementById("m-home-mirror").click(); await __settle();
        const second = document.querySelectorAll(".phone-mirror").length;
        result = { available, visible, pane, reused: first === second };
      } finally {
        for (const m of document.querySelectorAll(".phone-mirror")) closePanel(m.closest(".workspace-panel").dataset.id);
        window.crowe.getConfig = getConfig; __pair(false); await __settle(); __tap("Home"); await __settle();
      }
      return result;`,
    expect: { available: true, visible: true, pane: "workspace", reused: true },
  },
  {
    /* The web upgrade is drawn only where billing.plan() says buyHere (the US
       App Store storefront). Elsewhere a free account sees its tier and
       nothing to tap: no Settings button, no See plans under a plan notice,
       no card, since showing a way out to buy is itself steering (3.1.1). */
    name: "upgrade affordances appear only where the storefront allows a web purchase",
    body: `const b = window.crowe.billing, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      b.catalog = async () => ({ ladder: [{ slug: "pro", amount: 9900, interval: "month", features: ["Every tier"] }] });
      const free = (buyHere) => async () => ({ email: "g@example.com", tier: "free", known: true, paid: false, buyHere });
      const notice = () => { const n = document.createElement("div"); n.className = "notice plan"; n.textContent = "Free plan";
        document.getElementById("transcript").appendChild(n); return n; };
      const look = async (buyHere) => {
        b.plan = free(buyHere); window.dispatchEvent(new CustomEvent("crowe:plan", { detail: {} }));
        const n = notice(); await sleep(80);
        const r = { button: !document.getElementById("m-plan-up").hidden, line: document.getElementById("m-plan-line").textContent,
                    seePlans: Boolean(n.querySelector(".m-plan-up")) };
        n.querySelector(".m-plan-up") && n.querySelector(".m-plan-up").click(); await sleep(80);
        const card = document.querySelector("#transcript .plan-card");
        r.card = Boolean(card); r.price = card ? card.querySelector(".plan-price").textContent : "";
        if (card) card.closest(".msg").remove(); n.remove();
        return r;
      };
      const e = await look(false), u = await look(true);
      return { elseButton: e.button, elseLine: e.line, elseSeePlans: e.seePlans, elseCard: e.card,
               usButton: u.button, usSeePlans: u.seePlans, usCard: u.card, usPrice: u.price };`,
    expect: { elseButton: false, elseLine: "Free.", elseSeePlans: false, elseCard: false,
              usButton: true, usSeePlans: true, usCard: true, usPrice: "$99 a month" },
  },
  {
    name: "the bridge is installed and the phone chrome is applied",
    body: `return { bridge: typeof window.crowe, mobile: document.body.classList.contains("mobile"),
                    pane: document.body.dataset.pane, tabBar: __shown("#m-tabs") };`,
    expect: { bridge: "object", mobile: true, pane: "home", tabBar: true },
  },
  {
    name: "the task-first tabs exclude cultivation; Machine appears only once paired",
    body: `const before = __tabs().join(",");
      __pair(true); await __settle(50);
      const paired = __tabs().join(",");
      __pair(false); await __settle(50);
      const current = __current().join(","); __tap("Chat"); await __settle();
      return { tabs: before, current, paired };`,
    expect: { tabs: "Home,Chat,Messages,Playground", current: "Home", paired: "Home,Chat,Messages,Playground,Machine" },
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
    name: "the composer sits above the tab bar; the HUD is off by default and, switched on, sits between them",
    // 1.1: the HUD strip is developer chrome and hidden until Settings says
    // otherwise. Both states are measured: quiet, the composer meets the tabs;
    // with the switch on, the HUD is drawn between them.
    body: `const quiet = { hudHidden: !__shown("#hud"),
        composerAbove: __box("#composer").bottom <= __box("#m-tabs").top + 1,
        tabsOnScreen: __box("#m-tabs").bottom <= window.innerHeight + 1 };
      document.body.classList.add("m-usage"); await __settle(50);
      const composer = __box("#composer"), hud = __box("#hud"), tabs = __box("#m-tabs");
      const loud = { hudShown: __shown("#hud"), composerAboveHud: composer.bottom <= hud.top + 1, hudAboveTabs: hud.bottom <= tabs.top + 1 };
      document.body.classList.remove("m-usage"); await __settle(50);
      return { ...quiet, ...loud };`,
    expect: { hudHidden: true, composerAbove: true, tabsOnScreen: true, hudShown: true, composerAboveHud: true, hudAboveTabs: true },
  },
  {
    name: "usage and routing details are off by default, and one Settings switch turns them on and persists",
    body: `const off = { hud: __shown("#hud"), tier: __shown("#autonomy"), copy: __shown("#copy-conversation"),
                    configured: (await window.crowe.getConfig()).showUsage };
      document.getElementById("settings-btn").click();
      await __settle(300);
      const box = document.getElementById("m-cfg-usage");
      const row = { present: Boolean(box), shown: __shown("#m-cfg-usage"), checked: box ? box.checked : null };
      box.checked = true; box.dispatchEvent(new Event("change"));
      await __settle(150);
      const on = { hud: __shown("#hud") || document.body.classList.contains("m-usage"), tier: document.body.classList.contains("m-usage"),
                   configured: (await window.crowe.getConfig()).showUsage };
      box.checked = false; box.dispatchEvent(new Event("change"));
      await __settle(150);
      const back = { configured: (await window.crowe.getConfig()).showUsage, cls: document.body.classList.contains("m-usage") };
      document.getElementById("cfg-cancel").click();
      await __settle(120);
      return { offHud: off.hud, offTier: off.tier, offCopy: off.copy, offConfigured: off.configured,
               rowPresent: row.present, rowShown: row.shown, rowChecked: row.checked,
               onHud: on.hud, onTier: on.tier, onConfigured: on.configured, backConfigured: back.configured, backCls: back.cls };`,
    expect: { offHud: false, offTier: false, offCopy: false, offConfigured: false, rowPresent: true, rowShown: true, rowChecked: false,
              onHud: true, onTier: true, onConfigured: true, backConfigured: false, backCls: false },
  },
  {
    name: "Settings hides the legacy founders promotion while retaining its handlers",
    // The roster read is stubbed: this harness must not reach the live gateway.
    body: `const real = window.crowePhone.publicJson;
      window.crowePhone.publicJson = async () => ({ spots: 100, taken: 2, founders: [{ name: "B. Grower", farm: "Second Farm", n: 2 }, { name: "A. Grower", farm: "First Farm", n: 1 }] });
      document.getElementById("settings-btn").click();
      await __settle(300);
      const row = __shown("#m-founders-open");
      document.getElementById("m-founders-open").click();
      await __settle(300);
      const names = [...document.querySelectorAll("#m-founders-roster li b")].map((b) => b.textContent);
      const out = { row, sheet: __shown("#m-founders"), settingsClosed: !__shown("#settings"),
                    seats: document.getElementById("m-founders-seats").textContent, first: names[0], count: names.length,
                    link: __shown("#m-founders-link") };
      window.crowePhone.publicJson = async () => ({ spots: 100, taken: 100, founders: [] });
      document.getElementById("m-founders-close").click();
      document.getElementById("settings-btn").click(); await __settle(200);
      document.getElementById("m-founders-open").click(); await __settle(300);
      const full = { seats: document.getElementById("m-founders-seats").textContent, link: __shown("#m-founders-link") };
      window.crowePhone.publicJson = async () => null;
      document.getElementById("m-founders-close").click();
      document.getElementById("settings-btn").click(); await __settle(200);
      document.getElementById("m-founders-open").click(); await __settle(300);
      const down = { seats: document.getElementById("m-founders-seats").textContent, link: __shown("#m-founders-link") };
      document.getElementById("m-founders-close").click();
      window.crowePhone.publicJson = real;
      await __settle(120);
      return { ...out, fullSeats: full.seats, fullLink: full.link, downSeats: down.seats, downLink: down.link, closed: !__shown("#m-founders") };`,
    expect: { row: false, sheet: true, settingsClosed: true, seats: "2 of 100 seats taken.", first: "A. Grower", count: 2, link: true,
              fullSeats: "All 100 seats are taken.", fullLink: false, downSeats: "The roster could not be reached right now.", downLink: false, closed: true },
  },
  {
    name: "a tool card folds to one plain line that opens on tap; a failed turn is one sentence with Try again",
    // Drawn the way the renderer draws them (renderer.js addToolCard, addError),
    // without a gateway: the fold and the button are the phone layer's, and
    // both are measured on the same DOM the renderer produces.
    body: `const t = document.getElementById("transcript");
      const msgU = document.createElement("div"); msgU.className = "msg user"; msgU.innerHTML = '<div class="who"><div class="u">You</div></div><div class="body"><p>Is this lot ready?</p></div>';
      const msgA = document.createElement("div"); msgA.className = "msg assistant"; msgA.innerHTML = '<div class="who"></div><div class="body"></div>';
      t.appendChild(msgU); t.appendChild(msgA);
      const body = msgA.querySelector(".body");
      const card = document.createElement("div"); card.className = "toolcard ok";
      card.innerHTML = '<div class="tc-head"><span class="tc-dot"></span><span class="tc-name">read_grow</span><span class="tc-arg">{"type":"blocks"}</span></div><div class="tc-result">2 blocks row(s)</div>';
      body.appendChild(card);
      // A raw error is logged to the console on purpose; the harness counts console errors, so it is caught here.
      const realError = console.error; const logged = []; console.error = (...a) => logged.push(a.join(" "));
      const err = document.createElement("div"); err.className = "err"; err.textContent = 'gateway: {"type":"overloaded_error","message":"Overloaded"}';
      body.appendChild(err);
      await __settle(80);
      console.error = realError;
      const sum = card.querySelector(".m-tc-summary");
      const folded = { line: sum ? sum.querySelector(".m-tc-text").textContent : null, summaryShown: Boolean(sum) && sum.checkVisibility(),
                       headHidden: !card.querySelector(".tc-head").checkVisibility(), resultHidden: !card.querySelector(".tc-result").checkVisibility() };
      sum.click(); await __settle(50);
      const opened = { headShown: card.querySelector(".tc-head").checkVisibility(), resultShown: card.querySelector(".tc-result").checkVisibility() };
      const retry = err.querySelector(".m-retry");
      const said = { text: err.childNodes[0].textContent, retry: Boolean(retry) && retry.checkVisibility() };
      msgU.remove(); msgA.remove();
      return { ...folded, ...opened, ...said, rawLogged: logged.some((l) => /overloaded_error/.test(l)) };`,
    expect: { line: "Looked up your records", summaryShown: true, headHidden: true, resultHidden: true, headShown: true, resultShown: true,
              text: "The reader is busy. Try again in a moment.", retry: true, rawLogged: true },
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
    name: "Machine swaps the workbench pane, and a space tab swaps it back",
    body: `__pair(true); await __settle(50);
      __tap("Machine");
      await __settle();
      const onPanels = { pane: document.body.dataset.pane, agentHidden: !__shown("#agent"),
                         workspaceShown: __shown("#workspace"), current: __current().join(",") };
      __tap("Chat");
      await __settle();
      const back = { pane: document.body.dataset.pane, current: __current().join(",") };
      __tap("Chat");
      await __settle();
      __pair(false); await __settle(50);
      return { ...onPanels, backPane: back.pane, backCurrent: back.current };`,
    expect: { pane: "workspace", agentHidden: true, workspaceShown: true, current: "Machine",
              backPane: "agent", backCurrent: "Chat" },
  },
  {
    name: "the workspace opens on Operator Control, not a terminal that cannot start",
    body: `__pair(true); await __settle(50);
      __tap("Machine");
      await __settle();
      // .panel-title is an <input> — a panel's name is editable in place — so
      // the title is its value, not its text.
      const titles = [...document.querySelectorAll("#panel-deck .workspace-panel")]
        .map((p) => (p.querySelector(".panel-title") || {}).value || "").join(",");
      __tap("Chat");
      await __settle();
      __pair(false); await __settle(50);
      return { titles, terminals: /Terminal/.test(titles) };`,
    expect: { titles: "Operator Control", terminals: false },
  },
  {
    name: "a tap in the drawer closes it on the way to where it goes",
    body: `document.getElementById("sidebar-toggle").click();
      await __settle();
      document.querySelector('#spaces .seg-btn[data-space="chat"]').click();
      await __settle();
      const state = { space: document.body.dataset.space, closed: !__drawerOpen() };
      __tap("Chat");
      await __settle();
      return state;`,
    expect: { space: "chat", closed: true },
  },
  {
    name: "what this device cannot do is not offered",
    // Settings has to be open for its own rows to be asked about — inside a
    // closed modal everything is invisible, and the check would pass by
    // accident whether the rows were hidden or not.
    // 1.1: the tier picker is developer chrome, off unless the Details switch is
    // on, so the picker is measured with the switch on; what it hides within
    // itself (Execute, unpaired) is the question here.
    body: `document.body.classList.add("m-usage"); await __settle(30);
      const composer = { execTier: __shown('#autonomy .seg-btn[data-tier="execute"]'),
                          editTier: __shown('#autonomy .seg-btn[data-tier="edit"]') };
      document.body.classList.remove("m-usage");
      // The dock bar lives inside the workspace column, so its controls have to
      // be asked about while that column is the one on screen.
      __pair(true); await __settle(50);
      __tap("Machine");
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
                         autoApproveRow: __shown("#cfg-auto"), gatewayRow: __shown("#cfg-base"),
                         advanced: __shown(".m-advanced > summary") };
      document.getElementById("cfg-cancel").click();
      await __settle(120);
      __pair(false); await __settle(50);
      return { ...composer, ...dock, ...settings };`,
    // The trues are the control: they prove this check can still see a row
    // that is meant to be there, rather than reporting everything as hidden.
    expect: { execTier: false, editTier: true, gitTab: false, filesTab: false, outputTab: true,
              cliAgent: false, cwdRow: false, mcpRow: false, autoApproveRow: false, gatewayRow: false, advanced: true },
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
    body: `document.body.classList.add("m-usage"); await __settle(30);   // the picker is chrome; see above
      const unpaired = __shown('#autonomy .seg-btn[data-tier="execute"]');
      document.body.classList.add("m-paired");
      await __settle();
      const paired = __shown('#autonomy .seg-btn[data-tier="execute"]');
      // Left as it was found, so the order these cases run in cannot matter.
      document.body.classList.remove("m-paired");
      await __settle();
      const restored = __shown('#autonomy .seg-btn[data-tier="execute"]');
      document.body.classList.remove("m-usage");
      return { unpaired, paired, restored };`,
    expect: { unpaired: false, paired: true, restored: false },
  },
  {
    /* Found in real use rather than by reading: the agent, driven from a phone
       at Edit tier, wrote a script and installed a LaunchAgent. Nothing asked.
       write_file plus run_command is persistence, and the tier gates the class
       of action, not whether the result survives a reboot.

       The list is short on purpose. One that flags everything is one people tap
       through without reading, which is worse than not asking. */
    name: "things that outlive the command are flagged, ordinary work is not",
    body: `const risk = window.__crowePersistenceRisk;
      const flagged = [
        "launchctl load ~/Library/LaunchAgents/com.example.plist",
        "cp x.plist ~/Library/LaunchAgents/",
        "crontab -e",
        "sudo rm -rf /tmp/x",
        "echo 'export PATH=x' >> ~/.zshrc",
        "systemctl enable nginx",
        "cat id_rsa.pub >> ~/.ssh/authorized_keys",
      ].map((c) => Boolean(risk(c)));
      const ordinary = [
        "git status",
        "npm test",
        "ls -la ~/Projects",
        "grep -rn TODO src",
        "node scripts/test-qr.js",
        "tail -50 /tmp/build.log",
      ].map((c) => Boolean(risk(c)));
      return { everyRiskCaught: flagged.every(Boolean), noFalsePositives: ordinary.every((v) => v === false),
               reason: risk("launchctl load ~/Library/LaunchAgents/x.plist") };`,
    expect: { everyRiskCaught: true, noFalsePositives: true,
              reason: "installs something that runs at every login" },
  },
  {
    /* The pairing token rides every request and the requests are shell
       commands, so cleartext is only acceptable where the network is private.
       A userinfo trick must be judged by its real host. */
    name: "pairing accepts private networks over http and the internet only over https",
    body: `const p = window.__crowePairAddress;
      return {
        tailnet: p("http://mac.tail1234.ts.net:8787").url,
        cgnat: !p("http://100.101.1.2:8787").error,
        lan: !p("http://192.168.1.20:8787").error,
        publicHttp: Boolean(p("http://203.0.113.9:8787").error),
        publicHttps: !p("https://mac.example.com").error,
        userinfo: Boolean(p("http://100.64.0.1@evil.example").error),
        scheme: Boolean(p("javascript:alert(1)").error),
      };`,
    expect: { tailnet: "http://mac.tail1234.ts.net:8787", cgnat: true, lan: true, publicHttp: true,
              publicHttps: true, userinfo: true, scheme: true },
  },
  {
    /* A phone is handed to someone else more often than a laptop. Signing out
       has to take the paired machine and the provider keys with it, or the
       next person can drive the first person's computer. */
    name: "signing out forgets the paired machine, provider keys and conversations",
    body: `const c = window.crowe;
      await c.remote.pair({ url: "http://mac.tail1234.ts.net:8787", token: "t-should-be-forgotten" });
      const before = (await c.keys.set("openai", "sk-test-should-be-forgotten")).ok;
      const out = await c.auth.logout();
      const after = await c.remote.status();
      const keys = (await c.keys.list()).providers.some((k) => k.configured);
      const sessions = await c.sessions.list();
      return { before, out: out.ok, paired: after.configured, keys, sessions: (sessions.sessions || sessions || []).length };`,
    expect: { before: true, out: true, paired: false, keys: false, sessions: 0 },
  },
  {
    /* The approval sheet is drawn from model output, so it must be inert text;
       "Not now" declines; assistive activation approves without a hold; and
       the machine and tier are named, since that is what is being approved. */
    name: "the approval sheet names machine and tier, renders the command as text, and declines by default",
    body: `const evil = '<img src=x onerror="window.__pwned=1">rm -rf ~';
      const p1 = window.__croweApprove({ danger: true, title: "Run this on mac?", reason: "This runs as root.",
        detail: evil, machine: "http://mac.tail1234.ts.net:8787", tier: "execute", confirm: "Run command" });
      await new Promise((r) => setTimeout(r, 30));
      const sheet = document.querySelector(".m-approve");
      const shown = { pre: sheet.querySelector(".m-approve-detail").textContent, imgs: sheet.querySelectorAll("img").length,
        chips: [...sheet.querySelectorAll(".m-chip")].map((c) => c.textContent).join(" | "), hold: sheet.querySelector(".m-approve-yes").textContent,
        focused: document.activeElement && document.activeElement.textContent };
      sheet.querySelector(".m-approve-no").click();
      const declined = await p1;
      const p2 = window.__croweApprove({ danger: true, title: "x", detail: "sudo true", confirm: "Run command" });
      await new Promise((r) => setTimeout(r, 30));
      document.querySelector(".m-approve:not(.leaving) .m-approve-yes").click();
      const accessible = await p2;
      await new Promise((r) => setTimeout(r, 200));
      return { ...shown, pwned: Boolean(window.__pwned), declined, accessible, left: document.querySelectorAll(".m-approve").length };`,
    expect: { pre: '<img src=x onerror="window.__pwned=1">rm -rf ~', imgs: 0, chips: "mac.tail1234.ts.net | Execute tier",
              hold: "Hold to run command", focused: "Not now", pwned: false, declined: false, accessible: true, left: 0 },
  },
  {
    name: "long approval keeps actions visible and navigation hidden through dismissal",
    body: `const answer = window.__croweApprove({ danger: true, title: "Run this on a-long-computer-name?",
        detail: "a long harmless command description ".repeat(100), machine: "https://a-very-long-machine-name.tail1234.ts.net", tier: "execute", confirm: "Run command" });
      await new Promise((r) => setTimeout(r, 300));
      const sheet = document.querySelector(".m-approve");
      const footer = sheet.querySelector(".m-approve-actions").getBoundingClientRect();
      const content = sheet.querySelector(".m-approve-content");
      const blocked = document.body.classList.contains("approval-open");
      const visible = footer.top >= 0 && footer.bottom <= innerHeight && footer.width <= innerWidth;
      const scrollable = getComputedStyle(content).overflowY === "auto";
      sheet.querySelector(".m-approve-no").click();
      const blockedDuringExit = document.body.classList.contains("approval-open");
      const result = await answer;
      await new Promise((r) => setTimeout(r, 30));
      return { blocked, visible, scrollable, blockedDuringExit, result, restored: !document.body.classList.contains("approval-open") };`,
    expect: { blocked: true, visible: true, scrollable: true, blockedDuringExit: true, result: false, restored: true },
  },
  {
    /* Authority gates relayed from the person's computer: the Home card lists
       them, a tap opens the approval sheet, a 300-line diff scrolls inside the
       content area with Deny and Approve still on screen, diff lines colour by
       their first character without ever being parsed as markup, and Approve
       echoes the evidence hash that was shown. */
    name: "an authority gate with a long diff opens in the sheet with its actions visible, and approve echoes the evidence hash",
    body: `window.__tap("Home"); await window.__settle(200);
      const realGates = window.crowe.gates, realStatus = window.crowe.auth.status;
      const diff = ["@@ line 1 @@"].concat(Array.from({ length: 300 }, (_, i) => (i % 3 ? "+" : "-") + "line " + i + (i === 4 ? " <img src=x onerror=window.__pwned=1>" : ""))).join("\\n");
      const gate = { id: "g_TEST", status: "pending", machine: "Michael's MacBook Pro", mission: "Fix the flaky upload test", kind: "edit",
        title: "Edit src/upload.js", detail: "src/upload.js  (+200 -100)", why: "changes a file in your workspace", risk: "review",
        evidence: { path: "src/upload.js", diff }, evidence_hash: "hash-shown-to-the-person", expires_at: Date.now() + 600000 };
      let decided = null, gates = [gate];
      window.crowe.auth.status = async () => ({ user: { email: "m@example.com" } });
      window.crowe.gates = { list: async () => ({ ok: true, status: 200, gates, signedIn: true }),
        decide: async (id, d, h) => { decided = { id, d, h }; return { ok: true, status: 200, gate: { ...gate, status: "approved" } }; } };
      window.__croweGates.stop();
      await window.__croweGates.poll();
      const card = document.getElementById("m-gates");
      const home = { count: card.querySelector(".m-gate-n") && card.querySelector(".m-gate-n").textContent,
        row: card.querySelector(".m-gate-row b") && card.querySelector(".m-gate-row b").textContent,
        meta: card.querySelector(".m-gate-meta").textContent.replace(/ · [0-9:]+ left$/, "") };
      card.querySelector(".m-gate-row").click();
      await window.__settle(300);
      const sheet = document.querySelector(".m-approve");
      const footer = sheet.querySelector(".m-approve-actions").getBoundingClientRect();
      const content = sheet.querySelector(".m-approve-content");
      const spans = [...sheet.querySelectorAll(".m-approve-diff .m-dl")];
      const shown = { chips: [...sheet.querySelectorAll(".m-chip")].map((c) => c.textContent).join(" | "),
        mission: sheet.querySelector(".m-approve-mission").textContent, evidence: sheet.querySelector(".m-approve-evidence").textContent,
        lines: spans.length, adds: spans.filter((n) => n.classList.contains("add")).length, dels: spans.filter((n) => n.classList.contains("del")).length,
        hunks: spans.filter((n) => n.classList.contains("hunk")).length, imgs: sheet.querySelectorAll("img").length,
        scrollable: getComputedStyle(content).overflowY === "auto" && content.scrollHeight > content.clientHeight,
        actionsVisible: footer.top >= 0 && footer.bottom <= innerHeight && footer.width <= innerWidth,
        buttons: [...sheet.querySelectorAll(".m-approve-actions button")].map((b) => b.textContent).join("|"),
        expiry: /^Expires in /.test(sheet.querySelector(".m-approve-expiry").textContent) };
      sheet.querySelector(".m-approve-yes").click();
      await window.__settle(300);
      gates = [];
      await window.__settle(100);
      await window.__croweGates.poll();
      const empty = document.getElementById("m-gates").textContent;
      window.crowe.gates = realGates; window.crowe.auth.status = realStatus;
      window.__croweGates.stop();
      return { home: JSON.stringify(home), shown: JSON.stringify(shown), pwned: Boolean(window.__pwned), decided: JSON.stringify(decided), empty: /No gates waiting. Runs on your computer will ask here./.test(empty),
        left: document.querySelectorAll(".m-approve").length };`,
    expect: { home: JSON.stringify({ count: "1", row: "Edit src/upload.js", meta: "Michael's MacBook Pro · Fix the flaky upload test" }),
      shown: JSON.stringify({ chips: "Authority gate | Michael's MacBook Pro", mission: "Mission Fix the flaky upload test", evidence: "Evidencepathsrc/upload.js",
        lines: 301, adds: 200, dels: 100, hunks: 1, imgs: 0, scrollable: true, actionsVisible: true, buttons: "Not now|Deny|Approve", expiry: true }),
      pwned: false, decided: JSON.stringify({ id: "g_TEST", d: "approve", h: "hash-shown-to-the-person" }), empty: true, left: 0 },
  },
  {
    /* The answers a stale or raced gate can come back with are said in plain
       words, and a strict gate asks to be held rather than tapped. */
    name: "a strict gate is held to approve, and a 409 from the relay reads as answered on the computer",
    body: `window.__tap("Home"); await window.__settle(200);
      const realGates = window.crowe.gates, realStatus = window.crowe.auth.status;
      const gate = { id: "g_STRICT", status: "pending", machine: "Studio", kind: "run", title: "Run a command", detail: "rm -rf build", why: "deletes files",
        risk: "strict", evidence: { command: "rm -rf build", cwd: "/work" }, evidence_hash: "h2", expires_at: Date.now() + 600000 };
      window.crowe.auth.status = async () => ({ user: { email: "m@example.com" } });
      window.crowe.gates = { list: async () => ({ ok: true, status: 200, gates: [gate], signedIn: true }),
        decide: async () => ({ ok: false, status: 409, error: "already_decided", gate: { ...gate, status: "denied", decided_via: "desktop" } }) };
      window.__croweGates.stop(); await window.__croweGates.poll();
      document.querySelector("#m-gates .m-gate-row").click(); await window.__settle(300);
      const sheet = document.querySelector(".m-approve");
      const hold = sheet.querySelector(".m-approve-yes").textContent;
      const ev = sheet.querySelector(".m-approve-evidence").textContent;
      sheet.querySelector(".m-approve-yes").click();      // keyboard/VoiceOver activation approves without the hold
      await window.__settle(300);
      const note = document.querySelector("#m-gates .m-gate-note").textContent;
      window.crowe.gates = realGates; window.crowe.auth.status = realStatus; window.__croweGates.stop();
      return { hold, ev, note };`,
    expect: { hold: "Hold to approve", ev: "Evidencecwd/work", note: "Already answered on your computer" },
  },
  {
    /* Two questions at once queue rather than stack; the page behind is inert
       while one is up; and stopping the turn answers the open one and the
       waiting one "no", so a stopped turn never hangs on a sheet. */
    name: "approval sheets queue, bench the page, and a stop answers them no",
    body: `const a = window.__croweApprove({ title: "first", confirm: "Allow" });
      const b = window.__croweApprove({ title: "second", confirm: "Allow" });
      await new Promise((r) => setTimeout(r, 30));
      const open = document.querySelectorAll(".m-approve:not(.leaving)").length;
      const benched = document.getElementById("composer") ? document.getElementById("composer").closest("[inert]") !== null : null;
      await window.crowe.agent.stop("main");
      const answers = [await a, await b];
      await new Promise((r) => setTimeout(r, 200));
      const restored = !document.querySelector("body > [inert]");
      return { open, benched, answers: answers.join(","), left: document.querySelectorAll(".m-approve").length, restored };`,
    expect: { open: 1, benched: true, answers: "false,false", left: 0, restored: true },
  },
  {
    /* Rooms are dock panels, and the dock sits in the workspace pane that only a
       paired phone can reach, so New message used to open a room nobody could
       see. Messages is a tab now, a room opens full screen, and Back returns to
       the list. */
    name: "Messages is a tab; New message opens a full-screen room with a way back",
    body: `const tab = document.querySelector('#m-tabs [data-id="messages"]');
      if (!tab) return { tab: false };
      tab.click(); await new Promise((r) => setTimeout(r, 100));
      const listPane = document.body.dataset.pane;
      const listShown = document.getElementById("rooms-drawer").checkVisibility() && document.getElementById("m-messages-pane").getBoundingClientRect().width >= innerWidth - 1;
      document.getElementById("room-new").click(); await new Promise((r) => setTimeout(r, 400));
      const roomPane = document.body.dataset.pane;
      const roomShown = Boolean(document.querySelector(".m-room-on .room") && document.querySelector(".m-room-on .room").checkVisibility());
      const back = document.querySelector(".m-room-on .m-room-back");
      const backShown = Boolean(back && back.checkVisibility());
      const tabLit = tab.getAttribute("aria-current") === "true";
      if (back) back.click(); await new Promise((r) => setTimeout(r, 100));
      const after = document.body.dataset.pane;
      document.querySelector(".m-room-on .panel-close")?.click();
      document.querySelector('#m-tabs [data-id="chat"]').click();
      return { tab: true, listPane, listShown, roomPane, roomShown, backShown, tabLit, after };`,
    expect: { tab: true, listPane: "messages", listShown: true, roomPane: "room", roomShown: true, backShown: true, tabLit: true, after: "messages" },
  },
  {
    /* The first version of this matched on the program name and nothing else,
       so it refused `claude -p "..."` — the exact form its own error message
       tells you to use. A guard that blocks the alternative it recommends
       teaches the user the feature is broken, which is worse than not guarding
       at all. Both directions are checked here for that reason. */
    name: "one-shot forms are allowed, bare interactive ones are not",
    body: `const k = window.__croweNeedsKeyboard;
      return {
        bareClaude: k("claude"),
        claudePrint: k('claude -p "summarize this repo"'),
        claudeLongPrint: k("claude --print hello"),
        vim: k("vim notes.txt"),
        bareNode: k("node"),
        nodeScript: k("node scripts/test-qr.js"),
        sshBare: k("ssh crowelm-chat"),
        sshCommand: k("ssh crowelm-chat uptime"),
        ordinary: k("git -C ~/clm-mobile status"),
        pathed: k("/usr/bin/vim x"),
      };`,
    expect: { bareClaude: "claude", claudePrint: null, claudeLongPrint: null,
              vim: "vim", bareNode: "node", nodeScript: null,
              sshBare: "ssh", sshCommand: null, ordinary: null, pathed: "vim" },
  },
  {
    name: "the phone bundles xterm for remote sessions while local PTYs stay unavailable",
    body: `return { terminal: typeof window.Terminal, mirror: typeof window.crowePhoneMirror?.mount, xterm: Boolean(window.Terminal && window.Terminal.prototype.parser),
                    ptyAvailable: (await window.crowe.getConfig()).ptyAvailable };`,
    expect: { terminal: "function", mirror: "function", xterm: true, ptyAvailable: false },
  },
  {
    /* This used to require the opening copy to talk about the farm, which was
       right when the phone's only real capability was the grow log. Cultivation
       is a package the app can carry now, not the shape of the app, so leading
       with it introduces a general operator as a grow log.

       What has to stay true is narrower and does not expire: never promise a
       workspace running on the phone, and when no machine is paired, point at
       the way to get one instead of describing a machine that is not there. */
    name: "the first thing the app says is something it can do",
    /* Read the settled copy, not a fixed moment. The first-run card is
       appended empty, filled a statement later, and mobilised a macrotask
       after that (mobile-ui.js runs mobiliseCopy through a MutationObserver
       and a setTimeout). Alone that all lands well inside the load settle;
       under full-suite load the turns arrive late and a one-shot read catches
       the desktop prose mid-swap. Polling keeps the assertion — a swap that
       never happens still fails here, eight seconds later. */
    body: `const read = () => {
        const text = document.getElementById("transcript").textContent;
        const firstChip = (document.querySelector(".welcome .chip") || {}).textContent || "";
        return {
          // A folder to open and a terminal on the device: neither exists here,
          // paired or not. "on my Mac" is a different claim and a true one.
          localWorkspace: /project folder|a real terminal/i.test(text),
          // Unpaired, the honest opener names the way to get a machine.
          offersPairing: /pair a desktop|remote machine/i.test(text),
          leadsWithCultivation: /grow log|contamination|flush|fruiting/i.test(firstChip),
        };
      };
      const settled = (s) => !s.localWorkspace && s.offersPairing && !s.leadsWithCultivation;
      const deadline = Date.now() + 8000;
      let state = read();
      while (!settled(state) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        state = read();
      }
      return state;`,
    expect: { localWorkspace: false, offersPairing: true, leadsWithCultivation: false },
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
  {
    name: "the desktop's Phone companion section is hidden on the phone",
    // That section starts the desktop's pairing listener and draws the QR the
    // phone scans; on the phone it described a Tailscale it could not find,
    // under a heading about a phone it already was. Remote machine is the
    // phone's half of pairing and stays, as does Delete account; both are the
    // control that this check can still see a section that is meant to show.
    body: `document.getElementById("settings-btn").click();
      await __settle();
      const inner = document.getElementById("companion-body") || document.getElementById("companion-state");
      const section = inner && inner.closest("section");
      const out = { present: Boolean(section), companionShown: section ? section.checkVisibility() : null,
                    remoteShown: __shown("#m-remote-url"), deleteShown: __shown("#m-delete-account") };
      document.getElementById("cfg-cancel").click();
      await __settle(120);
      return out;`,
    expect: { present: true, companionShown: false, remoteShown: true, deleteShown: true },
  },
  {
    name: "Explore first takes the whole onboarding message away, not just its body",
    // Removing only the card's .body left the message shell (the mark and an
    // empty body) standing in the transcript as a blank operator bubble.
    body: `const btn = [...document.querySelectorAll("#transcript .onboarding-actions button")]
        .find((b) => b.textContent.trim() === "Explore first");
      if (!btn) return { hadCard: false };
      const before = document.querySelectorAll("#transcript .msg.assistant").length;
      btn.click();
      await __settle(200);
      const empty = [...document.querySelectorAll("#transcript .msg.assistant")]
        .filter((m) => { const b = m.querySelector(".body"); return !b || !b.textContent.trim(); }).length;
      return { hadCard: true, removed: document.querySelectorAll("#transcript .msg.assistant").length === before - 1, emptyBubbles: empty };`,
    expect: { hadCard: true, removed: true, emptyBubbles: 0 },
  },
  {
    name: "legacy cultivation records remain readable without a Log tab",
    body: `localStorage.setItem('crowe:grow:blocks', JSON.stringify([{id:'legacy-test',code:'RETAINED'}]));
      const rows = await window.crowe.grow.list('blocks');
      return { retained: rows.some(row => row.code === 'RETAINED'), logVisible: __tabs().includes('Log') };`,
    expect: { retained: true, logVisible: false },
  },
  {
    name: "Reply pace is a setting and the phone starts on brisk; reading pace stays offered",
    body: `document.getElementById("settings-btn").click();
      await __settle();
      const sel = document.getElementById("cfg-pace");
      const out = { present: Boolean(sel), shown: __shown("#cfg-pace"), value: sel ? sel.value : null,
                    configured: (await window.crowe.getConfig()).textPace,
                    reading: Boolean(sel && [...sel.options].some((o) => o.value === "reading")),
                    // The desktop's label calls reading pace the phone's default; the phone relabels it.
                    labelHonest: Boolean(sel && ![...sel.options].some((o) => o.value === "reading" && /default/.test(o.textContent))) };
      document.getElementById("cfg-cancel").click();
      await __settle(120);
      return out;`,
    expect: { present: true, shown: true, value: "brisk", configured: "brisk", reading: true, labelHonest: true },
  },
  {
    name: "Home introduces paired computer work and opens Chat",
    body: `__tap("Home");
      await __settle(500);
      const out = { paneShown: __shown("#m-home-pane"),
        pairing: Boolean(document.querySelector("#m-home-pair")),
        limits: /desktop app must stay running/.test(document.querySelector("#m-home-pane").textContent),
        noGrowHeadline: !/Your grow, today/.test(document.querySelector("#m-home-pane").textContent) };
      document.getElementById("m-home-chat").click();
      await __settle();
      return { ...out, backToChat: __shown("#agent") };`,
    expect: { paneShown: true, pairing: true, limits: true, noGrowHeadline: true, backToChat: true },
  },
  {
    name: "Playground is a tab of its own, and signed out it says so instead of failing",
    body: `__tap("Playground");
      await __settle(800);
      const pane = document.querySelector("#m-playground-pane");
      const out = { paneShown: __shown("#m-playground-pane"), chatHidden: !__shown("#agent"),
                    title: /Playground/.test(pane ? pane.textContent : ""),
                    signIn: /Sign in to use the Playground|Loading models|unavailable/.test(pane ? pane.textContent : ""),
                    photoStillReachable: Boolean(document.querySelector('input[type="file"][accept="image/*"]')) };
      __tap("Chat");
      await __settle();
      return out;`,
    expect: { paneShown: true, chatHidden: true, title: true, signIn: true, photoStillReachable: true },
  },
  {
    name: "Settings carries Diagnostics with Copy, Share and Clear, and the reminders test",
    body: `document.getElementById("settings-btn").click();
      await __settle(300);
      const out = { log: __shown("#m-diag-log"), copy: __shown("#m-diag-copy"), share: __shown("#m-diag-share"), clear: __shown("#m-diag-clear"),
                    hasHeader: /Crowe Logic/.test(document.getElementById("m-diag-log").textContent),
                    pending: __shown("#m-diag-pending"), testBtn: __shown("#m-diag-test-reminder"),
                    // No notification service in this harness: the pane must say so in words, not sit on "Loading".
                    pendingSaysWhy: /browser build/.test(document.getElementById("m-diag-pending").textContent) };
      // Reply voice: three choices, remembered where speak.js reads them.
      const sel = document.getElementById("m-voice");
      out.voice = __shown("#m-voice");
      out.voiceOptions = sel ? [...sel.options].map((o) => o.value).join(",") : "";
      if (sel) { sel.value = "neural"; sel.dispatchEvent(new Event("change")); }
      out.voiceStored = localStorage.getItem("crowe-reply-voice");
      if (sel) { sel.value = "phone"; sel.dispatchEvent(new Event("change")); }
      out.voiceStored += "," + localStorage.getItem("crowe-reply-voice");
      localStorage.removeItem("crowe-reply-voice");
      document.getElementById("cfg-cancel").click();
      await __settle(120);
      return out;`,
    expect: { log: true, copy: true, share: true, clear: true, hasHeader: true, pending: true, testBtn: true, pendingSaysWhy: true, voice: true, voiceOptions: "phone,neural", voiceStored: "neural,phone" },
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
    /* Storage is per origin, and the origin is 127.0.0.1 on whatever port the
       OS handed out. When it hands out one it gave an earlier run, that run's
       config, its onboarding flag and the block its lot test saved are all
       still there, and four checks fail for reasons that have nothing to do
       with the checkout under test. Start clean every time. */
    await win.webContents.session.clearStorageData({ storages: ["localstorage", "indexdb", "cookies"] });
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

    /* This suite's prelude disables all animations (a show:false window never
       advances them), which is also why it was blind to the one animation bug
       that mattered: a boot entrance with forwards fill pins `transform: none`
       over the drawer's translateX(-100%) forever, and the sidebar shipped
       parked open over the left 320px of every phone screen. A runtime check
       cannot see what the prelude removed, so the guard is static: no
       forwards-filling animation may target #sidebar unless the phone sheet
       explicitly switches the drawer's animation off. */
    const desktopCss = fs.readFileSync(path.join(ROOT, "renderer", "styles.css"), "utf8");
    const phoneCss = fs.readFileSync(path.join(ROOT, "mobile", "src", "mobile.css"), "utf8");
    const sidebarFill = /^[^\n{}]*#sidebar[^\n{}]*\{[^}]*animation:[^};]*\b(both|forwards)\b/m.test(desktopCss);
    if (sidebarFill && !/body\.mobile #sidebar \{ animation: none; \}/.test(phoneCss)) {
      failures++;
      console.log("not ok  a forwards-filling animation targets #sidebar without the phone opting out");
      console.log("        a finished fill pins transform:none over the drawer's translateX(-100%)");
    } else {
      console.log("ok      no forwards-filling animation can pin the drawer open");
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
