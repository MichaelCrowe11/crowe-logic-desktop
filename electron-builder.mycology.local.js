'use strict';
// Local arm64 directory candidate only. Never a release/publish configuration.
// Use scripts/build-local-mycology.js: it creates independent staged inputs and
// signs explicitly without electron-builder's identity-discovery path.
const base = require('./electron-builder.mycology');
module.exports = {
  ...base,
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  electronDist: 'node_modules/electron/dist',
  extraMetadata: {
    ...base.extraMetadata,
    croweLocalPrerelease: true,
    croweBuildChannel: 'local-prerelease',
  },
  directories: { ...base.directories, output: 'candidate' },
  mac: {
    ...base.mac,
    target: [{ target: 'dir', arch: ['arm64'] }],
    identity: null,
    notarize: false,
  },
  afterSign: null,
  publish: null,
};
