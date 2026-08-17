#!/usr/bin/env node
// Every module the app requires at runtime has to be in the shipped bundle.
//
//   node scripts/test-packaging.js
//
// electron-builder's `files` is an allowlist, not a filter: a source file that
// is not named there simply is not copied, and nothing says so. The app builds
// clean, signs clean, notarizes clean, and then throws
// "Cannot find module './companion'" on the user's machine at startup — a
// failure that exists only in the packaged artifact and in no test that runs
// from the checkout, because from the checkout the file is right there.
//
// This walks the relative requires out of the main-process entry points and
// checks each one against the allowlist. It is deliberately not a build: a real
// electron-builder run takes minutes and needs signing identities, and the
// mistake being caught here is a missing line in package.json.

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const allow = pkg.build.files.filter((f) => !f.startsWith("!"));

let failures = 0;
function check(name, fn) {
  try {
    const detail = fn();
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${String(e.message || e).split("\n").join("\n       ")}`);
  }
}
function assert(cond, message) { if (!cond) throw new Error(message); }

// "renderer/**" covers renderer/anything; "main.js" covers only itself.
function covered(rel) {
  // electron-builder copies package.json into every build whether it is listed
  // or not — it is how the packaged app knows its own main and version.
  if (rel === "package.json") return true;
  return allow.some((pattern) => {
    if (pattern === rel) return true;
    const star = pattern.indexOf("/**");
    return star > 0 && rel.startsWith(pattern.slice(0, star + 1));
  });
}

/* Follows relative requires transitively: a file that is packaged but whose own
   dependency is not is the same crash one level further in. */
function requiresFrom(entry, seen = new Set()) {
  const abs = path.join(root, entry);
  if (seen.has(entry) || !fs.existsSync(abs)) return seen;
  seen.add(entry);
  const src = fs.readFileSync(abs, "utf8");
  for (const m of src.matchAll(/require\(\s*["'](\.[^"']+)["']\s*\)/g)) {
    let rel = path.normalize(path.join(path.dirname(entry), m[1]));
    if (!fs.existsSync(path.join(root, rel)) && fs.existsSync(path.join(root, `${rel}.js`))) rel = `${rel}.js`;
    requiresFrom(rel, seen);
  }
  return seen;
}

console.log("packaging");

check("every module reachable from main.js is in the files allowlist", () => {
  const reachable = [...requiresFrom(pkg.main)];
  const missing = reachable.filter((f) => !covered(f));
  assert(!missing.length,
    `these would be left out of the build and crash it at startup:\n         ${missing.join("\n         ")}\n` +
    `       Add them to build.files in package.json.`);
  return `${reachable.length} modules`;
});

check("the preload is packaged too", () => {
  const reachable = [...requiresFrom("preload.js")];
  const missing = reachable.filter((f) => !covered(f));
  assert(!missing.length, `missing from the allowlist: ${missing.join(", ")}`);
  return `${reachable.length} modules`;
});

check("the mac icon named in the build config exists", () => {
  const icon = pkg.build.mac && pkg.build.mac.icon;
  assert(icon, "build.mac.icon is not set");
  assert(fs.existsSync(path.join(root, icon)), `${icon} does not exist`);
  return icon;
});

check("the preview harness and the web build are excluded, not shipped", () => {
  // preview-shim.js fakes the whole preload surface. Shipping it would put a
  // second, stubbed window.crowe inside the signed app. The web files are the
  // same shape of thing: web-bridge.js is a third window.crowe, backed by HTTP,
  // and rooms-web.js is the room engine bundled for a browser. Inert inside
  // Electron, since index.html never loads them, but a signed app should not
  // carry a second implementation of its own bridge.
  const excluded = [
    "renderer/preview.html", "renderer/preview-shim.js",
    "renderer/app.html", "renderer/web-bridge.js", "renderer/web-ui.js", "renderer/rooms-web.js",
  ];
  for (const f of excluded) {
    assert(pkg.build.files.includes(`!${f}`), `${f} is not excluded from the build`);
  }
  return excluded.map((f) => f.replace("renderer/", "")).join(", ");
});

console.log(failures ? `\n${failures} check(s) failed` : "\nall packaging checks passed");
process.exit(failures ? 1 : 0);
