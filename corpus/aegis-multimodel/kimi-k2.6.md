1. Architecture and component boundaries

The harness separates into three planes. The Control Plane hosts the Orchestrator (Rust or Go), the Scheduler, and the Policy Engine. It accepts jobs via gRPC over HTTP/2 and emits plan DAGs. The Data Plane stores artifacts in a content-addressable object store (S3/MinIO), context indices in LMDB and PostgreSQL, and checkpoints in SQLite with WAL mode. The Execution Plane runs Sandbox Workers. Untrusted code runs inside Firecracker microVMs; build tools run in rootless Docker; HIL tasks run on bare-metal agents behind a serial and power proxy. All inter-plane messages use Protobuf. Local workers communicate over Unix domain sockets; remote workers use mutual TLS.

2. Planner, executor, and verifier roles

Planner: read-only access to the repo index. It consumes a task description and emits a DAG of plan nodes. Each node declares inputs, outputs, a tool name, and a sandbox profile. The planner never executes code and never mutates repository state.

Executor: a stateless worker that materializes a Git worktree at an immutable base commit, mounts an OverlayFS upper layer for writes, and invokes the tool. It streams stdout and stderr to the orchestrator and returns artifact references. After execution, the upper layer is frozen and passed to the verifier.

Verifier: an idempotent worker that runs tests, diffs, property checks, formal solvers, and HIL health scripts. It approves or rejects the executor output. Only after verifier approval does the orchestrator commit the OverlayFS layer to the object store. The verifier cannot modify source.

3. Tool and sandbox contracts

Every tool exposes a manifest in JSON Schema defining inputs, outputs, declared side effects, and resource limits (CPU milliseconds, RAM megabytes, wall seconds). The sandbox enforces these via cgroups, seccomp-bpf, and network namespaces. Tools return a structured record: exit code, stdout and stderr base64, artifacts as SHA-256 references, resource usage, and latency. Side effects are classified into four classes: class 0 (read-only), class 1 (writes to a tmpdir), class 2 (network via an explicit SOCKS5 proxy), and class 3 (hardware access via the HIL bridge). Class 3 requires a human approval token injected by the Policy Engine.

4. Context and memory strategy for million-line repositories

Repos are indexed into three tiers. Tier 1 contains structural summaries from tree-sitter: AST outlines, symbol tables, and call graphs. Tier 2 contains dependency graphs extracted from Bazel, CMake, Cargo, npm, or HDL project files. Tier 3 contains semantic embeddings of functions, modules, and types. The planner queries these tiers to assemble a working set under a 200,000 token budget. Hot files are cached in LMDB. Cross-references resolve through the dependency graph rather than text search. Historical context (commits, reviews, bug tickets) lives in a vector database and is retrieved by similarity. The full repository never enters the prompt.

5. Deterministic state, checkpointing, retries, and recovery

Base state is an immutable Git commit. All mutations occur in OverlayFS upper directories. A plan run is deterministic because its cache key is the hash of the base commit, input artifact hashes, and tool version hashes. The orchestrator writes checkpoints to SQLite after every completed DAG node. The checkpoint stores the DAG JSON, completed node IDs, the current cursor, and artifact references. Retries are limited to three per node and use exponential backoff. On orchestrator restart, the latest checkpoint reloads, artifact existence is verified in the object store, and failed or missing nodes are re-executed. Orphaned sandboxes are detected by PID namespace scanning and reaped automatically.

6. Security and approval boundaries

All file writes outside of build directories require explicit human approval via a webhook or CLI acknowledgment. Kernel module insertion, FPGA bitstream flashing, firmware flashing, and HIL power cycling require multi-factor authentication. Generated patches are signed by an Ed25519 agent key and stored in the object store before human review. Secrets are injected by a Vault sidecar into a tmpfs mount; they never appear in environment variables. The policy engine maintains an allowlist of tool binaries by SHA-256. Changes to CI configuration, authentication, or cryptographic code paths always route to mandatory human review.

7. Evaluation and observability

The system exports OpenTelemetry traces and Prometheus metrics. Key metrics include plan success rate, node retry rate, verification pass rate, wall-clock latency per plan, and token cost per task. Logs are structured JSON. A nightly evaluation harness runs the agent against golden repositories containing known bugs, regressions, and formal verification challenges. Model A/B tests compare pass rates and costs. HIL tests include device telemetry such as temperature, voltage, and serial output to detect hardware state drift.

8. Model routing and cost controls

A lightweight classifier (local 8B model or regex heuristic) tags incoming tasks by complexity: syntax, refactor, architecture, proof, or HIL. The router selects the model tier: Tier 1 (local 8B) for linting and formatting; Tier 2 (GPT-4o / Claude 3.5 Sonnet) for implementation; Tier 3 (o1 / Claude 3 Opus) for design and formal verification. Each task carries a token budget and a dollar-equivalent cap enforced by the orchestrator. The orchestrator tracks cumulative spend per run and hard-stops if the cap is breached.

9. Concrete directory structure and data schemas

```
/harness
  /orchestrator
    /plans        # DAG JSON files
    /checkpoints  # SQLite + WAL
    /policies     # Rego or YAML policy rules
  /workers
    /sandboxes    # OverlayFS upper dirs, ephemeral
    /tools        # Tool manifests and binaries
  /context
    /index        # tree-sitter ASTs, dependency graphs
    /embeddings   # vectors in pgvector or faiss
    /cache        # LMDB hot file cache
  /hil
    /fixtures     # Device configs and test vectors
    /logs         # Serial and JTAG captures
  /artifacts      # Content-addressable object store
```

Plan Node Schema:
```
{
  "id": "uuid",
  "tool": "string",
  "inputs": [{"sha256": "hex", "uri": "string"}],
  "outputs": [{"name": "string", "mime": "string"}],
  "deps": ["uuid"],
  "retries": 3,
  "sandbox_profile": "firecracker|docker|hil",
  "budget_usd": 10.0
}
```

Artifact Reference Schema:
```
{
  "sha256": "hex",
  "uri": "s3://bucket/path",
  "mime_type": "string",
  "size_bytes": 0
}
```

Checkpoint Schema:
```
{
  "run_id": "uuid",
  "dag": "PlanNode[]",
  "completed": ["uuid"],
  "cursor": "uuid",
  "base_commit": "git_sha",
  "created_at": "iso8601"
}
```

10. Phased implementation roadmap

Phase 1 (Months 1-2): Build the orchestrator, SQLite checkpointing, Firecracker worker, and Git/OverlayFS state management. Support C and Python with basic tool adapters.

Phase 2 (Months 3-4): Add the context indexer (tree-sitter, dependency graphs), the planner/executor/verifier split, and CI pipeline integration via GitHub or GitLab webhooks.

Phase 3 (Months 5-6): Add Rust, TypeScript, and HDL (Verilog/VHDL) support. Integrate formal verification tools (Z3, Yosys, Coq). Build the HIL bridge with serial and power proxies.

Phase 4 (Months 7-8): Implement multi-agent scheduling, the model router, cost accounting, and security approval gates.

Phase 5 (Months 9-12): Harden for production: golden eval suite, bare-metal HIL clusters, policy engine tuning, and disaster recovery runbooks.

Contradictions and unsafe assumptions

- HIL determinism: We assume hardware resets make HIL tests reproducible, but physical state such as temperature, wear, and timing jitter introduces non-determinism. Mitigation requires statistical thresholds and health checks rather than strict pass/fail gates.

- Context sufficiency: A 200,000 token working set assumes the planner can always identify relevant files. Cross-cutting changes (global refactors, header include migrations) may require broader context than fits.

- Security versus speed: Firecracker adds 100-300ms per invocation. For million-line C++ builds this is acceptable, but for rapid edit-test loops it may frustrate users. Bare-metal HIL sacrifices isolation for realism.

- Build hermeticity: We assume build tools are hermetic, but C and C++ toolchains frequently leak host paths and timestamps. Without Bazel or Nix, reproducibility is weak.

- Planner omniscience: We assume a single planner decomposes tasks optimally. In practice, multi-agent systems need consensus or auction mechanisms, which this design omits for simplicity and which may cause suboptimal plans at scale.
