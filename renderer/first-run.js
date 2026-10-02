// First run, decided by facts the renderer can check.
//
// A fresh install booted into the home folder: the Files pane listed ~ and the
// first welcome chip would have summarised it. The workspace is the unit of
// work, so the first thing to ask for is a project folder, not a sign-in. This
// module is the pure half; the renderer draws it. Runs in node and the renderer.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CroweFirstRun = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const norm = (p) => String(p || "").replace(/\/+$/, "");
  // True when the workspace is the user's home folder, which is never a project.
  function workspaceIsHome(cwd, homeDir) {
    if (!cwd || !homeDir) return false;
    return norm(cwd) === norm(homeDir);
  }
  // The welcome chips for a workspace state. Three chips always, so the layout
  // and the tests that count them hold; the first one changes its job.
  function welcomeChips(atHome) {
    if (atHome) return [
      { text: "Open a project folder to start", action: "open-folder" },
      { text: "Run the test suite and report failures", action: "send" },
      { text: "Show me the git changes and stage the ones that look right", action: "send" },
    ];
    return [
      { text: "List the files here and summarize the project", action: "send" },
      { text: "Run the test suite and report failures", action: "send" },
      { text: "Show me the git changes and stage the ones that look right", action: "send" },
    ];
  }
  // Sign-in copy that matches the free tier the site and the CLI promise.
  const SIGN_IN_COPY = "Sign in with your Crowe ID to start. The free tier needs no card and no keys: CroweLM Flash, twenty turns a day, the full tool loop. Personal, Pro and Max open the whole CroweLM table.";
  const ONBOARDING_STEP_SIGN_IN = "Sign in with your Crowe ID. The free tier needs no card and no keys; Personal, Pro and Max open the whole CroweLM table.";
  const FILES_EMPTY_HOME = "No project open. The workspace is still your home folder, which is not a project. Open the folder you want the agent to work in.";
  return { workspaceIsHome, welcomeChips, SIGN_IN_COPY, ONBOARDING_STEP_SIGN_IN, FILES_EMPTY_HOME };
});
