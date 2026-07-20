// Crowe Logic desktop — renderer. Vanilla JS; all privileged calls go through
// window.crowe (preload). Conversation history is kept client-side and replayed
// each turn, so tool results (added as `tool` messages) round-trip.
const $ = (id) => document.getElementById(id);
const transcript = $("transcript");
const input = $("input");
const messages = []; // OpenAI-style: {role, content, tool_calls?, tool_call_id?}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function clearWelcome() {
  const w = transcript.querySelector(".welcome");
  if (w) w.remove();
}

function addMessage(role, content, toolCalls) {
  clearWelcome();
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const who = document.createElement("div");
  who.className = "who";
  who.innerHTML = role === "assistant"
    ? `<img src="../assets/avatar.png" alt="Crowe Logic" />`
    : `<div class="u">You</div>`;
  const body = document.createElement("div");
  body.className = "body";
  if (content) {
    const p = document.createElement("p");
    p.innerHTML = role === "assistant" ? `<span class="mark">&#9670;</span> ${esc(content)}` : esc(content);
    body.appendChild(p);
  }
  for (const tc of toolCalls || []) {
    const card = document.createElement("div");
    card.className = "toolcard";
    const fn = (tc.function || {});
    card.innerHTML = `<span class="tc-name">${esc(fn.name || "tool")}</span>` +
      `<div class="tc-args">${esc(fn.arguments || "")}</div>`;
    body.appendChild(card);
  }
  wrap.append(who, body);
  transcript.appendChild(wrap);
  transcript.scrollTop = transcript.scrollHeight;
  return body;
}

function addError(text) {
  clearWelcome();
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  wrap.innerHTML = `<div class="who"><img src="../assets/avatar.png" alt="" /></div>` +
    `<div class="body"><div class="err">${esc(text)}</div></div>`;
  transcript.appendChild(wrap);
  transcript.scrollTop = transcript.scrollHeight;
}

async function send() {
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.style.height = "auto";
  addMessage("user", text);
  messages.push({ role: "user", content: text });

  const thinking = addMessage("assistant", "thinking...");
  const res = await window.crowe.chat({ messages });
  thinking.closest(".msg").remove(); // drop the placeholder

  if (res.error) {
    addError(res.error);
    return;
  }
  addMessage("assistant", res.content, res.tool_calls);
  messages.push({
    role: "assistant",
    content: res.content || "",
    ...(res.tool_calls && res.tool_calls.length ? { tool_calls: res.tool_calls } : {}),
  });
}

$("composer").addEventListener("submit", (e) => { e.preventDefault(); send(); });
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
});

// ── Settings ──
const modal = $("settings");
async function openSettings() {
  const c = await window.crowe.getConfig();
  $("cfg-base").value = c.baseUrl;
  $("cfg-model").value = c.model;
  $("cfg-token").value = "";
  $("cfg-status").textContent = c.hasToken ? "Token is set." : "No token set yet.";
  modal.classList.remove("hidden");
}
$("settings-btn").addEventListener("click", openSettings);
$("cfg-cancel").addEventListener("click", () => modal.classList.add("hidden"));
$("cfg-save").addEventListener("click", async () => {
  const patch = { baseUrl: $("cfg-base").value.trim(), model: $("cfg-model").value.trim() };
  const tok = $("cfg-token").value.trim();
  if (tok) patch.token = tok;
  const c = await window.crowe.setConfig(patch);
  $("model-badge").textContent = c.model;
  modal.classList.add("hidden");
});

// init
(async () => {
  const c = await window.crowe.getConfig();
  $("model-badge").textContent = c.model;
})();
