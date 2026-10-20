"""Explicit, CPU-only synthetic runtime evaluation. Does not process user photos."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import statistics
import sys
import tempfile
import time
from urllib.request import urlopen


REVISION = "47534e27c9851bb1128ccc0102f1145e27f23f98"
MODELS = {
    "detector": {
        "directory": "face_detection_yunet",
        "filename": "face_detection_yunet_2023mar.onnx",
        "sha256": "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
        "bytes": 232589,
        "license": "MIT",
    },
    "recognizer": {
        "directory": "face_recognition_sface",
        "filename": "face_recognition_sface_2021dec.onnx",
        "sha256": "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
        "bytes": 38696353,
        "license": "Apache-2.0",
    },
}


def verify(path, spec):
    if path.stat().st_size != spec["bytes"]:
        raise ValueError(f"MODEL_SIZE_MISMATCH: {path.name}")
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != spec["sha256"]:
        raise ValueError(f"MODEL_CHECKSUM_MISMATCH: {path.name}")


def prepare_model(directory, spec, allow_download):
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / spec["filename"]
    if destination.exists():
        verify(destination, spec)
        return destination
    if not allow_download:
        raise ValueError("MODEL_MISSING: rerun with --download to fetch pinned models.")
    url = (
        f"https://media.githubusercontent.com/media/opencv/opencv_zoo/{REVISION}/"
        f"models/{spec['directory']}/{spec['filename']}"
    )
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=directory, delete=False) as output:
            temporary = Path(output.name)
            with urlopen(url, timeout=30) as response:
                total = 0
                started = time.monotonic()
                while chunk := response.read(64 * 1024):
                    total += len(chunk)
                    if total > spec["bytes"]:
                        raise ValueError("MODEL_DOWNLOAD_TOO_LARGE")
                    if time.monotonic() - started > 120:
                        raise ValueError("MODEL_DOWNLOAD_DEADLINE")
                    output.write(chunk)
        verify(temporary, spec)
        # An exclusive link never replaces a model created by another process.
        try:
            os.link(temporary, destination)
        except FileExistsError:
            verify(destination, spec)
        return destination
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def bounded_integer(minimum, maximum):
    def parse(value):
        number = int(value)
        if not minimum <= number <= maximum:
            raise argparse.ArgumentTypeError(
                f"Expected a value between {minimum} and {maximum}."
            )
        return number
    return parse


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models-dir", type=Path, required=True)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--iterations", type=bounded_integer(1, 100), default=10)
    parser.add_argument("--threads", type=bounded_integer(1, 4), default=2)
    parser.add_argument("--side", type=bounded_integer(320, 1920), default=640)
    return parser.parse_args(argv)


def evaluate(args):
    # No network operation occurs unless the user supplied --download.
    paths = {
        name: prepare_model(args.models_dir, spec, args.download)
        for name, spec in MODELS.items()
    }
    import cv2 as cv
    import numpy as np
    import psutil

    if cv.__version__ != "4.13.0":
        raise ValueError("UNTESTED_OPENCV_VERSION: install the pinned requirements.")
    cv.setNumThreads(args.threads)
    cv.ocl.setUseOpenCL(False)
    process = psutil.Process()
    rss_before = process.memory_info().rss
    started = time.perf_counter()
    detector = cv.FaceDetectorYN.create(
        str(paths["detector"]), "", (args.side, args.side), 0.9, 0.3, 5000,
        cv.dnn.DNN_BACKEND_OPENCV, cv.dnn.DNN_TARGET_CPU,
    )
    recognizer = cv.FaceRecognizerSF.create(
        str(paths["recognizer"]), "",
        cv.dnn.DNN_BACKEND_OPENCV, cv.dnn.DNN_TARGET_CPU,
    )
    load_ms = (time.perf_counter() - started) * 1000
    blank = np.zeros((args.side, args.side, 3), dtype=np.uint8)
    patch = np.random.default_rng(0).integers(0, 256, (112, 112, 3), dtype=np.uint8)
    detection_times, embedding_times = [], []
    max_observed_rss = rss_before
    # The first pass warms the models and is excluded from timing samples.
    for iteration in range(args.iterations + 1):
        started = time.perf_counter()
        _, faces = detector.detect(blank)
        detection_ms = (time.perf_counter() - started) * 1000
        if faces is not None and len(faces):
            raise ValueError("BLANK_INPUT_UNEXPECTED_FACE")
        started = time.perf_counter()
        embedding = recognizer.feature(patch)
        embedding_ms = (time.perf_counter() - started) * 1000
        if embedding.shape != (1, 128) or not np.isfinite(embedding).all():
            raise ValueError("INVALID_EMBEDDING_OUTPUT")
        max_observed_rss = max(max_observed_rss, process.memory_info().rss)
        if iteration:
            detection_times.append(detection_ms)
            embedding_times.append(embedding_ms)
    return {
        "kind": "synthetic-runtime-smoke",
        "quality_evaluated": False,
        "production_provider_changed": False,
        "opencv": cv.__version__,
        "numpy": np.__version__,
        "python": sys.version.split()[0],
        "model_revision": REVISION,
        "models": MODELS,
        "model_bytes": sum(spec["bytes"] for spec in MODELS.values()),
        "threads": args.threads,
        "detector_input": [args.side, args.side],
        "recognizer_input": [112, 112],
        "iterations_after_warmup": args.iterations,
        "load_ms": round(load_ms, 2),
        "blank_detection_median_ms": round(statistics.median(detection_times), 2),
        "synthetic_embedding_median_ms": round(statistics.median(embedding_times), 2),
        "max_observed_process_rss_bytes": max_observed_rss,
        "rss_before_model_load_bytes": rss_before,
        "limits": [
            "RSS is sampled between operations, not a guaranteed peak.",
            "Synthetic inputs do not measure identity accuracy or real image throughput.",
            "Image decode, alignment, storage, network and concurrency are not measured.",
            "This is not a production inference service or replacement provider.",
        ],
    }


if __name__ == "__main__":
    try:
        print(json.dumps(evaluate(arguments()), indent=2))
    except (ValueError, OSError) as error:
        print(f"Evaluation failed: {error}", file=sys.stderr)
        sys.exit(1)
