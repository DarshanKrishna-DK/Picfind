"""Calibrated, scope-bound local face search for evaluation, never production routing."""

import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
import sqlite3
import sys

from calibrate import load_report
from evaluate import MODELS, bounded_integer
from extract import publish
from local_index import LocalIndex, load_artifact, read_key, scope, validate_artifact


def calibration(path, pipeline_id, target_fmr, allow_small=False):
    if type(allow_small) is not bool:
        raise ValueError("EVALUATION_MODE_INVALID")
    result = load_report(Path(path), target_fmr)
    if result.get("pipeline_id") != pipeline_id:
        raise ValueError("CALIBRATION_PIPELINE_MISMATCH")
    if result["model_sha256"] != MODELS["recognizer"]["sha256"]:
        raise ValueError("CALIBRATION_MODEL_MISMATCH")
    for name in ("calibration", "held_out_test"):
        partition = result[name]
        if not allow_small and (partition["genuine_pairs"] < 100 or partition["impostor_pairs"] < 1000):
            raise ValueError("CALIBRATION_SAMPLE_FLOOR")
    if result["held_out_test"]["false_match_rate"] > target_fmr:
        raise ValueError("HELD_OUT_FALSE_MATCH_TARGET_EXCEEDED")
    return result


def cosine(left, right):
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    denominator = math.sqrt(sum(x * x for x in left) * sum(x * x for x in right))
    result = dot / denominator
    if not math.isfinite(result):
        raise ValueError("SEARCH_SCORE_INVALID")
    return max(-1.0, min(1.0, result))


def search(index, selected_scope, reference, scores_path, target_fmr=0.001, limit=100, allow_small=False):
    if type(limit) is not int or not 1 <= limit <= 500:
        raise ValueError("RESULT_LIMIT_INVALID")
    validate_artifact(reference, selected_scope, "reference")
    evaluation = calibration(scores_path, reference["pipeline_id"], target_fmr, allow_small)
    with index.snapshot_scope(selected_scope) as snapshot:
        if snapshot["pipeline_id"] != reference["pipeline_id"]:
            raise ValueError("QUERY_PIPELINE_MISMATCH")
        query_vector = reference["faces"][0]["embedding"]
        matches = []
        if not evaluation["reject_all"]:
            for photo in snapshot["photos"]:
                if not photo["faces"]:
                    continue
                best = max(cosine(query_vector, face["embedding"]) for face in photo["faces"])
                if best >= evaluation["candidate_threshold"]:
                    matches.append({"photo_id": photo["photo_id"], "cosine_similarity": best})
        matches.sort(key=lambda row: (-row["cosine_similarity"], row["photo_id"]))
        result = {
            "schema_version": 1,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "scope": {"kind": selected_scope[0], "id": selected_scope[1]},
            "pipeline_id": snapshot["pipeline_id"],
            "snapshot_sha256": snapshot["snapshot_sha256"],
            "reference_input_sha256": reference["input_sha256"],
            "matches": matches[:limit],
            "qualifying_photos": len(matches),
            "truncated": len(matches) > limit,
            "photos_examined": len(snapshot["photos"]),
            "faces_examined": sum(len(photo["faces"]) for photo in snapshot["photos"]),
            "evaluation": evaluation,
            "small_evaluation": bool(allow_small),
            "production_enabled": False,
        }
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--scope-kind", choices=["event", "scan"], required=True)
    parser.add_argument("--scope-id", required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--scores", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--target-fmr", type=float, default=0.001)
    parser.add_argument("--limit", type=bounded_integer(1, 500), default=100)
    parser.add_argument("--allow-small-evaluation", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.output.exists():
            raise ValueError("OUTPUT_ALREADY_EXISTS")
        if not args.output.parent.is_dir():
            raise ValueError("OUTPUT_DIRECTORY_MISSING")
        selected_scope = scope(args.scope_kind, args.scope_id)
        reference = load_artifact(args.reference, selected_scope, "reference")
        with LocalIndex(args.database, read_key(args.key_file)) as index:
            result = search(index, selected_scope, reference, args.scores, args.target_fmr, args.limit, args.allow_small_evaluation)
        publish(args.output, result)
        print(json.dumps({
            "status": "complete", "matches": len(result["matches"]),
            "truncated": result["truncated"], "small_evaluation": result["small_evaluation"],
            "production_enabled": False,
        }))
        return 0
    except (ValueError, OSError, sqlite3.Error, TypeError) as error:
        candidate = str(error)
        code = candidate if re.fullmatch(r"[A-Z_]{1,64}", candidate) else "SEARCH_FAILED"
        print(f"Local search failed: {code}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
