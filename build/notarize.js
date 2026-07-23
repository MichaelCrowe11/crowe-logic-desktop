// electron-builder afterSign hook: notarize + staple the signed .app using the
// pre-configured `crowe-notary` keychain profile (App Store Connect API key).
// Runs after code-signing, before dmg/zip packaging, so the artifacts ship with
// a stapled ticket. CI must provision the profile (or set APPLE_API_* env and
// swap the notarytool auth flags below).
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const PROFILE = process.env.CROWE_NOTARY_PROFILE || "crowe-notary";

exports.default = async function notarize(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CROWE_SKIP_NOTARIZE === "1") { console.log("notarize: skipped (CROWE_SKIP_NOTARIZE=1)"); return; }
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  if (!fs.existsSync(appPath)) { console.log("notarize: no app at", appPath); return; }
  const zip = path.join(context.appOutDir, "notarize-upload.zip");
  console.log("notarize: zipping", appName);
  execFileSync("ditto", ["-c", "-k", "--keepParent", appPath, zip]);
  try {
    console.log("notarize: submitting to Apple (profile:", PROFILE + ")");
    execFileSync("xcrun", ["notarytool", "submit", zip, "--keychain-profile", PROFILE, "--wait"], { stdio: "inherit" });
    execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
    console.log("notarize: stapled", appName);
  } finally {
    try { fs.unlinkSync(zip); } catch {}
  }
};
