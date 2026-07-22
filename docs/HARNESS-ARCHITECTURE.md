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

Today (`renderer/../harness.js` + gateway): a flat loop. Each round posts the whole
message list to one model (`crowelm`), runs whatever tools come back, repeats up to
24×. One model, no planning pass, no verification pass, unbounded context growth,
no notion of "which expert for this step."

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
1. Identity: hex-cube hero + one flat ≤24px glyph; depth/density shell pass.
2. Refactor harness.js into explicit stages (retrieve/route/reason/synthesize) with
   the router stubbed to today's single default (no behavior change, new shape).
3. Planner shared operator → **Plan Mode** as the 4th autonomy state.
4. Auto-update + code-signed Win/Mac builds.
Motion: wire **Convergent Hex** (nodes gathering to the core = routing) as the
thread's thinking animation; hex-cube stays the static brand mark.

**Horizon 2 — 1-2 months (residual + experts)**
5. Router live in the gateway; expert registry table (the deployments above).
6. Weighted-memory recall at Retrieve (real session memory).
7. Verifier shared operator → proof-of-work receipts in the colophon.
8. Checkpoint / rewind on the thread (block-boundary snapshots).

**Horizon 3 — a quarter (fan-out + interop)**
9. Parallel routed experts over git worktrees + a light command view.
10. ACP: run Claude Code / Codex / Gemini CLI as routed experts inside the thread.
11. Semantic index behind Retrieve.

---

## 7. Open items
- Router classifier: heuristic v1 (file-type + intent keywords) before a learned one.
- Cost governance: the router must respect a per-turn ceiling (ties to the colophon).
- Cortex overlap: the Cortex harness (spawns `crowe_logic headless`) is a candidate
  engine to fold in for the sidecar experts — engine only, brand stays separate.
