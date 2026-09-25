#!/usr/bin/env node
'use strict';

// Synthetic main-policy and actual council-host checks. No Electron, filesystem
// mutation, remote inference, or profile access is needed for these boundaries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveEdition } = require('../app-edition');
const { installCouncilHost } = require('../rooms/council-host');
const R = require('../rooms/engine');
const G = require('../rooms/registry');
const C = require('../rooms/council');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const plugins = JSON.parse(fs.readFileSync(path.join(__dirname, '../plugins.builtin.json'), 'utf8'));
const manifest = Array.isArray(plugins) ? plugins : plugins.plugins;
const pluginBody = source.match(/function pluginAllowed\(p\) \{[\s\S]*?\n\}/)[0];
const roomPolicy = source.match(/const GROWER_ROOM_AGENTS = new Set\([^\n]+\);\nfunction roomAgentAllowed[^\n]+/)[0];
const hostWiring = source.match(/const councilHost = require\("\.\/rooms\/council-host"\)\.installCouncilHost\(\{[\s\S]*?\n\}\);/)[0];
const canActivateBody = hostWiring.match(/canActivate: (room => [^\n]+),/)[1];
function policy(id) {
  return vm.runInNewContext(`${pluginBody}\n${roomPolicy}\n({pluginAllowed, canActivate: ${canActivateBody}})`, {
    EDITION: resolveEdition({ metadata: { croweEdition: id } }),
  });
}
const spec = { goal: 'Synthetic advisory result', mode: 'advisory', quorum: 2, maxSteps: 1, maxCalls: 8, minutes: 1 };
const growers = ['cultivation-intelligence', 'mycology-research', 'facility-design'];
function fixture(canActivate, agentIds = growers) {
  const handlers = {}, room = R.createRoom({ agentIds });
  room.agents.forEach((a, i) => { a.model = ['a', 'b', 'c'][i]; });
  let saves = 0, queues = 0, calls = 0, queued, finish;
  const done = new Promise(resolve => { finish = resolve; });
  installCouncilHost({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    loadRoom: () => room, save: () => { saves++; }, changed: () => {}, busy: () => false,
    canActivate,
    queue: (_id, fn) => { queues++; queued = fn; return done; },
    config: () => ({ cwd: '/synthetic', autonomy: 'readonly', model: 'a', token: 'fixture-only' }),
    catalog: () => ['a', 'b', 'c'].map(id => ({ id, engine: 'engine-' + id, available: true })),
    chat: async (messages, _tools, _retry, _signal, model) => {
      calls++;
      const system = messages[0].content;
      const reply = system.startsWith('Propose') ? { kind: 'complete', summary: 'Synthetic advisory evidence.', changes: [] }
        : system.startsWith('Act as a safety') ? { decision: 'allow', reason: 'No file changes.' }
          : { decision: 'approve', reason: 'Matches synthetic evidence.' };
      return { model, content: JSON.stringify(reply) };
    },
  });
  return {
    room, start: () => handlers['crowe:rooms:council-start'](null, { id: room.id, spec }),
    state: () => handlers['crowe:rooms:council-state'](null, { id: room.id }),
    stop: () => handlers['crowe:rooms:council-stop'](null, { id: room.id, revoke: true }),
    async run() { try { return await queued(); } finally { finish(); } },
    get saves() { return saves; }, get queues() { return queues; }, get calls() { return calls; },
  };
}
let checks = 0;
async function test(name, fn) { await fn(); checks++; console.log('ok - ' + name); }
(async () => {
  await test('shared skills stay available while grower-only plugins require Mycology', () => {
    for (const id of ['desktop', 'developers']) {
      const p = policy(id);
      assert.equal(p.pluginAllowed(manifest.find(x => x.id === 'crowe-skills')), true);
      assert.equal(p.pluginAllowed(manifest.find(x => x.id === 'crowe-sense')), false);
      assert.equal(p.pluginAllowed({ spaces: ['farm', 'cultivation'] }), false);
      assert.equal(resolveEdition({ metadata: { croweEdition: id } }).allowedSpaces.includes('messenger'), false);
      for (const spaces of [[], ['chat'], ['projects'], ['chat', 'farm']]) assert.equal(p.pluginAllowed({ spaces }), true);
    }
    assert.equal(policy('mycology').pluginAllowed(manifest.find(x => x.id === 'crowe-sense')), true);
    assert.equal(policy('mycology').pluginAllowed({ spaces: ['messenger'] }), true);
  });
  await test('main wires edition predicate to council activation but not state or stop', async () => {
    for (const edition of ['desktop', 'developers']) {
      const h = fixture(policy(edition).canActivate);
      h.room.council = C.create(C.grant(spec, h.room.agents.map(a => ({ id: a.agentId, model: a.model, engine: a.model }))));
      h.room.councilHistory = [{ preserved: true }];
      const before = JSON.stringify(h.room);
      const result = await h.start();
      assert.match(result.error, /Mycology/);
      assert.equal(JSON.stringify(h.room), before);
      assert.equal(h.saves, 0); assert.equal(h.queues, 0); assert.equal(h.calls, 0);
      assert.deepEqual((await h.state()).history, [{ preserved: true }]);
      assert.equal((await h.stop()).council.status, 'revoked');
      assert.equal(h.saves, 1);
    }
  });
  await test('allowed ordinary Desktop and Mycology grower councils still complete', async () => {
    const models = ['a', 'b', 'c'].map(id => G.modelAgent(id).id);
    for (const [edition, agents] of [['desktop', models], ['mycology', growers]]) {
      const h = fixture(policy(edition).canActivate, agents);
      assert.ok((await h.start()).council);
      await h.run();
      assert.equal(h.room.council.status, 'completed');
      assert.equal(h.calls, 5);
    }
  });
  await test('activation is rechecked after queueing before any inference', async () => {
    let permitted = true;
    const h = fixture(() => permitted);
    assert.ok((await h.start()).council);
    permitted = false;
    await h.run();
    assert.equal(h.room.council.status, 'escalated');
    assert.match(h.room.council.reason, /Mycology/);
    assert.equal(h.calls, 0);
    assert.equal(h.room.messages.filter(m => m.kind === 'council').length, 0);
  });
  await test('inference and execution retain independent activation checks', async () => {
    // Capture actual host dependencies while replacing only orchestration; this
    // reaches the individual gates without requiring a model to manufacture votes.
    const original = C.run; let deps;
    try {
      C.run = async (_state, value) => { deps = value; };
      let permitted = true;
      const h = fixture(() => permitted);
      await h.start(); await h.run(); permitted = false;
      await assert.rejects(deps.ask({ model: 'a' }, 'propose', {}), /Mycology/);
      await assert.rejects(deps.execute({ summary: 'Not approved', changes: [] }, {}, {}, () => true), /Mycology/);
      assert.equal(h.calls, 0);
      assert.equal(h.room.messages.filter(m => m.kind === 'council').length, 0);
    } finally { C.run = original; }
  });
  console.log(`edition-activation: ${checks} groups passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
