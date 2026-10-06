const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");

const fail = (message, status = 400, current) => Object.assign(new Error(message), { status, current });
const size = value => Buffer.byteLength(value, "utf8");
const dimensions = (cols, rows) => {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 300 || rows < 2 || rows > 120) throw fail("Invalid terminal dimensions.");
};

// Process ownership stays on the desktop. Poll clients only receive bounded,
// sequenced output. A missing history range is replaced by a full VT snapshot.
class TerminalSessions extends EventEmitter {
  constructor({ historyBytes = 256 * 1024, now = Date.now } = {}) {
    super(); this.sessions = new Map(); this.historyBytes = historyBytes; this.now = now;
  }
  create(id, spawn, { cols = 80, rows = 24, cwd = "", label = id, openedBy = null } = {}) {
    dimensions(cols, rows);
    if (this.sessions.has(id)) return this.get(id);
    if (this.sessions.size >= 24) throw fail("Close a terminal before opening another.", 429);
    const screen = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
    const serializer = new SerializeAddon(); screen.loadAddon(serializer);
    const s = { id, generation: crypto.randomUUID(), secret: crypto.randomBytes(32).toString("hex"), cols, rows, cwd, label,
      screen, serializer, seq: 0, history: [], bytes: 0, queued: 0, chain: Promise.resolve(), controller: null, lease: 0, inputs: new Map(), draft: null,
      // A shell a phone opened belongs to that phone: it may close it, and
      // nothing else on the phone may. Desktop terminals carry null.
      openedBy: openedBy ? { deviceId: openedBy.id, name: openedBy.name } : null };
    this.sessions.set(id, s);
    try { s.proc = spawn(s); } catch (error) { this.sessions.delete(id); screen.dispose(); throw error; }
    s.proc.onData(data => {
      s.queued += size(data);
      if (s.queued > 256 * 1024) s.proc.pause?.();
      this.enqueue(s, () => new Promise(resolve => screen.write(data, () => {
        s.queued -= size(data); this.record(s, { type: "output", data });
        if (s.queued < 64 * 1024) s.proc.resume?.(); resolve();
      })));
    });
    s.proc.onExit(() => this.remove(id, s.generation));
    return s;
  }
  enqueue(s, fn) {
    s.chain = s.chain.then(() => { if (!s.closed) return fn(); }).catch(error => {
      this.emit("fault", { id: s.id, error: error.message }); this.close(s.id);
    });
    return s.chain;
  }
  record(s, event) {
    const item = { ...event, seq: ++s.seq }; const bytes = size(JSON.stringify(item));
    s.history.push({ item, bytes }); s.bytes += bytes;
    while (s.bytes > this.historyBytes && s.history.length) s.bytes -= s.history.shift().bytes;
    this.emit("record", s.id);
  }
  // Holds a poll until there is something past `after`, control changes, or
  // the session ends, so a phone sees output as it lands instead of on the
  // next tick of a timer.
  waitFor(id, after, ms) {
    const s = this.sessions.get(id);
    if (!s || !Number.isInteger(after) || s.seq > after || ms <= 0) return Promise.resolve();
    return new Promise(resolve => {
      const wake = (e) => { if (e === id || e?.id === id || e?.sessionId === id || e?.session?.id === id) done(); };
      const done = () => { clearTimeout(timer); for (const t of ["record", "control", "removed", "draft-change", "draft-open"]) this.off(t, wake); resolve(); };
      const timer = setTimeout(done, ms);
      for (const t of ["record", "control", "removed", "draft-change", "draft-open"]) this.on(t, wake);
    });
  }
  get(id, generation) {
    const s = this.sessions.get(id);
    if (!s || (generation && generation !== s.generation)) throw fail("The terminal session ended. Select a current session.", 410);
    return s;
  }
  meta(s, viewer = null) {
    if (s.controller && s.controller.expires <= this.now()) this.reclaim(s.id);
    return { id: s.id, generation: s.generation, label: s.label, cwd: s.cwd, cols: s.cols, rows: s.rows,
      origin: s.openedBy ? "phone" : "desktop", openedBy: s.openedBy ? s.openedBy.name : null, mine: Boolean(viewer && s.openedBy?.deviceId === viewer),
      controller: s.controller ? { deviceId: s.controller.deviceId, name: s.controller.name, lease: s.lease } : null,
      draft: s.draft ? { id: s.draft.id, revision: s.draft.revision, status: s.draft.status } : null };
  }
  list(viewer = null) { return [...this.sessions.values()].map(s => this.meta(s, viewer)); }
  async poll(id, generation, after) {
    const s = this.get(id);
    // The barrier serializes resize and output before snapshotting; data that
    // arrives later belongs to a later sequence and the next request.
    await s.chain;
    this.get(id, s.generation);
    const first = s.history[0]?.item.seq ?? s.seq + 1;
    const snapshot = generation !== s.generation || !Number.isInteger(after) || after < first - 1 || after > s.seq;
    return { ...this.meta(s), seq: s.seq, snapshot: snapshot ? s.serializer.serialize() : null,
      events: snapshot ? [] : s.history.filter(e => e.item.seq > after).map(e => e.item) };
  }
  acquire(id, generation, device) {
    const s = this.get(id, generation); this.meta(s);
    if (s.controller && s.controller.deviceId !== device.id) throw fail("Another phone controls this session.", 409);
    if (!s.controller) s.lease++;
    s.controller = { deviceId: device.id, name: device.name, expires: this.now() + 15000 };
    this.emit("control", this.meta(s)); return this.meta(s);
  }
  renew(id, generation, device, lease) {
    const s = this.controlled(id, generation, device, lease); s.controller.expires = this.now() + 15000;
    return this.meta(s);
  }
  controlled(id, generation, device, lease) {
    const s = this.get(id, generation); this.meta(s);
    if (!s.controller || s.controller.deviceId !== device.id || s.lease !== lease) throw fail("Take control before sending input.", 409);
    return s;
  }
  reclaim(id) {
    const s = this.get(id); if (s.controller) { s.controller = null; s.lease++; this.emit("control", this.meta(s)); }
    return this.meta(s);
  }
  revoke(deviceId) { for (const s of this.sessions.values()) if (!deviceId || s.controller?.deviceId === deviceId) this.reclaim(s.id); }
  input(id, generation, device, lease, inputId, data) {
    const s = this.controlled(id, generation, device, lease);
    if (typeof data !== "string" || size(data) > 16384 || typeof inputId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(inputId)) throw fail("Invalid terminal input.");
    const key = `${device.id}:${lease}:${inputId}`;
    if (s.inputs.has(key)) {
      if (s.inputs.get(key) !== data) throw fail("Input ID was already used.", 409);
      return { accepted: inputId, duplicate: true };
    }
    s.proc.write(data); s.inputs.set(key, data);
    while (s.inputs.size > 256) s.inputs.delete(s.inputs.keys().next().value);
    return { accepted: inputId };
  }
  localInput(id, data) { const s = this.get(id); this.reclaim(id); s.proc.write(data); }
  resize(id, cols, rows) {
    dimensions(cols, rows); const s = this.get(id);
    return this.enqueue(s, () => {
      s.proc.resize(cols, rows); s.screen.resize(cols, rows); s.cols = cols; s.rows = rows;
      this.record(s, { type: "resize", cols, rows });
    });
  }
  localResize(id, cols, rows) { const s = this.get(id); if (!s.controller) return this.resize(id, cols, rows); }
  openDraft(id, text) {
    const s = this.get(id);
    if (typeof text !== "string" || size(text) > 256 * 1024) throw fail("Draft exceeds 256 KiB.");
    if (s.draft && s.draft.status === "editing") throw fail("This session already has an open draft.", 409);
    s.draft = { id: crypto.randomUUID(), revision: 1, text, status: "editing", desktopDirty: false, operations: new Map() };
    this.emit("draft-open", { session: this.meta(s), draft: this.draft(id, s.draft.id) });
    return this.draft(id, s.draft.id);
  }
  draft(id, draftId) {
    const d = this.get(id).draft;
    if (!d || d.id !== draftId) throw fail("That draft is no longer attached to this prompt.", 410);
    return { id: d.id, revision: d.revision, text: d.text, status: d.status, desktopDirty: d.desktopDirty };
  }
  changeDraft(id, draftId, { baseRevision, operationId, text, action = "save" }, local = false) {
    const s = this.get(id); const current = this.draft(id, draftId); const d = s.draft;
    if (!['save', 'return', 'discard'].includes(action) || typeof operationId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(operationId)) throw fail("Invalid draft operation.");
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ action, baseRevision, text })).digest("hex");
    if (d.operations.has(operationId)) {
      const old = d.operations.get(operationId);
      if (old.fingerprint !== fingerprint) throw fail("Draft operation ID was already used.", 409, current);
      return old.result;
    }
    if (d.status !== "editing" || d.revision !== baseRevision || (!local && d.desktopDirty)) throw fail("The draft changed. Review the host version before saving or returning.", 409, current);
    if (action === "save") {
      if (typeof text !== "string" || size(text) > 256 * 1024) throw fail("Draft exceeds 256 KiB.");
      d.text = text; d.revision++;
      if (local) d.desktopDirty = false;
    } else d.status = action === "return" ? "returned" : "discarded";
    const result = this.draft(id, draftId);
    d.operations.set(operationId, { fingerprint, result });
    while (d.operations.size > 64) d.operations.delete(d.operations.keys().next().value);
    this.emit("draft-change", { sessionId: id, draft: result, local });
    return result;
  }
  cancelDraft(id, draftId) {
    const s = this.get(id); const d = this.draft(id, draftId);
    if (d.status === "editing") { s.draft.status = "discarded"; this.emit("draft-change", { sessionId: id, draft: this.draft(id, draftId) }); }
  }
  remove(id, generation) {
    const s = this.sessions.get(id); if (!s || s.generation !== generation) return;
    s.closed = true; this.sessions.delete(id);
    s.screen.dispose(); this.emit("removed", { id, generation });
  }
  // The phone may end only a shell it opened itself; a desktop terminal stays
  // the desktop's to close.
  closeOwned(id, generation, device) {
    const s = this.get(id, generation);
    if (!s.openedBy || s.openedBy.deviceId !== device.id) throw fail("Only the phone that opened this shell can close it.", 403);
    this.close(id); return { closed: id };
  }
  // A phone that is unpaired, or a companion that stops, leaves no one who
  // could reach its shells, so they end with it.
  closeOpenedBy(deviceId) {
    for (const s of [...this.sessions.values()]) if (s.openedBy && (!deviceId || s.openedBy.deviceId === deviceId)) this.close(s.id);
  }
  close(id) { const s = this.sessions.get(id); if (s) { try { s.proc.kill(); } finally { this.remove(id, s.generation); } } }
  closeAll() { for (const id of [...this.sessions.keys()]) this.close(id); }
}
module.exports = { TerminalSessions, fail };
