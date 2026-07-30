#!/usr/bin/env node
// Serves mobile/www on :8732 so the phone layout can be worked on in a desktop
// browser's device emulator, with no simulator and no Xcode.
//
//   npm run serve        (in mobile/)
//
// The bridge detects that it is not inside Capacitor and degrades: Preferences
// becomes localStorage, the share sheet becomes the clipboard, and Crowe ID
// sign-in refuses with a message pointing at the token field in Settings —
// there is no deep link to come back through in a browser tab. Everything
// else, the gateway included, is the same code the device runs.

const http = require("http");
const fs = require("fs");
const path = require("path");

const www = path.join(__dirname, "..", "www");
const port = Number(process.env.PORT) || 8732;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".woff2": "font/woff2",
};

if (!fs.existsSync(path.join(www, "index.html"))) {
  console.error("mobile/www is not built. Run `npm run www` first.");
  process.exit(1);
}

http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "index.html";
  // Resolve then contain: a path that climbs out of www is a 403, not a read.
  const file = path.resolve(www, rel);
  if (!file.startsWith(www + path.sep) && file !== www) { res.writeHead(403).end("forbidden"); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(buf);
  });
}).listen(port, () => console.log(`mobile/www on http://localhost:${port}`));
