#!/usr/bin/env node
// Generates renderer/preview.html from renderer/index.html.
//
// preview.html runs the real shell in a plain browser: it loads preview-shim.js
// ahead of renderer.js to stub the window.crowe bridge that only exists inside
// Electron. It is a derived file, so regenerate it after any change to
// index.html rather than editing it by hand.
//
//   npm run preview:gen     regenerate
//   npm run preview         regenerate, then serve renderer/ on :8731
//
// Pass --check to fail when the committed copy is stale (useful in CI).

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const srcPath = path.join(root, "renderer", "index.html");
const outPath = path.join(root, "renderer", "preview.html");

const BANNER = `<!-- GENERATED FILE. Do not edit.
     Produced from index.html by scripts/gen-preview.js. Run \`npm run preview:gen\`
     after changing the shell. Loads preview-shim.js before renderer.js so the UI
     runs in a plain browser. Excluded from the packaged build via
     package.json build.files. -->
`;

// Every local asset gets a cache-busting query so a reload after an edit never
// serves a stale stylesheet or script from the browser cache.
const BUSTED = [
  "styles.css",
  "mark-geometry.js",
  "mark.js",
  "renderer.js",
  "preview-shim.js",
];

function generate(version) {
  let html = fs.readFileSync(srcPath, "utf8");

  html = html.replace(
    '<script src="mark-geometry.js"></script>',
    '<script src="preview-shim.js"></script>\n  <script src="mark-geometry.js"></script>',
  );

  for (const asset of BUSTED) {
    html = html.split(`"${asset}"`).join(`"${asset}?v=${version}"`);
  }

  if (!html.startsWith("<!doctype html>")) {
    throw new Error("index.html no longer starts with <!doctype html>");
  }
  return html.replace("<!doctype html>\n", `<!doctype html>\n${BANNER}`);
}

// The version query is the only part that legitimately differs run to run, so
// blank it out before comparing a regenerated file against the committed one.
const stripVersion = (html) => html.replace(/\?v=\d+/g, "?v=0");

const check = process.argv.includes("--check");
const generated = generate(check ? 0 : Date.now());

if (check) {
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
  if (stripVersion(current) !== stripVersion(generated)) {
    console.error(
      "renderer/preview.html is stale. Run `npm run preview:gen` and commit the result.",
    );
    process.exit(1);
  }
  console.log("renderer/preview.html is up to date.");
} else {
  fs.writeFileSync(outPath, generated);
  console.log(`Wrote ${path.relative(root, outPath)}`);
}
