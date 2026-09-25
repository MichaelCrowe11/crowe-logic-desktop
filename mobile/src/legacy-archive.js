/* Settings-only, explicit recovery of raw legacy strings. No startup reads,
 * bridge/tool registration, source writes, parsing, or implicit destinations.
 * This is not an import format for Mycology or a Farm compliance backup.
 */
(function () {
  "use strict";

  const KEYS = Object.freeze([
    "grow:blocks", "grow:flushes", "grow:contam", "grow:env",
    "grow:strains", "grow:recipes", "grow:log", "camera-roll",
  ]);
  const MAX_BYTES = 32 * 1024 * 1024;
  const CACHE = "CACHE", UTF8 = "utf8"; // Capacitor Filesystem v8 enum values.
  const SHARE_GRACE_MS = 5 * 60 * 1000;
  const URL_GRACE_MS = 60 * 1000;
  let busy = false;

  const failures = new WeakSet();
  const failed = (code, message) => {
    const result = { status: "failed", code, message };
    failures.add(result);
    return result;
  };
  function stop(code, message) { throw failed(code, message); }

  function mode() {
    const cap = window.Capacitor;
    if (!cap) return { native: false };
    // An incomplete native bridge is not evidence of empty browser storage.
    if (typeof cap.isNativePlatform !== "function") {
      stop("platform-unavailable", "Cannot identify this device's archive storage.");
    }
    const native = cap.isNativePlatform();
    if (typeof native !== "boolean") stop("platform-unavailable", "Cannot identify this device's archive storage.");
    return { native, plugins: native ? cap.Plugins : null };
  }

  function filename() {
    // Names never contain stored values; no timestamp-only collision fallback.
    const crypto = window.crypto;
    if (!crypto || typeof crypto.getRandomValues !== "function") {
      stop("random-unavailable", "Cannot safely create a unique archive filename.");
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const id = Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join("");
    return "crowe-legacy-archive-" + id + ".json";
  }

  function entry(key, value) {
    // Undefined, invalid plugin responses and exceptions must never look absent.
    if (value !== null && typeof value !== "string") {
      stop("storage-read-failed", "Could not read all legacy records. No archive was exported.");
    }
    return { key, present: value !== null, value };
  }

  function serialize(entries, startedAt) {
    const archive = {
      format: "crowe-mobile-legacy-raw-archive",
      version: 1,
      sourceApp: "com.crowelogic.mobile",
      startedAt,
      completedAt: new Date().toISOString(),
      privacy: "Private, unencrypted archive. Notes may contain sensitive information. A destination you choose may retain or upload it.",
      scope: "Eight raw stored string values, not physical storage bytes. Referenced photo files are not included. Reads are not an atomic snapshot.",
      compatibility: "Archive only; not an import-compatible Mycology transfer or Farm compliance backup.",
      entries,
    };
    // A cheap lower bound avoids serializing obviously oversized values. The
    // complete encoded envelope below remains the authoritative limit.
    if (entries.reduce((n, item) => n + (item.value === null ? 0 : item.value.length), 0) > MAX_BYTES) {
      stop("archive-too-large", "The complete archive exceeds 32 MiB. Nothing was exported or truncated.");
    }
    const json = JSON.stringify(archive);
    if (new TextEncoder().encode(json).byteLength > MAX_BYTES) {
      stop("archive-too-large", "The complete archive exceeds 32 MiB. Nothing was exported or truncated.");
    }
    return json;
  }

  async function nativeExport(plugins, name, startedAt) {
    const preferences = plugins && plugins.Preferences;
    const filesystem = plugins && plugins.Filesystem;
    const share = plugins && plugins.Share;
    if (!preferences || typeof preferences.get !== "function") {
      stop("storage-unavailable", "Legacy storage is unavailable. No archive was exported.");
    }
    if (!filesystem || typeof filesystem.writeFile !== "function" || typeof filesystem.deleteFile !== "function" ||
        !share || typeof share.canShare !== "function" || typeof share.share !== "function") {
      stop("sharing-unavailable", "File sharing is unavailable on this device. No archive was exported.");
    }
    let available;
    try { available = await share.canShare(); } catch { /* fail closed */ }
    if (!available || available.value !== true) {
      stop("sharing-unavailable", "File sharing is unavailable on this device. No archive was exported.");
    }
    const entries = [];
    for (const key of KEYS) {
      let result;
      try { result = await preferences.get({ key }); } catch {
        stop("storage-read-failed", "Could not read all legacy records. No archive was exported.");
      }
      entries.push(entry(key, result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "value") ? result.value : undefined));
    }
    const json = serialize(entries, startedAt);
    // Only this generated relative Cache path is ever deleted, even if a write
    // rejects after creating a partial file. Never scan or clear the cache.
    const location = { path: name, directory: CACHE };
    let outcome;
    let shareResolved = false;
    try {
      let written;
      try {
        written = await filesystem.writeFile({ ...location, data: json, encoding: UTF8 });
      } catch {
        stop("file-write-failed", "Could not create the temporary archive. Source records are unchanged.");
      }
      if (!written || typeof written.uri !== "string" || !written.uri.startsWith("file://")) {
        stop("file-write-failed", "The temporary archive did not return a shareable file. Source records are unchanged.");
      }
      try {
        // File only: no text/clipboard fallback, attachment registration or recipient.
        await share.share({ files: [written.uri], title: "Private legacy data archive", dialogTitle: "Share private legacy archive" });
        shareResolved = true;
        outcome = {
          status: "handed-off",
          message: "The share sheet returned. Saving or receipt is not verified; some destinations may not distinguish dismissal. Check your chosen destination.",
        };
      } catch (error) {
        // Exact rejection in Capacitor Share v8's iOS and Android implementations.
        outcome = error && error.message === "Share canceled"
          ? { status: "cancelled", message: "Sharing was cancelled. Source records are unchanged." }
          : failed("share-failed", "Sharing did not complete. A destination may have received the file; saving is not verified. Source records are unchanged.");
      }
    } catch (error) {
      outcome = failures.has(error) ? error : failed("export-failed", "The archive could not be exported. Source records are unchanged; no saved backup is verified.");
    } finally {
      if (shareResolved) {
        // A native receiver may still read the URI after Share resolves. Never
        // delete immediately on handoff. This operation owns only this path;
        // suspension/termination can prevent the timer, so retention is explicit.
        outcome.cacheNotice = "A private temporary copy may remain in app cache until cleanup runs or the operating system removes it.";
        try {
          setTimeout(() => { Promise.resolve().then(() => filesystem.deleteFile(location)).catch(() => {}); }, SHARE_GRACE_MS);
          outcome.cacheCleanup = "scheduled";
        } catch {
          outcome.cacheCleanup = "unavailable";
          outcome.cleanupWarning = true;
        }
      } else {
        try {
          await filesystem.deleteFile(location);
          outcome.cacheCleanup = "removed";
        } catch {
          outcome.cacheCleanup = "failed";
          outcome.cleanupWarning = true;
          outcome.cacheNotice = "The private temporary archive could not be removed and may remain in app cache.";
        }
      }
    }
    return outcome;
  }

  function browserExport(name, startedAt) {
    let storage;
    try { storage = window.localStorage; } catch { /* access itself may throw */ }
    if (!storage || typeof storage.getItem !== "function") {
      stop("storage-unavailable", "Legacy storage is unavailable. No archive was exported.");
    }
    if (typeof Blob !== "function" || !window.URL || typeof window.URL.createObjectURL !== "function" ||
        typeof window.URL.revokeObjectURL !== "function" || !document.body) {
      stop("download-unavailable", "File download is unavailable in this browser. No archive was exported.");
    }
    const entries = [];
    for (const key of KEYS) {
      let value;
      try { value = storage.getItem("crowe:" + key); } catch {
        stop("storage-read-failed", "Could not read all legacy records. No archive was exported.");
      }
      entries.push(entry(key, value));
    }
    const json = serialize(entries, startedAt);
    let url, anchor;
    try {
      anchor = document.createElement("a");
      if (!("download" in anchor)) stop("download-unavailable", "This browser does not support archive downloads.");
      url = window.URL.createObjectURL(new Blob([json], { type: "application/json;charset=utf-8" }));
      anchor.href = url;
      anchor.download = name;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      return { status: "download-requested", message: "Archive download requested. Saving is not verified; check your browser's downloads. Source records are unchanged." };
    } finally {
      if (anchor) { try { anchor.remove(); } catch { /* no archive in DOM text */ } }
      // Revoking synchronously can abort the browser's asynchronous download.
      if (url) setTimeout(() => { window.URL.revokeObjectURL(url); }, URL_GRACE_MS);
    }
  }

  async function exportArchive() {
    if (busy) return { status: "busy", message: "An archive export is already in progress." };
    // UI calls directly from the Settings click handler, before any await. Do
    // not add launch, lifecycle, native-intent, tool or timer invocations.
    if (window.navigator && window.navigator.userActivation && !window.navigator.userActivation.isActive) {
      return failed("gesture-required", "Choose Export legacy archive in Settings to start an export.");
    }
    busy = true;
    try {
      const platform = mode();
      const name = filename();
      const startedAt = new Date().toISOString();
      return platform.native
        ? await nativeExport(platform.plugins, name, startedAt)
        : browserExport(name, startedAt);
    } catch (error) {
      // Only our fixed messages leave this module. Never leak storage/plugin
      // error text (which can contain private raw values or filesystem paths).
      if (failures.has(error)) return error;
      return failed("export-failed", "The archive could not be exported. Source records are unchanged; no saved backup is verified.");
    } finally {
      busy = false;
    }
  }

  window.croweLegacyArchive = Object.freeze({ export: exportArchive });
})();
