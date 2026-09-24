'use strict';

// Crowe Logic Mycology for the Mac App Store. Same app as the direct-download
// Mycology edition, packaged for the store: sandboxed, signed with Apple
// Distribution, no self-update, no publish. The bundle ID is the one the App
// Store Connect record owns (com.crowelogic.mycology), not the direct edition's.
//
//   CROWE_MAS_PROFILE=/path/to/profile.provisionprofile \
//     npx electron-builder --config electron-builder.mycology.mas.js --mac mas
const mycology = require('./electron-builder.mycology.js');

const profile = process.env.CROWE_MAS_PROFILE;
if (!profile) throw new Error('electron-builder.mycology.mas.js: set CROWE_MAS_PROFILE to the Mac App Store provisioning profile');

module.exports = {
  ...mycology,
  appId: 'com.crowelogic.mycology',
  artifactName: 'CroweLogic-mycology-mas-${version}-${arch}.${ext}',
  directories: { ...mycology.directories, output: 'release-mas' },
  publish: null,
  afterSign: null,
  mac: {
    ...mycology.mac,
    target: [{ target: 'mas', arch: ['universal'] }],
    category: 'public.app-category.productivity',
    extendInfo: {
      NSMicrophoneUsageDescription: 'Crowe Logic Mycology uses the microphone only while you dictate a message.',
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  mas: {
    type: 'distribution',
    hardenedRuntime: false,
    identity: 'Apple Distribution: Michael Crowe (6QLMV9UCPP)',
    provisioningProfile: profile,
    entitlements: 'build/entitlements.mas.plist',
    entitlementsInherit: 'build/entitlements.mas.inherit.plist',
    artifactName: 'CroweLogic-mycology-mas-${version}.${ext}',
  },
};
