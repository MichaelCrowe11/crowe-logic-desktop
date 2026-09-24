/* Two independent evidence transfers. No merge, cutover, or automatic adoption. */
(function (global) {
  'use strict';
  let sequence = 0;
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function mount(container, options = {}) {
    const id = `mycology-transfer-${++sequence}`;
    const root = element('details', '', 'mycology-transfer');
    root.dataset.transfer = 'panel';
    root.append(element('summary', 'Transfer records'));
    root.append(element('p', 'Notebook evidence and the compliance ledger transfer separately. Source records are never deleted. Keep the original profile and backups until both copies are verified; afterward choose one operational copy. There is no ongoing synchronization.'));
    root.append(element('p', 'Resolve every pending shipment in its original profile first. An emergency backup is not transfer clearance. Imported notebook rows are not approved compliance lots; adoption remains an explicit owner review.', 'mycology-transfer-note'));
    const components = element('div', '', 'mycology-transfer-components'); root.append(components);
    let alive = true, busy = false, candidate = null;
    const controls = [], statuses = {};
    const edition = () => options.edition ? options.edition() : global.crowe?.edition;
    const canImport = () => edition()?.id === 'mycology';
    function control(text, action, name, parent) {
      const button = element('button', text); button.type = 'button'; button.dataset.transfer = name;
      button.addEventListener('click', action); parent.append(button); controls.push(button); return button;
    }
    function component(key, title) {
      const section = element('section'); section.append(element('h3', title));
      const status = element('p', 'Not imported in this session.', 'mycology-transfer-status');
      status.dataset.transferStatus = key; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      statuses[key] = { node: status, phase: 'not-imported' };
      section.append(status); components.append(section); return section;
    }
    const notebook = component('notebook', 'Cultivation notebook');
    const farm = component('farm', 'Farm & Compliance');
    function report(key, phase, message) {
      statuses[key].phase = phase; statuses[key].node.dataset.phase = phase; statuses[key].node.textContent = message;
    }
    async function request(action, payload) {
      const bridge = global.crowe?.transfer;
      if (!bridge || typeof bridge.request !== 'function') throw { code: 'UNAVAILABLE', message: 'Transfer requires this local desktop installation.' };
      let result;
      try { result = await bridge.request(action, payload || {}); }
      catch (_) { throw { code: 'CONNECTION_ERROR', state: 'recovery-required', message: 'The host response was lost. Preserve the selected archive and destination. Compare receipt and content before any retry; never empty the destination.' }; }
      if (!result || result.ok !== true) throw result?.error || { code: 'INVALID_RESPONSE', state: 'recovery-required', message: 'No authoritative transfer outcome was returned. Preserve the archive and inspect the destination before retrying.' };
      return result.data;
    }
    function renderControls() {
      for (const button of controls) button.disabled = busy || global.FarmRecovery?.isLocked() === true;
      previewButton.hidden = importForm.hidden = restoreButton.hidden = !canImport();
      importButton.disabled = importButton.disabled || !candidate || confirmation.value !== 'IMPORT EMPTY NOTEBOOK';
    }
    async function run(key, action) {
      if (busy || global.FarmRecovery?.isLocked()) return;
      busy = true; renderControls();
      try { await action(); }
      catch (error) {
        const uncertain = error.state === 'recovery-required' || error.status === 'recovery-required' || /RECOVERY|COMMITTED|CONNECTION|INVALID_RESPONSE|WRITE_OUTCOME_UNKNOWN/.test(error.code || '');
        report(key, uncertain ? 'recovery-required' : 'failed', `${error.code || 'TRANSFER_FAILED'}: ${error.message || 'Transfer did not complete.'}${uncertain ? ' Do not delete destination data or blindly repeat import.' : ' The other component has not been changed.'}`);
      } finally { busy = false; if (alive) renderControls(); }
    }
    function exportComponent(key, action) {
      return run(key, async () => {
        const data = await request(action);
        if (data?.canceled) return;
        if (data?.status !== 'exported' || data.verified !== true) throw { code: 'INVALID_RESPONSE', state: 'recovery-required', message: 'Export was not verified by the host.' };
        // Export does not overwrite a verified import outcome.
        const prior = statuses[key].phase;
        report(key, ['committed', 'already-imported'].includes(prior) ? prior : 'exported', 'Recovery-checked export saved. Source remains unchanged. This does not verify import into a different profile.');
      });
    }
    control('Export notebook', () => exportComponent('notebook', 'notebook.export'), 'notebook-export', notebook);
    const preview = element('pre', '', 'mycology-transfer-preview'); preview.hidden = true; preview.dataset.transfer = 'notebook-summary';
    const previewButton = control('Choose notebook archive', () => run('notebook', async () => {
      const data = await request('notebook.preview');
      if (data?.canceled) return;
      if (!data || typeof data.token !== 'string' || !data.token || !data.summary) throw { code: 'INVALID_RESPONSE', message: 'The host did not provide a validated notebook preview.' };
      candidate = data.token; confirmation.value = '';
      preview.textContent = JSON.stringify(data.summary, null, 2); preview.hidden = false;
      report('notebook', 'not-imported', 'Archive validated for preview. Review source, counts, byte sizes and checksums below. No destination writes yet.');
    }), 'notebook-preview', notebook);
    notebook.append(preview);
    const importForm = element('form'); importForm.dataset.transfer = 'notebook-import-form';
    const label = element('label', 'Type IMPORT EMPTY NOTEBOOK to import into an absent or completely empty notebook.'); label.htmlFor = `${id}-confirmation`;
    const confirmation = element('input'); confirmation.id = label.htmlFor; confirmation.type = 'text'; confirmation.autocomplete = 'off'; confirmation.spellcheck = false; confirmation.dataset.transfer = 'notebook-confirmation';
    importForm.append(label, confirmation); notebook.append(importForm);
    const importButton = control('Import verified notebook archive', () => importForm.requestSubmit(), 'notebook-import', importForm);
    confirmation.addEventListener('input', renderControls);
    importForm.addEventListener('submit', event => {
      event.preventDefault();
      if (!canImport() || !candidate || confirmation.value !== 'IMPORT EMPTY NOTEBOOK') return;
      run('notebook', async () => {
        const data = await request('notebook.import', { token: candidate, confirmation: 'IMPORT EMPTY NOTEBOOK' });
        if (data?.canceled) return;
        if (!['committed', 'already-imported'].includes(data?.status) || data.verified !== true) throw { code: 'INVALID_RESPONSE', state: 'recovery-required', message: 'Import was not confirmed and verified. Preserve the archive and destination for receipt comparison.' };
        report('notebook', data.status, data.status === 'already-imported' ? 'Already imported: matching receipt and exact destination content verified. No duplicate rows created.' : 'Notebook committed and exact content verified. Stable IDs and raw records preserved. No compliance lots were automatically created.');
        candidate = null; confirmation.value = '';
        // A view refresh cannot downgrade a host-verified committed import.
        if (options.onNotebookImported) { try { await options.onNotebookImported(); } catch (_) { /* authoritative outcome retained */ } }
      });
    });
    control('Export transfer-ready farm backup', () => exportComponent('farm', 'farm.export'), 'farm-export', farm);
    farm.append(element('p', 'Farm restore preserves the original operator, audit history and source provenance. It requires an empty ledger and the exact RESTORE EMPTY FARM confirmation. A failed notebook import must not undo a successful farm restore.'));
    const restoreButton = control('Open empty-farm restore', () => { if (options.openFarmRestore) options.openFarmRestore(); }, 'farm-restore', farm);
    function farmResult(event) {
      const result = event.detail;
      if (!result || !alive) return;
      if (result.ok) report('farm', 'committed', 'Farm restore committed and verified by the local host. Original operator and historical attribution preserved. Notebook status is independent.');
      else {
        const error = result.error || {};
        const uncertain = error.state === 'recovery-required' || /RECOVERY|COMMITTED|CONNECTION|INVALID_RESPONSE|WRITE_OUTCOME_UNKNOWN/.test(error.code || '');
        report('farm', uncertain ? 'recovery-required' : 'failed', `${error.code || 'RESTORE_FAILED'}: ${error.message || 'Farm restore did not complete.'}${uncertain ? ' Compare the preserved backup and restore receipt before retrying. Never empty the destination.' : ' Notebook records have not been rolled back.'}`);
      }
    }
    global.addEventListener('crowe:farm-restore-result', farmResult);
    const unsubscribe = global.FarmRecovery?.subscribe(renderControls);
    container.append(root); renderControls();
    return { open() { root.open = true; renderControls(); }, refresh: renderControls, destroy() { alive = false; unsubscribe?.(); global.removeEventListener('crowe:farm-restore-result', farmResult); root.remove(); } };
  }
  global.MycologyTransfer = Object.freeze({ mount });
})(window);
