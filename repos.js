// Repositories: the rules behind the sidebar's repository list.
//
// Everything here is decidable without Electron, git or the network, which is
// what lets scripts/test-repos.js hold it: which folders the app remembers and
// in what order, how a remote URL becomes owner/name, where a clone may land,
// and how GitHub's answer becomes rows. main.js owns the side effects (git, the
// folder dialog, the token, the approval gate); this file owns the rules.
"use strict";

const path = require("path");
const os = require("os");

// Twenty is what a sidebar can show before it is a search problem. Older rows
// fall off the end rather than being pruned by age, so a folder someone opens
// every week stays put however long ago the others were touched.
const MAX_RECENT = 20;

function defaultReposRoot() { return path.join(os.homedir(), "Crowe", "repos"); }

function normalizePath(p) {
  let s = String(p || "").trim();
  if (!s) return "";
  s = s.replace(/^~(?=$|\/)/, os.homedir());
  s = path.resolve(s);
  // /a/b and /a/b/ are one folder, not two rows.
  return s.length > 1 ? s.replace(/[\\/]+$/, "") : s;
}

/* The store is read from config on every call rather than trusted: a hand-edited
   config, or one written by a later version, can carry anything. Rows without a
   usable path are dropped, duplicates collapse to one, the newest comes first,
   and the cap holds on read as well as on write. */
function sanitizeRecent(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const dir = r && typeof r.path === "string" ? normalizePath(r.path) : "";
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const at = Number(r.openedAt);
    out.push({ path: dir, openedAt: Number.isFinite(at) && at > 0 ? at : 0 });
  }
  out.sort((a, b) => b.openedAt - a.openedAt);
  return out.slice(0, MAX_RECENT);
}

function rememberWorkspace(list, p, now = Date.now()) {
  const dir = normalizePath(p);
  if (!dir) return sanitizeRecent(list);
  const rest = sanitizeRecent(list).filter((r) => r.path !== dir);
  return [{ path: dir, openedAt: now }, ...rest].slice(0, MAX_RECENT);
}

function forgetWorkspace(list, p) {
  const dir = normalizePath(p);
  return sanitizeRecent(list).filter((r) => r.path !== dir);
}

// One path segment GitHub could have named and a filesystem can hold. A closed
// set on purpose: these become directory names under the clone root.
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/;
function safeSegment(s) {
  const v = String(s || "");
  return SEGMENT_RE.test(v) && v !== "." && v !== ".." && !/[. ]$/.test(v);
}

/* owner/name out of whatever `git remote get-url origin` said.

   Four spellings are in real use for one repository: https with or without
   .git, the scp-like git@host:owner/name.git, and ssh:// or git:// URLs. Any
   credentials in the URL are dropped on the floor here and never returned. The
   host comes back so a GitHub Enterprise remote is still owner/name in the
   sidebar, but `github` is what decides whether the GitHub lanes apply. */
function parseRemote(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  let host = "", rest = "";
  const scp = /^(?:[\w.-]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(s);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    host = scp[1]; rest = scp[2];
  } else {
    let u;
    try { u = new URL(s); } catch { return null; }
    if (!/^(https?|ssh|git|git\+ssh):$/.test(u.protocol)) return null;
    host = u.hostname; rest = u.pathname;
  }
  const parts = rest.replace(/^\/+/, "").replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[parts.length - 2];
  const name = parts[parts.length - 1].replace(/\.git$/i, "");
  if (!safeSegment(owner) || !safeSegment(name)) return null;
  host = host.toLowerCase();
  return { host, owner, name, full: `${owner}/${name}`, github: host === "github.com" };
}

// Where a clone of owner/name lands: <root>/<owner>/<name>. Null when either
// segment is not something this app will make a directory out of.
function cloneTarget(root, owner, name) {
  if (!safeSegment(owner) || !safeSegment(name)) return null;
  const base = normalizePath(root || defaultReposRoot());
  const target = path.join(base, owner, name);
  if (!target.startsWith(base + path.sep)) return null;
  return target;
}

// The URL main clones from is built here from the two validated segments, never
// taken from the renderer: an approval card that names one repository while
// git fetches another is the failure this closes.
function cloneUrl(owner, name) {
  if (!safeSegment(owner) || !safeSegment(name)) return null;
  return `https://github.com/${owner}/${name}.git`;
}

// ─── GitHub, read-only ───────────────────────────────────────────────────────
/* One GraphQL query answers what the sidebar shows for every repository the
   token can see: name, open pull request count, and whether the default
   branch's latest check rollup failed. The MCP server this app ships for GitHub
   has no tool for a branch's checks and none for "my repositories", and the PR
   count alone would be one call per repository, so the UI reads GitHub itself.
   Queries only; nothing here mutates. */
const REPOS_QUERY = `query($n: Int!) {
  viewer { login
    repositories(first: $n, orderBy: {field: PUSHED_AT, direction: DESC},
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) {
      totalCount
      nodes { nameWithOwner name owner { login } url isPrivate isArchived pushedAt
        pullRequests(states: OPEN) { totalCount }
        defaultBranchRef { name target { ... on Commit { statusCheckRollup { state } } } } } } } }`;

const WORK_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) { nameWithOwner url
    pullRequests(first: $n, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) { totalCount
      nodes { number title url isDraft updatedAt author { login } headRefName baseRefName body } }
    issues(first: $n, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) { totalCount
      nodes { number title url updatedAt author { login } labels(first: 6) { nodes { name } } body } } } }`;

// FAILURE and ERROR are the marker. PENDING and EXPECTED are in flight. No
// rollup at all (no checks configured, or a token that cannot read them) is
// "none", which is not the same thing as passed and is never drawn as such.
function checkState(state) {
  const s = String(state || "").toUpperCase();
  if (s === "FAILURE" || s === "ERROR") return "failed";
  if (s === "SUCCESS") return "passed";
  if (s === "PENDING" || s === "EXPECTED") return "pending";
  return "none";
}

function repoRows(data) {
  const nodes = (data && data.viewer && data.viewer.repositories && data.viewer.repositories.nodes) || [];
  return nodes.filter(Boolean).map((r) => ({
    owner: (r.owner && r.owner.login) || "",
    name: r.name || "",
    full: r.nameWithOwner || "",
    url: r.url || "",
    private: Boolean(r.isPrivate),
    archived: Boolean(r.isArchived),
    pushedAt: r.pushedAt ? Date.parse(r.pushedAt) || 0 : 0,
    openPulls: (r.pullRequests && r.pullRequests.totalCount) || 0,
    defaultBranch: (r.defaultBranchRef && r.defaultBranchRef.name) || "",
    checks: checkState(r.defaultBranchRef && r.defaultBranchRef.target && r.defaultBranchRef.target.statusCheckRollup
      && r.defaultBranchRef.target.statusCheckRollup.state),
  })).filter((r) => r.owner && r.name);
}

// Bodies ride along because Start task seeds a session with them. Capped here,
// once, so neither the IPC payload nor the first prompt grows with a novel.
const BODY_MAX = 6000;
function workRows(data) {
  const repo = data && data.repository;
  if (!repo) return null;
  const who = (a) => (a && a.login) || "";
  const when = (s) => (s ? Date.parse(s) || 0 : 0);
  return {
    full: repo.nameWithOwner || "",
    url: repo.url || "",
    pullCount: (repo.pullRequests && repo.pullRequests.totalCount) || 0,
    issueCount: (repo.issues && repo.issues.totalCount) || 0,
    pulls: ((repo.pullRequests && repo.pullRequests.nodes) || []).filter(Boolean).map((p) => ({
      kind: "pull", number: p.number, title: p.title || "", url: p.url || "", draft: Boolean(p.isDraft),
      updatedAt: when(p.updatedAt), author: who(p.author), head: p.headRefName || "", base: p.baseRefName || "",
      body: String(p.body || "").slice(0, BODY_MAX),
    })),
    issues: ((repo.issues && repo.issues.nodes) || []).filter(Boolean).map((i) => ({
      kind: "issue", number: i.number, title: i.title || "", url: i.url || "",
      updatedAt: when(i.updatedAt), author: who(i.author),
      labels: ((i.labels && i.labels.nodes) || []).map((l) => l && l.name).filter(Boolean),
      body: String(i.body || "").slice(0, BODY_MAX),
    })),
  };
}

module.exports = {
  MAX_RECENT, BODY_MAX, defaultReposRoot, normalizePath, sanitizeRecent, rememberWorkspace, forgetWorkspace,
  safeSegment, parseRemote, cloneTarget, cloneUrl, REPOS_QUERY, WORK_QUERY, checkState, repoRows, workRows,
};
