// Gate 4: a private tree per agent, and merges that land one at a time.
//
// This is the gate the build order calls hard, and the reason is not tidiness.
// Three agents editing one checkout concurrently is not a merge conflict, it is
// a corrupted working tree: two of them read a file, both write it, and the
// last writer wins silently. Nothing in the app can recover that by looping,
// because there is no record of what the losers meant to do. So a room that may
// write does not share a tree at all.
//
// The shape is git's own: `git worktree add` gives each agent a checkout of the
// same repository on its own branch, sharing one object store. The agent works
// there, its result is a diff against the room's base, and the operator merges
// diffs one at a time with a review in between. That last part is the point -
// the app's promise is that edits land where the user watched them land, and a
// room must not quietly become the exception.
//
// `git` is injected rather than imported so the mechanics are decidable in a
// test without a repository, which is how the ordering rules below are checked.

const path = require("path");

// Branch and directory names carry the room and the agent, because a stray
// worktree found a week later should say what made it.
const SLUG = /[^a-zA-Z0-9._-]+/g;
const slug = (s) => String(s || "").replace(SLUG, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "x";

function branchFor(roomId, agentId) { return `crowe/room-${slug(roomId)}/${slug(agentId)}`; }
function dirFor(base, roomId, agentId) { return path.join(base, `${slug(roomId)}--${slug(agentId)}`); }

/* One tree per agent, created from the room's base commit.

   Created lazily and only for agents that may actually write: a plan-tier seat
   in a write-capable room has nothing to isolate, and a worktree per idle agent
   is disk and cleanup for nothing. */
async function ensureTree(ctx, agentId) {
  const { git, roomId, baseRef, root } = ctx;
  if (ctx.trees[agentId]) return ctx.trees[agentId];

  const dir = dirFor(root, roomId, agentId);
  const branch = branchFor(roomId, agentId);
  // -B so a re-opened room reuses its branch rather than failing on a name it
  // already took. The worktree add is what fails if the directory is live, and
  // that failure is worth surfacing rather than working around.
  const add = await git(`worktree add -B ${branch} ${q(dir)} ${q(baseRef)}`);
  if (!add.ok) return { error: `could not isolate ${agentId}: ${(add.err || "").trim().split("\n")[0] || "worktree add failed"}` };

  const tree = { agentId, dir, branch, base: baseRef, merged: false };
  ctx.trees[agentId] = tree;
  return tree;
}

// What an agent changed, as a diff against the base it started from. This is
// the reviewable artifact; nothing merges without one being producible.
async function diffOf(ctx, agentId) {
  const tree = ctx.trees[agentId];
  if (!tree) return { error: `${agentId} has no isolated tree` };
  const add = await ctx.git(`-C ${q(tree.dir)} add -A`);
  if (!add.ok) return { error: `could not stage ${agentId}'s work` };
  const d = await ctx.git(`-C ${q(tree.dir)} diff --cached --stat`);
  const patch = await ctx.git(`-C ${q(tree.dir)} diff --cached`);
  return { agentId, branch: tree.branch, stat: (d.out || "").trim(), patch: patch.out || "", empty: !(patch.out || "").trim() };
}

/* Merges land one at a time, and only after the operator has seen the diff.

   `merge` refuses a second merge while one is unreviewed, which is the rule
   that makes "one agent at a time" true rather than aspirational: without it,
   three agents finishing together would race to the same branch and reproduce
   the corruption the worktrees were meant to prevent - just one level up.

   A merge that conflicts is not resolved here. It is reported, the tree is left
   standing, and the operator decides. An agent's work is never silently
   dropped, because the whole reason it ran in its own tree is that its output
   was worth keeping. */
async function merge(ctx, agentId) {
  const tree = ctx.trees[agentId];
  if (!tree) return { error: `${agentId} has no isolated tree` };
  if (tree.merged) return { error: `${agentId}'s work is already merged` };
  if (ctx.merging) return { error: `${ctx.merging} is mid-merge; land one agent's work before starting another` };

  const d = await diffOf(ctx, agentId);
  if (d.error) return d;
  if (d.empty) { tree.merged = true; return { agentId, empty: true, note: `${agentId} changed nothing` }; }
  if (!tree.reviewed) return { error: `${agentId}'s diff has not been reviewed`, needsReview: true, diff: d };

  ctx.merging = agentId;
  try {
    const commit = await ctx.git(`-C ${q(tree.dir)} commit -m ${q(`room ${ctx.roomId}: ${agentId}`)}`);
    if (!commit.ok) return { error: `could not commit ${agentId}'s work` };
    const m = await ctx.git(`merge --no-ff ${q(tree.branch)} -m ${q(`room ${ctx.roomId}: land ${agentId}`)}`);
    if (!m.ok) {
      // Left standing on purpose: the branch still holds the work, and the
      // operator can resolve it with the diff in front of them.
      return { error: `${agentId}'s work conflicts with the workspace`, conflict: true, branch: tree.branch };
    }
    tree.merged = true;
    return { agentId, merged: true, branch: tree.branch, stat: d.stat };
  } finally { ctx.merging = ""; }
}

// Marking a diff reviewed is the operator's act, and it is per agent. Reviewing
// one agent's work says nothing about the others'.
function markReviewed(ctx, agentId) {
  const tree = ctx.trees[agentId];
  if (!tree) return { error: `${agentId} has no isolated tree` };
  tree.reviewed = true;
  return { agentId, reviewed: true };
}

/* Cleanup removes the checkout and leaves the branch.

   Deliberately asymmetric: a worktree is a directory the app made and can
   safely take back, but the branch is the only record of what an agent did.
   Deleting both on close would mean a room that was closed before its diffs
   were landed destroyed the work it just paid for. */
async function release(ctx, { keepBranches = true } = {}) {
  const out = [];
  for (const tree of Object.values(ctx.trees)) {
    const r = await ctx.git(`worktree remove --force ${q(tree.dir)}`);
    out.push({ agentId: tree.agentId, removed: r.ok, branch: tree.branch, kept: keepBranches });
    if (!keepBranches && tree.merged) await ctx.git(`branch -D ${q(tree.branch)}`);
  }
  ctx.trees = {};
  return out;
}

function q(s) { return "'" + String(s == null ? "" : s).replace(/'/g, "'\\''") + "'"; }

// A room's isolation context. `root` is where the trees are made, which is
// outside the workspace so a worktree never appears in the tree it isolates.
function isolation({ git, roomId, baseRef = "HEAD", root }) {
  return { git, roomId, baseRef, root, trees: {}, merging: "" };
}

module.exports = { isolation, ensureTree, diffOf, merge, markReviewed, release, branchFor, dirFor };
