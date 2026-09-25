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
  const matches = (pattern) => {
    if (pattern === rel) return true;
    const star = pattern.indexOf("/**");
    return star > 0 && rel.startsWith(pattern.slice(0, star + 1));
  };
  return allow.some(matches) && !pkg.build.files.some((pattern) => pattern.startsWith("!") && matches(pattern.slice(1)));
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

check("the farm worker entrypoint and its dependencies are explicitly packaged", () => {
  // new Worker(path.join(__dirname, "worker.js")) is not a require edge.
  // Walking main.js alone silently misses the entire SQLite store.
  const entry = "farm/worker.js";
  assert(pkg.build.files.includes("farm/**"), "build.files must explicitly include farm/**");
  assert(fs.existsSync(path.join(root, entry)), "farm/worker.js does not exist");
  const reachable = [...requiresFrom(entry)];
  assert(reachable.includes("farm/store.js"), "the worker must reach the authoritative store");
  const missing = reachable.filter((f) => !covered(f) || pkg.build.files.includes(`!${f}`));
  assert(!missing.length, `farm worker dependencies missing from the package: ${missing.join(", ")}`);
  for (const asset of ["renderer/farm-compliance.js", "renderer/farm-compliance.css"]) {
    assert(covered(asset) && !pkg.build.files.includes(`!${asset}`) && fs.existsSync(path.join(root, asset)), `missing asset ${asset}`);
  }
  return `${reachable.length} worker modules; startup from a staged package: test-farm-packaging.js`;
});

check("edition policy and transfer host modules are packaged with their dependencies", () => {
  for (const entry of ["app-edition.js", "grow-transfer.js", "farm/transfer-host.js"]) {
    assert(fs.existsSync(path.join(root, entry)), `${entry} does not exist`);
    const missing = [...requiresFrom(entry)].filter((file) => !covered(file) || pkg.build.files.includes(`!${file}`));
    assert(!missing.length, `transfer dependencies missing from package: ${missing.join(", ")}`);
  }
  for (const asset of ["renderer/farm-recovery.js", "renderer/mycology-transfer.js", "renderer/mycology-transfer.css"]) {
    assert(covered(asset) && !pkg.build.files.includes(`!${asset}`), `${asset} is not packaged`);
    assert(fs.existsSync(path.join(root, asset)), `${asset} is missing`);
  }
});

check("Vision host and review assets ship without the synthetic farm fixture", () => {
  assert(pkg.build.files.includes("vision/**"), "build.files must explicitly include vision/**");
  for (const entry of ["vision/host.js", "vision/image.js", "vision/notebook.js"]) {
    assert(fs.existsSync(path.join(root, entry)), `${entry} is missing`);
    const missing = [...requiresFrom(entry)].filter((file) => !covered(file));
    assert(!missing.length, `Vision dependencies missing from package: ${missing.join(", ")}`);
  }
  for (const asset of ["renderer/mycology-vision.js", "renderer/mycology-vision.css"]) {
    assert(covered(asset) && fs.existsSync(path.join(root, asset)), `${asset} is missing or excluded`);
  }
  assert(!covered("farm/fixtures.js"), "synthetic farm fixture must not ship");
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

check("the developer edition config narrows the app and changes nothing else", () => {
  // Built from package.json's build section by require, so anything it does
  // not name is the full app's. electron-builder never runs here; this is the
  // cheap proof that the file loads and says what dist:developers relies on.
  const dev = require(path.join(root, "electron-builder.developer.js"));
  assert(dev.appId === `${pkg.build.appId}.developers`, `appId is ${dev.appId}`);
  assert(dev.productName === "Crowe Logic for Developers" && dev.extraMetadata.productName === dev.productName,
    "productName must be set on the config and in extraMetadata");
  assert(JSON.stringify(dev.extraMetadata.croweSpaces) === '["chat","projects"]',
    `croweSpaces is ${JSON.stringify(dev.extraMetadata.croweSpaces)}`);
  assert(/-developers-/.test(dev.artifactName) && /-developers-/.test(dev.mac.artifactName), "artifactName does not mark the edition");
  assert(dev.publish.every((p) => p.channel === "developers"), "the edition shares the full app's update channel");
  // The feeds live under the edition's own prefix, beside the full app's rather
  // than in its channel directory, so the url has to end there too.
  assert(dev.publish.every((p) => p.url === pkg.build.publish[0].url.replace("/desktop/channel/", "/desktop/developers/channel/")),
    `the edition's feed url is not under desktop/developers/: ${JSON.stringify(dev.publish.map((p) => p.url))}`);
  assert(dev.directories.output !== pkg.build.directories.output, "the edition shares the full app's output directory");
  assert(JSON.stringify(dev.files) === JSON.stringify(pkg.build.files) && dev.mac.identity === pkg.build.mac.identity
    && dev.afterPack === pkg.build.afterPack && dev.afterSign === pkg.build.afterSign, "the edition drifted from package.json");
  return `${dev.appId}, ${dev.directories.output}/`;
});

check("the developer edition installs beside the full app on Linux", () => {
  // The deb is named after deb.packageName, falling back to package.json's
  // name (app-builder-lib/out/targets/FpmTarget.js, computeFpmMetaInfoOptions);
  // the binary, the /usr/bin symlink, the .desktop file and the icons after
  // linux.executableName, falling back to that name lowercased
  // (app-builder-lib/out/linuxPackager.js). The full app sets neither, so both
  // of its names are crowe-logic-desktop, and an edition that also set neither
  // would replace it on `apt install`. Worked out here the way app-builder-lib
  // does, so the check still holds if the full app names them one day.
  const dev = require(path.join(root, "electron-builder.developer.js"));
  const devName = (dev.extraMetadata && dev.extraMetadata.name) || pkg.name;
  const fullPackage = (pkg.build.deb && pkg.build.deb.packageName) || pkg.name;
  const fullExe = (pkg.build.linux && pkg.build.linux.executableName) || pkg.build.executableName || pkg.name.toLowerCase();
  const devPackage = (dev.deb && dev.deb.packageName) || devName;
  const devExe = (dev.linux && dev.linux.executableName) || dev.executableName || devName.toLowerCase();
  assert(devPackage !== fullPackage, `both editions' deb package is named ${fullPackage}`);
  assert(devExe !== fullExe, `both editions' Linux executable is named ${fullExe}`);
  assert(/^[a-z0-9][a-z0-9+.-]+$/.test(devPackage), `${devPackage} is not a valid Debian package name`);
  assert(JSON.stringify(dev.linux.target) === JSON.stringify(pkg.build.linux.target)
    && JSON.stringify(dev.deb.depends) === JSON.stringify(pkg.build.deb.depends), "the edition's Linux config drifted from package.json");
  return `${devPackage} beside ${fullPackage}, ${devExe} beside ${fullExe}`;
});

check("Mycology has a separate installer, Linux and update identity without packaging drift", () => {
  const dev = require(path.join(root, "electron-builder.developer.js"));
  const mycology = require(path.join(root, "electron-builder.mycology.js"));
  assert(mycology.extraMetadata.croweEdition === "mycology", "packaged Mycology edition metadata missing");
  assert(pkg.build.extraMetadata.croweEdition === "desktop" && dev.extraMetadata.croweEdition === "developers", "existing edition metadata missing");
  assert(mycology.productName === "Crowe Logic Mycology" && mycology.extraMetadata.productName === mycology.productName, "Mycology product identity missing");
  assert(mycology.appId === `${pkg.build.appId}.mycology` && mycology.appId !== dev.appId, "Mycology appId is not isolated");
  assert(mycology.linux.executableName === "crowe-logic-mycology" && mycology.deb.packageName === "crowe-logic-mycology", "Mycology Linux package identity missing");
  assert(mycology.directories.output === "release-mycology", "Mycology output directory is not isolated");
  assert(mycology.artifactName.includes("-mycology-") && mycology.mac.artifactName === mycology.artifactName, "Mycology artifact names are not isolated");
  assert(mycology.publish.every((entry) => entry.channel === "mycology" && entry.url.endsWith('/desktop/mycology/channel/${os}')), "Mycology updater is not isolated");
  for (const field of ["files", "asarUnpack", "afterPack", "afterSign"]) assert(JSON.stringify(mycology[field]) === JSON.stringify(pkg.build[field]), `Mycology ${field} drifted`);
});

check("the DMG stapler finds each edition's artifacts and feed from its config", () => {
  // staple-dmg.js patches the update feed by name after stapling. The developer
  // edition writes developers-mac.yml into release-developers/, so a stapler
  // fixed on latest-mac.yml in release/ would staple the DMG and then throw
  // with the feed unpatched. Both editions are resolved here without running
  // xcrun; the default has to come out exactly as build:mac has always run it.
  const { target } = require(path.join(root, "scripts", "staple-dmg.js"));
  const dev = require(path.join(root, "electron-builder.developer.js"));
  const plain = target(["node", "staple-dmg.js"]);
  assert(plain.dir === path.resolve(root, "release") && plain.feed === "latest-mac.yml",
    `default resolves to ${plain.dir} / ${plain.feed}`);
  const named = target(["node", "staple-dmg.js", "release"]);
  assert(named.dir === plain.dir && named.feed === plain.feed, "the positional directory changed the default");
  const edition = target(["node", "staple-dmg.js", "--config", path.join(root, "electron-builder.developer.js")]);
  assert(edition.dir === path.resolve(root, dev.directories.output), `edition resolves to ${edition.dir}`);
  assert(edition.feed === `${dev.publish[0].channel}-mac.yml`, `edition feed is ${edition.feed}`);
  const mycology = target(["node", "staple-dmg.js", "--config", path.join(root, "electron-builder.mycology.js")]);
  assert(mycology.dir === path.resolve(root, "release-mycology") && mycology.feed === "mycology-mac.yml", "Mycology stapler resolves outside its channel");
  return `${path.basename(plain.dir)}/${plain.feed}, ${path.basename(edition.dir)}/${edition.feed}, ${path.basename(mycology.dir)}/${mycology.feed}`;
});

check("the phone bundle carries every script and stylesheet the shell loads", () => {
  // The same mistake one layer down. build-www.js copies an allowlist into
  // mobile/www and rewrites index.html; a <script> tag added to the shell
  // without a COPY line shipped as a 404 on the phone with every desktop test
  // green, three times in one week. The build now reads its own page back and
  // throws on a reference it did not copy. Requiring the script runs the build
  // (www/ is generated and git-ignored) and with it that guard.
  const script = path.join(root, "mobile", "scripts", "build-www.js");
  delete require.cache[require.resolve(script)];
  require(script);
  const html = fs.readFileSync(path.join(root, "mobile", "www", "index.html"), "utf8");
  const refs = [...html.matchAll(/<(?:script\b[^>]*\ssrc|link\b[^>]*\shref)="([^"?]+\.(?:m?js|css))/g)].map((m) => m[1]);
  assert(refs.length >= 10, `only ${refs.length} local script and stylesheet tags in the built page`);
  const gone = refs.filter((r) => !fs.existsSync(path.join(root, "mobile", "www", r)));
  assert(gone.length === 0, `built page names files not in www: ${gone.join(", ")}`);
  return `${refs.length} references, every one a file in mobile/www`;
});

console.log(failures ? `\n${failures} check(s) failed` : "\nall packaging checks passed");
process.exit(failures ? 1 : 0);
