// The GitHub plugin failed with "could not start: spawn failed" in the packaged
// app because a Finder launch has no npx on PATH. These checks pin the resolver
// that now finds the user's tools and names the binary when it cannot.
const assert = require("assert");
const { loginShellPath, findOnPath, pluginSpawnEnv, KNOWN_TOOL_DIRS } = require("../harness");

assert.strictEqual(findOnPath("sh", "/bin:/usr/bin"), "/bin/sh", "finds a binary on an explicit PATH");
assert.strictEqual(findOnPath("no-such-binary-crowe", "/bin:/usr/bin"), null, "returns null when the binary is absent");
assert.strictEqual(findOnPath("/bin/sh", ""), "/bin/sh", "an absolute path is checked directly");
assert.strictEqual(findOnPath("/nonexistent/sh", "/bin"), null, "an absent absolute path is null");
assert.strictEqual(findOnPath("", "/bin"), null, "an empty command is null");

const fallback = loginShellPath({ shell: "/nonexistent/shell", fresh: true });
for (const dir of KNOWN_TOOL_DIRS) assert(fallback.split(":").includes(dir), `fallback PATH keeps ${dir}`);

const real = loginShellPath({ fresh: true });
assert(real.split(":").includes("/usr/bin"), "login shell PATH includes /usr/bin");
assert(!/(^|:)(:|$)/.test(real), "no empty PATH entries");
assert.strictEqual(new Set(real.split(":")).size, real.split(":").length, "PATH entries are unique");

process.env.CROWE_TEST_TOKEN = "must-not-leak";
const env = pluginSpawnEnv({ GITHUB_PERSONAL_ACCESS_TOKEN: "x" });
assert.strictEqual(env.PATH, loginShellPath(), "plugin env carries the login shell PATH");
assert.strictEqual(env.GITHUB_PERSONAL_ACCESS_TOKEN, "x", "plugin env keeps the plugin's own variables");
assert(!("CROWE_TEST_TOKEN" in env), "plugin env drops sensitive variables like the agent shell does");
delete process.env.CROWE_TEST_TOKEN;

assert.strictEqual(findOnPath("npx", "/usr/bin:/bin:/usr/sbin:/sbin"), null, "launchd PATH has no npx (the original failure)");
if (findOnPath("npx", process.env.PATH || "")) assert(findOnPath("npx", real), "login shell PATH finds npx when the dev shell does");

console.log("ok      plugin spawn path: login shell PATH resolved, npx named when missing");
