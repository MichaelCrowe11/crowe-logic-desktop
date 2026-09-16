#!/usr/bin/env node
/* CROWE_TEST_PROFILE moves a launch onto a throwaway profile.

     npx electron scripts/test-profile-override.js

   The gate (resolveTestProfile: absolute, existing, inside the temp folder) is
   unit-tested in test-electron-security.js. This checks the wiring that only a
   launch can answer: main.js applies it at load, before anything reads a path,
   and the profile that fills at boot is the override.

   A fallback profile is set first, the way every other Electron test here sets
   its own. If the override ever failed, this run would land on that fallback,
   never on the installed app's profile, and the checks below would say so.
   Exit 1 on the first check that fails. */
const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const FALLBACK = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-profile-fallback-"));
const OVERRIDE = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-profile-override-"));
app.setPath("userData", FALLBACK);
app.setPath("sessionData", FALLBACK);
process.env.CROWE_TEST_PROFILE = OVERRIDE;

let checks = 0;
const check = (cond, what) => { if (!cond) throw new Error(what); checks += 1; console.log(`  ok   ${what}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = false;
const finish = () => {
  try { require(path.join(__dirname, "..", "main.js")).shutdownNativeResources(); } catch {}
  try { fs.rmSync(FALLBACK, { recursive: true, force: true }); fs.rmSync(OVERRIDE, { recursive: true, force: true }); } catch {}
  setTimeout(() => app.exit(ok ? 0 : 1), 300);
};

try {
  require(path.join(__dirname, "..", "main.js"));
  const real = fs.realpathSync(OVERRIDE);
  check(app.getPath("userData") === real, "userData follows CROWE_TEST_PROFILE as soon as main.js loads");
  check(app.getPath("sessionData") === real, "sessionData follows it too");
} catch (e) {
  console.error("profile override: FAIL", e && e.stack || e);
  app.whenReady().then(finish);
}

app.whenReady().then(async () => {
  if (checks < 2) return;
  try {
    await sleep(1500);
    const filled = fs.readdirSync(OVERRIDE);
    check(filled.length > 0, `the override profile fills at boot (${filled.slice(0, 4).join(", ")}${filled.length > 4 ? ", ..." : ""})`);
    check(fs.readdirSync(FALLBACK).length === 0, "nothing lands on the profile set before the override");
    ok = true;
    console.log(`\nprofile override: ${checks} checks passed`);
  } catch (e) {
    console.error("profile override: FAIL", e && e.stack || e);
  } finally { finish(); }
});
