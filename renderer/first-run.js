// First run, decided by facts the renderer can check.
//
// A fresh install booted into the home folder: the Files pane listed ~ and the
// first welcome chip would have summarised it. The workspace is the unit of
// work, so the first thing to ask for is a project folder, not a sign-in, and
// until one is chosen (or home is chosen on purpose) the composer holds. This
// module is the pure half; the renderer draws it. Runs in node and the renderer.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CroweFirstRun = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const norm = (p) => String(p || "").replace(/\/+$/, "");
  // True when the workspace is the user's home folder, which is never assumed
  // to be the project.
  function workspaceIsHome(cwd, homeDir) {
    if (!cwd || !homeDir) return false;
    return norm(cwd) === norm(homeDir);
  }
  // The composer holds while the workspace is home and the user has not said
  // that home is what they want. A shell with no folder to open (web, phone)
  // reports no cwd and is never held.
  function workspaceBlocked(cwd, homeDir, useHomeWorkspace) {
    return workspaceIsHome(cwd, homeDir) && !useHomeWorkspace;
  }
  // The last path segment, for a chip label. Control and bidi characters are
  // dropped: a folder name is shown, never interpreted.
  function workspaceName(cwd) {
    const s = String(cwd || "").replace(/[\\/]+$/, "");
    return s.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e]/g, "");
  }
  // The welcome chips for a workspace state. Three chips always, so the layout
  // and the tests that count them hold; the first one changes its job. While
  // the composer holds it opens a folder. With a project open its label names
  // the folder, and `prompt` is what is sent: a folder name is a label, not an
  // instruction, and the agent already works in that folder.
  function welcomeChips(blocked, folderName) {
    if (blocked) return [
      { text: "Open a project folder to start", action: "open-folder" },
      { text: "Run the test suite and report failures", action: "send" },
      { text: "Show me the git changes and stage the ones that look right", action: "send" },
    ];
    const first = folderName
      ? { text: `List the files in ${folderName} and summarize the project`, action: "send", prompt: "List the files in the current workspace and summarize the project" }
      : { text: "List the files here and summarize the project", action: "send" };
    return [
      first,
      { text: "Run the test suite and report failures", action: "send" },
      { text: "Show me the git changes and stage the ones that look right", action: "send" },
    ];
  }
  // Sign-in copy that matches the free tier the site and the CLI promise.
  const SIGN_IN_COPY = "Sign in with Crowe ID. The free tier is 20 turns a day on CroweLM Flash; plans unlock the other tiers.";
  const ONBOARDING_STEP_SIGN_IN = SIGN_IN_COPY;
  // What the app is, in the order a first task happens. Autonomy and approvals
  // are settings, so the sentence names them rather than promising a review
  // that the Execute tier with approvals off would not give.
  const ONBOARDING_INTRO = "Open a folder, pick how much the agent may do, and ask for a change. Autonomy sets what it does on its own; approvals set what waits for your yes.";
  const ONBOARDING_STEP_FOLDER = "Choose the folder the agent should work in.";
  const ONBOARDING_STEP_TASK = "Give the agent a task.";
  // The hold, said once as a card when a send is tried, and as the composer's
  // resting caption while it lasts.
  const WORKSPACE_PROMPT = "The workspace is still your home folder. Choose the project folder the agent should work in, or allow it to work in your home folder.";
  const COMPOSER_BLOCKED = "Choose a project folder to start";
  const CHOOSE_FOLDER = "Choose a folder";
  const USE_HOME = "Use my home folder";
  const FILES_EMPTY_HOME = "No project open. The workspace is still your home folder, which is not a project. Open the folder you want the agent to work in.";
  return { workspaceIsHome, workspaceBlocked, workspaceName, welcomeChips,
    SIGN_IN_COPY, ONBOARDING_STEP_SIGN_IN, ONBOARDING_INTRO, ONBOARDING_STEP_FOLDER, ONBOARDING_STEP_TASK,
    WORKSPACE_PROMPT, COMPOSER_BLOCKED, CHOOSE_FOLDER, USE_HOME, FILES_EMPTY_HOME };
});
