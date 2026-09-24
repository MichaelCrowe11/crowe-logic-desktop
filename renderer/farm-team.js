/* Mycology team surfaces share one explicit farm selection, never the local ledger. */
(function (root) {
  'use strict';
  root.FarmTeam = { mount(container, api, importsApi) {
    const doc = container.ownerDocument;
    const shell = doc.createElement('section'); shell.className = 'farm-team';
    const nav = doc.createElement('nav'); nav.className = 'farm-team-tabs'; nav.setAttribute('aria-label', 'Farm team tools');
    const scope = doc.createElement('p'); scope.className = 'farm-team-scope';
    scope.textContent = 'Shared team service. Standalone Farm & Compliance records remain separate until an explicit enrollment is available.';
    const panels = {}, buttons = {}, modules = {};
    let alive = true, active = true, tab = 'messages', selection = null;
    const labels = { messages: 'Messages', hours: 'Hours & payroll', knowledge: 'SOPs, training & alerts', imports: 'Document intake' };
    function clearScoped() {
      for (const key of ['hours', 'knowledge', 'imports']) { modules[key]?.destroy?.(); delete modules[key]; panels[key].replaceChildren(); }
    }
    function show() {
      if (!alive || !active) return;
      for (const key of Object.keys(labels)) {
        const on = key === tab; panels[key].hidden = !on;
        buttons[key].setAttribute('aria-pressed', String(on));
        if (!on) modules[key]?.deactivate?.();
      }
      if (tab === 'messages') modules.messages?.open?.();
      else if (tab === 'imports') {
        if (!modules.imports && !panels.imports.childNodes.length) {
          const warning = doc.createElement('p');
          warning.textContent = 'Device-local document archive, not this signed-in account or shared farm. Anyone using this desktop profile can read retained originals, including after sign-out. Opening it does not upload documents or approve records.';
          const enter = doc.createElement('button'); enter.type = 'button'; enter.textContent = 'Open device-local staging archive';
          enter.addEventListener('click', () => {
            if (!alive || !active || tab !== 'imports') return;
            if (!root.FarmImports || !importsApi) { warning.textContent = 'Document intake is unavailable in this runtime.'; return; }
            panels.imports.replaceChildren(); modules.imports = root.FarmImports.mount(panels.imports, importsApi, { sharedFarm: selection ? { ...selection } : null });
          });
          panels.imports.append(warning, enter);
        }
        modules.imports?.open?.();
      } else {
        const factory = tab === 'hours' ? root.FarmWorkforce : root.FarmAwareness;
        if (!selection) { panels[tab].textContent = 'Select your shared farm in Messages first. Local farm records are not automatically uploaded.'; return; }
        if (!factory) { panels[tab].textContent = 'This team tool is unavailable in this build.'; return; }
        if (!modules[tab]) { panels[tab].replaceChildren(); modules[tab] = factory.mount(panels[tab], api, { ...selection }); }
        else modules[tab].open?.();
      }
    }
    for (const [key, label] of Object.entries(labels)) {
      const button = doc.createElement('button'); button.type = 'button'; button.textContent = label; button.dataset.teamTab = key;
      button.addEventListener('click', () => { tab = key; show(); }); nav.append(button); buttons[key] = button;
      const panel = doc.createElement('div'); panel.dataset.teamPanel = key; panel.hidden = key !== tab; panels[key] = panel;
    }
    shell.append(nav, scope, ...Object.values(panels)); container.append(shell);
    modules.messages = root.FarmMessenger.mount(panels.messages, api, { onFarmChanged(next) {
      if (!alive) return;
      if (JSON.stringify(next) !== JSON.stringify(selection)) {
        clearScoped(); selection = next;
        if (tab !== 'messages') show();
      }
    } });
    show();
    return {
      open() { if (!alive) return; active = true; show(); },
      deactivate() { active = false; for (const mod of Object.values(modules)) mod?.deactivate?.(); },
      destroy() { alive = false; active = false; for (const mod of Object.values(modules)) mod?.destroy?.(); selection = null; shell.remove(); },
    };
  } };
})(typeof window !== 'undefined' ? window : globalThis);
