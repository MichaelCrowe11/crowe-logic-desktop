#!/usr/bin/env node
// Assembles mobile/www — the web payload Capacitor ships inside the iOS and
// Android shells — out of the desktop renderer plus the mobile layer in src/.
//
//   node scripts/build-www.js            build
//   node scripts/build-www.js --dev      build with a cache-busting stamp
//
// The renderer is copied, never forked. Every mobile-only difference is either
// a transform declared here or a file in src/, so a change to the desktop UI
// reaches the phone by rebuilding rather than by being ported twice. That is
// the same bargain gen-preview.js makes for the browser preview, and it is why
// the transforms below are assertions: if index.html stops containing what a
// transform is looking for, this script fails loudly instead of quietly
// shipping a www that is missing its bridge.
//
// www/ is generated and git-ignored. Do not edit anything in it.

const fs = require("fs");
const path = require("path");

const mobileDir = path.join(__dirname, "..");
const root = path.join(mobileDir, "..");
const src = path.join(mobileDir, "src");
const www = path.join(mobileDir, "www");
const dev = process.argv.includes("--dev");
const version = require(path.join(mobileDir, "package.json")).version;
const stamp = dev ? String(Date.now()) : version;

// Files copied verbatim: [from, to]. The renderer's own sources come first
// because everything else exists to serve them.
const COPY = [
  ["renderer/styles.css", "styles.css"],
  ["renderer/mark-geometry.js", "mark-geometry.js"],
  ["renderer/mark.js", "mark.js"],
  ["renderer/renderer.js", "renderer.js"],
  ["assets/mark-simple.svg", "assets/mark-simple.svg"],
  ["assets/mark-simple-dark.svg", "assets/mark-simple-dark.svg"],
  ["assets/wordmark-motion.svg", "assets/wordmark-motion.svg"],
  ["assets/wordmark-ink.svg", "assets/wordmark-ink.svg"],
  ["assets/cultivation-backdrop.png", "assets/cultivation-backdrop.png"],
  ["assets/icon.png", "assets/icon.png"],
  ["assets/fonts/fraunces-var.woff2", "assets/fonts/fraunces-var.woff2"],
  ["assets/fonts/inter-var.woff2", "assets/fonts/inter-var.woff2"],
  ["assets/fonts/jetbrains-mono-var.woff2", "assets/fonts/jetbrains-mono-var.woff2"],
  ["mobile/src/mobile.css", "mobile.css"],
  ["mobile/src/mobile-bridge.js", "mobile-bridge.js"],
  ["mobile/src/mobile-ui.js", "mobile-ui.js"],
];

// Assets whose query string gets the build stamp, so a reinstall over an older
// build never serves a stale stylesheet out of the webview's HTTP cache.
const BUSTED = [
  "styles.css", "mobile.css", "grow-schema.js", "mobile-bridge.js",
  "mark-geometry.js", "mark.js", "renderer.js", "mobile-ui.js",
];

const HEAD = `  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="default" />
  <meta name="apple-mobile-web-app-title" content="Crowe Logic" />
  <meta name="format-detection" content="telephone=no" />
  <meta name="color-scheme" content="light dark" />
  <meta name="theme-color" content="#f7f3ea" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#16130f" media="(prefers-color-scheme: dark)" />
  <link rel="manifest" href="manifest.webmanifest" />
  <link rel="apple-touch-icon" href="assets/icon.png" />`;

// grow-schema.js is CommonJS shared by main and the harness. The mobile bridge
// validates a record the same way the desktop store does — same field list,
// same option sets, same date rule — so the file is wrapped rather than
// reimplemented. A second copy of these rules is a second thing to forget.
function wrapGrowSchema(source) {
  return `// GENERATED from grow-schema.js by mobile/scripts/build-www.js. Do not edit.
(function () {
  "use strict";
  const module = { exports: {} };
${source.replace(/^/gm, "  ")}
  window.CROWE_GROW = module.exports;
})();
`;
}

// Every transform states what it expects to find. A silent no-op here is a
// build that boots into the desktop bridge that does not exist on a phone.
function must(html, needle, what) {
  if (!html.includes(needle)) throw new Error(`index.html no longer contains ${what} (${needle})`);
  return html;
}

function buildIndex() {
  let html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");

  must(html, '<meta charset="utf-8" />', "the charset meta");
  html = html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n${HEAD}`);

  // xterm ships from node_modules, which is not part of the app bundle, and the
  // pane it drives has no PTY behind it on a phone anyway. The bridge installs a
  // stand-in window.Terminal so initTerm() still runs and the pane explains
  // itself instead of throwing.
  must(html, '<link rel="stylesheet" href="../node_modules/@xterm/xterm/css/xterm.css" />', "the xterm stylesheet");
  html = html.replace('  <link rel="stylesheet" href="../node_modules/@xterm/xterm/css/xterm.css" />\n', "");
  for (const tag of ['<script src="../node_modules/@xterm/xterm/lib/xterm.js"></script>',
                     '<script src="../node_modules/@xterm/addon-fit/lib/addon-fit.js"></script>']) {
    must(html, tag, "an xterm script tag");
    html = html.replace(`  ${tag}\n`, "");
  }

  must(html, '<link rel="stylesheet" href="styles.css" />', "the stylesheet link");
  html = html.replace('<link rel="stylesheet" href="styles.css" />',
    '<link rel="stylesheet" href="styles.css" />\n  <link rel="stylesheet" href="mobile.css" />');

  // The bridge has to be installed before any renderer script reads
  // window.crowe, and mark-geometry.js is the first of them.
  must(html, '<script src="mark-geometry.js"></script>', "the mark-geometry script tag");
  html = html.replace('<script src="mark-geometry.js"></script>',
    '<script src="grow-schema.js"></script>\n  <script src="mobile-bridge.js"></script>\n  <script src="mark-geometry.js"></script>');

  // The phone chrome mirrors controls the renderer wires up on load, so it goes
  // after renderer.js rather than before it.
  must(html, '<script src="renderer.js"></script>', "the renderer script tag");
  html = html.replace('<script src="renderer.js"></script>',
    '<script src="renderer.js"></script>\n  <script src="mobile-ui.js"></script>');

  html = html.split("../assets/").join("assets/");
  for (const asset of BUSTED) html = html.split(`"${asset}"`).join(`"${asset}?v=${stamp}"`);

  return html.replace("<!doctype html>\n", `<!doctype html>\n<!-- GENERATED by mobile/scripts/build-www.js from renderer/index.html. Do not edit. -->\n`);
}

const MANIFEST = {
  name: "Crowe Logic",
  short_name: "Crowe Logic",
  description: "Agentic reasoning and cultivation console over the CroweLM gateway.",
  start_url: "index.html",
  display: "standalone",
  orientation: "portrait",
  background_color: "#f7f3ea",
  theme_color: "#f7f3ea",
  icons: [{ src: "assets/icon.png", sizes: "1024x1024", type: "image/png", purpose: "any maskable" }],
};

function copy(from, to) {
  const dest = path.join(www, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, from), dest);
}

function main() {
  fs.rmSync(www, { recursive: true, force: true });
  fs.mkdirSync(www, { recursive: true });

  for (const [from, to] of COPY) copy(from, to);

  fs.writeFileSync(path.join(www, "grow-schema.js"),
    wrapGrowSchema(fs.readFileSync(path.join(root, "grow-schema.js"), "utf8")));
  fs.writeFileSync(path.join(www, "manifest.webmanifest"), JSON.stringify(MANIFEST, null, 2) + "\n");
  fs.writeFileSync(path.join(www, "index.html"), buildIndex());
  // The shell reads its own version out of the bridge; handing it over as data
  // keeps the number in package.json rather than duplicated in a script.
  fs.writeFileSync(path.join(www, "build.json"),
    JSON.stringify({ version, builtFor: "capacitor", stamp }, null, 2) + "\n");

  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p); else files.push(p);
    }
  })(www);
  const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
  console.log(`Wrote mobile/www — ${files.length} files, ${(bytes / 1024).toFixed(0)} KB`);
}

main();
