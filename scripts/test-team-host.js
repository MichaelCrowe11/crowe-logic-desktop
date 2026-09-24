'use strict';

// Offline security/failure regression tests. Only synthetic sessions, injected
// fetch, and in-memory Response/ReadableStream fixtures; never main or a profile.
const assert = require('node:assert/strict');
const { createTeamHost, endpoint, READS, WRITES } = require('../farm/team-host');
const LIMIT = 1024 * 1024;
const EVENT = Object.freeze({ fixture: 'trusted-main-frame' });
const REQUEST_ID = 'fixture-command-0001';
let passed = 0, failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log('ok - ' + name); }
  catch (error) { failed++; console.error('not ok - ' + name + '\n' + error.stack); }
}
const rejected = (result, code) => {
  assert.equal(result?.ok, false, 'must not return successful/private response');
  assert.equal(result.error.code, code);
  assert.equal(typeof result.error.message, 'string');
  assert.equal(Object.hasOwn(result, 'data'), false);
};
const json = (body = { ok: true, data: { fixture: true } }, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(options = {}) {
  let trusted = true, access = true, sessionReads = 0;
  let session = { token: 'synthetic-team-access-token', generation: 1, baseUrl: 'https://api.crowelogic.com' };
  if (Object.hasOwn(options, 'session')) session = options.session;
  const calls = [];
  const host = createTeamHost({
    isTrustedSender: (event) => event === EVENT && trusted,
    canAccess: () => access,
    getSession: () => { sessionReads++; return options.getSession ? options.getSession(sessionReads, session) : session; },
    allowLocal: options.allowLocal || false, timeoutMs: options.timeoutMs || 15000,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return options.fetch ? options.fetch(url, init, calls.length) : json();
    },
  });
  return { host, calls, request: (action = 'farm.list', payload = {}, event = EVENT) => host.request(event, action, payload),
    revokeTrust: () => { trusted = false; }, revokeAccess: () => { access = false; },
    setSession: (value) => { session = value; }, session: () => session, sessionReads: () => sessionReads };
}
function streamed(parts, status = 200, headers = {}) {
  let index = 0, cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (index === parts.length) controller.close();
      else controller.enqueue(Buffer.from(parts[index++]));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { status, headers }), cancelled: () => cancelled, readCount: () => index };
}
function controlledBody() {
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  return { response: new Response(body, { status: 200 }),
    complete(value) { controller.enqueue(Buffer.from(JSON.stringify(value))); controller.close(); } };
}

(async () => {
  console.log('farm team host (offline synthetic security/failure fixtures)');
  await check('endpoint pins origin, HTTPS, path, credentials, query and fragment', () => {
    assert.equal(endpoint('https://api.crowelogic.com'), 'https://api.crowelogic.com/api/farm/commands');
    assert.equal(endpoint('https://API.CROWELOGIC.COM:443/'), 'https://api.crowelogic.com/api/farm/commands');
    for (const url of ['http://api.crowelogic.com', 'https://api.crowelogic.com.evil.invalid',
      'https://api.crowelogic.com@evil.invalid', 'https://evil.invalid@api.crowelogic.com',
      'https://api.crowelogic.com:8443', 'https://api.crowelogic.com.',
      'https://api.crowelogic.com/api/farm/commands', 'https://api.crowelogic.com?redirect=evil',
      'https://api.crowelogic.com#evil', 'https://sense.crowelogic.com', 'file:///tmp/farm', '', undefined]) {
      assert.throws(() => endpoint(url), undefined, String(url));
    }
  });
  await check('localhost exception requires trusted host flag and exact loopback HTTP origin', () => {
    for (const url of ['http://127.0.0.1:8900', 'http://[::1]:8900']) {
      assert.throws(() => endpoint(url, false));
      assert.equal(endpoint(url, true), url + '/api/farm/commands');
    }
    for (const url of ['http://localhost:8900', 'http://0.0.0.0:8900', 'http://10.0.0.1:8900',
      'http://127.0.0.1.evil.invalid:8900', 'https://127.0.0.1:8900', 'http://127.0.0.1:8900/path',
      'http://user:pass@127.0.0.1:8900']) assert.throws(() => endpoint(url, true), undefined, url);
  });
  await check('unapproved cloud endpoint never receives a token or dispatch', async () => {
    for (const baseUrl of ['https://evil.invalid', 'http://api.crowelogic.com', 'https://api.crowelogic.com.evil.invalid', 'http://127.0.0.1:8900']) {
      const f = fixture({ session: { token: 'synthetic-token', generation: 1, baseUrl } });
      rejected(await f.request('message.send', { requestId: REQUEST_ID }), 'UNAVAILABLE');
      assert.equal(f.calls.length, 0);
    }
  });
  await check('untrusted, wrong-event and wrong-edition requests do not read sessions or dispatch', async () => {
    const untrusted = fixture(); untrusted.revokeTrust();
    const denied = fixture(); denied.revokeAccess();
    for (const f of [untrusted, denied]) {
      rejected(await f.request(), 'UNAVAILABLE'); assert.equal(f.calls.length, 0); assert.equal(f.sessionReads(), 0);
    }
    const wrong = fixture(); rejected(await wrong.request('farm.list', {}, {}), 'UNAVAILABLE');
    assert.equal(wrong.calls.length, 0); assert.equal(wrong.sessionReads(), 0);
  });
  await check('unauthenticated requests fail before any network dispatch', async () => {
    for (const session of [undefined, null, {}, { token: '' }, { token: null }]) {
      const f = fixture({ session });
      rejected(await f.request(), 'AUTH_REQUIRED');
      rejected(await f.request('message.send', { requestId: REQUEST_ID }), 'AUTH_REQUIRED');
      assert.equal(f.calls.length, 0);
    }
  });
  await check('actions are closed and request IDs required for every mutating command', async () => {
    const f = fixture();
    for (const action of ['sql', 'snapshot', 'backup.restore', 'constructor', '__proto__', '', null]) rejected(await f.request(action), 'VALIDATION');
    for (const action of WRITES) {
      for (const requestId of [undefined, null, 123, '', 'short', 'x'.repeat(129), 'request with spaces', 'id/../../secret']) {
        rejected(await f.request(action, { requestId }), 'VALIDATION');
      }
    }
    assert.equal(f.calls.length, 0);
    for (const action of READS) assert.equal((await f.request(action)).ok, true, action);
    for (const action of WRITES) assert.equal((await f.request(action, { requestId: REQUEST_ID })).ok, true, action);
    assert.equal(f.calls.length, READS.size + WRITES.size);
  });
  await check('malformed/unserializable/oversized command bodies never dispatch', async () => {
    const f = fixture(), cycle = {}; cycle.self = cycle;
    for (const payload of [null, [], '', 3, true, cycle, { value: 1n }, { text: 'x'.repeat(LIMIT) }, { text: 'é'.repeat(LIMIT / 2) }]) {
      rejected(await f.request('farm.list', payload), 'VALIDATION');
    }
    assert.equal(f.calls.length, 0);
  });
  await check('serialized request byte limit accepts boundary and rejects one byte over', async () => {
    const f = fixture();
    const empty = JSON.stringify({ action: 'message.send', payload: { requestId: REQUEST_ID, content: '' } });
    const payload = { requestId: REQUEST_ID, content: 'x'.repeat(LIMIT - Buffer.byteLength(empty)) };
    assert.equal((await f.request('message.send', payload)).ok, true);
    assert.equal(Buffer.byteLength(f.calls[0].init.body), LIMIT);
    rejected(await f.request('message.send', { ...payload, content: payload.content + 'x' }), 'VALIDATION');
    assert.equal(f.calls.length, 1);
  });
  await check('POST is fixed-origin, authenticated, redirect-error and no-store; request body keeps identity', async () => {
    const f = fixture();
    const payload = Object.freeze({ requestId: REQUEST_ID, farmId: 'farm-fixture', content: 'Same command text', url: 'https://evil.invalid' });
    assert.equal((await f.request('message.send', payload)).ok, true);
    const { url, init } = f.calls[0];
    assert.equal(url, 'https://api.crowelogic.com/api/farm/commands');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-team-access-token');
    assert.equal(init.headers['Content-Type'], 'application/json'); assert.equal(init.headers.Accept, 'application/json');
    assert.deepEqual(JSON.parse(init.body), { action: 'message.send', payload });
    assert.ok(init.signal instanceof AbortSignal);
  });
  await check('ambiguous POST failure has no automatic retry and explicit retry keeps identical body', async () => {
    const f = fixture({ fetch: async (_url, _init, call) => {
      if (call === 1) throw new Error('Synthetic connection loss after acceptance');
      return json({ ok: true, data: { id: 'same-server-command', replayed: true } });
    } });
    const payload = { requestId: REQUEST_ID, conversationId: 'fixture-conversation', text: 'Immutable submitted text' };
    const first = await f.request('message.send', payload);
    rejected(first, 'WRITE_OUTCOME_UNKNOWN'); assert.match(first.error.message, /same request ID and content/);
    await tick(); assert.equal(f.calls.length, 1, 'must not issue automatic retry');
    const second = await f.request('message.send', payload); assert.equal(second.ok, true);
    assert.equal(f.calls.length, 2); assert.equal(f.calls[0].init.body, f.calls[1].init.body);
    assert.equal(JSON.parse(f.calls[1].init.body).payload.requestId, REQUEST_ID);
  });
  await check('read transport failure is unavailable and never retried', async () => {
    const f = fixture({ fetch: async () => { throw new Error('Synthetic offline'); } });
    rejected(await f.request('farm.list'), 'UNAVAILABLE'); await tick(); assert.equal(f.calls.length, 1);
  });
  await check('redirect rejection and 30x responses never follow another origin', async () => {
    for (const fetch of [async () => { throw new TypeError('Synthetic fetch redirect:error'); },
      async () => new Response('', { status: 302, headers: { location: 'https://evil.invalid' } }),
      async () => json({ ok: true, data: { wrong: true } }, 307, { location: 'https://evil.invalid' })]) {
      const f = fixture({ fetch }); rejected(await f.request('message.send', { requestId: REQUEST_ID }), 'WRITE_OUTCOME_UNKNOWN');
      assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.redirect, 'error');
    }
  });
  await check('already-followed redirect Response is not accepted as command success', async () => {
    const response = json({ ok: true, data: { wrongOrigin: true } });
    Object.defineProperty(response, 'redirected', { value: true });
    const f = fixture({ fetch: async () => response });
    rejected(await f.request('message.send', { requestId: REQUEST_ID }), 'WRITE_OUTCOME_UNKNOWN');
    assert.equal(f.calls.length, 1);
  });
  await check('5xx is uncertain even with explicit error; 401/404 have narrow safe classifications', async () => {
    for (const status of [500, 502, 503]) {
      const f = fixture({ fetch: async () => json({ ok: false, error: { code: 'INTERNAL', message: 'After possible commit' } }, status) });
      rejected(await f.request('document.approve', { requestId: REQUEST_ID }), 'WRITE_OUTCOME_UNKNOWN'); assert.equal(f.calls.length, 1);
    }
    for (const [status, code] of [[401, 'AUTH_REQUIRED'], [404, 'UNAVAILABLE']]) {
      const f = fixture({ fetch: async () => json({ error: 'not available' }, status) });
      rejected(await f.request('message.send', { requestId: REQUEST_ID }), code); assert.equal(f.calls.length, 1);
    }
  });
  await check('explicit bounded rejection is returned, untrusted error text/envelopes are not', async () => {
    for (const key of ['error', 'detail']) {
      const f = fixture({ fetch: async () => json({ [key]: { code: 'CONFLICT', message: 'Use the existing command.' } }, 409) });
      const result = await f.request('message.send', { requestId: REQUEST_ID }); rejected(result, 'CONFLICT');
      assert.equal(result.error.message, 'Use the existing command.');
    }
    for (const body of [{ error: { code: 'bad/slugg', message: 'private fixture path' } },
      { error: { code: 'VALIDATION', message: 'x'.repeat(501) } }, { error: { code: 'VALIDATION' } }, { detail: 'raw failure' }]) {
      const f = fixture({ fetch: async () => json(body, 400) });
      rejected(await f.request('message.send', { requestId: REQUEST_ID }), 'WRITE_OUTCOME_UNKNOWN');
    }
  });
  await check('malformed JSON, missing stream and invalid success envelopes remain uncertain', async () => {
    for (const make of [() => new Response('<html>error</html>', { status: 200 }), () => new Response(null, { status: 204 }),
      () => json(null), () => json([]), () => json({ ok: true }), () => json({ ok: 'true', data: {} }), () => json({ ok: false, data: {} })]) {
      const f = fixture({ fetch: async () => make() });
      rejected(await f.request('message.send', { requestId: REQUEST_ID }), 'WRITE_OUTCOME_UNKNOWN'); assert.equal(f.calls.length, 1);
    }
  });
  await check('successful JSON null data is a defined result rather than missing envelope', async () => {
    const f = fixture({ fetch: async () => json({ ok: true, data: null }) });
    assert.deepEqual(await f.request(), { ok: true, data: null });
  });
  await check('response byte bound applies to streamed chunks irrespective of Content-Length', async () => {
    for (const headers of [{}, { 'Content-Length': '1' }, { 'Content-Length': String(LIMIT * 2) }]) {
      const source = streamed(['x'.repeat(LIMIT), 'x', 'unread extra'], 200, headers);
      const f = fixture({ fetch: async () => source.response });
      rejected(await f.request('message.send', { requestId: REQUEST_ID }), 'WRITE_OUTCOME_UNKNOWN');
      assert.equal(source.cancelled(), true); assert.equal(source.readCount(), 2); assert.equal(f.calls.length, 1);
    }
  });
  await check('valid response at exact byte bound succeeds; UTF8 counts bytes not characters', async () => {
    const base = JSON.stringify({ ok: true, data: '' });
    const exact = JSON.stringify({ ok: true, data: 'x'.repeat(LIMIT - Buffer.byteLength(base)) });
    const source = streamed([exact.slice(0, 13), exact.slice(13)]);
    const f = fixture({ fetch: async () => source.response });
    assert.equal((await f.request()).ok, true);
    const wide = JSON.stringify({ ok: true, data: 'é'.repeat(LIMIT / 2) });
    assert.ok(wide.length < LIMIT); assert.ok(Buffer.byteLength(wide) > LIMIT);
    const g = fixture({ fetch: async () => new Response(wide) }); rejected(await g.request(), 'UNAVAILABLE');
  });
  await check('invalidation aborts all pending requests and late responses cannot publish private data', async () => {
    const replies = [deferred(), deferred()];
    const f = fixture({ fetch: (_url, _init, call) => replies[call - 1].promise });
    const read = f.request(), write = f.request('message.send', { requestId: REQUEST_ID });
    f.host.invalidate(); assert.equal(f.calls.length, 2);
    for (const { init } of f.calls) assert.equal(init.signal.aborted, true);
    replies[0].resolve(json({ ok: true, data: { privateOldAccount: true } })); replies[1].resolve(json());
    rejected(await read, 'UNAVAILABLE'); rejected(await write, 'WRITE_OUTCOME_UNKNOWN');
    await tick(); assert.equal(f.calls.length, 2);
  });
  await check('trust and edition access revoked during response body suppress returned data', async () => {
    for (const revoke of ['revokeTrust', 'revokeAccess']) {
      for (const action of ['farm.list', 'message.send']) {
        const body = controlledBody(), f = fixture({ fetch: async () => body.response });
        const pending = f.request(action, { requestId: REQUEST_ID }); await tick(); f[revoke]();
        body.complete({ ok: true, data: { privateOldFrame: true } });
        rejected(await pending, action === 'farm.list' ? 'UNAVAILABLE' : 'WRITE_OUTCOME_UNKNOWN'); assert.equal(f.calls.length, 1);
      }
    }
  });
  await check('account generation replaced during response body suppresses data and does not retry', async () => {
    const body = controlledBody(), f = fixture({ fetch: async () => body.response });
    const pending = f.request('message.send', { requestId: REQUEST_ID }); await tick();
    f.setSession({ ...f.session(), generation: 2, token: 'synthetic-other-account' });
    body.complete({ ok: true, data: { privateOldAccount: true } });
    rejected(await pending, 'WRITE_OUTCOME_UNKNOWN'); assert.equal(f.calls.length, 1);
  });
  await check('generation is captured as a value even if session provider mutates its object', async () => {
    const body = controlledBody(), f = fixture({ fetch: async () => body.response });
    const pending = f.request(); await tick(); f.session().generation++;
    body.complete({ ok: true, data: { privateOldAccount: true } });
    rejected(await pending, 'UNAVAILABLE'); assert.equal(f.calls.length, 1);
  });
  await check('session change before dispatch returns AUTH_CHANGED and never calls fetch', async () => {
    const f = fixture({ getSession: (reads, session) => reads === 1 ? session : { ...session, generation: 2 } });
    rejected(await f.request('message.send', { requestId: REQUEST_ID }), 'AUTH_CHANGED'); assert.equal(f.calls.length, 0);
  });
  await check('logout during response suppresses private data even without separate invalidate call', async () => {
    const reply = deferred(), f = fixture({ fetch: () => reply.promise });
    const pending = f.request(); f.setSession(null); reply.resolve(json({ ok: true, data: { privateOldAccount: true } }));
    rejected(await pending, 'UNAVAILABLE'); assert.equal(f.calls.length, 1);
  });
  await check('abort-aware timeout yields uncertain POST without automatic retry', async () => {
    const f = fixture({ timeoutMs: 5, fetch: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('Synthetic request abort')), { once: true });
    }) });
    const keepAlive = wait(30), pending = f.request('message.send', { requestId: REQUEST_ID });
    rejected(await pending, 'WRITE_OUTCOME_UNKNOWN'); await keepAlive;
    assert.equal(f.calls[0].init.signal.aborted, true); assert.equal(f.calls.length, 1);
  });
  await check('deadline-expired Response cannot report success even when transport ignores abort', async () => {
    const reply = deferred(), f = fixture({ timeoutMs: 5, fetch: () => reply.promise });
    const pending = f.request('message.send', { requestId: REQUEST_ID });
    await wait(30); assert.equal(f.calls[0].init.signal.aborted, true);
    reply.resolve(json({ ok: true, data: { completedTooLate: true } }));
    rejected(await pending, 'WRITE_OUTCOME_UNKNOWN'); assert.equal(f.calls.length, 1);
  });
  await check('invalidate does not poison a subsequent independently authorized request', async () => {
    const old = deferred();
    const f = fixture({ fetch: (_url, _init, call) => call === 1 ? old.promise : json({ ok: true, data: { generation: 2 } }) });
    const first = f.request(); f.host.invalidate(); f.setSession({ ...f.session(), generation: 2 });
    assert.deepEqual(await f.request(), { ok: true, data: { generation: 2 } });
    old.resolve(json({ ok: true, data: { generation: 1 } })); rejected(await first, 'UNAVAILABLE');
    assert.equal(f.calls.length, 2);
  });
  console.log(`\nteam-host: ${passed} passed, ${failed} failed (${process.version}); synthetic sessions and in-memory fetch responses only`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
