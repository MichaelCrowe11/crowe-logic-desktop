'use strict';

// Offline config contract only. Never installs, builds, dispatches or uploads.
// Uses the existing locked js-yaml and current Node, not a downloaded runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, '.github/workflows/mycology-candidate.yml'), 'utf8');
const workflow = yaml.load(source);
const job = workflow.jobs.candidate;
const steps = job.steps;
const lines = (text) => text.trim().split('\n');
const syntheticTests = [
  'test-mycology-candidate', 'test-customer-roster', 'test-audit-customer-payload',
  'test-profile-auth', 'test-app-edition', 'test-edition-bootstrap', 'test-edition-activation',
  'test-grow-transfer', 'test-transfer-host', 'test-farm', 'test-farm-service',
  'test-farm-host', 'test-farm-retry', 'test-farm-packaging', 'test-vision',
  'test-release-matrix', 'test-preflight-release',
];

test('only manual dispatch, read permission and one bounded hosted Linux job', () => {
  assert.deepEqual(Object.keys(workflow).sort(), ['concurrency', 'jobs', 'name', 'on', 'permissions']);
  assert.deepEqual(workflow.on, { workflow_dispatch: null });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['candidate']);
  assert.deepEqual(Object.keys(job).sort(), ['defaults', 'env', 'runs-on', 'steps', 'timeout-minutes']);
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(job['timeout-minutes'], 45);
  assert.deepEqual(job.defaults, { run: { shell: 'bash' } });
  assert.deepEqual(job.env, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(steps.length, 10);
  for (const step of steps) {
    assert.equal(Boolean(step.run), !step.uses, 'exactly one of run/uses');
    assert.equal(step['continue-on-error'], undefined);
    assert.equal(step.timeout, undefined);
    assert.ok(Object.keys(step).every(key => ['name', 'env', 'run', 'uses', 'with', 'if'].includes(key)));
    if (step !== steps[9]) assert.equal(step.if, undefined, 'gates cannot be conditionally skipped');
    if (step !== steps[0]) assert.equal(step.env, undefined, 'no unreviewed step environment');
  }
  assert.doesNotMatch(JSON.stringify(workflow), /secrets\.|github\.token|always\(\)|continue-on-error|--no-sandbox/);
});

test('visibility guard is first and fails closed before any action or dependency run', () => {
  assert.deepEqual(steps[0].env, {
    REPOSITORY_PRIVATE: '${{ github.event.repository.private }}',
    EVENT_NAME: '${{ github.event_name }}',
  });
  for (const visibility of ['true', 'false', '', 'null']) {
    for (const event of ['workflow_dispatch', 'push', 'pull_request', '']) {
      const result = spawnSync('bash', ['-c', steps[0].run], {
        env: { PATH: process.env.PATH, REPOSITORY_PRIVATE: visibility, EVENT_NAME: event }, encoding: 'utf8',
      });
      assert.ifError(result.error);
      assert.equal(result.status === 0, visibility === 'true' && event === 'workflow_dispatch');
    }
  }
});

test('release-workflow action pins, no persisted checkout credential or dependency cache', () => {
  assert.equal(steps[1].uses, 'actions/checkout@v4');
  assert.deepEqual(steps[1].with, { 'persist-credentials': false, 'fetch-depth': 1, submodules: false, lfs: false });
  assert.equal(steps[2].uses, 'actions/setup-node@v4');
  assert.deepEqual(steps[2].with, { 'node-version': 22 });
  assert.equal(steps[3].run, 'npm ci');
  assert.deepEqual(steps.filter(step => step.uses).map(step => step.uses), [
    'actions/checkout@v4', 'actions/setup-node@v4', 'actions/upload-artifact@v4',
  ]);
});

test('targeted synthetic commands replace broad or live suites', () => {
  assert.deepEqual(lines(steps[4].run), ['set -euo pipefail', ...syntheticTests.map(name => `node scripts/${name}.js`)]);
  for (const name of syntheticTests) assert.ok(fs.statSync(path.join(root, `scripts/${name}.js`)).isFile());
});

test('explicit edition, never publish, actual ASAR and strict full candidate matrix precede staging', () => {
  assert.deepEqual(lines(steps[5].run), [
    'set -euo pipefail', 'test ! -e release-mycology',
    './node_modules/.bin/electron-builder --config electron-builder.mycology.js --linux AppImage deb --x64 --publish never',
  ]);
  assert.deepEqual(lines(steps[6].run), [
    'set -euo pipefail',
    'node scripts/audit-customer-payload.js desktop release-mycology/linux-unpacked/resources/app.asar mycology > "$RUNNER_TEMP/mycology-payload-audit.json"',
  ]);
  assert.equal(steps[7].run, 'node scripts/preflight-release.js --config electron-builder.mycology.js --strict --matrix linux:x64:AppImage+deb');
  const config = require('../electron-builder.mycology');
  assert.equal(config.directories.output, 'release-mycology');
  assert.equal(config.extraMetadata.croweEdition, 'mycology');
  assert.equal(config.afterPack, 'build/fuses.js');
  assert.deepEqual(config.linux.target, ['AppImage', 'deb']);
});

const stageMatch = /^set -euo pipefail\nnode <<'NODE'\n([\s\S]+)\nNODE\n?$/.exec(steps[8].run);
assert.ok(stageMatch, 'staging must be a single bounded Node heredoc');
const stage = new vm.Script(stageMatch[1]);
function stageFixture(mutate = () => {}) {
  const version = require('../package.json').version;
  const bytes = Buffer.from('synthetic installer bytes; not an application');
  const files = ['AppImage', 'deb'].map(type => ({
    url: `CroweLogic-mycology-${version}-x64.${type}`,
    size: bytes.length,
    sha512: crypto.createHash('sha512').update(bytes).digest('base64'),
  }));
  const fixture = { feed: { version, files }, symlink: false, stale: false, corruptCopy: false, copies: new Map() };
  mutate(fixture);
  // Execute the actual staging code with synthetic in-memory I/O, never installers.
  const fakeFs = {
    constants: fs.constants,
    existsSync: target => target === 'mycology-candidate-artifacts' && fixture.stale,
    mkdirSync: target => assert.equal(target, 'mycology-candidate-artifacts'),
    lstatSync: target => {
      assert.ok(files.some(item => target === `release-mycology/${item.url}`));
      return { isFile: () => !fixture.symlink, isSymbolicLink: () => fixture.symlink };
    },
    copyFileSync: (from, to, flag) => {
      assert.equal(flag, fs.constants.COPYFILE_EXCL);
      assert.ok(files.some(item => from === `release-mycology/${item.url}` && to === `mycology-candidate-artifacts/${item.url}`));
      fixture.copies.set(to, fixture.corruptCopy ? Buffer.from('changed') : bytes);
    },
    readFileSync: target => target === 'release-mycology/mycology-linux.yml'
      ? yaml.dump(fixture.feed) : fixture.copies.get(target),
  };
  stage.runInNewContext({
    require(name) {
      if (name === 'node:fs') return fakeFs;
      if (name === './package.json') return { version };
      if (name === './scripts/release-matrix') return require('./release-matrix');
      if (['node:path', 'node:assert/strict', 'node:crypto', 'js-yaml'].includes(name)) return require(name);
      throw new Error('Unexpected staging module');
    },
  });
  return fixture;
}

test('staging copies only exact feed-listed installers and rejects incomplete, stale or altered data', () => {
  assert.equal(stageFixture().copies.size, 2);
  for (const mutate of [
    f => { f.feed.files.pop(); },
    f => { f.feed.files.push({ ...f.feed.files[0] }); },
    f => { f.feed.files[0].url = '../outside.AppImage'; },
    f => { f.feed.files[0].size++; },
    f => { f.feed.files[0].sha512 = crypto.createHash('sha512').update('other').digest('base64'); },
    f => { f.symlink = true; },
    f => { f.stale = true; },
    f => { f.corruptCopy = true; },
  ]) assert.throws(() => stageFixture(mutate));
});

test('only success-path private short-lived installer upload; no feed or audit upload', () => {
  assert.equal(steps[9].if, '${{ success() && github.event.repository.private == true }}');
  assert.equal(steps[9].uses, 'actions/upload-artifact@v4');
  assert.deepEqual(steps[9].with, {
    name: 'mycology-linux-x64-candidate-${{ github.run_id }}-${{ github.run_attempt }}',
    path: 'mycology-candidate-artifacts/', 'if-no-files-found': 'error',
    'include-hidden-files': false, 'retention-days': 3,
  });
  assert.match(source, /NOT complete privacy\/secret review/);
  assert.match(source, /not continuous enforcement/);
  assert.match(source, /installed app still has its configured updater/);
});

test('every embedded shell block parses offline without executing build commands', () => {
  for (const step of steps.filter(step => step.run)) {
    const result = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${step.name}: ${result.stderr}`);
  }
});
