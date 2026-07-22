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
  wrap.innerHTML = `<div class="who"><span class="who-mark" role="img" aria-label="Crowe Logic"></span></div><div class="body"></div>`;
  transcript.appendChild(wrap);
  const body = wrap.querySelector(".body");
  const markEl = wrap.querySelector(".who-mark");
  if (window.CroweMark) body._mark = CroweMark.mount(markEl, { state: "rest" });
  return body;
}
function mountWelcomeMark() {
  const wm = transcript.querySelector(".welcome-mark");
  if (wm && !wm.querySelector("svg") && window.CroweMark) CroweMark.mount(wm, { state: "idle" });
}
function renderText(body, text) {
  let p = body.querySelector("p.said"); if (!p) { p = document.createElement("p"); p.className = "said streaming"; body.prepend(p); }
  const t = body.querySelector(".thinking"); if (t) t.remove();
  p.innerHTML = md(text); transcript.scrollTop = transcript.scrollHeight;
}
function showThinking(body) {
  if (body.querySelector(".thinking") || body.querySelector("p.said")) return;
  const t = document.createElement("div"); t.className = "thinking";
  t.innerHTML = '<span class="tdot"></span><span>working</span>';
  body.appendChild(t); transcript.scrollTop = transcript.scrollHeight;
}
let lastCard = null;
function addToolCard(body, ev) {
  const card = document.createElement("div"); card.className = "toolcard running";
  const arg = ev.name === "run_shell" ? (ev.args.command || "")
    : ev.name === "open_url" ? (ev.args.url || "")
    : ev.name === "search" ? (ev.args.pattern || "")
    : (ev.args.path || JSON.stringify(ev.args));
  const label = ev.name && ev.name.startsWith("mcp__") ? ev.name.replace(/^mcp__/, "mcp:") : ev.name;
  card.innerHTML = `<div class="tc-head"><span class="tc-dot"></span><span class="tc-name">${esc(label || "tool")}</span><span class="tc-arg">${esc(arg)}</span></div>`;
  body.appendChild(card); lastCard = card; transcript.scrollTop = transcript.scrollHeight;
}
function fillToolResult(ev) {
  if (!lastCard) return;
  const result = String(ev.result || "");
  lastCard.classList.remove("running");
  lastCard.classList.add(/error|failed|exception|traceback/i.test(result) ? "fail" : "ok");
  const r = document.createElement("div"); r.className = "tc-result"; r.textContent = result;
  const lines = result.split("\n");
  if (lines.length > 3 || result.length > 160) {
    r.classList.add("collapsed");
    r.title = "Click to expand";
    r.addEventListener("click", () => r.classList.toggle("collapsed"));
  }
  lastCard.appendChild(r);
  transcript.scrollTop = transcript.scrollHeight;
}
function addEditProposal(body, ev) {
  const card = document.createElement("div"); card.className = "editcard";
  const rows = ev.diff.map((d) => `<div class="dl ${d.t === '+' ? 'add' : d.t === '-' ? 'del' : 'ctx'}">${esc((d.t === ' ' ? '  ' : d.t + ' ') + d.s)}</div>`).join("");
  card.innerHTML = `<div class="ec-head"><span class="ec-title">Proposed edit</span><span class="ec-path">${esc(ev.path)}</span></div>
    <div class="ec-diff">${rows}</div>
    <div class="ec-actions"><button class="approve">Approve</button><button class="reject">Reject</button><span class="ec-hint">a approve · r reject</span></div>`;
  card.tabIndex = 0;
  body.appendChild(card); card.focus(); transcript.scrollTop = transcript.scrollHeight;
  const done = (ok) => { window.crowe.edit.decide(ev.id, ok); card.querySelector(".ec-actions").innerHTML = `<span class="ec-status">${ok ? "applied" : "rejected"}</span>`; card.classList.add(ok ? "applied" : "rejected"); };
  card.querySelector(".approve").onclick = () => done(true);
  card.querySelector(".reject").onclick = () => done(false);
  card.addEventListener("keydown", (e) => {
    if (card.dataset.decided) return;
    const k = e.key.toLowerCase();
    if (k === "a") { card.dataset.decided = "1"; done(true); }
    else if (k === "r") { card.dataset.decided = "1"; done(false); }
  });
}
function addError(body, text) { const e = document.createElement("div"); e.className = "err"; e.textContent = text; body.appendChild(e); }

let running = false;
let sessionCost = 0, runCost = 0;
function fmtCost(c) { return "$" + (c || 0).toFixed(4); }
function addColophon(body, a, tok, cost) {
  if (!a.cmds && !a.edits && !a.tools && !tok) return;
  const parts = [];
  if (a.cmds) parts.push(a.cmds === 1 ? "1 command" : a.cmds + " commands");
  if (a.edits) parts.push(a.edits === 1 ? "1 edit" : a.edits + " edits");
  if (a.tools) parts.push(a.tools === 1 ? "1 tool call" : a.tools + " tool calls");
  const fmtTok = tok >= 1000 ? (tok / 1000).toFixed(1) + "k" : String(tok);
  const el = document.createElement("div");
  el.className = "colophon";
  el.innerHTML = `<span>${esc(parts.join(" · ") || "no workspace actions")}</span><span>${esc(fmtTok)} tok · ${esc(fmtCost(cost))}</span>`;
  body.appendChild(el);
}
function updateHud(ev) {
  runCost = ev.cost || 0;
  $("hud-tok").textContent = `${ev.promptTokens || 0} / ${ev.completionTokens || 0} tok`;
  $("hud-tps").textContent = ev.tps ? `${ev.tps} tok/s` : "";
  $("hud-cost").textContent = fmtCost(sessionCost + runCost);
}
function setRunning(on) {
  running = on;
  $("send").classList.toggle("hidden", on);
  $("stop").classList.toggle("hidden", !on);
  $("hud-status").textContent = on ? "running" : "idle";
}
function addStopped(body) { const e = document.createElement("div"); e.className = "stopped"; e.textContent = "stopped by you"; body.appendChild(e); }
function addRouteNode(body, ev) {
  const label = ev.expert && ev.expert !== "operator" ? `${ev.expert} · ${ev.model}` : (ev.model || "operator");
  const el = document.createElement("div"); el.className = "routecard";
  el.innerHTML = `<span class="rc-dot"></span><span class="rc-label">routed to ${esc(label)}</span>`;
  body.appendChild(el); transcript.scrollTop = transcript.scrollHeight;
}
async function send(text) {
  if (!text.trim() || running) return;
  if (!authed) { showSignInPrompt(); return; }
  addUser(text); messages.push({ role: "user", content: text });
  input.value = ""; input.style.height = "auto";
  const body = addAssistant(); let runText = "";
  const mark = body._mark; if (mark) mark.setState("reasoning");
  let runTok = 0, spentCost = 0; const acts = { cmds: 0, edits: 0, tools: 0 };
  showThinking(body); setRunning(true);
  const off = window.crowe.agent.onEvent((ev) => {
    if (ev.type === "assistant") { runText += (runText ? "\n\n" : "") + ev.text; renderText(body, runText); }
    else if (ev.type === "assistant_delta") { runText += ev.text || ""; renderText(body, runText); }
    else if (ev.type === "telemetry") { updateHud(ev); runTok = (ev.promptTokens || 0) + (ev.completionTokens || 0); }
    else if (ev.type === "tool_call") {
      showThinking(body); addToolCard(body, ev); $("hud-status").textContent = ev.name || "tool";
      if (mark) mark.ping();
    }
    else if (ev.type === "tool_result") {
      if (!/^blocked:/.test(String(ev.result || ""))) { if (ev.name === "run_shell") acts.cmds++; else if (ev.name === "write_file") acts.edits++; else acts.tools++; }
      fillToolResult(ev);
    }
    else if (ev.type === "edit_proposal") addEditProposal(body, ev);
    else if (ev.type === "route") { addRouteNode(body, ev); if (ev.model) $("hud-model").textContent = ev.model; }
    else if (ev.type === "stopped") { const t = body.querySelector(".thinking"); if (t) t.remove(); addStopped(body); }
    else if (ev.type === "error") addError(body, ev.text);
  });
  try { await window.crowe.agent.run(messages); } finally { off(); if (mark) mark.rest(); $("hud-model").textContent = "CroweLM"; spentCost = runCost; sessionCost += runCost; runCost = 0; $("hud-cost").textContent = fmtCost(sessionCost); setRunning(false); }
  const t = body.querySelector(".thinking"); if (t) t.remove();
  const said = body.querySelector("p.said"); if (said) said.classList.remove("streaming");
  if (runText) messages.push({ role: "assistant", content: runText });
  else if (!body.querySelector("p.said, .err, .stopped")) body.innerHTML = '<p class="said hint">Done. See the workspace.</p>';
  addColophon(body, acts, runTok, spentCost);
  refreshStatus();
}
$("stop").addEventListener("click", () => window.crowe.agent.stop());
$("composer").addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input.value); } });
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; });
function bindChips() { document.querySelectorAll(".chip").forEach((c) => (c.onclick = () => send(c.textContent))); }
bindChips();
const WELCOME_HTML = transcript.innerHTML;

// ── Tabs ──
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchPane(t.dataset.pane)));
function showPane(name) {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.pane === name));
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + name));
  if (name === "term") setTimeout(fitTerm, 30);
}

// ── Terminal (xterm + PTY) ──
let term = null, fit = null;
function fitTerm() { if (fit && term) { try { fit.fit(); window.crowe.pty.resize({ cols: term.cols, rows: term.rows }); } catch {} } }
async function initTerm() {
  term = new Terminal({ fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace", fontSize: 12.5, cursorBlink: true,
    theme: { background: "#17150f", foreground: "#e9e2cf", cursor: "#c9a227", selectionBackground: "#3a352a" } });
  fit = new FitAddon.FitAddon(); term.loadAddon(fit);
  term.open($("term")); fit.fit();
  const r = await window.crowe.pty.start({ cols: term.cols, rows: term.rows });
  if (!r || r.ok === false) { term.write("\r\n  PTY unavailable in this build.\r\n"); return; }
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
function abbrevPath(p) {
  if (!p) return "";
  let s = String(p).replace(/\/+$/, "");
  const home = "/Users/"; // abbreviate the home prefix to ~ when present
  const m = s.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (m) s = "~" + (m[1] || "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length > 3) s = (s[0] === "~" ? "~/…/" : "…/") + parts.slice(-2).join("/");
  return s;
}
function setCwd(c) { if (c) { $("cwd").textContent = c; const w = $("ws-path"); if (w) { w.textContent = abbrevPath(c); w.title = c; } } }
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

// ── Resizable split ──
const divider = $("divider"), workbench = $("workbench");
divider.addEventListener("mousedown", (e) => {
  e.preventDefault(); divider.classList.add("dragging");
  const move = (ev) => {
    const rect = workbench.getBoundingClientRect();
    const px = Math.min(Math.max(ev.clientX - rect.left, 300), rect.width - 320);
    workbench.style.setProperty("--split", px + "px");
  };
  const up = () => { divider.classList.remove("dragging"); fitTerm();
    window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
});

// ── Dark mode ──
function applyTheme(dark) {
  document.body.classList.toggle("dark", dark);
  $("theme-btn").textContent = dark ? "Light" : "Dark";
  try { localStorage.setItem("crowe-theme", dark ? "dark" : "light"); } catch {}
  if (window.CroweMark) CroweMark.reseed();  // re-anchor the living tokens to the new theme's family
}
$("theme-btn").addEventListener("click", () => applyTheme(!document.body.classList.contains("dark")));
try { applyTheme(localStorage.getItem("crowe-theme") === "dark"); } catch {}

// ── Cmd+Enter to send ──
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(input.value); }
});

// ── Pane switching (rail + tabs stay in sync; git loads on demand) ──
function setRailActive(pane) { document.querySelectorAll(".rail-btn[data-pane]").forEach((x) => x.classList.toggle("active", x.dataset.pane === pane)); }
function switchPane(name) { showPane(name); setRailActive(name); if (name === "git") loadGit(); }
document.querySelectorAll(".rail-btn[data-pane]").forEach((b) => b.addEventListener("click", () => switchPane(b.dataset.pane)));

// ── New chat + sessions drawer ──
const drawer = $("sessions-drawer");
async function newChat() {
  await window.crowe.sessions.new();
  messages.length = 0;
  transcript.innerHTML = WELCOME_HTML; bindChips(); mountWelcomeMark();
  input.value = ""; input.style.height = "auto"; input.focus();
  drawer.classList.add("hidden");
  sessionCost = 0; runCost = 0;
  $("hud-cost").textContent = fmtCost(0); $("hud-tok").textContent = "0 / 0 tok"; $("hud-tps").textContent = "";
}
$("rail-new").addEventListener("click", newChat);
$("sess-new").addEventListener("click", newChat);
$("rail-sessions").addEventListener("click", () => {
  const willShow = drawer.classList.contains("hidden");
  drawer.classList.toggle("hidden", !willShow);
  if (willShow) renderSessions();
});
async function renderSessions() {
  const list = await window.crowe.sessions.list();
  const el = $("sess-list"); el.innerHTML = "";
  if (!list.length) { el.innerHTML = '<div class="sess-empty">No saved sessions yet.</div>'; return; }
  for (const s of list) {
    const row = document.createElement("div"); row.className = "sess-row" + (s.current ? " current" : "");
    const when = new Date(s.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    row.innerHTML = `<div class="sess-main"><div class="sess-title">${esc(s.title || "Untitled")}</div><div class="sess-when">${esc(when)}</div></div><button class="sess-del" title="Delete">Delete</button>`;
    row.addEventListener("click", (e) => { if (e.target.closest(".sess-del")) return; loadSession(s.id); });
    row.querySelector(".sess-del").addEventListener("click", async (e) => { e.stopPropagation(); await window.crowe.sessions.delete(s.id); renderSessions(); });
    el.appendChild(row);
  }
}
async function loadSession(id) {
  const r = await window.crowe.sessions.load(id);
  if (r.error) return;
  messages.length = 0; for (const m of (r.messages || [])) messages.push(m);
  rebuildTranscript();
  renderSessions();
}
function rebuildTranscript() {
  transcript.innerHTML = "";
  let any = false;
  for (const m of messages) {
    if (m.role === "user") { addUser(m.content); any = true; }
    else if (m.role === "assistant" && m.content) { const b = addAssistant(); renderText(b, m.content); const s = b.querySelector("p.said"); if (s) s.classList.remove("streaming"); any = true; }
  }
  if (!any) { transcript.innerHTML = WELCOME_HTML; bindChips(); mountWelcomeMark(); }
}

// ── Git / version control pane ──
$("git-refresh").addEventListener("click", loadGit);
$("git-commit-btn").addEventListener("click", doCommit);
$("git-msg").addEventListener("keydown", (e) => { if (e.key === "Enter") doCommit(); });
async function loadGit() {
  const s = await window.crowe.git.status();
  const fl = $("git-files"), br = $("git-branch"), diff = $("git-diff");
  if (!s.repo) { br.textContent = "no repo"; fl.innerHTML = '<div class="git-empty">This workspace is not a git repository.</div>'; diff.textContent = ""; return; }
  br.textContent = s.branch;
  fl.innerHTML = "";
  if (!s.files.length) { fl.innerHTML = '<div class="git-empty">Working tree clean.</div>'; diff.textContent = ""; return; }
  for (const f of s.files) {
    const row = document.createElement("div"); row.className = "git-row";
    const code = f.staged ? f.index : (f.untracked ? "?" : (f.work || "M"));
    const cls = f.staged ? "staged" : f.untracked ? "untracked" : "mod";
    row.innerHTML = `<span class="git-x ${cls}">${esc(code)}</span><span class="git-path">${esc(f.path)}</span><button class="git-act">${f.staged ? "Unstage" : "Stage"}</button>`;
    row.addEventListener("click", (e) => { if (e.target.closest(".git-act")) return; showDiff(f); });
    row.querySelector(".git-act").addEventListener("click", async (e) => {
      e.stopPropagation();
      const res = f.staged ? await window.crowe.git.unstage(f.path) : await window.crowe.git.stage(f.path);
      if (res && res.error) { br.textContent = s.branch + " (" + res.error + ")"; return; }
      loadGit();
    });
    fl.appendChild(row);
  }
}
async function showDiff(f) {
  document.querySelectorAll(".git-row").forEach((r) => r.classList.remove("sel"));
  const d = await window.crowe.git.diff(f.path, f.staged);
  $("git-diff").innerHTML = colorizeDiff(typeof d === "string" ? d : (d && d.out) || "");
}
function colorizeDiff(text) {
  return String(text).split("\n").map((l) => {
    const c = (l[0] === "+" && !l.startsWith("+++")) ? "add" : (l[0] === "-" && !l.startsWith("---")) ? "del" : l.startsWith("@@") ? "hunk" : "ctx";
    return `<div class="dl ${c}">${esc(l) || "&nbsp;"}</div>`;
  }).join("");
}
async function doCommit() {
  const msg = $("git-msg").value.trim(); if (!msg) return;
  const r = await window.crowe.git.commit(msg);
  if (r && r.error) { $("git-branch").textContent = r.error; return; }
  $("git-msg").value = ""; loadGit();
}

// ── Autonomy pill ──
const TIER_HINT = {
  plan: "Describe a task. It explores read-only, then writes a plan to approve.",
  readonly: "Ask anything. Read-only: it can look, not touch.",
  edit: "Ask anything. It can edit files, with your review.",
  execute: "Ask anything. It can run commands and edit files.",
};
function setAutonomyBadge(tier) {
  document.querySelectorAll("#autonomy .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.tier === tier));
  $("autonomy").dataset.tier = tier;
  document.body.dataset.tier = tier;
  input.placeholder = TIER_HINT[tier] || "Ask Crowe Logic to do something...";
  try { localStorage.setItem("crowe-tier", tier); } catch {}
}
document.querySelectorAll("#autonomy .seg-btn").forEach((b) => b.addEventListener("click", async () => {
  await window.crowe.setConfig({ autonomy: b.dataset.tier }); setAutonomyBadge(b.dataset.tier);
}));

// ── Command palette (Cmd+K) ──
const PAL_ACTIONS = [
  { label: "New chat", run: newChat },
  { label: "Sessions", run: () => $("rail-sessions").click() },
  { label: "Terminal", run: () => switchPane("term") },
  { label: "Browser", run: () => switchPane("browser") },
  { label: "Files", run: () => switchPane("files") },
  { label: "Version control (git)", run: () => switchPane("git") },
  { label: "Toggle dark mode", run: () => applyTheme(!document.body.classList.contains("dark")) },
  { label: "Autonomy: Plan", run: () => selAutonomy("plan") },
  { label: "Autonomy: Read-only", run: () => selAutonomy("readonly") },
  { label: "Autonomy: Edit", run: () => selAutonomy("edit") },
  { label: "Autonomy: Execute", run: () => selAutonomy("execute") },
  { label: "Settings", run: () => $("settings-btn").click() },
];
async function selAutonomy(t) { await window.crowe.setConfig({ autonomy: t }); setAutonomyBadge(t); }
const palette = $("palette"), palInput = $("pal-input"), palList = $("pal-list");
function openPalette() { palette.classList.remove("hidden"); palInput.value = ""; renderPal(""); palInput.focus(); }
function closePalette() { palette.classList.add("hidden"); }
function renderPal(q) {
  palList.innerHTML = "";
  PAL_ACTIONS.filter((a) => a.label.toLowerCase().includes(q.toLowerCase())).forEach((a, i) => {
    const d = document.createElement("div"); d.className = "pal-row" + (i === 0 ? " sel" : ""); d.textContent = a.label;
    d.addEventListener("click", () => { closePalette(); a.run(); });
    palList.appendChild(d);
  });
}
palInput.addEventListener("input", () => renderPal(palInput.value));
palInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePalette();
  else if (e.key === "Enter") { const first = palList.querySelector(".pal-row"); if (first) first.click(); }
});
palette.addEventListener("click", (e) => { if (e.target === palette) closePalette(); });
$("rail-palette").addEventListener("click", openPalette);
$("rail-settings").addEventListener("click", () => $("settings-btn").click());
document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); } });

// ── Menu / tray / global-summon bus (previously fired into the void) ──
window.crowe.onMenuAction((a) => {
  if (a === "new-chat") newChat();
  else if (a === "focus-composer") input.focus();
  else if (a === "palette") openPalette();
  else if (a === "toggle-theme") applyTheme(!document.body.classList.contains("dark"));
  else if (a && a.startsWith("pane:")) switchPane(a.slice(5));
  else if (a && a.startsWith("autonomy:")) setAutonomyBadge(a.slice(9));
});

// ── Crowe ID sign-in ──
let authed = false;
async function refreshAuth() {
  const { user } = await window.crowe.auth.status();
  const btn = $("signin"), badge = $("userbadge");
  authed = Boolean(user && user.email);
  if (authed) {
    btn.classList.add("hidden");
    badge.textContent = user.tier ? `${user.email} · ${user.tier}` : user.email;
    badge.classList.remove("hidden");
  } else { btn.classList.remove("hidden"); badge.classList.add("hidden"); }
  return authed;
}
async function doSignIn() {
  const btn = $("signin"); const prev = btn.textContent;
  btn.textContent = "Opening browser..."; btn.disabled = true;
  const r = await window.crowe.auth.login();
  btn.disabled = false; btn.textContent = prev;
  if (r && r.ok) { await refreshAuth(); return true; }
  const b = addAssistant(); addError(b, r && r.error ? `Sign-in failed: ${r.error}` : "Sign-in failed.");
  return false;
}
function showSignInPrompt() {
  clearWelcome();
  const b = addAssistant();
  b.innerHTML = '<p class="said">Sign in with your Crowe ID to start. Your Pro access unlocks the full CroweLM tiers.</p>';
  const btn = document.createElement("button"); btn.className = "primary"; btn.textContent = "Sign in with Crowe ID";
  btn.style.marginTop = "8px"; btn.addEventListener("click", doSignIn);
  b.appendChild(btn); transcript.scrollTop = transcript.scrollHeight;
}
$("signin").addEventListener("click", doSignIn);
$("userbadge").addEventListener("click", async () => { await window.crowe.auth.logout(); await refreshAuth(); });

// ── Init ──
(async () => {
  $("model-badge").textContent = "CroweLM";
  if (window.CroweMark) { CroweMark.mount($("mark"), { state: "rest" }); mountWelcomeMark(); }
  try { setAutonomyBadge(localStorage.getItem("crowe-tier") || "edit"); } catch {}
  const c = await refreshStatus(); loadTree();
  setAutonomyBadge((c && c.autonomy) || "edit");
  await refreshAuth();
  await initTerm();
})();
