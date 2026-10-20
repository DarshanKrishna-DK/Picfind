import contextlib
import copy
import io
import json
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from calibrate import load_report, main, report


def fixture():
    pairs = []
    for split, prefix in [("calibration", "cal"), ("test", "held")]:
        for index, (score, same) in enumerate([(0.9, True), (0.7, True), (0.6, False), (0.2, False)]):
            pairs.append({
                "split": split,
                "left_identity": f"{prefix}-person-a",
                "right_identity": f"{prefix}-person-a" if same else f"{prefix}-person-b",
                "left_sample": f"{prefix}-left-{index}",
                "right_sample": f"{prefix}-right-{index}",
                "score": score,
            })
    return {
        "schema_version": 1,
        "score_kind": "cosine_similarity",
        "model_sha256": "a" * 64,
        "consent_reference": "synthetic-test-only",
        "pairs": pairs,
    }


class CalibrationTests(unittest.TestCase):
    def test_uses_calibration_only_and_reports_held_out_failures(self):
        data = fixture()
        data["pairs"][4]["score"] = 0.4
        data["pairs"][6]["score"] = 0.99
        result = report(data, 0)
        self.assertEqual(result["candidate_threshold"], 0.7)
        self.assertEqual(result["calibration"]["false_match_rate"], 0)
        self.assertEqual(result["held_out_test"]["false_match_rate"], 0.5)
        self.assertEqual(result["held_out_test"]["false_nonmatch_rate"], 0.5)
        self.assertFalse(result["production_enabled"])

    def test_boundary_is_inclusive_and_ties_are_not_split(self):
        data = fixture()
        data["pairs"][2]["score"] = 0.7
        result = report(data, 0)
        self.assertEqual(result["candidate_threshold"], 0.9)
        self.assertEqual(result["calibration"]["false_nonmatches"], 1)
        self.assertEqual(report(data, 0.5)["candidate_threshold"], 0.7)

    def test_reject_all_remains_explicit_when_top_score_is_impostor(self):
        data = fixture()
        data["pairs"][2]["score"] = 1
        result = report(data, 0)
        self.assertTrue(result["reject_all"])
        self.assertGreater(result["candidate_threshold"], 1)
        self.assertEqual(result["calibration"]["false_nonmatch_rate"], 1)

    def test_rejects_identity_leakage_across_partitions(self):
        data = fixture()
        data["pairs"][4]["left_identity"] = "cal-person-a"
        with self.assertRaisesRegex(ValueError, "IDENTITY_SPLIT_LEAKAGE"):
            report(data, 0)

    def test_rejects_duplicate_unordered_pairs_and_self_pairs(self):
        for self_pair in [False, True]:
            data = fixture()
            if self_pair:
                data["pairs"][0]["right_sample"] = data["pairs"][0]["left_sample"]
            else:
                duplicate = copy.deepcopy(data["pairs"][0])
                duplicate["left_sample"], duplicate["right_sample"] = (
                    duplicate["right_sample"], duplicate["left_sample"]
                )
                data["pairs"].append(duplicate)
            with self.assertRaisesRegex(ValueError, "SELF_PAIR|DUPLICATE_PAIR"):
                report(data, 0)

    def test_rejects_sample_identity_conflict(self):
        data = fixture()
        data["pairs"][2]["right_sample"] = data["pairs"][0]["left_sample"]
        with self.assertRaisesRegex(ValueError, "SAMPLE_IDENTITY_CONFLICT"):
            report(data, 0)

    def test_rejects_bad_scores_and_targets(self):
        for value in [math.nan, math.inf, -1.1, 1.1, True, "0.5"]:
            data = fixture()
            data["pairs"][0]["score"] = value
            with self.subTest(score=value), self.assertRaisesRegex(ValueError, "COSINE_SCORE"):
                report(data, 0)
        for value in [math.nan, math.inf, -0.1, 1.1, True]:
            with self.subTest(target=value), self.assertRaisesRegex(ValueError, "TARGET_FMR"):
                report(fixture(), value)

    def test_requires_provenance_consent_and_both_classes_per_partition(self):
        for key, value in [
            ("consent_reference", ""),
            ("model_sha256", "unknown"),
            ("score_kind", "aws_percentage"),
            ("schema_version", 2),
            ("pairs", []),
        ]:
            data = fixture()
            data[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                report(data, 0)
        data = fixture()
        data["pairs"] = [pair for pair in data["pairs"] if pair["score"] > 0.6]
        with self.assertRaisesRegex(ValueError, "BOTH_PAIR_CLASSES"):
            report(data, 0)

    def test_output_contains_no_identity_sample_or_consent_values(self):
        output = json.dumps(report(fixture(), 0))
        for private in ["cal-person", "held-person", "left-0", "synthetic-test-only"]:
            self.assertNotIn(private, output)

    def test_bounded_file_and_exact_dataset_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private-scores.json"
            path.write_text(json.dumps(fixture()), encoding="utf8")
            self.assertEqual(len(load_report(path, 0)["dataset_sha256"]), 64)
            with patch("calibrate.MAX_BYTES", 10):
                with self.assertRaisesRegex(ValueError, "DATASET_TOO_LARGE"):
                    load_report(path, 0)
            path.write_text("not json private-identity", encoding="utf8")
            errors = io.StringIO()
            with contextlib.redirect_stderr(errors):
                self.assertEqual(main(["--scores", str(path)]), 1)
            self.assertEqual(json.loads(errors.getvalue()), {"error": "DATASET_JSON_INVALID"})

    def test_cli_emits_json_without_installing_packages_or_models(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "scores.json"
            path.write_text(json.dumps(fixture()), encoding="utf8")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(main(["--scores", str(path), "--target-fmr", "0"]), 0)
            self.assertEqual(json.loads(output.getvalue())["candidate_threshold"], 0.7)


if __name__ == "__main__":
    unittest.main()
