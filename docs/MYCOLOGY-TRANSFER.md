# Crowe Logic Mycology: local records and transfer

Status: local implementation under verification, not a published release. No real farm records have been migrated by this work.

## Editions

Crowe Logic Desktop and Developers keep Chat and Projects as ordinary workspaces. Their explicit **Legacy farm records** entry retains access to the existing profile's notebook and compliance ledger. Saved navigation preferences cannot grant this access. Leaving recovery revokes access after admitted operations drain.

Crowe Logic Mycology has a separate installer identity, profile policy, and update channel. It opens Farm on every launch, with Cultivation available and Chat optional. General assistant panels and their managed subprocesses are deferred until explicit workbench entry. Accessing legacy records does not resume Sense or grant agent access to Desktop's notebook.

Packaged side-by-side identity and updater behavior still require packaged acceptance. The required secret-safety skill is unavailable, so the planned isolation from home-global legacy-auth migration remains unimplemented. Do not use the unfinished edition against real profiles until that blocker is resolved. Test profiles are synthetic and guarded.

## Before transfer

1. Preserve the original profile and its backups.
2. Resolve any retained shipment request in its original profile using the original request ID. Do not clear, copy, or re-enter pending intents to bypass recovery.
3. Choose which components to copy: notebook, compliance ledger, or both.
4. Pause source operations while exporting the selected components. They are independent snapshots, not an atomic cross-store transaction.
5. Choose a private export location outside the source profile. Existing destination files are not replaced.

A pending, foreign, corrupt, multiple, unreadable, or in-memory unresolved shipment intent blocks transfer-ready export and restore/import. Main acquires an acknowledged renderer lock, drains admitted farm operations, and rechecks recovery state after dialogs and reads. Competing writes fail busy rather than queueing an unintended later operation.

The ordinary emergency compliance backup remains available during recovery. Its existence is not clearance to switch operational profiles.

## Notebook archive

The `crowe-grow-archive` version 1 archive contains exactly seven logical slots: blocks, flushes, contam, env, strains, recipes, and log. Each records whether its source file existed. Existing UTF-8 text, stable IDs, whitespace, timestamps, and supported unknown fields are preserved exactly. An absent file is not converted to `[]`.

Limits:

- 16 MiB per source file.
- 32 MiB aggregate raw source text.
- 64 MiB encoded archive.
- 10,000 rows per type and 1 MiB per row.
- Existing JSON depth/node safeguards apply.

Corrupt JSON, invalid UTF-8, duplicate IDs/property names, dangerous property names, links, unsupported content, and over-limit files are refused. The app does not repair or normalize records during transfer.

In Mycology, select the archive, inspect its source/counts/checksums, and type **IMPORT EMPTY NOTEBOOK**. Import requires an absent notebook directory or a physically zero-entry directory. Existing `[]` files, hidden files, and unknown contents block import.

The complete notebook is staged beside the destination with a durable journal, then committed with one directory rename. Restart reconciles directory identity and file hashes before ordinary notebook access. A matching receipt and unchanged content allow an exact repeat to report already imported, without duplicates.

An incomplete stage or ambiguous journal is retained and blocks access. Do not delete it to retry. A post-rename error can mean the copy committed but verification is incomplete; preserve both profiles and restart for reconciliation.

Importing notebook evidence does not adopt or approve compliance lots. Adoption remains a separate owner-reviewed action. A current notebook row may legitimately differ from its historical adopted snapshot.

## Compliance ledger

Use the complete `crowe-farm-backup` version 1 backup, not a reconstruction from visible tables. In the destination, restore through Farm's backup/restore control and type **RESTORE EMPTY FARM**.

Restore accepts only an empty ledger. It validates the complete domain history by replay, preserves the original operator, actor identities, source evidence, approvals, quantities, shipments, and audit prefix, and appends one restore receipt. The 10 MiB backup limit includes the restored receipt; exceeding it rolls back without replacing the target.

A missing source ledger is not created solely to export it. No arbitrary external live database is opened for transfer.

If the restore response is lost, compare the preserved backup against destination records and the restore receipt before another attempt. Never empty a destination to make restore succeed.

## Independent outcomes

Notebook and compliance transfers have separate results. If one succeeds and the other fails, keep the successful component. Retry only the failed component after resolving its reported condition. Do not treat a successful notebook import as proof that the ledger restored, or vice versa.

Before using the destination operationally, verify both selected components, restart, and inspect:

- Exact notebook file content and IDs.
- Original compliance operator and audit prefix plus restore receipt.
- Source/reviewer/approval evidence for adopted harvests.
- Immutable shipped lot and recipient snapshots.
- Exact shipped/remaining quantities and lot-to-recipient recall.

Source and destination are independent copies, not synchronized. Choose one active operational copy after verification to avoid divergent records. Export/import never deletes, retires, or rewrites the source.

## Evidence limits

Checksums detect corruption, not malicious administrator replacement. Filesystem coordination excludes cooperating app writers, not arbitrary external namespace changes. Unsupported durability primitives fail closed. Shipment localStorage restart tests use orderly exit with storage flushing, not power-loss simulation.

See `FARM-COMPLIANCE-VERIFICATION.md` for current test status. Successful synthetic workflows do not establish regulatory certification, production retention capacity, packaged release readiness, or authorization to migrate real records.
