"""Offline pair-score calibration. Never reads photos or changes production settings."""

import argparse
import hashlib
import itertools
import json
import math
from pathlib import Path
import re
import sys

MAX_BYTES = 10 * 1024 * 1024
MAX_PAIRS = 100_000


def identifier(value):
    return isinstance(value, str) and 1 <= len(value) <= 128 and value.isprintable()


def validate(document):
    if (
        not isinstance(document, dict)
        or type(document.get("schema_version")) is not int
        or document["schema_version"] != 1
    ):
        raise ValueError("SCHEMA_VERSION_REQUIRED")
    if document.get("score_kind") != "cosine_similarity":
        raise ValueError("COSINE_SCORE_REQUIRED")
    if not isinstance(document.get("model_sha256"), str) or not re.fullmatch(
        r"[0-9a-f]{64}", document["model_sha256"]
    ):
        raise ValueError("MODEL_CHECKSUM_REQUIRED")
    if not identifier(document.get("consent_reference")):
        raise ValueError("CONSENT_REFERENCE_REQUIRED")
    pairs = document.get("pairs")
    if not isinstance(pairs, list) or not 1 <= len(pairs) <= MAX_PAIRS:
        raise ValueError("PAIR_COUNT_INVALID")
    partitions = {"calibration": [], "test": []}
    identities = {"calibration": set(), "test": set()}
    samples = {}
    seen_pairs = set()
    for pair in pairs:
        if (
            not isinstance(pair, dict)
            or not isinstance(pair.get("split"), str)
            or pair["split"] not in partitions
        ):
            raise ValueError("PAIR_SPLIT_INVALID")
        for key in ("left_identity", "right_identity", "left_sample", "right_sample"):
            if not identifier(pair.get(key)):
                raise ValueError("PAIR_IDENTIFIER_INVALID")
        score = pair.get("score")
        if (
            isinstance(score, bool)
            or not isinstance(score, (int, float))
            or not -1 <= score <= 1
            or not math.isfinite(score)
        ):
            raise ValueError("COSINE_SCORE_INVALID")
        left, right = pair["left_sample"], pair["right_sample"]
        if left == right:
            raise ValueError("SELF_PAIR_REJECTED")
        pair_key = tuple(sorted((left, right)))
        if pair_key in seen_pairs:
            raise ValueError("DUPLICATE_PAIR")
        seen_pairs.add(pair_key)
        split = pair["split"]
        for side in ("left", "right"):
            sample, identity = pair[f"{side}_sample"], pair[f"{side}_identity"]
            if sample in samples and samples[sample] != identity:
                raise ValueError("SAMPLE_IDENTITY_CONFLICT")
            samples[sample] = identity
            identities[split].add(identity)
        partitions[split].append(
            (float(score), pair["left_identity"] == pair["right_identity"])
        )
    if identities["calibration"] & identities["test"]:
        raise ValueError("IDENTITY_SPLIT_LEAKAGE")
    for pairs_in_split in partitions.values():
        labels = {genuine for _, genuine in pairs_in_split}
        if labels != {True, False}:
            raise ValueError("BOTH_PAIR_CLASSES_REQUIRED_IN_EACH_SPLIT")
    return partitions, {key: len(value) for key, value in identities.items()}


def metrics(pairs, threshold):
    genuine = sum(same for _, same in pairs)
    impostor = len(pairs) - genuine
    false_matches = sum(score >= threshold and not same for score, same in pairs)
    false_nonmatches = sum(score < threshold and same for score, same in pairs)
    return {
        "pairs": len(pairs),
        "genuine_pairs": genuine,
        "impostor_pairs": impostor,
        "false_matches": false_matches,
        "false_nonmatches": false_nonmatches,
        "false_match_rate": false_matches / impostor,
        "false_nonmatch_rate": false_nonmatches / genuine,
    }


def choose_threshold(pairs, target):
    """Lowest observed calibration cutoff satisfying empirical FMR; O(n log n)."""
    impostors = sum(not same for _, same in pairs)
    # Greater than the maximum cosine score represents an explicit reject-all choice.
    threshold = math.nextafter(1.0, math.inf)
    false_matches = 0
    ordered = sorted(pairs, key=lambda item: item[0], reverse=True)
    for score, group in itertools.groupby(ordered, key=lambda item: item[0]):
        false_matches += sum(not same for _, same in group)
        if false_matches / impostors > target:
            break
        threshold = score
    return threshold


def report(document, target):
    if (
        isinstance(target, bool)
        or not isinstance(target, (int, float))
        or not 0 <= target <= 1
        or not math.isfinite(target)
    ):
        raise ValueError("TARGET_FMR_INVALID")
    partitions, identities = validate(document)
    threshold = choose_threshold(partitions["calibration"], target)
    return {
        "schema_version": 1,
        "model_sha256": document["model_sha256"],
        "score_kind": "cosine_similarity",
        "comparison": "score >= threshold",
        "candidate_threshold": threshold,
        "reject_all": threshold > 1,
        "target_calibration_fmr": target,
        "threshold_policy": "lowest observed calibration cutoff meeting empirical FMR",
        "calibration": {
            **metrics(partitions["calibration"], threshold),
            "identities": identities["calibration"],
        },
        "held_out_test": {
            **metrics(partitions["test"], threshold),
            "identities": identities["test"],
        },
        "production_enabled": False,
        "limitations": [
            "Consent reference is an operator attestation, not verified authorization.",
            "Scores and identity labels are supplied by the operator, not verified here.",
            "Empirical pair rates do not establish event-level search accuracy.",
            "Pairs sharing identities are correlated; no confidence interval is claimed.",
            "Zero observed false matches does not establish zero real-world risk.",
            "Threshold is a candidate only; representative data and release review are required.",
        ],
    }


def load_report(path, target):
    # Bound the read itself, including a file that grows after a metadata check.
    with path.open("rb") as source:
        raw = source.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("DATASET_TOO_LARGE")
    try:
        document = json.loads(raw)
    except (ValueError, UnicodeError, RecursionError):
        raise ValueError("DATASET_JSON_INVALID") from None
    result = report(document, target)
    result["dataset_sha256"] = hashlib.sha256(raw).hexdigest()
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scores", type=Path, required=True)
    parser.add_argument("--target-fmr", type=float, default=0.001)
    args = parser.parse_args(argv)
    try:
        result = load_report(args.scores, args.target_fmr)
    except (OSError, ValueError) as error:
        # Do not echo file paths, pair identities, score rows, or consent references.
        code = str(error) if isinstance(error, ValueError) else "DATASET_READ_FAILED"
        print(json.dumps({"error": code}), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
