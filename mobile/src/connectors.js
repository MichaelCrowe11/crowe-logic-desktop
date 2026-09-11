/* Connected services on the phone: Google Calendar and Drive through the gateway.
 *
 * Drop-in for crowelogic-71's branch: one new file plus two small hooks.
 *   file  mobile/src/connectors.js  (COPY list in build-www.js, <script> after mobile-ui.js)
 *   hook 1  mobile-bridge.js, in runAgent where the tools array for the gateway is built:
 *             const extra = await (window.croweConnectors ? window.croweConnectors.tools() : []);
 *             tools = tools.concat(extra);
 *   hook 2  mobile-bridge.js, where a tool_call is dispatched by name:
 *             if (window.croweConnectors && window.croweConnectors.owns(name)) {
 *               result = await window.croweConnectors.act(name, args);   // -> string for the tool message
 *             } else { ...existing dispatch... }
 * Requires control plane 0.2.20 with CONNECTORS_ENABLED=1. Without it, /api/connectors
 * answers "enabled": false and this file draws nothing and adds no tools.
 *
 * Security shape: tokens never reach the phone. The phone only ever sees tool
 * definitions and tool results; the grant lives on the gateway under the person's
 * Crowe ID. Plan gate is the gateway's (personal and above).
 */
(() => {
  const $ = (id) => document.getElementById(id);
  if (!window.crowe || !window.crowe.getConfig) return;
  const Cap = window.Capacitor;
  const Browser = Cap && Cap.Plugins && Cap.Plugins.Browser;
  let base = "https://api.crowelogic.com";
  let cachedTools = null;
  let cachedAt = 0;

  async function bearer() {
    const st = await window.crowe.auth.status();
    if (!st || !st.user) return null;
    const cfg = await window.crowe.getConfig();
    base = (cfg.baseUrl || base).replace(/\/$/, "");
    return window.crowePhone && window.crowePhone.accessToken ? window.crowePhone.accessToken() : null;
  }
  async function api(method, path, body) {
    const b = await bearer();
    if (!b) throw new Error("Sign in first");
    const r = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${b}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (!r.ok) { const d = json && json.detail; throw new Error((d && (d.message || d)) || `${r.status}`); }
    return json;
  }

  const connectors = {
    // Tool definitions for the connected providers; cached for a minute so a run does not pay a round trip each turn.
    async tools() {
      try {
        if (cachedTools && Date.now() - cachedAt < 60000) return cachedTools;
        const out = await api("GET", "/api/connectors/tools");
        cachedTools = (out && out.tools) || []; cachedAt = Date.now();
        return cachedTools;
      } catch { return cachedTools || []; }
    },
    owns(name) { return Boolean(cachedTools && cachedTools.some((t) => t.function && t.function.name === name)); },
    async act(name, args) {
      try {
        const out = await api("POST", "/api/connectors/act", { name, arguments: args || {} });
        return JSON.stringify(out.result);
      } catch (e) {
        // The model gets the reason in words, the same way a failed shell command reads back.
        return JSON.stringify({ error: String(e.message || e) });
      }
    },
    invalidate() { cachedTools = null; },
  };
  window.croweConnectors = connectors;

  /* Settings: "Connected services". Drawn only when the gateway says connectors are enabled. */
  async function draw() {
    let cat;
    try { cat = await api("GET", "/api/connectors"); } catch { return; }
    if (!cat || !cat.enabled) return;
    let section = $("m-connectors");
    if (!section) {
      section = document.createElement("section");
      section.id = "m-connectors"; section.className = "key-manager";
      const anchor = $("m-delete-account") && $("m-delete-account").closest("section");
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(section, anchor); else return;
    }
    const rows = cat.connectors.map((c) => {
      const state = c.connected ? `Connected${c.account ? " as " + c.account : ""}` : (c.configured ? "Not connected" : "Not available yet");
      const btn = c.connected
        ? `<button class="ghost sm" data-disconnect="${c.provider}" type="button">Disconnect</button>`
        : (c.configured && c.allowed ? `<button class="ghost sm" data-connect="${c.provider}" type="button">Connect ${c.label}</button>` : "");
      return `<div class="m-connector"><b>${c.label}</b> <span>${c.services.join(", ")}. ${state}.</span> ${btn}</div>`;
    }).join("");
    section.innerHTML = [
      '<div class="settings-section-head"><div><b>Connected services</b>',
      "<span>Let the agent read and write inside your own accounts. Access is granted to the gateway under your Crowe ID and never stored on this phone. ",
      cat.connectors.some((c) => !c.allowed) ? `Needs the ${cat.min_plan} plan or higher.` : "",
      "</span></div></div>", rows,
    ].join("");
    section.querySelectorAll("[data-connect]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const out = await api("POST", `/api/connectors/${b.dataset.connect}/start`, { return_to: "com.crowelogic.mobile://connectors" });
        if (Browser) await Browser.open({ url: out.url, presentationStyle: "popover" }); else window.open(out.url, "_blank", "noopener");
      } catch (e) { if (typeof setComposerStatus === "function") setComposerStatus(String(e.message || e).slice(0, 80), "error"); }
      b.disabled = false;
    }));
    section.querySelectorAll("[data-disconnect]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      try { await api("DELETE", `/api/connectors/${b.dataset.disconnect}`); connectors.invalidate(); await draw(); }
      catch (e) { if (typeof setComposerStatus === "function") setComposerStatus(String(e.message || e).slice(0, 80), "error"); b.disabled = false; }
    }));
  }

  // Redraw when Settings opens, when the browser sheet closes (the grant may have landed), and on the deep link back.
  const settingsBtn = $("settings-btn");
  if (settingsBtn) settingsBtn.addEventListener("click", () => { setTimeout(draw, 50); });
  if (Browser && Browser.addListener) Promise.resolve(Browser.addListener("browserFinished", () => { connectors.invalidate(); draw(); })).catch(() => {});
  const App = Cap && Cap.Plugins && Cap.Plugins.App;
  if (App && App.addListener) Promise.resolve(App.addListener("appUrlOpen", (e) => { if (e && String(e.url || "").startsWith("com.crowelogic.mobile://connectors")) { connectors.invalidate(); draw(); } })).catch(() => {});
})();
