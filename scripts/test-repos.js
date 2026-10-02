#!/usr/bin/env node
// The rules behind the Repositories sidebar, held without Electron, git or the
// network: the recent-workspaces store, owner/name out of a remote URL, where a
// clone may land, and how GitHub's answer becomes rows.
//
// Run: node scripts/test-repos.js

const assert = require("assert");
const path = require("path");
const os = require("os");
const R = require("../repos");

let failures = 0;
function check(name, fn) {
  try { const note = fn(); console.log(`ok      ${name}${note ? " - " + note : ""}`); }
  catch (e) { failures++; console.log(`not ok  ${name}\n        ${e && e.message ? e.message : e}`); }
}

console.log("repositories");

// ─── Recent workspaces ───────────────────────────────────────────────────────

check("remembering a folder puts it first and keeps the rest in order", () => {
  let list = [];
  list = R.rememberWorkspace(list, "/w/a", 1000);
  list = R.rememberWorkspace(list, "/w/b", 2000);
  list = R.rememberWorkspace(list, "/w/c", 3000);
  assert.deepStrictEqual(list.map((r) => r.path), ["/w/c", "/w/b", "/w/a"]);
  assert.strictEqual(list[0].openedAt, 3000);
});

check("reopening a folder moves it to the top with a fresh time, not a second row", () => {
  let list = R.rememberWorkspace([], "/w/a", 1000);
  list = R.rememberWorkspace(list, "/w/b", 2000);
  list = R.rememberWorkspace(list, "/w/a/", 3000);
  assert.deepStrictEqual(list.map((r) => r.path), ["/w/a", "/w/b"]);
  assert.strictEqual(list[0].openedAt, 3000);
  return "trailing slash collapses";
});

check(`the store holds ${R.MAX_RECENT} and drops the oldest`, () => {
  let list = [];
  for (let i = 0; i < R.MAX_RECENT + 5; i++) list = R.rememberWorkspace(list, `/w/${i}`, i + 1);
  assert.strictEqual(list.length, R.MAX_RECENT);
  assert.strictEqual(list[0].path, `/w/${R.MAX_RECENT + 4}`);
  assert.strictEqual(list[list.length - 1].path, "/w/5");
});

check("a hand-edited store is sanitized on read: junk rows dropped, duplicates collapsed, newest first, cap held", () => {
  const junk = [null, 4, { path: 7 }, { path: "" }, { path: "/w/old", openedAt: 10 }, { path: "/w/new", openedAt: 20 },
    { path: "/w/old/", openedAt: "x" }, ...Array.from({ length: 30 }, (_, i) => ({ path: `/w/n${i}`, openedAt: 5 }))];
  const list = R.sanitizeRecent(junk);
  assert.strictEqual(list.length, R.MAX_RECENT);
  assert.deepStrictEqual(list.slice(0, 2).map((r) => r.path), ["/w/new", "/w/old"]);
  assert.strictEqual(list.filter((r) => r.path === "/w/old").length, 1);
  assert.deepStrictEqual(R.sanitizeRecent("nope"), []);
});

check("forgetting a folder removes exactly that row", () => {
  let list = R.rememberWorkspace([], "/w/a", 1);
  list = R.rememberWorkspace(list, "/w/b", 2);
  assert.deepStrictEqual(R.forgetWorkspace(list, "/w/a/").map((r) => r.path), ["/w/b"]);
  assert.deepStrictEqual(R.forgetWorkspace(list, "/w/zzz").map((r) => r.path), ["/w/b", "/w/a"]);
});

check("a tilde path is a home path", () => {
  const list = R.rememberWorkspace([], "~/proj", 1);
  assert.strictEqual(list[0].path, path.join(os.homedir(), "proj"));
});

// ─── Remote parsing ──────────────────────────────────────────────────────────

const REMOTES = {
  "https://github.com/MichaelCrowe11/crowe-logic-desktop.git": ["github.com", "MichaelCrowe11", "crowe-logic-desktop", true],
  "https://github.com/MichaelCrowe11/crowe-logic-desktop": ["github.com", "MichaelCrowe11", "crowe-logic-desktop", true],
  "https://github.com/MichaelCrowe11/crowe-logic-desktop/": ["github.com", "MichaelCrowe11", "crowe-logic-desktop", true],
  "git@github.com:MichaelCrowe11/crowe-logic-desktop.git": ["github.com", "MichaelCrowe11", "crowe-logic-desktop", true],
  "git@github.com:MichaelCrowe11/crowe-logic-desktop": ["github.com", "MichaelCrowe11", "crowe-logic-desktop", true],
  "ssh://git@github.com/MichaelCrowe11/crowe-logic-desktop.git": ["github.com", "MichaelCrowe11", "crowe-logic-desktop", true],
  "ssh://git@github.com:22/owner/name.git": ["github.com", "owner", "name", true],
  "git://github.com/owner/name.git": ["github.com", "owner", "name", true],
  "https://user:secret@github.com/owner/name.git": ["github.com", "owner", "name", true],
  "https://GitHub.com/owner/name.git": ["github.com", "owner", "name", true],
  "https://gitlab.example.com/group/sub/name.git": ["gitlab.example.com", "sub", "name", false],
  "git@ghe.corp.example:team/.github.git": ["ghe.corp.example", "team", ".github", false],
};
check("owner/name is read from https, scp-like and ssh remotes, credentials dropped", () => {
  for (const [url, [host, owner, name, github]] of Object.entries(REMOTES)) {
    const r = R.parseRemote(url);
    assert(r, `${url} did not parse`);
    assert.deepStrictEqual([r.host, r.owner, r.name, r.github], [host, owner, name, github], url);
    assert.strictEqual(r.full, `${owner}/${name}`);
    assert(!JSON.stringify(r).includes("secret"), "credentials leaked into the parsed remote");
  }
  return `${Object.keys(REMOTES).length} spellings`;
});

check("a remote that is not a repository address is null, not a guess", () => {
  for (const bad of ["", "   ", "github.com", "https://github.com/", "https://github.com/only-owner", "C:\\repos\\thing",
    "file:///tmp/repo.git", "ftp://github.com/a/b.git", "https://github.com/a/b%2F..%2Fc", "https://github.com/a/b/c%00"]) {
    assert.strictEqual(R.parseRemote(bad), null, `${JSON.stringify(bad)} should be null`);
  }
});

// ─── Clone target and URL ────────────────────────────────────────────────────

check("a clone lands at <root>/<owner>/<name> and nowhere else", () => {
  assert.strictEqual(R.cloneTarget("/r", "owner", "name"), path.join("/r", "owner", "name"));
  assert.strictEqual(R.cloneTarget("~/Crowe/repos", "o", "n"), path.join(os.homedir(), "Crowe", "repos", "o", "n"));
  assert.strictEqual(R.cloneTarget("", "o", "n"), path.join(R.defaultReposRoot(), "o", "n"));
  for (const [o, n] of [["..", "x"], ["x", ".."], [".", "x"], ["a/b", "x"], ["x", "a\\b"], ["", "x"], ["x", ""], ["x", "name."],
    ["x", "name "], ["x", "n".repeat(101)], ["o", "n:m"], ["o", "$(id)"]]) {
    assert.strictEqual(R.cloneTarget("/r", o, n), null, `${o}/${n} should be refused`);
  }
});

check("the clone URL is built from the validated segments, never taken from a caller", () => {
  assert.strictEqual(R.cloneUrl("owner", "name"), "https://github.com/owner/name.git");
  assert.strictEqual(R.cloneUrl("owner", "../evil"), null);
  assert.strictEqual(R.cloneUrl("", "name"), null);
});

// ─── GitHub rows ─────────────────────────────────────────────────────────────

check("repository rows carry the PR count and the check marker, and only a failure is a failure", () => {
  const node = (name, state, pulls, extra = {}) => ({
    nameWithOwner: `crowe/${name}`, name, owner: { login: "crowe" }, url: `https://github.com/crowe/${name}`,
    isPrivate: false, isArchived: false, pushedAt: "2026-09-12T10:00:00Z",
    pullRequests: { totalCount: pulls },
    defaultBranchRef: state === undefined ? null : { name: "main", target: { statusCheckRollup: state === null ? null : { state } } },
    ...extra,
  });
  const rows = R.repoRows({ viewer: { repositories: { nodes: [
    node("red", "FAILURE", 3), node("err", "ERROR", 0), node("green", "SUCCESS", 1), node("wait", "PENDING", 0),
    node("bare", null, 0), node("empty", undefined, 0), null, { nameWithOwner: "x/y", name: "", owner: null },
  ] } } });
  assert.deepStrictEqual(rows.map((r) => [r.full, r.checks, r.openPulls]), [
    ["crowe/red", "failed", 3], ["crowe/err", "failed", 0], ["crowe/green", "passed", 1], ["crowe/wait", "pending", 0],
    ["crowe/bare", "none", 0], ["crowe/empty", "none", 0],
  ]);
  assert.strictEqual(rows[0].pushedAt, Date.parse("2026-09-12T10:00:00Z"));
  assert.strictEqual(rows[5].defaultBranch, "");
  assert.deepStrictEqual(R.repoRows(null), []);
});

check("work rows keep the text a task needs and cap the body", () => {
  const w = R.workRows({ repository: { nameWithOwner: "crowe/x", url: "https://github.com/crowe/x",
    pullRequests: { totalCount: 1, nodes: [{ number: 7, title: "Fix", url: "u", isDraft: true, updatedAt: "2026-09-01T00:00:00Z",
      author: { login: "mc" }, headRefName: "fix", baseRefName: "main", body: "b".repeat(R.BODY_MAX + 50) }] },
    issues: { totalCount: 2, nodes: [{ number: 9, title: "Bug", url: "v", updatedAt: "2026-09-02T00:00:00Z", author: null,
      labels: { nodes: [{ name: "bug" }, null, { name: "" }] }, body: null }, null] } } });
  assert.strictEqual(w.pullCount, 1); assert.strictEqual(w.issueCount, 2);
  assert.strictEqual(w.pulls[0].body.length, R.BODY_MAX);
  assert.deepStrictEqual([w.pulls[0].kind, w.pulls[0].draft, w.pulls[0].head, w.pulls[0].author], ["pull", true, "fix", "mc"]);
  assert.deepStrictEqual([w.issues[0].kind, w.issues[0].author, w.issues[0].labels, w.issues[0].body], ["issue", "", ["bug"], ""]);
  assert.strictEqual(w.issues.length, 1);
  assert.strictEqual(R.workRows({}), null);
});

check("the GitHub queries are queries", () => {
  for (const q of [R.REPOS_QUERY, R.WORK_QUERY]) {
    assert(/^\s*query\b/.test(q), "must start with query");
    assert(!/\bmutation\b/.test(q), "must not carry a mutation");
  }
});

if (failures) { console.log(`\n${failures} repository check(s) failed`); process.exit(1); }
console.log("\nall repository checks passed");
