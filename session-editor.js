"use strict";
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDocument } = require("./draft-document");
const MAX_SHARED_BYTES = 256 * 1024;

// The packaged application supplies its own runtime. No system Python or Node
// and no Electron RunAsNode fuse are needed by the CLI's blocking editor call.
function editorCommand({ executable, appPath, packaged, platform = process.platform }) {
  const quote = value => platform === "win32" ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, `'"'"'`)}'`;
  return [executable, ...(packaged ? [] : [appPath]), "--session-draft"].map(quote).join(" ");
}

function brokerCall(port, sessionId, secret, route, fields = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ sessionId, ...fields });
    const req = http.request({ hostname: "127.0.0.1", port, path: `/${route}`, method: "POST", agent: false,
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, res => {
      let bytes = 0; const chunks = [];
      res.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 300 * 1024) { res.destroy(new Error("Draft response exceeds its limit.")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`Draft broker refused the request (${res.statusCode}).`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("Invalid draft response.")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("Draft broker did not respond.")));
    req.end(body);
  });
}

async function edit(filename, env = process.env, { pollMs = 300 } = {}) {
  const port = Number(env.CROWE_DRAFT_PORT), sessionId = env.CROWE_DRAFT_SESSION, secret = env.CROWE_DRAFT_SECRET;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !sessionId || !secret) throw new Error("This terminal has no shared draft broker.");
  const document = openDocument(path.resolve(filename));
  if (Buffer.byteLength(document.text) > MAX_SHARED_BYTES) throw new Error("Shared drafts require a file under 256 KiB.");
  const call = (route, fields) => brokerCall(port, sessionId, secret, route, fields);
  let draftId;
  try {
    draftId = (await call("open", { text: document.text })).id;
    if (typeof draftId !== "string" || !draftId) throw new Error("Draft broker returned no draft identifier.");
    for (;;) {
      const result = await call("result", { draftId });
      if (result.status === "discarded") return 0;
      if (result.status === "returned") {
        if (typeof result.text !== "string" || Buffer.byteLength(result.text) > MAX_SHARED_BYTES) throw new Error("Returned draft exceeds 256 KiB.");
        const text = document.text.includes("\r\n") ? result.text.replace(/\r?\n/g, "\r\n") : result.text;
        if (Buffer.byteLength(text) > MAX_SHARED_BYTES) throw new Error("Returned draft exceeds 256 KiB after restoring line endings.");
        document.save(text);
        await call("ack", { draftId }).catch(() => {});
        draftId = null;
        return 0;
      }
      if (result.status !== "editing") throw new Error("Invalid draft state.");
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  } finally {
    if (draftId) await call("cancel", { draftId }).catch(() => {});
  }
}

function start() {
  const { app } = require("electron");
  const index = process.argv.indexOf("--session-draft");
  if (index < 0 || process.argv.length !== index + 2) { console.error("Pass exactly one draft file."); app.exit(1); return; }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-session-editor-"));
  app.setPath("userData", profile);
  app.whenReady().then(() => app.dock?.hide());
  process.on("exit", () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} });
  edit(process.argv[index + 1]).then(code => app.exit(code), error => {
    console.error(`Cannot return the shared draft: ${error.message}`); app.exit(1);
  });
}

module.exports = { edit, editorCommand, start };
