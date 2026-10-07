const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../mobile/src/crowe-keyboard.js"), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function rig(overrides = {}) {
  const window = {}, handlers = new Map(), starts = [], stops = [], received = [], errors = [];
  const Speech = {
    addListener: async (name, fn) => { handlers.set(name, fn); return { remove: async () => { if (handlers.get(name) === fn) handlers.delete(name); } }; },
    requestPermissions: async () => ({ speechRecognition: "granted" }),
    available: async () => ({ available: true, sessionIds: true }),
    start: async opts => { starts.push(opts); },
    stop: async opts => { stops.push(opts); },
    ...overrides,
  };
  vm.runInNewContext(source, { window });
  const begin = () => window.croweKeyboard.captureSpeech(Speech, "terminal", { partial: d => received.push(d.matches[0]), stopped: () => {}, error: e => errors.push(e.message) });
  return { window, handlers, starts, stops, received, errors, begin };
}
test("permission cancellation never starts recognition and removes listeners", async () => {
  const permission = deferred(), r = rig({ requestPermissions: () => permission.promise });
  const capture = r.begin(); await flush();
  const stopped = capture.stop();
  assert.equal(r.begin(), null, "pending permission keeps exclusive ownership");
  permission.resolve({ speechRecognition: "granted" }); await stopped;
  assert.equal(r.starts.length, 0); assert.equal(r.handlers.size, 0); assert.equal(r.window.__croweSpeechOwner, null);
});
test("pending start is stopped before another surface may listen", async () => {
  const pending = deferred(); let didStart = false;
  const r = rig({ start: () => { didStart = true; return pending.promise; } });
  const capture = r.begin(); await flush(); assert.equal(didStart, true);
  const stopping = capture.stop(); assert.equal(r.begin(), null);
  pending.resolve(); await stopping;
  assert.equal(r.stops.length, 1); assert.equal(r.handlers.size, 0);
});
test("stale native events and removed callbacks cannot enter a later session", async () => {
  const r = rig(), a = r.begin(); await flush();
  const firstId = r.starts[0].sessionId, old = r.handlers.get("partialResults");
  await a.stop(); const b = r.begin(); await flush();
  const secondId = r.starts[1].sessionId;
  old({ sessionId: firstId, matches: ["old callback"] });
  r.handlers.get("partialResults")({ sessionId: firstId, matches: ["old native event"] });
  r.handlers.get("partialResults")({ sessionId: secondId, matches: ["current"] });
  assert.deepEqual(r.received, ["current"]); await b.stop();
});
test("untagged native implementations fail closed", async () => {
  const r = rig({ available: async () => ({ available: true }) }); r.begin(); await flush();
  assert.match(r.errors[0], /Update the iPhone app/); assert.equal(r.starts.length, 0);
  await flush(); assert.equal(r.handlers.size, 0); assert.equal(r.window.__croweSpeechOwner, null);
});
test("spoken commands cannot contain return or other terminal control bytes", () => {
  const r = rig();
  const text = r.window.croweKeyboard.forShell("Git status.\r\nrm -rf nowhere\x1b[A\u0085");
  assert.doesNotMatch(text, /[\x00-\x1f\x7f-\x9f]/);
  assert.equal(r.window.croweKeyboard.forShell("Git status."), "git status");
});
