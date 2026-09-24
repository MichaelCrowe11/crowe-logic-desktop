// Crowe Logic for Developers: the same app, packaged for the Azure Marketplace
// listing. That listing is pitched as a coding agent and its screenshots show
// no cultivation, so this edition allows only Chat and Projects in ordinary
// navigation. app-edition.js enforces the same policy in the host; legacy farm
// recovery is a separate, explicitly authorized window-scoped operation.
//
//   npm run dist:developers          # any platform, flags pass through
//   npm run dist:developers:mac      # also staples the DMG, reading this config
//   npm run publish:rclone:developers
//
// Built from package.json's `build` section so icons, signing, entitlements,
// the files allowlist and the hooks stay in one place; only what makes this a
// different product is set here. It has to be a require rather than `extends`:
// electron-builder's --config replaces the package.json section outright, and
// `extends` on a package.json reads the whole file, not its `build` key.
const base = require("./package.json").build;
const { prefix, outputDir } = require("./scripts/release-channel");

const channel = "developers";
const productName = "Crowe Logic for Developers";
// Distinct from the full app's names, so the two editions never overwrite each
// other's artifact in a shared folder. ${arch} is dropped by electron-builder
// for a target that has no single architecture.
const artifactName = "CroweLogic-developers-${version}-${arch}.${ext}";
// The deb package name and the Linux binary. Both default to package.json's
// name, which the two editions share, so without this a developer deb would
// replace the full app on one machine rather than install beside it.
const linuxName = "crowe-logic-developers";

module.exports = {
  ...base,
  // A second bundle id and NSIS GUID, so the edition installs beside the full
  // app rather than over it. Both editions read their own userData, since
  // Electron derives that path from the product name.
  appId: `${base.appId}.developers`,
  // Both are needed. The config-level name is what electron-builder names the
  // bundle and installer after; extraMetadata lands in the packaged app's own
  // package.json, which is where Electron reads app.name and where
  // app-edition.js resolves the immutable edition policy. croweSpaces remains
  // for older development tooling, not as authority to expand capabilities.
  productName,
  extraMetadata: { ...base.extraMetadata, productName, croweEdition: channel, croweSpaces: ["chat", "projects"] },
  artifactName,
  mac: { ...base.mac, artifactName },
  // app-builder-lib names the deb after deb.packageName and falls back to
  // package.json's name (out/targets/FpmTarget.js, computeFpmMetaInfoOptions);
  // it names the binary, the /usr/bin symlink, the .desktop file and the icons
  // after linux.executableName and falls back to that same name lowercased
  // (out/linuxPackager.js). The install directory is /opt/<productName>, which
  // already differs, and userData is left alone: Electron derives it from
  // productName, not from either of these.
  linux: { ...base.linux, executableName: linuxName },
  deb: { ...base.deb, packageName: linuxName },
  // Its own output directory. The publishers read release/ for the full
  // edition, and a developer artifact must never be swept into the public feed
  // by accident.
  directories: { ...base.directories, output: outputDir(channel) },
  // Its own update channel, under its own prefix in the bucket. On the shared
  // "latest" feed the updater would offer the next full release and install
  // Cultivation back over this edition; on a shared prefix a developer feed or
  // SHA256SUMS could land on a key the full edition serves. So the feed is
  // developers-mac.yml (electron-updater names it after the channel) and the
  // url ends in desktop/developers/channel/<os>, which is where the publishers
  // write it (scripts/release-channel.js has the layout). The channel is
  // unseeded until someone publishes to it; main.js already ignores the silent
  // launch check that 404s.
  publish: base.publish.map((p) => {
    const url = p.url.replace("/desktop/channel/", `/${prefix(channel)}/channel/`);
    // A url the replace left alone would send this edition's updater through
    // the full app's channel directory, and nothing would say so until the
    // next full release installed Cultivation over it. Refuse to build that.
    if (url === p.url) throw new Error(`electron-builder.developer.js: publish url ${p.url} is not under /desktop/channel/`);
    return { ...p, channel, url };
  }),
};
