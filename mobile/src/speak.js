/* Spoken replies, for the phone.
 *
 * One file, no hook in the shell: it takes over the composer's speaker button
 * (#voice-output) from the renderer's speechSynthesis handler, which binds with
 * onclick so a reassignment replaces it cleanly. The voice is the Settings row
 * "Reply voice" (localStorage crowe-reply-voice):
 *   "phone"  - Apple's best installed voice through the CroweVoice plugin, on
 *              the device, free; the default. Off the iOS shell (or on an older
 *              binary) it is the web speech engine.
 *   "neural" - a Deepgram Aura-2 voice from the crowe-ai worker (cloud-ai.js),
 *              billed to the account's Workers AI credits; if the worker cannot
 *              be reached the phone's voice reads instead.
 * The cloned "michael" voice is retired: it is never offered here and never
 * requested, even if a server still lists it. Each cloud read is noted in
 * Diagnostics with the voice that spoke and the characters it cost. */
(() => {
  const $ = (id) => document.getElementById(id);
  const btn = $("voice-output");
  if (!btn || !window.crowe) return;
  const say = (t, s) => { if (typeof setComposerStatus === "function") setComposerStatus(t, s); };
  const cap = window.Capacitor;
  const native = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.CroweVoice;

  let active = null, sequence = 0;
  const lit = on => { btn.classList.toggle("active", on); btn.setAttribute("aria-pressed", on ? "true" : "false"); };
  const current = request => active === request && !request.controller.signal.aborted;
  function stop() {
    const request = active; active = null;
    if (request) {
      request.controller.abort();
      if (request.player) { request.player.onended = request.player.onerror = null; request.player.pause(); }
      if (request.url) URL.revokeObjectURL(request.url);
      if (native && request.mode === "native") native.stop().catch(() => {});
      if (request.mode === "web") window.speechSynthesis?.cancel();
    }
    lit(false);
  }
  if (native) native.addListener("speakState", ({ status }) => {
    if (!active || active.mode !== "native") return;
    if (status === "started") { active.speaking = true; lit(true); }
    if (status === "ended" || status === "cancelled") { active = null; lit(false); say("Ready"); }
  });
  window.addEventListener("pagehide", stop);

  async function speakLast() {
    if (active) { stop(); say("Ready"); return; }
    const said = [...document.querySelectorAll(".msg.assistant .said")].pop();
    if (!said) { say("Nothing to read yet", "note"); return; }
    const request = { id: ++sequence, controller: new AbortController(), mode: "cloud", speaking: false };
    active = request; lit(true); say("Preparing voice", "running");
    const fallbackCurrent = () => fallback(said, request);
    try {
      const preferred = replyVoice();
      if (preferred === "phone" || !window.croweCloud) return await fallbackCurrent();
      let list;
      try {
        list = await (await window.croweCloud.call("/v1/voices", { signal: request.controller.signal })).json();
      } catch (error) {
        if (!current(request)) return;
        if (error.status === 401) { stop(); say("Sign in to hear the natural voice", "note"); return; }
        return await fallbackCurrent();
      }
      if (!current(request)) return;
      const allowed = (list.voices || []).map(v => v.id).filter(id => id && id !== "michael");
      if (!allowed.length) return await fallbackCurrent();
      let pick = ""; try { pick = localStorage.getItem("crowe-cloud-voice") || ""; } catch { /* storage refused */ }
      const voice = allowed.includes(pick) ? pick : allowed.includes(list.default) ? list.default : allowed[0];
      const text = said.innerText.slice(0, list.max_chars || 1500);
      const response = await window.croweCloud.call("/v1/speech", {
        method: "POST", signal: request.controller.signal, body: JSON.stringify({ text, voice }),
      });
      if (!current(request)) return;
      const spoke = response.headers.get("x-crowe-voice") || voice;
      const chars = response.headers.get("x-crowe-chars") || String(text.length);
      window.crowe.diag?.note("speech", `${spoke} · ${chars} chars`);
      const blob = await response.blob();
      if (!current(request)) return;
      request.url = URL.createObjectURL(blob);
      request.player = new Audio(request.url);
      request.player.onended = () => { if (current(request)) { stop(); say("Ready"); } };
      request.player.onerror = () => { if (current(request)) { stop(); say("Playback failed", "error"); } };
      await request.player.play();
      if (current(request)) { request.speaking = true; say("Reading", "running"); }
    } catch (error) {
      if (current(request)) { stop(); say("Could not read aloud: " + String(error.message || error).slice(0, 60), "error"); }
    }
  }

  // The Settings row writes this; anything unrecognised (including a stored
  // "michael" from before the cloned voice was retired) reads as "phone".
  function replyVoice() {
    let v = "";
    try { v = localStorage.getItem("crowe-reply-voice") || ""; } catch { /* storage refused */ }
    return ["neural", "phone"].includes(v) ? v : "phone";
  }

  async function fallback(said, request) {
    if (!current(request)) return;
    const text = said.innerText;
    if (native) {
      request.mode = "native";
      try {
        await native.speak({ text });
        if (current(request)) { request.speaking = true; lit(true); say("Reading", "running"); }
        return;
      } catch { if (!current(request)) return; }
    }
    if (!window.speechSynthesis) { stop(); say("Read-aloud is not available here", "note"); return; }
    request.mode = "web"; request.speaking = true;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onstart = () => { if (current(request)) lit(true); };
    utterance.onend = utterance.onerror = () => { if (current(request)) { stop(); say("Ready"); } };
    speechSynthesis.speak(utterance); say("Reading", "running");
  }

  btn.onclick = speakLast;
  btn.title = "Read the last reply aloud";
})();
