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
  const CAMERA_ICON = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  const railIcon = (space) => { const b = spaceButtons().find((x) => x.dataset.space === space); return b && b.querySelector("svg") ? b.querySelector("svg").outerHTML : ""; };
  const spaceOn = (space) => Boolean(spaceButtons().find((b) => b.dataset.space === space && !b.classList.contains("hidden")));

  function buildTabs() {
    const items = [{ kind: "pane", id: "home", label: "Home", icon: HOME_ICON }];
    items.push({ kind: "space", id: "chat", label: "Chat", icon: railIcon("chat") });
    items.push({ kind: "pane", id: "camera", label: "Camera", icon: CAMERA_ICON });
    if (spaceOn("cultivation")) items.push({ kind: "space", id: "cultivation", label: "Log", icon: railIcon("cultivation") });
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
      if (tab.dataset.kind === "pane") current = tab.dataset.id === "workspace" ? onPanels : pane === tab.dataset.id;
      else current = pane === "agent" && tab.dataset.id === space;
      if (current) tab.setAttribute("aria-current", "true"); else tab.removeAttribute("aria-current");
    });
  }

  buildTabs();
  window.addEventListener("crowe:remote", () => buildTabs());

  /* ── Home and Camera: the phone's own panes ─────────────────────────────────
     Two sections beside the workbench and the surfaces. Home answers "what
     does my grow need today" from the log already on this phone; Camera hands a
     photo to CroweLM Vision through the ordinary chat turn and then offers one
     tap to log the verdict against a lot. Nothing here needs a desktop. */
  const workbenchEl = $("workbench");
  const homePane = document.createElement("section"); homePane.id = "m-home-pane"; homePane.className = "m-pane"; homePane.setAttribute("aria-label", "Home");
  const cameraPane = document.createElement("section"); cameraPane.id = "m-camera-pane"; cameraPane.className = "m-pane"; cameraPane.setAttribute("aria-label", "Camera");
  if (workbenchEl && workbenchEl.parentNode) { workbenchEl.parentNode.insertBefore(homePane, workbenchEl); workbenchEl.parentNode.insertBefore(cameraPane, workbenchEl); }
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
  const rollCard = (c) => `<div class="m-roll">${c.thumb ? `<img src="${c.thumb}" alt="" class="m-roll-thumb">` : ""}<div><b>${esc(c.lot || "unassigned")}</b> <span class="m-lot-meta">${esc(new Date(c.ts).toLocaleDateString([], { month: "short", day: "numeric" }))}</span><div class="m-roll-verdict">${esc((c.verdict || "").slice(0, 180))}</div></div></div>`;
  let pendingLot = "", cameraArmed = false, photoTurn = null;

  async function renderHome() {
    const crowe = window.crowe; if (!crowe || !crowe.grow) return;
    const safe = (p) => Promise.resolve(p).catch(() => []);
    const [blocks, flushes, reminders, roll, sessions] = await Promise.all([
      safe(crowe.grow.list("blocks")), safe(crowe.grow.list("flushes")),
      crowe.reminders ? safe(crowe.reminders.list()) : [], crowe.camera ? safe(crowe.camera.list()) : [],
      crowe.sessions && crowe.sessions.list ? safe(crowe.sessions.list()) : []]);
    const rows = live(blocks).sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));
    const byLot = {}; for (const f of flushes || []) if (f && f.block) byLot[f.block] = (byLot[f.block] || 0) + (Number(f.weight) || 0);
    const upcoming = (reminders || []).filter((r) => r.at > Date.now() - 3600000).slice(0, 6);
    homePane.innerHTML = [
      '<div class="m-home-inner">',
      `<header class="m-home-head"><div class="m-kicker">Grow log · this phone</div><h1 class="m-title">Your grow, today</h1><p class="m-home-sub">${rows.length ? `${rows.length} active lot${rows.length === 1 ? "" : "s"} on this phone.` : "Nothing logged yet. Add a block in Log, or photograph one in Camera."}</p></header>`,
      rows.length ? '<section class="m-home-sec" id="m-home-blocks"><h2>Blocks by stage</h2>' + rows.map((b) => `<div class="m-lot" data-lot="${esc(b.code)}"><div class="m-lot-main"><b>${esc(b.code)}</b><span class="m-lot-name">${esc([b.species, b.strain].filter(Boolean).join(" · "))}</span><span class="m-stage m-stage-${esc(b.stage || "")}">${esc(b.stage || "")}</span></div><div class="m-lot-meta">${b.spawned ? esc(sinceDays(b.spawned)) + " since spawn" : ""}${b.count ? ` · ${esc(String(b.count))}×` : ""}${b.room ? ` · ${esc(b.room)}` : ""}</div>${yieldLine(b, byLot) ? `<div class="m-lot-yield">${esc(yieldLine(b, byLot))}</div>` : ""}<div class="m-lot-actions"><button type="button" class="ghost sm m-remind" data-lot="${esc(b.code)}" data-species="${esc(b.species || "")}" data-stage="${esc(b.stage || "")}">Remind me</button><button type="button" class="ghost sm m-check" data-lot="${esc(b.code)}">Photograph</button></div></div>`).join("") + "</section>" : "",
      '<section class="m-home-sec" id="m-home-reminders"><h2>Reminders</h2>' + (upcoming.length ? upcoming.map((r) => `<div class="m-rem"><div><b>${esc(r.title)}</b><div class="m-lot-meta">${esc(new Date(r.at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}${r.body ? " · " + esc(r.body) : ""}</div></div><button type="button" class="ghost sm m-rem-x" data-id="${r.id}">Remove</button></div>`).join("") : '<p class="m-home-empty">None set. Tap Remind me on a block.</p>') + "</section>",
      roll.length ? '<section class="m-home-sec"><h2>Camera checks</h2>' + roll.slice(0, 4).map(rollCard).join("") + "</section>" : "",
      sessions.length ? '<section class="m-home-sec"><h2>Recent conversations</h2>' + sessions.slice(0, 3).map((x) => `<div class="m-sess">${esc(x.name || x.title || "Untitled")}</div>`).join("") + "</section>" : "",
      "</div>",
    ].join("");
    homePane.querySelectorAll(".m-remind").forEach((btn) => btn.addEventListener("click", () => remindChooser(btn.dataset.lot, btn.dataset.species, btn.dataset.stage)));
    homePane.querySelectorAll(".m-check").forEach((btn) => btn.addEventListener("click", () => { pendingLot = btn.dataset.lot; setPane("camera"); }));
    homePane.querySelectorAll(".m-rem-x").forEach((btn) => btn.addEventListener("click", async () => { await window.crowe.reminders.remove(Number(btn.dataset.id)); renderHome(); }));
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

  const VISION_PROMPT = "Look at this photo of my block. Tell me what stage it is at, whether you see contamination or another problem, and what I should do next.";
  /* The Camera tab reads as a field inspection: a specimen frame with the last
     capture on file, a numbered capture protocol, and a ledger of findings
     against lots. The register is the Log's: mono kickers, a serif title,
     hairline rows. Nothing here claims more than one photo can carry. */
  const verdictKind = (v) => /contamin|trichoderma|mold|mould|bacteri|cobweb|discard|isolate/i.test(v) ? "bad" : /harvest|ready|pins|pinning|fruit|cluster/i.test(v) ? "gold" : /healthy|clean|no contamination|colonis|coloniz/i.test(v) ? "myc" : "neutral";
  const firstSentence = (v) => { const t = String(v || "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim(); const m = /^(.{12,160}?[.!?])(\s|$)/.exec(t); return m ? m[1] : t.slice(0, 140); };
  const fmtDay = (ts) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
  async function renderCamera() {
    const roll = window.crowe && window.crowe.camera ? await window.crowe.camera.list().catch(() => []) : [];
    const last = roll[0];
    cameraPane.innerHTML = [
      '<div class="m-home-inner">',
      '<header class="m-fi-head"><div class="m-kicker">Field inspection · CroweLM Vision</div><h1 class="m-title">Photograph a block</h1>',
      '<p class="m-home-sub">The block face is read by CroweLM Vision, running Claude Fable 5.1. Each check returns a graded finding, marked on the photo, and is recorded against its lot.</p></header>',
      `<section class="m-fi-frame${last ? "" : " is-empty"}"><div class="m-fi-view">`,
      last && last.thumb ? `<img class="m-fi-img" src="${last.thumb}" alt="last capture">` : "",
      '<div class="m-fi-lattice"></div><i class="m-fi-c c1"></i><i class="m-fi-c c2"></i><i class="m-fi-c c3"></i><i class="m-fi-c c4"></i><i class="m-fi-cross"></i>',
      last ? `<div class="m-fi-meta"><span>Last check</span><span>${esc(last.lot || "no lot")}</span><span>${esc(fmtDay(last.ts))}</span></div>` : '<div class="m-fi-empty"><span class="m-kicker">Specimen</span>No capture on file.<br>Frame the block face and photograph it.</div>',
      pendingLot ? `<div class="m-fi-lot">Checking lot <b>${esc(pendingLot)}</b></div>` : "",
      "</div>",
      '<div class="m-cam-actions"><button type="button" class="primary m-cam-shoot">Photograph</button><button type="button" class="ghost m-cam-pick">Choose a photo</button></div></section>',
      '<section class="m-fi-sec"><h2 class="m-kicker">Capture protocol</h2><ol class="m-fi-protocol"><li>Fill the frame with the block face.</li><li>Even light. No flash glare on the bag.</li><li>Include the lot tag when there is one.</li><li>One block per photo.</li></ol></section>',
      '<section class="m-fi-sec"><h2 class="m-kicker">Inspection ledger</h2>',
      roll.length ? '<div class="m-ledger"><div class="m-ledger-head"><span>Date</span><span>Lot</span><span>Finding</span></div>' + roll.slice(0, 20).map((c, i) => `<button type="button" class="m-ledger-row m-r-${verdictKind(c.verdict)}" data-i="${i}"><span class="d">${esc(fmtDay(c.ts))}</span><span class="l">${esc(c.lot || "no lot")}</span><span class="f">${esc(firstSentence(c.verdict))}</span><i class="mark"></i></button><div class="m-ledger-detail" hidden>${c.thumb ? `<img src="${c.thumb}" alt="">` : ""}<p>${esc(c.verdict || "")}</p></div>`).join("") + "</div>" : '<p class="m-home-empty">No inspections recorded on this phone.</p>',
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
      if (ev.type !== "assistant" || !photoTurn || ev.agentId && ev.agentId !== "main") return;
      const turn = photoTurn; photoTurn = null; pendingLot = "";
      const text = String(ev.text || "").trim(); if (!text) return;
      const bodies = document.querySelectorAll(".msg.assistant .body"); const body = bodies[bodies.length - 1]; if (!body) return;
      const blocks = live(await window.crowe.grow.list("blocks").catch(() => []));
      // The lot the check came from; else the only lot; else the fruiting one, which is the one usually photographed.
      const pick = turn.lot || (blocks.length === 1 ? blocks[0].code : ((blocks.find((b) => b.stage === "fruiting") || {}).code || ""));
      const row = document.createElement("div"); row.className = "m-log-row";
      row.innerHTML = `<select aria-label="Lot">${blocks.map((b) => `<option value="${esc(b.code)}"${b.code === pick ? " selected" : ""}>${esc(b.code)}${b.species ? " · " + esc(b.species) : ""}</option>`).join("")}<option value=""${pick ? "" : " selected"}>No lot</option></select><button type="button" class="primary sm m-log-it">Log this check</button><button type="button" class="ghost sm m-log-skip">Not now</button>`;
      body.appendChild(row);
      row.querySelector(".m-log-skip").addEventListener("click", () => row.remove());
      row.querySelector(".m-log-it").addEventListener("click", async () => {
        const lot = row.querySelector("select").value;
        const entry = (lot ? `Photo check of ${lot}. ` : "Photo check. ") + text.slice(0, 1200);
        const saved = await window.crowe.grow.save("log", { date: todayISO(), subject: lot ? `Photo check ${lot}` : "Photo check", entry });
        if (!saved || saved.ok === false) { alert((saved && saved.error) || "The journal did not take the entry."); return; }
        await window.crowe.camera.add({ lot, verdict: text.slice(0, 400), thumb: turn.thumb });
        row.innerHTML = `<span class="m-log-done">Logged${lot ? " to " + esc(lot) : ""} in the grow journal.</span>`;
      });
    });
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
  const CULTIVATION_CHIP = "What did I log about contamination this month, and what should I change?";
  const CULTIVATION_PHOTO_CHIP = "Photograph this block and tell me if that is contamination";

  // Three, in the order they earn their place: the machine when there is one,
  // the farm when that space is on, then general reasoning to fill the rest.
  const welcomeChips = () => {
    const chips = [];
    if (isPaired()) chips.push(...MACHINE_CHIPS);
    if (cultivationOn()) chips.push(CULTIVATION_PHOTO_CHIP, CULTIVATION_CHIP);
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
     "This is the operator over your CroweLM gateway, on your phone: reasoning, routing to the right expert, and once you pair a desktop, its shell, files and git."],
    ["Point the workspace at a project folder (Settings or ask the agent).",
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

  const transcript = $("transcript");
  if (transcript) {
    mobiliseWelcome(transcript);
    transcript.querySelectorAll(".msg .said").forEach(mobiliseCopy);
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
    // The onboarding card is filled after its empty message node is appended.
    // Listen for the completed card as well as the DOM mutation so the phone
    // never exposes desktop-only copy because two task queues happened to race.
    window.addEventListener("crowe:onboarding-shown", (event) => {
      const root = event.detail && event.detail.root;
      if (root && root.querySelectorAll) root.querySelectorAll(".said").forEach(mobiliseCopy);
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
    camBtn.title = "Photograph a block, bag or plate";
    camBtn.setAttribute("aria-label", "Photograph a block, bag or plate");
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
      scanSay(how === "error" ? ("The photo could not be read. " + String(why || "").slice(0, 140)).trim() : how === "stopped" ? "Stopped." :
        (activeScan.regions.length ? `Read. ${activeScan.regions.length} area${activeScan.regions.length === 1 ? "" : "s"} marked; tap the photo to hide them.` : "Read."));
      activeScan = null;
    }
    if (window.crowe && window.crowe.agent && window.crowe.agent.onEvent) {
      window.crowe.agent.onEvent((ev) => {
        if (!ev) return;
        if (ev.type === "vision_regions" && Array.isArray(ev.regions)) { scanRegions(ev.regions); return; }
        if (ev.type === "vision_reasoning" && typeof ev.text === "string") { scanReasoning(ev.text); return; }
        if (ev.type === "assistant_delta") { scanReading(); return; }
        if (ev.type === "assistant" || ev.type === "final") { endScan("done"); return; }
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

  /* Account deletion, App Store guideline 5.1.1(v). The deletion happens on
     the Crowe ID account page, which the bridge opens in the browser sheet;
     when the sheet closes the bridge finds out whether the account is still
     there and signs the phone out if it is not. Phone-only for the same reason
     as the section above: the desktop has its own account surface. */
  /* Siri and Shortcuts. "Ask Crowe Logic <question>" sends the question as a
     turn; "Log a block" opens the grow log on the Blocks lane with the note in
     the form. The note arrives from the bridge as crowe:intent (see
     takePendingIntent), on launch and on every return to the foreground. */
  window.addEventListener("crowe:intent", (e) => {
    if (e && e.detail && e.detail.kind === "home") { setPane("home"); return; }
    const d = (e && e.detail) || {};
    if (d.kind === "ask" && d.text) {
      __tapTab("Chat");
      if (typeof send === "function") { send(d.text); }
      else { const inp = $("input"); if (inp) { inp.value = d.text; inp.dispatchEvent(new Event("input")); const go = $("send"); if (go) go.click(); } }
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
    let listening = false, base = "";
    const stopped = () => {
      listening = false;
      dictBtn.classList.remove("active"); dictBtn.setAttribute("aria-pressed", "false");
      const st = $("composer-status");
      if (st && st.dataset.state === "listening") say("Ready");
    };
    Promise.resolve(Speech.addListener("partialResults", (d) => {
      const heard = d && Array.isArray(d.matches) && d.matches.length ? String(d.matches[0]) : "";
      dictInput.value = (base + " " + heard).trim();
      dictInput.dispatchEvent(new Event("input"));
    })).catch(() => {});
    Promise.resolve(Speech.addListener("listeningState", (d) => { if (d && d.status === "stopped") stopped(); })).catch(() => {});
    dictBtn.onclick = async () => {
      if (listening) { try { await Speech.stop(); } catch { stopped(); } return; }
      let perm = { speechRecognition: "denied" };
      try { perm = await Speech.requestPermissions(); } catch { /* answered below */ }
      if (perm.speechRecognition !== "granted") { say("Allow the microphone and speech recognition in Settings to dictate", "error"); return; }
      let avail = { available: false };
      try { avail = await Speech.available(); } catch { /* answered below */ }
      if (!avail.available) { say("Dictation is not available on this phone right now", "error"); return; }
      base = dictInput.value.trim(); listening = true;
      dictBtn.classList.add("active"); dictBtn.setAttribute("aria-pressed", "true"); say("Listening", "listening");
      try { await Speech.start({ language: "en-US", partialResults: true }); }
      catch (e) { say("Dictation failed: " + String(e && e.message || e).slice(0, 80), "error"); stopped(); }
    };
  } else if (dictBtn && window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
    // No native recogniser in this build: say so instead of lighting a button that fails.
    dictBtn.classList.add("unavailable"); dictBtn.setAttribute("aria-disabled", "true"); dictBtn.title = "Dictation is not available in this build";
    dictBtn.onclick = () => say("Dictation is not available in this build", "error");
  }

  const accountSection = document.createElement("section");
  accountSection.className = "key-manager m-account";
  accountSection.innerHTML = [
    '<div class="settings-section-head"><div><b>Your Crowe ID</b>',
    "<span>Deleting your Crowe ID removes the account and everything kept under it, including any plan on it, and cannot be undone. ",
    "This opens your account page; choose Delete account there. The phone signs out on its own once the account is gone.</span></div></div>",
    '<button id="m-delete-account" class="ghost sm" type="button">Delete account</button>',
  ].join("");
  if (remoteSection.parentNode) remoteSection.parentNode.insertBefore(accountSection, remoteSection.nextSibling);
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
  ].join("");
  accountSection.parentNode && accountSection.parentNode.insertBefore(diagSection, accountSection.nextSibling);
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
  $("settings-btn").addEventListener("click", () => setTimeout(renderDiag, 50));
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
