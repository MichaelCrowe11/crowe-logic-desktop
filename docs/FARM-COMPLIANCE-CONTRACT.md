# Farm & Compliance implementation contract

This is the shared interface for parallel implementation. Changes need coordination across store, host and UI owners.

## Boundaries and ownership

- `farm/store.js`: synchronous SQLite domain, exported `FarmStore` class; constructor `{ filename }`; `handle(action, payload = {})` returns data or throws an error with `.code`; `close()`.
- `farm/worker.js`: serialized worker-thread adapter that instantiates FarmStore. Host owner implements.
- `farm/service.js`: asynchronous worker RPC facade `new FarmService({ filename })`, `.request(action, payload)` returns data/rejects error, `.close()` shuts down worker.
- `farm/ipc.js`: desktop trusted-sender boundary, scoped action allowlist, canonical legacy adoption, local operator attribution (never a renderer-provided actor), no arbitrary filesystem/SQL access.
- `renderer/farm-compliance.js`: browser script exposing `window.FarmCompliance.mount(container, api)`, renders workspace and returns `{ destroy() }`. `api.request(action, payload)` returns the envelope below; `api.legacyHarvests()` returns the envelope. No direct Electron or filesystem use. Style scope `.farm-compliance` in `renderer/farm-compliance.css`.
- `preload.js`: `window.crowe.farm.request(action, payload)` and `.legacyHarvests()` only. Both async, returning `{ok:true,data}` or `{ok:false,error:{code,message}}`. No generic path/SQL/actor parameters.
- Main/shell adapter owner wires mount and preload availability. Browser, mobile, and preview bridges explicitly return UNAVAILABLE, not fake successful writes. Read-only explanatory UI instead of a second store.

## Store operations

All read/write methods validate unknown actions and input at the store boundary. Fixed action strings:

- `snapshot`: `{ facility, lots, customers, shipments, logs, documents, dashboard, storage }`.
- `facility.save`: `{name,ownerName,address?,emergencyPhone?,waterSource?}`.
- `lot.create`: `{harvestDate:'YYYY-MM-DD',room,species,quantityLbs:'48.000',notes?}`.
- `lot.adopt`: host-only, payload includes lot fields above and `{sourceId,sourceSnapshot}` populated from a reread of the actual legacy record. Reject an already-adopted source. Renderer calls this with `{sourceId,...ownerReviewedLotFields}`; IPC must reject any renderer `sourceSnapshot` and verify sourceId against legacy harvest records. Source is `legacy-flush:<stable row id>`, not a lot string. Source snapshot is immutable. Persist `sourceReviewedBy`, `sourceApprovedAt`, and `sourceHash` explicitly from the trusted local operator and clock, not just implicitly in audit. Do not mutate legacy records. Recall and lot detail expose this preserved provenance.
- `lot.correct`: `{id,expectedVersion,reason,harvestDate?,room?,species?,quantityLbs?,notes?}`. Correct recorded harvest facts by appending an immutable correction revision and recording before/after, actor, timestamp and reason, not deleting/replacing the original adoption or creation record. Lot ID/code and source identity/snapshot/reviewer/time never change. Quantity cannot go below already shipped amount. Shipment-time lot facts remain preserved in shipment item snapshots and recall identifies corrections. Existing adopted-source duplication constraints remain. Return the current lot projection with `version` and `corrections` history; original receipt stays accessible. This is correction of a record, not physical return/waste accounting.
- `customer.create`: `{name,contact?,email?,phone?,address?}`.
- `shipment.create`: `{requestId,customerId,shippedAt:ISO8601,items:[{lotId,quantityLbs:'20.000'}],notes?}`. Request ID is mandatory and idempotent; reusing with different content is an error. Entire allocation and audit transactional. Reject duplicate lot IDs within a shipment rather than silently double allocating.
- `log.create`: `{loggedAt:'YYYY-MM-DD',room,temperatureF?:number|null,humidityPercent?:number|null,cleaningCompleted:boolean,lotId?:string|null,deviationNotes?,correctiveAction?}`. Nonempty deviation notes starts OPEN, otherwise NONE. Providing corrective text alone does not resolve it.
- `log.update`: `{id,expectedVersion,reason,...same mutable log fields}`. Optimistic concurrency; preserve history. Cannot erase an existing deviation through ordinary field edit.
- `log.resolve`: `{id,expectedVersion,correctiveAction,reason}`. Requires open deviation, nonempty corrective action. Retains notes and records resolver/time.
- `log.reopen`: `{id,expectedVersion,reason}`. Requires resolved deviation, retains past correction through audit.
- `document.create`: `{title,type,content}` -> document with revision 1 DRAFT.
- `document.edit`: `{id,revisionId,expectedVersion,title,content,reason}`. Only DRAFT or NEEDS_REVIEW; editing NEEDS_REVIEW returns to DRAFT. Never edit approved/superseded content.
- `document.submit`: `{id,revisionId,expectedVersion}` DRAFT -> NEEDS_REVIEW.
- `document.approve`: `{id,revisionId,expectedVersion,attestation:true}` NEEDS_REVIEW -> APPROVED; atomically supersedes the prior approved revision of this document and records linkage. Records actor/timestamp and content hash.
- `document.revise`: `{id,reason}` creates next DRAFT copied from current approved revision; no competing draft per document. Prior approved stays active until successor is approved.
- `recall`: `{lotId}` -> `{lot,affectedShipments:[{shipmentId,shippedAt,customer,quantityLbs,notes}],totalShippedLbs,remainingLbs}`. Current customer edits must not rewrite shipment-time recipient facts.
- `audit`: `{entityId?:string}` -> event array with IDs, actor, timestamp, action, reason, before/after. Application append-only; not tamper-proof against an OS administrator.
- `backup.export`: -> `{format:'crowe-farm-backup',schemaVersion:1,exportedAt,...validated payload and checksum}`; consistent snapshot including audit and source provenance. No secret material.
- `backup.restore`: `{backup,confirmation:'RESTORE EMPTY FARM'}` -> restored counts. Only into an empty store. Validate format/checksum/schema and domain/relational/audit invariants before commit. Refuse populated target. No destructive restore in v0.

## Shared constants

Document types: FOOD_SAFETY_PLAN, SANITATION_SOP, HARVEST_PACKING_SOP, RECALL_PLAN, LOT_CODING_SOP. Store can export DOCUMENT_TYPES. Backup JSON max size: 10 MiB UTF-8 (10 * 1024 * 1024 bytes), enforced before read/parse in UI and at IPC/domain boundaries. Other request payloads max 1 MiB. Document content max 100000 characters; ordinary text fields max 500 except notes, reasons and corrective text max 5000. IDs max 200 characters. UI must display store error messages rather than assume exhaustive enum. Core codes: VALIDATION, NOT_FOUND, CONFLICT, INSUFFICIENT_QUANTITY, INVALID_STATE, DUPLICATE_SOURCE, UNAVAILABLE, CORRUPT_STORE, INVALID_BACKUP, STORE_NOT_EMPTY, INTERNAL. Error codes can be refined but cannot return false success.

Backup capacity: every mutation checks the complete exportable history before commit, including its audit event. A change that would exceed the supported 10 MiB JSON size/structure limits returns `BACKUP_CAPACITY` and rolls back. Restore checks after adding its receipt and rolls back if the restored store would not be exportable. Historical replay skips repeated capacity scans; final target validation remains mandatory. No pruning or archiving in v0. This is a bounded pilot ledger, not unlimited retention storage.

## DTOs

Identifiers are opaque stable strings. Quantities cross IPC as canonical decimal strings (`'20.000'`) and persist as integer thousandths of a pound. Reject more than 3 decimal places, negative/zero harvest and shipment quantities, non-finite or unsafe values.

- Facility: `{id,name,ownerName,address,emergencyPhone,waterSource,createdAt,updatedAt}` or null.
- Lot: `{id,lotCode,version,harvestDate,room,species,quantityLbs,shippedLbs,remainingLbs,notes,sourceId?,sourceSnapshot?,sourceReviewedBy?,sourceApprovedAt?,sourceHash?,originalRecord,corrections:[],createdAt}`. Corrections retain before/after, actor, timestamp, and reason; source provenance is immutable. Shipment items retain lot snapshots at posting time so corrections never silently rewrite historical recipient records.
- Customer: `{id,name,contact,email,phone,address,createdAt}`.
- Shipment: `{id,customerId,customer:{name,contact,email,phone,address},shippedAt,items:[{lotId,lotCode,quantityLbs,lotSnapshot}],notes,createdAt}`. `customer` is the shipment-time snapshot. Each `lotSnapshot` preserves shipment-time lot facts and source provenance; recall affectedShipments entries also expose that snapshot.
- Log: `{id,version,loggedAt,room,temperatureF,humidityPercent,cleaningCompleted,lotId,deviationNotes,correctiveAction,deviationStatus:'NONE'|'OPEN'|'RESOLVED',resolvedAt,resolvedBy,createdAt,updatedAt}`.
- Document: `{id,title,type,revisions:[Revision]}`. Revision: `{id,version,editVersion,title,content,status,createdAt,updatedAt,submittedAt,approvedAt,approvedBy,contentHash,supersedesRevisionId,supersededByRevisionId}`. The document root title follows newest revision for list display; revision titles are retained.
- Dashboard: `{lotsCreated,shipmentsRecorded,openDeviations,documentsAwaitingApproval,recentLots,recentShipments}`. Awaiting approval counts NEEDS_REVIEW revisions; DRAFT is not awaiting approval.
- Storage: `{kind:'desktop-local',schemaVersion:1,operator:{id,name},notice}`. Actor ID is local profile attribution, not verified Crowe ID identity or a regulatory electronic signature. Do not claim otherwise.
- Legacy harvest candidates: `{id,sourceId,date,lot,room,strain,weightLbs,adoptedLotId?,...minimal source display fields}`. Stored source snapshot is re-read by main, not trusted from renderer.

## Implementation guardrails

Use only existing app dependencies or Node built-ins. Electron 43.4.0 bundled Node24.18.1 and SQLite3.53.1 verified in this session. Node22 CI compatibility must be tested or documented explicitly. All SQLite operations in worker thread; long backup work cannot block UI main thread. Bound input lengths and file/import sizes. Use WAL, foreign keys and explicit transactions with rollback and busy handling. SQLite file lives beneath Electron userData/farm-compliance, outside the active project. Do not add farm tools to the engine harness or companion server.

UI errors remain visible, preserve forms, and clear saving state. Use provided error codes without exposing stack traces. Desktop IPC errors use the envelope, including worker startup/runtime failures. IPC only accepts trusted main-frame sender using existing policy. Schema migrations must fail closed on unsupported versions and leave existing data intact. Package farm/** explicitly because worker paths are not covered by require traversal.

Approval and revision controls visibly explain local owner review, not regulatory approval. Restore is owner-selected local JSON into an empty database, never overwrite. JSON backups are a v0 operational backup, not the excluded PDF/ZIP export feature. No sample seed into production. Test fixtures are separate.
