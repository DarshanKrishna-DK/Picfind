from concurrent.futures import ThreadPoolExecutor
import contextlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4
import zipfile

import backup
import local_index
from test_local_index import artifact


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.database = self.root / "index.sqlite"
        self.bundle = self.root / "backup.zip"
        self.report = self.root / "report.json"
        self.key_file = self.root / "key.bin"
        local_index.create_key(self.key_file)
        self.key = local_index.read_key(self.key_file)
        local_index.initialize(self.database, self.key)
        self.scope = ("event", str(uuid4()))
        self.photo = artifact(self.scope)
        with local_index.LocalIndex(self.database, self.key) as index:
            index.import_photo(self.scope, self.photo)

    def snapshot(self, **kwargs):
        return backup.snapshot(self.database, self.key, self.bundle, **kwargs)

    def drill(self, **kwargs):
        return backup.restore_drill(self.bundle, self.key, self.report, **kwargs)

    def entries(self):
        with zipfile.ZipFile(self.bundle) as archive:
            return [(name, archive.read(name)) for name in archive.namelist()]

    def rewrite(self, entries, compression=zipfile.ZIP_STORED):
        with zipfile.ZipFile(self.bundle, "w", compression=compression) as archive:
            for name, value in entries:
                archive.writestr(name, value)

    def assert_clean(self):
        self.assertFalse(list(self.root.glob(".picfind-*")))

    def test_multiscope_tombstones_survive_without_active_restore_or_plaintext(self):
        retired = ("scan", str(uuid4()))
        empty_retired = ("event", str(uuid4()))
        removed = str(uuid4())
        with local_index.LocalIndex(self.database, self.key) as index:
            index.import_photo(self.scope, artifact(self.scope, removed))
            index.erase_photo(self.scope, removed)
            index.import_photo(retired, artifact(retired))
            index.erase_scope(retired)
            index.erase_scope(empty_retired)
        before = self.database.read_bytes()
        created = self.snapshot()
        verified = self.drill()
        self.assertEqual(created["counts"], {
            "active_scopes": 1, "retired_scopes": 2,
            "live_photos": 1, "removed_photos": 2, "faces": 1,
        })
        self.assertEqual(verified["counts"], created["counts"])
        self.assertFalse(verified["restored_database_retained"])
        self.assertFalse(verified["current_consent_verified"])
        self.assertEqual(before, self.database.read_bytes())
        self.assertEqual(json.loads(self.report.read_bytes()), verified)
        for value in (self.bundle.read_bytes(), self.report.read_bytes()):
            self.assertNotIn(b"sensitive-consent-record", value)
            self.assertNotIn(self.key, value)
            self.assertNotIn(b'"embedding"', value)
        self.assertNotIn(self.scope[1], self.report.read_text())
        self.assert_clean()
        if os.name != "nt":
            self.assertEqual(self.bundle.stat().st_mode & 0o777, 0o600)
            self.assertEqual(self.report.stat().st_mode & 0o777, 0o600)

    def test_read_only_index_cannot_write_or_change_source_bytes(self):
        before = self.database.read_bytes()
        with local_index.LocalIndex(self.database, self.key, read_only=True) as index:
            self.assertEqual(index.read_scope(self.scope), [self.photo])
            with self.assertRaises(sqlite3.OperationalError):
                index.erase_scope(self.scope)
        self.assertEqual(before, self.database.read_bytes())

    def test_wrong_keys_fail_before_publication_and_cleanup(self):
        with self.assertRaisesRegex(ValueError, "AUTHENTICATION_FAILED"):
            backup.snapshot(self.database, b"x" * 32, self.bundle)
        self.assertFalse(self.bundle.exists())
        self.snapshot()
        with self.assertRaisesRegex(ValueError, "BACKUP_AUTHENTICATION_FAILED"):
            backup.restore_drill(self.bundle, b"x" * 32, self.report)
        self.assertFalse(self.report.exists())
        self.assert_clean()

    def test_manifest_tampering_and_duplicate_json_keys_fail(self):
        self.snapshot()
        original = self.entries()
        data = json.loads(dict(original)["manifest.json"])
        data["payload"]["counts"]["faces"] += 1
        self.rewrite([("index.sqlite", dict(original)["index.sqlite"]),
                      ("manifest.json", json.dumps(data))])
        with self.assertRaisesRegex(ValueError, "BACKUP_AUTHENTICATION_FAILED"):
            self.drill()
        self.rewrite([("index.sqlite", dict(original)["index.sqlite"]),
                      ("manifest.json", '{"payload": {}, "payload": {}, "signature": "x"}')])
        with self.assertRaisesRegex(ValueError, "ARTIFACT_JSON_INVALID"):
            self.drill()
        self.assertFalse(self.report.exists())
        self.assert_clean()

    def test_database_digest_tampering_fails_before_sqlite_open(self):
        self.snapshot()
        data = dict(self.entries())
        changed = bytearray(data["index.sqlite"])
        changed[-1] ^= 1
        self.rewrite([("index.sqlite", changed), ("manifest.json", data["manifest.json"])])
        with patch.object(backup, "validate_database") as validate:
            with self.assertRaisesRegex(ValueError, "BACKUP_DIGEST_MISMATCH"):
                self.drill()
            validate.assert_not_called()
        self.assert_clean()

    def test_signed_counts_mismatch_is_rejected(self):
        self.snapshot()
        data = dict(self.entries())
        saved = json.loads(data["manifest.json"])
        saved["payload"]["counts"]["faces"] += 1
        saved["signature"] = backup.signature(self.key, saved["payload"])
        self.rewrite([("index.sqlite", data["index.sqlite"]), ("manifest.json", json.dumps(saved))])
        with self.assertRaisesRegex(ValueError, "BACKUP_COUNTS_MISMATCH"):
            self.drill()
        self.assertFalse(self.report.exists())
        self.assert_clean()

    def test_extra_traversal_duplicate_and_compressed_entries_rejected(self):
        self.snapshot()
        original = self.entries()
        cases = [
            original + [("extra", b"x")],
            [("../index.sqlite", original[0][1]), original[1]],
            [original[0], original[0]],
        ]
        import warnings
        for entries in cases:
            with self.subTest(names=[x[0] for x in entries]), warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                self.rewrite(entries)
                with self.assertRaisesRegex(ValueError, "BACKUP_ARCHIVE_INVALID"):
                    self.drill()
        self.rewrite(original, zipfile.ZIP_DEFLATED)
        with self.assertRaisesRegex(ValueError, "BACKUP_ARCHIVE_INVALID"):
            self.drill()
        self.assert_clean()

    def test_directory_bound_checked_before_zipfile_allocation(self):
        self.bundle.write_bytes(b"x" * 100)
        with patch.object(backup.zipfile, "ZipFile") as archive:
            with self.assertRaisesRegex(ValueError, "BACKUP_ARCHIVE_INVALID"):
                self.drill()
            archive.assert_not_called()

    def test_truncation_oversized_manifest_and_entry_size_fail(self):
        self.snapshot()
        original = self.entries()
        self.bundle.write_bytes(self.bundle.read_bytes()[:-10])
        with self.assertRaisesRegex(ValueError, "BACKUP_ARCHIVE_INVALID"):
            self.drill()
        self.rewrite([original[0], ("manifest.json", b"x" * (backup.MANIFEST_BYTES + 1))])
        with self.assertRaisesRegex(ValueError, "BACKUP_MANIFEST_TOO_LARGE"):
            self.drill()
        self.rewrite([("index.sqlite", original[0][1] + b"extra"), original[1]])
        with self.assertRaisesRegex(ValueError, "BACKUP_SIZE_EXCEEDED"):
            self.drill()
        self.rewrite(original)
        with self.assertRaises(ValueError):
            self.drill(max_bytes=4096)
        self.assertFalse(self.report.exists())
        self.assert_clean()

    def test_links_and_linked_parent_directories_rejected(self):
        link = self.root / "linked.sqlite"
        try:
            link.symlink_to(self.database)
        except OSError:
            self.skipTest("Symbolic links are unavailable for this Windows account")
        with self.assertRaisesRegex(ValueError, "PATH_LINK_FORBIDDEN"):
            backup.snapshot(link, self.key, self.bundle)
        parent = self.root / "linked-parent"
        parent.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "PATH_LINK_FORBIDDEN"):
            backup.snapshot(self.database, self.key, parent / "new.zip")

    def test_existing_destinations_and_source_alias_never_overwritten(self):
        before = self.database.read_bytes()
        with self.assertRaisesRegex(ValueError, "OUTPUT_ALREADY_EXISTS"):
            backup.snapshot(self.database, self.key, self.database)
        self.snapshot()
        saved = self.bundle.read_bytes()
        with self.assertRaisesRegex(ValueError, "OUTPUT_ALREADY_EXISTS"):
            self.snapshot()
        self.report.write_text("keep")
        with self.assertRaisesRegex(ValueError, "OUTPUT_ALREADY_EXISTS"):
            self.drill()
        self.assertEqual(before, self.database.read_bytes())
        self.assertEqual(saved, self.bundle.read_bytes())
        self.assertEqual(self.report.read_text(), "keep")

    def test_publication_race_preserves_competing_output_and_cleans(self):
        original_link = os.link
        def competing(source, destination):
            Path(destination).write_bytes(b"other operation")
            original_link(source, destination)
        with patch.object(backup.os, "link", side_effect=competing):
            with self.assertRaisesRegex(ValueError, "OUTPUT_ALREADY_EXISTS"):
                self.snapshot()
        self.assertEqual(self.bundle.read_bytes(), b"other operation")
        self.assert_clean()

    def test_size_free_space_deadline_and_scope_limits(self):
        with self.assertRaisesRegex(ValueError, "BACKUP_SIZE_EXCEEDED"):
            self.snapshot(max_bytes=4096)
        with patch.object(backup.shutil, "disk_usage", return_value=type("Usage", (), {"free": 1})()):
            with self.assertRaisesRegex(ValueError, "BACKUP_DISK_SPACE_REQUIRED"):
                self.snapshot()
        with patch.object(backup.time, "monotonic", side_effect=[0, 601]):
            with self.assertRaisesRegex(ValueError, "BACKUP_DEADLINE"):
                self.snapshot()
        with patch.object(backup, "MAX_SCOPES", 0):
            with self.assertRaisesRegex(ValueError, "BACKUP_SCOPE_LIMIT"):
                self.snapshot()
        self.assertFalse(self.bundle.exists())
        self.assert_clean()

    def test_corrupt_ciphertext_and_tombstones_are_rejected(self):
        with contextlib.closing(sqlite3.connect(self.database)) as db:
            db.execute("UPDATE photos SET ciphertext=zeroblob(40)")
            db.commit()
        with self.assertRaisesRegex(ValueError, "AUTHENTICATION_FAILED"):
            self.snapshot()
        with contextlib.closing(sqlite3.connect(self.database)) as db:
            db.execute("UPDATE photos SET removed=1,artifact_digest='',face_count=0")
            db.commit()
        with self.assertRaisesRegex(ValueError, "BACKUP_TOMBSTONE_INVALID"):
            self.snapshot()
        self.assert_clean()

    def test_unexpected_schema_and_orphans_rejected(self):
        with contextlib.closing(sqlite3.connect(self.database)) as db:
            db.execute("CREATE VIEW secret_view AS SELECT * FROM photos")
        with self.assertRaisesRegex(ValueError, "BACKUP_SCHEMA_INVALID"):
            self.snapshot()
        with contextlib.closing(sqlite3.connect(self.database)) as db:
            db.execute("DROP VIEW secret_view")
            db.execute("DELETE FROM scopes")
            db.commit()
        with self.assertRaisesRegex(ValueError, "BACKUP_INTEGRITY_FAILED"):
            self.snapshot()
        self.assert_clean()

    def test_restore_deadline_and_publication_failure_remove_temporary_database(self):
        self.snapshot()
        with patch.object(backup.Budget, "check", side_effect=ValueError("BACKUP_DEADLINE")):
            with self.assertRaisesRegex(ValueError, "BACKUP_DEADLINE"):
                self.drill()
        with patch.object(backup.os, "link", side_effect=OSError("unsupported")):
            with self.assertRaisesRegex(ValueError, "OUTPUT_PUBLICATION_FAILED"):
                self.drill()
        self.assertFalse(self.report.exists())
        self.assert_clean()

    def test_backup_during_committed_writes_is_consistent(self):
        def write_photos():
            with local_index.LocalIndex(self.database, self.key) as index:
                for _ in range(15):
                    index.import_photo(self.scope, artifact(self.scope, str(uuid4())))
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(write_photos)
            saved = self.snapshot()
            future.result()
        verified = self.drill()
        self.assertEqual(saved["counts"], verified["counts"])
        self.assertGreaterEqual(verified["counts"]["live_photos"], 1)
        self.assertLessEqual(verified["counts"]["live_photos"], 16)
        with local_index.LocalIndex(self.database, self.key) as index:
            self.assertEqual(index.stats(self.scope)["photos"], 16)

    def test_wal_commits_are_included_without_checkpointing_source(self):
        with local_index.LocalIndex(self.database, self.key) as index:
            writer = index.connection
            self.assertEqual(writer.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            index.import_photo(self.scope, artifact(self.scope, str(uuid4())))
            before_db = self.database.read_bytes()
            before_wal = Path(str(self.database) + "-wal").read_bytes()
            self.assertEqual(self.snapshot()["counts"]["live_photos"], 2)
            self.assertEqual(self.drill()["counts"]["live_photos"], 2)
            self.assertEqual(self.database.read_bytes(), before_db)
            self.assertEqual(Path(str(self.database) + "-wal").read_bytes(), before_wal)
        self.assert_clean()

    def test_cli_outputs_only_aggregate_status_and_safe_errors(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = backup.main(["snapshot", "--input", str(self.database), "--key-file", str(self.key_file),
                                "--output", str(self.bundle)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout.getvalue())["status"], "snapshot_created")
        self.assertNotIn(str(self.root), stdout.getvalue())
        self.assertNotIn(self.scope[1], stdout.getvalue())
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = backup.main(["restore-drill", "--input", str(self.bundle), "--key-file", str(self.key_file),
                                "--output", str(self.report)])
        self.assertEqual(code, 0)
        self.assertEqual(stderr.getvalue(), "")
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = backup.main(["snapshot", "--input", str(self.root / "missing-private-name.sqlite"),
                                "--key-file", str(self.key_file), "--output", str(self.root / "new.zip")])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(stderr.getvalue()), {"error": "INPUT_FILE_REQUIRED"})
        self.assertNotIn("missing-private-name", stderr.getvalue())
        self.assert_clean()

    def test_independent_cli_processes_snapshot_and_verify_generated_fixture(self):
        for command, source, target in (
                ("snapshot", self.database, self.bundle),
                ("restore-drill", self.bundle, self.report)):
            completed = subprocess.run(
                [sys.executable, str(Path(backup.__file__).resolve()), command,
                 "--input", str(source), "--key-file", str(self.key_file), "--output", str(target)],
                capture_output=True, text=True, timeout=30, check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(json.loads(completed.stdout)["counts"]["live_photos"], 1)
            self.assertEqual(completed.stderr, "")
        self.assertEqual({item.name for item in self.root.iterdir()},
                         {"index.sqlite", "key.bin", "backup.zip", "report.json"})
        self.assert_clean()


if __name__ == "__main__":
    unittest.main()
