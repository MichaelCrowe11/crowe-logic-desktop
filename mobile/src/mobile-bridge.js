// Crowe Logic mobile — the bridge the renderer talks to on a phone.
//
// On the desktop, window.crowe is preload.js forwarding IPC to a Node main
// process that owns a workspace: a shell, a file tree, a git checkout, an MCP
// client. None of that exists inside an iOS or Android webview, and pretending
// otherwise is how a port ships a Files pane that lists nothing and a terminal
// that hangs. So this file re-implements the same surface with three honest
// classes of answer:
//
//   real     — the gateway (chat, the agent loop, the catalog), Crowe ID,
//              sessions, provider keys, settings.
//   local    — persisted through Capacitor Preferences instead of userData,
//              so the phone keeps its own sessions and general reminders.
//   refused  — the workspace capabilities, which return a stated reason
//              rather than an empty success. A pane that says "no shell on
//              iOS" is usable; one that spins forever is not.
//
// Every method keeps the desktop's return shape, because the renderer is
// copied here unmodified and reads those shapes directly. When you change a
// handler in main.js, change its twin here — scripts/test-mobile-bridge.js
// fails the build if the two surfaces drift apart.

(function () {
  "use strict";

  const CAP = window.Capacitor || null;
  const NATIVE = Boolean(CAP && typeof CAP.isNativePlatform === "function" && CAP.isNativePlatform());
  const PLATFORM = (CAP && CAP.getPlatform && CAP.getPlatform()) || "web";
  // The phone's product boundary is closure-owned. Replacing window.crowe.edition,
  // saved settings, pairing and model output cannot grant these capabilities.
  const EDITION = Object.freeze({
    id: "desktop", productName: "Crowe Logic",
    allowedSpaces: Object.freeze(["chat", "projects"]),
    defaultSpaces: Object.freeze(["chat", "projects"]), landingSpace: "chat",
    capabilities: Object.freeze({ grow: false, farm: false, sense: false, legacyAccess: false }),
    legacyAccess: false,
  });
  const GROW_OFF = "Growing records and specialist workflows are unavailable in this general phone app. Existing records are unchanged.";
  const unavailableGrow = () => ({ ok: false, error: GROW_OFF, code: "UNAVAILABLE" });
  const growToolAllowed = name => EDITION.capabilities.grow || !["read_grow", "log_grow"].includes(name);
  const specialistName = value => /(?:^|[-_:/\s])(grower|cultivation|mycology)(?:$|[-_:/\s])/i.test(String(value || ""));
  const specialistModels = new Set();
  // Unknown aliases are not general by default. Keep established general
  // routes available offline; custom IDs require catalog validation before
  // Rooms may claim a routine or any gateway path may dispatch them.
  const GENERAL_MODELS = new Set(["crowelm", "crowelm-flash", "crowelm-vision", "crowelm-mycelium", "gpt-5.6-sol"]);
  let catalogModels = new Set();
  function modelAllowed(model) {
    const id = String(model || "").toLowerCase();
    return EDITION.capabilities.grow || (!id || (!specialistName(id) && !specialistModels.has(id)
      && (GENERAL_MODELS.has(id) || catalogModels.has(id))));
  }
  function filterCatalog(models) {
    // Remember specialist IDs as well as filtering the picker, so a restored
    // room or saved default cannot bypass metadata-only catalog restrictions.
    for (const m of models) if (m && [m.role, m.model, m.id].some(specialistName)) {
      for (const id of [m.model, m.id]) if (id) specialistModels.add(String(id).toLowerCase());
    }
    catalogModels = new Set(models.filter(m => m && ![m.role, m.model, m.id].some(specialistName))
      .flatMap(m => [m.model, m.id]).filter(id => typeof id === "string" && id).map(id => id.toLowerCase()));
    return models.filter(m => m && modelAllowed(m.model) && modelAllowed(m.id) && !specialistName(m.role));
  }
  const defaultModel = () => modelAllowed(config.model) ? (config.model || DEFAULTS.model) : DEFAULTS.model;
  const plugin = (name) => (CAP && CAP.Plugins && CAP.Plugins[name]) || null;

  const CROWE_ID = "https://id.crowelogic.com/realms/crowe";
  const CROWE_ID_CLIENT = "crowe-cli";
  // The redirect the authorization server sends the code back to. A custom
  // scheme rather than a loopback port: a phone has no localhost the browser
  // and the app agree on, and App.addListener("appUrlOpen") is how the code
  // gets home. Overridable from settings so a build using its own Crowe ID
  // client can point at whatever that client has registered.
  const DEFAULT_REDIRECT = "com.crowelogic.mobile://auth/callback";

  const RATE_IN = 1.25 / 1e6, RATE_OUT = 10 / 1e6;   // same display rates as main.js
  const MAX_ROUNDS = 12;        // half the desktop's: no shell means far shorter loops
  const TOOL_RESULT_MAX = 4000;
  const ROOMS_OFF = "Rooms run several agents against one workspace, which lives on the desktop. Open the room there; this phone can drive that machine but cannot host it.";
  // Long command output matters at both ends: what ran is at the top, why it
  // failed is at the bottom. The turn loop slices tool text to TOOL_RESULT_MAX
  // before it reaches the model, which would keep the top and throw away the
  // reason — so machine output is clipped from the middle first, and the
  // per-stream budgets below add up to less than that cap.
  const REMOTE_OUT_MAX = 2200, REMOTE_ERR_MAX = 1200;
  function clip(text, max) {
    const s = String(text);
    if (s.length <= max) return s;
    const head = Math.floor(max * 0.35), tail = max - head - 40;
    return `${s.slice(0, head)}\n... ${s.length - head - tail} bytes cut ...\n${s.slice(-tail)}`;
  }
  const CONTEXT_BUDGET_CHARS = 120000;

  // ─── Storage ───────────────────────────────────────────────────────────────
  // Preferences on a device, localStorage in a plain browser (`npm run serve`).
  // Both are async here so the caller cannot come to depend on the synchronous
  // one and then break on the platform that is actually shipped.
  const Preferences = plugin("Preferences");
  const store = {
    async get(key) {
      try {
        // Secrets live in the Keychain when vault.js is present (see mobile/src/vault.js).
        if (window.croweVault && window.croweVault.handles(key)) { const v = await window.croweVault.get(key); return v ? JSON.parse(v) : null; }
        if (Preferences) { const { value } = await Preferences.get({ key }); return value ? JSON.parse(value) : null; }
        const raw = localStorage.getItem("crowe:" + key);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    },
    async set(key, value) {
      const json = JSON.stringify(value);
      try {
        if (window.croweVault && window.croweVault.handles(key)) { await window.croweVault.set(key, json); return true; }
        if (Preferences) await Preferences.set({ key, value: json });
        else localStorage.setItem("crowe:" + key, json);
        return true;
      } catch { return false; }
    },
    async remove(key) {
      try {
        if (window.croweVault && window.croweVault.handles(key)) { await window.croweVault.remove(key); return; }
        if (Preferences) await Preferences.remove({ key });
        else localStorage.removeItem("crowe:" + key);
      } catch { /* nothing to remove is not a failure */ }
    },
  };

  // ─── Config ────────────────────────────────────────────────────────────────
  // Mirrors DEFAULTS in main.js, minus the fields that describe a workspace.
  // Autonomy gates attached-file edits and paired-machine operations. The
  // general phone has no cultivation workspace, regardless of this setting.
  const DEFAULTS = {
    baseUrl: "https://api.crowelogic.com",
    model: "crowelm",
    token: "",
    refreshToken: "",
    authRedirect: DEFAULT_REDIRECT,
    autonomy: "edit",
    autoApprove: false,
    approvals: "high-risk",
    textPace: "reading",      // a phone in a hand reads along; the desktop defaults to brisk
    verifier: false,          // the verifier is a second full turn; too expensive on cellular by default
    turnBudgetUsd: 2,
    telemetry: true,
    onboarded: false,
    /* The data notice. Nothing leaves this phone for the gateway or a model
       until the person has read what is sent and to whom and has allowed it
       (App Store guidelines 5.1.1(i) and 5.1.2(i)). The record carries the
       version of the notice it answered, so a notice that names a new
       recipient is shown again instead of riding on an older yes. Read-aloud
       and dictation keep their own records because they reach different
       services (Microsoft Azure Speech or ElevenLabs; Apple) and are asked
       for separately, the first time each is used. */
    dataConsent: null,
    readAloudConsent: null,
    dictationConsent: null,
    // The machine this phone may drive, and the token that proves it may.
    // Empty means the remote tools do not exist at all — they are not offered
    // to the model, so it cannot claim a shell it has no way to reach.
    remoteUrl: "",
    remoteToken: "",
    licenseWorkspaceId: "",
    keys: {},
  };
  const TIERS = new Set(["plan", "readonly", "edit", "execute"]);
  // Bump when the notice names a new recipient or a new kind of data; an
  // older yes then stops counting and the notice is shown again.
  const DATA_NOTICE_VERSION = 3;
  const FEATURE_NOTICE_VERSION = 2;
  const consentKeys = ["dataConsent", "readAloudConsent", "dictationConsent"];
  // One nonsecret authority, never the config vault's fallback pair. A recovered
  // Keychain may contain old settings; those must never restore an allowance.
  const CONSENT_STORE_KEY = "data-consent-v2";
  let consentEpoch = 0;
  let consentWithdrawalPending = false;
  const validConsent = (rec, version) => Boolean(rec && rec.version === version && typeof rec.at === "string" && Number.isFinite(Date.parse(rec.at)));
  let configSave = Promise.resolve();
  const CONSENT_ERROR = "Allow Crowe Logic to send your messages before sending. The data notice says what is sent and to whom.";
  const consented = () => validConsent(config.dataConsent, DATA_NOTICE_VERSION);
  /* The refusal every gateway path answers with before the notice is allowed,
     and the event mobile-ui.js listens for to put the notice back on screen.
     Enforced here, under the UI, so no composer, pane, chip or intent can
     reach the gateway around it. */
  function consentNeeded() {
    try { window.dispatchEvent(new CustomEvent("crowe:consent-needed")); } catch { /* no window in tests */ }
    return { error: CONSENT_ERROR, code: "consent" };
  }
  let config = { ...DEFAULTS };
  let BUILD = { version: "0.0.0" };

  const ready = (async () => {
    const saved = await store.get("config");
    if (saved && typeof saved === "object") config = { ...DEFAULTS, ...saved };
    for (const k of consentKeys) config[k] = null;
    const allowance = await store.get(CONSENT_STORE_KEY);
    for (const k of consentKeys) {
      const rec = allowance && allowance[k];
      if (validConsent(rec, k === "dataConsent" ? DATA_NOTICE_VERSION : FEATURE_NOTICE_VERSION)) config[k] = rec;
    }
    if (!TIERS.has(config.autonomy)) config.autonomy = DEFAULTS.autonomy;
    if (!/^https?:\/\//i.test(config.baseUrl || "")) config.baseUrl = DEFAULTS.baseUrl;
    // Enforce cached metadata-only specialist aliases even on the first offline
    // chat or restored room; this does not rewrite the saved model selection.
    const cachedCatalog = await store.get("catalog");
    if (cachedCatalog && Array.isArray(cachedCatalog.models)) catalogCache = { ...cachedCatalog, models: filterCatalog(cachedCatalog.models) };
    try { BUILD = await (await fetch("build.json")).json(); } catch { /* dev serve without a build stamp */ }
  })();

  function saveConfig(patch, consentChange = false, expectedEpoch = consentEpoch) {
    patch = { ...(patch || {}) };
    // A stale Settings snapshot must never restore an allowance. Only the
    // notice's dedicated, revision-checked path may grant one.
    if (!consentChange) for (const k of consentKeys) delete patch[k];
    const revoking = consentChange && consentKeys.some(k => Object.hasOwn(patch, k) && patch[k] === null);
    if (revoking) {
      consentWithdrawalPending = true;
      for (const k of consentKeys) config[k] = null;
      consentEpoch += 1;
      try { window.crowe.agent.stopAll(); } catch { /* startup */ }
      try { window.dispatchEvent(new CustomEvent("crowe:consent-withdrawn")); } catch { /* tests */ }
    }
    const operation = configSave.then(async () => {
      if (consentChange && !revoking && expectedEpoch !== consentEpoch) throw new Error("The notice changed. Read it again before allowing.");
      const next = { ...config };
      for (const [k, v] of Object.entries(patch)) {
        if (k === "autonomy" && !TIERS.has(v)) continue;
        if (k === "token" && v === "") continue;
        if (consentKeys.includes(k) && v !== null && !validConsent(v, k === "dataConsent" ? DATA_NOTICE_VERSION : FEATURE_NOTICE_VERSION)) throw new Error("Invalid data notice allowance");
        next[k] = v;
      }
      if (revoking) for (const k of consentKeys) next[k] = null;
      const payload = consentChange
        ? Object.fromEntries(consentKeys.map(k => [k, next[k]]))
        : Object.fromEntries(Object.entries(next).filter(([k]) => !consentKeys.includes(k)));
      if (!await store.set(consentChange ? CONSENT_STORE_KEY : "config", payload)) throw new Error(revoking
        ? "Sending is stopped here, but withdrawal could not be saved. Retry before restarting the app."
        : "Settings could not be saved. Permission was not granted.");
      // Withdrawal while persistence was pending wins over the old grant.
      if (consentChange && !revoking && expectedEpoch !== consentEpoch) throw new Error("Permission was withdrawn while saving.");
      const currentConsent = Object.fromEntries(consentKeys.map(k => [k, config[k]]));
      config = next;
      if (revoking) consentWithdrawalPending = false;
      if (!consentChange) Object.assign(config, currentConsent);
      return config;
    });
    configSave = operation.catch(() => {});
    return operation;
  }
  const base = () => String(config.baseUrl || DEFAULTS.baseUrl).replace(/\/$/, "");

  // What the renderer is told about this install. ptyAvailable is false and
  // stays false: it is the flag the terminal pane reads before it tries.
  function publicConfig() {
    return {
      baseUrl: config.baseUrl, hasToken: Boolean(config.token), cwd: "",
      autoApprove: Boolean(config.autoApprove), autonomy: config.autonomy,
      approvals: config.approvals, textPace: config.textPace, verifier: Boolean(config.verifier),
      turnBudgetUsd: config.turnBudgetUsd, telemetry: Boolean(config.telemetry),
      onboarded: Boolean(config.onboarded), mcp: [], ptyAvailable: false,
      consentWithdrawalPending,
      dataConsent: config.dataConsent || null, readAloudConsent: config.readAloudConsent || null,
      dictationConsent: config.dictationConsent || null, dataNoticeVersion: DATA_NOTICE_VERSION, featureNoticeVersion: FEATURE_NOTICE_VERSION,
      version: BUILD.version, platform: PLATFORM, mobile: true,
      // The paired machine, never its token. publicConfig is what the renderer
      // reads and what a panel could print; the credential stays in the bridge.
      remote: { configured: remoteConfigured(), host: remoteBase() },
    };
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────────
  /* Two ways out of a Capacitor webview, and the app needs both.

     window.fetch is the real thing: it streams, which is the whole point of a
     token-by-token reply. But the page origin is capacitor://localhost or
     https://localhost, so every gateway call is cross-origin and dies unless
     api.crowelogic.com sends CORS headers back to those origins.

     CapacitorHttp goes through the native HTTP stack, where same-origin policy
     does not apply — and cannot stream, because the plugin hands back one
     finished body.

     So: stream over fetch, and if the network layer itself refuses (which is
     what a blocked preflight looks like from in here — a TypeError, no status),
     repeat the call natively and return it whole. The reply arrives in one
     piece instead of a word at a time, which is a visible downgrade and a
     working app, in that order. */
  const CapHttp = (CAP && CAP.CapacitorHttp) || plugin("CapacitorHttp");
  function corsBlocked(e) {
    return e instanceof TypeError || /Failed to fetch|Load failed|NetworkError|CORS/i.test(String(e || ""));
  }
  async function nativePost(url, headers, body) {
    if (!CapHttp) return null;
    const res = await CapHttp.request({ url, method: "POST", headers, data: body, responseType: "text" });
    const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? "");
    return { ok: res.status >= 200 && res.status < 300, status: res.status, text };
  }

  // ─── The machine at the other end ──────────────────────────────────────────
  /* A phone cannot run a shell — iOS will not fork a process for you, and the
     bridge says so everywhere else in this file. What it can do is drive a
     machine that can. Crowe Terminal is already that server: /run, /read_file
     and /write_file over bearer auth, running under launchd on the desktop.

     Reached over Tailscale, so the shell is never on the public internet: both
     devices are already on the tailnet, the address is a 100.x one that only
     resolves inside it, and the token is checked on every call.

     Native HTTP, not fetch. The tailnet address is plain http on a private
     network — a webview would refuse it as mixed content from an https origin
     and, on Android, `allowMixedContent: false` in capacitor.config.json says
     so explicitly. CapacitorHttp is also how these calls avoid the CORS wall
     the token endpoint taught us about. */
  const remoteBase = () => String(config.remoteUrl || "").replace(/\/$/, "");
  const remoteConfigured = () => Boolean(remoteBase());

  // ─── Files the user hands the phone ────────────────────────────────────────
  /* iOS and Android do not give an app the filesystem; they give it a document
     picker and whatever the user chose in it. This store is that grant, held
     in memory for the session: mobile-ui.js registers what the picker
     returned, and the file tools answer `phone:` paths from it — paired or
     not, because these files are already in the app's hands. Per-file, by the
     user's own tap, which is the platforms' consent model and honest here too.

     Nothing writes back into the phone's storage. A webview cannot save into
     an arbitrary picked location (iOS wants a document-scoped bookmark, which
     a picker <input> does not carry), so an edited copy leaves through the
     share sheet — the exit the platform actually offers. The chips row in
     mobile-ui.js is where that handoff lives.

     Session-scoped on purpose: holding a user's document contents in
     localStorage would outlive the conversation the grant was made for. */
  const phoneFiles = new Map();               // name -> { content, at }
  /* Photos are a second grant, kept apart from text files because they travel
     differently. A text file waits at a phone: path for a tool to read it. A
     photo rides inside the next turn itself, as an image part on the user's
     message, and that turn goes to CroweLM Vision whatever the words would
     have routed to. Pending until sent, then cleared: a photo is looked at
     once, on purpose, and never lands in the saved session. */
  const phoneImages = new Map();              // name -> { dataUrl, at }
  const PHONE_IMAGE_MAX = 4 * 1024 * 1024;    // data URL length; the composer downsizes to ~1280px first
  const PHONE_FILE_MAX = 512 * 1024;
  const phoneListeners = new Set();
  const phoneNotify = () => { for (const fn of phoneListeners) { try { fn(); } catch {} } };
  window.crowePhone = {
    max: PHONE_FILE_MAX,
    // For phone-only scripts that call the gateway themselves (speak.js): the
    // current bearer, after auth.status() has had its chance to refresh it.
    accessToken: () => config.token || null,
    // Consent is not an ordinary preference: stale whole-config writes cannot
    // grant it, and old in-flight work cannot resume after withdraw/reallow.
    consentEpoch: () => consentEpoch,
    consentValid: (epoch, feature) => epoch === consentEpoch && consented() && (!feature || validConsent(config[feature + "Consent"], FEATURE_NOTICE_VERSION)),
    async setConsent(patch, epoch) {
      await ready;
      if (!patch || Object.keys(patch).some(k => !consentKeys.includes(k))) throw new Error("Invalid notice update");
      await saveConfig(patch, true, epoch); return publicConfig();
    },
    add(name, content) {
      name = String(name || "").replace(/[/\\]/g, "_").trim();
      if (!name) return { error: "a file needs a name" };
      content = String(content ?? "");
      if (content.length > PHONE_FILE_MAX) return { error: `over the ${Math.round(PHONE_FILE_MAX / 1024)} KB cap` };
      phoneFiles.set(name, { content, at: Date.now() });
      phoneNotify();
      return { ok: true, name };
    },
    remove(name) { phoneFiles.delete(String(name || "")); phoneImages.delete(String(name || "")); phoneNotify(); },
    list() { return [...phoneFiles.entries()].map(([name, f]) => ({ name, size: f.content.length, at: f.at })); },
    get(name) { const f = phoneFiles.get(String(name || "")); return f ? f.content : null; },
    onChange(fn) { phoneListeners.add(fn); return () => phoneListeners.delete(fn); },
    addImage(name, dataUrl) {
      name = String(name || "photo.jpg").replace(/[/\\]/g, "_").trim() || "photo.jpg";
      dataUrl = String(dataUrl || "");
      if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) return { error: "not an image" };
      if (dataUrl.length > PHONE_IMAGE_MAX) return { error: "photo too large even after downsizing" };
      let key = name, n = 2;
      while (phoneImages.has(key)) key = name.replace(/(\.[^.]+)?$/, ` ${n++}$1`);
      phoneImages.set(key, { dataUrl, at: Date.now() });
      phoneNotify();
      return { ok: true, name: key };
    },
    images() { return [...phoneImages.entries()].map(([name, p]) => ({ name, size: p.dataUrl.length, at: p.at })); },
    async share(name) {
      const f = phoneFiles.get(String(name || ""));
      if (!f) return { error: "no such file" };
      const Share = plugin("Share");
      if (Share) { await Share.share({ title: name, text: f.content }).catch(() => {}); return { ok: true }; }
      // Browser preview: the share sheet does not exist, but the copy does.
      await navigator.clipboard?.writeText(f.content).catch(() => {});
      return { ok: true, copied: true };
    },
  };

  /* Things that outlive the command that made them.

     Found by watching this app in real use: from a phone, at Edit tier, the
     agent wrote a shell script, chmod'd it, and installed a LaunchAgent — a
     daemon that now starts on every login. Nothing asked, and nothing was
     wrong: write_file plus run_command is persistence, and that is the design
     reaching its logical end rather than a bug in it.

     What makes a phone different from a laptop here is not the power, it is the
     evidence. On a laptop you watch it happen in a terminal you are already
     looking at. On a phone you approve a sentence in a chat bubble and the
     result is a background process on a machine in another building.

     So the tier still decides what class of thing is allowed, and this decides
     what deserves a second look regardless of tier. Deliberately small: a list
     that flags everything is a list people tap through without reading. */
  const PERSISTENCE = [
    [/\bLaunch(Agents|Daemons)\b/i, "installs something that runs at every login"],
    [/\blaunchctl\s+(load|bootstrap|enable|submit)\b/i, "registers a background service with launchd"],
    [/\bcrontab\b|\/etc\/cron/i, "schedules a job that keeps running"],
    [/\bsystemctl\s+enable\b/i, "enables a service at boot"],
    [/(^|\s|\/)\.(zshrc|bashrc|bash_profile|profile|zprofile|zshenv)\b/, "changes what runs in every new shell"],
    [/\bdefaults\s+write\b.*\b(LoginItems|AutoLaunch)/i, "adds a login item"],
    [/^\s*sudo\b|\s\|\s*sudo\b|&&\s*sudo\b/, "runs as root"],
    [/\bssh-keygen\b|authorized_keys/i, "changes who can log in to this machine"],
  ];
  /* Programs that want a keyboard.

     Lifted out of the console so scripts/test-mobile-shell.js can exercise it:
     the first version matched on the program name alone and refused
     `claude -p "..."` — the very form its own error message recommends.
     Being wrong about that is worse than not checking, because it teaches the
     user the feature is broken. */
  // Nothing here has a useful one-shot form, so the name alone is enough.
  const INTERACTIVE = new Set([
    "vim", "vi", "nvim", "nano", "emacs", "pico",
    "top", "htop", "btop", "less", "more", "man", "tmux", "screen",
    "irb", "psql", "mysql", "sqlite3", "ftp", "telnet", "watch",
  ]);
  /* These are interactive when invoked bare and perfectly usable with the
     right flag — which matters, because the refusal message recommends
     exactly those flags. Matching on the program name alone blocked
     `claude -p "..."`, the alternative it had just suggested. */
  const ONE_SHOT = {
    claude: /(^|\s)(-p\b|--print\b)/,
    codex: /(^|\s)(exec\b|-p\b|--print\b)/,
    ssh: /^\S+\s+\S+\s+\S/,
  };
  const REPL_ALONE = new Set(["python", "python3", "node", "ruby", "php", "R", "julia", "bash", "zsh", "sh", "fish"]);

  function needsKeyboard(command) {
    const text = String(command || "").trim();
    const head = text.split(/\s+/)[0].replace(/^.*\//, "");
    const bare = text.split(/\s+/).length === 1;
    if (INTERACTIVE.has(head)) return head;
    if (ONE_SHOT[head]) return ONE_SHOT[head].test(text) ? null : head;
    if (bare && REPL_ALONE.has(head)) return head;
    return null;
  }
  window.__croweNeedsKeyboard = needsKeyboard;

  function persistenceRisk(text) {
    const s = String(text || "");
    for (const [re, why] of PERSISTENCE) if (re.test(s)) return why;
    return null;
  }
  /* A seam for scripts/test-mobile-shell.js, which drives the built bridge in a
     page and cannot reach a closure. Not on window.crowe deliberately: that
     surface is held to the desktop's shape, and this is not part of it. */
  window.__crowePersistenceRisk = persistenceRisk;

  async function remoteCall(path, payload, timeoutNote) {
    const base = remoteBase();
    if (!base) return { error: "No machine is paired with this phone. Settings → Remote machine." };
    const headers = { "Content-Type": "application/json" };
    if (config.remoteToken) headers.Authorization = `Bearer ${config.remoteToken}`;
    let r;
    try {
      r = await nativePost(`${base}${path}`, headers, JSON.stringify(payload));
    } catch (e) {
      /* Almost always a sleeping desktop rather than anything broken, and that
         is worth saying: the machine is only reachable while it is awake and on
         the tailnet, which is the honest limit of the whole feature. Naming it
         beats a stack trace the user cannot act on. */
      return { error: `${base} did not answer. The machine may be asleep, quit, or off the tailnet.`, offline: true };
    }
    if (!r) return { error: "the remote call needs the installed app" };
    let data = null;
    try { data = JSON.parse(r.text || "null"); } catch { /* not json — reported below */ }
    if (r.status === 401) return { error: "the machine rejected this phone's token" };
    if (r.status === 404 && path !== "/health") return { error: `the machine has no ${path} endpoint` };
    if (!r.ok) return { error: (data && data.detail) || `${timeoutNote || "remote call"} failed (HTTP ${r.status})` };
    return { ok: true, data };
  }

  /* Pairing by link, which is how a person who is not the author of this app
     will ever do it. Typing a tailnet address and a 48-character token on a
     phone keyboard is not a setup flow; scanning a code the desktop shows is.
     The desktop puts com.crowelogic.mobile://pair?url=…&token=… into a QR, the
     camera opens it, and this handler receives it.

     It asks first, every time. A custom scheme is not a private channel — any
     web page the user visits can navigate to one, so a link alone must never
     be enough to repoint a phone at someone else's machine. An attacker who
     could do that silently would not gain a shell, but they would receive
     every command the user asked for and get to answer with whatever they
     liked. One confirmation, naming the host, closes that. */
  let takingIntent = false;
  async function takePendingIntent() {
    if (takingIntent) return null;
    takingIntent = true;
    try {
      const note = await store.get("intent");
      if (!note || typeof note !== "object" || !note.kind) return null;
      await store.remove("intent");
      // Retired grow shortcuts must never reach UI listeners, even when a saved
      // native shortcut still writes an old handoff. Only generic Ask survives.
      if (note.kind !== "ask") return null;
      // Notes older than ten minutes are stale: the phone was opened for some
      // other reason since, and running an old question now would surprise.
      if (note.at && Date.now() - Number(note.at) > 10 * 60 * 1000) return null;
      try { window.dispatchEvent(new CustomEvent("crowe:intent", { detail: { kind: String(note.kind), text: String(note.text || "") } })); } catch { /* no window in tests */ }
      return note;
    } finally { takingIntent = false; }
  }
  function pairFromUrl(rawUrl) {
    const url = String(rawUrl || "");
    if (!/^com\.crowelogic\.mobile:\/\/pair\b/i.test(url)) return false;
    let host = "", token = "";
    try {
      const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      host = String(q.get("url") || "").trim().replace(/\/$/, "");
      token = String(q.get("token") || "");
    } catch { return false; }
    if (!/^https?:\/\//i.test(host)) return false;
    (async () => {
      await ready;
      const ok = window.confirm(
        `Pair this phone with ${host}?\n\n` +
        "It will be able to read files, write files and run shell commands there, " +
        "as the tier you choose allows.\n\nOnly continue if you started this."
      );
      if (!ok) return;
      await saveConfig({ remoteUrl: host, remoteToken: token });
      announceRemote();
      const s = await remoteStatus();
      window.alert(s.reachable ? `Paired with ${host}.` : `Saved ${host}, but it did not answer${s.error ? `: ${s.error}` : "."}`);
    })();
    return true;
  }

  /* Registered once for the life of the app, not inside signIn — that listener
     exists only while a sign-in is in flight. Both run on every appUrlOpen and
     each ignores what is not addressed to it.

     getLaunchUrl covers the cold start: a phone that was not already running
     when the link was opened never sees an appUrlOpen event, it just launches
     with the URL attached. Handling only the warm case is why deep links work
     when you test them and fail for the person who installed the app. */
  (() => {
    const App = plugin("App");
    if (!App) return;
    Promise.resolve(App.addListener("appUrlOpen", (e) => { pairFromUrl(e && e.url); }));
    /* Siri and Shortcuts. The App Intents in CroweIntents.swift open the app and
       leave a note under the Preferences key `intent` ({kind, text, at}); it is
       read and cleared here on launch and on every return to the foreground,
       then handed to the UI as a crowe:intent event. Two readers race on a cold
       start (this one and the appStateChange below), so the read is a take. */
    Promise.resolve(App.addListener("appStateChange", (st) => { if (st && st.isActive) takePendingIntent(); })).catch(() => {});
    ready.then(() => takePendingIntent()).catch(() => {});
    if (App.getLaunchUrl) {
      Promise.resolve(App.getLaunchUrl()).then((r) => { if (r && r.url) pairFromUrl(r.url); }).catch(() => {});
    }
  })();


  // Retire only notifications positively identified by structured lot metadata
  // and a native int32 ID. Never infer from title/body, purge saved reminders,
  // or cancel all notifications. A failed cancellation is retried on foreground.
  const growReminder = row => !EDITION.capabilities.grow && Boolean(row && typeof row.lot === "string" && row.lot.trim());
  const nativeReminderId = id => Number.isInteger(id) && id > 0 && id <= 2147483647;
  let retiringReminders = null;
  function retireGrowReminders() {
    if (retiringReminders) return retiringReminders;
    retiringReminders = (async () => {
      const LN = plugin("LocalNotifications");
      if (!LN || !LN.getPending || !LN.cancel || EDITION.capabilities.grow) return;
      try {
        const result = await LN.getPending();
        const saved = await store.get("reminders");
        const ids = new Set((Array.isArray(saved) ? saved : []).filter(growReminder).map(r => r.id).filter(nativeReminderId));
        const notifications = ((result && result.notifications) || [])
          .filter(n => n && nativeReminderId(n.id) && (growReminder(n.extra) || ids.has(n.id)))
          .map(n => ({ id: n.id }));
        if (notifications.length) await LN.cancel({ notifications });
      } catch { /* Leave records intact and retry next foreground. */ }
    })().finally(() => { retiringReminders = null; });
    return retiringReminders;
  }
  (() => {
    const LN = plugin("LocalNotifications");
    if (LN && LN.addListener) Promise.resolve(LN.addListener("localNotificationActionPerformed", async event => {
      const notification = event && event.notification;
      if (!notification || growReminder(notification.extra)) return;
      const saved = await store.get("reminders");
      if (Array.isArray(saved) && saved.some(r => r && r.id === notification.id && growReminder(r))) return;
      try { window.dispatchEvent(new CustomEvent("crowe:intent", { detail: { kind: "ask", text: "" } })); } catch { /* tests */ }
    })).catch(() => {});
    const App = plugin("App");
    if (App) Promise.resolve(App.addListener("appStateChange", state => {
      if (state && state.isActive) retireGrowReminders();
    })).catch(() => {});
    ready.then(retireGrowReminders).catch(() => {});
  })();

  // Told to the page, not just stored: the tier strip and the placeholders are
  // drawn from whether a machine is paired, and a pairing can land at any
  // moment from a deep link the user scanned seconds ago.
  function announceRemote() {
    try { window.dispatchEvent(new CustomEvent("crowe:remote", { detail: { configured: remoteConfigured(), host: remoteBase() } })); }
    catch { /* no CustomEvent in some webviews; the next launch picks it up */ }
  }

  async function remoteStatus() {
    const base = remoteBase();
    if (!base) return { configured: false };
    const headers = {};
    if (config.remoteToken) headers.Authorization = `Bearer ${config.remoteToken}`;
    try {
      const res = await CapHttp.request({ url: `${base}/health`, method: "GET", headers, responseType: "text", connectTimeout: 6000, readTimeout: 6000 });
      const alive = res.status >= 200 && res.status < 300;
      return { configured: true, host: base, reachable: alive, status: res.status };
    } catch (e) {
      return { configured: true, host: base, reachable: false, error: String(e).slice(0, 140) };
    }
  }

  // ─── Crowe ID ──────────────────────────────────────────────────────────────
  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  function decodeJwt(t) {
    try {
      const part = String(t).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(decodeURIComponent(escape(atob(part))));
    } catch { return {}; }
  }
  // Every slug the catalog sells. Same list as main.js and web-bridge.js, and
  // scripts/test-plan.js compares all three: a shorter list here would tell a
  // paying account it is free.
  const PAID_TIERS = ["byok", "personal", "pro", "team", "max", "scale", "studio", "business", "enterprise"];
  function currentUser() {
    if (!config.token) return null;
    const p = decodeJwt(config.token);
    return { email: p.email || p.preferred_username || "", name: p.name || p.given_name || "",
             tier: p.crowe_tier || p.tier || "", exp: p.exp || 0 };
  }
  // Native first on a device, and deliberately WITHOUT the try-fetch-then-fall-
  // back-to-native pattern the gateway calls use. Everything redeemed here is
  // single use: an authorization code, or a refresh token Keycloak rotates.
  //
  // A form-encoded POST is a CORS "simple request", so there is no preflight to
  // stop it. Cross-origin from capacitor://localhost the request IS delivered,
  // Keycloak spends the code, and only then does the browser withhold the
  // response for want of an Access-Control-Allow-Origin header. fetch rejects,
  // the fallback replays a code that no longer exists, and Crowe ID answers
  // "Code not valid" — a sign-in that fails at the last step having already
  // succeeded at the server. The same trap the refresh lock below describes.
  //
  // So: if the native stack is there, use it and only it. fetch is for `npm run
  // serve` in a desktop browser, where there is no CapacitorHttp to call.
  async function tokenRequest(params) {
    const body = new URLSearchParams(params).toString();
    const url = `${CROWE_ID}/protocol/openid-connect/token`;
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    if (CapHttp) {
      try {
        const r = await nativePost(url, headers, body);
        if (!r) return { error: "sign-in could not reach Crowe ID" };
        try { return JSON.parse(r.text || "{}"); } catch { return { error: `HTTP ${r.status}` }; }
      } catch (e) {
        return { error: String(e).slice(0, 200) };
      }
    }
    try {
      const r = await fetch(url, { method: "POST", headers, body });
      return JSON.parse(await r.text() || "{}");
    } catch (e) {
      return { error: String(e).slice(0, 200) };
    }
  }
  let refreshing = null;
  async function refreshToken() {
    if (!config.refreshToken) return null;
    // One refresh in flight at a time. Two 401s landing together used to send
    // two refreshes, and the second one redeemed a rotated token that the first
    // had already spent — signing the user out mid-turn.
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const d = await tokenRequest({ grant_type: "refresh_token", client_id: CROWE_ID_CLIENT, refresh_token: config.refreshToken });
      if (d && d.access_token) {
        await saveConfig({ token: d.access_token, refreshToken: d.refresh_token || config.refreshToken });
        return d.access_token;
      }
      return null;
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }

  async function signIn() {
    await ready;
    const App = plugin("App"), Browser = plugin("Browser");
    if (!NATIVE || !App || !Browser) {
      return { error: "Sign-in needs the installed app. In a browser, paste a Crowe ID token in Settings." };
    }
    if (!(window.crypto && window.crypto.subtle)) return { error: "This webview has no WebCrypto, so PKCE cannot be used." };

    const verifier = b64url(window.crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = b64url(window.crypto.getRandomValues(new Uint8Array(16)));
    const redirect = config.authRedirect || DEFAULT_REDIRECT;

    return new Promise((resolve) => {
      let settled = false, handle = null, timer = null;
      const finish = async (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (handle) handle.remove(); } catch { /* listener already gone */ }
        try { await Browser.close(); } catch { /* the user may have closed it themselves */ }
        resolve(value);
      };
      // Promise.resolve, not .then() on the return value. The JS packages
      // resolve a handle from addListener, but window.Capacitor.Plugins is the
      // bridge the native side injects, and its proxy returns the handle
      // synchronously. Calling .then() on it throws a TypeError inside this
      // executor, which rejects sign-in before Browser.open is ever reached —
      // the browser simply never appears. Promise.resolve takes both shapes.
      Promise.resolve(App.addListener("appUrlOpen", async ({ url }) => {
        if (!url || url.indexOf(redirect) !== 0) return;    // some other deep link
        let params;
        try { params = new URL(url).searchParams; } catch { return finish({ error: "sign-in returned an unreadable URL" }); }
        const code = params.get("code");
        if (params.get("state") !== state) return finish({ error: "sign-in was cancelled" });
        if (!code) return finish({ error: params.get("error_description") || params.get("error") || "sign-in was cancelled" });
        const d = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirect,
                                       client_id: CROWE_ID_CLIENT, code_verifier: verifier });
        if (d && d.access_token) {
          await saveConfig({ token: d.access_token, refreshToken: d.refresh_token || "" });
          fetchCatalog();
          return finish({ ok: true, user: currentUser() });
        }
        return finish({ error: (d && (d.error_description || d.error)) || "token exchange failed" });
      })).then((h) => { handle = h; if (settled) try { h.remove(); } catch { /* raced with finish */ } });

      const authUrl = `${CROWE_ID}/protocol/openid-connect/auth?` + new URLSearchParams({
        client_id: CROWE_ID_CLIENT, response_type: "code", scope: "openid profile email offline_access",
        redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: "S256",
      }).toString();
      Browser.open({ url: authUrl, presentationStyle: "popover" }).catch((e) => finish({ error: String(e).slice(0, 160) }));
      timer = setTimeout(() => finish({ error: "sign-in timed out" }), 300000);
    });
  }

  async function licensedFetch(route, method = "GET") {
    await ready;
    if (!config.token) return { status: 401, data: null };
    const call = async () => {
      const url = `${base()}${route}`;
      const headers = { Authorization: `Bearer ${config.token}` };
      try {
        const r = await fetch(url, { method, headers });
        return { status: r.status, text: await r.text() };
      } catch (e) {
        if (!corsBlocked(e) || !CapHttp) throw e;
        const r = await CapHttp.request({ url, method, headers, responseType: "text" });
        return { status: r.status, text: typeof r.data === "string" ? r.data : JSON.stringify(r.data ?? "") };
      }
    };
    try {
      let res = await call();
      if (res.status === 401 && await refreshToken()) res = await call();
      let data = null; try { data = res.text ? JSON.parse(res.text) : null; } catch { data = null; }
      return { status: res.status, data };
    } catch { return { status: 0, data: null }; }
  }

  async function licenseStatus() {
    await ready;
    if (!currentUser()) return { authenticated: false, workspaces: [], selectedWorkspaceId: "" };
    const result = await licensedFetch("/api/workspaces");
    if (result.status >= 400 || !Array.isArray(result.data)) {
      return { authenticated: true, workspaces: [], selectedWorkspaceId: "",
               error: result.status ? `License service returned HTTP ${result.status}` : "License service could not be reached" };
    }
    const workspaces = await Promise.all(result.data.map(async (workspace) => {
      const [entitlement, usage] = await Promise.all([
        licensedFetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/entitlements/agents`),
        licensedFetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/usage`),
      ]);
      return { ...workspace, agents: entitlement.status < 400 ? entitlement.data : { allowed: false },
               usage: usage.status < 400 ? usage.data : null };
    }));
    const configured = config.licenseWorkspaceId;
    const selectedWorkspaceId = workspaces.some((w) => w.id === configured) ? configured : (workspaces[0]?.id || "");
    return { authenticated: true, workspaces, selectedWorkspaceId };
  }

  // A licensed agent is one the Agent Fleet launches against a paid workspace,
  // and main.js refuses to start one without an entitlement. The check has to
  // live on this side of the call too: leaving it out would make the phone the
  // one client that runs them unlicensed.
  async function requireAgentEntitlement(workspaceId) {
    const status = await licenseStatus();
    const id = workspaceId || status.selectedWorkspaceId;
    const workspace = status.workspaces.find((item) => item.id === id);
    return workspace?.agents?.allowed
      ? { ok: true, workspace }
      : { ok: false, error: status.authenticated ? "An active Crowe Agents entitlement is required" : "Sign in with Crowe ID to use licensed agents" };
  }

  // ─── Gateway ───────────────────────────────────────────────────────────────
  /* One place that turns OpenAI chunk frames into a finished reply. The
     streamed fetch path feeds it line by line; the native fallback feeds it a
     whole body when the gateway streamed at a transport that cannot. An
     `error` object on a frame is the gateway saying the upstream failed after
     the headers were out, and it is surfaced as an error, not as an answer. */
  function sseAccumulator(useModel, onDelta) {
    let content = "", usage = {}, gotModel = useModel, gatewayError = null;
    const toolCalls = [];
    const handle = (payload) => {
      if (payload === "[DONE]") return;
      let d; try { d = JSON.parse(payload); } catch { return; }
      if (d && d.error) { gatewayError = String(d.error.message || d.error); return; }
      const delta = (d.choices && d.choices[0] && d.choices[0].delta) || d.delta || d;
      const chunk = typeof delta.content === "string" ? delta.content : "";
      if (chunk) { content += chunk; if (onDelta) onDelta(chunk); }
      for (const t of delta.tool_calls || []) {
        const i = Number.isInteger(t.index) ? t.index : toolCalls.length;
        const cur = toolCalls[i] || (toolCalls[i] = { id: "", type: "function", function: { name: "", arguments: "" } });
        if (t.id) cur.id = t.id;
        if (t.function?.name) cur.function.name = t.function.name;
        if (t.function?.arguments) cur.function.arguments += t.function.arguments;
      }
      if (d.usage) usage = d.usage;
      if (d.model) gotModel = d.model;
    };
    return {
      handle,
      feedText(text) { for (const raw of String(text || "").split("\n")) { const line = raw.trim(); if (line.startsWith("data:")) handle(line.slice(5).trim()); } },
      get content() { return content; },
      get error() { return gatewayError; },
      result() { return { content, tool_calls: toolCalls.filter(Boolean), model: gotModel, usage }; },
    };
  }
  async function gatewayChat(messages, tools, signal, model, onDelta, _retried, epoch = consentEpoch) {
    await ready;
    if (!consented() || epoch !== consentEpoch) return consentNeeded();
    if (signal && signal.aborted) return { error: "stopped", aborted: true };
    if (!config.token) return { error: 'Not signed in. Tap "Sign in with Crowe ID" to continue.' };
    const useModel = model || defaultModel();
    if (!modelAllowed(useModel)) return { error: GROW_OFF, code: "UNAVAILABLE" };
    // Keep the same restriction at this shared boundary (chat, turns, Rooms).
    tools = tools && tools.filter(t => growToolAllowed(t && t.function && t.function.name));
    const t0 = Date.now();
    const url = `${base()}/api/gateway/chat`;
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` };
    const body = JSON.stringify({ model: useModel, messages, tools: tools || undefined, stream: onDelta ? true : undefined });
    const done = (data, streamed) => ({
      content: data.content || "", tool_calls: data.tool_calls || [], model: data.model || useModel,
      usage: data.usage || {}, elapsedMs: Date.now() - t0, streamed,
    });

    let resp;
    diag("net:fetch", { model: useModel, stream: Boolean(onDelta), bytes: body.length, images: (body.match(/"type":"image_url"/g) || []).length });
    try {
      resp = await fetch(url, { method: "POST", headers, body, signal });
    } catch (e) {
      diag("net:fetch-threw", { name: e && e.name, message: String(e && e.message || e).slice(0, 200), cors: corsBlocked(e) });
      if (e && e.name === "AbortError") return { error: "stopped", aborted: true };
      if (!corsBlocked(e)) return { error: `gateway unreachable: ${String(e).slice(0, 200)}` };
      // The native transport hands back one finished body, so it must not ask
      // the gateway to stream: since control plane 0.2.17 the gateway honours
      // stream:true, and an event stream read as JSON is an empty answer.
      const nativeBody = JSON.parse(body); delete nativeBody.stream;
      if (!consented() || epoch !== consentEpoch) return consentNeeded();
      if (signal && signal.aborted) return { error: "stopped", aborted: true };
      const r = await nativePost(url, headers, nativeBody);
      if (!consented() || epoch !== consentEpoch) return consentNeeded();
      diag("net:native", r ? { status: r.status, bytes: String(r.text || "").length } : "no native transport");
      if (!r) return { error: `gateway unreachable: ${String(e).slice(0, 200)}` };
      if (r.status === 401 && !_retried && await refreshToken()) return gatewayChat(messages, tools, signal, model, onDelta, true, epoch);
      let data;
      try { data = JSON.parse(r.text); }
      catch {
        if (/^\s*data:/m.test(String(r.text || ""))) {
          const acc = sseAccumulator(useModel, null); acc.feedText(r.text);
          if (acc.error) return { error: `HTTP ${r.status}: ${acc.error}`.slice(0, 400), content: acc.content };
          data = acc.result();
        } else data = { detail: r.text };
      }
      if (!r.ok) return { error: `HTTP ${r.status}: ${data.detail || r.text}`.slice(0, 400) };
      return done(data, 0);
    }

    diag("net:response", { status: resp.status, type: String(resp.headers.get("content-type") || "").slice(0, 40), ms: Date.now() - t0 });
    if (resp.status === 401 && !_retried && await refreshToken()) return gatewayChat(messages, tools, signal, model, onDelta, true, epoch);

    // Streaming is decided by the response, not the request — same contract as
    // main.js, so a gateway build that answers JSON to stream:true still works.
    if (resp.ok && onDelta && String(resp.headers.get("content-type") || "").includes("text/event-stream") && resp.body) {
      const acc = sseAccumulator(useModel, onDelta);
      let buf = "";
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { done: eof, value } = await reader.read();
          if (!consented() || epoch !== consentEpoch) { await reader.cancel(); return consentNeeded(); }
          if (eof) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (line.startsWith("data:")) acc.handle(line.slice(5).trim());
          }
        }
      } catch (e) {
        diag("net:stream-broke", { name: e && e.name, message: String(e && e.message || e).slice(0, 160), got: acc.content.length });
        if (e && e.name === "AbortError") return { error: "stopped", aborted: true, content: acc.content, streamed: acc.content.length };
        return { error: `stream broke: ${String(e).slice(0, 160)}`, content: acc.content, streamed: acc.content.length };
      }
      diag("net:stream-end", { chars: acc.content.length, error: acc.error || "", ms: Date.now() - t0 });
      if (acc.error) return { error: `gateway: ${acc.error}`.slice(0, 400), content: acc.content, streamed: acc.content.length };
      return { ...acc.result(), elapsedMs: Date.now() - t0, streamed: acc.content.length };
    }

    const text = await resp.text();
    if (!consented() || epoch !== consentEpoch) return consentNeeded();
    let data; try { data = JSON.parse(text); } catch { data = { detail: text }; }
    if (!resp.ok) return { error: `HTTP ${resp.status}: ${data.detail || text}`.slice(0, 400) };
    return done(data, 0);
  }

  let catalogCache = { models: [], at: 0 };
  async function fetchCatalog() {
    await ready;
    const url = `${base()}/api/gateway/catalog`;
    try {
      let text;
      try { text = await (await fetch(url)).text(); }
      catch (e) {
        if (!corsBlocked(e) || !CapHttp) throw e;
        const r = await CapHttp.request({ url, method: "GET", responseType: "text" });
        text = typeof r.data === "string" ? r.data : JSON.stringify(r.data ?? "");
      }
      const data = JSON.parse(text);
      if (data && Array.isArray(data.models)) {
        catalogCache = { models: filterCatalog(data.models), at: Date.now() };
        // Retain source metadata locally so forbidden aliases remain recognized
        // after restart, while all public catalog views use the filtered cache.
        store.set("catalog", { models: data.models, at: catalogCache.at });
      }
    } catch { /* keep the last good catalog; routing falls back to the default model */ }
  }

  // ─── Routing ───────────────────────────────────────────────────────────────
  // General expert routing mirrors desktop roles except cultivation. Ordinary
  // questions about any topic still go to the general assistant.
  const ROLE_MATCH = [
    { role: "coding", match: /\b(refactor\w*|implement|debug\w*|stack ?trace|compile|pytest|unit test|API endpoint|migration|typescript|rust|golang)\b/i },
    { role: "reasoning", match: /\b(architect\w*|redesign|prove|reason through|algorithm\w*|optimi[sz]e|trade-?off|concurren\w*|race condition|root cause|complexity)\b/i },
    { role: "long-context", match: /\b(summari[sz]e (?:this|the (?:whole|entire))|entire (?:repo|codebase|document|file)|long document|across all files)\b/i },
  ];
  const ROUTED_ROLES = ["coding", "reasoning", "long-context"];
  const BRIDGE_ROLE_MODEL = { reasoning: "GPT-5.6-Sol" };
  const classifyRole = (text) => (ROLE_MATCH.find((r) => r.match.test(text)) || { role: "default" }).role;
  function catalogModelForRole(role) {
    const m = catalogCache.models.find((x) => x && x.featured && x.available !== false
      && x.gateway_tool_calling !== false && x.role === role);
    return m ? m.model : null;
  }
  // ─── Plan gate ─────────────────────────────────────────────────────────────
  // Same mirror as harness.js: the gateway admits a model when the account's
  // plan ranks at or above the catalog's `min_plan`, and a token with no tier
  // claim is the free plan. Route a free account to the free model up front;
  // keep the 403 handler for the day the mirror is stale.
  const PLAN_RANK = { "free-anonymous": -1, free: -1, byok: 0, personal: 1, pro: 2, team: 3, max: 4, scale: 5, studio: 6, business: 7, enterprise: 8 };
  const PLAN_ALIASES = { developer: "personal", lab: "team" };
  const TIER_PLAN = { free: "free", pro: "pro", studio: "team", enterprise: "enterprise", byok: "byok", personal: "personal", team: "team", max: "max", admin: "enterprise" };
  const FREE_MODEL = "crowelm-flash";
  // Photos go here, whatever the words routed to. Same id the catalog serves.
  const VISION_MODEL = "crowelm-vision";
  const PHOTO_DEFAULT_ASK = "Describe this image and help me understand what is visible.";
  const VISION_BRIEF = [
    "An image is attached to the user's message. Help with the user's task using what is actually visible.",
    "Describe relevant details, read visible text when useful, and distinguish observation from inference.",
    "Do not assume the image belongs to a particular subject or workflow. State uncertainty and image limitations.",
    "If the task is unclear, give a brief useful description and ask what the user wants to know.",
    "Begin with exactly one line of the form REGIONS: [{\"label\": \"...\", \"x\": 0.1, \"y\": 0.2, \"w\": 0.3, \"h\": 0.2}] naming up to",
    "four areas of the photo you examined, x y w h as fractions of the image width and height from the top left, then a",
    "blank line, then the answer. The line drives the phone's display of what you looked at; never refer to it in the answer.",
  ].join("\n");
  /* The REGIONS line is display data, not prose. It is lifted out of the
     stream before the transcript sees a character of it and handed to the UI
     as its own event, so the phone can draw what the model examined while the
     rest of the answer is still arriving. */
  const REGIONS_RE = /^\s*REGIONS:\s*(\[[\s\S]*?\])[ \t]*\r?\n?/;
  const REASONING_RE = /^\s*(?:NOTES|REASONING):\s*([^\n]*)\r?\n?/;
  const clamp01 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; };
  function parseRegions(json) {
    try {
      const a = JSON.parse(json);
      if (!Array.isArray(a)) return null;
      const out = a.filter((r) => r && typeof r.label === "string").slice(0, 6)
        .map((r) => ({ label: r.label.trim().slice(0, 60), x: clamp01(r.x), y: clamp01(r.y), w: clamp01(r.w), h: clamp01(r.h) }))
        .filter((r) => r.label && r.w > 0 && r.h > 0);
      return out.length ? out : null;
    } catch { return null; }
  }
  function stripRegions(text) {
    const m = REGIONS_RE.exec(text || "");
    if (!m) return { text: text || "", regions: null, reasoning: null, had: false };
    let rest = (text || "").slice(m[0].length).replace(/^[ \t]*\r?\n/, "");
    let reasoning = null;
    const r = REASONING_RE.exec(rest);
    if (r) { reasoning = r[1].trim().slice(0, 900) || null; rest = rest.slice(r[0].length).replace(/^[ \t]*\r?\n/, ""); }
    return { text: rest, regions: parseRegions(m[1]), reasoning, had: true };
  }
  function regionsFilter(onRegions, onDelta, onReasoning) {
    let buf = "", decided = false, swallow = false;
    const decide = () => {
      decided = true;
      const sr = stripRegions(buf);
      if (sr.regions) onRegions(sr.regions);
      if (sr.reasoning && onReasoning) onReasoning(sr.reasoning);
      let rest = sr.had ? sr.text : buf;
      buf = "";
      // The blank line after the map may land in a later chunk; drop leading
      // whitespace until the prose starts, and only when a map was taken out.
      if (sr.had) { rest = rest.replace(/^\s+/, ""); swallow = rest === ""; }
      if (rest) onDelta(rest);
    };
    return {
      delta(chunk) {
        if (decided) {
          if (swallow) { chunk = chunk.replace(/^\s+/, ""); if (!chunk) return; swallow = false; }
          onDelta(chunk); return;
        }
        buf += chunk;
        const head = buf.replace(/^\s+/, "");
        // Hold only while the text could still be the REGIONS line: an
        // unfinished prefix of the keyword, or the line itself before its newline.
        const couldBe = head === "" || "REGIONS:".startsWith(head.slice(0, 8)) || /^REGIONS:/.test(head);
        if (!couldBe || buf.length > 2000) { decide(); return; }
        if (/^REGIONS:/.test(head) && /\n/.test(head)) {
          // Past the map. If a REASONING line follows (owner accounts), wait for
          // its newline too; otherwise the answer has started and we decide now.
          const after = head.replace(REGIONS_RE, "").replace(/^\s+/, "");
          if (after === "" || "NOTES:".startsWith(after.slice(0, 6)) || "REASONING:".startsWith(after.slice(0, 10))) { if (buf.length > 2000) decide(); return; }
          if (/^(?:NOTES|REASONING):/.test(after) && !/\n/.test(after)) return;
          decide();
        }
      },
      flush() { if (!decided) decide(); },
    };
  }
  /* The owner account sees the model's stated reasoning under a vision scan;
     nobody else is asked for it, so nobody else can receive it. */
  const OWNER_EMAILS = new Set(["michael@crowelogic.com", "mike@southwestmushrooms.com"]);
  const isOwner = () => { const u = currentUser(); return Boolean(u && OWNER_EMAILS.has(String(u.email || "").trim().toLowerCase())); };
  /* Wire word: NOTES, not REASONING. Asked for a "REASONING:" line, CroweLM
     Vision returns an empty completion (0 tokens, finish stop; measured
     2026-09-10 against the live model with the same photo); asked for NOTES in
     the same shape it answers in full. The UI still calls the fold Reasoning. */
  const VISION_REASONING_BRIEF = [
    "After the REGIONS line and before the answer, add exactly one line NOTES: followed by two or three sentences an inspector",
    "would write in the margin: what in the photo carried the most weight, what was ruled out and why, and where the photo alone",
    "leaves doubt. Then a blank line, then the answer.",
  ].join("\n");
  const PLAN_GATE_RE = /HTTP 403: Model '([^']+)' requires (\S+) plan or higher/i;
  function planRank(plan) {
    const key = String(plan || "").trim().toLowerCase();
    const canonical = PLAN_ALIASES[key] || key;
    return canonical in PLAN_RANK ? PLAN_RANK[canonical] : -1;
  }
  function sessionPlan() {
    const u = currentUser();
    if (!u) return null;
    return TIER_PLAN[String(u.tier || "").trim().toLowerCase()] || "free";
  }
  function freeModel() {
    const m = (catalogCache.models || []).find((x) => x && x.model && planRank(x.min_plan) < 0);
    return m ? m.model : FREE_MODEL;
  }
  function minPlanFor(model) {
    const m = (catalogCache.models || []).find((x) => x && x.model === model);
    return m && m.min_plan ? m.min_plan : null;
  }
  function planBlocks(model) {
    const plan = sessionPlan();
    if (plan === null) return false;
    const floor = minPlanFor(model);
    return Boolean(floor) && planRank(plan) < planRank(floor);
  }
  function planGateOf(err) {
    const m = PLAN_GATE_RE.exec(String(err || ""));
    return m ? { model: m[1], required: m[2] } : null;
  }
  function planNotice(free, required) {
    return `This Crowe ID has no plan that includes the routed model, so ${free} is answering. The full CroweLM tiers need a ${required || "personal"} plan or higher.`;
  }
  function routeTurn(messages, pin) {
    const dflt = defaultModel();
    const last = [...(messages || [])].reverse().find((m) => m && m.role === "user");
    const role = pin && pin !== "default"
      ? (ROUTED_ROLES.includes(pin) ? pin : "default")
      : classifyRole(String((last && last.content) || ""));
    let route;
    if (role === "default") route = { expert: "operator", model: dflt, reason: "default operator" };
    else {
      const dynamic = catalogModelForRole(role);
      const model = dynamic || BRIDGE_ROLE_MODEL[role] || dflt;
      const src = dynamic ? "catalog" : (BRIDGE_ROLE_MODEL[role] ? "bridge" : "default");
      route = { expert: role, model, reason: `${role} · ${src}${pin ? " · pinned" : ""}` };
    }
    if (planBlocks(route.model)) {
      const free = freeModel();
      route.planLimited = { model: route.model, required: minPlanFor(route.model) };
      route.reason = `${route.reason} · ${route.model} needs a ${route.planLimited.required} plan, using ${free}`;
      route.model = free;
    }
    return route;
  }
  function resolveRoles() {
    const dflt = defaultModel();
    const out = {};
    for (const role of ROUTED_ROLES) {
      const dynamic = catalogModelForRole(role);
      const bridge = BRIDGE_ROLE_MODEL[role];
      out[role] = dynamic ? { model: dynamic, source: "catalog" }
        : bridge ? { model: bridge, source: "bridge" }
        : { model: dflt, source: "default" };
    }
    return out;
  }

  // ─── Tools ─────────────────────────────────────────────────────────────────
  /* The desktop offers ten tools, eight of which are a workspace: shell, read,
     edit, write, search, list. Handing those to the model here and answering
     every call with "not available" would burn a round per attempt and teach it
     nothing. So the phone advertises only what it can actually do, and the
     system prompt says so in the first line. */
  const OPEN_URL = {
    type: "function",
    function: {
      name: "open_url",
      description: "Open a web page for the user, in the phone's in-app browser.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  };

  /* The machine tools. Same three the desktop has, except the process runs on
     the desktop instead of here, which is the only honest way a phone gets a
     shell. They appear only when a machine is paired: an unpaired phone is not
     offered a shell it cannot reach, so the model cannot promise one. */
  const REMOTE_RUN = {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command on the paired desktop machine and return its exit code, stdout and stderr. This is a real shell on a real machine, so prefer reading over writing, and say what you are about to run.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run, e.g. 'git -C ~/Projects/foo status'." },
          cwd: { type: "string", description: "Working directory. Defaults to the machine's home directory." },
          timeout: { type: "integer", description: "Seconds to wait before the machine kills it. Default 60." },
        },
        required: ["command"],
      },
    },
  };
  const REMOTE_READ = {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the paired desktop machine, or a file the user attached from this phone (path phone:<name>).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or ~-relative path on that machine, or phone:<name> for an attached file." },
          max_bytes: { type: "integer", description: "Cap on bytes returned. Default 100000." },
        },
        required: ["path"],
      },
    },
  };
  const REMOTE_WRITE = {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a text file, replacing it entirely: on the paired desktop machine, or the app's copy of a phone attachment (path phone:<name>). Read it first unless you are creating it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or ~-relative path on that machine, or phone:<name> for an attached file." },
          content: { type: "string", description: "The full contents to write." },
        },
        required: ["path", "content"],
      },
    },
  };

  // The tier the user picked in the composer decides whether the model may
  // write attached files or files on the paired machine.
  const mayWrite = () => config.autonomy === "edit" || config.autonomy === "execute";
  function toolsForTurn() {
    const tools = [OPEN_URL];
    /* The tier ladder means the same thing here as it does on the desktop, and
       it is the whole safety story for a shell you are carrying in a pocket:
         plan:     nothing on the machine, not even a read
         readonly: read files
         edit:     read and write files
         execute:  and run commands
       Running a command is last on purpose. `write_file` can ruin a file;
       `run_command` can ruin a machine, and neither this app nor the server
       can tell a build from an `rm -rf` by reading the string. */
    /* The file tools are offered when there is anywhere for them to land: a
       paired machine, or files the user attached from this phone. An unpaired
       phone holding an attachment still gets read_file — withholding it would
       recreate the bug the system prompt already documents, a model refusing
       work its own tool list could do. run_command stays pairing-only: there
       is no phone: anything for a shell. */
    if (remoteConfigured() || phoneFiles.size) {
      if (config.autonomy !== "plan") tools.push(REMOTE_READ);
      if (mayWrite()) tools.push(REMOTE_WRITE);
      if (remoteConfigured() && config.autonomy === "execute") tools.push(REMOTE_RUN);
    }
    return tools;
  }

  /* Connector tools come from the gateway, for the services this Crowe ID has
     connected (Google Calendar and Drive first). connectors.js owns the fetch
     and the dispatch; the bridge only widens the tool list it hands the model
     and routes those calls back through the gateway, which holds the grant. */
  async function turnTools() {
    const tools = toolsForTurn();
    const cx = typeof window !== "undefined" && window.croweConnectors;
    if (!cx) return tools;
    try { return tools.concat(await cx.tools()).filter(t => growToolAllowed(t && t.function && t.function.name)); } catch { return tools; }
  }

  async function execTool(name, args) {
    // Deny before even asking a connector whether it owns the name. An
    // unsolicited tool call or connector collision cannot restore grow access.
    if (!growToolAllowed(name)) return { text: GROW_OFF, status: "blocked" };
    const cx = typeof window !== "undefined" && window.croweConnectors;
    if (cx && cx.owns(name)) return { text: await cx.act(name, args), status: "ok" };
    if (name === "open_url") {
      const url = String(args.url || "");
      if (!/^https?:\/\//i.test(url)) return { text: "refused: only http(s) URLs can be opened", status: "error" };
      /* Asked for, every time, showing the host.

         This used to open silently, which was defensible when the only thing
         this app could read was the grower's own log. It stopped being
         defensible the moment the phone could read files off a paired machine:
         read_file plus a silent open_url is an exfiltration channel. At the
         Read tier — which tells the user it "writes nothing" — the agent could
         read a secrets file and then open https://somewhere/?d=<contents>, and
         the only trace would be a browser sheet appearing for a moment.

         It does not take a hostile user. A file the agent reads can carry the
         instruction, and a model that has just read it is the one deciding.
         The confirmation is the whole mitigation: the destination cannot be
         reached without a person seeing where it goes. */
      let host = url;
      try { host = new URL(url).host; } catch { /* shown in full below instead */ }
      const ok = window.confirm(`Open ${host}?\n\n${url.slice(0, 300)}\n\nThe agent asked for this. Check the address if you did not expect it.`);
      if (!ok) return { text: `refused: the user declined to open ${host}`, status: "error" };
      const Browser = plugin("Browser");
      if (Browser) await Browser.open({ url }).catch(() => {});
      else window.open(url, "_blank", "noopener");
      return { text: `opened ${url}`, status: "ok" };
    }

    /* The machine tools. Each re-checks the tier rather than trusting that it
       was never offered: the model is handed a tool list per turn, but a turn
       can span a tier change, and a transcript can be replayed. The list is
       what the model sees; this is what actually decides. */
    if (name === "run_command" || name === "read_file" || name === "write_file") {
      /* `phone:` paths are the files the user handed this phone through the
         picker — answered locally, before the pairing gate, because pairing is
         about reaching another machine and these never left this one. The tier
         still decides: a grant to hold a file is not a grant to rewrite it. */
      const pf = String(args.path || "").match(/^phone:(.+)$/);
      if (pf && name !== "run_command") {
        const key = pf[1];
        const tierOk = name === "read_file" ? config.autonomy !== "plan" : mayWrite();
        if (!tierOk) return { text: `refused: ${name} needs a higher tier than ${config.autonomy}`, status: "error" };
        if (name === "read_file") {
          const f = phoneFiles.get(key);
          if (!f) return { text: `refused: no attached file named ${key}. The user attaches phone files with the paperclip in the composer`, status: "error" };
          return { text: `phone:${key}:\n${clip(f.content, TOOL_RESULT_MAX - 200)}`, status: "ok" };
        }
        const content = String(args.content ?? "");
        if (content.length > PHONE_FILE_MAX) return { text: `refused: over the ${Math.round(PHONE_FILE_MAX / 1024)} KB cap for phone files`, status: "error" };
        phoneFiles.set(key, { content, at: Date.now() });
        phoneNotify();
        return { text: `updated phone:${key} (${content.length} bytes). The user can send it anywhere from the paperclip row. Tapping the file opens the share sheet.`, status: "ok" };
      }
      if (!remoteConfigured()) {
        if (phoneFiles.size) return { text: `refused: no machine is paired with this phone (Settings → Remote machine). The files the user attached are readable as ${[...phoneFiles.keys()].map((n) => `phone:${n}`).join(", ")}`, status: "error" };
        return { text: "refused: no machine is paired with this phone (Settings → Remote machine)", status: "error" };
      }
      const allowed = name === "read_file" ? config.autonomy !== "plan"
        : name === "write_file" ? mayWrite()
        : config.autonomy === "execute";
      if (!allowed) {
        return { text: `refused: ${name} needs a higher tier than ${config.autonomy}`, status: "error" };
      }
      if (name === "run_command") {
        const command = String(args.command || "").trim();
        if (!command) return { text: "refused: no command given", status: "error" };
        const why = persistenceRisk(command);
        if (why && !window.confirm(`This ${why}.\n\n${command.slice(0, 300)}\n\nRun it on ${remoteBase()}?`)) {
          return { text: `refused: the user declined a command that ${why}`, status: "error" };
        }
        const timeout = Math.max(1, Math.min(600, Number(args.timeout) || 60));
        const r = await remoteCall("/run", { command, cwd: args.cwd || undefined, timeout }, "the command");
        if (r.error) return { text: `refused: ${r.error}`, status: "error" };
        const d = r.data || {};
        // Both streams, and the exit code, always. A model shown only stdout
        // reads a failed command as an empty success and carries on.
        const parts = [`exit ${d.exit_code}`];
        if (d.stdout) parts.push(`stdout:\n${clip(d.stdout, REMOTE_OUT_MAX)}`);
        if (d.stderr) parts.push(`stderr:\n${clip(d.stderr, REMOTE_ERR_MAX)}`);
        if (!d.stdout && !d.stderr) parts.push("(no output)");
        return { text: parts.join("\n"), status: d.exit_code === 0 ? "ok" : "error" };
      }
      if (name === "read_file") {
        const path = String(args.path || "");
        if (!path) return { text: "refused: no path given", status: "error" };
        const max = Math.max(1, Math.min(200000, Number(args.max_bytes) || 100000));
        const r = await remoteCall("/read_file", { path, max_bytes: max }, "the read");
        if (r.error) return { text: `refused: ${r.error}`, status: "error" };
        const d = r.data || {};
        return { text: `${d.path}${d.truncated ? " (truncated)" : ""}:\n${clip(d.content || "", TOOL_RESULT_MAX - 200)}`, status: "ok" };
      }
      const path = String(args.path || "");
      if (!path) return { text: "refused: no path given", status: "error" };
      const risk = persistenceRisk(path);
      if (risk && !window.confirm(`Writing this file ${risk}.\n\n${path}\n\nWrite it on ${remoteBase()}?`)) {
        return { text: `refused: the user declined a write that ${risk}`, status: "error" };
      }
      const r = await remoteCall("/write_file", { path, content: String(args.content ?? "") }, "the write");
      if (r.error) return { text: `refused: ${r.error}`, status: "error" };
      const d = r.data || {};
      return { text: `wrote ${d.bytes_written} bytes to ${d.path}`, status: "ok" };
    }
    return { text: `unknown tool ${name}`, status: "error" };
  }

  function systemPrompt(route) {
    const user = currentUser();
    /* What the model is told about its own reach has to track what
       toolsForTurn() actually handed it. This paragraph used to say flatly that
       there was no shell and none was coming, which was true until the phone
       could drive a machine — and then it was the reason a paired app still
       answered "I cannot run anything on your computer" while holding a working
       run_command. A prompt that contradicts the tool list wins, every time. */
    const machine = remoteConfigured() ? [
      `This phone is paired with a machine at ${remoteBase()}, reached privately over Tailscale. It is the`,
      "user's own desktop, and it is a real one: the same files and the same shell they would sit down to.",
      config.autonomy === "plan"
        ? "The tier is Plan, so you may not touch that machine at all this turn. Say so if asked, and plan instead."
        : [
          "You reach it with these tools, and the tier decides which you were given:",
          "  read_file:  read a file there (Read tier and above)",
          config.autonomy === "readonly" ? "" : "  write_file: replace a file there (Edit and above)",
          config.autonomy === "execute" ? "  run_command: run a shell command there" : "  run_command is NOT available at this tier; say the user can switch to Execute",
        ].filter(Boolean).join("\n"),
      "Never claim you cannot reach the user's computer while you hold these tools. Prefer reading before",
      "writing, say what you are about to run before you run it, and quote the exit code when it is not 0.",
    ].join("\n") : [
      "No machine is paired with this phone, and a phone cannot run a shell of its own. You genuinely cannot",
      "run commands or touch files on a computer right now, say so plainly, and add that pairing a machine in",
      "Settings under Remote machine gives you all three against their desktop.",
    ].join("\n");
    /* Same contract as `machine` above: this paragraph must track what the
       tools will actually answer. Files the user picked exist at phone: paths
       whether or not a machine is paired — an unpaired phone holding an
       attachment must not claim it cannot read files. */
    const attached = phoneFiles.size
      ? [
        "",
        `The user attached ${phoneFiles.size === 1 ? "a file" : phoneFiles.size + " files"} from this phone: ${[...phoneFiles.keys()].map((n) => `phone:${n}`).join(", ")}.`,
        "Read them with read_file on the phone: path (any tier above Plan). write_file to a phone: path updates",
        "the app's copy (Edit tier and above). The phone cannot overwrite the original where it lives, so tell",
        "the user the updated copy is in the paperclip row, and tapping it opens the share sheet to send or save it.",
      ].join("\n")
      : "";
    return [
      "You are Crowe Logic, running on the user's phone.",
      machine,
      attached,
      route.vision ? "\n" + VISION_BRIEF + (isOwner() ? "\n" + VISION_REASONING_BRIEF : "") : "",
      "",
      "You have open_url, which asks the user before opening a link. Use only the tools actually offered.",
      "Do not claim access to local records or workflows that are not provided by those tools.",
      "",
      "Write for a small screen held in one hand: short paragraphs, the answer first,",
      "no long tables, no ASCII diagrams. Give the number or the action before the reasoning.",
      route.expert && route.expert !== "operator" ? `You are answering as the ${route.expert} expert.` : "",
      user && user.email ? `The signed-in user is ${user.email}.` : "",
      `Today is ${new Date().toISOString().slice(0, 10)}.`,
    ].filter(Boolean).join("\n");
  }

  // Keep the conversation inside a phone's patience and the model's window:
  // drop the oldest tool traffic first, since a summary of what a tool said
  // survives in the assistant turn that followed it.
  function compact(messages) {
    let total = messages.reduce((n, m) => n + String(m.content || "").length, 0);
    if (total <= CONTEXT_BUDGET_CHARS) return messages.slice();
    const out = messages.slice();
    for (let i = 0; i < out.length - 6 && total > CONTEXT_BUDGET_CHARS; i++) {
      if (out[i] && out[i].role === "tool") {
        total -= String(out[i].content || "").length;
        out[i] = { ...out[i], content: "[earlier tool result elided to fit the context window]" };
      }
    }
    return out;
  }

  // ─── The agent loop ────────────────────────────────────────────────────────
  const listeners = new Set();
  const emit = (ev) => { for (const fn of listeners) { try { fn(ev); } catch (e) { diag("ui:listener-threw", String(e && e.message || e)); } } };

  /* Diagnostics. A ring of the last sixty things the bridge did: run start,
     route, the request it sent, what came back, and how it ended. Written to
     Preferences so it survives a relaunch, read by Settings, copied by hand.
     It exists because a phone cannot be attached to a debugger from a text
     message, and "nothing happened" needs a where. Never throws. */
  const DIAG_MAX = 60;
  let diagBuf = null;
  async function diag(kind, detail) {
    try {
      if (!diagBuf) diagBuf = (await store.get("diag")) || [];
      const d = detail == null ? "" : typeof detail === "string" ? detail : JSON.stringify(detail);
      diagBuf.push({ t: Date.now(), k: String(kind).slice(0, 40), d: String(d).slice(0, 400) });
      if (diagBuf.length > DIAG_MAX) diagBuf = diagBuf.slice(-DIAG_MAX);
      await store.set("diag", diagBuf);
    } catch { /* diagnostics never get in the way */ }
  }
  const runs = new Map();
  let runSequence = 0;

  async function runAgent(messages, id, opts, epoch) {
    await ready;
    if (!consented() || epoch !== consentEpoch) { const c = consentNeeded(); return { done: false, error: c.error, text: c.error }; }
    const previous = runs.get(id);
    if (previous) { previous.aborted = true; previous.controller?.abort(); }
    const run = { aborted: false, controller: null, epoch: consentEpoch, runId: ++runSequence };
    runs.set(id, run);
    const send = (ev) => {
      if (ev && (ev.type === "route" || ev.type === "error" || ev.type === "final" || ev.type === "plan" || ev.type === "photos" || ev.type === "vision_regions"))
        diag("run:" + ev.type, ev.type === "photos" ? { count: (ev.names || []).length } : ev.type === "vision_regions" ? { regions: (ev.regions || []).length } : { text: String(ev.text || ev.note || ev.model || "").slice(0, 200), expert: ev.expert, model: ev.model });
      emit({ ...ev, agentId: id, runId: run.runId });
    };
    diag("run:start", { id, messages: Array.isArray(messages) ? messages.length : 0, role: String(opts && opts.role || ""), user: (currentUser() || {}).email || "signed out" });
    const meter = { in: 0, out: 0, ms: 0, cost: 0 };
    const budget = Number(config.turnBudgetUsd) > 0 ? Number(config.turnBudgetUsd) : 0;
    let text = "";

    try {
      const route = routeTurn(messages, String(opts.role || ""));
      /* A photo changes the turn: it rides inside the user message as an image
         part and the turn goes to CroweLM Vision, whatever the words would have
         routed to. Decided here, before the route is announced, so the rail
         shows where the photo actually went. A free account hears the truth up
         front instead of being handed to a text model that cannot see. */
      let msgs = messages;
      const photos = [...phoneImages.entries()];
      if (photos.length) {
        phoneImages.clear(); phoneNotify();
        if (planBlocks(VISION_MODEL)) {
          const need = minPlanFor(VISION_MODEL) || "personal";
          const err = `Crowe Vision reads photos on the ${need} plan and higher. This Crowe ID is on the ${sessionPlan() || "free"} plan, so the photo was not sent. Sign in with an account that has a plan.`;
          send({ type: "error", text: err }); send({ type: "final", note: "vision needs a plan" });
          return { done: false, error: err, text };
        }
        msgs = messages.slice();
        const i = msgs.map((m) => m && m.role).lastIndexOf("user");
        const ask = String((i >= 0 && msgs[i].content) || "").trim() || PHOTO_DEFAULT_ASK;
        const parts = [{ type: "text", text: ask }, ...photos.map(([, p]) => ({ type: "image_url", image_url: { url: p.dataUrl } }))];
        if (i >= 0) msgs[i] = { ...msgs[i], content: parts }; else msgs.push({ role: "user", content: parts });
        Object.assign(route, { expert: "vision", model: VISION_MODEL, vision: true,
          reason: `vision · ${photos.length === 1 ? "a photo" : photos.length + " photos"} attached` });
        delete route.planLimited;
        send({ type: "photos", names: photos.map(([n]) => n), thumbs: photos.map(([, p]) => p.dataUrl) });
      }
      if (route.planLimited) {
        send({ type: "plan", model: route.model, blocked: route.planLimited.model, required: route.planLimited.required,
               text: planNotice(route.model, route.planLimited.required) });
      }
      send({ type: "route", expert: route.expert, model: route.model, reason: route.reason });
      let planGated = false, emptyRetried = false;

      const convo = [{ role: "system", content: systemPrompt(route) }];
      // The session's standing brief: who is speaking for this thread, ahead of
      // what the world looks like, as the desktop harness orders persona and
      // context.
      if (opts.brief) convo.push({ role: "system", content: String(opts.brief).slice(0, 4000) });
      if (opts.context) convo.push({ role: "system", content: `Situation on this device:\n${String(opts.context).slice(0, 8000)}` });
      convo.push(...compact(msgs));

      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (run.aborted || run.epoch !== consentEpoch || !consented()) { send({ type: "stopped" }); send({ type: "final", note: "stopped" }); return { done: false, text }; }
        if (budget && meter.cost >= budget) {
          send({ type: "budget", spent: meter.cost, ceiling: budget, stage: "answer", stopped: true });
          send({ type: "final", note: "turn budget reached" });
          return { done: true, text };
        }

        run.controller = new AbortController();
        const emitDelta = (chunk) => send({ type: "assistant_delta", text: chunk });
        const filt = route.vision ? regionsFilter((regions) => send({ type: "vision_regions", regions }), emitDelta,
          (reasoning) => { if (isOwner()) send({ type: "vision_reasoning", text: reasoning }); }) : null;
        const r = await gatewayChat(convo, await turnTools(), run.controller.signal, route.model, filt ? filt.delta : emitDelta, false, run.epoch);
        if (filt) {
          filt.flush();
          if (typeof r.content === "string") {
            const sr = stripRegions(r.content);
            if (sr.regions && !r.streamed) send({ type: "vision_regions", regions: sr.regions });
            if (sr.reasoning && !r.streamed && isOwner()) send({ type: "vision_reasoning", text: sr.reasoning });
            r.content = sr.text;
          }
        }

        if (r.usage || r.elapsedMs) {
          meter.in += r.usage?.prompt_tokens || 0;
          meter.out += r.usage?.completion_tokens || 0;
          meter.ms += r.elapsedMs || 0;
          meter.cost = meter.in * RATE_IN + meter.out * RATE_OUT;
          send({ type: "telemetry", promptTokens: meter.in, completionTokens: meter.out, elapsedMs: meter.ms,
                 tps: r.elapsedMs ? Math.round(((r.usage?.completion_tokens || 0) / r.elapsedMs) * 1000) : 0,
                 lastMs: r.elapsedMs || 0, cost: meter.cost, budget });
        }
        if (r.aborted || run.aborted) { send({ type: "stopped" }); send({ type: "final", note: "stopped" }); return { done: false, text }; }
        if (r.error) {
          // Plan gate: refused for this account's plan. Once, to the free
          // model; a second refusal there is the account's answer.
          const gate = planGateOf(r.error);
          if (gate && !planGated && route.model !== freeModel() && !route.vision) {
            planGated = true; route.model = freeModel();
            send({ type: "plan", model: route.model, blocked: gate.model, required: gate.required, text: planNotice(route.model, gate.required) });
            send({ type: "route", expert: route.expert, model: route.model, reason: `${gate.model} needs a ${gate.required} plan, using ${route.model}` });
            round -= 1; continue;
          }
          const err = gate
            ? `This Crowe ID has no plan that includes ${gate.model} (${gate.required} plan or higher). Sign in with an account that has a plan, or add one to this account.`
            : r.error;
          send({ type: "error", text: err }); send({ type: "final", note: "the gateway call failed" }); return { done: false, error: err, text };
        }

        if (r.content) {
          send({ type: "assistant", text: r.content, streamed: Boolean(r.streamed) });
          text += (text ? "\n\n" : "") + r.content;
        }
        const calls = r.tool_calls || [];
        if (!calls.length) {
          /* A vision round that returns neither words nor a tool call is an
             answer of nothing about a photo the grower is standing in front
             of (measured live: 0 completion tokens, finish stop). Ask once
             more; if it is still nothing, say so instead of letting the
             transcript fill the silence with a generic line. */
          if (route.vision && !(text || "").trim()) {
            if (!emptyRetried) { emptyRetried = true; diag("run:empty-vision-retry", { round }); continue; }
            const msg = "CroweLM Vision returned nothing for this photo, twice. Try again in a moment, or a closer photo of the block face in even light.";
            diag("run:empty-vision", { round });
            send({ type: "error", text: msg }); send({ type: "final", note: "empty completion" });
            return { done: false, error: msg, text };
          }
          send({ type: "final", note: "answered", success: Boolean((r.content || "").trim()), finding: (r.content || "").trim() }); return { done: true, text };
        }

        convo.push({ role: "assistant", content: r.content || "", tool_calls: calls });
        for (const call of calls) {
          if (run.aborted) break;
          const name = call.function?.name || "";
          let args = {};
          try { args = JSON.parse(call.function?.arguments || "{}"); } catch { args = {}; }
          send({ type: "tool_call", name, args });
          const out = await execTool(name, args);
          send({ type: "tool_result", name, result: String(out.text).slice(0, TOOL_RESULT_MAX), status: out.status });
          convo.push({ role: "tool", tool_call_id: call.id || name, name, content: String(out.text).slice(0, TOOL_RESULT_MAX) });
        }
      }
      send({ type: "final", note: `stopped after ${MAX_ROUNDS} rounds` });
      return { done: true, text };
    } finally {
      if (runs.get(id) === run) runs.delete(id);
    }
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────
  let currentSession = null;
  const newSessionId = () => "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  async function sessionIndex() { return (await store.get("sessions")) || []; }
  async function persistSession(messages) {
    if (!messages || !messages.length) return;
    if (!currentSession) currentSession = newSessionId();
    const firstUser = messages.find((m) => m.role === "user");
    const title = String(firstUser?.content || "Untitled").replace(/\s+/g, " ").slice(0, 60);
    const updatedAt = Date.now();
    // Read-merge-write: the name and brief were set outside the run and must
    // outlive it. A write of {id, title, messages} alone would drop them.
    const prior = (await store.get(`session:${currentSession}`)) || {};
    const name = prior.name || "";
    const brief = prior.brief || "";
    await store.set(`session:${currentSession}`, { id: currentSession, title, updatedAt, messages, name, brief });
    const index = (await sessionIndex()).filter((s) => s.id !== currentSession);
    index.unshift({ id: currentSession, title, name, updatedAt });
    // 200 threads is more history than a phone has any use for, and Preferences
    // is not a database — trimming here keeps the list read cheap.
    const keep = index.slice(0, 200);
    for (const dropped of index.slice(200)) await store.remove(`session:${dropped.id}`);
    await store.set("sessions", keep);
  }

  // ─── Provider keys ─────────────────────────────────────────────────────────
  /* The desktop encrypts these with the OS keychain through safeStorage. There
     is no safeStorage in a webview, so they live in Preferences — which is
     UserDefaults on iOS and SharedPreferences on Android: private to the app
     and included in device backups, but not hardware-encrypted. The Key
     Manager says so on screen rather than implying a vault that is not here. */
  const KEY_PROVIDERS = {
    openai: { label: "OpenAI", url: "https://api.openai.com/v1/models", header: "Bearer" },
    anthropic: { label: "Anthropic", url: "https://api.anthropic.com/v1/models", header: "x-api-key" },
    openrouter: { label: "OpenRouter", url: "https://openrouter.ai/api/v1/models", header: "Bearer" },
    groq: { label: "Groq", url: "https://api.groq.com/openai/v1/models", header: "Bearer" },
  };
  const keyStatus = () => Object.entries(KEY_PROVIDERS).map(([id, spec]) => {
    const entry = (config.keys || {})[id] || {};
    return { id, label: spec.label, configured: Boolean(entry.value), updatedAt: entry.updatedAt || 0,
             testedAt: entry.testedAt || 0, healthy: entry.healthy === true, storage: "device" };
  });

  // ─── Refused capabilities ──────────────────────────────────────────────────
  // One sentence each, naming the platform rather than the symptom, so the pane
  // that renders it can be read as an explanation instead of a bug.
  /* These are answers, not apologies, and they have to stay true as the app
     gains reach. iOS still will not let this process fork a shell — that part
     is permanent. What changed is that the phone can now drive a machine that
     will, so the unpaired copy names the way out instead of ending the
     conversation at "use the desktop". */
  const NO_WORKSPACE = () => (remoteConfigured()
    ? `No workspace runs on the phone itself. Ask the agent instead. It reaches ${remoteBase()} and can read, write and run there.`
    : "There is no workspace on the phone. Pair a machine in Settings → Remote machine and the agent can work on it from here.");
  const NO_SHELL = () => (remoteConfigured()
    ? `iOS will not let an app run its own shell. This phone drives ${remoteBase()} instead. Set the tier to Execute and ask the agent to run the command.`
    : "iOS will not let an app run its own shell. Pair a machine in Settings → Remote machine to run commands on it from here.");
  // Built per call, not once: BUILD is filled in by the async boot, and a
  // literal captured at load would report 0.0.0 forever.
  const updateState = () => ({ status: "idle", version: BUILD.version,
    notes: "Updates for the mobile app come from the App Store and Google Play." });

  /* The terminal pane.

     Unpaired it stays a stub that says why, because iOS will not fork a shell
     and pretending otherwise is what this whole file exists to avoid.

     Paired, it is a real console against the machine at the other end. Not a
     pty — the companion answers one request with one finished result, so there
     is no interactive vim here and nothing that waits on input. What it is
     good for is what a phone is good for: checking a build, reading a log,
     restarting something, from wherever you happen to be standing.

     `cd` is handled here rather than sent, because each command runs in its own
     shell on the far side and a plain `cd` would be forgotten the instant it
     returned. Tracking the directory locally is what makes it feel like a
     session instead of a series of unrelated commands. */
  function buildConsole(el) {
    const wrap = document.createElement("div");
    wrap.className = "term-console";
    const out = document.createElement("pre");
    out.className = "term-console-out";
    const row = document.createElement("div");
    row.className = "term-console-row";
    const prompt = document.createElement("span");
    prompt.className = "term-console-prompt";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "term-console-input";
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("spellcheck", "false");
    input.placeholder = "command";
    row.appendChild(prompt); row.appendChild(input);
    wrap.appendChild(out); wrap.appendChild(row);
    el.appendChild(wrap);

    let cwd = "~";
    const history = [];
    let at = history.length;
    const paint = () => { prompt.textContent = `${cwd} $`; };
    const write = (text, cls) => {
      const line = document.createElement("span");
      if (cls) line.className = cls;
      line.textContent = text.endsWith("\n") ? text : `${text}\n`;
      out.appendChild(line);
      out.scrollTop = out.scrollHeight;
    };
    paint();
    write(`Connected to ${remoteBase()}.`, "term-console-note");
    write("One command, one result. No interactive programs.", "term-console-note");

    /* Programs that wait for a keyboard.

       The companion runs one command and answers when it exits, so anything
       that sits at a prompt runs until the timeout kills it — two minutes of a
       dead input and no output, which reads as a crash rather than as a limit.
       The first thing typed into this console in the real world was `claude`,
       which is exactly that. Saying so in half a second is worth more than
       being right slowly.

       Matched on the program name only, so `git log` is fine while `git` alone
       — which opens a pager on some setups — is not the concern; the list is
       the interactive-by-default ones, and anything missed still times out
       safely rather than hanging forever. */

    async function run(command) {
      write(`${cwd} $ ${command}`, "term-console-echo");
      if (config.autonomy !== "execute") {
        write("Execute tier required. Change it in the composer. The tier gates the machine, not just the agent.", "term-console-err");
        return;
      }
      const risky = persistenceRisk(command);
      if (risky && !window.confirm(`This ${risky}.\n\n${command.slice(0, 300)}\n\nRun it?`)) {
        return write("cancelled", "term-console-note");
      }
      const head = needsKeyboard(command);
      if (head) {
        write(`${head} waits for a keyboard, and this console cannot give it one.`, "term-console-err");
        write("Each command runs on its own and this shows you the result. Try a one-shot form instead, for example `claude -p \"...\"` rather than `claude`.", "term-console-note");
        return;
      }
      // `cd` alone means home, and `cd -` is not tracked: without a session on
      // the far side there is no previous directory to go back to.
      const cdTarget = /^cd(\s+(.*))?$/.exec(command.trim());
      if (cdTarget) {
        const target = (cdTarget[2] || "~").trim();
        const r = await remoteCall("/run", { command: `cd ${target} && pwd`, cwd, timeout: 15 }, "the directory change");
        if (r.error) return write(r.error, "term-console-err");
        if (r.data.exit_code !== 0) return write(r.data.stderr.trim() || `cannot cd to ${target}`, "term-console-err");
        cwd = r.data.stdout.trim();
        paint();
        return;
      }
      /* A live "running" line, replaced by the result.

         Without it the console is silent for however long the command takes and
         there is no way to tell work from a hang — which is the same complaint
         as the interactive case, just slower to notice. 45 seconds rather than
         the tool path's 120: a person watching a phone gives up long before a
         model does, and a command that needs longer than this wants `nohup` and
         a log to read afterwards. */
      const ticker = document.createElement("span");
      ticker.className = "term-console-note";
      out.appendChild(ticker);
      const began = performance.now();
      const tick = setInterval(() => {
        ticker.textContent = `running… ${((performance.now() - began) / 1000).toFixed(0)}s (45s limit)\n`;
        out.scrollTop = out.scrollHeight;
      }, 250);
      let r;
      try { r = await remoteCall("/run", { command, cwd, timeout: 45 }, "the command"); }
      finally { clearInterval(tick); ticker.remove(); }
      if (r.error) return write(r.error, "term-console-err");
      const d = r.data || {};
      if (d.exit_code === 124) {
        write(`no result after 45s. The machine killed it.`, "term-console-err");
        write("If it was meant to keep running, start it detached and read its log: `nohup <command> > /tmp/out.log 2>&1 &` then `tail -50 /tmp/out.log`.", "term-console-note");
        return;
      }
      if (d.stdout) write(d.stdout.replace(/\n$/, ""));
      if (d.stderr) write(d.stderr.replace(/\n$/, ""), "term-console-err");
      // Silence from a command that failed is the case worth narrating: with no
      // output and no exit line, a failure and a success look identical.
      if (d.exit_code !== 0) write(`exit ${d.exit_code}`, "term-console-err");
      else if (!d.stdout && !d.stderr) write("(no output)", "term-console-note");
    }

    input.addEventListener("keydown", async (e) => {
      if (e.key === "ArrowUp") { if (at > 0) { at -= 1; input.value = history[at] || ""; } e.preventDefault(); return; }
      if (e.key === "ArrowDown") { at = Math.min(history.length, at + 1); input.value = history[at] || ""; e.preventDefault(); return; }
      if (e.key !== "Enter") return;
      const command = input.value.trim();
      if (!command) return;
      input.value = "";
      history.push(command); at = history.length;
      if (command === "clear") { out.textContent = ""; return; }
      input.disabled = true;
      try { await run(command); } finally { input.disabled = false; input.focus(); }
    });
  }

  const terminalStub = () => {
    if (window.Terminal) return;
    window.Terminal = class {
      constructor() { this.cols = 80; this.rows = 24; }
      loadAddon() {}
      open(el) {
        if (remoteConfigured()) return buildConsole(el);
        const pre = document.createElement("pre");
        pre.className = "term-stub";
        pre.textContent = NO_SHELL();
        el.appendChild(pre);
      }
      write() {} writeln() {} focus() {} dispose() {} onData() { return { dispose() {} }; }
      onResize() { return { dispose() {} }; }
    };
    window.FitAddon = { FitAddon: class { activate() {} fit() {} dispose() {} } };
  };
  terminalStub();

  // ─── The surface ───────────────────────────────────────────────────────────
  /* Every method below answers with a Promise, because ipcRenderer.invoke does
     and the renderer was written against that. A stub that returned its object
     outright looked correct in isolation and threw
     "…state(...).then is not a function" the moment the update banner asked the
     app for its version — at load, before anything else had a chance to run.

     Rather than remember to mark two dozen one-line stubs async, the rule is
     applied here, once: a method whose name begins with "on" is a subscription
     and must return its unsubscribe function synchronously; everything else is
     a call and comes back as a Promise. */
  function promisify(surface) {
    for (const [group, value] of Object.entries(surface)) {
      if (typeof value === "function") {
        if (!/^on[A-Z]/.test(group)) surface[group] = (...args) => Promise.resolve(value(...args));
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      for (const [name, fn] of Object.entries(value)) {
        if (typeof fn !== "function" || /^on[A-Z]/.test(name)) continue;
        value[name] = (...args) => Promise.resolve(fn(...args));
      }
    }
    return surface;
  }

  const noop = () => () => {};
  window.crowe = promisify({
    // Phone navigation follows Desktop policy; no local farm capability is granted.
    installSpaces: null,
    edition: EDITION,
    editionAccess: {
      async enterLegacy() { return { ok: false, error: { code: "UNAVAILABLE", message: "Legacy farm recovery requires the source desktop installation. No local records are accessed here." } }; },
      async leaveLegacy() { return { ok: false, error: { code: "UNAVAILABLE", message: "Legacy farm recovery is unavailable in this runtime." } }; },
      async openWorkbench() { return { ok: false, error: { code: "UNAVAILABLE", message: "Opening the local desktop workbench is unavailable in this runtime." } }; },
    },
    vision: { async request() { return { ok: false, error: { code: "UNAVAILABLE", message: "Notebook photo inspection requires the Mycology desktop app. No image is read or sent here." } }; } },
    transfer: {
      async request() { return { ok: false, error: { code: "UNAVAILABLE", message: "Notebook and compliance transfers require the local desktop app. No records are imported or exported here." } }; },
    },
    // Phone records and paired-machine routes are not the desktop farm database.
    farm: {
      async request() { return { ok: false, error: { code: "UNAVAILABLE", message: "Farm & Compliance is available in the local desktop app, not this phone. No farm records are stored here." } }; },
      async legacyHarvests() { return { ok: false, error: { code: "UNAVAILABLE", message: "Legacy harvest adoption is available only in the local desktop Farm & Compliance workspace." } }; },
    },
    team: {
      async request() { return { ok: false, error: { code: "UNAVAILABLE", message: "Farm team tools are available in the Mycology desktop app, not this phone." } }; },
    },
    imports: {
      async request() { return { ok: false, error: { code: "UNAVAILABLE", message: "Document intake is available in the Mycology desktop app, not this phone. No documents are stored here." } }; },
    },
    /* Also the flag renderer.js branches on: it is the one part of the bridge
       that exists before any class is put on the body, so a panel deck mounting
       during init can still tell which shell it is in. */
    mobile: {
      platform: PLATFORM, native: NATIVE,
      /* The browser panel's Open button. SFSafariViewController on iOS, Custom
         Tabs on Android — the page keeps the cookies the user already has, and
         the app keeps its process. Refusing anything that is not http(s) keeps
         a saved bookmark from becoming a way to reach a native scheme. The
         window.open fallback is `npm run serve`, where there is no plugin and a
         new tab is the honest equivalent. */
      openExternal: async (url) => {
        url = String(url || "").trim();
        if (!/^https?:\/\//i.test(url)) return { error: "only http and https addresses open here" };
        const Browser = plugin("Browser");
        if (Browser) { await Browser.open({ url }); return { ok: true }; }
        window.open(url, "_blank", "noopener");
        return { ok: true };
      },
    },

    agent: {
      run: async (messages, id = "main", options = {}) => {
        await ready;
        if (!consented()) { const c = consentNeeded(); return { done: false, error: c.error, text: c.error }; }
        const epoch = consentEpoch;
        if (options && options.licensed) {
          const gate = await requireAgentEntitlement(options.workspaceId);
          if (!gate.ok) return { done: false, error: gate.error, text: gate.error };
        }
        // A call with no messages answers, it does not reject: an unhandled
        // rejection is a console error in the WebView and a crash in Node.
        if (!Array.isArray(messages)) return { done: false, error: "nothing to send", text: "" };
        if (!consented() || epoch !== consentEpoch) { const c = consentNeeded(); return { done: false, error: c.error, text: c.error }; }
        const result = await runAgent(messages.slice(), String(id || "main"), options || {}, epoch);
        if (id === "main") { try { await persistSession([...messages, { role: "assistant", content: result.text || "" }]); } catch { /* history is not worth failing a turn over */ } }
        return { done: Boolean(result.done), text: result.text || "", error: result.error };
      },
      stop: (id = "main") => { const r = runs.get(id); if (r) { r.aborted = true; try { r.controller?.abort(); } catch { /* already finished */ } } return { ok: true }; },
      stopAll: () => { window.CroweLocalRooms?.stopAll(); for (const r of runs.values()) { r.aborted = true; try { r.controller?.abort(); } catch { /* already finished */ } } return { ok: true, stopped: runs.size }; },
      onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    },
    chat: async (messages) => gatewayChat(messages, null, undefined, undefined, undefined),

    intents: { take: takePendingIntent },
    auth: {
      login: signIn,
      logout: async () => { await saveConfig({ refreshToken: "" }); config.token = ""; await store.set("config", config); return { ok: true }; },
      /* App Store guideline 5.1.1(v): an account a person can create in the app
         must be one they can delete from the app. The deletion itself lives on
         the Crowe ID account page (Keycloak's delete_account action), so the
         phone opens that page in the browser sheet and, when the sheet closes,
         asks the realm whether this session still exists. A deleted user has no
         session, the refresh is refused, and the phone forgets its tokens. A
         person who only looked and closed the sheet refreshes fine and stays
         signed in. Without a refresh token there is nothing to ask, so the
         answer is unknown rather than guessed. */
      deleteAccount: async () => {
        await ready;
        /* Two routes, native first. Control plane 0.2.20 added DELETE
           /api/auth/me: the person types the address on the account, the
           gateway cancels the subscription (keeping the Stripe customer),
           removes the account's rows and deletes the Crowe ID, and the phone
           forgets its tokens. An older gateway answers 404 and the
           account-console route below takes over, so the app never depends
           on the deploy having landed. Without a way to ask for the typed
           address (no prompt in this webview, or in the test harness) the
           console route is used too: deletion is never attempted unconfirmed.
           The gateway refuses protected accounts with 403 and a message; that
           message is shown and nothing else happens. */
        const canPrompt = typeof window.prompt === "function";
        let u = currentUser();
        if (u && u.email && canPrompt) {
          if (u.exp && u.exp * 1000 < Date.now() + 60000) { await refreshToken(); u = currentUser() || u; }
          const typed = window.prompt(`Type ${u.email} to delete this Crowe ID and everything stored under it. This cannot be undone.`);
          if (typed === null || typed === undefined) return { opened: false, deleted: false, error: "Not deleted." };
          if (String(typed).trim().toLowerCase() !== String(u.email).toLowerCase()) return { opened: false, deleted: false, error: "Not deleted: the email did not match." };
          let res = null;
          try {
            res = await fetch(`${base()}/api/auth/me`, { method: "DELETE", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` }, body: JSON.stringify({ confirm: String(typed).trim() }) });
          } catch { res = null; }
          if (res && res.status !== 404) {
            if (!res.ok) {
              const d = await Promise.resolve(res.json ? res.json() : {}).catch(() => ({}));
              const detail = d && d.detail; const msg = detail && (detail.message || (typeof detail === "string" ? detail : "")) || d && d.error || "";
              return { opened: false, deleted: false, error: msg || `Deletion failed (${res.status})` };
            }
            await saveConfig({ refreshToken: "" }); config.token = ""; await store.set("config", config);
            return { opened: false, deleted: true };
          }
          // 404 or unreachable: the gateway predates 0.2.20, use the console.
        }
        const url = `${CROWE_ID}/account/`;
        const Browser = plugin("Browser");
        if (!Browser) { window.open(url, "_blank", "noopener"); return { opened: true, deleted: null }; }
        return new Promise((resolve) => {
          let handle = null, settled = false;
          const finish = async () => {
            if (settled) return;
            settled = true;
            try { if (handle) handle.remove(); } catch { /* listener already gone */ }
            if (!config.refreshToken) { resolve({ opened: true, deleted: null }); return; }
            const alive = await refreshToken();
            if (alive) { resolve({ opened: true, deleted: false }); return; }
            await saveConfig({ refreshToken: "" }); config.token = ""; await store.set("config", config);
            resolve({ opened: true, deleted: true });
          };
          // Promise.resolve for the same reason as in signIn: the injected
          // bridge returns the handle synchronously, the JS package a promise.
          Promise.resolve(Browser.addListener("browserFinished", finish)).then((h) => { handle = h; }).catch(() => {});
          Browser.open({ url, presentationStyle: "popover" }).catch(() => finish());
        });
      },
      status: async () => {
        await ready;
        let u = currentUser();
        if (u && u.exp) {
          const expMs = u.exp * 1000, now = Date.now();
          if (expMs < now) { const t = await refreshToken(); u = t ? currentUser() : null; }
          else if (expMs < now + 60000) { refreshToken(); }
        }
        return { user: u };
      },
    },
    license: {
      status: licenseStatus,
      select: async (workspaceId) => {
        if (typeof workspaceId !== "string" || workspaceId.length > 200) return { error: "Invalid workspace" };
        await saveConfig({ licenseWorkspaceId: workspaceId });
        return { ok: true, selectedWorkspaceId: workspaceId };
      },
      billing: async () => {
        const result = await licensedFetch("/api/billing/portal/self", "POST");
        if (result.status >= 400 || !result.data?.url) return { error: "Billing portal is unavailable" };
        let portal; try { portal = new URL(result.data.url); } catch { return { error: "Billing portal returned an unreadable URL" }; }
        if (portal.protocol !== "https:") return { error: "Billing portal returned an unsafe URL" };
        const Browser = plugin("Browser");
        if (Browser) await Browser.open({ url: portal.toString() });
        else window.open(portal.toString(), "_blank", "noopener");
        return { ok: true };
      },
    },

    /* The member's own plan, and why the phone cannot sell it.

       Parity with the desktop bridge (scripts/test-mobile-bridge.js requires
       every desktop method to exist here), but two of the four are stated
       refusals rather than working calls, for two separate and both real
       reasons:

         · catalog — the checkout Worker answers with an Access-Control-Allow-
           Origin allowlist naming crowelogic.com, not a wildcard. A fetch from
           capacitor://localhost is refused by the browser after the request has
           already been made. The desktop gets away with it by fetching from the
           main process, where CORS does not apply, and the web is on the listed
           origin. The phone is neither, so asking would fail silently and the
           card would show "price at checkout" forever.

         · checkout — selling a subscription to digital content inside an iOS or
           Android app is the store's business, through its own purchase API.
           Sending the buyer out to Stripe from in-app is the thing both review
           teams reject for. `license.billing` above is a different case and
           stays: managing a subscription that already exists is account
           management, which both stores permit.

       plan and refresh are the token's own claim, so they are real here. That
       means the phone can say what tier this Crowe ID is on, and pick up a tier
       bought elsewhere on the next refresh, which is the useful half. */
    billing: {
      plan: async () => {
        await ready;
        const u = currentUser();
        const tier = u ? String(u.tier || "") : "";
        return { email: u ? u.email : "", tier, known: Boolean(u), paid: PAID_TIERS.includes(tier.toLowerCase()) };
      },
      catalog: async () => ({ error: "The plan list is not available in the phone app." }),
      checkout: async () => ({
        ok: false,
        error: "Plans are not sold in the phone app. The plan on your Crowe ID reaches this phone on its next sign-in.",
      }),
      refresh: async () => {
        await ready;
        const t = await refreshToken();
        const u = currentUser();
        const tier = u ? String(u.tier || "") : "";
        return { ok: Boolean(t), plan: { email: u ? u.email : "", tier, known: Boolean(u), paid: PAID_TIERS.includes(tier.toLowerCase()) } };
      },
    },

    /* The paired machine. `pair` takes the token but nothing ever hands it
       back: status reports whether the machine answers, not what it was told.
       A phone is lost more often than a laptop, and a token that can be read
       out of a settings pane is a token that leaves with it. */
    remote: {
      status: async () => { await ready; return remoteStatus(); },
      pair: async ({ url, token } = {}) => {
        await ready;
        const clean = String(url || "").trim().replace(/\/$/, "");
        if (clean && !/^https?:\/\//i.test(clean)) return { error: "the address needs http:// or https://" };
        const patch = { remoteUrl: clean };
        // Same rule Settings uses for the Crowe ID token: blank means keep the
        // current one, so re-saving the address does not silently unpair.
        if (typeof token === "string" && token !== "") patch.remoteToken = token;
        if (!clean) patch.remoteToken = "";           // clearing the host clears the credential
        await saveConfig(patch);
        announceRemote();
        return { ok: true, ...(await remoteStatus()) };
      },
      run: async (command, cwd) => {
        await ready;
        if (config.autonomy !== "execute") {
          return { error: `running commands needs the Execute tier; this turn is ${config.autonomy}` };
        }
        const r = await remoteCall("/run", { command: String(command || ""), cwd: cwd || undefined, timeout: 60 }, "the command");
        return r.error ? { error: r.error } : { ok: true, ...r.data };
      },
    },

    /* The desktop hosts a companion for a phone to drive. A phone is the other
       end of that wire and cannot be both — iOS will not let this process fork
       a shell to lend, and a phone has no stable address to be found at. So
       these refuse rather than pretend, and point at the half that does exist:
       remote.pair, above, is how this device joins someone else's companion. */
    // Compatibility responses only. Never read saved Sense settings or poll a relay.
    sense: {
      status: async () => ({ config: { source: "off", url: "", node: "", relay: "" }, health: null,
        lastPoll: 0, lastError: "", stale: false, running: false, available: EDITION.capabilities.sense }),
      configure: async () => unavailableGrow(),
      onChange: () => () => {},
    },
    companion: {
      status: async () => ({ running: false, host: null, port: 0, tailscale: null, paired: remoteConfigured(),
                             error: "A phone cannot host the companion. It joins one: Settings → Remote machine." }),
      start: async () => ({ error: "A phone cannot host a shell for another device. Run the companion on the desktop app and scan its code from here." }),
      stop: async () => ({ running: false }),
      rotate: async () => ({ error: "There is no companion token on this device; the machine you paired with owns it." }),
      devices: async () => [],
      addDevice: async () => ({ error: "The desktop app mints device codes. This is the device that scans one." }),
      revokeDevice: async () => ({ error: "Revoke a device from the machine it was paired with." }),
      audit: async () => [],
      pairSvg: async () => ({ error: "The desktop app draws the pairing code. This is the device that scans it." }),
      onEvent: () => noop(),
    },

    // No edit or approval gate can fire on this device: the tools that would
    // raise one do not exist here. The methods stay so the renderer's handlers
    // resolve, and answer the only truthful thing.
    edit: { decide: () => ({ ok: false, error: NO_WORKSPACE() }) },
    approval: { decide: () => ({ ok: false, error: NO_WORKSPACE() }) },

    pty: {
      start: () => ({ error: NO_SHELL() }),
      input: () => {}, resize: () => {},
      close: () => ({ ok: true }),
      onData: noop,
    },
    fs: {
      list: () => ({ cwd: "", entries: [], error: NO_WORKSPACE() }),
      read: () => ({ error: NO_WORKSPACE() }),
      walk: () => [],
      pick: () => [],
      readContext: () => [],
    },
    git: {
      status: () => ({ repo: false, cwd: "", error: NO_WORKSPACE() }),
      diff: () => NO_WORKSPACE(),
      stage: () => ({ error: NO_WORKSPACE() }), unstage: () => ({ error: NO_WORKSPACE() }),
      commit: () => ({ error: NO_WORKSPACE() }), log: () => [], branches: () => [],
      checkout: () => ({ error: NO_WORKSPACE() }), pull: () => ({ error: NO_WORKSPACE() }),
      push: () => ({ error: NO_WORKSPACE() }),
    },
    // Local checkouts live on the desktop, and so does the GitHub plugin's
    // token. The phone lists none and says why, in git's own shapes.
    repos: {
      recent: async () => [],
      open: async () => ({ error: NO_WORKSPACE() }),
      pick: async () => ({ error: NO_WORKSPACE() }),
      forget: async () => ({ ok: true }),
      remote: async () => ({ cwd: "", repo: false, remote: null, error: NO_WORKSPACE() }),
      githubStatus: async () => ({ configured: false }),
      githubRepos: async () => ({ configured: false, repos: [], error: NO_WORKSPACE() }),
      githubWork: async () => ({ configured: false, error: NO_WORKSPACE() }),
      clone: async () => ({ error: NO_WORKSPACE() }),
    },

    sessions: {
      list: async () => (await sessionIndex()).map((s) => ({ ...s, current: s.id === currentSession })),
      load: async (id) => {
        const d = await store.get(`session:${id}`);
        if (!d) return { error: "no such session" };
        currentSession = id;
        return { messages: d.messages || [], title: d.title, name: d.name || "", brief: d.brief || "" };
      },
      new: () => { currentSession = newSessionId(); return { id: currentSession }; },
      // Name and brief for a session, before or after it has messages. Same
      // allowlist and caps as main.js and web-bridge.js, which the parity test
      // holds; a session that is only an id so far gets a record here.
      update: async (id, patch) => {
        const sid = String(id || currentSession || newSessionId());
        const fields = {};
        for (const [key, cap] of [["name", 80], ["brief", 4000]]) {
          if (patch && Object.prototype.hasOwnProperty.call(patch, key)) fields[key] = String(patch[key] == null ? "" : patch[key]).slice(0, cap);
        }
        const prior = (await store.get(`session:${sid}`)) || { id: sid, title: "Untitled", updatedAt: Date.now(), messages: [] };
        const next = { ...prior, ...fields, id: sid, updatedAt: Date.now() };
        await store.set(`session:${sid}`, next);
        const index = (await sessionIndex()).filter((s) => s.id !== sid);
        index.unshift({ id: sid, title: next.title, name: next.name || "", updatedAt: next.updatedAt });
        await store.set("sessions", index.slice(0, 200));
        if (!currentSession) currentSession = sid;
        return { ok: true, id: sid, name: next.name || "", brief: next.brief || "" };
      },
      delete: async (id) => {
        await store.remove(`session:${id}`);
        await store.set("sessions", (await sessionIndex()).filter((s) => s.id !== id));
        if (currentSession === id) currentSession = null;
        return { ok: true };
      },
    },

    // Ordinary growing APIs are unavailable, including the old clipboard
    // export. Settings' explicit legacy archive is a separate, raw-data path.
    grow: {
      list: async () => [],
      save: async () => unavailableGrow(),
      delete: async () => unavailableGrow(),
      export: async () => unavailableGrow(),
    },

    // General reminders remain. Grow-specific history stays stored untouched.
    reminders: {
      list: async () => ((await store.get("reminders")) || []).filter((r) => r && !growReminder(r) && r.at > Date.now() - 7 * 86400000).sort((a, b) => a.at - b.at),
      add: async ({ lot, title, body, at } = {}) => {
        if (!EDITION.capabilities.grow && lot != null && String(lot).trim()) return unavailableGrow();
        const when = Number(at);
        if (!Number.isFinite(when) || when < Date.now()) return { ok: false, error: "the reminder time is in the past" };
        // int32, as the notification plugin requires; seconds plus a nonce keeps two taps apart.
        const id = (Math.floor(Date.now() / 1000) % 2000000000) + Math.floor(Math.random() * 1000);
        const rec = { id, lot: String(lot || "").slice(0, 40), title: String(title || "Crowe Logic").slice(0, 80), body: String(body || "").slice(0, 200), at: when, createdAt: Date.now() };
        const LN = plugin("LocalNotifications");
        if (LN) {
          let perm = { display: "denied" };
          try { perm = await LN.checkPermissions(); if (perm.display !== "granted") perm = await LN.requestPermissions(); }
          catch (e) { return { ok: false, error: "notifications: " + String(e && e.message || e).slice(0, 80) }; }
          if (perm.display !== "granted") return { ok: false, error: "Allow notifications for Crowe Logic in Settings to get reminders" };
          try { await LN.schedule({ notifications: [{ id, title: rec.title, body: rec.body, schedule: { at: new Date(when), allowWhileIdle: true }, extra: { lot: rec.lot } }] }); }
          catch (e) { return { ok: false, error: "schedule: " + String(e && e.message || e).slice(0, 80) }; }
        }
        const all = (await store.get("reminders")) || [];
        all.push(rec);
        // Do not trim this collection: it includes preserved legacy history.
        await store.set("reminders", all);
        return { ok: true, reminder: rec, native: Boolean(LN) };
      },
      // What the system still holds for this app, so Diagnostics can show that
      // iOS accepted a reminder and not only that Preferences kept a row.
      // Pending is scheduling, not delivery: the one-minute test in Settings is
      // what proves a notification reaches the lock screen.
      pending: async () => {
        const LN = plugin("LocalNotifications");
        if (!LN || typeof LN.getPending !== "function") return { native: false, notifications: [] };
        try {
          const r = await LN.getPending();
          const list = (r && r.notifications) || [];
          return { native: true, notifications: list.map((n) => ({ id: n.id, title: String(n.title || ""), at: n.schedule && n.schedule.at ? new Date(n.schedule.at).getTime() : null })).sort((a, b) => (a.at || 0) - (b.at || 0)) };
        } catch (e) { return { native: true, notifications: [], error: String(e && e.message || e).slice(0, 80) }; }
      },
      remove: async (id) => {
        const all = (await store.get("reminders")) || [];
        if (all.some(r => r && r.id === Number(id) && growReminder(r))) return unavailableGrow();
        const LN = plugin("LocalNotifications");
        if (LN) { try { await LN.cancel({ notifications: [{ id: Number(id) }] }); } catch { /* fired already, or never scheduled */ } }
        await store.set("reminders", all.filter((r) => r && r.id !== Number(id)));
        return { ok: true };
      },
    },
    // This is the retired journal, not crowePhone's general photo attachment.
    camera: {
      list: async () => [],
      add: async () => unavailableGrow(),
    },

    diag: {
      list: async () => { if (!diagBuf) diagBuf = (await store.get("diag")) || []; return diagBuf.slice().reverse(); },
      clear: async () => { diagBuf = []; await store.set("diag", []); return { ok: true }; },
      note: (kind, detail) => diag(kind, detail),
    },

    onBrowserNavigate: noop,
    onMenuAction: noop,

    catalog: {
      get: async () => {
        await ready;
        if (!catalogCache.models.length) {
          const cached = await store.get("catalog");
          if (cached && Array.isArray(cached.models)) catalogCache = { ...cached, models: filterCatalog(cached.models) };
          fetchCatalog();
        } else if (Date.now() - catalogCache.at > 3600000) fetchCatalog();
        return { models: catalogCache.models, at: catalogCache.at, resolved: resolveRoles(), defaultModel: defaultModel() };
      },
    },

    /* The store, not electron-updater, decides when this app updates.
       "idle" is the desktop's own word for an app with nothing to report, and
       it is what the update banner checks for before staying hidden — a status
       of its own invention ("store") slipped past every branch in
       renderRefresh() and drew an empty gold banner across the top of the app
       on first launch. The note travels with it for anything that asks. */
    update: {
      check: updateState,
      download: updateState,
      install: updateState,
      state: updateState,
      onChange: noop,
    },

    // Plugins are stdio MCP servers the desktop spawns. A phone cannot spawn a
    // process, so the manifest is not even fetched: an empty list renders the
    // Settings section's own empty state.
    plugins: {
      list: () => [],
      enable: () => ({ error: "Plugins run MCP servers as local processes, which mobile does not allow." }),
      disable: () => ({ ok: true }),
    },

    /* Rooms are desktop-only, and refuse rather than being absent.

       A room runs several harness turns at once against one workspace, with a
       git worktree per writing agent. The phone has no workspace and cannot
       fork a process; what it has is a paired desktop, and driving a room there
       is a companion endpoint that does not exist yet.

       Absent is not an option even so: the phone ships the desktop renderer
       unmodified, so a rooms surface calling into a missing namespace would be
       a TypeError at a tap. Every method answers in the shape its caller
       expects - a list is an empty list, an action is a stated reason - which
       is the same contract the plugin and git refusals above keep. */
    rooms: window.CroweLocalRooms && window.CroweRooms ? window.CroweLocalRooms.create({
      read: async () => { await ready; return (await store.get("rooms")) || []; },
      write: async records => { if (!await store.set("rooms", records)) throw new Error("Room storage could not be saved. Autopilot stopped."); },
      catalog: async () => { await ready; if (config.token && !catalogCache.models.length) await fetchCatalog(); return catalogCache.models; },
      chat: async (model, messages, signal) => gatewayChat(messages, [], signal, model),
      emit,
    }, Object.freeze({ grow: EDITION.capabilities.grow, modelAllowed })) : {
      agents: async () => ({ agents: [], templates: [] }), list: async () => [],
      create: async () => ({ error: "Room engine is missing; rebuild the mobile payload." }),
      onChanged: () => () => {}, onOpen: () => () => {},
    },

    keys: {
      // { encrypted, providers } — not the bare array keyStatus() returns. The
      // Key Manager reads result.providers, and a list that answered with the
      // array drew the section with its heading, its badge and no rows at all.
      // encrypted is false and says so: Preferences is private app storage, not
      // the OS keychain safeStorage gives the desktop.
      list: async () => { await ready; return { encrypted: false, providers: keyStatus() }; },
      set: async (provider, key) => {
        if (!KEY_PROVIDERS[provider] || typeof key !== "string" || !key.trim()) return { error: "Invalid provider or key" };
        const keys = { ...(config.keys || {}) };
        keys[provider] = { value: key.trim(), updatedAt: Date.now() };
        await saveConfig({ keys });
        return { ok: true, providers: keyStatus() };
      },
      remove: async (provider) => {
        const keys = { ...(config.keys || {}) };
        delete keys[provider];
        await saveConfig({ keys });
        return { ok: true, providers: keyStatus() };
      },
      test: async (provider) => {
        const spec = KEY_PROVIDERS[provider];
        const entry = (config.keys || {})[provider];
        if (!spec || !entry?.value) return { ok: false, error: "no key set" };
        const headers = spec.header === "Bearer"
          ? { Authorization: `Bearer ${entry.value}` }
          : { "x-api-key": entry.value, "anthropic-version": "2023-06-01" };
        try {
          const r = await fetch(spec.url, { headers });
          const healthy = r.ok;
          const keys = { ...(config.keys || {}) };
          keys[provider] = { ...entry, testedAt: Date.now(), healthy };
          await saveConfig({ keys });
          return { ok: healthy, status: r.status, error: healthy ? "" : "Provider rejected the credential", providers: keyStatus() };
        } catch { return { ok: false, error: "the provider could not be reached from this device", providers: keyStatus() }; }
      },
    },

    operator: {
      /* Every non-array key here is printed verbatim as a tile label in the
         Operator Control panel — mountOperator() iterates the object rather
         than owning a schema. On the desktop those keys are the machine's own
         vocabulary (cwd, mcpServers) about a machine the user configured. On a
         phone they were noise: three counters pinned to zero and an empty tile
         labelled "cwd". So the phone reports in its own words, and only what
         has a value here: the run state, the paired machine, and the tier.
         agentIds/terminalIds stay for the "Active" lists the panel also reads. */
      status: () => {
        const host = remoteBase().replace(/^https?:\/\//, "").replace(/:\d+$/, "");
        return {
          app: "running", agents: runs.size, agentIds: [...runs.keys()], terminalIds: [],
          "paired machine": remoteConfigured() ? host : "none. Pair in Settings",
          autonomy: config.autonomy || "edit", version: BUILD.version,
          platform: PLATFORM === "ios" ? "iOS" : PLATFORM === "android" ? "Android" : "browser",
        };
      },
      stopAll: () => { window.CroweLocalRooms?.stopAll(); for (const r of runs.values()) { r.aborted = true; try { r.controller?.abort(); } catch { /* already finished */ } } return { ok: true }; },
    },

    getConfig: async () => { await ready; return publicConfig(); },
    setConfig: async (patch) => { await ready; await saveConfig(patch || {}); return publicConfig(); },
  });

  /* ─── Boot defaults the renderer reads before mobile-ui.js exists ──────────
     Both of these are localStorage keys renderer.js consults while it builds
     the shell, which is over before the phone chrome loads. Seeded only when
     the user has no preference of their own, so neither one overrides a choice.

     The workspace deck defaults to a terminal — reasonable on a workstation,
     and on a phone it opened the Panels tab onto a dead pane whose toolbar
     offered to restart a shell that had never started. Operator Control is
     what a phone actually wants there: what is running, and the button that
     stops it.

     The rail defaults to open, which on a phone is a drawer across the app.
     Collapsing it here rather than from mobile-ui means it is never painted
     open and then shut in front of the user. */
  try {
    if (!localStorage.getItem("crowe-workspace-panels")) {
      localStorage.setItem("crowe-workspace-panels", JSON.stringify({ layout: "stack", panels: [{ type: "operator" }] }));
    }
    if (!localStorage.getItem("crowe-sidebar")) localStorage.setItem("crowe-sidebar", "collapsed");
  } catch { /* a webview with storage disabled still boots, just without the defaults */ }

  // Warm the catalog so the first model picker has models in it, and so routing
  // is not stuck on the default model for the first turn of the session.
  ready.then(() => { if (config.token) fetchCatalog(); });
})();
