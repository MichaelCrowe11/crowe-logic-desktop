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
})();
