(function () {
  "use strict";
  /* The phone's terminal, built the way a dedicated terminal app is: the paired
     computer is a host, a tap opens a shell on it, and the shell fills the
     screen at the phone's own size with the keys a phone keyboard lacks on a
     bar above it. Desktop terminals are listed beside the phone's own shells
     and can be watched, taken over and handed back, Control+G drafts included.

     Process ownership stays on the desktop. A shell this phone opened is its
     own: it starts with control, is sized to this screen, and only this phone
     can close it. A desktop terminal keeps the desktop's size and scrolls. */
  const transport = window.croweMirrorTransport;
  const uid = () => crypto.randomUUID();
  window.crowePhoneMirror = { mount };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const FONT_KEY = "mirror-font-size";
  function mount(body) {
    const root = document.createElement("section"); root.className = "phone-mirror"; root.dataset.screenName = "hosts";
    root.innerHTML = `<div class="mirror-hosts" data-hosts>
        <div class="mirror-heading"><strong>Terminal</strong><button type="button" class="mirror-icon" data-refresh aria-label="Refresh">Refresh</button></div>
        <div class="mirror-host" data-host-card>
          <div class="mirror-host-row"><i class="mirror-dot" data-host-dot aria-hidden="true"></i><div class="mirror-host-text"><b data-host-name>Your computer</b><span class="mirror-status" data-status role="status" aria-live="polite">Connecting to your paired machine</span></div></div>
          <button type="button" class="primary mirror-open" data-open disabled>New terminal</button>
          <p class="mirror-grant" data-grant hidden></p>
        </div>
        <h2 class="mirror-label">Sessions</h2>
        <div class="mirror-sessions" data-session-list role="list"><p class="mirror-empty">No terminals open yet.</p></div>
      </div>
      <div class="mirror-term" data-term hidden>
        <div class="mirror-bar">
          <button type="button" class="mirror-back" data-back aria-label="Back to sessions">Sessions</button>
          <b class="mirror-title" data-title>Terminal</b>
          <button type="button" class="mirror-icon" data-font="-1" aria-label="Smaller text">A&minus;</button>
          <button type="button" class="mirror-icon" data-font="1" aria-label="Larger text">A+</button>
          <button type="button" class="mirror-icon" data-close hidden aria-label="Close this shell">Close</button>
        </div>
        <div class="mirror-tabs" aria-label="Session views"><button type="button" data-view="terminal" aria-pressed="true">Terminal</button><button type="button" data-view="draft" aria-pressed="false">Draft</button><button type="button" data-view="review" aria-pressed="false">Review</button></div>
        <section data-panel="terminal" class="mirror-terminal-panel">
          <div class="mirror-screen-scroll" data-scroll><div class="mirror-screen" data-screen></div></div>
          <div class="mirror-controls" data-control-row><span data-owner>Viewing only</span><button type="button" data-control disabled>Take control</button></div>
          <div class="mirror-keys" data-keys hidden role="toolbar" aria-label="Terminal keys">
            <button type="button" data-key="escape">Esc</button><button type="button" data-key="tab">Tab</button><button type="button" data-ctrl aria-pressed="false">Ctrl</button>
            <button type="button" data-key="left" aria-label="Left">&larr;</button><button type="button" data-key="up" aria-label="Up">&uarr;</button><button type="button" data-key="down" aria-label="Down">&darr;</button><button type="button" data-key="right" aria-label="Right">&rarr;</button>
            <button type="button" data-key="interrupt" aria-label="Interrupt, Control C">^C</button><button type="button" data-key="edit" aria-label="Edit draft, Control G">^G</button>
            <button type="button" data-key="pipe">|</button><button type="button" data-key="slash">/</button><button type="button" data-key="tilde">~</button><button type="button" data-key="dash">-</button><button type="button" data-paste>Paste</button>
          </div>
        </section>
        <section data-panel="draft" hidden><label class="mirror-draft-label">CLI draft<textarea data-draft rows="8" disabled spellcheck="false" autocorrect="off" autocapitalize="off" aria-label="Shared CLI draft" placeholder="Open a draft with Control+G in the Crowe Logic CLI."></textarea></label>
          <div class="mirror-save-state" data-save-state>No open draft</div>
          <div class="mirror-draft-actions"><button type="button" data-save disabled>Save to host</button><button type="button" data-review disabled>Review changes</button></div>
        </section>
        <section data-panel="review" hidden><div class="mirror-review-label">Host revision</div><pre data-host-text></pre><div class="mirror-review-label">Your draft</div><pre data-local-text></pre>
          <div data-conflict hidden><p>The host changed. Choose which text to keep before saving.</p><button type="button" data-use-host>Use host version</button><button type="button" data-keep-local>Keep my version</button></div>
          <button type="button" data-return disabled>Save and return to session</button><p class="mirror-save-state">Returns to this session's waiting prompt. It does not submit it.</p>
        </section>
      </div>`;
    body.append(root);
    const $ = selector => root.querySelector(selector);
    let fontSize = 13;
    try { const saved = Number(localStorage.getItem(FONT_KEY)); if (saved >= 9 && saved <= 22) fontSize = saved; } catch { /* default */ }
    const terminal = new window.Terminal({ cols: 80, rows: 24, fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace", fontSize,
      scrollback: 1000, disableStdin: true, allowProposedApi: true, cursorBlink: true,
      theme: { background: "#0b0e12", foreground: "#eceae4", cursor: "#d2ad62", selectionBackground: "rgba(210,173,98,0.35)" } });
    terminal.open($("[data-screen]"));
    let sessions = [], selected = null, epoch = 0, seq = -1, connected = false, lease = null, deviceId = null, disposed = false, canOpen = false;
    let draft = null, hostDraft = null, draftKey = null, conflict = false, dirty = false, busy = false, polling = false, opening = false;
    let listTime = 0, renewTime = 0, inputQueue = Promise.resolve(), queuedInput = 0, pendingSave = null, pendingReturn = null, controlBusy = false;
    let persistQueue = Promise.resolve(), ctrlArmed = false, lastFit = "", heldBy = null;
    // Shells this phone opened; older desktops do not mark them in the list.
    const mineIds = new Set();
    const payload = () => ({ sessionId: selected?.id, generation: selected?.generation });
    const own = () => selected?.origin === "phone" && selected?.mine;
    function status(text) { $("[data-status]").textContent = text; if (root.dataset.screenName === "term") $("[data-owner]").textContent = text; }
    // Terminal access is granted on the computer, so the phone can only say
    // where: it names this phone as the computer knows it.
    let deviceName = "this phone", hostLabel = "the computer";
    function needsGrant(result) {
      if (!result?.needsGrant) return false;
      showGrant(false); return true;
    }
    function showGrant(on) {
      $("[data-grant]").hidden = on;
      $("[data-grant]").textContent = `Terminal access is off for ${deviceName}. On ${hostLabel}, open Crowe Logic, then Settings, Phone, and tick Terminal beside ${deviceName}.`;
    }

    // ── Sizing ──
    // A phone shell is fitted to the screen; the desktop's terminals keep the
    // desktop's size, since resizing them would reflow the operator's window.
    function cell() {
      const probe = document.createElement("span");
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:${terminal.options.fontFamily};font-size:${fontSize}px;line-height:normal`;
      probe.textContent = "W".repeat(20); document.body.append(probe);
      const r = probe.getBoundingClientRect(); probe.remove();
      return { w: r.width / 20 || fontSize * 0.6, h: Math.ceil(fontSize * 1.2) };
    }
    function fitted() {
      const box = $("[data-scroll]").getBoundingClientRect(); const c = cell();
      const cols = Math.max(20, Math.min(300, Math.floor((box.width - 16) / c.w)));
      const rows = Math.max(5, Math.min(120, Math.floor((box.height - 16) / c.h)));
      return { cols, rows };
    }
    async function fitOwn() {
      if (!own() || lease === null || !connected) return;
      const { cols, rows } = fitted(); const key = `${cols}x${rows}`;
      if (key === lastFit || (cols === terminal.cols && rows === terminal.rows)) { lastFit = key; return; }
      lastFit = key;
      const result = await transport.call("/sessions/resize", { ...payload(), lease, cols, rows });
      if (result.error) lastFit = "";
    }
    function sizeScreen() {
      $("[data-screen]").style.width = own() ? "100%" : `${Math.ceil(terminal.cols * cell().w + 16)}px`;
    }

    function controls() {
      terminal.options.disableStdin = !connected || lease === null;
      $("[data-control]").disabled = !connected || !selected || controlBusy;
      $("[data-control]").textContent = lease === null ? "Take control" : "Release";
      $("[data-control]").hidden = own() && lease !== null;
      $("[data-keys]").hidden = !connected || lease === null;
      $("[data-close]").hidden = !own();
      $("[data-ctrl]").setAttribute("aria-pressed", String(ctrlArmed));
      $("[data-open]").disabled = !canOpen || opening;
      const editable = draft?.status === "editing";
      $("[data-draft]").disabled = !editable || busy;
      $("[data-save]").disabled = !editable || !connected || busy || conflict;
      $("[data-review]").disabled = !editable;
      $("[data-return]").disabled = !editable || !connected || busy || conflict;
      $("[data-conflict]").hidden = !conflict;
      $("[data-host-text]").textContent = !editable ? "No open draft" : hostDraft.text || "Empty draft";
      $("[data-local-text]").textContent = $("[data-draft]").value;
      $("[data-save-state]").textContent = !editable ? "No open draft. Press Control+G in the Crowe Logic CLI." : conflict ? "Conflict · local text preserved" : dirty ? "Local changes · not saved to host" : `Revision ${draft.revision} · saved on host`;
      root.querySelector('[data-view="draft"]').classList.toggle("has-draft", editable);
    }
    function view(name) {
      root.querySelectorAll("[data-panel]").forEach(el => { el.hidden = el.dataset.panel !== name; });
      root.querySelectorAll("[data-view]").forEach(el => el.setAttribute("aria-pressed", String(el.dataset.view === name)));
      controls();
    }
    function screen(name) {
      root.dataset.screenName = name;
      $("[data-hosts]").hidden = name !== "hosts"; $("[data-term]").hidden = name !== "term";
      if (name === "hosts") renderList();
    }
    function persist() {
      if (!draftKey || !draft) return;
      const key = draftKey, value = { text: $("[data-draft]").value, revision: draft.revision, dirty };
      persistQueue = persistQueue.then(() => transport.storage.set(key, value)).then(ok => { if (!ok && key === draftKey) status("Local storage failed. Keep this editor open and copy your draft."); });
    }

    // ── Host and session list ──
    function renderList() {
      const list = $("[data-session-list]");
      if (!sessions.length) { list.innerHTML = `<p class="mirror-empty">${canOpen ? "No terminals open yet. Tap New terminal." : "Open a terminal in Crowe Logic on your computer, then refresh."}</p>`; return; }
      list.innerHTML = sessions.map(s => {
        const mine = s.origin === "phone" && s.mine;
        const who = s.controller ? (s.controller.deviceId === deviceId ? "You have control" : `Controlled by ${esc(s.controller.name)}`) : mine ? "This phone" : "On the desktop";
        return `<button type="button" class="mirror-session" role="listitem" data-session-row="${esc(s.id)}">
          <span class="mirror-session-glyph" aria-hidden="true">&gt;_</span>
          <span class="mirror-session-text"><b>${esc(s.label)}</b><small>${esc(s.cwd)} · ${who}</small></span><i class="m-chev" aria-hidden="true"></i></button>`;
      }).join("");
      list.querySelectorAll("[data-session-row]").forEach(row => { row.onclick = () => select(sessions.find(s => s.id === row.dataset.sessionRow)); });
    }
    async function refresh() {
      const result = await transport.call("/sessions/list");
      if (disposed) return;
      $("[data-host-dot]").classList.toggle("on", !result.error);
      if (result.error) { connected = false; lease = null; canOpen = false; status(result.error); controls(); renderList(); return; }
      deviceId = result.data.deviceId; listTime = Date.now(); canOpen = Boolean(result.data.canOpen);
      if (result.data.host) { $("[data-host-name]").textContent = result.data.host; hostLabel = result.data.host; }
      if (result.data.device) deviceName = result.data.device;
      // Older desktops send no grant field; they gate on their own terms.
      showGrant(result.data.terminal !== false);
      sessions = result.data.sessions.map(s => ({ ...s, mine: Boolean(s.mine) || mineIds.has(s.id) }));
      if (selected && !sessions.some(s => s.id === selected.id && s.generation === selected.generation)) {
        persist(); epoch++; selected = null; connected = false; lease = null; draft = null; terminal.reset();
        if (root.dataset.screenName === "term") screen("hosts");
        status("The session ended. Your local draft is preserved.");
      } else if (!selected) status(result.data.terminal === false ? "Paired. Terminal access is off." : canOpen ? "Connected. Open a terminal or pick a session." : sessions.length ? "Pick a session to watch or take over." : "Open a terminal in Crowe Logic on your computer, then refresh.");
      controls(); renderList();
    }

    function select(meta, { take = false } = {}) {
      if (!meta) return;
      persist();
      const release = selected && lease !== null && selected.id !== meta.id ? { ...payload(), lease } : null;
      epoch++; seq = -1; lease = null; draft = hostDraft = null; draftKey = null; dirty = conflict = busy = controlBusy = false;
      pendingSave = pendingReturn = null; connected = false; lastFit = ""; ctrlArmed = false; heldBy = null;
      selected = { id: meta.id, generation: meta.generation, origin: meta.origin, mine: meta.mine || mineIds.has(meta.id), label: meta.label };
      $("[data-title]").textContent = meta.label || "Terminal";
      terminal.reset(); $("[data-draft]").value = ""; screen("term"); view("terminal"); controls();
      if (release) transport.call("/sessions/release", release).catch(() => {});
      if (take || (own() && meta.controller === null)) takeControl(); else poll();
    }
    async function takeControl() {
      if (!selected || controlBusy) return;
      const request = { ...payload(), lease: null }, currentEpoch = epoch;
      controlBusy = true; controls();
      try {
        const result = await transport.call("/sessions/control", request);
        if (disposed || epoch !== currentEpoch) return;
        if (result.error) { needsGrant(result); status(result.error); return; }
        lease = result.data.controller?.deviceId === deviceId ? result.data.controller.lease : null;
        if (lease !== null) terminal.focus();
      } finally { if (epoch === currentEpoch) { controlBusy = false; controls(); poll(); } }
    }
    async function openShell() {
      if (opening || !canOpen) return;
      opening = true; controls(); status("Opening a shell on your computer");
      try {
        // Size it for the terminal screen the shell will live in.
        screen("term"); view("terminal"); const size = fitted(); screen("hosts");
        const result = await transport.call("/sessions/open", size);
        if (disposed) return;
        if (result.error) { needsGrant(result); status(result.error); return; }
        const meta = result.data; mineIds.add(meta.id);
        await refresh();
        select({ ...meta, mine: true });
        lease = meta.controller?.lease ?? null; controls(); terminal.focus();
      } finally { opening = false; controls(); }
    }

    async function readDraft(meta, currentEpoch) {
      if (!meta || meta.status !== "editing") { draft = null; controls(); return; }
      if (draft?.id === meta.id && hostDraft?.revision === meta.revision) return;
      const result = await transport.call("/draft/get", { ...payload(), draftId: meta.id });
      if (disposed || epoch !== currentEpoch || result.error) return;
      const host = result.data; hostDraft = host;
      if (draft?.id !== host.id) {
        draftKey = `mirror-draft:${selected.generation}:${host.id}`;
        const local = await transport.storage.get(draftKey);
        if (disposed || epoch !== currentEpoch) return;
        draft = { ...host, revision: local?.dirty ? local.revision : host.revision };
        $("[data-draft]").value = local?.dirty ? local.text : host.text;
        dirty = Boolean(local?.dirty); conflict = dirty && local.revision !== host.revision;
        pendingSave = pendingReturn = null;
      } else if (dirty || busy) conflict = draft.revision !== host.revision;
      else { draft = host; $("[data-draft]").value = host.text; conflict = false; }
      controls();
    }
    async function poll() {
      if (disposed || document.hidden || !root.isConnected || !root.getClientRects().length || polling) return;
      if (!selected) { if (Date.now() - listTime > 5000) await refresh(); return; }
      polling = true; const currentEpoch = epoch;
      try {
        // Held on the desktop until output lands, so a keystroke echoes in a
        // round trip. The first poll of a session returns at once.
        const result = await transport.call("/sessions/poll", { ...payload(), after: seq, wait: connected && seq >= 0 ? 4000 : 0 });
        if (disposed || epoch !== currentEpoch) return;
        if (result.error) { connected = false; lease = null; status(result.error); controls(); if (result.status === 410) await refresh(); return; }
        const value = result.data;
        connected = true; heldBy = value.controller; lease = value.controller?.deviceId === deviceId ? value.controller.lease : null;
        $("[data-owner]").textContent = value.controller ? (value.controller.deviceId === deviceId ? "You have control" : `Control: ${value.controller.name}`) : own() ? "Tap Take control to type" : "Viewing only";
        if (value.snapshot !== null) {
          terminal.reset(); terminal.resize(value.cols, value.rows);
          await new Promise(resolve => terminal.write(value.snapshot, resolve));
        } else for (const event of value.events) {
          if (event.seq !== seq + 1) { seq = -1; return; }
          if (event.type === "resize") terminal.resize(event.cols, event.rows);
          else await new Promise(resolve => terminal.write(event.data, resolve));
          seq = event.seq;
        }
        if (disposed || epoch !== currentEpoch) return;
        seq = value.seq;
        sizeScreen();
        await readDraft(value.draft, currentEpoch);
        if (disposed || epoch !== currentEpoch) return;
        if (lease !== null && Date.now() - renewTime > 5000) {
          const renewed = await transport.call("/sessions/renew", { ...payload(), lease });
          if (disposed || epoch !== currentEpoch) return;
          if (renewed.error) lease = null; renewTime = Date.now();
        }
        controls();
        fitOwn();
      } catch (error) { connected = false; lease = null; status(error.message); controls(); }
      finally {
        polling = false;
        if (!disposed && selected && connected && epoch === currentEpoch && !document.hidden) setTimeout(poll, 0);
      }
    }
    async function saveDraft(returning) {
      if (!draft || busy || !connected || conflict) return;
      busy = true; controls(); const currentEpoch = epoch; const text = $("[data-draft]").value;
      try {
        if (dirty) {
          if (!pendingSave || pendingSave.text !== text || pendingSave.baseRevision !== draft.revision) pendingSave = { ...payload(), draftId: draft.id, text, baseRevision: draft.revision, operationId: uid() };
          const result = await transport.call("/draft/save", pendingSave);
          if (epoch !== currentEpoch) return;
          if (result.error) { if (result.current) { hostDraft = result.current; conflict = true; } status(result.error); return; }
          draft = hostDraft = result.data; dirty = conflict = false; pendingSave = null; persist();
        }
        if (returning) {
          pendingReturn ||= { ...payload(), draftId: draft.id, baseRevision: draft.revision, operationId: uid() };
          const result = await transport.call("/draft/return", pendingReturn);
          if (epoch !== currentEpoch) return;
          if (result.error) { if (result.current) { hostDraft = result.current; conflict = true; } status(result.error); return; }
          draft = result.data; pendingReturn = null; status("Draft returned to the CLI. It has not been submitted."); view("terminal");
        } else status("Draft saved on the desktop.");
      } finally { if (epoch === currentEpoch) { busy = false; controls(); } }
    }
    function sendInput(data) {
      if (!connected || lease === null) return;
      // Ctrl on the key bar applies to the next key typed, as on a hardware
      // keyboard: Ctrl then c is an interrupt.
      if (ctrlArmed && data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
        ctrlArmed = false; controls();
      }
      if (queuedInput + data.length > 16384) { status("Input queue is full. Wait before typing again."); return; }
      const request = { ...payload(), lease, inputId: uid(), data }; const currentEpoch = epoch;
      queuedInput += data.length;
      inputQueue = inputQueue.then(async () => {
        if (!connected || epoch !== currentEpoch || lease !== request.lease) return;
        const result = await transport.call("/sessions/input", request);
        if (epoch === currentEpoch && result.error) { lease = null; status(`${result.error} Input was not retried.`); controls(); }
      }).catch(error => { lease = null; status(error.message); controls(); }).finally(() => { queuedInput -= data.length; });
    }
    terminal.onData(sendInput);
    $("[data-refresh]").onclick = refresh;
    $("[data-open]").onclick = openShell;
    // Leaving a session hands it back; the shell keeps running on the desktop
    // and its row stays in the list to return to.
    $("[data-back]").onclick = () => {
      persist();
      if (selected && lease !== null) transport.call("/sessions/release", { ...payload(), lease }).catch(() => {});
      epoch++; selected = null; lease = null; connected = false; heldBy = null; draft = null; terminal.reset();
      screen("hosts"); refresh();
    };
    $("[data-control]").onclick = async () => {
      if (!selected || controlBusy) return;
      if (lease === null) return takeControl();
      const request = { ...payload(), lease }, currentEpoch = epoch;
      controlBusy = true; controls();
      try {
        const result = await transport.call("/sessions/release", request);
        if (disposed || epoch !== currentEpoch) return;
        if (result.error) status(result.error); else lease = null;
      } finally { if (epoch === currentEpoch) { controlBusy = false; controls(); } }
    };
    // Tapping the screen of a session nobody else holds takes it, the way a
    // terminal app focuses on touch; the keyboard follows.
    $("[data-screen]").addEventListener("click", () => {
      if (lease !== null) terminal.focus();
      else if (connected && !controlBusy && !heldBy) takeControl();
    });
    $("[data-close]").onclick = async () => {
      if (!own()) return;
      const result = await transport.call("/sessions/close", payload());
      if (result.error) { status(result.error); return; }
      mineIds.delete(selected.id); epoch++; selected = null; lease = null; connected = false; terminal.reset();
      screen("hosts"); refresh();
    };
    root.querySelectorAll("[data-font]").forEach(button => { button.onclick = () => {
      fontSize = Math.max(9, Math.min(22, fontSize + Number(button.dataset.font)));
      terminal.options.fontSize = fontSize; try { localStorage.setItem(FONT_KEY, String(fontSize)); } catch { /* fine */ }
      lastFit = ""; sizeScreen(); fitOwn();
    }; });
    const keys = { escape: "\u001b", tab: "\t", up: "\u001b[A", down: "\u001b[B", right: "\u001b[C", left: "\u001b[D", edit: "\u0007", interrupt: "\u0003",
      pipe: "|", slash: "/", tilde: "~", dash: "-" };
    // Keys on the bar must not take focus from the terminal, or the keyboard
    // drops every time one is pressed.
    root.querySelectorAll("[data-keys] button").forEach(button => button.addEventListener("pointerdown", e => e.preventDefault()));
    root.querySelectorAll("[data-key]").forEach(button => { button.onclick = () => { sendInput(keys[button.dataset.key]); terminal.focus(); }; });
    $("[data-ctrl]").onclick = () => { ctrlArmed = !ctrlArmed; controls(); terminal.focus(); };
    $("[data-paste]").onclick = async () => {
      try { const text = await navigator.clipboard.readText(); if (text) sendInput(text.slice(0, 16384)); } catch { status("Paste needs permission to read the clipboard."); }
      terminal.focus();
    };
    root.querySelectorAll("[data-view]").forEach(button => { button.onclick = () => view(button.dataset.view); });
    $("[data-draft]").oninput = () => { dirty = true; pendingSave = pendingReturn = null; persist(); controls(); };
    $("[data-review]").onclick = () => view("review");
    $("[data-save]").onclick = () => saveDraft(false);
    $("[data-return]").onclick = () => saveDraft(true);
    $("[data-use-host]").onclick = () => { draft = { ...hostDraft }; $("[data-draft]").value = hostDraft.text; dirty = conflict = false; pendingSave = pendingReturn = null; persist(); controls(); };
    $("[data-keep-local]").onclick = () => { draft = { ...hostDraft }; dirty = true; conflict = false; pendingSave = pendingReturn = null; persist(); controls(); };
    // Back from the lock screen, the phone's own shell is taken again without
    // asking; a desktop terminal goes back to watching.
    const visibility = () => {
      if (document.hidden) { persist(); lease = null; controls(); return; }
      seq = -1;
      if (own()) takeControl(); else poll();
    };
    document.addEventListener("visibilitychange", visibility);
    const onResize = () => { lastFit = ""; fitOwn(); };
    window.addEventListener("resize", onResize);
    const timer = setInterval(poll, 350);
    const observer = new MutationObserver(() => { if (!root.isConnected) dispose(); }); observer.observe(body.parentNode, { childList: true, subtree: true });
    function dispose() { if (disposed) return; disposed = true; epoch++; persist(); clearInterval(timer); observer.disconnect(); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("resize", onResize); terminal.dispose(); }
    screen("hosts"); refresh(); controls();
    return { dispose, select: id => select(sessions.find(s => s.id === id)) };
  }
})();
