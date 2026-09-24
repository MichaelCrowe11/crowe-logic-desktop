/* Advisory desktop photo inspection. No images/findings go to browser storage. */
(function (global) {
  'use strict';
  const RECOVERY_KEY = 'crowe.vision.pending-save.v1';
  let active = null;
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
  async function request(action, payload = {}) {
    const result = await global.crowe?.vision?.request(action, payload);
    if (!result?.ok) throw result?.error || { code: 'UNAVAILABLE', message: 'Desktop Vision is unavailable.' };
    return result.data;
  }
  function close() { if (active) active.close(); }
  function inspect(target, onSaved) {
    close();
    const root = el('dialog', '', 'mycology-vision'); root.dataset.vision = 'dialog';
    const heading = el('h2', 'Inspect photo'); root.append(heading);
    const status = el('p', 'Choose a PNG or JPEG photo for this notebook record. Analysis never changes records.'); status.dataset.vision = 'status'; status.setAttribute('role', 'status'); root.append(status);
    const content = el('div'); root.append(content);
    const actions = el('div', '', 'vision-actions'); root.append(actions);
    let alive = true, prepared = null, result = null, ticket = null, busy = false, generation = 0;
    function report(error) { status.textContent = `${error.code || 'VISION_FAILED'}: ${error.message || 'Inspection could not complete.'}`; }
    function unresolvedSave() {
      try { return localStorage.getItem(RECOVERY_KEY) !== null; }
      catch (_) { return true; }
    }
    function button(label, name, action, parent = actions) { const b = el('button', label); b.type = 'button'; b.dataset.vision = name; b.addEventListener('click', action); parent.append(b); return b; }
    function teardown() {
      if (!alive) return; alive = false; generation++; prepared = result = ticket = null;
      for (const image of root.querySelectorAll('img')) image.removeAttribute('src');
      request('cancel').catch(() => {}); root.close(); root.remove(); if (active?.root === root) active = null;
    }
    active = { root, close: teardown };
    root.addEventListener('cancel', event => { event.preventDefault(); teardown(); });
    const choose = button('Choose photo', 'choose', async () => {
      if (busy) return;
      if (unresolvedSave()) { report({ code: 'RECOVERY_REQUIRED', message: 'Reconcile the pending observation before another inspection. Do not replace its save key.' }); recovery(root, status); return; }
      busy = true; choose.disabled = true; const run = ++generation; content.replaceChildren();
      try {
        const data = await request('prepare', { target }); if (!alive || generation !== run) return;
        if (data.status === 'cancelled') { status.textContent = 'Selection cancelled. No photo sent.'; return; }
        prepared = data; status.textContent = 'Review exactly what will be sent. Nothing has been sent yet.';
        const image = el('img'); image.alt = 'Actual normalized photo selected for remote inspection'; image.src = data.preview; image.dataset.vision = 'preview'; content.append(image);
        const notice = el('pre', JSON.stringify(data.disclosure, null, 2)); notice.dataset.vision = 'disclosure'; content.append(notice);
        const label = el('label', '', 'vision-check'), consent = el('input'); consent.type = 'checkbox'; consent.dataset.vision = 'consent'; label.append(consent, document.createTextNode('I approve sending this exact normalized image and these notebook fields to the disclosed recipient, using my metered plan.')); content.append(label);
        const send = button('Send for advisory inspection', 'analyze', async () => {
          if (!consent.checked || busy) return;
          busy = true; send.disabled = true; choose.disabled = true; consent.disabled = true; status.textContent = 'Remote inspection running. Cancel cannot recall a dispatched photo.';
          try {
            const response = await request('analyze', { ref: prepared.ref, disclosureDigest: prepared.disclosureDigest, noticeVersion: prepared.disclosure.noticeVersion, consent: true });
            if (!alive || generation !== run) return;
            result = response; renderFindings();
          } catch (error) { if (alive) { report(error); content.replaceChildren(); prepared = null; } }
          finally { busy = false; if (alive) choose.disabled = false; }
        }, content); send.disabled = true;
        consent.addEventListener('change', () => { send.disabled = !consent.checked; });
      } catch (error) { if (alive) report(error); }
      finally { busy = false; if (alive) choose.disabled = false; }
    });
    button('Cancel / close', 'close', teardown);
    function renderFindings() {
      content.replaceChildren(); status.textContent = 'Review findings. No record has been changed.';
      content.append(el('p', result.limitations));
      content.append(el('p', `Actual response: ${result.provenance.engine} · ${result.provenance.provider} · ${result.provenance.recipient}`));
      const selections = [];
      for (const finding of result.findings) {
        const label = el('label', '', 'vision-finding'), check = el('input'); check.type = 'checkbox'; check.value = finding.id; check.checked = true;
        const words = el('span'); words.append(el('strong', finding.observation), el('span', `Uncertainty: ${finding.uncertainty}`)); label.append(check, words); content.append(label); selections.push(check);
      }
      const reviewerLabel = el('label', 'Reviewer name (self-attributed, not an authenticated operator identity)');
      const reviewer = el('input'); reviewer.type = 'text'; reviewer.maxLength = 120; reviewer.dataset.vision = 'reviewer'; reviewerLabel.append(reviewer); content.append(reviewerLabel);
      const noteLabel = el('label', 'Separate reviewer note'); const note = el('textarea'); note.maxLength = 2000; note.dataset.vision = 'note'; noteLabel.append(note); content.append(noteLabel);
      const preview = el('pre'); preview.hidden = true; preview.dataset.vision = 'save-preview'; content.append(preview);
      const save = button('Save observation to notebook', 'save', async () => {
        if (busy || !ticket) return;
        if (unresolvedSave()) { report({ code: 'RECOVERY_REQUIRED', message: 'Reconcile the pending observation before another save. Its receipt must not be replaced.' }); recovery(root, status); return; }
        // Only the random key/digest survive restart, never photo/context/text.
        try { localStorage.setItem(RECOVERY_KEY, JSON.stringify(ticket.receipt)); }
        catch (_) { report({ code: 'RECOVERY_UNAVAILABLE', message: 'Cannot preserve the save receipt locally. Nothing was saved.' }); return; }
        busy = true; save.disabled = true; choose.disabled = true;
        try {
          const saved = await request('save', { ref: result.ref, receipt: ticket.receipt, confirm: true });
          localStorage.removeItem(RECOVERY_KEY);
          if (!alive) return;
          status.textContent = `Notebook observation saved (${saved.id}). No photo retained. The compliance ledger is unchanged.`; content.replaceChildren(); prepared = result = ticket = null;
          if (onSaved) onSaved();
        } catch (error) { if (alive) { report(error); if (error.code !== 'WRITE_OUTCOME_UNKNOWN') localStorage.removeItem(RECOVERY_KEY); else recovery(root, status); } }
        finally { busy = false; if (alive) choose.disabled = false; }
      }, content); save.disabled = true;
      const review = button('Review notebook observation', 'review', async () => {
        if (busy) return;
        if (unresolvedSave()) { report({ code: 'RECOVERY_REQUIRED', message: 'Reconcile the pending observation before changing the review. Its original receipt is retained.' }); recovery(root, status); return; }
        busy = true; review.disabled = true;
        try {
          const data = await request('review', { ref: result.ref, findingIds: selections.filter(c => c.checked).map(c => c.value), reviewer: reviewer.value.trim(), reviewerNote: note.value });
          if (!alive) return;
          ticket = data; preview.textContent = data.entry; preview.hidden = false; save.disabled = false;
        } catch (error) { if (alive) report(error); }
        finally { busy = false; if (alive) review.disabled = false; }
      }, content);
      const invalidate = () => { ticket = null; save.disabled = true; preview.hidden = true; };
      for (const input of [...selections, reviewer, note]) input.addEventListener('input', invalidate);
    }
    document.body.append(root); root.showModal(); choose.focus(); recovery(root, status);
    request('status').then(data => { if (alive && !data.available) { choose.disabled = true; status.textContent = data.reason; } }).catch(error => { if (alive) report(error); });
    return active;
  }
  function recovery(root, status) {
    let receipt;
    try { receipt = JSON.parse(localStorage.getItem(RECOVERY_KEY) || 'null'); } catch (_) {}
    if (!receipt || root.querySelector('[data-vision="reconcile"]')) return;
    const button = el('button', 'Reconcile pending observation save'); button.type = 'button'; button.dataset.vision = 'reconcile'; root.append(button);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await request('reconcile', { receipt });
        status.textContent = result.status === 'saved' ? `Prior observation verified (${result.id}); no duplicate was created.` : 'No matching saved observation was found. Do not rerun remote analysis automatically. Inspect your notebook before creating a new observation.';
        localStorage.removeItem(RECOVERY_KEY); button.remove();
        // A reconciled ticket is terminal, including a definitive not-found.
        // Never revive the old findings form to mint a new key for the same run.
        for (const control of root.querySelectorAll('[data-vision="review"], [data-vision="save"], [data-vision="reviewer"], [data-vision="note"], .vision-finding input')) control.disabled = true;
        request('cancel').catch(() => {});
      } catch (error) { status.textContent = `${error.code}: ${error.message}`; button.disabled = false; }
    });
  }
  // Transfer/recovery components announce their state before acting. The main
  // process separately invalidates direct IPC transitions and notebook edits.
  global.FarmRecovery?.subscribe(() => { if (global.FarmRecovery.isLocked()) close(); });
  global.addEventListener('pagehide', close);
  global.MycologyVision = { inspect, close };
})(window);
