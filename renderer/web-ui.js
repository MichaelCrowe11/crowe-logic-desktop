// Crowe Logic web — the browser chrome.
//
// Runs after renderer.js on every web width, the way mobile-ui.js runs after
// it on a phone, and touches the shell only where the desktop's copy makes a
// promise the browser cannot keep. Nothing here changes what the shell does;
// it changes what the shell says it does, so the first thing crowelm.com tells
// a person is not three things it cannot do.
//
// The desktop welcome offers to list the files here, run the test suite and
// stage a git change. All three are the workspace, and web-bridge.js refuses
// each of them with a remedy: they exist in a Crowe Workspace, one domain
// over. So the copy says that, and the openers are turns the web can take.
//
// Two rules, borrowed from the phone chrome. Rewrites match the desktop's own
// sentences, and scripts/test-web-bridge.js asserts each needle still occurs
// in renderer.js and index.html, so a rewording over there fails the build
// rather than letting the web quietly go back to promising a terminal. And on
// a phone this file runs first, mobile-ui.js runs after it and rewrites the
// welcome to the iOS app's copy (which promises a paired desktop the web does
// not have), then the gate in app.html announces that and this file applies
// its copy again, in its pocket phrasing. The web's own words win on every
// width.

(function () {
  "use strict";

  // Only in a browser tab. The desktop never loads this file (package.json
  // build.files excludes it) but a guard costs nothing.
  if (typeof window === "undefined" || !window.crowe || window.Capacitor) return;

  const $ = (id) => document.getElementById(id);
  const body = document.body;
  body.classList.add("web");

  const WORKSPACES_URL =
    (typeof window !== "undefined" && window.CROWE_WORKSPACES_URL) || "https://croweos.com/#/dashboard";

  // ─── First-run copy ────────────────────────────────────────────────────────

  const cultivationOn = () =>
    Boolean(document.querySelector('#spaces .seg-btn[data-space="cultivation"]:not(.hidden)'));

  // Phrased for the pocket once the phone chrome is up (body.mobile), for the
  // desk otherwise. Both name the Workspace rather than a paired desktop, since
  // pairing is the iOS app's, not the web's.
  const welcomeText = () => (body.classList.contains("mobile")
    ? "Your operator, in your pocket. Ask it to reason, look things up, and keep track of what you are working on. Terminal, files and git open in your Workspace when a turn needs them."
    : "Your operator. Ask it to reason, look things up, and keep track of what you are working on. Terminal, files and git open in your Workspace when a turn needs them.");

  const GENERAL_CHIPS = [
    "Explain what this error means and what to try first",
    "Talk me through two ways to approach this, and which you would pick",
    "Summarize where this project stands and what is next",
  ];
  const CULTIVATION_CHIP = "What did I log about contamination this month, and what should I change?";

  const welcomeChips = () => {
    const chips = [];
    if (cultivationOn()) chips.push(CULTIVATION_CHIP);
    chips.push(...GENERAL_CHIPS);
    return chips.slice(0, 3);
  };

  function webWelcome(root, force) {
    const welcome = root.querySelector ? root.querySelector(".welcome") : null;
    if (!welcome || (welcome.dataset.web === "1" && !force)) return;
    welcome.dataset.web = "1";
    const p = welcome.querySelector("p");
    if (p) p.textContent = welcomeText();
    const text = welcomeChips();
    welcome.querySelectorAll(".chip").forEach((chip, i) => { if (text[i]) chip.textContent = text[i]; });
  }

  /* The first-run card is built in renderer.js for anyone not signed in. Two of
     its three steps are the workspace. Matched on the desktop's own sentences;
     the test holds the needles. */
  const COPY = [
    ["This is the operator over your CroweLM gateway - chat, a real terminal, files, git, and plugin tools, all reviewed through one agent loop.",
     "This is the operator over your CroweLM gateway, in your browser: reasoning, routing to the right expert, and rooms of specialists. Terminal, files and git open in your Workspace."],
    ["Point the workspace at a project folder (Settings or ask the agent).",
     "Open a Workspace from any terminal, files or git request, and it runs there on a real machine."],
    ["Give the agent a task - try",
     "Ask it something - try"],
    ["Sign in with your Crowe ID (Pro access unlocks the full CroweLM tiers).",
     "Sign in with your Crowe ID. Pro unlocks the operator, the rooms and the named agents; the free plan can look around."],
    ["Sign in with your Crowe ID to start. Your Pro access unlocks the full CroweLM tiers.",
     "Sign in with your Crowe ID to start. Pro unlocks the operator; the free plan can look around."],
    ["summarize this repo", "summarize where this project stands"],
    ["run the tests and fix what fails", "talk me through two ways to approach this"],
  ];
  function webCopy(root) {
    if (!root.innerHTML) return;
    let html = root.innerHTML, changed = false;
    for (const [from, to] of COPY) {
      if (html.includes(from)) { html = html.split(from).join(to); changed = true; }
    }
    if (changed) root.innerHTML = html;
  }

  const transcript = $("transcript");
  if (transcript) {
    webWelcome(transcript);
    // On a phone, mobile-ui.js loads after this file (app.html appends it once
    // the width or pointer says phone) and rewrites the welcome to the iOS
    // app's copy, which promises a paired desktop the web does not have. The
    // gate announces when it has run, and the web copy is applied again, in its
    // pocket phrasing, over the top.
    window.addEventListener("crowe:mobile-ui", () => webWelcome(transcript, true));
    new MutationObserver((records) => {
      webWelcome(transcript);
      if (!records.some((r) => [...r.addedNodes].some((n) => n.nodeType === 1))) return;
      setTimeout(() => transcript.querySelectorAll(".msg .said").forEach(webCopy), 0);
    }).observe(transcript, { childList: true });
  }

  // ─── Autonomy tiers ────────────────────────────────────────────────────────
  /* Plan and Read are what the browser can honour. Edit and Execute claim a
     filesystem and a shell that web-bridge.js refuses, so the buttons go, and
     the config's readonly default stands. Hidden rather than removed: the
     renderer's tier code still finds its buttons and nothing there changes. */
  document.querySelectorAll('.seg-btn[data-tier="edit"], .seg-btn[data-tier="execute"]').forEach((b) => {
    b.classList.add("hidden");
    b.setAttribute("aria-hidden", "true");
    b.tabIndex = -1;
  });

  // ─── The Workspace, one tap away ───────────────────────────────────────────
  /* The escalation remedy names croweos.com when a turn asks for the terminal
     or files. Where the shell already refuses, the offer should also stand on
     its own: a small link in the header, so the Workspace is not only reachable
     from a failure. */
  const bar = $("bar");
  const badge = $("userbadge");
  if (bar && badge && !$("web-workspace")) {
    const a = document.createElement("a");
    a.id = "web-workspace";
    a.className = "ghost sm";
    a.href = WORKSPACES_URL;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Workspace";
    a.title = "Open a Crowe Workspace: a real Linux desktop, in this browser.";
    bar.insertBefore(a, badge);
  }

  // ─── The plan, and the way up ──────────────────────────────────────────────
  /* What this Crowe ID is entitled to is the edge's answer (auth.status reports
     the tier it was told, web-bridge.js whoami); what to do about it is this
     file's. Three surfaces, all web-only:

       · the badge after the email already says the plan (renderer.js:3505);
       · a free account gets an Upgrade pill in the header;
       · a plan card, with the live price from the checkout Worker's catalog,
         opens on a paywalled turn (the bridge's crowe:paywall event), on
         ?pricing=1 (where Stripe sends a cancelled checkout), and once per
         browser session on a free account's signed-in load.

     ?upgraded=1 is the return from Stripe through /welcome, which the edge
     turns into a fresh sign-in so the session carries the new tier; what it
     says is what the edge now sees, not what was paid for. A tier the edge
     did not state ("known" false) shows nothing at all: an account whose
     client lacks the claim mapper must not be told it is free. */
  const PLAN_NAMES = { free: "Free", personal: "Personal", pro: "Pro", team: "Team", max: "Max", enterprise: "Enterprise", byok: "BYOK" };
  const billing = window.crowe.billing;
  const query = new URLSearchParams(location.search);
  const transcriptEl = $("transcript");
  const money = (cents, interval) => `$${Math.round(cents / 100)}${interval ? ` a ${interval}` : ""}`;

  // A line from the operator, in the transcript's own markup (renderer.js
  // addAssistant), since that function is not exported.
  function say(html) {
    if (!transcriptEl) return null;
    const welcome = transcriptEl.querySelector(".welcome");
    if (welcome) welcome.remove();
    const wrap = document.createElement("div");
    wrap.className = "msg assistant";
    wrap.innerHTML = '<div class="who"><span class="who-mark" role="img" aria-label="Crowe Logic"></span></div><div class="body"></div>';
    wrap.querySelector(".body").innerHTML = html;
    transcriptEl.appendChild(wrap);
    wrap.scrollIntoView({ block: "end" });
    return wrap;
  }

  function upgradePill(show) {
    let el = $("upgrade-pill");
    if (!show) { if (el) el.remove(); return; }
    if (el) return;
    el = document.createElement("button");
    el.id = "upgrade-pill"; el.type = "button"; el.className = "ghost sm";
    el.textContent = "Upgrade";
    el.title = "Pro unlocks the operator, the rooms and the named agents.";
    el.addEventListener("click", () => planCard({ reason: "pill" }));
    const badge = $("userbadge");
    if (badge && badge.parentNode) badge.parentNode.insertBefore(el, badge);
  }

  async function planCard({ reason } = {}) {
    if (!transcriptEl || !billing) return;
    const prior = transcriptEl.querySelector(".plan-card");
    if (prior) { prior.scrollIntoView({ block: "nearest" }); return; }
    const wrap = say([
      '<div class="plan-card">',
      '<div class="plan-head"><b>Crowe Logic Pro</b><span class="plan-price">reading the price</span></div>',
      '<p class="said plan-why"></p>',
      '<ul class="plan-feats"></ul>',
      '<div class="plan-row"><button type="button" class="primary plan-go">Upgrade with Stripe</button><button type="button" class="ghost plan-later">Not now</button></div>',
      '<p class="hint plan-note"></p>',
      "</div>",
    ].join(""));
    if (!wrap) return;
    const card = wrap.querySelector(".plan-card");
    card.querySelector(".plan-why").textContent =
      (reason === "paywall" ? "That turn needs Pro. " : "") +
      "One subscription unlocks every Crowe Logic surface: the operator here, the rooms and named agents, the desktop and phone apps, and the CLI.";
    const priceEl = card.querySelector(".plan-price");
    const feats = card.querySelector(".plan-feats");
    try {
      const cat = await billing.catalog();
      const pro = ((cat && cat.ladder) || []).find((i) => i.slug === "pro") || null;
      if (pro && pro.amount) {
        priceEl.textContent = money(pro.amount, pro.interval);
        feats.innerHTML = (pro.features || []).slice(0, 6).map((f) => `<li>${esc(f)}</li>`).join("");
      } else {
        priceEl.textContent = "price at checkout";
      }
    } catch (_) {
      priceEl.textContent = "price at checkout";
    }
    card.querySelector(".plan-go").addEventListener("click", async (e) => {
      const b = e.currentTarget;
      b.disabled = true; b.textContent = "Opening Stripe";
      const r = await billing.checkout("pro");
      if (r && r.ok && r.url) { location.assign(r.url); return; }
      b.disabled = false; b.textContent = "Upgrade with Stripe";
      card.querySelector(".plan-note").textContent = (r && r.error) || "Checkout is not answering. Try again in a moment.";
    });
    card.querySelector(".plan-later").addEventListener("click", () => wrap.remove());
  }
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  window.addEventListener("crowe:paywall", () => planCard({ reason: "paywall" }));

  (async () => {
    let p = null;
    try { p = billing ? await billing.plan() : null; } catch (_) { p = null; }
    const signedIn = Boolean(p && p.email);
    const free = Boolean(p && p.known && !p.paid);
    upgradePill(signedIn && free);
    const clearQuery = () => { try { history.replaceState(null, "", location.pathname); } catch (_) {} };
    if (query.get("upgraded") === "1") {
      clearQuery();
      if (p && p.paid) {
        say(`<p class="said">${PLAN_NAMES[p.tier] || esc(p.tier)} is active on ${esc(p.email)}. The operator, the rooms and the named agents are open.</p>`);
      } else if (signedIn) {
        say('<p class="said">Thank you. Your upgrade is landing on this Crowe ID now; if the badge still says Free in a minute, sign out and back in so the session picks it up.</p>');
      }
    } else if (query.get("pricing") === "1") {
      clearQuery();
      planCard({ reason: "pricing" });
    } else if (signedIn && free) {
      let seen = false;
      try { seen = sessionStorage.getItem("crowe-plan-card") === "1"; sessionStorage.setItem("crowe-plan-card", "1"); } catch (_) {}
      if (!seen) planCard({ reason: "free" });
    }
  })();
})();
