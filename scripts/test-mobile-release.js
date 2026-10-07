"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { verifyMetadata } = require("../mobile/scripts/verify-android-artifacts");
const valid = "package: name='com.crowelogic.mobile' versionCode='2616' versionName='0.26.16'\nsdkVersion:'24'\ntargetSdkVersion:'36'\n";
test("accepts the expected release APK metadata", () => assert.equal(verifyMetadata(valid, "0.26.16").build, 2616));
test("rejects stale versions, a wrong package, a debug build and stale SDK targets", () => {
  for (const bad of [valid.replace("2616", "2615"), valid.replace("0.26.16", "0.26.15"), valid.replace("com.crowelogic.mobile", "com.example.app"), valid + "application-debuggable\n", valid.replace("'36'", "'35'"), ""]) {
    assert.throws(() => verifyMetadata(bad, "0.26.16"));
  }
});
