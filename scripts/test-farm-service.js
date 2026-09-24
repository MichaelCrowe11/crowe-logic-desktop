"use strict";

// Node 22.13+ or ELECTRON_RUN_AS_NODE=1 <development electron> this-file.
// No main.js, installed profile, network, native addon, or dependency install.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { FarmService } = require("../farm/service");
const { MAX_BACKUP_BYTES, MAX_PAYLOAD_BYTES } = require("../farm/validation");

let checks = 0;
async function test(name, run) { await run(); checks++; console.log("ok - " + name); }
const rejects = (promise, code) => assert.rejects(promise, (cause) => cause.code === code);
const tick = () => new Promise((resolve) => setImmediate(resolve));
class FakeWorker extends EventEmitter {
  constructor() { super(); this.messages = []; this.terminated = 0; }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated++; this.emit("exit", 1); return Promise.resolve(1); }
  answer(data, ok = true) {
    const request = this.messages.findLast((message) => message.type === "request");
    this.emit("message", { type: "result", id: request.id, ok, ...(ok ? { data } : { error: data }) });
  }
}
function fake(options = {}) {
  const worker = new FakeWorker();
  let spawned = 0;
  const service = new FarmService({ filename: path.join(os.tmpdir(), "not-opened-farm.db"),
    startupTimeoutMs: 1000, requestTimeoutMs: 1000, closeTimeoutMs: 1000,
    ...options, workerFactory: (filename, config) => {
      assert.equal(path.basename(filename), "worker.js");
      assert.deepEqual(config.execArgv, []);
      assert.deepEqual(config.env, {});
      spawned++;
      return worker;
    } });
  return { service, worker, spawned: () => spawned };
}
async function graceful(service, worker) {
  const closing = service.close();
  assert.equal(worker.messages.at(-1).type, "close");
  worker.emit("message", { type: "closed" });
  worker.emit("exit", 0);
  await closing;
}

async function mocks() {
  await test("lazy worker, clean launch flags, FIFO, cloned arguments, data/reject API", async () => {
    const { service, worker, spawned } = fake();
    assert.equal(spawned(), 0);
    const payload = { room: "A" };
    const one = service.request("lot.correct", payload);
    payload.room = "MUTATED";
    const two = service.request("snapshot");
    assert.equal(spawned(), 1);
    assert.equal(worker.messages.length, 0);
    worker.emit("message", { type: "ready" });
    assert.equal(worker.messages.length, 1);
    assert.equal(worker.messages[0].payload.room, "A");
    worker.answer({ id: "lot-1" });
    assert.deepEqual(await one, { id: "lot-1" });
    assert.equal(worker.messages.length, 2);
    const failed = rejects(two, "CORRUPT_STORE");
    worker.answer({ code: "CORRUPT_STORE", message: "Stored data is invalid." }, false);
    await failed;
    const three = service.request("snapshot");
    worker.answer({ lots: [] });
    assert.deepEqual(await three, { lots: [] });
    await graceful(service, worker);
    await rejects(service.request("snapshot"), "FARM_CLOSED");
  });
  await test("unknown actions and invalid JSON do not start storage", async () => {
    const { service, spawned } = fake();
    await rejects(service.request("sql", {}), "UNKNOWN_ACTION");
    await rejects(service.request("snapshot", { a: NaN }), "VALIDATION");
    await rejects(service.request("snapshot", { a: "x".repeat(MAX_PAYLOAD_BYTES) }), "VALIDATION");
    await rejects(service.request("backup.restore", { backup: "x".repeat(MAX_BACKUP_BYTES) }), "VALIDATION");
    const circular = {}; circular.circular = circular;
    await rejects(service.request("snapshot", circular), "VALIDATION");
    assert.equal(spawned(), 0);
    await service.close();
  });
  await test("startup exception rejects all requests without claiming a write happened", async () => {
    const service = new FarmService({ filename: path.join(os.tmpdir(), "not-opened.db"), workerFactory: () => { throw new Error("private"); } });
    await rejects(service.request("lot.create"), "FARM_INIT_FAILED");
    await rejects(service.request("snapshot"), "FARM_INIT_FAILED");
    await service.close();
  });
  await test("startup failure is terminal and preserves domain error", async () => {
    const { service, worker, spawned } = fake();
    const first = rejects(service.request("lot.create"), "CORRUPT_STORE");
    const second = rejects(service.request("snapshot"), "CORRUPT_STORE");
    worker.emit("message", { type: "init-error", error: { code: "CORRUPT_STORE", message: "Unsupported schema." } });
    await Promise.all([first, second]);
    await rejects(service.request("snapshot"), "CORRUPT_STORE");
    assert.equal(spawned(), 1);
    await service.close();
  });
  await test("lost write reply is unknown, queued writes fail explicitly, no respawn", async () => {
    const { service, worker, spawned } = fake();
    const active = rejects(service.request("shipment.create"), "WRITE_OUTCOME_UNKNOWN");
    const queued = rejects(service.request("lot.create"), "FARM_WORKER_CRASH");
    worker.emit("message", { type: "ready" });
    worker.emit("error", new Error("private native path"));
    await Promise.all([active, queued]);
    await rejects(service.request("snapshot"), "FARM_WORKER_CRASH");
    assert.equal(worker.messages.length, 1);
    assert.equal(spawned(), 1);
    assert.equal(worker.terminated, 1);
    await service.close();
  });
  await test("read crashes and unexpected zero exit are failures, not empty data", async () => {
    const { service, worker } = fake();
    const pending = rejects(service.request("snapshot"), "FARM_WORKER_CRASH");
    worker.emit("message", { type: "ready" });
    worker.emit("exit", 0);
    await pending;
    await service.close();
  });
  await test("startup and request deadlines fail terminally", async () => {
    const a = fake({ startupTimeoutMs: 15 });
    await rejects(a.service.request("lot.create"), "FARM_INIT_TIMEOUT");
    await a.service.close();
    const b = fake({ requestTimeoutMs: 15 });
    const write = rejects(b.service.request("facility.save"), "WRITE_OUTCOME_UNKNOWN");
    b.worker.emit("message", { type: "ready" });
    await write;
    await rejects(b.service.request("snapshot"), "FARM_REQUEST_TIMEOUT");
    await b.service.close();
  });
  await test("malformed worker response fails active writes as unknown", async () => {
    const { service, worker } = fake();
    const write = rejects(service.request("lot.correct"), "WRITE_OUTCOME_UNKNOWN");
    worker.emit("message", { type: "ready" });
    worker.emit("message", { type: "result", id: 999, ok: true });
    await write;
    await rejects(service.request("snapshot"), "FARM_PROTOCOL_ERROR");
    await service.close();
  });
  await test("close drains accepted work and waits for worker exit", async () => {
    const { service, worker } = fake();
    const pending = service.request("snapshot");
    const closing = service.close();
    assert.equal(closing, service.close());
    await rejects(service.request("snapshot"), "FARM_CLOSED");
    worker.emit("message", { type: "ready" });
    worker.answer({ lots: [] });
    await pending;
    assert.equal(worker.messages.at(-1).type, "close");
    let finished = false;
    closing.then(() => { finished = true; });
    worker.emit("message", { type: "closed" });
    await tick();
    assert.equal(finished, false);
    worker.emit("exit", 0);
    await closing;
    assert.equal(finished, true);
  });
  await test("bounded shutdown marks unfinished write unknown and terminates", async () => {
    const { service, worker } = fake({ closeTimeoutMs: 15 });
    const pending = rejects(service.request("lot.adopt"), "WRITE_OUTCOME_UNKNOWN");
    worker.emit("message", { type: "ready" });
    await service.close();
    await pending;
    assert.equal(worker.terminated, 1);
    await rejects(service.request("snapshot"), "FARM_CLOSE_TIMEOUT");
  });
  await test("queue capacity refuses excess work without dropping accepted requests", async () => {
    const { service, worker } = fake({ maxPending: 1 });
    const pending = service.request("snapshot");
    await rejects(service.request("snapshot"), "FARM_BUSY");
    worker.emit("message", { type: "ready" });
    worker.answer({ lots: [] });
    await pending;
    await graceful(service, worker);
  });
}

async function realWorkers() {
  // Absence is an explicit failing/deferred gate, never a silently green skip.
  assert(fs.existsSync(path.join(__dirname, "../farm/store.js")), "DEFERRED: farm/store.js is not ready; real-worker acceptance must be rerun.");
  require("node:sqlite");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-farm-service-"));
  const open = new Set();
  const make = (filename) => { const s = new FarmService({ filename }); open.add(s); return s; };
  const stop = async (s) => { await s.close(); open.delete(s); };
  try {
    await test("real worker creates SQLite, survives restart, preserves correction and shipment snapshots", async () => {
      const filename = path.join(root, "userData", "farm-compliance", "farm.db");
      let service = make(filename);
      assert.equal(fs.existsSync(filename), false);
      let snapshot = await service.request("snapshot");
      assert.deepEqual(snapshot.lots, []);
      assert.equal(snapshot.storage.kind, "desktop-local");
      const source = { id: "flush_1", block: "ambiguous name", date: "2026-09-22", weight: 12.345, notes: " original ", createdAt: 12345 };
      const lot = await service.request("lot.adopt", { sourceId: "legacy-flush:flush_1", sourceSnapshot: source,
        harvestDate: "2026-09-22", room: "Room A", species: "Oyster", quantityLbs: "12.345", notes: "owner reviewed" });
      assert.deepEqual(lot.sourceSnapshot, source);
      assert.deepEqual(lot.sourceReviewedBy, snapshot.storage.operator);
      assert(lot.sourceApprovedAt && lot.sourceHash);
      const customer = await service.request("customer.create", { name: "Fixture Restaurant" });
      const shipment = await service.request("shipment.create", { requestId: "fixture-shipment-1", customerId: customer.id,
        shippedAt: "2026-09-23T12:00:00.000Z", items: [{ lotId: lot.id, quantityLbs: "2.345" }] });
      assert.deepEqual(shipment.items[0].lotSnapshot.sourceSnapshot, source);
      const corrected = await service.request("lot.correct", { id: lot.id, expectedVersion: lot.version, reason: "Correct room entry", room: "Room B" });
      assert.equal(corrected.room, "Room B");
      assert.equal(corrected.version, lot.version + 1);
      assert.equal(corrected.corrections.length, 1);
      assert.deepEqual(corrected.sourceSnapshot, source);
      const recall = await service.request("recall", { lotId: lot.id });
      assert.equal(recall.totalShippedLbs, "2.345");
      assert.equal(recall.remainingLbs, "10.000");
      assert.equal(recall.affectedShipments[0].lotSnapshot.room, "Room A");
      const attempts = await Promise.allSettled([
        service.request("lot.adopt", { sourceId: lot.sourceId, sourceSnapshot: source, harvestDate: "2026-09-22", room: "X", species: "Oyster", quantityLbs: "1.000" }),
        service.request("lot.adopt", { sourceId: lot.sourceId, sourceSnapshot: source, harvestDate: "2026-09-22", room: "X", species: "Oyster", quantityLbs: "1.000" }),
      ]);
      assert(attempts.every((r) => r.status === "rejected" && r.reason.code === "DUPLICATE_SOURCE"));
      snapshot = await service.request("snapshot");
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(path.dirname(filename)).mode & 0o777, 0o700);
        for (const suffix of ["", "-wal", "-shm"]) {
          assert.equal(fs.statSync(filename + suffix).mode & 0o777, 0o600);
        }
      }
      await stop(service);
      service = make(filename);
      const reopened = await service.request("snapshot");
      assert.deepEqual(reopened.lots, snapshot.lots);
      assert.deepEqual(reopened.shipments, snapshot.shipments);
      const backup = await service.request("backup.export");
      const target = make(path.join(root, "restored", "farm.db"));
      await target.request("backup.restore", { backup, confirmation: "RESTORE EMPTY FARM" });
      const restored = await target.request("snapshot");
      assert.deepEqual(restored.lots, reopened.lots);
      assert.deepEqual(restored.shipments, reopened.shipments);
      await stop(target);
      await stop(service);
    });
    await test("real worker refuses invalid database and remains terminal", async () => {
      const filename = path.join(root, "corrupt", "farm.db");
      fs.mkdirSync(path.dirname(filename));
      fs.writeFileSync(filename, "this is not SQLite");
      const service = make(filename);
      await assert.rejects(service.request("snapshot"));
      assert.equal(service.state, "faulted");
      await assert.rejects(service.request("snapshot"));
      await stop(service);
      assert.equal(fs.readFileSync(filename, "utf8"), "this is not SQLite");
    });
    await test("real worker refuses linked database paths without changing targets", async () => {
      const target = path.join(root, "link-target");
      fs.writeFileSync(target, "preserve");
      const filename = path.join(root, "linked", "farm.db");
      fs.mkdirSync(path.dirname(filename));
      fs.symlinkSync(target, filename);
      const service = make(filename);
      await rejects(service.request("snapshot"), "FARM_STORAGE_PATH");
      await stop(service);
      assert.equal(fs.readFileSync(target, "utf8"), "preserve");
    });
  } finally {
    await Promise.all([...open].map((s) => s.close()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  await mocks();
  await realWorkers();
  console.log(`farm-service: ${checks} groups passed (${process.version}${process.versions.electron ? ", Electron " + process.versions.electron : ""})`);
})().catch((cause) => { console.error(cause); process.exitCode = 1; });
