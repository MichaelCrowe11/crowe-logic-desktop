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
  // No terminal in the store build: Mycology has no terminal space, a login shell
  // is not something the sandbox runs, and main.js already reports "pty
  // unavailable" without node-pty. Leaving out the one native module also makes
  // the arm64 and x64 halves identical, so the universal merge has nothing to lipo.
  files: [...mycology.files.filter((f) => !f.includes('node-pty')), '!node_modules/node-pty{,/**}'],
  npmRebuild: false,
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
    identity: 'Michael Crowe (6QLMV9UCPP)',
    provisioningProfile: profile,
    entitlements: 'build/entitlements.mas.plist',
    entitlementsInherit: 'build/entitlements.mas.inherit.plist',
    artifactName: 'CroweLogic-mycology-mas-${version}.${ext}',
  },
};
