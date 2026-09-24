"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { json, MAX_BACKUP_BYTES, MAX_PAYLOAD_BYTES } = require("./validation");

// This is a desktop-local domain protocol, never a SQL or engine tool surface.
const ACTIONS = Object.freeze([
  "snapshot", "facility.save", "lot.create", "lot.adopt", "lot.correct", "customer.create",
  "shipment.create", "log.create", "log.update", "log.resolve", "log.reopen",
  "document.create", "document.edit", "document.submit", "document.approve",
  "document.revise", "recall", "audit", "backup.export", "backup.restore",
]);
const READ_ACTIONS = new Set(["snapshot", "recall", "audit", "backup.export"]);
const error = (code, message) => Object.assign(new Error(message), { code });

class FarmService {
  constructor({ filename, startupTimeoutMs = 15000, requestTimeoutMs = 60000,
    closeTimeoutMs = 5000, maxPending = 64, workerFactory } = {}) {
    if (typeof filename !== "string" || !path.isAbsolute(filename)) {
      throw error("FARM_STORAGE_PATH", "Farm storage requires a local absolute filename.");
    }
    this.filename = filename;
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.closeTimeoutMs = closeTimeoutMs;
    this.maxPending = maxPending;
    // Dependency injection is host/test-only. No renderer controls worker paths.
    this.workerFactory = workerFactory || ((file, options) => new Worker(file, options));
    this.state = "idle";
    this.queue = [];
    this.active = null;
    this.sequence = 0;
    this.worker = null;
    this.ready = false;
  }

  request(action, payload = {}) {
    if (!ACTIONS.includes(action)) return Promise.reject(error("UNKNOWN_ACTION", "Unknown farm action."));
    if (["closing", "closed"].includes(this.state)) return Promise.reject(error("FARM_CLOSED", "Farm storage is closing or closed."));
    if (this.state === "faulted") return Promise.reject(this.failure);
    if (this.queue.length + (this.active ? 1 : 0) >= this.maxPending) {
      return Promise.reject(error("FARM_BUSY", "Farm storage has too many pending requests. Try again after they finish."));
    }
    // Snapshot arguments at acceptance, not eventual dispatch. Callers cannot
    // change a queued shipment or adoption while another transaction is running.
    let copy;
    try {
      json(payload, action === "backup.restore" ? MAX_BACKUP_BYTES + 4096 : MAX_PAYLOAD_BYTES);
      if (action === "backup.restore") json(payload.backup, MAX_BACKUP_BYTES);
      copy = structuredClone(payload);
    } catch (cause) { return Promise.reject(error("VALIDATION", cause.message || "Farm request must contain plain JSON data.")); }
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.sequence, action, payload: copy, resolve, reject });
      if (this.state === "idle") this._start();
      this._drain();
    });
  }

  _start() {
    this.state = "starting";
    try {
      this.worker = this.workerFactory(path.join(__dirname, "worker.js"), {
        workerData: { filename: this.filename },
        // Do not inherit the app's preload/inspection flags or environment.
        execArgv: [],
        env: {},
      });
      this.worker.on("message", (message) => this._message(message));
      this.worker.on("error", () => this._fault(error(
        this.ready ? "FARM_WORKER_CRASH" : "FARM_INIT_FAILED",
        this.ready ? "Farm storage stopped unexpectedly. Restart the app." : "Farm storage could not start. Restart the app after checking local storage.",
      )));
      this.worker.on("exit", (code) => {
        this.exited = true;
        if (this.state === "closing" && this.closeAcknowledged && code === 0) this._finishClose();
        else if (!["faulted", "closed"].includes(this.state)) this._fault(error(
          this.ready ? "FARM_WORKER_CRASH" : "FARM_INIT_FAILED", "Farm storage stopped unexpectedly. Restart the app.",
        ));
      });
      this.startupTimer = setTimeout(() => this._fault(error("FARM_INIT_TIMEOUT", "Farm storage did not start in time. Restart the app.")), this.startupTimeoutMs);
    } catch {
      this._fault(error("FARM_INIT_FAILED", "Farm storage could not start. Restart the app after checking local storage."));
    }
  }

  _message(message) {
    if (["faulted", "closed"].includes(this.state)) return;
    if (!message || typeof message !== "object") return this._protocolFault();
    if (message.type === "init-error" && !this.ready) {
      return this._fault(error(message.error?.code || "FARM_INIT_FAILED", message.error?.message || "Farm storage could not start."));
    }
    if (message.type === "ready" && !this.ready) {
      clearTimeout(this.startupTimer);
      this.ready = true;
      if (this.state === "starting") this.state = "ready";
      this._drain();
      return;
    }
    if (message.type === "closed" && this.state === "closing" && this.closeSent) {
      this.closeAcknowledged = true;
      // Wait for exit, not merely the close acknowledgement.
      return;
    }
    if (message.type !== "result" || !this.active || message.id !== this.active.id || typeof message.ok !== "boolean" ||
        (message.ok ? !Object.hasOwn(message, "data") :
          !message.error || typeof message.error.code !== "string" || typeof message.error.message !== "string")) {
      return this._protocolFault();
    }
    const entry = this.active;
    clearTimeout(this.requestTimer);
    this.active = null;
    if (message.ok) entry.resolve(message.data);
    else entry.reject(error(message.error?.code || "FARM_STORE_ERROR", message.error?.message || "Farm operation failed."));
    this._drain();
  }

  _protocolFault() {
    this._fault(error("FARM_PROTOCOL_ERROR", "Farm storage returned an invalid response. Restart the app."));
  }

  _drain() {
    if (!this.ready || this.active || !["ready", "closing"].includes(this.state)) return;
    const entry = this.queue.shift();
    if (!entry) {
      if (this.state === "closing" && !this.closeSent) {
        this.closeSent = true;
        try { this.worker.postMessage({ type: "close" }); }
        catch { this._fault(error("FARM_WORKER_CRASH", "Farm storage could not close normally.")); }
      }
      return;
    }
    this.active = entry;
    this.requestTimer = setTimeout(() => this._fault(error("FARM_REQUEST_TIMEOUT", "Farm storage did not respond in time. Restart the app.")), this.requestTimeoutMs);
    try { this.worker.postMessage({ type: "request", id: entry.id, action: entry.action, payload: entry.payload }); }
    catch { this._fault(error("FARM_WORKER_CRASH", "Farm storage stopped unexpectedly. Restart the app.")); }
  }

  _fault(cause) {
    if (["faulted", "closed"].includes(this.state)) return;
    this.state = "faulted";
    this.failure = cause;
    clearTimeout(this.startupTimer);
    clearTimeout(this.requestTimer);
    if (this.active) {
      // A lost reply is not a rollback guarantee. Never silently retry writes.
      this.active.reject(READ_ACTIONS.has(this.active.action) ? cause : error(
        "WRITE_OUTCOME_UNKNOWN", "The farm write result is unknown. Restart the app and inspect records before retrying. Reuse the same shipment request ID.",
      ));
      this.active = null;
    }
    for (const entry of this.queue.splice(0)) entry.reject(cause);
    this._terminate();
    if (this.closeResolve) {
      if (!this.worker || this.exited) this._finishClose();
      else this.termination?.then(() => this._finishClose());
    }
  }

  _terminate() {
    if (this.worker && !this.exited && !this.termination) {
      try { this.termination = Promise.resolve(this.worker.terminate()).catch(() => {}); }
      catch { this.termination = Promise.resolve(); }
    }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    if (this.state === "idle" || this.state === "closed") {
      this.state = "closed";
      return Promise.resolve();
    }
    this.closePromise = new Promise((resolve) => { this.closeResolve = resolve; });
    // The bound covers the entire drain, including worker startup. Termination
    // is best effort: a native call can outlive this wait. Never reopen here.
    this.closeTimer = setTimeout(() => {
      if (this.state !== "faulted") this._fault(error("FARM_CLOSE_TIMEOUT", "Farm storage did not finish before shutdown."));
      this._terminate();
      this._finishClose();
    }, this.closeTimeoutMs);
    if (this.state === "faulted") {
      this._terminate();
      if (!this.worker || this.exited) this._finishClose();
      else this.termination?.then(() => this._finishClose());
    } else {
      this.state = "closing";
      this._drain();
    }
    return this.closePromise;
  }

  _finishClose() {
    clearTimeout(this.closeTimer);
    if (this.state !== "faulted") this.state = "closed";
    if (this.closeResolve) { const resolve = this.closeResolve; this.closeResolve = null; resolve(); }
  }
}

module.exports = { FarmService, ACTIONS };
