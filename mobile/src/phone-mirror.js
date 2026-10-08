(function () {
  "use strict";
  /* The phone's terminal, built the way a dedicated terminal app is: the paired
     computer is a host, a tap opens a shell on it, and the shell fills the
     screen at the phone's own size, typed on the Crowe Logic keyboard
     (crowe-keyboard.js) rather than the phone's. Desktop terminals are listed beside the phone's own shells
     and can be watched, taken over and handed back, Control+G drafts included.

     Process ownership stays on the desktop. A shell this phone opened is its
     own: it starts with control, is sized to this screen, and only this phone
     can close it. A desktop terminal keeps the desktop's size and scrolls.

     Engines open shells of their own (the harness terminal_* tools); they are
     listed here as they work, can be watched live, taken over (the engine
     waits while this phone holds the keys) and handed back, or stopped. */
  const transport = window.croweMirrorTransport;
  const uid = () => crypto.randomUUID();
  window.crowePhoneMirror = { mount };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const FONT_KEY = "mirror-font-size";
  function mount(body) {
    const root = document.createElement("section"); root.className = "phone-mirror"; root.dataset.screenName = "hosts";
    root.innerHTML = `<div class="mirror-hosts" data-hosts>
        <div class="mirror-heading"><div><p class="mirror-eyebrow">Your workspace, with you</p><h1>Terminals</h1></div><button type="button" class="mirror-icon" data-refresh aria-label="Refresh sessions">Refresh</button></div>
        <div class="mirror-host" data-host-card>
          <div class="mirror-host-row"><i class="mirror-dot" data-host-dot aria-hidden="true"></i><div class="mirror-host-text"><b data-host-name>Your computer</b><span class="mirror-status" data-status role="status" aria-live="polite">Connecting to your paired machine</span></div></div>
          <button type="button" class="primary mirror-open" data-open disabled><span aria-hidden="true">+</span> New terminal</button>
          <p class="mirror-grant" data-grant hidden></p>
        </div>
        <div class="mirror-list-heading"><h2 class="mirror-label">Sessions</h2><span data-session-count class="mirror-count">0 open</span></div>
        <div class="mirror-sessions" data-session-list role="list"><p class="mirror-empty">No terminals open yet.</p></div>
        <p class="mirror-footnote">Work stays on your computer. Open a session to follow along or take the keys.</p>
      </div>
      <div class="mirror-term" data-term hidden>
        <div class="mirror-bar">
          <button type="button" class="mirror-back" data-back aria-label="Back to sessions"><span aria-hidden="true">&#8249;</span></button>
          <div class="mirror-identity"><span class="mirror-eyebrow" data-context>Desktop session</span><b class="mirror-title mirror-sr-only" data-title>Terminal</b><select class="mirror-switch" data-session-switch aria-label="Switch terminal"></select></div>
          <button type="button" class="mirror-icon mirror-new" data-new disabled aria-label="Open another terminal">+ New</button>
          <button type="button" class="mirror-icon" data-close hidden aria-label="Close this shell">Close</button>
        </div>
        <div class="mirror-toolbar"><div class="mirror-tabs" role="group" aria-label="Session views"><button type="button" data-view="terminal" aria-pressed="true">Terminal</button><button type="button" data-view="draft" aria-pressed="false">Draft</button><button type="button" data-view="review" aria-pressed="false">Review</button></div><div class="mirror-text-size" role="group" aria-label="Terminal text size"><button type="button" class="mirror-icon" data-font="-1" aria-label="Smaller terminal text">A&minus;</button><button type="button" class="mirror-icon" data-font="1" aria-label="Larger terminal text">A+</button></div></div>
        <div class="mirror-notice" data-notice hidden><span data-notice-text role="status" aria-live="polite"></span><button type="button" data-dismiss aria-label="Dismiss message">Dismiss</button></div>
        <section data-panel="terminal" class="mirror-terminal-panel">
          <div class="mirror-screen-scroll" data-scroll><div class="mirror-screen" data-screen></div></div>
          <div class="mirror-controls" data-control-row><span data-owner>Viewing only</span><button type="button" data-control disabled>Take control</button></div>
          <section class="mirror-paste" data-paste-review hidden aria-label="Review clipboard text"><label>Review paste<textarea data-paste-text readonly aria-label="Clipboard text" rows="3"></textarea></label><p>Line breaks become spaces. Return stays yours.</p><div><button type="button" data-paste-cancel>Cancel</button><button type="button" data-paste-type>Type text</button></div></section>
          <div class="mirror-keys" data-keys hidden></div>
          <button type="button" class="mirror-kb-show" data-kb-show hidden>Crowe keyboard</button>
        </section>
        <section data-panel="draft" class="mirror-editor" hidden><div class="mirror-editor-heading"><p class="mirror-eyebrow">Write with room to think</p><h2>Session draft</h2><p>Edit here, then return it to the waiting CLI prompt.</p></div><label class="mirror-draft-label">Draft text<textarea data-draft rows="8" disabled spellcheck="false" autocorrect="off" autocapitalize="off" aria-label="Shared CLI draft" placeholder="Open a draft with Control+G in the Crowe Logic CLI."></textarea></label>
          <div class="mirror-draft-meta"><span class="mirror-save-state" data-save-state role="status" aria-live="polite">No open draft</span><span data-draft-count class="mirror-count">0 words</span></div>
          <div class="mirror-draft-actions"><button type="button" data-save disabled>Save to host</button><button type="button" data-review disabled>Review changes</button></div>
        </section>
        <section data-panel="review" class="mirror-editor" hidden><div class="mirror-editor-heading"><p class="mirror-eyebrow">One last look</p><h2>Review your draft</h2><p>Compare with the host before returning to the session.</p></div><div class="mirror-review-card"><div class="mirror-review-label">Host revision</div><pre data-host-text></pre></div><div class="mirror-review-card is-local"><div class="mirror-review-label">Your draft</div><pre data-local-text></pre></div>
          <div data-conflict hidden><p>The host changed. Choose which text to keep before saving.</p><button type="button" data-use-host>Use host version</button><button type="button" data-keep-local>Keep my version</button></div>
          <div class="mirror-review-actions"><button type="button" data-return disabled>Save and return to session</button><p class="mirror-save-state">Returns to this session's waiting prompt. It does not submit it.</p></div>
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
    let persistQueue = Promise.resolve(), lastFit = "", heldBy = null, closing = false, refreshing = false, pasteReview = null;
    let activeView = "terminal", renderSignature = "", switchSignature = "";
    // Which keyboard types here: "crowe" (ours, drawn below the screen),
    // "system" (the phone's, by the globe key) or "hidden" (folded away).
    let keyboardMode = "crowe";
    // Shells this phone opened; older desktops do not mark them in the list.
    const mineIds = new Set();
    const payload = () => ({ sessionId: selected?.id, generation: selected?.generation });
    const own = () => selected?.origin === "phone" && selected?.mine;
    const engine = () => selected?.origin === "engine";
    function status(text) { $("[data-status]").textContent = text; if (root.dataset.screenName === "term") { $("[data-notice-text]").textContent = text; $("[data-notice]").hidden = false; } }
    function clearNotice() { $("[data-notice]").hidden = true; }
    function cancelPaste() { pasteReview = null; $("[data-paste-review]").hidden = true; $("[data-paste-text]").value = ""; }
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
      if (!own() || lease === null || !connected || activeView !== "terminal" || !root.getClientRects().length) return;
      const { cols, rows } = fitted(); const key = `${cols}x${rows}`;
      if (key === lastFit || (cols === terminal.cols && rows === terminal.rows)) { lastFit = key; return; }
      lastFit = key;
      const request = { ...payload(), lease, cols, rows }, currentEpoch = epoch;
      try {
        const result = await transport.call("/sessions/resize", request);
        if (!disposed && epoch === currentEpoch && result.error) lastFit = "";
      } catch { if (!disposed && epoch === currentEpoch) lastFit = ""; }
    }
    function sizeScreen() {
      $("[data-screen]").style.width = own() ? "100%" : `${Math.ceil(terminal.cols * cell().w + 16)}px`;
    }

    function controls() {
      if (!connected || lease === null || activeView !== "terminal") cancelPaste();
      terminal.options.disableStdin = !connected || lease === null;
      $("[data-control]").disabled = !connected || !selected || controlBusy;
      $("[data-control]").textContent = engine() ? (lease === null ? "Take over" : "Hand back") : lease === null ? "Take control" : "Release";
      $("[data-control]").hidden = own() && lease !== null;
      const typing = connected && lease !== null;
      if (!typing || keyboardMode !== "crowe" || controlBusy || pasteReview) keys?.cancelSpeech();
      $("[data-keys]").hidden = !typing || keyboardMode !== "crowe" || Boolean(pasteReview);
      $("[data-kb-show]").hidden = !typing || keyboardMode === "crowe" || Boolean(pasteReview);
      // The phone's keyboard rises only when it was asked for by the globe key.
      terminal.textarea?.setAttribute("inputmode", keyboardMode === "system" ? "text" : "none");
      $("[data-close]").hidden = !own() && !engine();
      $("[data-close]").disabled = !connected || closing;
      $("[data-close]").textContent = engine() ? "Stop" : "Close";
      $("[data-close]").setAttribute("aria-label", engine() ? "Stop this engine terminal" : "Close this shell");
      $("[data-open]").disabled = !canOpen || opening;
      $("[data-open]").setAttribute("aria-busy", String(opening));
      $("[data-new]").disabled = !canOpen || opening;
      $("[data-new]").setAttribute("aria-busy", String(opening));
      $("[data-refresh]").disabled = refreshing;
      $("[data-refresh]").setAttribute("aria-busy", String(refreshing));
      $("[data-font='-1']").disabled = fontSize <= 9;
      $("[data-font='1']").disabled = fontSize >= 22;
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
      const words = $("[data-draft]").value.trim().split(/\s+/u).filter(Boolean).length;
      $("[data-draft-count]").textContent = `${words} ${words === 1 ? "word" : "words"}`;
      $("[data-save-state]").dataset.state = conflict ? "conflict" : dirty ? "dirty" : "saved";
      renderSwitcher();
    }
    function renderSwitcher() {
      const choices = [...sessions];
      if (selected && !choices.some(s => s.id === selected.id)) choices.push(selected);
      const signature = JSON.stringify(choices.map(s => [s.id, s.generation, s.label]));
      const picker = $("[data-session-switch]");
      if (signature !== switchSignature) {
        picker.innerHTML = choices.map((s, i) => {
          const label = s.label || "Terminal";
          const duplicate = choices.filter(other => (other.label || "Terminal") === label).length > 1;
          return `<option value="${esc(s.id)}">${duplicate ? `${i + 1}. ` : ""}${esc(label)}</option>`;
        }).join("");
        switchSignature = signature;
      }
      picker.value = selected?.id || "";
      picker.disabled = !selected || choices.length < 2;
    }
    function view(name) {
      activeView = name; root.dataset.view = name;
      if (name !== "terminal") keys?.cancelSpeech();
      root.querySelectorAll("[data-panel]").forEach(el => { el.hidden = el.dataset.panel !== name; });
      root.querySelectorAll("[data-view]").forEach(el => el.setAttribute("aria-pressed", String(el.dataset.view === name)));
      controls();
      if (name === "terminal") { lastFit = ""; fitOwn(); }
    }
    function screen(name) {
      if (name !== "term") keys?.reset();
      root.dataset.screenName = name;
      $("[data-hosts]").hidden = name !== "hosts"; $("[data-term]").hidden = name !== "term";
      if (name === "hosts") renderList();
    }
    function persist() {
      if (!draftKey || !draft) return;
      const key = draftKey, value = { text: $("[data-draft]").value, revision: draft.revision, dirty };
      const failed = () => { if (!disposed && key === draftKey) status("Local storage failed. Keep this editor open and copy your draft."); };
      persistQueue = persistQueue.then(() => transport.storage.set(key, value)).then(ok => { if (!ok) failed(); }).catch(failed);
    }

    // ── Host and session list ──
    function renderList() {
      const list = $("[data-session-list]");
      $("[data-session-count]").textContent = `${sessions.length} open`;
      const signature = JSON.stringify([sessions, deviceId, canOpen]);
      if (signature === renderSignature) return;
      renderSignature = signature;
      const focused = document.activeElement?.dataset?.sessionRow;
      if (!sessions.length) { list.innerHTML = `<div class="mirror-empty" role="listitem"><span class="mirror-empty-mark" aria-hidden="true">&gt;_</span><strong>Room for your next task</strong><p>${canOpen ? "Open a terminal above to start on your computer." : "Open a terminal in Crowe Logic on your computer, then refresh."}</p></div>`; return; }
      list.innerHTML = sessions.map(s => {
        const mine = s.origin === "phone" && s.mine;
        const isEngine = s.origin === "engine";
        const who = s.controller ? (s.controller.deviceId === deviceId ? "You have control" : `Controlled by ${esc(s.controller.name)}`)
          : isEngine ? `${esc(s.openedBy || "Engine")} ${s.busy ? "is running a command" : "is working here"}` : mine ? "This phone" : "On the desktop";
        return `<div role="listitem"><button type="button" class="mirror-session${isEngine ? " is-engine" : ""}" data-session-row="${esc(s.id)}">
          <span class="mirror-session-glyph${isEngine && s.busy ? " live" : ""}" aria-hidden="true">${isEngine ? "&#9672;" : "&gt;_"}</span>
          <span class="mirror-session-text"><b>${esc(s.label)}</b><small class="mirror-session-path">${esc(s.cwd)}</small><span class="mirror-session-state${s.controller?.deviceId === deviceId ? " is-held" : ""}">${who}</span></span><span class="mirror-chevron" aria-hidden="true">&#8250;</span></button></div>`;
      }).join("");
      // Engines first: they are the shells that change while nobody watches.
      list.querySelectorAll("[data-session-row]").forEach(row => { row.onclick = () => select(sessions.find(s => s.id === row.dataset.sessionRow)); });
      if (focused) [...list.querySelectorAll("[data-session-row]")].find(row => row.dataset.sessionRow === focused)?.focus({ preventScroll: true });
    }
    async function refresh() {
      if (refreshing || disposed) return;
      refreshing = true; controls();
      try {
      const result = await transport.call("/sessions/list");
      if (disposed) return;
      $("[data-host-dot]").classList.toggle("on", !result.error);
      if (result.error) { connected = false; lease = null; canOpen = false; status(result.error); controls(); renderList(); return; }
      deviceId = result.data.deviceId; listTime = Date.now(); canOpen = Boolean(result.data.canOpen);
      if (result.data.host) { $("[data-host-name]").textContent = result.data.host; hostLabel = result.data.host; }
      if (result.data.device) deviceName = result.data.device;
      // Older desktops send no grant field; they gate on their own terms.
      showGrant(result.data.terminal !== false);
      const rank = s => s.origin === "engine" ? 0 : s.origin === "phone" ? 1 : 2;
      sessions = result.data.sessions.map(s => ({ ...s, mine: Boolean(s.mine) || mineIds.has(s.id) })).sort((a, b) => rank(a) - rank(b));
      if (selected && !sessions.some(s => s.id === selected.id && s.generation === selected.generation)) {
        persist(); epoch++; selected = null; connected = false; lease = null; draft = null; terminal.reset();
        if (root.dataset.screenName === "term") screen("hosts");
        status("The session ended. Your local draft is preserved.");
      } else if (!selected) status(result.data.terminal === false ? "Paired. Terminal access is off." : canOpen ? "Connected. Open a terminal or pick a session." : sessions.length ? "Pick a session to watch or take over." : "Open a terminal in Crowe Logic on your computer, then refresh.");
      controls(); renderList();
      } catch (error) { if (!disposed) { canOpen = false; connected = false; lease = null; status(error.message); } }
      finally { refreshing = false; if (!disposed) controls(); }
    }

    function select(meta, { take = false, autoTake = true } = {}) {
      if (!meta) return;
      if (selected?.id === meta.id && selected.generation === meta.generation) return;
      persist();
      const release = selected && lease !== null && selected.id !== meta.id ? { ...payload(), lease } : null;
      epoch++; seq = -1; lease = null; draft = hostDraft = null; draftKey = null; dirty = conflict = busy = controlBusy = closing = false;
      clearNotice(); cancelPaste();
      pendingSave = pendingReturn = null; connected = false; lastFit = ""; heldBy = null; keys?.reset();
      selected = { id: meta.id, generation: meta.generation, origin: meta.origin, mine: meta.mine || mineIds.has(meta.id), label: meta.label, engineName: meta.openedBy };
      $("[data-title]").textContent = meta.label || "Terminal";
      $("[data-context]").textContent = engine() ? `${meta.openedBy || "Engine"} session` : own() ? "Phone terminal" : "Desktop session";
      terminal.reset(); $("[data-draft]").value = ""; screen("term"); view("terminal"); controls();
      if (release) transport.call("/sessions/release", release).catch(() => {});
      if (take || (autoTake && own() && (!meta.controller || meta.controller.deviceId === deviceId))) takeControl(); else poll();
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
        if (lease !== null) focusKeys();
      } catch (error) { if (!disposed && epoch === currentEpoch) status(error.message); }
      finally { if (!disposed && epoch === currentEpoch) { controlBusy = false; controls(); poll(); } }
    }
    async function openShell() {
      if (opening || !canOpen) return;
      const currentEpoch = epoch;
      opening = true; controls(); status("Opening a shell on your computer");
      try {
        const wasHosts = !selected;
        if (wasHosts) { screen("term"); view("terminal"); }
        const size = fitted();
        if (wasHosts) screen("hosts");
        const result = await transport.call("/sessions/open", { ...size, operationId: uid() });
        if (disposed || epoch !== currentEpoch || document.hidden || !root.getClientRects().length) {
          if (result.data?.controller) transport.call("/sessions/release", { sessionId: result.data.id, generation: result.data.generation, lease: result.data.controller.lease }).catch(() => {});
          return;
        }
        if (result.error) { needsGrant(result); status(result.error); return; }
        const meta = result.data; mineIds.add(meta.id);
        if (!sessions.some(s => s.id === meta.id)) sessions.push({ ...meta, mine: true });
        select({ ...meta, mine: true }, { autoTake: false });
        lease = meta.controller?.lease ?? null; controls(); focusKeys();
        await refresh();
      } catch (error) { if (!disposed && epoch === currentEpoch) status(error.message); }
      finally { opening = false; if (!disposed) controls(); }
    }

    async function readDraft(meta, currentEpoch) {
      if (!meta || meta.status !== "editing") { draft = null; controls(); return; }
      if (draft?.id === meta.id && hostDraft?.revision === meta.revision) return;
      const result = await transport.call("/draft/get", { ...payload(), draftId: meta.id });
      if (disposed || epoch !== currentEpoch || result.error) return;
      const host = result.data; hostDraft = host;
      if (draft?.id !== host.id) {
        draftKey = `mirror-draft:${selected.generation}:${host.id}`;
        await persistQueue;
        if (disposed || epoch !== currentEpoch) return;
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
      if (disposed || document.hidden || !root.isConnected || !root.getClientRects().length) { keys?.cancelSpeech(); return; }
      if (polling) return;
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
        $("[data-owner]").textContent = value.controller ? (value.controller.deviceId === deviceId ? (engine() ? `You have the keys. ${selected.engineName || "The engine"} waits.` : "You have control") : `Control: ${value.controller.name}`)
          : engine() ? `${selected.engineName || "An engine"} ${value.busy ? "is running a command" : "is working here"}. Watching live.` : own() ? "Tap Take control to type" : "Viewing only";
        if (value.snapshot !== null) {
          terminal.reset(); terminal.resize(value.cols, value.rows);
          await new Promise(resolve => terminal.write(value.snapshot, resolve));
        } else for (const event of value.events) {
          if (disposed || epoch !== currentEpoch || document.hidden) return;
          if (event.seq !== seq + 1) { seq = -1; return; }
          if (event.type === "resize") terminal.resize(event.cols, event.rows);
          else await new Promise(resolve => terminal.write(event.data, resolve));
          if (disposed || epoch !== currentEpoch) return;
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
        // Keep the picker current when another desktop or engine opens a shell.
        // Refresh after the long-poll settles, without replacing the active view.
        if (Date.now() - listTime > 10000) await refresh();
      } catch (error) { if (!disposed && epoch === currentEpoch) { connected = false; lease = null; status(error.message); controls(); } }
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
      } catch (error) { if (!disposed && epoch === currentEpoch) status(error.message); }
      finally { if (!disposed && epoch === currentEpoch) { busy = false; controls(); } }
    }
    const inputBytes = text => new TextEncoder().encode(text).byteLength;
    function inputPrefix(text) {
      let prefix = "", bytes = 0;
      for (const char of text) {
        const count = inputBytes(char);
        if (bytes + count > 16384) break;
        prefix += char; bytes += count;
      }
      return prefix;
    }
    function sendInput(data) {
      if (disposed || document.hidden || !root.isConnected || !root.getClientRects().length || activeView !== "terminal" || controlBusy || closing || !connected || lease === null) return;
      const bytes = inputBytes(data);
      if (queuedInput + bytes > 16384) { status("Input queue is full. Wait before typing again."); return; }
      const request = { ...payload(), lease, inputId: uid(), data }; const currentEpoch = epoch;
      queuedInput += bytes;
      inputQueue = inputQueue.then(async () => {
        if (disposed || document.hidden || !root.getClientRects().length || activeView !== "terminal" || controlBusy || closing || !connected || epoch !== currentEpoch || lease !== request.lease) return;
        const result = await transport.call("/sessions/input", request);
        if (epoch === currentEpoch && result.error) { lease = null; status(`${result.error} Input was not retried.`); controls(); }
      }).catch(error => { if (epoch === currentEpoch) { lease = null; status(error.message); controls(); } }).finally(() => { queuedInput -= bytes; });
    }
    terminal.onData(data => { keys?.invalidateLine(); sendInput(data); });
    async function paste() {
      const currentEpoch = epoch, currentLease = lease;
      try {
        const text = await navigator.clipboard.readText();
        if (!disposed && !document.hidden && epoch === currentEpoch && lease === currentLease && currentLease !== null && activeView === "terminal" && text) {
          // Clipboard line breaks and escape characters must not execute a
          // command as a side effect of typing. Review a single line first.
          const safe = inputPrefix(text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " "));
          pasteReview = { text: safe, epoch: currentEpoch, lease: currentLease };
          $("[data-paste-text]").value = safe; $("[data-paste-review]").hidden = false;
          controls();
          $("[data-paste-cancel]").focus({ preventScroll: true });
        }
      } catch { if (epoch === currentEpoch) status("Paste needs permission to read the clipboard."); }
    }
    const keys = window.croweKeyboard?.create($("[data-keys]"), {
      send: sendInput, paste, status,
      onSystem: () => { keyboardMode = "system"; controls(); terminal.focus(); },
      onHide: () => { keyboardMode = "hidden"; controls(); },
    });
    if (!keys) keyboardMode = "system";
    // The Crowe keyboard needs no focus; the phone's own does.
    function focusKeys() { if (keyboardMode === "system") terminal.focus(); }
    $("[data-kb-show]").onclick = () => { keyboardMode = "crowe"; terminal.blur(); controls(); };
    $("[data-refresh]").onclick = refresh;
    $("[data-dismiss]").onclick = clearNotice;
    $("[data-paste-cancel]").onclick = () => { cancelPaste(); controls(); };
    $("[data-paste-type]").onclick = () => {
      const review = pasteReview; cancelPaste(); controls();
      if (review && review.epoch === epoch && review.lease === lease) sendInput(review.text);
    };
    $("[data-open]").onclick = openShell;
    $("[data-new]").onclick = openShell;
    $("[data-session-switch]").onchange = event => select(sessions.find(s => s.id === event.target.value), { take: false });
    // Leaving a session hands it back; the shell keeps running on the desktop
    // and its row stays in the list to return to.
    $("[data-back]").onclick = () => {
      persist();
      if (selected && lease !== null) transport.call("/sessions/release", { ...payload(), lease }).catch(() => {});
      epoch++; selected = null; lease = null; connected = false; heldBy = null; draft = null; cancelPaste(); clearNotice(); terminal.reset();
      if (keyboardMode === "system") keyboardMode = "crowe";
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
      } catch (error) { if (!disposed && epoch === currentEpoch) status(error.message); }
      finally { if (!disposed && epoch === currentEpoch) { controlBusy = false; controls(); } }
    };
    // Tapping the screen of a session nobody else holds takes it, the way a
    // terminal app focuses on touch; the keyboard follows.
    $("[data-screen]").addEventListener("click", () => {
      if (lease !== null) { if (keyboardMode === "hidden") { keyboardMode = "crowe"; controls(); } focusKeys(); }
      else if (connected && !controlBusy && !heldBy && !engine()) takeControl();
    });
    $("[data-close]").onclick = async () => {
      if (closing || !connected || (!own() && !engine())) return;
      if (engine() && !window.confirm(`Stop this terminal? ${selected.engineName || "The engine"} loses it and whatever runs in it ends.`)) return;
      persist();
      const request = payload(), currentEpoch = epoch;
      closing = true; controls();
      try {
        const result = await transport.call("/sessions/close", request);
        if (disposed || epoch !== currentEpoch) return;
        if (result.error) { status(result.error); return; }
        mineIds.delete(request.sessionId); epoch++; selected = null; lease = null; connected = false; draft = null; cancelPaste(); terminal.reset();
        screen("hosts"); refresh();
      } catch (error) { if (!disposed && epoch === currentEpoch) status(error.message); }
      finally { if (!disposed && (epoch === currentEpoch || !selected)) { closing = false; controls(); } }
    };
    root.querySelectorAll("[data-font]").forEach(button => { button.onclick = () => {
      fontSize = Math.max(9, Math.min(22, fontSize + Number(button.dataset.font)));
      terminal.options.fontSize = fontSize; try { localStorage.setItem(FONT_KEY, String(fontSize)); } catch { /* fine */ }
      lastFit = ""; sizeScreen(); fitOwn(); controls();
    }; });
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
      if (document.hidden) { suspend(); return; }
      seq = -1;
      if (own()) takeControl(); else poll();
    };
    document.addEventListener("visibilitychange", visibility);
    const onResize = () => { lastFit = ""; fitOwn(); };
    window.addEventListener("resize", onResize);
    const timer = setInterval(poll, 350);
    let rootVisible = Boolean(root.getClientRects().length);
    const observer = new MutationObserver(() => {
      if (!root.isConnected) { dispose(); return; }
      const visible = Boolean(root.getClientRects().length);
      if (rootVisible && !visible) suspend();
      else if (!rootVisible && visible && !document.hidden) { seq = -1; poll(); }
      rootVisible = visible;
    });
    observer.observe(body.parentNode, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "style"] });
    function suspend() {
      persist();
      if (selected && lease !== null) transport.call("/sessions/release", { ...payload(), lease }).catch(() => {});
      epoch++; seq = -1; lease = null; connected = false; controlBusy = busy = closing = false; cancelPaste(); keys?.cancelSpeech(); controls();
    }
    function dispose() { if (disposed) return; suspend(); disposed = true; clearInterval(timer); observer.disconnect(); keys?.destroy(); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("resize", onResize); terminal.dispose(); }
    screen("hosts"); refresh(); controls();
    return { dispose, select: id => select(sessions.find(s => s.id === id)) };
  }
})();
