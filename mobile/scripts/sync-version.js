#!/usr/bin/env node
/* Carries mobile/package.json's version into the iOS project.
 *
 *   node mobile/scripts/sync-version.js            write it
 *   node mobile/scripts/sync-version.js --check    fail if it has drifted
 *
 * Android reads package.json directly from build.gradle, so it cannot drift.
 * Xcode cannot: MARKETING_VERSION and CURRENT_PROJECT_VERSION are build
 * settings inside project.pbxproj, which is why they sat at 0.23.0 and 1 while
 * everything else moved. This writes them, and --check is what stops the next
 * one being noticed by App Store Connect instead of by us.
 *
 * The build number is derived the same way Android derives versionCode
 * (major * 10000 + minor * 100 + patch), so the two stores never disagree about
 * which build a version is, and it only ever ascends. App Store Connect refuses
 * a build number it has already seen, and that refusal arrives after the upload
 * rather than before it.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const MOBILE = path.resolve(__dirname, "..");
const PBXPROJ = path.join(MOBILE, "ios/App/App.xcodeproj/project.pbxproj");
const CHECK = process.argv.includes("--check");

function derive(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) throw new Error(`version "${version}" is not a semver a build number can be derived from`);
  const [, major, minor, patch] = m.map(Number);
  if (minor > 99 || patch > 99) {
    throw new Error(`the build number carries minor and patch in two digits each; ${version} overflows it`);
  }
  return major * 10000 + minor * 100 + patch;
}

function main() {
  const version = require(path.join(MOBILE, "package.json")).version;
  const build = derive(version);
  const before = fs.readFileSync(PBXPROJ, "utf8");

  // Every configuration carries its own copy of both settings, so all of them
  // are rewritten. A build that is Debug-only correct is a build that ships
  // wrong exactly once.
  const after = before
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`);

  // Read out of `before`, not `after`. Reporting the rewritten buffer would
  // print the numbers we wanted next to the complaint that they are missing,
  // which reads as the check being broken rather than the project being stale.
  const found = (src, key) => [...new Set([...src.matchAll(new RegExp(`${key} = ([^;]+);`, "g"))].map((m) => m[1]))];
  const marketing = found(before, "MARKETING_VERSION");
  const current = found(before, "CURRENT_PROJECT_VERSION");
  if (!marketing.length || !current.length) {
    console.error("sync-version: found no MARKETING_VERSION/CURRENT_PROJECT_VERSION to write — has the project been regenerated?");
    return 1;
  }

  if (CHECK) {
    if (after === before) {
      console.log(`ok      ios carries ${version} (${build})`);
      return 0;
    }
    console.error(`the iOS project does not carry mobile/package.json's version.`);
    console.error(`  package.json wants: ${version}  (build ${build})`);
    console.error(`  project has:        MARKETING_VERSION ${marketing.join(", ")}, CURRENT_PROJECT_VERSION ${current.join(", ")}`);
    console.error("Run `node mobile/scripts/sync-version.js` and commit the result.");
    return 1;
  }

  if (after === before) {
    console.log(`ios already carries ${version} (${build})`);
    return 0;
  }
  fs.writeFileSync(PBXPROJ, after);
  console.log(`wrote ios MARKETING_VERSION ${version}, CURRENT_PROJECT_VERSION ${build} (${marketing.length} configuration(s))`);
  return 0;
}

process.exit(main());
