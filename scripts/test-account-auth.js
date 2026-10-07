"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

// Exercise the production auth handlers against an isolated fixture store.
// Never load Electron or the operator's real sign-in files for these checks.
const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const source = main.slice(main.indexOf('const CROWE_ID ='), main.indexOf('ipcMain.handle("crowe:auth:status"'));
function fixture(fetch) {
  let cfg = { token: "fixture-access", refreshToken: "fixture-refresh" }, reads = 0, stopped = 0;
  const handlers = {};
  const context = vm.createContext({
    fetch, Buffer, URL, URLSearchParams, AbortSignal, setTimeout,
    path, os: { homedir: () => "/isolated-fixture" },
    fs: { readFileSync: () => { reads++; return JSON.stringify({ access_token: "legacy-access", refresh_token: "legacy-refresh" }); } },
    loadConfig: () => ({ ...cfg }), saveConfig: patch => { cfg = { ...cfg, ...patch }; },
    configPath: () => "/isolated-fixture/config.json",
    ipcMain: { handle: (channel, handler) => { handlers[channel] = handler; } },
    stopAccountRuns: () => { stopped++; },
    browserSessions: { endAll: async () => {} },
  });
  vm.runInContext(source + "\nglobalThis.api = { refreshToken, migrateLegacyAuth, persistTokens };", context);
  return { ...context.api, logout: handlers["crowe:auth:logout"], config: () => cfg, reads: () => reads, stopped: () => stopped };
}

test("desktop sign-out survives restart without importing the CLI account", () => {
  const f = fixture(() => new Promise(() => {}));
  assert.equal(f.logout().ok, true);
  f.migrateLegacyAuth();
  assert.equal(f.config().token, "");
  assert.equal(f.config().refreshToken, "");
  assert.equal(f.reads(), 0);
  assert.equal(f.stopped(), 1);
  f.persistTokens({ access_token: "explicit-login", refresh_token: "new-refresh" });
  assert.equal(f.config().accountSignedOut, false);
});

test("concurrent desktop refreshes share a request and cannot undo sign-out", async () => {
  let resolveRefresh, requests = 0;
  const f = fixture(url => {
    if (url.endsWith("/revoke")) return new Promise(() => {});
    requests++;
    return new Promise(resolve => { resolveRefresh = resolve; });
  });
  const one = f.refreshToken(), two = f.refreshToken();
  assert.equal(requests, 1);
  f.logout();
  resolveRefresh({ json: async () => ({ access_token: "late-access", refresh_token: "late-refresh" }) });
  assert.deepEqual(await Promise.all([one, two]), [null, null]);
  assert.equal(f.config().token, "");
  assert.equal(f.config().accountSignedOut, true);
});
