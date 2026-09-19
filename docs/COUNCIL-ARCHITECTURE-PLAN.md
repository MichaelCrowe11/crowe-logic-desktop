# Council architecture plan for the next council autopilot

Produced by Crowe Logic's own council autopilot on 2026-09-19, running the
protocol in `rooms/council.js` through the headless host
(`scripts/council-run.js`) against five distinct engines. Every step below was
proposed by one seat, classified for safety by a second, voted on
independently by the others without seeing one another's ballots, recorded,
and verified by a seat that had not proposed it. The full receipts, with every
ballot and reason, are in `docs/council-runs/`.

This is the council's approved text, reproduced verbatim from the completion
recorded in `docs/council-runs/2026-09-19-arch-12.md`. Each step's complete
design, with its rationale, interfaces, invariants, tests and known limits, is
in the receipt named in the provenance table.

## The plan

Step 1, uniform authorization: Start with rooms/council-host.js, rooms/council-files.js, rooms/registry.js, companion.js, and each built-in and MCP dispatch entry point. Route every Room-attributable action through a host-owned ActionIntent gate using a trusted operation registry, current permission intersections, exact targets and arguments, receiver-side validation, and structured receipts. Unknown or unmediated operations fail closed. Invariant: Read-only, advisory, pairing, or quorum state can never create execution authority.

Step 2, cross-device continuity: Start with rooms/engine.js, rooms/council.js, rooms/council-host.js, and companion.js. Represent desktop, web, and mobile as authenticated projections of one pinned owner's durable, ordered Room journal, with owner epochs, command deduplication, stale-revision rejection, exclusive writing, and durable outcome records. Invariant: synchronization never copies executable authority or automatically replays interrupted or outcome-unknown actions.

Step 3, strict spend: Start with rooms/engine.js for atomic whole-batch reservations before Promise.all, then rooms/council.js, rooms/council-host.js, scripts/council-run.js, and the web runner for complete-cycle admission. Use exact prepared-request token counts, binding price revisions, provider-enforced output caps, the approved 50000-token council cap, and bounded receipts per docs/council-runs/2026-09-19-protocol-bounds.md. Settle validated metered usage or the reservation ceiling, never zero. Invariant: committed plus reserved spend never exceeds the applicable Room or grant ceiling before dispatch.

Step 4, correlated reviewer failure: Start with rooms/council.js and rooms/council-host.js, followed by protocol tests and docs/COUNCIL-AUTOPILOT.md. Add host-computed facts, structured decision grounds, explicit prior approval outcomes, rotating separate classifier and verifier roles, frozen independent ballots, untrusted-evidence framing, source-linked reasons, and advisory receipt equality checks. Invariant: models decide semantic questions only; countable facts and approval state are host-owned, design preferences cannot terminate grants as safety findings, and no safeguard grants authority.

Step 5, oversight metrics: Start with rooms/council.js for pure derivation, rooms/council-host.js for persisted intervention-request timestamps and exposure, then the Room oversight renderer and docs/COUNCIL-AUTOPILOT.md. Derive intent-to-authorization coverage, execution-receipt rates, request-to-terminal intervention latency, and operator-labeled false approvals and false refusals from persisted events, receipts, and append-only annotations. Missing evidence is unavailable rather than zero, and proxy signals are not ground truth. Invariant: metrics are deterministic views of records, never model assertions or grants.

## Provenance

Seats: GPT-6 Astra (crowelm-zenith), Claude Fable 5.1 (crowelm-kernel),
GPT-5.6 Sol (crowelm-coder), DeepSeek V4 Pro, Grok 4.6 (crowelm-depth, early
grants) and Kimi K3 (later grants). Quorum was three of four reviewers for
Steps 1 and 2 and two of four afterwards, once design disagreement was ruled
an abstention rather than a rejection.

| Step | Receipt | Proposer | Approve | Abstain | Verifier |
|---|---|---|---|---|---|
| 1 | arch-1, Proposal 1 | Astra | Fable, Grok, Sol | DeepSeek | DeepSeek abstained: the advisory receipt then carried no content. Approved by vote; verification defect fixed the same day. |
| 2 | arch-2, Proposal 1 | Astra | Fable, Grok, Sol | DeepSeek | Sol, verified |
| 3a | arch-8, Proposal 1 | Astra | Sol, Fable, Kimi | DeepSeek | Kimi, verified |
| 3b | arch-8, Proposal 2 | Sol | Fable, Kimi | Astra, DeepSeek | Kimi, verified |
| 4 | arch-9, Proposal 1 | Sol | Fable, Astra, Kimi | DeepSeek | Kimi, verified |
| 5 | arch-10, Proposal 1 | Sol | Astra, Fable, Kimi | DeepSeek | Kimi, verified |
| Plan | arch-12, Proposal 1 | Sol | Astra, Fable, Kimi | DeepSeek | Kimi, verified |

Twelve grants ran to reach this. The five that failed did so on: one safety
classifier escalation over a design disagreement (arch-3); two proposals
over the protocol's 8000-character bound (arch-4, arch-5); one reject on a
hand count of 3429 characters as 3812 (arch-6); one reject on a paraphrase
of where `noteCost` runs (arch-7); three rejects of a later step as "out of
order" on a bare `verified` status (arch-8, arch-9, arch-10); and one
request timeout (arch-11). Each failure is recorded in its receipt and in
`docs/COUNCIL-AUTOPILOT.md` under what the first councils taught. The
mechanisms in Step 4 are the council's answer to its own failures.

## Status

Advisory. Nothing in this document has been implemented except the three
fixes the runs forced immediately: receipts that carry the recorded text,
prompts that state the length bound and keep design critique out of the
classifier, a file-authority gate that fails closed on invalid autonomy and
unresolved roster identities, and a `previous` list that states approval
plainly. Everything else is a plan for a maintainer to start tomorrow, in the
order given.
