// A fresh install booted into the home folder and told the user Pro was
// required. These pin the pure half of the first-run fixes.
const assert = require("assert");
const F = require("../renderer/first-run");
assert.strictEqual(F.workspaceIsHome("/Users/x", "/Users/x"), true);
assert.strictEqual(F.workspaceIsHome("/Users/x/", "/Users/x"), true, "a trailing slash is the same folder");
assert.strictEqual(F.workspaceIsHome("/Users/x/proj", "/Users/x"), false);
assert.strictEqual(F.workspaceIsHome("", "/Users/x"), false);
assert.strictEqual(F.workspaceIsHome("/Users/x", ""), false);
const home = F.welcomeChips(true), proj = F.welcomeChips(false);
assert.strictEqual(home.length, 3); assert.strictEqual(proj.length, 3);
assert.strictEqual(home[0].action, "open-folder", "at home the first chip opens a folder");
assert.strictEqual(proj[0].action, "send");
assert.strictEqual(proj[0].text, "List the files here and summarize the project");
assert(!/Pro access unlocks/.test(F.SIGN_IN_COPY), "no Pro wall in the sign-in copy");
assert(/free tier/.test(F.SIGN_IN_COPY) && /no card/.test(F.SIGN_IN_COPY));
assert(/free tier/.test(F.ONBOARDING_STEP_SIGN_IN));
assert(/home folder/.test(F.FILES_EMPTY_HOME));
for (const s of [F.SIGN_IN_COPY, F.ONBOARDING_STEP_SIGN_IN, F.FILES_EMPTY_HOME]) { assert(!s.includes("—"), "no em dash"); assert(!/\bAI\b/.test(s)); }
console.log("ok      first run: home detection, chips, honest sign-in copy");
