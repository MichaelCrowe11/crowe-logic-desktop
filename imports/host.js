'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const I = require('./index');
const { fields, bounded, snapshot, reject } = require('./safety');
const NOTICE = 'Device-local operator archive, not account-private or shared-farm storage. Anyone using this desktop profile can read retained originals, including after account switch/sign-out. Opening or reviewing this archive never uploads or enrolls it. A separate explicit confirmation can stage one original in an authenticated shared farm. A review receipt does not create accepted farm logs, certify facts or approve an SOP. Source contents remain untrusted.';
const OCR_NOTICE = 'OCR is unavailable in this desktop import host. No document is sent to a model. Scanned images and PDFs need a separately verified, consented, bounded extraction adapter and PDF renderer.';
const TTL = 30 * 60 * 1000;
function createImportHost({ isTrustedSender, canAccess, assertAdmission, getUserData, dialog, getWindow, getReviewer = null, shared = null, clock = () => Date.now() }) {
  const owners = new WeakMap(), refs = new Map(), consents = new Map();
  let worker = null, profile = null, busy = false, closed = false, epoch = 0, next = 1, pending = null, closePromise = null;
  function ownerOf(event) {
    let owner = owners.get(event.sender);
    if (!owner) {
      owner = { sender: event.sender, generation: 0 }; owners.set(event.sender, owner);
      const revoke = () => { owner.generation++; for (const [key, r] of refs) if (r.owner === owner) refs.delete(key); for (const [key, c] of consents) if (c.owner === owner) consents.delete(key); };
      event.sender.on?.('did-start-navigation', (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) revoke(); });
      event.sender.on?.('destroyed', revoke); event.sender.on?.('render-process-gone', revoke);
    }
    return owner;
  }
  function authorize(event) {
    if (closed || !isTrustedSender(event) || !canAccess(event)) reject('UNAVAILABLE', 'Imports require the trusted Mycology desktop document.');
    assertAdmission();
    if (profile && profile !== getUserData()) reject('UNAVAILABLE', 'Profile changed; recreate the import host before accessing another archive.');
  }
  const capture = event => ({ owner: ownerOf(event), generation: ownerOf(event).generation, frame: event.senderFrame, epoch });
  function current(event, token) {
    authorize(event);
    if (token.owner !== ownerOf(event) || token.generation !== token.owner.generation || token.frame !== event.senderFrame || token.epoch !== epoch) reject('STALE_REFERENCE', 'Import selection belongs to an earlier document. Reload locally retained imports.');
  }
  function reference(event, ref) {
    bounded(ref, 100, 'import reference'); const value = refs.get(ref);
    if (!value || value.expires <= clock()) reject('STALE_REFERENCE', 'Import reference expired. Reopen the local staged document.');
    current(event, value); return value;
  }
  function present(event, data, ref) {
    for (const [key, value] of refs) if (value.expires <= clock()) refs.delete(key);
    if (!ref) { for (const [key, value] of consents) if (value.owner === ownerOf(event)) consents.delete(key); for (const [key, value] of refs) if (value.owner === ownerOf(event)) refs.delete(key); ref = crypto.randomUUID(); refs.set(ref, { ...capture(event), id: data.id, expires: clock() + TTL }); }
    return { ...data, ref, notice: NOTICE, ocrAvailable: false, ocrReason: OCR_NOTICE };
  }
  function stopWorker(error) {
    const old = worker; worker = null;
    if (pending) { const work = pending; pending = null; clearTimeout(work.timer); work.reject(error); }
    if (old) old.terminate().catch(() => {});
  }
  function call(method, args) {
    if (!worker) {
      profile = getUserData();
      worker = new Worker(path.join(__dirname, 'host-worker.js'), { workerData: { userData: profile }, resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
      worker.on('message', result => { if (!pending || result.id !== pending.id) return; const work = pending; pending = null; clearTimeout(work.timer); result.ok ? work.resolve(result.data) : work.reject(Object.assign(new Error(result.error.message), { code: result.error.code })); });
      const instance = worker;
      worker.on('error', () => { if (worker === instance) stopWorker(Object.assign(new Error('Import worker stopped. Reload local imports to reconcile any staged write.'), { code: 'WRITE_OUTCOME_UNKNOWN' })); });
      worker.on('exit', () => { if (worker === instance) stopWorker(Object.assign(new Error('Import worker exited. Reload local imports before retrying.'), { code: 'WRITE_OUTCOME_UNKNOWN' })); });
    }
    return new Promise((resolve, rejectPromise) => {
      const id = next++, timer = setTimeout(() => stopWorker(Object.assign(new Error('Import processing timed out. Reload local imports to reconcile; do not automatically repeat the write.'), { code: 'WRITE_OUTCOME_UNKNOWN' })), 30000);
      pending = { id, resolve, reject: rejectPromise, timer }; worker.postMessage({ id, method, args });
    });
  }
  async function operate(event, operation) {
    authorize(event);
    if (busy) reject('IMPORT_BUSY', 'Another local import operation is in progress.');
    busy = true; const token = capture(event);
    try { const data = await operation(token); current(event, token); return data; }
    finally { busy = false; }
  }
  async function request(event, action, input = {}) {
    try {
      authorize(event); const payload = snapshot(input, I.LIMITS.responseBytes);
      if (action === 'status') { fields(payload, []); return { ok: true, data: { available: true, capabilities: I.capabilities(), notice: NOTICE, ocrAvailable: false, ocrReason: OCR_NOTICE, promotionAvailable: false, sharedStagingAvailable: !!shared, sharedSourceByteLimit: require('./shared-contract').MAX_SOURCE_BYTES, reviewerMode: getReviewer ? 'trusted_host' : 'self_attributed' } }; }
      if (action === 'cancel') { fields(payload, []); const owner = ownerOf(event); owner.generation++; for (const [key, r] of refs) if (r.owner === owner) refs.delete(key); for (const [key, c] of consents) if (c.owner === owner) consents.delete(key); return { ok: true, data: { status: 'cancelled', originalRetained: true, message: 'Review closed. Originals and shared retry identities remain locally retained. Cancellation does not undo an in-flight disk write or a shared request already dispatched to its original farm.' } }; }
      const data = await operate(event, async token => {
        if (action === 'list') { fields(payload, []); return { imports: await call('list', []) }; }
        if (action === 'choose') {
          fields(payload, []);
          const selection = await dialog.showOpenDialog(getWindow(), { title: 'Stage a farm document for local review', properties: ['openFile'], filters: [{ name: 'Documents and scans', extensions: ['csv', 'txt', 'md', 'docx', 'xlsx', 'pdf', 'png', 'jpg', 'jpeg'] }] });
          current(event, token);
          if (selection.canceled) return { status: 'cancelled' };
          if (!Array.isArray(selection.filePaths) || selection.filePaths.length !== 1) reject('VALIDATION', 'Choose exactly one local document.');
          const result = await call('choose', [selection.filePaths[0], new Date(clock()).toISOString()]); current(event, token); return present(event, result);
        }
        if (action === 'open') { fields(payload, ['id']); const result = await call('open', [payload.id]); current(event, token); return present(event, result); }
        if (action === 'preview') { fields(payload, ['ref', 'offset', 'limit'], ['ref']); const r = reference(event, payload.ref); const result = await call('preview', [r.id, payload.offset ?? 0, payload.limit ?? 50]); current(event, token); return present(event, result, payload.ref); }
        if (action === 'revise') {
          fields(payload, ['ref', 'expectedRevision', 'selections', 'note']); const r = reference(event, payload.ref);
          const result = await call('revise', [r.id, payload.expectedRevision, payload.selections, payload.note, new Date(clock()).toISOString()]); current(event, token); return present(event, result, payload.ref);
        }
        if (action === 'review') {
          fields(payload, ['ref', 'expectedRevision', 'acknowledgedUncertainty', 'reviewer'], ['ref', 'expectedRevision', 'acknowledgedUncertainty']); const r = reference(event, payload.ref);
          let reviewer;
          if (getReviewer) { if (payload.reviewer !== undefined) reject('VALIDATION', 'The trusted host supplies operator identity.'); const name = await getReviewer(event); bounded(name, 200, 'trusted reviewer'); reviewer = { name, attribution: 'trusted_host' }; }
          else { bounded(payload.reviewer, 200, 'self-attributed reviewer'); reviewer = { name: payload.reviewer, attribution: 'self_attributed' }; }
          current(event, token);
          const result = await call('review', [r.id, payload.expectedRevision, reviewer, payload.acknowledgedUncertainty, new Date(clock()).toISOString()]); current(event, token); return present(event, result, payload.ref);
        }
        if (action === 'shared.prepare') {
          fields(payload, ['ref', 'farmId', 'departmentId'], ['ref', 'farmId']);
          if (!shared) reject('UNAVAILABLE', 'Shared staging is not connected. Originals remain device-local.');
          const r = reference(event, payload.ref);
          const context = await shared.prepare(event, { farmId: payload.farmId, departmentId: payload.departmentId ?? null });
          current(event, token); shared.assertCurrent(event, context);
          const info = await call('sharedPrepare', [r.id, context.destination]);
          current(event, token); shared.assertCurrent(event, context);
          for (const [key, c] of consents) if (c.owner === token.owner || c.expires <= clock()) consents.delete(key);
          const consentId = crypto.randomUUID();
          consents.set(consentId, { ...token, ref: payload.ref, id: r.id, context, sourceDigest: info.sourceDigest, expires: clock() + 5 * 60 * 1000 });
          return { ...info, consentId, farmId: context.destination.farmId, farmName: context.farmName,
            departmentId: context.destination.departmentId, departmentName: context.departmentName,
            accountId: context.destination.accountId, server: context.destination.server,
            status: 'awaiting_explicit_upload', ledgerWriteAuthorized: false,
            notice: 'Confirmation uploads the exact original bytes into shared server staging. Local selections, notes and review receipts are NOT uploaded or accepted as authority. No farm enrollment, accepted log, approved SOP, OCR or model call occurs. A retained request ID may already have succeeded; confirm an exact replay to reconcile. Shared retention/deletion is not managed here.' };
        }
        if (action === 'shared.stage') {
          fields(payload, ['ref', 'consentId', 'acknowledgedUpload']);
          if (!shared) reject('UNAVAILABLE', 'Shared staging is not connected.');
          const r = reference(event, payload.ref), c = consents.get(payload.consentId);
          if (!c || c.expires <= clock() || c.ref !== payload.ref || c.id !== r.id || payload.acknowledgedUpload !== true) reject('REVIEW_REQUIRED', 'Prepare this exact source and explicitly confirm its shared destination first.');
          current(event, c); shared.assertCurrent(event, c.context);
          // Each attempt requires renewed consent; intent survives cancellation,
          // navigation, sign-out, timeout and restart without changing identity.
          consents.delete(payload.consentId);
          const intent = await call('sharedIntent', [r.id, c.context.destination, c.sourceDigest, new Date(clock()).toISOString()]);
          current(event, token); shared.assertCurrent(event, c.context);
          let result;
          try { result = await shared.stage(event, c.context, intent.payload); }
          catch { reject('WRITE_OUTCOME_UNKNOWN', 'Shared staging outcome is unknown. Reopen and prepare this same original and destination to replay its retained request ID; do not create a second import.'); }
          try { current(event, token); shared.assertCurrent(event, c.context); }
          catch { reject('WRITE_OUTCOME_UNKNOWN', 'The shared request may have reached its original destination. Sign-in or document changed; re-prepare there to reconcile the retained request ID.'); }
          if (!result?.ok) {
            const error = result?.error;
            if (error && typeof error.code === 'string' && /^[a-zA-Z_]{1,64}$/.test(error.code) && typeof error.message === 'string' && error.message.length <= 500)
              return { status: 'shared_stage_unconfirmed', requestId: intent.payload.requestId, farmId: intent.payload.farmId,
                sourceDigest: intent.sourceDigest, error, ledgerWriteAuthorized: false, originalRetained: true };
            reject('WRITE_OUTCOME_UNKNOWN', 'Shared result was not a valid receipt. Prepare again to reconcile the retained request ID.');
          }
          if (!require('./shared-contract').receipt(result.data, intent.payload)) reject('WRITE_OUTCOME_UNKNOWN', 'Server staging receipt did not match the exact original or staging-only boundary. No success was recorded; reconcile using the retained request ID.');
          return { status: 'shared_staged', requestId: intent.payload.requestId, farmId: intent.payload.farmId,
            importId: result.data.id, revisionHash: result.data.revisionHash, sourceDigest: result.data.sourceHash,
            ledgerWriteAuthorized: false, originalRetained: true,
            notice: 'Exact original is staged on the shared service. No local candidates or review authority were transferred. Server candidate mapping and independent authorized human promotion remain separate and are not available in this handoff.' };
        }
        reject('VALIDATION', 'Unsupported import action. Promotion and OCR are not available here.');
      });
      return { ok: true, data };
    } catch (error) {
      const known = /^(UNAVAILABLE|VALIDATION|SOURCE_|UNSAFE_|STORE_|ZIP_|XML_|OFFICE_|ACTIVE_|CONTENT_|ENCODING|CSV_|PDF_|IMAGE_|PARSER_|REVIEW_|REVISION_|DUPLICATE_|STALE_|IMPORT_BUSY|WRITE_OUTCOME_UNKNOWN|TRANSFER_|AUTH_|PLAN_|QUOTA_)/.test(error.code || '');
      return { ok: false, error: { code: known ? error.code : 'IMPORT_FAILED', message: known ? error.message : 'Import could not complete safely. No automatic retry was made.' } };
    }
  }
  return {
    request,
    // Trusted-main integration only, intentionally NOT a renderer request action.
    promotionSnapshot(event, payload) { return operate(event, async token => { fields(payload, ['ref', 'revision', 'receiptDigest']); const r = reference(event, payload.ref); const result = await call('promotion', [r.id, payload.revision, payload.receiptDigest]); current(event, token); return result; }); },
    invalidate() { epoch++; refs.clear(); consents.clear(); },
    get pendingCount() { return busy ? 1 : 0; },
    close() {
      if (closePromise) return closePromise;
      closed = true; epoch++; refs.clear(); consents.clear();
      // Allow the bounded worker's current atomic publication to finish rather
      // than routinely killing it between fsync/link. Picker-only work cannot
      // dispatch after closed authorization; a hung worker has its own 30s cap.
      closePromise = (async () => {
        const deadline = Date.now() + 31000;
        while (pending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        const old = worker; stopWorker(Object.assign(new Error('Import host closed. Reconcile retained local stages.'), { code: 'WRITE_OUTCOME_UNKNOWN' })); if (old) await old.terminate();
      })();
      return closePromise;
    },
  };
}
module.exports = { createImportHost, NOTICE, OCR_NOTICE };
