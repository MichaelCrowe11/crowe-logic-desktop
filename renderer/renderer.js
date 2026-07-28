// Crowe Logic desktop — renderer. Thin UI over window.crowe (preload). The agent
// runs in the main process and streams events here; tool actions drive the
// terminal (real PTY), the browser, and the file tree. File edits arrive as
// diffs you approve or reject.
const $ = (id) => document.getElementById(id);
const transcript = $("transcript");
const input = $("input");
const messages = [];

function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
// Markdown for the operator's replies. Escape-first, then structure: the input
// is untrusted model output, so every character passes esc() before any HTML
// is assembled, and links only ever carry http(s) hrefs.
function inlineMd(s) {
  // Code spans are lifted out first so no later pass can rewrite their insides,
  // then restored at the end. \x00 can't occur in esc()'d text we produce.
  const codes = [];
  s = s.replace(/\x00/g, "");
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return "\x00" + (codes.length - 1) + "\x00"; });
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"']+)\)/g, '<a class="mdlink" href="$2">$1</a>');
  s = s.replace(/(^|[^"'>=\w])(https?:\/\/[^\s<>"')\]]+)/g, '$1<a class="mdlink" href="$2">$2</a>');
  s = s.replace(/\*\*(\S(?:[^*\n]*\S)?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|\W)\*(\S(?:[^*\n]*\S)?)\*(?=\W|$)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  return s.replace(/\x00(\d+)\x00/g, (_, i) => "<code>" + codes[+i] + "</code>");
}
function mdBlocks(t) {
  const lines = t.split("\n");
  const out = [], para = [];
  const flush = () => { if (para.length) { out.push("<p>" + para.map(inlineMd).join("<br>") + "</p>"); para.length = 0; } };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (!l.trim()) { flush(); i++; continue; }
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { flush(); const n = m[1].length; out.push(`<h${n}>${inlineMd(m[2])}</h${n}>`); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { flush(); out.push("<hr>"); i++; continue; }
    if (/^&gt;\s?/.test(l)) {
      flush(); const q = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) { q.push(inlineMd(lines[i].replace(/^&gt;\s?/, ""))); i++; }
      out.push("<blockquote>" + q.join("<br>") + "</blockquote>"); continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      flush(); const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push("<li>" + inlineMd(lines[i].replace(/^\s*[-*]\s+/, "")) + "</li>"); i++; }
      out.push("<ul>" + items.join("") + "</ul>"); continue;
    }
    if (/^\s*\d+[.)]\s+/.test(l)) {
      flush(); const items = [];
      const start = parseInt(l.match(/^\s*(\d+)/)[1], 10) || 1;
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push("<li>" + inlineMd(lines[i].replace(/^\s*\d+[.)]\s+/, "")) + "</li>"); i++; }
      out.push(`<ol${start !== 1 ? ` start="${start}"` : ""}>` + items.join("") + "</ol>"); continue;
    }
    if (/^\|.*\|/.test(l) && i + 1 < lines.length && /^\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      flush();
      const cells = (s) => s.replace(/^\||\|$/g, "").split("|").map((c) => inlineMd(c.trim()));
      const head = cells(l); i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push("<table><thead><tr>" + head.map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>"
        + rows.map((r) => "<tr>" + r.map((c) => `<td>${c}</td>`).join("") + "</tr>").join("") + "</tbody></table>");
      continue;
    }
    para.push(l); i++;
  }
  flush();
  return out.join("");
}
function md(s) {
  const parts = String(s).split(/```/);
  return parts.map((chunk, i) => {
    if (i % 2 === 1) {
      const m = chunk.match(/^([\w+-]*)\n/);
      const lang = m && m[1] ? esc(m[1]) : "";
      return `<pre${lang ? ` data-lang="${lang}"` : ""}><code>${esc(chunk.replace(/^[\w+-]*\n/, ""))}</code></pre>`;
    }
    return mdBlocks(esc(chunk));
  }).join("");
}
function clearWelcome() { const w = transcript.querySelector(".welcome"); if (w) w.remove(); }

async function copyText(text, button) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = "Copied";
    button.classList.add("copied");
    setTimeout(() => { button.textContent = label; button.classList.remove("copied"); }, 1400);
  } catch {
    button.textContent = "Copy failed";
    setTimeout(() => { button.textContent = "Copy"; }, 1400);
  }
}
function attachCopyButton(wrap, text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-copy ghost sm";
  button.textContent = "Copy";
  button.title = "Copy this message";
  button.addEventListener("click", () => copyText(text, button));
  wrap.querySelector(".body").appendChild(button);
}
function conversationMarkdown() {
  return messages.map((m) => `## ${m.role === "user" ? "You" : "Crowe Logic"}\n\n${m.content}`).join("\n\n");
}
$("copy-conversation").addEventListener("click", (e) => copyText(conversationMarkdown(), e.currentTarget));

// Follow the stream only while the user is at the bottom; never yank them back
// down while they are reading scrollback.
let pinned = true;
transcript.addEventListener("scroll", () => { pinned = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 48; });
function scrollBottom(force) { if (force || pinned) transcript.scrollTop = transcript.scrollHeight; }
// Links in replies open in the app's own browser pane, not the OS browser.
transcript.addEventListener("click", (e) => {
  const a = e.target.closest("a.mdlink"); if (!a) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
  showPane("browser");
});

function addUser(text) {
  clearWelcome();
  const wrap = document.createElement("div"); wrap.className = "msg user";
  wrap.innerHTML = `<div class="who"><div class="u">You</div></div><div class="body"><p>${esc(text)}</p></div>`;
  transcript.appendChild(wrap); attachCopyButton(wrap, text); pinned = true; scrollBottom(true);
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
  // Static render (history/rebuild). .said is a <div>: markdown emits block
  // elements a <p> could not contain. Appended: replies read chronologically.
  let p = body.querySelector(".said"); if (!p) { p = document.createElement("div"); p.className = "said streaming"; body.appendChild(p); }
  const t = body.querySelector(".thinking"); if (t) t.remove();
  p.innerHTML = md(text); scrollBottom();
}
// ── Thinking glyphs: the eight tournament directions as animated states ──
// These are per-turn cognition glyphs, not identity. The identity mark is
// CroweMark (mark.js) and it is the only thing allowed to speak for the brand.
// Fixed brand palette (Royal Blue / Logic Gold), one per turn.
const TG_B = "#2E5CB8", TG_G = "#D4A62A";
const TG_HEX8 = "12,4 18.9,8 18.9,16 12,20 5.1,16 5.1,8";
const TG_HEX3 = "12,9 14.6,10.5 14.6,13.5 12,15 9.4,13.5 9.4,10.5";
const TG_SPOKES = [[12, 8.5, 12, 4.5], [15, 10.3, 18.5, 8.3], [15, 13.8, 18.5, 15.8], [12, 15.5, 12, 19.5], [9, 13.8, 5.5, 15.8], [9, 10.3, 5.5, 8.3]];
function tgLines(w, extra) { return TG_SPOKES.map((p) => `<line x1="${p[0]}" y1="${p[1]}" x2="${p[2]}" y2="${p[3]}" stroke="${TG_B}" stroke-width="${w}" stroke-linecap="round"${extra || ""}/>`).join(""); }
const TG_DRAW = {
  meridian: () => `<polygon points="${TG_HEX8}" fill="none" stroke="${TG_B}" stroke-width="1.5" opacity=".35"/><g fill="${TG_B}"><circle cx="18.9" cy="8" r="1.6"/><circle cx="18.9" cy="16" r="1.6"/><circle cx="12" cy="20" r="1.6"/><circle cx="5.1" cy="16" r="1.6"/><circle cx="5.1" cy="8" r="1.6"/></g><g class="a"><circle cx="12" cy="4" r="2.2" fill="${TG_G}"/></g><circle cx="12" cy="12" r="1.9" fill="${TG_G}"/>`,
  iris: () => `<polygon points="12,3.5 19.4,7.8 19.4,16.3 12,20.5 4.6,16.3 4.6,7.8" fill="${TG_B}"/><polygon points="12,7 16.3,9.5 16.3,14.5 12,17 7.7,14.5 7.7,9.5" fill="var(--panel)"/><polygon class="a" points="${TG_HEX3}" fill="${TG_G}"/>`,
  coalesce: () => `<g class="a" fill="${TG_B}"><polygon points="12,3.5 10.3,9.1 13.7,9.1"/><polygon points="19.4,7.8 13.7,9.1 15.4,12"/><polygon points="19.4,16.3 15.4,12 13.7,14.9"/><polygon points="12,20.5 13.7,14.9 10.3,14.9"/><polygon points="4.6,16.3 10.3,14.9 8.6,12"/><polygon points="4.6,7.8 8.6,12 10.3,9.1"/></g><circle cx="12" cy="12" r="2" fill="${TG_G}"/>`,
  convergent: () => `<polygon points="${TG_HEX8}" fill="none" stroke="${TG_B}" stroke-width="1.3" opacity=".3"/><g class="a" fill="${TG_B}"><circle cx="12" cy="4" r="1.9"/><circle cx="18.9" cy="8" r="1.9"/><circle cx="18.9" cy="16" r="1.9"/><circle cx="12" cy="20" r="1.9"/><circle cx="5.1" cy="16" r="1.9"/><circle cx="5.1" cy="8" r="1.9"/></g><circle cx="12" cy="12" r="2.2" fill="${TG_G}"/>`,
  hexbloom: () => `<g class="a">${tgLines(3.2)}<circle cx="12" cy="12" r="1.8" fill="${TG_G}"/><circle cx="12" cy="3.4" r="1.1" fill="${TG_G}"/><circle cx="19.4" cy="16.4" r="1.1" fill="${TG_G}"/><circle cx="4.6" cy="16.4" r="1.1" fill="${TG_G}"/></g>`,
  mycelial: () => `${tgLines(1.6)}<polygon points="${TG_HEX3}" fill="${TG_G}"/>`,
  meshwork: () => `<polygon class="a" style="transform-box:view-box;transform-origin:9px 12px" points="9,5.5 14.6,8.8 14.6,15.3 9,18.5 3.4,15.3 3.4,8.8" fill="none" stroke="${TG_B}" stroke-width="2"/><polygon class="o" style="transform-box:view-box;transform-origin:16.5px 12px" points="16.5,7 20.8,9.5 20.8,14.5 16.5,17 12.2,14.5 12.2,9.5" fill="none" stroke="${TG_G}" stroke-width="2"/>`,
  facet: () => `<polygon points="12,12 12,3.5 19.4,7.8" fill="${TG_B}"/><polygon points="12,12 19.4,7.8 19.4,16.3" fill="${TG_G}"/><polygon points="12,12 19.4,16.3 12,20.5" fill="${TG_B}"/><polygon points="12,12 12,20.5 4.6,16.3" fill="${TG_G}"/><polygon points="12,12 4.6,16.3 4.6,7.8" fill="${TG_B}"/><polygon points="12,12 4.6,7.8 12,3.5" fill="${TG_G}"/>`,
};
const THINKERS = Object.keys(TG_DRAW);
let thinkerIdx = Math.floor(Date.now() / 1000) % THINKERS.length;
function thinkerSvg(kind) {
  const k = kind && TG_DRAW[kind] ? kind : THINKERS[thinkerIdx++ % THINKERS.length];
  return `<svg class="tg tg-${k}" viewBox="0 0 24 24" aria-hidden="true">${TG_DRAW[k]()}</svg>`;
}
// The glyph tracks the block stage: what the operator is doing right now.
function toolGlyph(name) {
  if (name === "run_shell") return ["meshwork", "executing"];
  if (name === "write_file" || name === "edit_file") return ["facet", "editing"];
  if (name === "open_url") return ["iris", "browsing"];
  if (name && name.startsWith("mcp__")) {
    const id = name.split("__")[1];
    return [pluginGlyphs[id] || "hexbloom", "calling " + id];
  }
  return ["mycelial", "retrieving"];
}
// One indicator per message body; it moves to the bottom and morphs per stage.
function showThinking(body, kind, label) {
  let t = body.querySelector(".thinking");
  if (!t) { t = document.createElement("div"); t.className = "thinking"; t.dataset.since = Date.now(); }
  t.dataset.label = label || "working";
  t.innerHTML = thinkerSvg(kind) + `<span class="th-label">${esc(label || "working")}</span><span class="th-elapsed"></span>`;
  body.appendChild(t); scrollBottom();
}
// Elapsed-time pulse: long model calls show visible progress, not dead air.
setInterval(() => {
  document.querySelectorAll(".thinking").forEach((t) => {
    const s = Number(t.dataset.since || 0); if (!s) return;
    const sec = Math.round((Date.now() - s) / 1000);
    const el = t.querySelector(".th-elapsed");
    if (el && sec >= 3) el.textContent = sec + "s";
  });
}, 1000);
function hideThinking(body) { const t = body.querySelector(".thinking"); if (t) t.remove(); }
let lastCard = null;
function addToolCard(body, ev) {
  const card = document.createElement("div"); card.className = "toolcard running";
  const arg = ev.name === "run_shell" ? (ev.args.command || "")
    : ev.name === "open_url" ? (ev.args.url || "")
    : ev.name === "search" ? (ev.args.pattern || "")
    : (ev.args.path || JSON.stringify(ev.args));
  const label = ev.name && ev.name.startsWith("mcp__") ? ev.name.replace(/^mcp__/, "mcp:") : ev.name;
  card.innerHTML = `<div class="tc-head"><span class="tc-dot"></span><span class="tc-name">${esc(label || "tool")}</span><span class="tc-arg">${esc(arg)}</span></div>`;
  body.appendChild(card); lastCard = card; scrollBottom();
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
  scrollBottom();
}
function addEditProposal(body, ev) {
  const card = document.createElement("div"); card.className = "editcard";
  const rows = ev.diff.map((d) => `<div class="dl ${d.t === '+' ? 'add' : d.t === '-' ? 'del' : 'ctx'}">${esc((d.t === ' ' ? '  ' : d.t + ' ') + d.s)}</div>`).join("");
  card.innerHTML = `<div class="ec-head"><span class="ec-title">Proposed edit</span><span class="ec-path">${esc(ev.path)}</span></div>
    <div class="ec-diff">${rows}</div>
    <div class="ec-actions"><button class="approve">Approve</button><button class="reject">Reject</button><span class="ec-hint">a approve · r reject</span></div>`;
  card.tabIndex = 0;
  body.appendChild(card); card.focus(); scrollBottom();
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
  body.appendChild(el); scrollBottom();
}
// opts.role pins the expert for this turn. Surfaces built around one specialty
// pass it so the routing matches what the surface says it does, instead of
// depending on the operator happening to use the right vocabulary.
async function send(text, opts = {}) {
  if (!text.trim() || running) return;
  // Re-validate live: a token that expired since launch must not eat the turn.
  if (!(await refreshAuth())) { showSignInPrompt(); return; }
  addUser(text); messages.push({ role: "user", content: text });
  input.value = ""; input.style.height = "auto";
  const body = addAssistant(); let runText = "";
  const mark = body._mark; if (mark) mark.setState("reasoning");
  let runTok = 0, spentCost = 0; const acts = { cmds: 0, edits: 0, tools: 0 };
  // Chronological streaming: each burst of text gets its own block appended
  // after the tool cards that produced it, revealed character by character.
  let curSaid = null, curText = "", shownLen = 0, typerOn = false;
  const finishSaid = () => {
    if (!curSaid) return;
    curSaid.innerHTML = md(curText); curSaid.classList.remove("streaming");
    curSaid = null; curText = ""; shownLen = 0; scrollBottom();
  };
  const typeTick = () => {
    if (!curSaid || shownLen >= curText.length) { typerOn = false; return; }
    const backlog = curText.length - shownLen;
    // Readable token cadence: ~120 chars/s base, ramping gently on a deep
    // backlog, hard-capped so a whole reply never flashes in at once.
    shownLen += Math.min(8, 2 + Math.floor(backlog / 600));
    curSaid.innerHTML = md(curText.slice(0, shownLen));
    scrollBottom();
    requestAnimationFrame(typeTick);
  };
  const pushText = (txt, burst) => {
    if (!txt) return;
    hideThinking(body);
    if (!curSaid) {
      curSaid = document.createElement("div"); curSaid.className = "said streaming";
      body.appendChild(curSaid); curText = ""; shownLen = 0;
    }
    curText += (burst && curText ? "\n\n" : "") + txt;
    if (!typerOn) { typerOn = true; requestAnimationFrame(typeTick); }
  };
  showThinking(body); setRunning(true);
  const off = window.crowe.agent.onEvent((ev) => {
    if (ev.type === "assistant") { runText += (runText ? "\n\n" : "") + ev.text; pushText(ev.text, true); }
    else if (ev.type === "assistant_delta") { runText += ev.text || ""; pushText(ev.text || "", false); }
    else if (ev.type === "telemetry") { updateHud(ev); runTok = (ev.promptTokens || 0) + (ev.completionTokens || 0); }
    else if (ev.type === "tool_call") {
      finishSaid(); addToolCard(body, ev);
      const [g, gl] = toolGlyph(ev.name); showThinking(body, g, gl);
      $("hud-status").textContent = ev.name || "tool";
      if (mark) mark.ping();
    }
    else if (ev.type === "tool_result") {
      if (!/^blocked:/.test(String(ev.result || ""))) { if (ev.name === "run_shell") acts.cmds++; else if (ev.name === "write_file") acts.edits++; else acts.tools++; }
      fillToolResult(ev);
      showThinking(body, "convergent", "reasoning");
    }
    else if (ev.type === "edit_proposal") { finishSaid(); hideThinking(body); addEditProposal(body, ev); }
    else if (ev.type === "route") { addRouteNode(body, ev); showThinking(body, "convergent", "reasoning"); if (ev.model) $("hud-model").textContent = ev.model; }
    else if (ev.type === "stopped") { finishSaid(); hideThinking(body); addStopped(body); }
    else if (ev.type === "error") { finishSaid(); hideThinking(body); addError(body, ev.text); }
  });
  try { await window.crowe.agent.run(messages, "main", opts.role ? { role: opts.role } : {}); } finally { off(); if (mark) mark.rest(); $("hud-model").textContent = "CroweLM"; spentCost = runCost; sessionCost += runCost; runCost = 0; $("hud-cost").textContent = fmtCost(sessionCost); setRunning(false); }
  finishSaid(); hideThinking(body);
  if (runText) { messages.push({ role: "assistant", content: runText }); attachCopyButton(body.closest(".msg"), runText); }
  else if (!body.querySelector(".said, .err, .stopped")) body.innerHTML = '<p class="said hint">Done. See the workspace.</p>';
  addColophon(body, acts, runTok, spentCost);
  refreshStatus();
}
$("stop").addEventListener("click", () => window.crowe.agent.stop());
$("composer").addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input.value); } });
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; });
function bindChips() { transcript.querySelectorAll(".chip").forEach((c) => (c.onclick = () => send(c.textContent))); }
bindChips();
const WELCOME_HTML = transcript.innerHTML;

// Crowe Logic agent dock. Agents always open in the stackable workspace.
// Legacy floating-agent state is intentionally retired to prevent duplicate runtimes.
try { localStorage.removeItem("crowe-glass-agents"); } catch {}

// ── Modular workspace panels ──
const panelDeck = $("panel-deck");
let panels = [], panelSeq = 0, activeLegacy = null, activePanelId = null;
const terminalPanels = new Map();
function panelId(type) { return `${type}-${Date.now().toString(36)}-${++panelSeq}`; }
function panelState() { return { layout: $("panel-layout").value, panels: panels.map((p) => ({ id:p.id, type:p.type, title:p.title, url:p.url, history:p.history || [], bookmarks:p.bookmarks || [], licensed:Boolean(p.licensed), workspaceId:p.workspaceId || "" })) }; }
function savePanelState() {
  try { localStorage.setItem("crowe-workspace-panels", JSON.stringify(panelState())); } catch {}
}
function savedLayouts(){try{return JSON.parse(localStorage.getItem("crowe-saved-layouts")||"{}")}catch{return {}}}
function refreshSavedLayouts(){const select=$("layout-saved"),layouts=savedLayouts();select.innerHTML='<option value="">Saved layouts</option>'+Object.keys(layouts).map((n)=>`<option value="${esc(n)}">${esc(n)}</option>`).join("")}
async function applyPanelState(st){for(const p of [...panels])closePanel(p.id);$("panel-layout").value=st.layout||"stack";panelDeck.className="panel-deck "+$("panel-layout").value;for(const p of(st.panels||[]))await addPanel(p.type,p);if(!panels.length)await addPanel("terminal");applyStackVisibility();renderDockTabs();fitTerminals()}
$("layout-save").onclick=()=>{const name=prompt("Layout name");if(!name||!name.trim())return;const layouts=savedLayouts();layouts[name.trim()]=panelState();localStorage.setItem("crowe-saved-layouts",JSON.stringify(layouts));refreshSavedLayouts()};
$("layout-saved").onchange=async(e)=>{const st=savedLayouts()[e.target.value];if(st)await applyPanelState(st);e.target.value=""};
$("layout-reset").onclick=()=>applyPanelState({layout:"stack",panels:[{type:"terminal"},{type:"browser",url:"https://crowelogic.com"},{type:"operator"}]});
refreshSavedLayouts();
function panelShell(p) {
  const el = document.createElement("section"); el.className = "workspace-panel"; el.dataset.id = p.id; el.draggable = true;
  el.innerHTML = `<div class="panel-head"><input class="panel-title" value="${esc(p.title)}" aria-label="Panel name"><button class="panel-dup ghost sm" title="Duplicate">Copy</button><button class="panel-close ghost sm" title="Close">Close</button></div><div class="panel-body"></div>`;
  el.querySelector(".panel-title").onchange=(e)=>{p.title=e.target.value;savePanelState();renderDockTabs()};
  el.querySelector(".panel-close").onclick = () => closePanel(p.id);
  el.querySelector(".panel-dup").onclick = () => addPanel(p.type, { url:p.url, title:p.title+" Copy", history:[...(p.history||[])], bookmarks:[...(p.bookmarks||[])] });
  el.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/panel", p.id));
  el.addEventListener("dragover", (e) => e.preventDefault());
  el.addEventListener("drop", (e) => { e.preventDefault(); const from=e.dataTransfer.getData("text/panel"); reorderPanel(from,p.id); });
  return el;
}
function reorderPanel(from, to) {
  const a=panels.findIndex((p)=>p.id===from), b=panels.findIndex((p)=>p.id===to); if(a<0||b<0||a===b)return;
  const [p]=panels.splice(a,1); panels.splice(b,0,p); renderPanelOrder(); renderDockTabs(); savePanelState();
}
function renderPanelOrder() { panels.forEach((p) => { const el=panelDeck.querySelector(`[data-id="${p.id}"]`); if(el) panelDeck.appendChild(el); }); }
async function addPanel(type, seed={}) {
  hideLegacy();
  const titles={terminal:"Terminal",browser:"Browser",operator:"Operator Control",workflow:"Workflows",agents:"Agent Fleet",agent:"Crowe Logic Agent",workbench:"Workbench",system:"CroweLM System Terminal"};
  const p = { id:seed.id || panelId(type), type, title:seed.title || titles[type] || "Panel", url:seed.url || "https://crowelogic.com", history:seed.history || [], bookmarks:seed.bookmarks || [], licensed:Boolean(seed.licensed), workspaceId:seed.workspaceId || "" };
  panels.push(p); activePanelId = p.id; const el=panelShell(p); panelDeck.appendChild(el); const body=el.querySelector(".panel-body");
  if(type === "terminal" || type === "system") await mountTerminal(p, body, type === "system");
  else if(type === "agent") await mountWorkspaceAgent(p, body, seed);
  else if(type === "browser") mountBrowser(p, body);
  else if(type === "workflow") mountWorkflow(p, body);
  else if(type === "agents") mountAgentFleet(p, body);
  else if(type === "workbench") mountWorkbench(p, body);
  else mountOperator(p, body);
  savePanelState(); applyStackVisibility(); renderDockTabs(); return p;
}
async function mountTerminal(p, body, systemTerminal=false) {
  const tools=document.createElement("div"); tools.className="terminal-tools";
  tools.innerHTML='<button class="term-restart ghost sm">Restart</button><button class="term-clear ghost sm">Clear</button><button class="term-copy ghost sm">Copy selection</button><button class="term-export ghost sm">Copy scrollback</button><span class="terminal-state">starting</span>';
  const host=document.createElement("div"); host.className="terminal-host"; body.append(tools,host);
  const t=new Terminal({fontFamily:"JetBrains Mono, ui-monospace, Menlo, monospace",fontSize:12.5,cursorBlink:true,scrollback:5000,theme:termTheme()});
  const f=new FitAddon.FitAddon(); t.loadAddon(f); t.open(host); try{f.fit()}catch{}
  const state=tools.querySelector(".terminal-state");
  /* Say why the shell did not open. It always claimed "unavailable in this
     build", which is wrong and unactionable when the real answer is that the
     autonomy tier withholds the shell and the operator can just raise it. */
  const start=async()=>{state.textContent="starting";const r=await window.crowe.pty.start({id:p.id,cols:t.cols,rows:t.rows});const ok=r&&r.ok!==false;state.textContent=ok?"running":"no shell";if(!ok)t.write(`\r\n  ${r?.error||"PTY unavailable."}\r\n`)};
  terminalPanels.set(p.id,{term:t,fit:f,host,state,start}); await start();
  /* Plain terminals stay plain shells. They used to auto-enter crowe-logic,
     which made every terminal a Crowe Logic CLI whether the operator wanted
     one or not - and left no ordinary shell to run anything else from. The
     agent panel is the one place the CLI is entered for you. */
  t.onData((data)=>window.crowe.pty.input(p.id,data));
  tools.querySelector(".term-restart").onclick=async()=>{await window.crowe.pty.close(p.id);t.reset();await start()};
  tools.querySelector(".term-clear").onclick=()=>t.clear();
  tools.querySelector(".term-copy").onclick=()=>navigator.clipboard.writeText(t.getSelection()||"");
  tools.querySelector(".term-export").onclick=()=>navigator.clipboard.writeText(t.buffer.active.getLine(0)?Array.from({length:t.buffer.active.length},(_,i)=>t.buffer.active.getLine(i)?.translateToString(true)||"").join("\n"):"");
  setTimeout(()=>fitTerminals(),40);
}
window.crowe.pty.onData(({id,data})=>{const x=terminalPanels.get(id);if(x)x.term.write(data)});
function fitTerminals(){for(const [id,x] of terminalPanels){try{x.fit.fit();window.crowe.pty.resize({id,cols:x.term.cols,rows:x.term.rows})}catch{}}}
async function mountWorkspaceAgent(p, body, seed={}) {
  body.classList.add("workspace-agent-node");
  body.innerHTML = `<div class="agent-operation-head"><div class="agent-mark" role="img" aria-label="Crowe Logic"></div><div><small>CROWE LOGIC CLI AGENT</small><strong class="agent-operation-state">Booting runtime</strong></div><span class="agent-operation-chip" data-state="booting">BOOTING</span></div><div class="agent-event-stream" aria-live="polite"></div><div class="agent-terminal-slot"></div><form class="agent-command-dock"><textarea rows="2" placeholder="Assign an objective to this agent..."></textarea><button type="submit" class="primary sm">Run</button><button type="button" class="agent-interrupt ghost sm">Interrupt</button></form>`;
  const slot=body.querySelector(".agent-terminal-slot");
  const cs=getComputedStyle(document.body),tok=n=>cs.getPropertyValue(n).trim();
  const t=new Terminal({fontFamily:"JetBrains Mono, ui-monospace, Menlo, monospace",fontSize:12,cursorBlink:true,scrollback:5000,theme:{background:tok("--term-bg")||tok("--cream"),foreground:tok("--term-fg")||tok("--ink"),cursor:tok("--gold"),selectionBackground:tok("--accent-wash")||"rgba(184,137,58,.28)"}});
  const f=new FitAddon.FitAddon();t.loadAddon(f);t.open(slot);try{f.fit()}catch{}
  const status=body.querySelector(".agent-operation-state"),chip=body.querySelector(".agent-operation-chip"),events=body.querySelector(".agent-event-stream");
  /* The same CroweMark the header wears, at panel size. The panel used to draw
     its own radial while the header drew a cube, both calling it "reasoning". */
  const mark=window.CroweMark?CroweMark.mount(body.querySelector(".agent-mark"),{state:"idle"}):{setState(){},ping(){}};
  const pingMark=()=>mark.ping();
  /* One call moves the chip, its label and the mark together. They were
     separate before, which let the chip keep reading ACTIVE in red after the
     runtime had already failed. */
  const CHIP={booting:"BOOTING",running:"ACTIVE",verified:"DONE",waiting:"PAUSED",failed:"OFFLINE",idle:"READY"};
  const setState=(chipState,markState,label)=>{chip.dataset.state=chipState;chip.textContent=CHIP[chipState]||chipState.toUpperCase();mark.setState(markState);if(label)status.textContent=label};
  const addEvent=(kind,text)=>{const row=document.createElement("div");row.className=`agent-event agent-event-${kind}`;row.innerHTML=`<span>${esc(kind)}</span><code>${esc(text)}</code>`;events.appendChild(row);events.scrollTop=events.scrollHeight};
  /* This panel is the one place the Crowe Logic CLI is entered for you. When
     the tier withholds the shell the dock still works - the objective runs on
     the gateway - so this is a degraded panel, not a dead one. */
  const start=async()=>{const r=await window.crowe.pty.start({id:p.id,cols:t.cols,rows:t.rows});if(r?.ok!==false){window.crowe.pty.input(p.id,"crowe-logic\r");setState("idle","idle","Crowe Logic CLI ready");addEvent("runtime","crowe-logic entered automatically")}else{setState("idle","idle","Gateway only - no shell at this tier");addEvent("runtime",r?.error||"shell unavailable");t.write(`\r\n  ${r?.error||"Shell unavailable."}\r\n`)}};
  terminalPanels.set(p.id,{term:t,fit:f,host:slot,state:status,start});await start();
  t.onData(data=>window.crowe.pty.input(p.id,data));
  const form=body.querySelector(".agent-command-dock"),box=form.querySelector("textarea"),run=form.querySelector('button[type="submit"]');let running=false;
  /* The dock runs the objective on the gateway agent, and only there. It used
     to also type the objective into the PTY, so every task ran twice - two
     bills, two sets of side effects on the same working tree. The terminal
     below stays interactive for anything the operator wants to run by hand. */
  form.onsubmit=async e=>{e.preventDefault();const task=box.value.trim();if(!task||running)return;running=true;setState("running","reasoning","Reasoning and executing");addEvent("input",task);box.value="";run.disabled=true;let answer="";const off=window.crowe.agent.onEvent(ev=>{if(ev.agentId!==p.id)return;if(ev.type==="tool_call"){status.textContent=`Running ${ev.name||"tool"}`;pingMark();addEvent("tool",ev.name||"tool")}else if(ev.type==="assistant"||ev.type==="assistant_delta")answer+=ev.text||"";else if(ev.type==="error")addEvent("error",ev.text||"failed")});try{const r=await window.crowe.agent.run([{role:"user",content:task}],p.id,{licensed:p.licensed,workspaceId:p.workspaceId});answer=answer||r?.text||"Completed";addEvent("verified",answer.slice(0,500));setState("verified","idle","Verified")}catch(err){addEvent("error",err.message||String(err));setState("failed","failed","Needs attention")}finally{off();running=false;run.disabled=false}};
  /* Interrupt stops the agent run, not the terminal. It used to also send
     Ctrl-C to the PTY, killing whatever the operator had running by hand for
     a run that was never happening there. Ctrl-C in the terminal still works. */
  body.querySelector(".agent-interrupt").onclick=()=>{window.crowe.agent.stop(p.id);setState("waiting","idle","Interrupted");addEvent("status","operator interrupted the agent run")};
  new ResizeObserver(()=>{try{f.fit();window.crowe.pty.resize({id:p.id,cols:t.cols,rows:t.rows})}catch{}}).observe(slot);
}

function mountBrowser(p, body) {
  body.style.position="relative";
  const bar=document.createElement("div");bar.className="browser-tools";
  bar.innerHTML='<button class="back ghost sm" title="Back">Back</button><button class="forward ghost sm" title="Forward">Next</button><button class="reload ghost sm" title="Reload">Reload</button><button class="hist ghost sm" title="History">History</button><button class="bookmark ghost sm" title="Bookmark page">Bookmark</button><button class="bookmarks ghost sm" title="Bookmarks">Saved</button><input class="browser-url" spellcheck="false" aria-label="Address"><button class="go ghost sm">Go</button>';
  const hist=document.createElement("div");hist.className="browser-history hidden";
  const host=document.createElement("div");host.className="browser-host";const w=document.createElement("webview");w.setAttribute("allowpopups","");host.appendChild(w);body.append(bar,hist,host);
  const input=bar.querySelector("input");
  const go=(u)=>{u=String(u||"").trim();if(!/^https?:\/\//i.test(u))u="https://"+u;w.src=u;input.value=u};
  const showList=(items,kind)=>{hist.innerHTML="";const head=document.createElement("div");head.className="browser-list-head";head.innerHTML=`<b>${kind}</b><button class="ghost sm">Clear</button>`;head.querySelector("button").onclick=()=>{if(kind==="History")p.history=[];else p.bookmarks=[];savePanelState();hist.classList.add("hidden")};hist.appendChild(head);[...items].reverse().forEach((u)=>{const row=document.createElement("div");row.className="history-row";const b=document.createElement("button");b.textContent=u;b.onclick=()=>{go(u);hist.classList.add("hidden")};row.appendChild(b);if(kind==="Bookmarks"){const del=document.createElement("button");del.textContent="Remove";del.className="ghost sm";del.onclick=()=>{p.bookmarks=p.bookmarks.filter((x)=>x!==u);savePanelState();showList(p.bookmarks,kind)};row.appendChild(del)}hist.appendChild(row)});hist.classList.remove("hidden")};
  bar.querySelector(".back").onclick=()=>w.canGoBack()&&w.goBack();bar.querySelector(".forward").onclick=()=>w.canGoForward()&&w.goForward();bar.querySelector(".reload").onclick=()=>w.reload();bar.querySelector(".hist").onclick=()=>showList(p.history,"History");bar.querySelector(".bookmark").onclick=()=>{const u=w.getURL()||p.url;if(u&&!p.bookmarks.includes(u))p.bookmarks.push(u);savePanelState()};bar.querySelector(".bookmarks").onclick=()=>showList(p.bookmarks,"Bookmarks");bar.querySelector(".go").onclick=()=>go(input.value);input.onkeydown=(e)=>{if(e.key==="Enter")go(input.value)};
  const navigated=()=>{const u=w.getURL();if(!u)return;input.value=u;p.url=u;if(p.history[p.history.length-1]!==u)p.history.push(u);p.history=p.history.slice(-100);savePanelState()};
  w.addEventListener("did-navigate",navigated);w.addEventListener("did-navigate-in-page",navigated);go(p.url);
}
const WORKFLOW_TEMPLATES=[
  {name:"Service Call Recovery",nodes:[{name:"Call Intake",prompt:"Review the customer request, identify urgency, trade, location, and missing details."},{name:"Dispatch Planner",prompt:"Create the best booking and dispatch plan from this request."},{name:"Customer Follow-up",prompt:"Write a concise confirmation and next-step message for the customer."}]},
  {name:"Customer Operations",nodes:[{name:"Account Review",prompt:"Summarize the customer account, open issues, and immediate risks."},{name:"Resolution Agent",prompt:"Propose the fastest complete resolution with clear owners."},{name:"Quality Check",prompt:"Audit the proposed resolution for omissions and customer impact."}]},
];
function workflowStore(){try{return JSON.parse(localStorage.getItem("crowe-agent-workflows")||"[]")}catch{return []}}
function saveWorkflowStore(items){localStorage.setItem("crowe-agent-workflows",JSON.stringify(items))}
function mountWorkflow(p, body) {
  body.classList.add("workflow-surface");
  let workflows=workflowStore(), active=workflows[0]||{id:`wf-${Date.now().toString(36)}`,name:"New agent workflow",nodes:[],runs:[]};
  if(!workflows.length){workflows=[active];saveWorkflowStore(workflows)}
  body.innerHTML='<aside class="workflow-sidebar"><div class="workflow-brand"><span class="workflow-icon">WF</span><div><small>ORCHESTRATION</small><b>Agent Runbook</b></div></div><button class="wf-new ghost sm">New workflow</button><div class="wf-list"></div><div class="wf-templates"><small>TEMPLATES</small></div><button class="wf-add ghost sm">+ Add agent node</button><button class="wf-run primary">Run workflow</button><button class="wf-abort danger hidden">Abort run</button></aside><main class="workflow-main"><header><div><input class="wf-name" aria-label="Workflow name"><span class="wf-status">Draft</span></div><p>Compose Crowe Agents into a reusable customer operation. Nodes run in parallel and combine into a final result.</p></header><div class="wf-canvas"></div><section class="wf-output"><div><b>Run output</b><button class="wf-copy ghost sm">Copy</button></div><pre>Select Run workflow to begin.</pre></section></main>';
  let aborted=false;
  const persist=()=>{const i=workflows.findIndex(x=>x.id===active.id);if(i<0)workflows.unshift(active);else workflows[i]=active;saveWorkflowStore(workflows)};
  const renderList=()=>{body.querySelector(".wf-list").innerHTML=workflows.map(w=>`<button data-id="${esc(w.id)}" class="${w.id===active.id?"active":""}"><b>${esc(w.name)}</b><small>${w.nodes.length} agents · ${(w.runs||[]).length} runs</small></button>`).join("");body.querySelectorAll(".wf-list button").forEach(b=>b.onclick=()=>{active=workflows.find(w=>w.id===b.dataset.id);render()})};
  const renderNodes=()=>{const canvas=body.querySelector(".wf-canvas");canvas.innerHTML=active.nodes.length?active.nodes.map((n,i)=>`<article class="wf-node" data-index="${i}"><div class="wf-node-top"><span>${String(i+1).padStart(2,"0")}</span><input class="wf-node-name" value="${esc(n.name)}" aria-label="Agent node name"><button class="wf-node-remove ghost sm">Remove</button></div><label>Agent instructions<textarea class="wf-node-prompt" rows="4">${esc(n.prompt)}</textarea></label><div class="wf-node-foot"><span class="wf-node-dot"></span><small>Ready · independent parallel agent</small></div></article>`).join('<div class="wf-connector">+</div>'):'<div class="wf-empty"><b>Build an agent workflow</b><span>Add parallel agent nodes or start from a customer operations template.</span></div>';
    canvas.querySelectorAll(".wf-node").forEach(card=>{const i=+card.dataset.index;card.querySelector(".wf-node-name").onchange=e=>{active.nodes[i].name=e.target.value;persist();renderList()};card.querySelector(".wf-node-prompt").onchange=e=>{active.nodes[i].prompt=e.target.value;persist()};card.querySelector(".wf-node-remove").onclick=()=>{active.nodes.splice(i,1);persist();renderNodes()}});
  };
  const render=()=>{body.querySelector(".wf-name").value=active.name;renderList();renderNodes()};
  body.querySelector(".wf-name").onchange=e=>{active.name=e.target.value||"Untitled workflow";persist();renderList()};
  body.querySelector(".wf-new").onclick=()=>{active={id:`wf-${Date.now().toString(36)}`,name:"New agent workflow",nodes:[],runs:[]};workflows.unshift(active);persist();render()};
  WORKFLOW_TEMPLATES.forEach(t=>{const b=document.createElement("button");b.className="wf-template";b.innerHTML=`<b>${esc(t.name)}</b><small>${t.nodes.length} parallel agents</small>`;b.onclick=()=>{active={id:`wf-${Date.now().toString(36)}`,name:t.name,nodes:t.nodes.map(n=>({...n})),runs:[]};workflows.unshift(active);persist();render()};body.querySelector(".wf-templates").appendChild(b)});
  body.querySelector(".wf-add").onclick=()=>{active.nodes.push({name:`Crowe Agent ${active.nodes.length+1}`,prompt:"Describe this agent's responsibility and expected output."});persist();renderNodes();renderList()};
  const abort=body.querySelector(".wf-abort"),run=body.querySelector(".wf-run"),status=body.querySelector(".wf-status"),out=body.querySelector(".wf-output pre");
  abort.onclick=()=>{aborted=true;active.nodes.forEach((_,i)=>window.crowe.agent.stop(`${p.id}-${i}`));status.textContent="Aborted"};
  run.onclick=async()=>{if(!active.nodes.length)return;aborted=false;run.classList.add("hidden");abort.classList.remove("hidden");status.textContent="Running";out.textContent="Launching parallel agents...";body.querySelectorAll(".wf-node-dot").forEach(x=>x.classList.add("running"));
    const results=await Promise.all(active.nodes.map(async(n,i)=>{let text="";const id=`${p.id}-${i}`;const off=window.crowe.agent.onEvent(ev=>{if(ev.agentId===id&&(ev.type==="assistant"||ev.type==="assistant_delta"))text+=(ev.text||"")});try{const r=await window.crowe.agent.run([{role:"user",content:n.prompt}],id);return {name:n.name,text:text||(r&&r.text)||"Completed."}}catch(e){return {name:n.name,text:`Failed: ${e.message||e}`}}finally{off()}}));
    body.querySelectorAll(".wf-node-dot").forEach(x=>{x.classList.remove("running");x.classList.add(aborted?"failed":"done")});const report=results.map(r=>`## ${r.name}\n\n${r.text}`).join("\n\n");out.textContent=report;active.runs.unshift({at:Date.now(),status:aborted?"aborted":"completed",output:report});active.runs=active.runs.slice(0,20);persist();status.textContent=aborted?"Aborted":"Completed";run.classList.remove("hidden");abort.classList.add("hidden");renderList()};
  body.querySelector(".wf-copy").onclick=e=>copyText(out.textContent,e.currentTarget);render();
}
function mountAgentFleet(p, body) {
  const agents=[
    {name:"Call Intake",role:"Answers, qualifies, and captures every service request",prompt:"Act as a call-intake agent. Qualify this service request and identify the next action."},
    {name:"Dispatch",role:"Books jobs and coordinates field schedules",prompt:"Act as a dispatch coordinator. Build a booking and dispatch plan for this request."},
    {name:"Customer Success",role:"Handles follow-up, updates, and retention",prompt:"Act as a customer-success agent. Draft the right follow-up and retention action."},
    {name:"Operations Analyst",role:"Finds missed revenue and operational leakage",prompt:"Act as an operations analyst. Identify revenue leakage, bottlenecks, and corrective actions."},
  ];
  body.classList.add("agent-fleet");body.innerHTML='<header class="fleet-hero"><div><small>CROWE AGENTS · CUSTOMER CONTROL PLANE</small><h2>Your licensed agent workforce</h2><p>Launch a terminal-backed specialist into the stackable workspace, combine agents in Workflows, or manage the live service at croweagents.com.</p></div><button class="fleet-site primary">Open Crowe Agents</button></header><div class="fleet-license"><span class="health-dot"></span><div><b>Checking workspace license</b><small>Connecting identity, entitlements, and usage.</small></div><select class="fleet-workspace" aria-label="Licensed workspace"></select><button class="fleet-refresh ghost sm">Refresh</button><button class="fleet-billing ghost sm">Manage billing</button><span class="badge">Checking</span></div><div class="fleet-grid"></div>';
  body.querySelector(".fleet-site").onclick=()=>navigate("https://croweagents.com");body.querySelector(".fleet-billing").onclick=async()=>{const r=await window.crowe.license.billing();if(r?.error)alert(r.error)};const grid=body.querySelector(".fleet-grid"),license=body.querySelector(".fleet-license"),workspaceSelect=body.querySelector(".fleet-workspace");let licensed=false,workspaceId="";
  const renderLicense=async()=>{license.querySelector("b").textContent="Checking workspace license";const status=await window.crowe.license.status();workspaceSelect.innerHTML=(status.workspaces||[]).map(x=>`<option value="${esc(x.id)}">${esc(x.name||x.id)}</option>`).join("");workspaceId=status.selectedWorkspaceId||status.workspaces?.[0]?.id||"";workspaceSelect.value=workspaceId;const workspace=status.workspaces?.find(x=>x.id===workspaceId),allowed=Boolean(workspace?.agents?.allowed);licensed=allowed;workspaceSelect.disabled=!status.workspaces?.length;license.querySelector(".health-dot").classList.toggle("ok",allowed);license.querySelector("b").textContent=!status.authenticated?"Sign in to Crowe ID":allowed?`${workspace.name||workspace.id} license active`:status.error||"Agent license required";license.querySelector("small").textContent=allowed?`${workspace.plan_id||"Managed"} plan · ${workspace.usage?.agent_jobs||0} agent jobs this period`:"Licensed agents remain locked until an active workspace entitlement is found.";license.querySelector(".badge").textContent=allowed?"Licensed":"Locked";grid.querySelectorAll(".launch,.workflow").forEach(button=>button.disabled=!allowed)};
  workspaceSelect.onchange=async()=>{await window.crowe.license.select(workspaceSelect.value);renderLicense()};body.querySelector(".fleet-refresh").onclick=renderLicense;
  agents.forEach(a=>{const card=document.createElement("article");card.className="fleet-card";card.innerHTML=`<div class="fleet-avatar">${a.name.split(" ").map(x=>x[0]).join("")}</div><div class="fleet-state"><span></span>Licensed service</div><h3>${esc(a.name)}</h3><p>${esc(a.role)}</p><div><button class="launch primary sm" disabled>Launch agent</button><button class="workflow ghost sm" disabled>Add to workflow</button></div>`;card.querySelector(".launch").onclick=()=>{if(!licensed)return;addPanel("agent",{title:a.name,licensed:true,workspaceId,prompt:a.prompt})};card.querySelector(".workflow").onclick=()=>{if(licensed)addPanel("workflow",{title:`${a.name} Workflow`})};grid.appendChild(card)});renderLicense();
}
// Parallel synthesis: each branch answers the same task from a different angle,
// then one synthesis pass merges the drafts into a single answer.
const SYNTH_LENSES=[
  {name:"Conventional",brief:"Take the most direct, conventional approach. Prioritize correctness and completeness."},
  {name:"Contrarian",brief:"Take a contrarian angle: challenge the assumptions in the task and surface the risks and failure modes a conventional answer would miss."},
  {name:"Pragmatic",brief:"Optimize for practical constraints — cost, time, and what can ship soonest. Be concrete about the tradeoffs you accept."},
  {name:"First principles",brief:"Reason from first principles. Ignore convention and work forward from the underlying goal."},
];
function workbenchPresets(){try{return JSON.parse(localStorage.getItem("crowe-workbench-presets")||"[]")}catch{return []}}
function workbenchHistory(){try{return JSON.parse(localStorage.getItem("crowe-workbench-history")||"[]")}catch{return []}}
function mountWorkbench(p, body) {
  body.classList.add("agent-workbench");
  body.innerHTML='<aside class="awb-sidebar"><div class="awb-brand"><img src="../assets/mark-simple.svg" alt=""><div><small>AGENT LAB</small><b>Workbench</b></div></div><button class="awb-new primary sm">New run</button><div class="awb-presets"></div><div class="awb-history"></div></aside><main class="awb-main"><header><div><small>COMPOSE, TEST, SHIP</small><h2>Agent Workbench</h2></div><span class="awb-run-state">Ready</span></header><div class="awb-controls"><label>Agent<select class="awb-agent"><option>CroweLM Operator</option><option>Research Agent</option><option>Builder Agent</option><option>Operations Analyst</option></select></label><label>Mode<select class="awb-mode"><option value="single">Single run</option><option value="compare">Compare two agents</option><option value="parallel">Parallel synthesis</option></select></label><label>Context<input class="awb-context" placeholder="URLs, customer context, or constraints"></label></div><details class="awb-advanced"><summary>Run controls</summary><div><label>Temperature<input class="awb-temp" type="range" min="0" max="1" step="0.1" value="0.4"><output>0.4</output></label><label>Output format<select class="awb-format"><option>Markdown</option><option>JSON</option><option>Plain text</option></select></label><label class="awb-tools"><input type="checkbox" checked> Allow workspace tools</label><label class="awb-branch-field">Branches<select class="awb-branches"><option>2</option><option selected>3</option><option>4</option></select></label></div></details><div class="awb-attachments"><button class="awb-attach ghost sm">Attach files</button><span>No attachments</span><div></div></div><textarea class="awb-prompt" rows="7" placeholder="Describe the outcome, constraints, tools, and expected output..."></textarea><div class="awb-actions"><button class="awb-run primary">Run workbench</button><button class="awb-cancel danger hidden">Cancel run</button><button class="awb-save ghost">Save preset</button><button class="awb-copy ghost">Copy outputs</button><button class="awb-workflow ghost">Make workflow</button></div><div class="awb-meter"><span>0 tokens</span><span>$0.0000</span></div><section class="awb-results"></section></main>';
  const prompt=body.querySelector(".awb-prompt"),context=body.querySelector(".awb-context"),mode=body.querySelector(".awb-mode"),state=body.querySelector(".awb-run-state"),results=body.querySelector(".awb-results"),branches=body.querySelector(".awb-branches"),branchField=body.querySelector(".awb-branch-field"),runBtn=body.querySelector(".awb-run"),cancelBtn=body.querySelector(".awb-cancel");
  let attachments=[],runIds=[],usage={tokens:0,cost:0},outputs=[],cancelled=false;
  const branchCount=()=>Math.max(2,Math.min(4,+branches.value||3));
  const shellSpecs=()=>mode.value==="parallel"
    ?[{title:"Synthesis",sub:`merged from ${branchCount()} branches`,cls:"awb-synthesis"},...Array.from({length:branchCount()},(_,i)=>({title:`Branch ${i+1}`,sub:SYNTH_LENSES[i%SYNTH_LENSES.length].name}))]
    :mode.value==="compare"?[{title:"Primary result",sub:"Agent A"},{title:"Comparison",sub:"Agent B"}]
    :[{title:"Primary result",sub:"Agent A"}];
  const renderShells=(placeholder="Results appear here.")=>{results.innerHTML=shellSpecs().map(s=>`<article class="${s.cls||""}"><header><b>${esc(s.title)}</b><span>${esc(s.sub)}</span></header><div class="awb-output">${esc(placeholder)}</div></article>`).join("");outputs=[...results.querySelectorAll(".awb-output")]};
  const syncMode=()=>{branchField.classList.toggle("hidden",mode.value!=="parallel");renderShells()};
  const cardTitle=x=>x.closest("article").querySelector("b").textContent;
  const runAgent=async(id,content)=>{let answer="";const off=window.crowe.agent.onEvent(ev=>{if(ev.agentId===id&&(ev.type==="assistant"||ev.type==="assistant_delta"))answer+=(ev.text||"")});try{const r=await window.crowe.agent.run([{role:"user",content}],id);return answer||(r&&r.text)||"Completed."}catch(e){return `Run failed: ${e.message||e}`}finally{off()}};
  const renderLibrary=()=>{const list=workbenchPresets(),runs=workbenchHistory();body.querySelector(".awb-presets").innerHTML='<small>SAVED CONFIGURATIONS</small>'+list.map((x,i)=>`<button data-i="${i}"><b>${esc(x.name)}</b><span>${esc(x.mode)}</span></button>`).join("");body.querySelector(".awb-history").innerHTML='<small>RUN HISTORY</small>'+runs.slice(0,10).map((x,i)=>`<button data-i="${i}"><b>${esc(x.name)}</b><span>${new Date(x.at).toLocaleString()}</span></button>`).join("");body.querySelectorAll(".awb-presets button").forEach(b=>b.onclick=()=>{const x=list[+b.dataset.i];prompt.value=x.prompt;context.value=x.context;mode.value=x.mode;syncMode()});body.querySelectorAll(".awb-history button").forEach(b=>b.onclick=()=>{const x=runs[+b.dataset.i];prompt.value=x.prompt;mode.value=x.mode;if(x.branches)branches.value=String(x.branches);syncMode();x.outputs.forEach((v,i)=>{if(outputs[i])outputs[i].innerHTML=md(v)})})};
  mode.onchange=syncMode;branches.onchange=syncMode;
  body.querySelector(".awb-temp").oninput=e=>e.target.nextElementSibling.value=e.target.value;
  body.querySelector(".awb-new").onclick=()=>{prompt.value="";context.value="";mode.value="single";attachments=[];body.querySelector(".awb-attachments span").textContent="No attachments";body.querySelector(".awb-attachments div").innerHTML="";syncMode()};
  body.querySelector(".awb-attach").onclick=async()=>{attachments=await window.crowe.fs.pick();body.querySelector(".awb-attachments span").textContent=attachments.length?`${attachments.length} file${attachments.length===1?"":"s"} attached`:"No attachments";body.querySelector(".awb-attachments div").innerHTML=attachments.map(x=>`<span title="${esc(x.path)}">${esc(x.name)}</span>`).join("")};
  body.querySelector(".awb-save").onclick=()=>{const name=prompt.value.trim().split(/\s+/).slice(0,6).join(" ")||"Untitled preset",items=workbenchPresets();items.unshift({name,prompt:prompt.value,context:context.value,mode:mode.value});localStorage.setItem("crowe-workbench-presets",JSON.stringify(items.slice(0,30)));renderLibrary()};
  body.querySelector(".awb-copy").onclick=e=>copyText(outputs.map(x=>`## ${cardTitle(x)}\n\n${x.textContent}`).join("\n\n"),e.currentTarget);
  body.querySelector(".awb-workflow").onclick=()=>{const tasks=outputs.map(x=>({name:cardTitle(x),prompt:x.textContent}));const workflows=workflowStore();workflows.unshift({id:`wf-${Date.now().toString(36)}`,name:prompt.value.trim().split(/\s+/).slice(0,5).join(" ")||"Workbench workflow",nodes:tasks,runs:[]});saveWorkflowStore(workflows);addPanel("workflow")};
  cancelBtn.onclick=()=>{cancelled=true;runIds.forEach(id=>window.crowe.agent.stop(id));state.textContent="Cancelled"};
  runBtn.onclick=async()=>{const task=prompt.value.trim();if(!task)return;cancelled=false;state.textContent="Running";runBtn.classList.add("hidden");cancelBtn.classList.remove("hidden");usage={tokens:0,cost:0};
    const parallel=mode.value==="parallel",count=parallel?branchCount():mode.value==="compare"?2:1;renderShells("Agent running...");
    let fileContext="";if(attachments.length){const files=await window.crowe.fs.readContext(attachments.map(x=>x.path));fileContext=files.map(x=>`File: ${x.path}\n${x.content||x.error}`).join("\n\n")}
    const format=body.querySelector(".awb-format").value,tools=body.querySelector(".awb-tools input").checked,stamp=Date.now();
    const branchIds=Array.from({length:count},(_,i)=>`${p.id}-run-${stamp}-${i}`),synthId=`${p.id}-run-${stamp}-synthesis`;
    runIds=parallel?[...branchIds,synthId]:branchIds;
    const off=window.crowe.agent.onEvent(ev=>{if(!runIds.includes(ev.agentId))return;if(ev.type==="telemetry"){usage.tokens+=(ev.promptTokens||0)+(ev.completionTokens||0);usage.cost+=(ev.cost||0);body.querySelector(".awb-meter").innerHTML=`<span>${usage.tokens.toLocaleString()} tokens</span><span>$${usage.cost.toFixed(4)}</span>`}});
    try{
      const head=[context.value.trim(),fileContext,`Output format: ${format}. Workspace tools: ${tools?"allowed":"not requested"}.`].filter(Boolean).join("\n\n");
      const cards=parallel?outputs.slice(1):outputs;
      // Branches stream into their own card as each finishes, so a slow branch never hides a fast one.
      const drafts=await Promise.all(branchIds.map(async(id,i)=>{const lens=parallel?SYNTH_LENSES[i%SYNTH_LENSES.length].brief:i===1?"Provide an independent alternative approach.":"";const text=await runAgent(id,[head,task,lens].filter(Boolean).join("\n\n"));if(cards[i])cards[i].innerHTML=md(text);return text}));
      let stored=drafts;
      if(parallel){
        if(cancelled)outputs[0].textContent="Cancelled before synthesis.";
        else{
          outputs[0].textContent="Synthesizing branches...";
          const brief=drafts.map((d,i)=>`### Branch ${i+1} — ${SYNTH_LENSES[i%SYNTH_LENSES.length].name}\n\n${d}`).join("\n\n");
          const synth=await runAgent(synthId,[head,`Task:\n\n${task}`,`${count} agents answered that task independently, each from a different angle. Their drafts:`,brief,"Merge the drafts into one answer. Keep the strongest reasoning from each branch, state plainly where the branches disagree and which side is right, and drop any claim no branch supports. Return the merged answer only — do not narrate the merge."].join("\n\n"));
          outputs[0].innerHTML=md(synth);stored=[synth,...drafts];
        }
      }
      const history=workbenchHistory();history.unshift({at:Date.now(),name:task.split(/\s+/).slice(0,6).join(" "),prompt:task,mode:mode.value,branches:count,outputs:stored,usage});localStorage.setItem("crowe-workbench-history",JSON.stringify(history.slice(0,50)));
      if(!cancelled)state.textContent="Completed";renderLibrary()
    }finally{off();runIds=[];runBtn.classList.remove("hidden");cancelBtn.classList.add("hidden")}};
  renderLibrary();syncMode();
}

function mountOperator(p, body) {
  body.innerHTML='<div class="operator-health"><span class="health-dot"></span><b>Operator service</b><span class="health-label">checking</span></div><div class="operator-grid"></div><div class="operator-lists"><section><b>Active agents</b><div class="agent-list">None</div></section><section><b>Active terminals</b><div class="terminal-list">None</div></section></div><div class="operator-actions"><button class="refresh primary sm">Refresh</button><button class="stop-agent ghost sm">Stop main agent</button><button class="stop-voice ghost sm">Stop voice</button><button class="emergency danger sm">Emergency stop all</button></div>';
  const refresh=async()=>{const x=await window.crowe.operator.status();const scalar=Object.entries(x).filter(([,v])=>!Array.isArray(v));body.querySelector(".operator-grid").innerHTML=scalar.map(([k,v])=>`<div class="operator-stat">${esc(k)}<b>${esc(v)}</b></div>`).join("");body.querySelector(".agent-list").textContent=(x.agentIds||[]).join(", ")||"None";body.querySelector(".terminal-list").textContent=(x.terminalIds||[]).join(", ")||"None";body.querySelector(".health-label").textContent=x.app||"unavailable";body.querySelector(".health-dot").classList.toggle("ok",x.app==="running")};
  body.querySelector(".refresh").onclick=refresh;body.querySelector(".stop-agent").onclick=async()=>{await window.crowe.agent.stop();refresh()};body.querySelector(".stop-voice").onclick=()=>speechSynthesis.cancel();body.querySelector(".emergency").onclick=async()=>{if(!confirm("Stop every agent and terminal process?"))return;await window.crowe.operator.stopAll();speechSynthesis.cancel();for(const x of terminalPanels.values())x.state.textContent="stopped";refresh()};refresh();p.operatorTimer=setInterval(()=>{if(document.body.contains(body))refresh();else clearInterval(p.operatorTimer)},5000);
}
function closePanel(id){const i=panels.findIndex((p)=>p.id===id);if(i<0)return;const p=panels[i];if(p.type==="terminal"||p.type==="system"||p.type==="agent"){window.crowe.pty.close(id);const x=terminalPanels.get(id);if(x)x.term.dispose();terminalPanels.delete(id)}if(p.operatorTimer)clearInterval(p.operatorTimer);panels.splice(i,1);panelDeck.querySelector(`[data-id="${id}"]`)?.remove();if(activePanelId===id)activePanelId=panels.length?panels[Math.min(i,panels.length-1)].id:null;savePanelState();renderDockTabs()}
function hideLegacy(){document.querySelectorAll(".legacy-pane-view").forEach((x)=>x.classList.remove("active"));activeLegacy=null;panelDeck.style.display="";if(typeof renderDockTabs==="function")renderDockTabs()}
function showPane(name){
  if(["files","git","output"].includes(name)){panelDeck.style.display="none";document.querySelectorAll(".legacy-pane-view").forEach((x)=>x.classList.toggle("active",x.id==="pane-"+name));activeLegacy=name;if(name==="git")loadGit();renderDockTabs();return}
  const type = name === "term" ? "terminal" : name;
  hideLegacy();
  const found = [...panels].reverse().find((p)=>p.type===type);
  if(found) focusPanel(found.id); else addPanel(type).then((p)=>focusPanel(p.id));
}
function switchPane(name){showPane(name);setRailActive(name)}
function navigate(u){hideLegacy();let p=[...panels].reverse().find((x)=>x.type==="browser");if(!p){addPanel("browser",{url:u});return}const el=panelDeck.querySelector(`[data-id="${p.id}"]`);const input=el?.querySelector("input.browser-url");if(input){input.value=u;el.querySelector(".go").click()}}
$("panel-add-term").onclick=()=>addPanel("terminal");$("panel-add-agent").onclick=()=>addPanel("agent",{title:`Crowe Logic Agent ${panels.filter(p=>p.type==="agent").length+1}`});$("panel-add-system").onclick=()=>{const existing=panels.find(p=>p.type==="system");if(existing){focusPanel(existing.id);return}addPanel("system")};$("panel-add-browser").onclick=()=>addPanel("browser");$("panel-add-operator").onclick=()=>addPanel("operator");$("panel-add-workflow").onclick=()=>addPanel("workflow");$("panel-add-agents").onclick=()=>addPanel("agents");$("panel-add-workbench").onclick=()=>addPanel("workbench");
$("panel-layout").onchange=()=>{panelDeck.className="panel-deck "+$("panel-layout").value;applyStackVisibility();savePanelState();setTimeout(fitTerminals,40)};
$("glass-launcher").onclick=()=>$("panel-add-agent").click();
document.querySelectorAll(".legacy-pane").forEach((b)=>b.onclick=()=>switchPane(b.dataset.pane));

// ── Dock: one tab strip for pinned views and every open panel ──
const dockTabs = $("dock-tabs");
const PANEL_GLYPH = { terminal:"Terminal", browser:"Browser", operator:"Operator", workflow:"Workflows", agents:"Agent fleet", workbench:"Workbench" };
function applyStackVisibility(){
  const stacked = panelDeck.classList.contains("stack");
  if (stacked && !panels.some((p)=>p.id===activePanelId)) activePanelId = panels.length ? panels[panels.length-1].id : null;
  panels.forEach((p)=>{
    const el = panelDeck.querySelector(`[data-id="${p.id}"]`);
    if (el) el.classList.toggle("stack-active", !stacked || p.id===activePanelId);
  });
}
function focusPanel(id){
  hideLegacy();
  setRailActive(null);
  activePanelId = id;
  applyStackVisibility();
  const el = panelDeck.querySelector(`[data-id="${id}"]`);
  if (el && !panelDeck.classList.contains("stack")) el.scrollIntoView({ behavior:"smooth", block:"nearest", inline:"nearest" });
  renderDockTabs();
  setTimeout(fitTerminals, 40);
}
function renderDockTabs(){
  if (!dockTabs) return;
  dockTabs.querySelectorAll(".dock-tab.panel-tab").forEach((x)=>x.remove());
  panels.forEach((p)=>{
    const t = document.createElement("button");
    const isActive = !activeLegacy && p.id === activePanelId;
    t.className = "dock-tab panel-tab" + (isActive ? " active" : "");
    if (isActive) t.setAttribute("aria-current", "true");
    t.dataset.id = p.id;
    t.title = PANEL_GLYPH[p.type] || p.title;
    t.innerHTML = `<span class="dock-tab-label"></span><span class="dock-tab-close" role="button" aria-label="Close panel">&times;</span>`;
    t.querySelector(".dock-tab-label").textContent = p.title;
    t.addEventListener("click",(e)=>{ if (e.target.closest(".dock-tab-close")) { closePanel(p.id); return; } focusPanel(p.id); });
    dockTabs.appendChild(t);
  });
  dockTabs.classList.toggle("has-panels", panels.length > 0);
  const active = dockTabs.querySelector(".dock-tab.panel-tab.active");
  if (active) active.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// Add-to-panel palette. The panel-add-* buttons live inside it, so their
// existing handlers keep working and the overlay just closes behind them.
const addPanelModal = $("addpanel");
function openAddPanel(){ addPanelModal.classList.remove("hidden"); }
function closeAddPanel(){ addPanelModal.classList.add("hidden"); }
$("dock-add").addEventListener("click", openAddPanel);
addPanelModal.addEventListener("click",(e)=>{ if (e.target === addPanelModal) closeAddPanel(); });
addPanelModal.querySelectorAll(".pal-row").forEach((b)=>b.addEventListener("click", closeAddPanel));
document.addEventListener("keydown",(e)=>{ if (e.key === "Escape" && !addPanelModal.classList.contains("hidden")) closeAddPanel(); });

const dockOverflow = $("dock-overflow");
$("dock-menu").addEventListener("click",(e)=>{ e.stopPropagation(); dockOverflow.classList.toggle("hidden"); });
document.addEventListener("click",(e)=>{ if (!dockOverflow.contains(e.target) && !e.target.closest("#dock-menu")) dockOverflow.classList.add("hidden"); });

window.addEventListener("resize",()=>{clampWorkbenchSplit();fitTerminals()});
async function restorePanels(){let st;try{st=JSON.parse(localStorage.getItem("crowe-workspace-panels")||"null")}catch{};st=st||{layout:"stack",panels:[{type:"terminal"}]};$("panel-layout").value=st.layout||"stack";panelDeck.className="panel-deck "+$("panel-layout").value;for(const p of(st.panels||[]))await addPanel(p.type,p);if(!panels.length)await addPanel("terminal");applyStackVisibility();renderDockTabs()}

// ── Voice input and TTS ──
let recognition=null;
$("voice-input").onclick=()=>{const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR){appendOutput("voice: speech recognition is unavailable on this system");return}if(recognition){recognition.stop();return}recognition=new SR();recognition.continuous=true;recognition.interimResults=true;recognition.onstart=()=>$("voice-input").classList.add("active");recognition.onresult=(e)=>{let text="";for(let i=e.resultIndex;i<e.results.length;i++)text+=e.results[i][0].transcript;input.value=(input.value+" "+text).trim();input.dispatchEvent(new Event("input"))};recognition.onend=()=>{$("voice-input").classList.remove("active");recognition=null};recognition.onerror=(e)=>appendOutput("voice: "+e.error);recognition.start()};
$("voice-output").onclick=()=>{if(speechSynthesis.speaking){speechSynthesis.cancel();return}const said=[...document.querySelectorAll(".msg.assistant .said")].pop();if(!said)return;const u=new SpeechSynthesisUtterance(said.textContent);u.onstart=()=>$("voice-output").classList.add("active");u.onend=()=>$("voice-output").classList.remove("active");speechSynthesis.speak(u)};
window.crowe.onBrowserNavigate((u)=>{navigate(u)});

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
async function renderKeyManager(){
  const result=await window.crowe.keys.list(),host=$("key-provider-list"),vault=$("key-vault-state");
  vault.textContent=result.encrypted?"Native vault ready":"Vault unavailable";
  host.innerHTML=(result.providers||[]).map(x=>`<div class="key-provider" data-provider="${x.id}"><div><b>${esc(x.label)}</b><span>${x.configured?(x.healthy?"Connected · tested ":"Configured securely · ")+(x.testedAt?new Date(x.testedAt).toLocaleDateString():"not tested"):"Not configured"}</span></div><input type="password" autocomplete="new-password" spellcheck="false" placeholder="${x.configured?"Replace existing key":"Enter API key"}"><button class="key-save ghost sm">Save</button><button class="key-test ghost sm" ${x.configured?"":"disabled"}>Test</button><button class="key-remove ghost sm" ${x.configured?"":"disabled"}>Remove</button></div>`).join("");
  host.querySelectorAll(".key-provider").forEach(row=>{const id=row.dataset.provider,input=row.querySelector("input");row.querySelector(".key-save").onclick=async()=>{if(!input.value.trim())return;await window.crowe.keys.set(id,input.value.trim());input.value="";renderKeyManager()};row.querySelector(".key-test").onclick=async e=>{e.currentTarget.textContent="Testing";const r=await window.crowe.keys.test(id);e.currentTarget.textContent=r.ok?"Connected":"Failed"};row.querySelector(".key-remove").onclick=async()=>{if(!confirm(`Remove the ${id} credential from the native vault?`))return;await window.crowe.keys.remove(id);renderKeyManager()}});
}
$("settings-btn").addEventListener("click", async () => {
  const c = await window.crowe.getConfig();
  $("cfg-base").value = c.baseUrl; $("cfg-cwd").value = c.cwd || ""; $("cfg-token").value = "";
  $("cfg-auto").checked = Boolean(c.autoApprove);
  $("cfg-status").textContent = (c.hasToken ? "Token set. " : "No token yet. ") + (c.ptyAvailable ? "PTY ready." : "PTY unavailable.");
  renderPlugins(); renderKeyManager();
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
const MIN_AGENT_WIDTH = 300, MIN_WORKSPACE_WIDTH = 320;
function clampSplit(requested) {
  const rect = workbench.getBoundingClientRect();
  const shellRight = workbench.parentElement.getBoundingClientRect().right;
  const availableWidth = Math.max(0, shellRight - rect.left);
  const dividerWidth = divider.getBoundingClientRect().width || 5;
  const max = Math.max(0, availableWidth - dividerWidth - MIN_WORKSPACE_WIDTH);
  const min = Math.min(MIN_AGENT_WIDTH, max);
  return Math.min(Math.max(requested, min), max);
}
function setWorkbenchSplit(requested) {
  const px = clampSplit(requested);
  workbench.style.setProperty("--split", px + "px");
  return px;
}
function clampWorkbenchSplit() {
  const current = parseFloat(workbench.style.getPropertyValue("--split"));
  if (Number.isFinite(current)) setWorkbenchSplit(current);
}
divider.addEventListener("mousedown", (e) => {
  e.preventDefault(); divider.classList.add("dragging");
  const move = (ev) => {
    const rect = workbench.getBoundingClientRect();
    setWorkbenchSplit(ev.clientX - rect.left);
  };
  const up = () => { divider.classList.remove("dragging"); fitTerminals();
    window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
});

// ── Dark mode ──
// The terminal is the one surface xterm paints itself, so it cannot inherit
// the CSS variables. Read them instead, and re-read on every theme flip.
function termTheme() {
  const s = getComputedStyle(document.body);
  const v = (name, fallback) => (s.getPropertyValue(name) || "").trim() || fallback;
  return {
    background: v("--term-bg", "#0b0e12"),
    foreground: v("--term-fg", "#eceae4"),
    cursor: v("--gold", "#d2ad62"),
    selectionBackground: v("--line-strong", "rgba(255,255,255,0.16)"),
  };
}

function applyTheme(dark) {
  document.body.classList.toggle("dark", dark);
  const themeLabel = $("theme-btn").querySelector(".side-foot-label");
  if (themeLabel) themeLabel.textContent = dark ? "Light" : "Dark";
  try { localStorage.setItem("crowe-theme", dark ? "dark" : "light"); } catch {}
  const theme = termTheme();
  terminalPanels.forEach((t) => { try { t.term.options.theme = theme; } catch {} });
  if (window.CroweMark) CroweMark.reseed();  // re-anchor the living tokens to the new theme's family
}
$("theme-btn").addEventListener("click", () => applyTheme(!document.body.classList.contains("dark")));
// Dark console is the canonical app surface; light remains one click away.
try { applyTheme(localStorage.getItem("crowe-theme") !== "light"); } catch { applyTheme(true); }

// ── Sidebar collapse ──
// Terminals are sized to their container, so the deck has to be refitted once
// the width transition finishes or xterm keeps the old column count.
function applySidebarCollapsed(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  const toggle = $("sidebar-toggle");
  if (toggle) toggle.setAttribute("aria-expanded", String(!collapsed));
  try { localStorage.setItem("crowe-sidebar", collapsed ? "collapsed" : "open"); } catch {}
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  setTimeout(fitTerminals, reduced ? 0 : 220);
}
$("sidebar-toggle").addEventListener("click", () =>
  applySidebarCollapsed(!document.body.classList.contains("sidebar-collapsed")));
try { applySidebarCollapsed(localStorage.getItem("crowe-sidebar") === "collapsed"); } catch {}

// ── Cmd+Enter to send ──
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(input.value); }
});

// ── Dock tabs ──
// aria-current marks the one active item in each nav set. The dock tabs stay
// plain buttons rather than role="tab", since they drive two different things
// (legacy panes and live panels) and have no single tabpanel to point at.
function setRailActive(pane) {
  document.querySelectorAll(".dock-tab[data-pane]").forEach((x) => {
    const on = x.dataset.pane === pane;
    x.classList.toggle("active", on);
    if (on) x.setAttribute("aria-current", "true"); else x.removeAttribute("aria-current");
  });
}
document.querySelectorAll(".dock-tab[data-pane]").forEach((b) => b.addEventListener("click", () => switchPane(b.dataset.pane)));

// ── New chat + sessions drawer ──
const drawer = $("sessions-drawer");
async function newChat() {
  await window.crowe.sessions.new();
  messages.length = 0;
  transcript.innerHTML = WELCOME_HTML; bindChips(); mountWelcomeMark();
  input.value = ""; input.style.height = "auto"; input.focus();
  drawer.classList.remove("hidden");
  renderSessions();
  sessionCost = 0; runCost = 0;
  $("hud-cost").textContent = fmtCost(0); $("hud-tok").textContent = "0 / 0 tok"; $("hud-tps").textContent = "";
}
$("rail-new").addEventListener("click", newChat);
$("sess-new").addEventListener("click", newChat);
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
    else if (m.role === "assistant" && m.content) { const b = addAssistant(); renderText(b, m.content); attachCopyButton(b.closest(".msg"), m.content); const s = b.querySelector(".said"); if (s) s.classList.remove("streaming"); any = true; }
  }
  if (!any) { transcript.innerHTML = WELCOME_HTML; bindChips(); mountWelcomeMark(); }
}

// ── Git / version control pane ──
$("git-refresh").addEventListener("click", loadGit);
$("git-pull").addEventListener("click", async () => {
  const r = await window.crowe.git.pull();
  if (!r || r.error || r.ok === false) { $("git-branch").textContent = (r && r.error) || "pull failed"; appendOutput("git pull failed: " + ((r && (r.out || r.error)) || "").slice(0, 400)); }
  else { $("git-branch").textContent = "pulled"; loadGit(); }
  statusTick();
});
$("git-push").addEventListener("click", async () => {
  const r = await window.crowe.git.push();
  if (!r || r.error || r.ok === false) { $("git-branch").textContent = (r && r.error) || "push failed"; appendOutput("git push failed: " + ((r && (r.out || r.error)) || "").slice(0, 400)); }
  else { $("git-branch").textContent = "pushed"; setTimeout(loadGit, 600); }
  statusTick();
});
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

// ── Spaces: Chat · Projects · Studio · Cultivation ──
// One operator thread underneath; a space is how much surface you see. Chat is
// today's workbench. Projects adds the grouped nav + Home control surface.
// Studio and Cultivation are launch surfaces that funnel into the same thread.
const SURFACES = { home: $("surface-home"), lane: $("surface-lane"), studio: $("surface-studio"), cultivation: $("surface-cultivation") };
let projLane = "home";
const LANES = {
  sessions: { title: "Sessions", sub: "Every conversation with the operator, resumable." },
  training: { title: "Training", sub: "Fine-tune runs for the CroweLM experts.", pending: "Endpoint pending — lands with the crowe-nimbus training API." },
  evals: { title: "Evals", sub: "Capability suites across the deployment fleet.", pending: "Endpoint pending — /api/gateway/evals is on the nimbus roadmap." },
  deployments: { title: "Deployments", sub: "Every model the gateway serves, with its routing flags." },
  storage: { title: "Storage", sub: "Releases, datasets, and artifacts.", pending: "R2 browser pending — release downloads are already live." },
};
function setSpace(name) {
  document.body.dataset.space = name;
  document.querySelectorAll("#spaces .seg-btn").forEach((b) => {
    const on = b.dataset.space === name;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
  });
  const showWb = name === "chat" || (name === "projects" && projLane === "deepwork");
  workbench.classList.toggle("hidden", !showWb);
  $("space-nav").classList.toggle("hidden", name !== "projects");
  drawer.classList.toggle("hidden", name !== "chat");
  Object.values(SURFACES).forEach((s) => s.classList.add("hidden"));
  if (name === "projects" && !showWb) {
    if (projLane === "home") { SURFACES.home.classList.remove("hidden"); refreshHome(); }
    else { SURFACES.lane.classList.remove("hidden"); renderLane(projLane); }
  } else if (name === "studio") SURFACES.studio.classList.remove("hidden");
  else if (name === "cultivation") SURFACES.cultivation.classList.remove("hidden");
  if (showWb) setTimeout(() => { clampWorkbenchSplit(); fitTerminals(); }, 30);
  try { localStorage.setItem("crowe-space", name); } catch {}
}
document.querySelectorAll("#spaces .seg-btn").forEach((b) => b.addEventListener("click", () => setSpace(b.dataset.space)));
document.querySelectorAll("#space-nav .sn-item").forEach((b) => b.addEventListener("click", () => {
  projLane = b.dataset.lane;
  document.querySelectorAll("#space-nav .sn-item").forEach((x) => x.classList.toggle("active", x === b));
  setSpace("projects");
}));

function ago(ts) {
  if (!ts) return "never";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 2) return "just now";
  if (m < 90) return m + "m ago";
  const h = Math.round(m / 60);
  return h < 36 ? h + "h ago" : Math.round(h / 24) + "d ago";
}
async function refreshHome() {
  const [cat, sess, cfg] = await Promise.all([window.crowe.catalog.get(), window.crowe.sessions.list(), window.crowe.getConfig()]);
  const hs = $("home-sessions"); hs.innerHTML = "";
  if (!sess.length) hs.innerHTML = '<div class="card-empty">No sessions yet. Start one above.</div>';
  for (const s of sess.slice(0, 4)) {
    const row = document.createElement("button"); row.type = "button"; row.className = "krow";
    row.innerHTML = `<span class="k">${esc(s.title || "Untitled")}</span><span class="v dim">${esc(ago(s.updatedAt))}</span>`;
    row.addEventListener("click", async () => { await loadSession(s.id); setSpace("chat"); });
    hs.appendChild(row);
  }
  const hr = $("home-routing"); hr.innerHTML = "";
  for (const [role, r] of Object.entries(cat.resolved || {}))
    hr.insertAdjacentHTML("beforeend", `<div class="kv"><span class="k">${esc(role)}</span><span class="v">${esc(r.model)}<em class="src">${esc(r.source)}</em></span></div>`);
  hr.insertAdjacentHTML("beforeend", `<div class="kv"><span class="k">everything else</span><span class="v">${esc(cat.defaultModel || "crowelm")}<em class="src">operator</em></span></div>`);
  let host = cfg.baseUrl; try { host = new URL(cfg.baseUrl).host; } catch {}
  $("home-gateway").innerHTML = `
    <div class="kv"><span class="k">endpoint</span><span class="v">${esc(host)}</span></div>
    <div class="kv"><span class="k">signed in</span><span class="v">${authed ? "yes" : "no"}</span></div>
    <div class="kv"><span class="k">catalog</span><span class="v">${cat.models.length ? esc(ago(cat.at)) : "unreachable"}</span></div>`;
  const featured = cat.models.filter((m) => m && m.featured).length;
  const roled = cat.models.filter((m) => m && m.role).length;
  $("home-models").innerHTML = `
    <div class="kv"><span class="k">in catalog</span><span class="v">${cat.models.length}</span></div>
    <div class="kv"><span class="k">featured</span><span class="v">${featured || "none yet"}</span></div>
    <div class="kv"><span class="k">role-tagged</span><span class="v">${roled || "none yet"}</span></div>
    <div class="kv"><span class="k">health</span><span class="v dim">endpoint pending</span></div>`;
  $("ss-gw").classList.toggle("ok", cat.models.length > 0);
  $("ss-cat").textContent = cat.models.length ? `catalog · ${cat.models.length} models` : "catalog · unreachable";
  $("ss-tier").textContent = "tier · " + (document.body.dataset.tier || "edit");
  $("ss-ver").textContent = cfg.version ? "v" + cfg.version : "";
}
let laneGen = 0; // stale async renders must not write into a newer lane
async function renderLane(lane) {
  const gen = ++laneGen;
  const info = LANES[lane] || { title: lane, sub: "" };
  $("lane-title").textContent = info.title; $("lane-sub").textContent = info.sub;
  const body = $("lane-body"); body.innerHTML = "";
  if (lane === "sessions") {
    const list = await window.crowe.sessions.list();
    if (gen !== laneGen) return;
    if (!list.length) { body.innerHTML = '<div class="card-empty">No saved sessions yet.</div>'; return; }
    for (const s of list) {
      const row = document.createElement("div"); row.className = "sess-row lane-sess" + (s.current ? " current" : "");
      const when = new Date(s.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      row.innerHTML = `<div class="sess-main"><div class="sess-title">${esc(s.title || "Untitled")}</div><div class="sess-when">${esc(when)}</div></div><button class="sess-del" title="Delete">Delete</button>`;
      row.addEventListener("click", async (e) => { if (e.target.closest(".sess-del")) return; await loadSession(s.id); setSpace("chat"); });
      row.querySelector(".sess-del").addEventListener("click", async (e) => { e.stopPropagation(); await window.crowe.sessions.delete(s.id); if (projLane === "sessions") renderLane("sessions"); });
      body.appendChild(row);
    }
  } else if (lane === "deployments") {
    const cat = await window.crowe.catalog.get();
    if (gen !== laneGen) return;
    if (!cat.models.length) { body.innerHTML = '<div class="card-empty">Catalog unreachable. Check the gateway URL in Settings.</div>'; return; }
    for (const m of cat.models) {
      if (!m) continue;
      const flags = [m.featured ? "featured" : "", m.role || "", m.available === false ? "offline" : "", m.gateway_tool_calling === false ? "no-tools" : ""].filter(Boolean);
      body.insertAdjacentHTML("beforeend", `<div class="mrow"><span class="m-id">${esc(m.model || m.id || "?")}</span><span class="m-name">${esc(m.display || m.display_name || "")}</span><span class="m-flags">${flags.map((f) => `<em>${esc(f)}</em>`).join("")}</span></div>`);
    }
  } else {
    body.innerHTML = `<span class="pending">${esc(info.pending || "wire pending")}</span>`;
  }
}
$("home-composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = $("home-input").value.trim(); if (!t) return;
  setSpace("chat");
  // Seed the chat composer first: send() clears it only after its running/auth
  // guards pass, so an early return leaves the draft visible instead of lost.
  input.value = t;
  send(t);
  $("home-input").value = "";
});
$("studio-film").addEventListener("click", (e) => {
  // Never inject keystrokes into the live PTY — a foregrounded vim/REPL would
  // receive them as commands. Copy instead; the user pastes at their prompt.
  const btn = e.currentTarget;
  navigator.clipboard.writeText("psynth").catch(() => {});
  btn.textContent = "Copied — paste at the prompt";
  setTimeout(() => { btn.textContent = "Copy psynth · open Terminal"; }, 2400);
  setSpace("chat"); switchPane("term");
});
$("studio-music").addEventListener("click", () => {
  setSpace("chat");
  input.value = "Compose with Talon: ";
  input.focus(); input.setSelectionRange(input.value.length, input.value.length);
});
document.querySelectorAll(".cult-chip").forEach((c) => c.addEventListener("click", () => { setSpace("chat"); send(c.textContent, { role: "cultivation" }); }));

// ── Official plugins (Settings picker; manifest lives in main) ──
let pluginGlyphs = {};
async function loadPluginGlyphs() {
  try { for (const p of await window.crowe.plugins.list()) if (p.glyph) pluginGlyphs[p.id] = p.glyph; } catch {}
}
async function renderPlugins() {
  const box = $("cfg-plugins"); if (!box) return;
  const list = await window.crowe.plugins.list();
  box.innerHTML = "";
  for (const p of list) {
    const row = document.createElement("div"); row.className = "plug-row";
    const status = !p.available ? '<em class="plug-tag">server pending</em>'
      : p.connected ? `<em class="plug-tag on">on · ${p.toolCount} tools</em>`
      : p.enabled ? '<em class="plug-tag warn">enabled · not connected</em>' : "";
    row.innerHTML = `<div class="plug-main"><div class="plug-name">${esc(p.name)} ${status}</div>
      <div class="plug-desc">${esc(p.description)}</div></div>`;
    const act = document.createElement("button");
    act.type = "button"; act.className = "ghost sm";
    act.textContent = p.enabled ? "Disable" : "Enable";
    if (!p.available && !p.enabled) act.disabled = true;
    const collectEnv = (envDiv) => {
      const vals = {};
      if (envDiv) envDiv.querySelectorAll("input").forEach((i) => { if (i.value.trim()) vals[i.dataset.key] = i.value.trim(); });
      return vals;
    };
    const doEnable = async (vals) => {
      const r = await window.crowe.plugins.enable(p.id, vals);
      if (r && r.error) { $("cfg-status").textContent = r.error; return; }
      $("cfg-status").textContent = `${p.name} connected.`;
      renderPlugins(); refreshStatus();
    };
    act.addEventListener("click", async () => {
      if (p.enabled) { await window.crowe.plugins.disable(p.id); $("cfg-status").textContent = ""; renderPlugins(); refreshStatus(); return; }
      const existing = row.querySelector(".plug-env");
      if (existing) { doEnable(collectEnv(existing)); return; } // Enable == Connect once inputs are shown
      if ((p.envPrompts || []).length) {
        // Keys are entered by the user, stored in the plugin's config section,
        // and passed to the server as env — never rendered back.
        const env = document.createElement("div"); env.className = "plug-env";
        env.innerHTML = p.envPrompts.map((e) => `<input type="password" data-key="${esc(e.key)}" placeholder="${esc(e.label)}" spellcheck="false">`).join("");
        const go = document.createElement("button"); go.type = "button"; go.className = "primary sm"; go.textContent = "Connect";
        go.addEventListener("click", () => doEnable(collectEnv(env)));
        env.appendChild(go); row.appendChild(env);
        return;
      }
      doEnable({});
    });
    row.appendChild(act);
    box.appendChild(row);
  }
}

// ── Auto-update banner (consent-first: never downloads without a click) ──
const updBanner = $("update-banner"), ubText = $("ub-text"), ubAction = $("ub-action");
function refitTermIfVisible() { fitTerminals(); }
function renderUpdate(s) {
  const wasHidden = updBanner.classList.contains("hidden");
  if (!s || s.status === "idle" || s.status === "current" || s.status === "dev") { updBanner.classList.add("hidden"); if (!wasHidden) refitTermIfVisible(); return; }
  updBanner.classList.remove("hidden");
  if (wasHidden) refitTermIfVisible();
  if (s.status === "available") { ubText.textContent = `Update ${s.version} is available.`; ubAction.textContent = "Download"; ubAction.disabled = false; }
  else if (s.status === "downloading") { ubText.textContent = `Downloading update… ${s.percent || 0}%`; ubAction.textContent = "Downloading"; ubAction.disabled = true; }
  else if (s.status === "ready") { ubText.textContent = `Update ${s.version} is ready.`; ubAction.textContent = "Restart to update"; ubAction.disabled = false; }
  else if (s.status === "error") { ubText.textContent = `Update check failed.`; ubAction.textContent = "Retry"; ubAction.disabled = false; }
}
ubAction.addEventListener("click", async () => {
  const t = ubAction.textContent;
  if (t === "Download") await window.crowe.update.download();
  else if (t === "Restart to update") await window.crowe.update.install();
  else if (t === "Retry") await window.crowe.update.check();
});
$("ub-dismiss").addEventListener("click", () => { updBanner.classList.add("hidden"); refitTermIfVisible(); });
if (window.crowe.update) {
  window.crowe.update.onChange(renderUpdate);
  window.crowe.update.state().then(renderUpdate);
}

// ── Workbench output, quick open, status bar ──
// Output pane: the full agent event stream, always recording.
const OUTPUT_MAX = 500;
function appendOutput(line) {
  const log = $("output-log"); if (!log) return;
  const ts = new Date().toLocaleTimeString([], { hour12: false });
  log.textContent += `[${ts}] ${line}\n`;
  const lines = log.textContent.split("\n");
  if (lines.length > OUTPUT_MAX) log.textContent = lines.slice(lines.length - OUTPUT_MAX).join("\n");
  log.scrollTop = log.scrollHeight;
}
window.crowe.agent.onEvent((ev) => {
  if (ev.type === "assistant_delta") return; // too chatty for a log
  const brief = ev.type === "tool_call" ? `${ev.name} ${JSON.stringify(ev.args || {}).slice(0, 120)}`
    : ev.type === "tool_result" ? `${ev.name || "tool"} → ${String(ev.result || "").slice(0, 120).replace(/\n/g, " ")}`
    : ev.type === "route" ? `→ ${ev.expert} · ${ev.model}`
    : ev.type === "telemetry" ? `${ev.promptTokens || 0}/${ev.completionTokens || 0} tok`
    : ev.type === "assistant" ? String(ev.text || "").slice(0, 120).replace(/\n/g, " ")
    : ev.type;
  appendOutput(`${ev.type}: ${brief}`);
});

// Quick open (Cmd+P): fuzzy file jump over the workspace.
const qopen = $("qopen"), qoInput = $("qo-input"), qoList = $("qo-list");
let qoFiles = [], qoAt = 0, qoRoot = null;
function fuzzy(q, s) {
  q = q.toLowerCase(); s = s.toLowerCase();
  let qi = 0, score = 0, last = -2;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) { score += (i === last + 1 ? 3 : 1) + (s[i - 1] === "/" ? 4 : 0); last = i; qi++; }
  }
  return qi === q.length ? score - s.length * 0.01 : -1;
}
async function openQuickOpen() {
  const cwd = (await window.crowe.getConfig()).cwd;
  if (Date.now() - qoAt > 30000 || qoRoot !== cwd) {
    const w = await window.crowe.fs.walk();
    qoFiles = w.files || []; qoRoot = w.root || cwd; qoAt = Date.now();
  }
  qopen.classList.remove("hidden"); qoInput.value = ""; renderQuickOpen(""); qoInput.focus();
}
function closeQuickOpen() { qopen.classList.add("hidden"); }
function renderQuickOpen(q) {
  const ranked = q
    ? qoFiles.map((f) => [fuzzy(q, f), f]).filter((x) => x[0] >= 0).sort((a, b) => b[0] - a[0]).slice(0, 40).map((x) => x[1])
    : qoFiles.slice(0, 40);
  qoList.innerHTML = "";
  ranked.forEach((f, i) => {
    const d = document.createElement("div"); d.className = "pal-row" + (i === 0 ? " sel" : ""); d.textContent = f;
    d.addEventListener("click", () => quickOpenFile(f, false));
    qoList.appendChild(d);
  });
}
async function quickOpenFile(f, toChat) {
  closeQuickOpen();
  if (toChat) { setSpace("chat"); input.value = (input.value ? input.value + " " : "") + f; input.focus(); return; }
  setSpace("chat"); switchPane("files");
  const r = await window.crowe.fs.read(f);
  $("files-view").textContent = r.error ? r.error : r.content;
}
qoInput.addEventListener("input", () => renderQuickOpen(qoInput.value));
qoInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeQuickOpen();
  else if (e.key === "Enter") { const first = qoList.querySelector(".pal-row.sel") || qoList.querySelector(".pal-row"); if (first) quickOpenFile(first.textContent, e.metaKey || e.ctrlKey); }
});
qopen.addEventListener("click", (e) => { if (e.target === qopen) closeQuickOpen(); });
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); openQuickOpen(); }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "b") {
    e.preventDefault();
    applySidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));
  }
});

// Shortcut hints are authored with Cmd; every binding also accepts Ctrl, so
// relabel them off the Mac rather than showing a key that isn't on the board.
const MOD_LABEL = /mac/i.test(navigator.userAgent) ? "Cmd" : "Ctrl";
if (MOD_LABEL !== "Cmd") {
  for (const el of document.querySelectorAll("[title*='Cmd'], [placeholder*='Cmd']")) {
    for (const attr of ["title", "placeholder"]) {
      const v = el.getAttribute(attr);
      if (v && v.includes("Cmd")) el.setAttribute(attr, v.split("Cmd").join(MOD_LABEL));
    }
  }
}

// Status bar: branch + dirty count + plugin count, refreshed lazily.
async function statusTick() {
  try {
    const s = await window.crowe.git.status();
    const b = $("hud-branch");
    if (s.repo) { b.textContent = `⎇ ${s.branch}${s.files.length ? " · " + s.files.length : ""}`; b.classList.remove("hidden"); }
    else { b.textContent = ""; b.classList.add("hidden"); }
  } catch { /* keep last */ }
  try {
    const on = (await window.crowe.plugins.list()).filter((p) => p.connected).length;
    $("hud-plug").textContent = on ? `⬡ ${on}` : "";
  } catch { /* keep last */ }
}
if ($("hud-branch")) $("hud-branch").addEventListener("click", () => { setSpace("chat"); switchPane("git"); });
setInterval(statusTick, 30000);

// ── Command palette (Cmd+K) ──
const PAL_ACTIONS = [
  { label: "New chat", run: () => { setSpace("chat"); newChat(); } },
  { label: "Space: Chat", run: () => setSpace("chat") },
  { label: "Space: Projects", run: () => setSpace("projects") },
  { label: "Space: Studio", run: () => setSpace("studio") },
  { label: "Space: Cultivation", run: () => setSpace("cultivation") },
  { label: "Sessions", run: () => { setSpace("chat"); renderSessions(); } },
  { label: "Terminal", run: () => { setSpace("chat"); switchPane("term"); } },
  { label: "Browser", run: () => { setSpace("chat"); switchPane("browser"); } },
  { label: "Files", run: () => { setSpace("chat"); switchPane("files"); } },
  { label: "Version control (git)", run: () => { setSpace("chat"); switchPane("git"); } },
  { label: "Toggle dark mode", run: () => applyTheme(!document.body.classList.contains("dark")) },
  { label: "Autonomy: Plan", run: () => selAutonomy("plan") },
  { label: "Autonomy: Read-only", run: () => selAutonomy("readonly") },
  { label: "Autonomy: Edit", run: () => selAutonomy("edit") },
  { label: "Autonomy: Execute", run: () => selAutonomy("execute") },
  { label: "New terminal panel", run: () => addPanel("terminal") },
  { label: "Quick open file", run: openQuickOpen },
  { label: "Output (agent events)", run: () => { setSpace("chat"); switchPane("output"); } },
  { label: "Git: pull", run: async () => { const r = await window.crowe.git.pull(); appendOutput("git pull: " + ((r && (r.out || r.error)) || "").slice(0, 200)); loadGit(); statusTick(); } },
  { label: "Git: push", run: async () => { const r = await window.crowe.git.push(); appendOutput("git push: " + ((r && (r.out || r.error)) || "").slice(0, 200)); statusTick(); } },
  { label: "Check for updates", run: async () => { const s = await window.crowe.update.check(); if (s && (s.status === "current" || s.status === "dev")) appendOutput("update: " + (s.status === "dev" ? "dev build — updates only in packaged app" : "you're on the latest version")); } },
  { label: "Plugins", run: () => $("settings-btn").click() },
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
document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); } });

// ── Menu / tray / global-summon bus (previously fired into the void) ──
window.crowe.onMenuAction((a) => {
  if (a === "new-chat") { setSpace("chat"); newChat(); }
  else if (a === "focus-composer") { setSpace("chat"); input.focus(); }
  else if (a === "palette") openPalette();
  else if (a === "toggle-theme") applyTheme(!document.body.classList.contains("dark"));
  else if (a && a.startsWith("pane:")) { setSpace("chat"); switchPane(a.slice(5)); }
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
  b.appendChild(btn); scrollBottom();
}
$("signin").addEventListener("click", doSignIn);
$("userbadge").addEventListener("click", async () => { await window.crowe.auth.logout(); await refreshAuth(); });

// ── First-run onboarding ──
// Shown once, on a machine with no Crowe ID session and no onboarded flag.
// Walks sign-in → pick workspace → first task, then marks itself done in config.
async function maybeShowOnboarding(cfg) {
  if (authed) return;
  if (cfg && cfg.onboarded) return;
  clearWelcome();
  const b = addAssistant();
  b.innerHTML = [
    '<p class="said"><strong>Welcome to Crowe Logic.</strong> This is the operator over your CroweLM gateway - chat, a real terminal, files, git, and plugin tools, all reviewed through one agent loop.</p>',
    '<p class="said">Three quick steps to your first task:</p>',
    '<ol class="said" style="margin:4px 0 0 1.2em;line-height:1.7">',
    "<li>Sign in with your Crowe ID (Pro access unlocks the full CroweLM tiers).</li>",
    "<li>Point the workspace at a project folder (Settings or ask the agent).</li>",
    '<li>Give the agent a task - try <em>"summarize this repo"</em> or <em>"run the tests and fix what fails"</em>.</li>',
    "</ol>",
  ].join("");
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;margin-top:10px";
  const signinBtn = document.createElement("button");
  signinBtn.className = "primary"; signinBtn.textContent = "Sign in with Crowe ID";
  signinBtn.addEventListener("click", async () => { await window.crowe.setConfig({ onboarded: true }); await doSignIn(); });
  const laterBtn = document.createElement("button");
  laterBtn.className = "ghost"; laterBtn.textContent = "Explore first";
  laterBtn.addEventListener("click", async () => { await window.crowe.setConfig({ onboarded: true }); b.remove(); });
  row.appendChild(signinBtn); row.appendChild(laterBtn);
  b.appendChild(row); scrollBottom();
}

// ── Init ──
(async () => {
  $("model-badge").textContent = "CroweLM";
  if (window.CroweMark) { CroweMark.mount($("mark"), { state: "rest" }); mountWelcomeMark(); }
  try { setAutonomyBadge(localStorage.getItem("crowe-tier") || "edit"); } catch {}
  const c = await refreshStatus(); loadTree(); loadPluginGlyphs();
  setAutonomyBadge((c && c.autonomy) || "edit");
  await refreshAuth();
  await maybeShowOnboarding(c);
  try { const sp = localStorage.getItem("crowe-space"); if (sp && sp !== "chat") setSpace(sp); } catch {}
  statusTick();
  await restorePanels();
})();
