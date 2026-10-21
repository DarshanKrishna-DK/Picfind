"""Authenticated local face index snapshots and verification-only restore drills."""

import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import struct
import sys
import tempfile
import time
import zipfile

from evaluate import bounded_integer
from local_index import (
    LocalIndex, MAX_DATABASE_BYTES, MAX_FACES, MAX_PHOTOS, PHOTO_COLUMNS,
    canonical_uuid, decode, hexadecimal, read_key, scope,
)

DEFAULT_BYTES = 256 * 1024 * 1024
MANIFEST_BYTES = 16384
ARCHIVE_OVERHEAD = 65536
CHUNK = 65536
MAX_SCOPES = 1000
COUNTERS = {"active_scopes", "retired_scopes", "live_photos", "removed_photos", "faces"}
COLUMNS = {
    "metadata": ["id", "database_id", "verifier"],
    "scopes": ["kind", "id", "pipeline_id", "retired"],
    "photos": ["kind", "scope_id", "photo_id", "artifact_digest", "face_count", "ciphertext", "removed"],
}


class Budget:
    def __init__(self, max_bytes=DEFAULT_BYTES, seconds=120):
        if (type(max_bytes) is not int or not 4096 <= max_bytes <= MAX_DATABASE_BYTES or
                type(seconds) is not int or not 1 <= seconds <= 600):
            raise ValueError("BACKUP_OPTIONS_INVALID")
        self.max_bytes = max_bytes
        self.ends = time.monotonic() + seconds

    def check(self):
        if time.monotonic() >= self.ends:
            raise ValueError("BACKUP_DEADLINE")

    def progress(self):
        return int(time.monotonic() >= self.ends)


def local_path(value, output=False):
    path = Path(os.path.abspath(value))
    if str(path).startswith(("\\\\", "//")):
        raise ValueError("LOCAL_PATH_REQUIRED")
    for item in [path, *path.parents]:
        if item.is_symlink() or item.is_junction():
            raise ValueError("PATH_LINK_FORBIDDEN")
    if os.name == "nt":
        import ctypes
        if ctypes.windll.kernel32.GetDriveTypeW(str(path.anchor)) == 4:
            raise ValueError("LOCAL_PATH_REQUIRED")
    if output:
        if path.exists():
            raise ValueError("OUTPUT_ALREADY_EXISTS")
        if not path.parent.is_dir():
            raise ValueError("OUTPUT_DIRECTORY_MISSING")
    elif not path.is_file():
        raise ValueError("INPUT_FILE_REQUIRED")
    return path


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def signature(key, payload):
    if not isinstance(key, bytes) or len(key) != 32:
        raise ValueError("KEY_LENGTH_INVALID")
    derived = hmac.digest(key, b"picfind-local-index-backup-key-v1", "sha256")
    return hmac.new(derived, canonical(payload), hashlib.sha256).hexdigest()


def private_file(path):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb")


def publish(source, output):
    try:
        os.link(source, output)
    except FileExistsError:
        raise ValueError("OUTPUT_ALREADY_EXISTS") from None
    except OSError:
        raise ValueError("OUTPUT_PUBLICATION_FAILED") from None


def space(parent, needed):
    if shutil.disk_usage(parent).free < needed + 16 * 1024 * 1024:
        raise ValueError("BACKUP_DISK_SPACE_REQUIRED")


def stream_copy(source, target, maximum, budget):
    count, digest = 0, hashlib.sha256()
    while True:
        budget.check()
        block = source.read(min(CHUNK, maximum - count + 1))
        if not block:
            break
        count += len(block)
        if count > maximum:
            raise ValueError("BACKUP_SIZE_EXCEEDED")
        digest.update(block)
        target.write(block)
    return count, digest.hexdigest()


def validate_database(database, key, budget):
    budget.check()
    if database.stat().st_size > budget.max_bytes:
        raise ValueError("BACKUP_SIZE_EXCEEDED")
    # Inspect the closed snapshot, never an active source database.
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as raw:
        raw.set_progress_handler(budget.progress, 1000)
        objects = raw.execute("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex_%'").fetchmany(5)
        if sorted(objects) != [("table", name) for name in sorted(COLUMNS)]:
            raise ValueError("BACKUP_SCHEMA_INVALID")
        for table, columns in COLUMNS.items():
            if [row[1] for row in raw.execute(f"PRAGMA table_info({table})")] != columns:
                raise ValueError("BACKUP_SCHEMA_INVALID")
        if raw.execute("PRAGMA integrity_check").fetchmany(2) != [("ok",)]:
            raise ValueError("BACKUP_INTEGRITY_FAILED")
        if raw.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValueError("BACKUP_INTEGRITY_FAILED")
        if raw.execute("SELECT COUNT(*) FROM metadata").fetchone()[0] != 1:
            raise ValueError("BACKUP_SCHEMA_INVALID")
        if raw.execute("""SELECT 1 FROM metadata WHERE id!=1 OR typeof(database_id)!='text' OR
                length(database_id)!=36 OR typeof(verifier)!='blob' OR length(verifier)>128""").fetchone():
            raise ValueError("BACKUP_SCHEMA_INVALID")
        if raw.execute("""SELECT 1 FROM scopes WHERE typeof(kind)!='text' OR typeof(id)!='text' OR
                typeof(pipeline_id)!='text' OR typeof(retired)!='integer' OR
                length(kind)>5 OR length(id)!=36 OR length(pipeline_id)>64 OR retired NOT IN (0,1) LIMIT 1""").fetchone():
            raise ValueError("BACKUP_SCOPE_INVALID")
        if raw.execute("""SELECT 1 FROM photos WHERE typeof(kind)!='text' OR typeof(scope_id)!='text' OR
                typeof(photo_id)!='text' OR typeof(artifact_digest)!='text' OR typeof(removed)!='integer' OR
                length(kind)>5 OR length(scope_id)!=36 OR
                length(photo_id)!=36 OR length(artifact_digest)>64 OR
                typeof(face_count)!='integer' OR face_count<0 OR face_count>100 OR
                removed NOT IN (0,1) LIMIT 1""").fetchone():
            raise ValueError("BACKUP_PHOTO_INVALID")
    result = dict.fromkeys(sorted(COUNTERS), 0)
    with LocalIndex(database, key, read_only=True) as index, index.transaction():
        db = index.connection
        db.set_progress_handler(budget.progress, 1000)
        scopes = db.execute("SELECT * FROM scopes ORDER BY kind,id LIMIT ?", (MAX_SCOPES + 1,)).fetchall()
        if len(scopes) > MAX_SCOPES:
            raise ValueError("BACKUP_SCOPE_LIMIT")
        seen_scopes = set()
        for saved_scope in scopes:
            budget.check()
            selected = scope(saved_scope["kind"], saved_scope["id"])
            if selected in seen_scopes or (not hexadecimal(saved_scope["pipeline_id"]) and
                                          not (saved_scope["retired"] and saved_scope["pipeline_id"] == "")):
                raise ValueError("BACKUP_SCOPE_INVALID")
            seen_scopes.add(selected)
            result["retired_scopes" if saved_scope["retired"] else "active_scopes"] += 1
            seen_photos, faces = set(), 0
            rows = db.execute(f"SELECT {PHOTO_COLUMNS} FROM photos WHERE kind=? AND scope_id=? LIMIT ?",
                              (*selected, MAX_PHOTOS + 1))
            for row in rows:
                budget.check()
                identifier = canonical_uuid(row["photo_id"])
                if identifier in seen_photos or len(seen_photos) >= MAX_PHOTOS:
                    raise ValueError("SCOPE_CAPACITY_EXCEEDED")
                seen_photos.add(identifier)
                if row["removed"]:
                    if row["artifact_digest"] != "" or row["face_count"] != 0 or row["ciphertext"] is not None:
                        raise ValueError("BACKUP_TOMBSTONE_INVALID")
                    # PHOTO_COLUMNS masks oversized ciphertext; verify actual NULL too.
                    actual = db.execute("SELECT ciphertext IS NULL FROM photos WHERE kind=? AND scope_id=? AND photo_id=?",
                                        (*selected, identifier)).fetchone()
                    if not actual[0]:
                        raise ValueError("BACKUP_TOMBSTONE_INVALID")
                    result["removed_photos"] += 1
                else:
                    if saved_scope["retired"]:
                        raise ValueError("BACKUP_TOMBSTONE_INVALID")
                    artifact = index.decode_photo(selected, saved_scope, row)
                    if artifact["pipeline_id"] != saved_scope["pipeline_id"]:
                        raise ValueError("BACKUP_PIPELINE_INVALID")
                    faces += row["face_count"]
                    if faces > MAX_FACES:
                        raise ValueError("SCOPE_CAPACITY_EXCEEDED")
                    result["live_photos"] += 1
                    del artifact
            result["faces"] += faces
        # Also rejects orphan rows if a damaged schema omitted its FK constraint.
        total = db.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
        if total != result["live_photos"] + result["removed_photos"]:
            raise ValueError("BACKUP_INTEGRITY_FAILED")
    budget.check()
    return result


def snapshot(database, key, output, max_bytes=DEFAULT_BYTES, seconds=120):
    budget = Budget(max_bytes, seconds)
    database, output = local_path(database), local_path(output, output=True)
    if database.stat().st_size > max_bytes:
        raise ValueError("BACKUP_SIZE_EXCEEDED")
    space(output.parent, 2 * max_bytes + ARCHIVE_OVERHEAD)
    with tempfile.TemporaryDirectory(prefix=".picfind-backup-", dir=output.parent) as folder:
        temporary = Path(folder)
        copied = temporary / "index.sqlite"
        with private_file(copied):
            pass
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=1)) as source:
            with closing(sqlite3.connect(copied)) as target:
                def progress(status, remaining, total):
                    budget.check()
                    if total * source.execute("PRAGMA page_size").fetchone()[0] > max_bytes:
                        raise ValueError("BACKUP_SIZE_EXCEEDED")
                source.backup(target, pages=128, progress=progress, sleep=0.01)
        counts = validate_database(copied, key, budget)
        bundle = temporary / "bundle.zip"
        with private_file(bundle) as stream, zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
            with copied.open("rb") as source, archive.open("index.sqlite", "w", force_zip64=True) as target:
                size, digest = stream_copy(source, target, max_bytes, budget)
            payload = {
                "schema_version": 1, "created_at": datetime.now(timezone.utc).isoformat(),
                "database_bytes": size, "database_sha256": digest, "counts": counts,
            }
            archive.writestr("manifest.json", canonical({"payload": payload, "signature": signature(key, payload)}))
        budget.check()
        with bundle.open("r+b") as stream:
            os.fsync(stream.fileno())
        publish(bundle, output)
    return {"status": "snapshot_created", "counts": counts, "production_enabled": False}


def manifest(archive, key, budget):
    entries = archive.infolist()
    if (len(entries) != 2 or {entry.filename for entry in entries} != {"index.sqlite", "manifest.json"} or
            any(entry.compress_type != zipfile.ZIP_STORED or entry.flag_bits & 1 or
                entry.compress_size != entry.file_size or entry.extra or entry.comment for entry in entries)):
        raise ValueError("BACKUP_ARCHIVE_INVALID")
    if archive.comment:
        raise ValueError("BACKUP_ARCHIVE_INVALID")
    if archive.getinfo("manifest.json").file_size > MANIFEST_BYTES:
        raise ValueError("BACKUP_MANIFEST_TOO_LARGE")
    data = decode(archive.read("manifest.json"))
    if not isinstance(data, dict) or set(data) != {"payload", "signature"} or not hexadecimal(data["signature"]):
        raise ValueError("BACKUP_MANIFEST_INVALID")
    payload = data["payload"]
    if (not isinstance(payload, dict) or
            set(payload) != {"schema_version", "created_at", "database_bytes", "database_sha256", "counts"} or
            type(payload["schema_version"]) is not int or payload["schema_version"] != 1 or
            type(payload["database_bytes"]) is not int or not 4096 <= payload["database_bytes"] <= budget.max_bytes or
            not hexadecimal(payload["database_sha256"]) or not isinstance(payload["created_at"], str) or
            not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{6})?\+00:00", payload["created_at"]) or
            not isinstance(payload["counts"], dict) or set(payload["counts"]) != COUNTERS or
            any(type(value) is not int or not 0 <= value <= MAX_SCOPES * MAX_FACES for value in payload["counts"].values())):
        raise ValueError("BACKUP_MANIFEST_INVALID")
    datetime.fromisoformat(payload["created_at"])
    if not hmac.compare_digest(signature(key, payload), data["signature"]):
        raise ValueError("BACKUP_AUTHENTICATION_FAILED")
    if archive.getinfo("index.sqlite").file_size != payload["database_bytes"]:
        raise ValueError("BACKUP_SIZE_EXCEEDED")
    return payload


def archive_directory(stream):
    """Bound directory allocation before ZipFile parses attacker-controlled entries."""
    stream.seek(0, os.SEEK_END)
    size = stream.tell()
    if size < 22:
        raise ValueError("BACKUP_ARCHIVE_INVALID")
    stream.seek(-22, os.SEEK_END)
    magic, disk, start_disk, disk_count, count, directory_size, offset, comment = struct.unpack(
        "<4s4H2LH", stream.read(22))
    if (magic != b"PK\x05\x06" or disk or start_disk or disk_count != 2 or count != 2 or
            comment or directory_size > 4096 or offset + directory_size != size - 22):
        raise ValueError("BACKUP_ARCHIVE_INVALID")
    stream.seek(0)


def restore_drill(bundle, key, output, max_bytes=DEFAULT_BYTES, seconds=120):
    budget = Budget(max_bytes, seconds)
    bundle, output = local_path(bundle), local_path(output, output=True)
    if bundle.stat().st_size > max_bytes + ARCHIVE_OVERHEAD:
        raise ValueError("BACKUP_SIZE_EXCEEDED")
    with bundle.open("rb") as stream:
        archive_directory(stream)
        return drill_archive(stream, key, output, budget)


def drill_archive(stream, key, output, budget):
    with zipfile.ZipFile(stream, "r") as archive:
        payload = manifest(archive, key, budget)
        space(output.parent, payload["database_bytes"])
        with tempfile.TemporaryDirectory(prefix=".picfind-restore-", dir=output.parent) as folder:
            database = Path(folder) / "index.sqlite"
            with archive.open("index.sqlite") as source, private_file(database) as target:
                size, digest = stream_copy(source, target, payload["database_bytes"], budget)
            if size != payload["database_bytes"] or not hmac.compare_digest(digest, payload["database_sha256"]):
                raise ValueError("BACKUP_DIGEST_MISMATCH")
            counts = validate_database(database, key, budget)
            if counts != payload["counts"]:
                raise ValueError("BACKUP_COUNTS_MISMATCH")
            report = {
                "schema_version": 1, "status": "restore_drill_verified", "counts": counts,
                "snapshot_created_at": payload["created_at"],
                "verified_at": datetime.now(timezone.utc).isoformat(),
                "restored_database_retained": False, "production_enabled": False,
                "current_consent_verified": False,
            }
            staged = Path(folder) / "report.json"
            with private_file(staged) as target:
                target.write(canonical(report))
                target.flush()
                os.fsync(target.fileno())
            budget.check()
            # Remove the restored database before publishing a success report.
            database.unlink()
            publish(staged, output)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["snapshot", "restore-drill"])
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-bytes", type=bounded_integer(4096, MAX_DATABASE_BYTES), default=DEFAULT_BYTES)
    parser.add_argument("--deadline", type=bounded_integer(1, 600), default=120)
    args = parser.parse_args(argv)
    try:
        key = read_key(local_path(args.key_file))
        operation = snapshot if args.command == "snapshot" else restore_drill
        result = operation(args.input, key, args.output, args.max_bytes, args.deadline)
        print(json.dumps(result))
        return 0
    except (ValueError, OSError, sqlite3.Error, zipfile.BadZipFile, RuntimeError, TypeError) as error:
        candidate = str(error)
        code = candidate if re.fullmatch(r"[A-Z_]{1,64}", candidate) else "BACKUP_OPERATION_FAILED"
        print(json.dumps({"error": code}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
