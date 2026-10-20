"""Bounded local JPEG extraction for consented development evaluation only."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from uuid import UUID

from evaluate import MODELS, REVISION, bounded_integer, prepare_model

MAX_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 16_000_000
MAX_SIDE = 8192
MAX_OUTPUT = 512 * 1024


def jpeg_dimensions(data):
    if len(data) > MAX_BYTES:
        raise ValueError("IMAGE_TOO_LARGE")
    if len(data) < 4 or data[:2] != b"\xff\xd8" or data[-2:] != b"\xff\xd9":
        raise ValueError("JPEG_REQUIRED")
    offset, dimensions = 2, None
    while offset < len(data):
        if data[offset] != 0xFF:
            raise ValueError("INVALID_JPEG_HEADER")
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            break
        marker = data[offset]
        offset += 1
        if marker == 0xDA:
            if dimensions is None:
                raise ValueError("JPEG_DIMENSIONS_MISSING")
            return dimensions
        if marker in {0x00, 0xD8, 0xD9} or 0xD0 <= marker <= 0xD7:
            raise ValueError("INVALID_JPEG_HEADER")
        if marker == 0x01:
            continue
        if offset + 2 > len(data):
            break
        size = int.from_bytes(data[offset:offset + 2], "big")
        if size < 2 or offset + size > len(data):
            raise ValueError("INVALID_JPEG_HEADER")
        if marker in {0xC0, 0xC2}:
            if dimensions is not None or size < 8:
                raise ValueError("INVALID_JPEG_HEADER")
            height = int.from_bytes(data[offset + 3:offset + 5], "big")
            width = int.from_bytes(data[offset + 5:offset + 7], "big")
            if min(width, height) < 1 or max(width, height) > MAX_SIDE or width * height > MAX_PIXELS:
                raise ValueError("IMAGE_DIMENSIONS_EXCEEDED")
            dimensions = (width, height)
        elif marker in {0xC1, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
            raise ValueError("UNSUPPORTED_JPEG_ENCODING")
        offset += size
    raise ValueError("JPEG_DIMENSIONS_MISSING")


def checked_uuid(value):
    try:
        return str(UUID(value))
    except (ValueError, AttributeError):
        raise argparse.ArgumentTypeError("A UUID is required.") from None


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--models-dir", type=Path, required=True)
    parser.add_argument("--scope-kind", choices=["event", "scan"], required=True)
    parser.add_argument("--scope-id", type=checked_uuid, required=True)
    parser.add_argument("--photo-id", type=checked_uuid, required=True)
    parser.add_argument("--consent-reference", required=True)
    parser.add_argument("--mode", choices=["photo", "reference"], default="photo")
    parser.add_argument("--threads", type=bounded_integer(1, 4), default=2)
    parser.add_argument("--side", type=bounded_integer(320, 1600), default=1280)
    parser.add_argument("--max-faces", type=bounded_integer(1, 100), default=100)
    parser.add_argument("--timeout", type=bounded_integer(1, 120), default=30)
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", args.consent_reference):
        parser.error("Use a pseudonymous consent reference of 1 to 128 safe characters.")
    return args


def normalized_feature(values):
    if not isinstance(values, list) or len(values) != 128 or not all(
        type(value) in {int, float} and math.isfinite(value) for value in values
    ):
        raise ValueError("INVALID_EMBEDDING")
    length = math.sqrt(sum(value * value for value in values))
    if not math.isfinite(length) or length <= 1e-12:
        raise ValueError("INVALID_EMBEDDING")
    return [value / length for value in values]


def pipeline(side, threads):
    return {
        "provider": "opencv-sface",
        "version": 1,
        "opencv": "4.13.0",
        "model_revision": REVISION,
        "detector_sha256": MODELS["detector"]["sha256"],
        "recognizer_sha256": MODELS["recognizer"]["sha256"],
        "extractor_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "maximum_side": side,
        "threads": threads,
        "resize": "proportional-inter-area-no-upscale",
        "orientation": "stored-jpeg-ignore-exif",
        "alignment": "opencv-sface-alignCrop",
        "normalization": "l2-128-finite",
        "score_threshold": 0.9,
        "nms_threshold": 0.3,
        "top_k": 5000,
        "backend": "opencv-cpu",
    }


def digest_json(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def document(job, image_digest, dimensions, extracted):
    profile = pipeline(job["side"], job["threads"])
    pipeline_id = digest_json(profile)
    faces = []
    detections_seen = set()
    for row in extracted:
        detection = row["detection"]
        if not isinstance(detection, list) or len(detection) != 15 or not all(
            type(value) in {int, float} and math.isfinite(value) for value in detection
        ):
            raise ValueError("INVALID_DETECTION")
        if detection[2] <= 0 or detection[3] <= 0 or not 0 <= detection[14] <= 1:
            raise ValueError("INVALID_DETECTION")
        coordinates = tuple(detection)
        if coordinates in detections_seen:
            raise ValueError("DUPLICATE_DETECTION")
        detections_seen.add(coordinates)
    ordered = sorted(extracted, key=lambda row: tuple(row["detection"]))
    for index, row in enumerate(ordered):
        detection = row["detection"]
        face_id = digest_json([job["scope_kind"], job["scope_id"], job["photo_id"], image_digest, pipeline_id, index])
        faces.append({
            "id": face_id,
            "detection": detection,
            "embedding": normalized_feature(row["embedding"]),
        })
    return {
        "schema_version": 1,
        "scope": {"kind": job["scope_kind"], "id": job["scope_id"]},
        "photo_id": job["photo_id"],
        "consent_reference": job["consent_reference"],
        "mode": job["mode"],
        "input_sha256": image_digest,
        "input_dimensions": list(dimensions),
        "pipeline_id": pipeline_id,
        "pipeline": profile,
        "faces": faces,
        "quality_evaluated": False,
    }


def validate_job(job):
    if not isinstance(job, dict):
        raise ValueError("INVALID_JOB")
    for key in ("input", "models_dir"):
        value = job.get(key)
        if not isinstance(value, str) or not 1 <= len(value) <= 4096 or "\0" in value:
            raise ValueError("INVALID_JOB")
    for key, minimum, maximum in (("threads", 1, 4), ("side", 320, 1600), ("max_faces", 1, 100)):
        value = job.get(key)
        if type(value) is not int or not minimum <= value <= maximum:
            raise ValueError("INVALID_JOB")
    if job.get("scope_kind") not in ("event", "scan") or job.get("mode") not in ("photo", "reference"):
        raise ValueError("INVALID_JOB")
    for key in ("scope_id", "photo_id"):
        value = job.get(key)
        if not isinstance(value, str):
            raise ValueError("INVALID_JOB")
        try:
            if str(UUID(value)) != value:
                raise ValueError("INVALID_JOB")
        except ValueError:
            raise ValueError("INVALID_JOB") from None
    reference = job.get("consent_reference")
    if not isinstance(reference, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", reference):
        raise ValueError("INVALID_JOB")


def check_face_count(count, job):
    if job["mode"] == "reference" and count != 1:
        raise ValueError("REFERENCE_NO_FACE" if count == 0 else "REFERENCE_MULTIPLE_FACES")
    if count > job["max_faces"]:
        raise ValueError("FACE_LIMIT_EXCEEDED")


def extract(job):
    validate_job(job)
    source = Path(job["input"])
    if source.stat().st_size > MAX_BYTES:
        raise ValueError("IMAGE_TOO_LARGE")
    with source.open("rb") as stream:
        data = stream.read(MAX_BYTES + 1)
    width, height = jpeg_dimensions(data)
    paths = {name: prepare_model(Path(job["models_dir"]), spec, False) for name, spec in MODELS.items()}
    # These native decode guards must be set before cv2 is imported.
    os.environ["OPENCV_IO_MAX_IMAGE_PIXELS"] = str(MAX_PIXELS)
    os.environ["OPENCV_IO_MAX_IMAGE_WIDTH"] = str(MAX_SIDE)
    os.environ["OPENCV_IO_MAX_IMAGE_HEIGHT"] = str(MAX_SIDE)
    import cv2 as cv
    import numpy as np

    if cv.__version__ != "4.13.0":
        raise ValueError("UNTESTED_OPENCV_VERSION")
    cv.setNumThreads(job["threads"])
    cv.ocl.setUseOpenCL(False)
    image = cv.imdecode(np.frombuffer(data, dtype=np.uint8), cv.IMREAD_COLOR | cv.IMREAD_IGNORE_ORIENTATION)
    if image is None or image.shape != (height, width, 3):
        raise ValueError("IMAGE_DECODE_MISMATCH")
    scale = min(1.0, job["side"] / max(width, height))
    resized = cv.resize(image, (max(1, round(width * scale)), max(1, round(height * scale))), interpolation=cv.INTER_AREA) if scale < 1 else image
    detector = cv.FaceDetectorYN.create(str(paths["detector"]), "", (resized.shape[1], resized.shape[0]), 0.9, 0.3, 5000, cv.dnn.DNN_BACKEND_OPENCV, cv.dnn.DNN_TARGET_CPU)
    _, detections = detector.detect(resized)
    count = 0 if detections is None else len(detections)
    check_face_count(count, job)
    extracted = []
    if count:
        recognizer = cv.FaceRecognizerSF.create(str(paths["recognizer"]), "", cv.dnn.DNN_BACKEND_OPENCV, cv.dnn.DNN_TARGET_CPU)
        for detection in detections:
            if detection.shape != (15,) or not np.isfinite(detection).all():
                raise ValueError("INVALID_DETECTION")
            crop = recognizer.alignCrop(resized, detection)
            feature = recognizer.feature(crop)
            try:
                if feature.shape != (1, 128):
                    raise ValueError("INVALID_EMBEDDING")
                extracted.append({"detection": [float(value) for value in detection], "embedding": [float(value) for value in feature[0]]})
            finally:
                crop.fill(0)
                feature.fill(0)
    result = document(job, hashlib.sha256(data).hexdigest(), (width, height), extracted)
    result["detector_dimensions"] = [resized.shape[1], resized.shape[0]]
    image.fill(0)
    resized.fill(0)
    return result


def publish(output, result):
    if not output.parent.is_dir():
        raise ValueError("OUTPUT_DIRECTORY_MISSING")
    payload = json.dumps(result, separators=(",", ":"), allow_nan=False).encode()
    if len(payload) > MAX_OUTPUT:
        raise ValueError("OUTPUT_TOO_LARGE")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as stream:
            temporary = Path(stream.name)
            os.chmod(temporary, 0o600)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, output)
        except FileExistsError:
            raise ValueError("OUTPUT_ALREADY_EXISTS") from None
        except OSError:
            raise ValueError("OUTPUT_PUBLICATION_FAILED") from None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def run(args):
    if args.output.exists():
        raise ValueError("OUTPUT_ALREADY_EXISTS")
    if not args.output.parent.is_dir():
        raise ValueError("OUTPUT_DIRECTORY_MISSING")
    job = {key: str(value) if isinstance(value, Path) else value for key, value in vars(args).items() if key not in {"output", "timeout"}}
    try:
        completed = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--internal-worker"],
            input=json.dumps(job), capture_output=True, text=True,
            timeout=args.timeout, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        raise ValueError("EXTRACTION_DEADLINE") from None
    if len(completed.stdout.encode()) > MAX_OUTPUT:
        raise ValueError("OUTPUT_TOO_LARGE")
    try:
        result = json.loads(completed.stdout)
    except (ValueError, TypeError):
        raise ValueError("WORKER_FAILED") from None
    if completed.returncode != 0:
        code = result.get("error", "") if isinstance(result, dict) else ""
        raise ValueError(code if re.fullmatch(r"[A-Z_]{1,64}", code) else "WORKER_FAILED")
    if not isinstance(result, dict) or result.get("schema_version") != 1 or not isinstance(result.get("faces"), list):
        raise ValueError("WORKER_RESPONSE_INVALID")
    publish(args.output, result)
    return {"status": "complete", "faces": len(result["faces"]), "mode": args.mode, "quality_evaluated": False}


def main():
    if sys.argv[1:] == ["--internal-worker"]:
        try:
            job = json.loads(sys.stdin.read(16 * 1024))
            print(json.dumps(extract(job), separators=(",", ":"), allow_nan=False))
            return 0
        except Exception as error:
            candidate = str(error).split(":")[0]
            code = candidate if re.fullmatch(r"[A-Z_]{1,64}", candidate) else "EXTRACTION_FAILED"
            print(json.dumps({"error": code}))
            return 1
    try:
        print(json.dumps(run(arguments())))
        return 0
    except (ValueError, OSError) as error:
        candidate = str(error).split(":")[0]
        code = candidate if re.fullmatch(r"[A-Z_]{1,64}", candidate) else "EXTRACTION_FAILED"
        print(f"Extraction failed: {code}", file=sys.stderr)
        if code == "OUTPUT_PUBLICATION_FAILED":
            print("Use a private writable output directory on a filesystem that supports hard links.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
