// Flips Electron's runtime fuses after electron-builder lays the app out and
// before it signs. Off: running the binary as plain Node, --inspect, and
// NODE_OPTIONS, each a way for an unprivileged local process to run inside the
// signed app and read what its Keychain items only release to it. On: load the
// app only from app.asar and check the integrity hash Info.plist carries for it.
//
// Verify a build: npx @electron/fuses read --app "release/mac-arm64/Crowe Logic.app"
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");
const path = require("path");

exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager, arch } = context;
  const name = packager.appInfo.productFilename;
  const binary = electronPlatformName === "darwin"
    ? path.join(appOutDir, `${name}.app`, "Contents", "MacOS", name)
    : electronPlatformName === "win32" ? path.join(appOutDir, `${name}.exe`) : path.join(appOutDir, name);
  await flipFuses(binary, {
    version: FuseVersion.V1,
    // arm64 Mach-O binaries have to carry a valid signature to launch at all;
    // the flip invalidates the ad-hoc one, so put a fresh ad-hoc one back for
    // electron-builder's real signing to replace.
    resetAdHocDarwinSignature: electronPlatformName === "darwin" && arch === 3,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
  console.log(`  • fuses flipped for ${electronPlatformName} ${binary}`);
};
