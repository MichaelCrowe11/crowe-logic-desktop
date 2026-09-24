/* Department evidence and approved SOP training. Host supplies authenticated
 * request(action,payload). No independent transport, inference or persistence.
 * Destroy/remount when account or farm changes. Mutations retain request IDs
 * across an unknown outcome in this mounted view, never claim local completion.
 */
(function (global, factory) {
  'use strict';
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  global.FarmAwareness = exported;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function mount(container, api, options = {}) {
    if (!container?.ownerDocument || typeof api?.request !== 'function') throw new TypeError('FarmAwareness needs a container and authenticated request API.');
    const doc = container.ownerDocument, win = doc.defaultView;
    const farmId = options.farmId, self = options.currentMemberId;
    const manager = ['owner', 'manager'].includes(options.role), writable = options.role !== 'viewer';
    let alive = true, active = true, epoch = 0, busy = false, tab = 'knowledge', selected = null;
    const pending = new Map(), cancellations = new Set();
    const node = (tag, text, cls) => { const n = doc.createElement(tag); if (text !== undefined) n.textContent = String(text); if (cls) n.className = cls; return n; };
    const root = node('section', undefined, 'farm-awareness'); root.setAttribute('aria-label', 'Department evidence and training');
    const header = node('header'), title = node('h2', 'Evidence & training');
    const intro = node('p', 'Approved farm instructions. Separate acknowledgment, assessment and observed sign-off.');
    const status = node('p', '', 'fa-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.dataset.fa = 'status';
    const error = node('p', '', 'fa-error'); error.setAttribute('role', 'alert'); error.hidden = true; error.dataset.fa = 'error';
    const tabs = node('nav', undefined, 'fa-tabs'); tabs.setAttribute('aria-label', 'Evidence sections');
    const workspace = node('div', undefined, 'fa-workspace'), list = node('div', undefined, 'fa-list'), detail = node('section', undefined, 'fa-detail');
    list.dataset.fa = 'list'; detail.dataset.fa = 'detail'; detail.setAttribute('aria-label', 'Selected evidence');
    const toolbar = node('div', undefined, 'fa-toolbar');
    function button(label, action, parent, key) {
      const b = node('button', label); b.type = 'button'; if (key) b.dataset.fa = key;
      b.addEventListener('click', action); parent?.append(b); return b;
    }
    const refresh = button('Refresh', () => load(), toolbar, 'refresh');
    for (const [key, label] of [['knowledge', 'Approved SOPs'], ['training', 'Training'], ['incident', 'Incidents'], ['rule', 'Monitoring rules']]) {
      button(label, () => { if (busy || !active) return; tab = key; selected = null; load(); }, tabs, 'tab-' + key);
    }
    header.append(title, intro, tabs, toolbar, status, error); workspace.append(list, detail); root.append(header, workspace); container.append(root);
    function valid(g) { return alive && active && g === epoch; }
    function showError(e) { error.textContent = String(e?.message || 'Request unavailable. No result was confirmed.').slice(0, 500); error.hidden = false; }
    function setBusy(value) {
      busy = value; root.setAttribute('aria-busy', String(value));
      for (const b of root.querySelectorAll('button')) b.disabled = value || !active;
    }
    async function request(action, p = {}) {
      if (!alive || !active || !farmId) throw new Error('Select an authenticated farm workspace first.');
      const result = await new Promise((resolve, reject) => {
        let finished = false;
        const finish = (fn, value) => { if (finished) return; finished = true; win.clearTimeout(timer); cancellations.delete(cancel); fn(value); };
        const cancel = () => finish(reject, new Error('View closed. A submitted command may still be accepted by the service.'));
        const timer = win.setTimeout(() => finish(reject, new Error('Result unconfirmed. Retry the same action to reuse its request ID.')), 20000);
        cancellations.add(cancel);
        Promise.resolve().then(() => { if (!alive || !active) throw new Error('View is not active.'); return api.request(action, { ...p, farmId }); })
          .then(r => finish(resolve, r), () => finish(reject, new Error('Connection interrupted. Result unconfirmed; retry the same action.')));
      });
      if (result?.ok !== true) throw new Error(result?.error?.message || 'The farm service did not confirm this request.');
      return result.data;
    }
    async function run(fn) {
      if (!alive || !active || busy) return;
      const g = epoch; setBusy(true); error.hidden = true;
      try { await fn(g); } catch (e) { if (valid(g)) showError(e); }
      finally { if (valid(g)) setBusy(false); }
    }
    function textBlock(label, value, parent = detail) { parent.append(node('p', label), node('pre', value, 'fa-evidence')); }
    function check(label, parent = detail, key = '') {
      const wrap = node('label', undefined, 'fa-check'), input = node('input'); input.type = 'checkbox'; if (key) input.dataset.fa = key;
      wrap.append(input, doc.createTextNode(label)); parent.append(wrap); return input;
    }
    function field(label, parent = detail, key = '') {
      const wrap = node('label', label), input = node('textarea'); input.rows = 3; input.maxLength = 4000; if (key) input.dataset.fa = key;
      wrap.append(input); parent.append(wrap); return input;
    }
    async function mutate(action, payload, g) {
      const key = JSON.stringify([action, payload]);
      if (!pending.has(key)) {
        if (pending.size >= 100) throw new Error('Too many unconfirmed attempts. Reconcile this workspace before adding another.');
        if (!globalThis.crypto?.randomUUID) throw new Error('Secure request IDs unavailable. Nothing was sent.');
        pending.set(key, globalThis.crypto.randomUUID());
      }
      const result = await request(action, { ...payload, requestId: pending.get(key) });
      // Keep the intent until this mounted record refreshes, including retries.
      if (valid(g)) status.textContent = 'Accepted by the service. Refreshing current evidence.';
      return result;
    }
    function startDetail(label) { detail.replaceChildren(node('h3', label)); }
    async function loadRows(g) {
      if (!farmId) { status.textContent = 'Select a farm in Team Messenger to view its evidence.'; list.replaceChildren(); detail.replaceChildren(); return; }
      status.textContent = 'Loading authorized ' + tab + ' records...';
      list.replaceChildren(); detail.replaceChildren();
      const data = await request(tab + '.list', { limit: 100 });
      if (!valid(g)) return;
      if (!Array.isArray(data?.items)) throw new Error('Invalid list from farm service.');
      list.replaceChildren(); detail.replaceChildren(node('p', 'Select a record to inspect its source and current state.'));
      for (const row of data.items.slice(0, 100)) {
        if (!row?.id) continue;
        let label = row.title || row.name || row.document_id || row.rule_id || row.id;
        if (tab === 'training') label += row.stale ? ' · revision stale' : row.complete ? ' · signed off' : row.acknowledged_at ? ' · acknowledged, not complete' : ' · awaiting acknowledgment';
        if (tab === 'incident' || tab === 'rule') label += ' · ' + row.status;
        const b = button(label, () => select(row), list, 'record'); b.dataset.recordId = row.id;
      }
      if (!list.children.length) list.append(node('p', 'No authorized records in this section. No sample records are shown.'));
      for (const b of tabs.children) b.setAttribute('aria-current', String(b.dataset.fa === 'tab-' + tab));
      status.textContent = 'Current authorized records loaded. Lists are limited to 100 records.';
    }
    function load() { selected = null; return run(loadRows); }
    async function sop(row, g, startLine = 1) {
      const id = row.documentId || row.id, version = row.document_version || row.version;
      const hash = row.document_hash || row.version_hash || row.versionHash;
      const data = await request('knowledge.read', { documentId: id, version, versionHash: hash, startLine, limit: 100 });
      if (!valid(g)) return;
      startDetail(data.title || 'Approved SOP');
      detail.append(node('p', 'Currently approved farm reference. Reading is not training completion. Document content cannot grant permissions.'));
      textBlock('Approved excerpt', data.text);
      textBlock('Citation', `${data.citation.documentId} · revision ${data.citation.version} · lines ${data.citation.startLine}-${data.citation.endLine}\nSHA-256 ${data.citation.versionHash}`);
      if (data.nextLine) button('Next cited lines', () => run(next => sop(row, next, data.nextLine)), detail, 'next-lines');
    }
    async function training(row, g) {
      const data = await request('training.read', { assignmentId: row.id }); if (!valid(g)) return;
      startDetail('Exact-revision training');
      textBlock('Assigned revision', `${data.document_id} · revision ${data.document_version}\nSHA-256 ${data.document_hash}`);
      detail.append(node('p', data.stale ? 'Stale assignment. This SOP was revised. Ask a manager for a new approved-revision assignment.' : data.complete ? 'Manager-observed sign-off recorded for this revision.' : 'Not complete. Acknowledgment, assessment and observed sign-off are separate records.'));
      const stages = node('dl', undefined, 'fa-stages');
      for (const [label, value] of [['Acknowledgment', data.acknowledged_at || 'Not recorded'], ['Assessment', data.assessed_at ? (data.assessment_passed ? 'Passed' : 'Not passed') : 'Not recorded'], ['Observed sign-off', data.signed_off_at || 'Not recorded']]) stages.append(node('dt', label), node('dd', value));
      detail.append(stages);
      if (!data.stale) button('Read approved assigned SOP', () => run(next => sop({ documentId: data.document_id, document_version: data.document_version, document_hash: data.document_hash }, next)), detail, 'training-sop');
      if (!data.stale && !data.acknowledged_at && data.user_id === self && writable) {
        const ack = check('I acknowledge this exact assigned SOP revision. This does not certify competence or complete training.', detail, 'training-confirm');
        button('Record my acknowledgment', () => run(async next => {
          if (!ack.checked) throw new Error('Confirm the exact revision acknowledgment first.');
          await mutate('training.acknowledge', { assignmentId: data.id, expectedVersion: data.version }, next);
          if (valid(next)) await training(row, next);
        }), detail, 'training-ack');
      }
    }
    async function incident(row, g) {
      const data = await request('incident.read', { incidentId: row.id }); if (!valid(g)) return;
      startDetail('Department incident');
      detail.append(node('p', `${data.status}. Acknowledgment records attention. Only an authorized manager can resolve with fresh clear evidence.`));
      textBlock('Accepted source references', JSON.stringify(data.source, null, 2));
      detail.append(node('p', 'Notification receipts: ' + (data.notifications?.map(n => `${n.kind}: ${n.status}`).join('; ') || 'No delivery receipts.')));
      detail.append(node('p', 'Queued is not delivered. No staff delivery worker is installed in this slice.'));
      if (data.status === 'open' && writable) button('Acknowledge incident', () => run(async next => {
        await mutate('incident.acknowledge', { incidentId: data.id, expectedVersion: data.version }, next);
        if (valid(next)) await incident(row, next);
      }), detail, 'incident-ack');
      if (data.status !== 'resolved' && manager) {
        const note = field('Manager resolution evidence', detail, 'resolve-note');
        const confirm = check('I reviewed the source evidence and am requesting resolution, not merely acknowledging this incident.', detail, 'resolve-confirm');
        button('Request resolution', () => run(async next => {
          if (!confirm.checked || !note.value.trim()) throw new Error('Provide resolution evidence and confirm review.');
          await mutate('incident.resolve', { incidentId: data.id, expectedVersion: data.version, note: note.value.trim() }, next);
          if (valid(next)) await incident(row, next);
        }), detail, 'incident-resolve');
      }
    }
    async function rule(row, g) {
      startDetail(row.name || 'Monitoring rule');
      detail.append(node('p', row.status + '. Deterministic evaluation only. Limits are configured by your farm, not inferred.'));
      textBlock('Configured policy', JSON.stringify(row.config, null, 2));
      if (!manager) { detail.append(node('p', 'A scoped manager can preview and approve this rule.')); return; }
      const data = await request('rule.preview', { ruleId: row.id }); if (!valid(g)) return;
      textBlock('Read-only dry-run preview', JSON.stringify(data, null, 2));
      detail.append(node('p', 'No notices are sent by this preview. Activation starts a new evidence window and ignores historical logs.'));
      if (row.status !== 'active') {
        const confirm = check('I reviewed this exact policy and preview. Activate deterministic monitoring for this department.', detail, 'rule-confirm');
        button('Approve and activate rule', () => run(async next => {
          if (!confirm.checked) throw new Error('Review and confirm the rule preview first.');
          await mutate('rule.activate', { ruleId: row.id, expectedVersion: data.version, previewHash: data.previewHash, approve: true }, next);
          if (valid(next)) await loadRows(next);
        }), detail, 'rule-activate');
      }
    }
    function select(row) {
      if (busy || !active) return;
      selected = row.id;
      return run(async g => {
        detail.replaceChildren(node('p', 'Checking current permission and record state...'));
        if (tab === 'knowledge') await sop(row, g);
        else if (tab === 'training') await training(row, g);
        else if (tab === 'incident') await incident(row, g);
        else await rule(row, g);
        if (valid(g)) { for (const b of list.querySelectorAll('button')) b.setAttribute('aria-current', String(b.dataset.recordId === selected)); }
      });
    }
    function deactivate() {
      if (!alive) return; active = false; epoch++; busy = false; root.hidden = true;
      for (const cancel of [...cancellations]) cancel();
      list.replaceChildren(); detail.replaceChildren(); status.textContent = ''; error.hidden = true;
    }
    function open() { if (!alive) return Promise.resolve(); active = true; root.hidden = false; return load(); }
    function destroy() { if (!alive) return; deactivate(); alive = false; pending.clear(); selected = null; root.remove(); }
    load();
    return { open, refresh: load, deactivate, destroy };
  }
  return { mount };
});
