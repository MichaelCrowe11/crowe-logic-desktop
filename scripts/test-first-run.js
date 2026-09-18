// A fresh install booted into the home folder and told the user Pro was
// required. These pin the pure half of the first-run fixes: home detection,
// the hold on the composer until a folder is chosen or home is chosen on
// purpose, the chips, and copy that says what the free tier is.
const assert = require("assert");
const F = require("../renderer/first-run");

assert.strictEqual(F.workspaceIsHome("/Users/x", "/Users/x"), true);
assert.strictEqual(F.workspaceIsHome("/Users/x/", "/Users/x"), true, "a trailing slash is the same folder");
assert.strictEqual(F.workspaceIsHome("/Users/x/proj", "/Users/x"), false);
assert.strictEqual(F.workspaceIsHome("", "/Users/x"), false);
assert.strictEqual(F.workspaceIsHome("/Users/x", ""), false);

// The hold: home and not chosen. A shell with no folder (cwd "") never holds.
assert.strictEqual(F.workspaceBlocked("/Users/x", "/Users/x", false), true);
assert.strictEqual(F.workspaceBlocked("/Users/x", "/Users/x", undefined), true, "an unset flag is not consent");
assert.strictEqual(F.workspaceBlocked("/Users/x", "/Users/x", true), false, "home on purpose lifts the hold");
assert.strictEqual(F.workspaceBlocked("/Users/x/proj", "/Users/x", false), false);
assert.strictEqual(F.workspaceBlocked("", "", false), false, "web and phone report no cwd and are never held");

// A folder name is shown, never interpreted.
assert.strictEqual(F.workspaceName("/Users/x/proj/"), "proj");
assert.strictEqual(F.workspaceName("C:\\Users\\x\\demo"), "demo");
assert.strictEqual(F.workspaceName("/Users/x/pr\u202eoj\n"), "proj", "control and bidi characters are dropped");
assert.strictEqual(F.workspaceName(""), "");

const held = F.welcomeChips(true), proj = F.welcomeChips(false), named = F.welcomeChips(false, "demo");
assert.strictEqual(held.length, 3); assert.strictEqual(proj.length, 3); assert.strictEqual(named.length, 3);
assert.strictEqual(held[0].action, "open-folder", "while the hold is on the first chip opens a folder");
assert.strictEqual(proj[0].action, "send");
assert.strictEqual(proj[0].text, "List the files here and summarize the project");
assert.strictEqual(named[0].text, "List the files in demo and summarize the project", "with a project open the first chip names it");
assert.strictEqual(named[0].prompt, "List the files in the current workspace and summarize the project", "the folder name is a label, not the instruction");
assert.strictEqual(proj[0].prompt, undefined);

// Copy. The sign-in sentence is the one the design review prescribed, exactly.
assert.strictEqual(F.SIGN_IN_COPY, "Sign in with Crowe ID. The free tier is 20 turns a day on CroweLM Flash; plans unlock the other tiers.");
assert.strictEqual(F.ONBOARDING_STEP_SIGN_IN, F.SIGN_IN_COPY, "one sign-in sentence, not two");
assert(!/operator over your CroweLM gateway/.test(F.ONBOARDING_INTRO));
assert(!/Cmd\+O/.test(F.ONBOARDING_STEP_FOLDER), "there is no Cmd+O; the copy must not claim one");
assert(/home folder/.test(F.FILES_EMPTY_HOME));
const copy = [F.SIGN_IN_COPY, F.ONBOARDING_INTRO, F.ONBOARDING_STEP_FOLDER, F.WORKSPACE_PROMPT, F.COMPOSER_BLOCKED, F.CHOOSE_FOLDER, F.USE_HOME, F.FILES_EMPTY_HOME];
for (const s of copy) {
  assert(!/Pro access|requires? (a )?plan|Pro plan/i.test(s), `no Pro wall: ${s}`);
  assert(!s.includes("\u2014"), `no em dash: ${s}`);
  assert(!s.includes("!"), `no exclamation mark: ${s}`);
  assert(!/\bAI\b/.test(s), `no standalone AI: ${s}`);
  assert(!/[\u{1F000}-\u{1FAFF}\u{FE0F}]/u.test(s), `no emoji: ${s}`);
}
console.log("ok      first run: home detection, the hold, chips, honest sign-in copy");
