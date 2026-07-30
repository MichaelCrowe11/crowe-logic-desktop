# Aegis: Production Agentic Engineering Harness

## 1. Architecture and component boundaries

Aegis should be a durable workflow engine around models, not a chat loop. Its control plane owns state, policy, scheduling, and audit. Stateless workers perform model inference and tool execution.

Core services:

1. **Run API** accepts a goal, repository revision, constraints, budget, and approval policy. It returns a stable run ID.
2. **Orchestrator** advances a persisted state machine. It never executes repository tools directly.
3. **Planner** converts goals into a dependency graph of typed tasks with acceptance criteria.
4. **Scheduler** leases ready tasks to workers according to capability, isolation, locality, and budget.
5. **Executor workers** operate in disposable sandboxes against immutable inputs.
6. **Verifier workers** independently test claims and produce evidence.
7. **Repository intelligence service** indexes symbols, build graphs, ownership, history, and test relationships.
8. **Artifact store** retains patches, logs, binaries, traces, waveforms, coverage, and attestations.
9. **Policy engine** authorizes tools, network access, secrets, approvals, and promotion.
10. **Event store** is the authoritative append-only history. A relational projection serves queries.

Use PostgreSQL for workflow state and leases, object storage for large artifacts, and a queue only as a delivery mechanism. Queue messages are hints. Database state determines truth.

## 2. Planner, executor, and verifier roles

The planner emits tasks, not prose:

```json
{
  "task_id": "t-42",
  "goal": "Fix DMA timeout without changing the ioctl ABI",
  "depends_on": ["t-17"],
  "inputs": [{"kind": "git_tree", "digest": "sha256:..."}],
  "allowed_tools": ["search", "edit", "build", "test"],
  "acceptance": ["existing ABI snapshot unchanged", "driver tests pass"],
  "risk": "high",
  "budget": {"tokens": 120000, "wall_seconds": 3600}
}
```

The executor returns a candidate change plus claims and evidence references. It cannot mark its own task verified. The verifier starts from the original tree, applies the candidate patch, reruns required checks, probes negative cases, and reports each acceptance criterion as pass, fail, or unknown.

Planning is incremental. The planner expands only enough graph to expose parallel work, then replans from verified facts. For HDL, firmware, kernel, and distributed systems, use domain-specific verifier templates. Examples include synthesis and timing checks, simulator regressions, ABI comparisons, fault injection, race detection, and hardware-in-the-loop runs.

## 3. Tool and sandbox contracts

Every tool implements a versioned request and response schema:

```ts
interface ToolRequest {
  runId: string;
  taskId: string;
  invocationId: string;
  toolVersion: string;
  args: unknown;
  inputDigests: string[];
  deadline: string;
}

interface ToolResult {
  invocationId: string;
  status: "ok" | "error" | "timeout" | "denied";
  exitCode?: number;
  stdoutArtifact?: string;
  stderrArtifact?: string;
  outputDigests: string[];
  metrics: Record<string, number>;
}
```

Invocation IDs make retries idempotent. Outputs are content-addressed. Tools receive declared mounts, environment variables, CPU, memory, storage, process, and time limits. Network is denied by default and enabled per host and protocol. Secrets are short-lived handles injected only into approved processes and redacted from logs.

Use containers for ordinary compilation and tests, microVMs for untrusted code or kernel-adjacent work, and dedicated isolated runners for FPGA boards and hardware-in-the-loop. Kernel tests should run in nested virtual machines or sacrificial hosts, never on the control plane. Hardware access requires exclusive leases, safe power-cycle controls, current limits, watchdogs, and emergency release.

## 4. Context and memory for million-line repositories

Do not place the repository into a prompt. Build a layered, revision-specific index:

- file metadata, languages, ownership, generated-file status
- syntax trees, symbols, references, call edges, imports, and inheritance
- build targets and dependency graphs from the real build system
- tests, coverage, historical co-change, and failure ownership
- concise file and subsystem summaries linked to source digests

Retrieval begins with deterministic structure, then semantic search. A context pack records every included range, digest, retrieval reason, and token cost. Workers can request expansion, but stale context is rejected when its source digest differs from the task tree.

Memory has three scopes: immutable run events, verified project facts tied to revisions, and provisional worker notes. Only verifier-confirmed facts enter reusable project memory. Summaries are caches, never authority. Source files, tool outputs, and verified artifacts remain authoritative.

## 5. Deterministic state, checkpointing, retries, and recovery

Represent each run as an explicit state machine. State transitions and their triggering events commit in one database transaction. Workers acquire expiring leases and send heartbeats. Completion uses compare-and-swap on lease generation, preventing late workers from overwriting newer attempts.

Checkpoint at task boundaries and before expensive tools. A checkpoint includes workflow state, repository digest, patch stack, context manifest, tool versions, policy version, budgets, and artifact references. Model generation is not deterministic, so record provider, model revision when available, parameters, prompt digest, response, and usage. Replay means reproducing orchestration and tool effects from recorded outputs, not promising identical model text.

Retry only classified transient failures. Compilation errors are task evidence, not infrastructure retries. Apply exponential backoff with jitter and a per-operation attempt ceiling. After repeated failure, route to a different worker or model, reduce task scope, or request approval. Recovery must resume from persisted events without depending on worker memory.

## 6. Security and approval boundaries

Separate read, mutate, execute, network, secret, hardware, and promotion capabilities. Policies consider repository, branch, file path, task risk, tool, destination, and actor. Require explicit approval for production deployment, destructive cloud changes, credential rotation, external messaging, purchases, firmware flashing outside test inventory, and changes to security boundaries.

Protect against prompt injection from source code, issue text, logs, and web content. Treat all repository content as data. Tool permissions come only from signed policy, never model output. Normalize paths, reject traversal and symlink escapes, scan generated patches for secrets, and preserve complete audit records.

Use two-person approval for safety-critical firmware, cryptographic code, privileged drivers, and production infrastructure. Signing and release credentials remain in separate promotion services that accept verified artifact digests, not arbitrary commands.

## 7. Evaluation and observability

Emit traces across planning, retrieval, inference, tools, verification, approvals, and retries. Track task success, first-pass verification, escaped defects, rollback rate, test selection precision, context tokens, cache hits, wall time, queue time, cost, and human intervention.

Maintain versioned evaluation suites built from real historical tasks plus synthetic adversarial cases. Score functional correctness in clean environments, not textual similarity. Include compile repair, cross-language refactors, kernel races, HDL timing regressions, flaky distributed tests, malicious repository instructions, and interrupted-run recovery. Run shadow evaluations before changing prompts, models, routing, retrieval, or policy.

## 8. Model routing and cost controls

Route by task type, risk, context need, tool reliability, latency, and measured evaluation performance. Small models classify, summarize, and retrieve. Strong coding models implement bounded changes. High-reasoning models plan ambiguous work and analyze difficult failures. Use model diversity for high-risk verification.

Enforce budgets per run and task for tokens, tool time, hardware time, and money. Cache by prompt and input digest where policy permits. Stop agents that repeat equivalent tool calls or fail to create new evidence. Escalation must spend from a reserved budget and record its reason.

## 9. Directory structure and schemas

```text
aegis/
  api/
  orchestrator/
  planner/
  scheduler/
  workers/{executor,verifier}/
  tools/{build,test,debug,sim,formal,hil}/
  repo_index/
  policy/
  schemas/
    run.schema.json
    task.schema.json
    event.schema.json
    tool.schema.json
    evidence.schema.json
  evals/
  migrations/
  deploy/
  sdk/{python,typescript,rust}/
```

Primary tables are `runs`, `tasks`, `attempts`, `leases`, `events`, `artifacts`, `evidence`, `approvals`, `budgets`, and `model_calls`. Store schema versions on every event. Evidence links a criterion to tool invocations, artifact digests, environment digest, and verifier verdict. Never persist mutable filesystem paths as artifact identity.

## 10. Phased implementation roadmap

1. **Foundation:** PostgreSQL state machine, local container runner, Git patch artifacts, one planner, one executor, one verifier, approval API, and full event logging.
2. **Repository scale:** symbol and build indexing, deterministic context packs, remote workers, leases, checkpoints, and budget enforcement.
3. **Engineering depth:** C/C++/Rust toolchains, sanitizers, debuggers, kernel VM runner, HDL simulation, formal tools, and board leasing.
4. **Operational maturity:** multi-model routing, evaluation gates, policy administration, secret broker, artifact signing, disaster recovery, and horizontal scaling.
5. **Controlled promotion:** CI integration, staged deployments, two-person gates, provenance attestations, and production feedback loops.

Each phase must ship with failure injection tests for worker death, duplicate delivery, database restart, network partition, expired leases, corrupted artifacts, and unavailable models.

## Contradictions and unsafe assumptions

Strict determinism conflicts with stochastic models and nondeterministic compilers, tests, networks, and hardware. Aegis can guarantee durable, auditable transitions and immutable inputs, not identical outcomes. Independent verification is weakened if planner, executor, and verifier share the same model or context, so high-risk tasks need model or prompt diversity and clean verifier environments. Repository indexes can be stale or wrong, so all retrieved data must be revision-bound and checked against source. Sandboxes reduce risk but do not make hostile kernel, HDL, or hardware workloads safe. Dedicated infrastructure and physical protections remain necessary. Finally, autonomous long-running work can optimize the wrong objective. Bounded tasks, explicit acceptance criteria, budget ceilings, and human promotion gates are requirements, not optional controls.
