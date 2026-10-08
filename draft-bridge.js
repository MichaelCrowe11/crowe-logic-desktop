const http = require("node:http");
const crypto = require("node:crypto");

// The child CLI authenticates using a per-session capability inherited from
// its parent PTY. This loopback service accepts text, never filesystem paths.
class DraftBridge {
  constructor(sessions) { this.sessions = sessions; this.clients = new Map(); }
  async start() {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.requestTimeout = 10000; this.server.headersTimeout = 5000;
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => { this.port = this.server.address().port; resolve(); });
    });
    this.timer = setInterval(() => {
      for (const [key, client] of this.clients) if (Date.now() - client.seen > 30000) {
        try { this.sessions.cancelDraft(client.sessionId, client.draftId); } catch {}
        this.clients.delete(key);
      }
    }, 5000); this.timer.unref();
    return this.starting;
  }
  env(s) { return { CROWE_DRAFT_PORT: String(this.port), CROWE_DRAFT_SESSION: s.id, CROWE_DRAFT_SECRET: s.secret }; }
  async handle(req, res) {
    const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
    if (req.method !== "POST" || req.headers.origin) return send(403, { error: "CLI requests only." });
    let bytes = 0; const chunks = [];
    try {
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 300 * 1024) { send(413, { error: "Draft too large." }); return; } chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const s = this.sessions.get(body.sessionId);
      const given = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer /, ""));
      const expected = Buffer.from(s.secret);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return send(401, { error: "Invalid session capability." });
      let draft;
      if (req.url === "/open") {
        draft = this.sessions.openDraft(s.id, body.text);
        this.clients.set(draft.id, { sessionId: s.id, draftId: draft.id, seen: Date.now() });
      } else {
        draft = this.sessions.draft(s.id, body.draftId);
        const client = this.clients.get(draft.id);
        if (client) client.seen = Date.now();
        if (req.url === "/cancel") { this.sessions.cancelDraft(s.id, draft.id); this.clients.delete(draft.id); }
        else if (req.url === "/ack") { this.clients.delete(draft.id); s.draft = null; }
        else if (req.url !== "/result") return send(404, { error: "No such route." });
      }
      send(200, draft);
    } catch (error) { if (!res.writableEnded) send(error.status || 400, { error: error.message }); }
  }
  stop() { clearInterval(this.timer); this.server?.closeAllConnections(); this.server?.close(); }
}
module.exports = { DraftBridge };
