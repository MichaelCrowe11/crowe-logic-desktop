# Agentic Harness for Systems Engineering

## 1. Architecture and component boundaries

Five processes, not one. Each has a single owning concern and communicates over a typed message bus (NATS or gRPC; a local Unix socket in dev).

- **Orchestrator**: owns the task DAG, checkpoints, budgets, and agent lifecycle. Stateless between ticks; all state lives in the store.
- **Store**: Postgres for task/run/event tables, content-addressed blob store (S3 or local CAS) for artifacts, logs, and build outputs. Single source of truth.
- **Context service**: repository indexing, retrieval, symbol graph, memory. Read-mostly, horizontally scalable.
- **Executor pool**: sandboxed workers that run tools. No LLM calls inside. Workers are cattle: killed on timeout, restarted from checkpoint.
- **Gateway**: model routing, token accounting, prompt caching, rate limits, redaction.

The hard boundary: **the model never touches the filesystem, network, or hardware directly.** Every effect goes through a declared tool call, validated against a schema, executed in a sandbox, and recorded as an event. This is the property that makes replay, audit, and rollback possible.

The second hard boundary: **the orchestrator never generates text.** It runs deterministic control flow. Every nondeterministic decision comes from an agent call, and every agent call is journaled with its inputs so a rerun with the same journal is a pure function.

## 2. Planner, executor, verifier

Three roles, distinct prompts, distinct models, distinct tool grants.

**Planner** (high-capability model, read-only tools). Input: goal, repo map, prior failures. Output: a `Plan` DAG of `Task` nodes, each with an explicit `verification` clause written *before* any code is produced. A plan without a machine-checkable verifier is rejected by the orchestrator, not by another model. Planner may not write files. It replans on verifier failure, receiving the failing evidence, not a summary.

**Executor** (mid-tier model, write plus build plus test tools, scoped to a worktree). One executor per leaf task, isolated in its own git worktree so parallel executors cannot conflict. Executor sees a task-local context window: the task spec, the retrieved slice, and its own scratchpad. It does not see sibling tasks.

**Verifier** (independent model instance, read-only, plus the ability to run the test and analysis tools). Critically, the verifier is *adversarial and evidence-bound*: it must cite a command, its exit code, and its output. A verifier that cannot produce a command that fails must return `pass`. This kills the failure mode where a reviewer model invents plausible objections.

Verification tiers, cheapest first, short-circuiting:

| Tier | Check | Typical cost |
|---|---|---|
| 0 | compile, lint, format, type check | seconds |
| 1 | unit tests, `cargo test`, `pytest -x` | minutes |
| 2 | sanitizers (ASan/UBSan/TSan), `miri`, clang-tidy, `cppcheck` | minutes |
| 3 | property tests, fuzzing budget (libFuzzer/AFL++), differential tests | tens of minutes |
| 4 | formal: CBMC, Kani, TLA+/Apalache, SMT obligations, Verilator lint + formal equivalence | long |
| 5 | HIL: flash to target, run on-device suite, JTAG/OpenOCD assertions, logic-analyzer capture | scarce, serialized |

Tier 5 hardware is a **leased resource**, not a tool. The orchestrator holds a lease table with device IDs, exclusive locks, TTLs, and a mandatory power-cycle recovery hook. A crashed executor must never leave a board bricked or a bench locked.

## 3. Tool and sandbox contracts

Every tool declares:

```json
{
  "name": "build.cargo",
  "version": "3",
  "effects": ["fs:write:/work", "net:none", "cpu:8", "wall:900s"],
  "input_schema": {...},
  "output_schema": {"stdout_ref":"blob","exit_code":"int","diagnostics":"[Diagnostic]"},
  "idempotent": true,
  "approval": "none",
  "determinism": "hermetic"
}
```

Rules the harness enforces, not suggests:

- Outputs over 8 KB are written to the blob store and returned as `blob://sha256/...` with a head, a tail, and a **structured** summary. Never dump a 200 MB build log into context. Parse it: compilers, linkers, and test runners all emit machine-readable diagnostics (`cargo --message-format=json`, `clang -fdiagnostics-format=sarif`, JUnit XML, `ctest --output-junit`). Tools return `Diagnostic[]`, and raw text is a fallback, not the interface.
- Sandbox: Linux, per-task namespace, seccomp profile, read-only bind of the repo, writable overlay for the worktree, `/tmp` tmpfs, network **default deny** with an allowlist for the package proxy only. macOS uses `sandbox-exec` plus a VM for anything untrusted. Firmware toolchains and vendor EDA binaries run in pinned OCI images.
- Determinism classes: `hermetic` (Bazel/Nix, cacheable by input hash), `repeatable` (same host, same result), `nondeterministic` (HIL, timing, network). Only `hermetic` results are cached across runs. Mislabeling here is the single most likely source of silent corruption, so the harness verifies a random 1 percent of cache hits by re-execution.
- Timeouts are enforced by the executor with `SIGTERM` then `SIGKILL`, and a partial-output artifact is always produced. A killed tool returns a typed `Timeout` result, never an exception that unwinds the task.

## 4. Context and memory for million-line repos

Retrieval is layered and mostly *not* embeddings.

1. **Symbol layer** (authoritative): compile-database-driven index. `clangd`/`rust-analyzer`/`pyright`/`tsserver` via LSP, plus tree-sitter for HDL and anything without a server. Gives exact defs, refs, call graph, type hierarchy. Queries: `def(sym)`, `refs(sym)`, `callers(sym, depth)`, `impls(trait)`.
2. **Structural layer**: `CODEOWNERS`, build graph (Bazel/CMake targets), module boundaries. Answers "what is the blast radius of this change" with a target-level dependency query, which is far more reliable than semantic search.
3. **History layer**: `git log -L`, blame, and a "co-change" matrix. Files that historically change together are strong context signals.
4. **Semantic layer** (last resort): chunk embeddings over docs, comments, and commit messages. Used for "where is the thing that does X" when the name is unknown.

Retrieval budget is a hard token cap per task (for example 60k of a 200k window), filled by a deterministic ranker: exact symbol hits, then build-graph neighbors, then co-change, then embeddings. The ranking is code, not a model, so it is reproducible.

**Memory** is three tiers, all explicit files under version control or the store:

- `repo-facts`: durable, verified statements with provenance and a validity check (for example "build requires `--cfg tokio_unstable`; verified by run r-8812"). Facts carry an expiry and are re-verified on staleness.
- `task-scratch`: per-task, discarded on completion, summarized into the run record.
- `failure-index`: signature-keyed record of previously seen errors and what fixed them. Keyed by normalized diagnostic code plus file plus symbol. This is the highest-leverage memory in practice.

Never let a model write to `repo-facts` without a verifier-attached command that reproduces the fact.

## 5. Deterministic state, checkpointing, recovery

The run is an append-only event log:

```json
{"run_id":"r-8812","seq":1041,"ts":"...","actor":"exec-3","type":"tool_result",
 "task_id":"t-19","tool":"build.cargo","input_hash":"sha256:...",
 "output":{"exit_code":1,"diagnostics_ref":"blob://..."},"tokens":{"in":0,"out":0},
 "parent_seq":1040}
```

Checkpoint = (event log offset, git commit SHA per worktree, blob refs, lease state). Taken after every verified task and every tier-2+ verification. Recovery replays the log: cached tool results for `hermetic` calls, re-execution for the rest.

Retry policy is typed by failure class, and this matters more than retry count:

- `Transient` (network, flaky infra, OOM): exponential backoff, up to 3, same inputs.
- `Deterministic` (compile error, test failure): **do not retry the same action.** Feed the diagnostic back and require a *different* action. Track a per-task edit-hash set; an executor proposing a previously-tried diff is halted.
- `Budget` (tokens, wall clock): escalate to planner for rescope.
- `Unsafe` (approval denied, sandbox violation): halt, surface to human, never auto-retry.

Global circuit breakers: no-progress detection (N tasks with no verifier tier advancing), cost ceiling, and a wall-clock deadline. On trip, the harness produces a **handoff artifact**: current diff, what passed, what failed, the exact commands to reproduce.

## 6. Security and approval boundaries

Three trust zones: `read` (index, plan), `write-sandbox` (edit worktree, build, test), `write-world` (push, deploy, flash hardware, mutate shared infra).

Approvals are policy-as-code, evaluated by the orchestrator before dispatch:

```yaml
- match: {tool: "git.push", ref: "refs/heads/main"}
  decision: deny
- match: {tool: "hil.flash", device_class: "production"}
  decision: require_human
- match: {effects: ["net:egress"], destination_not_in: [pkg_proxy]}
  decision: deny
```

Secrets never enter model context. Tools receive credentials from the executor's environment by reference; the gateway runs an outbound scrubber and refuses to send anything matching secret patterns to the model. Prompt injection from repository content (READMEs, test fixtures, vendor code) is assumed present, so retrieved content is delimited and marked untrusted, and **no tool grant is ever derived from file content.**

## 7. Evaluation and observability

Every run emits OpenTelemetry spans keyed by `run_id`/`task_id`, with token counts, cost, and tool latency as span attributes. The dashboard metrics that actually drive decisions: task success rate by verification tier, median tiers-passed-before-failure, cost per merged change, human-intervention rate, and cache hit rate by determinism class.

Evaluation suites, run in CI on the harness itself: a frozen corpus of real tasks per domain (a Rust refactor, a kernel driver bug, an HDL timing fix, a CMake breakage) each with a hidden verifier. Report pass@1 and cost, and gate harness releases on no regression. Also run a **negative suite**: tasks where the correct answer is "this cannot be done safely," to measure over-eagerness.

## 8. Model routing and cost controls

Route by task class, not by vibes. Planning and tier-4 reasoning get the strongest model; execution and diagnostic triage get a mid-tier model; classification, summarization, and log parsing get a small model or plain code. Escalate on failure (small then mid then large), never start large. Cache aggressively: system prompts, tool schemas, and the repo map are stable prefixes and should be prompt-cached. Budgets are enforced per run and per task by the gateway, which refuses calls over ceiling rather than trusting the agent to self-limit.

## 9. Directory structure and schemas

```
harness/
  orchestrator/     # DAG, scheduler, policy engine, leases
  gateway/          # routing, budgets, caching, redaction
  context/          # lsp/, treesitter/, graph/, embed/, memory/
  executor/         # sandbox/, tools/, runners/
  tools/            # one manifest + impl per tool
    build.cargo/{manifest.json,run.py}
    hdl.verilator/  fw.flash/  formal.cbmc/  hil.lease/
  policy/           # approvals.yaml, sandbox profiles, allowlists
  eval/             # corpora/, harness_ci/
  schemas/          # json schema, single source for codegen
.harness/           # per-repo, committed
  repo.yaml         # toolchains, build graph roots, test tiers
  facts/*.md        # repo-facts with provenance
  policy.yaml       # repo-level overrides (tighter only, never looser)
runs/<run_id>/      # events.jsonl, checkpoints/, artifacts/, handoff.md
```

Core types:

```
Task { id, parent, goal, inputs[], worktree, verification: Check[],
       budget{tokens,wall,cost}, status, attempts, blocked_on[] }
Check { tier, tool, args, expect{exit_code|assertion}, evidence_ref? }
Diagnostic { severity, file, line, col, code, message, rendered_ref }
Lease { resource_id, holder, ttl, recovery_hook }
Fact { text, provenance{run_id,command,exit_code}, expires_at }
```

## 10. Roadmap

- **P0 (weeks 1 to 4)**: event log, sandbox, tool contract, three tools (shell, patch, test), single executor, tier 0 to 1 verification. Ship it on real repos immediately.
- **P1 (5 to 10)**: LSP symbol index, retrieval ranker, planner/verifier split, checkpoint and replay, failure-index memory.
- **P2 (11 to 18)**: parallel worktree executors, build-graph blast radius, sanitizers and fuzzing tiers, model routing and budgets, eval corpus.
- **P3 (19 to 28)**: HDL and firmware toolchains, HIL lease manager with power-cycle recovery, formal tier.
- **P4 (ongoing)**: distributed-systems verification (deterministic simulation, fault injection), long-horizon runs with human checkpoints.

## Contradictions and unsafe assumptions in this design

1. **"Verifier is independent" is partly false.** The verifier shares training data and often the same model family as the executor, so correlated blind spots survive. Mitigation: weight tier 0 to 4 mechanical checks above model judgment, and treat the model verifier as a triage filter, not a proof.
2. **Determinism labels are self-reported.** Marking a tool `hermetic` when it reads the clock, the network, or `/proc` silently poisons the cache. The 1 percent audit is a smoke alarm, not a guarantee. Bazel/Nix should be mandatory for anything cached.
3. **Replay is not true determinism.** Model sampling, concurrency interleavings, and HIL timing are not reproducible. Replay reproduces the *decision sequence* from the journal, not the reasoning. Do not market this as deterministic execution.
4. **Parallel worktrees conflict at merge.** Isolation prevents write races, not semantic conflicts. Independent tasks touching a shared header or API will pass independently and fail together. Needs a serialized integration phase with full-tier reverification, which erases much of the parallel speedup.
5. **Retrieval caps guarantee misses.** A 60k budget on a million-line repo will sometimes exclude the file that matters. Budget overrun should be an explicit, logged, escalatable event, not a silent truncation.
6. **HIL recovery is optimistic.** A power-cycle hook does not recover a corrupted bootloader or a physically damaged board. Any autonomous flashing needs hardware write protection, a recovery bootloader, and a policy of `require_human` for anything that touches boot or fuse regions.
7. **Untrusted-content marking is weak.** Delimiting retrieved text reduces prompt injection risk but does not eliminate it. The real defense is that tool grants are static per task, so a successful injection can misdirect the work but cannot expand privilege.
8. **Cost control conflicts with escalation.** Small-then-large routing raises total cost on hard tasks by paying for failed cheap attempts. Track escalation rate per task class, and pin classes that escalate more than half the time straight to the large model.
