'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { readCustomerRoster, validateCustomerRoster } = require('./sync-agent-registry');
const { validCustomerRoster } = require('../rooms/registry');
const root = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-customer-roster-'));
const roster = readCustomerRoster();
let checks = 0;
function check(fn) { fn(); checks++; }
function changed(fn) { const copy = structuredClone(roster); fn(copy); return copy; }
function runtime(input) {
  const module = { exports: {} };
  const reads = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, 'rooms/registry.js'), 'utf8'), {
    module, exports: module.exports, __dirname: '/fixture/rooms',
    require(name) {
      if (name === 'path') return path;
      if (name === 'fs') return { readFileSync(file) {
        reads.push(file);
        assert.equal(path.basename(file), 'agents.customer.json');
        if (input instanceof Error) throw input;
        return input;
      } };
      throw new Error('Unexpected module');
    },
  });
  return { agents: module.exports.listAgents(), reads };
}
try {
  check(() => assert.equal(roster.agents.length, 20));
  check(() => assert.equal(validCustomerRoster(roster), true));
  for (const mutate of [
    r => { r.audience = 'internal'; },
    r => { r.privateContext = 'unexpected'; },
    r => { r.agents.push(r.agents[0]); },
    r => { r.agents[0].autonomyCeiling = 'execute'; },
    r => { r.agents[0].authority = '__proto__'; },
    r => { r.agents[0].tools = ['terminal', 'terminal']; },
    r => { r.agents.find(a => a.authority === 'advisory').tools = ['terminal']; },
    r => { r.agents[0].systemPrompt = ''; },
  ]) check(() => assert.equal(validCustomerRoster(changed(mutate)), false));
  check(() => assert.throws(() => validateCustomerRoster(changed(r => { r.agents[0].domain = 'other'; }))));
  check(() => assert.throws(() => validateCustomerRoster(changed(r => { r.agents[0].systemPrompt += ' Read SYSTEM_PROMPT.md'; })), /local-or-internal-path/));
  check(() => assert.equal(runtime(JSON.stringify(roster)).agents.length, 20));
  for (const input of [new Error('absent'), '{', JSON.stringify({ audience: 'internal', agents: roster.agents })]) {
    check(() => {
      const result = runtime(input);
      assert.equal(result.agents.length, 0);
      assert.equal(result.reads.length, 1);
    });
  }
  // All destructive/freshness probes run in our own isolated build tree.
  for (const file of ['scripts/build-rooms-web.js', 'scripts/sync-agent-registry.js',
    'rooms/registry.js', 'rooms/engine.js', 'rooms/council.js', 'rooms/agents.customer.json',
    'mobile/scripts/build-www.js', 'mobile/package.json']) {
    const dest = path.join(temp, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, file), dest);
  }
  fs.mkdirSync(path.join(temp, 'renderer'));
  fs.mkdirSync(path.join(temp, 'mobile/www'));
  const sentinel = path.join(temp, 'mobile/www/preserve.txt');
  fs.writeFileSync(sentinel, 'owned test sentinel');
  const build = require(path.join(temp, 'scripts/build-rooms-web.js'));
  check(() => assert.throws(() => build.assertFreshRoomsBundle(), /stale/));
  fs.writeFileSync(path.join(temp, 'renderer/rooms-web.js'), build.createRoomsBundle().bundle);
  check(() => build.assertFreshRoomsBundle());
  const updated = changed(r => { r.agents[0].role += ' Reviewed.'; });
  fs.writeFileSync(path.join(temp, 'rooms/agents.customer.json'), JSON.stringify(updated));
  check(() => assert.throws(() => build.assertFreshRoomsBundle(), /stale/));
  check(() => {
    const result = spawnSync(process.execPath, [path.join(temp, 'mobile/scripts/build-www.js')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Customer rooms bundle is stale/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'owned test sentinel');
  });
  check(() => {
    const result = spawnSync(process.execPath, [path.join(temp, 'scripts/sync-agent-registry.js'), '--source', 'private'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /imports are disabled/);
  });
  console.log(`Customer roster: ${checks} isolated checks passed`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
