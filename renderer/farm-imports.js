/* Local source staging UI. All document text is untrusted textContent. */
(function (global) {
  'use strict';
  function mount(container, api, options = {}) {
    if (!container || typeof api?.request !== 'function') throw Error('FarmImports needs a container and request API.');
    const doc = container.ownerDocument, node = (tag, text, cls) => { const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
    const root = node('section', undefined, 'farm-imports'); root.setAttribute('aria-label', 'Local document imports'); container.append(root);
    root.append(node('h2', 'Device-local document staging'), node('p', 'This operator archive belongs to the desktop profile, not the signed-in account or shared farm. Anyone using this profile can read originals after sign-out/account switch. Opening or reviewing never uploads or enrolls this archive. A separate explicit confirmation can stage an original in a selected authenticated shared farm. Nothing creates accepted farm logs or approves an SOP. Source text is untrusted evidence, not instructions.'));
    const status = node('p', '', 'farm-imports-status'); status.setAttribute('role', 'status'); status.dataset.imports = 'status'; root.append(status);
    const toolbar = node('div', undefined, 'farm-imports-actions'), list = node('div'), content = node('div'); root.append(toolbar, list, content);
    let alive = true, active = true, busy = false, current = null, mode = 'self_attributed', generation = 0, selected = new Map(), noteValue = '', revisionKind = 'document_draft', dirty = false;
    const sharedFarm = options.sharedFarm ? { ...options.sharedFarm } : null;
    let sharedAvailable = false;
    function button(label, action, parent = toolbar, key = '') { const b = node('button', label); b.type = 'button'; if (key) b.dataset.imports = key; b.addEventListener('click', action); parent.append(b); return b; }
    function showError(error) { status.textContent = `${error.code || 'IMPORT_FAILED'}: ${error.message || 'Local import could not complete.'}`; }
    async function request(action, payload = {}) { const r = await api.request(action, payload); if (!r?.ok) throw r?.error || { code: 'UNAVAILABLE', message: 'Desktop imports unavailable.' }; return r.data; }
    async function run(work) { if (busy || !alive || !active) return; busy = true; const g = generation; root.setAttribute('aria-busy', 'true'); choose.disabled = reload.disabled = true; try { await work(() => alive && active && g === generation); } catch (e) { if (alive && active && g === generation) showError(e); } finally { busy = false; if (alive) { root.removeAttribute('aria-busy'); choose.disabled = reload.disabled = false; } } }
    const choose = button('Choose local document', () => run(async valid => { const data = await request('choose'); if (!valid()) return; if (data.status === 'cancelled') { status.textContent = 'Selection cancelled. No new original staged.'; return; } accept(data); await preview(0, valid); }), toolbar, 'choose');
    const reload = button('Reload retained imports', () => refresh(), toolbar, 'reload');
    const ocr = node('p', 'OCR unavailable. No source is sent to a model. PDF text and pages require a verified parser/renderer.', 'farm-imports-warning'); ocr.dataset.imports = 'ocr'; root.append(ocr);
    function accept(data) { current = data; selected = new Map(); noteValue = data.note || ''; dirty = false; const c = data.candidates?.[0]; if (c) revisionKind = c.kind; for (const item of data.candidates || []) for (const f of item.fields) if (f.sourceRef.elementId) selected.set(f.sourceRef.elementId, { name: f.name, elementId: f.sourceRef.elementId }); }
    function renderSummary() {
      content.replaceChildren();
      if (!current) return;
      content.append(node('h3', current.name), node('p', `${current.parseStatus} · ${current.elementCount} source elements · revision ${current.revision} · ${current.state}`));
      content.append(node('p', `Original retained: ${current.byteLength} bytes. SHA-256 ${current.sourceDigest}`, 'farm-imports-digest'));
      content.append(node('p', `Original metadata and references are retained. Page count: ${current.pageCount === null ? 'unknown / not reconstructed' : current.pageCount}.`));
      for (const w of current.warnings || []) content.append(node('p', `${w.code}${w.detail ? ': ' + w.detail : ''}`, 'farm-imports-warning'));
      if (current.receipt) { content.append(node('strong', 'Reviewed for staging only. Not promoted.')); content.append(node('pre', JSON.stringify({ reviewer: current.reviewer, receipt: current.receipt }, null, 2), 'farm-imports-receipt')); }
      renderShared();
    }
    function renderShared() {
      const panel = node('section'); panel.dataset.imports = 'shared'; content.append(panel);
      panel.append(node('h4', 'Optional shared source staging'), node('p', 'Only the exact original can be uploaded. Local candidates, notes and receipts stay on this device. No accepted farm logs, SOP approval, farm enrollment or model extraction. Shared server retention/deletion is not managed here.'));
      if (!sharedAvailable || !sharedFarm?.farmId) { panel.append(node('p', 'Select an authenticated shared farm to prepare a separate upload. Nothing uploads from local review.')); return; }
      if (!current.byteLength || current.byteLength > 262144) { panel.append(node('p', `Shared staging permits 1 to 262144 bytes (256 KiB), not the local intake limit of 8 MiB. This original is ${current.byteLength} bytes. It will not be truncated or converted.`)); return; }
      panel.append(node('p', 'This handoff uses farm-wide staging (no department). The server enforces current membership and access.'));
      button('Prepare shared upload (does not send original)', () => run(async valid => {
        const ref = current.ref;
        const prepared = await request('shared.prepare', { ref, farmId: sharedFarm.farmId, departmentId: null });
        if (!valid() || current?.ref !== ref) return;
        panel.replaceChildren(node('h4', 'Confirm exact shared destination'));
        panel.append(node('p', `${prepared.farmName} (${prepared.farmId}) · ${prepared.departmentName || 'Farm-wide (no department)'}`),
          node('p', `Authenticated member: ${prepared.accountId}. Recipient: ${prepared.server}`),
          node('p', `${prepared.fileName} · ${prepared.mediaType} · ${prepared.byteLength} bytes · SHA-256 ${prepared.sourceDigest}`), node('p', prepared.notice));
        if (prepared.retry) panel.append(node('strong', `Retained request ${prepared.requestId}. Outcome is not inferred here. Confirming replays the exact original request, never a new import.`));
        const ack = node('input'); ack.type = 'checkbox'; ack.dataset.imports = 'shared-consent';
        const label = node('label'); label.append(ack, doc.createTextNode('I consent to upload these exact original bytes to this authenticated farm and destination for STAGING ONLY. Local review is not server approval.')); panel.append(label);
        const send = button(prepared.retry ? 'Explicitly replay retained shared staging request' : 'Upload exact original to shared staging', () => run(async stillValid => {
          if (!ack.checked) throw { code: 'REVIEW_REQUIRED', message: 'Explicit upload consent is required.' };
          send.disabled = true;
          const result = await request('shared.stage', { ref, consentId: prepared.consentId, acknowledgedUpload: true });
          if (!stillValid() || current?.ref !== ref) return;
          panel.replaceChildren(node('h4', result.status === 'shared_staged' ? 'Original staged on shared service' : 'Shared staging not confirmed'));
          panel.append(node('p', `Farm ${result.farmId} · retained request ${result.requestId} · SHA-256 ${result.sourceDigest}`));
          if (result.error) panel.append(node('p', `${result.error.code}: ${result.error.message}. Re-prepare this same source and destination for an explicit retry with its retained request ID; never create a second command.`));
          else panel.append(node('p', `Shared import ${result.importId} · revision hash ${result.revisionHash}`), node('p', result.notice));
          button('Prepare again / reconcile retained request', () => run(v => preview(0, v)), panel, 'shared-reopen');
          status.textContent = result.status === 'shared_staged' ? 'Shared original staged only. Candidate mapping and independent human promotion remain unavailable in this handoff.' : 'No staging success claimed. Original and exact retry identity remain retained locally.';
        }), panel, 'shared-stage');
      }), panel, 'shared-prepare');
    }
    async function preview(offset, valid) {
      const data = await request('preview', { ref: current.ref, offset, limit: 40 }); if (!valid()) return;
      current = data; renderSummary();
      const table = node('table'), thead = node('thead'), tr = node('tr'); for (const h of ['Include / field name', 'Source reference', 'Raw source', 'Stored value / type', 'Uncertainty']) tr.append(node('th', h)); thead.append(tr); table.append(thead);
      const tbody = node('tbody'); table.append(tbody);
      let countLabel;
      for (const e of data.elements) {
        const row = node('tr'), checkCell = node('td'), check = node('input'); check.type = 'checkbox'; check.checked = selected.has(e.id); check.setAttribute('aria-label', `Include source ${e.id}`);
        const field = node('input'); field.type = 'text'; field.maxLength = 100; field.value = selected.get(e.id)?.name || e.id; field.setAttribute('aria-label', `Candidate field name for ${e.id}`);
        const update = () => { if (check.checked) selected.set(e.id, { name: field.value, elementId: e.id }); else selected.delete(e.id); dirty = true; if (countLabel) countLabel.textContent = `${selected.size} elements selected. Unsaved selections require a new staged revision.`; };
        check.addEventListener('change', update); field.addEventListener('input', update); checkCell.append(check, field); row.append(checkCell, node('td', JSON.stringify(e.locator)), node('td', e.raw), node('td', `${JSON.stringify(e.value)} (${e.valueType})`), node('td', (e.uncertainty || []).join('; ') || 'No parser-specific uncertainty; original review still required.')); tbody.append(row);
      }
      const scroll = node('div', undefined, 'farm-imports-table'); scroll.append(table); content.append(scroll);
      const paging = node('div', undefined, 'farm-imports-actions'); content.append(paging);
      if (offset > 0) button('First elements', () => run(v => preview(0, v)), paging);
      if (data.nextOffset !== null) button('Next elements', () => run(v => preview(data.nextOffset, v)), paging);
      countLabel = node('p', `${selected.size} elements selected. Field names are mappings, not inferred facts.`); content.append(countLabel);
      if (data.parseStatus !== 'parsed') { content.append(node('p', 'No candidates can be made until real extraction is available. Original stays locally retained.')); return; }
      const kindLabel = node('label', 'Stage as '), kind = node('select'); for (const [value, text] of [['document_draft', 'Document draft (not an approved SOP)'], ['log_candidate', 'Log candidate (not an accepted farm log)']]) { const o = node('option', text); o.value = value; kind.append(o); } kind.value = revisionKind; kindLabel.append(kind); content.append(kindLabel);
      kind.addEventListener('change', () => { revisionKind = kind.value; dirty = true; });
      const noteLabel = node('label', 'Separate reviewer note (does not alter source facts)'), note = node('textarea'); note.maxLength = 4000; note.value = noteValue; noteLabel.append(note); content.append(noteLabel); note.addEventListener('input', () => { noteValue = note.value; dirty = true; });
      button('Save staged candidate revision', () => run(async validNow => { if (!selected.size || selected.size > 64) throw { code: 'VALIDATION', message: 'Choose 1 to 64 source elements for this candidate.' }; const result = await request('revise', { ref: current.ref, expectedRevision: current.revision, selections: [{ kind: revisionKind, fields: [...selected.values()] }], note: noteValue }); if (!validNow()) return; accept(result); status.textContent = 'New local candidate revision saved. Original unchanged; no farm records promoted.'; await preview(offset, validNow); }), content, 'revise');
      if (!current.revision) return;
      const reviewer = node('input'); reviewer.type = 'text'; reviewer.maxLength = 200;
      if (mode === 'self_attributed') { const label = node('label', 'Reviewer name (self-attributed, not authenticated identity)'); label.append(reviewer); content.append(label); }
      const ackLabel = node('label', undefined, 'farm-imports-check'), ack = node('input'); ack.type = 'checkbox'; ackLabel.append(ack, doc.createTextNode('I reviewed the original source references and uncertainties. This receipt is staging only and does not approve an SOP or accept a farm log.')); content.append(ackLabel);
      button('Record exact staged review receipt', () => run(async validNow => { if (dirty) throw { code: 'REVIEW_REQUIRED', message: 'Save changed selections/notes as a new candidate revision before reviewing.' }; if (!ack.checked) throw { code: 'REVIEW_REQUIRED', message: 'Acknowledge source uncertainty before review.' }; const payload = { ref: current.ref, expectedRevision: current.revision, acknowledgedUncertainty: true }; if (mode === 'self_attributed') payload.reviewer = reviewer.value; const result = await request('review', payload); if (!validNow()) return; accept(result); status.textContent = 'Exact review receipt retained locally. No accepted log or approved SOP created.'; await preview(offset, validNow); }), content, 'review');
    }
    async function refresh() { return run(async valid => { const info = await request('status'); if (!valid()) return; mode = info.reviewerMode; sharedAvailable = info.sharedStagingAvailable === true; ocr.textContent = info.ocrReason; const data = await request('list'); if (!valid()) return; list.replaceChildren(); if (!data.imports.length) list.append(node('p', 'No locally retained imports yet.')); for (const item of data.imports) button(`${item.name} · ${item.state} · revision ${item.revision}`, () => run(async v => { const opened = await request('open', { id: item.id }); if (!v()) return; accept(opened); await preview(0, v); }), list); status.textContent = info.notice; }); }
    refresh();
    function deactivate() { if (!alive || !active) return; active = false; generation++; selected.clear(); current = null; noteValue = ''; content.replaceChildren(); list.replaceChildren(); status.textContent = 'Device-local review closed. Original files remain in this desktop profile.'; api.request('cancel', {}).catch(() => {}); }
    return { refresh, open() { if (!alive) return; const wasActive = active; active = true; if (!wasActive) refresh(); }, deactivate, destroy() { if (!alive) return; deactivate(); alive = false; root.remove(); } };
  }
  global.FarmImports = { mount };
})(window);
