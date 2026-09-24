'use strict';

// Offline workflow contract only: extract its local validation, run against
// synthetic metadata, and prove its terminal publication blocker always fails.
// No actions checkout, package installation, download, credentials or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const text = fs.readFileSync(path.join(__dirname, '../.github/workflows/publish-feed.yml'), 'utf8');
const workflow = yaml.load(text);
const job = workflow.jobs.publish;
const steps = job.steps;
const trust = steps.find(step => step.id === 'trust');
const selection = steps.find(step => step.id === 'selection');
const blocked = steps.find(step => step.id === 'publication-blocked');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-feed-workflow-')));
let checks = 0;
const check = fn => { fn(); checks++; };
try {
  check(() => {
    for (const name of ['version', 'edition', 'matrix']) assert.equal(workflow.on.workflow_dispatch.inputs[name].required, true);
    assert.deepEqual(workflow.on.workflow_dispatch.inputs.edition.options, ['desktop', 'developers', 'mycology']);
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
  });
  check(() => {
    const checkouts = steps.filter(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkouts.length, 2);
    assert.deepEqual(checkouts.map(step => step.with), [
      { ref: '${{ github.sha }}', path: 'gates', 'persist-credentials': false },
      { ref: 'refs/tags/${{ inputs.version }}', path: 'candidate-source', 'persist-credentials': false },
    ]);
    assert.ok(steps.indexOf(trust) < steps.indexOf(checkouts[0]));
    const install = steps.find(step => step.run?.includes('npm ci'));
    assert.equal(install['working-directory'], 'gates');
    assert.equal(install.run, 'npm ci --ignore-scripts');
    assert.equal(selection.env.CANDIDATE_TAG, '${{ inputs.version }}');
    assert.equal(selection.env.RELEASE_EDITION, '${{ inputs.edition }}');
    assert.equal(selection.env.RELEASE_MATRIX, '${{ inputs.matrix }}');
  });
  check(() => {
    assert.deepEqual(Object.keys(workflow.jobs), ['publish']);
    assert.equal(steps.at(-1), blocked);
    assert.equal(blocked.if, '${{ always() }}');
    assert.equal(job['continue-on-error'], undefined);
    for (const step of steps) {
      assert.equal(step['continue-on-error'], undefined);
      assert.ok(!step.run?.includes('${{'), 'untrusted expressions must not interpolate into shell source');
    }
    assert.doesNotMatch(text, /secrets\.|GH_TOKEN|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|gh release download|bash scripts\/publish|npx wrangler|rclone copyto/);
  });
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home); fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: root };
  function shell(script, vars) {
    const result = spawnSync('/bin/bash', ['-c', script], { cwd: root, env: { ...env, ...vars }, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    return result;
  }
  const trusted = { DISPATCH_REF: 'refs/heads/main', DEFAULT_REF: 'refs/heads/main', REF_PROTECTED: 'true', CANDIDATE_TAG: 'v9.8.7' };
  check(() => assert.equal(shell(trust.run, trusted).status, 0));
  for (const invalid of [
    { DISPATCH_REF: 'refs/heads/unreviewed' }, { REF_PROTECTED: 'false' },
    { CANDIDATE_TAG: 'main' }, { CANDIDATE_TAG: '9.8.7' },
    { CANDIDATE_TAG: 'v9.8.7; touch injected' }, { CANDIDATE_TAG: 'v9.8.7\necho bad' },
  ]) check(() => assert.notEqual(shell(trust.run, { ...trusted, ...invalid }).status, 0));

  let number = 0;
  function validate(overrides = {}, candidateVersion = '9.8.7', gateVersion = '9.8.7', tweak = () => {}) {
    const workspace = path.join(root, `case-${number++}`);
    const gates = path.join(workspace, 'gates');
    const source = path.join(workspace, 'candidate-source');
    fs.mkdirSync(path.join(gates, 'scripts'), { recursive: true });
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(gates, 'package.json'), JSON.stringify({ version: gateVersion }));
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: candidateVersion }));
    // Only reviewed helpers are copied. Any candidate-code execution must fail.
    for (const name of ['publish-args.js', 'release-channel.js', 'release-matrix.js']) fs.copyFileSync(path.join(__dirname, name), path.join(gates, 'scripts', name));
    fs.writeFileSync(path.join(source, 'electron-builder.mycology.js'), 'throw new Error("CANDIDATE CODE EXECUTED");');
    tweak({ workspace, gates, source });
    return { workspace, result: shell(selection.run, {
      GITHUB_WORKSPACE: workspace, CANDIDATE_TAG: 'v9.8.7', RELEASE_EDITION: 'mycology', RELEASE_MATRIX: 'mac:arm64:dmg+zip', ...overrides,
    }) };
  }
  for (const edition of ['desktop', 'developers', 'mycology']) check(() => {
    const { result, workspace } = validate({ RELEASE_EDITION: edition });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readdirSync(path.join(workspace, 'candidate-artifacts')).length, 0);
    assert.match(result.stdout, /preflight NOT passed, nothing published/);
  });
  for (const overrides of [
    { RELEASE_EDITION: '' }, { RELEASE_EDITION: 'latest' }, { RELEASE_EDITION: '__proto__' },
    { RELEASE_EDITION: 'mycology; touch injected' }, { RELEASE_MATRIX: '' },
    { RELEASE_MATRIX: 'mac:arm64:dmg' }, { RELEASE_MATRIX: 'linux:arm64:AppImage' },
    { RELEASE_MATRIX: 'mac:arm64:dmg+zip; touch injected' }, { CANDIDATE_TAG: 'main' },
  ]) check(() => assert.notEqual(validate(overrides).result.status, 0));
  check(() => {
    const { result } = validate({}, '9.8.6');
    assert.notEqual(result.status, 0); assert.match(result.stderr, /source version differs from tag/);
  });
  check(() => {
    const { result } = validate({}, '9.8.7', '9.8.8');
    assert.notEqual(result.status, 0); assert.match(result.stderr, /differs from reviewed gate package/);
  });
  for (const mutation of [
    ({ source }) => fs.writeFileSync(path.join(source, 'package.json'), '{broken'),
    ({ source }) => fs.unlinkSync(path.join(source, 'package.json')),
    ({ source, gates }) => { fs.unlinkSync(path.join(source, 'package.json')); fs.symlinkSync(path.join(gates, 'package.json'), path.join(source, 'package.json')); },
    ({ workspace }) => fs.mkdirSync(path.join(workspace, 'candidate-artifacts')),
  ]) check(() => assert.notEqual(validate({}, '9.8.7', '9.8.7', mutation).result.status, 0));
  check(() => {
    assert.equal(validate().result.status, 0);
    const result = shell(blocked.run, {});
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Publication disabled: approved asm-exec/);
    assert.equal(fs.existsSync(path.join(root, 'injected')), false);
  });
  console.log(`publish-feed workflow: ${checks} offline checks passed; publication remains explicitly blocked`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
