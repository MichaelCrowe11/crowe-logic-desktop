"use strict";

// Synthetic profiles, native-dialog stubs and the real pending-state helper.
// No Electron process, network, actual home/profile or credential access.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createTransferHost } = require("../farm/transfer-host");
const notebook = require("../grow-transfer");
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "crowe-transfer-host-fixture-"));
let counter = 0, checks = 0;
const profile = () => { const dir = path.join(root, String(++counter)); fs.mkdirSync(dir); return dir; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const rejected = (result, code) => { assert.equal(result.ok, false, JSON.stringify(result)); if (code) assert.equal(result.error.code, code); return result.error; };
const source = { edition: "desktop", version: "fixture" };
const recoverySource = fs.readFileSync(path.join(__dirname, "../renderer/farm-recovery.js"), "utf8");
function loadHost({ fileSystem = fsp, notebookApi = notebook } = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../farm/transfer-host.js"), "utf8"), {
    module, exports: module.exports, Buffer, setTimeout, clearTimeout, Object,
    require: name => name === "node:fs/promises" ? fileSystem : name === "../grow-transfer" ? notebookApi :
      name === "./ipc" ? require("../farm/ipc") : require(name),
  });
  return module.exports.createTransferHost;
}
function harness({ factory = createTransferHost, userData = profile(), exists = true, request, importAllowed = true } = {}) {
  const rows = new Map(), calls = [], farmCalls = [];
  const localStorage = { get length() { return rows.size; }, key: i => [...rows.keys()][i], getItem: key => rows.get(key) ?? null };
  const context = vm.createContext({ window: { localStorage } });
  vm.runInContext(recoverySource, context);
  const sender = new EventEmitter(), frame = {};
  let access = true, trust = true, hook = null;
  sender.executeJavaScript = async script => {
    calls.push(script.match(/r\.(acquire|inspect|release)\(/)[1]);
    if (hook) await hook(script);
    return vm.runInContext(script, context);
  };
  const event = { sender, senderFrame: frame };
  const dialog = { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) };
  const host = factory({ dialog, getWindow: () => ({ webContents: sender }), getUserData: () => userData,
    isTrustedSender: e => trust && e.sender === sender && e.senderFrame === frame,
    canAccess: () => access, canImport: () => importAllowed, source: () => source, farmExists: async () => exists,
    farmRequest: async (action, payload) => { farmCalls.push(action); return request ? request(action, payload) : { format: "fixture-backup" }; },
  });
  return { host, event, dialog, rows, calls, farmCalls, userData,
    helper: context.window.FarmRecovery, request: (action, payload = {}) => host.request(event, action, payload),
    hook: fn => { hook = fn; }, revoke: () => { access = false; }, distrust: () => { trust = false; },
    navigate: () => sender.emit("did-start-navigation", {}, "file:///fixture.html", false, true),
  };
}
const pending = operatorId => JSON.stringify({ schemaVersion: 1, operatorId, payload: {
  customerId: "c1", shippedAt: "2026-09-23T12:00:00.000Z", notes: "", requestId: "unchanged-id",
  items: [{ lotId: "l1", quantityLbs: "1.000" }],
} });
async function test(name, fn) { await fn(); checks++; console.log("ok - " + name); }
async function main() {
  const original = profile(); fs.mkdirSync(path.join(original, "grow"));
  const raw = ' [ {"id":"harvest-stable", "weight":5.123, "extension":{"unchanged":true}} ]\r\n';
  fs.writeFileSync(path.join(original, "grow", "flushes.json"), raw);
  const archive = await notebook.createArchive({ userData: original, source });
  const archiveFile = path.join(root, "archive.json"); fs.writeFileSync(archiveFile, JSON.stringify(archive));
  const preview = async h => {
    h.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archiveFile] });
    const result = await h.request("notebook.preview"); assert.equal(result.ok, true, JSON.stringify(result)); return result.data.token;
  };
  const importPayload = token => ({ token, confirmation: "IMPORT EMPTY NOTEBOOK" });

  await test("lease is synchronous, drains admitted work, rejects competitors and releases on cancel", async () => {
    const h = harness(), slow = deferred(); let began = false;
    const first = h.host.runFarm(h.event, "snapshot", async () => { began = true; return slow.promise; });
    await tick(); assert(began);
    const exporting = h.request("farm.export");
    assert(h.host.busy);
    await assert.rejects(h.host.runFarm(h.event, "lot.create", () => assert.fail("queued competitor")), { code: "TRANSFER_BUSY" });
    rejected(await h.request("notebook.export"), "TRANSFER_BUSY");
    await tick(); assert(h.helper.isLocked()); assert.equal(h.farmCalls.length, 0);
    slow.resolve({}); await first;
    assert.equal((await exporting).data.canceled, true);
    assert.equal(h.host.busy, false); assert.equal(h.helper.isLocked(), false);
    assert.deepEqual(h.calls, ["acquire", "inspect", "inspect", "inspect", "release"]);
  });
  await test("pending namespace, corruption, foreign/multiple intents and memory blockers fail closed", async () => {
    const samples = [
      [["crowe.farm.pending-shipment.v1:foreign", pending("foreign")]],
      [["crowe.farm.pending-shipment.v1:o", "{"]],
      [["crowe.farm.pending-shipment.v1:a", pending("a")], ["crowe.farm.pending-shipment.v1:b", pending("b")]],
    ];
    for (const sample of samples) {
      const h = harness(); for (const [key, value] of sample) h.rows.set(key, value);
      const before = [...h.rows];
      rejected(await h.request("farm.export"), "RECOVERY_REQUIRED");
      await assert.rejects(h.host.runFarm(h.event, "backup.restore", () => assert.fail("restore passed pending")), { code: "RECOVERY_REQUIRED" });
      assert.deepEqual([...h.rows], before); assert.equal(h.farmCalls.length, 0); assert.equal(h.helper.isLocked(), false);
    }
    const memory = harness(); memory.helper.registerBlocker(() => "Unresolved write outcome");
    rejected(await memory.request("notebook.preview"), "RECOVERY_REQUIRED");
    const inaccessible = harness(); inaccessible.rows.set("crowe.farm.pending-shipment.v1:o", pending("o"));
    inaccessible.rows.get = () => { throw Error("denied storage"); };
    rejected(await inaccessible.request("farm.export"), "RECOVERY_REQUIRED");
  });
  await test("recovery rechecked after native dialogs and no file published on changed pending state", async () => {
    const h = harness(), target = path.join(root, "must-not-export.json");
    h.dialog.showSaveDialog = async () => {
      assert(h.helper.isLocked()); assert.throws(() => h.helper.assertUnlocked(), { code: "TRANSFER_BUSY" });
      h.rows.set("crowe.farm.pending-shipment.v1:o", pending("o"));
      return { canceled: false, filePath: target };
    };
    rejected(await h.request("farm.export"), "RECOVERY_REQUIRED"); assert(!fs.existsSync(target));
    assert.equal(h.rows.get("crowe.farm.pending-shipment.v1:o"), pending("o"));
  });
  await test("absent ledger is not opened or created solely for export", async () => {
    const h = harness({ exists: false }); rejected(await h.request("farm.export"), "FARM_NOT_FOUND");
    assert.equal(h.farmCalls.length, 0); assert.deepEqual(fs.readdirSync(h.userData), []);
  });
  await test("export publishes complete private archive without replacing any destination", async () => {
    const h = harness({ userData: original }), target = path.join(root, "exported-notebook.json");
    h.dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    const result = await h.request("notebook.export"); assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.status, "exported"); assert.equal(result.data.verified, true);
    const exported = notebook.validateArchive(fs.readFileSync(target)); assert.equal(exported.slots.flushes.text, raw);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    const before = fs.readFileSync(target);
    rejected(await h.request("notebook.export"), "TRANSFER_DESTINATION_EXISTS"); assert.deepEqual(fs.readFileSync(target), before);
    h.dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(original, "forbidden.json") });
    rejected(await h.request("notebook.export"), "TRANSFER_DESTINATION");
    const alias = path.join(root, "profile-alias"); fs.symlinkSync(original, alias);
    h.dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(alias, "forbidden.json") });
    rejected(await h.request("notebook.export"), "TRANSFER_DESTINATION");
    assert.equal(fs.readFileSync(path.join(original, "grow", "flushes.json"), "utf8"), raw);
    assert(!fs.readdirSync(root).some(name => name.startsWith(".crowe-export-")));
  });
  await test("preview is immutable, token/document bound, and repeat import verifies exact content", async () => {
    const h = harness(), token = await preview(h);
    rejected(await h.request("notebook.import", importPayload("wrong")), "TRANSFER_CONFIRMATION");
    rejected(await h.request("notebook.import", { token, confirmation: "wrong" }), "TRANSFER_CONFIRMATION");
    fs.writeFileSync(archiveFile, "malformed replacement after preview");
    const result = await h.request("notebook.import", importPayload(token));
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.data.status, "committed");
    assert.equal(fs.readFileSync(path.join(h.userData, "grow", "flushes.json"), "utf8"), raw);
    assert.equal((await h.request("notebook.import", importPayload(token))).data.status, "already-imported");
    fs.writeFileSync(archiveFile, JSON.stringify(archive));
    const restarted = harness({ userData: h.userData }), freshToken = await preview(restarted);
    assert.equal((await restarted.request("notebook.import", importPayload(freshToken))).data.status, "already-imported");
    assert(!fs.existsSync(path.join(h.userData, "farm-compliance")));
    h.navigate(); rejected(await h.request("notebook.import", importPayload(token)), "TRANSFER_CONFIRMATION");
  });
  await test("read rejects symlink, oversize and corrupt archives without destination writes", async () => {
    const files = [path.join(root, "bad.json"), path.join(root, "link.json"), path.join(root, "oversize.json")];
    fs.writeFileSync(files[0], "{"); fs.symlinkSync(archiveFile, files[1]); fs.writeFileSync(files[2], ""); fs.truncateSync(files[2], notebook.MAX_ARCHIVE_BYTES + 1);
    const archiveDirectoryAlias = path.join(root, "archive-directory-alias"); fs.symlinkSync(root, archiveDirectoryAlias);
    files.push(path.join(archiveDirectoryAlias, "archive.json"));
    for (const file of files) {
      const h = harness(); h.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      rejected(await h.request("notebook.preview")); assert.deepEqual(fs.readdirSync(h.userData), []);
    }
  });
  await test("trust denied at admission, after dialog and during release never returns preview data", async () => {
    const denied = harness(); denied.distrust(); rejected(await denied.request("farm.export"), "UNAVAILABLE"); assert.equal(denied.calls.length, 0);
    for (const phase of ["dialog", "release"]) {
      const h = harness();
      h.dialog.showOpenDialog = async () => { if (phase === "dialog") h.navigate(); return { canceled: false, filePaths: [archiveFile] }; };
      if (phase === "release") h.hook(script => { if (script.includes("r.release(")) h.navigate(); });
      const result = await h.request("notebook.preview"); rejected(result, "UNAVAILABLE"); assert(!result.data); assert.equal(h.host.busy, false);
    }
  });
  await test("navigation after commit preserves outcome and skips release in replacement document", async () => {
    let h;
    const api = { ...notebook, importArchive: async args => { const result = await notebook.importArchive(args); h.navigate(); return result; } };
    h = harness({ factory: loadHost({ notebookApi: api }) });
    const token = await preview(h); h.calls.length = 0;
    const error = rejected(await h.request("notebook.import", importPayload(token)), "UNAVAILABLE");
    assert.equal(error.state, "recovery-required"); assert.equal(error.committed, true);
    assert(!h.calls.includes("release"));
    assert.equal(fs.readFileSync(path.join(h.userData, "grow", "flushes.json"), "utf8"), raw);
    const restored = harness(); restored.hook(script => { if (script.includes("r.release(")) restored.navigate(); });
    await assert.rejects(restored.host.runFarm(restored.event, "backup.restore", async () => ({ restored: true })),
      error => error.state === "recovery-required" && error.committed === true);
  });
  await test("missing helper aborts before storage and selected-file reads are followed by recovery inspection", async () => {
    const missing = harness(); missing.event.sender.executeJavaScript = async () => undefined;
    rejected(await missing.request("farm.export"), "RECOVERY_REQUIRED"); assert.equal(missing.farmCalls.length, 0);
    let h;
    const fileSystem = { ...fsp, open: async (...args) => {
      const handle = await fsp.open(...args);
      if (args[0] === archiveFile) {
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); h.rows.set("crowe.farm.pending-shipment.v1:o", pending("o")); };
      }
      return handle;
    } };
    h = harness({ factory: loadHost({ fileSystem }) });
    h.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archiveFile] });
    rejected(await h.request("notebook.preview"), "RECOVERY_REQUIRED"); assert.deepEqual(fs.readdirSync(h.userData), []);
  });
  await test("drain keeps admission closed until revocation completes and returns callback data", async () => {
    const h = harness(), slow = deferred(), revoke = deferred();
    const write = h.host.runFarm(h.event, "lot.create", () => slow.promise); await tick();
    let callback = false;
    const draining = h.host.drain(h.event, async () => { callback = true; await revoke.promise; h.revoke(); return { revoked: true }; });
    assert(h.host.busy); await tick(); assert.equal(callback, false);
    await assert.rejects(h.host.runFarm(h.event, "snapshot", () => ({})), { code: "TRANSFER_BUSY" });
    rejected(await h.request("farm.export"), "TRANSFER_BUSY");
    slow.resolve({}); await write; await tick(); assert(callback); assert(h.host.busy);
    revoke.resolve(); assert.deepEqual(await draining, { revoked: true }); assert.equal(h.host.busy, false);
    rejected(await h.request("farm.export"), "UNAVAILABLE");
  });
  await test("restore verification failure preserves committed state and lost reply remains uncertain", async () => {
    const h = harness({ request: async () => { throw Object.assign(Error("verification unavailable"), { code: "FARM_UNAVAILABLE" }); } });
    await assert.rejects(h.host.runFarm(h.event, "backup.restore", async () => ({ restored: true })), error => error.state === "recovery-required" && error.committed === true);
    assert.equal(h.host.busy, false); assert.equal(h.helper.isLocked(), false);
    const lost = harness();
    await assert.rejects(lost.host.runFarm(lost.event, "backup.restore", async () => { throw Object.assign(Error("reply lost"), { code: "WRITE_OUTCOME_UNKNOWN" }); }), error => error.state === "recovery-required" && !Object.hasOwn(error, "committed"));
  });
  await test("notebook postcommit errors retain recovery state and committed marker", async () => {
    const h = harness({ factory: loadHost({ notebookApi: { ...notebook, importArchive: async () => { throw Object.assign(Error("receipt failure"), { code: "GROW_RECOVERY_REQUIRED", state: "recovery-required", committed: true }); } } }) });
    const token = await preview(h);
    const error = rejected(await h.request("notebook.import", importPayload(token)), "GROW_RECOVERY_REQUIRED");
    assert.equal(error.state, "recovery-required"); assert.equal(error.committed, true); assert.equal(h.host.busy, false);
  });
  await test("published export followed by directory sync failure is not reported as uncommitted", async () => {
    let syncs = 0;
    const factory = loadHost({ fileSystem: { ...fsp, open: async (...args) => {
      const handle = await fsp.open(...args);
      if (args[0] === root) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { if (++syncs === 2) throw Object.assign(Error("injected"), { code: "EIO" }); return sync(); };
      }
      return handle;
    } } });
    const h = harness({ factory }), target = path.join(root, "published-unverified.json");
    h.dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    const error = rejected(await h.request("farm.export"), "EXPORT_VERIFICATION_REQUIRED");
    assert.equal(error.committed, true); assert.equal(error.state, "recovery-required"); assert(fs.existsSync(target));
  });
  await test("native IO failures are redacted and request payload cannot select paths or invoke getters", async () => {
    const h = harness(); h.dialog.showSaveDialog = async () => { throw Object.assign(Error("/private/customer/path"), { code: "EROFS" }); };
    const error = rejected(await h.request("farm.export"), "TRANSFER_IO"); assert(!error.message.includes("/private"));
    rejected(await h.request("farm.export", { filename: "/arbitrary" }), "VALIDATION");
    rejected(await h.request("constructor"), "VALIDATION");
    const payload = {}; Object.defineProperty(payload, "token", { enumerable: true, get: () => assert.fail("getter called") });
    rejected(await h.request("notebook.import", payload), "VALIDATION");
    rejected(await harness({ importAllowed: false }).request("notebook.preview"), "UNAVAILABLE");
  });
  await test("close is idempotent, closes admission immediately, and waits for admitted work/transfer", async () => {
    const h = harness(), write = deferred();
    const active = h.host.runFarm(h.event, "shipment.create", () => write.promise); await tick();
    const closing = h.host.close(); assert.equal(h.host.close(), closing); let done = false; closing.then(() => { done = true; });
    await tick(); assert.equal(done, false); rejected(await h.request("farm.export"), "TRANSFER_CLOSED");
    write.resolve({}); await active; await closing; assert(done);
    const transferring = harness(), dialog = deferred();
    transferring.dialog.showSaveDialog = () => dialog.promise;
    const exporting = transferring.request("farm.export"); await tick();
    const closeTransfer = transferring.host.close(); let settled = false; closeTransfer.then(() => { settled = true; });
    await tick(); assert.equal(settled, false);
    dialog.resolve({ canceled: true }); rejected(await exporting, "TRANSFER_CLOSED"); await closeTransfer; assert(settled);
  });
  console.log(`transfer-host: ${checks} groups passed (${process.version})`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  // This process created this entire root, including all symlinks, above.
  fs.rmSync(root, { recursive: true, force: true });
});
