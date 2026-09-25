"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const { ACTIONS } = require("./service");
const { FarmError } = require("./validation");

function fault(code, message) { return new FarmError(code, message); }
function publicError(cause, fallback) {
  // Domain messages are authored by the store. Native exceptions can contain
  // filenames or internals and must not cross the renderer boundary.
  if (cause instanceof FarmError) {
    return { code: cause.code, message: String(cause.message).slice(0, 500) };
  }
  return { code: fallback, message: fallback === "FARM_INIT_FAILED"
    ? "Farm storage could not open. Check local storage and restart the app."
    : "Farm operation could not complete. Check local storage before retrying." };
}

function prepareStorage(filename) {
  if (typeof filename !== "string" || !path.isAbsolute(filename)) throw fault("FARM_STORAGE_PATH", "Invalid farm storage location.");
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = fs.lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw fault("FARM_STORAGE_PATH", "Farm storage directory must not be a symbolic link.");
  fs.chmodSync(directory, 0o700);
  // Pre-create before SQLite can choose permissions. WAL and SHM inherit the
  // database mode; also tighten/check any sidecars from an earlier session.
  try {
    const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.closeSync(fd);
  } catch (cause) { if (cause.code !== "EEXIST") throw cause; }
  for (const file of [filename, filename + "-wal", filename + "-shm", filename + "-journal"]) {
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (cause) { if (cause.code === "ENOENT") continue; throw cause; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fault("FARM_STORAGE_PATH", "Farm storage must use ordinary private files.");
    fs.chmodSync(file, 0o600);
  }
}

let store;
try {
  prepareStorage(workerData.filename);
  const { FarmStore } = require("./store");
  store = new FarmStore({ filename: workerData.filename });
  parentPort.postMessage({ type: "ready" });
} catch (cause) {
  parentPort.postMessage({ type: "init-error", error: publicError(cause, "FARM_INIT_FAILED") });
  parentPort.close();
}

if (store) {
  // handle() is synchronous. The message loop cannot start another transaction
  // until the previous call has returned or thrown.
  parentPort.on("message", (message) => {
    if (message?.type === "close") {
      try {
        store.close();
        parentPort.postMessage({ type: "closed" });
        parentPort.close();
      } catch { throw fault("FARM_CLOSE_FAILED", "Farm storage could not close normally."); }
      return;
    }
    if (message?.type !== "request" || !Number.isSafeInteger(message.id)) {
      throw fault("FARM_PROTOCOL_ERROR", "Invalid farm worker request.");
    }
    let data;
    try {
      if (!ACTIONS.includes(message.action)) throw fault("UNKNOWN_ACTION", "Unknown farm action.");
      data = store.handle(message.action, message.payload);
    } catch (cause) {
      // Only domain errors are known rejections. A native failure (including a
      // failed rollback) has no safe transaction-outcome guarantee.
      if (!(cause instanceof FarmError)) throw cause;
      parentPort.postMessage({ type: "result", id: message.id, ok: false, error: publicError(cause, "INTERNAL") });
      return;
    }
    // A failure to transmit a committed result must crash the worker, not look
    // like a rejected transaction. The host marks dispatched writes unknown.
    parentPort.postMessage({ type: "result", id: message.id, ok: true, data });
  });
}
