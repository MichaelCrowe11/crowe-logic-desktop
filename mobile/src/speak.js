/* Spoken replies through the gateway, for the phone.
 *
 * One file, no hook in the shell: it takes over the composer's speaker button
 * (#voice-output) from the renderer's speechSynthesis handler, which binds with
 * onclick so a reassignment replaces it cleanly. Voices come from
 * GET /api/gateway/speech/voices and audio from POST /api/gateway/speech
 * (control plane 0.2.20). Until that gateway is live the voices call 404s and
 * the system voice reads the reply exactly as before, so shipping this ahead of
 * the deploy costs nothing. The voice is the Settings row "Reply voice"
 * (localStorage crowe-reply-voice): "michael" when the plan allows it, "neural"
 * for the gateway's own voice, "phone" for the device's speech engine without a
 * gateway call. Each gateway read is noted in Diagnostics with the voice that
 * actually spoke and the characters it cost, from the X-Crowe-* headers.
 * Handed over by the gateway session on 2026-09-10; adapted here. */
(() => {
  const $ = (id) => document.getElementById(id);
  const btn = $("voice-output");
  if (!btn || !window.crowe || !window.crowe.getConfig) return;
  const say = (t, s) => { if (typeof setComposerStatus === "function") setComposerStatus(t, s); };

  let player = null;
  const stop = () => { if (player) { try { player.pause(); URL.revokeObjectURL(player.src); } catch { /* already gone */ } player = null; } btn.classList.remove("active"); btn.setAttribute("aria-pressed", "false"); };

  async function token() {
    // The bridge keeps the access token; auth.status() refreshes it when stale.
    const st = await window.crowe.auth.status();
    if (!st || !st.user) return null;
    const cfg = await window.crowe.getConfig();
    return { base: (cfg.baseUrl || "https://api.crowelogic.com").replace(/\/$/, ""), bearer: window.crowePhone && window.crowePhone.accessToken ? window.crowePhone.accessToken() : null, cfg };
  }

  async function voices(base, bearer) {
    const r = await fetch(`${base}/api/gateway/speech/voices`, { headers: { Authorization: `Bearer ${bearer}` } });
    if (!r.ok) throw new Error(`voices ${r.status}`);
    return r.json();
  }

  async function speakLast() {
    if (player) { stop(); say("Ready"); return; }
    const said = [...document.querySelectorAll(".msg.assistant .said")].pop();
    if (!said) { say("Nothing to read yet", "note"); return; }
    const preferred = replyVoice();
    if (preferred === "phone") return fallback(said);
    const t = await token();
    if (!t || !t.bearer) { say("Sign in to hear replies", "note"); return; }
    let list;
    try { list = await voices(t.base, t.bearer); } catch { return fallback(said); }
    const allowed = list.voices.filter((v) => v.allowed && v.configured).map((v) => v.voice);
    if (!allowed.length) return fallback(said);
    const voice = allowed.includes(preferred) ? preferred : allowed[0];
    const text = said.innerText.slice(0, list.max_chars || 1500);
    btn.classList.add("active"); btn.setAttribute("aria-pressed", "true"); say(voice === "michael" ? "Michael is reading" : "Reading", "running");
    const r = await fetch(`${t.base}/api/gateway/speech`, {
      method: "POST", headers: { Authorization: `Bearer ${t.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });
    if (!r.ok) { stop(); const d = await r.json().catch(() => ({})); say((d.detail && (d.detail.message || d.detail)) || `Could not read aloud (${r.status})`, "error"); return; }
    // What actually spoke, and what it cost: the gateway says so in headers.
    const spoke = r.headers.get("x-crowe-voice") || voice, fell = r.headers.get("x-crowe-fallback") || "", chars = r.headers.get("x-crowe-chars") || String(text.length);
    if (window.crowe.diag && window.crowe.diag.note) window.crowe.diag.note("speech", `${spoke}${fell ? " (asked " + voice + ", fell back: " + fell + ")" : ""} · ${chars} chars`);
    if (fell) say(spoke === "michael" ? "Michael is reading" : "Reading with the Crowe Logic voice", "running");
    const blob = await r.blob();
    player = new Audio(URL.createObjectURL(blob));
    player.onended = () => { stop(); say("Ready"); };
    player.onerror = () => { stop(); say("Playback failed", "error"); };
    try { await player.play(); } catch (e) { stop(); say("Playback blocked: " + String(e.message || e).slice(0, 60), "error"); }
  }

  // The Settings row writes this; anything unrecognised reads as "michael" so a
  // stale value never silences the button.
  function replyVoice() {
    let v = "";
    try { v = localStorage.getItem("crowe-reply-voice") || ""; } catch { /* storage refused */ }
    return ["michael", "neural", "phone"].includes(v) ? v : "michael";
  }

  function fallback(said) {
    // Older gateway, nothing configured, or the person chose the phone's own voice.
    if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
    speechSynthesis.speak(new SpeechSynthesisUtterance(said.innerText));
  }

  btn.onclick = () => { speakLast().catch((e) => { stop(); say("Could not read aloud: " + String(e.message || e).slice(0, 60), "error"); }); };
  btn.title = "Read the last reply aloud";
})();
