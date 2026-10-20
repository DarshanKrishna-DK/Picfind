import argparse
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import extract


def job():
    return {
        "input": "fixture.jpg",
        "models_dir": "models",
        "scope_kind": "event",
        "scope_id": "55bda43c-4bde-4e1f-a9b5-16188acc9f00",
        "photo_id": "6087f37f-a5c7-4db8-a905-11764fb343ac",
        "consent_reference": "generated-fixture",
        "mode": "photo",
        "threads": 2,
        "side": 1280,
        "max_faces": 100,
    }


def header(width=640, height=480, marker=0xC0):
    # Header fixture only. Native decode is exercised separately with a real JPEG.
    frame = struct.pack(">BHHB", 8, height, width, 1) + b"\x01\x11\x00"
    return b"\xff\xd8\xff" + bytes([marker]) + struct.pack(">H", len(frame) + 2) + frame + b"\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00\xff\xd9"


def face(x=1):
    return {"detection": [x, 2, 20, 30] + [5] * 10 + [0.99], "embedding": [1.0] * 128}


class ExtractionTests(unittest.TestCase):
    def test_native_boundary_uses_verified_models_cpu_alignment_and_normalized_output(self):
        class Array(list):
            def __init__(self, values, shape):
                super().__init__(values)
                self.shape = shape
                self.cleared = False

            def fill(self, value):
                self.cleared = value == 0

        image = Array([], (480, 640, 3))
        detection = Array(face()["detection"], (15,))
        crop = Array([], (112, 112, 3))
        feature = Array([[1.0] * 128], (1, 128))
        cv = Mock(__version__="4.13.0", IMREAD_COLOR=1, IMREAD_IGNORE_ORIENTATION=128)
        np = Mock()
        cv.imdecode.return_value = image
        cv.FaceDetectorYN.create.return_value.detect.return_value = (1, [detection])
        recognizer = cv.FaceRecognizerSF.create.return_value
        recognizer.alignCrop.return_value = crop
        recognizer.feature.return_value = feature
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.jpg"
            source.write_bytes(header())
            data = dict(job(), input=str(source))
            with patch.dict(sys.modules, {"cv2": cv, "numpy": np}), patch.object(
                extract, "prepare_model", side_effect=lambda directory, spec, download: directory / spec["filename"]
            ) as prepared:
                result = extract.extract(data)
        self.assertEqual(len(result["faces"]), 1)
        self.assertAlmostEqual(sum(x * x for x in result["faces"][0]["embedding"]), 1)
        self.assertEqual(prepared.call_count, 2)
        self.assertTrue(all(call.args[2] is False for call in prepared.call_args_list))
        cv.setNumThreads.assert_called_once_with(2)
        cv.ocl.setUseOpenCL.assert_called_once_with(False)
        self.assertEqual(cv.FaceDetectorYN.create.call_args.args[-1], cv.dnn.DNN_TARGET_CPU)
        recognizer.alignCrop.assert_called_once_with(image, detection)
        recognizer.feature.assert_called_once_with(crop)
        self.assertTrue(image.cleared and crop.cleared and feature.cleared)

    def test_model_verification_failure_prevents_native_decode(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.jpg"
            source.write_bytes(header())
            cv = Mock()
            with patch.dict(sys.modules, {"cv2": cv}), patch.object(
                extract, "prepare_model", side_effect=ValueError("MODEL_CHECKSUM_MISMATCH")
            ):
                with self.assertRaisesRegex(ValueError, "MODEL_CHECKSUM_MISMATCH"):
                    extract.extract(dict(job(), input=str(source)))
            cv.imdecode.assert_not_called()

    def test_native_decode_must_agree_with_prechecked_dimensions(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.jpg"
            source.write_bytes(header())
            for decoded in (None, Mock(shape=(481, 640, 3))):
                cv = Mock(__version__="4.13.0", IMREAD_COLOR=1, IMREAD_IGNORE_ORIENTATION=128)
                cv.imdecode.return_value = decoded
                with patch.dict(sys.modules, {"cv2": cv, "numpy": Mock()}), patch.object(
                    extract, "prepare_model", return_value=Path("verified.onnx")
                ):
                    with self.assertRaisesRegex(ValueError, "IMAGE_DECODE_MISMATCH"):
                        extract.extract(dict(job(), input=str(source)))
                cv.FaceDetectorYN.create.assert_not_called()

    def test_reads_baseline_and_progressive_dimensions(self):
        for marker in (0xC0, 0xC2):
            self.assertEqual(extract.jpeg_dimensions(header(marker=marker)), (640, 480))

    def test_rejects_dimensions_before_decode(self):
        for width, height in ((0, 480), (640, 0), (8193, 10), (5000, 5000)):
            with self.subTest(width=width, height=height), self.assertRaisesRegex(ValueError, "IMAGE_DIMENSIONS_EXCEEDED"):
                extract.jpeg_dimensions(header(width, height))

    def test_rejects_non_jpeg_truncation_oversized_and_unsupported_encoding(self):
        cases = [
            (b"PNG", "JPEG_REQUIRED"),
            (header()[:-1], "JPEG_REQUIRED"),
            (b"x" * (extract.MAX_BYTES + 1), "IMAGE_TOO_LARGE"),
            (header(marker=0xC1), "UNSUPPORTED_JPEG_ENCODING"),
            (b"\xff\xd8\xff\xda\xff\xd9", "JPEG_DIMENSIONS_MISSING"),
            (b"\xff\xd8\xff\xe0\xff\xff\xff\xd9", "INVALID_JPEG_HEADER"),
            (b"\xff\xd8\xff\xe0\x00\x01\xff\xd9", "INVALID_JPEG_HEADER"),
            (b"\xff\xd8\x00\x00\xff\xd9", "INVALID_JPEG_HEADER"),
            (header()[:15] + header()[2:], "INVALID_JPEG_HEADER"),
        ]
        for value, error in cases:
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                extract.jpeg_dimensions(value)

    def test_worker_rejects_invalid_jobs_before_reading_files(self):
        for key, value in (
            ("threads", 0), ("threads", 5), ("threads", True),
            ("side", 1601), ("max_faces", 101), ("max_faces", -1),
            ("input", ""), ("input", "a\0b"), ("models_dir", None),
            ("mode", "all"), ("scope_kind", "global"), ("scope_id", "unknown"),
            ("photo_id", None), ("consent_reference", "email@example.com"),
        ):
            data = job()
            data[key] = value
            with self.subTest(key=key, value=value), patch.object(Path, "open") as opened:
                with self.assertRaisesRegex(ValueError, "INVALID_JOB"):
                    extract.extract(data)
                opened.assert_not_called()
        extract.validate_job(job())

    def test_reference_requires_one_face_and_photo_cap_is_not_truncated(self):
        data = job()
        extract.check_face_count(0, data)
        extract.check_face_count(100, data)
        with self.assertRaisesRegex(ValueError, "FACE_LIMIT_EXCEEDED"):
            extract.check_face_count(101, data)
        data["mode"] = "reference"
        extract.check_face_count(1, data)
        for count, error in ((0, "REFERENCE_NO_FACE"), (2, "REFERENCE_MULTIPLE_FACES")):
            with self.assertRaisesRegex(ValueError, error):
                extract.check_face_count(count, data)

    def test_normalizes_features_and_rejects_invalid_vectors(self):
        vector = extract.normalized_feature([2.0] * 128)
        self.assertAlmostEqual(sum(value * value for value in vector), 1)
        for vector in ([0.0] * 128, [1.0] * 127, [float("nan")] * 128,
                       [float("inf")] * 128, [1e308] * 128, ["1"] * 128, [True] * 128):
            with self.assertRaisesRegex(ValueError, "INVALID_EMBEDDING"):
                extract.normalized_feature(vector)

    def test_ids_are_stable_after_detection_reordering_and_scoped_to_provenance(self):
        data = job()
        first = extract.document(data, "a" * 64, (640, 480), [face(2), face(1)])
        second = extract.document(data, "a" * 64, (640, 480), [face(1), face(2)])
        self.assertEqual(first, second)
        self.assertFalse(first["quality_evaluated"])
        self.assertEqual(len({row["id"] for row in first["faces"]}), 2)
        for key, value in (("scope_kind", "scan"), ("photo_id", data["scope_id"]),
                           ("scope_id", data["photo_id"]), ("side", 640), ("threads", 1)):
            changed = dict(data, **{key: value})
            result = extract.document(changed, "a" * 64, (640, 480), [face(1), face(2)])
            self.assertNotEqual(first["faces"][0]["id"], result["faces"][0]["id"])
        changed_input = extract.document(data, "b" * 64, (640, 480), [face(1), face(2)])
        self.assertNotEqual(first["faces"][0]["id"], changed_input["faces"][0]["id"])
        reference = extract.document(dict(data, mode="reference"), "a" * 64, (640, 480), [face()])
        self.assertEqual(first["pipeline_id"], reference["pipeline_id"])

    def test_rejects_bad_detection_metadata(self):
        for index, value in ((2, 0), (3, -1), (14, 1.1), (0, float("nan")), (1, "bad")):
            row = face()
            row["detection"][index] = value
            with self.assertRaisesRegex(ValueError, "INVALID_DETECTION"):
                extract.document(job(), "a" * 64, (640, 480), [row])

    def test_duplicate_detections_fail_without_assigning_order_dependent_face_ids(self):
        first, second = face(), face()
        second["embedding"][0] = -1.0
        for rows in ([first, second], [second, first]):
            with self.assertRaisesRegex(ValueError, "DUPLICATE_DETECTION"):
                extract.document(job(), "a" * 64, (640, 480), rows)

    def test_full_face_cap_with_long_float_encodings_fits_publication_limit(self):
        rows = []
        for index in range(100):
            row = face(index)
            row["detection"] = [float(value) + 0.0001234567890123 for value in row["detection"]]
            row["embedding"] = [(-1 if i % 2 else 1) * (1.2345678901234567e-200 if i % 3 else 0.12345678901234567) for i in range(128)]
            rows.append(row)
        result = extract.document(job(), "a" * 64, (8192, 1900), rows)
        result["detector_dimensions"] = [1280, 297]
        wire = json.dumps(result, separators=(",", ":"), allow_nan=False) + "\n"
        self.assertLess(len(wire.encode()), extract.MAX_OUTPUT)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "faces.json"
            args = argparse.Namespace(**job(), output=output, timeout=7)
            completed = subprocess.CompletedProcess([], 0, wire, "")
            with patch.object(extract.subprocess, "run", return_value=completed):
                self.assertEqual(extract.run(args)["faces"], 100)
            self.assertEqual(len(json.loads(output.read_text())["faces"]), 100)

    def test_atomic_publication_never_overwrites_and_cleans_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "faces.json"
            extract.publish(output, {"faces": []})
            before = output.read_bytes()
            with self.assertRaisesRegex(ValueError, "OUTPUT_ALREADY_EXISTS"):
                extract.publish(output, {"faces": [1]})
            self.assertEqual(output.read_bytes(), before)
            self.assertEqual(list(Path(directory).iterdir()), [output])
            with patch.object(extract.os, "link", side_effect=OSError("disk failure")):
                with self.assertRaisesRegex(ValueError, "OUTPUT_PUBLICATION_FAILED"):
                    extract.publish(Path(directory) / "failed.json", {})
            self.assertEqual(list(Path(directory).iterdir()), [output])

    def test_missing_output_directory_is_rejected_before_inference(self):
        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(**job(), output=Path(directory) / "absent" / "faces.json", timeout=7)
            with patch.object(extract.subprocess, "run") as child:
                with self.assertRaisesRegex(ValueError, "OUTPUT_DIRECTORY_MISSING"):
                    extract.run(args)
                child.assert_not_called()

    def test_publication_rejects_nonfinite_or_oversized_payload_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "faces.json"
            for value in ({"value": math.nan}, {"value": "x" * extract.MAX_OUTPUT}):
                with self.assertRaises(ValueError):
                    extract.publish(output, value)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_supervisor_applies_deadline_and_never_publishes_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(**job(), output=Path(directory) / "faces.json", timeout=7)
            with patch.object(extract.subprocess, "run", side_effect=subprocess.TimeoutExpired("worker", 7)) as child:
                with self.assertRaisesRegex(ValueError, "EXTRACTION_DEADLINE"):
                    extract.run(args)
                self.assertEqual(child.call_args.kwargs["timeout"], 7)
            self.assertFalse(args.output.exists())

    def test_supervisor_filters_worker_failure_details_and_malformed_results(self):
        cases = [
            (1, json.dumps({"error": "REFERENCE_NO_FACE"}), "REFERENCE_NO_FACE"),
            (1, json.dumps({"error": "sensitive filesystem path"}), "WORKER_FAILED"),
            (1, "native error at private path", "WORKER_FAILED"),
            (0, "[]", "WORKER_RESPONSE_INVALID"),
            (0, '{"schema_version":1,"faces":null}', "WORKER_RESPONSE_INVALID"),
            (0, "x" * (extract.MAX_OUTPUT + 1), "OUTPUT_TOO_LARGE"),
        ]
        for code, stdout, error in cases:
            with self.subTest(error=error), tempfile.TemporaryDirectory() as directory:
                args = argparse.Namespace(**job(), output=Path(directory) / "faces.json", timeout=7)
                completed = subprocess.CompletedProcess([], code, stdout, "private native stderr")
                with patch.object(extract.subprocess, "run", return_value=completed):
                    with self.assertRaisesRegex(ValueError, error):
                        extract.run(args)
                self.assertFalse(args.output.exists())

    def test_supervisor_printable_result_excludes_embeddings_and_private_labels(self):
        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(**job(), output=Path(directory) / "faces.json", timeout=7)
            result = extract.document(job(), "a" * 64, (640, 480), [face()])
            completed = subprocess.CompletedProcess([], 0, json.dumps(result), "")
            with patch.object(extract.subprocess, "run", return_value=completed):
                summary = extract.run(args)
            self.assertEqual(summary, {"status": "complete", "faces": 1, "mode": "photo", "quality_evaluated": False})
            self.assertEqual(json.loads(args.output.read_text()), result)
            with patch.object(extract.subprocess, "run") as child:
                with self.assertRaisesRegex(ValueError, "OUTPUT_ALREADY_EXISTS"):
                    extract.run(args)
                child.assert_not_called()


if __name__ == "__main__":
    unittest.main()
