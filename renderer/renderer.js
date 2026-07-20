// Crowe Logic desktop — renderer. Thin UI over window.crowe (preload). The agent
// runs in the main process and streams events here; tool actions also drive the
// terminal and browser panes directly.
const $ = (id) => document.getElementById(id);
const transcript = $("transcript");
const input = $("input");
const messages = []; // {role, content}

function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

// Minimal, safe markdown: fenced code, inline code, bold.
function md(s) {
  const parts = String(s).split(/```/);
  return parts.map((chunk, i) => {
    if (i % 2 === 1) return `<pre>${esc(chunk.replace(/^\w*\n/, ""))}</pre>`;
    return esc(chunk)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
  }).join("");
}

function clearWelcome() { const w = transcript.querySelector(".welcome"); if (w) w.remove(); }

function addUser(text) {
  clearWelcome();
  const wrap = document.createElement("div");
  wrap.className = "msg user";
  wrap.innerHTML = `<div class="who"><div class="u">You</div></div><div class="body"><p>${esc(text)}</p></div>`;
  transcript.appendChild(wrap); transcript.scrollTop = transcript.scrollHeight;
}

function addAssistant() {
  clearWelcome();
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  wrap.innerHTML = `<div class="who"><img src="../assets/face.png" alt="Crowe Logic" /></div><div class="body"></div>`;
  transcript.appendChild(wrap);
  return wrap.querySelector(".body");
}

function renderText(body, text) {
  let p = body.querySelector("p.said");
  if (!p) { p = document.createElement("p"); p.className = "said"; body.prepend(p); }
  p.innerHTML = md(text);
  transcript.scrollTop = transcript.scrollHeight;
}

let lastCard = null;
function addToolCard(body, ev) {
  const card = document.createElement("div");
  card.className = "toolcard";
  const arg = ev.name === "run_shell" ? (ev.args.command || "") :
              ev.name === "open_url" ? (ev.args.url || "") :
              (ev.args.path || JSON.stringify(ev.args));
  card.innerHTML = `<div class="tc-head"><span class="tc-dot"></span><span class="tc-name">${esc(ev.name || "tool")}</span><span class="tc-arg">${esc(arg)}</span></div>`;
  body.appendChild(card); lastCard = card;
  transcript.scrollTop = transcript.scrollHeight;
}
function fillToolResult(ev) {
  if (!lastCard) return;
  const r = document.createElement("div");
  r.className = "tc-result"; r.textContent = ev.result || "";
  lastCard.appendChild(r);
  transcript.scrollTop = transcript.scrollHeight;
}
function addError(body, text) {
  const e = document.createElement("div"); e.className = "err"; e.textContent = text; body.appendChild(e);
}

async function send(text) {
  if (!text.trim()) return;
  addUser(text);
  messages.push({ role: "user", content: text });
  input.value = ""; input.style.height = "auto";
  const body = addAssistant();
  let runText = "";
  const off = window.crowe.agent.onEvent((ev) => {
    if (ev.type === "assistant") { runText += (runText ? "\n\n" : "") + ev.text; renderText(body, runText); }
    else if (ev.type === "tool_call") addToolCard(body, ev);
    else if (ev.type === "tool_result") fillToolResult(ev);
    else if (ev.type === "error") addError(body, ev.text);
  });
  try { await window.crowe.agent.run(messages); }
  finally { off(); }
  if (runText) messages.push({ role: "assistant", content: runText });
  else if (!body.querySelector("p.said, .err")) body.innerHTML = '<p class="said hint">(done — see the workspace)</p>';
  refreshCwd();
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
}

// ── Terminal ──
const termOut = $("term-out");
function termPrint(s) { termOut.textContent += s; termOut.scrollTop = termOut.scrollHeight; }
window.crowe.term.onEcho(termPrint);
window.crowe.term.onData(termPrint);
$("term-in").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  const cmd = e.target.value; e.target.value = "";
  termPrint(`$ ${cmd}\n`);
  const r = await window.crowe.term.run(cmd);
  termPrint(r.output || ""); setCwd(r.cwd);
});

// ── Browser ──
const wv = $("wv"), urlIn = $("url-in");
function navigate(u) { if (!/^https?:\/\//.test(u)) u = "https://" + u; wv.src = u; urlIn.value = u; }
$("url-go").addEventListener("click", () => navigate(urlIn.value));
urlIn.addEventListener("keydown", (e) => { if (e.key === "Enter") navigate(urlIn.value); });
wv.addEventListener("did-navigate", () => { urlIn.value = wv.getURL(); });
window.crowe.onBrowserNavigate((u) => { navigate(u); showPane("browser"); });

// ── Files ──
let filesDir = null;
async function loadTree(dir) {
  const r = await window.crowe.fs.list(dir);
  filesDir = r.cwd; setCwd(r.cwd);
  const tree = $("files-tree"); tree.innerHTML = "";
  const up = document.createElement("div"); up.className = "frow dir"; up.textContent = "../";
  up.onclick = () => loadTree(r.cwd + "/.."); tree.appendChild(up);
  for (const e of r.entries) {
    const row = document.createElement("div");
    row.className = "frow" + (e.dir ? " dir" : "");
    row.textContent = e.dir ? e.name + "/" : e.name;
    row.onclick = async () => {
      const full = r.cwd + "/" + e.name;
      if (e.dir) return loadTree(full);
      const f = await window.crowe.fs.read(full);
      $("files-view").textContent = f.error ? f.error : f.content;
    };
    tree.appendChild(row);
  }
}

// ── cwd display ──
function setCwd(c) { if (c) $("cwd").textContent = c; }
async function refreshCwd() { const r = await window.crowe.term.cwd(); setCwd(r.cwd); }

// ── Settings ──
const modal = $("settings");
$("settings-btn").addEventListener("click", async () => {
  const c = await window.crowe.getConfig();
  $("cfg-base").value = c.baseUrl; $("cfg-cwd").value = c.cwd || ""; $("cfg-token").value = "";
  $("cfg-status").textContent = c.hasToken ? "Token is set." : "No token set yet.";
  modal.classList.remove("hidden");
});
$("cfg-cancel").addEventListener("click", () => modal.classList.add("hidden"));
$("cfg-save").addEventListener("click", async () => {
  const patch = { baseUrl: $("cfg-base").value.trim(), cwd: $("cfg-cwd").value.trim() };
  const tok = $("cfg-token").value.trim(); if (tok) patch.token = tok;
  await window.crowe.setConfig(patch);
  modal.classList.add("hidden");
  refreshCwd(); loadTree($("cfg-cwd").value.trim() || undefined);
});

// ── Init ──
(async () => {
  const c = await window.crowe.getConfig();
  $("model-badge").textContent = "CroweLM"; // never surface the raw routing id
  setCwd(c.cwd); loadTree();
})();
