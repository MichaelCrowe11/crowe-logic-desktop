// Crowe Logic for Developers: the same app, packaged for the Azure Marketplace
// listing. That listing is pitched as a coding agent and its screenshots show
// no cultivation, so this edition ships the Chat and Projects spaces and leaves
// Cultivation out of the default. A default, not a lock: the picker in Settings
// can still turn it on, exactly as installSpaces() in main.js describes.
//
//   npm run dist:developers
//
// Built from package.json's `build` section so icons, signing, entitlements,
// the files allowlist and the hooks stay in one place; only what makes this a
// different product is set here. It has to be a require rather than `extends`:
// electron-builder's --config replaces the package.json section outright, and
// `extends` on a package.json reads the whole file, not its `build` key.
const base = require("./package.json").build;

const productName = "Crowe Logic for Developers";
// Distinct from the full app's names, so the two editions never overwrite each
// other's artifact in a shared folder. ${arch} is dropped by electron-builder
// for a target that has no single architecture.
const artifactName = "CroweLogic-developers-${version}-${arch}.${ext}";

module.exports = {
  ...base,
  // A second bundle id and NSIS GUID, so the edition installs beside the full
  // app rather than over it. Both editions read their own userData, since
  // Electron derives that path from the product name.
  appId: `${base.appId}.developers`,
  // Both are needed. The config-level name is what electron-builder names the
  // bundle and installer after; extraMetadata lands in the packaged app's own
  // package.json, which is where Electron reads app.name and where
  // installSpaces() reads croweSpaces.
  productName,
  extraMetadata: { productName, croweSpaces: ["chat", "projects"] },
  artifactName,
  mac: { ...base.mac, artifactName },
  // Its own output directory. publish-r2.sh reads release/, and a developer
  // artifact must never be swept into the public feed by accident.
  directories: { ...base.directories, output: "release-developers" },
  // Its own update channel. On the shared "latest" feed the updater would offer
  // the next full release and install Cultivation back over this edition. The
  // channel is unseeded until someone publishes to it; main.js already ignores
  // the silent launch check that 404s.
  publish: base.publish.map((p) => ({ ...p, channel: "developers" })),
};
