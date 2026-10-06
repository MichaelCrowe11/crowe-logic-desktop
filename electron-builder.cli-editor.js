// A distinct local installation avoids confusing LaunchServices with the
// signed production app while keeping the full Crowe Logic application.
const base = require("./package.json").build;
module.exports = {
  ...base,
  appId: "com.crowelogic.desktop.cli-editor",
  directories: { ...base.directories, output: "release-cli-editor" },
};
