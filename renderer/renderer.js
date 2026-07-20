// Crowe Logic desktop — renderer. Thin UI over window.crowe (preload). The agent
// runs in the main process and streams events here; tool actions drive the
// terminal (real PTY), the browser, and the file tree. File edits arrive as
// diffs you approve or reject.
const $ = (id) => document.getElementById(id);
const transcript = $("transcript");
const input = $("input");
const messages = [];

function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function md(s) {
  const parts = String(s).split(/```/);
  return parts.map((chunk, i) => {
    if (i % 2 === 1) return `<pre>${esc(chunk.replace(/^\w*\n/, ""))}</pre>`;
    return esc(chunk).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
  }).join("");
}
function clearWelcome() { const w = transcript.querySelector(".welcome"); if (w) w.remove(); }

function addUser(text) {
  clearWelcome();
  const wrap = document.createElement("div"); wrap.className = "msg user";
  wrap.innerHTML = `<div class="who"><div class="u">You</div></div><div class="body"><p>${esc(text)}</p></div>`;
  transcript.appendChild(wrap); transcript.scrollTop = transcript.scrollHeight;
}
function addAssistant() {
  clearWelcome();
  const wrap = document.createElement("div"); wrap.className = "msg assistant";
  wrap.innerHTML = `<div class="who"><img src="../assets/face.png" alt="Crowe Logic" /></div><div class="body"></div>`;
  transcript.appendChild(wrap); return wrap.querySelector(".body");
}
function renderText(body, text) {
  let p = body.querySelector("p.said"); if (!p) { p = document.createElement("p"); p.className = "said"; body.prepend(p); }
  p.innerHTML = md(text); transcript.scrollTop = transcript.scrollHeight;
}
let lastCard = null;
function addToolCard(body, ev) {
  const card = document.createElement("div"); card.className = "toolcard";
  const arg = ev.name === "run_shell" ? (ev.args.command || "") : ev.name === "open_url" ? (ev.args.url || "") : (ev.args.path || JSON.stringify(ev.args));
  const label = ev.name && ev.name.startsWith("mcp__") ? ev.name.replace(/^mcp__/, "mcp:") : ev.name;
  card.innerHTML = `<div class="tc-head"><span class="tc-dot"></span><span class="tc-name">${esc(label || "tool")}</span><span class="tc-arg">${esc(arg)}</span></div>`;
  body.appendChild(card); lastCard = card; transcript.scrollTop = transcript.scrollHeight;
}
function fillToolResult(ev) {
  if (!lastCard) return;
  const r = document.createElement("div"); r.className = "tc-result"; r.textContent = ev.result || ""; lastCard.appendChild(r);
  transcript.scrollTop = transcript.scrollHeight;
}
function addEditProposal(body, ev) {
  const card = document.createElement("div"); card.className = "editcard";
  const rows = ev.diff.map((d) => `<div class="dl ${d.t === '+' ? 'add' : d.t === '-' ? 'del' : 'ctx'}">${esc((d.t === ' ' ? '  ' : d.t + ' ') + d.s)}</div>`).join("");
  card.innerHTML = `<div class="ec-head"><span class="ec-title">Proposed edit</span><span class="ec-path">${esc(ev.path)}</span></div>
    <div class="ec-diff">${rows}</div>
    <div class="ec-actions"><button class="approve">Approve</button><button class="reject">Reject</button></div>`;
  body.appendChild(card); transcript.scrollTop = transcript.scrollHeight;
  const done = (ok) => { window.crowe.edit.decide(ev.id, ok); card.querySelector(".ec-actions").innerHTML = `<span class="ec-status">${ok ? "applied" : "rejected"}</span>`; card.classList.add(ok ? "applied" : "rejected"); };
  card.querySelector(".approve").onclick = () => done(true);
  card.querySelector(".reject").onclick = () => done(false);
}
function addError(body, text) { const e = document.createElement("div"); e.className = "err"; e.textContent = text; body.appendChild(e); }

async function send(text) {
  if (!text.trim()) return;
  addUser(text); messages.push({ role: "user", content: text });
  input.value = ""; input.style.height = "auto";
  const body = addAssistant(); let runText = "";
  const off = window.crowe.agent.onEvent((ev) => {
    if (ev.type === "assistant") { runText += (runText ? "\n\n" : "") + ev.text; renderText(body, runText); }
    else if (ev.type === "tool_call") addToolCard(body, ev);
    else if (ev.type === "tool_result") fillToolResult(ev);
    else if (ev.type === "edit_proposal") addEditProposal(body, ev);
    else if (ev.type === "error") addError(body, ev.text);
  });
  try { await window.crowe.agent.run(messages); } finally { off(); }
  if (runText) messages.push({ role: "assistant", content: runText });
  else if (!body.querySelector("p.said, .err")) body.innerHTML = '<p class="said hint">(done — see the workspace)</p>';
  refreshStatus();
}
$("composer").addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input.value); } });
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; });
document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => send(c.textContent)));

// ── Tabs ──
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showPane(t.dataset.pane)));
function showPane(name) {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.pane === name));
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + name));
  if (name === "term") setTimeout(fitTerm, 30);
}

// ── Terminal (xterm + PTY) ──
let term = null, fit = null, ptyStarted = false;
function fitTerm() { if (fit && term) { try { fit.fit(); window.crowe.pty.resize({ cols: term.cols, rows: term.rows }); } catch {} } }
async function initTerm() {
  term = new Terminal({ fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace", fontSize: 12.5, cursorBlink: true,
    theme: { background: "#17150f", foreground: "#e9e2cf", cursor: "#c9a227", selectionBackground: "#3a352a" } });
  fit = new FitAddon.FitAddon(); term.loadAddon(fit);
  term.open($("term")); fit.fit();
  const r = await window.crowe.pty.start({ cols: term.cols, rows: term.rows });
  if (!r || r.ok === false) { term.write("\r\n  PTY unavailable in this build.\r\n"); return; }
  ptyStarted = true;
  window.crowe.pty.onData((d) => term.write(d));
  term.onData((d) => window.crowe.pty.input(d));
}
window.addEventListener("resize", () => { if (document.querySelector("#pane-term.active")) fitTerm(); });

// ── Browser ──
const wv = $("wv"), urlIn = $("url-in");
function navigate(u) { if (!/^https?:\/\//.test(u)) u = "https://" + u; wv.src = u; urlIn.value = u; }
$("url-go").addEventListener("click", () => navigate(urlIn.value));
urlIn.addEventListener("keydown", (e) => { if (e.key === "Enter") navigate(urlIn.value); });
wv.addEventListener("did-navigate", () => { urlIn.value = wv.getURL(); });
window.crowe.onBrowserNavigate((u) => { navigate(u); showPane("browser"); });

// ── Files ──
async function loadTree(dir) {
  const r = await window.crowe.fs.list(dir);
  const tree = $("files-tree"); tree.innerHTML = "";
  const up = document.createElement("div"); up.className = "frow dir"; up.textContent = "../"; up.onclick = () => loadTree(r.cwd + "/.."); tree.appendChild(up);
  for (const e of r.entries) {
    const row = document.createElement("div"); row.className = "frow" + (e.dir ? " dir" : ""); row.textContent = e.dir ? e.name + "/" : e.name;
    row.onclick = async () => { const full = r.cwd + "/" + e.name; if (e.dir) return loadTree(full); const f = await window.crowe.fs.read(full); $("files-view").textContent = f.error ? f.error : f.content; };
    tree.appendChild(row);
  }
}

// ── Status (cwd + MCP) ──
function setCwd(c) { if (c) $("cwd").textContent = c; }
async function refreshStatus() {
  const c = await window.crowe.getConfig();
  setCwd(c.cwd);
  const total = (c.mcp || []).reduce((n, s) => n + s.tools, 0);
  const badge = $("mcp-badge");
  if (total > 0) { badge.textContent = `MCP · ${total} tools`; badge.classList.remove("hidden"); } else badge.classList.add("hidden");
  return c;
}

// ── Settings ──
const modal = $("settings");
$("settings-btn").addEventListener("click", async () => {
  const c = await window.crowe.getConfig();
  $("cfg-base").value = c.baseUrl; $("cfg-cwd").value = c.cwd || ""; $("cfg-token").value = "";
  $("cfg-auto").checked = Boolean(c.autoApprove);
  $("cfg-status").textContent = (c.hasToken ? "Token set. " : "No token yet. ") + (c.ptyAvailable ? "PTY ready." : "PTY unavailable.");
  modal.classList.remove("hidden");
});
$("cfg-cancel").addEventListener("click", () => modal.classList.add("hidden"));
$("cfg-save").addEventListener("click", async () => {
  const patch = { baseUrl: $("cfg-base").value.trim(), cwd: $("cfg-cwd").value.trim(), autoApprove: $("cfg-auto").checked };
  const tok = $("cfg-token").value.trim(); if (tok) patch.token = tok;
  const mcpRaw = $("cfg-mcp").value.trim();
  if (mcpRaw) { try { patch.mcpServers = JSON.parse(mcpRaw); } catch { $("cfg-status").textContent = "MCP JSON is invalid."; return; } }
  await window.crowe.setConfig(patch);
  modal.classList.add("hidden"); refreshStatus(); loadTree($("cfg-cwd").value.trim() || undefined);
});

// ── Init ──
(async () => {
  $("model-badge").textContent = "CroweLM";
  await refreshStatus(); loadTree();
  await initTerm();
})();
