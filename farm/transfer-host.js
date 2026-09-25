"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { errorEnvelope } = require("./ipc");
const notebook = require("../grow-transfer");
const fault = (code, message) => Object.assign(new Error(message), { code });
const uncertain = (error, committed) => Object.assign(error, { state: "recovery-required", ...(typeof committed === "boolean" ? { committed } : {}) });

// One cooperating-app barrier covers notebook writers, farm IPC and renderer
// intent creation. It does not inspect another profile or copy Chromium state.
function createTransferHost({ dialog, getWindow, isTrustedSender, getUserData, canAccess,
  canImport, source, farmRequest, farmExists = async () => false }) {
  let lease = null;
  let closing = false;
  let closePromise = null;
  let preview = null;
  const active = new Set(), documents = new WeakMap();
  function documentOf(event) {
    let document = documents.get(event.sender);
    if (!document) {
      document = { generation: 0 };
      documents.set(event.sender, document);
      // A webContents survives reload/navigation. Never deliver a preview or
      // execute recovery scripts in the replacement document.
      event.sender.on?.("did-start-navigation", (_e, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) document.generation++;
      });
      event.sender.on?.("render-process-gone", () => { document.generation++; });
      event.sender.on?.("destroyed", () => { document.generation++; });
    }
    return { sender: event.sender, frame: event.senderFrame, generation: document.generation };
  }
  const sameDocument = (owner, event) => owner.sender === event.sender && owner.frame === event.senderFrame &&
    documents.get(event.sender)?.generation === owner.generation;
  const trusted = (event, owner) => {
    if (!isTrustedSender(event) || !canAccess(event) || (owner && !sameDocument(owner, event))) {
      throw fault("UNAVAILABLE", "Record transfer requires the original desktop document and its farm workspace.");
    }
    if (closing) throw fault("TRANSFER_CLOSED", "Record transfer is closing.");
  };
  async function inspect(event, id, method) {
    if (!lease || lease.id !== id) throw fault("TRANSFER_BUSY", "The transfer session is no longer current.");
    trusted(event, lease.owner);
    const script = `(() => { const r = window.FarmRecovery; return r && typeof r.${method} === 'function' ? r.${method}(${JSON.stringify(id)}) : {ok:false,error:{code:'RECOVERY_UNAVAILABLE',message:'Shipment recovery state is unavailable.'}}; })()`;
    let timer;
    try {
      const result = await Promise.race([
        event.sender.executeJavaScript(script),
        new Promise((_, reject) => { timer = setTimeout(() => reject(fault("RECOVERY_UNAVAILABLE", "Shipment recovery inspection timed out.")), 5000); }),
      ]);
      trusted(event, lease.owner);
      if (!result || result.ok !== true) throw fault("RECOVERY_REQUIRED", result?.error?.message || "Resolve pending shipment recovery in this profile first.");
    } finally { clearTimeout(timer); }
  }
  function acquire(event, kind) {
    trusted(event);
    if (lease) throw fault("TRANSFER_BUSY", "Another record transfer or restore is in progress.");
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    lease = { id: crypto.randomUUID(), owner: documentOf(event), kind, done, finish };
    return lease;
  }
  function release(owned) {
    if (lease === owned) lease = null;
    owned.finish();
  }
  async function withLease(event, work, writes = false) {
    const owned = acquire(event, "transfer");
    let result;
    try {
      await inspect(event, owned.id, "acquire");
      await Promise.allSettled([...active]);
      await inspect(event, owned.id, "inspect");
      result = await work(() => inspect(event, owned.id, "inspect"), owned.owner);
    } finally {
      // Losing the original renderer cannot undo a commit. Never execute a
      // release script in a replacement document; its helper starts unlocked.
      try { await inspect(event, owned.id, "release"); } catch { /* original renderer stays fail-closed */ }
      release(owned);
    }
    // Release itself awaits renderer execution; navigation during that final
    // await must not leak preview data into the next document either.
    try { trusted(event, owned.owner); }
    catch (error) {
      if (writes || (result?.status && !result.canceled)) throw uncertain(error, true);
      throw error;
    }
    return result;
  }
  async function runFarm(event, action, work) {
    trusted(event);
    if (action === "backup.restore") {
      return withLease(event, async (check, owner) => {
        await check();
        let result;
        try { result = await work(); }
        catch (error) {
          if (error.code === "WRITE_OUTCOME_UNKNOWN") throw uncertain(error);
          throw error;
        }
        try {
          // Verify exportability without re-entering the public admission gate.
          await farmRequest("backup.export", {});
          trusted(event, owner);
        } catch (error) { throw uncertain(error, true); }
        return result;
      }, true);
    }
    if (lease) throw fault("TRANSFER_BUSY", "Record transfer is in progress. No farm request was queued.");
    const owner = documentOf(event);
    const pending = Promise.resolve().then(() => { trusted(event, owner); return work(); });
    active.add(pending);
    try { return await pending; } finally { active.delete(pending); }
  }
  async function save(event, name, text, check) {
    const selected = await dialog.showSaveDialog(getWindow(), {
      title: "Export private farm records", defaultPath: name,
      filters: [{ name: "JSON archive", extensions: ["json"] }],
    });
    await check();
    if (selected.canceled || !selected.filePath) return { canceled: true };
    // Refuse this profile's destinations, including realpath aliases, and
    // existing files. A save dialog never authorizes overwriting a record.
    const parent = await fs.realpath(path.dirname(selected.filePath));
    const profile = await fs.realpath(getUserData());
    const relative = path.relative(profile, parent);
    if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) {
      throw fault("TRANSFER_DESTINATION", "Choose an export location outside this desktop profile.");
    }
    const destination = path.join(parent, path.basename(selected.filePath));
    const temp = path.join(parent, `.crowe-export-${crypto.randomUUID()}.tmp`);
    let handle, directory, published = false;
    try {
      directory = await fs.open(parent, constants.O_RDONLY);
      // Reject unsupported directory durability before publishing anything.
      await directory.sync();
      handle = await fs.open(temp, "wx", 0o600);
      await handle.writeFile(text, "utf8"); await handle.sync(); await handle.close(); handle = null;
      await check();
      await fs.link(temp, destination); published = true;
      await directory.sync();
      await fs.unlink(temp);
      await directory.sync();
      return { status: "exported", verified: true, path: destination };
    } catch (error) {
      if (published) throw uncertain(fault("EXPORT_VERIFICATION_REQUIRED", "The destination archive was published but durability or cleanup could not be verified. Preserve and inspect it before another export."), true);
      if (error.code === "EEXIST") throw fault("TRANSFER_DESTINATION_EXISTS", "The selected destination already exists. Choose a new filename; nothing was overwritten.");
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (directory) await directory.close().catch(() => {});
      await fs.unlink(temp).catch(() => {});
    }
  }
  async function readSelected(filename) {
    if (!path.isAbsolute(filename) || await fs.realpath(path.dirname(filename)) !== path.resolve(path.dirname(filename))) {
      throw fault("GROW_ARCHIVE_INVALID", "Select an archive through its real directory, not a symbolic-link alias.");
    }
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > notebook.MAX_ARCHIVE_BYTES) throw fault("GROW_ARCHIVE_INVALID", "Select a supported notebook archive within the size limit.");
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const before = await handle.stat();
      if (before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size) throw fault("GROW_SOURCE_CHANGED", "The selected archive changed.");
      const bytes = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const { bytesRead } = await handle.read(bytes, count, bytes.length - count, null);
        if (!bytesRead) break;
        count += bytesRead;
      }
      const after = await handle.stat();
      if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw fault("GROW_SOURCE_CHANGED", "The selected archive changed while reading.");
      return notebook.validateArchive(bytes.subarray(0, count));
    } finally { await handle.close(); }
  }
  async function request(event, action, payload = {}) {
    try {
      trusted(event);
      const fields = { "notebook.export": [], "notebook.preview": [], "notebook.import": ["token", "confirmation"], "farm.export": [] };
      if (!Object.hasOwn(fields, action) || !payload || typeof payload !== "object" || Array.isArray(payload) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(payload)) ||
          Object.keys(payload).some(key => !fields[action].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(payload, key), "value"))) throw fault("VALIDATION", "Unsupported transfer request.");
      if (action.startsWith("notebook.") && action !== "notebook.export" && !canImport()) throw fault("UNAVAILABLE", "Import notebook records in Crowe Logic Mycology.");
      const data = await withLease(event, async (check, owner) => {
        let result;
        if (action === "notebook.export") {
          const archive = await notebook.createArchive({ userData: getUserData(), source: source() });
          await check();
          result = { ...await save(event, "crowe-notebook.json", JSON.stringify(archive), check), summary: notebook.inspectArchive(archive) };
        } else if (action === "farm.export") {
          if (!await farmExists()) throw fault("FARM_NOT_FOUND", "This profile has no compliance ledger to export. No ledger was created.");
          const backup = await farmRequest("backup.export", {});
          await check();
          result = await save(event, "crowe-farm-backup.json", JSON.stringify(backup), check);
        } else if (action === "notebook.preview") {
          preview = null;
          const selected = await dialog.showOpenDialog(getWindow(), { title: "Select notebook archive", properties: ["openFile"], filters: [{ name: "JSON archive", extensions: ["json"] }] });
          await check();
          if (selected.canceled || selected.filePaths.length !== 1) return { canceled: true };
          const archive = await readSelected(selected.filePaths[0]);
          await check();
          preview = { token: crypto.randomUUID(), owner, archive };
          result = { token: preview.token, summary: notebook.inspectArchive(archive) };
        } else {
          if (payload.confirmation !== "IMPORT EMPTY NOTEBOOK" || !preview || payload.token !== preview.token || !sameDocument(preview.owner, event)) throw fault("TRANSFER_CONFIRMATION", "Select the archive and type IMPORT EMPTY NOTEBOOK.");
          await check();
          // Keep this immutable candidate for safe matching-receipt retry; a
          // repeated token never authorizes a different archive or document.
          result = { ...await notebook.importArchive({ userData: getUserData(), archive: preview.archive }), verified: true };
        }
        try { trusted(event, owner); }
        catch (error) {
          if (result?.status && !result.canceled) throw uncertain(error, true);
          throw error;
        }
        return result;
      });
      return { ok: true, data };
    } catch (error) {
      const safeError = /^E[A-Z0-9]+$/.test(error?.code || "")
        ? fault("TRANSFER_IO", "Record transfer could not access local storage. Preserve existing records and check storage availability.") : error;
      const envelope = errorEnvelope(safeError);
      if (error?.state) envelope.error.state = error.state;
      if (typeof error?.committed === "boolean") envelope.error.committed = error.committed;
      return envelope;
    }
  }
  return {
    get busy() { return !!lease || closing; },
    runFarm, request,
    async drain(event, revoke) {
      if (typeof revoke !== "function") throw fault("VALIDATION", "Legacy revocation must execute inside the drain barrier.");
      const owned = acquire(event, "drain");
      try {
        await Promise.allSettled([...active]);
        trusted(event, owned.owner);
        const result = await revoke();
        preview = null;
        return result;
      } finally { release(owned); }
    },
    close() {
      if (!closePromise) {
        closing = true; preview = null;
        closePromise = Promise.allSettled([...active, ...(lease ? [lease.done] : [])]).then(() => undefined);
      }
      return closePromise;
    },
  };
}
module.exports = { createTransferHost };
