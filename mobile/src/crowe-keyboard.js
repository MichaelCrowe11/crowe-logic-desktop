(function () {
  "use strict";
  /* The Crowe Logic keyboard: the terminal's own keyboard, drawn in the app
     in place of the phone's. A shell wants keys a phone keyboard buries or
     lacks (Esc, Tab, Control, arrows, the pipe and the tilde) and none of what
     it adds (autocorrect, capitals after a full stop, smart quotes), so the
     terminal row sits above the letters and the symbol pages are laid out for
     commands rather than prose.

     Above it, a strip of the commands typed here before, one tap to type
     again, never to run: return is always the operator's own key. The mic
     key listens on this iPhone (CroweSpeech) and shows what it heard for
     review before anything reaches the shell.

     The space bar is also a trackpad: drag along it to move the cursor. */
  const STARTERS = ["ls", "cd ..", "git status", "clear"];
  const PAGES = {
    abc: [["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"], ["a", "s", "d", "f", "g", "h", "j", "k", "l"], ["shift", "z", "x", "c", "v", "b", "n", "m", "back"]],
    num: [["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"], ["-", "/", ":", ";", "(", ")", "$", "&", "@", "\""], ["sym", ".", ",", "?", "!", "'", "back"]],
    sym: [["[", "]", "{", "}", "#", "%", "^", "*", "+", "="], ["_", "\\", "|", "~", "<", ">", "`", "'", "\"", "."], ["num", ".", ",", "?", "!", "'", "back"]],
  };
  const SEQ = { esc: "\u001b", tab: "\t", left: "\u001b[D", up: "\u001b[A", down: "\u001b[B", right: "\u001b[C", intr: "\u0003", back: "\u007f", enter: "\r" };
  const REPEATS = new Set(["back", "left", "right", "up", "down"]);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = {
    mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
    globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 2.6 14.6 0 17M12 3.5c-2.6 2.4-2.6 14.6 0 17"/></svg>',
    hide: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10l6 6 6-6"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11v12H9l-6-6z"/><path d="M12.5 9.5l5 5M17.5 9.5l-5 5"/></svg>',
    shift: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l8 8h-4.5v7h-7v-7H4z"/></svg>',
    enter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6v6H6M10 8l-4 4 4 4"/></svg>',
  };

  // Speech arrives as prose: "Git status." A shell wants "git status". The
  // closing full stop goes, and a leading capital the recogniser added to an
  // ordinary word comes off; acronyms and paths are left as heard.
  function forShell(text) {
    let t = String(text || "").replace(/[\x00-\x1f\x7f-\x9f\s]+/g, " ").trim().replace(/[.!?]+$/, "");
    t = t.replace(/^([A-Z])([a-z]+\b)/, (_m, a, b) => a.toLowerCase() + b);
    return t;
  }

  // One recogniser serves both surfaces. Hold its lease through pending start
  // and stop calls, and remove this attempt's listeners before another starts.
  function captureSpeech(Speech, kind, { partial, stopped, error }) {
    if (window.__croweSpeechOwner) return null;
    const owner = { kind, id: `speech-${Date.now()}-${Math.random().toString(36).slice(2)}` };
    window.__croweSpeechOwner = owner;
    let cancelled = false, started = false, cleanup = null;
    const handles = [];
    const current = d => !cancelled && window.__croweSpeechOwner === owner && d?.sessionId === owner.id;
    const ready = Promise.resolve().then(async () => {
      handles.push(await Speech.addListener("partialResults", d => { if (current(d)) partial(d); }));
      handles.push(await Speech.addListener("listeningState", d => {
        if (current(d) && d.status === "stopped") { started = false; stopped(); void stop(); }
      }));
      if (cancelled) return;
      const perm = await Speech.requestPermissions();
      if (cancelled) return;
      if (perm.speechRecognition !== "granted") throw new Error("Allow the microphone and speech recognition in Settings.");
      const avail = await Speech.available();
      if (cancelled) return;
      if (!avail.available) throw new Error("Speech recognition is not available on this phone right now.");
      if (!avail.sessionIds) throw new Error("Update the iPhone app to use safe terminal dictation.");
      started = true;
      await Speech.start({ language: "en-US", partialResults: true, sessionId: owner.id });
    }).catch(e => { if (!cancelled) error(e); void stop(); }).finally(() => { if (cancelled) return; if (!started) void stop(); });
    function stop() {
      cancelled = true;
      cleanup ||= Promise.resolve().then(async () => {
        await ready;
        if (started) { try { await Speech.stop({ sessionId: owner.id }); } catch { /* callbacks remain invalid */ } }
        for (const handle of handles) { try { await handle.remove(); } catch { /* callbacks remain invalid */ } }
        if (window.__croweSpeechOwner === owner) window.__croweSpeechOwner = null;
      });
      return cleanup;
    }
    return { stop };
  }

  function create(host, { send, paste, onSystem, onHide, status = () => {} } = {}) {
    const el = document.createElement("div");
    el.className = "crowe-kb"; el.setAttribute("role", "group"); el.setAttribute("aria-label", "Crowe Logic keyboard");
    host.append(el);
    let page = "abc", shift = 0, ctrl = false, line = "", lineKnown = true, history = [];
    let listening = false, heard = "", reviewing = false, capture = null, revision = 0, destroyed = false;
    const Speech = window.Capacitor?.Plugins?.CroweSpeech;
    const native = Boolean(Speech && window.Capacitor?.isNativePlatform?.());

    function out(data) {
      if (ctrl && data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) { data = String.fromCharCode(code - 64); lineKnown = false; }
        ctrl = false;
      }
      send(data);
    }
    function typed(text) {
      // What is on the line, as far as this keyboard can tell, so the strip
      // can remember a command once return is pressed. Arrows and control
      // keys make it unknowable, and then nothing is remembered.
      line += text; out(text);
    }
    function commit() {
      const cmd = line.trim();
      if (lineKnown && cmd.length > 1) history = [cmd, ...history.filter(x => x !== cmd)].slice(0, 30);
      line = ""; lineKnown = true;
    }
    function act(key) {
      if (destroyed) return;
      if (key === "shift") { shift = shift === 0 ? 1 : shift === 1 ? 2 : 0; return render(); }
      if (key === "num" || key === "sym" || key === "abc") { page = key; shift = 0; return render(); }
      if (key === "ctrl") { ctrl = !ctrl; return render(); }
      if (key === "space") return typed(" ");
      if (key === "enter") { out(SEQ.enter); commit(); return render(); }
      if (key === "back") { line = Array.from(line).slice(0, -1).join(""); return out(SEQ.back); }
      if (key === "intr" || key === "esc") { line = ""; lineKnown = true; return out(SEQ[key]); }
      if (key === "tab" || key in SEQ) { lineKnown = false; return out(SEQ[key]); }
      if (key === "mic") return listen();
      if (key === "system") { lineKnown = false; return onSystem?.(); }
      if (key === "hide") return onHide?.();
      if (key === "paste") { lineKnown = false; return paste?.(); }
      if (key.length === 1) {
        const ch = page === "abc" && shift ? key.toUpperCase() : key;
        if (ctrl) { lineKnown = false; out(ch); }
        else typed(ch);
        if (shift === 1) { shift = 0; render(); }
        else if (ctrl === false && el.classList.contains("ctrl")) render();
        return;
      }
    }

    // ── Voice ──
    function cancelSpeech() {
      stopHold();
      revision++; const old = capture; capture = null;
      listening = reviewing = false; heard = "";
      if (old) void old.stop();
      if (!destroyed) render();
    }
    async function listen() {
      if (destroyed || document.hidden) return;
      if (!native) { status("Speaking a command needs the Crowe Logic iPhone app."); return; }
      if (listening) {
        const old = capture; capture = null; listening = false;
        await old?.stop(); if (!destroyed) render(); return;
      }
      const attempt = ++revision;
      const active = () => !destroyed && revision === attempt;
      const next = captureSpeech(Speech, "terminal", {
        partial: d => {
          if (!active()) return;
          heard = Array.isArray(d.matches) && d.matches.length ? forShell(String(d.matches[0])) : heard;
          renderStrip();
        },
        stopped: () => { if (active()) { listening = false; render(); } },
        error: e => { if (active()) { listening = false; status(`Listening failed: ${String(e?.message || e).slice(0, 120)}`); render(); } },
      });
      if (!next) { status("Finish the current dictation before starting another."); return; }
      capture = next; heard = ""; reviewing = listening = true; render();
    }
    async function endReview(type) {
      const attempt = ++revision, text = heard, old = capture;
      capture = null; listening = reviewing = false; heard = ""; render();
      await old?.stop();
      if (destroyed || revision !== attempt || document.hidden) return;
      if (type && text) { ctrl = false; typed(text); }
      render();
    }
    const onVisibility = () => { if (document.hidden) cancelSpeech(); };
    document.addEventListener("visibilitychange", onVisibility);

    // ── Drawing ──
    function keyHtml(key) {
      const shiftOn = page === "abc" && shift;
      const special = { shift: icon.shift, back: icon.back, num: "123", sym: "#+=", abc: "ABC" };
      if (key in special) {
        const label = { shift: shift === 2 ? "Caps lock on" : "Shift", back: "Delete", num: "Numbers", sym: "Symbols", abc: "Letters" }[key];
        const pressed = key === "shift" ? ` aria-pressed="${shift > 0}"` : "";
        return `<button type="button" class="ck-key ck-fn ck-${key}${key === "shift" && shift === 2 ? " ck-lock" : ""}" data-kb-key="${key}" aria-label="${label}"${pressed}>${special[key]}</button>`;
      }
      const shown = shiftOn ? key.toUpperCase() : key;
      return `<button type="button" class="ck-key ck-char" data-kb-key="${esc(key)}" data-label="${esc(shown)}" aria-label="${esc(shown)}">${esc(shown)}</button>`;
    }
    function renderStrip() {
      const strip = el.querySelector("[data-kb-strip]"); if (!strip) return;
      if (reviewing) {
        strip.className = "ck-strip ck-voice";
        strip.innerHTML = `<span class="ck-voice-dot${listening ? " on" : ""}" aria-hidden="true"></span>
          <span class="ck-heard" data-kb-heard aria-live="polite">${heard ? esc(forShell(heard)) : listening ? "Listening" : "Nothing heard"}</span>
          <button type="button" class="ck-chip" data-kb-voice="cancel">Cancel</button>
          <button type="button" class="ck-chip ck-chip-go" data-kb-voice="type"${heard ? "" : " disabled"}>Type it</button>`;
        strip.querySelectorAll("[data-kb-voice]").forEach(b => { b.onclick = () => endReview(b.dataset.kbVoice === "type"); });
        return;
      }
      strip.className = "ck-strip";
      const chips = (history.length ? history : STARTERS).slice(0, 10);
      strip.innerHTML = `<button type="button" class="ck-chip ck-chip-quiet" data-kb-key="paste">Paste</button>` +
        chips.map(c => `<button type="button" class="ck-chip" data-kb-chip="${esc(c)}">${esc(c)}</button>`).join("");
      strip.querySelectorAll("[data-kb-chip]").forEach(b => {
        b.addEventListener("pointerdown", e => e.preventDefault());
        b.onclick = () => typed(b.dataset.kbChip);
      });
    }
    function render() {
      el.classList.toggle("ctrl", ctrl);
      const rows = PAGES[page];
      el.innerHTML = `<div data-kb-strip></div>
        <div class="ck-row ck-term">
          <button type="button" class="ck-key ck-t" data-kb-key="esc">Esc</button>
          <button type="button" class="ck-key ck-t" data-kb-key="tab">Tab</button>
          <button type="button" class="ck-key ck-t${ctrl ? " ck-on" : ""}" data-kb-key="ctrl" aria-pressed="${ctrl}">Ctrl</button>
          <button type="button" class="ck-key ck-t" data-kb-key="left" aria-label="Left">&larr;</button>
          <button type="button" class="ck-key ck-t" data-kb-key="up" aria-label="Up">&uarr;</button>
          <button type="button" class="ck-key ck-t" data-kb-key="down" aria-label="Down">&darr;</button>
          <button type="button" class="ck-key ck-t" data-kb-key="right" aria-label="Right">&rarr;</button>
          <button type="button" class="ck-key ck-t ck-intr" data-kb-key="intr" aria-label="Interrupt, Control C">^C</button>
          <button type="button" class="ck-key ck-t ck-icon" data-kb-key="hide" aria-label="Hide keyboard">${icon.hide}</button>
        </div>
        ${rows.map((row, i) => `<div class="ck-row${page === "abc" && i === 1 ? " ck-inset" : ""}">${row.map(keyHtml).join("")}</div>`).join("")}
        <div class="ck-row ck-bottom">
          <button type="button" class="ck-key ck-fn ck-page" data-kb-key="${page === "abc" ? "num" : "abc"}" aria-label="${page === "abc" ? "Numbers" : "Letters"}">${page === "abc" ? "123" : "ABC"}</button>
          <button type="button" class="ck-key ck-fn ck-icon" data-kb-key="system" aria-label="Use the iPhone keyboard">${icon.globe}</button>
          <button type="button" class="ck-key ck-fn ck-icon ck-mic${listening ? " ck-on" : ""}" data-kb-key="mic" aria-label="${listening ? "Stop listening" : "Speak a command"}" aria-pressed="${listening}">${icon.mic}</button>
          <button type="button" class="ck-key ck-space" data-kb-key="space" aria-label="Space. Drag to move the cursor">space</button>
          <button type="button" class="ck-key ck-enter" data-kb-key="enter" aria-label="Return">${icon.enter}<span>return</span></button>
        </div>`;
      renderStrip();
    }

    // ── Touch ──
    // Keys act on release, as the phone's own keyboard does, so a thumb that
    // slides off a key cancels it. Delete and the arrows repeat while held.
    // Nothing here takes focus, so the phone's keyboard never rises.
    let held = null;
    const stopHold = () => { if (held) { clearTimeout(held.wait); clearInterval(held.repeat); held.btn.classList.remove("down"); held = null; } };
    el.addEventListener("pointerdown", e => {
      const btn = e.target.closest("[data-kb-key]"); if (!btn) return;
      e.preventDefault(); stopHold();
      const key = btn.dataset.kbKey;
      btn.classList.add("down");
      held = { btn, key, x: e.clientX, moved: false, step: 0 };
      try { btn.setPointerCapture(e.pointerId); } catch { /* synthetic events in tests */ }
      if (REPEATS.has(key)) {
        act(key); held.fired = true;
        held.wait = setTimeout(() => { if (held) held.repeat = setInterval(() => act(key), 70); }, 380);
      }
    });
    el.addEventListener("pointermove", e => {
      if (!held || held.key !== "space") return;
      // Trackpad: every 12 pixels along the space bar is one cursor step.
      const steps = Math.trunc((e.clientX - held.x) / 12);
      while (held.step < steps) { held.step++; held.moved = true; lineKnown = false; out(SEQ.right); }
      while (held.step > steps) { held.step--; held.moved = true; lineKnown = false; out(SEQ.left); }
    });
    el.addEventListener("pointerup", e => {
      const h = held; stopHold(); if (!h) return;
      if (h.fired || h.moved) return;
      const over = document.elementFromPoint?.(e.clientX, e.clientY);
      if (over && !h.btn.contains(over) && e.isTrusted) return;
      act(h.key);
    });
    el.addEventListener("pointercancel", stopHold);
    // Assistive technology activates with a click and no pointer.
    el.addEventListener("click", e => {
      const btn = e.target.closest("[data-kb-key]");
      if (btn && e.detail === 0 && !held) act(btn.dataset.kbKey);
    });

    render();
    return {
      el,
      cancelSpeech,
      invalidateLine() { lineKnown = false; },
      destroy() { destroyed = true; stopHold(); cancelSpeech(); document.removeEventListener("visibilitychange", onVisibility); el.remove(); },
      reset() { stopHold(); cancelSpeech(); line = ""; lineKnown = true; history = []; ctrl = false; shift = 0; render(); },
    };
  }
  window.croweKeyboard = { create, forShell, captureSpeech };
})();
