#!/usr/bin/env node
'use strict';

// Synthetic local Rooms policy tests. Only in-memory records and mock inference;
// no profile reads, network, credentials, generated payloads, or native builds.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const E = require('../rooms/engine');
const G = require('../rooms/registry');
const C = require('../rooms/council');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'renderer/rooms-local.js'), 'utf8');
const growers = ['cultivation-intelligence', 'mycology-research', 'facility-design'];
const models = ['synthetic-alpha', 'synthetic-beta', 'synthetic-gamma'];
const modelAllowed = model => !String(model).includes('grower');
const policy = () => ({ grow: false, modelAllowed });
const spec = { goal: 'Synthetic advisory result', mode: 'advisory', quorum: 2, maxSteps: 1, maxCalls: 8, minutes: 1 };
const immediate = () => new Promise(resolve => setImmediate(resolve));
const denied = result => assert.match(result.error, /Mycology/);

function room(agentIds = growers) {
  const result = E.createRoom({ agentIds, title: 'Synthetic historical room' });
  result.agents.forEach((a, i) => { a.model = models[i % models.length]; });
  E.pushMessage(result, { author: result.agents[0].agentId, kind: 'reply', content: 'Synthetic preserved history', ask: E.normalizeAsk({ question: 'Proceed?', options: ['Yes', 'No'] }) });
  E.addRoutine(result, { text: 'Synthetic scheduled task', every: 'minutes', minutes: 5 }, Date.now() - 1000);
  result.routines[0].nextRunAt = Date.now() - 500;
  result.councilHistory = [{ synthetic: 'preserved council history' }];
  return result;
}
function fixture({ records = [], activation = policy(), omitPolicy = false, engine = {}, council = {}, catalog, emit } = {}) {
  let raw = JSON.stringify(records), writes = 0, claims = 0;
  const calls = [], ticks = [], events = [];
  const window = { CroweRooms: { registry: G, engine: { ...E, ...engine, claimRoutine(...args) { claims++; return E.claimRoutine(...args); } } }, CroweCouncil: { ...C, ...council } };
  vm.runInNewContext(source, { window, AbortController, setTimeout, clearTimeout, setInterval(fn) { ticks.push(fn); } });
  const api = window.CroweLocalRooms.create({
    read: async () => JSON.parse(raw),
    write: async value => { writes++; raw = JSON.stringify(value); },
    catalog: catalog || (async () => [...models, 'synthetic-grower'].map(id => ({ id, engine: 'engine-' + id, available: true }))),
    emit: event => { events.push(event); emit?.(event); },
    chat: async (model, messages) => {
      calls.push({ model, messages });
      const system = messages[0].content;
      const reply = system.startsWith('Propose') ? { kind: 'complete', summary: 'Synthetic advisory evidence.', changes: [] }
        : system.startsWith('Act as a safety') ? { decision: 'allow', reason: 'No file changes.' }
          : system.startsWith('Independently') ? { decision: 'approve', reason: 'Matches synthetic evidence.' } : null;
      return { model, content: reply ? JSON.stringify(reply) : 'Synthetic response' };
    },
  }, ...(omitPolicy ? [] : [activation]));
  return { api, window, calls, events, tick: () => ticks[0](), get raw() { return raw; }, get writes() { return writes; }, get claims() { return claims; } };
}
async function settleCouncil(h, id) {
  for (let i = 0; i < 30; i++) {
    await immediate();
    const state = (await h.api.councilState(id)).council;
    if (['completed', 'escalated', 'stopped', 'revoked'].includes(state?.status)) return state;
  }
  throw new Error('Synthetic council did not settle');
}
let checks = 0;
async function test(name, fn) { await fn(); checks++; console.log('ok - ' + name); }
(async () => {
  await test('specialist rule matches main.js and filters resolved template agents', async () => {
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const declaration = main.match(/const GROWER_ROOM_AGENTS = new Set\((\[[^\n]+\])\);/);
    assert.ok(declaration);
    assert.deepEqual(JSON.parse(declaration[1]), growers);
    const h = fixture();
    const listing = await h.api.agents();
    growers.forEach(id => assert.ok(!listing.agents.some(a => a.id === id)));
    assert.ok(!listing.agents.some(a => a.model === 'synthetic-grower'));
    assert.ok(!listing.templates.some(t => t.id === 'grow-diagnosis'));
    assert.ok(listing.agents.some(a => a.id === 'operator'));
    assert.ok(listing.templates.some(t => t.id === 'ship-it'));
    assert.equal(h.writes, 0);
  });
  await test('hidden template, specialist and encoded grower model creation are denied without writes', async () => {
    const h = fixture();
    for (const opts of [
      { template: 'grow-diagnosis' }, ...growers.map(id => ({ agentIds: [id, 'operator'] })),
      { agentIds: [G.modelAgent('synthetic-grower').id] }, { agentIds: ['operator'], defaultAgent: growers[0] },
    ]) denied(await h.api.create(opts));
    assert.equal(h.writes, 0); assert.equal(h.calls.length, 0);
  });
  await test('general room join and model assignment reject growers, even across autonomy settings', async () => {
    for (const tier of ['plan', 'readonly', 'edit', 'execute']) {
      const ordinary = room(['operator']); ordinary.tier = tier;
      const h = fixture({ records: [E.toSession(ordinary)] });
      const before = h.raw;
      for (const id of [...growers, G.modelAgent('synthetic-grower').id]) denied(await h.api.join(ordinary.id, id));
      denied(await h.api.setAgentModel(ordinary.id, 'operator', 'synthetic-grower'));
      assert.equal(h.raw, before); assert.equal(h.writes, 0); assert.equal(h.calls.length, 0);
      assert.ok((await h.api.setAgentModel(ordinary.id, 'operator', models[0])).room);
      assert.ok((await h.api.say(ordinary.id, 'An ordinary question about mushrooms is not a topic ban.')).ran[0].ok);
      assert.equal(h.calls.length, 1);
    }
  });
  await test('all restored grower activation paths refuse before mutation while history stays readable', async () => {
    for (const legacy of [room(), room([G.modelAgent('synthetic-grower').id]), room(['operator'])]) {
      if (legacy.agents[0].agentId === 'operator') legacy.agents[0].model = 'synthetic-grower';
      const general = room(['operator']);
      const h = fixture({ records: [E.toSession(legacy), E.toSession(general)] });
      const before = h.raw, rt = legacy.routines[0].id, msg = legacy.messages[0].id;
      const actions = [
        () => h.api.join(legacy.id, 'email'),
        () => h.api.setAgentModel(legacy.id, legacy.agents[0].agentId, models[0]),
        () => h.api.say(legacy.id, 'Synthetic new message'), () => h.api.critique(legacy.id), () => h.api.revise(legacy.id),
        () => h.api.answer(legacy.id, msg, 'a'),
        () => h.api.forward(legacy.id, msg, general.id),
        () => h.api.forward(general.id, general.messages[0].id, legacy.id),
        () => h.api.routineAdd(legacy.id, { text: 'No', every: 'minutes' }),
        () => h.api.routineUpdate(legacy.id, rt, { enabled: true }),
        () => h.api.routineRun(legacy.id, rt), () => h.api.councilStart(legacy.id, spec),
      ];
      for (const action of actions) denied(await action());
      assert.equal(h.raw, before); assert.equal(h.writes, 0); assert.equal(h.calls.length, 0);
      assert.equal((await h.api.list()).length, 2);
      assert.equal((await h.api.load(legacy.id)).messages[0].content, legacy.messages[0].content);
      assert.deepEqual((await h.api.councilState(legacy.id)).history, legacy.councilHistory);
      assert.equal(h.raw, before);
    }
  });
  await test('denied schedules skip before claim/save, including removed grower targets', async () => {
    const legacy = room();
    const pinned = room(['operator']); pinned.agents[0].model = 'synthetic-grower';
    const removed = room(['operator']); removed.routines[0].agentId = growers[0];
    const h = fixture({ records: [legacy, pinned, removed].map(E.toSession) });
    const before = h.raw;
    await h.tick(); await h.tick();
    assert.equal(h.raw, before); assert.equal(h.claims, 0); assert.equal(h.writes, 0); assert.equal(h.calls.length, 0);
    denied(await h.api.routineRun(removed.id, removed.routines[0].id));
    assert.equal(h.raw, before);
  });
  await test('allowed scheduled work does not mutate a denied room or a removed grower routine', async () => {
    const legacy = room(); const general = room(['operator']);
    const dormant = { ...general.routines[0], id: 'synthetic-removed', agentId: growers[0] };
    general.routines.push(dormant);
    const savedLegacy = E.toSession(legacy);
    const h = fixture({ records: [savedLegacy, E.toSession(general)] });
    await h.tick();
    assert.equal(h.claims, 1); assert.equal(h.calls.length, 1);
    assert.deepEqual(JSON.parse(h.raw).find(r => r.id === legacy.id), savedLegacy);
    assert.deepEqual((await h.api.load(general.id)).room.routines.find(r => r.id === dormant.id), dormant);
  });
  await test('legacy council stop, read, routine pause and stopAll remain available', async () => {
    const legacy = room();
    legacy.council = C.create(C.grant(spec, legacy.agents.map(a => ({ id: a.agentId, model: a.model, engine: a.model }))));
    const h = fixture({ records: [E.toSession(legacy)] });
    assert.equal((await h.api.markRead(legacy.id)).unread, 0);
    assert.equal((await h.api.routineUpdate(legacy.id, legacy.routines[0].id, { enabled: false })).routine.enabled, false);
    assert.equal((await h.api.councilStop(legacy.id, true)).council.status, 'revoked');
    assert.deepEqual((await h.api.councilState(legacy.id)).history, legacy.councilHistory);
    h.window.CroweLocalRooms.stopAll();
    assert.equal(h.calls.length, 0);
  });
  await test('options are captured and omitted policy keeps grower defaults unchanged', async () => {
    const mutable = policy(); const restricted = fixture({ activation: mutable });
    mutable.grow = true; mutable.modelAllowed = () => true;
    denied(await restricted.api.create({ template: 'grow-diagnosis' }));
    denied(await restricted.api.create({ agentIds: [G.modelAgent('synthetic-grower').id] }));
    for (const options of [{ omitPolicy: true }, { activation: { grow: true } }]) {
      const h = fixture(options);
      assert.ok((await h.api.agents()).templates.some(t => t.id === 'grow-diagnosis'));
      const created = await h.api.create({ template: 'grow-diagnosis' });
      assert.ok(created.room);
      const id = created.room.id;
      assert.ok((await h.api.setAgentModel(id, growers[0], 'synthetic-grower')).room);
      assert.ok((await h.api.say(id, 'Synthetic growing task')).ran[0].ok);
      assert.equal(h.calls.length, 1);
    }
  });
  await test('general and unrestricted grower councils still complete', async () => {
    for (const [ids, activation] of [[['operator', 'email', 'revenue'], policy()], [growers, null]]) {
      const r = room(ids); const h = fixture({ records: [E.toSession(r)], activation });
      assert.ok((await h.api.councilStart(r.id, spec)).council);
      assert.equal((await settleCouncil(h, r.id)).status, 'completed');
      assert.equal(h.calls.length, 5);
    }
  });
  await test('council rechecks after catalog await and at each protocol dispatch', async () => {
    const r = room(['operator', 'email', 'revenue']); let allowed = true;
    const activation = { grow: false, modelAllowed: () => allowed };
    const waiting = fixture({ records: [E.toSession(r)], activation, catalog: async () => { allowed = false; return models.map(id => ({ id, available: true })); } });
    denied(await waiting.api.councilStart(r.id, spec));
    assert.equal(waiting.writes, 0); assert.equal(waiting.calls.length, 0);
    allowed = true; let deps;
    const captured = fixture({ records: [E.toSession(r)], activation, council: { run: async (_state, value) => { deps = value; } } });
    assert.ok((await captured.api.councilStart(r.id, spec)).council);
    await immediate(); assert.ok(deps); allowed = false;
    await assert.rejects(deps.authorized(), /Mycology/);
    await assert.rejects(deps.ask({ id: 'operator', model: models[0] }, 'propose', {}), /Mycology/);
    await assert.rejects(deps.execute({ summary: 'No dispatch' }, {}, {}, () => true), /Mycology/);
    assert.equal(captured.calls.length, 0);
    assert.equal((await captured.api.load(r.id)).messages.filter(m => m.kind === 'council').length, 0);
  });
  await test('queued room activation is checked after waiting, before engine mutation', async () => {
    const r = room(['operator']); let allowed = true, release;
    const pending = new Promise(resolve => { release = resolve; });
    const h = fixture({ records: [E.toSession(r)], activation: { grow: false, modelAllowed: () => allowed },
      engine: { react: async () => { await pending; return {}; } },
    });
    const first = h.api.react(r.id, r.messages[0].id, 'noted');
    const second = h.api.say(r.id, 'Must never enter the transcript');
    await immediate(); allowed = false; release();
    await first; const before = h.raw, writes = h.writes;
    denied(await second);
    assert.equal(h.raw, before); assert.equal(h.writes, writes); assert.equal(h.calls.length, 0);
  });
  await test('runner checks effective target independently and rechecks before chat', async () => {
    const r = room(['operator']); let allowed = true; let run;
    const h = fixture({ records: [E.toSession(r)], activation: { grow: false, modelAllowed: id => allowed && modelAllowed(id) },
      engine: { speak: async (_room, _text, deps) => { run = deps.runAgent; return {}; } },
      emit: () => { allowed = false; },
    });
    await h.api.say(r.id, 'Capture synthetic runner');
    denied(await run({ agentId: growers[0], model: models[0], messages: [] }));
    denied(await run({ agentId: 'operator', model: 'synthetic-grower', messages: [] }));
    denied(await run({ agentId: 'operator', model: models[0], messages: [] }));
    assert.equal(h.calls.length, 0);
  });
  console.log(`mobile-rooms-policy: ${checks} groups passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
