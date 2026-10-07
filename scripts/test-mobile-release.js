"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { verifyMetadata, verifyBundleMetadata } = require("../mobile/scripts/verify-android-artifacts");
const valid = "package: name='com.crowelogic.mobile' versionCode='2616' versionName='0.26.16'\nsdkVersion:'24'\ntargetSdkVersion:'36'\n";
test("accepts the expected release APK metadata", () => assert.equal(verifyMetadata(valid, "0.26.16").build, 2616));
test("rejects stale versions, a wrong package, a debug build and stale SDK targets", () => {
  for (const bad of [valid.replace("2616", "2615"), valid.replace("0.26.16", "0.26.15"), valid.replace("com.crowelogic.mobile", "com.example.app"), valid + "application-debuggable\n", valid.replace("'36'", "'35'"), ""]) {
    assert.throws(() => verifyMetadata(bad, "0.26.16"));
  }
});
test("rejects a stale or different signed bundle beside the current APK", () => {
  const apk = verifyMetadata(valid, "0.26.16");
  verifyBundleMetadata({ bundleId: apk.bundleId, version: apk.version, build: "2616" }, apk);
  for (const change of [{ bundleId: "other.app" }, { build: "2615" }, { version: "0.26.15" }, { build: "" }]) {
    assert.throws(() => verifyBundleMetadata({ ...apk, ...change }, apk));
  }
});

test("phone CSP includes the checkout and speech origins without allowing arbitrary Workers", () => {
  const fs = require("node:fs"), path = require("node:path"), root = path.resolve(__dirname, "..");
  require("node:child_process").execFileSync(process.execPath, [path.join(root, "mobile/scripts/build-www.js")]);
  const html = fs.readFileSync(path.join(root, "mobile/www/index.html"), "utf8");
  const connect = html.match(/connect-src ([^;]+);/)[1].split(/\s+/);
  for (const [file, pattern] of [["mobile/src/mobile-bridge.js", /const CHECKOUT_URL = "([^"]+)"/], ["mobile/src/cloud-ai.js", /const BASE = "([^"]+)"/]]) {
    const origin = new URL(fs.readFileSync(path.join(root, file), "utf8").match(pattern)[1]).origin;
    assert.ok(connect.includes(origin));
  }
  assert.ok(!connect.includes("*") && !connect.some(value => value.includes("*.workers.dev")));
});
