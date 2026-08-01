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
/* ── Streaming reveal ────────────────────────────────────────────────────────
   The old loop re-parsed the entire message and replaced the entire subtree on
   every animation frame. Three things followed from that, and all three were
   the complaint: a long reply meant kilobytes of markdown parsed sixty times a
   second with hundreds of DOM nodes rebuilt under it; any text the user had
   selected was destroyed on the next frame, so a streaming reply could not be
   copied from until it finished; and at a hard cap of 300 chars/s the writing
   fell steadily behind a model that streams faster than that, so the animation
   was still typing long after the answer had arrived.

   What replaces it: text that is structurally final is parsed once and left
   alone, only the last unfinished block is re-rendered per frame, and the rate
   tracks the stream instead of a fixed cadence. The three functions below are
   the whole policy, kept at module scope so scripts/test-panels.js can hold
   them to it. */

/* Baseline cadence, and the ceiling on how far the reveal may trail the model.

   Proportional catch-up - reveal a fixed fraction of the backlog each frame -
   was the obvious approach and the wrong one: it decays exponentially, so a
   4 KB burst still took a second to drain and the "never trails by more than
   LAG_MS" claim above it was simply false. Instead the backlog itself is
   capped. Anything beyond what reads in LAG_MS is not animation, it is delay,
   so it is skipped outright and the last stretch is written at the base rate.
   The trailing distance is then bounded by construction rather than by hope. */
const STREAM_CPS = 420, STREAM_LAG_MS = 220;
function streamRevealLen(shown, total, dtMs) {
  if (shown >= total) return total;
  if (!(dtMs > 0)) return shown;
  const maxBacklog = (STREAM_CPS * STREAM_LAG_MS) / 1000;
  const from = Math.max(shown, total - maxBacklog);
  return Math.min(total, from + Math.max(1, Math.ceil((STREAM_CPS * dtMs) / 1000)));
}
/* The last blank line that can be committed to the DOM permanently. `from` is
   the previous settled point, which is never inside a code fence, so parity of
   the fences between there and the candidate is what decides whether a blank
   line is a paragraph break or just a blank line inside code. */
function streamSettleAt(text, from, shown) {
  const tail = text.slice(from, shown);
  let at = tail.lastIndexOf("\n\n");
  while (at > 0) {
    if ((tail.slice(0, at).match(/```/g) || []).length % 2 === 0) return from + at + 2;
    at = tail.lastIndexOf("\n\n", at - 1);
  }
  return from;
}
/* How much of the revealed text can be drawn without showing punctuation that
   is about to become formatting. Without this, `**bold` spends a few frames as
   two literal asterisks and then snaps, which reads as a rendering fault. An
   opener is only held briefly - past 160 characters it is likelier to be prose
   than markup, and a reveal that stalls is worse than one that flickers. */
function streamSafeLen(text, from, shown) {
  const head = text.slice(from, shown);
  // Inside an open fence everything is literal, so nothing needs holding back.
  if ((head.match(/```/g) || []).length % 2) return shown;
  const lastFence = head.lastIndexOf("```");
  const base = lastFence < 0 ? 0 : lastFence + 3;
  const region = head.slice(base);
  let cut = region.length;
  const hold = (i) => { if (i >= 0 && region.length - i <= 160) cut = Math.min(cut, i); };
  if ((region.match(/`/g) || []).length % 2) hold(region.lastIndexOf("`"));
  if ((region.match(/\*\*/g) || []).length % 2) hold(region.lastIndexOf("**"));
  if (region.lastIndexOf("[") > region.lastIndexOf("]")) hold(region.lastIndexOf("["));
  return from + base + cut;
}
const REDUCED_MOTION = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
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
  // 26px slot with 3.5px of padding, so ~19px of drawing — the small cut.
  if (window.CroweMark) body._mark = CroweMark.mount(markEl, { state: "rest", small: true });
  return body;
}
function renderText(body, text) {
  // Static render (history/rebuild). .said is a <div>: markdown emits block
  // elements a <p> could not contain. Appended: replies read chronologically.
  let p = body.querySelector(".said"); if (!p) { p = document.createElement("div"); p.className = "said streaming"; body.appendChild(p); }
  const t = body.querySelector(".thinking"); if (t) t.remove();
  p.innerHTML = md(text); scrollBottom();
}
/* ── The thinking indicator is the logotype ──────────────────────────────────
   This used to be a bank of eight blue-and-gold hexagons, one drawn per turn,
   on the theory that a turn deserved its own cognition glyph. It didn't. Eight
   marks that nobody could name meant the moment the user actually watches -
   waiting - was the one moment the product wore something other than its own
   name, in a palette the identity had already left behind. Now the wait is the
   wordmark: CROWE LOGIC with its rotors turning inside the O's. One mark,
   everywhere, and the animation is the only thing that changes.

   The stage still gets a word, because "editing" and "executing" are not
   interchangeable to anyone watching a file get written. The picture is
   constant; the label carries the difference. */
function stageLabel(name) {
  if (name === "run_shell") return "executing";
  if (name === "write_file" || name === "edit_file") return "editing";
  if (name === "open_url") return "browsing";
  if (name && name.startsWith("mcp__")) return "calling " + name.split("__")[1];
  return "retrieving";
}
/* The motion logotype, fetched once per cut and held. There are two cuts of
   the same drawing on the same viewBox: "sm" redraws the o-blades and the
   spore for the sizes most mounts actually render (22px header, ~22px
   thinking line, ~31px agent head — see gen-mark.js on why fine taper is
   invisible there), and "full" keeps the print-scale detail for the welcome
   hero, the one mount large enough to resolve it. A session that never shows
   the hero never pays for the second file. */
const wordmarkMotionHeld = {}, wordmarkMotionPending = {};
function wordmarkMotionMarkup(cut = "sm") {
  if (wordmarkMotionHeld[cut]) return Promise.resolve(wordmarkMotionHeld[cut]);
  if (!wordmarkMotionPending[cut]) {
    wordmarkMotionPending[cut] = fetch(cut === "full" ? "../assets/wordmark-motion.svg" : "../assets/wordmark-motion-sm.svg")
      .then((r) => (r.ok ? r.text() : null))
      .then((t) => (wordmarkMotionHeld[cut] = t ? t.replace(/<\?xml[^>]*\?>/, "").trim() : null))
      .catch(() => null);
  }
  return wordmarkMotionPending[cut];
}

/* A thinking copy keeps the drawing and drops everything that only made sense
   for the one logotype in the header: the ids, which are document-global and
   would have the entrance CSS animate whichever copy loaded first, and the
   labelling, since the indicator's own label already says what is happening.
   Stripping ids is safe here only because the motion cut has no url(#) fills -
   its ink is currentColor and its spore is flat gold. `is-thinking` replaces
   `is-animated`: an indicator that played the arrival every time it appeared
   would be a logo swooping in on every tool call. */
async function mountMotionLogotype(host, cls) {
  const markup = await wordmarkMotionMarkup();
  if (!markup || host.firstElementChild) return null;
  host.insertAdjacentHTML("beforeend", markup
    .replace(/\sid="[^"]*"/g, "")
    .replace(/\saria-labelledby="[^"]*"/g, "")
    .replace('class="is-animated"', `class="${cls || ""}"`));
  const svg = host.firstElementChild;
  if (svg) { svg.setAttribute("aria-hidden", "true"); svg.removeAttribute("role"); }
  return svg;
}

/* The indicator has to stay under whatever the turn has appended since, and
   appendChild is how you do that — but re-inserting a node restarts every CSS
   animation under it, so the rotors would snap back to zero each time a tool
   card landed. That is precisely the moment the motion is meant to cover.

   So the move is made and the clocks are carried across it. Each keyframe name
   appears once in the logotype, which is what makes matching by name enough. */
function keepAtBottom(t, body) {
  if (t.parentNode === body && body.lastElementChild === t) return;
  const was = new Map();
  for (const a of t.getAnimations({ subtree: true })) if (a.currentTime != null) was.set(a.animationName, a.currentTime);
  body.appendChild(t);
  for (const a of t.getAnimations({ subtree: true })) if (was.has(a.animationName)) a.currentTime = was.get(a.animationName);
}

// One indicator per message body; it moves to the bottom and morphs per stage.
function showThinking(body, label) {
  let t = body.querySelector(".thinking");
  if (!t) {
    t = document.createElement("div"); t.className = "thinking"; t.dataset.since = Date.now();
    t.innerHTML = '<span class="th-logotype" role="img" aria-label="Crowe Logic"></span>'
      + '<span class="th-label"></span><span class="th-elapsed"></span>';
    mountMotionLogotype(t.firstElementChild, "is-thinking");
  }
  /* Only the label is rewritten per stage. This used to rebuild innerHTML on
     every event, which with a turning mark restarts its animation - the blades
     would snap back to zero on each tool call instead of running through the
     whole turn, which is the one thing continuous motion is for. */
  t.dataset.label = label || "working";
  t.querySelector(".th-label").textContent = label || "working";
  keepAtBottom(t, body);
  scrollBottom();
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

/* The approval card. It looks like the edit card on purpose - the gesture is the
   same one the user already knows - but it is answering a different question. The
   edit card asks whether a diff is right. This asks whether something that cannot
   be undone should happen at all, so it leads with what the command does rather
   than with the command, and the command is shown verbatim underneath. */
function addApproval(body, ev) {
  const card = document.createElement("div");
  card.className = `editcard gatecard risk-${ev.risk === "review" ? "review" : "strict"}`;
  card.dataset.approvalId = String(ev.id);
  card.innerHTML = `<div class="ec-head"><span class="ec-title">${ev.risk === "review" ? "Reaches past the workspace" : "Cannot be undone"}</span><span class="ec-path">${esc(ev.kind || "action")}</span></div>
    <div class="gc-why">This ${esc(ev.why || "action needs your approval")}.</div>
    <div class="ec-diff"><div class="dl ctx">${esc(ev.detail || "")}</div></div>
    <div class="ec-actions"><button class="approve">Allow once</button><button class="reject">Deny</button><span class="ec-hint">a allow · r deny</span></div>`;
  card.tabIndex = 0;
  body.appendChild(card); card.focus(); scrollBottom();
  const done = (ok) => {
    if (card.dataset.decided) return;
    card.dataset.decided = "1";
    window.crowe.approval.decide(ev.id, ok);
    card.querySelector(".ec-actions").innerHTML = `<span class="ec-status">${ok ? "allowed once" : "denied"}</span>`;
    card.classList.add(ok ? "applied" : "rejected");
  };
  card.querySelector(".approve").onclick = () => done(true);
  card.querySelector(".reject").onclick = () => done(false);
  card.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "a") done(true); else if (k === "r") done(false);
  });
}
function expireApproval(id) {
  const card = document.querySelector(`.gatecard[data-approval-id="${id}"]`);
  if (!card || card.dataset.decided) return;
  card.dataset.decided = "1";
  card.classList.add("rejected");
  const actions = card.querySelector(".ec-actions");
  if (actions) actions.innerHTML = '<span class="ec-status">no answer, so it was denied</span>';
}
// The receipt from the independent check. Checks are listed with their evidence
// because a verdict with nothing behind it is the thing this pass exists to stop.
function addVerdict(body, ev) {
  const card = document.createElement("div");
  card.className = `verdictcard ${ev.status || "inconclusive"}`;
  const head = ev.status === "pass" ? "Verified" : ev.status === "fail" ? "Verification failed" : "Verification inconclusive";
  const checks = (ev.checks || []).map((c) => `<div class="vc-check ${esc(c.result || "")}">
      <span class="vc-name">${esc(c.name || "")}</span><span class="vc-res">${esc(c.result || "")}</span>
      ${c.evidence ? `<div class="vc-ev">${esc(String(c.evidence).slice(0, 500))}</div>` : ""}</div>`).join("");
  // Said on the card as well as in the text, because the caveat travels with the
  // verdict rather than with the prose about it.
  const caveat = ev.independent === false
    ? '<div class="vc-note">Checked by the same model that made the change. Weigh the evidence, not the verdict.</div>'
    : "";
  card.innerHTML = `<div class="vc-head"><span class="vc-title">${head}</span><span class="vc-model">${esc(ev.model || "")}</span></div>
    <div class="vc-summary">${esc(ev.summary || "")}</div>${caveat}${checks ? `<div class="vc-checks">${checks}</div>` : ""}`;
  body.appendChild(card); scrollBottom();
}
function addNotice(body, text, cls) {
  const n = document.createElement("div");
  n.className = `notice ${cls || ""}`.trim();
  n.textContent = text;
  body.appendChild(n); scrollBottom();
}

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
  // after the tool cards that produced it, revealed as it arrives. Settled
  // paragraphs are parsed once and never touched again; only `.md-tail`, the
  // one unfinished block, is re-rendered per frame.
  let curSaid = null, curText = "", shownLen = 0, settledLen = 0, tailEl = null, typerOn = false, lastFrame = 0;
  const openSaid = () => {
    curSaid = document.createElement("div"); curSaid.className = "said streaming";
    tailEl = document.createElement("div"); tailEl.className = "md-tail";
    curSaid.appendChild(tailEl); body.appendChild(curSaid);
    curText = ""; shownLen = 0; settledLen = 0;
  };
  const paint = () => {
    const safe = streamSafeLen(curText, settledLen, shownLen);
    const at = streamSettleAt(curText, settledLen, safe);
    // Only settle when something would still be left to write, so the caret -
    // which rides the tail's last line - always has a line to ride.
    if (at > settledLen && safe > at) {
      const tpl = document.createElement("template");
      tpl.innerHTML = md(curText.slice(settledLen, at));
      curSaid.insertBefore(tpl.content, tailEl);
      settledLen = at;
    }
    tailEl.innerHTML = md(curText.slice(settledLen, safe));
  };
  const finishSaid = () => {
    if (!curSaid) return;
    curSaid.innerHTML = md(curText); curSaid.classList.remove("streaming");
    curSaid = null; tailEl = null; curText = ""; shownLen = 0; settledLen = 0; scrollBottom();
  };
  const typeTick = (now) => {
    if (!curSaid) { typerOn = false; return; }
    const dt = lastFrame ? now - lastFrame : 16; lastFrame = now;
    shownLen = REDUCED_MOTION.matches ? curText.length : streamRevealLen(shownLen, curText.length, dt);
    paint(); scrollBottom();
    if (shownLen >= curText.length) { typerOn = false; lastFrame = 0; return; }
    requestAnimationFrame(typeTick);
  };
  const pushText = (txt, burst) => {
    if (!txt) return;
    hideThinking(body);
    if (!curSaid) openSaid();
    curText += (burst && curText ? "\n\n" : "") + txt;
    if (!typerOn) { typerOn = true; lastFrame = 0; requestAnimationFrame(typeTick); }
  };
  showThinking(body); setRunning(true);
  const off = window.crowe.agent.onEvent((ev) => {
    /* The transcript is the "main" agent's and only its. Panels and workflow
       nodes run under their own ids on the same channel, so without this the
       chat would draw a workflow node's approval card and the user would be
       answering for an action they are not looking at. */
    if (ev.agentId && ev.agentId !== "main") return;
    // A streamed burst has already arrived character by character; the closing
    // assistant event is its receipt, not more text to append.
    if (ev.type === "assistant") { if (!ev.streamed) { runText += (runText ? "\n\n" : "") + ev.text; pushText(ev.text, true); } }
    else if (ev.type === "assistant_delta") { runText += ev.text || ""; pushText(ev.text || "", false); }
    else if (ev.type === "stream_reset") {
      // A retried call repeats its answer from the top; the harness says how
      // many streamed characters to take back so the fragment is not kept
      // ahead of the whole.
      const n = ev.chars || 0;
      runText = runText.slice(0, Math.max(0, runText.length - n));
      if (curSaid) {
        curText = curText.slice(0, Math.max(0, curText.length - n));
        if (!curText) { curSaid.remove(); curSaid = null; tailEl = null; shownLen = 0; settledLen = 0; }
        else {
          // Rebuilt rather than trimmed: a rollback can cut into text that was
          // already settled into the DOM, and settled nodes carry no offsets to
          // trim by.
          shownLen = Math.min(shownLen, curText.length);
          curSaid.innerHTML = ""; settledLen = 0;
          tailEl = document.createElement("div"); tailEl.className = "md-tail";
          curSaid.appendChild(tailEl); paint();
        }
      }
    }
    else if (ev.type === "telemetry") { updateHud(ev); runTok = (ev.promptTokens || 0) + (ev.completionTokens || 0); }
    else if (ev.type === "tool_call") {
      finishSaid(); addToolCard(body, ev);
      showThinking(body, stageLabel(ev.name));
      $("hud-status").textContent = ev.name || "tool";
      if (mark) mark.ping();
    }
    else if (ev.type === "tool_result") {
      if (!/^blocked:/.test(String(ev.result || ""))) { if (ev.name === "run_shell") acts.cmds++; else if (ev.name === "write_file") acts.edits++; else acts.tools++; }
      fillToolResult(ev);
      // A record the agent just wrote should appear where records live, now,
      // without the grower having to leave and come back. This is also the
      // review: the row is on screen while the turn is still running, and it
      // edits and deletes like any other, so an agent that logged the wrong
      // thing is one click from being corrected.
      if (ev.name === "log_grow" && /^(logged|corrected)/.test(String(ev.result || ""))) refreshCultivation();
      showThinking(body, "reasoning");
    }
    else if (ev.type === "edit_proposal") { finishSaid(); hideThinking(body); addEditProposal(body, ev); }
    else if (ev.type === "approval_request") { finishSaid(); hideThinking(body); addApproval(body, ev); }
    else if (ev.type === "approval_expired") { expireApproval(ev.id); }
    else if (ev.type === "verdict") { finishSaid(); hideThinking(body); addVerdict(body, ev); }
    else if (ev.type === "budget") {
      finishSaid();
      const spent = /token/.test(ev.limit || "")
        ? `${(ev.tokens || 0).toLocaleString()} of ${(ev.tokenCeiling || 0).toLocaleString()} tokens`
        : `$${(ev.spent || 0).toFixed(2)} of $${(ev.ceiling || 0).toFixed(2)}`;
      addNotice(body, `Stopped at this turn's ${ev.limit || "ceiling"}: ${spent}. Raise it in Settings if this turn needed more.`, "budget");
    }
    else if (ev.type === "retry") { $("hud-status").textContent = `retrying (${ev.attempt}/${ev.of})`; }
    else if (ev.type === "route") { addRouteNode(body, ev); showThinking(body, "reasoning"); if (ev.model) $("hud-model").textContent = ev.model; }
    else if (ev.type === "stopped") { finishSaid(); hideThinking(body); addStopped(body); }
    else if (ev.type === "error") { finishSaid(); hideThinking(body); addError(body, ev.text); }
  });
  // Every turn carries the farm's own records; the harness hands them to the
  // cultivation expert and drops them for everyone else. Sent unconditionally
  // because the routing happens over there - a mushroom question asked from
  // plain Chat should reach the grower with the same records as one asked from
  // the Cultivation surface. Read fresh each turn rather than pinned into
  // `messages`, so the expert sees the grow as it is now and the saved
  // transcript stays a conversation instead of a stale snapshot of the store.
  const runOpts = {};
  if (opts.role) runOpts.role = opts.role;
  const gc = await growContext(); if (gc) runOpts.context = gc;
  try { await window.crowe.agent.run(messages, "main", runOpts); } finally { off(); if (mark) mark.rest(); $("hud-model").textContent = "CroweLM"; spentCost = runCost; sessionCost += runCost; runCost = 0; $("hud-cost").textContent = fmtCost(sessionCost); setRunning(false); }
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
  const titles={terminal:"Terminal",browser:"Browser",operator:"Operator Control",workflow:"Workflows",agents:"Agent Fleet",agent:"Crowe Logic Agent",workbench:"Workbench",system:"CroweLM System Terminal",room:"Room"};
  const p = { id:seed.id || panelId(type), type, title:seed.title || titles[type] || "Panel", url:seed.url || "https://crowelogic.com", history:seed.history || [], bookmarks:seed.bookmarks || [], licensed:Boolean(seed.licensed), workspaceId:seed.workspaceId || "" };
  panels.push(p); activePanelId = p.id; const el=panelShell(p); panelDeck.appendChild(el); const body=el.querySelector(".panel-body");
  if(type === "terminal" || type === "system") await mountTerminal(p, body, type === "system");
  else if(type === "agent") await mountWorkspaceAgent(p, body, seed);
  else if(type === "browser") mountBrowser(p, body);
  else if(type === "workflow") mountWorkflow(p, body);
  else if(type === "agents") mountAgentFleet(p, body);
  else if(type === "workbench") mountWorkbench(p, body);
  else if(type === "room") mountRoom(p, body, seed);
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
  body.innerHTML = `<div class="agent-operation-head"><div class="agent-logotype" role="img" aria-label="Crowe Logic"></div><div><small>CLI AGENT</small><strong class="agent-operation-state">Booting runtime</strong></div><button type="button" class="agent-console-toggle ghost sm" aria-expanded="false">Console</button><span class="agent-operation-chip" data-state="booting">BOOTING</span></div><div class="agent-event-stream" aria-live="polite"></div><div class="agent-terminal-slot"></div><form class="agent-command-dock"><textarea rows="2" placeholder="Assign an objective to this agent..."></textarea><button type="submit" class="primary sm">Run</button><button type="button" class="agent-interrupt ghost sm">Interrupt</button></form>`;
  const slot=body.querySelector(".agent-terminal-slot");
  const cs=getComputedStyle(document.body),tok=n=>cs.getPropertyValue(n).trim();
  const t=new Terminal({fontFamily:"JetBrains Mono, ui-monospace, Menlo, monospace",fontSize:12,cursorBlink:true,scrollback:5000,theme:{background:tok("--term-bg")||tok("--cream"),foreground:tok("--term-fg")||tok("--ink"),cursor:tok("--gold"),selectionBackground:tok("--accent-wash")||"rgba(184,137,58,.28)"}});
  const f=new FitAddon.FitAddon();t.loadAddon(f);t.open(slot);try{f.fit()}catch{}
  const status=body.querySelector(".agent-operation-state"),chip=body.querySelector(".agent-operation-chip"),events=body.querySelector(".agent-event-stream");
  /* The panel head wears the logotype, same as the header and the thinking
     indicator — one mark everywhere, and here the motion is doing work: turning
     rotors mean the runtime is alive and reasoning, still ones mean it is
     waiting on you. The <small> beside it reads "CLI AGENT" rather than "CROWE
     LOGIC CLI AGENT" because the drawing already says the name and setting it
     twice, once drawn and once in caps, just looks like nobody checked.

     This replaced a CroweMark whorl. Nothing is lost: the whorl's states were
     idle / reasoning / failed, and only "reasoning" ever animated, which is
     exactly the distinction is-thinking carries. */
  const logotype = { svg: null, state: "idle" };
  mountMotionLogotype(body.querySelector(".agent-logotype"), "").then((svg) => {
    logotype.svg = svg;
    if (svg) svg.classList.toggle("is-thinking", logotype.state === "reasoning");
  });
  const mark = {
    setState(s) {
      logotype.state = s;
      if (logotype.svg) logotype.svg.classList.toggle("is-thinking", s === "reasoning");
    },
    // A tool landed. One quick beat of the whole mark, distinct from the rotors
    // so it reads as an event rather than as more of the same turning.
    ping() {
      const el = body.querySelector(".agent-logotype");
      if (!el) return;
      el.classList.remove("pinged");
      void el.offsetWidth;   // restart the beat even if one is already running
      el.classList.add("pinged");
    },
  };
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
  form.onsubmit=async e=>{e.preventDefault();const task=box.value.trim();if(!task||running)return;running=true;setState("running","reasoning","Reasoning and executing");addEvent("input",task);box.value="";run.disabled=true;let answer="";const off=window.crowe.agent.onEvent(ev=>{if(ev.agentId!==p.id)return;if(ev.type==="tool_call"){status.textContent=`Running ${ev.name||"tool"}`;pingMark();addEvent("tool",ev.name||"tool")}else if(ev.type==="assistant_delta"||(ev.type==="assistant"&&!ev.streamed))answer+=ev.text||"";else if(ev.type==="error")addEvent("error",ev.text||"failed")});try{const r=await window.crowe.agent.run([{role:"user",content:task}],p.id,{licensed:p.licensed,workspaceId:p.workspaceId});answer=answer||r?.text||"Completed";addEvent("verified",answer.slice(0,500));setState("verified","idle","Verified")}catch(err){addEvent("error",err.message||String(err));setState("failed","failed","Needs attention")}finally{off();running=false;run.disabled=false}};
  /* Interrupt stops the agent run, not the terminal. It used to also send
     Ctrl-C to the PTY, killing whatever the operator had running by hand for
     a run that was never happening there. Ctrl-C in the terminal still works. */
  body.querySelector(".agent-interrupt").onclick=()=>{window.crowe.agent.stop(p.id);setState("waiting","idle","Interrupted");addEvent("status","operator interrupted the agent run")};
  /* The terminal is a manual console, not the engine. An objective typed into
     the dock runs on the gateway agent and never touches this PTY, and the
     event stream above is fed by agent.onEvent - so the panel already tells
     the whole story of a run without the shell being on screen. It stays one
     click away for anything the operator wants to run by hand.

     Fitting is deferred to reveal because xterm measures a cell against the
     live DOM: fit() on a display:none slot computes zero columns, and the PTY
     told that width wraps every later line at the wrong place. */
  const consoleBtn=body.querySelector(".agent-console-toggle");
  const showConsole=(open)=>{
    body.classList.toggle("console-open",open);
    consoleBtn.setAttribute("aria-expanded",String(open));
    localStorage.setItem("crowe-agent-console",open?"open":"closed");
    if(open)requestAnimationFrame(()=>{try{f.fit();window.crowe.pty.resize({id:p.id,cols:t.cols,rows:t.rows})}catch{}});
  };
  consoleBtn.onclick=()=>showConsole(!body.classList.contains("console-open"));
  showConsole(localStorage.getItem("crowe-agent-console")==="open");
  new ResizeObserver(()=>{try{f.fit();window.crowe.pty.resize({id:p.id,cols:t.cols,rows:t.rows})}catch{}}).observe(slot);
}

/* A bare host typed into the address bar gets https by default - except loopback,
   where that default is fatal: the TLS handshake against a plain-HTTP dev server
   fails before anything renders, so "localhost:8123" would never load. Real
   browsers default loopback to http; this bar does the same. The host must end at
   a boundary ("localhost.evil.com" is not loopback), and *.localhost counts
   because resolvers pin that whole TLD to the loopback interface. */
function normalizeBrowserUrl(u){
  u=String(u||"").trim();
  if(/^https?:\/\//i.test(u))return u;
  const loopback=/^(localhost|[\w-]+(\.[\w-]+)*\.localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(:\d+)?([/?#]|$)/i.test(u);
  return (loopback?"http://":"https://")+u;
}
/* The webview announces itself as "CroweLogic/x Chrome/y Electron/z", and
   bot walls (Akamai on microsoft.com, Google sign-in, Cloudflare challenges)
   reject UAs carrying tokens no real browser sends - pages 403 or challenge
   forever. The guest page gets the Chrome UA the engine actually is: strip
   everything between the engine suffix and the Chrome token, then the
   Electron token. Scoped to the browser panel; gateway and telemetry traffic
   keep the honest app UA. */
function browserUserAgent(ua) {
  ua = ua || navigator.userAgent;
  return ua.replace(/(\(KHTML, like Gecko\) ).*?(Chrome\/)/, "$1$2").replace(/ Electron\/[\d.]+/, "");
}
function mountBrowser(p, body) {
  body.style.position="relative";
  const bar=document.createElement("div");bar.className="browser-tools";
  bar.innerHTML='<button class="back ghost sm" title="Back">Back</button><button class="forward ghost sm" title="Forward">Next</button><button class="reload ghost sm" title="Reload">Reload</button><button class="hist ghost sm" title="History">History</button><button class="bookmark ghost sm" title="Bookmark page">Bookmark</button><button class="bookmarks ghost sm" title="Bookmarks">Saved</button><input class="browser-url" spellcheck="false" aria-label="Address"><button class="go ghost sm">Go</button>';
  const hist=document.createElement("div");hist.className="browser-history hidden";
  const host=document.createElement("div");host.className="browser-host";const w=document.createElement("webview");w.setAttribute("allowpopups","");w.setAttribute("useragent",browserUserAgent());host.appendChild(w);body.append(bar,hist,host);
  const input=bar.querySelector("input");
  const go=(u)=>{u=normalizeBrowserUrl(u);w.src=u;input.value=u};
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
/* The canvas is authored by the agents, not assembled by hand. The operator says
   what the operation is; a full harness turn designs the nodes. This brief is
   that turn's instructions, and it is explicit about the one constraint the
   canvas imposes: nodes run in parallel and blind to each other, so a prompt
   that says "using the previous agent's output" designs a workflow that cannot
   exist here. */
const COMPOSE_ASK=(want)=>`Design an agent workflow for this operation: ${want}\n\nReturn ONLY a JSON object, no prose before or after, shaped exactly like:\n{"name":"short workflow name","nodes":[{"name":"agent name","prompt":"complete standalone instructions for this agent"}]}\nUse 2 to 5 nodes. Each node is an independent agent that runs in parallel and cannot see the others, so every prompt must stand alone, carry its own context, and name its expected output.`;
/* Lenient on the outside, strict on the inside. Models wrap JSON in prose and
   code fences no matter how firmly the brief says not to, so the object is cut
   from first "{" to last "}" - but a node without both a name and a prompt is
   dropped, and a result with no usable nodes is a failure the surface reports,
   never a half-drawn canvas. */
function parseComposedWorkflow(text){
  const s=String(text||""),a=s.indexOf("{"),b=s.lastIndexOf("}");
  if(a<0||b<=a)return null;
  try{
    const d=JSON.parse(s.slice(a,b+1));
    const nodes=(Array.isArray(d.nodes)?d.nodes:[])
      .filter(n=>n&&typeof n.name==="string"&&typeof n.prompt==="string"&&n.name.trim()&&n.prompt.trim())
      .slice(0,8).map(n=>({name:n.name.trim(),prompt:n.prompt.trim()}));
    if(!nodes.length)return null;
    return {name:(typeof d.name==="string"&&d.name.trim())||"Composed workflow",nodes};
  }catch{return null}
}
function mountWorkflow(p, body) {
  body.classList.add("workflow-surface");
  let workflows=workflowStore(), active=workflows[0]||{id:`wf-${Date.now().toString(36)}`,name:"New agent workflow",nodes:[],runs:[]};
  if(!workflows.length){workflows=[active];saveWorkflowStore(workflows)}
  body.innerHTML='<aside class="workflow-sidebar"><div class="wf-side-head"><small>RUNBOOK</small><button class="wf-new ghost sm">New</button></div><div class="wf-list"></div><div class="wf-templates"><small>TEMPLATES</small></div></aside><main class="workflow-main"><header><div><input class="wf-name" aria-label="Workflow name"><span class="wf-status">Draft</span></div><div class="wf-actions"><button class="wf-run primary sm">Run workflow</button><button class="wf-abort danger sm hidden">Stop</button></div></header><div class="wf-compose"><input class="wf-compose-say" placeholder="Describe the operation — the Crowe agents design the workflow" aria-label="Describe the operation to compose"><button class="wf-compose-go primary sm">Compose</button><small class="wf-compose-state"></small></div><div class="wf-canvas"></div><button class="wf-add ghost sm">Add an agent by hand</button><section class="wf-output"><div><b>Run output</b><button class="wf-copy ghost sm">Copy</button></div><pre>Select Run workflow to begin.</pre></section></main>';
  let aborted=false;
  const persist=()=>{const i=workflows.findIndex(x=>x.id===active.id);if(i<0)workflows.unshift(active);else workflows[i]=active;saveWorkflowStore(workflows)};
  const renderList=()=>{body.querySelector(".wf-list").innerHTML=workflows.map(w=>`<button data-id="${esc(w.id)}" class="${w.id===active.id?"active":""}"><b>${esc(w.name)}</b><small>${w.nodes.length} agents · ${(w.runs||[]).length} runs</small></button>`).join("");body.querySelectorAll(".wf-list button").forEach(b=>b.onclick=()=>{active=workflows.find(w=>w.id===b.dataset.id);render()})};
  const renderNodes=()=>{const canvas=body.querySelector(".wf-canvas");canvas.innerHTML=active.nodes.length?active.nodes.map((n,i)=>`<article class="wf-node" data-index="${i}"><div class="wf-node-top"><span>${String(i+1).padStart(2,"0")}</span><input class="wf-node-name" value="${esc(n.name)}" aria-label="Agent node name"><span class="wf-node-route"></span><button class="wf-node-remove ghost sm">Remove</button></div><textarea class="wf-node-prompt" rows="1" aria-label="Agent instructions">${esc(n.prompt)}</textarea><div class="wf-node-foot"><span class="wf-node-dot"></span><small class="wf-node-state">Ready</small></div><div class="wf-node-gate"></div></article>`).join(""):'<div class="wf-empty"><b>Say what the operation is</b><span>Describe it above and the Crowe agents design the workflow — or add nodes by hand.</span></div>';
    canvas.querySelectorAll(".wf-node").forEach(card=>{const i=+card.dataset.index;card.querySelector(".wf-node-name").onchange=e=>{active.nodes[i].name=e.target.value;persist();renderList()};const t=card.querySelector(".wf-node-prompt");t.onchange=e=>{active.nodes[i].prompt=e.target.value;persist()};
      // The instructions are prose on a page, not a box in a form: the field
      // grows to hold what the agents wrote, because clipped instructions read
      // as a broken surface and hide exactly what the operator is approving.
      const fit=()=>{t.style.height="auto";t.style.height=t.scrollHeight+"px"};t.oninput=fit;fit();
      card.querySelector(".wf-node-remove").onclick=()=>{active.nodes.splice(i,1);persist();renderNodes()}});
  };
  const render=()=>{body.querySelector(".wf-name").value=active.name;renderList();renderNodes()};
  body.querySelector(".wf-name").onchange=e=>{active.name=e.target.value||"Untitled workflow";persist();renderList()};
  body.querySelector(".wf-new").onclick=()=>{active={id:`wf-${Date.now().toString(36)}`,name:"New agent workflow",nodes:[],runs:[]};workflows.unshift(active);persist();render()};
  WORKFLOW_TEMPLATES.forEach(t=>{const b=document.createElement("button");b.className="wf-template";b.innerHTML=`<b>${esc(t.name)}</b><small>${t.nodes.length} agents</small>`;b.onclick=()=>{active={id:`wf-${Date.now().toString(36)}`,name:t.name,nodes:t.nodes.map(n=>({...n})),runs:[]};workflows.unshift(active);persist();render()};body.querySelector(".wf-templates").appendChild(b)});
  body.querySelector(".wf-add").onclick=()=>{active.nodes.push({name:`Crowe Agent ${active.nodes.length+1}`,prompt:"Describe this agent's responsibility and expected output."});persist();renderNodes();renderList()};
  /* Composing is itself a harness turn - it routes, it can fail, and it answers
     on its own agent id so the chat transcript never draws its events. What it
     never does is guess: a reply that does not parse into nodes leaves the
     canvas exactly as it was, with the failure named where the operator typed. */
  const composeSay=body.querySelector(".wf-compose-say"),composeGo=body.querySelector(".wf-compose-go"),composeState=body.querySelector(".wf-compose-state");
  const compose=async()=>{
    const want=composeSay.value.trim();if(!want||composeGo.disabled)return;
    const id=`${p.id}-compose`;
    composeGo.disabled=true;composeState.textContent="Designing";
    let text="",failure="";
    const off=window.crowe.agent.onEvent(ev=>{
      if(ev.agentId!==id)return;
      if(ev.type==="route")composeState.textContent=`Designing · ${ev.expert||"operator"} · ${ev.model||""}`.trim();
      else if(ev.type==="assistant_delta"||(ev.type==="assistant"&&!ev.streamed))text+=(ev.text||"");
      else if(ev.type==="error")failure=ev.text||"the gateway call failed";
    });
    try{
      const r=await window.crowe.agent.run([{role:"user",content:COMPOSE_ASK(want)}],id,{licensed:p.licensed,workspaceId:p.workspaceId});
      if(r&&r.error)failure=failure||r.error;
      text=text||(r&&r.text)||"";
    }catch(e){failure=failure||(e&&e.message)||String(e)}
    finally{off()}
    const drafted=!failure&&parseComposedWorkflow(text);
    if(!drafted){composeState.textContent=`Failed · ${(failure||"the agent did not return a workflow").slice(0,90)}`;composeGo.disabled=false;return}
    active={id:`wf-${Date.now().toString(36)}`,name:drafted.name,nodes:drafted.nodes,runs:[]};
    workflows.unshift(active);persist();render();
    composeState.textContent=`Composed ${drafted.nodes.length} agents`;composeSay.value="";composeGo.disabled=false;
  };
  composeGo.onclick=compose;composeSay.onkeydown=e=>{if(e.key==="Enter")compose()};
  const abort=body.querySelector(".wf-abort"),run=body.querySelector(".wf-run"),status=body.querySelector(".wf-status"),out=body.querySelector(".wf-output pre");
  abort.onclick=()=>{aborted=true;active.nodes.forEach((_,i)=>window.crowe.agent.stop(`${p.id}-${i}`));status.textContent="Aborted"};
  /* One node's run. Every node is a full harness turn, which means it routes to
     an expert, calls tools, can be stopped at the approval gate, and can fail -
     and the surface used to listen for exactly one of those things. Two
     consequences, both of which read as "workflows do not work":

     A node that touched the workspace raised an approval request nobody drew.
     The only listener that rendered a gate card was the chat transcript's,
     registered per chat turn, so the request went to no one and the node sat on
     "Running" for the five-minute timeout before being denied by default.

     And a node that failed reported "Completed.", because the fallback chain
     ended in that string and `error` events were dropped on the floor. The dot
     went green on a turn that had gone nowhere.

     So the node now shows what the router chose, what the agent is doing, hosts
     its own gate card, and says plainly when it failed. */
  const runNode=async(n,i)=>{
    const id=`${p.id}-${i}`;
    const card=body.querySelector(`.wf-node[data-index="${i}"]`);
    const dot=card&&card.querySelector(".wf-node-dot"),stateEl=card&&card.querySelector(".wf-node-state");
    const routeEl=card&&card.querySelector(".wf-node-route"),gate=card&&card.querySelector(".wf-node-gate");
    const say=t=>{if(stateEl)stateEl.textContent=t};
    let text="",failure="",routed="",verdict=null,tools=0;
    const off=window.crowe.agent.onEvent(ev=>{
      if(ev.agentId!==id)return;
      if(ev.type==="route"){routed=`${ev.expert||"operator"} · ${ev.model||""}`.trim();if(routeEl)routeEl.textContent=routed;say("Reasoning")}
      else if(ev.type==="assistant_delta"||(ev.type==="assistant"&&!ev.streamed))text+=(ev.text||"");
      else if(ev.type==="tool_call"){tools++;say(`Running ${ev.name||"tool"}`)}
      else if(ev.type==="approval_request"){say("Waiting on your approval");if(dot)dot.classList.add("waiting");if(gate)addApproval(gate,ev)}
      else if(ev.type==="approval_expired"){expireApproval(ev.id);if(dot)dot.classList.remove("waiting")}
      else if(ev.type==="retry")say(`Retrying (${ev.attempt}/${ev.of})`);
      else if(ev.type==="verdict")verdict=ev;
      else if(ev.type==="error")failure=ev.text||"the gateway call failed";
      else if(ev.type==="stopped")failure="stopped";
    });
    try{
      const r=await window.crowe.agent.run([{role:"user",content:n.prompt}],id,{licensed:p.licensed,workspaceId:p.workspaceId});
      // The handler resolves with an error rather than throwing when a license
      // or entitlement check refuses the run, so that shape counts as a failure.
      if(r&&r.error)failure=failure||r.error;
      text=text||(r&&r.text)||"";
      if(!failure&&!text)failure="the agent returned nothing";
    }catch(e){failure=failure||(e&&e.message)||String(e)}
    finally{off()}
    if(dot){dot.classList.remove("running","waiting");dot.classList.add(failure?"failed":"done")}
    say(failure?`Failed · ${failure}`.slice(0,120):`Done · ${tools} tool call${tools===1?"":"s"}`);
    return {name:n.name,routed,text,failure,verdict};
  };
  run.onclick=async()=>{if(!active.nodes.length)return;aborted=false;run.classList.add("hidden");abort.classList.remove("hidden");status.textContent="Running";out.textContent="Launching parallel agents...";
    body.querySelectorAll(".wf-node-gate").forEach(g=>{g.innerHTML=""});
    body.querySelectorAll(".wf-node-route").forEach(r=>{r.textContent=""});
    body.querySelectorAll(".wf-node-dot").forEach(x=>{x.classList.remove("done","failed","waiting");x.classList.add("running")});
    body.querySelectorAll(".wf-node-state").forEach(s=>{s.textContent="Queued"});
    const results=await Promise.all(active.nodes.map(runNode));
    const failed=results.filter(r=>r.failure).length;
    const report=results.map(r=>{
      const head=`## ${r.name}${r.routed?`\n\n_${r.routed}_`:""}`;
      if(r.failure)return `${head}\n\n**Failed:** ${r.failure}`;
      const receipt=r.verdict?`\n\n_Verification ${r.verdict.status}: ${r.verdict.summary||""}_`:"";
      return `${head}\n\n${r.text}${receipt}`;
    }).join("\n\n");
    out.textContent=report;
    // The run's own status has to say it, not just the dots: a run where two of
    // three nodes failed is not a completed run.
    const outcome=aborted?"Aborted":failed===results.length?"Failed":failed?`${failed} of ${results.length} failed`:"Completed";
    active.runs.unshift({at:Date.now(),status:outcome.toLowerCase(),output:report});active.runs=active.runs.slice(0,20);persist();
    status.textContent=outcome;run.classList.remove("hidden");abort.classList.add("hidden");renderList()};
  body.querySelector(".wf-copy").onclick=e=>copyText(out.textContent,e.currentTarget);
  /* Chat authors into the Runbook mid-conversation (workflow_authored below).
     The store is the truth, so the panel re-reads it on that signal - fully
     when idle, sidebar-only mid-run, because redrawing the canvas under a
     running run would orphan the cards its events are landing on. */
  body.addEventListener("crowe:workflows-changed",()=>{workflows=workflowStore();if(!abort.classList.contains("hidden")){renderList();return}active=workflows[0]||active;render()});
  render();
}
/* The other half of the harness's compose_workflow tool: the agent authored a
   workflow in chat, and this is where it lands. Saved first - the store is the
   artifact - then shown: an open Runbook panel re-reads the store in place, and
   if none is open the canvas opens itself, because an artifact the user has to
   go hunting for reads as a tool call that did nothing. */
function workflowAuthored(ev){
  if(ev.type!=="workflow_authored"||!ev.workflow)return;
  const wfs=workflowStore();
  wfs.unshift({id:`wf-${Date.now().toString(36)}`,name:String(ev.workflow.name||"Composed workflow"),nodes:(ev.workflow.nodes||[]).map(n=>({name:String(n.name||""),prompt:String(n.prompt||"")})),runs:[]});
  saveWorkflowStore(wfs);
  const p=panels.find(x=>x.type==="workflow");
  if(!p){addPanel("workflow");return}
  const bodyEl=panelDeck.querySelector(`[data-id="${p.id}"] .panel-body`);
  if(bodyEl)bodyEl.dispatchEvent(new Event("crowe:workflows-changed"));
}
window.crowe.agent.onEvent(workflowAuthored);
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
  const runAgent=async(id,content)=>{let answer="";const off=window.crowe.agent.onEvent(ev=>{if(ev.agentId===id&&(ev.type==="assistant_delta"||(ev.type==="assistant"&&!ev.streamed)))answer+=(ev.text||"")});try{const r=await window.crowe.agent.run([{role:"user",content}],id);return answer||(r&&r.text)||"Completed."}catch(e){return `Run failed: ${e.message||e}`}finally{off()}};
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

/* A room: several named agents and the operator in one thread.

   The surface is built around the two facts that make a room different from a
   thread, and it refuses to bury either one. Every message wears the name of
   the agent that wrote it, never a generic assistant label, because "which
   specialist said this" is the whole reason there is more than one. And the
   roster strip carries live state and live cost per seat, in the room rather
   than in a settings pane, because a three-agent room with a two-round critique
   loop is roughly nine calls where the app used to make one and the operator
   should be able to watch that happen.

   Critique and revise are buttons rather than remembered commands, and each one
   states what it is about to spend before it spends it. */
async function mountRoom(p, body, seed = {}) {
  const wrap = document.createElement("div"); wrap.className = "room";
  wrap.innerHTML = `
    <div class="room-roster" role="list" aria-label="Room roster"></div>
    <div class="room-thread" aria-live="polite"></div>
    <div class="room-rounds">
      <button class="room-critique ghost sm" disabled>Critique</button>
      <button class="room-revise ghost sm" disabled>Revise</button>
      <span class="room-cap"></span>
      <span class="spacer"></span>
      <span class="room-meter" title="Spent of this room's budget"></span>
    </div>
    <form class="room-composer">
      <input class="room-input" autocomplete="off" spellcheck="false"
             placeholder="Address the room with @room, or one agent with @name" aria-label="Message the room">
      <button class="room-send primary sm" type="submit">Send</button>
      <div class="room-suggest hidden" role="listbox"></div>
    </form>`;
  body.appendChild(wrap);

  const roster = wrap.querySelector(".room-roster");
  const thread = wrap.querySelector(".room-thread");
  const input = wrap.querySelector(".room-input");
  const suggest = wrap.querySelector(".room-suggest");
  const bCrit = wrap.querySelector(".room-critique");
  const bRev = wrap.querySelector(".room-revise");
  const capEl = wrap.querySelector(".room-cap");
  const meter = wrap.querySelector(".room-meter");

  let state = null, busy = false;

  const money = (n) => "$" + Number(n || 0).toFixed(3);

  function drawRoster() {
    roster.innerHTML = "";
    for (const a of (state?.agents || [])) {
      const el = document.createElement("div");
      el.className = "seat" + (a.state === "working" || a.state === "queued" ? " live" : "") + (a.state === "failed" ? " bad" : "");
      el.setAttribute("role", "listitem");
      el.innerHTML = `<span class="seat-name">${esc(a.name || a.agentId)}</span>
        <span class="seat-model">${esc(a.model || "room default")}</span>
        <span class="seat-state" data-state="${esc(a.state || "idle")}">${esc(a.state || "idle")}</span>
        <span class="seat-cost">${money(a.cost?.usd)}<em>${a.cost?.calls || 0} calls</em></span>`;
      roster.appendChild(el);
    }
  }

  function drawThread() {
    thread.innerHTML = "";
    for (const m of (state?.messages || [])) {
      const mine = m.author === ":operator";
      const el = document.createElement("div");
      el.className = "rmsg" + (mine ? " from-operator" : "") + (m.kind === "critique" ? " is-critique" : "");
      const who = mine ? "You" : (state.agents.find((a) => a.agentId === m.author)?.name || m.author);
      el.innerHTML = `<div class="rmsg-who">${esc(who)}${m.kind === "critique" ? '<span class="rmsg-tag">reviewing</span>' : ""}</div>
        <div class="rmsg-body">${md(m.content || "")}</div>`;
      thread.appendChild(el);
    }
    thread.scrollTop = thread.scrollHeight;
  }

  /* The projected call count rides on the button itself. A round that is about
     to make three calls should say three before it is pressed, not after. */
  async function drawRounds() {
    const positions = (state?.messages || []).filter((m) => m.kind === "reply").length;
    const critiques = (state?.messages || []).filter((m) => m.kind === "critique").length;
    const capped = (state?.critiqueRounds || 0) >= (state?.maxCritiqueRounds || 2);
    const halted = Boolean(state?.halted);

    const [pc, pr] = await Promise.all([
      window.crowe.rooms.project(p.roomId, "critique"),
      window.crowe.rooms.project(p.roomId, "revise"),
    ]);
    bCrit.textContent = `Critique · ${pc.calls || 0} calls`;
    bRev.textContent = `Revise · ${pr.calls || 0} calls`;
    bCrit.disabled = busy || halted || capped || positions < 2;
    bRev.disabled = busy || halted || critiques < 1;
    capEl.textContent = capped ? `critique capped at ${state.maxCritiqueRounds} rounds`
      : halted ? `room halted: ${state.halted}` : "";
    meter.textContent = `${money(state?.spentUsd)} of ${money(state?.budgetUsd)}`;
    meter.classList.toggle("over", halted);
  }

  const paint = async () => { drawRoster(); drawThread(); await drawRounds(); };

  async function refresh() {
    const r = await window.crowe.rooms.load(p.roomId);
    if (r?.error) { thread.innerHTML = `<div class="card-empty">${esc(r.error)}</div>`; return; }
    state = { ...r.room, messages: r.messages || [] };
    p.title = state.title || p.title;
    await paint();
  }

  async function round(fn) {
    if (busy) return;
    busy = true; await drawRounds();
    try {
      const out = await fn();
      if (out?.room) state = { ...out.room, messages: state.messages };
      await refresh();
    } finally { busy = false; await drawRounds(); }
  }

  wrap.querySelector(".room-composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim(); if (!text || busy) return;
    input.value = ""; suggest.classList.add("hidden");
    await round(() => window.crowe.rooms.say(p.roomId, text));
  });
  bCrit.addEventListener("click", () => round(() => window.crowe.rooms.critique(p.roomId)));
  bRev.addEventListener("click", () => round(() => window.crowe.rooms.revise(p.roomId)));

  // @mention autocomplete off the room's own roster, so a handle that is not in
  // this room is never offered.
  input.addEventListener("input", () => {
    const m = input.value.match(/@([\w-]*)$/);
    if (!m || !state) { suggest.classList.add("hidden"); return; }
    const q = m[1].toLowerCase();
    const opts = [{ agentId: "room", name: "Everyone in the room" }, ...state.agents]
      .filter((a) => a.agentId.toLowerCase().includes(q) || String(a.name).toLowerCase().replace(/\s+/g, "").includes(q));
    if (!opts.length) { suggest.classList.add("hidden"); return; }
    suggest.innerHTML = "";
    for (const a of opts) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "sug";
      b.innerHTML = `<b>@${esc(a.agentId)}</b><span>${esc(a.name)}</span>`;
      b.addEventListener("click", () => {
        input.value = input.value.replace(/@([\w-]*)$/, "@" + a.agentId + " ");
        suggest.classList.add("hidden"); input.focus();
      });
      suggest.appendChild(b);
    }
    suggest.classList.remove("hidden");
  });

  /* A room panel opens on the composer unless it was handed a room to resume.

     Opening straight into a fixed template was the shortcut that made Rooms
     look like a cultivation feature: the roster underneath spans sixteen
     domains and the panel only ever showed three of them. Composing first is
     also the honest order - who is in the room is the decision, and it should
     be made before the room costs anything. */
  if (seed.roomId) { p.roomId = seed.roomId; wrap.classList.remove("composing"); await refresh(); return; }

  const composer = document.createElement("div");
  composer.className = "room-compose";
  wrap.classList.add("composing");
  wrap.prepend(composer);

  const { agents = [], templates = [] } = await window.crowe.rooms.agents();
  const picked = new Set();

  const byDomain = agents.reduce((m, a) => ((m[a.domain || "other"] = m[a.domain || "other"] || []).push(a), m), {});
  composer.innerHTML = `
    <div class="rc-head">
      <b>Open a room</b>
      <span>A room earns its cost when a decision has more than one binding constraint. Where there is only one, a single agent is the right answer.</span>
    </div>
    <div class="rc-templates"></div>
    <div class="rc-own">
      <div class="rc-sub">Or compose your own</div>
      <div class="rc-agents"></div>
      <div class="rc-actions">
        <input class="rc-name" placeholder="Name this room" aria-label="Room name">
        <label class="rc-budget">Budget <input class="rc-budget-input" type="number" min="0" step="0.25" value="1.00" aria-label="Room budget in dollars"></label>
        <span class="rc-count"></span>
        <button class="rc-open primary sm" disabled>Open</button>
      </div>
    </div>`;

  const tWrap = composer.querySelector(".rc-templates");
  for (const t of templates) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "rc-template";
    b.innerHTML = `<b>${esc(t.name)}</b><span>${esc(t.purpose || "")}</span>
      <em>${t.agents.map((a) => esc(a.name || a.id)).join(" · ")}</em>`;
    b.addEventListener("click", () => open({ template: t.id }));
    tWrap.appendChild(b);
  }

  const aWrap = composer.querySelector(".rc-agents");
  const countEl = composer.querySelector(".rc-count");
  const openBtn = composer.querySelector(".rc-open");
  const nameEl = composer.querySelector(".rc-name");

  const syncPick = () => {
    countEl.textContent = picked.size
      ? `${picked.size} agent${picked.size === 1 ? "" : "s"}${picked.size === 1 ? " — a room of one behaves like an ordinary thread" : ""}`
      : "";
    openBtn.disabled = picked.size === 0;
  };

  for (const [domain, list] of Object.entries(byDomain)) {
    const g = document.createElement("div"); g.className = "rc-group";
    g.innerHTML = `<div class="rc-domain">${esc(domain)}</div>`;
    for (const a of list) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "rc-agent"; b.title = a.role || "";
      b.innerHTML = `<b>${esc(a.name)}</b><span>${esc(a.autonomyCeiling || "plan")}</span>`;
      b.addEventListener("click", () => {
        if (picked.has(a.id)) { picked.delete(a.id); b.classList.remove("on"); }
        else { picked.add(a.id); b.classList.add("on"); }
        syncPick();
      });
      g.appendChild(b);
    }
    aWrap.appendChild(g);
  }
  syncPick();

  async function open(opts) {
    openBtn.disabled = true;
    const made = await window.crowe.rooms.create({
      budgetUsd: Number(composer.querySelector(".rc-budget-input").value) || undefined,
      ...opts,
    });
    if (made?.error) { countEl.textContent = made.error; openBtn.disabled = false; return; }
    p.roomId = made.room.id;
    composer.remove();
    wrap.classList.remove("composing");
    await refresh();
    renderDockTabs();
  }

  openBtn.addEventListener("click", () => open({
    agentIds: [...picked],
    title: nameEl.value.trim() || "Room",
  }));
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
$("panel-add-term").onclick=()=>addPanel("terminal");$("panel-add-agent").onclick=()=>addPanel("agent",{title:`Crowe Logic Agent ${panels.filter(p=>p.type==="agent").length+1}`});$("panel-add-system").onclick=()=>{const existing=panels.find(p=>p.type==="system");if(existing){focusPanel(existing.id);return}addPanel("system")};$("panel-add-browser").onclick=()=>addPanel("browser");$("panel-add-operator").onclick=()=>addPanel("operator");$("panel-add-workflow").onclick=()=>addPanel("workflow");$("panel-add-agents").onclick=()=>addPanel("agents");$("panel-add-workbench").onclick=()=>addPanel("workbench");$("panel-add-room").onclick=()=>addPanel("room");
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
/* The phone companion pane.

   The QR is drawn in the main process and arrives as finished markup, so the
   pairing token — which is a shell credential — is never a string this side
   holds, and cannot end up in a log line or a crash report. It is only
   requested while the companion is actually running. */
async function renderCompanion(){
  const body = $("companion-body"), badge = $("companion-state");
  if (!body) return;
  const s = await window.crowe.companion.status();
  const running = Boolean(s && s.running);
  badge.textContent = running ? `Listening on ${s.host}` : (s && s.tailscale ? "Off" : "Tailscale not found");
  const rows = [];
  if (!running) {
    rows.push(s && s.tailscale
      ? `<p class="said">This machine is <b>${s.tailscale}</b> on your tailnet. Start the companion and scan the code with the Crowe Logic app on your phone.</p>`
      : `<p class="said">No Tailscale address on this machine. The phone reaches this app over the tailnet rather than the open internet, so install Tailscale and sign in, then reopen Settings.</p>`);
    rows.push(`<button id="companion-start" class="primary sm"${s && s.tailscale ? "" : " disabled"}>Start companion</button>`);
  } else {
    rows.push('<div id="companion-qr" style="display:flex;justify-content:center;padding:10px 0"></div>');
    rows.push(`<p class="said">Open Crowe Logic on your phone and scan this. The code carries the address and a one-machine token; it stops working the moment you press Stop or Rotate.</p>`);
    // Said out loud, because it is a real trade and the user is entitled to
    // know why the battery went down: a phone can only reach a machine that is
    // awake, so the companion holds this one awake while it is listening.
    if (s.keepingAwake) rows.push('<p class="said">This Mac is being kept awake while the companion runs, so the phone can reach it. The display still sleeps.</p>');
    rows.push('<div style="display:flex;gap:8px;flex-wrap:wrap"><button id="companion-stop" class="ghost sm">Stop</button><button id="companion-add" class="ghost sm">Add a device</button><button id="companion-rotate" class="ghost sm">Revoke all</button></div>');

    /* Which devices can drive this machine, and what they have done.

       One shared token made "I lost my phone" and "unpair everything I own" the
       same action, and made the log able to say only that something ran. A
       device each fixes both: revoke the one that is gone, and every line says
       who. */
    const devices = s.devices || [];
    if (devices.length) {
      rows.push('<div class="settings-section-head" style="margin-top:12px"><div><b>Paired devices</b></div></div>');
      rows.push(devices.map((d) => {
        const seen = d.lastSeen ? new Date(d.lastSeen).toLocaleString() : "never used";
        return `<div class="key-provider" style="display:flex;align-items:center;gap:10px">
          <div style="flex:1"><b>${esc(d.name)}</b><br><span class="said" style="opacity:.7">last used ${esc(seen)}</span></div>
          <button class="ghost sm companion-revoke" data-id="${d.id}">Revoke</button></div>`;
      }).join(""));
    }
    rows.push('<div class="settings-section-head" style="margin-top:12px"><div><b>Recent activity</b><span>What the paired devices have run on this machine.</span></div></div>');
    rows.push('<div id="companion-audit" class="said" style="max-height:180px;overflow:auto;font-family:var(--mono);font-size:12px"></div>');
  }
  body.innerHTML = rows.join("");
  const start = $("companion-start");
  if (start) start.onclick = async () => {
    start.disabled = true; start.textContent = "Starting";
    const r = await window.crowe.companion.start();
    if (r && r.error) { body.innerHTML = `<p class="said">${r.error}</p>`; return; }
    renderCompanion();
  };
  const stop = $("companion-stop");
  if (stop) stop.onclick = async () => { await window.crowe.companion.stop(); renderCompanion(); };
  const rotate = $("companion-rotate");
  if (rotate) rotate.onclick = async () => {
    if (!confirm("Revoke every paired device?\n\nAll of them stop working until they scan a new code. To remove just one, use Revoke beside its name.")) return;
    await window.crowe.companion.rotate();
    renderCompanion();
  };
  const add = $("companion-add");
  if (add) add.onclick = async () => {
    const name = prompt("Name this device, so the log and the revoke button mean something later.", "iPhone");
    if (name === null) return;
    const r = await window.crowe.companion.addDevice(name);
    if (r && r.error) { alert(r.error); return; }
    await renderCompanion();
    // Show the new device's code rather than the most recent one generally,
    // since the point of adding a device is to pair that device.
    const host = $("companion-qr");
    if (host && r && r.svg) host.innerHTML = r.svg;
  };
  body.querySelectorAll(".companion-revoke").forEach((b) => {
    b.onclick = async () => {
      const row = b.closest(".key-provider");
      const label = row ? (row.querySelector("b") || {}).textContent : "this device";
      if (!confirm(`Revoke ${label}?\n\nIt stops working immediately. Other paired devices are unaffected.`)) return;
      await window.crowe.companion.revokeDevice(b.dataset.id);
      renderCompanion();
    };
  });
  const auditHost = $("companion-audit");
  if (auditHost) {
    const entries = await window.crowe.companion.audit(40);
    auditHost.innerHTML = entries.length
      ? entries.map((e) => {
        const when = new Date(e.at).toLocaleTimeString();
        const what = e.kind === "run" ? `${e.command || ""}${e.exit ? ` (exit ${e.exit})` : ""}`
          : e.kind === "denied" ? `refused: ${e.reason || ""}`
          : `${e.kind} ${e.path || ""}`;
        return `<div>${esc(when)} · ${esc(e.device || "unknown")} · ${esc(String(what).slice(0, 160))}</div>`;
      }).join("")
      : '<div style="opacity:.7">Nothing yet.</div>';
  }
  if (running) {
    const r = await window.crowe.companion.pairSvg();
    const host = $("companion-qr");
    if (host) host.innerHTML = r && r.svg ? r.svg : `<p class="said">${(r && r.error) || "could not draw the code"}</p>`;
  }
}

async function renderKeyManager(){
  const result=await window.crowe.keys.list(),host=$("key-provider-list"),vault=$("key-vault-state");
  vault.textContent=result.encrypted?"Native vault ready":"Vault unavailable";
  host.innerHTML=(result.providers||[]).map(x=>`<div class="key-provider" data-provider="${x.id}"><div><b>${esc(x.label)}</b><span>${x.configured?(x.healthy?"Connected · tested ":"Configured securely · ")+(x.testedAt?new Date(x.testedAt).toLocaleDateString():"not tested"):"Not configured"}</span></div><input type="password" autocomplete="new-password" spellcheck="false" placeholder="${x.configured?"Replace existing key":"Enter API key"}"><button class="key-save ghost sm">Save</button><button class="key-test ghost sm" ${x.configured?"":"disabled"}>Test</button><button class="key-remove ghost sm" ${x.configured?"":"disabled"}>Remove</button></div>`).join("");
  host.querySelectorAll(".key-provider").forEach(row=>{const id=row.dataset.provider,input=row.querySelector("input");row.querySelector(".key-save").onclick=async()=>{if(!input.value.trim())return;await window.crowe.keys.set(id,input.value.trim());input.value="";renderKeyManager()};row.querySelector(".key-test").onclick=async e=>{e.currentTarget.textContent="Testing";const r=await window.crowe.keys.test(id);e.currentTarget.textContent=r.ok?"Connected":"Failed"};row.querySelector(".key-remove").onclick=async()=>{if(!confirm(`Remove the ${id} credential from the native vault?`))return;await window.crowe.keys.remove(id);renderKeyManager()}});
}
// Rows are built from the space registry rather than listed here, so a space
// added to SPACES is offered without a second edit — the same reason the nav
// handlers and palette entries are generated from it.
//
// This one writes through on change instead of waiting for Save, matching the
// key manager and the plugin rows either side of it: the effect is visible
// behind the modal, so a toggle that did nothing until Save would read as
// broken. Cancel does not undo it, for the same reason it does not un-enable a
// plugin.
function renderSpacePicker() {
  const box = $("cfg-spaces"); if (!box) return;
  box.innerHTML = "";
  for (const [id, sp] of Object.entries(SPACES)) {
    const fixed = id === "chat"; // the thread every other space funnels into
    const row = document.createElement("label");
    row.className = "chk";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.dataset.space = id;
    cb.checked = PROFILE.has(id); cb.disabled = fixed;
    cb.addEventListener("change", () => {
      setSpaceProfile([...box.querySelectorAll("input:checked")].map((i) => i.dataset.space));
    });
    const name = document.createElement("span");
    name.textContent = sp.label;
    row.append(cb, name);
    if (fixed) { const tag = document.createElement("em"); tag.className = "plug-tag"; tag.textContent = "always on"; row.append(tag); }
    box.append(row);
  }
}

$("settings-btn").addEventListener("click", async () => {
  const c = await window.crowe.getConfig();
  $("cfg-base").value = c.baseUrl; $("cfg-cwd").value = c.cwd || ""; $("cfg-token").value = "";
  $("cfg-auto").checked = Boolean(c.autoApprove);
  $("cfg-approvals").value = c.approvals || "high-risk";
  $("cfg-verifier").checked = c.verifier !== false;
  $("cfg-budget").value = Number(c.turnBudgetUsd ?? 2);
  $("cfg-status").textContent = (c.hasToken ? "Token set. " : "No token yet. ") + (c.ptyAvailable ? "PTY ready." : "PTY unavailable.");
  renderSpacePicker(); renderPlugins(); renderKeyManager(); renderCompanion();
  modal.classList.remove("hidden");
});
$("cfg-cancel").addEventListener("click", () => modal.classList.add("hidden"));
$("cfg-save").addEventListener("click", async () => {
  const budget = Number($("cfg-budget").value);
  const patch = { baseUrl: $("cfg-base").value.trim(), cwd: $("cfg-cwd").value.trim(), autoApprove: $("cfg-auto").checked,
    approvals: $("cfg-approvals").value, verifier: $("cfg-verifier").checked,
    turnBudgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : 2 };
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
/* WELCOME_HTML is a string taken at load, which is before liveLockups() has
   swapped the static mask for the inlined svg. So restoring it puts back a dead
   lockup: the logotype is on screen, correctly drawn, and completely still. A
   still copy of a mark whose whole job is to look awake reads worse than no mark
   at all - it reads as the app having stopped, on the one screen a new chat
   starts from.

   liveLockups is safe to call again by construction: it skips lockups that
   already carry their svg, and it indexes ids over every lockup rather than over
   the pending ones, so the header's are never renumbered out from under it. */
function resetWelcome() { transcript.innerHTML = WELCOME_HTML; bindChips(); liveLockups(); }
async function newChat() {
  await window.crowe.sessions.new();
  messages.length = 0;
  resetWelcome();
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
  if (!any) resetWelcome();
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
  training: { title: "Training", sub: "Fine-tune runs for the CroweLM experts.", pending: "Endpoint pending. Lands with the crowe-nimbus training API." },
  evals: { title: "Evals", sub: "Capability suites across the deployment fleet.", pending: "Endpoint pending. /api/gateway/evals is on the nimbus roadmap." },
  deployments: { title: "Deployments", sub: "Every model the gateway serves, with its routing flags." },
  storage: { title: "Storage", sub: "Releases, datasets, and artifacts.", pending: "R2 browser pending. Release downloads are already live." },
};
let cultLane = "home";

// Each space is a descriptor rather than another arm of an if/else. setSpace had
// grown one branch per space, and adding one meant editing four places that all
// had to agree: the workbench predicate, both nav toggles, and the surface
// switch. Forget one and you get a nav bar stuck open over the wrong space.
// A descriptor keeps a space's answers to those questions in one object, which
// also makes "which spaces does this install have" a data question — see PROFILE.
//
//   workbench()  true when this space wants the terminal workbench instead of a surface
//   open()       reveal this space's surface (skipped entirely when workbench() wins)
//   nav          id of the lane rail that belongs to this space, if it has one
//   laneAttr     the data-* key its rail items carry
//   lane(v)      read the current lane with no argument, set it with one
const SPACES = {
  chat: {
    label: "Chat",
    drawer: true,
    workbench: () => true,
  },
  projects: {
    label: "Projects",
    nav: "space-nav", laneAttr: "lane",
    lane: (v) => (v === undefined ? projLane : (projLane = v)),
    // Deep work is the one lane that wants the workbench rather than a surface.
    workbench: () => projLane === "deepwork",
    open() {
      if (projLane === "home") { SURFACES.home.classList.remove("hidden"); refreshHome(); }
      else { SURFACES.lane.classList.remove("hidden"); renderLane(projLane); }
    },
  },
  studio: {
    label: "Studio",
    open() { SURFACES.studio.classList.remove("hidden"); },
  },
  cultivation: {
    label: "Cultivation",
    nav: "cult-nav", laneAttr: "cult",
    lane: (v) => (v === undefined ? cultLane : (cultLane = v)),
    // Cultivation borrows the same lane surface Projects uses. Its records are
    // the same kind of thing as the lanes over there — rows you scan, not a
    // conversation — so they get the same list rather than a parallel one.
    open() {
      if (cultLane === "home") { SURFACES.cultivation.classList.remove("hidden"); refreshCult(); }
      else if (cultLane === "trace") { SURFACES.lane.classList.remove("hidden"); renderTrace(); }
      else { SURFACES.lane.classList.remove("hidden"); renderGrowLane(cultLane); }
    },
  },
};

// Which spaces this install shows. Cultivation is a mushroom farm's surface and
// Studio is a film and music one; neither earns its tab on a machine installed
// to drive a terminal. Chat is never optional — it is the thread every other
// space funnels into — so it is added back regardless of what is stored.
let PROFILE = new Set(Object.keys(SPACES));

// What this install shows before anyone has touched the picker. Normally every
// space; on a build packaged for a narrower job, whatever that build declared -
// see installSpaces() in main.js.
//
// Read on every call rather than snapshotted into a const, so the default is a
// question the code asks rather than a fact it captured at load. That is what
// lets a test stand up a narrowed install without relaunching Electron.
//
// Filtered against SPACES here, at the one place that knows what a space is.
// Main deliberately ships the configured names through unchecked, so a typo or
// a space deleted in a later version lands here and is dropped, rather than
// putting a dead id into PROFILE and hiding a rail button that has no owner.
function defaultSpaceIds() {
  const all = Object.keys(SPACES);
  const declared = window.crowe && window.crowe.installSpaces;
  if (!Array.isArray(declared) || !declared.length) return all;
  const wanted = new Set(declared);
  return all.filter((id) => id === "chat" || wanted.has(id));
}

function applySpaceProfile() {
  let ids = null;
  try {
    const raw = localStorage.getItem("crowe-spaces");
    if (raw) { const parsed = JSON.parse(raw); if (Array.isArray(parsed) && parsed.length) ids = parsed; }
  } catch {}
  PROFILE = ids ? new Set(["chat", ...ids.filter((id) => SPACES[id])]) : new Set(defaultSpaceIds());
  for (const [id, sp] of Object.entries(SPACES)) {
    const on = PROFILE.has(id);
    const btn = document.querySelector(`#spaces .seg-btn[data-space="${id}"]`);
    if (btn) btn.classList.toggle("hidden", !on);
    if (sp.nav && !on) $(sp.nav).classList.add("hidden");
  }
  const cur = document.body.dataset.space;
  if (cur && !PROFILE.has(cur)) setSpace("chat");
}

// Stored as the whole enabled list, chat included, so the value reads the same
// as what the picker shows rather than as a diff you have to reconstruct.
//
// A picker choice that matches the install default stores nothing at all. That
// matters for the next version: a saved list is a closed set, so a space added
// later would be absent from every existing install's list and silently never
// appear. Storing only a deliberate divergence means an ordinary install's
// default stays "everything", and only someone who actually changed it keeps a
// list that can go stale.
//
// Compared against defaultSpaceIds() rather than the whole registry, which is
// the part that breaks if you get it wrong. On a build shipping Chat and
// Projects only, someone who ticks all four boxes has made a real choice - but
// against "is this everything?" it looks like a reset, so nothing gets written,
// and the next launch falls back to the build's two and silently discards what
// they asked for. Measuring against the default makes both directions storable.
function setSpaceProfile(ids) {
  const all = Object.keys(SPACES);
  const keep = all.filter((id) => id === "chat" || ids.includes(id));
  // Both are built by filtering `all`, so they are in registry order and can be
  // compared as strings rather than as sets.
  const isDefault = keep.join() === defaultSpaceIds().join();
  try {
    if (isDefault) localStorage.removeItem("crowe-spaces");
    else localStorage.setItem("crowe-spaces", JSON.stringify(keep));
  } catch {}
  applySpaceProfile();
}

function setSpace(name) {
  // A space that was dropped from the profile can still be reached from restored
  // state or the palette, so fall back rather than render a half-hidden shell.
  if (!SPACES[name] || !PROFILE.has(name)) name = "chat";
  const space = SPACES[name];
  document.body.dataset.space = name;
  document.querySelectorAll("#spaces .seg-btn").forEach((b) => {
    const on = b.dataset.space === name;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
  });
  const showWb = !!(space.workbench && space.workbench());
  workbench.classList.toggle("hidden", !showWb);
  for (const [id, sp] of Object.entries(SPACES)) if (sp.nav) $(sp.nav).classList.toggle("hidden", id !== name);
  drawer.classList.toggle("hidden", !space.drawer);
  Object.values(SURFACES).forEach((s) => s.classList.add("hidden"));
  if (!showWb && space.open) space.open();
  if (showWb) setTimeout(() => { clampWorkbenchSplit(); fitTerminals(); }, 30);
  try { localStorage.setItem("crowe-space", name); } catch {}
}
document.querySelectorAll("#spaces .seg-btn").forEach((b) => b.addEventListener("click", () => setSpace(b.dataset.space)));
for (const [id, space] of Object.entries(SPACES)) {
  if (!space.nav) continue;
  document.querySelectorAll(`#${space.nav} .sn-item`).forEach((b) => b.addEventListener("click", () => {
    space.lane(b.dataset[space.laneAttr]);
    document.querySelectorAll(`#${space.nav} .sn-item`).forEach((x) => x.classList.toggle("active", x === b));
    setSpace(id);
  }));
}

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
  /* This card answers the one routing question a person actually has — "which
     model answers which kind of question?" — in the asker's vocabulary. The
     router's own labels leaked here for a release: role keys on the left
     ("long-context") and provenance on the right ("bridge" = static fallback
     table, "catalog" = role-tagged gateway entry, "default" = neither), which
     rendered rows like "reasoning · <deployment id> · bridge" — words from three
     different internal registers. Provenance is an engineering answer and the
     Deployments lane still gives it; here the only distinction worth ink is
     whether a specialist takes the question. Specialist rows are tagged
     "expert", default rows are bare — visibly the same model the
     "everything else" row already names. */
  const ROLE_ASKS = { cultivation: "growing", coding: "code", reasoning: "hard problems", "long-context": "long documents" };
  const hr = $("home-routing"); hr.innerHTML = "";
  for (const [role, r] of Object.entries(cat.resolved || {}))
    hr.insertAdjacentHTML("beforeend", `<div class="kv"><span class="k">${esc(ROLE_ASKS[role] || role)}</span><span class="v">${esc(r.model)}${r.source === "default" ? "" : '<em class="src">expert</em>'}</span></div>`);
  hr.insertAdjacentHTML("beforeend", `<div class="kv"><span class="k">everything else</span><span class="v">${esc(cat.defaultModel || "crowelm")}</span></div>`);
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

// ── Cultivation records ──
/* Grow records list the way the Projects lanes list, because they are the same
   shape of thing: rows the operator scans for the one that is wrong. One table
   describes each type — the fields it collects, and how a saved row reads back
   as id / name / flags — and a single renderer builds both the add form and the
   list from it. Adding a record type is data, not another surface. */
/* A field's `w` is how much room its content actually wants — a count is three
   characters and a note is a sentence, so letting every input flex alike wastes
   the row and makes the form read as undifferentiated boxes. `from` points a
   field at another lane's records: the libraries are only worth keeping if the
   forms that consume them offer what is in there. */
const GROW = {
  blocks: {
    title: "Blocks", sub: "Every substrate block, spawn to spent.", one: "block", plural: "blocks", date: "spawned",
    fields: [
      { k: "code", label: "Lot code", w: "sm" },
      { k: "species", label: "Species" },
      { k: "strain", label: "Strain", from: ["strains", "name"] },
      { k: "substrate", label: "Substrate", from: ["recipes", "name"] },
      { k: "count", label: "Count", type: "number", w: "xs" },
      // Suggests from the rooms already logged, so a lot and its readings agree
      // on the spelling. A trace joins them on this string.
      { k: "room", label: "Room", from: ["env", "room"], w: "sm" },
      { k: "spawned", label: "Spawned", type: "date", w: "sm" },
      { k: "stage", label: "Stage", opts: ["spawned", "colonizing", "consolidating", "fruiting", "spent", "discarded"] },
      { k: "notes", label: "Notes", w: "lg" },
    ],
    id: (r) => r.code, name: (r) => [r.species, r.strain, r.substrate].filter(Boolean).join(" · "),
    flags: (r) => [r.stage, r.count ? r.count + "×" : "", growAge(r.spawned)],
  },
  flushes: {
    title: "Flushes", sub: "Harvests, each one keyed to the block it came off.", one: "flush", plural: "flushes", date: "date",
    fields: [
      { k: "block", label: "Block lot", w: "sm", from: ["blocks", "code"] },
      { k: "n", label: "Flush #", type: "number", w: "xs" },
      { k: "date", label: "Harvested", type: "date", w: "sm" },
      { k: "weight", label: "Weight (lb)", type: "number", w: "xs" },
      { k: "grade", label: "Grade", opts: ["A", "B", "cull"], w: "sm" },
      { k: "notes", label: "Notes", w: "lg" },
    ],
    // Block lot plus flush number is how a harvest is identified downstream.
    // Derived for display only — what the farm's lot format should be is a
    // question for its traceability SOP, not for this list.
    id: (r) => (r.block ? r.block + "-F" + (r.n || "?") : "F" + (r.n || "?")),
    name: (r) => fmtDay(r.date), flags: (r) => [r.weight ? r.weight + " lb" : "", r.grade ? "grade " + r.grade : ""],
  },
  contam: {
    title: "Contamination", sub: "What went wrong, where you caught it, what you did.", one: "event", plural: "events", date: "date",
    fields: [
      { k: "block", label: "Block lot", w: "sm", from: ["blocks", "code"] },
      { k: "organism", label: "Organism", opts: ["Trichoderma", "Penicillium", "Aspergillus", "Neurospora", "bacterial / wet spot", "cobweb", "unknown"] },
      { k: "stage", label: "Caught at", opts: ["grain spawn", "substrate", "colonizing", "fruiting", "post-harvest"] },
      { k: "date", label: "Found", type: "date", w: "sm" },
      { k: "action", label: "Action", opts: ["discarded", "isolated", "salvaged", "monitoring"] },
      { k: "notes", label: "Notes", w: "lg" },
    ],
    id: (r) => r.block || "—", name: (r) => [r.organism, r.stage].filter(Boolean).join(" · "),
    flags: (r) => [r.action, fmtDay(r.date)],
  },
  env: {
    title: "Environment", sub: "Room readings, entered by hand until Crowe Sense writes here too.", one: "reading", plural: "readings", date: "date",
    fields: [
      { k: "room", label: "Room" },
      { k: "date", label: "Date", type: "date", w: "sm" },
      { k: "temp", label: "Temp °F", type: "number", w: "xs" },
      { k: "rh", label: "RH %", type: "number", w: "xs" },
      { k: "co2", label: "CO₂ ppm", type: "number", w: "xs" },
      { k: "fae", label: "FAE", w: "xs" },
      { k: "notes", label: "Notes", w: "lg" },
    ],
    id: (r) => r.room || "room", name: (r) => fmtDay(r.date),
    flags: (r) => [r.temp ? r.temp + "°F" : "", r.rh ? r.rh + "% RH" : "", r.co2 ? r.co2 + " ppm" : "", r.fae ? "FAE " + r.fae : ""],
  },
  strains: {
    title: "Strains", sub: "The culture library: what you hold and where it came from.", one: "strain", plural: "strains", date: "acquired",
    fields: [
      { k: "name", label: "Name" },
      { k: "species", label: "Species" },
      { k: "source", label: "Source" },
      { k: "gen", label: "Generation", type: "number", w: "xs" },
      { k: "acquired", label: "Acquired", type: "date", w: "sm" },
      { k: "notes", label: "Notes", w: "lg" },
    ],
    id: (r) => r.name, name: (r) => [r.species, r.source].filter(Boolean).join(" · "),
    flags: (r) => [r.gen ? "G" + r.gen : "", fmtDay(r.acquired)],
  },
  recipes: {
    title: "Recipes", sub: "Substrate formulations a block can point back at.", one: "recipe", plural: "recipes", date: "",
    fields: [
      { k: "name", label: "Name" },
      { k: "base", label: "Base" },
      { k: "supplement", label: "Supplement" },
      { k: "hydration", label: "Hydration %", type: "number", w: "xs" },
      { k: "process", label: "Sterilize / pasteurize" },
      { k: "notes", label: "Notes", w: "lg" },
    ],
    id: (r) => r.name, name: (r) => [r.base, r.supplement].filter(Boolean).join(" + "),
    flags: (r) => [r.hydration ? r.hydration + "%" : "", r.process],
  },
  log: {
    title: "Grow log", sub: "The running journal: anything that does not fit a form.", one: "entry", plural: "entries", date: "date",
    fields: [
      { k: "date", label: "Date", type: "date", w: "sm" },
      { k: "subject", label: "Subject" },
      { k: "entry", label: "What happened", w: "lg" },
    ],
    id: (r) => fmtDay(r.date) || "—", name: (r) => r.subject || "", flags: () => [], note: (r) => r.entry,
  },
};
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
// Parse as local midnight: bare "2026-07-28" is UTC, which reads a day off for
// anyone west of Greenwich — including every US grow room.
function growStamp(d) { const t = Date.parse(String(d) + "T00:00:00"); return Number.isNaN(t) ? NaN : t; }
function growAge(d) { const t = growStamp(d); return Number.isNaN(t) ? "" : "day " + Math.max(0, Math.round((Date.now() - t) / 86400000)); }
// Rows read as prose, not as a database dump: "Jul 25" is how the grower says
// it. The stored value stays ISO — this is the display end only.
function fmtDay(d) {
  const t = growStamp(d);
  if (Number.isNaN(t)) return String(d || "");
  const x = new Date(t), now = new Date();
  return x.toLocaleDateString([], { month: "short", day: "numeric", ...(x.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}
function growWhen(def, r) { const t = def.date ? growStamp(r[def.date]) : NaN; return Number.isNaN(t) ? (r.createdAt || 0) : t; }
/* A date-stemmed serial so the lot field is never blank. It is a default, not a
   scheme: the format a farm's lot codes must take comes from its traceability
   SOP, so the field stays editable and the app does not claim otherwise. */
function nextLot(rows) {
  const stem = today().replace(/-/g, "").slice(2);
  let n = 0;
  for (const r of rows) { const m = /^(\d{6})-(\d+)$/.exec(String((r && r.code) || "")); if (m && m[1] === stem) n = Math.max(n, Number(m[2])); }
  return stem + "-" + String(n + 1).padStart(2, "0");
}
/* The record currently open for correction, or null. A grower who typed 8.4 for
   84 lb needs to fix the row, not delete it and lose its id, its createdAt and
   the lot serial that downstream records already point at. The store has always
   supported an in-place update - save() with an id - so this is the form
   learning to carry one, not new persistence. */
let cultEdit = null;
function growForm(lane, def, rows, refs, editing) {
  const f = document.createElement("form");
  f.className = "grow-add" + (editing ? " editing" : ""); f.autocomplete = "off";
  // Fields the form answers for the grower. They must not count as evidence the
  // grower answered anything, or the "did you actually type something" guard
  // below passes on a form nobody touched.
  const prefilled = new Set();
  for (const fd of def.fields) {
    let el;
    if (fd.opts) {
      el = document.createElement("select");
      // Leading blank: a select that arrives pre-answered puts a guess on the
      // record. "Trichoderma" is a diagnosis, not a default.
      el.appendChild(new Option(fd.label, ""));
      for (const o of fd.opts) el.appendChild(new Option(o, o));
    } else {
      el = document.createElement("input");
      el.type = fd.type || "text";
      el.placeholder = fd.label;
      if (fd.type === "number") el.step = "any";
      if (fd.type === "date") { el.value = today(); prefilled.add(fd.k); }
      if (fd.from) {
        // Suggest what the referenced lane already holds, so a block points at a
        // strain that exists instead of a typo of one. A datalist suggests
        // rather than constrains: a culture can be in the ground before it is
        // in the library, and the form must not stop the grower logging it.
        const dl = document.createElement("datalist");
        dl.id = `grow-ref-${lane}-${fd.k}`;
        for (const v of new Set((refs[fd.from[0]] || []).map((r) => r && r[fd.from[1]]).filter(Boolean))) dl.appendChild(new Option(v, v));
        f.appendChild(dl);
        el.setAttribute("list", dl.id);
      }
    }
    el.className = "w-" + (fd.w || "md");
    el.name = fd.k; el.title = fd.label; el.setAttribute("aria-label", fd.label);
    f.appendChild(el);
  }
  if (editing) {
    // The stored values win over every default: a lot serial invented for the
    // next record has no business overwriting the one this record already has.
    for (const fd of def.fields) if (editing[fd.k] != null) f.elements[fd.k].value = String(editing[fd.k]);
    prefilled.clear(); // nothing here is a guess any more
  } else if (lane === "blocks") { f.elements.code.value = nextLot(rows); prefilled.add("code"); }
  // The button gets its own row rather than trailing whichever field happened to
  // wrap last, so the panel keeps one shape across all seven lanes. The caption
  // carries the label the placeholders cannot: what this form makes.
  const foot = document.createElement("div"); foot.className = "grow-go";
  foot.innerHTML = `<span class="grow-cap">${editing ? "Editing " + esc(def.id(editing) || def.one) : "New " + esc(def.one)}</span>`;
  if (editing) {
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "ghost sm"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => { cultEdit = null; renderGrowLane(lane); });
    foot.appendChild(cancel);
  }
  const btn = document.createElement("button");
  btn.type = "submit"; btn.className = "primary sm"; btn.textContent = editing ? "Save" : "Add";
  foot.appendChild(btn); f.appendChild(foot);
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rec = editing ? { id: editing.id } : {};
    // An edit sends every field, blanks included. The store merges a patch onto
    // the stored row, so omitting a field the grower just cleared would leave
    // the old value in place and the form would silently lie about the save.
    for (const fd of def.fields) {
      const v = String(f.elements[fd.k].value || "").trim();
      if (v || editing) rec[fd.k] = v;
    }
    // Today's date and the next lot serial arrive already filled in, so a row
    // carrying only those is a stray Enter, not a record. Refuse it rather than
    // log an empty day — and burn a lot number on it. When editing there is no
    // prefill to discount, but a record emptied of every field is still not one.
    if (!def.fields.some((fd) => !prefilled.has(fd.k) && rec[fd.k])) { f.elements[def.fields[0].k].focus(); return; }
    const res = await window.crowe.grow.save(lane, rec);
    if (!res || !res.ok) { btn.textContent = "Failed — " + ((res && res.error) || "unknown"); return; }
    cultEdit = null;
    if (cultLane === lane) renderGrowLane(lane);
  });
  return f;
}
async function renderGrowLane(lane) {
  const gen = ++laneGen; // shared with renderLane: both own #lane-body
  const def = GROW[lane]; if (!def) return;
  $("lane-title").textContent = def.title; $("lane-sub").textContent = def.sub;
  const body = $("lane-body"); body.innerHTML = "";
  // Whatever lanes this one's fields point at, fetched alongside its own rows.
  const need = [...new Set(def.fields.filter((fd) => fd.from).map((fd) => fd.from[0]))];
  const [rows, ...refRows] = await Promise.all([window.crowe.grow.list(lane), ...need.map((t) => window.crowe.grow.list(t))]);
  if (gen !== laneGen) return;
  const refs = Object.fromEntries(need.map((t, i) => [t, refRows[i]]));
  // Re-resolved from the freshly-read rows rather than held as an object: the
  // record being edited must be the stored one, not a copy that went stale when
  // the lane last re-rendered.
  const editing = cultEdit ? rows.find((r) => r && r.id === cultEdit) || null : null;
  if (cultEdit && !editing) cultEdit = null; // it was deleted out from under us
  body.appendChild(growForm(lane, def, rows, refs, editing));
  const list = document.createElement("div"); list.className = "grow-list";
  const sorted = rows.slice().sort((a, b) => growWhen(def, b) - growWhen(def, a));
  if (!sorted.length) list.innerHTML = `<div class="card-empty">No ${esc(def.plural)} yet — the first one goes in above.</div>`;
  else $("lane-sub").textContent = `${def.sub}  ·  ${sorted.length} ${sorted.length === 1 ? def.one : def.plural}`;
  for (const r of sorted) {
    const row = document.createElement("div");
    row.className = "growrow" + (editing && editing.id === r.id ? " editing" : "");
    const flags = (def.flags(r) || []).filter(Boolean);
    const note = (def.note ? def.note(r) : r.notes) || "";
    row.innerHTML =
      `<div class="gr-main"><button class="gr-open" title="Edit this ${esc(def.one)}">` +
      `<span class="gr-id">${esc(def.id(r) || "—")}</span>` +
      `<span class="gr-name">${esc(def.name(r) || "")}</span>` +
      `<span class="gr-flags">${flags.map((x) => `<em>${esc(x)}</em>`).join("")}</span></button>` +
      `<button class="gr-del" title="Delete">Delete</button></div>` +
      (note ? `<div class="gr-note">${esc(note)}</div>` : "");
    row.querySelector(".gr-open").addEventListener("click", () => {
      cultEdit = cultEdit === r.id ? null : r.id; // a second click puts it back
      renderGrowLane(lane);
    });
    const del = row.querySelector(".gr-del");
    /* Two clicks, because there is no undo and no trash: the row is gone from
       the JSON the moment it goes. The second click is the confirmation, and it
       expires on its own so a Delete armed and forgotten does not fire on the
       next stray click a week later. */
    let armed = 0;
    del.addEventListener("click", async () => {
      if (!armed) {
        armed = setTimeout(() => { armed = 0; del.textContent = "Delete"; del.classList.remove("armed"); }, 4000);
        del.textContent = "Delete?"; del.classList.add("armed");
        return;
      }
      clearTimeout(armed);
      await window.crowe.grow.delete(lane, r.id);
      if (cultEdit === r.id) cultEdit = null;
      if (cultLane === lane) renderGrowLane(lane);
    });
    list.appendChild(row);
  }
  body.appendChild(list);
}
/* Redraw whatever the Cultivation space is showing, when the store changes under
   it - today that means the agent wrote a record on a turn the grower ran from
   somewhere else in the app.

   Deliberately not guarded on the space being visible. The grower who dictates a
   flush is almost always in Chat when they do it, so the guard would skip every
   case it exists for and leave a stale lane waiting behind the tab. Redrawing a
   hidden surface costs one store read and nothing else. */
function refreshCultivation() {
  if (cultLane === "home") refreshCult();
  else if (cultLane === "trace") renderTrace();
  else renderGrowLane(cultLane);
}

/* ── Trace a lot ────────────────────────────────────────────────────────────
   Everything the store knows about one lot, gathered in one place.

   This is the farm's own view — where did this box of mushrooms come from —
   and it is also, without changing anything, the exercise two audit schemes
   ask for. Harmonized GAP G-6.1 wants one step forward and one step back with
   lot numbers, harvest dates and quantities; G-6.2 wants a trace completed
   within four hours with full reconciliation, at least annually. MGAP 12.1a
   wants lot tagging traceable to location and date of harvest. The lanes have
   held those fields all along; nothing joined them up.

   What it deliberately does not do is claim to be a compliance artifact. It
   reconciles what was recorded, and a farm that did not log a flush gets a
   trace that is missing it. Saying so is the useful part — a trace exercise
   that quietly papers over gaps teaches the farm nothing before the audit. */
let traceLot = "";
function growTrace(code, d) {
  const eq = (a) => String(a || "").trim().toLowerCase() === String(code).trim().toLowerCase();
  const block = d.blocks.find((r) => eq(r.code)) || null;
  const flushes = d.flushes.filter((r) => eq(r.block)).sort((a, b) => (growStamp(a.date) || 0) - (growStamp(b.date) || 0));
  const contam = d.contam.filter((r) => eq(r.block)).sort((a, b) => (growStamp(a.date) || 0) - (growStamp(b.date) || 0));
  // The journal is free text, so this is a mention, not a join. Worth surfacing
  // — a note about a lot is often the only record of why something was done —
  // but it is labelled as a mention so nobody reads it as a structured link.
  const rx = new RegExp(String(code).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const notes = d.log.filter((r) => rx.test(r.subject || "") || rx.test(r.entry || ""));
  // Readings for the room this lot is in, between spawn and the last harvest.
  // A room reading outside that window belongs to whatever grew there next.
  const from = block ? growStamp(block.spawned) : NaN;
  const to = flushes.length ? growStamp(flushes[flushes.length - 1].date) : Date.now();
  const env = block && block.room ? d.env.filter((r) => {
    if (String(r.room || "").trim().toLowerCase() !== String(block.room).trim().toLowerCase()) return false;
    const s = growStamp(r.date);
    return !Number.isNaN(s) && (Number.isNaN(from) || s >= from) && s <= to + 86400000;
  }).sort((a, b) => (growStamp(a.date) || 0) - (growStamp(b.date) || 0)) : [];
  const yieldLb = flushes.reduce((a, r) => a + (Number(r.weight) || 0), 0);
  const strain = block && block.strain ? d.strains.find((r) => String(r.name || "").trim().toLowerCase() === String(block.strain).trim().toLowerCase()) : null;
  const recipe = block && block.substrate ? d.recipes.find((r) => String(r.name || "").trim().toLowerCase() === String(block.substrate).trim().toLowerCase()) : null;
  // Gaps, named. Each one is something an auditor asks for by name and the
  // farm cannot produce from these records — better said out loud here than
  // discovered during the exercise.
  const gaps = [];
  if (!block) gaps.push("No block record for this lot code — everything below is orphaned.");
  else {
    if (!block.spawned) gaps.push("Spawn date not recorded, so the lot has no start.");
    if (!block.room) gaps.push("No room on the block, so no environment history can be tied to it (MGAP 12.1a wants location).");
    if (!block.count) gaps.push("Block count not recorded, so yield per block cannot be reconciled.");
    if (block.substrate && !recipe) gaps.push(`Substrate "${block.substrate}" has no recipe record to trace back to.`);
    if (block.strain && !strain) gaps.push(`Strain "${block.strain}" has no library record to trace back to.`);
  }
  if (!flushes.length) gaps.push("No harvests recorded against this lot.");
  else if (flushes.some((r) => !r.weight)) gaps.push("At least one flush has no weight, so total yield is understated.");
  // Nothing here records who the mushrooms went to. One-up is the half of
  // G-6.1 this app cannot answer yet, and pretending otherwise would be worse
  // than the gap.
  gaps.push("Shipment and customer records are not kept in this app, so one-step-forward cannot be traced from here.");
  return { code, block, strain, recipe, flushes, contam, env, notes, yieldLb, gaps };
}
async function renderTrace() {
  const gen = ++laneGen;
  $("lane-title").textContent = "Trace a lot";
  $("lane-sub").textContent = "One lot, everything recorded about it, spawn to harvest.";
  const body = $("lane-body"); body.innerHTML = "";
  const t = ["blocks", "flushes", "contam", "env", "strains", "recipes", "log"];
  const got = await Promise.all(t.map((x) => window.crowe.grow.list(x)));
  if (gen !== laneGen) return;
  const d = Object.fromEntries(t.map((x, i) => [x, Array.isArray(got[i]) ? got[i] : []]));
  const codes = [...new Set(d.blocks.map((r) => r.code).filter(Boolean))].reverse();
  if (!traceLot && codes.length) traceLot = codes[0];

  const pick = document.createElement("form");
  pick.className = "grow-add"; pick.autocomplete = "off";
  pick.innerHTML =
    `<input name="code" class="w-sm" list="trace-codes" placeholder="Lot code" value="${esc(traceLot)}">` +
    `<datalist id="trace-codes">${codes.map((c) => `<option value="${esc(c)}"></option>`).join("")}</datalist>` +
    `<div class="grow-go"><span class="grow-cap">${codes.length ? codes.length + " lot" + (codes.length === 1 ? "" : "s") + " on the books" : "No blocks recorded yet"}</span>` +
    `<button type="button" class="ghost sm" id="trace-export">Export</button>` +
    `<button type="submit" class="primary sm">Trace</button></div>`;
  pick.addEventListener("submit", (e) => { e.preventDefault(); traceLot = pick.elements.code.value.trim(); renderTrace(); });
  body.appendChild(pick);
  if (!traceLot) return;

  const tr = growTrace(traceLot, d);
  pick.querySelector("#trace-export").addEventListener("click", async () => {
    const res = await window.crowe.grow.export(traceLot, traceText(tr));
    const btn = pick.querySelector("#trace-export");
    btn.textContent = res && res.ok ? "Saved" : res && res.canceled ? "Export" : "Failed";
    if (res && res.ok) setTimeout(() => { btn.textContent = "Export"; }, 2000);
  });

  const wrap = document.createElement("div");
  wrap.className = "trace";
  const sec = (title, note, rowsHtml) =>
    `<section class="tr-sec"><h3>${esc(title)}${note ? `<span class="tr-note">${esc(note)}</span>` : ""}</h3>${rowsHtml}</section>`;
  const kv = (pairs) => `<div class="tr-kv">` + pairs.filter(([, v]) => v).map(([k, v]) =>
    `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("") + `</div>`;
  const line = (id, text) => `<div class="tr-line"><span class="tr-when">${esc(id)}</span><span>${esc(text)}</span></div>`;

  const b = tr.block;
  wrap.innerHTML =
    `<div class="tr-head"><span class="tr-code">${esc(tr.code)}</span>` +
    `<span class="tr-sum">${b ? esc([b.species, b.strain].filter(Boolean).join(" ") || "species unrecorded") : "no block record"}` +
    `${tr.flushes.length ? ` · ${tr.flushes.length} flush${tr.flushes.length === 1 ? "" : "es"}` : ""}` +
    `${tr.yieldLb ? ` · ${Math.round(tr.yieldLb * 10) / 10} lb total` : ""}</span></div>` +
    (b ? sec("The block", "", kv([
      ["species", b.species], ["strain", b.strain], ["substrate", b.substrate],
      ["blocks in lot", b.count], ["room", b.room],
      ["spawned", b.spawned ? `${fmtDay(b.spawned)} (${growAge(b.spawned)})` : ""],
      ["stage now", b.stage], ["notes", b.notes],
    ])) : "") +
    (tr.recipe ? sec("Substrate", "from the recipe library", kv([
      ["recipe", tr.recipe.name], ["base", tr.recipe.base], ["supplement", tr.recipe.supplement],
      ["hydration", tr.recipe.hydration && tr.recipe.hydration + "%"], ["process", tr.recipe.process],
    ])) : "") +
    (tr.strain ? sec("Strain", "from the strain library", kv([
      ["name", tr.strain.name], ["species", tr.strain.species], ["source", tr.strain.source],
      ["generation", tr.strain.gen], ["acquired", tr.strain.acquired && fmtDay(tr.strain.acquired)],
    ])) : "") +
    (tr.flushes.length ? sec("Harvests", `${Math.round(tr.yieldLb * 10) / 10} lb across ${tr.flushes.length}`,
      tr.flushes.map((r) => line(fmtDay(r.date),
        `flush ${r.n || "?"}${r.weight ? " · " + r.weight + " lb" : " · unweighed"}${r.grade ? " · grade " + r.grade : ""}${r.notes ? " · " + r.notes : ""}`)).join("")) : "") +
    (tr.contam.length ? sec("Contamination", "", tr.contam.map((r) => line(fmtDay(r.date),
      `${r.organism || "unidentified"} at ${r.stage || "unrecorded stage"} — ${r.action || "no action recorded"}${r.notes ? " · " + r.notes : ""}`)).join("")) : "") +
    (tr.env.length ? sec("Room history", `${esc(b.room)}, spawn to last harvest`, tr.env.map((r) => line(fmtDay(r.date),
      [r.temp && r.temp + "°F", r.rh && r.rh + "% RH", r.co2 && r.co2 + " ppm CO₂", r.fae && "FAE " + r.fae].filter(Boolean).join(" · ") || "no values")).join("")) : "") +
    (tr.notes.length ? sec("Journal", "mentions this lot code", tr.notes.map((r) => line(fmtDay(r.date),
      `${r.subject || ""}${r.entry ? ": " + r.entry : ""}`)).join("")) : "") +
    sec("Gaps in this trace", "what these records cannot answer",
      `<ul class="tr-gaps">${tr.gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>`);
  body.appendChild(wrap);
}
/* The same trace as plain text, which is the form it leaves the app in. Not
   CSV: a trace is read by a person reconciling a claim, and one lot's history
   flattened into rows loses the thing that makes it readable. */
function traceText(tr) {
  const L = [];
  const b = tr.block;
  L.push(`LOT TRACE — ${tr.code}`, `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} from Crowe Logic cultivation records.`, "");
  if (b) {
    L.push("BLOCK", ...[["Species", b.species], ["Strain", b.strain], ["Substrate", b.substrate], ["Blocks in lot", b.count],
      ["Room", b.room], ["Spawned", b.spawned], ["Stage now", b.stage], ["Notes", b.notes]]
      .filter(([, v]) => v).map(([k, v]) => `  ${k}: ${v}`), "");
  } else L.push("BLOCK", "  no block record for this lot code", "");
  if (tr.recipe) L.push("SUBSTRATE RECIPE", ...[["Name", tr.recipe.name], ["Base", tr.recipe.base], ["Supplement", tr.recipe.supplement],
    ["Hydration", tr.recipe.hydration], ["Process", tr.recipe.process]].filter(([, v]) => v).map(([k, v]) => `  ${k}: ${v}`), "");
  if (tr.strain) L.push("STRAIN", ...[["Name", tr.strain.name], ["Species", tr.strain.species], ["Source", tr.strain.source],
    ["Generation", tr.strain.gen], ["Acquired", tr.strain.acquired]].filter(([, v]) => v).map(([k, v]) => `  ${k}: ${v}`), "");
  L.push(`HARVESTS (${tr.flushes.length}, ${Math.round(tr.yieldLb * 10) / 10} lb total)`);
  L.push(...(tr.flushes.length ? tr.flushes.map((r) =>
    `  ${r.date || "date?"}  flush ${r.n || "?"}  ${r.weight ? r.weight + " lb" : "unweighed"}${r.grade ? "  grade " + r.grade : ""}${r.notes ? "  " + r.notes : ""}`)
    : ["  none recorded"]), "");
  if (tr.contam.length) L.push("CONTAMINATION", ...tr.contam.map((r) =>
    `  ${r.date || "date?"}  ${r.organism || "unidentified"} at ${r.stage || "stage?"} — ${r.action || "no action recorded"}${r.notes ? "  " + r.notes : ""}`), "");
  if (tr.env.length) L.push(`ROOM HISTORY (${b.room}, spawn to last harvest)`, ...tr.env.map((r) =>
    `  ${r.date}  ${[r.temp && r.temp + "F", r.rh && r.rh + "% RH", r.co2 && r.co2 + " ppm CO2", r.fae && "FAE " + r.fae].filter(Boolean).join("  ") || "no values"}`), "");
  if (tr.notes.length) L.push("JOURNAL MENTIONS", ...tr.notes.map((r) => `  ${r.date || "date?"}  ${r.subject || ""}${r.entry ? ": " + r.entry : ""}`), "");
  L.push("GAPS IN THIS TRACE", ...tr.gaps.map((g) => `  - ${g}`), "");
  // The provenance line matters more than anything above it. An auditor reading
  // this needs to know it came out of a farm's own hand-kept records and was
  // not reconciled against shipping, scale tickets or anything external.
  L.push("PROVENANCE",
    "  Assembled from records entered by farm staff in the Crowe Logic desktop app.",
    "  Not reconciled against shipping records, scale tickets, or any external system.",
    "  Environment readings are hand-entered, not instrument-logged.");
  return L.join("\n");
}
/* The Overview, which until now held a card promising Crowe Sense telemetry in
   0.8 and nothing else. The farm's own records are already here and already
   current, so the surface can say something true about today's grow instead of
   something aspirational about next release. Each card opens the lane behind it,
   which is also the only cross-lane navigation the space has. */
async function refreshCult() {
  const host = $("cult-state"); if (!host) return;
  const t = ["blocks", "flushes", "contam", "env"];
  let d;
  try { const got = await Promise.all(t.map((x) => window.crowe.grow.list(x))); d = Object.fromEntries(t.map((x, i) => [x, got[i] || []])); }
  catch { host.innerHTML = ""; return; }
  const by = (rows, key) => rows.slice().sort((a, b) => (growStamp(b[key]) || 0) - (growStamp(a[key]) || 0));
  const since = (rows, key, days) => rows.filter((r) => { const s = growStamp(r[key]); return !Number.isNaN(s) && Date.now() - s < days * 86400000; });
  const cards = [];

  const live = d.blocks.filter((r) => r.stage !== "spent" && r.stage !== "discarded");
  // Lots first, blocks only where the count was actually recorded. Defaulting a
  // blank count to 1 would put a number on the surface that nobody entered, and
  // the one figure a grower checks against reality is the block count.
  const stages = new Map();
  for (const r of live) {
    const s = r.stage || "stage unrecorded", cur = stages.get(s) || { lots: 0, blocks: 0 };
    cur.lots++; cur.blocks += Number(r.count) || 0; stages.set(s, cur);
  }
  cards.push(["blocks", "Blocks in play", [...stages].map(([s, n]) =>
    [s, `${n.lots} lot${n.lots === 1 ? "" : "s"}${n.blocks ? " · " + n.blocks + " blocks" : ""}`]),
    live.length ? "" : "Nothing growing on the books."]);

  const fl = by(d.flushes, "date"), last = fl[0];
  const lb = since(d.flushes, "date", 30).reduce((a, r) => a + (Number(r.weight) || 0), 0);
  cards.push(["flushes", "Harvest", last ? [
    ["last flush", `${last.block || "?"} · ${fmtDay(last.date)}`],
    ["that flush", last.weight ? last.weight + " lb" : "unweighed"],
    ["last 30 days", lb ? Math.round(lb * 10) / 10 + " lb" : "nothing recorded"],
  ] : [], last ? "" : "No harvests logged yet."]);

  const cn = by(since(d.contam, "date", 30), "date");
  // "Open" means the grower has not called it: isolated and monitoring are still
  // live questions, discarded and salvaged are closed.
  const open = cn.filter((r) => r.action === "isolated" || r.action === "monitoring" || !r.action);
  cards.push(["contam", "Contamination", cn.length ? [
    ["last 30 days", String(cn.length)],
    ["still open", open.length ? String(open.length) : "none"],
    ["most recent", `${cn[0].organism || "unidentified"} · ${fmtDay(cn[0].date)}`],
  ] : [], cn.length ? "" : "Clean month on the books."]);

  const rooms = new Map();
  for (const r of by(since(d.env, "date", 7), "date")) if (r.room && !rooms.has(r.room)) rooms.set(r.room, r);
  cards.push(["env", "Rooms", [...rooms.values()].map((r) => [r.room,
    [r.temp && r.temp + "°F", r.rh && r.rh + "%", r.co2 && r.co2 + "ppm"].filter(Boolean).join(" · ") || "—"]),
    rooms.size ? "" : "No readings this week."]);

  host.innerHTML = "";
  for (const [lane, title, rows, empty] of cards) {
    const c = document.createElement("button");
    c.type = "button"; c.className = "card cult-card"; c.dataset.cult = lane;
    c.innerHTML = `<div class="card-h">${esc(title)}</div><div class="card-b">` +
      (rows.length ? rows.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("")
                   : `<div class="card-empty">${esc(empty)}</div>`) + "</div>";
    c.addEventListener("click", () => { const b = document.querySelector(`#cult-nav [data-cult="${lane}"]`); if (b) b.click(); });
    host.appendChild(c);
  }
  // Said plainly, because the difference matters to anyone reading these numbers:
  // the room figures above were typed by a person, not measured. Crowe Sense will
  // write into the same store, and this line goes when it does.
  const foot = document.createElement("p");
  foot.className = "cult-foot";
  foot.textContent = "Every figure here is what you entered. Crowe Sense will write room readings into this same store when it lands. Until then, environment is hand-logged.";
  host.appendChild(foot);

  /* The openers, which shipped as three sentences about a farm that isn't this
     one — a 10-bag oyster run, day-6 rye spawn, a Martha tent. A grower with
     Trichoderma open on 260722-01 does not want to be offered a hypothetical.

     Each chip states only what the records say and asks the model for the part
     the records cannot answer. Nothing here is inferred: no chip claims a reading
     is out of range or a block is late, because that judgement depends on species
     and stage and belongs to the expert on the other side of the click. Order is
     urgency — an open contamination first, then whatever has been sitting longest.

     The three static chips stay in the markup as the empty-store case. A farm on
     its first day has nothing to be asked about and is better served by an
     example than by a blank row. */
  const chips = $("cult-chips"); if (!chips) return;
  const q = [];
  const c0 = open[0];
  if (c0 && (c0.organism || c0.block)) q.push(
    `${c0.organism || "Contamination"} found ${fmtDay(c0.date)}${c0.block ? " on " + c0.block : ""}` +
    `${c0.stage ? " at " + c0.stage : ""} and still open — what do I do with it, and with the rest of the room?`);
  const pre = new Set(["spawned", "colonizing", "consolidating"]);
  const oldest = live.filter((r) => pre.has(r.stage) && !Number.isNaN(growStamp(r.spawned)))
    .sort((a, b) => growStamp(a.spawned) - growStamp(b.spawned))[0];
  if (oldest) q.push(
    `${oldest.code || "A lot"} is ${oldest.stage}, ${growAge(oldest.spawned)} since spawn` +
    `${oldest.species || oldest.strain ? " — " + [oldest.species, oldest.strain].filter(Boolean).join(" ") : ""}` +
    `${oldest.substrate ? " on " + oldest.substrate : ""}. Is that on track, and what comes next?`);
  const room = [...rooms.values()][0];
  if (room && (room.temp || room.rh || room.co2)) q.push(
    `${room.room} read ${[room.temp && room.temp + "°F", room.rh && room.rh + "% RH", room.co2 && room.co2 + " ppm CO₂"].filter(Boolean).join(", ")}` +
    ` on ${fmtDay(room.date)}. What should I change?`);
  if (last && last.block) q.push(
    `${last.block} gave${last.weight ? " " + last.weight + " lb on" : ""} flush ${last.n || "?"} on ${fmtDay(last.date)}.` +
    ` How do I bring the next one?`);
  if (!q.length) return;
  chips.innerHTML = "";
  for (const text of q.slice(0, 3)) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip cult-chip"; b.textContent = text;
    chips.appendChild(b);
  }
}

/* What the grow looks like right now, as a paragraph the expert can read.

   Without this the cultivation agent is a textbook: it answers about oysters in
   general when the question is about *these* oysters, on day 6, in a room that
   has been drifting to 1900ppm. The farm already typed all of that into the
   lanes; not handing it over is the whole gap.

   It is a digest, not a dump. Spent blocks, old harvests and stale readings are
   dropped, each section is capped, and the whole thing rides on one turn's
   system prompt - so it never accumulates in the saved session, and a big
   season's records cannot crowd out the conversation. */
async function growContext() {
  let d;
  try {
    const t = ["blocks", "flushes", "contam", "env", "strains", "recipes", "log"];
    const got = await Promise.all(t.map((x) => window.crowe.grow.list(x)));
    d = Object.fromEntries(t.map((x, i) => [x, Array.isArray(got[i]) ? got[i] : []]));
  } catch { return ""; } // No records is a normal state, not an error to report.
  const recent = (rows, key, days) => rows.filter((r) => { const s = growStamp(r[key]); return !Number.isNaN(s) && Date.now() - s < days * 86400000; });
  const by = (rows, key) => rows.slice().sort((a, b) => (growStamp(b[key]) || 0) - (growStamp(a[key]) || 0));
  const out = [];
  const live = by(d.blocks.filter((r) => r.stage !== "spent" && r.stage !== "discarded"), "spawned").slice(0, 14);
  if (live.length) out.push("Blocks in play:\n" + live.map((r) =>
    `- ${r.code || "?"} ${[r.species, r.strain].filter(Boolean).join(" ")}${r.substrate ? " on " + r.substrate : ""}` +
    `${r.count ? ", " + r.count + " blocks" : ""} — ${r.stage || "stage unrecorded"}, ${growAge(r.spawned) || "spawn date unrecorded"}` +
    `${r.notes ? ". " + r.notes : ""}`).join("\n"));
  const fl = by(recent(d.flushes, "date", 60), "date").slice(0, 10);
  if (fl.length) out.push("Recent harvests:\n" + fl.map((r) =>
    `- ${fmtDay(r.date)} ${r.block || "?"} flush ${r.n || "?"}${r.weight ? ", " + r.weight + " lb" : ""}${r.grade ? ", grade " + r.grade : ""}${r.notes ? ". " + r.notes : ""}`).join("\n"));
  const cn = by(recent(d.contam, "date", 90), "date").slice(0, 10);
  if (cn.length) out.push("Contamination in the last 90 days:\n" + cn.map((r) =>
    `- ${fmtDay(r.date)} ${r.organism || "unidentified"} on ${r.block || "?"} at ${r.stage || "unrecorded stage"}, ${r.action || "no action recorded"}${r.notes ? ". " + r.notes : ""}`).join("\n"));
  // One line per room: the current state of the room is what matters, and a
  // fortnight of readings for six rooms would be most of the budget.
  const rooms = new Map();
  for (const r of by(recent(d.env, "date", 14), "date")) if (r.room && !rooms.has(r.room)) rooms.set(r.room, r);
  if (rooms.size) out.push("Latest room readings:\n" + [...rooms.values()].map((r) =>
    `- ${r.room} (${fmtDay(r.date)}): ${[r.temp && r.temp + "°F", r.rh && r.rh + "% RH", r.co2 && r.co2 + " ppm CO2", r.fae && "FAE " + r.fae].filter(Boolean).join(", ") || "no values"}${r.notes ? ". " + r.notes : ""}`).join("\n"));
  const lg = by(recent(d.log, "date", 30), "date").slice(0, 8);
  if (lg.length) out.push("Grow log, last 30 days:\n" + lg.map((r) =>
    `- ${fmtDay(r.date)} ${r.subject || ""}${r.entry ? ": " + r.entry : ""}`).join("\n"));
  const lib = [
    d.strains.length && "strains held: " + d.strains.map((r) => r.name).filter(Boolean).join(", "),
    d.recipes.length && "substrate recipes: " + d.recipes.map((r) => r.name).filter(Boolean).join(", "),
  ].filter(Boolean);
  if (lib.length) out.push("Library — " + lib.join("; ") + ".");
  if (!out.length) return "";
  // Say where this came from and how far to trust it. Environment rows are typed
  // by a person, not measured by Crowe Sense, and an expert that treats a
  // hand-entered number as instrumentation will over-read it.
  return "The operator's own cultivation records from this app, current as of now. " +
    "Treat them as the ground truth for what is actually growing; they are hand-entered, " +
    "so a gap means unrecorded, not zero. Refer to blocks by their lot code.\n\n" + out.join("\n\n");
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
/* The grower's own way in. Until now the surface had no input at all - the
   chips were the only thing you could do on it, and they were fixed sentences.
   Pinned to cultivation, so a question that doesn't happen to contain a word
   the router recognises still reaches the mycology expert. */
$("cult-composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = $("cult-input").value.trim(); if (!t) return;
  setSpace("chat");
  // Seed the chat composer first, same reason as the projects composer above:
  // send() clears it only once its guards pass, so a draft survives a bounce.
  input.value = t;
  send(t, { role: "cultivation" });
  $("cult-input").value = "";
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
// Delegated, because refreshCult() replaces these chips with ones drawn from the
// records — a listener bound to the original three would go with them.
$("cult-chips")?.addEventListener("click", (e) => {
  const c = e.target.closest(".cult-chip"); if (!c) return;
  setSpace("chat"); send(c.textContent, { role: "cultivation" });
});

// ── Official plugins (Settings picker; manifest lives in main) ──
/* A plugin's `glyph` used to pick which of the eight hexagons appeared while
   that plugin's tool ran. Nothing picks a glyph any more - the indicator is
   always the logotype - so the map that cached them is gone rather than left
   populated and unread. main.js still passes the field through from the
   manifest; it is simply nobody's input at the moment. */
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
  // Generated from the space registry so a space dropped from the profile does
  // not survive here as a back door into a shell whose nav is hidden.
  ...Object.entries(SPACES).map(([id, s]) => ({ label: `Space: ${s.label}`, space: id, run: () => setSpace(id) })),
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
  PAL_ACTIONS.filter((a) => (!a.space || PROFILE.has(a.space)) && a.label.toLowerCase().includes(q.toLowerCase())).forEach((a, i) => {
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

/* Swaps the static masked logotype for the animated one. The motion cut has to
   be INLINE, not an <img> or a background: its choreography is a <style> block
   that only runs when the SVG is part of this document, and its ink is
   currentColor, which an <img> would resolve against nothing.

   Every id in that file is document-global once inlined, so a second copy would
   collide — #rotor-crowe-blades would then animate whichever one the document
   happened to hold first, the same class of bug mark.js carries its own gradient
   counter to avoid. There is one lockup today; the suffix keeps that true if a
   second ever appears rather than leaving a trap for whoever adds it.

   Failure is quiet on purpose. If the fetch fails the mask is already on screen
   and correct, so the header keeps its logo and the app has nothing to report. */
/* A counter, not a position. This used to suffix ids by the lockup's index
   among all lockups, which held only while the set never shrank: the launch
   veil is a lockup that is removed once it lifts, and every lockup added after
   that would shift down one and be handed a suffix a live lockup was already
   using. A number that only ever goes up cannot collide with anything already
   on screen, whatever happens to the DOM in between.

   Zero stays unsuffixed because the entrance choreography in the motion cut is
   written against bare ids, so exactly one copy per document can play it. The
   veil is first in the markup and therefore claims it — which is where the
   entrance was always meant to be seen. */
let lockupSeq = 0;
async function liveLockups() {
  const todo = [...document.querySelectorAll(".lockup")].filter((el) => !el.classList.contains("live"));
  if (!todo.length) return;
  // The hero and the launch veil are the lockups big enough to resolve the
  // full cut; the header takes the small one, matching the -sm mask it is
  // replacing. Both files carry the same ids, which the suffixing below
  // already scopes per copy — it rewrites the ids inside each copy's own
  // <style> too, so a suffixed copy's entrance drives itself rather than
  // whichever copy loaded first.
  const cutOf = (el) => (el.classList.contains("welcome-logotype") || el.classList.contains("launch-mark") ? "full" : "sm");
  const markups = {};
  for (const cut of new Set(todo.map(cutOf))) markups[cut] = await wordmarkMotionMarkup(cut);
  todo.forEach((el) => {
    const markup = markups[cutOf(el)];
    if (!markup) return;
    const n = lockupSeq++;
    const scoped = n === 0 ? markup
      : markup.replace(/(\bid="|url\(#|#)(crowe-logic-motion|rotor-[a-z-]+|wordmark-letterforms|gold-thinking-mark)\b/g,
        (_, lead, id) => `${lead}${id}-${n}`);
    el.insertAdjacentHTML("beforeend", scoped);
    // The inlined <svg> carries role="img" and its own <title>; the wrapper
    // already announces "Crowe Logic", so let the wrapper speak and hide the
    // copy rather than reading the name twice.
    const svg = el.lastElementChild;
    svg.setAttribute("aria-hidden", "true");
    svg.removeAttribute("role");
    el.classList.add("live");
  });
}

/* The veil lifts in CSS; this only clears the node it leaves behind, so a
   fixed, full-bleed element is not left sitting over the app for the rest of
   the session. The timeout is the belt to animationend's braces: a window that
   is hidden or occluded at launch may never fire the event at all, and a veil
   that outlives its animation is invisible but still in the layer tree. */
function dismissLaunch() {
  const veil = document.getElementById("launch");
  if (!veil) return;
  const done = () => { if (veil.isConnected) veil.remove(); };
  veil.addEventListener("animationend", done, { once: true });
  setTimeout(done, 3000);
}

// ── Init ──
(async () => {
  $("model-badge").textContent = "CroweLM";
  // The logotype is now the whole visual language: header, welcome screen,
  // agent panel head, and the thinking indicator in the transcript. One mark,
  // four places, and what changes between them is only how it moves.
  //
  // At rest the spore turns and nothing else does — a breath and a drift, not
  // a spinner, so it reads as the app being awake rather than as something
  // loading. It is the one piece of the brand on screen in every space and
  // every state, and a still picture of a living mark is worse than none.
  //
  // Under `is-thinking` the o's join in: two rotors counter-turning on
  // durations that do not divide into each other, and the spore quickens to
  // match. That is the only cue that separates working from waiting, so it is
  // spent nowhere else — the rings stay still, and the letterforms never move
  // after their entrance.
  //
  // CroweMark survives only on transcript avatars, at `rest`: a hundred of
  // them turning at once would spend the signal the indicator depends on.
  liveLockups();
  dismissLaunch();
  try { setAutonomyBadge(localStorage.getItem("crowe-tier") || "edit"); } catch {}
  const c = await refreshStatus(); loadTree();
  setAutonomyBadge((c && c.autonomy) || "edit");
  await refreshAuth();
  await maybeShowOnboarding(c);
  applySpaceProfile();
  try { const sp = localStorage.getItem("crowe-space"); if (sp && sp !== "chat") setSpace(sp); } catch {}
  statusTick();
  await restorePanels();
})();
