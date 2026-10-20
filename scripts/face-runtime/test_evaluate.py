import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from evaluate import arguments, prepare_model, verify


class ArtifactSafetyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.data = b"synthetic test model"
        self.spec = {
            "directory": "example",
            "filename": "model.onnx",
            "bytes": len(self.data),
            "sha256": hashlib.sha256(self.data).hexdigest(),
        }

    def test_missing_model_does_not_download_implicitly(self):
        with patch("evaluate.urlopen") as network:
            with self.assertRaisesRegex(ValueError, "MODEL_MISSING"):
                prepare_model(self.root, self.spec, False)
            network.assert_not_called()

    def test_corrupt_existing_model_is_not_replaced(self):
        destination = self.root / self.spec["filename"]
        destination.write_bytes(b"x" * len(self.data))
        with patch("evaluate.urlopen") as network:
            with self.assertRaisesRegex(ValueError, "CHECKSUM"):
                prepare_model(self.root, self.spec, True)
            network.assert_not_called()
        self.assertEqual(destination.read_bytes(), b"x" * len(self.data))

    def test_verified_download_is_published_and_then_reused_offline(self):
        with patch("evaluate.urlopen", return_value=io.BytesIO(self.data)):
            path = prepare_model(self.root, self.spec, True)
        verify(path, self.spec)
        with patch("evaluate.urlopen") as network:
            self.assertEqual(prepare_model(self.root, self.spec, False), path)
            network.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [path])

    def test_oversized_download_leaves_no_partial_model(self):
        with patch("evaluate.urlopen", return_value=io.BytesIO(self.data + b"x")):
            with self.assertRaisesRegex(ValueError, "TOO_LARGE"):
                prepare_model(self.root, self.spec, True)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_wrong_digest_download_leaves_no_partial_model(self):
        with patch("evaluate.urlopen", return_value=io.BytesIO(b"x" * len(self.data))):
            with self.assertRaisesRegex(ValueError, "CHECKSUM"):
                prepare_model(self.root, self.spec, True)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_bounds_reject_excessive_work(self):
        for option, value in [("--iterations", "101"), ("--threads", "5"), ("--side", "8192")]:
            with self.subTest(option=option), patch("sys.stderr", new=io.StringIO()):
                with self.assertRaises(SystemExit):
                    arguments(["--models-dir", str(self.root), option, value])


if __name__ == "__main__":
    unittest.main()
