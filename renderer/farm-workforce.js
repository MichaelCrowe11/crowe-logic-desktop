/* Private workforce UI. Host owns authenticated transport and farm selection.
 * Destroy/remount on identity or farm change. No inference or browser storage.
 * Retry retains the exact in-memory command, including occurrence time and hash.
 */
(function (root, factory) {
  'use strict';
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.FarmWorkforce = exported;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  let mounts = 0;
  const clean = value => typeof value === 'string' ? value : '';
  function requestId() {
    if (!globalThis.crypto?.randomUUID) throw new Error('Secure request IDs are unavailable. Nothing was sent.');
    return globalThis.crypto.randomUUID();
  }
  function stampNow() {
    const now = new Date(), offset = -now.getTimezoneOffset();
    const local = new Date(now.getTime() + offset * 60000).toISOString().slice(0, -1);
    const sign = offset < 0 ? '-' : '+';
    const pad = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
    return { occurredAt: `${local}${sign}${pad(offset / 60)}:${pad(offset % 60)}`, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', offline: false };
  }
  function mount(container, api, options = {}) {
    if (!container?.ownerDocument || !options.farmId || !options.currentMemberId) throw new Error('Workforce needs an authenticated farm selection.');
    const doc = container.ownerDocument, win = doc.defaultView, prefix = `fw-${++mounts}`;
    const farmId = options.farmId, self = options.currentMemberId;
    const manager = ['owner', 'manager'].includes(options.role), owner = options.role === 'owner';
    let alive = true, active = true, epoch = 0, busy = false, pending = null;
    let shifts = [], sheets = [], preview = null, selfShift = null;
    const listeners = new Set();
    function el(tag, attrs = {}, ...children) {
      const node = doc.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'className') node.className = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else if (value !== false && value !== undefined && value !== null) node.setAttribute(key, value === true ? '' : String(value));
      }
      for (const child of children.flat()) if (child !== undefined && child !== null) node.append(child.nodeType ? child : doc.createTextNode(String(child)));
      return node;
    }
    const button = (text, fn, attrs = {}) => el('button', { type: 'button', onclick: fn, ...attrs }, text);
    const note = text => el('p', { className: 'fw-note' }, text);
    function field(label, name, tag = 'input', attrs = {}) {
      const input = el(tag, { id: `${prefix}-${name}`, 'data-fw': name, ...attrs });
      return { input, node: el('label', { for: input.id, className: 'fw-field' }, el('span', {}, label), input) };
    }
    const root = el('section', { className: 'farm-workforce', 'aria-label': 'Workforce timekeeping' });
    const status = el('p', { role: 'status', 'aria-live': 'polite', 'data-fw': 'status' }, 'Loading private time records...');
    const error = el('p', { role: 'alert', className: 'fw-error', hidden: true, 'data-fw': 'error' });
    const retry = button('Retry exact pending command', () => sendPending(), { hidden: true, 'data-fw': 'retry' });
    const refreshButton = button('Refresh', () => refresh(), { 'data-fw': 'refresh' });
    root.append(el('header', { className: 'fw-header' }, el('div', {}, el('p', { className: 'fw-eyebrow' }, 'MYCOLOGY / WORKFORCE'), el('h1', {}, 'Time & attendance')), refreshButton), status, error, retry,
      note('Private time records. Server permissions apply to every request. Offline punches are not recorded here; reconnect before clocking. Closing this view does not cancel a submitted command.'));

    const punchBox = el('section', { className: 'fw-section', 'aria-label': 'My time clock' });
    const clockStatus = el('p', { 'data-fw': 'clock-status' }, 'Checking current shift...');
    const department = field('Department', 'department', 'select');
    const job = field('Job code', 'job', 'input', { maxlength: 128, placeholder: 'Your configured job code' });
    const punchButtons = {};
    for (const [kind, title] of [['clock_in', 'Clock in'], ['break_start', 'Start break'], ['break_end', 'End break'], ['clock_out', 'Clock out']]) {
      punchButtons[kind] = button(title, () => {
        const p = stampNow();
        if (kind === 'clock_in') { p.departmentId = department.input.value || null; p.jobCode = job.input.value.trim(); if (!p.jobCode) return showError('Enter a job code before clocking in.'); }
        else { if (!selfShift) return; p.shiftId = selfShift.id; }
        mutate(`time.${kind}`, p, () => refresh());
      }, { disabled: true, 'data-fw': kind });
    }
    punchBox.append(el('h2', {}, 'My clock'), clockStatus, el('div', { className: 'fw-fields' }, department.node, job.node), el('div', { className: 'fw-actions' }, Object.values(punchButtons)));
    root.append(punchBox);

    const target = field('Employee user ID (blank for my records)', 'target', 'input', { maxlength: 128 });
    target.node.hidden = !manager;
    const history = el('div', { 'data-fw': 'history', className: 'fw-records' });
    root.append(el('section', { className: 'fw-section' }, el('h2', {}, 'Time history'), target.node, manager ? note('Managers see assigned departments only. Enter a known farm member ID, then refresh.') : null, history));
    target.input.addEventListener('input', () => { epoch++; preview = null; shifts = []; sheets = []; history.replaceChildren(); sheetList.replaceChildren(); exportView.replaceChildren(); confirm.input.checked = false; status.textContent = 'Employee selection changed. Refresh to load authorized records.'; updateControls(); });

    const periodStart = field('Period start (ISO timestamp with UTC offset)', 'period-start', 'input', { placeholder: 'YYYY-MM-DDT00:00:00+00:00', maxlength: 64 });
    const periodEnd = field('Period end, exclusive (ISO timestamp with UTC offset)', 'period-end', 'input', { placeholder: 'YYYY-MM-DDT00:00:00+00:00', maxlength: 64 });
    const sheetList = el('div', { className: 'fw-records', 'data-fw': 'timesheets' });
    const createSheet = button('Create reviewable period snapshot', () => {
      const start = periodStart.input.value.trim(), end = periodEnd.input.value.trim();
      if (!start || !end) return showError('Both ISO period boundaries are required.');
      mutate('timesheet.create', { userId: target.input.value.trim() || self, periodStart: start, periodEnd: end }, () => refresh());
    }, { 'data-fw': 'create-sheet' });
    root.append(el('section', { className: 'fw-section' }, el('h2', {}, 'Timesheet revisions'), note('Closed shifts only. Review the exact revision before approval. Approved periods are frozen; post-approval adjustments are not available. A different authorized owner or manager must approve your own time.'), el('div', { className: 'fw-fields' }, periodStart.node, periodEnd.node), createSheet, sheetList));

    const exportBox = el('section', { className: 'fw-section', hidden: !owner, 'aria-label': 'CSV payroll handoff' });
    const config = field('CSV configuration (JSON: destination, employeeMap, payCodeMap, breakTreatment)', 'config', 'textarea', { rows: 8, spellcheck: false });
    const saveConfig = button('Save CSV configuration', () => {
      let value; try { value = JSON.parse(config.input.value); } catch (_) { return showError('Configuration must be valid JSON.'); }
      mutate('payroll.configure', { config: value }, () => { preview = null; exportView.replaceChildren(); confirm.input.checked = false; status.textContent = 'CSV configuration saved. Create a fresh preview.'; updateControls(); });
    }, { 'data-fw': 'save-config' });
    const previewButton = button('Preview selected approved revisions', () => previewExport(), { 'data-fw': 'preview-export' });
    const exportView = el('div', { 'data-fw': 'export-view' });
    const confirm = field('I reviewed this destination, revision list, configuration and payload hash. Create this CSV artifact only.', 'confirm', 'input', { type: 'checkbox' });
    confirm.input.addEventListener('change', updateControls);
    config.input.addEventListener('input', () => { preview = null; confirm.input.checked = false; exportView.replaceChildren(); updateControls(); });
    const exportButton = button('Confirm CSV export', () => {
      if (!preview || !confirm.input.checked) return;
      const frozen = preview;
      mutate('payroll.export', { timesheetIds: frozen.revisions.map(r => r.id), payloadHash: frozen.payloadHash, confirmed: true }, result => {
        preview = null; confirm.input.checked = false;
        exportView.replaceChildren(el('h3', {}, 'CSV artifact receipt'), note(`Status: ${result.status}. No external submission or wage payment.`), el('pre', {}, JSON.stringify({ id: result.id, payloadHash: result.payloadHash, csvSha256: result.csvSha256, destination: result.destination }, null, 2)), csvArea(result.csv));
        status.textContent = 'CSV artifact created and recorded. Select and copy the CSV below for your payroll system.';
        updateControls();
      });
    }, { disabled: true, 'data-fw': 'export' });
    exportBox.append(el('h2', {}, 'Payroll handoff'), note('CSV is the only available connector. No provider connection, automatic submission, tax calculations, overtime rules or wage payments. Explicitly choose paid or unpaid break treatment for this export.'), config.node,
      note('Required JSON keys: destination (label), employeeMap (farm user ID to payroll ID), payCodeMap (job code to pay code), breakTreatment ("paid" or "unpaid"). Optional: connector "csv", delimiter, columns. Seconds remain exact; the optional hours column is displayed to six decimal places.'), saveConfig, previewButton, exportView, confirm.node, exportButton);
    root.append(exportBox); container.append(root);

    function showError(message) { if (alive && active) { error.textContent = String(message).slice(0, 700); error.hidden = false; } }
    function current(token) { return alive && active && token === epoch; }
    function updateControls() {
      const locked = busy || !!pending || !active;
      for (const b of root.querySelectorAll('button')) b.disabled = locked;
      for (const input of root.querySelectorAll('input,select,textarea')) input.disabled = locked && !input.readOnly;
      retry.disabled = busy || !active; retry.hidden = !pending;
      punchButtons.clock_in.disabled = locked || selfShift !== null || !shiftsReady;
      punchButtons.clock_out.disabled = locked || !selfShift || !!selfShift.openBreakAt;
      punchButtons.break_start.disabled = locked || !selfShift || !!selfShift.openBreakAt;
      punchButtons.break_end.disabled = locked || !selfShift?.openBreakAt;
      exportButton.disabled = locked || !preview || !confirm.input.checked;
      createSheet.disabled = locked;
    }
    let shiftsReady = false;
    async function request(action, p) {
      if (!alive || !active || typeof api?.request !== 'function') throw new Error('Authenticated workforce connection unavailable.');
      const result = await new Promise((resolve, reject) => {
        let done = false;
        const finish = (fn, value) => { if (done) return; done = true; win.clearTimeout(timer); listeners.delete(cancel); fn(value); };
        const cancel = () => finish(reject, new Error('View closed; server outcome may still be pending.'));
        const timer = win.setTimeout(() => finish(reject, new Error('Connection timed out. Server outcome is unknown.')), 20000);
        listeners.add(cancel);
        Promise.resolve().then(() => { if (!alive || !active) throw new Error('View closed.'); return api.request(action, { ...p, farmId }); }).then(result => finish(resolve, result), () => finish(reject, new Error('Connection interrupted. Server outcome is unknown.')));
      });
      if (!result || result.ok !== true) {
        const err = new Error(clean(result?.error?.message) || 'Workforce request was not accepted.');
        const code = clean(result?.error?.code).toLowerCase();
        err.definitive = !!code && !/unavailable|timeout|network|unknown|retry|unconfirmed/.test(code);
        throw err;
      }
      return result.data;
    }
    async function mutate(action, p, onSuccess) {
      if (!alive || !active || busy || pending) return;
      try { pending = { action, payload: { ...p, requestId: requestId() }, onSuccess }; }
      catch (err) { showError(err.message); return; }
      await sendPending();
    }
    async function sendPending() {
      if (!pending || busy || !active || !alive) return;
      busy = true; const intent = pending, token = epoch;
      error.hidden = true; status.textContent = 'Awaiting server acceptance...'; updateControls();
      try {
        const result = await request(intent.action, intent.payload);
        // Keep the accepted intent reconcilable if its view changed while awaiting
        // the response. Replaying it later returns the same server receipt.
        if (!current(token)) return;
        if (pending === intent) pending = null;
        busy = false; status.textContent = 'Command accepted by the server.'; await intent.onSuccess(result);
      } catch (err) {
        if (err.definitive && pending === intent) pending = null;
        if (current(token)) showError(err.message + (pending ? ' Retry the exact pending command. Do not create a replacement.' : ' No change was accepted.'));
      } finally { busy = false; if (alive) updateControls(); }
    }
    function csvArea(content) {
      const f = field('CSV bytes (select and copy)', 'csv-output', 'textarea', { readonly: true, rows: 8 });
      f.input.value = clean(content); return f.node;
    }
    async function previewExport() {
      const ids = [...sheetList.querySelectorAll('input[data-sheet]:checked')].map(n => n.dataset.sheet).sort();
      if (!ids.length) return showError('Select at least one approved revision.');
      const token = epoch; busy = true; preview = null; confirm.input.checked = false; updateControls();
      try {
        const result = await request('payroll.preview', { timesheetIds: ids });
        if (!current(token)) return;
        preview = result;
        exportView.replaceChildren(el('h3', {}, 'Review CSV preview'), note(`Destination: ${result.destination}`), el('pre', {}, JSON.stringify({ configHash: result.configHash, payloadHash: result.payloadHash, csvSha256: result.csvSha256, revisions: result.revisions }, null, 2)), csvArea(result.csv));
        status.textContent = 'Preview only. Review the bytes and hash, then confirm the export.';
      } catch (err) { if (current(token)) showError(err.message); }
      finally { busy = false; if (alive) updateControls(); }
    }
    function renderHistory() {
      history.replaceChildren();
      if (!shifts.length) history.append(note('No time records returned for this employee and your authorized scope.'));
      for (const s of shifts) {
        const details = el('details', {}, el('summary', {}, `${s.startedAt} to ${s.endedAt || 'open'} / ${s.jobCode}`));
        details.append(el('pre', {}, JSON.stringify(s, null, 2)));
        history.append(details);
      }
      sheetList.replaceChildren();
      if (!sheets.length) sheetList.append(note('No timesheet revisions returned.'));
      for (const s of sheets) {
        const hash = s.revisionHash || s.revision_hash, user = s.userId || s.user_id || s.snapshot?.userId;
        const row = el('article', { className: 'fw-revision' }, el('h3', {}, `${s.status} / ${user}`), note(`Revision: ${s.id}`));
        const details = el('details', {}, el('summary', {}, 'Review immutable snapshot and hash'), el('pre', {}, JSON.stringify({ revisionHash: hash, snapshot: s.snapshot }, null, 2)));
        row.append(details);
        if (manager && s.status === 'draft' && user !== self) {
          const approved = field('I reviewed this exact revision and approve these hours.', `approve-${s.id}`, 'input', { type: 'checkbox' });
          row.append(approved.node, button('Approve and freeze revision', () => {
            if (!approved.input.checked) return showError('Review the snapshot and select its approval confirmation.');
            mutate('timesheet.approve', { timesheetId: s.id, revisionHash: hash }, () => refresh());
          }, { 'data-approve': s.id }));
        }
        if (owner && s.status === 'approved') {
          const selected = field('Include this approved revision in CSV preview', `sheet-${s.id}`, 'input', { type: 'checkbox', 'data-sheet': s.id });
          selected.input.addEventListener('change', () => { preview = null; confirm.input.checked = false; exportView.replaceChildren(); updateControls(); });
          row.append(selected.node);
        }
        sheetList.append(row);
      }
    }
    async function refresh() {
      if (!alive || !active || busy) return;
      const token = ++epoch, userId = target.input.value.trim() || self;
      busy = true; shiftsReady = false; preview = null; confirm.input.checked = false;
      exportView.replaceChildren(); history.replaceChildren(); sheetList.replaceChildren(); error.hidden = true; status.textContent = 'Loading private records...'; updateControls();
      try {
        const [mine, selected, timesheets, departments, settings] = await Promise.all([
          request('time.list', { limit: 100 }), userId === self ? Promise.resolve(null) : request('time.list', { userId, limit: 100 }),
          request('timesheet.list', { userId, limit: 100 }), request('department.list', {}), owner ? request('payroll.config', {}) : Promise.resolve(null)
        ]);
        if (!current(token)) return;
        if (![mine.items, (selected || mine).items, timesheets.items, departments.items].every(Array.isArray)) throw new Error('Service returned an invalid record list.');
        selfShift = mine.items.find(s => !s.endedAt) || null; shiftsReady = true;
        shifts = (selected || mine).items; sheets = timesheets.items;
        const previous = department.input.value;
        department.input.replaceChildren(el('option', { value: '' }, 'No department'), departments.items.map(d => el('option', { value: d.id }, d.name)));
        department.input.value = previous;
        if (settings) config.input.value = settings.config ? JSON.stringify(settings.config, null, 2) : '';
        clockStatus.textContent = selfShift ? `${selfShift.openBreakAt ? 'On break' : 'Clocked in'} since ${selfShift.startedAt}.` : 'No open shift returned.';
        renderHistory(); status.textContent = 'Records received from the server. Latest 100 per list. No pending offline acceptance.';
      } catch (err) { if (current(token)) { selfShift = null; showError(err.message); status.textContent = 'Workforce records unavailable.'; } }
      finally { busy = false; if (alive) updateControls(); }
    }
    function deactivate() {
      if (!alive) return;
      active = false; epoch++; root.hidden = true;
      shifts = []; sheets = []; preview = null; selfShift = null; shiftsReady = false;
      history.replaceChildren(); sheetList.replaceChildren(); exportView.replaceChildren(); config.input.value = ''; confirm.input.checked = false;
      for (const cancel of [...listeners]) cancel();
      updateControls();
    }
    function destroy() { if (!alive) return; deactivate(); alive = false; pending = null; root.remove(); }
    function open() { if (!alive) return; active = true; root.hidden = false; return refresh(); }
    updateControls(); refresh();
    return { open, deactivate, destroy };
  }
  return { mount, stampNow };
});
