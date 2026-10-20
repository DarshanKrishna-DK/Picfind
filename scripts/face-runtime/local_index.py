"""Encrypted, scope-bound local face evaluation storage. No production activation."""

import argparse
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
from uuid import UUID, uuid4

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from extract import MAX_OUTPUT, MAX_PIXELS, MAX_SIDE, digest_json, pipeline

MAX_PHOTOS = 5000
MAX_FACES = 20000
MAX_DATABASE_BYTES = 2 * 1024 * 1024 * 1024
PHOTO_COLUMNS = f"kind,scope_id,photo_id,artifact_digest,face_count,removed,CASE WHEN length(ciphertext)<={MAX_OUTPUT + 28} THEN ciphertext ELSE NULL END AS ciphertext"


def canonical_uuid(value):
    if not isinstance(value, str):
        raise ValueError("UUID_REQUIRED")
    try:
        if str(UUID(value)) != value:
            raise ValueError("UUID_REQUIRED")
    except ValueError:
        raise ValueError("UUID_REQUIRED") from None
    return value


def scope(kind, identifier):
    if kind not in ("event", "scan"):
        raise ValueError("SCOPE_KIND_REQUIRED")
    return kind, canonical_uuid(identifier)


def hexadecimal(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def decode(payload):
    try:
        return json.loads(payload, object_pairs_hook=unique_object)
    except (ValueError, RecursionError, UnicodeError):
        raise ValueError("ARTIFACT_JSON_INVALID") from None


def validate_artifact(data, expected_scope, expected_mode="photo"):
    required = {"schema_version", "scope", "photo_id", "consent_reference", "mode",
                "input_sha256", "input_dimensions", "pipeline_id", "pipeline",
                "faces", "quality_evaluated", "detector_dimensions"}
    if not isinstance(data, dict) or set(data) != required or type(data["schema_version"]) is not int or data["schema_version"] != 1:
        raise ValueError("ARTIFACT_SCHEMA_INVALID")
    if data["scope"] != {"kind": expected_scope[0], "id": expected_scope[1]}:
        raise ValueError("ARTIFACT_SCOPE_MISMATCH")
    canonical_uuid(data["photo_id"])
    if expected_mode not in ("photo", "reference"):
        raise ValueError("ARTIFACT_MODE_INVALID")
    if data["mode"] != expected_mode or data["quality_evaluated"] is not False:
        raise ValueError("PHOTO_ARTIFACT_REQUIRED" if expected_mode == "photo" else "REFERENCE_ARTIFACT_REQUIRED")
    if not hexadecimal(data["input_sha256"]) or not hexadecimal(data["pipeline_id"]):
        raise ValueError("ARTIFACT_DIGEST_INVALID")
    consent = data["consent_reference"]
    if not isinstance(consent, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", consent):
        raise ValueError("CONSENT_REFERENCE_REQUIRED")
    profile = data["pipeline"]
    if not isinstance(profile, dict) or type(profile.get("maximum_side")) is not int or type(profile.get("threads")) is not int:
        raise ValueError("PIPELINE_INVALID")
    side, threads = profile["maximum_side"], profile["threads"]
    if not 320 <= side <= 1600 or not 1 <= threads <= 4:
        raise ValueError("PIPELINE_INVALID")
    expected_pipeline = digest_json(pipeline(side, threads))
    if digest_json(profile) != expected_pipeline or data["pipeline_id"] != expected_pipeline:
        raise ValueError("PIPELINE_INCOMPATIBLE")
    dimensions = data["input_dimensions"]
    if not isinstance(dimensions, list) or len(dimensions) != 2 or not all(type(n) is int and 1 <= n <= MAX_SIDE for n in dimensions):
        raise ValueError("ARTIFACT_DIMENSIONS_INVALID")
    width, height = dimensions
    if width * height > MAX_PIXELS:
        raise ValueError("ARTIFACT_DIMENSIONS_INVALID")
    scale = min(1.0, side / max(width, height))
    detector_dimensions = data["detector_dimensions"]
    if not isinstance(detector_dimensions, list) or not all(type(n) is int for n in detector_dimensions) or detector_dimensions != [max(1, round(width * scale)), max(1, round(height * scale))]:
        raise ValueError("ARTIFACT_DIMENSIONS_INVALID")
    faces = data["faces"]
    if not isinstance(faces, list) or len(faces) > 100:
        raise ValueError("ARTIFACT_FACE_COUNT_INVALID")
    if expected_mode == "reference" and len(faces) != 1:
        raise ValueError("SINGLE_FACE_REFERENCE_REQUIRED")
    previous = None
    for index, face in enumerate(faces):
        if not isinstance(face, dict) or set(face) != {"id", "detection", "embedding"}:
            raise ValueError("ARTIFACT_FACE_INVALID")
        detection, embedding = face["detection"], face["embedding"]
        for vector, length in ((detection, 15), (embedding, 128)):
            if not isinstance(vector, list) or len(vector) != length or not all(type(n) in (float, int) and math.isfinite(n) for n in vector):
                raise ValueError("ARTIFACT_VECTOR_INVALID")
        current = tuple(detection)
        if previous is not None and current <= previous:
            raise ValueError("ARTIFACT_FACE_ORDER_INVALID")
        previous = current
        if detection[2] <= 0 or detection[3] <= 0 or not 0 <= detection[14] <= 1:
            raise ValueError("ARTIFACT_DETECTION_INVALID")
        length_squared = sum(n * n for n in embedding)
        if not math.isfinite(length_squared) or abs(length_squared - 1) > 1e-6:
            raise ValueError("ARTIFACT_NORMALIZATION_INVALID")
        expected_id = digest_json([*expected_scope, data["photo_id"], data["input_sha256"], data["pipeline_id"], index])
        if face["id"] != expected_id:
            raise ValueError("ARTIFACT_FACE_ID_INVALID")
    return data


def load_artifact(path, expected_scope, expected_mode="photo"):
    with Path(path).open("rb") as stream:
        payload = stream.read(MAX_OUTPUT + 1)
    if len(payload) > MAX_OUTPUT:
        raise ValueError("ARTIFACT_TOO_LARGE")
    return validate_artifact(decode(payload), expected_scope, expected_mode)


def create_key(path):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(AESGCM.generate_key(bit_length=256))
        stream.flush()
        os.fsync(stream.fileno())


def read_key(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError("KEY_FILE_REQUIRED")
    if os.name != "nt" and stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ValueError("KEY_PERMISSIONS_UNSAFE")
    with path.open("rb") as stream:
        key = stream.read(33)
    if len(key) != 32:
        raise ValueError("KEY_LENGTH_INVALID")
    return key


def seal(key, payload, aad):
    nonce = os.urandom(12)
    return nonce + AESGCM(key).encrypt(nonce, payload, aad)


def unseal(key, payload, aad):
    try:
        if not isinstance(payload, bytes) or len(payload) < 28:
            raise ValueError("INDEX_AUTHENTICATION_FAILED")
        return AESGCM(key).decrypt(payload[:12], payload[12:], aad)
    except InvalidTag:
        raise ValueError("INDEX_AUTHENTICATION_FAILED") from None


def initialize(database, key):
    database = Path(database)
    descriptor = os.open(database, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    connection = sqlite3.connect(database, isolation_level=None)
    try:
        connection.executescript("""
            BEGIN IMMEDIATE;
            CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), database_id TEXT NOT NULL, verifier BLOB NOT NULL);
            CREATE TABLE scopes (
                kind TEXT NOT NULL, id TEXT NOT NULL, pipeline_id TEXT NOT NULL,
                retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)),
                PRIMARY KEY(kind,id));
            CREATE TABLE photos (
                kind TEXT NOT NULL, scope_id TEXT NOT NULL, photo_id TEXT NOT NULL,
                artifact_digest TEXT NOT NULL, face_count INTEGER NOT NULL,
                ciphertext BLOB, removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1)),
                PRIMARY KEY(kind,scope_id,photo_id),
                FOREIGN KEY(kind,scope_id) REFERENCES scopes(kind,id));
            PRAGMA user_version=1;
        """)
        database_id = str(uuid4())
        verifier = seal(key, b"picfind-local-index-v1", database_id.encode())
        connection.execute("INSERT INTO metadata VALUES(1,?,?)", (database_id, verifier))
        connection.execute("COMMIT")
    except BaseException:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()


class LocalIndex:
    def __init__(self, database, key):
        database = Path(database)
        if database.is_symlink() or not database.is_file():
            raise ValueError("INDEX_FILE_REQUIRED")
        if database.stat().st_size > MAX_DATABASE_BYTES:
            raise ValueError("INDEX_SIZE_EXCEEDED")
        self.connection = sqlite3.connect(database.resolve().as_uri() + "?mode=rw", uri=True, timeout=5, isolation_level=None)
        self.connection.row_factory = sqlite3.Row
        self.key = key
        try:
            if self.connection.execute("PRAGMA user_version").fetchone()[0] != 1:
                raise ValueError("INDEX_VERSION_UNSUPPORTED")
            metadata = self.connection.execute("SELECT database_id,verifier FROM metadata WHERE id=1").fetchone()
            if not metadata:
                raise ValueError("INDEX_AUTHENTICATION_FAILED")
            canonical_uuid(metadata["database_id"])
            if unseal(key, metadata["verifier"], metadata["database_id"].encode()) != b"picfind-local-index-v1":
                raise ValueError("INDEX_AUTHENTICATION_FAILED")
            self.database_id = metadata["database_id"]
            page_size = self.connection.execute("PRAGMA page_size").fetchone()[0]
            page_limit = MAX_DATABASE_BYTES // page_size
            if self.connection.execute(f"PRAGMA max_page_count={page_limit}").fetchone()[0] > page_limit:
                raise ValueError("INDEX_SIZE_EXCEEDED")
            self.connection.execute("PRAGMA foreign_keys=ON")
            self.connection.execute("PRAGMA secure_delete=ON")
            self.connection.execute("PRAGMA synchronous=FULL")
        except BaseException:
            self.connection.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.connection.close()

    @contextmanager
    def transaction(self, write=False):
        self.connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
        try:
            yield
            self.connection.execute("COMMIT")
        except BaseException:
            if self.connection.in_transaction:
                self.connection.execute("ROLLBACK")
            raise

    def aad(self, selected_scope, photo_id, pipeline_id):
        return json.dumps([1, self.database_id, *selected_scope, photo_id, pipeline_id], separators=(",", ":")).encode()

    def scope_row(self, selected_scope):
        scope(*selected_scope)
        return self.connection.execute("SELECT * FROM scopes WHERE kind=? AND id=?", selected_scope).fetchone()

    def import_photo(self, selected_scope, artifact, expected_digest=None):
        scope(*selected_scope)
        validate_artifact(artifact, selected_scope)
        if expected_digest is not None and not hexadecimal(expected_digest):
            raise ValueError("EXPECTED_DIGEST_INVALID")
        payload = json.dumps(artifact, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        if len(payload) > MAX_OUTPUT:
            raise ValueError("ARTIFACT_TOO_LARGE")
        digest = hashlib.sha256(payload).hexdigest()
        photo_id, pipeline_id = artifact["photo_id"], artifact["pipeline_id"]
        with self.transaction(write=True):
            saved_scope = self.scope_row(selected_scope)
            if saved_scope and saved_scope["retired"]:
                raise ValueError("SCOPE_RETIRED")
            if saved_scope and saved_scope["pipeline_id"] != pipeline_id:
                raise ValueError("SCOPE_PIPELINE_INCOMPATIBLE")
            existing = self.connection.execute(f"SELECT {PHOTO_COLUMNS} FROM photos WHERE kind=? AND scope_id=? AND photo_id=?", (*selected_scope, photo_id)).fetchone()
            if existing and existing["removed"]:
                raise ValueError("PHOTO_RETIRED")
            if existing:
                self.decode_photo(selected_scope, saved_scope, existing)
            if existing and existing["artifact_digest"] == digest:
                return {"status": "unchanged", "artifact_digest": digest, "faces": len(artifact["faces"])}
            if (existing and expected_digest != existing["artifact_digest"]) or (not existing and expected_digest is not None):
                raise ValueError("PHOTO_VERSION_CONFLICT")
            counts = self.connection.execute("SELECT COUNT(*) AS photos,COALESCE(SUM(face_count),0) AS faces FROM photos WHERE kind=? AND scope_id=?", selected_scope).fetchone()
            if counts["photos"] + (0 if existing else 1) > MAX_PHOTOS or counts["faces"] - (existing["face_count"] if existing else 0) + len(artifact["faces"]) > MAX_FACES:
                raise ValueError("SCOPE_CAPACITY_EXCEEDED")
            if not saved_scope:
                self.connection.execute("INSERT INTO scopes(kind,id,pipeline_id) VALUES(?,?,?)", (*selected_scope, pipeline_id))
            ciphertext = seal(self.key, payload, self.aad(selected_scope, photo_id, pipeline_id))
            self.connection.execute("""
                INSERT INTO photos(kind,scope_id,photo_id,artifact_digest,face_count,ciphertext) VALUES(?,?,?,?,?,?)
                ON CONFLICT(kind,scope_id,photo_id) DO UPDATE SET artifact_digest=excluded.artifact_digest,face_count=excluded.face_count,ciphertext=excluded.ciphertext
            """, (*selected_scope, photo_id, digest, len(artifact["faces"]), ciphertext))
        return {"status": "stored", "artifact_digest": digest, "faces": len(artifact["faces"])}

    def decode_photo(self, selected_scope, saved_scope, row):
        payload = unseal(self.key, row["ciphertext"], self.aad(selected_scope, row["photo_id"], saved_scope["pipeline_id"]))
        if len(payload) > MAX_OUTPUT or hashlib.sha256(payload).hexdigest() != row["artifact_digest"]:
            raise ValueError("INDEX_ARTIFACT_CORRUPT")
        artifact = validate_artifact(decode(payload), selected_scope)
        if artifact["photo_id"] != row["photo_id"] or len(artifact["faces"]) != row["face_count"]:
            raise ValueError("INDEX_ARTIFACT_CORRUPT")
        return artifact

    @contextmanager
    def snapshot_scope(self, selected_scope):
        with self.transaction():
            saved_scope = self.scope_row(selected_scope)
            if not saved_scope or saved_scope["retired"]:
                raise ValueError("SCOPE_UNAVAILABLE")
            rows = self.connection.execute(f"SELECT {PHOTO_COLUMNS} FROM photos WHERE kind=? AND scope_id=? AND removed=0 ORDER BY photo_id LIMIT ?", (*selected_scope, MAX_PHOTOS + 1)).fetchall()
            if len(rows) > MAX_PHOTOS or sum(row["face_count"] for row in rows) > MAX_FACES:
                raise ValueError("SCOPE_CAPACITY_EXCEEDED")
            photos = [self.decode_photo(selected_scope, saved_scope, row) for row in rows]
            yield {
                "pipeline_id": saved_scope["pipeline_id"],
                "snapshot_sha256": digest_json([list(selected_scope), saved_scope["pipeline_id"], [[row["photo_id"], row["artifact_digest"]] for row in rows]]),
                "photos": photos,
            }

    def read_scope(self, selected_scope):
        with self.snapshot_scope(selected_scope) as snapshot:
            return snapshot["photos"]

    def inspect_photo(self, selected_scope, photo_id, expected_pipeline):
        """Authenticate one cached photo without materializing the full scope."""
        canonical_uuid(photo_id)
        if not hexadecimal(expected_pipeline):
            raise ValueError("PIPELINE_INVALID")
        with self.transaction():
            saved_scope = self.scope_row(selected_scope)
            if not saved_scope:
                return None
            if saved_scope["retired"]:
                raise ValueError("SCOPE_RETIRED")
            if saved_scope["pipeline_id"] != expected_pipeline:
                raise ValueError("SCOPE_PIPELINE_INCOMPATIBLE")
            row = self.connection.execute(
                f"SELECT {PHOTO_COLUMNS} FROM photos WHERE kind=? AND scope_id=? AND photo_id=?",
                (*selected_scope, photo_id),
            ).fetchone()
            if not row:
                return None
            if row["removed"]:
                raise ValueError("PHOTO_RETIRED")
            return {"artifact": self.decode_photo(selected_scope, saved_scope, row),
                    "artifact_digest": row["artifact_digest"]}

    def stats(self, selected_scope):
        with self.transaction():
            saved_scope = self.scope_row(selected_scope)
            if not saved_scope:
                raise ValueError("SCOPE_UNAVAILABLE")
            row = self.connection.execute("SELECT COUNT(*) AS retained,COALESCE(SUM(removed),0) AS removed,COALESCE(SUM(face_count),0) AS faces FROM photos WHERE kind=? AND scope_id=?", selected_scope).fetchone()
            return {"retired": bool(saved_scope["retired"]), "photos": row["retained"] - row["removed"], "removed_photos": row["removed"], "faces": row["faces"], "pipeline_id": saved_scope["pipeline_id"]}

    def erase_photo(self, selected_scope, photo_id):
        canonical_uuid(photo_id)
        with self.transaction(write=True):
            saved_scope = self.scope_row(selected_scope)
            if not saved_scope or saved_scope["retired"]:
                raise ValueError("SCOPE_UNAVAILABLE")
            existing = self.connection.execute("SELECT 1 FROM photos WHERE kind=? AND scope_id=? AND photo_id=?", (*selected_scope, photo_id)).fetchone()
            count = self.connection.execute("SELECT COUNT(*) FROM photos WHERE kind=? AND scope_id=?", selected_scope).fetchone()[0]
            if not existing and count >= MAX_PHOTOS:
                raise ValueError("SCOPE_CAPACITY_EXCEEDED")
            # Retain the UUID even if an extraction import has not arrived yet.
            self.connection.execute("""
                INSERT INTO photos(kind,scope_id,photo_id,artifact_digest,face_count,ciphertext,removed) VALUES(?,?,?,'',0,NULL,1)
                ON CONFLICT(kind,scope_id,photo_id) DO UPDATE SET artifact_digest='',face_count=0,ciphertext=NULL,removed=1
            """, (*selected_scope, photo_id))
        return {"status": "photo-retired"}

    def erase_scope(self, selected_scope):
        scope(*selected_scope)
        with self.transaction(write=True):
            self.connection.execute("INSERT INTO scopes(kind,id,pipeline_id,retired) VALUES(?,?,'',1) ON CONFLICT(kind,id) DO UPDATE SET retired=1", selected_scope)
            self.connection.execute("UPDATE photos SET artifact_digest='',face_count=0,ciphertext=NULL,removed=1 WHERE kind=? AND scope_id=?", selected_scope)
        return {"status": "scope-retired"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["keygen", "init", "import", "stats", "erase-photo", "erase-scope"])
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--database", type=Path)
    parser.add_argument("--scope-kind", choices=["event", "scan"])
    parser.add_argument("--scope-id")
    parser.add_argument("--artifact", type=Path)
    parser.add_argument("--photo-id")
    parser.add_argument("--expected-digest")
    args = parser.parse_args(argv)
    try:
        if args.command == "keygen":
            create_key(args.key_file)
            result = {"status": "key-created"}
        else:
            if args.database is None or args.database.resolve() == args.key_file.resolve():
                raise ValueError("SEPARATE_DATABASE_PATH_REQUIRED")
            key = read_key(args.key_file)
            if args.command == "init":
                initialize(args.database, key)
                result = {"status": "index-created"}
            else:
                selected_scope = scope(args.scope_kind, args.scope_id)
                with LocalIndex(args.database, key) as index:
                    if args.command == "import":
                        if args.artifact is None:
                            raise ValueError("ARTIFACT_PATH_REQUIRED")
                        result = index.import_photo(selected_scope, load_artifact(args.artifact, selected_scope), args.expected_digest)
                    elif args.command == "stats":
                        result = index.stats(selected_scope)
                    elif args.command == "erase-photo":
                        result = index.erase_photo(selected_scope, args.photo_id)
                    else:
                        result = index.erase_scope(selected_scope)
        print(json.dumps(result))
        return 0
    except (ValueError, OSError, sqlite3.Error, TypeError) as error:
        candidate = str(error)
        code = candidate if re.fullmatch(r"[A-Z_]{1,64}", candidate) else "INDEX_OPERATION_FAILED"
        print(f"Local index failed: {code}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
