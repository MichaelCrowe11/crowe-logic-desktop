// Crowe Logic mobile - Crowe Vision.
//
// No bundler and no framework. The whole app is one screen with four states
// (empty, has-image, analyzing, answered), which is less state than a build
// step would cost to manage.

const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);

// tools/vision.py's "crowe" backend posts here. The path is settable because
// the FastAPI router in domain/vision mounts its own routes at /vision/* and
// the two have not converged yet - see the note in src-tauri/src/lib.rs.
const DEFAULT_ENDPOINT = "https://mycology.crowelogic.com/api/crowe-vision/analyze";

// Phone cameras shoot 12MP. Base64 of a raw frame is ~16 MB, which is slow on
// grow-room wifi and larger than most vision models will accept anyway. The
// long edge is capped instead; contamination is visible well below that.
const MAX_EDGE = 1536;
const JPEG_QUALITY = 0.85;

const PROMPTS = {
  contamination:
    "Inspect this mushroom substrate or culture for contamination. Identify any " +
    "mould, bacterial blotch, wet spot or cobweb. State the contaminant if you can " +
    "name it, roughly what fraction of the visible area is affected, and what the " +
    "grower should do about it. Say plainly if it looks clean.",
  growth_stage:
    "Identify the growth stage of this mushroom culture: no growth, early / mid / " +
    "full colonisation, primordia, pin set, young or mature fruiting, or " +
    "sporulating. Estimate percent colonisation and note anything about vigour.",
  species_id:
    "Identify this mushroom from its morphology. Give the most likely species, " +
    "plausible alternatives, and the features you used. Note explicitly that " +
    "photographs are not sufficient for deciding edibility.",
  general: "Describe what you see in this image in detail, for a mushroom grower.",
};

const state = {
  type: "contamination",
  image: null,     // { b64, mime, dataUrl }
  busy: false,
};

const $ = (id) => document.getElementById(id);
const els = {
  types: $("types"), file: $("file"), shot: $("shot"),
  shotLabel: $("shot-label"), shotHint: $("shot-hint"),
  analyze: $("analyze"), clear: $("clear"), result: $("result"),
  settings: $("settings"), endpoint: $("endpoint"), apikey: $("apikey"),
};

// ── settings ──────────────────────────────────────────────────────

const settings = {
  get endpoint() { return localStorage.getItem("cv.endpoint") || DEFAULT_ENDPOINT; },
  get apiKey() { return localStorage.getItem("cv.apikey") || ""; },
  save(endpoint, apiKey) {
    localStorage.setItem("cv.endpoint", endpoint.trim() || DEFAULT_ENDPOINT);
    localStorage.setItem("cv.apikey", apiKey);
  },
};

$("open-settings").addEventListener("click", () => {
  els.endpoint.value = settings.endpoint;
  els.apikey.value = settings.apiKey;
  els.settings.showModal();
});

els.settings.addEventListener("close", () => {
  if (els.settings.returnValue === "save") settings.save(els.endpoint.value, els.apikey.value);
});

// ── analysis type ─────────────────────────────────────────────────

els.types.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-type]");
  if (!btn) return;
  state.type = btn.dataset.type;
  for (const b of els.types.querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b === btn));
  }
});

// ── capture ───────────────────────────────────────────────────────

/** Draw the picked file to a canvas capped at MAX_EDGE and re-encode as JPEG. */
function downscale(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL("image/jpeg", JPEG_QUALITY);
      resolve({ dataUrl, mime: "image/jpeg", b64: dataUrl.split(",")[1] });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("could not decode that image")); };
    img.src = url;
  });
}

els.file.addEventListener("change", async () => {
  const file = els.file.files && els.file.files[0];
  if (!file) return;
  try {
    state.image = await downscale(file);
    showImage();
  } catch (err) {
    render({ error: String(err.message || err) });
  }
});

function showImage() {
  els.shot.classList.add("has-image");
  let preview = els.shot.querySelector("img.preview");
  if (!preview) {
    preview = document.createElement("img");
    preview.className = "preview";
    preview.alt = "";
    els.shot.appendChild(preview);
  }
  preview.src = state.image.dataUrl;
  const kb = Math.round((state.image.b64.length * 3) / 4 / 1024);
  els.shotLabel.textContent = "Retake";
  els.shotHint.textContent = `${kb} KB ready to send`;
  els.analyze.disabled = false;
  els.clear.disabled = false;
}

els.clear.addEventListener("click", () => {
  state.image = null;
  els.file.value = "";
  els.shot.classList.remove("has-image");
  const preview = els.shot.querySelector("img.preview");
  if (preview) preview.remove();
  els.shotLabel.textContent = "Take a photo";
  els.shotHint.textContent = "or choose one from your library";
  els.analyze.disabled = true;
  els.clear.disabled = true;
  els.result.innerHTML = "";
});

// ── analyze ───────────────────────────────────────────────────────

els.analyze.addEventListener("click", async () => {
  if (!state.image || state.busy) return;
  state.busy = true;
  els.analyze.disabled = true;
  els.result.innerHTML =
    `<div class="card"><h2><span class="spinner"></span> Analyzing</h2>` +
    `<p class="meta">Sending to ${escapeHtml(hostOf(settings.endpoint))}</p></div>`;

  try {
    const data = await invoke("vision_analyze", {
      req: {
        endpoint: settings.endpoint,
        api_key: settings.apiKey,
        body: {
          image: state.image.b64,
          mime_type: state.image.mime,
          prompt: PROMPTS[state.type],
          analysis_type: state.type,
        },
      },
    });
    render(data);
  } catch (err) {
    render({ error: String(err) });
  } finally {
    state.busy = false;
    els.analyze.disabled = !state.image;
  }
});

// ── rendering ─────────────────────────────────────────────────────

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

// Severity drives the pill colour. The backend has shipped this under a few
// different shapes, so read whichever one is present rather than insisting.
function verdictFor(data) {
  const sev = data.severity || (data.results && data.results.severity);
  if (sev) {
    const bad = ["moderate", "severe"].includes(sev);
    const warn = ["suspected", "mild"].includes(sev);
    return { text: sev, cls: bad ? "bad" : warn ? "warn" : "ok" };
  }
  if (typeof data.detected === "boolean") {
    return data.detected
      ? { text: "contamination", cls: "bad" }
      : { text: "clean", cls: "ok" };
  }
  const stage = data.stage || (data.results && data.results.stage);
  if (stage) return { text: String(stage).replace(/_/g, " "), cls: "ok" };
  return null;
}

// The live backend answers an unauthenticated call with
// HTTP 401 {"code":"AUTH_REQUIRED", ...}. That is the first thing every new
// install hits, so it gets a real screen with the way out on it rather than a
// wall of JSON the grower has to read past.
function authPrompt(raw) {
  let message = "Crowe Vision needs an account before it will analyze a photo.";
  const json = raw.match(/\{.*\}/s);
  if (json) {
    try {
      const parsed = JSON.parse(json[0]);
      if (parsed.message) message = parsed.message;
    } catch { /* keep the default wording */ }
  }
  return `<div class="card"><h2>Sign in to run Crowe Vision</h2>` +
    `<p>${escapeHtml(message)}</p>` +
    `<div class="actions"><button class="primary" id="goto-settings">Add API key</button></div></div>`;
}

function render(data) {
  if (data && data.error) {
    const raw = String(data.error);
    if (/HTTP 401|AUTH_REQUIRED/.test(raw)) {
      els.result.innerHTML = authPrompt(raw);
      $("goto-settings").addEventListener("click", () => $("open-settings").click());
      return;
    }
    els.result.innerHTML =
      `<div class="card error"><h2>Could not analyze</h2>` +
      `<pre>${escapeHtml(raw)}</pre></div>`;
    return;
  }

  const verdict = verdictFor(data);
  // The useful prose lives under a different key depending on the backend that
  // answered; fall back to the raw payload rather than showing an empty card.
  const text = data.analysis
    || data.analysis_details
    || data.recommendation
    || (data.results && (data.results.analysis || data.results.analysis_details))
    || JSON.stringify(data, null, 2);

  const bits = [];
  bits.push(`<h2>Result${verdict ? ` <span class="verdict ${verdict.cls}">${escapeHtml(verdict.text)}</span>` : ""}</h2>`);
  bits.push(`<pre>${escapeHtml(text)}</pre>`);

  const conf = data.confidence ?? (data.results && data.results.confidence);
  const meta = [];
  if (typeof conf === "number") meta.push(`confidence ${Math.round(conf * 100)}%`);
  if (data.backend) meta.push(`via ${data.backend}`);
  if (data.model) meta.push(data.model);
  if (meta.length) bits.push(`<p class="meta">${escapeHtml(meta.join(" · "))}</p>`);

  els.result.innerHTML = `<div class="card">${bits.join("")}</div>`;
}
