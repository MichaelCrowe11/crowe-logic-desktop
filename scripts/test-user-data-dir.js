#!/usr/bin/env node
/* --user-data-dir must keep moving a launch onto the profile it names.

     npx electron scripts/test-user-data-dir.js

   scripts/smoke-packaged-mac.sh launches a packaged build with
   --user-data-dir=<throwaway> so the installed app's live profile is never
   opened. That is a Chromium switch Electron maps onto app.getPath("userData");
   nothing in this repo makes it so, and an Electron bump could quietly stop
   honouring it, at which point the smoke would land on the live profile beside
   the running app. (HOME= is what was tried first, on 2026-09-15, and it does
   nothing of the kind on macOS; it is not pinned here because a child launched
   without the switch would initialise the real profile just to answer.) A
   child Electron is started with the switch and asked where its profile is.
   Exit 1 if the answer is not the directory named. */
const { app } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

if (process.argv.includes("--probe")) {
  app.whenReady().then(() => { process.stdout.write(`PROBE ${app.getPath("userData")}|${app.getPath("sessionData")}\n`); app.exit(0); });
} else {
  const PARENT = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-udd-parent-"));
  app.setPath("userData", PARENT);
  app.setPath("sessionData", PARENT);
  const probe = (dir) => new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, "--probe", `--user-data-dir=${dir}`], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 20000);
    child.on("exit", () => { clearTimeout(timer); resolve((out.match(/^PROBE (.*)$/m) || [])[1] || ""); });
  });
  app.whenReady().then(async () => {
    let checks = 0, ok = false;
    const check = (cond, what) => { if (!cond) throw new Error(what); checks += 1; console.log(`  ok   ${what}`); };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-udd-"));
    try {
      const real = fs.realpathSync(dir);
      const [userData, sessionData] = (await probe(dir)).split("|");
      check(userData === real, `--user-data-dir moves userData onto the directory named (${userData})`);
      check(sessionData === real, "sessionData follows it");
      check(fs.readdirSync(dir).length > 0, `the named profile is the one that fills (${fs.readdirSync(dir).slice(0, 3).join(", ")})`);
      ok = true;
      console.log(`\nuser-data-dir: ${checks} checks passed`);
    } catch (e) {
      console.error("user-data-dir: FAIL", e && e.stack || e);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(PARENT, { recursive: true, force: true }); } catch {}
      setTimeout(() => app.exit(ok ? 0 : 1), 200);
    }
  });
}
