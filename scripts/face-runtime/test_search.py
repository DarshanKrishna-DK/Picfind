from concurrent.futures import ThreadPoolExecutor
import contextlib
import copy
import hashlib
import io
import json
import math
from pathlib import Path
import tempfile
import threading
import unittest
from uuid import uuid4

import calibrate
from evaluate import MODELS
import extract
import local_index
import search
from test_calibrate import fixture as score_fixture
from test_extract import face, job


def artifact(selected_scope, scores, photo_id=None, mode="photo", side=1280):
    data = job()
    data.update(scope_kind=selected_scope[0], scope_id=selected_scope[1],
                photo_id=photo_id or str(uuid4()), mode=mode, side=side)
    rows = []
    for index, score in enumerate(scores):
        row = face(index + 1)
        row["embedding"] = [score, math.sqrt(1 - score * score)] + [0.0] * 126
        rows.append(row)
    result = extract.document(data, "b" * 64, (640, 480), rows)
    scale = min(1.0, side / 640)
    result["detector_dimensions"] = [round(640 * scale), round(480 * scale)]
    return result


class ScopedSearchTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.database = self.root / "index.sqlite"
        self.key_file = self.root / "key.bin"
        local_index.create_key(self.key_file)
        self.key = local_index.read_key(self.key_file)
        local_index.initialize(self.database, self.key)
        self.scope = ("event", job()["scope_id"])
        self.reference = artifact(self.scope, [1], mode="reference")
        self.scores = score_fixture()
        self.scores.update(model_sha256=MODELS["recognizer"]["sha256"], pipeline_id=self.reference["pipeline_id"])
        self.scores_path = self.root / "scores.json"
        self.write_scores()

    def write_scores(self):
        self.scores_path.write_text(json.dumps(self.scores), encoding="utf8")

    def index(self):
        return local_index.LocalIndex(self.database, self.key)

    def query(self, index, **options):
        return search.search(index, self.scope, self.reference, self.scores_path, target_fmr=0, allow_small=True, **options)

    def test_ranks_best_face_per_photo_with_stable_ties_and_cap(self):
        low_id = "11111111-1111-4111-8111-111111111111"
        high_id = "22222222-2222-4222-8222-222222222222"
        with self.index() as index:
            for scores, photo_id in [([0.8, 0.9], high_id), ([0.9], low_id), ([0.6], str(uuid4())), ([], str(uuid4()))]:
                index.import_photo(self.scope, artifact(self.scope, scores, photo_id))
            result = self.query(index, limit=1)
        self.assertEqual(result["qualifying_photos"], 2)
        self.assertEqual(result["matches"], [{"photo_id": low_id, "cosine_similarity": 0.9}])
        self.assertTrue(result["truncated"])
        self.assertEqual(result["faces_examined"], 4)
        self.assertEqual(result["photos_examined"], 4)
        self.assertFalse(result["production_enabled"])
        self.assertEqual(result["evaluation"]["dataset_sha256"], hashlib.sha256(self.scores_path.read_bytes()).hexdigest())

    def test_exact_cutoff_is_inclusive_and_reject_all_is_honored(self):
        for pair in self.scores["pairs"]:
            pair["score"] = 1 if pair["left_identity"] == pair["right_identity"] else 0.6
        self.write_scores()
        with self.index() as index:
            index.import_photo(self.scope, artifact(self.scope, [1]))
            self.assertEqual(len(self.query(index)["matches"]), 1)
            for pair in self.scores["pairs"]:
                if pair["split"] == "calibration" and pair["left_identity"] != pair["right_identity"]:
                    pair["score"] = 1
            self.write_scores()
            result = self.query(index)
        self.assertEqual(result["matches"], [])
        self.assertTrue(result["evaluation"]["reject_all"])

    def test_held_out_failure_blocks_search_without_tuning_the_cutoff(self):
        self.scores["pairs"][6]["score"] = 0.99
        self.write_scores()
        with self.index() as index:
            index.import_photo(self.scope, artifact(self.scope, [1]))
            with self.assertRaisesRegex(ValueError, "HELD_OUT_FALSE_MATCH_TARGET_EXCEEDED"):
                self.query(index)

    def test_normal_sample_floor_and_explicit_small_fixture_option(self):
        with self.index() as index:
            index.import_photo(self.scope, artifact(self.scope, [1]))
            with self.assertRaisesRegex(ValueError, "CALIBRATION_SAMPLE_FLOOR"):
                search.search(index, self.scope, self.reference, self.scores_path)
            self.assertTrue(self.query(index)["small_evaluation"])
            original = self.scores["pairs"]
            self.scores["pairs"] = []
            for pair in original:
                genuine = pair["left_identity"] == pair["right_identity"]
                for i in range(50 if genuine else 500):
                    self.scores["pairs"].append({
                        **pair, "left_sample": f"{pair['left_sample']}-{i}",
                        "right_sample": f"{pair['right_sample']}-{i}",
                    })
            self.write_scores()
            result = search.search(index, self.scope, self.reference, self.scores_path)
            self.assertFalse(result["small_evaluation"])
            self.assertFalse(result["production_enabled"])

    def test_requires_calibration_pipeline_and_recognizer_provenance(self):
        with self.index() as index:
            index.import_photo(self.scope, artifact(self.scope, [1]))
            for field, value, error in (
                ("pipeline_id", "a" * 64, "CALIBRATION_PIPELINE_MISMATCH"),
                ("model_sha256", "a" * 64, "CALIBRATION_MODEL_MISMATCH"),
            ):
                previous = self.scores[field]
                self.scores[field] = value
                self.write_scores()
                with self.assertRaisesRegex(ValueError, error):
                    self.query(index)
                self.scores[field] = previous
            del self.scores["pipeline_id"]
            self.write_scores()
            with self.assertRaisesRegex(ValueError, "CALIBRATION_PIPELINE_MISMATCH"):
                self.query(index)

    def test_legacy_calibration_reports_remain_supported_but_bad_pipeline_labels_fail(self):
        legacy = score_fixture()
        self.assertNotIn("pipeline_id", calibrate.report(legacy, 0))
        for value in ("bad", True, None):
            with self.assertRaisesRegex(ValueError, "PIPELINE_CHECKSUM_INVALID"):
                calibrate.report({**legacy, "pipeline_id": value}, 0)
        self.assertEqual(calibrate.report(self.scores, 0)["pipeline_id"], self.reference["pipeline_id"])

    def test_rejects_zero_multiple_or_photo_mode_references(self):
        with self.index() as index:
            index.import_photo(self.scope, artifact(self.scope, [1]))
            for scores, mode in (([], "reference"), ([1, 0.9], "reference"), ([1], "photo")):
                reference = artifact(self.scope, scores, mode=mode)
                with self.assertRaisesRegex(ValueError, "SINGLE_FACE_REFERENCE_REQUIRED|REFERENCE_ARTIFACT_REQUIRED"):
                    search.search(index, self.scope, reference, self.scores_path, allow_small=True)

    def test_rejects_query_index_pipeline_mismatch(self):
        with self.index() as index:
            index.import_photo(self.scope, artifact(self.scope, [1], side=640))
            with self.assertRaisesRegex(ValueError, "QUERY_PIPELINE_MISMATCH"):
                self.query(index)

    def test_queries_never_include_another_scope_or_removed_photo(self):
        foreign = ("scan", self.scope[1])
        photo = artifact(self.scope, [1])
        with self.index() as index:
            index.import_photo(self.scope, photo)
            index.import_photo(foreign, artifact(foreign, [1]))
            self.assertEqual(self.query(index)["qualifying_photos"], 1)
            index.erase_photo(self.scope, photo["photo_id"])
            self.assertEqual(self.query(index)["matches"], [])
            index.erase_scope(self.scope)
            with self.assertRaisesRegex(ValueError, "SCOPE_UNAVAILABLE"):
                self.query(index)
            with self.assertRaisesRegex(ValueError, "ARTIFACT_SCOPE_MISMATCH"):
                search.search(index, foreign, self.reference, self.scores_path, allow_small=True)

    def test_snapshot_digest_is_stable_and_changes_with_photo_replacement(self):
        photo_id = str(uuid4())
        with self.index() as index:
            initial = index.import_photo(self.scope, artifact(self.scope, [0.8], photo_id))
            first = self.query(index)
            self.assertEqual(first["snapshot_sha256"], self.query(index)["snapshot_sha256"])
            index.import_photo(self.scope, artifact(self.scope, [0.9], photo_id), initial["artifact_digest"])
            self.assertNotEqual(first["snapshot_sha256"], self.query(index)["snapshot_sha256"])

    def test_snapshot_holds_a_consistent_read_while_erasure_waits_to_commit(self):
        photo = artifact(self.scope, [1])
        entered = threading.Event()
        def erase():
            with self.index() as writer:
                entered.set()
                return writer.erase_photo(self.scope, photo["photo_id"])
        with self.index() as index, ThreadPoolExecutor(max_workers=1) as executor:
            index.import_photo(self.scope, photo)
            with index.snapshot_scope(self.scope) as snapshot:
                future = executor.submit(erase)
                self.assertTrue(entered.wait(2))
                self.assertFalse(future.done())
                self.assertEqual(snapshot["photos"], [photo])
            self.assertEqual(future.result(timeout=5)["status"], "photo-retired")
            self.assertEqual(index.read_scope(self.scope), [])

    def test_rejects_invalid_limits_and_targets(self):
        with self.index() as index:
            index.import_photo(self.scope, artifact(self.scope, [1]))
            for limit in (0, 501, True, 1.5):
                with self.assertRaisesRegex(ValueError, "RESULT_LIMIT_INVALID"):
                    self.query(index, limit=limit)
            for target in (-1, 2, math.nan, math.inf):
                with self.assertRaisesRegex(ValueError, "TARGET_FMR_INVALID"):
                    search.search(index, self.scope, self.reference, self.scores_path, target_fmr=target, allow_small=True)
            with self.assertRaisesRegex(ValueError, "EVALUATION_MODE_INVALID"):
                search.search(index, self.scope, self.reference, self.scores_path, allow_small="yes")

    def test_output_contains_no_vectors_identities_or_consent_references(self):
        with self.index() as index:
            index.import_photo(self.scope, artifact(self.scope, [1]))
            result = json.dumps(self.query(index))
        for secret in ("embedding", "detection", "cal-person", "held-person", "synthetic-test-only", "generated-fixture"):
            self.assertNotIn(secret, result)

    def test_cli_publishes_private_results_without_overwriting_and_reports_only_counts(self):
        reference_file, output = self.root / "reference.json", self.root / "results.json"
        reference_file.write_text(json.dumps(self.reference))
        with self.index() as index:
            index.import_photo(self.scope, artifact(self.scope, [1]))
        args = ["--database", str(self.database), "--key-file", str(self.key_file),
                "--scope-kind", self.scope[0], "--scope-id", self.scope[1],
                "--reference", str(reference_file), "--scores", str(self.scores_path),
                "--output", str(output), "--allow-small-evaluation"]
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(search.main(args), 0)
            before = output.read_bytes()
            self.assertEqual(search.main(args), 1)
        self.assertEqual(output.read_bytes(), before)
        self.assertEqual(json.loads(stdout.getvalue()), {
            "status": "complete", "matches": 1, "truncated": False,
            "small_evaluation": True, "production_enabled": False,
        })
        self.assertIn("OUTPUT_ALREADY_EXISTS", stderr.getvalue())
        self.assertEqual(len(json.loads(before)["matches"]), 1)

    def test_failed_reference_does_not_publish_output(self):
        reference_file, output = self.root / "reference.json", self.root / "results.json"
        reference = copy.deepcopy(self.reference)
        reference["faces"] = []
        reference_file.write_text(json.dumps(reference))
        with contextlib.redirect_stderr(io.StringIO()):
            code = search.main(["--database", str(self.database), "--key-file", str(self.key_file),
                "--scope-kind", self.scope[0], "--scope-id", self.scope[1],
                "--reference", str(reference_file), "--scores", str(self.scores_path),
                "--output", str(output), "--allow-small-evaluation"])
        self.assertEqual(code, 1)
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
