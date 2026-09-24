#!/usr/bin/env node
'use strict';

// Pure policy/config tests: no Electron launch, installer build or real profile.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveEdition, publicEditionDescriptor } = require('../app-edition');
const pkg = require('../package.json');
const dev = require('../electron-builder.developer');
const mycology = require('../electron-builder.mycology');
const layout = require('./release-channel');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`ok      ${name}`); }
const resolve = (id, env = {}, isPackaged = true) => resolveEdition({ metadata: { croweEdition: id }, env, isPackaged });
const expected = {
  desktop: { productName: 'Crowe Logic', allowed: ['chat', 'projects'], defaults: ['chat', 'projects'], landing: 'chat', grows: false },
  developers: { productName: 'Crowe Logic for Developers', allowed: ['chat', 'projects'], defaults: ['chat', 'projects'], landing: 'chat', grows: false },
  mycology: { productName: 'Crowe Logic Mycology', allowed: ['farm', 'cultivation', 'messenger', 'chat'], defaults: ['farm', 'cultivation', 'messenger'], landing: 'farm', grows: true },
};

for (const [id, value] of Object.entries(expected)) {
  check(`${id} policy identity, navigation and capabilities are explicit`, () => {
    const edition = resolve(id);
    assert.equal(edition.id, id);
    assert.equal(edition.productName, value.productName);
    assert.equal(edition.profileName, value.productName);
    assert.equal(edition.appId, `com.crowelogic.desktop${id === 'desktop' ? '' : '.' + id}`);
    assert.equal(edition.protocol, null, 'editions must not claim a shared protocol');
    assert.deepEqual(edition.allowedSpaces, value.allowed);
    assert.deepEqual(edition.defaultSpaces, value.defaults);
    assert.equal(edition.landingSpace, value.landing);
    assert.equal(edition.legacyAccess, false);
    assert.deepEqual(edition.capabilities, { grow: value.grows, farm: value.grows, sense: value.grows, legacyAccess: false });
  });
  check(`${id} descriptors and nested state are immutable and detached`, () => {
    const edition = resolve(id);
    const copy = publicEditionDescriptor(edition);
    for (const value of [edition, edition.allowedSpaces, edition.defaultSpaces, edition.capabilities, copy, copy.allowedSpaces, copy.capabilities]) {
      assert.ok(Object.isFrozen(value));
    }
    assert.notEqual(copy, edition);
    assert.notEqual(copy.capabilities, edition.capabilities);
    assert.throws(() => edition.allowedSpaces.push('cultivation'), TypeError);
    assert.throws(() => { edition.capabilities.grow = !edition.capabilities.grow; }, TypeError);
    assert.throws(() => { edition.id = 'mycology'; }, TypeError);
    assert.deepEqual(resolve(id), edition);
  });
  check(`${id} packaged policy cannot be overridden by environment or legacy metadata`, () => {
    for (const override of ['desktop', 'developers', 'mycology', '', 'unknown', null]) {
      assert.deepEqual(resolve(id, { CROWE_EDITION: override }), resolve(id));
    }
    const poisoned = resolveEdition({ metadata: { croweEdition: id, croweSpaces: ['farm'], productName: 'Untrusted', capabilities: { grow: true }, legacyAccess: true }, isPackaged: true });
    assert.deepEqual(poisoned, resolve(id));
  });
  check(`${id} CROWE_SPACES cannot expand the allowlist or remove landing`, () => {
    for (const request of ['', ' ', 'unknown', 'farm,cultivation,messenger,sense,projects,chat,terminal', 'projects', 'cultivation', 'chat']) {
      const edition = resolve(id, { CROWE_SPACES: request });
      assert.ok(edition.defaultSpaces.includes(value.landing));
      assert.ok(edition.defaultSpaces.every((space) => value.allowed.includes(space)));
      assert.deepEqual(edition.allowedSpaces, value.allowed);
      assert.deepEqual(edition.capabilities, resolve(id).capabilities);
    }
    assert.deepEqual(resolve(id, { CROWE_SPACES: '' }).defaultSpaces, [value.landing]);
  });
}

check('legacy absent edition metadata means Desktop, not inferred grower access', () => {
  assert.deepEqual(resolveEdition(), resolve('desktop'));
  assert.deepEqual(resolveEdition({ metadata: { croweSpaces: ['cultivation', 'farm'] } }), resolve('desktop'));
});
check('only unpackaged development permits a valid edition override', () => {
  assert.deepEqual(resolve('desktop', { CROWE_EDITION: 'mycology' }, false), resolve('mycology'));
  assert.deepEqual(resolve('mycology', { CROWE_EDITION: 'developers' }, false), resolve('developers'));
  assert.deepEqual(resolve('mycology', {}, false), resolve('mycology'));
});
check('unknown and malformed edition IDs fail closed, including prototype names', () => {
  for (const bad of ['', 'Desktop', ' mycology', 'mycology ', 'unknown', '__proto__', 'constructor', 'toString', null, undefined, 1, [], {}]) {
    assert.throws(() => resolve(bad), /Unknown Crowe edition/);
    assert.throws(() => resolve('desktop', { CROWE_EDITION: bad }, false), /Unknown Crowe edition/);
    assert.throws(() => resolve(bad, { CROWE_EDITION: 'mycology' }, false), /Unknown Crowe edition/);
  }
});
check('malformed resolver arguments cannot silently broaden policy', () => {
  for (const metadata of [null, false, 'mycology', []]) assert.throws(() => resolveEdition({ metadata }), /metadata must/);
  for (const isPackaged of ['false', null, 0]) assert.throws(() => resolveEdition({ isPackaged }), /isPackaged must/);
  for (const spaces of [null, false, ['farm']]) assert.throws(() => resolve('mycology', { CROWE_SPACES: spaces }), /CROWE_SPACES must/);
});
check('space selection is deduplicated and policy ordered; Mycology assistant is opt-in', () => {
  assert.deepEqual(resolve('desktop', { CROWE_SPACES: 'farm,cultivation, chat, chat' }).defaultSpaces, ['chat']);
  assert.deepEqual(resolve('mycology', { CROWE_SPACES: 'chat' }).defaultSpaces, ['farm', 'chat']);
  assert.deepEqual(resolve('mycology', { CROWE_SPACES: 'chat,cultivation,farm,chat' }).defaultSpaces, ['farm', 'cultivation', 'chat']);
});
check('Messenger is explicit Mycology default without enabling assistant or other editions', () => {
  const mycology = resolve('mycology');
  assert.ok(mycology.defaultSpaces.includes('messenger'));
  assert.ok(!mycology.defaultSpaces.includes('chat'));
  assert.ok(!mycology.allowedSpaces.includes('projects'));
  assert.deepEqual(resolve('mycology', { CROWE_SPACES: 'messenger,messenger' }).defaultSpaces, ['farm', 'messenger']);
  for (const id of ['desktop', 'developers']) {
    assert.ok(!resolve(id).allowedSpaces.includes('messenger'));
    assert.deepEqual(resolve(id, { CROWE_SPACES: 'messenger' }).defaultSpaces, ['chat']);
  }
});
check('public descriptor sanitizes identity, capabilities and recovery access', () => {
  const descriptor = publicEditionDescriptor({ ...resolve('desktop'), productName: 'Untrusted', appId: 'other', profileName: '/some/path', capabilities: { grow: true }, allowedSpaces: ['farm'], defaultSpaces: ['farm', 'projects'], landingSpace: 'farm', legacyAccess: true, privateField: 'not-public' });
  assert.deepEqual(descriptor, resolve('desktop'));
  assert.ok(!Object.hasOwn(descriptor, 'privateField'));
});
check('metadata/env inputs are not retained or modified', () => {
  const metadata = { croweEdition: 'mycology' };
  const env = { CROWE_SPACES: 'chat' };
  const result = resolveEdition({ metadata, env, isPackaged: false });
  assert.deepEqual(metadata, { croweEdition: 'mycology' });
  assert.deepEqual(env, { CROWE_SPACES: 'chat' });
  metadata.croweEdition = 'desktop';
  env.CROWE_SPACES = 'cultivation';
  assert.equal(result.id, 'mycology');
  assert.deepEqual(result.defaultSpaces, ['farm', 'chat']);
});
check('packaged metadata selects the correct immutable policy for all three configs', () => {
  assert.equal(pkg.croweEdition, 'desktop');
  for (const [id, config] of [['desktop', pkg.build], ['developers', dev], ['mycology', mycology]]) {
    assert.equal(config.extraMetadata.croweEdition, id);
    const edition = resolveEdition({ metadata: { ...pkg, ...config.extraMetadata }, isPackaged: true, env: { CROWE_EDITION: 'unknown' } });
    assert.equal(edition.id, id);
    assert.equal(edition.productName, config.productName);
    assert.equal(edition.appId, config.appId);
    assert.ok(config.files.includes('app-edition.js'));
  }
});
check('Mycology preserves shared packaging hooks and has isolated install/update identities', () => {
  const all = [pkg.build, dev, mycology];
  for (const field of ['appId', 'productName']) assert.equal(new Set(all.map((config) => config[field])).size, 3);
  assert.equal(new Set(all.map((config) => config.directories.output)).size, 3);
  assert.equal(new Set(all.map((config) => config.linux.executableName || pkg.name)).size, 3);
  assert.equal(new Set(all.map((config) => config.deb.packageName || pkg.name)).size, 3);
  assert.equal(mycology.linux.executableName, 'crowe-logic-mycology');
  assert.equal(mycology.deb.packageName, 'crowe-logic-mycology');
  assert.equal(mycology.artifactName, 'CroweLogic-mycology-${version}-${arch}.${ext}');
  assert.equal(mycology.mac.artifactName, mycology.artifactName);
  for (const key of ['files', 'afterPack', 'afterSign', 'asarUnpack']) assert.deepEqual(mycology[key], pkg.build[key]);
  assert.deepEqual(mycology.mac.entitlements, pkg.build.mac.entitlements);
  assert.deepEqual(mycology.linux.target, pkg.build.linux.target);
  assert.deepEqual(mycology.deb.depends, pkg.build.deb.depends);
  assert.deepEqual(mycology.publish.map((entry) => entry.channel), ['mycology']);
  assert.deepEqual(mycology.publish.map((entry) => entry.url), pkg.build.publish.map((entry) => entry.url.replace('/desktop/channel/', '/desktop/mycology/channel/')));
});
check('Mycology layout and CLI config selection remain isolated', () => {
  assert.equal(layout.prefix('mycology'), 'desktop/mycology');
  assert.equal(layout.outputDir('mycology'), 'release-mycology');
  assert.equal(layout.pagePath('mycology'), '/mycology');
  const config = path.join(__dirname, '..', 'electron-builder.mycology.js');
  assert.deepEqual(layout.fromArgs(['--config', config]), { channel: 'mycology', dir: 'release-mycology', rest: [] });
  const run = spawnSync(process.execPath, [path.join(__dirname, 'release-channel.js'), '--shell', '--config', config], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /channel='mycology'/);
  assert.match(run.stdout, /prefix='desktop\/mycology'/);
  assert.match(run.stdout, /feed_mac='mycology-mac.yml'/);
  const keys = ['latest', 'developers', 'mycology'].flatMap((channel) => [
    ...layout.OSES.map((os) => layout.feedKey(channel, os)), layout.artifactKey(channel, '1.2.3', 'SHA256SUMS'),
  ]);
  assert.equal(new Set(keys).size, keys.length);
});

console.log(`\napp-edition: ${passed} checks passed`);
