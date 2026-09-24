'use strict';

// Shared commands never fall back to the standalone ledger. Auth and endpoint
// selection stay in main; neither URLs nor bearer credentials cross preload.
const READS = new Set(['farm.list', 'member.list', 'department.list', 'conversation.list',
  'message.list', 'log.list', 'document.list', 'document.read_current',
  'time.list', 'time.correction_list', 'timesheet.list', 'payroll.config', 'payroll.capabilities', 'payroll.preview', 'payroll.status',
  'rule.list', 'rule.preview', 'incident.list', 'incident.read', 'knowledge.list', 'knowledge.read', 'training.list', 'training.read']);
const WRITES = new Set(['farm.create', 'member.add', 'member.revoke', 'department.create',
  'conversation.create', 'message.send', 'message.read', 'log.create', 'document.draft',
  'document.submit', 'document.approve', 'document.revise',
  'time.clock_in', 'time.clock_out', 'time.break_start', 'time.break_end', 'time.correction_request', 'time.correction_approve',
  'time.correction_reject', 'timesheet.create', 'timesheet.approve', 'payroll.configure', 'payroll.export',
  'rule.create', 'rule.activate', 'rule.disable', 'rule.evaluate', 'incident.acknowledge', 'incident.resolve',
  'training.assign', 'training.acknowledge', 'training.assess', 'training.signoff']);
const MAX_BYTES = 1024 * 1024;
const fault = (code, message) => ({ ok: false, error: { code, message } });
function endpoint(baseUrl, allowLocal) {
  const url = new URL(baseUrl);
  const local = allowLocal && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && url.origin !== 'https://api.crowelogic.com') || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('Unapproved farm endpoint');
  return `${url.origin}/api/farm/commands`;
}
async function boundedJson(response) {
  if (!response.body?.getReader) throw new Error('Missing response stream');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Response too large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
function createTeamHost({ isTrustedSender, canAccess, getSession, fetch: fetchImpl = globalThis.fetch,
  allowLocal = false, timeoutMs = 15000 }) {
  const pending = new Set(), importContexts = new WeakMap(); let epoch = 0;
  const importPermit = {};
  async function request(event, action, payload = {}, permit = null, expected = null) {
    if (!isTrustedSender(event) || !canAccess(event)) return fault('UNAVAILABLE', 'Team operations require Mycology.');
    const write = WRITES.has(action) || (permit === importPermit && action === 'import.stage');
    if (!write && !READS.has(action)) return fault('VALIDATION', 'Unsupported farm team action.');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fault('VALIDATION', 'Expected a command object.');
    let body;
    try { body = JSON.stringify({ action, payload }); } catch { return fault('VALIDATION', 'Command cannot be serialized.'); }
    if (Buffer.byteLength(body) > MAX_BYTES) return fault('VALIDATION', 'Command exceeds the size limit.');
    if (write && (typeof payload.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(payload.requestId)))
      return fault('VALIDATION', 'A stable request ID is required for this command.');
    const session = { ...getSession() };
    if (expected && (session.token !== expected.session.token || session.generation !== expected.session.generation || session.baseUrl !== expected.session.baseUrl || epoch !== expected.epoch)) return fault('AUTH_CHANGED', 'Shared consent belongs to an earlier sign-in.');
    if (!session?.token) return fault('AUTH_REQUIRED', 'Sign in with Crowe ID to open your farm team.');
    let url;
    try { url = endpoint(session.baseUrl, allowLocal); }
    catch { return fault('UNAVAILABLE', 'The configured server is not an approved farm endpoint.'); }
    const started = epoch, controller = new AbortController(); pending.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    let dispatched = false;
    const same = () => !controller.signal.aborted && started === epoch && getSession()?.generation === session.generation &&
      getSession()?.token === session.token && getSession()?.baseUrl === session.baseUrl &&
      isTrustedSender(event) && canAccess(event);
    const unknown = () => fault(write && dispatched ? 'WRITE_OUTCOME_UNKNOWN' : 'UNAVAILABLE',
      write && dispatched ? 'Server acceptance is unknown. Keep the same request ID and content when retrying; do not create a second command.' : 'The farm service is unavailable. No automatic retry was made.');
    try {
      if (!same()) return fault('AUTH_CHANGED', 'Your sign-in changed. Reopen Messenger.');
      dispatched = true;
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error', cache: 'no-store',
        headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body, signal: controller.signal });
      if (response.redirected || !same()) return unknown();
      const result = await boundedJson(response);
      if (!same()) return unknown();
      if (response.ok && result?.ok === true && Object.hasOwn(result, 'data')) return result;
      // Only explicit command rejections establish a non-write. A 5xx may have
      // occurred after COMMIT and must retain the original retry identity.
      if (response.status >= 500) return unknown();
      if (response.status === 401) return fault('AUTH_REQUIRED', 'Your Crowe ID sign-in must be renewed.');
      if (response.status === 404) return fault('UNAVAILABLE', 'Shared farm service is not available on this server. Local records are unchanged.');
      const error = result?.detail || result?.error;
      if (response.status >= 400 && typeof error?.code === 'string' && /^[a-zA-Z_]{1,64}$/.test(error.code) &&
          typeof error.message === 'string' && error.message.length <= 500) return fault(error.code, error.message);
      return unknown();
    } catch { return unknown(); }
    finally { clearTimeout(timer); pending.delete(controller); }
  }
  function captureImport(event) {
    if (!isTrustedSender(event) || !canAccess(event)) throw Object.assign(Error('Shared staging requires Mycology.'), { code: 'UNAVAILABLE' });
    const session = { ...getSession() };
    if (!session.token || session.generation === undefined) throw Object.assign(Error('Sign in before preparing a shared upload.'), { code: 'AUTH_REQUIRED' });
    return { session, epoch, sender: event.sender, frame: event.senderFrame, server: endpoint(session.baseUrl, allowLocal) };
  }
  function sameImport(event, value) {
    const now = captureImport(event);
    if (now.epoch !== value.epoch || now.sender !== value.sender || now.frame !== value.frame ||
        now.session.generation !== value.session.generation || now.session.token !== value.session.token ||
        now.server !== value.server || now.session.baseUrl !== value.session.baseUrl)
      throw Object.assign(Error('Sign-in or document changed. Prepare and confirm the shared destination again.'), { code: 'AUTH_CHANGED' });
  }
  const imports = {
    async prepare(event, { farmId, departmentId }) {
      const C = require('../imports/shared-contract'), before = captureImport(event);
      C.destination({ farmId, departmentId, accountId: 'pending-server-verification', server: before.server });
      const result = await request(event, 'farm.list', {}); sameImport(event, before);
      if (!result.ok) throw Object.assign(Error(result.error.message), { code: result.error.code });
      const farm = result.data?.items?.find(item => item.id === farmId);
      if (!farm || typeof farm.currentMemberId !== 'string' || !farm.currentMemberId)
        throw Object.assign(Error('Current authenticated farm membership is required; standalone records cannot enroll through imports.'), { code: 'AUTH_REQUIRED' });
      let departmentName = null;
      if (departmentId !== null) {
        const departments = await request(event, 'department.list', { farmId }); sameImport(event, before);
        if (!departments.ok) throw Object.assign(Error(departments.error.message), { code: departments.error.code });
        const department = departments.data?.items?.find(item => item.id === departmentId);
        if (!department) throw Object.assign(Error('Choose a department available to your farm membership.'), { code: 'AUTH_REQUIRED' });
        departmentName = department.name;
      }
      const destination = C.destination({ accountId: farm.currentMemberId, server: before.server, farmId, departmentId });
      const context = Object.freeze({ destination: Object.freeze(destination), farmName: String(farm.name), departmentName });
      importContexts.set(context, before); return context;
    },
    assertCurrent(event, context) {
      const value = importContexts.get(context);
      if (!value) throw Object.assign(Error('Shared destination must be prepared by the trusted host.'), { code: 'AUTH_REQUIRED' });
      sameImport(event, value);
    },
    async stage(event, context, payload) {
      imports.assertCurrent(event, context);
      require('../imports/shared-contract').command(payload);
      if (payload.farmId !== context.destination.farmId || payload.departmentId !== context.destination.departmentId)
        throw Object.assign(Error('Shared upload destination does not match consent.'), { code: 'AUTH_CHANGED' });
      // This method is trusted-main only. The general renderer team action list
      // intentionally excludes all import writes, especially revise/promote.
      return request(event, 'import.stage', payload, importPermit, importContexts.get(context));
    },
  };
  return { request, imports, invalidate() { epoch++; for (const controller of pending) controller.abort(); } };
}
module.exports = { createTeamHost, endpoint, READS, WRITES };
