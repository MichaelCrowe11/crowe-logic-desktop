#!/usr/bin/env node
"use strict";
// An unsigned PR artifact is packaging evidence only. Release verification
// requires signatures by default; CI must explicitly identify an unsigned run.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function verifyMetadata(badging, version) {
  const [major, minor, patch] = version.split(".").map(Number);
  const code = major * 10000 + minor * 100 + patch;
  const pkg = badging.match(/^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m);
  assert.ok(pkg, "APK package metadata is missing");
  assert.equal(pkg[1], "com.crowelogic.mobile", "APK belongs to another application");
  assert.equal(pkg[2], String(code), "APK build number is stale");
  assert.equal(pkg[3], version, "APK version is stale");
  assert.equal(badging.match(/^sdkVersion:'(\d+)'/m)?.[1], "24", "Unexpected minimum Android SDK");
  assert.equal(badging.match(/^targetSdkVersion:'(\d+)'/m)?.[1], "36", "Unexpected target Android SDK");
  assert.doesNotMatch(badging, /^application-debuggable/m, "A debug APK cannot be a release artifact");
  return { bundleId: pkg[1], version, build: code, targetSdk: 36 };
}

function verifyBundleMetadata(bundle, apk) {
  assert.equal(bundle.bundleId, apk.bundleId, "AAB belongs to another application");
  assert.equal(String(bundle.build), String(apk.build), "AAB build number is stale");
  assert.equal(bundle.version, apk.version, "AAB version is stale");
}

function main() {
  const mobile = path.resolve(__dirname, "..");
  const version = require(path.join(mobile, "package.json")).version;
  const allowUnsigned = process.argv.includes("--allow-unsigned");
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  assert.ok(sdk, "ANDROID_HOME or ANDROID_SDK_ROOT is required");
  const buildTools = path.join(sdk, "build-tools", "36.0.0");
  const apkDir = path.join(mobile, "android/app/build/outputs/apk/release");
  const apks = fs.readdirSync(apkDir).filter(f => f.endsWith(".apk"));
  assert.equal(apks.length, 1, "Expected exactly one release APK");
  const apk = path.join(apkDir, apks[0]);
  const aab = path.join(mobile, "android/app/build/outputs/bundle/release/app-release.aab");
  const run = (exe, args) => execFileSync(exe, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const meta = verifyMetadata(run(path.join(buildTools, "aapt"), ["dump", "badging", apk]), version);
  assert.ok(fs.statSync(aab).size > 0, "Release bundle is empty");
  run("unzip", ["-t", aab]);
  const entries = run("unzip", ["-Z1", aab]);
  assert.match(entries, /^base\/manifest\/AndroidManifest\.xml$/m, "Bundle manifest is absent");
  const bundletool = process.env.BUNDLETOOL_JAR;
  assert.ok(bundletool && fs.existsSync(bundletool), "BUNDLETOOL_JAR must point to the verified bundletool jar");
  const attribute = name => run("java", ["-jar", bundletool, "dump", "manifest", `--bundle=${aab}`, `--xpath=/manifest/@${name}`]).trim();
  verifyBundleMetadata({ bundleId: attribute("package"), build: attribute("android:versionCode"), version: attribute("android:versionName") }, meta);
  if (!allowUnsigned) {
    run(path.join(buildTools, "apksigner"), ["verify", apk]);
    const signature = run("jarsigner", ["-J-Duser.language=en", "-verify", aab]);
    assert.match(signature, /jar verified\./i, "Release bundle is unsigned or its signature is invalid");
  }
  console.log(JSON.stringify({ ...meta, verification: allowUnsigned ? "packaging-only; signatures not verified" : "signed-artifacts", apk, aab }, null, 2));
}
if (require.main === module) {
  try { main(); } catch (error) { console.error("Android artifact verification failed:", error.message); process.exitCode = 1; }
}
module.exports = { verifyMetadata, verifyBundleMetadata };
