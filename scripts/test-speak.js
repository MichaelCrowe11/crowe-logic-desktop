"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync(require.resolve("../mobile/src/speak.js"), "utf8");
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const voices = () => ({ json: async () => ({ voices: [{ id: "voice" }], default: "voice" }) });
function fixture({ call, native, voice = "neural" } = {}) {
  const events = {}, audio = [], urls = [], revoked = [], messages = [];
  const btn = { classList: { toggle: (_key, v) => { btn.active = v; } }, setAttribute() {} };
  class Audio {
    constructor(src) { this.src = src; audio.push(this); }
    async play() { this.played = true; }
    pause() { this.paused = true; }
  }
  const window = { crowe: {}, croweCloud: { call }, addEventListener: (name, cb) => { events[name] = cb; } };
  if (native) window.Capacitor = { isNativePlatform: () => true, Plugins: { CroweVoice: native } };
  vm.runInNewContext(source, { window, AbortController, Audio,
    document: { getElementById: () => btn, querySelectorAll: () => [{ innerText: "A reply" }] },
    localStorage: { getItem: key => key === "crowe-reply-voice" ? voice : null },
    URL: { createObjectURL: () => { const url = `blob:${urls.length}`; urls.push(url); return url; }, revokeObjectURL: url => revoked.push(url) },
    setComposerStatus: value => messages.push(value),
  });
  return { btn, audio, urls, revoked, events, messages };
}
test("second tap aborts a pending voice lookup without billing speech", async () => {
  const held = deferred(), calls = [];
  const f = fixture({ call: (route, init) => { calls.push({ route, init }); return held.promise; } });
  const first = f.btn.onclick(); await f.btn.onclick();
  assert.equal(calls[0].init.signal.aborted, true);
  held.resolve(voices()); await first;
  assert.equal(calls.length, 1); assert.equal(f.audio.length, 0); assert.equal(f.btn.active, false);
});
test("stop during speech or blob loading prevents late playback and leaves a newer request alone", async () => {
  const speech = deferred(), blob = deferred(); let posts = 0;
  const f = fixture({ call: async route => route === "/v1/voices" ? voices() : (++posts === 1 ? speech.promise : { headers: { get: () => null }, blob: () => blob.promise }) });
  const first = f.btn.onclick(); await new Promise(setImmediate);
  await f.btn.onclick(); const second = f.btn.onclick(); await new Promise(setImmediate);
  speech.resolve({ headers: { get: () => null }, blob: async () => ({}) }); await first;
  assert.equal(f.btn.active, true); assert.equal(f.audio.length, 0);
  await f.btn.onclick(); blob.resolve({}); await second;
  assert.equal(f.audio.length, 0); assert.equal(f.urls.length, 0);
});
test("native fallback is stoppable before a speakState event arrives", async () => {
  let spoken = 0, stopped = 0;
  const native = { addListener() {}, speak: async () => { spoken++; }, stop: async () => { stopped++; } };
  const f = fixture({ voice: "phone", native, call: () => { throw new Error("Unexpected cloud call"); } });
  await f.btn.onclick(); assert.equal(f.btn.active, true);
  await f.btn.onclick(); assert.equal(spoken, 1); assert.equal(stopped, 1); assert.equal(f.btn.active, false);
});
test("page hide releases cloud audio and its object URL", async () => {
  const f = fixture({ call: async route => route === "/v1/voices" ? voices() : { headers: { get: () => null }, blob: async () => ({}) } });
  await f.btn.onclick(); f.events.pagehide();
  assert.equal(f.audio[0].paused, true); assert.deepEqual(f.revoked, f.urls); assert.equal(f.btn.active, false);
});
