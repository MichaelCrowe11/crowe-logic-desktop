# Farm & Compliance acceptance contract

Status: implementation target, not a release claim.

## Product boundary

A focused workspace inside Crowe Logic, not a second product fork. The first supported runtime is the local desktop app. Browser and phone surfaces must not claim access to these records unless they use the same authoritative store. No new public server, customer notification, regulatory filing, engine integration, or automatic migration is included.

Harvest lots represent harvested product. They are distinct from cultivation block/batch records. An owner can explicitly link or adopt existing harvest records through stable source identifiers and immutable source snapshots. Legacy edits cannot rewrite compliance history. Existing cultivation data is never silently converted, deleted, or reset.

## End-to-end owner workflow

1. Open the workspace without invoking an engine.
2. Save one facility with an owner and emergency contact details.
3. Create two harvest lots with unique human-readable lot codes, valid dates, species, rooms, and exact pound quantities.
4. Create a customer and one shipment containing both lots; retain recipient details as they were at shipment time.
5. Create a second partial shipment. Reject any cumulative overshipment, including concurrent attempts and duplicate submission retries.
6. Record daily environment and sanitation activity. Deviations have explicit open/resolved state; resolving requires a corrective action. Edits carry a reason and retained history.
7. Select a lot and inspect all affected shipments and customers, totals shipped and remaining, and a print-friendly result. An unshipped lot has an explicit empty result. Unknown identifiers are errors.
8. Draft a plan or SOP, submit for owner review, approve, create a successor draft, and approve it. Approved revision content remains immutable; supersession is linked and retained. Approval records who and when, without claiming regulatory certification.
9. Dashboard counts and recent rows match stored records. Status is conveyed in text, not color alone.
10. Export a consistent backup. Validate and restore into an empty isolated store, with data, history, links, and quantities intact. Corrupt or incompatible backups fail without altering the target. Production restore requires explicit owner confirmation and preservation of pre-restore state.
11. Restart the app and verify records persist.

## Explicit adoption gates requested during implementation

- Adopting the same source harvest twice cannot create duplicate lots, including concurrent/retried requests.
- Each adopted record retains its source ID, exact snapshot, source hash, reviewer, and approval time.
- Notebook edits or deletion cannot silently alter approved or shipped compliance records.
- Harvest corrections preserve the original receipt and record who changed what, when, and why. They cannot reduce quantity below recorded allocations. Shipment-time lot snapshots do not change.
- A shipped lot can be traced back to its preserved source harvest and forward to shipment-time recipients.

Screenshots show interface state only. These gates require assertions against the real store and live IPC, not a screenshot or mock-only test.

## Integrity checks

- All input is validated at the trusted service boundary, not only by forms.
- Integer thousandths of a pound are canonical. Reject non-finite values, unsafe quantities, zero/negative harvest/shipment quantities, and excess decimal precision.
- Multi-lot writes and their audit events commit or roll back together.
- Foreign keys, unique lot codes, source adoption uniqueness, duplicate-item handling, and document revision constraints are enforced.
- Failed writes do not leave partial shipments, audit-only events, consumed quantities, or partially superseded documents.
- Persisted records have stable IDs; strings displayed to an owner are not relational keys.
- Audit is append-only through the application. Local filesystem administrators are outside this integrity guarantee.
- No sample data is inserted into a real store automatically. Fixtures exist only in isolated test/demo profiles.
- No renderer-controlled arbitrary database path, SQL, actor identity, or filesystem operation is accepted.
- New IPC handlers use the application's trusted sender policy and narrowly allowlisted commands.
- General engine tools receive no new compliance binding. This is not an OS-level guarantee against a separately authorized shell or filesystem tool.
- Local single-owner operation is not multi-user authentication or tenant isolation.

## User experience checks

- Desktop and narrow viewport layout, keyboard access, visible focus, field labels, empty/error/saving states.
- Text is escaped; user-entered document HTML is never executed.
- No misleading compliance-certified, regulator-approved, or complete traceability claims.
- Source gaps and desktop-local availability remain visible.
- Restore, approval, and supersession require explicit owner intent.
- Filters and form values do not disappear on unrelated background updates.

## Verification evidence required

- Domain/unit/integration test results, including transaction and restore failure paths.
- Electron SQLite runtime compatibility.
- Actual app interaction with an isolated home, userData, sessionData, workspace, and blocked network.
- Screenshots of populated workspace, recall, and document approval/revision flow, inspected visually.
- Packaging inclusion and existing targeted regression tests.
- Independent integrity/security and completeness review, followed by fixes and reruns.

No release, commit, push, live migration, or installed-app replacement is authorized by this document.
