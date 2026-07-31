// Crowe Logic mobile — the phone chrome.
//
// Runs after renderer.js, and touches the shell only through the controls the
// renderer already owns: it clicks the header's sidebar toggle rather than
// setting the class itself, and clicks the rail's own space buttons rather
// than calling setSpace(), which is not exported. That is deliberate. Every
// one of those paths also writes localStorage and updates aria state, and a
// second implementation of them here would drift the first time one changed.
//
// What it adds that has no desktop equivalent:
//   · a bottom tab bar, built from whichever space buttons this build shows
//   · a scrim, so tapping beside the drawer closes it
//   · keyboard insets, an Android back button, and status-bar theming
//   · honest first-run copy: the desktop's opening chips ask for a shell.

(function () {
  "use strict";

  const CAP = window.Capacitor || null;
  const plugin = (name) => (CAP && CAP.Plugins && CAP.Plugins[name]) || null;
  const $ = (id) => document.getElementById(id);
  const body = document.body;

  body.classList.add("mobile");
  if (!body.dataset.pane) body.dataset.pane = "agent";

  // ─── Drawer ────────────────────────────────────────────────────────────────
  const sidebarToggle = $("sidebar-toggle");
  const drawerOpen = () => !body.classList.contains("sidebar-collapsed");
  const setDrawer = (open) => { if (sidebarToggle && drawerOpen() !== open) sidebarToggle.click(); };
  setDrawer(false);   // a rail restored from a desktop-shaped preference would cover the app

  const scrim = document.createElement("div");
  scrim.id = "m-scrim";
  scrim.setAttribute("aria-hidden", "true");
  scrim.addEventListener("click", () => setDrawer(false));
  body.appendChild(scrim);

  // Anything in the drawer that navigates should also close it — otherwise the
  // surface it just opened is behind the drawer that opened it.
  document.querySelectorAll("#sidebar .seg-btn, #sidebar .sn-item, #sidebar .sess-item, #sidebar .side-foot-btn, #sidebar .side-new")
    .forEach((el) => el.addEventListener("click", () => setTimeout(() => setDrawer(false), 0)));
  // The sessions list is rebuilt whenever a thread is saved, so its rows are
  // bound by delegation instead of one by one.
  const sessList = $("sess-list");
  if (sessList) sessList.addEventListener("click", () => setTimeout(() => setDrawer(false), 0));

  // ─── Tab bar ───────────────────────────────────────────────────────────────
  const PANE_ICON = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/></svg>';
  const tabs = document.createElement("nav");
  tabs.id = "m-tabs";
  tabs.className = "m-tabs";
  tabs.setAttribute("aria-label", "Spaces");
  body.appendChild(tabs);

  const spaceButtons = () => [...document.querySelectorAll('#spaces .seg-btn')];
  const showsWorkbench = () => { const wb = $("workbench"); return wb && !wb.classList.contains("hidden"); };

  function setPane(pane) {
    body.dataset.pane = pane;
    syncTabs();
    // The transcript and the panel deck each remember their own scroll, and a
    // deck that was laid out while display:none has no size. Nudging resize
    // lets the panels measure themselves the moment they become visible.
    window.dispatchEvent(new Event("resize"));
  }

  function buildTabs() {
    const items = spaceButtons()
      .filter((b) => !b.classList.contains("hidden"))
      .map((b) => ({
        kind: "space",
        id: b.dataset.space,
        label: (b.textContent || "").trim(),
        icon: (b.querySelector("svg") || {}).outerHTML || "",
      }));
    // Panels — the workspace column, which on a phone is a view of its own
    // rather than a second pane. Workflows, the agent fleet and operator
    // control all live there and all run over the gateway, so it earns a tab
    // even though the terminal and file panels it also hosts do not open here.
    items.push({ kind: "pane", id: "workspace", label: "Panels", icon: PANE_ICON });

    tabs.innerHTML = items.map((item) => `
      <button type="button" class="m-tab" data-kind="${item.kind}" data-id="${item.id}">
        ${item.icon}<span>${item.label}</span>
      </button>`).join("");

    tabs.querySelectorAll(".m-tab").forEach((tab) => tab.addEventListener("click", () => {
      setDrawer(false);
      if (tab.dataset.kind === "space") {
        const btn = spaceButtons().find((b) => b.dataset.space === tab.dataset.id);
        if (btn) btn.click();
        setPane("agent");
      } else if (showsWorkbench()) {
        setPane("workspace");
      } else {
        // Panels hang off the workbench, and only some spaces show it, so a tap
        // from a surface space lands on Chat first.
        //
        // The pane then has to be set after that switch, not with it: changing
        // the space queues the observer below, which resets the pane to the
        // conversation, and a reset queued during the click runs after
        // everything the click handler does. Setting Panels inline looked right
        // and was undone a microtask later — the tab highlighted and the
        // conversation stayed on screen.
        const chat = spaceButtons().find((b) => b.dataset.space === "chat");
        if (chat) chat.click();
        setTimeout(() => setPane("workspace"), 0);
      }
    }));
    syncTabs();
  }

  function syncTabs() {
    const space = body.dataset.space || "chat";
    const onPanels = body.dataset.pane === "workspace" && showsWorkbench();
    tabs.querySelectorAll(".m-tab").forEach((tab) => {
      const current = tab.dataset.kind === "pane" ? onPanels : (!onPanels && tab.dataset.id === space);
      if (current) tab.setAttribute("aria-current", "true"); else tab.removeAttribute("aria-current");
    });
  }

  buildTabs();
  // The space picker in Settings hides and shows rail buttons after load, and
  // the rail is the tab bar's only source of truth about which spaces exist.
  new MutationObserver(buildTabs).observe($("spaces"), { attributes: true, subtree: true, attributeFilter: ["class"] });
  // A space change from anywhere — the palette, a chip, the Home composer —
  // means the conversation is what the user wants to see, so the pane resets
  // with it. setPane syncs the tabs on its way through; when it is already the
  // conversation, only the highlight needs moving.
  new MutationObserver(() => { if (body.dataset.pane !== "agent") setPane("agent"); else syncTabs(); })
    .observe(body, { attributes: true, attributeFilter: ["data-space"] });

  // ─── First-run copy ────────────────────────────────────────────────────────
  /* The desktop's welcome offers to list the files here, run the test suite and
     stage a git change. All three are the workspace, and none of them exist on
     a phone: the first thing the app said to a new user was three things it
     could not do. These are the same shape — one tap, a real turn — against
     what this device actually has. */
  /* Two things this copy got wrong, and they are the same mistake.

     It said the workspace stays on the desktop, which the companion made false
     — a paired phone reads, writes and runs there. And all three openers were
     cultivation, so an app meant for broad use introduced itself as a grow log
     and nothing else. Cultivation is a package this app can carry, not the
     shape of the app.

     So both are derived now rather than fixed: what it says it can do comes
     from whether a machine is paired, and the cultivation opener appears only
     where the Cultivation space is switched on. */
  const cultivationOn = () =>
    Boolean(document.querySelector('#spaces .seg-btn[data-space="cultivation"]:not(.hidden)'));
  const isPaired = () => body.classList.contains("m-paired");

  const welcomeText = () => (isPaired()
    ? "Your operator, in your pocket — and it reaches your desktop. Ask it to reason, look things up, read and change files on the paired machine, or run a command there."
    : "Your operator, in your pocket. Ask it to reason, look things up, and keep track of what you are working on. Pair a desktop in Settings and it can work on that machine from here.");

  const GENERAL_CHIPS = [
    "Explain what this error means and what to try first",
    "Talk me through two ways to approach this, and which you would pick",
    "Summarize where this project stands and what is next",
  ];
  const MACHINE_CHIPS = [
    "What is running on my Mac right now?",
    "Show me the last 30 lines of the log and tell me what went wrong",
  ];
  const CULTIVATION_CHIP = "What did I log about contamination this month, and what should I change?";

  // Three, in the order they earn their place: the machine when there is one,
  // the farm when that space is on, then general reasoning to fill the rest.
  const welcomeChips = () => {
    const chips = [];
    if (isPaired()) chips.push(...MACHINE_CHIPS);
    if (cultivationOn()) chips.push(CULTIVATION_CHIP);
    chips.push(...GENERAL_CHIPS);
    return chips.slice(0, 3);
  };
  function mobiliseWelcome(root) {
    const welcome = root.querySelector ? root.querySelector(".welcome") : null;
    if (!welcome || welcome.dataset.mobile === "1") return;
    welcome.dataset.mobile = "1";
    const p = welcome.querySelector("p");
    if (p) p.textContent = welcomeText();
    const text = welcomeChips();
    const chips = welcome.querySelectorAll(".chip");
    chips.forEach((chip, i) => { if (text[i]) chip.textContent = text[i]; });
  }
  /* The first-run card is built in renderer.js and shown to anyone not signed
     in, which on a phone is everyone on launch day. Two of its three steps are
     the workspace: point it at a project folder, then ask it to summarize the
     repo. Neither is possible here.

     Swapped by matching the desktop's own sentences, which is only safe because
     scripts/test-mobile-bridge.js asserts each of these needles still occurs in
     renderer.js. Reword one over there without rewording it here and the build
     fails, rather than the phone quietly going back to promising a terminal. */
  const COPY = [
    ["This is the operator over your CroweLM gateway - chat, a real terminal, files, git, and plugin tools, all reviewed through one agent loop.",
     "This is the operator over your CroweLM gateway, on your phone: reasoning, routing to the right expert, and — once you pair a desktop — its shell, files and git."],
    ["Point the workspace at a project folder (Settings or ask the agent).",
     "Pair a desktop in Settings under Remote machine, and it can work on that machine from here."],
    ["Give the agent a task - try",
     "Ask it something — try"],
    ["summarize this repo", "what changed on my Mac today"],
    ["run the tests and fix what fails", "run the tests on my Mac and tell me what failed"],
  ];
  function mobiliseCopy(root) {
    if (!root.innerHTML) return;
    let html = root.innerHTML, changed = false;
    for (const [from, to] of COPY) {
      if (html.includes(from)) { html = html.split(from).join(to); changed = true; }
    }
    if (changed) root.innerHTML = html;
  }

  const transcript = $("transcript");
  if (transcript) {
    mobiliseWelcome(transcript);
    // Both the welcome and the first-run card are rebuilt on a new chat, so the
    // swap runs on every change to the transcript rather than once at load.
    // innerHTML rewriting would drop the card's buttons and their handlers, so
    // it is confined to the nodes that carry prose.
    new MutationObserver((records) => {
      mobiliseWelcome(transcript);
      if (!records.some((r) => [...r.addedNodes].some((n) => n.nodeType === 1))) return;
      // The card is appended empty and filled a statement later, so the pass
      // waits a turn. Only direct children are observed, so streaming text —
      // which lands inside a message that already exists — never triggers it.
      setTimeout(() => transcript.querySelectorAll(".msg .said").forEach(mobiliseCopy), 0);
    }).observe(transcript, { childList: true });
  }

  /* The composer's placeholder names what the tier lets the agent do, and every
     desktop line names files or commands. The renderer rewrites it on each tier
     change, so this watches the attribute rather than setting it once. */
  // Unpaired, the only thing the agent can change is the grow log — so saying so
  // is accurate where that space is on and misleading where it is off, which is
  // most installs once cultivation is a package rather than the whole app.
  const TIER_HINT = {
    plan: "Describe a task. It plans it out first.",
    readonly: "Ask anything. It reads, changes nothing.",
    edit: () => (cultivationOn() ? "Ask anything. It can add to your grow log." : "Ask anything."),
    execute: () => (cultivationOn() ? "Ask anything. It can add to your grow log." : "Ask anything."),
  };
  // What each tier means changes once a machine is paired, because the tier is
  // then gating a real shell and not only the grow log. Saying "your grow log"
  // while Execute can delete a directory would be the friendliest lie here.
  const TIER_HINT_PAIRED = {
    plan: "Describe a task. It plans it out first, and touches nothing.",
    readonly: "Ask anything. It reads your log and files on the paired machine.",
    edit: "Ask anything. It can write files on the paired machine.",
    execute: "Ask anything. It can run commands on the paired machine.",
  };
  const composerInput = $("input");
  if (composerInput) {
    const hint = () => {
      const table = body.classList.contains("m-paired") ? TIER_HINT_PAIRED : TIER_HINT;
      const entry = table[body.dataset.tier] || table.edit;
      const want = typeof entry === "function" ? entry() : entry;
      if (composerInput.placeholder !== want) composerInput.placeholder = want;
    };
    hint();
    window.__croweHint = hint;
    new MutationObserver(hint).observe(composerInput, { attributes: true, attributeFilter: ["placeholder"] });
    new MutationObserver(hint).observe(body, { attributes: true, attributeFilter: ["data-tier"] });
  }

  /* The surface composers' placeholders were written for a desktop-width
     input. At 390px, minus the send button, they clip mid-word — Projects
     opened on "routed to the right expert" cut at "routec", which reads as a
     rendering fault rather than as elision. Static text, so set once. */
  const SURFACE_HINTS = { "home-input": "Start a task — it opens in Chat.", "cult-input": "Ask the grower anything." };
  for (const [id, text] of Object.entries(SURFACE_HINTS)) {
    const field = $(id);
    if (field) field.placeholder = text;
  }

  // ─── Settings ──────────────────────────────────────────────────────────────
  /* Three rows in Settings describe machinery this app does not have: a
     workspace folder, MCP servers started as local processes, and a diff review
     to skip. Marked rather than deleted, so the class is the one place that
     says why and the CSS is the one place that hides them.

     Hidden in script rather than with `label:has(> #cfg-cwd)` because :has
     needs iOS 15.4, and Capacitor still supports 14 — a selector the webview
     does not understand drops the whole rule and shows every row again. */
  for (const id of ["cfg-cwd", "cfg-mcp", "cfg-auto"]) {
    const field = $(id);
    const row = field && field.closest("label");
    if (row) row.classList.add("m-desktop-only");
  }

  /* Remote machine.
     "Workspace folder" is hidden just above because a phone has no folder. What
     it has instead is a machine it can reach: Crowe Terminal, over Tailscale.
     So the row that described a workspace this app cannot have is replaced,
     in place, by the one that gives it back.

     Built here rather than in renderer/index.html because it is phone-only —
     the desktop already stands where these calls are trying to reach. The
     token field follows the same rule as the Crowe ID one directly above it:
     blank keeps whatever is stored, and nothing ever reads it back out. */
  const remoteSection = document.createElement("section");
  remoteSection.className = "key-manager";
  remoteSection.innerHTML = [
    '<div class="settings-section-head"><div><b>Remote machine</b>',
    "<span>A machine this phone may drive. On your desktop, open Crowe Logic → Settings → Phone companion and scan the code — or enter its tailnet address by hand. ",
    "Traffic stays inside your own Tailscale network, and the tier in the composer still decides: Read reads files, Edit writes them, Execute runs commands.</span></div>",
    '<span id="m-remote-state" class="badge">Not paired</span></div>',
    // The example is a MagicDNS name on the companion's port, deliberately:
    // both mobile network policies match cleartext exceptions by NAME, so a
    // 100.x address is refused no matter what the config files say — a
    // placeholder teaching the IP form would be a tutorial in the one failure
    // that cost a device session to diagnose. And 8787 is the companion;
    // 8765 is the desktop's OAuth loopback, which answers to nobody.
    // Short enough that the port survives a 390px input: the name teaches
    // "MagicDNS, not the 100.x address" and the port teaches "the companion,
    // not the OAuth loopback" — clipping either loses half the lesson.
    '<label>Address <input id="m-remote-url" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="http://mac.tail1234.ts.net:8787" /></label>',
    '<label>Token <input id="m-remote-token" type="password" placeholder="paste to update; blank keeps current" /></label>',
    '<button id="m-remote-pair" class="ghost sm" type="button">Pair and test</button>',
  ].join("");
  const tokenRow = $("cfg-token") && $("cfg-token").closest("label");
  if (tokenRow && tokenRow.parentNode) tokenRow.parentNode.insertBefore(remoteSection, tokenRow.nextSibling);

  /* One class on <body> is what the rest of the phone UI reads to know a
     machine is paired: the CSS uses it to reveal the Execute tier, the
     placeholder table uses it to stop describing a grow log when the tier now
     gates a shell. Set at boot, and again whenever the bridge says the pairing
     changed — including from the deep link, which can arrive at any moment. */
  async function syncPaired() {
    try {
      const cfg = await window.crowe.getConfig();
      body.classList.toggle("m-paired", Boolean(cfg && cfg.remote && cfg.remote.configured));
      // The placeholder is drawn from the same fact and is not watching this
      // class, so it would go on naming the grow log until the next tier tap.
      if (typeof window.__croweHint === "function") window.__croweHint();
    } catch { /* the bridge has not read its config yet; the event will retry */ }
  }
  syncPaired();
  window.addEventListener("crowe:remote", syncPaired);

  const remoteBadge = () => document.getElementById("m-remote-state");
  function paintRemote(s) {
    const badge = remoteBadge();
    if (!badge) return;
    if (!s || !s.configured) { badge.textContent = "Not paired"; return; }
    badge.textContent = s.reachable ? "Reachable" : (s.error ? "No answer" : `HTTP ${s.status}`);
  }
  // The address is safe to show; the token is not, and is never read back.
  (async () => {
    try {
      const cfg = await window.crowe.getConfig();
      const url = document.getElementById("m-remote-url");
      if (url && cfg && cfg.remote && cfg.remote.host) url.value = cfg.remote.host;
      if (cfg && cfg.remote && cfg.remote.configured) paintRemote(await window.crowe.remote.status());
    } catch { /* settings can open before the bridge has read its config */ }
  })();
  const pairBtn = document.getElementById("m-remote-pair");
  if (pairBtn) {
    pairBtn.addEventListener("click", async () => {
      const urlEl = document.getElementById("m-remote-url");
      const tokEl = document.getElementById("m-remote-token");
      const badge = remoteBadge();
      if (badge) badge.textContent = "Checking";
      pairBtn.disabled = true;
      try {
        const r = await window.crowe.remote.pair({ url: (urlEl && urlEl.value) || "", token: (tokEl && tokEl.value) || "" });
        if (tokEl) tokEl.value = "";              // never leave a credential sitting in the field
        if (r && r.error) { if (badge) badge.textContent = r.error; return; }
        paintRemote(r);
      } finally { pairBtn.disabled = false; }
    });
  }

  /* The Key Manager's own copy promises the operating system's vault. On a
     phone the keys are in this app's private storage — real isolation from
     other apps, no hardware encryption, and included in a device backup. The
     badge is rewritten as it is drawn, since renderKeyManager() sets it from
     the bridge's `encrypted: false` every time the sheet opens. */
  const vaultCopy = $("key-vault-state");
  if (vaultCopy) {
    const relabel = () => { if (vaultCopy.textContent !== "Device storage") vaultCopy.textContent = "Device storage"; };
    relabel();
    new MutationObserver(relabel).observe(vaultCopy, { childList: true, characterData: true, subtree: true });
  }
  const keyBlurb = document.querySelector(".key-manager .settings-section-head span");
  if (keyBlurb && /encrypted by the/.test(keyBlurb.textContent)) {
    keyBlurb.textContent = "Provider keys are kept in this app's private storage on the device. That is not the hardware vault the desktop app uses, and a device backup includes them.";
  }

  // ─── Keyboard ──────────────────────────────────────────────────────────────
  /* The Capacitor config asks the native side not to resize the webview, so the
     keyboard slides over a full-height page. The app shortens itself instead:
     --kb feeds the body's height, which pulls the composer, the HUD and every
     scroll container up as one. Resizing the webview natively looks the same
     for a moment and then reflows the transcript mid-animation. */
  const Keyboard = plugin("Keyboard");
  if (Keyboard) {
    Keyboard.addListener("keyboardWillShow", (info) => {
      body.style.setProperty("--kb", `${info.keyboardHeight || 0}px`);
      body.classList.add("kb-open");
    });
    Keyboard.addListener("keyboardWillHide", () => {
      body.style.setProperty("--kb", "0px");
      body.classList.remove("kb-open");
    });
  } else if (window.visualViewport) {
    // Browser preview, and Android where the native events are not delivered.
    const vv = window.visualViewport;
    const apply = () => {
      const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      body.style.setProperty("--kb", `${Math.round(overlap)}px`);
      body.classList.toggle("kb-open", overlap > 120);
    };
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
  }

  // ─── Status bar ────────────────────────────────────────────────────────────
  // Light content over the ink theme, dark content over cream. Tracked rather
  // than set once: the theme button flips body.dark at any time.
  const StatusBar = plugin("StatusBar");
  function paintStatusBar() {
    if (!StatusBar) return;
    const dark = body.classList.contains("dark");
    StatusBar.setStyle({ style: dark ? "DARK" : "LIGHT" }).catch(() => {});
    // Android draws a solid bar behind the status area; iOS ignores this call.
    StatusBar.setBackgroundColor({ color: dark ? "#16130f" : "#f7f3ea" }).catch(() => {});
  }
  paintStatusBar();
  new MutationObserver(paintStatusBar).observe(body, { attributes: true, attributeFilter: ["class"] });

  // ─── Android back ──────────────────────────────────────────────────────────
  /* Back has to unwind what is actually on top, innermost first, or it exits
     the app from under an open sheet. Only when there is nothing left to close
     does it do what the platform expects and leave. */
  const App = plugin("App");
  if (App) {
    App.addListener("backButton", () => {
      const modal = [...document.querySelectorAll(".modal")].find((m) => !m.classList.contains("hidden"));
      if (modal) { modal.classList.add("hidden"); return; }
      if (drawerOpen()) { setDrawer(false); return; }
      if (body.dataset.pane === "workspace") { setPane("agent"); return; }
      if ((body.dataset.space || "chat") !== "chat") {
        const chat = spaceButtons().find((b) => b.dataset.space === "chat");
        if (chat) { chat.click(); return; }
      }
      // Minimise rather than exit: a run may still be streaming, and killing
      // the process would lose the turn the user is waiting on.
      if (App.minimizeApp) App.minimizeApp(); else App.exitApp();
    });
  }

  // ─── Splash ────────────────────────────────────────────────────────────────
  // Held until the shell is laid out — launchAutoHide is off in the Capacitor
  // config — so the app never shows an unstyled frame while fonts load.
  const SplashScreen = plugin("SplashScreen");
  if (SplashScreen) {
    const hide = () => setTimeout(() => SplashScreen.hide().catch(() => {}), 120);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(hide, hide);
    else requestAnimationFrame(hide);
  }

  // The document itself must not scroll or rubber-band; every scroll on this
  // app belongs to a pane inside it.
  document.addEventListener("touchmove", (e) => {
    if (e.touches.length > 1) return;                       // pinch-zoom on a diff or an image
    let el = e.target;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      const scrollsY = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
      const scrollsX = /(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth;
      if (scrollsY || scrollsX) return;
      el = el.parentElement;
    }
    e.preventDefault();
  }, { passive: false });
})();
