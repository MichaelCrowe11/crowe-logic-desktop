"""Wholly fake media, adapter, channels and review evidence. No network imports."""
import copy
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

import uploader as u


class Crash(BaseException):
    pass


class Fake:
    is_synthetic = True

    def __init__(self):
        self.calls = []
        self.channel_id = u.CHANNELS["software"]
        self.session = "synthetic_session"
        self.video_id = "synthetic_video"
        self.ack = 0
        self.privacy = "private"
        self.finished = {}
        self.fail = None
        self.result = None
        self.observed = {}
        self.on_call = None

    def call(self, name):
        self.calls.append(name)
        if self.on_call:
            self.on_call(name)
        if self.fail == name:
            raise RuntimeError("https://synthetic.invalid/?token=DO_NOT_LOG")

    def channel(self):
        self.call("channel")
        return self.channel_id

    def initialize(self, binding, metadata, *, privacy):
        self.binding = copy.deepcopy(binding)
        self.metadata = bytes(metadata)
        assert privacy == "private"
        assert json.loads(metadata)["status"]["privacyStatus"] == "private"
        self.call("initialize")
        return self.session

    def chunk(self, session, start, body, total):
        assert session == self.session
        assert start == self.ack
        self.ack = start + len(body)
        self.total = total
        self.call("chunk")
        return self.progress()

    def progress(self):
        if self.result is not None:
            return copy.deepcopy(self.result)
        if self.ack == self.total:
            return {"kind": "complete", "videoId": self.video_id}
        return {"kind": "incomplete", "range": f"bytes=0-{self.ack - 1}"} if self.ack else {"kind": "incomplete"}

    def query(self, session, total):
        assert session == self.session
        self.total = total
        self.call("query")
        return self.progress()

    def video(self, video_id):
        assert video_id == "synthetic_video"
        self.call("video")
        return {"videoId": video_id, "channelId": self.channel_id, "privacy": self.privacy,
                "processed": True, "intendedResolution": True, "intendedDuration": True,
                "metadataSha256": u.sha(self.metadata), **self.observed}

    def finish(self, video_id, kind, body, digest):
        assert video_id == self.video_id
        assert u.sha(body) == digest
        self.finished[kind] = digest
        self.call(kind)

    def finishing_status(self, video_id, kind, digest):
        assert video_id == self.video_id
        self.call("status_" + kind)
        return self.finished.get(kind) == digest

    def promote(self, video_id, *, privacy):
        assert video_id == self.video_id and privacy == "public"
        self.privacy = "public"
        self.call("promote")


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="film-upload-fake-")
        self.base = pathlib.Path(os.path.realpath(self.temp.name))
        self.root = str(self.base / "receipts")
        metadata = {"snippet": {"title": "SYNTHETIC TEST ONLY"},
                    "status": {"privacyStatus": "private", "selfDeclaredMadeForKids": False}}
        self.files = {}
        for kind, body in {"master": b"synthetic media bytes only", "metadata": u.encoded(metadata),
                           "captions": b"synthetic caption bytes", "thumbnail": b"synthetic image bytes"}.items():
            p = self.base / kind
            p.write_bytes(body)
            self.files[kind] = str(p)
        self.adapter = Fake()
        self.operation = str(uuid.uuid4())
        self.chunk_patch = patch.object(u, "CHUNK", 8)
        self.chunk_patch.start()

    def tearDown(self):
        self.chunk_patch.stop()
        self.temp.cleanup()

    def run_action(self, action, **overrides):
        params = {"operation_id": self.operation, "lane": "software", "expected_channel": u.CHANNELS["software"],
                  "files": self.files, "adapter": self.adapter, "action": action}
        params.update(overrides)
        return u.run(self.root, **params)

    def ok(self, action, **kwargs):
        result = self.run_action(action, **kwargs)
        self.assertTrue(result["ok"], result)
        return result

    def held(self, action, code=None, **kwargs):
        result = self.run_action(action, **kwargs)
        self.assertFalse(result["ok"], result)
        if code:
            self.assertEqual(result["code"], code)
        self.assertNotIn("DO_NOT_LOG", json.dumps(result))
        self.assertNotIn(self.adapter.session, json.dumps(result))
        return result

    def receipt(self):
        return json.loads((pathlib.Path(self.root) / "software.json").read_bytes())

    def private(self):
        self.ok("initialize")
        for _ in range(20):
            if self.receipt()["state"] == "private":
                return
            self.ok("chunk")
        self.fail("did not finish synthetic upload")

    def finished(self):
        self.private()
        self.ok("captions")
        self.ok("thumbnail")

    def evidence(self):
        r = self.receipt()
        return {"binding": copy.deepcopy(r["binding"]), "videoId": r["videoId"], "reviewer": "synthetic_reviewer",
                "reviewedAt": "2026-01-01T00:00:00+00:00", "checks": {k: True for k in u.GATES | {"logged_out_playback"}},
                "authorizePublic": True}

    def test_private_first_to_explicit_public_acceptance(self):
        self.finished()
        self.ok("promote", evidence=self.evidence())
        self.assertEqual(self.receipt()["state"], "public")
        self.ok("accept", evidence=self.evidence())
        self.assertEqual(self.receipt()["state"], "accepted")
        self.held("initialize", "INITIALIZATION_ALREADY_INTENDED")
        self.assertEqual(self.adapter.calls.count("initialize"), 1)

    def test_live_transport_disabled_before_files_or_store(self):
        self.held("initialize", "LIVE_TRANSPORT_UNAVAILABLE", adapter=u.LiveTransport())
        self.assertFalse(os.path.exists(self.root))

    def test_lane_requires_exact_channel(self):
        self.held("initialize", "LANE_CHANNEL_MISMATCH", expected_channel=u.CHANNELS["mycology"])
        self.assertEqual(self.adapter.calls, [])

    def test_mycology_lane(self):
        self.adapter.channel_id = u.CHANNELS["mycology"]
        self.ok("initialize", lane="mycology", expected_channel=u.CHANNELS["mycology"])
        self.assertTrue((pathlib.Path(self.root) / "mycology.json").is_file())

    def test_authenticated_channel_mismatch_prevents_initialize(self):
        self.adapter.channel_id = u.CHANNELS["mycology"]
        self.held("initialize", "CHANNEL_MISMATCH")
        self.assertNotIn("initialize", self.adapter.calls)

    def test_reenter_cannot_initialize_twice(self):
        self.ok("initialize")
        self.held("initialize", "INITIALIZATION_ALREADY_INTENDED")
        self.assertEqual(self.adapter.calls.count("initialize"), 1)

    def test_new_operation_id_cannot_bypass_lane_receipt(self):
        self.ok("initialize")
        self.held("initialize", "OPERATION_CONFLICT", operation_id=str(uuid.uuid4()))
        self.assertEqual(self.adapter.calls.count("initialize"), 1)

    def test_exact_bytes_bound_for_each_input(self):
        self.ok("initialize")
        for kind, filename in self.files.items():
            with self.subTest(kind=kind):
                p = pathlib.Path(filename)
                original = p.read_bytes()
                p.write_bytes(original + (b" " if kind == "metadata" else b"x"))
                self.held("chunk", "OPERATION_CONFLICT")
                p.write_bytes(original)
        self.assertNotIn("chunk", self.adapter.calls)

    def test_nonprivate_metadata_rejected(self):
        p = pathlib.Path(self.files["metadata"])
        p.write_bytes(p.read_bytes().replace(b"private", b"unlisted"))
        self.held("initialize", "PRIVATE_METADATA_REQUIRED")
        self.assertEqual(self.adapter.calls, [])

    def test_preproduction_template_is_not_payload(self):
        pathlib.Path(self.files["metadata"]).write_text('{"isPublicationPayload":false}')
        self.held("initialize", "PRIVATE_METADATA_REQUIRED")

    def test_lost_initialization_never_retries(self):
        self.adapter.fail = "initialize"
        self.held("initialize")
        self.assertEqual(self.receipt()["state"], "init_intent")
        self.adapter.fail = None
        self.held("initialize", "INITIALIZATION_ALREADY_INTENDED")
        self.held("reconcile", "INITIALIZATION_OUTCOME_UNKNOWN")
        self.held("chunk", "RECONCILIATION_REQUIRED")
        self.assertEqual(self.adapter.calls.count("initialize"), 1)

    def test_crash_after_intent_before_dispatch(self):
        real = u.Store.save
        def crash(store, r):
            real(store, r)
            if r["state"] == "init_intent":
                raise Crash()
        with patch.object(u.Store, "save", crash), self.assertRaises(Crash):
            self.run_action("initialize")
        self.held("initialize", "INITIALIZATION_ALREADY_INTENDED")
        self.assertNotIn("initialize", self.adapter.calls)

    def test_crash_after_initialization_before_outcome_save(self):
        real = u.Store.save
        def crash(store, r):
            if r["state"] == "uploading":
                raise Crash()
            real(store, r)
        with patch.object(u.Store, "save", crash), self.assertRaises(Crash):
            self.run_action("initialize")
        self.held("reconcile", "INITIALIZATION_OUTCOME_UNKNOWN")
        self.assertEqual(self.adapter.calls.count("initialize"), 1)

    def test_intent_is_on_disk_before_every_mutation(self):
        mapping = {"initialize": "init_intent", "chunk": "chunk_intent", "captions": "captions_intent",
                   "thumbnail": "thumbnail_intent", "promote": "promote_intent"}
        def check(name):
            if name in mapping:
                self.assertEqual(self.receipt()["state"], mapping[name])
        self.adapter.on_call = check
        self.finished()
        self.ok("promote", evidence=self.evidence())

    def test_lost_chunk_requires_same_session_query(self):
        self.ok("initialize")
        self.adapter.fail = "chunk"
        self.held("chunk")
        self.assertEqual(self.receipt()["ack"], 0)
        self.held("chunk", "RECONCILIATION_REQUIRED")
        self.adapter.fail = None
        self.ok("reconcile")
        self.assertEqual(self.receipt()["ack"], 8)
        self.ok("chunk")
        self.assertEqual(self.adapter.calls.count("query"), 1)

    def test_lost_final_response_recovers_same_video(self):
        self.ok("initialize")
        while self.adapter.ack + 8 < pathlib.Path(self.files["master"]).stat().st_size:
            self.ok("chunk")
        self.adapter.fail = "chunk"
        self.held("chunk")
        self.adapter.fail = None
        self.ok("reconcile")
        self.assertEqual(self.receipt()["videoId"], "synthetic_video")
        self.assertEqual(self.receipt()["state"], "private")
        self.assertEqual(self.adapter.calls.count("initialize"), 1)

    def test_completion_id_persisted_before_video_lookup(self):
        self.ok("initialize")
        while self.adapter.ack + 8 < pathlib.Path(self.files["master"]).stat().st_size:
            self.ok("chunk")
        self.adapter.fail = "video"
        self.held("chunk")
        self.assertEqual(self.receipt()["videoId"], "synthetic_video")
        self.adapter.fail = None
        self.adapter.video_id = "different_video"
        self.held("reconcile", "VIDEO_MISMATCH")

    def test_invalid_ranges_do_not_advance_receipt(self):
        self.ok("initialize")
        for value in ["bytes=1-7", "bytes=0-999999", "bytes=0--1", "7", "bytes=0-7,9-10", "bytes=0-01", 7]:
            with self.subTest(value=value):
                self.adapter.result = {"kind": "incomplete", "range": value}
                self.held("reconcile", "INVALID_RANGE")
                self.assertEqual(self.receipt()["ack"], 0)

    def test_missing_range_means_zero_not_attempted_end(self):
        self.ok("initialize")
        self.adapter.result = {"kind": "incomplete"}
        self.ok("chunk")
        self.assertEqual(self.receipt()["ack"], 0)

    def test_regressing_range_rejected(self):
        self.ok("initialize")
        self.ok("chunk")
        self.adapter.result = {"kind": "incomplete"}
        self.held("reconcile", "INVALID_RANGE")
        self.assertEqual(self.receipt()["ack"], 8)

    def test_premature_completion_rejected(self):
        self.ok("initialize")
        self.adapter.result = {"kind": "complete", "videoId": "synthetic_video"}
        self.held("chunk", "INVALID_COMPLETION")

    def test_expired_session_never_replaced(self):
        self.ok("initialize")
        self.adapter.result = {"kind": "expired"}
        self.held("reconcile", "INVALID_PROGRESS")
        self.held("initialize", "INITIALIZATION_ALREADY_INTENDED")

    def test_query_failure_does_not_dispatch_chunk(self):
        self.ok("initialize")
        self.adapter.fail = "chunk"
        self.held("chunk")
        self.adapter.fail = "query"
        self.held("reconcile")
        self.held("chunk", "RECONCILIATION_REQUIRED")
        self.assertEqual(self.adapter.calls.count("chunk"), 1)

    def test_finishing_failure_holds_same_video(self):
        self.private()
        self.adapter.fail = "captions"
        self.held("captions")
        self.held("promote", "FINISHING_REQUIRED", evidence=self.evidence())
        self.held("captions", "PRIVATE_REQUIRED")
        self.adapter.fail = None
        self.ok("reconcile")
        self.ok("thumbnail")
        self.assertEqual(self.adapter.calls.count("initialize"), 1)
        self.assertEqual(self.adapter.calls.count("captions"), 1)

    def test_missing_serving_caption_never_retries_insert(self):
        self.private()
        self.adapter.fail = "captions"
        self.held("captions")
        self.adapter.finished.clear()
        self.adapter.fail = None
        self.held("reconcile", "FINISHING_OUTCOME_UNKNOWN")
        self.held("captions", "PRIVATE_REQUIRED")

    def test_thumbnail_lost_response_reconciles(self):
        self.private()
        self.adapter.fail = "thumbnail"
        self.held("thumbnail")
        self.adapter.fail = None
        self.ok("reconcile")
        self.assertTrue(self.receipt()["finished"]["thumbnail"])

    def test_promotion_requires_every_exact_hash_gate(self):
        self.finished()
        for gate in u.GATES:
            e = self.evidence()
            e["checks"][gate] = False
            self.held("promote", "GATES_INCOMPLETE", evidence=e)
        e = self.evidence()
        e["binding"]["hashes"]["master"] = "0" * 64
        self.held("promote", "EVIDENCE_MISMATCH", evidence=e)
        e = self.evidence()
        e["authorizePublic"] = False
        self.held("promote", "APPROVAL_REQUIRED", evidence=e)
        self.assertNotIn("promote", self.adapter.calls)

    def test_processing_and_channel_rechecked(self):
        self.finished()
        for key in ["processed", "intendedDuration", "intendedResolution"]:
            self.adapter.observed = {key: False}
            self.held("promote", "PROCESSING_REQUIRED", evidence=self.evidence())
        self.adapter.observed = {"metadataSha256": "wrong"}
        self.held("promote", "PROCESSING_REQUIRED", evidence=self.evidence())
        self.adapter.observed = {}
        self.adapter.channel_id = u.CHANNELS["mycology"]
        self.held("promote", "CHANNEL_MISMATCH", evidence=self.evidence())
        self.assertNotIn("promote", self.adapter.calls)

    def test_lost_promotion_only_queries(self):
        self.finished()
        self.adapter.fail = "promote"
        self.held("promote", evidence=self.evidence())
        self.assertEqual(self.receipt()["state"], "promote_intent")
        self.adapter.fail = None
        self.held("promote", "FINISHING_REQUIRED", evidence=self.evidence())
        self.ok("reconcile")
        self.assertEqual(self.receipt()["state"], "public")
        self.assertEqual(self.adapter.calls.count("promote"), 1)
        self.assertIsNone(self.receipt()["publicAcceptance"])

    def test_private_readback_does_not_reissue_promotion(self):
        self.finished()
        self.adapter.fail = "promote"
        self.held("promote", evidence=self.evidence())
        self.adapter.fail = None
        self.adapter.privacy = "private"
        self.held("reconcile", "PROMOTION_OUTCOME_UNKNOWN")
        self.held("promote", "FINISHING_REQUIRED", evidence=self.evidence())
        self.assertEqual(self.adapter.calls.count("promote"), 1)

    def test_public_requires_logged_out_playback_acceptance(self):
        self.finished()
        self.ok("promote", evidence=self.evidence())
        e = self.evidence()
        e["checks"]["logged_out_playback"] = False
        self.held("accept", "GATES_INCOMPLETE", evidence=e)
        self.assertEqual(self.receipt()["state"], "public")

    def test_private_store_and_receipt_modes(self):
        self.ok("initialize")
        self.assertEqual(os.stat(self.root).st_mode & 0o777, 0o700)
        for name in ["lock", "software.json"]:
            self.assertEqual(os.stat(os.path.join(self.root, name)).st_mode & 0o777, 0o600)
        os.chmod(os.path.join(self.root, "software.json"), 0o644)
        self.held("chunk", "UNSAFE_STORE")

    def test_symlinks_and_hardlinks_rejected(self):
        master = pathlib.Path(self.files["master"])
        link = self.base / "linked"
        link.symlink_to(master)
        self.held("initialize", files={**self.files, "master": str(link)})
        link.unlink()
        os.link(master, link)
        self.held("initialize", "UNSAFE_FILE")

    def test_root_symlink_rejected(self):
        real = self.base / "real-store"
        real.mkdir(mode=0o700)
        pathlib.Path(self.root).symlink_to(real)
        self.held("initialize", "UNSAFE_STORE")

    def test_receipt_symlink_and_corruption_rejected(self):
        self.ok("initialize")
        p = pathlib.Path(self.root) / "software.json"
        p.unlink()
        p.symlink_to(self.files["metadata"])
        self.held("chunk")
        p.unlink()
        p.write_text("{bad json", encoding="utf8")
        p.chmod(0o600)
        self.held("initialize")
        self.assertEqual(self.adapter.calls.count("initialize"), 1)

    def test_lock_excludes_another_process(self):
        with u.Store(self.root):
            script = 'import uploader as u,sys\ntry:\n with u.Store(sys.argv[1]): print("BAD")\nexcept u.Hold as e: print(str(e))'
            result = subprocess.run([sys.executable, "-B", "-c", script, self.root], cwd=pathlib.Path(__file__).parent,
                                    capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout.strip(), "LOCKED")
        self.ok("initialize")

    def test_new_process_reads_durable_initialization_hold(self):
        self.adapter.fail = "initialize"
        self.held("initialize")
        request = {"root": self.root, "operation_id": self.operation, "lane": "software",
                   "expected_channel": u.CHANNELS["software"], "files": self.files, "action": "initialize"}
        script = ('import json,sys,uploader as u\nfrom test_uploader import Fake\n'
                  'p=json.loads(sys.stdin.read());print(json.dumps(u.run(adapter=Fake(),**p)))')
        result = subprocess.run([sys.executable, "-B", "-c", script], input=json.dumps(request),
                                cwd=pathlib.Path(__file__).parent, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)["code"], "INITIALIZATION_ALREADY_INTENDED")

    def test_failed_intent_save_prevents_dispatch(self):
        real = u.Store.save
        def fail(store, r):
            if r["state"] == "init_intent":
                raise OSError("DO_NOT_LOG")
            real(store, r)
        with patch.object(u.Store, "save", fail):
            self.held("initialize")
        self.assertNotIn("initialize", self.adapter.calls)

    def test_input_change_between_hash_and_dispatch_is_held(self):
        self.ok("initialize")
        def change(name):
            if name == "channel":
                pathlib.Path(self.files["master"]).write_bytes(b"replaced during dispatch")
        self.adapter.on_call = change
        self.held("chunk", "INPUT_CHANGED")
        self.assertNotIn("chunk", self.adapter.calls)

    def test_adapter_cannot_smuggle_diagnostic_as_hold(self):
        with patch.object(self.adapter, "channel", side_effect=u.Hold("DO_NOT_LOG")):
            self.held("initialize", "OPERATION_HELD")

    def test_corrupt_session_query_holds_subsequent_chunks(self):
        self.ok("initialize")
        self.adapter.result = {"kind": "expired"}
        self.held("reconcile", "INVALID_PROGRESS")
        self.held("chunk", "RECONCILIATION_REQUIRED")
        self.assertNotIn("chunk", self.adapter.calls)

    def test_chunk_crash_before_dispatch_reconciles_zero(self):
        self.ok("initialize")
        real = u.Store.save
        def crash(store, r):
            real(store, r)
            if r["state"] == "chunk_intent":
                raise Crash()
        with patch.object(u.Store, "save", crash), self.assertRaises(Crash):
            self.run_action("chunk")
        self.assertNotIn("chunk", self.adapter.calls)
        self.ok("reconcile")
        self.assertEqual(self.receipt()["ack"], 0)
        self.ok("chunk")

    def test_chunk_crash_before_outcome_save_queries_committed_range(self):
        self.ok("initialize")
        real = u.Store.save
        def crash(store, r):
            if r["state"] == "uploading":
                raise Crash()
            real(store, r)
        with patch.object(u.Store, "save", crash), self.assertRaises(Crash):
            self.run_action("chunk")
        self.held("chunk", "RECONCILIATION_REQUIRED")
        self.ok("reconcile")
        self.assertEqual(self.receipt()["ack"], 8)
        self.assertEqual(self.adapter.calls.count("chunk"), 1)

    def test_promotion_crash_before_dispatch_is_not_reissued(self):
        self.finished()
        real = u.Store.save
        def crash(store, r):
            real(store, r)
            if r["state"] == "promote_intent":
                raise Crash()
        with patch.object(u.Store, "save", crash), self.assertRaises(Crash):
            self.run_action("promote", evidence=self.evidence())
        self.held("reconcile", "PROMOTION_OUTCOME_UNKNOWN")
        self.held("promote", "FINISHING_REQUIRED", evidence=self.evidence())
        self.assertNotIn("promote", self.adapter.calls)

    def test_abrupt_process_exit_preserves_intent_and_releases_lock(self):
        request = {"root": self.root, "operation_id": self.operation, "lane": "software",
                   "expected_channel": u.CHANNELS["software"], "files": self.files, "action": "initialize"}
        script = ('import json,sys,os,uploader as u\nfrom test_uploader import Fake\n'
                  'class Die(Fake):\n def initialize(self,*args,**kwargs): os._exit(77)\n'
                  'u.run(adapter=Die(),**json.loads(sys.stdin.read()))')
        result = subprocess.run([sys.executable, "-B", "-c", script], input=json.dumps(request),
                                cwd=pathlib.Path(__file__).parent, capture_output=True, text=True)
        self.assertEqual(result.returncode, 77)
        self.assertEqual(self.receipt()["state"], "init_intent")
        self.held("initialize", "INITIALIZATION_ALREADY_INTENDED")
        self.assertNotIn("initialize", self.adapter.calls)

    def test_no_network_or_credential_code_imported(self):
        source = pathlib.Path(u.__file__).read_text()
        self.assertNotIn("urllib", source)
        self.assertNotIn("http.client", source)
        self.assertNotIn("swm-yt-creds", source)
        self.assertNotIn("get-secret-value", source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
