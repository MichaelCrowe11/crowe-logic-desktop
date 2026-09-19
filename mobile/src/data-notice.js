/* The data notice. App Store guidelines 5.1.1(i) and 5.1.2(i).
 *
 * Nothing this app sends leaves the phone until the person has read what is
 * sent and to whom and has allowed it. The bridge enforces that under every
 * gateway path (mobile-bridge.js refuses with code "consent" and raises
 * crowe:consent-needed); this file is the notice itself, the Settings section
 * that shows the answer and takes it back, and the two smaller notices for
 * read-aloud and dictation, which reach services the main notice does not
 * send anything to and are asked for the first time each is used.
 *
 * The copy here IS the disclosure. Keep it in step with the privacy page at
 * crowelogic.com/privacy and with the tier-to-engine map the gateway publishes.
 * When a recipient is added, bump DATA_NOTICE_VERSION in the bridge so an older
 * yes stops counting and this is shown again. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  if (!window.crowe || !window.crowe.getConfig || !window.crowe.setConfig) return;
  const POLICY_URL = "https://crowelogic.com/privacy";
  const FEATURE_VERSION = 1;   // read-aloud and dictation notices; the main one is versioned by the bridge
  const say = (t, s) => { if (typeof setComposerStatus === "function") setComposerStatus(t, s); };
  const openPolicy = () => {
    if (window.crowe.mobile && window.crowe.mobile.openExternal) window.crowe.mobile.openExternal(POLICY_URL);
    else window.open(POLICY_URL, "_blank", "noopener");
  };

  const NOTICES = {
    data: {
      key: "dataConsent",
      kicker: "Before you start",
      title: "What Crowe Logic sends, and to whom",
      allow: "Allow and continue",
      later: "Not now",
      html: [
        "<h2>What is sent</h2>",
        "<ul>",
        "<li>The messages you type or dictate, the photos and files you attach, and the replies you ask to hear read aloud.</li>",
        "<li>Your Crowe ID email and plan, so each request can be counted against your account.</li>",
        "</ul>",
        "<h2>Who receives it</h2>",
        "<ul>",
        "<li><b>Crowe Logic's gateway</b> at api.crowelogic.com, running on Microsoft Azure. It records your Crowe ID, the tier, token counts and the time, and passes your message to the model for the tier you chose.</li>",
        "<li><b>CroweLM, Zenith, Vision and the Claude picks</b> are processed by Anthropic's service on Microsoft Azure.</li>",
        "<li><b>Depth, Coder, Flash and the GPT, DeepSeek and Kimi picks</b> are processed by Microsoft Azure, which does not pass them to xAI, OpenAI, DeepSeek or Moonshot AI.</li>",
        "<li><b>Mycelium</b> is Google's Gemma 4 model, run by Crowe Logic on Modal.</li>",
        "<li><b>GLM 5.3 Flash</b> by Z.ai is processed by Cloudflare's inference service.</li>",
        "<li>Photos go to CroweLM Vision, which is Anthropic's service on Microsoft Azure. The model picker names the engine behind every tier.</li>",
        "<li><b>Usage events</b> (which feature ran, when, on which plan) are recorded with PostHog, an analytics service, under your account identifier. Your messages are not included.</li>",
        "<li>If you pair a desktop, the commands you ask it to run go to that machine over your own Tailscale network.</li>",
        "</ul>",
        "<h2>Asked separately, the first time you use them</h2>",
        "<ul>",
        "<li><b>Read aloud</b> sends a reply's text to Microsoft Azure Speech, or to ElevenLabs for the Michael voice.</li>",
        "<li><b>Dictation</b> uses Apple's speech recognition, on the phone or on Apple's servers.</li>",
        "</ul>",
        "<h2>What is not done</h2>",
        "<p>Crowe Logic does not use your conversations to train models, does not sell them, and does not track you across other apps. Your chat history stays on this phone. You can take this permission back at any time in Settings, under Your data.</p>",
      ].join(""),
    },
    readAloud: {
      key: "readAloudConsent",
      kicker: "Read aloud",
      title: "Hearing a reply sends its text to a voice service",
      allow: "Allow read aloud",
      later: "Use the phone's voice instead",
      html: [
        "<p>When you ask to hear a reply, its text goes to Crowe Logic's gateway, which has it spoken by <b>Microsoft Azure Speech</b>, or by <b>ElevenLabs</b> when the Michael voice is on. The text is used to make the audio and for nothing else.</p>",
        "<p>Without this, your phone's own voice reads the reply and nothing is sent.</p>",
      ].join(""),
    },
    dictation: {
      key: "dictationConsent",
      kicker: "Dictation",
      title: "Dictation uses Apple's speech recognition",
      allow: "Allow dictation",
      later: "Not now",
      html: [
        "<p>Your voice may be processed on this phone or on <b>Apple's servers</b>, under Apple's privacy policy, and the words land in the message box.</p>",
        "<p>Nothing is sent to Crowe Logic until you tap send.</p>",
      ].join(""),
    },
  };

  // ─── The sheet ─────────────────────────────────────────────────────────────
  const sheet = document.createElement("div");
  sheet.id = "m-notice";
  sheet.className = "m-notice";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-labelledby", "m-notice-title");
  sheet.innerHTML = [
    '<div class="m-notice-card">',
    '<p class="m-kicker" id="m-notice-kicker"></p>',
    '<h1 class="m-title" id="m-notice-title"></h1>',
    '<div class="m-notice-body" id="m-notice-body"></div>',
    '<div class="m-notice-actions">',
    '<button class="primary" id="m-notice-allow" type="button"></button>',
    '<button class="ghost" id="m-notice-later" type="button"></button>',
    "</div>",
    '<button class="m-notice-policy" id="m-notice-policy" type="button">Read the privacy policy</button>',
    "</div>",
  ].join("");
  body.appendChild(sheet);
  $("m-notice-policy").addEventListener("click", openPolicy);

  let pending = null;   // { kind, resolve } while a notice is on screen
  const stamp = () => ({ version: pending && pending.kind === "data" ? noticeVersion : FEATURE_VERSION, at: new Date().toISOString() });
  let noticeVersion = 1;
  const close = () => { sheet.classList.remove("open"); body.classList.remove("m-notice-open"); pending = null; };
  $("m-notice-allow").addEventListener("click", async () => {
    if (!pending) return;
    const { kind, resolve } = pending;
    try { await window.crowe.setConfig({ [NOTICES[kind].key]: stamp() }); } catch { /* answered below by the bridge refusing again */ }
    close(); paintSettings(); resolve(true);
  });
  $("m-notice-later").addEventListener("click", () => {
    if (!pending) return;
    const { kind, resolve } = pending;
    close(); paintSettings(); resolve(false);
    if (kind === "data") say("Sending is off until you allow the data notice", "note");
  });

  const allowed = (cfg, kind) => {
    const rec = cfg && cfg[NOTICES[kind].key];
    const need = kind === "data" ? Number(cfg && cfg.dataNoticeVersion) || 1 : FEATURE_VERSION;
    return Boolean(rec && Number(rec.version) >= need);
  };
  /* Shows the notice for `kind` and answers true when it is allowed. A notice
     already on screen is answered once, to everyone who asked. */
  function show(kind) {
    const n = NOTICES[kind];
    if (!n) return Promise.resolve(false);
    if (pending) {
      if (pending.kind === kind) return pending.promise;
      return pending.promise.then(() => show(kind));
    }
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    pending = { kind, resolve, promise };
    $("m-notice-kicker").textContent = n.kicker;
    $("m-notice-title").textContent = n.title;
    $("m-notice-body").innerHTML = n.html;
    $("m-notice-allow").textContent = n.allow;
    $("m-notice-later").textContent = n.later;
    sheet.classList.toggle("compact", kind !== "data");
    sheet.scrollTop = 0;
    sheet.classList.add("open"); body.classList.add("m-notice-open");
    return promise;
  }
  /* ask(kind): true at once when already allowed, otherwise the notice. This is
     what speak.js and the dictation button call before their first send. */
  async function ask(kind) {
    const cfg = await window.crowe.getConfig();
    if (allowed(cfg, kind)) return true;
    return show(kind);
  }
  async function has(kind) { return allowed(await window.crowe.getConfig(), kind); }
  async function withdraw() {
    await window.crowe.setConfig({ dataConsent: null, readAloudConsent: null, dictationConsent: null });
    paintSettings();
    say("Sending is off until you allow the data notice", "note");
  }
  window.croweConsent = { ask, has, show, withdraw };

  // ─── Settings: Your data ───────────────────────────────────────────────────
  const section = document.createElement("section");
  section.className = "key-manager m-data";
  section.innerHTML = [
    '<div class="settings-section-head"><div><b>Your data</b>',
    '<span id="m-data-state">Loading</span></div></div>',
    '<div class="m-data-actions">',
    '<button id="m-data-notice" class="ghost sm" type="button">Show the notice</button>',
    '<button id="m-data-policy" class="ghost sm" type="button">Privacy policy</button>',
    '<button id="m-data-withdraw" class="ghost sm" type="button">Take permission back</button>',
    "</div>",
  ].join("");
  const account = document.querySelector("#settings .m-account");
  if (account && account.parentNode) account.parentNode.insertBefore(section, account);
  else { const list = $("key-provider-list"); const km = list && list.closest(".key-manager"); if (km && km.parentNode) km.parentNode.insertBefore(section, km.nextSibling); }
  const fmt = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch { return iso; } };
  async function paintSettings() {
    const el = $("m-data-state"); if (!el) return;
    let cfg = null;
    try { cfg = await window.crowe.getConfig(); } catch { cfg = null; }
    const parts = [];
    if (allowed(cfg, "data")) parts.push(`Allowed on ${fmt(cfg.dataConsent.at)}: what you send goes to Crowe Logic's gateway and to the service behind the tier you chose.`);
    else parts.push("Not allowed. Nothing is sent, and the notice is shown when you try to send.");
    parts.push(`Read aloud ${allowed(cfg, "readAloud") ? "allowed" : "not asked yet"}. Dictation ${allowed(cfg, "dictation") ? "allowed" : "not asked yet"}.`);
    el.textContent = parts.join(" ");
    const w = $("m-data-withdraw"); if (w) w.disabled = !(allowed(cfg, "data") || allowed(cfg, "readAloud") || allowed(cfg, "dictation"));
  }
  $("m-data-notice").addEventListener("click", () => show("data"));
  $("m-data-policy").addEventListener("click", openPolicy);
  $("m-data-withdraw").addEventListener("click", async () => {
    if (!window.confirm("Take back permission to send?\n\nNothing will leave this phone until you allow the notice again. What was already sent is not affected.")) return;
    await withdraw();
  });
  const settingsBtn = $("settings-btn");
  if (settingsBtn) settingsBtn.addEventListener("click", () => setTimeout(paintSettings, 50));

  // ─── Launch ────────────────────────────────────────────────────────────────
  // The bridge refuses a send made before the notice is allowed and raises this;
  // the notice comes back rather than the refusal sitting in the transcript.
  window.addEventListener("crowe:consent-needed", () => { show("data"); });
  window.crowe.getConfig().then((cfg) => {
    noticeVersion = Number(cfg && cfg.dataNoticeVersion) || 1;
    paintSettings();
    if (!allowed(cfg, "data")) show("data");
  }).catch(() => {});
})();
