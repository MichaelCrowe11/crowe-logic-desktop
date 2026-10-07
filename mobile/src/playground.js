/* Playground: try a model, or two side by side, on the phone.
 *
 * Its own pane (#m-playground-pane), shown by mobile-ui.js's "playground" tab.
 * The models are the crowe-ai worker's curated list (cloud-ai.js), billed to
 * the account's Workers AI credits; text answers stream, images come back
 * whole. Nothing here touches the chat thread: a playground run is a scratch
 * pad, so it is not saved to sessions and costs the transcript nothing. The
 * picker is a native <select> grouped by vendor, which iOS draws as its own
 * menu. */
(() => {
  const body = document.body;
  const wb = document.getElementById("workbench");
  if (!wb || !wb.parentNode || !body.classList.contains("mobile")) return;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const md = (t) => (typeof window.md === "function" ? window.md(String(t || "")) : esc(t).replace(/\n/g, "<br>"));
  const haptic = (s) => { if (window.croweHaptic) window.croweHaptic(s); };

  const pane = document.createElement("section");
  pane.id = "m-playground-pane"; pane.className = "m-pane"; pane.setAttribute("aria-label", "Playground");
  wb.parentNode.insertBefore(pane, wb);

  let models = null, kind = "text", compare = false, busy = false, aborts = [];
  const imageURLs = new Set();
  const releaseImages = () => { for (const url of imageURLs) URL.revokeObjectURL(url); imageURLs.clear(); };
  window.addEventListener("pagehide", () => { aborts.forEach(c => c.abort()); releaseImages(); });
  const pick = { a: "", b: "" };
  try { Object.assign(pick, JSON.parse(localStorage.getItem("crowe-playground") || "{}")); } catch { /* fresh */ }
  const remember = () => { try { localStorage.setItem("crowe-playground", JSON.stringify(pick)); } catch { /* storage refused */ } };

  function options(selected) {
    const list = (models || []).filter((m) => m.kind === kind);
    const vendors = [...new Set(list.map((m) => m.vendor))];
    return vendors.map((v) => `<optgroup label="${esc(v)}">` + list.filter((m) => m.vendor === v)
      .map((m) => `<option value="${esc(m.id)}"${m.id === selected ? " selected" : ""}>${esc(m.label)}</option>`).join("") + "</optgroup>").join("");
  }
  const labelOf = (id) => ((models || []).find((m) => m.id === id) || {}).label || id;
  const first = () => ((models || []).find((m) => m.kind === kind) || {}).id || "";
  const valid = (id) => (models || []).some((m) => m.id === id && m.kind === kind);

  const STARTERS = {
    text: ["Explain recursion to a new programmer in three sentences.", "Write a polite email declining a meeting.", "What are the trade-offs between SQL and NoSQL?"],
    image: ["A brass compass on a dark walnut desk, soft window light", "An isometric city at dusk, neon signs, light rain", "A watercolor of a lighthouse on a rocky coast"],
  };
  const starters = () => `<section class="m-pg-try"><h2 class="m-h-label">Try one</h2><div class="m-pg-chips">${STARTERS[kind].map((t) => `<button type="button" data-starter="${esc(t)}">${esc(t)}</button>`).join("")}</div></section>`;

  function shell(note) {
    releaseImages();
    pane.innerHTML = `<div class="m-home-inner m-pg">
      <header class="m-pg-head"><h1 class="m-pg-title">Playground</h1>
        <p class="m-pg-sub">Try the models behind Crowe Logic. Runs here are scratch work and are not saved to your chats.</p></header>
      ${note ? `<p class="m-pg-note">${esc(note)}</p>` : ""}</div>`;
  }

  async function render() {
    if (!window.croweCloud) { shell("The Playground needs this build's cloud connection."); return; }
    if (!models) {
      shell("Loading models…");
      try { models = (await (await window.croweCloud.call("/v1/models")).json()).models || []; } catch (e) {
        models = null;
        shell(e.status === 401 ? "Sign in to use the Playground." : `The Playground is unavailable right now (${e.message}).`);
        return;
      }
    }
    if (!valid(pick.a)) pick.a = first();
    if (!valid(pick.b)) pick.b = ((models || []).filter((m) => m.kind === kind)[1] || {}).id || pick.a;
    const two = compare && kind === "text";
    pane.innerHTML = `<div class="m-home-inner m-pg">
      <header class="m-pg-head"><h1 class="m-pg-title">Playground</h1>
        <p class="m-pg-sub">Try the models behind Crowe Logic. Runs here are scratch work and are not saved to your chats.</p></header>
      <div class="m-seg" role="tablist" aria-label="Kind">
        <button type="button" role="tab" data-kind="text" aria-selected="${kind === "text"}">Text</button>
        <button type="button" role="tab" data-kind="image" aria-selected="${kind === "image"}">Image</button>
      </div>
      <div class="m-group">
        <label class="m-row"><span>Model</span><select id="m-pg-a" aria-label="Model">${options(pick.a)}</select></label>
        ${kind === "text" ? `<label class="m-row"><span>Compare</span><input type="checkbox" class="m-switch" id="m-pg-compare"${two ? " checked" : ""}></label>` : ""}
        ${two ? `<label class="m-row"><span>Second model</span><select id="m-pg-b" aria-label="Second model">${options(pick.b)}</select></label>` : ""}
      </div>
      <div class="m-pg-compose">
        <textarea id="m-pg-input" rows="4" maxlength="${kind === "image" ? 2048 : 8000}" placeholder="${kind === "image" ? "Describe the image to make" : "Ask anything"}"></textarea>
        <button type="button" class="primary m-pg-run" id="m-pg-run">${kind === "image" ? "Create" : "Run"}</button>
      </div>
      <div id="m-pg-out" class="m-pg-out" aria-live="polite">${starters()}</div>
    </div>`;
    pane.querySelectorAll(".m-seg [data-kind]").forEach((b) => b.addEventListener("click", () => {
      if (busy || b.dataset.kind === kind) return; kind = b.dataset.kind; haptic("selection"); render();
    }));
    const a = document.getElementById("m-pg-a"), bSel = document.getElementById("m-pg-b"), cmp = document.getElementById("m-pg-compare");
    a.addEventListener("change", () => { pick.a = a.value; remember(); });
    if (bSel) bSel.addEventListener("change", () => { pick.b = bSel.value; remember(); });
    if (cmp) cmp.addEventListener("change", () => { compare = cmp.checked; haptic("selection"); render(); });
    document.getElementById("m-pg-run").addEventListener("click", run);
    pane.querySelectorAll("[data-starter]").forEach((c) => c.addEventListener("click", () => {
      document.getElementById("m-pg-input").value = c.dataset.starter; haptic("light"); run();
    }));
  }

  function card(id) {
    const el = document.createElement("article");
    el.className = "m-pg-card";
    el.innerHTML = `<header><b>${esc(labelOf(id))}</b><span class="m-pg-meta">Waiting…</span></header><div class="m-pg-body said m-md"></div>`;
    return el;
  }

  async function streamText(model, prompt, el) {
    const meta = el.querySelector(".m-pg-meta"), out = el.querySelector(".m-pg-body");
    const t0 = performance.now(); let firstAt = 0, text = "";
    const ctrl = new AbortController(); aborts.push(ctrl);
    try {
      const r = await window.croweCloud.call("/v1/run", { method: "POST", signal: ctrl.signal, body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 1024 }) });
      const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "";
      meta.textContent = "Thinking…";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, cut); buf = buf.slice(cut + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            try { const piece = JSON.parse(data).response || ""; if (piece) { if (!firstAt) firstAt = performance.now(); text += piece; out.innerHTML = md(text); } } catch { /* partial line */ }
          }
        }
      }
      const secs = ((performance.now() - t0) / 1000).toFixed(1), ttft = firstAt ? ((firstAt - t0) / 1000).toFixed(1) : "–";
      meta.textContent = `${secs}s · first words ${ttft}s`;
      if (!text) out.innerHTML = '<p class="m-pg-note">No answer came back.</p>';
    } catch (e) {
      if (e.name === "AbortError") { meta.textContent = "Stopped"; return; }
      meta.textContent = "Failed"; out.innerHTML = `<p class="m-pg-note">${esc(e.message)}</p>`;
    }
  }

  async function makeImage(model, prompt, el) {
    const meta = el.querySelector(".m-pg-meta"), out = el.querySelector(".m-pg-body");
    const t0 = performance.now();
    meta.textContent = "Creating…";
    const ctrl = new AbortController(); aborts.push(ctrl);
    try {
      const r = await window.croweCloud.call("/v1/image", { method: "POST", signal: ctrl.signal, body: JSON.stringify({ model, prompt }) });
      const blob = await r.blob();
      if (ctrl.signal.aborted || !el.isConnected) return;
      const url = URL.createObjectURL(blob); imageURLs.add(url);
      out.innerHTML = `<img class="m-pg-img" src="${url}" alt="${esc(prompt.slice(0, 120))}">`;
      meta.textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
    } catch (e) { meta.textContent = "Failed"; out.innerHTML = `<p class="m-pg-note">${esc(e.message)}</p>`; }
  }

  async function run() {
    const btn = document.getElementById("m-pg-run");
    if (busy) { aborts.forEach((c) => c.abort()); return; }
    const prompt = document.getElementById("m-pg-input").value.trim();
    if (!prompt) { document.getElementById("m-pg-input").focus(); return; }
    document.getElementById("m-pg-input").blur();
    busy = true; aborts = []; haptic("light");
    btn.textContent = kind === "image" ? "Creating…" : "Stop";
    releaseImages();
    const out = document.getElementById("m-pg-out"); out.innerHTML = "";
    const ids = kind === "text" && compare ? [pick.a, pick.b] : [pick.a];
    const cards = ids.map((id) => { const el = card(id); out.appendChild(el); return el; });
    await Promise.all(ids.map((id, i) => kind === "image" ? makeImage(id, prompt, cards[i]) : streamText(id, prompt, cards[i])));
    busy = false; haptic("success");
    btn.textContent = kind === "image" ? "Create" : "Run";
  }

  window.crowePlayground = { render };
})();
