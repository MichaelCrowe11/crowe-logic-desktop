/* Spoken replies through the gateway, for the phone.
 *
 * One file, no hook in the shell: it takes over the composer's speaker button
 * (#voice-output) from the renderer's speechSynthesis handler, which binds with
 * onclick so a reassignment replaces it cleanly. Voices come from
 * GET /api/gateway/speech/voices and audio from POST /api/gateway/speech
 * (control plane 0.2.20). Until that gateway is live the voices call 404s and
 * the system voice reads the reply exactly as before, so shipping this ahead of
 * the deploy costs nothing. "michael" is chosen when the plan allows it, else
 * "neural"; a later Settings row can write config.replyVoice and this reads it.
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
    const t = await token();
    if (!t || !t.bearer) { say("Sign in to hear replies", "note"); return; }
    let list;
    try { list = await voices(t.base, t.bearer); } catch { return fallback(said); }
    const allowed = list.voices.filter((v) => v.allowed && v.configured).map((v) => v.voice);
    if (!allowed.length) return fallback(said);
    const preferred = (t.cfg && t.cfg.replyVoice) || "michael";
    const voice = allowed.includes(preferred) ? preferred : allowed[0];
    const text = said.innerText.slice(0, list.max_chars || 1500);
    btn.classList.add("active"); btn.setAttribute("aria-pressed", "true"); say(voice === "michael" ? "Michael is reading" : "Reading", "running");
    const r = await fetch(`${t.base}/api/gateway/speech`, {
      method: "POST", headers: { Authorization: `Bearer ${t.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });
    if (!r.ok) { stop(); const d = await r.json().catch(() => ({})); say((d.detail && (d.detail.message || d.detail)) || `Could not read aloud (${r.status})`, "error"); return; }
    const blob = await r.blob();
    player = new Audio(URL.createObjectURL(blob));
    player.onended = () => { stop(); say("Ready"); };
    player.onerror = () => { stop(); say("Playback failed", "error"); };
    try { await player.play(); } catch (e) { stop(); say("Playback blocked: " + String(e.message || e).slice(0, 60), "error"); }
  }

  function fallback(said) {
    // Older gateway or nothing configured: the system voice, as before.
    if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
    speechSynthesis.speak(new SpeechSynthesisUtterance(said.innerText));
  }

  btn.onclick = () => { speakLast().catch((e) => { stop(); say("Could not read aloud: " + String(e.message || e).slice(0, 60), "error"); }); };
  btn.title = "Read the last reply aloud";
})();
