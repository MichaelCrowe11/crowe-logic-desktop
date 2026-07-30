## Agentic Harness for Heavy-Duty Systems Engineering

### 1. Architecture and Component Boundaries

```
[Gateway] --> [Router] --> [Orchestrator]
                              |
              +---------------+---------------+
              |               |               |
         [Planner]      [Executor]      [Verifier]
              |               |               |
         [Context]       [Sandbox]       [Evaluator]
              |               |               |
         [Store]         [Tools]         [Observer]
```

**Gateway**: gRPC/HTTP ingress. Accepts tasks as structured `TaskSpec` protobufs. Authenticates, meters, enqueues. Returns streaming `TaskEvent` responses.

**Router**: Classifies tasks by domain (kernel, FPGA, CI, etc.) and routes to domain-specialized orchestrators. Maintains cost budgets per task.

**Orchestrator**: Owns the lifecycle of a single task. Spawns planner/executor/verifier triples, manages checkpoints, enforces deadlines, and emits events.

**Contradiction**: Routing by domain classification requires a classifier that itself needs context the task hasn't yet provided. We resolve this: the router runs a lightweight "scout" inference pass with 2K-token budget to categorize before the heavy context loads.

### 2. Planner, Executor, and Verifier Roles

**Planner**: Takes `TaskSpec + ContextWindow`, outputs `Plan`. A Plan is an ordered DAG of `Step` nodes. Each step has: `id`, `tool_name`, `params`, `expected_output_schema`, `timeout_ms`, `max_retries`, `depends_on[]`, `rollback_step_id`. Plans are immutable once approved. Re-planning is a new Plan version.

**Executor**: Consumes `Plan`, sequentially or topologically walks the DAG, invokes tools via the sandbox contract, collects `StepResult` for each step. If a step fails, executes the rollback step if defined, then either retries or signals `PlanFailure` to the orchestrator.

**Verifier**: After each step and after plan completion, runs validation. For a single step: compares output schema against `expected_output_schema`, runs static analysis on produced code (clippy, mypy, shellcheck, cppcheck), runs a subset of tests. For plan completion: runs the full test suite, checks build integrity, runs formal verification if specified. Verifier returns `Verdict{pass, warnings[], errors[], coverage_delta}`.

**Unsafe assumption**: Verifiers cannot verify their own correctness. A buggy verifier that passes broken code is catastrophic. Mitigation: verifier code itself is subject to a separate verification harness with golden tests; verifier changes require two-person review in the approval boundary.

### 3. Tool and Sandbox Contracts

Every tool implements:

```
interface Tool {
  name: string
  schema: JSONSchema          // input/output shapes
  invoke(params, sandbox): Promise<ToolResult>
  dryRun(params): CostEstimate // pre-flight cost
  idempotencyKey(params): string
}
```

**Sandbox tiers**:

| Tier | Isolation | Allowed syscalls | Networking | Persistence | Use case |
|------|-----------|-----------------|------------|-------------|----------|
| T0 | None (inline) | All | Yes | Host fs | Read-only: git, grep, ls |
| T1 | seccomp+ns | Allowlist | None | tmpfs | Build, lint, unit tests |
| T2 | Firecracker microVM | Allowlist | Loopback only | 9p/overlay | Integration tests, kernel builds |
| T3 | Physical rack + FPGA | Hardware allowlist | Isolated VLAN | Bare metal | HIL, FPGA flashing, driver tests |

Each sandbox implements `Sandbox{ create(), exec(cmd, env, timeout), writeFile(path, content), readFile(path), snapshot(), restore(snapshot_id), destroy() }`. Tool invocations declare `required_sandbox_tier`.

**Contract violation risk**: A T1 sandbox that leaks filesystem access is catastrophic. We run a daily "breakout" test suite that actively attempts sandbox escapes and fails the harness if any succeed.

### 4. Context and Memory Strategy for Million-Line Repositories

**Structure**: Three-layer context model.

1. **Static Index** (pre-computed): ctags/cscope symbol index, module dependency graph, build graph (Bazel query / Makefile parse), git blame heatmap. This is a `rocksdb` key-value store with O(1) symbol lookup. Rebuilt on every baseline commit, takes ~5 minutes per million lines.

2. **Dynamic Context** (per-task): Assembled by `ContextManager` which takes (`TaskSpec`, `StaticIndex`) and returns a `ContextWindow`. The window has: `relevant_symbols[]` (top-k by embedding similarity + dependency distance), `relevant_files[]` (full content, deduplicated), `conversation_history`, `current_plan_version`, `environment_vars`, `tool_output_cache`. Total window budget is configurable (default 128K tokens).

3. **Working Memory** (ephemeral): LLM context. Strictly the active window. When full, the context manager evicts least-recently-used file/symbol, compressing the evicted content into a dense summary stored in a side-channel `summaries[]` array the model can reference by key.

**Key decision**: We do NOT embed entire repositories. Embedding 1M files costs more than the value. We embed only function/class signatures and docstrings. File retrieval uses BM25 + dependency-graph distance. This keeps the retrieval index under 2GB for 1M LOC.

**Contradiction**: Summarization loses detail that later steps may need. Eviction is lossy by design. We accept this; the planner can explicitly request re-fetch of evicted content via a `recall(symbol_key)` tool.

### 5. Deterministic State, Checkpointing, Retries, and Recovery

**State model**: Every mutable entity (Plan, Step, Sandbox, ContextWindow) is serialized as a protobuf with a monotonically increasing `version`. All state mutations are `append-only` to a Write-Ahead Log (WAL).

**Checkpointing**: After every step completion, the orchestrator writes a `Checkpoint{ task_id, plan_version, completed_step_ids[], sandbox_snapshot_id, context_window_hash }` to the WAL. Sandboxes support `snapshot()` (copy-on-write overlay snapshot in T2/T3; tmpfs tar in T1). Checkpoint frequency is every step; cost is ~200ms for T2 snapshot.

**Retries**: Steps are retried with exponential backoff (1s, 2s, 4s, 8s, cap 60s). On tool timeout, the sandbox is killed and recreated from the last checkpoint. On model invocation failure, the orchestrator retries with a different model provider (see routing). Max retries per step is 3; after that, the plan is marked `FAILED` and human review required.

**Recovery**: On orchestrator crash, the WAL is replayed from the last committed checkpoint. All non-idempotent steps (git push, hardware flash, package publish) require an explicit `idempotencyKey`. If a step with a known idempotency key was already committed before crash, it is skipped during recovery.

**Tricky edge case**: Hardware-in-the-loop steps cannot be fully idempotent (flashing an FPGA changes physical state). For HIL steps, the idempotency check queries the hardware for its current bitstream hash before re-flashing.

### 6. Security and Approval Boundaries

| Boundary | Mechanism | Scope |
|----------|-----------|-------|
| Authentication | mTLS + JWT with device attestation | Gateway ingress |
| Authorization | OPA/Rego policies per tool + tier | Every tool invocation |
| Tool approval | Human-in-the-loop for T2/T3 destructive ops | flash, deploy, git push, rm -rf |
| Code review gate | Verifier pass required; diffs >500 lines need human signoff | Before PR creation |
| Secret access | Tools request `Secret(namespace/key)`; resolved by Vault sidecar | Never in context window |
| Network egress | T0: allowlist domains; T1: none; T2: loopback; T3: isolated VLAN | Per sandbox tier |
| Audit | Every tool invocation logged to immutable append-only store with hash chain | All operations |

**Destructive operation approval flow**: Planner proposes a destructive step → human receives notification with diff/dry-run output → human approves/rejects within 5-minute window → if timeout, step is skipped and plan continues with non-destructive steps.

**Unsafe assumption**: Human-in-the-loop is slow (minutes) while model steps are fast (seconds). This creates pipeline bubbles. Resolution: the planner schedules destructive steps in a "gate group" that must all be approved before any execute. While awaiting approval, the orchestrator can eagerly execute non-destructive steps from future plan nodes that have no dependency on the gate group.

### 7. Evaluation and Observability

**Metrics pipeline**:

```
Tool invocations --> [Collector] --> [Stream Processor] --> [Storage]
                                             |
                                      [Alerts] [Dashboards]
```

Metrics: `step_latency_p50/p99`, `step_success_rate`, `plan_success_rate`, `verifier_pass_rate`, `sandbox_breakout_attempts`, `cost_per_task`, `tokens_consumed`, `context_window_utilization_pct`, `human_approval_latency`, `recovery_count`.

**Evaluation**: Weekly regression suite runs 200+ reference tasks (kernel patches, FPGA builds, Rust crate migrations) against the harness. Each run produces `pass@k` and `cost_per_pass`. A new harness version must match or beat the baseline on both metrics to deploy. Golden verifier tests are immutable and versioned alongside the harness.

**Observability**: OpenTelemetry traces span the full task lifecycle (gateway → router → orchestrator → planner/executor/verifier → tool → sandbox). Structured logs at every boundary. Errors include full stack context, sandbox state, and the plan step that failed.

### 8. Model Routing and Cost Controls

**Router strategy**: Classify task into tier based on complexity and budget.

| Tier | Models | Max cost/task | Use case |
|------|--------|---------------|----------|
| C0 | Claude Haiku, GPT-4o-mini, local Llama-3-70B | $0.50 | Grep, lint fixes, simple refactors |
| C1 | Claude Sonnet, GPT-4o | $5.00 | Feature work, debugging, test writing |
| C2 | Claude Opus, o1-pro | $50.00 | Architecture, kernel work, formal proofs |
| C3 | C2 + human pairing | $200.00 | Safety-critical, FPGA, deployment |

**Failover**: If primary model errors or times out (3s deadline for C0, 15s C1, 60s C2), retry with fallback: C2→o1→Sonnet, C1→Sonnet→Haiku. Each failover logs a metric and degrades the cost ceiling (can't exceed C2 budget with C1 model).

**Cost enforcement**: Orchestrator holds a budget token bucket. Each model call debits tokens. When bucket is empty, task is paused with `BUDGET_EXCEEDED` and requires human approval to increase. Budgets are per-task, not per-tenant, to prevent one task starving others.

### 9. Directory Structure and Schemas

```
harness/
  proto/
    task.proto           # TaskSpec, TaskEvent, TaskStatus
    plan.proto           # Plan, Step, StepResult
    checkpoint.proto     # Checkpoint, SandboxSnapshot
    tools.proto          # ToolSchema, ToolResult
  orchestrator/
    main.go              # Orchestrator service
    planner.go           # Plan generation
    executor.go          # DAG walker + tool invoker
    verifier.go          # Post-step, post-plan verification
    context.go           # ContextManager, retrieval pipeline
    checkpoint.go        # WAL, snapshot, recovery
    budget.go            # Token bucket, cost routing
  tools/
    tools.go             # Tool interface + registry
    lint/                # LintTool (clippy, mypy, eslint, etc.)
    build/               # BuildTool (cargo, gcc, bazel, make)
    test/                # TestTool (pytest, cargo test, ctest)
    git/                 # GitTool (diff, branch, commit, push)
    sandbox/             # SandboxTool (exec, writeFile, readFile)
    formal/              # FormalVerificationTool (tla+, coq, kani)
    hw/                  # HardwareTool (vivado, openocd, jtag)
  sandbox/
    tier0.go             # Inline sandbox
    tier1.go             # seccomp + namespaces
    tier2.go             # Firecracker microVM manager
    tier3.go             # Physical rack controller
    breakout_test.go     # Sandbox escape attack suite
  indexer/
    indexer.go           # Ctags/cscope index builder
    retriever.go         # BM25 + dep-graph retrieval
    embeddings.go        # Signature embedding pipeline
  gateway/
    gateway.go           # gRPC/HTTP ingress
    auth.go              # mTLS, JWT, OPA integration
    audit.go             # Immutable audit log
  eval/
    suite.go             # Regression test suite runner
    metrics.go           # pass@k, cost_per_pass computation
    golden/              # Immutable verifier golden tests
  deploy/
    docker-compose.yml   # Local dev
    terraform/           # Production (GCP + on-prem FPGA rack)
```

### 10. Phased Implementation Roadmap

| Phase | Duration | Deliverables |
|-------|----------|-------------|
| P0: Skeleton | 2 weeks | proto definitions, orchestrator passes Plan→Step→Tool→Result in-memory, T0 sandbox, gateway skeleton, no checkpointing, no routing |
| P1: Core loop | 4 weeks | Planner/executor/verifier working with T0/T1 sandboxes, static index + BM25 retriever, WAL checkpoint + recovery, basic tool registry (git, lint, build, test) |
| P2: Safety | 3 weeks | OPA authorization, audit log, human-in-the-loop for destructive ops, sandbox breakout tests, T2 Firecracker sandbox, secret management via Vault |
| P3: Scale | 3 weeks | Model routing + cost budgets, context eviction + summaries, multi-repo static index, embeddings pipeline, OpenTelemetry instrumentation, dashboards |
| P4: Hardware | 4 weeks | T3 physical rack integration, FPGA/HIL tools, hardware idempotency checks, HIL-specific approval flows |
| P5: Evaluation | 3 weeks | 200-task regression suite, golden verifier tests, automated weekly eval runs, CI gating on pass@k |
| P6: Hardening | ongoing | Chaos engineering, long-running task soak tests (72hr+), adversarial model inputs, third-party security audit |

**Total**: ~19 weeks to production-grade with hardware; ~12 weeks for software-only MVP.

**Key risk**: The jump from P1 (tmpfs sandboxes) to P2 (Firecracker microVMs) requires kernel-level changes to the sandbox interface. The `Sandbox` interface must be designed in P0 with T2 in mind, even though T2 implementation is deferred. If the interface leaks tmpfs assumptions, P2 is a rewrite. Explicitly: no path concatenation in tool code; always use `sandbox.readFile(key)`, never `open("/sandbox/"+key)`.
