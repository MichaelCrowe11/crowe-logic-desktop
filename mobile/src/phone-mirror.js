(function () {
  "use strict";
  const transport = window.croweMirrorTransport;
  const uid = () => crypto.randomUUID();
  window.crowePhoneMirror = { mount };
  function mount(body) {
    const root = document.createElement("section"); root.className = "phone-mirror";
    root.innerHTML = `<div class="mirror-heading"><strong>Shared terminal</strong><button type="button" data-refresh>Refresh</button></div>
      <label class="mirror-session-label">Session<select data-sessions aria-label="Desktop terminal session"><option value="">Select a desktop session</option></select></label>
      <div class="mirror-status" data-status role="status" aria-live="polite">Connecting to your paired machine</div>
      <div class="mirror-tabs" aria-label="Session views"><button type="button" data-view="terminal" aria-pressed="true">Terminal</button><button type="button" data-view="draft" aria-pressed="false">Draft</button><button type="button" data-view="review" aria-pressed="false">Review</button></div>
      <section data-panel="terminal"><div class="mirror-screen-scroll"><div class="mirror-screen" data-screen></div></div>
        <div class="mirror-controls"><button type="button" data-control disabled>Take control</button><span data-owner>Viewing only</span></div>
        <div class="mirror-keys" data-keys hidden><button type="button" data-key="escape">Esc</button><button type="button" data-key="tab">Tab</button><button type="button" data-key="up">↑</button><button type="button" data-key="down">↓</button><button type="button" data-key="edit">Ctrl+G</button><button type="button" data-key="interrupt">Interrupt</button></div>
      </section>
      <section data-panel="draft" hidden><label class="mirror-draft-label">CLI draft<textarea data-draft rows="8" disabled spellcheck="false" autocorrect="off" autocapitalize="off" aria-label="Shared CLI draft" placeholder="Open a draft with Control+G in the managed Crowe Logic CLI."></textarea></label>
        <div class="mirror-save-state" data-save-state>No open draft</div>
        <div class="mirror-draft-actions"><button type="button" data-save disabled>Save to host</button><button type="button" data-review disabled>Review changes</button></div>
      </section>
      <section data-panel="review" hidden><div class="mirror-review-label">Host revision</div><pre data-host-text></pre><div class="mirror-review-label">Your draft</div><pre data-local-text></pre>
        <div data-conflict hidden><p>The host changed. Choose which text to keep before saving.</p><button type="button" data-use-host>Use host version</button><button type="button" data-keep-local>Keep my version</button></div>
        <button type="button" data-return disabled>Save and return to session</button><p class="mirror-save-state">Returns to this session's waiting prompt. It does not submit it.</p>
      </section>`;
    body.append(root);
    const $ = selector => root.querySelector(selector);
    const terminal = new window.Terminal({ cols: 80, rows: 24, fontFamily: "JetBrains Mono, monospace", fontSize: 13,
      scrollback: 1000, disableStdin: true, allowProposedApi: true, theme: { background: "#0b0e12", foreground: "#eceae4", cursor: "#d2ad62" } });
    terminal.open($("[data-screen]"));
    let selected = null, epoch = 0, seq = -1, connected = false, lease = null, deviceId = null, disposed = false;
    let draft = null, hostDraft = null, draftKey = null, conflict = false, dirty = false, busy = false, polling = false;
    let listTime = 0, renewTime = 0, inputQueue = Promise.resolve(), queuedInput = 0, pendingSave = null, pendingReturn = null, controlBusy = false;
    let persistQueue = Promise.resolve();
    const payload = () => ({ sessionId: selected?.id, generation: selected?.generation });
    function status(text) { $("[data-status]").textContent = text; }
    function controls() {
      terminal.options.disableStdin = !connected || lease === null;
      $("[data-control]").disabled = !connected || !selected || controlBusy;
      $("[data-control]").textContent = lease === null ? "Take control" : "Release control";
      $("[data-keys]").hidden = !connected || lease === null;
      const editable = draft?.status === "editing";
      $("[data-draft]").disabled = !editable || busy;
      $("[data-save]").disabled = !editable || !connected || busy || conflict;
      $("[data-review]").disabled = !editable;
      $("[data-return]").disabled = !editable || !connected || busy || conflict;
      $("[data-conflict]").hidden = !conflict;
      $("[data-host-text]").textContent = !editable ? "No open draft" : hostDraft.text || "Empty draft";
      $("[data-local-text]").textContent = $("[data-draft]").value;
      $("[data-save-state]").textContent = !editable ? "No open draft. Press Control+G in the managed CLI." : conflict ? "Conflict · local text preserved" : dirty ? "Local changes · not saved to host" : `Revision ${draft.revision} · saved on host`;
    }
    function view(name) {
      root.querySelectorAll("[data-panel]").forEach(el => { el.hidden = el.dataset.panel !== name; });
      root.querySelectorAll("[data-view]").forEach(el => el.setAttribute("aria-pressed", String(el.dataset.view === name)));
      controls();
    }
    function persist() {
      if (!draftKey || !draft) return;
      const key = draftKey, value = { text: $("[data-draft]").value, revision: draft.revision, dirty };
      persistQueue = persistQueue.then(() => transport.storage.set(key, value)).then(ok => { if (!ok && key === draftKey) status("Local storage failed. Keep this editor open and copy your draft."); });
    }
    async function refresh() {
      const result = await transport.call("/sessions/list");
      if (disposed) return;
      if (result.error) { connected = false; lease = null; status(result.error); controls(); return; }
      deviceId = result.data.deviceId; listTime = Date.now();
      const select = $("[data-sessions]"); select.replaceChildren();
      const empty = document.createElement("option"); empty.value = ""; empty.textContent = "Select a desktop session"; select.append(empty);
      for (const session of result.data.sessions) { const option = document.createElement("option"); option.value = session.id; option.textContent = `${session.label} · ${session.cwd}`; option.dataset.generation = session.generation; select.append(option); }
      if (selected && !result.data.sessions.some(s => s.id === selected.id && s.generation === selected.generation)) {
        persist(); epoch++; selected = null; connected = false; lease = null; draft = null; status("The session ended. Your local draft is preserved."); controls();
      }
      select.value = selected?.id || "";
      if (!selected) status(result.data.sessions.length ? "Choose a terminal. Start Crowe Logic inside that desktop terminal." : "Open a terminal in the Crowe Logic desktop app, then refresh.");
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
        const result = await transport.call("/sessions/poll", { ...payload(), after: seq });
        if (disposed || epoch !== currentEpoch) return;
        if (result.error) { connected = false; lease = null; status(result.error); controls(); if (result.status === 410) await refresh(); return; }
        const value = result.data;
        connected = true; lease = value.controller?.deviceId === deviceId ? value.controller.lease : null;
        $("[data-owner]").textContent = value.controller ? `Control: ${value.controller.name}` : "Viewing only";
        status("Connected · desktop must remain running and awake");
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
        $("[data-screen]").style.width = `${Math.ceil(terminal.cols * 7.85 + 20)}px`;
        await readDraft(value.draft, currentEpoch);
        if (disposed || epoch !== currentEpoch) return;
        if (lease !== null && Date.now() - renewTime > 5000) {
          const renewed = await transport.call("/sessions/renew", { ...payload(), lease });
          if (disposed || epoch !== currentEpoch) return;
          if (renewed.error) lease = null; renewTime = Date.now();
        }
        controls();
      } catch (error) { connected = false; lease = null; status(error.message); controls(); }
      finally { polling = false; }
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
    $("[data-sessions]").onchange = event => {
      persist();
      const release = selected && lease !== null ? { ...payload(), lease } : null;
      const option = event.target.selectedOptions[0];
      epoch++; seq = -1; lease = null; draft = hostDraft = null; draftKey = null; dirty = conflict = busy = controlBusy = false;
      pendingSave = pendingReturn = null; connected = false;
      selected = option?.value ? { id: option.value, generation: option.dataset.generation } : null;
      terminal.reset(); $("[data-draft]").value = ""; controls();
      if (release) transport.call("/sessions/release", release).catch(() => {});
      poll();
    };
    $("[data-control]").onclick = async () => {
      if (!selected || controlBusy) return;
      const route = lease === null ? "/sessions/control" : "/sessions/release";
      const request = { ...payload(), lease }, currentEpoch = epoch;
      controlBusy = true; controls();
      try {
        const result = await transport.call(route, request);
        if (disposed || epoch !== currentEpoch) {
          if (route === "/sessions/control" && result.data?.controller?.deviceId === deviceId)
            await transport.call("/sessions/release", { ...request, lease: result.data.controller.lease });
          return;
        }
        if (result.error) status(result.error);
        else { lease = result.data.controller?.deviceId === deviceId ? result.data.controller.lease : null; if (lease !== null) terminal.focus(); }
      } finally { if (epoch === currentEpoch) { controlBusy = false; controls(); } }
    };
    const keys = { escape: "\u001b", tab: "\t", up: "\u001b[A", down: "\u001b[B", edit: "\u0007", interrupt: "\u0003" };
    root.querySelectorAll("[data-key]").forEach(button => { button.onclick = () => sendInput(keys[button.dataset.key]); });
    root.querySelectorAll("[data-view]").forEach(button => { button.onclick = () => view(button.dataset.view); });
    $("[data-draft]").oninput = () => { dirty = true; pendingSave = pendingReturn = null; persist(); controls(); };
    $("[data-review]").onclick = () => view("review");
    $("[data-save]").onclick = () => saveDraft(false);
    $("[data-return]").onclick = () => saveDraft(true);
    $("[data-use-host]").onclick = () => { draft = { ...hostDraft }; $("[data-draft]").value = hostDraft.text; dirty = conflict = false; pendingSave = pendingReturn = null; persist(); controls(); };
    $("[data-keep-local]").onclick = () => { draft = { ...hostDraft }; dirty = true; conflict = false; pendingSave = pendingReturn = null; persist(); controls(); };
    const visibility = () => { if (document.hidden) { persist(); lease = null; controls(); } else { seq = -1; poll(); } };
    document.addEventListener("visibilitychange", visibility);
    const timer = setInterval(poll, 350);
    const observer = new MutationObserver(() => { if (!root.isConnected) dispose(); }); observer.observe(body.parentNode, { childList: true, subtree: true });
    function dispose() { if (disposed) return; disposed = true; epoch++; persist(); clearInterval(timer); observer.disconnect(); document.removeEventListener("visibilitychange", visibility); terminal.dispose(); }
    refresh(); controls();
    return { dispose };
  }
})();
