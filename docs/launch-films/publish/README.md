# Offline publication state machine

**Synthetic-tested core only. LIVE TRANSPORT UNAVAILABLE. No film has been uploaded or accepted by this package.**

Run from the worktree:

```sh
python3 -B docs/launch-films/publish/test_uploader.py
```

Python standard library only, POSIX (macOS/Linux). This command creates tiny invented inputs and protected temporary receipts, uses a fake adapter, exercises actual filesystem persistence/process locks, and removes only its own temporary directory. It does not import the historical uploader, read credentials, resolve secrets, contact YouTube, synthesize voice or render media. Running `uploader.py` directly exits 2 with `LIVE_TRANSPORT_UNAVAILABLE`. No live CLI or transport is exposed.

## Safety contract

- Explicit UUID operation ID, lane and exact expected channel. Software is `UCIQxSp5Zp2Oaz9a22USFyfg`; mycology is `UCTXP5BRecHpwa7_sFbbyMng`. No default channel or cross-lane fallback.
- SHA-256 and byte length of the exact master, metadata JSON bytes, captions and thumbnail are permanently bound to that operation. Even metadata whitespace changes conflict. Inputs are rehashed on every transition; the master uses the same checked descriptor for hashing and chunk reading, with change detection before dispatch. Inputs must be frozen by the trusted operator.
- One permanent receipt per lane under one canonical, trusted local store. A new operation ID or changed media cannot bypass an existing lane receipt. Completed/held receipts are not automatically removed. There is no reset, takeover, retry-initialize, expiry replacement or delete API.
- The store is owner-only `0700`; receipts and the permanent lock inode are `0600`. Symlink/nonregular/hardlinked files and permissive stores are rejected. `flock` is held over read/validate/intent/dispatch/result; it releases automatically when a process exits. The lock inode is never unlinked. Atomic replacement and file/directory `fsync` establish durable transitions. Pending temporary files after a hard kill are not receipts and are never adopted.
- Initialization intent is durable before dispatch. Once it exists, initialization is never dispatched again, even after a crash before sending. A lost initialization response with no durable session reference remains an investigation hold. This deliberately sacrifices progress rather than guessing.
- Each chunk records intent and highest attempted byte before dispatch. Uncertain outcomes permit only a query of the stored session. Acknowledgements must be a contiguous, nonregressing prefix within attempted bytes. Missing Range means zero bytes, not the end of a chunk. An expired, inconsistent or failed query leaves the operation held. A complete prefix without a final video ID is not accepted as completion.
- The first completion candidate ID is durable before querying video identity. A different subsequent ID is rejected. Channel and private status must be verified before finishing. All finishing operations stay on that video; uncertain caption/thumbnail outcomes are query-only, with no repeated caption insert or new upload.
- Initialization metadata must request `private`, not `unlisted` or `public`. Scheduled-publication fields are not accepted. Current channel is rechecked on every action, including initialization and public promotion.
- Promotion requires both finished assets, fresh private/processed/metadata/resolution/duration checks and explicit hash-bound human evidence for artifact acceptance, rights, privacy, voice, music, audience, full decode, audio, captions, thumbnail, metadata and private playback. The explicit public authorization and reviewer/time are durably saved before dispatch.
- An uncertain promotion is query-only on the same video. A private read-back does not authorize retry. Public read-back is not final acceptance: a separate explicit hash/video-bound logged-out playback review advances `public` to `accepted`.
- Public results contain only fixed diagnostic codes, operation/lane/state/byte count/video ID. Raw adapter errors, session handles, input content and paths are never returned. Receipts contain opaque session references, not session URLs or credentials.

This establishes **at-most-once initialization dispatch with fail-closed ambiguity**, not exactly-once video creation. It does not protect against a trusted user deleting receipts, selecting another store root, rolling back disk snapshots, modifying code, or another uploader acting outside this store. Use one canonical store and one uploader owner; preserve receipt history. Do not solve an unknown outcome by copying the files to another directory or choosing another operation. A local trusted-user lock is not a distributed lock, cryptographic audit log, encrypted vault or power-loss qualification. Unsupported network filesystems and Windows are outside this implementation.

## Core API and adapter seam

`run(root, operation_id=..., lane=..., expected_channel=..., files=..., action=..., adapter=..., evidence=...)` performs at most one selected transition. `files` has exactly `master`, `metadata`, `captions`, `thumbnail`; values are explicit paths. Required metadata shape:

```json
{
  "snippet": {"title": "An independently reviewed title", "description": "Reviewed metadata"},
  "status": {"privacyStatus": "private", "selfDeclaredMadeForKids": false}
}
```

The preproduction manifest templates are intentionally rejected as upload metadata. Neither those templates nor these tests supply genuine review evidence.

Actions: `initialize`, `chunk`, `reconcile`, `captions`, `thumbnail`, `promote`, `accept`. Calls return a sanitized object; false results must never trigger a new operation or an implicit mutation retry. A receipt remains authoritative after interruption. Review evidence binds the entire receipt `binding` and `videoId`, has a safe reviewer identifier, timezone-qualified `reviewedAt`, named `checks` with literal boolean `true`, and (for promotion) `authorizePublic: true`. Human statements are recorded as attestations, not automatically verified facts. Reviewer authentication, signed review provenance and a real approval UI are not implemented.

Enabled adapters must declare `is_synthetic = True`. That flag is a trusted test seam, not a sandbox: arbitrary supplied Python can do arbitrary work. The included fake makes no network calls. Do not label a live adapter synthetic to bypass the boundary.

Adapter contract for offline tests:

| Method | Contract |
| --- | --- |
| `channel()` | Single verified channel ID, ambiguity rejected by adapter |
| `initialize(binding, metadata_bytes, privacy="private")` | One dispatch, no retries; returns durable opaque session reference, never a URL |
| `chunk(session, start, bytes, total)` | One dispatch; returns incomplete range or completion candidate ID |
| `query(session, total)` | Read-only reconciliation of exactly that session |
| `video(video_id)` | Read-back identity, channel, privacy, processed state, intended resolution/duration, verified expected metadata hash |
| `finish(video_id, kind, bytes, sha256)` | One caption or thumbnail mutation; no retries |
| `finishing_status(video_id, kind, sha256)` | True only for the expected serving caption track / verified thumbnail associated with those exact source bytes |
| `promote(video_id, privacy="public")` | One privacy update, never upload/create; preserve unrelated metadata |

The intended-resolution/duration and asset-hash assertions are **synthetic contracts**, not claims that YouTube's API natively returns source SHA-256 or those booleans. A future live adapter needs documented evidence mapping, remote canonicalization, actual serving/processing checks and human playback receipts. It also needs a protected durable session-reference vault, safe approved credential runtime, restricted session URL destinations, timeouts, no hidden mutation retries and explicit API error handling. None is supplied here. Existing Secrets Manager access is blocked; this package does not bypass it.

A future transport must not return success before durable session mapping is available. If mapping persistence is uncertain, initialization must stay held. The core does not magically recover a URL lost before it was saved. No automatic replacement is safe merely because an old session expired or a video search found nothing.

## Verification boundary

On 2026-09-23, `python3 -B docs/launch-films/publish/test_uploader.py` passed **46 tests** on macOS with Python 3.13.14, including a child process terminating with `os._exit` after initialization intent. This is process-interruption evidence, not a power-loss test. GPT-6 Astra independently reviewed the fail-closed initialization decision and agreed that at-most-once dispatch, retained lane receipts and query-only uncertain recovery are required; this was a design opinion, not a code audit.

The synthetic suite checks private-first success; distinct lanes; channel/operation/hash conflicts; rejected preproduction metadata; restart and cross-process exclusion; crash before dispatch and before outcome persistence; lost initialization/chunk/final/promotion responses; query-only recovery; strict range validation; candidate video-ID binding; finishing failures; every human promotion gate; processing checks; public playback acceptance; store permissions and link rejection; changed input; sanitized diagnostics; and disabled live transport.

No real media decode, loudness, privacy, rights, caption timing, account eligibility, processing, playback, monetization, upload, remote retry or actual filesystem power loss is verified. SWM monetization still requires Studio confirmation. No historical videos, playlists, comments or pins are touched. Production templates remain blocked and unchanged.
