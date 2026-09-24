"""Offline, injectable state machine. No credential or network implementation."""
import contextlib
import fcntl
import hashlib
import json
import os
import re
import stat
import uuid
from datetime import datetime, timezone

CHANNELS = {
    "software": "UCIQxSp5Zp2Oaz9a22USFyfg",
    "mycology": "UCTXP5BRecHpwa7_sFbbyMng",
}
CHUNK = 16 * 1024 * 1024
LIMIT = 1024 * 1024
STATES = {"ready", "init_intent", "uploading", "chunk_intent", "private",
          "captions_intent", "thumbnail_intent", "promote_intent", "public", "accepted"}
GATES = {"artifact", "rights", "privacy", "voice", "music", "audience", "decode",
         "audio", "captions", "thumbnail", "metadata", "private_playback"}


CODES = frozenset("""UNSAFE_FILE UNSAFE_STORE INPUT_REQUIRED EMPTY_INPUT INPUT_TOO_LARGE
INPUT_CHANGED PRIVATE_METADATA_REQUIRED INVALID_METADATA LOCKED INVALID_RECEIPT RECEIPT_FULL
OPERATION_CONFLICT CHANNEL_MISMATCH VIDEO_MISMATCH INVALID_PROGRESS INVALID_COMPLETION
PRIVATE_REQUIRED INVALID_RANGE EVIDENCE_MISMATCH REVIEW_REQUIRED GATES_INCOMPLETE APPROVAL_REQUIRED
LIVE_TRANSPORT_UNAVAILABLE LANE_CHANNEL_MISMATCH INVALID_OPERATION_ID INVALID_ACTION RECEIPT_REQUIRED
INITIALIZATION_ALREADY_INTENDED INVALID_SESSION_REFERENCE RECONCILIATION_REQUIRED
INITIALIZATION_OUTCOME_UNKNOWN FINISHING_OUTCOME_UNKNOWN PROMOTION_OUTCOME_UNKNOWN NOT_RECONCILABLE
FINISHING_ALREADY_COMPLETE FINISHING_REQUIRED PROCESSING_REQUIRED PUBLIC_REQUIRED""".split())


class Hold(Exception):
    """Only fixed, non-sensitive diagnostic codes cross the public boundary."""


def need(condition, code):
    if not condition:
        raise Hold(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def identifier(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value)


def stamp(s):
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns


def checked_file(fd, private=False):
    s = os.fstat(fd)
    need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1, "UNSAFE_FILE")
    if private:
        need(s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) == 0o600, "UNSAFE_STORE")
    return s


@contextlib.contextmanager
def inputs(files):
    """Keep the hashed master descriptor open, never reopen it by pathname."""
    handles = {}
    try:
        hashes, sizes, data, stamps = {}, {}, {}, {}
        need(set(files) == {"master", "metadata", "captions", "thumbnail"}, "INPUT_REQUIRED")
        for kind, name in files.items():
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            handles[kind] = fd
            before = checked_file(fd)
            need(before.st_size > 0, "EMPTY_INPUT")
            need(kind == "master" or before.st_size <= LIMIT, "INPUT_TOO_LARGE")
            h, parts = hashlib.sha256(), []
            while True:
                part = os.read(fd, LIMIT)
                if not part:
                    break
                h.update(part)
                if kind != "master":
                    parts.append(part)
            after = checked_file(fd)
            need(stamp(before) == stamp(after), "INPUT_CHANGED")
            hashes[kind], sizes[kind], stamps[kind] = h.hexdigest(), before.st_size, after
            if kind != "master":
                data[kind] = b"".join(parts)
        metadata = json.loads(data["metadata"])
        need(isinstance(metadata, dict) and set(metadata) == {"snippet", "status"}, "PRIVATE_METADATA_REQUIRED")
        need(metadata["status"] == {"privacyStatus": "private", "selfDeclaredMadeForKids": False}, "PRIVATE_METADATA_REQUIRED")
        need(isinstance(metadata["snippet"], dict) and isinstance(metadata["snippet"].get("title"), str)
             and metadata["snippet"]["title"].strip(), "INVALID_METADATA")
        yield handles, hashes, sizes, data, stamps
    finally:
        for fd in handles.values():
            os.close(fd)


class Store:
    """One permanent receipt per lane; advisory lock spans the whole operation.

    Requires a local POSIX filesystem, one trusted OS user, and a canonical root.
    No stale-lock deletion: flock releases on process exit, the inode stays put.
    """
    def __init__(self, root):
        self.root = root
        self.fd = self.lock = None

    def __enter__(self):
        need(os.path.isabs(self.root) and os.path.realpath(self.root) == self.root, "UNSAFE_STORE")
        try:
            os.mkdir(self.root, 0o700)
        except FileExistsError:
            pass
        self.fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            s = os.fstat(self.fd)
            need(s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) == 0o700, "UNSAFE_STORE")
            self.lock = os.open("lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=self.fd)
            checked_file(self.lock, True)
            try:
                fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Hold("LOCKED") from None
            os.fsync(self.lock)
            os.fsync(self.fd)
            # Make the root creation durable before allowing any external intent.
            parent = os.open(os.path.dirname(self.root), os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        if self.lock is not None:
            os.close(self.lock)
        if self.fd is not None:
            os.close(self.fd)

    def read(self, lane):
        try:
            fd = os.open(lane + ".json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        except FileNotFoundError:
            return None
        try:
            need(checked_file(fd, True).st_size <= LIMIT, "INVALID_RECEIPT")
            return json.loads(os.read(fd, LIMIT + 1))
        finally:
            os.close(fd)

    def save(self, receipt):
        receipt["sequence"] += 1
        receipt["history"].append({"sequence": receipt["sequence"], "state": receipt["state"],
                                   "ack": receipt["ack"], "at": datetime.now(timezone.utc).isoformat()})
        raw = encoded(receipt)
        need(len(raw) <= LIMIT, "RECEIPT_FULL")
        temp = ".pending-" + uuid.uuid4().hex
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        try:
            with os.fdopen(fd, "wb") as out:
                out.write(raw)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temp, receipt["binding"]["lane"] + ".json", src_dir_fd=self.fd, dst_dir_fd=self.fd)
            os.fsync(self.fd)
        finally:
            try:
                os.unlink(temp, dir_fd=self.fd)
            except FileNotFoundError:
                pass


class LiveTransport:
    is_synthetic = False


def summary(receipt):
    return {"operationId": receipt["binding"]["operationId"], "lane": receipt["binding"]["lane"],
            "state": receipt["state"], "acknowledgedBytes": receipt["ack"], "videoId": receipt["videoId"]}


def validate_receipt(r, binding):
    need(isinstance(r, dict) and r.get("schema") == 1 and r.get("binding") == binding, "OPERATION_CONFLICT")
    need(r.get("state") in STATES and type(r.get("ack")) is int and type(r.get("attempted")) is int,
         "INVALID_RECEIPT")
    need(0 <= r["ack"] <= r["attempted"] <= binding["sizes"]["master"], "INVALID_RECEIPT")
    need(type(r.get("sequence")) is int and isinstance(r.get("history"), list)
         and len(r["history"]) == r["sequence"], "INVALID_RECEIPT")
    need(r.get("session") is None or identifier(r["session"]), "INVALID_RECEIPT")
    need(r.get("videoId") is None or identifier(r["videoId"]), "INVALID_RECEIPT")
    need(isinstance(r.get("finished"), dict) and set(r["finished"]) == {"captions", "thumbnail"}
         and all(type(v) is bool for v in r["finished"].values()), "INVALID_RECEIPT")
    if r["state"] in {"ready", "init_intent"}:
        need(r["ack"] == r["attempted"] == 0 and r["session"] is None and r["videoId"] is None, "INVALID_RECEIPT")
    else:
        need(identifier(r["session"]), "INVALID_RECEIPT")
    if r["state"] not in {"ready", "init_intent", "uploading", "chunk_intent"}:
        need(identifier(r["videoId"]) and r["ack"] == binding["sizes"]["master"], "INVALID_RECEIPT")


def same_channel(adapter, binding):
    need(adapter.channel() == binding["expectedChannelId"], "CHANNEL_MISMATCH")


def video(adapter, r):
    observed = adapter.video(r["videoId"])
    need(isinstance(observed, dict) and observed.get("videoId") == r["videoId"]
         and observed.get("channelId") == r["binding"]["expectedChannelId"], "VIDEO_MISMATCH")
    return observed


def progress(adapter, store, r, result):
    need(isinstance(result, dict), "INVALID_PROGRESS")
    if result.get("kind") == "complete":
        need(r["attempted"] == r["binding"]["sizes"]["master"] and identifier(result.get("videoId")), "INVALID_COMPLETION")
        need(r["videoId"] in (None, result["videoId"]), "VIDEO_MISMATCH")
        # Persist the candidate ID before any subsequent read can fail. State
        # remains uncertain until channel/private status have been verified.
        r["videoId"] = result["videoId"]
        store.save(r)
        observed = video(adapter, r)
        need(observed.get("privacy") == "private", "PRIVATE_REQUIRED")
        r["ack"] = r["binding"]["sizes"]["master"]
        r["state"] = "private"
    else:
        need(result.get("kind") == "incomplete" and r["videoId"] is None, "INVALID_PROGRESS")
        # Missing Range means NO bytes, never the end of the attempted chunk.
        value = result.get("range")
        if value is None:
            ack = 0
        else:
            need(isinstance(value, str) and re.fullmatch(r"bytes=0-(0|[1-9][0-9]*)", value), "INVALID_RANGE")
            ack = int(value[8:]) + 1
        need(r["ack"] <= ack <= r["attempted"] and ack < r["binding"]["sizes"]["master"], "INVALID_RANGE")
        r["ack"], r["state"] = ack, "uploading"
    store.save(r)


def gate(evidence, r, action):
    need(isinstance(evidence, dict) and evidence.get("binding") == r["binding"]
         and evidence.get("videoId") == r["videoId"], "EVIDENCE_MISMATCH")
    need(identifier(evidence.get("reviewer")) and isinstance(evidence.get("reviewedAt"), str), "REVIEW_REQUIRED")
    try:
        reviewed = datetime.fromisoformat(evidence["reviewedAt"])
        need(reviewed.tzinfo is not None and reviewed <= datetime.now(timezone.utc), "REVIEW_REQUIRED")
    except ValueError:
        raise Hold("REVIEW_REQUIRED") from None
    checks = evidence.get("checks")
    required = GATES if action == "promote" else {"logged_out_playback"}
    need(isinstance(checks, dict) and all(checks.get(k) is True for k in required), "GATES_INCOMPLETE")
    if action == "promote":
        need(evidence.get("authorizePublic") is True, "APPROVAL_REQUIRED")


def run(root, *, operation_id, lane, expected_channel, files, action, adapter=None, evidence=None):
    """One transition per call. Adapter methods are trusted, retry-free test seams.

    Only synthetic adapters are enabled. All returned diagnostics are allowlisted;
    exception bodies, paths, metadata, and session handles never leave this API.
    """
    try:
        need(adapter is not None and getattr(adapter, "is_synthetic", False) is True, "LIVE_TRANSPORT_UNAVAILABLE")
        need(lane in CHANNELS and expected_channel == CHANNELS[lane], "LANE_CHANNEL_MISMATCH")
        need(str(uuid.UUID(operation_id)) == operation_id, "INVALID_OPERATION_ID")
        need(action in {"initialize", "chunk", "reconcile", "captions", "thumbnail", "promote", "accept"}, "INVALID_ACTION")
        with Store(root) as store, inputs(files) as (handles, hashes, sizes, data, stamps):
            binding = {"operationId": operation_id, "lane": lane, "expectedChannelId": expected_channel,
                       "hashes": hashes, "sizes": sizes}
            r = store.read(lane)
            if r is None:
                need(action == "initialize", "RECEIPT_REQUIRED")
                r = {"schema": 1, "binding": binding, "state": "ready", "ack": 0, "attempted": 0,
                     "session": None, "videoId": None, "finished": {"captions": False, "thumbnail": False},
                     "sequence": 0, "history": [], "approval": None, "publicAcceptance": None}
                store.save(r)
            validate_receipt(r, binding)
            same_channel(adapter, binding)
            if action == "initialize":
                need(r["state"] == "ready", "INITIALIZATION_ALREADY_INTENDED")
                r["state"] = "init_intent"
                store.save(r)
                session = adapter.initialize(binding, data["metadata"], privacy="private")
                need(identifier(session), "INVALID_SESSION_REFERENCE")
                r["session"], r["state"] = session, "uploading"
                store.save(r)
            elif action == "chunk":
                need(r["state"] == "uploading", "RECONCILIATION_REQUIRED")
                start = r["ack"]
                fd = handles["master"]
                os.lseek(fd, start, os.SEEK_SET)
                body = os.read(fd, min(CHUNK, sizes["master"] - start))
                need(len(body) == min(CHUNK, sizes["master"] - start) and stamp(checked_file(fd)) == stamp(stamps["master"]), "INPUT_CHANGED")
                r["attempted"] = max(r["attempted"], start + len(body))
                r["state"] = "chunk_intent"
                store.save(r)
                result = adapter.chunk(r["session"], start, body, sizes["master"])
                progress(adapter, store, r, result)
            elif action == "reconcile":
                need(r["state"] != "init_intent", "INITIALIZATION_OUTCOME_UNKNOWN")
                if r["state"] in {"chunk_intent", "uploading"}:
                    # Even a voluntary query can discover an expired or
                    # contradictory session. No further chunk until resolved.
                    r["state"] = "chunk_intent"
                    store.save(r)
                    progress(adapter, store, r, adapter.query(r["session"], sizes["master"]))
                elif r["state"] in {"captions_intent", "thumbnail_intent"}:
                    kind = r["state"].split("_")[0]
                    observed = video(adapter, r)
                    need(observed.get("privacy") == "private", "PRIVATE_REQUIRED")
                    need(adapter.finishing_status(r["videoId"], kind, hashes[kind]) is True, "FINISHING_OUTCOME_UNKNOWN")
                    r["finished"][kind], r["state"] = True, "private"
                    store.save(r)
                elif r["state"] == "promote_intent":
                    need(video(adapter, r).get("privacy") == "public", "PROMOTION_OUTCOME_UNKNOWN")
                    r["state"] = "public"
                    store.save(r)
                else:
                    raise Hold("NOT_RECONCILABLE")
            elif action in {"captions", "thumbnail"}:
                need(r["state"] == "private", "PRIVATE_REQUIRED")
                need(not r["finished"][action], "FINISHING_ALREADY_COMPLETE")
                need(video(adapter, r).get("privacy") == "private", "PRIVATE_REQUIRED")
                r["state"] = action + "_intent"
                store.save(r)
                adapter.finish(r["videoId"], action, data[action], hashes[action])
                need(adapter.finishing_status(r["videoId"], action, hashes[action]) is True, "FINISHING_OUTCOME_UNKNOWN")
                r["finished"][action], r["state"] = True, "private"
                store.save(r)
            elif action == "promote":
                need(r["state"] == "private" and all(r["finished"].values()), "FINISHING_REQUIRED")
                gate(evidence, r, action)
                observed = video(adapter, r)
                need(observed.get("privacy") == "private" and observed.get("processed") is True
                     and observed.get("intendedResolution") is True and observed.get("intendedDuration") is True
                     and observed.get("metadataSha256") == hashes["metadata"], "PROCESSING_REQUIRED")
                for kind in ("captions", "thumbnail"):
                    need(adapter.finishing_status(r["videoId"], kind, hashes[kind]) is True, "FINISHING_REQUIRED")
                # Persist only the exact binding, explicit booleans and reviewer,
                # never arbitrary caller-supplied evidence or diagnostic strings.
                r["approval"] = {"binding": binding, "videoId": r["videoId"], "reviewer": evidence["reviewer"],
                                 "reviewedAt": evidence["reviewedAt"], "checks": {k: True for k in sorted(GATES)},
                                 "authorizePublic": True}
                r["state"] = "promote_intent"
                store.save(r)
                adapter.promote(r["videoId"], privacy="public")
                need(video(adapter, r).get("privacy") == "public", "PROMOTION_OUTCOME_UNKNOWN")
                r["state"] = "public"
                store.save(r)
            else:
                need(r["state"] == "public", "PUBLIC_REQUIRED")
                gate(evidence, r, action)
                need(video(adapter, r).get("privacy") == "public", "PUBLIC_REQUIRED")
                r["publicAcceptance"] = {"binding": binding, "videoId": r["videoId"], "reviewer": evidence["reviewer"],
                                         "reviewedAt": evidence["reviewedAt"], "loggedOutPlayback": True}
                r["state"] = "accepted"
                store.save(r)
            return {"ok": True, **summary(r)}
    except Hold as error:
        return {"ok": False, "code": str(error) if str(error) in CODES else "OPERATION_HELD"}
    except Exception:
        # Even parse/transport/IO errors can embed a URL, token or private path.
        return {"ok": False, "code": "OPERATION_HELD"}


if __name__ == "__main__":
    print("LIVE_TRANSPORT_UNAVAILABLE: run the offline synthetic tests only.")
    raise SystemExit(2)
