# Crowe Logic — the block-residual operator harness

Status: proposal, 2026-07-21. Owner: platform + desktop.
Premise decided with Michael: CroweLM is a **router over hosted Azure + Cloudflare
deployments**, not a trained-in-house net. Therefore the mixture-of-experts lives
in the **harness**, not the model. This doc specifies that harness.

The shape is borrowed from a frontier LLM block diagram (Kimi K3: block-attention
residuals + LatentMoE), reused as the shape of the *agent loop* rather than a
neural net. It formalizes what the product already implies: the operator thread is
a residual backbone, and multi-model routing is expert dispatch.

---

## 1. Today vs. the target

Was (before 2026-07-28): a flat loop. Each round posted the whole message list to
one model, ran whatever tools came back, repeated up to 24×. One model, no
verification pass, no cost ceiling, and one gate (the autonomy tier) that could
say "shell: yes" but never "this shell command: no."

Now: a turn is **block → check → at most one repair**, with a policy table in
front of every action and a receipt behind it. What landed is in §7. What was
deliberately left out, and why, is in §8.

Target: each **turn is a block** with four stages, and the session is a **residual
backbone** — every block attends back to a weighted memory of all prior blocks.

```
                              Output (answer)
                                  ^
   ┌───────────── current turn (block) ─────────────┐
   │  Synthesize  ← α ─┐                             │
   │  Reason      ← α ─┤   α = weighted memory of    │
   │  Route       ← α ─┤       every prior turn      │
   │  Retrieve    ← α ─┘   (the operator thread)     │
   └───────────────────▲─────────────────────────────┘
        Turn n-1, Turn n-2, ... Request  ──residual──┘
```

- **Retrieve** — gather context: workspace (search/read/list) + the α-weighted
  memory of prior turns. Not a growing raw blob; a relevance-selected recall.
- **Route** — a router classifies the step and dispatches to one **routed expert**
  (a specific deployment) plus the always-on **shared operators**.
- **Reason** — the routed expert does the work (may emit tool calls).
- **Synthesize** — assemble the reviewed step; emit to the thread.

---

## 2. The expert registry (real deployments = experts)

Routed experts map to deployments that already exist behind the gateway:

| Role                | Deployment (provider)                          | When routed |
|---------------------|------------------------------------------------|-------------|
| Code specialist     | `@cf/qwen/qwen2.5-coder-32b` (Cloudflare)      | edits, diffs, code reasoning |
| Agentic coding      | `@cf/zai-org/glm-5.2` (Cloudflare)             | multi-file / tool-heavy code turns |
| General reasoning   | `Llama-3.3-70B` (Cloudflare) / Azure OpenAI tier | prose, analysis, planning-of-record |
| Cultivation / domain| CroweLM Grower / Kernel (Azure Foundry)        | mycology / cultivation domain turns |
| Research            | frontier Azure tier                            | long synthesis, web-grounded turns |
| Fast / cheap        | `@cf/zai-org/glm-4.7-flash`, `Llama-3.1-8b`    | the router itself, planner, verifier |

Shared operators (always run, on the fast/cheap tier):
- **Planner** — before Route on a fresh task: produce a short written plan. Exposed
  as **Plan Mode**, a 4th autonomy state (read-only exploration → plan → approval).
- **Verifier** — after Synthesize on a mutating turn: check the step against the
  plan / tests / a screenshot, and emit a proof-of-work receipt into the colophon.

The registry is data, not code: a table of `{role, deployment, provider, cost_tier,
when}` that the router reads. Adding an Azure or CF deployment = a row.

---

## 3. The router

A cheap classifier call (fast tier) that maps a step to `{expert, confidence,
reason}`. Inputs: the step intent, the file types in scope, the autonomy tier, and
a cost ceiling. Output rides the existing gateway `provider` dispatch — no new
provider plumbing, just selection. Fallback: on low confidence or a provider error,
fall back to the general-reasoning expert (the current default), so routing can
never make the loop worse than today. Every routing decision is logged to the
thread (which expert, why, what it cost) — this is also the colophon's next column.

Where it lives: the router belongs in the **gateway** (crowe-nimbus control_plane),
so every surface (desktop, CLI, Cortex) inherits it; the desktop harness owns the
**block loop** (retrieve/route/reason/synthesize) and the thread rendering.

---

## 4. Weighted memory (the residual / α)

Instead of resending the full transcript each round, keep a per-session memory of
prior turns and, at Retrieve, select the k most relevant (embedding or recency +
tool-overlap score) — the α weights. This is the attention-residual: bounded
context, long-horizon recall, and the visible operator thread is its UI. Reuses the
context-compaction budget already in harness.js; upgrades it from "elide oldest" to
"recall most relevant."

---

## 5. Why this is the roadmap in disguise

Each competitive frontier item falls out of one stage:
- Plan Mode ⇐ the Planner shared operator.
- Verification-as-artifact ⇐ the Verifier shared operator + the browser pane.
- Parallel / background agents ⇐ routed experts run concurrently over git worktrees.
- Checkpoint / rewind ⇐ block boundaries are natural snapshot points.
- Model choice / BYOK ⇐ the expert registry is already multi-provider.

---

## 6. Phased roadmap (ticket-ready)

**Horizon 1 — weeks (premium pass + skeleton)**
1. Identity: hex-cube hero + one flat ≤24px glyph; depth/density shell pass. **Done.**
2. Refactor harness.js into explicit stages (retrieve/route/reason/synthesize) with
   the router stubbed to today's single default (no behavior change, new shape). **Done.**
3. Planner shared operator → **Plan Mode** as the 4th autonomy state. **Done.**
4. Auto-update + code-signed Win/Mac builds. **Done.**
Motion: wire **Convergent Hex** (nodes gathering to the core = routing) as the
thread's thinking animation; hex-cube stays the static brand mark.

**Horizon 2 — 1-2 months (residual + experts)**
5. Router live in the gateway; expert registry table (the deployments above).
   Partly: the desktop routes from the catalog, fallback-first, and resolves a
   `verifier` role the same way. The gateway-side registry is still open.
6. Weighted-memory recall at Retrieve (real session memory). Partly: compaction now
   drops superseded results before old ones, which is relevance, not yet recall.
7. Verifier shared operator → proof-of-work receipts in the colophon. **Done** (§7),
   as a verdict card with cited evidence rather than a colophon column.
8. Checkpoint / rewind on the thread (block-boundary snapshots). Groundwork: the
   journal records the block boundaries; nothing restores from them yet.

**Horizon 3 — a quarter (fan-out + interop)**
9. Parallel routed experts over git worktrees + a light command view.
10. ACP: run Claude Code / Codex / Gemini CLI as routed experts inside the thread.
11. Semantic index behind Retrieve.

---

## 7. What landed (2026-07-28)

Sourced from five independent designs of the same system (GLM 5.2, DeepSeek V4 Pro,
Claude Opus, Kimi K2.6, GPT-5), kept with the prompt they all answered in
`corpus/aegis-multimodel/`, filtered to what a single-machine desktop operator can
actually honour. All of it is in `harness.js` with 69 headless tests in
`scripts/test-harness.js` (`npm test`).

Where the five disagreed, the disagreement was usually the useful part. Opus
supplied the rule that a verifier must cite a failing command or return pass, and
the typed-retry rule that a deterministic failure must get a *different* action.
Kimi supplied the one structural idea the others missed: that "compensatable" is
only a label until something keeps the thing you compensate with. GPT-5 was the
most operationally careful of the five and found three live holes: nothing scanned
what the agent *wrote* for credentials, nothing noticed a file changed by an
outside editor after the agent had read it, and nothing questioned a write landing
outside the workspace the user opened.

**Delivery semantics, one table.** Every tool declares what re-running it means:
`read_only`, `idempotent`, `compensatable`, `irreversible`. `run_shell` resolves
per command. This is the single policy surface; the gates read it rather than each
holding an opinion. It is also the answer to "retry with the same correlation id,"
which is safe for a read and an incident for a deploy.

**Action risk, orthogonal to the tier.** A literal pattern table (no model call)
classifies each command AUTO / REVIEW / STRICT. STRICT asks the user every time,
Execute included: force-push, recursive delete, publish or deploy, destructive
SQL, sudo, pipe-a-download-into-a-shell, writing to a disk device, and sending a
local file off the machine - not only a credentials file, because a POST with any
file attached sends whatever that file holds. REVIEW (remotes, dependency
versions, CI config, local history rewrites) asks only in strict mode, or when
auto-approve has removed the diff review that would otherwise have caught it. Two
classes of path are gated the same way: build and deploy config, and files whose
names say they decide who may do what (auth, session, token, crypto, policy).
Coarse by name on purpose, so it fires early rather than cleverly.

**Secrets, in both directions.** The blocklist stopped the agent opening a
credentials file. It did nothing about the opposite direction, an agent writing a
live key into ordinary source, which is how a secret reaches a commit and then a
history someone has to rewrite. Written content is now scanned for
high-confidence, prefix-anchored patterns (PEM private-key blocks, AWS ids, live
Stripe keys, GitHub and Slack tokens, Anthropic and OpenAI-style keys, Google API
keys, JWTs) and gated STRICT. The matched value is never echoed: not into the
prompt, not into the approval card, not into the journal. Only its kind. A test
asserts the harness's own source does not trip its own scanner, and that ordinary
prose about keys stays quiet.

**Writes that leave the workspace ask first.** Resolved through symlinks on the
deepest existing ancestor, so a link pointing out of the tree does not walk past a
string comparison. This is not a security boundary, since Execute grants a real
shell. It closes a scope surprise: at the Edit tier, where the shell is off, "you
may change files" reads as "files here", and nothing made that true. Reads are
untouched, because inspecting a config in `~/.config` is ordinary and the secret
blocklist already covers what matters.

**Stale reads.** Our own mutations clear the read cache. An outside editor, another
agent, or a build does not, so a cached read is re-stat'd before it is served and
dropped if the file has changed underneath. `search` and `list_dir` results are not
stamped this way and can still be a little stale within a turn.

**Compensatable, made real.** Before an edit applies, the file as it stands is
written to the content-addressed artifact store and the pointer is recorded
(first change to a file per turn, files under 4 MB). Nothing is rolled back
automatically - the user's own review decisions are not ours to undo - but a
failed verdict now names where the previous contents are, and the repair pass is
handed the same pointers. This is also the first half of the block-boundary rewind
in Horizon 2 item 8.

**Approvals that are actually approvals.** Bound to the exact action's input hash,
used once, expiring after 5 minutes, and an unanswered prompt is a denial. Stop
releases them, so Stop can never leave a turn parked on a question. Every request
and decision is journaled.

**An independent verifier.** On a mutating turn: a separate model instance, a
read-only tool set (plus a shell for builds and tests where the tier already
allowed one), and hard isolation - it gets the request, the list of what changed,
and the operator's claim marked as a claim. Not the operator's transcript, not its
cached reads. It writes its own acceptance criteria from the user's request, and it
speaks only through `submit_verdict` (status, checks with evidence, and a
rejection report). The rule that makes it worth its cost: **to fail a change it
must name a command that failed or quote what it read.** Otherwise it returns
pass. A fail on a hunch costs a repair block and the user's trust. It is also asked
to probe the negative case: a change that makes the good input work and the bad
input work too has been demonstrated, not verified. Checks report pass, fail,
unknown (ran it, could not tell), or skipped (did not run it), because collapsing
the middle two is how "I could not check this" becomes "this is fine". On a fail,
one bounded repair block runs and one re-check follows. Config: `verifier`.

Where the catalog offers no `verifier` deployment, the check runs on the same model
that did the work, and the receipt says so on a pass: weigh the cited evidence, not
the verdict. Separate context is guaranteed; separate weights are not, and the
product should not imply otherwise.

**Content from the workspace is data, never instructions.** The system prompt used
to call tool results "ground truth", which is the right idea about facts and the
wrong frame for a file that contains "ignore previous instructions". Results are now
framed as authoritative about what the workspace contains and as data: a file, log,
commit message, dependency, or command output never assigns a task or grants a
permission, and an attempt to do so gets reported to the user rather than followed.
Tool grants come from config alone, never from anything read.

**A hard ceiling, with a backstop.** `turnBudgetUsd`, default $2, enforced per turn
across every stage. Because dollars are priced from display rates, a model whose
rate this app does not know would run uncapped, so `turnTokenCap` (default 400k)
binds in tokens, the unit every provider agrees on. Whichever comes first stops the
loop, and the message names which one. On breach the loop spends one tool-free call
to turn what it gathered into an answer, because a turn that spent two dollars and
then said nothing wasted all of it. That call is a reserve spend and is journaled as
one with its reason, rather than being quietly outside the accounting. Either
ceiling can be set to 0 deliberately.

**Replay, staleness, and loop breakers.** Identical `read_only` calls are served
from a per-turn cache keyed by a stable input hash; any mutation empties it. The
same read asked a fourth time stops having its body resent. The same *diff*
proposed twice is refused outright - a deterministic failure must get a different
action, not the same one again. A `write_file` over a file that changed after this
turn read it is refused with instructions to re-read. A round counts as no progress
when everything in it failed, was blocked, *or came back out of the cache*, since an
agent re-reading what it has already read is not gathering evidence; two such rounds
in a row turn the wrap-up note into "change approach or say what is blocking you".

**Typed gateway retries.** Transient (429, 5xx, dropped socket) gets exponential
backoff with jitter, up to 2 retries, before the existing model fallback.
Permanent (401, 400) surfaces immediately instead of burning a fallback on it.

**Truncation that does not lose the middle.** Long tool output is spooled to a
content-addressed artifact under `userData/artifacts` and the pointer travels with
the head and tail, so the first failure in a 4000-line test run is a grep away
instead of gone. Pruned after 7 days.

**Compaction by relevance, not just age.** A tool result superseded by a later
identical call is elided before anything that is merely old.

**An append-only, hash-chained journal.** `userData/journal/<day>.jsonl`: turn
started/finished, every tool call with its input hash and delivery class, approval
requested/granted/denied, model fallbacks, retries, verdicts, budget breaches.
Each line carries the digest of the line before it, so a file edited in the middle
stops verifying there. Two rules: it is never read back as state (a corrupt
journal degrades to no journal, never to a wrong decision), and a journal write
that throws cannot break a turn.

Config added: `approvals` (off | high-risk | strict), `verifier`, `turnBudgetUsd`,
`turnTokenCap`, all normalised to a closed set or a non-negative number on load.
The first three are in Settings under Guardrails; the token cap stays a config-file
backstop, because the dollar ceiling is the lever a person actually reasons about.

### Honest limits

- **The verifier is not independent, only separate.** Same family, and unless the
  catalog offers a `verifier` deployment, the same weights, so correlated blind spots
  survive. It is a triage filter, not a proof. What carries real weight is the
  mechanical evidence it is required to cite, which is why the receipt now says when
  the check was not independent.
- **The secret scanner is a net, not a wall.** It catches shaped, prefixed
  credentials. A bare high-entropy string, a base64-wrapped key, or a token format
  it has never seen goes through.
- **The workspace gate covers writes, not reads**, and it is a scope guard rather
  than a sandbox. Execute mode has a real shell, and a shell can write anywhere the
  user can.
- **A read-only classification is a heuristic.** `READ_ONLY_CMD_RE` is kept narrow
  so the error lands on "treated a read as a mutation" (an extra check) rather
  than the reverse.
- **The stale-write guard is size plus mtime**, not a content hash. It catches an
  editor or another agent writing the file; it would miss a change that preserved
  both.
- **Cost is estimated from display rates**, not billed usage, so the dollar ceiling
  is approximate. The token cap is the exact one, which is why it exists.
- **Snapshots are per file, not per tree.** A turn that renames or deletes files
  leaves a copy of what it edited, not a restorable tree. Rewind proper needs the
  block-boundary work in Horizon 2 item 8.
- **The authorization-path gate matches names, not semantics.** It will ask about
  `policy.ts` and stay silent on auth logic living in `index.ts`.

## 8. Deliberately not ported

The corpus designs assume a fleet. This is one machine, one user, one workspace,
and the wrong half of that design would be theatre here.

- **Temporal / Kubernetes / NATS orchestration.** A desktop turn is not a durable
  distributed workflow. Also, per the review of the source design, Temporal plus a
  separate event-sourcing store means two claimants to the same state. The journal
  is an audit stream only, and there is exactly one source of truth.
- **Firecracker / ZFS / seccomp sandbox tiers.** The isolation boundary here is
  the autonomy tier plus the approval gate plus the secret blocklist. A microVM
  around a tool the user explicitly asked to run in their own workspace protects
  nothing they did not already consent to.
- **HIL rigs, hardware leases, FPGA flashing, formal verification tiers.** No
  hardware in this product.
- **SCIP / Neo4j / Qdrant code intelligence.** Real value, wrong order: start with
  Postgres-and-object-storage equivalents and add a graph or vector store when a
  measurement demands it. Today `search` plus `read_file` with offset/limit is
  what the loop has, and the honest gap is that a million-line repo will still
  overflow. That is the next real piece of work, not a fifth gate.
- **Protobuf tool contracts.** The tool schemas are already JSON Schema over an
  OpenAI-compatible gateway; a second IDL buys nothing.
- **OverlayFS staging with commit-on-verify** (Kimi). The right shape for a fleet
  and the wrong one here: this product's promise is that the user watches edits land
  in their own working tree and reviews each diff. Staging changes behind a verifier
  would mean the review they already gave no longer applies to what gets committed.
  The portable half of the idea - keep what was there before - did land, above.
- **Signed agent patches, tool-binary allowlists by hash, Vault sidecars.** One
  local user on their own machine; the journal's hash chain already covers
  tamper-evidence, and secrets stay out of reach through the blocklist.
- **Per-tool CPU and memory limits** via cgroups. Not portable to macOS, and the
  wall-clock timeout plus an output cap already stop the runaway cases.
- **Two-person approval** for cryptographic or safety-critical changes (GPT-5,
  Kimi). There is one person at this machine. The nearest honest equivalent, asking
  before an unreviewed change to an authorization path, did land.
- **Leases, heartbeats, and compare-and-swap on lease generation** (GPT-5). These
  solve two workers racing for one task. Parallel agents here share a workspace
  rather than a task queue, and the stale-write and stale-read guards are the
  right-sized version of the same worry. If background agents over worktrees ever
  land (Horizon 3), this comes back.
- **Structured diagnostics** (`cargo --message-format=json`, JUnit XML, SARIF)
  instead of raw text. Genuinely worth doing and not done: it needs a parser per
  toolchain, and the artifact pointer covers the immediate loss.

## 9. Open items
- Router classifier: heuristic v1 (file-type + intent keywords) before a learned one.
- Retrieval for large repositories: the real remaining gap (see §8). A symbol layer
  before an embedding layer.
- Route by measured outcome, not by name. Three of the four source designs asked
  for the same thing: a golden corpus of real tasks with hidden verifiers, run
  nightly, reporting pass rate and cost per model tier, with harness releases gated
  on no regression. The journal already records, per turn, which model ran and what
  the verdict was, which is the input that corpus would score against. Worth adding
  a negative suite too (tasks whose correct answer is "not safely"), since
  over-eagerness is the failure this harness is most likely to have.
- Structured diagnostics from build and test tools (§8).
- Cortex overlap: the Cortex harness (spawns `crowe_logic headless`) is a candidate
  engine to fold in for the sidecar experts — engine only, brand stays separate.
