'use strict';

// Separate installer, profile and update identity; one maintained application.
// Follow the developer edition's config composition without inheriting its
// product/channel names. Signing, platform targets, files and hooks stay in base.
const base = require('./package.json').build;
const { resolveEdition } = require('./app-edition');
const { prefix, outputDir } = require('./scripts/release-channel');

const channel = 'mycology';
const edition = resolveEdition({ metadata: { croweEdition: channel }, isPackaged: true });
const productName = edition.productName;
const artifactName = 'CroweLogic-mycology-${version}-${arch}.${ext}';
const linuxName = 'crowe-logic-mycology';

module.exports = {
  ...base,
  appId: edition.appId,
  productName,
  extraMetadata: {
    ...base.extraMetadata,
    productName,
    croweEdition: channel,
    croweSpaces: [...edition.defaultSpaces],
  },
  artifactName,
  mac: { ...base.mac, artifactName, icon: 'assets/icon-mycology.icns' },
  win: { ...base.win, icon: 'assets/icon-mycology.ico' },
  linux: { ...base.linux, executableName: linuxName, icon: 'assets/icon-mycology.png' },
  deb: { ...base.deb, packageName: linuxName },
  directories: { ...base.directories, output: outputDir(channel) },
  publish: base.publish.map((entry) => {
    const url = entry.url.replace('/desktop/channel/', `/${prefix(channel)}/channel/`);
    if (url === entry.url) throw new Error(`electron-builder.mycology.js: publish url ${entry.url} is not under /desktop/channel/`);
    return { ...entry, channel, url };
  }),
};
