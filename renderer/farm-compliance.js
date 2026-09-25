/* Desktop-local Farm & Compliance. The shell supplies the only data boundary. */
(function (global) {
  'use strict';
  const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
  const LANES = [ ['overview', 'Overview'], ['facility', 'Facility'], ['lots', 'Harvest lots'],
    ['shipments', 'Customers & shipments'], ['logs', 'Daily logs'], ['recall', 'Recall'],
    ['documents', 'Documents'], ['audit', 'Audit & backup'] ];
  const DOCUMENT_TYPES = ['FOOD_SAFETY_PLAN', 'SANITATION_SOP', 'HARVEST_PACKING_SOP', 'RECALL_PLAN', 'LOT_CODING_SOP'];
  // Only trusted, explicit rejections release a dispatched shipment. CONFLICT is
  // deliberately excluded: the key may already identify a committed allocation.
  const DEFINITIVE_ERRORS = new Set(['VALIDATION', 'NOT_FOUND', 'INSUFFICIENT_QUANTITY', 'INVALID_STATE', 'BACKUP_CAPACITY']);
  const recovery = global.FarmRecovery;
  if (!recovery) throw new Error('FarmRecovery must load before FarmCompliance.');
  const { shipmentStorageKey, recoveryError, validId, pendingRecord, readPendingShipment, quantity } = recovery;
  let mountNumber = 0;

  function node(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === 'className') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (value !== undefined && value !== null && value !== false) el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) if (child !== null && child !== undefined) el.append(child.nodeType ? child : document.createTextNode(String(child)));
    return el;
  }
  const button = (text, fn, attrs = {}) => node('button', { type: 'button', onclick: fn, ...attrs }, text);
  const text = (value) => value === null || value === undefined || value === '' ? 'Not recorded' : String(value);
  const detail = (label, value) => node('div', { className: 'fc-detail' }, node('dt', {}, label), node('dd', {}, text(value)));
  const json = (value) => node('pre', { className: 'fc-json' }, JSON.stringify(value === undefined ? null : value, null, 2));
  const empty = (message) => node('p', { className: 'fc-empty' }, message);
  function mount(container, api) {
    if (!container || typeof container.append !== 'function') throw new TypeError('A workspace container is required.');
    const prefix = `fc-${++mountNumber}`;
    const state = { alive: true, active: true, sequence: 0, mutationEpoch: 0, ready: false, unavailable: false,
      lane: 'overview', snapshot: null, legacySequence: 0, recallSequence: 0, auditSequence: 0, pendingShipment: null,
      shipmentStorageError: null, shipmentOperator: null, shipmentFresh: false };
    const forms = new Set();
    const selectBindings = [];
    const panes = {};
    const lists = {};
    const navButtons = {};
    const root = node('section', { className: 'farm-compliance', 'aria-label': 'Farm & Compliance' });
    const status = node('p', { className: 'fc-status', role: 'status', 'aria-live': 'polite', 'data-fc': 'status' }, 'Opening local records...');
    const alert = node('div', { className: 'fc-error', role: 'alert', hidden: true, 'data-fc': 'error' });
    const storageNotice = node('p', { className: 'fc-caption', 'data-fc': 'storage-notice' }, 'Desktop-local records. No browser or phone copy.');
    const shipmentNotice = node('div', { className: 'fc-note', role: 'status', 'aria-live': 'polite', 'data-fc': 'shipment-recovery', hidden: true });
    const refreshButton = button('Refresh records', () => refresh(), { 'data-fc': 'refresh' });
    root.append(node('header', { className: 'fc-header' }, node('div', {}, node('p', { className: 'fc-eyebrow' }, 'LOCAL OPERATIONS'),
      node('h1', {}, 'Farm & Compliance'), storageNotice), refreshButton), status, alert, shipmentNotice);
    const unavailable = node('section', { className: 'fc-unavailable', hidden: true, 'data-fc': 'unavailable' },
      node('h2', {}, 'Desktop records unavailable'), node('p', {}, 'Open this workspace in the local desktop app to record farm activity. Browser, phone and preview surfaces do not have access to the authoritative farm database.'),
      node('p', {}, 'No records have been created here. No second database or automatic migration is used.'));
    root.append(unavailable);
    const nav = node('nav', { className: 'fc-nav', role: 'tablist', 'aria-label': 'Farm sections' });
    const body = node('div', { className: 'fc-body' });
    root.append(nav, body);
    container.append(root);
    for (const [key, label] of LANES) {
      navButtons[key] = button(label, () => open(key), { id: `${prefix}-tab-${key}`, role: 'tab', 'data-lane': key, 'data-farm-lane': key === 'overview' ? 'dashboard' : key, 'aria-controls': `${prefix}-${key}` });
      navButtons[key].addEventListener('keydown', event => {
        const index = LANES.findIndex(([lane]) => lane === key);
        const next = event.key === 'ArrowRight' ? (index + 1) % LANES.length : event.key === 'ArrowLeft' ? (index + LANES.length - 1) % LANES.length : event.key === 'Home' ? 0 : event.key === 'End' ? LANES.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); open(LANES[next][0]); navButtons[LANES[next][0]].focus();
      });
      nav.append(navButtons[key]);
      panes[key] = node('section', { id: `${prefix}-${key}`, role: 'tabpanel', tabindex: '0', 'aria-labelledby': `${prefix}-tab-${key}`, 'data-pane': key, hidden: key !== 'overview' });
      body.append(panes[key]);
    }
    function errorAt(target, error) {
      target.replaceChildren(node('strong', {}, text(error && error.code || 'UNEXPECTED_ERROR')), document.createTextNode(`: ${error && error.message || 'The operation did not complete. Your form is retained.'}`));
      target.hidden = false;
    }
    function unavailableState(error) {
      state.unavailable = true; state.ready = false;
      forms.forEach(applyEnabled);
      unavailable.hidden = false; nav.hidden = true; body.hidden = true;
      status.textContent = 'UNAVAILABLE. Read-only explanation.';
      errorAt(alert, error);
    }
    async function request(action, payload = {}) {
      if (!api || typeof api.request !== 'function') throw { code: 'UNAVAILABLE', message: 'This runtime has no desktop farm bridge.' };
      let result;
      try { result = await api.request(action, payload); }
      catch (_) { throw { code: 'CONNECTION_ERROR', message: 'The local service did not return a result. Retain this form and retry; a shipment retry uses the same request ID.' }; }
      if (!result || result.ok !== true) {
        if (result && result.ok === false && result.error && typeof result.error.code === 'string' && typeof result.error.message === 'string') throw result.error;
        throw { code: 'INVALID_RESPONSE', message: 'The local service returned an invalid response.' };
      }
      return result.data;
    }
    function open(lane) {
      if (!state.alive) return;
      const aliases = { dashboard: 'overview', customers: 'shipments', deviations: 'logs', adoption: 'lots', backup: 'audit', revisions: 'documents' };
      lane = aliases[lane] || lane || state.lane;
      if (!panes[lane]) lane = 'overview';
      state.active = true; state.lane = lane; root.hidden = false;
      for (const [key] of LANES) {
        panes[key].hidden = key !== lane;
        navButtons[key].setAttribute('aria-current', key === lane ? 'page' : 'false');
        navButtons[key].setAttribute('aria-selected', String(key === lane));
        navButtons[key].tabIndex = key === lane ? 0 : -1;
      }
    }
    function applyEnabled(form) {
      form.fields.disabled = form.busy || form.locked || recovery.isLocked() || !state.ready || state.unavailable;
      if (form.retry) form.retry.disabled = recovery.isLocked() || form.busy || !state.ready || state.unavailable || !!state.shipmentStorageError || !state.pendingShipment || state.shipmentOperator !== state.pendingShipment.operatorId;
    }
    function form(title, id, parent) {
      const element = node('form', { 'data-form': id, className: 'fc-form' });
      const fields = node('fieldset', {});
      const err = node('div', { role: 'alert', className: 'fc-error', hidden: true, 'data-form-error': id });
      const message = node('p', { role: 'status', className: 'fc-form-status', 'aria-live': 'polite' });
      element.append(node('h2', {}, title), fields, err, message);
      const f = { element, fields, err, message, busy: false, locked: false, inputs: {}, dirty: false };
      element.addEventListener('input', () => { f.dirty = true; });
      element.addEventListener('change', () => { f.dirty = true; });
      forms.add(f); applyEnabled(f); parent.append(element); return f;
    }
    function field(f, name, label, opts = {}) {
      const id = `${prefix}-${f.element.dataset.form}-${name}`;
      const { kind, options, value, ...attributes } = opts;
      const input = node(kind === 'textarea' ? 'textarea' : kind === 'select' ? 'select' : 'input', { id, name,
        ...(kind === 'textarea' || kind === 'select' ? {} : { type: 'text' }), maxLength: ['notes', 'deviationNotes', 'correctiveAction', 'reason'].includes(name) ? 5000 : name.endsWith('Id') ? 200 : 500, ...attributes });
      if (kind === 'select') for (const item of options || []) input.append(node('option', { value: Array.isArray(item) ? item[0] : item }, Array.isArray(item) ? item[1] : item));
      if (value !== undefined) { if (attributes.type === 'checkbox') input.checked = !!value; else input.value = value === null ? '' : String(value); }
      const wrapper = node('div', { className: attributes.type === 'checkbox' ? 'fc-check' : 'fc-field' });
      if (attributes.type === 'checkbox') wrapper.append(input, node('label', { for: id }, label));
      else wrapper.append(node('label', { for: id }, label), input);
      f.inputs[name] = input; f.fields.append(wrapper); return input;
    }
    function select(f, name, label, collection, labelFn, optional = false) {
      const input = field(f, name, label, { kind: 'select', required: !optional });
      selectBindings.push({ input, collection, labelFn, optional }); updateSelects(); return input;
    }
    function updateSelects() {
      for (let i = selectBindings.length - 1; i >= 0; i--) {
        const binding = selectBindings[i]; const { input, collection, labelFn, optional } = binding;
        if (!root.contains(input)) continue; // New shipment rows bind before attachment.
        const selected = input.value;
        const entries = (state.snapshot && state.snapshot[collection]) || [];
        input.replaceChildren(node('option', { value: '' }, optional ? 'No linked lot' : 'Select a record'));
        for (const row of entries) input.append(node('option', { value: row.id }, labelFn(row)));
        if (selected && !entries.some(row => row.id === selected)) input.append(node('option', { value: selected }, 'Selected record unavailable. Review before saving.'));
        input.value = selected;
      }
    }
    function submit(f, label, handler) {
      const btn = node('button', { type: 'submit', 'data-submit': f.element.dataset.form }, label);
      f.fields.append(btn);
      f.element.addEventListener('submit', (event) => { event.preventDefault(); if (recovery.isLocked() || f.busy || f.locked || !state.ready || state.unavailable || !state.alive) return;
        // Call synchronously so saving state gates a second submit in this event turn.
        try { Promise.resolve(handler()).catch(error => { if (state.alive) { errorAt(f.err, error); f.message.textContent = 'Not saved. Form retained.'; } }); }
        catch (error) { errorAt(f.err, error); f.message.textContent = 'Not saved. Form retained.'; }
      });
      return btn;
    }
    const values = f => Object.fromEntries(Object.entries(f.inputs).map(([name, input]) => [name, input.type === 'checkbox' ? input.checked : name === 'content' ? input.value : input.value.trim()]));
    function reset(f) { f.element.reset(); f.dirty = false; }
    async function mutate(f, action, payload, after) {
      if (recovery.isLocked() || f.busy || !state.ready || !state.alive || state.unavailable) return false;
      const returnFocus = f.element.contains(document.activeElement) ? document.activeElement : null;
      const restoreFocus = () => {
        if (!returnFocus || !state.active || !state.alive || (document.activeElement !== document.body && document.activeElement !== returnFocus)) return;
        if (returnFocus.isConnected && !returnFocus.matches(':disabled') && !returnFocus.closest('[hidden]')) returnFocus.focus({ preventScroll: true });
        else focusLane(state.lane);
      };
      f.busy = true; applyEnabled(f); f.message.textContent = 'Saving...';
      if (action === 'backup.restore') { state.shipmentFresh = false; state.shipmentOperator = null; updateShipmentRecovery(); }
      state.mutationEpoch++; state.sequence++; state.recallSequence++; state.auditSequence++; state.legacySequence++;
      legacyButton.disabled = false; refreshButton.disabled = false;
      printButton.disabled = true; recallForm.message.textContent = 'Records may have changed. Run recall again before printing. Previous result retained.';
      auditForm.message.textContent = 'Records changed. Read audit events again for current history.';
      let result;
      try { result = await request(action, payload); }
      catch (error) {
        if (action === 'backup.restore') global.dispatchEvent(new CustomEvent('crowe:farm-restore-result', { detail: { ok: false, error } }));
        if (state.alive) {
          errorAt(f.err, error); f.message.textContent = 'Not confirmed. Form retained.';
          if (error.code === 'UNAVAILABLE') unavailableState(error);
          f.busy = false; applyEnabled(f); restoreFocus();
        }
        return false;
      }
      if (action === 'backup.restore') global.dispatchEvent(new CustomEvent('crowe:farm-restore-result', { detail: { ok: true, data: result } }));
      if (!state.alive) return true;
      // A failed list refresh must never turn a confirmed write into a failed write.
      f.err.hidden = true; f.message.textContent = 'Saved to local records.';
      const refreshed = await refresh();
      if (!state.alive) return true;
      try {
        if (after) after(result, refreshed);
        if (!refreshed) f.message.textContent = 'Saved. List refresh failed; refresh records before another revision action.';
      } finally { f.busy = false; applyEnabled(f); if (action === 'backup.restore') updateShipmentRecovery(); restoreFocus(); }
      return true;
    }
    function table(headers, rows, message) {
      if (!rows.length) return empty(message);
      return node('div', { className: 'fc-table-wrap', tabindex: '0', role: 'region', 'aria-label': headers.join(', ') }, node('table', {}, node('thead', {}, node('tr', {}, headers.map(h => node('th', { scope: 'col' }, h)))),
        node('tbody', {}, rows.map(row => node('tr', {}, row.map(cell => node('td', {}, cell)))))));
    }
    function split(lane) { const wrap = node('div', { className: 'fc-split' }); const left = node('div', {}); const right = node('div', { className: 'fc-records' }); wrap.append(left, right); panes[lane].append(wrap); return [left, right]; }
    function recordList(lane, target) { lists[lane] = node('div', { 'data-list': lane }); target.append(lists[lane]); }
    function forgetSelects(element) { for (let i = selectBindings.length - 1; i >= 0; i--) if (element.contains(selectBindings[i].input)) selectBindings.splice(i, 1); }
    function removeForm(f) { if (f) { forms.delete(f); forgetSelects(f.element); f.element.remove(); } }
    function discardEditor(f) { return !f || (!f.busy && (!f.dirty || global.confirm('Discard this unsaved editor? Other forms will be retained.'))); }

    // Count-only overview. These are authoritative store counters, never inferred chart data.
    const kpis = node('dl', { className: 'fc-kpis', 'data-fc': 'kpis' });
    panes.overview.append(node('h2', {}, 'Recorded operations'), kpis,
      node('p', { className: 'fc-note' }, 'Harvested product only. Cultivation blocks and batches remain separate. Missing source records are not reconstructed.'),
      node('h2', {}, 'Recent lots'));
    recordList('recentLots', panes.overview);
    panes.overview.append(node('h2', {}, 'Recent shipments')); recordList('recentShipments', panes.overview);

    const [facilityLeft, facilityRight] = split('facility');
    const facilityForm = form('Facility record', 'facility', facilityLeft);
    field(facilityForm, 'name', 'Facility name', { required: true });
    field(facilityForm, 'ownerName', 'Owner name', { required: true });
    field(facilityForm, 'address', 'Address', { kind: 'textarea', rows: 2 });
    field(facilityForm, 'emergencyPhone', 'Emergency phone', { type: 'tel' });
    field(facilityForm, 'waterSource', 'Water source');
    submit(facilityForm, 'Save facility', () => mutate(facilityForm, 'facility.save', values(facilityForm), () => { facilityForm.dirty = false; }));
    facilityRight.append(node('h2', {}, 'Local owner record'), node('p', {}, 'Owner review is a local operational record, not regulatory certification or a verified electronic signature.'));
    recordList('facility', facilityRight);
    let facilityInitialized = false;

    const [lotLeft, lotRight] = split('lots');
    function lotFields(f, initial = {}) {
      field(f, 'harvestDate', 'Harvest date', { type: 'date', required: true, value: initial.harvestDate || '' });
      field(f, 'room', 'Room', { required: true, value: initial.room || '' });
      field(f, 'species', 'Species', { required: true, value: initial.species || '' });
      field(f, 'quantityLbs', 'Harvest quantity (lb)', { required: true, inputmode: 'decimal', pattern: '\\d+(\\.\\d{1,3})?', value: initial.quantityLbs || '' });
      field(f, 'notes', 'Notes', { kind: 'textarea', rows: 3, value: initial.notes || '' });
    }
    const lotForm = form('Create harvest lot', 'lot', lotLeft); lotFields(lotForm);
    submit(lotForm, 'Create lot', () => { const data = values(lotForm); data.quantityLbs = quantity(data.quantityLbs); return mutate(lotForm, 'lot.create', data, () => reset(lotForm)); });
    lotRight.append(node('h2', {}, 'Harvest lots')); recordList('lots', lotRight);
    const lotEditor = node('section', { className: 'fc-section', 'data-fc': 'lot-editor' }); panes.lots.append(lotEditor);
    let correctLotForm = null;
    const actorText = actor => typeof actor === 'object' && actor ? [actor.name, actor.id].filter(Boolean).join(' / ') : actor;
    function provenance(lot) {
      return node('section', { className: 'fc-provenance', 'data-provenance': lot.id || lot.sourceId || 'manual' },
        node('h3', {}, 'Preserved source provenance'),
        lot.sourceId ? node('dl', { className: 'fc-details' }, detail('Source identifier', lot.sourceId),
          detail('Source reviewed by', actorText(lot.sourceReviewedBy)), detail('Source approved at', lot.sourceApprovedAt), detail('Source hash', lot.sourceHash)) :
          node('p', { className: 'fc-note' }, 'Owner-entered harvest. No linked legacy source snapshot; source completeness is not verified.'),
        lot.sourceId ? node('details', { 'data-detail': `source-${lot.id || lot.sourceId}` }, node('summary', {}, 'Preserved source snapshot'), json(lot.sourceSnapshot)) : null);
    }
    function corrections(lot) {
      return node('section', { className: 'fc-corrections' }, node('h3', {}, `Harvest corrections: ${(lot.corrections || []).length}`),
        (lot.corrections || []).length ? (lot.corrections || []).map((change, i) => node('details', { 'data-detail': `correction-${lot.id}-${i}` },
          node('summary', {}, `${text(change.timestamp || change.createdAt)} / ${text(change.reason)}`),
          node('p', {}, `Recorded by: ${text(actorText(change.actor))}`), node('h3', {}, 'Before'), json(change.before), node('h3', {}, 'After'), json(change.after))) :
          node('p', { className: 'fc-note' }, 'No corrections recorded.'));
    }
    function lotEvidence(lot) {
      return node('div', {}, provenance(lot), corrections(lot), node('details', { 'data-detail': `original-${lot.id}` },
        node('summary', {}, 'Original harvest receipt'), json(lot.originalRecord)));
    }
    function shipmentLot(item) {
      const saved = item.lotSnapshot;
      const current = state.snapshot.lots.find(lot => lot.id === (item.lotId || saved && saved.id));
      return node('div', { className: 'fc-shipment-lot' },
        saved ? node('p', {}, `At shipment: ${text(saved.lotCode)} / ${text(saved.harvestDate)} / ${text(saved.species)} / ${text(saved.room)} / version ${text(saved.version)}`) :
          node('p', { className: 'fc-note' }, 'Shipment-time lot snapshot is not available. Do not infer historic facts from the current lot.'),
        current && saved && current.version !== saved.version ? node('p', { className: 'fc-note' }, `Harvest corrected since shipment. Current version ${current.version}; preserved shipment version ${text(saved.version)}.`) : null,
        saved ? node('details', { 'data-detail': `shipment-lot-${item.shipmentId || ''}-${item.lotId || saved.id}` }, node('summary', {}, 'Preserved shipment-time lot snapshot'), json(saved)) : null);
    }
    function correctLot(record) {
      if (!discardEditor(correctLotForm)) return;
      removeForm(correctLotForm);
      const f = correctLotForm = form('Correct harvest record', 'lot-correct', lotEditor);
      f.fields.append(node('p', {}, `${record.lotCode} / current version ${record.version}`),
        node('p', { className: 'fc-note' }, 'Append a correction with a reason. The original receipt, source identity, reviewer and shipment-time facts remain unchanged. Quantity cannot be below recorded shipments. This is not return or waste accounting.'), lotEvidence(record));
      lotFields(f, record);
      field(f, 'reason', 'Reason for harvest correction', { kind: 'textarea', rows: 3, required: true });
      submit(f, 'Append harvest correction', () => {
        const data = values(f); data.quantityLbs = quantity(data.quantityLbs);
        return mutate(f, 'lot.correct', { id: record.id, expectedVersion: record.version, ...data }, () => { removeForm(f); correctLotForm = null; focusLane('lots'); });
      });
      f.fields.append(button('Cancel correction', () => { if (discardEditor(f)) { removeForm(f); correctLotForm = null; focusLane('lots'); } }));
      f.inputs.harvestDate.focus();
    }
    function focusLane(lane) { if (state.active && state.lane === lane) navButtons[lane].focus(); }
    const adoption = node('section', { className: 'fc-section', 'data-fc': 'adoption' });
    const legacyList = node('div', { 'data-list': 'legacy' }); const adoptionEditor = node('div', {});
    const legacyError = node('div', { role: 'alert', className: 'fc-error', hidden: true });
    const legacyButton = button('Read current harvest sources', loadLegacy, { 'data-fc': 'load-legacy' });
    adoption.append(node('h2', {}, 'Adopt an existing harvest'), node('p', {}, 'Optional and owner-confirmed. Read the current source, review every field, then create a separate immutable compliance lot. Original cultivation records are never changed.'), legacyButton, legacyError, legacyList, adoptionEditor);
    panes.lots.append(adoption); let adoptForm = null;
    async function loadLegacy() {
      if (!state.ready || legacyButton.disabled) return;
      const seq = ++state.legacySequence; legacyButton.disabled = true;
      try {
        const result = api && typeof api.legacyHarvests === 'function' ? await api.legacyHarvests() : { ok: false, error: { code: 'UNAVAILABLE', message: 'Legacy harvest sources are unavailable in this runtime.' } };
        if (!state.alive || seq !== state.legacySequence) return;
        if (!result || !result.ok) throw result && result.error || { code: 'INVALID_RESPONSE', message: 'Could not read source records.' };
        legacyError.hidden = true;
        legacyList.replaceChildren(table(['Source', 'Harvest', 'Quantity (lb)', 'Adoption'], (result.data || []).map(row => [text(row.sourceId), `${text(row.date)} / ${text(row.strain)} / ${text(row.room)}`, text(row.weightLbs),
          row.adoptedLotId ? 'Already adopted' : button('Review source', () => beginAdoption(row), { 'data-source-id': row.sourceId })]), 'No current harvest sources. Create a lot manually when the owner has the source facts.'));
      } catch (error) { if (state.alive && seq === state.legacySequence) errorAt(legacyError, error); }
      finally { if (state.alive && seq === state.legacySequence) legacyButton.disabled = false; }
    }
    function beginAdoption(source) {
      if (!discardEditor(adoptForm)) return;
      removeForm(adoptForm);
      adoptForm = form('Review source adoption', 'adopt', adoptionEditor);
      const f = adoptForm;
      f.fields.append(node('p', {}, `Source identifier: ${source.sourceId}`), node('details', {}, node('summary', {}, 'Current source preview'), json(source)),
        node('p', { className: 'fc-note' }, 'The desktop re-reads this source at save time and retains that immutable snapshot. Reviewed lot fields are recorded separately. A later source edit cannot rewrite this lot.'));
      lotFields(f, { harvestDate: source.date, room: source.room, species: source.strain, quantityLbs: source.weightLbs });
      field(f, 'ownerConfirmation', 'I reviewed this harvest source and confirm these lot facts.', { type: 'checkbox', required: true });
      submit(f, 'Adopt reviewed harvest', () => { const data = values(f); if (!data.ownerConfirmation) throw { code: 'VALIDATION', message: 'Owner confirmation is required.' }; delete data.ownerConfirmation; data.quantityLbs = quantity(data.quantityLbs);
        return mutate(f, 'lot.adopt', { sourceId: source.sourceId, ...data }, () => { removeForm(f); adoptForm = null; loadLegacy(); }); });
      f.fields.append(button('Cancel adoption', () => { if (discardEditor(f)) { removeForm(f); adoptForm = null; focusLane('lots'); } }));
      f.inputs.harvestDate.focus();
    }

    const [shipmentLeft, shipmentRight] = split('shipments');
    const customerForm = form('Create customer', 'customer', shipmentLeft);
    field(customerForm, 'name', 'Customer name', { required: true }); field(customerForm, 'contact', 'Contact person');
    field(customerForm, 'email', 'Email', { type: 'email' }); field(customerForm, 'phone', 'Phone', { type: 'tel' });
    field(customerForm, 'address', 'Recipient address', { kind: 'textarea', rows: 2 });
    submit(customerForm, 'Create customer', () => mutate(customerForm, 'customer.create', values(customerForm), () => reset(customerForm)));
    const shipmentForm = form('Record shipment', 'shipment', shipmentLeft);
    select(shipmentForm, 'customerId', 'Customer', 'customers', row => row.name);
    field(shipmentForm, 'shippedAt', 'Shipment date and time (local)', { type: 'datetime-local', required: true });
    field(shipmentForm, 'notes', 'Shipment notes', { kind: 'textarea', rows: 2 });
    const shipmentRows = node('div', { className: 'fc-shipment-items', 'data-fc': 'shipment-items' });
    shipmentForm.fields.append(node('p', { className: 'fc-note' }, 'Recipient details are retained as they were at shipment time. Enter pounds to a maximum of 3 decimal places.'), shipmentRows);
    let itemCount = 0;
    function addItem() {
      const count = ++itemCount;
      const row = node('div', { className: 'fc-shipment-item', 'data-item': count });
      const temp = { ...shipmentForm, fields: row, inputs: {}, element: shipmentForm.element };
      const lot = select(temp, `lot-${count}`, 'Lot', 'lots', lot => `${lot.lotCode} / ${lot.remainingLbs} lb remaining`);
      const amount = field(temp, `quantity-${count}`, 'Quantity (lb)', { inputmode: 'decimal', required: true, pattern: '\\d+(\\.\\d{1,3})?' });
      row._item = { lot, amount }; row.append(button('Remove item', () => { forgetSelects(row); row.remove(); shipmentForm.dirty = true; addItemButton.focus(); }, { 'data-remove-item': count })); shipmentRows.append(row); updateSelects(); return row;
    }
    const addItemButton = button('Add lot to shipment', addItem, { 'data-fc': 'add-shipment-item' }); shipmentForm.fields.append(addItemButton); addItem();
    const shipmentSubmit = submit(shipmentForm, 'Record shipment', () => {
      if (recovery.isLocked() || state.pendingShipment || state.shipmentStorageError || !state.shipmentFresh || !state.shipmentOperator || restoreForm.busy) return;
      const data = values(shipmentForm); const when = new Date(data.shippedAt);
      if (!Number.isFinite(when.getTime())) throw { code: 'VALIDATION', message: 'Choose a shipment date and time.' };
      const items = [...shipmentRows.children].map(row => ({ lotId: row._item.lot.value, quantityLbs: quantity(row._item.amount.value) }));
      if (!items.length || items.some(item => !item.lotId)) throw { code: 'VALIDATION', message: 'Select at least one lot and enter its quantity.' };
      if (new Set(items.map(item => item.lotId)).size !== items.length) throw { code: 'VALIDATION', message: 'Each lot may appear only once in a shipment.' };
      recovery.assertUnlocked();
      const key = shipmentStorageKey(state.shipmentOperator);
      const raw = JSON.stringify({ schemaVersion: 1, operatorId: state.shipmentOperator, payload: { customerId: data.customerId,
        shippedAt: when.toISOString(), notes: data.notes, items, requestId: global.crypto.randomUUID() } });
      const pending = pendingRecord(raw, key);
      pending.persisted = false;
      // Check the entire namespace, then write and read back BEFORE any IPC call.
      // A failure retains the frozen intent and blocks dispatch (including retry).
      try {
        if (readPendingShipment()) throw recoveryError('Another pending shipment exists. Restart to recover it; no new shipment was sent.');
        state.pendingShipment = pending;
        recovery.assertUnlocked();
        global.localStorage.setItem(key, raw);
        if (global.localStorage.getItem(key) !== raw) throw recoveryError('Pending shipment storage did not retain the exact request.');
        pending.persisted = true;
      } catch (_) { blockShipmentStorage('Could not safely persist this shipment before dispatch. No new shipment was sent.'); return; }
      updateShipmentRecovery();
      return retryShipment();
    });
    const shipmentRetry = button('Retry unchanged shipment', retryShipment, { hidden: true, 'data-fc': 'retry-shipment' }); shipmentForm.retry = shipmentRetry;
    const shipmentEdit = button('Correct rejected shipment', () => {
      const pending = state.pendingShipment;
      if (recovery.isLocked() || shipmentForm.busy || !pending || !pending.definitive || state.shipmentStorageError || state.shipmentOperator !== pending.operatorId) return;
      // Restore the frozen fields, not any programmatic/unsaved edits made while locked.
      restoreShipmentFields(pending);
      if (!clearPendingShipment(pending)) return;
      shipmentForm.err.hidden = true;
      shipmentForm.message.textContent = 'Confirmed rejection. Correct the retained fields and submit a new request after refreshing records.';
      updateShipmentRecovery();
    }, { hidden: true, 'data-fc': 'correct-shipment' });
    shipmentForm.element.append(shipmentRetry, shipmentEdit);
    function blockShipmentStorage(message) {
      state.shipmentStorageError = `${message} New shipments and backup restore are blocked. Preserve this desktop profile and its pending shipment data; do not clear storage or re-enter the shipment. Recover storage access and restart.`;
      updateShipmentRecovery();
    }
    function restoreShipmentFields(pending) {
      const p = pending.payload;
      shipmentForm.inputs.customerId.value = p.customerId;
      // The JSON below always shows the exact UTC instant; datetime-local is display only.
      const when = new Date(p.shippedAt);
      shipmentForm.inputs.shippedAt.value = new Date(when.getTime() - when.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      shipmentForm.inputs.notes.value = p.notes;
      forgetSelects(shipmentRows); shipmentRows.replaceChildren();
      for (const item of p.items) { const row = addItem(); row._item.lot.append(node('option', { value: item.lotId }, item.lotId)); row._item.lot.value = item.lotId; row._item.amount.value = item.quantityLbs; }
      if (!shipmentForm.inputs.customerId.value) { shipmentForm.inputs.customerId.append(node('option', { value: p.customerId }, p.customerId)); shipmentForm.inputs.customerId.value = p.customerId; }
      updateSelects(); shipmentForm.dirty = true;
    }
    function updateShipmentRecovery() {
      const pending = state.pendingShipment;
      const mismatch = pending && state.shipmentOperator && pending.operatorId !== state.shipmentOperator;
      shipmentForm.locked = !!pending || !!state.shipmentStorageError || !state.shipmentOperator || !state.shipmentFresh || restoreForm.busy;
      shipmentSubmit.hidden = !!pending;
      shipmentRetry.hidden = !pending;
      shipmentEdit.hidden = !pending || !pending.definitive;
      shipmentEdit.disabled = recovery.isLocked() || shipmentForm.busy || !!state.shipmentStorageError || !!mismatch || !state.shipmentOperator;
      let message = state.shipmentStorageError;
      if (!message && mismatch) message = 'Pending shipment belongs to a different local operator than this database (possibly after backup restore). No new shipment or retry is allowed here. Return to the original database/profile to resolve it; the retained intent has not been discarded.';
      if (!message && pending) message = pending.definitive ? 'Shipment explicitly rejected. The original request remains frozen and stored. Retry unchanged, or choose Correct rejected shipment to release this rejected request before editing.' :
        `Unresolved shipment retained in this desktop profile. It may already be committed even if absent from the displayed snapshot. Fields and request ID are frozen. ${state.shipmentOperator ? 'Use Retry unchanged shipment only; restart the desktop app first if the local worker failed.' : 'Waiting for a desktop snapshot to verify the local operator before enabling an exact retry.'} Never re-enter it as a new shipment.`;
      if (!message && !state.shipmentFresh) message = 'New shipments are blocked until a current desktop snapshot and local operator are verified. Refresh records.';
      shipmentNotice.hidden = !message;
      shipmentNotice.replaceChildren(...(message ? [node('p', {}, message)] : []), ...(pending ? [node('p', {}, `Stored local operator: ${pending.operatorId}. Request ID: ${pending.payload.requestId}.`), node('details', { 'data-fc': 'pending-shipment-payload' }, node('summary', {}, 'Exact retained shipment request'), json(pending.payload)), button('Review shipment recovery', () => open('shipments'))] : []));
      applyEnabled(shipmentForm);
      // Initialized before the initial storage scan; block identity-changing restore
      // while an allocation's outcome is unresolved, even on an empty snapshot.
      restoreForm.locked = !farmEmpty() || !!pending || !!state.shipmentStorageError;
      applyEnabled(restoreForm);
    }
    function verifyPendingShipment(pending) {
      const saved = readPendingShipment();
      if (!pending.persisted || !saved || saved.key !== pending.key || saved.raw !== pending.raw) throw recoveryError('Pending shipment storage changed or disappeared.');
    }
    function clearPendingShipment(pending) {
      // Keep the exact intent if a host lease arrived while dispatch was in flight.
      if (recovery.isLocked()) return false;
      try {
        verifyPendingShipment(pending);
        recovery.assertUnlocked();
        global.localStorage.removeItem(pending.key);
        if (global.localStorage.getItem(pending.key) !== null) throw recoveryError('Pending shipment could not be cleared.');
      } catch (_) { blockShipmentStorage('The shipment result was definitive, but pending storage could not be safely cleared.'); return false; }
      state.pendingShipment = null;
      return true;
    }
    async function retryShipment() {
      const pending = state.pendingShipment;
      if (recovery.isLocked() || !state.alive || !state.ready || state.unavailable || !pending || shipmentForm.busy || state.shipmentStorageError || state.shipmentOperator !== pending.operatorId) return;
      try { verifyPendingShipment(pending); }
      catch (_) { blockShipmentStorage('The retained shipment cannot be verified in desktop storage. Nothing was sent.'); return; }
      pending.definitive = false;
      shipmentForm.busy = true; state.shipmentFresh = false;
      state.mutationEpoch++; state.sequence++; state.recallSequence++; state.auditSequence++; state.legacySequence++;
      legacyButton.disabled = false; refreshButton.disabled = false; printButton.disabled = true;
      recallForm.message.textContent = 'Shipment outcome pending. Run recall again before printing.';
      auditForm.message.textContent = 'Shipment outcome pending. Read audit again for current history.';
      shipmentForm.message.textContent = 'Submitting exact stored shipment request...'; updateShipmentRecovery();
      try {
        const result = await request('shipment.create', pending.payload);
        // An ok envelope without a shipment identity is not proof of a commit.
        if (!result || !validId(result.id)) throw { code: 'INVALID_RESPONSE', message: 'No confirmed shipment identity was returned.' };
        if (!state.alive) return;
        shipmentForm.err.hidden = true;
        shipmentForm.message.textContent = 'Shipment confirmed in local records.';
        if (clearPendingShipment(pending)) { reset(shipmentForm); forgetSelects(shipmentRows); shipmentRows.replaceChildren(); addItem(); }
        const refreshed = await refresh();
        if (state.alive && !refreshed) shipmentForm.message.textContent = 'Shipment confirmed. List refresh failed; refresh records before recording another shipment.';
      } catch (error) {
        if (!state.alive) return;
        pending.definitive = DEFINITIVE_ERRORS.has(error.code);
        errorAt(shipmentForm.err, error);
        shipmentForm.message.textContent = pending.definitive ? 'Shipment rejected. Retry unchanged or explicitly correct this rejected request.' : 'Outcome unknown. Exact request retained across restart. Do not re-enter this shipment.';
        // Keep the recovery notice and controls visible even for a terminal worker
        // failure; the UNAVAILABLE surface must not hide a possibly committed intent.
      } finally {
        shipmentForm.busy = false;
        if (state.alive) updateShipmentRecovery();
        else if (!state.shipmentStorageError && (!state.pendingShipment || state.pendingShipment.persisted)) unregisterRecovery();
      }
    }
    shipmentRight.append(node('h2', {}, 'Customers')); recordList('customers', shipmentRight);
    shipmentRight.append(node('h2', {}, 'Shipments')); recordList('shipments', shipmentRight);

    const [logLeft, logRight] = split('logs');
    function logFields(f, initial = {}) {
      field(f, 'loggedAt', 'Log date', { type: 'date', required: true, value: initial.loggedAt || '' });
      field(f, 'room', 'Room', { required: true, value: initial.room || '' });
      field(f, 'temperatureF', 'Temperature (F)', { type: 'number', step: 'any', value: initial.temperatureF });
      field(f, 'humidityPercent', 'Humidity (%)', { type: 'number', min: 0, max: 100, step: 'any', value: initial.humidityPercent });
      field(f, 'cleaningCompleted', 'Cleaning completed', { type: 'checkbox', value: initial.cleaningCompleted });
      const lot = select(f, 'lotId', 'Linked harvest lot (optional)', 'lots', row => row.lotCode, true); lot.value = initial.lotId || '';
      field(f, 'deviationNotes', 'Deviation notes', { kind: 'textarea', rows: 3, value: initial.deviationNotes || '' });
      field(f, 'correctiveAction', 'Corrective action', { kind: 'textarea', rows: 3, value: initial.correctiveAction || '' });
    }
    function logPayload(f) { const data = values(f); for (const key of ['temperatureF', 'humidityPercent']) { data[key] = data[key] === '' ? null : Number(data[key]); if (data[key] !== null && !Number.isFinite(data[key])) throw { code: 'VALIDATION', message: 'Environment readings must be finite numbers.' }; } data.lotId = data.lotId || null; return data; }
    const logForm = form('Record daily activity', 'log', logLeft); logFields(logForm);
    logForm.fields.append(node('p', { className: 'fc-note' }, 'Deviation notes open a deviation. Corrective text alone does not resolve it. Use the explicit resolve action after review.'));
    submit(logForm, 'Record daily log', () => mutate(logForm, 'log.create', logPayload(logForm), () => reset(logForm)));
    logRight.append(node('h2', {}, 'Daily records'));
    const logFilter = node('select', { 'aria-label': 'Filter deviation status', 'data-fc': 'log-filter', onchange: renderLogs },
      ['ALL', 'OPEN', 'RESOLVED', 'NONE'].map(v => node('option', { value: v }, v === 'ALL' ? 'All deviation states' : v)));
    logRight.append(logFilter); recordList('logs', logRight);
    const logEditor = node('div', { 'data-fc': 'log-editor' }); logLeft.append(logEditor); let editLogForm = null;
    function editLog(record, action) {
      if (!discardEditor(editLogForm)) return; removeForm(editLogForm);
      const f = editLogForm = form(action === 'log.update' ? 'Edit daily log' : action === 'log.resolve' ? 'Resolve deviation' : 'Reopen deviation', 'log-edit', logEditor);
      f.fields.append(node('p', {}, `${record.loggedAt} / ${record.room} / version ${record.version}`), node('p', {}, `Current deviation: ${record.deviationStatus}. ${record.deviationNotes || ''}`));
      if (action === 'log.update') logFields(f, record);
      else if (action === 'log.resolve') field(f, 'correctiveAction', 'Completed corrective action', { kind: 'textarea', rows: 4, required: true, value: record.correctiveAction });
      field(f, 'reason', 'Reason for this change', { kind: 'textarea', rows: 2, required: true });
      (f.inputs.loggedAt || f.inputs.correctiveAction || f.inputs.reason).focus();
      submit(f, action === 'log.resolve' ? 'Confirm resolution' : action === 'log.reopen' ? 'Confirm reopen' : 'Save log revision', () => mutate(f, action,
        { id: record.id, expectedVersion: record.version, ...(action === 'log.update' ? logPayload(f) : values(f)) }, () => { removeForm(f); editLogForm = null; }));
      f.fields.append(button('Close editor', () => { if (discardEditor(f)) { removeForm(f); editLogForm = null; focusLane('logs'); } }));
    }
    function renderLogs() {
      if (!state.snapshot) return;
      const rows = state.snapshot.logs.filter(row => logFilter.value === 'ALL' || row.deviationStatus === logFilter.value);
      lists.logs.replaceChildren(table(['Date / room', 'Environment', 'Cleaning / deviation', 'Review'], rows.map(row => [
        `${row.loggedAt} / ${row.room}`, `${text(row.temperatureF)} F / ${text(row.humidityPercent)}%`,
        node('details', { 'data-detail': `log-${row.id}` }, node('summary', {}, `${row.cleaningCompleted ? 'Completed' : 'Not completed'} / ${row.deviationStatus}`),
          node('dl', {}, detail('Deviation notes', row.deviationNotes), detail('Corrective action', row.correctiveAction), detail('Resolved by', actorText(row.resolvedBy)), detail('Resolved at', row.resolvedAt), detail('Record version', row.version))),
        node('div', { className: 'fc-actions' }, button('Edit', () => editLog(row, 'log.update'), { 'data-log-id': row.id }),
          row.deviationStatus === 'OPEN' ? button('Resolve', () => editLog(row, 'log.resolve'), { 'data-resolve-id': row.id }) : null,
          row.deviationStatus === 'RESOLVED' ? button('Reopen', () => editLog(row, 'log.reopen'), { 'data-reopen-id': row.id }) : null)
      ]), 'No daily records match this filter.'));
    }

    const recallForm = form('Trace a harvest lot', 'recall', panes.recall);
    select(recallForm, 'lotId', 'Harvest lot', 'lots', row => `${row.lotCode} / ${row.species}`);
    const recallResult = node('section', { className: 'fc-recall-result', 'data-fc': 'recall-result', 'aria-live': 'polite' }, empty('Choose a lot to inspect recorded recipients.'));
    const printButton = button('Print recall record', () => {
      if (printButton.disabled || !state.active || state.lane !== 'recall') return;
      const closed = [...recallResult.querySelectorAll('details:not([open])')];
      closed.forEach(detail => { detail.open = true; });
      root.classList.add('fc-printing');
      try { global.print(); } finally { root.classList.remove('fc-printing'); closed.forEach(detail => { detail.open = false; }); }
    }, { disabled: true, 'data-fc': 'print-recall' });
    submit(recallForm, 'Inspect recall', async () => {
      const seq = ++state.recallSequence; const epoch = state.mutationEpoch;
      recallForm.busy = true; applyEnabled(recallForm); printButton.disabled = true; recallForm.message.textContent = 'Reading affected shipments...';
      try {
        const report = await request('recall', values(recallForm));
        if (!state.alive || seq !== state.recallSequence || epoch !== state.mutationEpoch) return;
        recallForm.err.hidden = true; recallForm.message.textContent = 'Recall record ready.';
        recallResult.replaceChildren(node('h2', {}, `Recall record: ${report.lot.lotCode}`), node('p', {}, `Facility: ${state.snapshot.facility ? state.snapshot.facility.name : 'Not recorded'}`),
          node('p', {}, `Harvest: ${report.lot.harvestDate} / ${report.lot.species} / ${report.lot.room}`),
          node('p', { className: 'fc-mono' }, `Shipped: ${report.totalShippedLbs} lb. Remaining: ${report.remainingLbs} lb.`),
          node('p', { className: 'fc-caption' }, 'Local source scope: only lots, source snapshots and shipments recorded in this desktop database. Missing source facts are not reconstructed. Recipients and lot facts below are retained at shipment time. No notifications have been sent.'),
          lotEvidence(report.lot),
          table(['Shipment / date', 'Recipient at shipment', 'Quantity (lb)', 'Shipment-time lot facts / notes'], report.affectedShipments.map(item => [
            `${item.shipmentId} / ${item.shippedAt}`, node('div', {}, node('strong', {}, item.customer.name), node('p', {}, [item.customer.contact, item.customer.email, item.customer.phone, item.customer.address].filter(Boolean).join('\n'))), item.quantityLbs,
            node('div', {}, shipmentLot(item), node('p', {}, text(item.notes)))
          ]), 'No shipments recorded for this lot. No affected recipients in this database.'), node('p', { className: 'fc-caption', 'data-fc': 'recall-generated' }, `Generated ${new Date().toISOString()}. Desktop-local operational record, not a regulatory determination.`));
        printButton.disabled = false;
      } catch (error) { if (state.alive && seq === state.recallSequence) { errorAt(recallForm.err, error); recallForm.message.textContent = 'Recall was not refreshed.'; } }
      finally { if (state.alive) { recallForm.busy = false; applyEnabled(recallForm); } }
    });
    panes.recall.append(printButton, recallResult);
    recallForm.inputs.lotId.addEventListener('change', () => { state.recallSequence++; printButton.disabled = true; recallResult.replaceChildren(empty('Selection changed. Inspect this lot before printing.')); });

    const [documentLeft, documentRight] = split('documents');
    const documentForm = form('Draft an operating document', 'document', documentLeft);
    field(documentForm, 'title', 'Document title', { required: true });
    field(documentForm, 'type', 'Document type', { kind: 'select', options: DOCUMENT_TYPES });
    field(documentForm, 'content', 'Document text', { kind: 'textarea', rows: 8, maxLength: 100000, required: true });
    submit(documentForm, 'Create draft', () => mutate(documentForm, 'document.create', values(documentForm), () => reset(documentForm)));
    documentRight.append(node('h2', {}, 'Documents & revisions'), node('p', { className: 'fc-note' }, 'Approval records local human review. It is not regulatory approval, certification or a verified electronic signature. Approved content cannot be edited.'));
    recordList('documents', documentRight);
    const documentEditor = node('section', { className: 'fc-section', 'data-fc': 'document-editor' }); panes.documents.append(documentEditor);
    let revisionForm = null;
    function showRevision(doc, revision) {
      if (!discardEditor(revisionForm)) return;
      removeForm(revisionForm); revisionForm = null; documentEditor.replaceChildren();
      const f = revisionForm = form(`${revision.title} / revision ${revision.version}`, 'revision', documentEditor);
      f.fields.append(node('dl', { className: 'fc-details' }, detail('Status', revision.status), detail('Local reviewer', actorText(revision.approvedBy)), detail('Approved at', revision.approvedAt),
        detail('Content hash', revision.contentHash), detail('Supersedes', revision.supersedesRevisionId), detail('Superseded by', revision.supersededByRevisionId)));
      const mutable = revision.status === 'DRAFT' || revision.status === 'NEEDS_REVIEW';
      const identity = { id: doc.id, revisionId: revision.id, expectedVersion: revision.editVersion };
      const reload = (_result, refreshed, latest = false) => {
        f.dirty = false;
        if (!refreshed) {
          f.locked = true;
          f.element.append(button('Load saved revision', async () => {
            if (f.busy) return;
            f.busy = true; applyEnabled(f);
            const current = await refresh(); f.busy = false;
            if (state.alive && current) reload(null, true, latest);
            else if (state.alive) applyEnabled(f);
          }, { 'data-fc': 'reload-revision' }));
          return;
        }
        const next = state.snapshot.documents.find(item => item.id === doc.id); if (!next) return;
        f.busy = false;
        showRevision(next, latest ? next.revisions.reduce((a, b) => a.version > b.version ? a : b) : next.revisions.find(item => item.id === revision.id) || next.revisions[next.revisions.length - 1]);
      };
      if (mutable) {
        field(f, 'title', 'Revision title', { required: true, value: revision.title });
        field(f, 'content', 'Revision text', { kind: 'textarea', rows: 12, maxLength: 100000, required: true, value: revision.content });
        field(f, 'reason', 'Reason for edit', { kind: 'textarea', rows: 2 });
        submit(f, 'Save draft changes', () => { const data = values(f); if (!data.reason) throw { code: 'VALIDATION', message: 'A reason is required to edit a revision.' }; delete data.attestation;
          return mutate(f, 'document.edit', { ...identity, ...data }, reload); });
        const reviewTransition = (action, extra = {}) => {
          if (f.inputs.title.value !== revision.title || f.inputs.content.value !== revision.content) { errorAt(f.err, { code: 'UNSAVED_CHANGES', message: 'Save draft changes before changing review status.' }); return; }
          return mutate(f, action, { ...identity, ...extra }, reload);
        };
        if (revision.status === 'DRAFT') f.fields.append(button('Submit for owner review', () => reviewTransition('document.submit'), { 'data-fc': 'submit-review' }));
        if (revision.status === 'NEEDS_REVIEW') {
          field(f, 'attestation', 'I reviewed this exact revision and approve it for local use. Any prior approved revision will be superseded.', { type: 'checkbox' });
          f.fields.append(button('Approve reviewed revision', () => { if (!f.inputs.attestation.checked) { errorAt(f.err, { code: 'ATTESTATION_REQUIRED', message: 'Human review attestation is required.' }); return; } return reviewTransition('document.approve', { attestation: true }); }, { 'data-fc': 'approve-revision' }));
        }
      } else {
        f.fields.append(node('p', { className: 'fc-note' }, 'Immutable revision. Changes require a successor draft.'), node('pre', { className: 'fc-document-content' }, revision.content));
        if (revision.status === 'APPROVED') {
          field(f, 'reason', 'Reason for successor revision', { kind: 'textarea', rows: 2, required: true });
          f.fields.append(node('p', {}, 'The current approval stays active until the successor is reviewed and approved.'));
          submit(f, 'Create successor draft', () => mutate(f, 'document.revise', { id: doc.id, reason: values(f).reason }, (result, refreshed) => reload(result, refreshed, true)));
        }
      }
      f.fields.append(button('Close revision', () => { if (discardEditor(f)) { removeForm(f); revisionForm = null; focusLane('documents'); } }, { 'data-fc': 'close-revision' }));
      f.element.tabIndex = -1;
      if (state.active && state.lane === 'documents') (f.inputs.title || f.element).focus();
    }

    const [auditLeft, auditRight] = split('audit');
    const auditForm = form('Inspect audit history', 'audit', auditLeft);
    field(auditForm, 'entityId', 'Entity identifier (optional)');
    const auditResult = node('div', { 'data-list': 'audit' }); auditLeft.append(auditResult);
    submit(auditForm, 'Read audit events', async () => {
      const seq = ++state.auditSequence; const epoch = state.mutationEpoch;
      auditForm.busy = true; applyEnabled(auditForm); auditForm.message.textContent = 'Reading audit...';
      try {
        const value = values(auditForm).entityId; const events = await request('audit', value ? { entityId: value } : {});
        if (!state.alive || seq !== state.auditSequence || epoch !== state.mutationEpoch) return;
        auditForm.err.hidden = true; auditForm.message.textContent = `${events.length} recorded events.`;
        auditResult.replaceChildren(events.length ? node('div', {}, events.map(event => node('details', { className: 'fc-audit-event' },
          node('summary', {}, `${text(event.timestamp || event.createdAt)} / ${text(event.action)}`), node('dl', {}, detail('Event', event.id), detail('Entity', event.entityId),
            detail('Actor', typeof event.actor === 'object' ? JSON.stringify(event.actor) : event.actor), detail('Reason', event.reason)),
          node('h3', {}, 'Before'), json(event.before), node('h3', {}, 'After'), json(event.after)))) : empty('No audit events match this entity.'));
      } catch (error) { if (state.alive && seq === state.auditSequence) errorAt(auditForm.err, error); }
      finally { if (state.alive) { auditForm.busy = false; applyEnabled(auditForm); } }
    });
    auditRight.append(node('h2', {}, 'Operational backup'), node('p', {}, 'JSON backups include records, audit history and source provenance. Keep downloaded files private. Audit is append-only through this app, not tamper-proof against an operating-system administrator.'));
    auditRight.append(node('p', { className: 'fc-note', 'data-fc': 'emergency-export-warning' }, 'Emergency backup is not transfer clearance. It does not contain or resolve pending shipment intents. Keep this source profile intact and use Transfer records for a recovery-checked export before cutover.'));
    const exportForm = form('Export local snapshot', 'export', auditRight);
    submit(exportForm, 'Download JSON backup', async () => {
      exportForm.busy = true; applyEnabled(exportForm); exportForm.message.textContent = 'Preparing consistent backup...';
      try {
        const backup = await request('backup.export'); if (!state.alive) return;
        const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
        if (blob.size > MAX_BACKUP_BYTES) throw { code: 'INVALID_BACKUP', message: 'This export exceeds the 10 MiB restore limit. No unusable backup was downloaded.' };
        const url = URL.createObjectURL(blob);
        const anchor = node('a', { href: url, download: `crowe-farm-backup-${new Date().toISOString().slice(0, 10)}.json` });
        root.append(anchor); anchor.click(); anchor.remove(); global.setTimeout(() => URL.revokeObjectURL(url), 1000);
        exportForm.err.hidden = true; exportForm.message.textContent = 'Backup download requested. Confirm the file is saved before relying on it.';
      } catch (error) { if (state.alive) errorAt(exportForm.err, error); }
      finally { if (state.alive) { exportForm.busy = false; applyEnabled(exportForm); } }
    });
    const restoreForm = form('Restore into an empty farm', 'restore', auditRight);
    const restoreNotice = node('p', { className: 'fc-note', 'data-fc': 'restore-notice' }); restoreForm.fields.append(restoreNotice);
    const backupFile = field(restoreForm, 'backupFile', 'Owner-selected JSON backup (maximum 10 MiB)', { type: 'file', accept: '.json,application/json', required: true });
    field(restoreForm, 'confirmation', 'Type RESTORE EMPTY FARM to confirm', { required: true, autocomplete: 'off' });
    submit(restoreForm, 'Validate and restore empty farm', async () => {
      recovery.assertUnlocked();
      if (state.pendingShipment || state.shipmentStorageError) throw recoveryError('Resolve pending shipment recovery before restoring a different farm identity.');
      if (!farmEmpty()) throw { code: 'STORE_NOT_EMPTY', message: 'This farm contains records. Restore cannot overwrite a populated farm.' };
      if (restoreForm.inputs.confirmation.value !== 'RESTORE EMPTY FARM') throw { code: 'CONFIRMATION_REQUIRED', message: 'Type RESTORE EMPTY FARM exactly.' };
      const file = backupFile.files[0];
      if (!file || !file.size || file.size > MAX_BACKUP_BYTES) throw { code: 'BACKUP_TOO_LARGE', message: 'Select a nonempty JSON backup no larger than 10 MiB.' };
      restoreForm.busy = true; applyEnabled(restoreForm); restoreForm.message.textContent = 'Reading selected backup...';
      let backup;
      try { backup = JSON.parse(await file.text()); }
      catch (_) { throw { code: 'INVALID_BACKUP', message: 'The selected file is not valid JSON. No records were restored.' }; }
      finally { restoreForm.busy = false; if (state.alive) applyEnabled(restoreForm); }
      if (!state.alive) return;
      recovery.assertUnlocked();
      if (state.pendingShipment || state.shipmentStorageError) throw recoveryError('A shipment became pending while reading the backup. Resolve it before restoring.');
      return mutate(restoreForm, 'backup.restore', { backup, confirmation: 'RESTORE EMPTY FARM' }, () => reset(restoreForm));
    });
    function farmEmpty() { const s = state.snapshot; return !!s && !s.facility && ['lots', 'customers', 'shipments', 'logs', 'documents'].every(key => s[key].length === 0); }

    function renderSnapshot() {
      // Lists alone are reconciled. Form nodes, selection, drafts and optimistic
      // version captures stay untouched. Preserve open evidence and list focus too.
      const opened = [...root.querySelectorAll('[data-list] details[open][data-detail]')].map(el => el.dataset.detail);
      const focused = document.activeElement;
      const focusList = focused && focused.closest('[data-list]');
      const focusKey = focusList && [...focused.attributes].find(attr => attr.name.startsWith('data-'));
      const s = state.snapshot;
      const dashboard = s.dashboard;
      kpis.replaceChildren(...[['lotsCreated', 'Harvest lots'], ['shipmentsRecorded', 'Shipments'], ['openDeviations', 'Open deviations'], ['documentsAwaitingApproval', 'Awaiting review']].map(([key, label]) =>
        node('div', {}, node('dt', {}, label), node('dd', { 'data-count': key }, dashboard[key]))));
      const lotRows = rows => rows.map(row => [row.lotCode, `${row.harvestDate} / ${row.species}`, row.quantityLbs, row.remainingLbs]);
      lists.recentLots.replaceChildren(table(['Lot', 'Harvest / species', 'Harvested (lb)', 'Remaining (lb)'], lotRows(dashboard.recentLots || []), 'No lots recorded. Create a harvest lot to begin.'));
      lists.recentShipments.replaceChildren(table(['Shipment', 'Recipient', 'Date'], (dashboard.recentShipments || []).map(row => [row.id, row.customer && row.customer.name || 'Not recorded', row.shippedAt]), 'No shipments recorded.'));
      lists.facility.replaceChildren(s.facility ? node('dl', { className: 'fc-details' }, ...['name', 'ownerName', 'address', 'emergencyPhone', 'waterSource'].map(key => detail(key, s.facility[key]))) : empty('No facility saved. Record the facility and responsible owner.'));
      if (!facilityInitialized && !facilityForm.dirty && s.facility) { for (const [key, input] of Object.entries(facilityForm.inputs)) input.value = s.facility[key] || ''; facilityInitialized = true; }
      lists.lots.replaceChildren(table(['Lot / harvest', 'Species / room', 'Quantity / remaining (lb)', 'Evidence / correction'], s.lots.map(row => [
        `${row.lotCode} / ${row.harvestDate}`, `${row.species} / ${row.room}`, `${row.quantityLbs} / ${row.remainingLbs}`,
        node('div', {}, node('details', { 'data-detail': `lot-${row.id}`, 'data-lot-id': row.id }, node('summary', {}, `Version ${row.version} / ${row.sourceId ? 'Adopted source' : 'Owner-entered harvest'}`), lotEvidence(row)),
          button('Correct harvest', () => correctLot(row), { 'data-correct-lot-id': row.id }))
      ]), 'No harvest lots recorded.'));
      lists.customers.replaceChildren(table(['Name', 'Contact', 'Address'], s.customers.map(row => [row.name, [row.contact, row.email, row.phone].filter(Boolean).join(' / '), text(row.address)]), 'No customers recorded.'));
      lists.shipments.replaceChildren(table(['Shipment / date', 'Recipient snapshot', 'Lot quantities'], s.shipments.map(row => [
        `${row.id} / ${row.shippedAt}`, node('details', { 'data-detail': `recipient-${row.id}` }, node('summary', {}, row.customer.name), json(row.customer)),
        node('div', {}, row.items.map(item => node('div', {}, node('p', {}, `${item.lotCode}: ${item.quantityLbs} lb`), shipmentLot({ ...item, shipmentId: row.id }))))
      ]), 'No shipments recorded.'));
      renderLogs();
      lists.documents.replaceChildren(s.documents.length ? node('div', {}, s.documents.map(doc => node('section', { className: 'fc-document-record' }, node('h3', {}, doc.title), node('p', { className: 'fc-caption' }, doc.type),
        doc.revisions.map(rev => button(`Revision ${rev.version}: ${rev.status}`, () => showRevision(doc, rev), { 'data-document-id': doc.id, 'data-revision-id': rev.id }))))) : empty('No operating documents. Start with a draft for local owner review.'));
      restoreNotice.textContent = farmEmpty() ? 'No records are currently visible. The service must also verify that the database and audit history are empty. Restore validates the complete backup before committing.' : 'This farm contains records. Restore is unavailable here and will not overwrite them. Export a backup to preserve the current state.';
      restoreForm.locked = !farmEmpty() || !!state.pendingShipment || !!state.shipmentStorageError;
      updateSelects(); forms.forEach(applyEnabled);
      root.querySelectorAll('[data-list] details[data-detail]').forEach(el => { if (opened.includes(el.dataset.detail)) el.open = true; });
      if (focusKey && focusList.isConnected && state.active) {
        const replacement = [...focusList.querySelectorAll(focused.tagName)].find(el => el.getAttribute(focusKey.name) === focusKey.value);
        if (replacement) replacement.focus({ preventScroll: true });
      }
    }
    async function refresh() {
      if (!state.alive) return false;
      const seq = ++state.sequence; const epoch = state.mutationEpoch;
      state.recallSequence++; state.auditSequence++; printButton.disabled = true;
      recallForm.message.textContent = 'Snapshot refresh requested. Inspect the lot again before printing; previous result retained.';
      refreshButton.disabled = true; status.textContent = 'Reading local records...';
      state.shipmentFresh = false; updateShipmentRecovery();
      try {
        const snapshot = await request('snapshot');
        if (!state.alive || seq !== state.sequence || epoch !== state.mutationEpoch) return false;
        if (!snapshot || !snapshot.dashboard || !snapshot.storage || !['lots', 'customers', 'shipments', 'logs', 'documents'].every(key => Array.isArray(snapshot[key]))) throw { code: 'INVALID_RESPONSE', message: 'The local snapshot is incomplete. Existing drafts are retained.' };
        state.snapshot = snapshot; state.ready = true; state.unavailable = false;
        const operator = snapshot.storage.operator && snapshot.storage.operator.id;
        state.shipmentOperator = snapshot.storage.kind === 'desktop-local' && snapshot.storage.schemaVersion === 1 && validId(operator) ? operator : null;
        state.shipmentFresh = !!state.shipmentOperator;
        if (!state.shipmentStorageError) {
          try {
            if (state.pendingShipment) verifyPendingShipment(state.pendingShipment);
            else { const saved = readPendingShipment(); if (saved) { state.pendingShipment = saved; restoreShipmentFields(saved); } }
          } catch (_) { blockShipmentStorage('Pending shipment storage is unreadable, corrupt, unsupported, or changed.'); }
        }
        updateShipmentRecovery();
        unavailable.hidden = true; nav.hidden = false; body.hidden = false;
        alert.hidden = true; storageNotice.textContent = `${snapshot.storage.notice || 'Desktop-local records.'} Local operator: ${snapshot.storage.operator && snapshot.storage.operator.name || 'Not recorded'}.`;
        renderSnapshot(); status.textContent = 'Local records current. Unsaved forms retained.'; return true;
      } catch (error) {
        if (state.alive && seq === state.sequence) { if (error.code === 'UNAVAILABLE') unavailableState(error); else { errorAt(alert, error); status.textContent = state.snapshot ? 'Refresh failed. Showing the last snapshot; drafts retained.' : 'Local records could not be opened.'; } }
        return false;
      } finally { if (state.alive && seq === state.sequence) refreshButton.disabled = false; }
    }
    // Do not equate a busy restore form with an active shipment: main acquires
    // its lease after restore has dispatched. That must not self-deadlock.
    const unregisterRecovery = recovery.registerBlocker(() => state.shipmentStorageError ||
      (state.pendingShipment ? 'A retained shipment must be resolved in its original profile.' : null) ||
      (shipmentForm.busy ? 'A shipment request is still in flight.' : null));
    const unsubscribeRecovery = recovery.subscribe(() => { if (state.alive) { updateShipmentRecovery(); forms.forEach(applyEnabled); } });
    // Read profile storage before the first snapshot or operator is known. A slow
    // or failed mount cannot briefly expose a new editable shipment form.
    try { state.pendingShipment = readPendingShipment(); if (state.pendingShipment) restoreShipmentFields(state.pendingShipment); }
    catch (_) { blockShipmentStorage('Pending shipment storage is unreadable, corrupt, or uses an unsupported schema.'); }
    updateShipmentRecovery();
    open('overview'); refresh();
    return {
      open,
      deactivate() { if (state.alive) { state.active = false; root.hidden = true; root.classList.remove('fc-printing'); } },
      destroy() { if (!state.alive) return; unsubscribeRecovery(); if (!state.shipmentStorageError && !shipmentForm.busy && (!state.pendingShipment || state.pendingShipment.persisted)) unregisterRecovery(); state.alive = false; state.sequence++; state.recallSequence++; state.auditSequence++; state.legacySequence++; forms.clear(); root.remove(); }
    };
  }
  global.FarmCompliance = Object.freeze({ mount });
})(window);
