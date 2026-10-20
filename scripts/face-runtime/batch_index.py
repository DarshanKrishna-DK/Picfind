"""Bounded, resumable local JPEG indexing for operator-authorized evaluation."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time

import extract
from evaluate import bounded_integer
from local_index import LocalIndex, canonical_uuid, decode, hexadecimal, read_key, scope, validate_artifact

MAX_MANIFEST = 1024 * 1024
MAX_BATCH_PHOTOS = 100


def safe_source(root, relative):
    if (not isinstance(relative, str) or not 1 <= len(relative) <= 1024 or
            any(ord(character) < 32 for character in relative) or
            "\\" in relative or ":" in relative or
            any(part in ("", ".", "..") for part in relative.split("/"))):
        raise ValueError("SOURCE_PATH_INVALID")
    current = root
    for part in relative.split("/"):
        current = current / part
        if current.is_symlink() or current.is_junction():
            raise ValueError("SOURCE_LINK_FORBIDDEN")
    resolved = current.resolve(strict=True)
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise ValueError("SOURCE_PATH_INVALID")
    if resolved.suffix.lower() not in (".jpg", ".jpeg"):
        raise ValueError("JPEG_REQUIRED")
    return resolved


def manifest(path, root, selected_scope, pipeline_id):
    with Path(path).open("rb") as stream:
        raw = stream.read(MAX_MANIFEST + 1)
    if len(raw) > MAX_MANIFEST:
        raise ValueError("MANIFEST_TOO_LARGE")
    data = decode(raw)
    if (not isinstance(data, dict) or
            set(data) != {"schema_version", "scope", "pipeline_id", "consent_reference", "photos"} or
            type(data["schema_version"]) is not int or data["schema_version"] != 1):
        raise ValueError("MANIFEST_SCHEMA_INVALID")
    if data["scope"] != {"kind": selected_scope[0], "id": selected_scope[1]}:
        raise ValueError("MANIFEST_SCOPE_MISMATCH")
    if data["pipeline_id"] != pipeline_id:
        raise ValueError("MANIFEST_PIPELINE_MISMATCH")
    consent = data["consent_reference"]
    if not isinstance(consent, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", consent):
        raise ValueError("CONSENT_REFERENCE_REQUIRED")
    photos = data["photos"]
    if not isinstance(photos, list) or not 1 <= len(photos) <= MAX_BATCH_PHOTOS:
        raise ValueError("BATCH_PHOTO_LIMIT")
    identifiers, paths = set(), set()
    for photo in photos:
        if (not isinstance(photo, dict) or not {"photo_id", "input", "sha256"}.issubset(photo) or
                set(photo) - {"photo_id", "input", "sha256", "expected_digest"}):
            raise ValueError("MANIFEST_PHOTO_INVALID")
        canonical_uuid(photo["photo_id"])
        if not hexadecimal(photo["sha256"]) or ("expected_digest" in photo and not hexadecimal(photo["expected_digest"])):
            raise ValueError("MANIFEST_DIGEST_INVALID")
        source = safe_source(root, photo["input"])
        normalized = os.path.normcase(str(source))
        if photo["photo_id"] in identifiers or normalized in paths:
            raise ValueError("MANIFEST_DUPLICATE_PHOTO")
        identifiers.add(photo["photo_id"])
        paths.add(normalized)
    return data, hashlib.sha256(raw).hexdigest()


def source_digest(path):
    with path.open("rb") as stream:
        raw = stream.read(extract.MAX_BYTES + 1)
    if len(raw) > extract.MAX_BYTES:
        raise ValueError("IMAGE_TOO_LARGE")
    return hashlib.sha256(raw).hexdigest()


def worker(job, timeout):
    """Use the unchanged extractor protocol so existing pipeline IDs stay valid."""
    try:
        completed = subprocess.run(
            [sys.executable, str(Path(extract.__file__).resolve()), "--internal-worker"],
            input=json.dumps(job), capture_output=True, text=True, timeout=timeout, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        raise ValueError("EXTRACTION_DEADLINE") from None
    if len(completed.stdout.encode()) > extract.MAX_OUTPUT:
        raise ValueError("OUTPUT_TOO_LARGE")
    result = decode(completed.stdout)
    if completed.returncode != 0:
        code = result.get("error", "") if isinstance(result, dict) else ""
        raise ValueError(code if isinstance(code, str) and re.fullmatch(r"[A-Z_]{1,64}", code) else "WORKER_FAILED")
    return result


def error_code(error):
    candidate = str(error)
    return candidate if re.fullmatch(r"[A-Z_]{1,64}", candidate) else "BATCH_OPERATION_FAILED"


def run(args):
    for name, minimum, maximum in (("threads", 1, 4), ("side", 320, 1600),
                                   ("max_faces", 1, 100), ("timeout", 1, 120), ("deadline", 1, 3600)):
        value = getattr(args, name)
        if type(value) is not int or not minimum <= value <= maximum:
            raise ValueError("BATCH_OPTIONS_INVALID")
    if args.output.exists():
        raise ValueError("OUTPUT_ALREADY_EXISTS")
    if not args.output.parent.is_dir():
        raise ValueError("OUTPUT_DIRECTORY_MISSING")
    if args.root.is_symlink() or args.root.is_junction():
        raise ValueError("SOURCE_LINK_FORBIDDEN")
    root = args.root.resolve(strict=True)
    if not root.is_dir() or str(root).startswith(("\\\\", "//")):
        raise ValueError("LOCAL_SOURCE_DIRECTORY_REQUIRED")
    selected_scope = scope(args.scope_kind, args.scope_id)
    pipeline_id = extract.digest_json(extract.pipeline(args.side, args.threads))
    data, manifest_digest = manifest(args.manifest, root, selected_scope, pipeline_id)
    if args.database.resolve() == args.key_file.resolve():
        raise ValueError("SEPARATE_DATABASE_PATH_REQUIRED")
    started, results = time.monotonic(), []
    with LocalIndex(args.database, read_key(args.key_file)) as index:
        for photo in data["photos"]:
            try:
                remaining = args.deadline - (time.monotonic() - started)
                if remaining < 1:
                    raise ValueError("BATCH_DEADLINE")
                source = safe_source(root, photo["input"])
                if source_digest(source) != photo["sha256"]:
                    raise ValueError("SOURCE_DIGEST_MISMATCH")
                cached = index.inspect_photo(selected_scope, photo["photo_id"], pipeline_id)
                if (cached and cached["artifact"]["input_sha256"] == photo["sha256"] and
                        cached["artifact"]["consent_reference"] == data["consent_reference"]):
                    artifact = cached["artifact"]
                else:
                    if cached and photo.get("expected_digest") != cached["artifact_digest"]:
                        raise ValueError("PHOTO_VERSION_CONFLICT")
                    if not cached and "expected_digest" in photo:
                        raise ValueError("PHOTO_VERSION_CONFLICT")
                    remaining = args.deadline - (time.monotonic() - started)
                    if remaining < 1:
                        raise ValueError("BATCH_DEADLINE")
                    job = {
                        "input": str(safe_source(root, photo["input"])), "models_dir": str(args.models_dir),
                        "scope_kind": selected_scope[0], "scope_id": selected_scope[1],
                        "photo_id": photo["photo_id"], "consent_reference": data["consent_reference"],
                        "mode": "photo", "threads": args.threads, "side": args.side, "max_faces": args.max_faces,
                    }
                    artifact = worker(job, min(args.timeout, math.floor(remaining)))
                validate_artifact(artifact, selected_scope)
                if (artifact["photo_id"] != photo["photo_id"] or artifact["input_sha256"] != photo["sha256"] or
                        artifact["pipeline_id"] != pipeline_id or artifact["consent_reference"] != data["consent_reference"]):
                    raise ValueError("WORKER_PROVENANCE_MISMATCH")
                if len(artifact["faces"]) > args.max_faces:
                    raise ValueError("FACE_LIMIT_EXCEEDED")
                if time.monotonic() - started >= args.deadline:
                    raise ValueError("BATCH_DEADLINE")
                # Recheck tombstones and concurrent changes even when native extraction was skipped.
                outcome = index.import_photo(selected_scope, artifact, photo.get("expected_digest"))
                results.append({"photo_id": photo["photo_id"], **outcome})
            except (ValueError, OSError, sqlite3.Error, TypeError) as error:
                results.append({"photo_id": photo["photo_id"], "status": "failed", "error": error_code(error)})
    counts = {name: sum(item["status"] == name for item in results) for name in ("stored", "unchanged", "failed")}
    report = {
        "schema_version": 1, "created_at": datetime.now(timezone.utc).isoformat(),
        "scope": data["scope"], "pipeline_id": pipeline_id, "manifest_sha256": manifest_digest,
        "status": "partial" if counts["failed"] else "complete", "counts": counts, "results": results,
        "quality_evaluated": False, "production_enabled": False,
    }
    extract.publish(args.output, report)
    return {name: report[name] for name in ("status", "counts", "quality_evaluated", "production_enabled")}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("manifest", "root", "models-dir", "database", "key-file", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--scope-kind", choices=["event", "scan"], required=True)
    parser.add_argument("--scope-id", required=True)
    parser.add_argument("--threads", type=bounded_integer(1, 4), default=2)
    parser.add_argument("--side", type=bounded_integer(320, 1600), default=1280)
    parser.add_argument("--max-faces", type=bounded_integer(1, 100), default=100)
    parser.add_argument("--timeout", type=bounded_integer(1, 120), default=30)
    parser.add_argument("--deadline", type=bounded_integer(1, 3600), default=600)
    args = parser.parse_args(argv)
    try:
        result = run(args)
        print(json.dumps(result))
        return 1 if result["counts"]["failed"] else 0
    except (ValueError, OSError, sqlite3.Error, TypeError) as error:
        print(f"Batch indexing failed: {error_code(error)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
