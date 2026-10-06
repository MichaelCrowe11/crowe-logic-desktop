// The CLI draft mode uses the same Crowe Logic application, with no workspace
// services or sign-in needed to edit a local prompt.
if (process.argv.includes("--edit-draft")) {
  require("./draft-editor").start();
} else {
  require("./main");
}
