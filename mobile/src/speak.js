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

  let player = null, speaking = false;
  const lit = (on) => { btn.classList.toggle("active", on); btn.setAttribute("aria-pressed", on ? "true" : "false"); };
  const stop = () => {
    if (player) { try { player.pause(); URL.revokeObjectURL(player.src); } catch { /* already gone */ } player = null; }
    if (native && speaking) native.stop().catch(() => {});
    if (!native && window.speechSynthesis && speechSynthesis.speaking) speechSynthesis.cancel();
    speaking = false; lit(false);
  };
  if (native) native.addListener("speakState", ({ status }) => {
    speaking = status === "started"; lit(speaking);
    if (status === "ended") say("Ready");
  });

  async function speakLast() {
    if (player || speaking) { stop(); say("Ready"); return; }
    const said = [...document.querySelectorAll(".msg.assistant .said")].pop();
    if (!said) { say("Nothing to read yet", "note"); return; }
    const preferred = replyVoice();
    if (preferred === "phone") return fallback(said);
    if (!window.croweCloud) return fallback(said);
    let list;
    try { list = await (await window.croweCloud.call("/v1/voices")).json(); } catch (e) {
      if (e.status === 401) { say("Sign in to hear the natural voice", "note"); return; }
      return fallback(said);
    }
    // The cloned "michael" voice is retired; never request it even if a server still lists it.
    const allowed = (list.voices || []).map((v) => v.id).filter((id) => id && id !== "michael");
    if (!allowed.length) return fallback(said);
    let pick = ""; try { pick = localStorage.getItem("crowe-cloud-voice") || ""; } catch { /* storage refused */ }
    const voice = allowed.includes(pick) ? pick : allowed.includes(list.default) ? list.default : allowed[0];
    const text = said.innerText.slice(0, list.max_chars || 1500);
    lit(true); say("Reading", "running");
    let r;
    try {
      r = await window.croweCloud.call("/v1/speech", { method: "POST", body: JSON.stringify({ text, voice }) });
    } catch (e) { stop(); say(e.message || "Could not read aloud", "error"); return; }
    const spoke = r.headers.get("x-crowe-voice") || voice, chars = r.headers.get("x-crowe-chars") || String(text.length);
    if (window.crowe.diag && window.crowe.diag.note) window.crowe.diag.note("speech", `${spoke} · ${chars} chars`);
    const blob = await r.blob();
    player = new Audio(URL.createObjectURL(blob));
    player.onended = () => { stop(); say("Ready"); };
    player.onerror = () => { stop(); say("Playback failed", "error"); };
    try { await player.play(); } catch (e) { stop(); say("Playback blocked: " + String(e.message || e).slice(0, 60), "error"); }
  }

  // The Settings row writes this; anything unrecognised (including a stored
  // "michael" from before the cloned voice was retired) reads as "phone".
  function replyVoice() {
    let v = "";
    try { v = localStorage.getItem("crowe-reply-voice") || ""; } catch { /* storage refused */ }
    return ["neural", "phone"].includes(v) ? v : "phone";
  }

  async function fallback(said) {
    // The person chose the phone's voice, or the cloud voice is out of reach.
    const text = said.innerText;
    if (native) {
      try { await native.speak({ text }); say("Reading", "running"); return; } catch { /* fall through to the web engine */ }
    }
    if (!window.speechSynthesis) { say("Read-aloud is not available here", "note"); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.onstart = () => lit(true);
    u.onend = () => lit(false);
    u.onerror = u.onend;
    speechSynthesis.speak(u);
  }

  btn.onclick = () => { speakLast().catch((e) => { stop(); say("Could not read aloud: " + String(e.message || e).slice(0, 60), "error"); }); };
  btn.title = "Read the last reply aloud";
})();
