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
  // A tap on a session row navigates and the drawer should close behind it. A
  // tap in the current session's name or brief field at the top of the same
  // list is the opposite: the person is about to type, and a drawer that
  // closes under the keyboard makes those two fields unusable on a phone.
  if (sessList) sessList.addEventListener("click", (e) => {
    if (e.target && e.target.closest && e.target.closest(".sess-meta")) return;
    setTimeout(() => setDrawer(false), 0);
  });

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
    if (pane === "home" && typeof renderHome === "function") renderHome();
    if (pane === "camera" && typeof renderCamera === "function") renderCamera();
    if (pane === "playground" && window.crowePlayground) window.crowePlayground.render();
    // The transcript and the panel deck each remember their own scroll, and a
    // deck that was laid out while display:none has no size. Nudging resize
    // lets the panels measure themselves the moment they become visible.
    window.dispatchEvent(new Event("resize"));
  }

  /* 1.1: the phone's own tab set. Home and Camera are panes this file owns;
     Chat and Log are the rail's chat and cultivation spaces. Projects and
     Panels describe a workspace on a machine, so they appear only once a
     machine is paired, as one "Machine" tab onto the workspace pane. */
  const HOME_ICON = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>';
  const MESSAGES_ICON = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/><path d="M19 9h1a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-1v3l-4-3h-4"/></svg>';
  const PLAYGROUND_ICON = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';
  const CAMERA_ICON = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  const railIcon = (space) => { const b = spaceButtons().find((x) => x.dataset.space === space); return b && b.querySelector("svg") ? b.querySelector("svg").outerHTML : ""; };
  const spaceOn = (space) => Boolean(spaceButtons().find((b) => b.dataset.space === space && !b.classList.contains("hidden")));

  function buildTabs() {
    const items = [{ kind: "pane", id: "home", label: "Home", icon: HOME_ICON }];
    items.push({ kind: "space", id: "chat", label: "Chat", icon: railIcon("chat") });
    // Messages run on the phone itself, so the tab needs no paired machine.
    if ($("rooms-drawer")) items.push({ kind: "pane", id: "messages", label: "Messages", icon: MESSAGES_ICON });
    // Photo questions start from the camera button in Chat; the tab slot goes
    // to the Playground (playground.js), which owns its pane.
    items.push({ kind: "pane", id: "playground", label: "Playground", icon: PLAYGROUND_ICON });

    // Read the class directly: isPaired is declared further down and this runs at boot.
    if (body.classList.contains("m-paired")) items.push({ kind: "pane", id: "workspace", label: "Machine", icon: PANE_ICON });

    tabs.innerHTML = items.map((item) => `
      <button type="button" class="m-tab" data-kind="${item.kind}" data-id="${item.id}">
        ${item.icon}<span>${item.label}</span>
      </button>`).join("");

    tabs.querySelectorAll(".m-tab").forEach((tab) => tab.addEventListener("click", () => {
      setDrawer(false);
      const id = tab.dataset.id;
      if (tab.dataset.kind === "space") {
        const btn = spaceButtons().find((b) => b.dataset.space === id);
        if (btn) btn.click();
        setPane("agent");
      } else if (id === "workspace") {
        if (showsWorkbench()) { setPane("workspace"); return; }
        // Panels hang off the workbench, and only some spaces show it, so a tap
        // from a surface space lands on Chat first. The pane is set after that
        // switch: changing the space queues the observer below, which resets
        // the pane to the conversation, and that reset runs after this handler.
        const chat = spaceButtons().find((b) => b.dataset.space === "chat");
        if (chat) chat.click();
        setTimeout(() => setPane("workspace"), 0);
      } else {
        setPane(id);
      }
    }));
    syncTabs();
  }

  function syncTabs() {
    const space = body.dataset.space || "chat";
    const pane = body.dataset.pane || "agent";
    const onPanels = pane === "workspace" && showsWorkbench();
    tabs.querySelectorAll(".m-tab").forEach((tab) => {
      let current = false;
      if (tab.dataset.kind === "pane") current = tab.dataset.id === "workspace" ? onPanels : tab.dataset.id === "messages" ? pane === "messages" || pane === "room" : pane === tab.dataset.id;
      else current = pane === "agent" && tab.dataset.id === space;
      if (current) tab.setAttribute("aria-current", "true"); else tab.removeAttribute("aria-current");
    });
  }

  buildTabs();
  window.addEventListener("crowe:remote", () => buildTabs());

  /* The account badge: an avatar with the address's initial (mobile.css draws
     it). On the desktop a click signs out at once; on a phone that is one
     stray tap from losing the session, so here the tap opens Settings, where
     signing out is a deliberate row. Captured so the renderer's handler never
     runs. */
  const badge = $("userbadge");
  if (badge) {
    const initial = () => {
      const t = (badge.textContent || "").trim();
      if (t) { badge.dataset.initial = t[0].toUpperCase(); badge.setAttribute("aria-label", `Account: ${t}`); }
      else delete badge.dataset.initial;
    };
    new MutationObserver(initial).observe(badge, { childList: true, characterData: true, subtree: true });
    initial();
    badge.setAttribute("role", "button");
    badge.title = "Account and settings";
    badge.addEventListener("click", (e) => {
      e.stopImmediatePropagation(); e.preventDefault();
      window.dispatchEvent(new CustomEvent("crowe:account"));
    }, true);
  }

  /* ── Home and Camera: the phone's own panes ─────────────────────────────────
     Two sections beside the workbench and the surfaces. Home answers "what
     does my grow need today" from the log already on this phone; Camera hands a
     photo to CroweLM Vision through the ordinary chat turn and then offers one
     tap to log the verdict against a lot. Nothing here needs a desktop. */
  const workbenchEl = $("workbench");
  const homePane = document.createElement("section"); homePane.id = "m-home-pane"; homePane.className = "m-pane"; homePane.setAttribute("aria-label", "Home");
  const cameraPane = document.createElement("section"); cameraPane.id = "m-camera-pane"; cameraPane.className = "m-pane"; cameraPane.setAttribute("aria-label", "Camera");
  if (workbenchEl && workbenchEl.parentNode) { workbenchEl.parentNode.insertBefore(homePane, workbenchEl); workbenchEl.parentNode.insertBefore(cameraPane, workbenchEl); }

  /* Messages: the conversation list as a tab of its own, the way a phone keeps
     texts. The desktop keeps it in the rail, which on a phone is a drawer you
     have to know to open, so the list moves here whole, with its listeners.
     A room is a dock panel, and the dock lives in the workspace pane that only
     a paired phone shows; opening one switches to a "room" pane that shows that
     panel alone, full screen, with a way back to the list. */
  const roomsDrawer = $("rooms-drawer");
  const messagesPane = document.createElement("section"); messagesPane.id = "m-messages-pane"; messagesPane.className = "m-pane"; messagesPane.setAttribute("aria-label", "Messages");
  if (roomsDrawer && workbenchEl && workbenchEl.parentNode) {
    workbenchEl.parentNode.insertBefore(messagesPane, workbenchEl);
    messagesPane.appendChild(roomsDrawer);
    roomsDrawer.classList.remove("hidden");
  }
  const roomPanels = () => [...document.querySelectorAll("#panel-deck .workspace-panel")].filter((el) => el.querySelector(".room"));
  function showRoom(panelEl) {
    if (!panelEl) return;
    roomPanels().forEach((el) => el.classList.toggle("m-room-on", el === panelEl));
    const head = panelEl.querySelector(".panel-head");
    if (head && !head.querySelector(".m-room-back")) {
      const back = document.createElement("button");
      back.type = "button"; back.className = "m-room-back ghost sm"; back.textContent = "Messages";
      back.setAttribute("aria-label", "Back to Messages");
      back.addEventListener("click", () => setPane("messages"));
      head.prepend(back);
    }
    const go = () => setPane("room");
    if (showsWorkbench()) { go(); return; }
    // Same order as the Machine tab: the space change resets the pane, so the
    // room is shown after it.
    const chat = spaceButtons().find((b) => b.dataset.space === "chat");
    if (chat) chat.click();
    setTimeout(go, 0);
  }
  // A tap on a row focuses its open panel or opens a new one; either way the
  // panel that ends up active is the one to show. A new room's panel is added
  // a moment later, which the observer below catches.
  if (roomsDrawer) roomsDrawer.addEventListener("click", (e) => {
    if (!e.target.closest || e.target.closest(".sess-del")) return;
    if (!e.target.closest(".msg-row")) return;
    setTimeout(() => { const el = document.querySelector("#panel-deck .workspace-panel.stack-active .room, #panel-deck .workspace-panel:last-child .room"); if (el) showRoom(el.closest(".workspace-panel")); }, 60);
  });
  const deck = $("panel-deck");
  if (deck) new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) {
      if (n.nodeType !== 1 || !n.classList.contains("workspace-panel")) continue;
      // The room's body is mounted after the shell is appended.
      // Only from the list: panels restored at launch must not open the app
      // into a room.
      if (!["messages", "room"].includes(body.dataset.pane)) continue;
      setTimeout(() => { if (n.querySelector(".room") && document.body.contains(n)) showRoom(n); }, 0);
    }
  }).observe(deck, { childList: true });
  // A closed room leaves the room pane with nothing in it.
  if (deck) new MutationObserver(() => { if (body.dataset.pane === "room" && !deck.querySelector(".workspace-panel.m-room-on")) setPane("messages"); })
    .observe(deck, { childList: true });
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const sinceDays = (iso) => { const t = Date.parse(String(iso || "") + "T00:00:00"); if (!Number.isFinite(t)) return ""; const d = Math.floor((Date.now() - t) / 86400000); return d < 0 ? "" : d === 0 ? "today" : d === 1 ? "1 day" : `${d} days`; };
  const live = (blocks) => (blocks || []).filter((b) => b && b.code && !["spent", "discarded"].includes(b.stage));
  const STAGE_ORDER = ["fruiting", "consolidating", "colonizing", "spawned"];
  /* Yield only with the basis the grower stated. Dry substrate gives biological
     efficiency; a wet block gives a ratio and is labelled as one. */
  function yieldLine(b, byLot) {
    const got = byLot[b.code] || 0, w = Number(b.weight);
    if (!got || !w) return "";
    const pct = Math.round((got / w) * 100);
    return b.basis === "dry" ? `${pct}% biological efficiency: ${got.toFixed(1)} lb from ${w} lb dry substrate`
      : b.basis === "wet" ? `${pct}% of wet block weight: ${got.toFixed(1)} lb from ${w} lb` : `${got.toFixed(1)} lb harvested (state the weight basis to see the ratio)`;
  }
  /* A finding is markdown: the model bolds the stage and lists the actions.
     Home and Camera used to escape it and show the asterisks. The transcript's
     own renderer (md, renderer.js) draws it here too, inside a .said so the
     list and heading rules it already has apply; one-line rows get the plain
     words instead, since a grid cell cannot hold a list. */
  const mdSafe = (t) => (typeof md === "function" ? md(String(t || "")) : esc(String(t || "")));
  const rollCard = (c) => `<div class="m-roll">${c.thumb ? `<img src="${c.thumb}" alt="" class="m-roll-thumb">` : ""}<div><b>${esc(c.lot || "unassigned")}</b> <span class="m-lot-meta">${esc(new Date(c.ts).toLocaleDateString([], { month: "short", day: "numeric" }))}</span><div class="m-roll-verdict said m-md">${mdSafe(c.verdict)}</div></div></div>`;
  let pendingLot = "", cameraArmed = false, photoTurn = null;
  const transcript = $("transcript");

  const isIOS = () => Boolean(window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === "ios");
  /* What the phone may do on the paired computer, said where the connection is
     shown. The mode is chosen in the composer and applies to every request
     until it is changed; this is not a per-action approval, and the wording
     does not suggest one. Risky commands still stop for a yes on their own. */
  const HOME_MODE = {
    plan: ["Plan", "Proposes steps and changes nothing."],
    readonly: ["Read", "Reads files. Changes nothing."],
    edit: ["Edit", "Reads and writes files. Commands need Execute."],
    execute: ["Execute", "Reads, writes and runs commands."],
  };
  const homeMode = () => {
    const [name, means] = HOME_MODE[body.dataset.tier] || HOME_MODE.edit;
    return `<div class="m-h-mode" id="m-home-mode"><span class="m-h-mode-k">Operating mode</span><b>${name}</b><span class="m-h-mode-v">${means} Change it in Chat, under the message box.</span></div>`;
  };
  new MutationObserver(() => { if (body.dataset.pane === "home" && $("m-home-mode")) $("m-home-mode").outerHTML = homeMode(); })
    .observe(body, { attributes: true, attributeFilter: ["data-tier"] });
  async function renderHome() {
    // The native vault can finish after the initial pane is selected. Read
    // the ready config instead of capturing the not-yet-synced CSS class.
    const cfg = await window.crowe.getConfig().catch(() => null);
    const paired = Boolean(cfg?.remote?.configured);
    const sessions = window.crowe?.sessions?.list ? await window.crowe.sessions.list().catch(() => []) : [];
    const hour = new Date().getHours();
    const greeting = hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    const TASKS = [
      ["Understand a problem", "Explain an error or compare approaches", "Explain this problem and help me choose the next step: ", '<path d="M12 17h.01"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4"/><circle cx="12" cy="12" r="9"/>'],
      ["Review a file", "An attachment or a file on your computer", "Help me review a file. First ask me to attach it or provide its path on my paired computer.", '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>'],
      ["Plan a change", "See the action before it runs", "Help me plan a change. Show the proposed action and how we will verify the result before doing any work.", '<path d="M4 6h10M4 12h16M4 18h7"/><path d="M17 4l3 2-3 2"/>'],
    ];
    homePane.innerHTML = [
      '<div class="m-home-inner m-h">',
      `<header class="m-h-head"><p class="m-h-hello">${greeting}</p><h1 class="m-h-title">What are we working on?</h1></header>`,
      '<button type="button" class="m-h-ask" id="m-home-chat"><span>Ask anything</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button>',
      '<section class="m-h-tiles" aria-label="Start a task">',
      TASKS.map(([t, sub, task, icon]) => `<button type="button" class="m-h-tile" data-task="${esc(task)}"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><b>${t}</b><span>${sub}</span></button>`).join(""),
      '<button type="button" class="m-h-tile m-h-tile-pg" id="m-home-pg"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/></svg><b>Try a model</b><span>Compare models side by side</span></button>',
      '</section>',
      '<section class="m-h-group" id="m-gates" aria-label="Authority gates" aria-live="polite"></section>',
      `<section class="m-h-group" aria-label="Your computer"><h2 class="m-h-label">Your computer</h2><div class="m-h-card">`,
      `<div class="m-h-status"><i class="m-h-dot${paired ? " on" : ""}" aria-hidden="true"></i><div><b>${paired ? "Paired" : "Not paired"}</b><span>${paired ? "Reachable while it is awake and on your private Tailscale network." : "Chat works without it. Pair to read files and run commands on your own computer. It has to be awake and on your private Tailscale network."}</span></div></div>`,
      paired ? homeMode() : '',
      paired ? '<button type="button" class="primary m-h-cta" id="m-home-mirror">Shared terminal and drafts</button>' : '',
      `<button type="button" class="${paired ? "ghost" : "primary"} m-h-cta" id="m-home-pair">${paired ? "Connection settings" : "Pair computer"}</button>`,
      '<details class="m-h-more"><summary>How pairing works</summary><p>Turn on Phone companion in Crowe Logic on your computer. Both devices need the same private Tailscale network, and the computer has to be awake. Open Shared terminal to watch a desktop session, take control, or edit its Control+G draft. The desktop app must stay running. Drafts return to the prompt for you to submit. File tools and commands have activity receipts; terminal keystrokes and draft contents are not logged.</p></details>',
      '</div></section>',
      paired ? '<section class="m-h-group" id="m-activity" aria-live="polite"><h2>Activity on your computer</h2><p class="m-home-empty">Checking&hellip;</p></section>' : '',
      sessions.length ? '<section class="m-h-group"><h2 class="m-h-label">Recent</h2><div class="m-h-card m-h-list">' + sessions.slice(0, 4).map((x) => `<button type="button" class="m-sess" data-session="${esc(x.id)}"><span>${esc(x.name || x.title || "Untitled")}</span><i class="m-chev" aria-hidden="true"></i></button>`).join("") + '</div></section>' : '',
      '</div>',
    ].join('');
    $("m-home-pair").addEventListener("click", () => { $("settings-btn").click(); remoteSection.scrollIntoView({ block: "center" }); });
    $("m-home-mirror")?.addEventListener("click", () => {
      __tapTab("Machine");
      setTimeout(async () => {
        if (typeof addPanel !== "function") return;
        const existing = document.querySelector('.phone-mirror')?.closest('.workspace-panel');
        if (existing && typeof focusPanel === "function") focusPanel(existing.dataset.id);
        else await addPanel("terminal", { title: "Shared terminal" });
      }, 0);
    });
    $("m-home-chat").addEventListener("click", () => { __tapTab("Chat"); const i = $("input"); if (i) i.focus(); });
    $("m-home-pg").addEventListener("click", () => __tapTab("Playground"));
    homePane.querySelectorAll("[data-session]").forEach((b) => b.addEventListener("click", async () => {
      if (typeof loadSession === "function") await loadSession(b.dataset.session);
      __tapTab("Chat");
    }));
    if (paired) renderActivity();
    renderGates();
    startGates(true);
    homePane.querySelectorAll("[data-task]").forEach((button) => button.addEventListener("click", () => {
      __tapTab("Chat");
      const input = $("input");
      input.value = button.dataset.task;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    }));
  }

  /* Receipts from the paired machine, on the phone: the trail the desktop keeps
     for every command, read, write and refusal this device caused. The thing
     a remote shell owes its owner is evidence, and this is where it is read. */
  const ACT_LABEL = { run: "Ran", read: "Read", write: "Wrote", denied: "Refused", error: "Failed" };
  function ago(at) {
    const t = Date.parse(at);
    if (Number.isNaN(t)) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
  }
  async function renderActivity() {
    const host = $("m-activity");
    if (!host || !window.crowe?.remote?.activity) return;
    const r = await window.crowe.remote.activity(8).catch((e) => ({ error: String(e) }));
    if (!host.isConnected) return;
    const note = (t) => `<h2>Activity on your computer</h2><p class="m-home-empty">${esc(t)}</p>`;
    if (r.error) { host.innerHTML = note(r.error); return; }
    if (!r.entries.length) { host.innerHTML = note("Nothing yet. Every command, read and write this phone causes will be listed here."); return; }
    host.innerHTML = '<h2>Activity on your computer</h2><ol class="m-act">' + r.entries.map((e) => {
      const bad = e.kind === "denied" || e.kind === "error" || (e.kind === "run" && e.exit !== 0);
      // A refusal's path field is the route (/write_file); the file it refused is in detail.
      const what = e.kind === "denied" || e.kind === "error" ? (e.detail || e.path || e.reason || "") : (e.command || e.path || e.reason || e.detail || "");
      const tail = e.kind === "run" ? (e.exit == null ? "no exit code" : `exit ${e.exit}`) : e.kind === "write" && e.bytes != null ? `${e.bytes} B` : e.reason || "";
      return `<li class="m-act-row${bad ? " bad" : ""}"><span class="m-act-kind">${esc(ACT_LABEL[e.kind] || e.kind)}</span><code class="m-act-what">${esc(what)}</code><span class="m-act-meta">${esc([tail, ago(e.at)].filter(Boolean).join(" · "))}</span></li>`;
    }).join("") + '</ol>';
  }

  function remindChooser(lot, species, stage) {
    const host = homePane.querySelector(`.m-lot[data-lot="${CSS.escape(lot)}"] .m-lot-actions`); if (!host) return;
    host.innerHTML = [3, 7, 14].map((d) => `<button type="button" class="ghost sm m-rem-pick" data-days="${d}">${d} days</button>`).join("") + '<button type="button" class="ghost sm m-rem-cancel">Cancel</button>';
    host.querySelector(".m-rem-cancel").addEventListener("click", () => renderHome());
    host.querySelectorAll(".m-rem-pick").forEach((b) => b.addEventListener("click", async () => {
      const r = await window.crowe.reminders.add({ lot, title: `Check ${lot}`, body: [species, stage].filter(Boolean).join(" · "), at: Date.now() + Number(b.dataset.days) * 86400000 });
      if (!r || !r.ok) alert((r && r.error) || "The reminder could not be set.");
      renderHome();
    }));
  }

  const VISION_PROMPT = "Describe what is visible in this photo, explain relevant details, and tell me what is uncertain.";
  /* The Camera tab reads as a field inspection: a specimen frame with the last
     capture on file, a numbered capture protocol, and a ledger of findings
     against lots. The register is the Log's: mono kickers, a serif title,
     hairline rows. Nothing here claims more than one photo can carry. */
  const verdictKind = (v) => /contamin|trichoderma|mold|mould|bacteri|cobweb|discard|isolate/i.test(v) ? "bad" : /harvest|ready|pins|pinning|fruit|cluster/i.test(v) ? "gold" : /healthy|clean|no contamination|colonis|coloniz/i.test(v) ? "myc" : "neutral";
  const plainWords = (v) => String(v || "").replace(/\*\*|__|`/g, "").replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+)/gm, "").replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=[\s.,;:!?]|$)/g, "$1$2");
  const firstSentence = (v) => { const t = plainWords(v).replace(/\s+/g, " ").trim(); const m = /^(.{12,160}?[.!?])(\s|$)/.exec(t); return m ? m[1] : t.slice(0, 140); };
  const fmtDay = (ts) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
  async function renderCamera() {
    const roll = window.crowe && window.crowe.camera ? await window.crowe.camera.list().catch(() => []) : [];
    const last = roll[0];
    cameraPane.innerHTML = [
      '<div class="m-home-inner">',
      '<header class="m-fi-head"><div class="m-kicker">Photo questions · CroweLM Vision</div><h1 class="m-title">Explore a photo</h1>',
      '<p class="m-home-sub">Choose a photo and ask CroweLM Vision to describe what is visible. Check important details yourself.</p></header>',
      `<section class="m-fi-frame${last ? "" : " is-empty"}"><div class="m-fi-view">`,
      last && last.thumb ? `<img class="m-fi-img" src="${last.thumb}" alt="last capture">` : "",
      '<div class="m-fi-lattice"></div><i class="m-fi-c c1"></i><i class="m-fi-c c2"></i><i class="m-fi-c c3"></i><i class="m-fi-c c4"></i><i class="m-fi-cross"></i>',
      last ? `<div class="m-fi-meta"><span>Last check</span><span>${esc(last.lot || "Photo")}</span><span>${esc(fmtDay(last.ts))}</span></div>` : '<div class="m-fi-empty"><span class="m-kicker">Photo</span>No capture on file.<br>Choose a clear photo to discuss in Chat.</div>',
      pendingLot ? `<div class="m-fi-lot">Checking lot <b>${esc(pendingLot)}</b></div>` : "",
      "</div>",
      '<div class="m-cam-actions"><button type="button" class="primary m-cam-shoot">Photograph</button><button type="button" class="ghost m-cam-pick">Choose a photo</button></div></section>',
      '<section class="m-fi-sec"><h2 class="m-kicker">Capture protocol</h2><ol class="m-fi-protocol"><li>Keep the subject in focus.</li><li>Use even light without glare.</li><li>Exclude private or sensitive information.</li><li>Review the answer before acting.</li></ol></section>',
      '<section class="m-fi-sec"><h2 class="m-kicker">Photo history</h2>',
      roll.length ? '<div class="m-ledger"><div class="m-ledger-head"><span>Date</span><span>Context</span><span>Finding</span></div>' + roll.slice(0, 20).map((c, i) => `<button type="button" class="m-ledger-row m-r-${verdictKind(c.verdict)}" data-i="${i}"><span class="d">${esc(fmtDay(c.ts))}</span><span class="l">${esc(c.lot || "Photo")}</span><span class="f">${esc(firstSentence(c.verdict))}</span><i class="mark"></i></button><div class="m-ledger-detail" hidden>${c.thumb ? `<img src="${c.thumb}" alt="">` : ""}<div class="said m-md">${mdSafe(c.verdict)}</div></div>`).join("") + "</div>" : '<p class="m-home-empty">No photo questions yet.</p>',
      "</section>",
      '<p class="m-fi-note">A finding is the model\'s reading of one image. It informs a hands-on inspection; it does not replace one.</p>',
      "</div>",
    ].join("");
    const camInput = () => document.querySelector('input[type="file"][accept="image/*"]');
    cameraPane.querySelector(".m-cam-shoot").addEventListener("click", () => { const i = camInput(); if (!i) return; cameraArmed = true; i.setAttribute("capture", "environment"); i.click(); });
    cameraPane.querySelector(".m-cam-pick").addEventListener("click", () => { const i = camInput(); if (!i) return; cameraArmed = true; i.removeAttribute("capture"); i.click(); setTimeout(() => i.setAttribute("capture", "environment"), 1500); });
    cameraPane.querySelectorAll(".m-ledger-row").forEach((row) => row.addEventListener("click", () => { const d = row.nextElementSibling; if (d) d.hidden = !d.hidden; row.classList.toggle("is-open", d && !d.hidden); }));
  }

  /* A photo taken from the Camera tab becomes a chat turn on its own: the photo
     is already attached by the picker, so the question goes out at once and the
     answer streams where every answer streams. */
  if (window.crowePhone && window.crowePhone.onChange) {
    window.crowePhone.onChange(() => {
      if (!cameraArmed) return;
      const photos = window.crowePhone.images ? window.crowePhone.images() : [];
      if (!photos.length) return;
      cameraArmed = false;
      photoTurn = { lot: pendingLot, thumb: "" };
      // The transcript is the chat space's; from Camera the space may still be
      // Log, whose lane surface would hide the scan and the answer.
      const chatBtn = spaceButtons().find((b) => b.dataset.space === "chat");
      if (chatBtn && body.dataset.space !== "chat") chatBtn.click();
      setPane("agent");
      const q = pendingLot ? `${VISION_PROMPT} This is lot ${pendingLot}.` : VISION_PROMPT;
      if (typeof send === "function") send(q);
      else { const inp = $("input"); if (inp) { inp.value = q; inp.dispatchEvent(new Event("input")); } }
    });
  }

  /* After a vision reply: one row under the answer to log it against a lot. The
     journal gets the verdict as a dated entry; the camera roll keeps the
     thumbnail and the first lines so Home can show what was checked. */
  if (window.crowe && window.crowe.agent && window.crowe.agent.onEvent) {
    window.crowe.agent.onEvent(async (ev) => {
      if (!ev) return;
      if (ev.type === "photos" && Array.isArray(ev.thumbs)) { if (!photoTurn) photoTurn = { lot: pendingLot, thumb: "" }; photoTurn.thumb = ev.thumbs[0] || ""; return; }
      if (!photoTurn || ev.agentId && ev.agentId !== "main") return;
      // The finding is the LAST thing the model said in this turn, not the first: a turn that opens
      // with "I'll pull your recent block records first" and then reads the photo must log the read,
      // not the preamble. Collect assistant texts and act when the turn is final.
      if (ev.type === "assistant") { const t = String(ev.text || "").trim(); if (t) photoTurn.text = t; return; }
      if (ev.type !== "final") return;
      const turn = photoTurn; photoTurn = null; pendingLot = "";
      const text = String(turn.text || "").trim(); if (!text) return;
      const bodies = document.querySelectorAll(".msg.assistant .body"); const body = bodies[bodies.length - 1]; if (!body) return;
      const row = document.createElement("div"); row.className = "m-log-row";
      row.innerHTML = '<button type="button" class="ghost sm m-log-it">Save to photo history</button><button type="button" class="ghost sm m-log-skip">Not now</button>';
      body.appendChild(row);
      row.querySelector(".m-log-skip").addEventListener("click", () => row.remove());
      row.querySelector(".m-log-it").addEventListener("click", async () => {
        await window.crowe.camera.add({ lot: "", verdict: text.slice(0, 400), thumb: turn.thumb });
        row.innerHTML = '<span class="m-log-done">Saved to photo history on this phone.</span>';
      });
    });
  }
  /* ── 1.1: the transcript a grower sees ─────────────────────────────────────
     The launch films had to hide the developer chrome with a stylesheet to be
     watchable: the colophon's tool and token counts, the route card, the tool
     cards' arguments and results, the tier picker, the copy buttons, the HUD
     strip. On the phone all of it is now off unless Settings says otherwise.
     Nothing is removed: mobile.css hides by class, keyed on body.m-usage, so
     the desktop renderer draws exactly what it always did and the switch turns
     the same elements back on.

     Two things need script rather than a stylesheet. A tool card collapses to
     one plain line ("Looked up your grow records") that expands on tap, and
     that line has to be written from the tool's name. And a failed turn ends
     in one sentence with a Try again button that sends the same message, and
     the same photo, again. */
  const TOOL_SUMMARY = {
    read_grow: "Looked up your records",
    log_grow: "Added to your log",
    open_url: "Opened a web page",
    read_file: "Read a file",
    write_file: "Wrote a file",
    run_command: "Ran a command on your machine",
  };
  const toolSummary = (name) => TOOL_SUMMARY[name]
    || (/calendar|event/i.test(name) ? "Checked your calendar"
      : /drive|doc|sheet/i.test(name) ? "Looked in your Drive"
      : /search|lookup|find|list/i.test(name) ? "Looked something up"
      : "Used a tool");
  function summarise(card) {
    if (card.dataset.mobile) return;
    card.dataset.mobile = "1";
    const isEdit = card.classList.contains("editcard");
    const name = isEdit ? "" : ((card.querySelector(".tc-name") || {}).textContent || "").trim();
    const path = isEdit ? ((card.querySelector(".ec-path") || {}).textContent || "").trim() : "";
    const line = isEdit ? `Proposed an edit${path ? " to " + path : ""}` : toolSummary(name);
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "m-tc-summary";
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = `<span class="m-tc-dot"></span><span class="m-tc-text">${esc(line)}</span><span class="m-tc-more">Details</span>`;
    btn.addEventListener("click", () => { const open = card.classList.toggle("m-open"); btn.setAttribute("aria-expanded", String(open)); });
    card.insertBefore(btn, card.firstChild);
  }

  /* The turn that failed, so Try again can send it back. The text is the user
     bubble's own; the photos are the ones the scan drew into it, still data
     URLs; the lot is the one the Camera tab was checking, remembered here
     because the log-row handler above clears it when the turn ends. */
  let failedLot = "";
  if (window.crowe && window.crowe.agent && window.crowe.agent.onEvent) {
    window.crowe.agent.onEvent((ev) => {
      if (ev && ev.type === "error" && (!ev.agentId || ev.agentId === "main")) failedLot = photoTurn ? photoTurn.lot : "";
    });
  }
  const RAW_ERROR = /^(HTTP \d{3}\b|gateway( unreachable)?:|stream broke:|The run did not complete:|\s*[\[{])/i;
  function dressError(err) {
    if (err.dataset.mobile) return;
    err.dataset.mobile = "1";
    const raw = err.textContent;
    // The bridge already speaks plainly; this is the net under the renderer's
    // own two error paths, which quote whatever was thrown.
    if (RAW_ERROR.test(raw)) {
      const said = window.__croweHumanError ? window.__croweHumanError(raw) : null;
      try { console.error("[crowe] turn failed:", raw); } catch { /* no console */ }
      err.textContent = said && said.kind !== "message" ? said.text : "The reading did not come back. Try again.";
    }
    const msg = err.closest(".msg.assistant");
    const user = msg && msg.previousElementSibling;
    if (!user || !user.classList.contains("user")) return;
    const p = user.querySelector(".body > p");
    const text = p ? p.textContent : "";
    if (!text.trim()) return;
    const photos = [...user.querySelectorAll(".m-sent-photos img")]
      .map((img, i) => ({ name: i ? `photo ${i + 1}.jpg` : "photo.jpg", src: img.getAttribute("src") || "" }))
      .filter((x) => /^data:image\//.test(x.src));
    const lot = failedLot;
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "m-retry ghost sm"; btn.textContent = "Try again";
    btn.addEventListener("click", () => retryTurn({ text, photos, lot, user, msg }));
    err.appendChild(btn);
  }
  function retryTurn(t) {
    if (typeof send !== "function") return;
    if (typeof running !== "undefined" && running) return;
    // The failed exchange comes out of the transcript and out of the
    // conversation the model is shown, so the retry is the same turn again and
    // not a second copy of the question under the first.
    try {
      if (typeof messages !== "undefined" && messages.length && messages[messages.length - 1].role === "user" && messages[messages.length - 1].content === t.text) messages.pop();
    } catch { /* the renderer keeps its own list; a duplicate is not worth failing the retry */ }
    t.msg.remove(); t.user.remove();
    if (t.lot) pendingLot = t.lot;
    if (t.photos.length && window.crowePhone && window.crowePhone.addImage) {
      cameraArmed = false;    // the photo rides this send; the Camera tab's own trigger stays quiet
      for (const ph of t.photos) window.crowePhone.addImage(ph.name, ph.src);
    }
    send(t.text);
  }
  if (transcript) {
    const dress = (root) => {
      if (!root || root.nodeType !== 1) return;
      if (root.matches(".toolcard, .editcard:not(.gatecard)")) summarise(root);
      root.querySelectorAll(".toolcard, .editcard:not(.gatecard)").forEach(summarise);
      if (root.matches(".err")) dressError(root);
      root.querySelectorAll(".err").forEach(dressError);
    };
    dress(transcript);
    new MutationObserver((records) => { for (const r of records) r.addedNodes.forEach(dress); }).observe(transcript, { childList: true, subtree: true });
  }

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
    ? "Your operator, in your pocket, and it reaches your desktop. Ask it to reason, look things up, read and change files on the paired machine, or run a command there."
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

  // Three, in the order they earn their place: the machine when there is one,
  // the farm when that space is on, then general reasoning to fill the rest.
  const welcomeChips = () => {
    const chips = [];
    if (isPaired()) chips.push(...MACHINE_CHIPS);

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
    ["This is the operator over your CroweLM gateway: chat, a real terminal, files, git, and plugin tools, all reviewed through one agent loop.",
     "Turn a question into work you can inspect: understand a problem, review an attachment, or work with files and commands on your paired computer."],
    ["Open the project folder the agent should work in (the button below, or Cmd+O).",
     "Pair a desktop in Settings under Remote machine, and it can work on that machine from here."],
    ["Give the agent a task. Try",
     "Ask it something. Try"],
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

  if (transcript) {
    mobiliseWelcome(transcript);
    transcript.querySelectorAll(".msg .said").forEach(mobiliseCopy);
    // Both the welcome and the first-run card are rebuilt on a new chat, so the
    // swap runs on every change to the transcript rather than once at load.
    // innerHTML rewriting would drop the card's buttons and their handlers, so
    // it is confined to the nodes that carry prose.
    // A phone has no local folder to open; the desktop's button would promise one.
    // Stripped here as well as on the event below, because the card can be built
    // before this script has registered its listener, and then the event is gone.
    const stripFolderButton = (root) => root.querySelectorAll(".onboarding-actions button").forEach((b) => { if (/Open a project folder/.test(b.textContent)) b.remove(); });
    stripFolderButton(transcript);
    new MutationObserver((records) => {
      mobiliseWelcome(transcript);
      if (!records.some((r) => [...r.addedNodes].some((n) => n.nodeType === 1))) return;
      // The card is appended empty and filled a statement later, so the pass
      // waits a turn. Only direct children are observed, so streaming text —
      // which lands inside a message that already exists — never triggers it.
      setTimeout(() => { transcript.querySelectorAll(".msg .said").forEach(mobiliseCopy); stripFolderButton(transcript); }, 0);
    }).observe(transcript, { childList: true });
    // The onboarding card is filled after its empty message node is appended.
    // Listen for the completed card as well as the DOM mutation so the phone
    // never exposes desktop-only copy because two task queues happened to race.
    window.addEventListener("crowe:onboarding-shown", (event) => {
      const root = event.detail && event.detail.root;
      if (root && root.querySelectorAll) root.querySelectorAll(".said").forEach(mobiliseCopy);
      if (root && root.querySelectorAll) stripFolderButton(root);
    });
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
    edit: "Describe the file change you need.",
    execute: "Describe the task and the result you want.",
  };
  // What each tier means changes once a machine is paired, because the tier is
  // then gating a real shell and not only the grow log. Saying "your grow log"
  // while Execute can delete a directory would be the friendliest lie here.
  const TIER_HINT_PAIRED = {
    plan: "Describe a task. It plans it out first, and touches nothing.",
    readonly: "Ask anything. It reads files on the paired machine.",
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

  // ─── Files from this phone ─────────────────────────────────────────────────
  /* The phone-side half of the picker grant (the store and the phone: tool
     paths live in mobile-bridge.js). An <input type="file"> IS the platform
     document picker — the Files app sheet on iOS, the system picker on
     Android — so no native plugin stands between the tap and the grant.

     The chips row shows every file the app currently holds, picked or written
     by the agent, and a tap on a chip opens the share sheet: that is the only
     way a changed copy leaves the app, so the row is where "saving" visibly
     lives. Text files only, and small ones — this hands documents to a
     conversation, it is not a file manager. */
  const composerForm = $("composer");
  if (composerForm && window.crowePhone) {
    const frame = composerForm.querySelector(".composer-frame");
    const foot = composerForm.querySelector(".composer-foot");
    const actions = composerForm.querySelector(".composer-actions");
    const row = document.createElement("div");
    row.id = "m-attach-row";
    if (frame && foot) frame.insertBefore(row, foot);
    else composerForm.insertBefore(row, composerForm.firstChild);
    const picker = document.createElement("input");
    picker.type = "file"; picker.multiple = true; picker.hidden = true;
    picker.accept = "image/*,text/*,.md,.txt,.csv,.json,.js,.ts,.py,.html,.css,.yml,.yaml,.toml,.sh,.log";
    const clipBtn = document.createElement("button");
    clipBtn.type = "button"; clipBtn.id = "m-attach"; clipBtn.className = "bar-icon";
    clipBtn.title = "Attach a file from this phone";
    clipBtn.setAttribute("aria-label", "Attach a file from this phone");
    clipBtn.innerHTML = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 11.5 12 20a5.2 5.2 0 0 1-7.4-7.4l8.6-8.5a3.5 3.5 0 0 1 4.9 4.9l-8.5 8.5a1.8 1.8 0 0 1-2.5-2.5l7.8-7.8"/></svg>';
    clipBtn.addEventListener("click", () => picker.click());
    if (actions) actions.insertBefore(clipBtn, actions.firstChild);
    else if (foot) foot.insertBefore(clipBtn, foot.firstChild);
    composerForm.appendChild(picker);
    /* Photos. The same picker accepts them (the Photos library on iOS), and a
       second input with `capture` opens the camera straight away, which is the
       gesture at the rack: point at the block, ask what that is. Either way
       the file is downsized here before it becomes a data URL, so a 4 MB HEIC
       leaves the phone as a JPEG a few hundred KB wide that the vision tier
       reads just as well. */
    const cam = document.createElement("input");
    cam.type = "file"; cam.accept = "image/*"; cam.hidden = true; cam.setAttribute("capture", "environment");
    const camBtn = document.createElement("button");
    camBtn.type = "button"; camBtn.id = "m-camera"; camBtn.className = "bar-icon";
    camBtn.title = "Attach a photo to your question";
    camBtn.setAttribute("aria-label", "Attach a photo to your question");
    camBtn.innerHTML = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
    camBtn.addEventListener("click", () => cam.click());
    clipBtn.insertAdjacentElement("afterend", camBtn);
    composerForm.appendChild(cam);

    const PHOTO_EDGE = 1280;
    async function shrinkPhoto(file) {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close && bitmap.close();
      return canvas.toDataURL("image/jpeg", 0.82);
    }
    async function takeIn(files) {
      for (const file of files || []) {
        if (/^image\//.test(file.type) || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name)) {
          try {
            const r = window.crowePhone.addImage(file.name || "photo.jpg", await shrinkPhoto(file));
            if (r.error) alert(`${file.name}: ${r.error}`);
          } catch (e) { alert(`${file.name}: this photo could not be read (${String(e && e.message || e).slice(0, 80)})`); }
          continue;
        }
        if (file.size > window.crowePhone.max) { alert(`${file.name} is over the ${Math.round(window.crowePhone.max / 1024)} KB cap for attached files.`); continue; }
        const text = await file.text();
        // A null byte means this is not text; the tools would hand the model gibberish.
        if (/\u0000/.test(text.slice(0, 4096))) { alert(`${file.name} is not a text file. The operator reads text files and photos.`); continue; }
        const r = window.crowePhone.add(file.name, text);
        if (r.error) alert(`${file.name}: ${r.error}`);
      }
    }
    picker.addEventListener("change", async () => { await takeIn(picker.files); picker.value = ""; });
    cam.addEventListener("change", async () => { await takeIn(cam.files); cam.value = ""; });
    const renderRow = () => {
      const files = window.crowePhone.list();
      row.innerHTML = "";
      for (const f of files) {
        const chip = document.createElement("span");
        chip.className = "m-attach-chip";
        chip.innerHTML = `<button type="button" class="m-attach-share" title="Share or save ${esc(f.name)}">${esc(f.name)}</button><button type="button" class="m-attach-x" aria-label="Remove ${esc(f.name)}">&times;</button>`;
        chip.querySelector(".m-attach-share").addEventListener("click", () => window.crowePhone.share(f.name));
        chip.querySelector(".m-attach-x").addEventListener("click", () => window.crowePhone.remove(f.name));
        row.appendChild(chip);
      }
      const photos = window.crowePhone.images ? window.crowePhone.images() : [];
      for (const ph of photos) {
        const chip = document.createElement("span");
        chip.className = "m-attach-chip is-photo";
        chip.innerHTML = `<span class="m-attach-name" title="Goes to CroweLM Vision with your next message">${esc(ph.name)}</span><button type="button" class="m-attach-x" title="Remove ${esc(ph.name)}" aria-label="Remove ${esc(ph.name)}">×</button>`;
        chip.querySelector(".m-attach-x").addEventListener("click", () => window.crowePhone.remove(ph.name));
        row.appendChild(chip);
      }
      row.classList.toggle("has-files", files.length + photos.length > 0);
    };
    renderRow();
    window.crowePhone.onChange(renderRow);
    /* The photo leaves the chip row the moment the turn starts; show it in the
       bubble that asked, so the transcript reads as what was actually sent. */
    /* The scan. While CroweLM Vision works, the photo it was given sits large
       in the bubble that sent it, under a moving hairline; the areas the model
       says it examined arrive as their own event before any prose and are drawn
       where they are, with their labels, so the reading is watched, not waited
       for. The boxes stay when the answer lands; a tap on the photo hides them. */
    let activeScan = null;
    const REGION_KIND = [
      [/trich|mold|mould|contam|bacter|slim|wet spot|blotch|rot|green patch|black|yellow stain|cobweb/i, "bad"],
      [/pin|primordia|fruit|cap|cluster|harvest|bouquet|stem|gill/i, "gold"],
      [/mycel|substrate|coloni|white|healthy|block|bag|agar|grain|surface/i, "myc"],
    ];
    const regionKind = (label) => (REGION_KIND.find(([re]) => re.test(label)) || [null, "neutral"])[1];
    function beginScan(strip, img) {
      strip.classList.add("m-scan");
      const wrap = document.createElement("div"); wrap.className = "m-scan-wrap m-scan-sending";
      img.classList.add("m-scan-photo");
      wrap.appendChild(img);
      for (const cls of ["m-scan-lattice", "m-scan-sweep"]) { const el = document.createElement("div"); el.className = cls; wrap.appendChild(el); }
      const boxes = document.createElement("div"); boxes.className = "m-scan-boxes"; wrap.appendChild(boxes);
      const tiles = document.createElement("div"); tiles.className = "m-scan-tiles"; tiles.hidden = true;
      const cap = document.createElement("div"); cap.className = "m-scan-cap"; cap.innerHTML = '<span class="m-scan-dot"></span><span class="m-scan-cap-text">Sending the photo to CroweLM Vision</span>';
      strip.appendChild(wrap); strip.appendChild(tiles); strip.appendChild(cap);
      const fit = () => { if (img.naturalWidth && img.naturalHeight) wrap.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`; };
      if (img.complete) fit(); else img.addEventListener("load", fit, { once: true });
      wrap.addEventListener("click", () => wrap.classList.toggle("m-scan-hide"));
      activeScan = { strip, wrap, img, boxes, tiles, cap, regions: [], reading: false };
    }
    const scanSay = (text) => { if (activeScan) activeScan.cap.querySelector(".m-scan-cap-text").textContent = text; };
    /* The dissection: one tile per reported area, cut from the photo itself at
       the model's coordinates with a little margin, so the reading can be
       inspected part by part. Tapping a tile lights its box. */
    function cutTiles() {
      const sc = activeScan; if (!sc || !sc.regions.length || !sc.img.naturalWidth) return;
      sc.tiles.innerHTML = ""; sc.tiles.hidden = false;
      const W = sc.img.naturalWidth, H = sc.img.naturalHeight;
      sc.regions.forEach((r, i) => {
        const pad = 0.06;
        const x0 = Math.max(0, (r.x - pad) * W), y0 = Math.max(0, (r.y - pad) * H);
        const x1 = Math.min(W, (r.x + r.w + pad) * W), y1 = Math.min(H, (r.y + r.h + pad) * H);
        const side = Math.max(x1 - x0, y1 - y0, 24);
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const sx = Math.max(0, Math.min(W - side, cx - side / 2)), sy = Math.max(0, Math.min(H - side, cy - side / 2));
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 240;
        try { canvas.getContext("2d").drawImage(sc.img, sx, sy, Math.min(side, W - sx), Math.min(side, H - sy), 0, 0, 240, 240); } catch { /* a tainted or unloaded image: no tile */ return; }
        const tile = document.createElement("button"); tile.type = "button"; tile.className = `m-scan-tile m-r-${regionKind(r.label)}`; tile.style.animationDelay = `${i * 120}ms`;
        tile.appendChild(canvas);
        const lab = document.createElement("span"); lab.className = "m-scan-tile-label"; lab.textContent = r.label; tile.appendChild(lab);
        tile.addEventListener("click", () => {
          const on = tile.classList.toggle("is-focus");
          sc.tiles.querySelectorAll(".m-scan-tile").forEach((t) => { if (t !== tile) t.classList.remove("is-focus"); });
          sc.boxes.querySelectorAll(".m-scan-box").forEach((b, j) => b.classList.toggle("is-focus", on && j === i));
          sc.wrap.classList.toggle("m-scan-focus", on);
        });
        sc.tiles.appendChild(tile);
      });
    }
    function scanRegions(regions) {
      if (!activeScan) return;
      activeScan.wrap.classList.remove("m-scan-sending");
      activeScan.boxes.innerHTML = "";
      activeScan.regions = regions;
      regions.forEach((r, i) => {
        const box = document.createElement("div"); box.className = `m-scan-box m-r-${regionKind(r.label)}`;
        box.style.left = `${(r.x * 100).toFixed(2)}%`; box.style.top = `${(r.y * 100).toFixed(2)}%`;
        box.style.width = `${(r.w * 100).toFixed(2)}%`; box.style.height = `${(r.h * 100).toFixed(2)}%`;
        box.style.animationDelay = `${i * 260}ms`;
        box.innerHTML = '<i class="c c1"></i><i class="c c2"></i><i class="c c3"></i><i class="c c4"></i>';
        const label = document.createElement("span"); label.className = "m-scan-label"; label.textContent = `${i + 1}  ${r.label}`;
        if (r.y < 0.12) label.classList.add("below");
        box.appendChild(label);
        activeScan.boxes.appendChild(box);
      });
      scanSay(regions.length ? "Looking at " + regions.map((r) => r.label.toLowerCase()).join(", ") : "Reading the photo");
      if (activeScan.img.complete && activeScan.img.naturalWidth) cutTiles(); else activeScan.img.addEventListener("load", cutTiles, { once: true });
    }
    function scanReading() {
      if (!activeScan || activeScan.reading) return;
      activeScan.reading = true;
      activeScan.wrap.classList.remove("m-scan-sending");
      if (!activeScan.regions.length) scanSay("Reading the photo");
    }
    function scanReasoning(text) {
      if (!activeScan || !text) return;
      const d = document.createElement("details"); d.className = "m-scan-reason";
      d.innerHTML = `<summary>Reasoning<span class="m-scan-reason-tag">owner view</span></summary><p>${esc(text)}</p>`;
      activeScan.strip.appendChild(d);
    }
    function endScan(how, why) {
      if (!activeScan) return;
      activeScan.strip.classList.add("m-scan-done");
      activeScan.wrap.classList.remove("m-scan-sending");
      scanSay(how === "error" ? String(why || "The photo could not be read.").slice(0, 160) : how === "stopped" ? "Stopped." :
        (activeScan.regions.length ? `Read. ${activeScan.regions.length} area${activeScan.regions.length === 1 ? "" : "s"} marked; tap the photo to hide them.` : "Read."));
      activeScan = null;
    }
    if (window.crowe && window.crowe.agent && window.crowe.agent.onEvent) {
      window.crowe.agent.onEvent((ev) => {
        if (!ev) return;
        if (ev.type === "vision_regions" && Array.isArray(ev.regions)) { scanRegions(ev.regions); return; }
        if (ev.type === "vision_reasoning" && typeof ev.text === "string") { scanReasoning(ev.text); return; }
        if (ev.type === "assistant_delta") { scanReading(); return; }
        /* The scan runs until the TURN ends, not until the first text. A read
           that opens with "I'll pull your recent block records first", calls
           read_grow and then reads the photo used to be marked Read. at the
           preamble, and the regions arriving a round later had no scan left to
           land on. Same shape of bug as the log row's, fixed the same way. */
        if (ev.type === "assistant") { scanReading(); return; }
        if (ev.type === "final") { endScan("done"); return; }
        if (ev.type === "error") { endScan("error", ev.text); return; }
        if (ev.type === "stopped") { endScan("stopped"); return; }
        if (ev.type !== "photos" || !Array.isArray(ev.thumbs)) return;
        const bodies = document.querySelectorAll(".msg.user .body");
        const body = bodies[bodies.length - 1];
        if (!body) return;
        const strip = document.createElement("div");
        strip.className = "m-sent-photos";
        ev.thumbs.forEach((src, i) => {
          const img = document.createElement("img");
          img.className = "m-sent-photo"; img.src = src; img.alt = "photo sent to CroweLM Vision";
          if (i === 0) { beginScan(strip, img); return; }
          strip.appendChild(img);
        });
        body.appendChild(strip);
      });
    }
  }

  /* The surface composers' placeholders were written for a desktop-width
     input. At 390px, minus the send button, they clip mid-word — Projects
     opened on "routed to the right expert" cut at "routec", which reads as a
     rendering fault rather than as elision. Static text, so set once. */
  const SURFACE_HINTS = { "home-input": "Start a task. It opens in Chat.", "cult-input": "Ask the grower anything." };
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
  /* The Phone companion section is the desktop's half of pairing: it starts a
     listener on this machine and draws the QR the phone scans. On the phone it
     described a Tailscale it could not find, under a heading about a phone it
     already was. The Remote machine section below is the phone's half. */
  const companion = $("companion-body") || $("companion-state");
  const companionSection = companion && companion.closest("section");
  if (companionSection) companionSection.classList.add("m-desktop-only");

  /* The reply pace. The phone now starts on brisk (mobile-bridge.js DEFAULTS),
     so the desktop's option label naming reading pace as the phone's default is
     relabelled here, on the phone only. */
  const paceSelect = $("cfg-pace");
  if (paceSelect) {
    const PACE_LABEL = { reading: "Reading pace, slower", brisk: "Brisk, keeps up with the model (the phone's default)", instant: "Instant" };
    [...paceSelect.options].forEach((o) => { if (PACE_LABEL[o.value]) o.textContent = PACE_LABEL[o.value]; });
  }

  /* The one switch for the developer chrome (see "the transcript a grower
     sees" above). Applies on the tap and persists through the bridge as
     showUsage, so it is a fact the app remembers and not a mode it is in. */
  const detailsSection = document.createElement("section");
  detailsSection.className = "key-manager m-details";
  detailsSection.innerHTML = [
    '<div class="settings-section-head"><div><b>Details</b>',
    "<span>Which expert answered, what it looked up, token counts and cost under each reply, the strip above the tabs, and the Plan, Read and Edit picker under the composer. Off, a reply is just the reply.</span></div></div>",
    '<label class="chk"><input id="m-cfg-usage" type="checkbox" /> Show usage and routing details</label>',
  ].join("");
  const guardrails = paceSelect && paceSelect.closest("section");
  if (guardrails && guardrails.parentNode) guardrails.parentNode.insertBefore(detailsSection, guardrails.nextSibling);
  const usageBox = $("m-cfg-usage");
  const paintUsage = (on) => { body.classList.toggle("m-usage", Boolean(on)); if (usageBox) usageBox.checked = Boolean(on); };
  async function syncUsage() {
    try { const c = await window.crowe.getConfig(); paintUsage(c && c.showUsage); } catch { /* the bridge answers on the next open */ }
  }
  syncUsage();
  if (usageBox) usageBox.addEventListener("change", async () => {
    paintUsage(usageBox.checked);
    try { await window.crowe.setConfig({ showUsage: usageBox.checked }); } catch { /* shown either way; saved next time */ }
  });

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
    "<span>A machine this phone may drive. On your desktop, open Crowe Logic → Settings → Phone companion and scan the code, or enter its tailnet address by hand. ",
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
  /* The gateway address and a pasted token are for support and self-hosting,
     not for a first look. Folded away, Settings opens on what a person came for
     — the computer, the account — and a reviewer does not meet two developer
     fields before anything else. */
  const baseRow = $("cfg-base") && $("cfg-base").closest("label");
  if (baseRow && tokenRow && baseRow.parentNode) {
    const adv = document.createElement("details");
    adv.className = "m-advanced";
    adv.innerHTML = '<summary>Advanced: gateway and token</summary>';
    baseRow.parentNode.insertBefore(adv, remoteSection.nextSibling);
    adv.append(baseRow, tokenRow);
  }
  /* The status line sits after the sticky action row on desktop. Here that
     leaves a strip below the buttons where the scroll shows through, so it
     reads above them instead, next to what was just saved. */
  const status = $("cfg-status"), actions = status && status.previousElementSibling;
  if (actions && actions.classList.contains("row")) actions.parentNode.insertBefore(status, actions);

  /* Account deletion, App Store guideline 5.1.1(v). The deletion happens on
     the Crowe ID account page, which the bridge opens in the browser sheet;
     when the sheet closes the bridge finds out whether the account is still
     there and signs the phone out if it is not. Phone-only for the same reason
     as the section above: the desktop has its own account surface. */
  /* Siri and Shortcuts. "Ask Crowe Logic <question>" sends the question as a
     turn — unless a paired computer is at Edit or Execute, where a Shortcut
     automation (not a person) could otherwise write files or run commands
     unseen. There it lands in the composer for a tap. The note arrives from the
     bridge as crowe:intent (see takePendingIntent). "log-block" notes from
     builds before 1.1 still open the legacy form. */
  window.addEventListener("crowe:intent", (e) => {
    if (e && e.detail && e.detail.kind === "home") { setPane("home"); return; }
    const d = (e && e.detail) || {};
    if (d.kind === "ask" && d.text) {
      __tapTab("Chat");
      const acts = body.classList.contains("m-paired") && (body.dataset.tier === "edit" || body.dataset.tier === "execute");
      if (acts) {
        const inp = $("input");
        if (inp) { inp.value = d.text; inp.dispatchEvent(new Event("input")); inp.focus(); }
      } else if (typeof send === "function") { send(d.text); }
      else { const inp = $("input"); if (inp) { inp.value = d.text; inp.dispatchEvent(new Event("input")); const go = $("send"); if (go) go.click(); } }
    } else if (d.kind === "log-block" && !cultivationOn()) {
      // No Cultivation on this build, so no form to open: the note waits in
      // Chat's composer instead of vanishing.
      __tapTab("Chat");
      const inp = $("input");
      if (inp && d.text) { inp.value = d.text; inp.dispatchEvent(new Event("input")); inp.focus(); }
    } else if (d.kind === "log-block") {
      __tapTab("Cultivation");
      const blocks = document.querySelector('#cult-nav .sn-item[data-cult="blocks"]');
      if (blocks) blocks.click();
      setTimeout(() => {
        const form = document.querySelector("#lane-body form.grow-add");
        if (!form) return;
        if (d.text && form.elements.notes) form.elements.notes.value = d.text;
        const first = form.elements.species || form.querySelector("input,select");
        if (first) first.focus();
      }, 350);
    }
  });
  function __tapTab(label) {
    const tab = [...document.querySelectorAll("#m-tabs .m-tab")].find((t) => t.textContent.trim() === label);
    if (tab) tab.click();
  }

  /* Dictation. WKWebView exposes webkitSpeechRecognition but the recogniser
     behind it never starts (WebKit 239816), so the desktop handler would light
     the button and fail. On the phone the button drives CroweSpeech, a small
     native plugin in the app target over Apple's speech recogniser, and writes
     into the composer exactly as the desktop handler does: appended to what is
     already typed, one input event per partial result. */
  const Speech = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CroweSpeech;
  const dictBtn = $("voice-input"), dictInput = $("input");
  const say = (text, state) => { if (typeof setComposerStatus === "function") setComposerStatus(text, state); };
  if (dictBtn && dictInput && Speech && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
    dictBtn.classList.remove("unavailable"); dictBtn.removeAttribute("aria-disabled"); dictBtn.title = "Dictate with microphone";
    let capture = null, revision = 0;
    const stopped = () => {
      dictBtn.classList.remove("active"); dictBtn.setAttribute("aria-pressed", "false");
      const st = $("composer-status");
      if (st && st.dataset.state === "listening") say("Ready");
    };
    const cancel = () => { revision++; const old = capture; capture = null; stopped(); if (old) void old.stop(); };
    dictBtn.onclick = () => {
      if (capture) { cancel(); return; }
      const begin = window.croweKeyboard?.captureSpeech;
      if (!begin) { say("Dictation is not available in this build", "error"); return; }
      if (document.hidden) return;
      const attempt = ++revision, base = dictInput.value.trim();
      const current = () => attempt === revision && !document.hidden && dictInput.isConnected && dictInput.getClientRects().length;
      const next = begin(Speech, "composer", {
        partial: d => {
          if (!current()) { cancel(); return; }
          const heard = Array.isArray(d.matches) && d.matches.length ? String(d.matches[0]) : "";
          dictInput.value = (base + " " + heard).trim();
          dictInput.dispatchEvent(new Event("input"));
        },
        stopped: () => { if (attempt === revision) { capture = null; stopped(); } },
        error: e => { if (attempt === revision) { capture = null; say("Dictation failed: " + String(e?.message || e).slice(0, 120), "error"); stopped(); } },
      });
      if (!next) { say("Finish the current dictation before starting another", "error"); return; }
      capture = next;
      dictBtn.classList.add("active"); dictBtn.setAttribute("aria-pressed", "true"); say("Listening", "listening");
    };
    document.addEventListener("visibilitychange", () => { if (document.hidden) cancel(); });
    window.addEventListener("pagehide", cancel);
    const speechVisibility = new MutationObserver(() => {
      if (capture && (!dictInput.isConnected || !dictInput.getClientRects().length)) cancel();
    });
    speechVisibility.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "style"] });
  } else if (dictBtn && window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
    // No native recogniser in this build: say so instead of lighting a button that fails.
    dictBtn.classList.add("unavailable"); dictBtn.setAttribute("aria-disabled", "true"); dictBtn.title = "Dictation is not available in this build";
    dictBtn.onclick = () => say("Dictation is not available in this build", "error");
  }

  /* The plan, and the way up. Three places a free account meets it:

       · a plan notice in the transcript (the bridge's "plan" event, which the
         renderer renders as one muted line) gets a See plans button under it;
       · the Settings row below names the tier and offers the same;
       · the card itself, in the transcript, in the renderer's own .plan-card
         markup, with the live price from the ladder.

     The bridge decides whether a sale may happen here at all: billing.plan()
     answers buyHere, true only on the United States App Store storefront.
     Where it is false none of the three is drawn, not the button, not the
     card, not a web price, because showing a way out to buy is itself what
     App Review calls steering (3.1.1). Nothing is drawn while the answer is
     pending either, so a refused storefront never sees a flash. The UI never
     reads the price from anywhere but billing.catalog, and never navigates the
     webview to Stripe: the bridge opens the system browser and the card waits
     for crowe:plan, which the bridge fires on the way back. */
  const billing = window.crowe && window.crowe.billing;
  const PLAN_NAMES = { free: "Free", personal: "Personal", pro: "Pro", team: "Team", max: "Max", scale: "Scale", studio: "Studio", business: "Business", enterprise: "Enterprise", byok: "BYOK" };
  const money = (cents, interval) => `$${Math.round(cents / 100)}${interval ? ` a ${interval}` : ""}`;
  const buyHere = async () => { try { return Boolean((await billing.plan()).buyHere); } catch { return false; } };
  async function planCard(reason) {
    if (!transcript || !billing || !(await buyHere())) return;
    const prior = transcript.querySelector(".plan-card");
    if (prior) { prior.scrollIntoView({ block: "nearest" }); return; }
    const wrap = document.createElement("div");
    wrap.className = "msg assistant";
    wrap.innerHTML = '<div class="who"><span class="who-mark" role="img" aria-label="Crowe Logic"></span></div><div class="body"><div class="plan-card">'
      + '<div class="plan-head"><b>Crowe Logic Pro</b><span class="plan-price">reading the price</span></div>'
      + '<p class="said plan-why"></p><ul class="plan-feats"></ul>'
      + '<div class="plan-row"><button type="button" class="primary plan-go">Upgrade on crowelogic.com</button><button type="button" class="ghost plan-later">Not now</button></div>'
      + '<p class="hint plan-note"></p></div></div>';
    const welcome = transcript.querySelector(".welcome"); if (welcome) welcome.remove();
    transcript.appendChild(wrap); wrap.scrollIntoView({ block: "end" });
    const card = wrap.querySelector(".plan-card");
    card.querySelector(".plan-why").textContent = (reason === "paywall" ? "That turn needs a plan. " : "")
      + "One subscription unlocks every Crowe Logic surface: the operator here and on the desktop, the rooms and named agents, and the CLI. It opens in your browser; the plan goes on your Crowe ID.";
    const priceEl = card.querySelector(".plan-price");
    try {
      const cat = await billing.catalog();
      const pro = ((cat && cat.ladder) || []).find((i) => i.slug === "pro");
      if (pro && pro.amount) {
        priceEl.textContent = money(pro.amount, pro.interval);
        card.querySelector(".plan-feats").innerHTML = (pro.features || []).slice(0, 6).map((f) => `<li>${esc(f)}</li>`).join("");
      } else priceEl.textContent = "price at checkout";
    } catch { priceEl.textContent = "price at checkout"; }
    const go = card.querySelector(".plan-go");
    go.addEventListener("click", async () => {
      go.disabled = true; go.textContent = "Opening your browser";
      const r = await billing.checkout("pro");
      if (r && r.ok) { card.querySelector(".plan-note").textContent = "Finish in your browser. This phone picks up the plan when you come back."; go.textContent = "Opened in your browser"; return; }
      go.disabled = false; go.textContent = "Upgrade on crowelogic.com";
      card.querySelector(".plan-note").textContent = (r && r.error) || "Checkout is not answering. Try again in a moment.";
    });
    card.querySelector(".plan-later").addEventListener("click", () => wrap.remove());
  }
  // A See plans button under each plan notice the renderer writes.
  if (transcript && billing) new MutationObserver(async (records) => {
    const added = records.flatMap((r) => [...r.addedNodes]);
    if (!added.some((n) => n instanceof HTMLElement && (n.matches(".notice.plan") || n.querySelector(".notice.plan")))) return;
    if (!(await buyHere())) return;
    for (const n of added) {
      if (!(n instanceof HTMLElement)) continue;
      const notices = n.matches && n.matches(".notice.plan") ? [n] : [...(n.querySelectorAll ? n.querySelectorAll(".notice.plan") : [])];
      for (const el of notices) {
        if (el.dataset.upgrade) continue; el.dataset.upgrade = "1";
        const b = document.createElement("button"); b.type = "button"; b.className = "ghost sm m-plan-up"; b.textContent = "See plans";
        b.addEventListener("click", () => planCard("paywall"));
        el.appendChild(document.createTextNode(" ")); el.appendChild(b);
      }
    }
  }).observe(transcript, { childList: true, subtree: true });

  const planSection = document.createElement("section");
  planSection.className = "key-manager m-plan";
  planSection.innerHTML = '<div class="settings-section-head"><div><b>Your plan</b><span id="m-plan-line">Reading your plan.</span></div></div><button id="m-plan-up" class="ghost sm" type="button" hidden>See plans</button>';
  async function paintPlan(p) {
    if (!billing) return;
    try { p = p || await billing.plan(); } catch { p = null; }
    const line = planSection.querySelector("#m-plan-line"), btn = planSection.querySelector("#m-plan-up");
    if (!p || !p.email) { line.textContent = "Sign in with your Crowe ID to see your plan."; btn.hidden = true; return; }
    if (!p.known) { line.textContent = "Your plan is managed on your Crowe ID."; btn.hidden = true; return; }
    const name = PLAN_NAMES[String(p.tier || "free").toLowerCase()] || p.tier || "Free";
    line.textContent = p.paid ? `${name}. Use Manage billing above to review your subscription.`
      : p.buyHere ? "Free. Pro unlocks every CroweLM tier and the frontier engines." : `${name}.`;
    btn.hidden = Boolean(p.paid) || !p.buyHere;
  }
  planSection.querySelector("#m-plan-up").addEventListener("click", () => {
    $("settings")?.classList.add("hidden");
    __tapTab("Chat");
    planCard("settings");
  });
  window.addEventListener("crowe:plan", (e) => {
    paintPlan(null);
    const d = e && e.detail;
    if (d && d.paid) { const c = transcript && transcript.querySelector(".plan-card"); if (c) c.querySelector(".plan-note").textContent = `Your Crowe ID is on ${PLAN_NAMES[String(d.tier).toLowerCase()] || d.tier}. Thank you.`; }
  });
  paintPlan(null);

  const accountSection = document.createElement("section");
  accountSection.className = "key-manager m-account";
  accountSection.innerHTML = [
    '<div class="settings-section-head"><div><b>Your Crowe ID</b>',
    "<span>Deleting your Crowe ID removes the account and everything kept under it, including any plan on it, and cannot be undone. ",
    "This opens your account page; choose Delete account there. The phone signs out on its own once the account is gone.</span></div></div>",
    '<button id="m-delete-account" class="ghost sm" type="button">Delete account</button>',
  ].join("");
  if (remoteSection.parentNode) remoteSection.parentNode.insertBefore(accountSection, remoteSection.nextSibling);
  if (accountSection.parentNode) accountSection.parentNode.insertBefore(planSection, accountSection);

  /* Founding Growers. A hundred seats for the growers backing the app in its
     first year; the roster is public at GET /api/public/founders and lists the
     ones who chose to be named, in the order they signed up. A row in Settings
     opens a sheet with the count, the roster, and the way in while seats
     remain. The read is cached a minute in the bridge and fails quietly: a
     roster that cannot be reached is one muted line, not an error. */
  const foundersSection = document.createElement("section");
  foundersSection.className = "key-manager m-founders-row";
  foundersSection.innerHTML = [
    '<div class="settings-section-head"><div><b>Founding Growers</b>',
    "<span>The first hundred growers behind Crowe Logic, and who has taken a seat so far.</span></div></div>",
    '<button id="m-founders-open" class="ghost sm" type="button">Founding Growers</button>',
  ].join("");
  // Keep legacy handlers intact without promoting the cultivation roster.
  foundersSection.hidden = true;
  if (accountSection.parentNode) accountSection.parentNode.insertBefore(foundersSection, accountSection.nextSibling);
  const FOUNDERS_URL = "https://crowelogic.com/founders";
  const foundersSheet = document.createElement("div");
  foundersSheet.id = "m-founders"; foundersSheet.className = "modal hidden";
  foundersSheet.setAttribute("aria-label", "Founding Growers");
  foundersSheet.innerHTML = [
    '<div class="modal-card m-founders-card">',
    '<div class="m-kicker">Founding Growers</div><h2 class="m-title">The first hundred</h2>',
    '<p id="m-founders-seats" class="m-home-sub">Reading the roster.</p>',
    '<ol id="m-founders-roster" class="m-founders-roster"></ol>',
    '<p id="m-founders-note" class="m-home-empty"></p>',
    '<div class="row"><button id="m-founders-link" class="primary" type="button">Take a seat at crowelogic.com/founders</button><button id="m-founders-close" class="ghost" type="button">Close</button></div>',
    "</div>",
  ].join("");
  body.appendChild(foundersSheet);
  async function renderFounders() {
    const seats = $("m-founders-seats"), roster = $("m-founders-roster"), note = $("m-founders-note"), link = $("m-founders-link");
    const d = window.crowePhone && window.crowePhone.publicJson ? await window.crowePhone.publicJson("/api/public/founders") : null;
    if (!d || !Number.isFinite(Number(d.spots))) {
      seats.textContent = "The roster could not be reached right now.";
      roster.innerHTML = ""; note.textContent = ""; link.hidden = true;
      return;
    }
    const spots = Number(d.spots), taken = Math.max(0, Number(d.taken) || 0);
    const list = (Array.isArray(d.founders) ? d.founders : []).filter((f) => f && (f.name || f.farm))
      .slice().sort((a, b) => (Number(a.n) || 0) - (Number(b.n) || 0));
    seats.textContent = taken >= spots ? `All ${spots} seats are taken.` : `${taken} of ${spots} seats taken.`;
    roster.innerHTML = list.map((f) => `<li><span class="m-founders-n">${esc(String(Number(f.n) || "").padStart(2, "0"))}</span><span><b>${esc(f.name || "A grower")}</b>${f.farm ? `<span class="m-founders-farm">${esc(f.farm)}</span>` : ""}</span></li>`).join("");
    note.textContent = list.length ? "" : (taken ? "The growers so far have chosen not to be listed." : "No seats taken yet. The roster fills in sign-up order.");
    link.hidden = taken >= spots;
  }
  $("m-founders-open").addEventListener("click", () => {
    const settings = $("settings"); if (settings) settings.classList.add("hidden");
    foundersSheet.classList.remove("hidden");
    renderFounders();
  });
  $("m-founders-close").addEventListener("click", () => foundersSheet.classList.add("hidden"));
  $("m-founders-link").addEventListener("click", () => {
    if (window.crowe && window.crowe.mobile && window.crowe.mobile.openExternal) window.crowe.mobile.openExternal(FOUNDERS_URL);
    else window.open(FOUNDERS_URL, "_blank", "noopener");
  });
  /* Diagnostics. What the bridge did, newest first, with Copy and Share, so a
     phone that says nothing can be read from a text message. Errors the page
     itself throws are noted here too. */
  const diagSection = document.createElement("section");
  diagSection.className = "key-manager m-diag";
  diagSection.innerHTML = [
    '<div class="settings-section-head"><div><b>Diagnostics</b>',
    "<span>The last things this app did: each run, the request it sent, what came back, and how it ended. Copy it and send it to support when something does not answer.</span></div></div>",
    '<pre id="m-diag-log" class="m-diag-log" aria-live="off">Loading</pre>',
    '<div class="m-diag-actions"><button id="m-diag-copy" class="ghost sm" type="button">Copy</button><button id="m-diag-share" class="ghost sm" type="button">Share</button><button id="m-diag-clear" class="ghost sm" type="button">Clear</button></div>',
    '<div class="settings-section-head m-diag-rem"><div><b>Reminders</b>',
    "<span>What this phone still holds for Crowe Logic. Pending means iOS accepted the schedule, not that it rang. The one-minute test is the proof: set it, lock the phone, and wait.</span></div></div>",
    '<pre id="m-diag-pending" class="m-diag-log" aria-live="off">Loading</pre>',
    '<div class="m-diag-actions"><button id="m-diag-test-reminder" class="ghost sm" type="button">Test reminder (1 minute)</button></div>',
  ].join("");
  accountSection.parentNode && accountSection.parentNode.insertBefore(diagSection, accountSection.nextSibling);
  /* Reply voice. speak.js reads localStorage crowe-reply-voice on every tap of
     the speaker, so this row needs no bridge round trip and no config key.
     "phone" is Apple's on-device voice and the default; "neural" is the cloud
     voice from the crowe-ai worker. No choice here is a real person's voice. */
  const voiceSection = document.createElement("section");
  voiceSection.className = "key-manager m-voice";
  voiceSection.innerHTML = [
    '<div class="settings-section-head"><div><b>Reply voice</b>',
    "<span>What the speaker button uses to read a reply. Apple's voice runs on this phone and never leaves it; the natural voice is generated in the Crowe Logic cloud.</span></div></div>",
    '<label class="m-voice-row">Voice <select id="m-voice"><option value="phone">Apple voice (on this phone)</option><option value="neural">Natural voice (cloud)</option></select></label>',
  ].join("");
  diagSection.parentNode && diagSection.parentNode.insertBefore(voiceSection, diagSection);
  const VOICES = ["neural", "phone"];
  const voiceSel = $("m-voice");
  try { const v = localStorage.getItem("crowe-reply-voice"); voiceSel.value = VOICES.includes(v) ? v : "phone"; } catch { voiceSel.value = "phone"; }
  voiceSel.addEventListener("change", () => {
    const v = VOICES.includes(voiceSel.value) ? voiceSel.value : "phone";
    try { localStorage.setItem("crowe-reply-voice", v); } catch { /* storage refused; speak.js falls back to phone */ }
    say(v === "neural" ? "Replies read in the natural voice" : "Replies read by Apple's voice on this phone", "note");
  });
  const diagText = async () => {
    const rows = window.crowe && window.crowe.diag ? await window.crowe.diag.list().catch(() => []) : [];
    const ver = (window.crowe && window.crowe.getConfig) ? await window.crowe.getConfig().then((c) => c.version || "").catch(() => "") : "";
    const head = `Crowe Logic ${ver || ""} · ${navigator.userAgent.slice(0, 80)} · ${new Date().toISOString()}`;
    return head + "\n" + (rows.length ? rows.map((r) => `${new Date(r.t).toISOString().slice(11, 19)} ${r.k} ${r.d}`).join("\n") : "(nothing recorded yet)");
  };
  async function renderDiag() { const pre = $("m-diag-log"); if (pre) pre.textContent = (await diagText()).split("\n").slice(0, 26).join("\n"); }
  $("m-diag-copy").addEventListener("click", async () => {
    const text = await diagText();
    try { await navigator.clipboard.writeText(text); say("Diagnostics copied", "note"); }
    catch { if (window.crowePhone && window.crowePhone.shareText) window.crowePhone.shareText(text); else window.prompt("Copy this:", text); }
  });
  $("m-diag-share").addEventListener("click", async () => {
    const text = await diagText();
    const Share = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share;
    if (Share) { try { await Share.share({ title: "Crowe Logic diagnostics", text }); } catch { /* dismissed */ } }
    else if (navigator.share) { try { await navigator.share({ title: "Crowe Logic diagnostics", text }); } catch { /* dismissed */ } }
    else window.prompt("Copy this:", text);
  });
  $("m-diag-clear").addEventListener("click", async () => { if (window.crowe && window.crowe.diag) await window.crowe.diag.clear(); renderDiag(); });
  const fmtWhen = (ts) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  async function renderPending() {
    const pre = $("m-diag-pending"); if (!pre) return;
    const R = window.crowe && window.crowe.reminders;
    if (!R || !R.pending) { pre.textContent = "Reminders are not part of this build."; return; }
    const p = await R.pending().catch(() => ({ native: false, notifications: [] }));
    if (!p.native) { pre.textContent = "No notification service here; this is the browser build. On the phone this lists what iOS holds."; return; }
    if (p.error) { pre.textContent = "Could not read pending notifications: " + p.error; return; }
    pre.textContent = p.notifications.length ? p.notifications.map((n) => `${n.at ? fmtWhen(n.at) : "no time"}  ${n.title} (#${n.id})`).join("\n") : "Nothing pending.";
  }
  $("m-diag-test-reminder").addEventListener("click", async () => {
    const R = window.crowe && window.crowe.reminders; if (!R) return;
    const r = await R.add({ title: "Crowe Logic test", body: "Reminders reach this phone.", at: Date.now() + 60000 });
    if (r && r.ok) say(r.native ? "Test reminder set. Lock the phone; it rings in one minute." : "Set, but this build has no notification service to ring it.", "note");
    else say((r && r.error) || "The reminder could not be set.", "error");
    renderPending(); if (typeof renderHome === "function") renderHome();
  });
  $("settings-btn").addEventListener("click", () => setTimeout(() => { renderDiag(); renderPending(); syncUsage(); }, 50));
  window.addEventListener("error", (e) => { if (window.crowe && window.crowe.diag) window.crowe.diag.note("page:error", `${e.message} @${(e.filename || "").split("/").pop()}:${e.lineno}`); });
  window.addEventListener("unhandledrejection", (e) => { if (window.crowe && window.crowe.diag) window.crowe.diag.note("page:rejection", String(e.reason && e.reason.message || e.reason).slice(0, 200)); });

  const deleteBtn = $("m-delete-account");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      const sure = window.confirm("Delete your Crowe ID?\n\nYour account page opens next. Choose Delete account there. This cannot be undone.");
      if (!sure) return;
      deleteBtn.disabled = true;
      let r = null;
      try { r = await window.crowe.auth.deleteAccount(); } catch { r = null; }
      deleteBtn.disabled = false;
      if (r && r.deleted) {
        if (typeof refreshAuth === "function") { try { await refreshAuth(); } catch { /* the badge redraws on next load */ } }
        window.alert("Your Crowe ID has been deleted and this phone is signed out.");
      }
    });
  }

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
    StatusBar.setBackgroundColor({ color: dark ? "#0a0a0b" : "#f7f3ea" }).catch(() => {});
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
      if (body.dataset.pane === "room") { setPane("messages"); return; }
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

  const sensorSettings = $("sense-state")?.closest("section");
  if (sensorSettings) sensorSettings.hidden = true;
  setTimeout(() => { setPane("home"); }, 0);

  /* ─── Approval sheet ───────────────────────────────────────────────────────
     Where a person stands between the agent and a consequence, the question is
     drawn rather than delegated to window.confirm: which computer, at which
     tier, the exact text that will run, and why it was flagged. A risky action
     is approved by holding the button, so a reflexive tap cannot approve a
     LaunchAgent; VoiceOver and keyboard activation (click with no pointer
     press) approve directly, since a hold is not an accessible gesture.
     Everything is set with textContent: the command came from a model. */
  /* One sheet at a time: an agent tool and a Terminal command asking together
     queue, rather than stacking two sheets that one Escape answers both of.
     Stopping the turn answers every open and waiting sheet "no", so a stopped
     turn never sits on a question nobody can see the point of any more. */
  let approveChain = Promise.resolve();
  let approveGen = 0;                       // bumped by a stop; queued sheets from before it never open
  const approveOpen = new Set();
  window.__croweApproveDismiss = () => { approveGen++; for (const d of [...approveOpen]) d(false); };
  window.__croweApprove = (spec) => {
    const gen = approveGen;
    const next = approveChain.then(() => (gen === approveGen ? showApprove(spec) : false));
    approveChain = next.catch(() => false);
    return next;
  };
  const showApprove = (spec) => new Promise((resolve) => {
    const s = spec || {};
    const prior = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "m-approve" + (s.danger ? " danger" : "");
    wrap.setAttribute("role", "alertdialog");
    wrap.setAttribute("aria-modal", "true");
    const card = document.createElement("div");
    card.className = "m-approve-card";
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    if (s.machine || s.tier) {
      const chips = el("div", "m-approve-chips");
      if (s.machine) { let h = s.machine; try { h = new URL(s.machine).hostname; } catch { /* shown as given */ } chips.appendChild(el("span", "m-chip", h)); }
      if (s.tier) chips.appendChild(el("span", "m-chip tier-" + s.tier, s.tier.charAt(0).toUpperCase() + s.tier.slice(1) + " tier"));
      card.appendChild(chips);
    }
    if (s.kicker && card.firstChild === null) { const chips = el("div", "m-approve-chips"); card.appendChild(chips); }
    if (s.kicker) card.firstChild.insertBefore(el("span", "m-chip m-chip-gate", s.kicker), card.firstChild.firstChild);
    const title = el("h2", "m-approve-title", s.title || "Allow this?");
    title.id = "m-approve-title";
    wrap.setAttribute("aria-labelledby", title.id);
    card.appendChild(title);
    if (s.mission) { const m = el("p", "m-approve-mission"); m.append(el("b", null, "Mission "), document.createTextNode(s.mission)); card.appendChild(m); }
    if (s.reason) card.appendChild(el("p", "m-approve-reason", s.reason));
    if (s.detail) card.appendChild(el("pre", "m-approve-detail", s.detail));
    if (Array.isArray(s.evidence) && s.evidence.length) {
      const ev = el("div", "m-approve-evidence");
      ev.appendChild(el("span", "m-approve-evidence-k", "Evidence"));
      for (const [k, v] of s.evidence) { const row = el("div", "m-ev-row"); row.append(el("span", "m-ev-k", k), el("code", "m-ev-v", v)); ev.appendChild(row); }
      card.appendChild(ev);
    }
    /* A diff arrives as unified text from the computer. Each line is its own
       span, coloured by its first character, and all of it is textContent. */
    if (s.diff) {
      const pre = el("pre", "m-approve-diff");
      for (const line of String(s.diff).split("\n")) {
        const c = line[0];
        pre.appendChild(el("span", "m-dl " + (c === "+" ? "add" : c === "-" ? "del" : line.startsWith("@@") ? "hunk" : "ctx"), line + "\n"));
      }
      card.appendChild(pre);
    }
    let expiryEl = null;
    if (s.expiresAt) { expiryEl = el("p", "m-approve-expiry", ""); card.appendChild(expiryEl); }
    if (s.question) card.appendChild(el("p", "m-approve-q", s.question));
    const content = el("div", "m-approve-content");
    while (card.firstChild) content.appendChild(card.firstChild);
    card.appendChild(content);
    const row = el("div", "m-approve-actions");
    const no = el("button", "ghost m-approve-no", "Not now");
    no.type = "button";
    const deny = s.deny ? el("button", "ghost m-approve-deny", s.deny) : null;
    if (deny) deny.type = "button";
    const yes = el("button", "m-approve-yes", s.danger ? `Hold to ${String(s.confirm || "approve").toLowerCase()}` : (s.confirm || "Allow"));
    yes.type = "button";
    row.append(no);
    if (deny) row.append(deny);
    row.append(yes);
    card.appendChild(row);
    wrap.appendChild(card);
    let settled = false;
    let cancelHold = () => {};
    // aria-modal alone does not stop VoiceOver's rotor or a hardware keyboard
    // reaching the page behind; inert does.
    const benched = Array.from(body.children).filter((n) => n !== wrap && !n.inert);
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (tick) clearInterval(tick);
      cancelHold();
      window.removeEventListener("blur", cancelHold);
      approveOpen.delete(done);
      wrap.classList.add("leaving");
      document.removeEventListener("keydown", onKey, true);
      setTimeout(() => {
        wrap.remove();
        benched.forEach((n) => { n.inert = false; });
        try { prior && prior.focus && prior.focus(); } catch { /* gone */ }
        resolve(v);
        // Queued approvals open before navigation is restored.
        setTimeout(() => {
          if (!document.querySelector(".m-approve")) body.classList.remove("approval-open");
        }, 0);
      }, 160);
    };
    approveOpen.add(done);
    if (deny) deny.addEventListener("click", () => done("deny"));
    /* The countdown, and a way for the caller to close the sheet from outside:
       a gate answered on the computer, or expired, must not stay answerable. */
    let tick = null;
    if (expiryEl) {
      const paint = () => {
        const left = Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000));
        expiryEl.textContent = left > 0 ? `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Expired";
        if (left <= 0) { clearInterval(tick); if (s.onExpire) s.onExpire(); done(false); }
      };
      tick = setInterval(paint, 1000); setTimeout(paint, 0);
    }
    if (s.onOpen) s.onOpen((v) => done(v === undefined ? false : v));
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); done(false); }
      else if (e.key === "Tab") { e.preventDefault(); (document.activeElement === no ? yes : no).focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    no.addEventListener("click", () => done(false));
    wrap.addEventListener("click", (e) => { if (e.target === wrap) done(false); });
    if (s.danger) {
      const HOLD = 650;
      let timer = null;
      const cancel = () => { clearTimeout(timer); timer = null; yes.classList.remove("holding"); };
      cancelHold = cancel;
      window.addEventListener("blur", cancelHold);
      yes.addEventListener("blur", cancel);
      yes.addEventListener("pointerdown", (e) => {
        if (settled || e.button !== 0 || e.isPrimary === false) return;
        e.preventDefault();
        cancel();
        yes.classList.add("holding");
        timer = setTimeout(() => { timer = null; done(true); }, HOLD);
      });
      ["pointerup", "pointerleave", "pointercancel"].forEach((t) => yes.addEventListener(t, cancel));
      yes.addEventListener("click", (e) => { if (e.detail === 0) done(true); });
      yes.setAttribute("aria-label", s.confirm || "Approve");
    } else {
      yes.addEventListener("click", () => done(true));
    }
    body.classList.add("approval-open");
    body.appendChild(wrap);
    benched.forEach((n) => { n.inert = true; });
    // Establish the entrance style without making authority controls wait for
    // an animation frame, which a hidden or backgrounded window can suspend.
    wrap.getBoundingClientRect();
    wrap.classList.add("open");
    no.focus({ preventScroll: true });
  });


  /* ─── Authority gates ─────────────────────────────────────────────────────
     A run on the person's computer that reaches something it should not take
     alone asks, and the same question lands here through the gate relay. The
     Home card lists what is waiting; a tap opens the approval sheet with the
     machine, the mission, the exact command or diff, and the time left. An
     approval echoes the evidence hash the person was shown, so the relay can
     refuse it if the gate changed underneath.
     Polling is every 4 s and only while the app is in the foreground and the
     person is signed in: it stops when the app is backgrounded and resumes the
     moment it returns. There is no remote push in this version, so a gate that
     arrives while the app is closed waits (until it expires) for the next open. */
  const GATES_POLL_MS = 4000;
  let gatesState = { gates: [], signedIn: true, error: "", note: "", loaded: false };
  let gatesTimer = null, gatesBusy = false, gatesFg = true, openGate = null;
  const gatesWanted = () => gatesFg && !document.hidden && Boolean(window.crowe && window.crowe.gates);
  function gateLeft(g) {
    const left = Math.max(0, Math.round((Number(g.expires_at) - Date.now()) / 1000));
    return left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left` : "expired";
  }
  function renderGates() {
    const host = $("m-gates");
    if (!host) return;
    const st = gatesState;
    host.textContent = "";
    const h = document.createElement("h2"); h.className = "m-h-label"; h.textContent = "Authority gates";
    host.appendChild(h);
    const card = document.createElement("div"); card.className = "m-h-card";
    const line = (cls, text) => { const p = document.createElement("p"); p.className = cls; p.textContent = text; return p; };
    if (!st.signedIn) card.appendChild(line("m-home-empty", "Sign in with Crowe ID to receive authority gates from your computer."));
    else if (!st.loaded) card.appendChild(line("m-home-empty", "Checking…"));
    else {
      if (st.gates.length) {
        const head = document.createElement("div"); head.className = "m-gate-head";
        const k = document.createElement("span"); k.className = "m-gate-k"; k.textContent = "Waiting on you";
        const n = document.createElement("b"); n.className = "m-gate-n"; n.textContent = String(st.gates.length);
        head.append(k, n); card.appendChild(head);
        for (const g of st.gates) {
          const row = document.createElement("button"); row.type = "button"; row.className = "m-gate-row" + (g.risk === "strict" ? " strict" : "");
          row.dataset.gate = g.id;
          const t = document.createElement("b"); t.textContent = g.title || "An action needs your authorization";
          const meta = document.createElement("span"); meta.className = "m-gate-meta";
          meta.textContent = [g.machine, g.mission, gateLeft(g)].filter(Boolean).join(" · ");
          row.append(t, meta);
          row.addEventListener("click", () => openGateSheet(g.id));
          card.appendChild(row);
        }
      } else card.appendChild(line("m-home-empty", "No gates waiting. Runs on your computer will ask here."));
      if (st.error) card.appendChild(line("m-gate-note warn", "Could not reach the gate relay. Your computer still asks you there."));
    }
    if (st.note) card.appendChild(line("m-gate-note", st.note));
    host.appendChild(card);
  }
  async function pollGates() {
    if (gatesBusy || !gatesWanted()) return;
    gatesBusy = true;
    try {
      const status = window.crowe.auth && window.crowe.auth.status ? await window.crowe.auth.status().catch(() => null) : null;
      if (!status || !status.user) {
        gatesState = { ...gatesState, gates: [], signedIn: false, loaded: true, error: "" };
        stopGates(); renderGates(); return;
      }
      const r = await window.crowe.gates.list();
      if (r.ok) gatesState = { ...gatesState, gates: r.gates, signedIn: true, loaded: true, error: "" };
      else if (r.signedIn === false) { gatesState = { ...gatesState, gates: [], signedIn: false, loaded: true, error: "" }; stopGates(); }
      else gatesState = { ...gatesState, signedIn: true, loaded: true, error: "unreachable" };
      renderGates();
      // The sheet is for a pending gate. If this one was answered on the computer, close it.
      if (r.ok && openGate && !r.gates.some((g) => g.id === openGate.id)) openGate.close("elsewhere");
    } finally { gatesBusy = false; }
  }
  function startGates(immediate) {
    if (!gatesWanted()) return;
    if (!gatesTimer) gatesTimer = setInterval(pollGates, GATES_POLL_MS);
    if (immediate) pollGates();
  }
  function stopGates() { if (gatesTimer) clearInterval(gatesTimer); gatesTimer = null; }
  window.__croweGates = { poll: pollGates, start: startGates, stop: stopGates, state: () => gatesState, open: (id) => openGateSheet(id), polling: () => Boolean(gatesTimer) };
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopGates(); else if (gatesFg) startGates(true); });
  if (App) Promise.resolve(App.addListener("appStateChange", (st) => {
    gatesFg = Boolean(st && st.isActive);
    if (gatesFg) startGates(true); else stopGates();
  })).catch(() => {});
  setTimeout(() => startGates(true), 800);

  async function openGateSheet(id) {
    const g = gatesState.gates.find((x) => x.id === id);
    if (!g || openGate) return;
    const ev = g.evidence || {};
    const rows = [];
    if (ev.command && ev.command !== g.detail) rows.push(["command", ev.command]);
    if (ev.cwd) rows.push(["cwd", ev.cwd]);
    if (ev.path) rows.push(["path", ev.path]);
    if (ev.args && typeof ev.args === "object") rows.push(["args", JSON.stringify(ev.args)]);
    let dismiss = null, reason = "";
    openGate = { id: g.id, close: (why) => { reason = why; if (dismiss) dismiss(false); } };
    const answer = await window.__croweApprove({
      kicker: "Authority gate", title: g.title || "An action needs your authorization",
      machine: g.machine, mission: g.mission, reason: g.why ? `This ${g.why}.` : "", detail: g.detail,
      evidence: rows, diff: ev.diff, expiresAt: Number(g.expires_at) || 0,
      danger: g.risk === "strict", confirm: "Approve", deny: "Deny",
      onOpen: (d) => { dismiss = d; }, onExpire: () => { reason = "expired"; },
    });
    openGate = null;
    let note = "";
    if (reason === "elsewhere") note = "Already answered on your computer";
    else if (reason === "expired") note = "Expired";
    else if (answer === true || answer === "deny") {
      const r = await window.crowe.gates.decide(g.id, answer === true ? "approve" : "deny", g.evidence_hash);
      if (r.ok) note = answer === true ? "Approved. The run continues on your computer." : "Denied.";
      else if (r.status === 409 && r.error === "evidence_mismatch") note = "This gate changed on your computer. Open it again to review the new evidence.";
      else if (r.status === 409) note = r.gate && (r.gate.decided_via === "desktop" || r.gate.decided_via === "cli") ? "Already answered on your computer" : "Already answered";
      else if (r.status === 410) note = "Expired";
      else if (r.status === 401) note = "Signed out. Sign in with Crowe ID to answer gates.";
      else note = "Could not reach the gate relay. Nothing was sent. Your computer still asks you there.";
    }
    gatesState = { ...gatesState, note };
    renderGates();
    pollGates();
    if (note) setTimeout(() => { if (gatesState.note === note) { gatesState = { ...gatesState, note: "" }; renderGates(); } }, 8000);
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
