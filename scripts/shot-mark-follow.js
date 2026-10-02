#!/usr/bin/env node
/* Eyes on the mark that rides the turn.

     npx electron scripts/shot-mark-follow.js

   Serves this checkout's renderer/preview.html on an ephemeral port (the same
   idiom as test-panels.js), scripts a four-card turn through the preview
   shim's agent bridge with 900 ms between events, and captures five frames to
   /tmp/crowe-shots/mark-follow: after each of the first three cards, while the
   answer streams, and after the landing. Each frame prints --mark-y as
   renderer.js set it. test-panels.js holds the geometry; this is for looking. */
const { app, BrowserWindow } = require("electron");
const http = require("http"), path = require("path"), fs = require("fs");
const ROOT = path.join(__dirname, "..");
const OUT = "/tmp/crowe-shots/mark-follow"; fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, ""); const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) return res.writeHead(403).end();
  fs.readFile(file, (err, buf) => { if (err) return res.writeHead(404).end(); res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" }); res.end(buf); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const url = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}/renderer/preview.html`)));
  const win = new BrowserWindow({ width: 1280, height: 860, show: true, webPreferences: { webviewTag: true } });
  await win.loadURL(url + "?t=" + Date.now()); await sleep(3000);
  const t0 = Date.now();
  await win.webContents.executeJavaScript(`(() => {
    let listeners = [];
    window.crowe.agent.onEvent = (fn) => { listeners.push(fn); return () => { listeners = listeners.filter((f) => f !== fn); }; };
    window.crowe.agent.run = async (m, id) => {
      const script = [
        { type: "route", expert: "operator", model: "crowelm" },
        { type: "tool_call", id: "t1", name: "list_dir", args: { path: "." } },
        { type: "tool_result", id: "t1", name: "list_dir", result: ".devcontainer/\\n.git/\\n.github/\\nsrc/\\nREADME.md" },
        { type: "tool_call", id: "t2", name: "read_file", args: { path: "universal-fungal-intelligence-system/src/core/fungal_intelligence.py" } },
        { type: "tool_result", id: "t2", name: "read_file", result: Array(14).fill(0).map((_, i) => (i + 1) + "  import line_" + i).join("\\n") },
        { type: "tool_call", id: "t3", name: "read_file", args: { path: "README.md" } },
        { type: "tool_result", id: "t3", name: "read_file", result: "# crowe-ml-pipeline\\n\\nPython monorepo from 2025 for fungal compound screening." },
        { type: "tool_call", id: "t4", name: "run_shell", args: { command: "pytest -q" } },
        { type: "tool_result", id: "t4", name: "run_shell", result: "85 passed in 4.2s" },
        { type: "assistant", text: "Steps one through four are done: the module reads, the tests pass, and nothing outside the listed files changed." },
      ];
      for (const ev of script) { listeners.slice().forEach((f) => f({ agentId: id || "main", ...ev })); await new Promise((r) => setTimeout(r, 900)); }
      return {};
    };
    send("execute steps one through four");
    return true;
  })()`);
  const shots = [[1400, "01-after-first-card"], [3200, "02-after-second-card"], [5000, "03-after-third-card"], [8400, "04-answer-streaming"], [11500, "05-landed-home"]];
  for (const [at, name] of shots) {
    const wait = t0 + at - Date.now(); if (wait > 0) await sleep(wait);
    const y = await win.webContents.executeJavaScript(`(() => { const w = document.querySelector(".msg.assistant .who"); return w ? w.style.getPropertyValue("--mark-y") : "none"; })()`);
    const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, name + ".png"), img.toPNG());
    console.log(`shot ${name} at t=${Date.now() - t0}ms --mark-y=${y || "(unset)"}`);
  }
  app.exit(0);
});
