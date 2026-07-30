Here is a comprehensive design for **Aegis**, a production-grade agentic harness designed for heavy-duty computer engineering, semiconductor, and software engineering tasks.

---

### 1. Architecture and Component Boundaries

The system is designed as an asynchronous, event-driven distributed system. Agents are stateless workers; state is externalized.

*   **Control Plane (Orchestrator):** The brain. Manages the Directed Acyclic Graph (DAG) of tasks, handles scheduling, enforces policies, and manages checkpoints. Built on Temporal.io for durable execution.
*   **Agent Workers:** Stateless compute nodes running the LLM loops. They receive a `TaskContext`, execute ReAct-style loops, and yield `Action` requests. They scale horizontally via Kubernetes.
*   **Environment Manager:** Provisions and manages sandboxes (Firecracker microVMs, Docker containers) and physical hardware allocations (HIL rigs).
*   **Code Intelligence Service (CIS):** A persistent service maintaining SCIP/LSIF indexes of all repositories. Agents query CIS via gRPC instead of grepping million-line codebases.
*   **Tool Gateway:** A reverse proxy sitting between agents and tools. Enforces RBAC, rate limits, and approval boundaries.
*   **State & Memory Store:** PostgreSQL (relational state), Neo4j (code dependency graph), Qdrant (semantic vector search), and Redis (ephemeral context).

### 2. Planner, Executor, and Verifier Roles

The system uses a strict hierarchy to prevent infinite loops and ensure determinism.

*   **Planner (The Architect):**
    *   *Input:* High-level goal (e.g., "Port this Linux driver to Rust and verify on QEMU").
    *   *Process:* Decomposes the goal into a DAG of sub-tasks. Defines explicit **Acceptance Criteria** for each node.
    *   *Output:* A `TaskGraph` JSON. Does not write code.
*   **Executor (The Operator):**
    *   *Input:* A single `TaskNode` from the graph, scoped context, and tool permissions.
    *   *Process:* Writes code, runs builds, edits configs. Operates strictly within a scoped sandbox.
    *   *Output:* `ExecutionResult` containing diffs, logs, and artifact pointers.
*   **Verifier (The SKEPTIC):**
    *   *Input:* `ExecutionResult` and the `Acceptance Criteria`.
    *   *Process:* Runs independent checks: builds the code from scratch, runs unit tests, executes formal verification (e.g., Coq, Verilator simulations), checks cyclomatic complexity.
    *   *Output:* `Verdict` (Pass/Fail). If Fail, generates a structured `RejectionReport` fed back to the Planner.

### 3. Tool and Sandbox Contracts

All tools are defined via strict protobuf schemas. Agents do not execute code directly; they invoke tools via the Tool Gateway.

**Sandbox Tiers:**
1.  *Tier 1 (Ephemeral):* Docker container, no network, memory/CPU limits. For static analysis, linting, unit tests.
2.  *Tier 2 (Persistent VM):* Firecracker microVM with root access. For kernel modules, eBPF, build systems.
3.  *Tier 3 (HIL Rig):* Physical FPGA/SoC boards connected via JTAG/UART. Allocation requires a hardware lease.

**Tool Contract (gRPC):**
```protobuf
message ToolRequest {
  string tool_id = 1;
  string sandbox_id = 2; // Must be allocated first
  google.protobuf.Struct parameters = 3;
  string correlation_id = 4;
}

message ToolResponse {
  enum Status { SUCCESS = 0; FAIL = 1; TIMEOUT = 2; APPROVAL_REQUIRED = 3; }
  Status status = 1;
  bytes stdout = 2;
  bytes stderr = 3;
  map<string, string> artifacts = 4; // S3 pointers to generated files
  string error_trace = 5;
}
```
*Failure Handling:* Tools enforce idempotency. If a network drops mid-tool-call, the Orchestrator retries with the same `correlation_id`. The Tool Gateway safely aborts the duplicate request.

### 4. Context and Memory Strategy

For million-line C/C++/Rust codebases, LLM context windows are insufficient. We use a multi-tier retrieval strategy.

*   **Tier 1: Code Graph (Neo4j + SCIP):** The repository is continuously indexed. When an agent needs to understand a function, it calls `get_symbol_definition(symbol_id)` or `find_callers(symbol_id)`. Returns exact AST snippets, not approximations.
*   **Tier 2: Semantic Cache (Qdrant):** Embeddings of prior successful solutions, error/fix pairs, and architectural decision records (ADRs). E.g., "How did we fix the DMA buffer overflow in driver X last time?"
*   **Tier 3: Working Set (Redis):** A sliding window of the current session's active files, logs, and build outputs. Automatically summarized by a background LLM job when it exceeds 32k tokens, replacing raw logs with "Build failed due to missing header X" summaries.

### 5. Deterministic State, Checkpointing, and Recovery

State is managed via **Event Sourcing**. The database stores a sequence of events (e.g., `TaskCreated`, `CodeEdited`, `BuildStarted`, `BuildFailed`). The current state is a fold over these events.

**Checkpointing:**
*   Every state transition is a checkpoint.
*   For sandboxes, ZFS snapshots are taken before destructive actions (e.g., `make clean`, `git reset`). If a build corrupts the environment, the Orchestrator rolls back to the ZFS snapshot.
*   For HIL (hardware), if a board hangs, the system executes a hardware reset sequence (power cycle, JTAG reset) before retrying.

**Retries:**
*   *Transient failures* (network, OOM): Exponential backoff with jitter.
*   *Build failures:* Fed back to the Executor with the compiler error. Max 3 retries before escalating to Planner to re-architect the approach.
*   *Hardware faults:* Automatically re-queued to a different HIL rig, faulty rig marked for maintenance.

### 6. Security and Approval Boundaries

**RBAC for Agents:**
Agents are assigned roles: `Reader`, `Builder`, `Committer`, `HardwareOperator`.

**Approval Gateway:**
Certain tool calls trigger an asynchronous human approval workflow via Slack/Email.
*   *Tier 1 (Auto):* Reading files, running unit tests, compiling.
*   *Tier 2 (Approval Required):* Modifying CI/CD pipelines, changing dependency versions, mutating `main` branch.
*   *Tier 3 (Strict Approval):* Flashing physical hardware, deploying to staging environments, executing destructive database queries.

*Implementation:* The Tool Gateway intercepts the request, changes state to `AWAITING_APPROVAL`, and pauses the Temporal workflow. Upon human approval, the workflow resumes.

### 7. Evaluation and Observability

*   **Tracing:** OpenTelemetry (OTLP) spans for every LLM call, tool call, and sandbox interaction. Traces are linked to the `TaskGraph` ID.
*   **LLM Eval (Offline):** Continuous evaluation of agent trajectories against a golden dataset of kernel bugs, FPGA timing violations, and build failures.
*   **Runtime Eval:** The Verifier node acts as the real-time evaluator. Metrics tracked: Pass/Fail rate per task type, token cost per successful merge, average retries per build.
*   **Drift Detection:** If an agent suddenly starts using 3x more tokens to solve similar tasks, the system alerts administrators.

### 8. Model Routing and Cost Controls

**Router Service:**
Evaluates the `TaskNode` and routes to the appropriate model based on complexity and context requirements.

*   **Planner/Verifier:** High-reasoning models (e.g., Claude 3.5 Sonnet, GPT-4o, or local Llama-3-70B fine-tuned on code review).
*   **Executor (Code Gen):** DeepSeek-Coder-V2 or CodeLlama (local, high throughput, lower cost).
*   **Summarization/Context compression:** Llama-3-8B or Claude 3 Haiku.

**Cost Controls:**
*   Hard token limits per `TaskGraph`. If budget is exceeded, the graph fails fast and alerts human.
*   Semantic deduplication of prompts: If an agent requests the same file 5 times, the context manager serves it from cache, saving embedding/token costs.

### 9. Directory Structure and Data Schemas

**Repository Structure:**
```text
aegis/
├── orchestrator/          # Temporal workflows, state machine
├── agents/                # Planner, Executor, Verifier implementations
├── tool_gateway/          # gRPC proxy, RBAC, approval intercepts
├── sandboxes/             # Docker/Firecracker/ZFS management
├── cis/                   # Code intelligence (SCIP indexer, graph queries)
├── hil_controller/        # FPGA/SoC JTAG/UART automation
└── proto/                 # Shared protobuf definitions
```

**TaskGraph Schema (JSON):**
```json
{
  "graph_id": "uuid-1234",
  "root_goal": "Implement SPI driver in Rust for STM32",
  "nodes": [
    {
      "node_id": "n1",
      "type": "EXECUTOR",
      "prompt_template": "create_file",
      "params": {"path": "src/spi.rs", "interface": "HAL"},
      "dependencies": [],
      "acceptance_criteria": {"static_check": "no unsafe blocks"}
    },
    {
      "node_id": "n2",
      "type": "VERIFIER",
      "tool": "cargo_build",
      "dependencies": ["n1"],
      "acceptance_criteria": {"exit_code": 0}
    }
  ]
}
```

**Agent Memory Event Schema (Avro/JSON):**
```json
{
  "event_id": "uuid",
  "timestamp": "iso8601",
  "agent_id": "executor-7",
  "event_type": "TOOL_CALLED",
  "tool_id": "run_cargo_build",
  "sandbox_id": "vm-998",
  "input_hash": "sha256...",
  "output_summary": "Build failed: unresolved import",
  "token_cost": 1520
}
```

### 10. Phased Implementation Roadmap

**Phase 1: Core Orchestration & Sandboxing (Months 1-2)**
*   Implement Temporal workflows for Planner/Executor/Verifier.
*   Build Docker-based Tier 1 sandboxes.
*   Integrate basic tools: `read_file`, `write_file`, `run_bash`.
*   *Goal:* Agent can clone a Python repo, write a unit test, and run it.

**Phase 2: Code Intelligence & Large Codebases (Month 3)**
*   Deploy SCIP indexer for Rust/C++/TS.
*   Implement `get_symbol_definition` and `find_callers` tools.
*   Integrate Redis sliding-window context manager.
*   *Goal:* Agent can trace a bug across a 500k-line C++ codebase without overflowing context.

**Phase 3: Hardware-in-the-Loop & Formal Verification (Months 4-5)**
*   Build HIL controller (Raspberry Pi CM4s acting as JTAG debuggers).
*   Integrate Verilator/QEMU tools for HDL/Kernel work.
*   Implement ZFS snapshotting for Tier 2 Firecracker VMs.
*   *Goal:* Agent can synthesize a Verilog module, simulate it, and flash it to a physical FPGA via HIL.

**Phase 4: Multi-Agent Determinism & Long-Running Tasks (Month 6)**
*   Implement Event Sourcing state store.
*   Add approval gateway integrations (Slack).
*   Deploy Model Router with local open-source models for cost reduction.
*   *Goal:* System can run autonomously for 48 hours on a distributed systems refactoring task, checkpointing, failing, and recovering without human intervention.
