"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const { FarmService, ACTIONS } = require("./service");
const { json, MAX_BACKUP_BYTES, MAX_PAYLOAD_BYTES: MAX_REQUEST_BYTES } = require("./validation");
const MAX_LEGACY_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = MAX_REQUEST_BYTES;
const SOURCE_PREFIX = "legacy-flush:";
const validSourceRowId = (id) => typeof id === "string" && id.length > 0 &&
  id.length <= 200 - SOURCE_PREFIX.length && id.trim() === id && !/[\x00-\x1f\x7f]/.test(id);
const LOT_FIELDS = ["harvestDate", "room", "species", "quantityLbs", "notes"];
const LOG_FIELDS = ["loggedAt", "room", "temperatureF", "humidityPercent", "cleaningCompleted", "lotId", "deviationNotes", "correctiveAction"];
const FIELDS = Object.freeze({
  snapshot: [],
  "facility.save": ["name", "ownerName", "address", "emergencyPhone", "waterSource"],
  "lot.create": LOT_FIELDS,
  "lot.adopt": ["sourceId", ...LOT_FIELDS],
  "lot.correct": ["id", "expectedVersion", "reason", ...LOT_FIELDS],
  "customer.create": ["name", "contact", "email", "phone", "address"],
  "shipment.create": ["requestId", "customerId", "shippedAt", "items", "notes"],
  "log.create": LOG_FIELDS,
  "log.update": ["id", "expectedVersion", "reason", ...LOG_FIELDS],
  "log.resolve": ["id", "expectedVersion", "correctiveAction", "reason"],
  "log.reopen": ["id", "expectedVersion", "reason"],
  "document.create": ["title", "type", "content"],
  "document.edit": ["id", "revisionId", "expectedVersion", "title", "content", "reason"],
  "document.submit": ["id", "revisionId", "expectedVersion"],
  "document.approve": ["id", "revisionId", "expectedVersion", "attestation"],
  "document.revise": ["id", "reason"],
  recall: ["lotId"],
  audit: ["entityId"],
  "backup.export": [],
  "backup.restore": ["backup", "confirmation"],
});
const fault = (code, message) => Object.assign(new Error(message), { code });
const denied = () => ({ ok: false, error: { code: "UNTRUSTED_SENDER", message: "Farm records are available only to the desktop workspace." } });
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

function validateJson(value, maxBytes, code = "VALIDATION") {
  try { return json(value, maxBytes); }
  catch (cause) { throw fault(code, cause.message); }
}

function sanitizeRequest(action, payload) {
  if (typeof action !== "string" || !ACTIONS.includes(action)) throw fault("UNKNOWN_ACTION", "Unknown farm action.");
  if (!plain(payload)) throw fault("VALIDATION", "Farm request must be an object.");
  validateJson(payload, action === "backup.restore" ? MAX_BACKUP_BYTES + 4096 : MAX_REQUEST_BYTES);
  const clean = {};
  for (const key of Object.keys(payload)) {
    // Renderer provenance, paths and actors are rejected, never ignored.
    if (!FIELDS[action].includes(key)) throw fault("VALIDATION", "Farm request contains an unsupported field.");
    clean[key] = payload[key];
  }
  if (action === "backup.restore") validateJson(clean.backup, MAX_BACKUP_BYTES, "INVALID_BACKUP");
  if (action === "shipment.create" && Array.isArray(clean.items)) {
    for (const item of clean.items) {
      if (!plain(item) || Object.keys(item).some((key) => !["lotId", "quantityLbs"].includes(key))) {
        throw fault("VALIDATION", "Shipment items accept only lotId and quantityLbs.");
      }
    }
  }
  if (action === "backup.restore" && clean.confirmation !== "RESTORE EMPTY FARM") {
    throw fault("RESTORE_CONFIRMATION_REQUIRED", "Type RESTORE EMPTY FARM to restore into an empty store.");
  }
  return clean;
}

// A missing file means no legacy harvests. Every other I/O/parse/schema failure
// is explicit, unlike growRead(), which intentionally returns [] on corruption.
async function readLegacyHarvests(filename) {
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_LEGACY_BYTES) throw fault("LEGACY_SOURCE_INVALID", "Legacy harvest file is not a supported JSON file.");
    // A bounded read also catches a file that grew after stat(), without reading
    // unbounded data into the main process.
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw fault("LEGACY_SOURCE_CHANGED", "Legacy harvest file changed while reading. Try again.");
    }
    let rows;
    try { rows = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))); }
    catch { throw fault("LEGACY_SOURCE_INVALID", "Legacy harvest file contains invalid JSON. The original file has not been changed."); }
    if (!Array.isArray(rows) || rows.length > 10000) throw fault("LEGACY_SOURCE_INVALID", "Legacy harvest file must contain a supported list of records.");
    const ids = new Set();
    for (const row of rows) {
      if (!plain(row) || !validSourceRowId(row.id)) {
        throw fault("LEGACY_SOURCE_INVALID", "Each legacy harvest must have a valid stable record ID.");
      }
      if (ids.has(row.id)) throw fault("LEGACY_SOURCE_DUPLICATE_ID", "Legacy harvest IDs are duplicated. Resolve the source records before adoption.");
      ids.add(row.id);
      validateJson(row, MAX_SOURCE_BYTES, "LEGACY_SOURCE_INVALID");
      for (const key of ["date", "block", "room", "strain", "weight", "n", "grade"]) {
        if (row[key] !== undefined && row[key] !== null && !["string", "number"].includes(typeof row[key])) {
          throw fault("LEGACY_SOURCE_INVALID", "Legacy harvest display fields must be text or numbers.");
        }
      }
    }
    return rows;
  } catch (cause) {
    if (cause.code === "ENOENT") return [];
    if (String(cause.code || "").startsWith("LEGACY_")) throw cause;
    throw fault("LEGACY_SOURCE_UNREADABLE", "Legacy harvest file could not be read. The original file has not been changed.");
  } finally { if (handle) await handle.close(); }
}

function errorEnvelope(cause) {
  const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(cause?.code || "") ? cause.code : "FARM_UNAVAILABLE";
  const safe = !/^(?:ERR_|SQLITE_|EACCES$|EPERM$|ENOENT$|EIO$|ENOSPC$)/.test(code);
  return { ok: false, error: { code: safe ? code : "FARM_UNAVAILABLE", message: safe && cause?.code
    ? String(cause.message || "Farm operation failed.").slice(0, 500)
    : "Farm storage is unavailable. Check local storage and restart the app.",
    ...(["not-imported", "recovery-required"].includes(cause?.state) ? { state: cause.state } : {}),
    ...(typeof cause?.committed === "boolean" ? { committed: cause.committed } : {}),
  } };
}

function registerFarmIpc({ ipcMain, isTrustedSender, getFilename, getLegacyFilename,
  canAccess = () => true, runOperation = (_event, _action, work) => work(),
  createService = (options) => new FarmService(options) }) {
  let service = null;
  let closing = false;
  const getService = () => {
    if (closing) throw fault("FARM_CLOSED", "Farm storage is closing or closed.");
    if (!service) service = createService({ filename: getFilename() });
    return service;
  };
  const guard = (handler) => async (event, ...args) => {
    try {
      if (!isTrustedSender(event)) return denied();
      if (!canAccess(event)) throw fault("UNAVAILABLE", "Open Legacy farm records or use Crowe Logic Mycology to access this local ledger.");
      if (closing) throw fault("FARM_CLOSED", "Farm storage is closing or closed.");
      const data = await handler(event, ...args);
      // Do not return farm data into a document which navigated while waiting.
      if (!isTrustedSender(event)) return denied();
      if (!canAccess(event)) throw fault("UNAVAILABLE", "Legacy record access has ended.");
      return { ok: true, data };
    } catch (cause) { return errorEnvelope(cause); }
  };

  ipcMain.handle("crowe:farm:request", guard(async (event, action, payload = {}) => {
    const clean = sanitizeRequest(action, payload);
    return runOperation(event, action, async () => {
      if (action === "lot.adopt") {
        if (typeof clean.sourceId !== "string" || !clean.sourceId.startsWith(SOURCE_PREFIX) ||
            !validSourceRowId(clean.sourceId.slice(SOURCE_PREFIX.length))) {
          throw fault("LEGACY_SOURCE_NOT_FOUND", "Select a legacy harvest by its stable source ID.");
        }
        const rows = await readLegacyHarvests(getLegacyFilename());
        const source = rows.find((row) => "legacy-flush:" + row.id === clean.sourceId);
        if (!source) throw fault("LEGACY_SOURCE_NOT_FOUND", "The selected legacy harvest no longer exists.");
        if (!isTrustedSender(event)) throw fault("UNTRUSTED_SENDER", "Farm records are available only to the desktop workspace.");
        // Retain the actual complete source row, unchanged. Reviewed lot fields
        // describe the new lot, never overwrite historical source facts.
        clean.sourceSnapshot = source;
      }
      if (!canAccess(event)) throw fault("UNAVAILABLE", "Legacy record access has ended.");
      return getService().request(action, clean);
    });
  }));

  ipcMain.handle("crowe:farm:legacy-harvests", guard(async (event) => runOperation(event, "legacy-harvests", async () => {
    const rows = await readLegacyHarvests(getLegacyFilename());
    if (!isTrustedSender(event)) throw fault("UNTRUSTED_SENDER", "Farm records are available only to the desktop workspace.");
    const snapshot = await getService().request("snapshot", {});
    const adopted = new Map(snapshot.lots.filter((lot) => lot.sourceId).map((lot) => [lot.sourceId, lot.id]));
    return rows.map((row) => {
      const sourceId = "legacy-flush:" + row.id;
      const candidate = {
        id: row.id, sourceId, date: row.date ?? "", lot: row.block ?? "",
        room: row.room ?? "", strain: row.strain ?? "", weightLbs: row.weight ?? "",
        n: row.n ?? "", grade: row.grade ?? "",
      };
      if (adopted.has(sourceId)) candidate.adoptedLotId = adopted.get(sourceId);
      return candidate;
    });
  })));

  return {
    request(action, payload = {}) { return getService().request(action, payload); },
    close() {
      closing = true;
      return service ? service.close() : null;
    },
  };
}

module.exports = { registerFarmIpc, sanitizeRequest, readLegacyHarvests, errorEnvelope, MAX_BACKUP_BYTES };
