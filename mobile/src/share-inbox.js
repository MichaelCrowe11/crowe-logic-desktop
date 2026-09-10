/* The share inbox: what the Share Extension left for the app.
 *
 * CroweShare (ios/App/CroweShare) writes one JSON note into the App Group's
 * UserDefaults under the key the Capacitor Preferences plugin reads for
 * "share" in the suite group.com.crowelogic.mobile, then opens the app on
 * com.crowelogic.mobile://share. This file collects the note on launch, on
 * that URL, and on every return to the foreground, clears it, and hands it to
 * the composer: text and links become the draft, a photo goes to CroweLM
 * Vision through the same path as the camera button.
 *
 * Self-contained on purpose: it registers its own App plugin listeners (the
 * plugin allows many) and touches nothing in mobile-bridge.js or mobile-ui.js.
 * A note older than ten minutes is dropped, the same rule as Siri's notes.
 */
(() => {
  const Cap = window.Capacitor;
  if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;
  const Plugins = Cap.Plugins || {};
  const Preferences = Plugins.Preferences, App = Plugins.App;
  if (!Preferences || !App) return;
  const GROUP = "group.com.crowelogic.mobile";
  const KEY = "share";
  const MAX_AGE_MS = 10 * 60 * 1000;
  const $ = (id) => document.getElementById(id);
  let busy = false;

  async function take() {
    // Read from the shared suite, then put the plugin back on the app's own
    // store so nothing else in the bridge ever sees the group.
    await Preferences.configure({ group: GROUP });
    let note = null;
    try {
      const { value } = await Preferences.get({ key: KEY });
      if (value) { await Preferences.remove({ key: KEY }); try { note = JSON.parse(value); } catch { note = null; } }
    } finally {
      await Preferences.configure({ group: "CapacitorStorage" });
    }
    if (!note || !note.at || Date.now() - Number(note.at) > MAX_AGE_MS) return null;
    return note;
  }

  function draft(note) {
    const input = $("input");
    const parts = [];
    if (note.text) parts.push(String(note.text).trim());
    if (note.url && !(note.text || "").includes(note.url)) parts.push(String(note.url).trim());
    if (input && parts.length) {
      input.value = [input.value.trim(), parts.join("\n")].filter(Boolean).join("\n");
      input.dispatchEvent(new Event("input"));
      input.focus();
    }
    if (note.image && window.crowePhone && typeof window.crowePhone.addImage === "function") {
      window.crowePhone.addImage(note.image);
      if (input && !parts.length) { input.placeholder = "What should I look at in this photo?"; }
    }
    if (typeof setComposerStatus === "function") {
      setComposerStatus(note.image ? "Photo received. Ask about it, or send." : "Shared into Crowe Logic. Edit, then send.", "note");
    }
  }

  async function collect() {
    if (busy) return;
    busy = true;
    try {
      const note = await take();
      if (note) {
        // Shared content goes to Chat, whatever tab was open.
        const chat = [...document.querySelectorAll("#m-tabs .m-tab")].find((t) => t.textContent.trim() === "Chat");
        if (chat) chat.click();
        draft(note);
      }
    } catch (e) {
      if (typeof setComposerStatus === "function") setComposerStatus("Could not read the shared item: " + String(e && e.message || e).slice(0, 60), "error");
    } finally {
      busy = false;
    }
  }

  Promise.resolve(App.addListener("appUrlOpen", (e) => {
    if (e && typeof e.url === "string" && e.url.startsWith("com.crowelogic.mobile://share")) collect();
  })).catch(() => {});
  Promise.resolve(App.addListener("appStateChange", (s) => { if (s && s.isActive) collect(); })).catch(() => {});
  // Cold start: the URL may have launched the app before this script ran.
  setTimeout(collect, 600);
  window.croweShareInbox = { collect };
})();
