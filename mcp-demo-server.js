#!/usr/bin/env node
// A tiny self-contained MCP server (stdio, newline-delimited JSON-RPC) so the
// app's MCP client has something real to talk to out of the box. Exposes two
// tools. Swap in any real MCP server via Settings -> MCP servers.
const TOOLS = [
  { name: "http_get", description: "Fetch a URL over HTTP and return the response body as text (headless, no browser).",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "now", description: "Return the current date and time in ISO 8601.",
    inputSchema: { type: "object", properties: {} } },
];

async function call(name, args) {
  if (name === "http_get") {
    const r = await fetch(args.url); const t = await r.text();
    return `HTTP ${r.status} ${args.url}\n\n${t.slice(0, 6000)}`;
  }
  if (name === "now") return new Date().toISOString();
  return `unknown tool: ${name}`;
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
    if (msg.method === "initialize") reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "crowe-tools", version: "0.1.0" } });
    else if (msg.method === "tools/list") reply({ tools: TOOLS });
    else if (msg.method === "tools/call") {
      try { const out = await call(msg.params.name, msg.params.arguments || {}); reply({ content: [{ type: "text", text: String(out) }] }); }
      catch (e) { reply({ content: [{ type: "text", text: "error: " + String(e) }], isError: true }); }
    } else if (msg.id) reply({});
  }
});
