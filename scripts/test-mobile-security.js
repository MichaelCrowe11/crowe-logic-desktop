#!/usr/bin/env node
"use strict";

// Launch gate for native credential storage and platform containment. These
// checks are intentionally source-level where the behavior belongs to Android
// or iOS, and executable where the JavaScript migration can be exercised.

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
let checks = 0;

async function check(name, fn) {
  try {
    await fn();
    checks += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${String(error.message || error)}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log("mobile security");

  await check("Android vault uses device-bound authenticated encryption", () => {
    const java = read("mobile/android/app/src/main/java/com/crowelogic/mobile/CroweVault.java");
    assert.match(java, /AndroidKeyStore/);
    assert.match(java, /AES\/GCM\/NoPadding/);
    assert.match(java, /setKeySize\(256\)/);
    assert.match(java, /updateAAD\(AAD\)/);
    assert.doesNotMatch(java, /getDefaultSharedPreferences/);
  });

  await check("Android release disables backup, broad file sharing and WebView debugging", () => {
    const manifest = read("mobile/android/app/src/main/AndroidManifest.xml");
    const paths = read("mobile/android/app/src/main/res/xml/file_paths.xml");
    const activity = read("mobile/android/app/src/main/java/com/crowelogic/mobile/MainActivity.java");
    const gradle = read("mobile/android/app/build.gradle");
    assert.match(manifest, /android:allowBackup="false"/);
    assert.doesNotMatch(paths, /<external-path\b/);
    assert.match(activity, /registerPlugin\(CroweVault\.class\)/);
    assert.match(activity, /setWebContentsDebuggingEnabled\(BuildConfig\.DEBUG\)/);
    assert.match(gradle, /minifyEnabled true/);
    assert.match(gradle, /shrinkResources true/);
  });

  await check("iOS vault remains device-only and restricts its record surface", () => {
    const swift = read("mobile/ios/App/App/CroweVault.swift");
    assert.match(swift, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
    assert.match(swift, /allowedKeys: Set<String> = \["config"\]/);
  });

  await check("OAuth callbacks require an exact scheme, host and path", () => {
    const bridge = read("mobile/src/mobile-bridge.js");
    assert.match(bridge, /callback\.protocol !== expected\.protocol/);
    assert.match(bridge, /callback\.hostname !== expected\.hostname/);
    assert.match(bridge, /callback\.pathname !== expected\.pathname/);
    assert.doesNotMatch(bridge, /url\.indexOf\(redirect\) !== 0/);
  });

  console.log(process.exitCode ? "\nmobile security checks failed" : `\nmobile-security: ${checks} checks passed`);
})();
