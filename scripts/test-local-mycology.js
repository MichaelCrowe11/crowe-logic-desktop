'use strict';
// Execute the actual immutable metadata/updater/telemetry gates without Electron,
// real profiles, network, signing, or a build.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const declaration = source.match(/^const LOCAL_PRERELEASE = .+;$/m)[0];
const updater = source.slice(source.indexOf('let autoUpdater = null;'), source.indexOf('\nconst DEFAULTS ='));
const telemetry = source.slice(source.indexOf('function telemetryExtra() {'), source.indexOf('\nfunction configPath()'));
let checks = 0;
for (const packaged of [false, true]) for (const flag of [undefined, false, 'true', true]) {
  let imports = 0, sends = 0, crash;
  const expected = packaged && flag === true;
  const ctx = { app: { isPackaged: packaged, getVersion: () => '0.24.15', getPath: () => '/synthetic', setPath() {} },
    require: name => {
      if (name === './package.json') return { croweLocalPrerelease: flag };
      assert.equal(name, 'electron-updater'); imports++; return { autoUpdater: {} };
    },
    process: { platform: 'darwin', arch: 'arm64', env: { CROWE_LOCAL_PRERELEASE: 'true' } },
    path, loadConfig: () => ({ telemetry: true, baseUrl: 'https://synthetic.invalid' }),
    crashReporter: { start: options => { crash = options; } },
    fetch: () => { sends++; return Promise.resolve(); }, AbortSignal,
  };
  vm.runInNewContext(`${declaration}\n${updater}\n${telemetry}\ninitCrashReporting(); postTelemetry('synthetic');`, ctx);
  assert.equal(imports, expected ? 0 : 1);
  assert.equal(sends, expected ? 0 : 1);
  assert.equal(crash.uploadToServer, !expected);
  assert.equal(crash.submitURL, expected ? '' : 'https://synthetic.invalid/api/telemetry/crash');
  checks++;
}
assert.match(source, /if \(LOCAL_PRERELEASE\) cfg\.telemetry = false;/);
assert.match(source, /telemetry: !LOCAL_PRERELEASE/);
const config = require('../electron-builder.mycology.local');
assert.equal(config.appId, 'com.crowelogic.desktop.mycology');
assert.equal(config.extraMetadata.croweLocalPrerelease, true);
assert.equal(config.extraMetadata.croweBuildChannel, 'local-prerelease');
assert.deepEqual(config.mac.target, [{ target: 'dir', arch: ['arm64'] }]);
assert.equal(config.mac.identity, null);
assert.equal(config.mac.notarize, false);
assert.equal(config.npmRebuild, false);
assert.equal(config.nodeGypRebuild, false);
assert.equal(config.publish, null);
assert.equal(config.afterSign, null);
assert.equal(config.afterPack, 'build/fuses.js');
console.log(`local-mycology: ${checks} metadata/updater/crash/event gate combinations and directory-only config passed`);
