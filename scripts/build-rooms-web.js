#!/usr/bin/env node
// Bundles the room engine for the browser.
//
//   node scripts/build-rooms-web.js          write renderer/rooms-web.js
//   node scripts/build-rooms-web.js --check  fail if renderer/rooms-web.js is stale
//
// rooms/engine.js and rooms/registry.js are CommonJS and the registry reads
// agents.vendored.json off disk, so neither can load in a plain browser tab.
// The web build needs them, because a room on the web is the same engine
// driven by a runner that calls the edge instead of the harness.
//
// The engine is NOT rewritten. Both sources are wrapped verbatim in a module
// shim whose `require` answers the three things they ask for: "fs" and "path"
// (registry, to read the vendored roster, which is inlined here as JSON) and
// "./registry" (engine). The bytes that run on the web are the bytes that run
// on the desktop and under scripts/test-rooms.js, which is what makes the
// one-engine claim checkable rather than a hope. A port that hand-edited the
// engine for the browser would be a second engine the day it was written.
//
// The output is committed, like renderer/preview.html, so app.html can load it
// as a static file. --check is what keeps it honest in CI: edit the engine and
// forget to rebuild, and the web ships the old rules.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);

const engineSrc = read("rooms/engine.js");
const registrySrc = read("rooms/registry.js");
const vendoredSrc = read("rooms/agents.vendored.json");
const outPath = path.join(root, "renderer", "rooms-web.js");

// Parsed and re-serialised so a formatting change to the JSON does not churn
// the bundle, and so a malformed roster fails the build instead of the browser.
const vendored = JSON.stringify(JSON.parse(vendoredSrc));

const stamp = { engine: sha(engineSrc), registry: sha(registrySrc), vendored: sha(vendored) };

// One module wrapper per source, in dependency order. `require` is a closure
// over the finished registry, so the engine's require("./registry") resolves to
// the same object the registry wrapper returned.
const bundle = `// GENERATED FILE. Do not edit.
// Produced by scripts/build-rooms-web.js from rooms/engine.js, rooms/registry.js
// and rooms/agents.vendored.json. Run \`npm run rooms:web\` after changing any
// of them; \`npm test\` fails while this file is stale.
//
// The engine and registry sources below are verbatim. Only \`require\` is
// shimmed, so the rules that run in a browser room are byte-for-byte the rules
// that run on the desktop and under scripts/test-rooms.js.
// engine ${stamp.engine}  registry ${stamp.registry}  roster ${stamp.vendored}
(function () {
  "use strict";
  var VENDORED = ${vendored};

  var registry;
  function shimRequire(name) {
    if (name === "fs") return { readFileSync: function () { return JSON.stringify(VENDORED); } };
    if (name === "path") return { join: function () { return "agents.vendored.json"; } };
    if (name === "./registry") return registry;
    throw new Error("rooms-web: unbundled require(" + JSON.stringify(name) + ")");
  }

  var registryModule = { exports: {} };
  registry = (function (require, module, exports, __dirname) {
${indent(registrySrc)}
    return module.exports;
  })(shimRequire, registryModule, registryModule.exports, "");

  var engineModule = { exports: {} };
  var engine = (function (require, module, exports, __dirname) {
${indent(engineSrc)}
    return module.exports;
  })(shimRequire, engineModule, engineModule.exports, "");

  window.CroweRooms = Object.freeze({
    engine: engine,
    registry: registry,
    source: Object.freeze(${JSON.stringify(stamp)}),
  });
})();
`;

function indent(src) {
  return src.split("\n").map((l) => (l.length ? "    " + l : l)).join("\n");
}

if (process.argv.includes("--check")) {
  let current = "";
  try { current = fs.readFileSync(outPath, "utf8"); } catch {}
  if (current !== bundle) {
    console.error("renderer/rooms-web.js is stale. Run `npm run rooms:web` and commit the result.");
    process.exit(1);
  }
  console.log("renderer/rooms-web.js is up to date.");
} else {
  fs.writeFileSync(outPath, bundle);
  console.log(`wrote renderer/rooms-web.js (${bundle.length} bytes; engine ${stamp.engine}, registry ${stamp.registry}, roster ${stamp.vendored})`);
}
