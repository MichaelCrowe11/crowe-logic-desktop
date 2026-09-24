"use strict";

// Execute the real IPC/preload wrappers without importing main.js or opening
// the application's real profile. All disk fixtures are isolated temporary data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { registerFarmIpc, sanitizeRequest, readLegacyHarvests, MAX_BACKUP_BYTES } = require("../farm/ipc");
const { isTrustedIpcSender } = require("../main-security");
const { MAX_PAYLOAD_BYTES } = require("../farm/validation");
const { FarmService, ACTIONS } = require("../farm/service");
const root = path.join(__dirname, "..");
const entry = path.join(root, "renderer", "index.html");
let checks = 0;
async function test(name, run) { await run(); checks++; console.log("ok - " + name); }
const rejected = (value, code) => { assert.equal(value.ok, false); if (code) assert.equal(value.error.code, code); assert.equal(typeof value.error.message, "string"); };
const lotFields = { harvestDate: "2026-09-22", room: "Owner reviewed room", species: "Owner reviewed species", quantityLbs: "5.000" };
function harness(directory, createService) {
  const handlers = new Map();
  const frame = { url: pathToFileURL(entry).href };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: frame };
  const filename = path.join(directory, "userData", "farm-compliance", "farm.db");
  const legacy = path.join(directory, "userData", "grow", "flushes.json");
  const host = registerFarmIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    isTrustedSender: (e) => isTrustedIpcSender(e, window, entry), getFilename: () => filename,
    getLegacyFilename: () => legacy, ...(createService ? { createService } : {}) });
  return { host, event, frame, contents, handlers, filename, legacy,
    request: (action, payload = {}, e = event) => handlers.get("crowe:farm:request")(e, action, payload),
    list: (e = event) => handlers.get("crowe:farm:legacy-harvests")(e),
    write: (rows) => { fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.writeFileSync(legacy, JSON.stringify(rows)); },
  };
}

async function mocks(directory) {
  await test("scoped allowlist contains lot.correct and uses exact shared byte limits", async () => {
    for (const action of ACTIONS.filter((a) => !["backup.restore"].includes(a))) assert.doesNotThrow(() => sanitizeRequest(action, {}));
    assert.equal(MAX_BACKUP_BYTES, 10 * 1024 * 1024);
    const payload = { content: "x".repeat(MAX_PAYLOAD_BYTES - Buffer.byteLength(JSON.stringify({ content: "" }))) };
    assert.doesNotThrow(() => sanitizeRequest("document.create", payload));
    assert.throws(() => sanitizeRequest("document.create", { content: payload.content + "x" }), { code: "VALIDATION" });
    assert.throws(() => sanitizeRequest("document.create", { content: "é".repeat(MAX_PAYLOAD_BYTES / 2) }), { code: "VALIDATION" });
    const backup = { data: "x".repeat(MAX_BACKUP_BYTES - Buffer.byteLength(JSON.stringify({ data: "" }))) };
    assert.doesNotThrow(() => sanitizeRequest("backup.restore", { backup, confirmation: "RESTORE EMPTY FARM" }));
    assert.throws(() => sanitizeRequest("backup.restore", { backup: { data: backup.data + "x" }, confirmation: "RESTORE EMPTY FARM" }), { code: "INVALID_BACKUP" });
    assert.throws(() => sanitizeRequest("backup.restore", { backup, confirmation: "restore" }));
    for (const action of ["sql", "fs.read", "operator.set", "constructor"]) assert.throws(() => sanitizeRequest(action, {}), { code: "UNKNOWN_ACTION" });
  });
  await test("renderer cannot inject paths, actor or source and shipment provenance", async () => {
    for (const key of ["actor", "operator", "sourceSnapshot", "sourceHash", "sourceReviewedBy", "sourceApprovedAt", "filename", "path", "sql"]) {
      assert.throws(() => sanitizeRequest("lot.adopt", { sourceId: "legacy-flush:f1", ...lotFields, [key]: "spoof" }), { code: "VALIDATION" });
      assert.throws(() => sanitizeRequest("lot.correct", { id: "lot1", reason: "reason", expectedVersion: 1, [key]: "spoof" }), { code: "VALIDATION" });
    }
    for (const key of ["actor", "lotSnapshot", "sourceSnapshot", "lotCode"]) {
      assert.throws(() => sanitizeRequest("shipment.create", { items: [{ lotId: "l1", quantityLbs: "1.000", [key]: {} }] }), { code: "VALIDATION" });
    }
    for (const payload of [{ notes: undefined }, { notes: new Date() }, { notes: Infinity }, JSON.parse('{"__proto__":{}}')]) {
      assert.throws(() => sanitizeRequest("lot.create", payload), { code: "VALIDATION" });
    }
    const payload = {};
    Object.defineProperty(payload, "notes", { enumerable: true, get: () => { throw new Error("getter must never run"); } });
    assert.throws(() => sanitizeRequest("lot.create", payload), { code: "VALIDATION" });
  });
  await test("sender policy denies subframes, guests, stale contents, remote pages; storage stays lazy", async () => {
    let opened = 0;
    const h = harness(path.join(directory, "trust"), () => { opened++; return { request: async () => ({}), close() {} }; });
    assert.equal(opened, 0);
    for (const event of [{}, { sender: h.contents, senderFrame: { url: h.frame.url } },
      { sender: { mainFrame: h.frame }, senderFrame: h.frame }]) {
      rejected(await h.request("snapshot", {}, event), "UNTRUSTED_SENDER");
      rejected(await h.list(event), "UNTRUSTED_SENDER");
    }
    const url = h.frame.url;
    h.frame.url = "https://example.invalid/";
    rejected(await h.request("snapshot"), "UNTRUSTED_SENDER");
    h.frame.url = url;
    rejected(await h.request("snapshot", { filename: "/tmp/not-allowed" }), "VALIDATION");
    assert.equal(opened, 0);
    assert.deepEqual(await h.request("snapshot"), { ok: true, data: {} });
    assert.equal(opened, 1);
    await h.host.close();
    rejected(await h.request("snapshot"), "FARM_CLOSED");
  });
  await test("adoption rereads complete raw row; candidates do not infer species or room", async () => {
    let accepted;
    const h = harness(path.join(directory, "reread"), () => ({ request: async (action, payload) => {
      if (action === "snapshot") return { lots: [{ sourceId: "legacy-flush:f1", id: "already-adopted" }] };
      accepted = payload;
      return { id: "created" };
    }, close() {} }));
    const first = { id: "f1", date: "2026-09-22", block: "Room A / Oyster / ambiguous", weight: 5, notes: "first", extra: { raw: true } };
    h.write([first]);
    const candidates = await h.list();
    assert.equal(candidates.ok, true);
    assert.equal(candidates.data[0].sourceId, "legacy-flush:f1");
    assert.equal(candidates.data[0].adoptedLotId, "already-adopted");
    assert.equal(candidates.data[0].room, "");
    assert.equal(candidates.data[0].strain, "");
    assert.equal(candidates.data[0].lot, first.block);
    assert.equal(Object.hasOwn(candidates.data[0], "extra"), false);
    const edited = { ...first, notes: " second exact record ", weight: 7.125, extra: { raw: [1, null, " preserved "] } };
    h.write([edited]);
    const bytes = fs.readFileSync(h.legacy);
    const result = await h.request("lot.adopt", { sourceId: "legacy-flush:f1", ...lotFields });
    assert.equal(result.ok, true);
    assert.deepEqual(accepted.sourceSnapshot, edited);
    assert.equal(accepted.quantityLbs, "5.000");
    assert.equal(Object.hasOwn(accepted, "actor"), false);
    assert.deepEqual(fs.readFileSync(h.legacy), bytes);
    rejected(await h.request("lot.adopt", { sourceId: "legacy-flush:f1", ...lotFields, sourceSnapshot: first }), "VALIDATION");
    h.write([]);
    rejected(await h.request("lot.adopt", { sourceId: "legacy-flush:f1", ...lotFields }), "LEGACY_SOURCE_NOT_FOUND");
    await h.host.close();
  });
  await test("missing legacy file is empty but corrupt, duplicate and invalid IDs are explicit errors", async () => {
    const h = harness(path.join(directory, "legacy-invalid"), () => ({ request: async () => ({ lots: [] }), close() {} }));
    assert.deepEqual(await readLegacyHarvests(h.legacy), []);
    for (const rows of [[{}], [{ id: "" }], [{ id: 5 }], [{ id: " f1" }], [{ id: "x".repeat(201) }], [{ id: "f1", weight: {} }]]) {
      h.write(rows);
      rejected(await h.list(), "LEGACY_SOURCE_INVALID");
    }
    h.write([{ id: "f1" }, { id: "f1" }]);
    rejected(await h.list(), "LEGACY_SOURCE_DUPLICATE_ID");
    h.write({ wrong: [] });
    rejected(await h.list(), "LEGACY_SOURCE_INVALID");
    fs.writeFileSync(h.legacy, "{broken");
    rejected(await h.list(), "LEGACY_SOURCE_INVALID");
    assert.equal(fs.readFileSync(h.legacy, "utf8"), "{broken");
    fs.writeFileSync(h.legacy, Buffer.from([0xff, 0xfe]));
    rejected(await h.list(), "LEGACY_SOURCE_INVALID");
    fs.truncateSync(h.legacy, 16 * 1024 * 1024 + 1);
    rejected(await h.list(), "LEGACY_SOURCE_INVALID");
    await h.host.close();
  });
  await test("navigation during async work cannot receive data; worker errors are envelopes", async () => {
    let finish;
    const h = harness(path.join(directory, "async-trust"), () => ({ request: () => new Promise((resolve) => { finish = resolve; }), close() {} }));
    const pending = h.request("snapshot");
    h.frame.url = "https://example.invalid/";
    finish({ private: "do not deliver" });
    rejected(await pending, "UNTRUSTED_SENDER");
    await h.host.close();
    const failed = harness(path.join(directory, "error"), () => ({ request: async () => { throw Object.assign(new Error("Result unknown. Inspect first."), { code: "WRITE_OUTCOME_UNKNOWN" }); }, close() {} }));
    rejected(await failed.request("lot.create", lotFields), "WRITE_OUTCOME_UNKNOWN");
    await failed.host.close();
    const native = harness(path.join(directory, "native-error"), () => { throw Object.assign(new Error("private /home/name/database"), { code: "EACCES" }); });
    const response = await native.request("snapshot");
    rejected(response);
    assert(!response.error.message.includes("/home"));
    await native.host.close();
  });
  await test("preload exposes two explicit async methods and preserves failure envelopes", async () => {
    let bridge, next = { ok: true, data: { lots: [] } }, call;
    const context = { process: { argv: ["electron", "--crowe-spaces=chat,farm"] }, require: (name) => {
      assert.equal(name, "electron");
      return { contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, "crowe"); bridge = value; } },
        ipcRenderer: { invoke: async (...args) => { call = args; if (next instanceof Error) throw next; return next; } } };
    } };
    vm.runInNewContext(fs.readFileSync(path.join(root, "preload.js"), "utf8"), context);
    assert.deepEqual(Object.keys(bridge.farm), ["request", "legacyHarvests"]);
    assert.equal(bridge.installSpaces.join(","), "chat,farm");
    assert.equal((await bridge.farm.request("snapshot")).ok, true);
    assert.equal(call[0], "crowe:farm:request");
    next = { ok: false, error: { code: "CONFLICT", message: "Refresh the record." } };
    assert.equal(await bridge.farm.request("lot.correct", {}), next);
    await bridge.farm.legacyHarvests();
    assert.deepEqual(call, ["crowe:farm:legacy-harvests"]);
    next = new Error("native exception /private/path");
    rejected(await bridge.farm.request("snapshot"), "UNAVAILABLE");
    rejected(await bridge.farm.request("lot.create", lotFields), "WRITE_OUTCOME_UNKNOWN");
    rejected(await bridge.farm.legacyHarvests(), "UNAVAILABLE");
    next = undefined;
    rejected(await bridge.farm.request("snapshot"), "UNAVAILABLE");
  });
  await test("main wiring uses fixed userData paths, same trust policy, lazy teardown, passes farm space", async () => {
    const source = fs.readFileSync(path.join(root, "main.js"), "utf8");
    const registration = source.match(/const farmHost = require\("\.\/farm\/ipc"\)\.registerFarmIpc\(\{[\s\S]*?\n\}\);/)[0];
    let options;
    const context = { require: (name) => name === "./grow-transfer" ? { assertReady: () => {} } : ({ registerFarmIpc: (value) => { options = value; return {}; } }),
      path, app: { getPath: (name) => { assert.equal(name, "userData"); return path.join(directory, "wiring"); } },
      registerIpcHandler() {}, isTrustedIpcSender: (e, w, entryPath) => e === "event" && w === "window" && entryPath === entry,
      mainWindow: "window", APP_ENTRY: entry, farmAccess: () => false,
      transferHost: { runFarm: (_e, _action, work) => work() } };
    vm.runInNewContext(registration, context);
    assert.equal(options.getFilename(), path.join(directory, "wiring", "farm-compliance", "farm.db"));
    assert.equal(options.getLegacyFilename(), path.join(directory, "wiring", "grow", "flushes.json"));
    assert.equal(options.isTrustedSender("event"), true);
    assert.equal(options.isTrustedSender("guest"), false);
    assert(source.includes("const farm = transferHost.close().then(() => farmHost.close());"));
    const install = source.match(/function installSpaces\(\) \{[\s\S]*?\n\}/)[0];
    const spaces = vm.runInNewContext(install + '\ninstallSpaces()', { EDITION: { defaultSpaces: ["farm", "cultivation"] } });
    assert.equal(spaces.join(","), "farm,cultivation");
    assert.equal(options.canAccess(), false);
    const harnessBody = (source.match(/const harnessCtx = \{[\s\S]*?\n\};/) || [""])[0];
    assert(!/\bfarm\s*:/.test(harnessBody));
  });
}

async function realHost(directory) {
  assert(fs.existsSync(path.join(root, "farm/store.js")), "DEFERRED: farm/store.js is not ready; real host/worker assertions must be rerun.");
  require("node:sqlite");
  await test("real IPC and worker preserve adoption, corrections, traceability and backup restart", async () => {
    let service;
    const h = harness(path.join(directory, "real"), (options) => { service = new FarmService(options); return service; });
    try {
      assert.equal(service, undefined);
      const raw = { id: "f-stable", block: "ambiguous shared block", date: "2026-09-22", weight: 5.123, notes: " raw  " };
      h.write([raw]);
      const candidates = await h.list();
      assert.equal(candidates.ok, true);
      assert.equal(candidates.data[0].room, "");
      assert.equal(candidates.data[0].strain, "");
      raw.notes = " exact reread ";
      h.write([raw]);
      const request = { sourceId: "legacy-flush:f-stable", ...lotFields };
      const attempts = await Promise.all([h.request("lot.adopt", request), h.request("lot.adopt", request)]);
      assert.equal(attempts.filter((r) => r.ok).length, 1, JSON.stringify(attempts));
      rejected(attempts.find((r) => !r.ok), "DUPLICATE_SOURCE");
      const lot = attempts.find((r) => r.ok).data;
      assert.deepEqual(lot.sourceSnapshot, raw);
      assert(lot.sourceReviewedBy && lot.sourceApprovedAt && lot.sourceHash);
      const originalSource = structuredClone(lot.sourceSnapshot);
      const customerResponse = await h.request("customer.create", { name: "Fixture recipient" });
      assert.equal(customerResponse.ok, true);
      const shipmentRequest = { requestId: "host-idempotency", customerId: customerResponse.data.id,
        shippedAt: "2026-09-23T12:00:00Z", items: [{ lotId: lot.id, quantityLbs: "2.000" }] };
      const shipments = await Promise.all([h.request("shipment.create", shipmentRequest), h.request("shipment.create", shipmentRequest)]);
      assert(shipments.every((r) => r.ok));
      assert.equal(shipments[0].data.id, shipments[1].data.id);
      const correction = await h.request("lot.correct", { id: lot.id, expectedVersion: lot.version, reason: "Reviewed room correction", room: "Corrected room" });
      assert.equal(correction.ok, true);
      const insufficient = await h.request("lot.correct", { id: lot.id, expectedVersion: correction.data.version, reason: "Too low", quantityLbs: "1.000" });
      assert.equal(insufficient.ok, false);
      h.write([]);
      const recall = await h.request("recall", { lotId: lot.id });
      assert.equal(recall.ok, true);
      assert.deepEqual(recall.data.lot.sourceSnapshot, originalSource);
      assert.equal(recall.data.lot.room, "Corrected room");
      assert.equal(recall.data.affectedShipments[0].lotSnapshot.room, lotFields.room);
      assert.deepEqual(recall.data.affectedShipments[0].lotSnapshot.sourceSnapshot, originalSource);
      const audit = await h.request("audit", { entityId: lot.id });
      assert.equal(audit.ok, true);
      assert(audit.data.length >= 2);
      assert(audit.data.every((e) => e.actor));
      const snapshot = await h.request("snapshot");
      await h.host.close();
      const reopened = harness(path.join(directory, "real"));
      try {
        const persisted = await reopened.request("snapshot");
        assert.equal(persisted.ok, true);
        assert.deepEqual(persisted.data.lots, snapshot.data.lots);
        assert.deepEqual(persisted.data.shipments, snapshot.data.shipments);
      } finally { await reopened.host.close(); }
    } finally { await h.host.close(); }
  });
  await test("real adoption preserves additional fields on the actual legacy row", async () => {
    const h = harness(path.join(directory, "raw-extension"));
    try {
      // growWrite merges complete records rather than enforcing a closed row
      // schema. Host must never discard these existing facts to make adoption fit.
      const raw = { id: "f-extra", date: "2026-09-22", block: "shared label", weight: 5,
        room: "Actual explicit room", strain: "Actual explicit strain", extra: { observed: true } };
      h.write([raw]);
      const listed = await h.list();
      assert.equal(listed.ok, true);
      assert.equal(listed.data[0].room, raw.room);
      assert.equal(listed.data[0].strain, raw.strain);
      const adopted = await h.request("lot.adopt", { sourceId: "legacy-flush:f-extra", ...lotFields });
      assert.equal(adopted.ok, true, JSON.stringify(adopted));
      assert.deepEqual(adopted.data.sourceSnapshot, raw);
      assert.deepEqual(fs.readFileSync(h.legacy, "utf8"), JSON.stringify([raw]));
    } finally { await h.host.close(); }
  });
}

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-farm-host-"));
  try { await mocks(directory); await realHost(directory); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
  console.log(`farm-host: ${checks} groups passed (${process.version}${process.versions.electron ? ", Electron " + process.versions.electron : ""})`);
})().catch((cause) => { console.error(cause); process.exitCode = 1; });
