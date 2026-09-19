// Desktop council boundary. Only the renderer can grant authority; models have
// no IPC tools. Council inference is tool-free, pinned and never silently routed.
const C = require("./council");
const { makeFileExecutor } = require("./council-files");
const H = require("../harness");
const R = require("./engine");
const registry = require("./registry");
// File authority is the intersection of the operator's configured autonomy and
// the roster's own ceiling: the tier a Room turn runs at. A read-only or
// advisory roster cannot be lifted into writing by a grant. A missing or
// invalid autonomy setting fails closed here; effectiveTier alone would
// default it to edit, which is right for a Room turn and wrong for a grant.
const fileTier = (room, cfg) => registry.TIERS.includes(String(cfg.autonomy)) ? registry.effectiveTier(room.agents.map(a => a.agentId), cfg.autonomy) : "plan";
function installCouncilHost(d) {
  const runs = new Map();
  const command = (name, fn) => d.ipcMain.handle(`crowe:rooms:council-${name}`, async (_e, arg = {}) => {
    try { return await fn(arg); } catch (e) { return { error: H.redactSecrets(String(e.message || e)) }; }
  });
  const get = id => { const room = d.loadRoom(id); if (!room) throw new Error("No such room."); return room; };
  const save = room => d.save(room);
  command("state", ({ id }) => ({ council: get(id).council || null, history: get(id).councilHistory || [], capabilities: { files: true, advisory: true } }));
  command("stop", async ({ id, revoke = false }) => {
    const room = get(id); C.stop(room.council, revoke);
    const run = runs.get(id); if (run) run.controller.abort();
    save(room); d.changed(room, "council"); return { council: room.council || null };
  });
  command("start", async ({ id, spec }) => {
    const room = get(id);
    if (runs.has(id) || d.busy(id)) throw new Error("This room is busy. Pause or finish its current turn first.");
    const cfg = d.config();
    if (spec?.mode === "files" && !registry.writeCapable(fileTier(room, cfg))) throw new Error(`Scoped file autopilot requires an edit-capable room; this room's effective tier is ${fileTier(room, cfg)}.`);
    const catalog = d.catalog();
    const seats = room.agents.map(a => {
      const model = a.model || cfg.model;
      const entry = catalog.find(m => m.id === model && m.available !== false);
      if (!entry) throw new Error(`Pin an available catalog model for every seat: ${model || a.agentId}.`);
      return { id: a.agentId, model, engine: String(entry.engine || entry.base_model || entry.model || entry.id) };
    });
    const contract = C.grant({ ...spec, workspace: cfg.cwd }, seats);
    const files = contract.mode === "files" ? makeFileExecutor(cfg.cwd, contract.files) : null;
    if (files) { contract.workspace = files.workspace; files.snapshot(); }
    if (H.scanForSecrets(contract.goal).length) throw new Error("Remove credential-like material from the goal.");
    const state = C.create(contract);
    if (room.council) (room.councilHistory || (room.councilHistory = [])).push(room.council);
    room.council = state;
    save(room);
    const run = { controller: new AbortController() }; runs.set(id, run);
    const authorized = () => {
      const current = d.config();
      if (!current.token) throw new Error("Sign-in ended; council authority is suspended.");
      if (room.council !== state || runs.get(id) !== run) throw new Error("Council authority no longer belongs to this run.");
      if (contract.mode === "files" && (!registry.writeCapable(fileTier(room, current)) || require('fs').realpathSync(current.cwd) !== contract.workspace)) throw new Error(`Workspace or autonomy changed (effective tier ${fileTier(room, current)}); a new grant is required.`);
      if (room.agents.length !== seats.length || seats.some(s => !room.agents.some(a => a.agentId === s.id && (a.model || current.model) === s.model))) throw new Error("Roster or model pins changed; votes are invalid.");
    };
    d.queue(id, async () => {
      const deps = {
        authorized,
        save: async () => { save(room); d.changed(room, "council"); },
        snapshot: async () => files ? files.snapshot() : {},
        classify: async proposal => { if (H.scanForSecrets(proposal.summary).length) throw new Error("Proposal contains credential-like material."); if (files) files.classify(proposal); },
        ask: async (seat, task, data) => {
          const timeout = setTimeout(() => run.controller.abort(), Math.min(120000, Math.max(1, contract.expiresAt - Date.now())));
          let result;
          try { result = await d.chat([{ role: "system", content: C.PROMPTS[task] }, { role: "user", content: JSON.stringify(data) }], [], false, run.controller.signal, seat.model); }
          finally { clearTimeout(timeout); }
          if (result.error || result.aborted) throw new Error(result.error || "Model request interrupted.");
          if (result.model && result.model !== seat.model) throw new Error("Gateway returned a different model; no vote accepted.");
          if (result.tool_calls?.length) throw new Error("Council requests cannot execute model tools.");
          const text = result.content || result.text || "";
          if (H.scanForSecrets(text).length) throw new Error("Model response contained credential-like material; response withheld.");
          return text;
        },
        execute: async (proposal, before, grant, live) => {
          authorized();
          const receipt = files ? files.execute(proposal, before, grant, () => { authorized(); return live(); })
            // The advisory result is the record itself, so the receipt carries
            // it: the verifier compares `recorded` with the approved summary
            // instead of taking a sentence on trust.
            : { summary: "Council-approved advisory result recorded. No external action or workspace write. The recorded text is reproduced as `recorded`; verification is its equality with the approved proposal summary.", recorded: proposal.summary, kind: proposal.kind, at: Date.now() };
          R.pushMessage(room, { author: R.SYSTEM, kind: "council", content: `Council approved: ${proposal.summary}\n${receipt.summary}` });
          return receipt;
        },
      };
      await C.run(state, deps);
    }).catch(e => {
      if (!["paused", "revoked"].includes(state.status)) { state.status = "escalated"; state.reason = H.redactSecrets(String(e.message || e)); }
      try { save(room); d.changed(room, "council"); } catch { /* Disk failure is surfaced in memory, never permission to execute. */ }
    }).finally(() => { if (runs.get(id) === run) runs.delete(id); });
    d.changed(room, "council");
    return { council: state };
  });
  return { stopAll: () => { for (const [id, run] of runs) { const room = d.loadRoom(id); if (room?.council) { C.stop(room.council); run.controller.abort(); save(room); d.changed(room, "council"); } run.controller.abort(); } }, busy: id => runs.has(id) };
}
module.exports = { installCouncilHost };
