'use strict';

// The build number is written twice, in two languages, and nothing compares
// them. sync-version.js derives it in JavaScript for iOS; app/build.gradle
// derives it again in Groovy for Android. Both claim the same formula, and the
// commit that introduced them says the point is "so the two stores never
// disagree about which build a version is" - but that agreement is a comment,
// not a check. Change one multiplier and the stores silently disagree: Play
// takes 2400 while App Store Connect takes something else, and the first
// warning arrives after an upload.
//
// Groovy cannot run here (no JDK on the machine this was written on, and
// installing one costs 4-6GB against a disk that has a documented ENOSPC
// history), so this does not pretend to execute the Gradle half. It compares
// the arithmetic both sides are built from, and anchors that arithmetic to the
// build number the JavaScript side actually reports for the real version.
//
// What this proves: the two derivations use the same constants, and those
// constants produce the number iOS is really carrying.
// What it does NOT prove: that Gradle runs, or that Capacitor wires the value
// into the APK. Only an Android build shows that, and CI is where to do it -
// ubuntu runners already ship a JDK.

const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GRADLE = path.join(ROOT, 'mobile/android/app/build.gradle');
const SYNC = path.join(ROOT, 'mobile/scripts/sync-version.js');
const MOBILE_PKG = path.join(ROOT, 'mobile/package.json');

// Pull the numbers out of a source file rather than trusting a copy of them
// here. A third written-down copy of the formula would be one more thing that
// can drift, which is the failure under test.
function gradleConstants(src) {
  const code = /croweVersionCode\s*=\s*\S+\s*\*\s*(\d+)\s*\+\s*\w+\s*\*\s*(\d+)\s*\+/.exec(src);
  const guard = /croweMinor\s*>\s*(\d+)\s*\|\|\s*crowePatch\s*>\s*(\d+)/.exec(src);
  assert.ok(code, 'could not find the versionCode derivation in build.gradle - has it been rewritten?');
  assert.ok(guard, 'could not find the overflow guard in build.gradle - has it been rewritten?');
  return {
    major: Number(code[1]), minor: Number(code[2]),
    minorMax: Number(guard[1]), patchMax: Number(guard[2]),
  };
}

function jsConstants(src) {
  const code = /return\s+major\s*\*\s*(\d+)\s*\+\s*minor\s*\*\s*(\d+)\s*\+\s*patch/.exec(src);
  const guard = /minor\s*>\s*(\d+)\s*\|\|\s*patch\s*>\s*(\d+)/.exec(src);
  assert.ok(code, 'could not find the build-number derivation in sync-version.js - has it been rewritten?');
  assert.ok(guard, 'could not find the overflow guard in sync-version.js - has it been rewritten?');
  return {
    major: Number(code[1]), minor: Number(code[2]),
    minorMax: Number(guard[1]), patchMax: Number(guard[2]),
  };
}

const checks = [];
function check(name, fn) {
  try { fn(); checks.push(null); console.log(`ok      ${name}`); }
  catch (err) {
    checks.push(name);
    console.log(`not ok  ${name}`);
    String(err.message).split('\n').forEach((l) => console.log(`        ${l}`));
  }
}

const gradle = gradleConstants(fs.readFileSync(GRADLE, 'utf8'));
const js = jsConstants(fs.readFileSync(SYNC, 'utf8'));

check('Android and iOS derive the build number from the same multipliers', () => {
  assert.deepStrictEqual(
    { major: gradle.major, minor: gradle.minor },
    { major: js.major, minor: js.minor },
    `build.gradle uses major*${gradle.major} + minor*${gradle.minor}, `
    + `sync-version.js uses major*${js.major} + minor*${js.minor}. `
    + 'Whichever is right, the stores now disagree about which build a version is.',
  );
});

check('both guard the same overflow bound', () => {
  assert.deepStrictEqual(
    { minor: gradle.minorMax, patch: gradle.patchMax },
    { minor: js.minorMax, patch: js.patchMax },
    'the two overflow guards disagree, so a version one rejects the other would encode wrongly',
  );
});

check('the bound is exactly what the multipliers can carry', () => {
  // major*10000 + minor*100 + patch only ascends while minor and patch each
  // stay below the next column. A guard looser than the carry silently wraps
  // 0.100.0 into the same code as 1.0.0; tighter, and it rejects versions that
  // would have encoded fine.
  assert.strictEqual(js.major / js.minor, js.minor,
    `columns are ${js.major}/${js.minor}, which is not a consistent radix`);
  assert.strictEqual(js.minorMax, js.minor - 1,
    `guard allows minor up to ${js.minorMax} but the column carries at ${js.minor}`);
  assert.strictEqual(js.patchMax, js.minor - 1,
    `guard allows patch up to ${js.patchMax} but the column carries at ${js.minor}`);
});

check('the shared formula produces the build number iOS actually carries', () => {
  // Anchors the parsed constants to observed behaviour. Without this the test
  // is two regexes agreeing with each other and nothing else.
  const version = require(MOBILE_PKG).version;
  const [major, minor, patch] = version.split('.').map(Number);
  const expected = major * js.major + minor * js.minor + patch;
  const out = execFileSync(process.execPath, [SYNC, '--check'], { encoding: 'utf8' });
  const reported = /\((\d+)\)/.exec(out);
  assert.ok(reported, `sync-version.js --check did not report a build number:\n${out}`);
  assert.strictEqual(Number(reported[1]), expected,
    `the formula gives ${expected} for ${version}, but sync-version.js reports ${reported[1]}`);
});

check('the derivation ascends across every release that fits the guard', () => {
  // The property Play actually enforces: a later version must never produce a
  // code less than or equal to an earlier one.
  const derive = (a, b, c) => a * js.major + b * js.minor + c;
  const versions = [
    [0, 9, 9], [0, 10, 0], [0, 23, 9], [0, 24, 0], [0, 99, 99], [1, 0, 0], [1, 0, 1], [9, 99, 99],
  ];
  for (let i = 1; i < versions.length; i++) {
    const prev = derive(...versions[i - 1]);
    const next = derive(...versions[i]);
    assert.ok(next > prev,
      `${versions[i - 1].join('.')} -> ${versions[i].join('.')} gives ${prev} -> ${next}, which does not ascend`);
  }
  // And the template's versionCode 1, which the first upload had to clear.
  assert.ok(derive(0, 1, 0) > 1, 'the derivation must start above the Capacitor template 1');
});

const failed = checks.filter(Boolean).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
