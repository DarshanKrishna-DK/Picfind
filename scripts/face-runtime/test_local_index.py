from concurrent.futures import ThreadPoolExecutor
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

import extract
import local_index
from test_extract import face, job


def artifact(selected_scope=None, photo_id=None, side=1280, image_digest="a" * 64):
    data = job()
    if selected_scope:
        data["scope_kind"], data["scope_id"] = selected_scope
    if photo_id:
        data["photo_id"] = photo_id
    data["side"] = side
    data["consent_reference"] = "sensitive-consent-record"
    result = extract.document(data, image_digest, (640, 480), [face()])
    scale = min(1.0, side / 640)
    result["detector_dimensions"] = [round(640 * scale), round(480 * scale)]
    return result


class LocalIndexTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.database = self.root / "private.sqlite"
        self.key_file = self.root / "key.bin"
        local_index.create_key(self.key_file)
        self.key = local_index.read_key(self.key_file)
        local_index.initialize(self.database, self.key)
        self.scope = ("event", job()["scope_id"])
        self.artifact = artifact()

    def index(self):
        return local_index.LocalIndex(self.database, self.key)

    def test_key_and_database_creation_never_overwrite(self):
        before_key, before_db = self.key_file.read_bytes(), self.database.read_bytes()
        with self.assertRaises(FileExistsError):
            local_index.create_key(self.key_file)
        with self.assertRaises(FileExistsError):
            local_index.initialize(self.database, self.key)
        self.assertEqual(self.key_file.read_bytes(), before_key)
        self.assertEqual(self.database.read_bytes(), before_db)
        if os.name != "nt":
            self.assertEqual(self.key_file.stat().st_mode & 0o777, 0o600)
            self.assertEqual(self.database.stat().st_mode & 0o777, 0o600)

    def test_key_lengths_and_posix_permissions_fail_closed(self):
        for size in (0, 31, 33, 10000):
            self.key_file.write_bytes(b"x" * size)
            with self.assertRaisesRegex(ValueError, "KEY_LENGTH_INVALID"):
                local_index.read_key(self.key_file)
        if os.name != "nt":
            self.key_file.write_bytes(self.key)
            self.key_file.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "KEY_PERMISSIONS_UNSAFE"):
                local_index.read_key(self.key_file)

    def test_restart_recovers_only_authenticated_encrypted_artifacts(self):
        with self.index() as index:
            stored = index.import_photo(self.scope, self.artifact)
            self.assertEqual(stored["status"], "stored")
            self.assertEqual(index.stats(self.scope)["faces"], 1)
        with self.index() as index:
            self.assertEqual(index.read_scope(self.scope), [self.artifact])
            self.assertEqual(index.import_photo(self.scope, self.artifact)["status"], "unchanged")
        raw = self.database.read_bytes()
        self.assertNotIn(b"sensitive-consent-record", raw)
        self.assertNotIn(b'"embedding"', raw)
        self.assertNotIn(b'"detection"', raw)

    def test_wrong_key_and_wrong_schema_do_not_mutate_database(self):
        before = self.database.read_bytes()
        with self.assertRaisesRegex(ValueError, "INDEX_AUTHENTICATION_FAILED"):
            local_index.LocalIndex(self.database, AESGCM.generate_key(bit_length=256))
        self.assertEqual(self.database.read_bytes(), before)
        with contextlib.closing(sqlite3.connect(self.database)) as connection:
            connection.execute("PRAGMA user_version=2")
        with self.assertRaisesRegex(ValueError, "INDEX_VERSION_UNSUPPORTED"):
            self.index()

    def test_scope_kind_and_id_isolate_the_same_photo_uuid(self):
        other = ("scan", self.scope[1])
        foreign = ("event", str(uuid4()))
        with self.index() as index:
            index.import_photo(self.scope, self.artifact)
            index.import_photo(other, artifact(other))
            self.assertEqual(index.read_scope(self.scope), [self.artifact])
            self.assertEqual(index.read_scope(other), [artifact(other)])
            with self.assertRaisesRegex(ValueError, "SCOPE_UNAVAILABLE"):
                index.read_scope(foreign)
            with self.assertRaisesRegex(ValueError, "ARTIFACT_SCOPE_MISMATCH"):
                index.import_photo(foreign, self.artifact)

    def test_replacement_requires_current_digest_and_is_atomic(self):
        updated = artifact(image_digest="b" * 64)
        with self.index() as index:
            initial = index.import_photo(self.scope, self.artifact)
            with self.assertRaisesRegex(ValueError, "PHOTO_VERSION_CONFLICT"):
                index.import_photo(self.scope, updated)
            with self.assertRaisesRegex(ValueError, "PHOTO_VERSION_CONFLICT"):
                index.import_photo(self.scope, updated, "c" * 64)
            changed = index.import_photo(self.scope, updated, initial["artifact_digest"])
            self.assertNotEqual(changed["artifact_digest"], initial["artifact_digest"])
            with self.assertRaisesRegex(ValueError, "PHOTO_VERSION_CONFLICT"):
                index.import_photo(self.scope, self.artifact, initial["artifact_digest"])
            self.assertEqual(index.read_scope(self.scope), [updated])
            self.assertEqual(index.stats(self.scope)["photos"], 1)

    def test_same_scope_cannot_mix_pipeline_versions(self):
        with self.index() as index:
            index.import_photo(self.scope, self.artifact)
            with self.assertRaisesRegex(ValueError, "SCOPE_PIPELINE_INCOMPATIBLE"):
                index.import_photo(self.scope, artifact(photo_id=str(uuid4()), side=640))
            self.assertEqual(index.read_scope(self.scope), [self.artifact])

    def test_photo_erasure_removes_ciphertext_and_blocks_late_import_after_restart(self):
        photo_id = self.artifact["photo_id"]
        with self.index() as index:
            index.import_photo(self.scope, self.artifact)
            index.erase_photo(self.scope, photo_id)
            index.erase_photo(self.scope, photo_id)
            self.assertEqual(index.read_scope(self.scope), [])
            self.assertEqual(index.stats(self.scope)["removed_photos"], 1)
            row = index.connection.execute("SELECT ciphertext,face_count,artifact_digest FROM photos").fetchone()
            self.assertEqual(tuple(row), (None, 0, ""))
        with self.index() as index:
            with self.assertRaisesRegex(ValueError, "PHOTO_RETIRED"):
                index.import_photo(self.scope, self.artifact)

    def test_tombstone_prevents_a_pending_photo_import_into_an_existing_scope(self):
        pending_id = str(uuid4())
        with self.index() as index:
            index.import_photo(self.scope, self.artifact)
            index.erase_photo(self.scope, pending_id)
            with self.assertRaisesRegex(ValueError, "PHOTO_RETIRED"):
                index.import_photo(self.scope, artifact(photo_id=pending_id))

    def test_scope_erasure_blocks_late_import_including_never_created_scope(self):
        other = ("event", str(uuid4()))
        with self.index() as index:
            index.import_photo(self.scope, self.artifact)
            index.erase_scope(self.scope)
            index.erase_scope(self.scope)
            index.erase_scope(other)
        with self.index() as index:
            self.assertTrue(index.stats(self.scope)["retired"])
            self.assertEqual(index.stats(self.scope)["faces"], 0)
            for selected_scope in (self.scope, other):
                with self.assertRaisesRegex(ValueError, "SCOPE_RETIRED"):
                    index.import_photo(selected_scope, artifact(selected_scope))
                with self.assertRaisesRegex(ValueError, "SCOPE_UNAVAILABLE"):
                    index.read_scope(selected_scope)

    def test_ciphertext_tampering_and_cross_scope_swaps_are_detected(self):
        other = ("scan", self.scope[1])
        with self.index() as index:
            index.import_photo(self.scope, self.artifact)
            index.import_photo(other, artifact(other))
            original = index.connection.execute("SELECT ciphertext FROM photos WHERE kind='event'").fetchone()[0]
            index.connection.execute("UPDATE photos SET ciphertext=? WHERE kind='scan'", (original,))
            with self.assertRaisesRegex(ValueError, "INDEX_AUTHENTICATION_FAILED"):
                index.read_scope(other)
            index.connection.execute("UPDATE photos SET ciphertext=? WHERE kind='event'", (original[:-1] + bytes([original[-1] ^ 1]),))
            with self.assertRaisesRegex(ValueError, "INDEX_AUTHENTICATION_FAILED"):
                index.read_scope(self.scope)
            with self.assertRaisesRegex(ValueError, "INDEX_AUTHENTICATION_FAILED"):
                index.import_photo(self.scope, self.artifact)
            index.erase_scope(self.scope)
            self.assertEqual(index.stats(self.scope)["faces"], 0)

    def test_plaintext_count_or_digest_corruption_is_rejected_on_read(self):
        with self.index() as index:
            index.import_photo(self.scope, self.artifact)
            index.connection.execute("UPDATE photos SET face_count=2")
            with self.assertRaisesRegex(ValueError, "INDEX_ARTIFACT_CORRUPT"):
                index.read_scope(self.scope)
            index.connection.execute("UPDATE photos SET face_count=1,artifact_digest=?", ("b" * 64,))
            with self.assertRaisesRegex(ValueError, "INDEX_ARTIFACT_CORRUPT"):
                index.read_scope(self.scope)

    def test_oversized_ciphertext_and_cross_database_replay_are_rejected(self):
        other_database = self.root / "other.sqlite"
        local_index.initialize(other_database, self.key)
        with self.index() as index, local_index.LocalIndex(other_database, self.key) as other:
            index.import_photo(self.scope, self.artifact)
            other.import_photo(self.scope, self.artifact)
            encrypted = index.connection.execute("SELECT ciphertext FROM photos").fetchone()[0]
            other.connection.execute("UPDATE photos SET ciphertext=?", (encrypted,))
            with self.assertRaisesRegex(ValueError, "INDEX_AUTHENTICATION_FAILED"):
                other.read_scope(self.scope)
            index.connection.execute("UPDATE photos SET ciphertext=zeroblob(?)", (extract.MAX_OUTPUT + 29,))
            with self.assertRaisesRegex(ValueError, "INDEX_AUTHENTICATION_FAILED"):
                index.read_scope(self.scope)

    def test_failed_encryption_rolls_back_scope_and_photo_creation(self):
        with self.index() as index, patch.object(local_index, "seal", side_effect=ValueError("SYNTHETIC_FAILURE")):
            with self.assertRaisesRegex(ValueError, "SYNTHETIC_FAILURE"):
                index.import_photo(self.scope, self.artifact)
            self.assertEqual(index.connection.execute("SELECT COUNT(*) FROM scopes").fetchone()[0], 0)
            self.assertEqual(index.connection.execute("SELECT COUNT(*) FROM photos").fetchone()[0], 0)

    def test_concurrent_imports_use_sqlite_transactions(self):
        def store(data):
            with self.index() as index:
                try:
                    return index.import_photo(self.scope, data)["status"]
                except ValueError as error:
                    return str(error)
        with ThreadPoolExecutor(max_workers=2) as executor:
            result = list(executor.map(store, [self.artifact, self.artifact]))
        self.assertCountEqual(result, ["stored", "unchanged"])
        with self.index() as index:
            self.assertEqual(index.stats(self.scope)["photos"], 1)
        other_photo = str(uuid4())
        with ThreadPoolExecutor(max_workers=2) as executor:
            result = list(executor.map(store, [artifact(photo_id=other_photo), artifact(photo_id=other_photo, image_digest="b" * 64)]))
        self.assertCountEqual(result, ["stored", "PHOTO_VERSION_CONFLICT"])

    def test_capacity_counts_retained_photo_tombstones_and_live_faces(self):
        with self.index() as index, patch.object(local_index, "MAX_PHOTOS", 1):
            index.import_photo(self.scope, self.artifact)
            index.erase_photo(self.scope, self.artifact["photo_id"])
            with self.assertRaisesRegex(ValueError, "SCOPE_CAPACITY_EXCEEDED"):
                index.import_photo(self.scope, artifact(photo_id=str(uuid4())))
            with self.assertRaisesRegex(ValueError, "SCOPE_CAPACITY_EXCEEDED"):
                index.erase_photo(self.scope, str(uuid4()))
        other = ("scan", self.scope[1])
        with self.index() as index, patch.object(local_index, "MAX_FACES", 1):
            index.import_photo(other, artifact(other))
            with self.assertRaisesRegex(ValueError, "SCOPE_CAPACITY_EXCEEDED"):
                index.import_photo(other, artifact(other, photo_id=str(uuid4())))

    def test_artifact_validation_rejects_reference_untrusted_metadata_and_vectors(self):
        cases = [
            ("mode", "reference"), ("schema_version", True),
            ("quality_evaluated", True), ("photo_id", "bad"),
            ("consent_reference", ""), ("input_sha256", "bad"),
            ("pipeline_id", "0" * 64), ("input_dimensions", [8192, 8192]),
            ("detector_dimensions", [1, 1]),
        ]
        with self.index() as index:
            for field, value in cases:
                data = copy.deepcopy(self.artifact)
                data[field] = value
                with self.subTest(field=field), self.assertRaises(ValueError):
                    index.import_photo(self.scope, data)
            for value in (float("nan"), float("inf"), True, "bad", 0.9):
                data = copy.deepcopy(self.artifact)
                data["faces"][0]["embedding"][0] = value
                with self.subTest(value=value), self.assertRaises(ValueError):
                    index.import_photo(self.scope, data)
            data = copy.deepcopy(self.artifact)
            data["faces"][0]["id"] = "b" * 64
            with self.assertRaisesRegex(ValueError, "ARTIFACT_FACE_ID_INVALID"):
                index.import_photo(self.scope, data)
            self.assertEqual(index.connection.execute("SELECT COUNT(*) FROM photos").fetchone()[0], 0)

    def test_json_loading_is_bounded_and_rejects_duplicate_keys(self):
        path = self.root / "extraction.json"
        path.write_text('{"schema_version":1,"schema_version":2}')
        with self.assertRaisesRegex(ValueError, "ARTIFACT_JSON_INVALID"):
            local_index.load_artifact(path, self.scope)
        path.write_bytes(b"x" * (extract.MAX_OUTPUT + 1))
        with self.assertRaisesRegex(ValueError, "ARTIFACT_TOO_LARGE"):
            local_index.load_artifact(path, self.scope)

    def test_cli_prints_counts_and_digests_without_vectors_or_consent(self):
        path = self.root / "extraction.json"
        path.write_text(json.dumps(self.artifact))
        base = ["--key-file", str(self.key_file), "--database", str(self.database), "--scope-kind", self.scope[0], "--scope-id", self.scope[1]]
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            self.assertEqual(local_index.main(["import", *base, "--artifact", str(path)]), 0)
            self.assertEqual(local_index.main(["stats", *base]), 0)
            self.assertEqual(local_index.main(["erase-photo", *base, "--photo-id", self.artifact["photo_id"]]), 0)
        self.assertEqual(errors.getvalue(), "")
        self.assertNotIn("embedding", output.getvalue())
        self.assertNotIn("sensitive-consent-record", output.getvalue())
        self.assertNotIn(self.key.hex(), output.getvalue())
        self.assertEqual(json.loads(output.getvalue().splitlines()[0])["faces"], 1)


if __name__ == "__main__":
    unittest.main()
