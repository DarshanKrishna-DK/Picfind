import argparse
import contextlib
import copy
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import batch_index
import extract
import local_index
from test_extract import face, header, job


class BatchIndexTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.key_file, self.database = self.root / "key.bin", self.root / "index.sqlite"
        local_index.create_key(self.key_file)
        self.key = local_index.read_key(self.key_file)
        local_index.initialize(self.database, self.key)
        self.scope = ("event", job()["scope_id"])
        self.data = {
            "schema_version": 1, "scope": {"kind": self.scope[0], "id": self.scope[1]},
            "pipeline_id": extract.digest_json(extract.pipeline(1280, 2)),
            "consent_reference": "private-consent-reference", "photos": [],
        }
        for index in range(2):
            filename = f"private-source-{index}.jpg"
            payload = header(640 + index)
            (self.source / filename).write_bytes(payload)
            self.data["photos"].append({
                "photo_id": str(uuid4()), "input": filename, "sha256": hashlib.sha256(payload).hexdigest(),
            })
        self.args = argparse.Namespace(
            manifest=self.root / "manifest.json", root=self.source, models_dir=self.root / "models",
            database=self.database, key_file=self.key_file, output=self.root / "report.json",
            scope_kind=self.scope[0], scope_id=self.scope[1], threads=2, side=1280,
            max_faces=100, timeout=30, deadline=600,
        )
        self.calls = []
        self.write()

    def write(self):
        self.args.manifest.write_text(json.dumps(self.data), encoding="utf-8")

    def index(self):
        return local_index.LocalIndex(self.database, self.key)

    def fake_worker(self, data, timeout):
        self.calls.append((copy.deepcopy(data), timeout))
        payload = Path(data["input"]).read_bytes()
        dimensions = extract.jpeg_dimensions(payload)
        result = extract.document(data, hashlib.sha256(payload).hexdigest(), dimensions, [face()])
        scale = min(1.0, data["side"] / max(dimensions))
        result["detector_dimensions"] = [round(n * scale) for n in dimensions]
        return result

    def execute(self, worker=None):
        self.args.output = self.root / f"report-{uuid4()}.json"
        with patch("batch_index.worker", side_effect=worker or self.fake_worker):
            result = batch_index.run(self.args)
        return result, json.loads(self.args.output.read_text())

    def test_restart_resume_authenticates_and_skips_native_work_without_plaintext_artifacts(self):
        before_sources = {path.name: path.read_bytes() for path in self.source.iterdir()}
        result, report = self.execute()
        self.assertEqual(result["counts"], {"stored": 2, "unchanged": 0, "failed": 0})
        self.assertEqual(len(self.calls), 2)
        self.calls.clear()
        result, again = self.execute()
        self.assertEqual(result["counts"], {"stored": 0, "unchanged": 2, "failed": 0})
        self.assertEqual(self.calls, [])
        self.assertEqual([x["artifact_digest"] for x in report["results"]],
                         [x["artifact_digest"] for x in again["results"]])
        self.assertEqual(before_sources, {path.name: path.read_bytes() for path in self.source.iterdir()})
        self.assertEqual({path.suffix for path in self.root.iterdir() if path.is_file()}, {".json", ".bin", ".sqlite"})
        for path in self.root.glob("*.json"):
            self.assertNotIn('"embedding"', path.read_text())

    def test_source_digest_mismatch_does_not_call_native_or_write_that_photo(self):
        self.data["photos"][0]["sha256"] = "a" * 64
        self.write()
        result, report = self.execute()
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["counts"], {"stored": 1, "unchanged": 0, "failed": 1})
        self.assertEqual(report["results"][0]["error"], "SOURCE_DIGEST_MISMATCH")
        self.assertEqual(len(self.calls), 1)
        with self.index() as index:
            self.assertIsNone(index.inspect_photo(self.scope, self.data["photos"][0]["photo_id"], self.data["pipeline_id"]))

    def test_oversized_source_is_bounded_before_native_extraction(self):
        photo = self.data["photos"][0]
        boundary = len(header())
        payload = b"x" * (boundary + 1)
        (self.source / photo["input"]).write_bytes(payload)
        photo["sha256"] = hashlib.sha256(payload).hexdigest()
        self.write()
        with patch("batch_index.extract.MAX_BYTES", boundary):
            result, report = self.execute()
        self.assertEqual(report["results"][0]["error"], "IMAGE_TOO_LARGE")
        self.assertEqual(result["counts"], {"stored": 1, "unchanged": 0, "failed": 1})
        self.assertEqual(len(self.calls), 1)

    def test_changed_input_requires_explicit_expected_digest_and_retries_idempotently(self):
        _, first = self.execute()
        photo = self.data["photos"][0]
        payload = header(800, 600)
        (self.source / photo["input"]).write_bytes(payload)
        photo["sha256"] = hashlib.sha256(payload).hexdigest()
        self.write()
        self.calls.clear()
        result, conflict = self.execute()
        self.assertEqual(conflict["results"][0]["error"], "PHOTO_VERSION_CONFLICT")
        self.assertEqual(self.calls, [])
        photo["expected_digest"] = first["results"][0]["artifact_digest"]
        self.write()
        result, changed = self.execute()
        self.assertEqual(result["counts"], {"stored": 1, "unchanged": 1, "failed": 0})
        self.assertNotEqual(changed["results"][0]["artifact_digest"], photo["expected_digest"])
        result, _ = self.execute()
        self.assertEqual(result["counts"]["unchanged"], 2)

    def test_consent_reference_change_requires_explicit_replacement(self):
        self.execute()
        self.data["consent_reference"] = "different-consent"
        self.write()
        self.calls.clear()
        _, report = self.execute()
        self.assertEqual([item["error"] for item in report["results"]], ["PHOTO_VERSION_CONFLICT"] * 2)
        self.assertEqual(self.calls, [])

    def test_expected_digest_cannot_create_a_missing_photo(self):
        self.data["photos"][0]["expected_digest"] = "a" * 64
        self.write()
        _, report = self.execute()
        self.assertEqual(report["results"][0]["error"], "PHOTO_VERSION_CONFLICT")

    def test_photo_and_scope_tombstones_block_resume_before_native_work(self):
        self.execute()
        with self.index() as index:
            index.erase_photo(self.scope, self.data["photos"][0]["photo_id"])
        self.calls.clear()
        _, report = self.execute()
        self.assertEqual(report["results"][0]["error"], "PHOTO_RETIRED")
        self.assertEqual(self.calls, [])
        with self.index() as index:
            index.erase_scope(self.scope)
        _, report = self.execute()
        self.assertEqual([item["error"] for item in report["results"]], ["SCOPE_RETIRED"] * 2)
        self.assertEqual(self.calls, [])

    def test_erase_between_resume_read_and_commit_cannot_resurrect(self):
        self.execute()
        original = local_index.LocalIndex.inspect_photo
        def erase(index, selected_scope, photo_id, pipeline_id):
            result = original(index, selected_scope, photo_id, pipeline_id)
            index.erase_photo(selected_scope, photo_id)
            return result
        with patch.object(local_index.LocalIndex, "inspect_photo", erase):
            _, report = self.execute()
        self.assertEqual([row["error"] for row in report["results"]], ["PHOTO_RETIRED"] * 2)
        with self.index() as index:
            self.assertEqual(index.stats(self.scope)["photos"], 0)

    def test_corrupt_cached_artifact_fails_instead_of_silently_reextracting(self):
        self.execute()
        with contextlib.closing(sqlite3.connect(self.database)) as connection:
            connection.execute("UPDATE photos SET ciphertext=?", (b"corrupt",))
            connection.commit()
        self.calls.clear()
        result, _ = self.execute()
        self.assertEqual(result["counts"]["failed"], 2)
        self.assertEqual(self.calls, [])

    def test_scope_pipeline_conflict_blocks_even_an_unindexed_photo(self):
        self.execute()
        self.args.side = 640
        self.data["pipeline_id"] = extract.digest_json(extract.pipeline(640, 2))
        self.data["photos"][0]["photo_id"] = str(uuid4())
        self.write()
        self.calls.clear()
        _, report = self.execute()
        self.assertEqual([row["error"] for row in report["results"]], ["SCOPE_PIPELINE_INCOMPATIBLE"] * 2)
        self.assertEqual(self.calls, [])

    def test_worker_failure_preserves_other_commits_and_partial_resume(self):
        def fail_one(data, timeout):
            if data["photo_id"] == self.data["photos"][0]["photo_id"]:
                raise ValueError("JPEG_REQUIRED")
            return self.fake_worker(data, timeout)
        result, report = self.execute(fail_one)
        self.assertEqual(result["counts"]["stored"], 1)
        self.assertEqual(report["results"][0]["error"], "JPEG_REQUIRED")
        self.calls.clear()
        result, _ = self.execute()
        self.assertEqual(result["counts"], {"stored": 1, "unchanged": 1, "failed": 0})
        self.assertEqual(len(self.calls), 1)

    def test_worker_cannot_substitute_photo_or_input_provenance(self):
        def wrong(data, timeout):
            return self.fake_worker({**data, "photo_id": str(uuid4())}, timeout)
        _, report = self.execute(wrong)
        self.assertEqual([row["error"] for row in report["results"]], ["WORKER_PROVENANCE_MISMATCH"] * 2)
        with self.index() as index:
            with self.assertRaisesRegex(ValueError, "SCOPE_UNAVAILABLE"):
                index.stats(self.scope)

    def test_cached_face_limit_is_still_enforced(self):
        def multiple(data, timeout):
            result = self.fake_worker(data, timeout)
            result = extract.document(data, result["input_sha256"], result["input_dimensions"], [face(1), face(2)])
            result["detector_dimensions"] = result["input_dimensions"]
            return result
        self.execute(multiple)
        self.args.max_faces = 1
        self.calls.clear()
        _, report = self.execute()
        self.assertEqual([row["error"] for row in report["results"]], ["FACE_LIMIT_EXCEEDED"] * 2)
        self.assertEqual(self.calls, [])

    def test_batch_deadline_prevents_late_worker_results_from_being_committed(self):
        self.args.deadline = 2
        clock = [0]
        def slow(data, timeout):
            result = self.fake_worker(data, timeout)
            self.assertEqual(timeout, 2)
            clock[0] = 3
            return result
        with patch("batch_index.time.monotonic", side_effect=lambda: clock[0]):
            result, report = self.execute(slow)
        self.assertEqual(result["counts"]["failed"], 2)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual([row["error"] for row in report["results"]], ["BATCH_DEADLINE"] * 2)

    def test_database_growth_limit_rolls_back_failed_imports_and_remains_recoverable(self):
        with self.index() as index:
            page_size = index.connection.execute("PRAGMA page_size").fetchone()[0]
            pages = index.connection.execute("PRAGMA page_count").fetchone()[0]
        limit = (pages + 2) * page_size
        def large(data, timeout):
            result = self.fake_worker(data, timeout)
            result = extract.document(data, result["input_sha256"], result["input_dimensions"],
                                      [face(number) for number in range(1, 101)])
            result["detector_dimensions"] = result["input_dimensions"]
            return result
        with patch("local_index.MAX_DATABASE_BYTES", limit):
            result, _ = self.execute(large)
            self.assertEqual(result["counts"]["failed"], 2)
            self.assertLessEqual(self.database.stat().st_size, limit)
            with self.index() as index:
                self.assertIsNone(index.scope_row(self.scope))
        result, _ = self.execute()
        self.assertEqual(result["counts"]["stored"], 2)

    def test_manifest_rejects_ambiguous_schema_scope_pipeline_ids_and_entries_before_any_write(self):
        original = copy.deepcopy(self.data)
        mutations = [
            lambda d: d.update(schema_version=True),
            lambda d: d.update(extra="private"),
            lambda d: d["scope"].update(kind="scan"),
            lambda d: d.update(pipeline_id="a" * 64),
            lambda d: d.update(consent_reference="not safe"),
            lambda d: d.update(photos=[]),
            lambda d: d.update(photos=d["photos"] * 51),
            lambda d: d["photos"][1].update(photo_id=d["photos"][0]["photo_id"]),
            lambda d: d["photos"][1].update(input=d["photos"][0]["input"]),
            lambda d: d["photos"][0].update(sha256="invalid"),
            lambda d: d["photos"][0].update(expected_digest=None),
            lambda d: d["photos"][0].update(extra=True),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                self.data = copy.deepcopy(original)
                mutate(self.data)
                self.write()
                with self.assertRaises(ValueError):
                    self.execute()
        self.assertEqual(self.calls, [])
        with self.index() as index:
            self.assertIsNone(index.scope_row(self.scope))

    def test_manifest_is_bounded_and_duplicate_json_keys_fail(self):
        for payload in ('{"schema_version":1,"schema_version":1}', " " * (batch_index.MAX_MANIFEST + 1)):
            self.args.manifest.write_text(payload)
            with self.assertRaises(ValueError):
                self.execute()
        self.assertEqual(self.calls, [])

    def test_relative_paths_reject_escape_absolute_network_and_unsupported_inputs(self):
        for relative in ("../secret.jpg", "/secret.jpg", "C:/secret.jpg", "\\\\host\\file.jpg",
                         "http://host/file.jpg", "./private-source-0.jpg", "a//b.jpg", "bad\0.jpg", "file.png"):
            with self.subTest(path=relative):
                if relative == "file.png":
                    (self.source / relative).write_bytes(header())
                self.data["photos"][0]["input"] = relative
                self.write()
                with self.assertRaises((ValueError, OSError)):
                    self.execute()
        self.assertEqual(self.calls, [])

    def test_source_links_are_rejected(self):
        link = self.source / "linked.jpg"
        try:
            link.symlink_to(self.source / self.data["photos"][0]["input"])
        except OSError:
            self.skipTest("Creating symlinks requires operating-system permission.")
        self.data["photos"][0]["input"] = link.name
        self.write()
        with self.assertRaisesRegex(ValueError, "SOURCE_LINK_FORBIDDEN"):
            self.execute()

    def test_report_is_private_and_publication_race_does_not_overwrite_or_undo_commits(self):
        result, report = self.execute()
        encoded = json.dumps(report)
        for private in ("private-source", "private-consent", str(self.source), "embedding", "detection"):
            self.assertNotIn(private, encoded)
        self.assertFalse(report["production_enabled"])
        self.assertFalse(report["quality_evaluated"])
        self.assertNotIn("results", result)
        self.args.output = self.root / "raced.json"
        original = local_index.LocalIndex.import_photo
        def race(index, *args):
            result = original(index, *args)
            self.args.output.write_text("another process")
            return result
        with patch.object(local_index.LocalIndex, "import_photo", race):
            with self.assertRaisesRegex(ValueError, "OUTPUT_ALREADY_EXISTS"):
                batch_index.run(self.args)
        self.assertEqual(self.args.output.read_text(), "another process")
        with self.index() as index:
            self.assertEqual(index.stats(self.scope)["photos"], 2)

    def test_existing_report_and_wrong_key_fail_before_native_work(self):
        self.args.output.write_text("preserved")
        with self.assertRaisesRegex(ValueError, "OUTPUT_ALREADY_EXISTS"):
            batch_index.run(self.args)
        self.assertEqual(self.args.output.read_text(), "preserved")
        self.args.output = self.root / "new.json"
        self.key_file.write_bytes(b"x" * 32)
        with patch("batch_index.worker") as worker:
            with self.assertRaisesRegex(ValueError, "INDEX_AUTHENTICATION_FAILED"):
                batch_index.run(self.args)
            worker.assert_not_called()
        self.assertFalse(self.args.output.exists())

    def test_worker_protocol_bounds_deadline_output_and_sanitizes_failure(self):
        with patch("batch_index.subprocess.run", side_effect=subprocess.TimeoutExpired("worker", 1)):
            with self.assertRaisesRegex(ValueError, "EXTRACTION_DEADLINE"):
                batch_index.worker(job(), 1)
        for response, code in (
            (subprocess.CompletedProcess([], 1, '{"error":"MODEL_MISSING"}'), "MODEL_MISSING"),
            (subprocess.CompletedProcess([], 1, '{"error":"private/path.jpg"}'), "WORKER_FAILED"),
            (subprocess.CompletedProcess([], 0, "x" * (extract.MAX_OUTPUT + 1)), "OUTPUT_TOO_LARGE"),
            (subprocess.CompletedProcess([], 0, "not-json"), "ARTIFACT_JSON_INVALID"),
        ):
            with patch("batch_index.subprocess.run", return_value=response):
                with self.assertRaisesRegex(ValueError, code):
                    batch_index.worker(job(), 1)

    def test_cli_prints_counts_only_and_partial_status_is_a_failure_exit(self):
        argv = []
        for name, value in vars(self.args).items():
            argv.extend([f"--{name.replace('_', '-')}", str(value)])
        output, errors = io.StringIO(), io.StringIO()
        with patch("batch_index.worker", side_effect=ValueError("private source path")), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            code = batch_index.main(argv)
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output.getvalue())["counts"]["failed"], 2)
        self.assertNotIn(self.data["photos"][0]["photo_id"], output.getvalue())
        self.assertNotIn("private source path", self.args.output.read_text())
        self.assertEqual(errors.getvalue(), "")

    def test_programmatic_options_do_not_bypass_cpu_limits(self):
        for name, value in (("threads", 5), ("side", 319), ("max_faces", 101),
                            ("timeout", 0), ("deadline", 3601), ("threads", True)):
            original = getattr(self.args, name)
            setattr(self.args, name, value)
            with self.assertRaisesRegex(ValueError, "BATCH_OPTIONS_INVALID"):
                self.execute()
            setattr(self.args, name, original)


if __name__ == "__main__":
    unittest.main()
