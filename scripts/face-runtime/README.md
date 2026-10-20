# Local face runtime evaluation

This standalone development tool verifies pinned YuNet/SFace model files and
runs CPU inference on a blank image and a synthetic 112x112 patch. It never
reads user photos, starts a network server, or changes PicFind's provider.
It requires no API key. It is not an accuracy benchmark or a production service.

Use an isolated Python environment:

```powershell
uv venv artifacts/face-eval-venv --python 3.14
uv pip install --python artifacts/face-eval-venv/Scripts/python.exe -r scripts/face-runtime/requirements.txt
artifacts/face-eval-venv/Scripts/python.exe scripts/face-runtime/evaluate.py --models-dir artifacts/face-models --download
```

The initial download is about 37.1 MiB of model data. Subsequent runs omit
`--download` and work offline. Invalid existing files fail verification and are
never silently replaced. Temporary failed downloads are removed. Review the
printed timings, observed RSS and explicit limitations together.

Defaults: two CPU threads, 640x640 blank detector input, ten timed iterations after
one warmup. Limits: four threads, 1920 input side, 100 iterations. Model loading
and native execution are not enclosed in an operating-system memory sandbox.
This CLI is for trusted local developer use, not untrusted request handling.

The synthetic recognizer patch is already the expected aligned input size.
The tool does not measure real-image decoding, face alignment, event indexing,
false matches, missed matches or production throughput. A passing run only
supports proceeding to a consented real-photo evaluation.

Artifact-only tests require Python but no OpenCV or model downloads:

```powershell
artifacts/face-eval-venv/Scripts/python.exe -m unittest discover -s scripts/face-runtime -p "test_*.py"
```

## Provenance

Models are pinned to OpenCV Zoo commit
`47534e27c9851bb1128ccc0102f1145e27f23f98` and verified against the upstream
Git LFS byte sizes/SHA-256 digests recorded in `evaluate.py`.

- [YuNet README and MIT license](https://github.com/opencv/opencv_zoo/tree/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet)
- [SFace README and Apache 2.0 license](https://github.com/opencv/opencv_zoo/tree/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_recognition_sface)
- [Upstream OpenCV inference API](https://docs.opencv.org/4.13.0/d0/dd4/tutorial_dnn_face.html)

Models and environment stay under ignored `artifacts/`. Preserve the upstream
notices when distributing model files. Production use additionally requires
training/data-rights review, consent, scoped persistent indexes, deletion,
calibration and a verified deployment. The existing AWS implementation remains
unchanged until those requirements pass.

## Laptop smoke evidence

2026-10-20, ASUS VivoBook X415JA, i7-1065G7, about 16 GB RAM, Intel Iris Plus.
Python 3.14.0, OpenCV 4.13.0, NumPy 2.4.2, CPU only, two threads, ten iterations:

| Measurement                      | Observed                       |
| -------------------------------- | ------------------------------ |
| Combined verified model bytes    | 38,928,942                     |
| Model initialization             | 272.74 ms                      |
| Median blank 640x640 detection   | 65.05 ms                       |
| Median synthetic patch embedding | 51.74 ms                       |
| Maximum sampled process RSS      | 167,018,496 bytes (159.28 MiB) |

Six artifact safety tests passed. These measurements establish local runtime
compatibility only. They do not establish real event throughput, matching quality,
minimum production RAM or a safe production threshold.

## Offline pair-score calibration

`calibrate.py` accepts an operator-prepared JSON dataset of cosine similarity
scores. It requires only Python's standard library, no models, network, API keys,
GPU or photo uploads. It does not compute scores or enable production matching.
Keep the dataset under ignored `artifacts/`, with pseudonymous identity and sample
IDs. Do not commit participant data or consent documents.

```powershell
artifacts/face-eval-venv/Scripts/python.exe scripts/face-runtime/calibrate.py --scores artifacts/private-evaluation/scores.json --target-fmr 0.001
```

The document shape is:

```json
{
  "schema_version": 1,
  "score_kind": "cosine_similarity",
  "model_sha256": "64 lowercase hexadecimal characters",
  "consent_reference": "local operator consent record reference",
  "pairs": [
    {
      "split": "calibration",
      "left_identity": "pseudonymous-person-a",
      "right_identity": "pseudonymous-person-a",
      "left_sample": "sample-1",
      "right_sample": "sample-2",
      "score": 0.8
    }
  ]
}
```

This abbreviated example is not a valid evaluation dataset. Both `calibration`
and `test` need genuine pairs (same identity) and impostor pairs (different
identities). Identities must be disjoint between splits. Sample IDs must refer to
the same identity throughout, and self-pairs and duplicate unordered sample pairs
are rejected. Use globally unique sample IDs. Bounds: 10 MiB JSON, 100,000 pairs,
128 characters per identifier. Scores must be finite and within [-1, 1].

The candidate is the lowest observed calibration cutoff whose empirical false
match rate meets the requested target. Equal scores are accepted or rejected
together. If no observed cutoff meets the target, the report explicitly selects
reject-all. The held-out test is evaluated once at that fixed cutoff; test scores
never select the threshold. Do not repeatedly tune against the held-out set.
The report includes raw error counts, denominators, empirical rates, identity
counts and exact dataset/model digests, without printing identities, sample IDs
or consent references.

The tool cannot verify consent, label correctness, score provenance, demographic
coverage or representativeness. A zero error count on a small dataset is weak
evidence. Repeated identities produce correlated pairs, so these rates have no
claimed confidence interval and do not represent event-gallery retrieval accuracy.
Review genuine/impostor sample sizes, lighting, pose, camera and group-shot
coverage separately. Production remains gated by consented representative
evaluation, candidate retrieval testing, deletion and operational review.

## Bounded local JPEG extraction

`extract.py` uses the pinned models already prepared by `evaluate.py`. It never
downloads weights or calls a hosted API. Use the existing evaluation environment
and an operator-authorized JPEG. Keep photos and output under private ignored
`artifacts/`. The output directory must already exist and the output file must
be new.

```powershell
artifacts/face-eval-venv/Scripts/python.exe scripts/face-runtime/extract.py --input artifacts/private-evaluation/photo.jpg --output artifacts/private-evaluation/photo-faces.json --models-dir artifacts/face-models --scope-kind event --scope-id 55bda43c-4bde-4e1f-a9b5-16188acc9f00 --photo-id 6087f37f-a5c7-4db8-a905-11764fb343ac --consent-reference evaluation-record-1
```

Use `--mode reference` for a query image. It requires exactly one detected face;
photo mode allows zero faces. Defaults are two CPU threads, 1,280 maximum
detection side, 100 faces and a 30-second child-process deadline. Flags
`--threads`, `--side`, `--max-faces` and `--timeout` allow only bounded values.
Input is limited to 10 MiB, 16 million pixels and 8,192 pixels per side. JPEG
dimensions are checked before native decode. Exif rotation is deliberately
ignored and recorded in the preprocessing profile, so use correctly oriented
JPEGs for evaluation. Limits are resource safeguards, not an OS memory sandbox.

The private JSON contains normalized 128-value embeddings, detector coordinates,
scope/photo identifiers, consent reference, model/input digests and a pipeline
fingerprint. Coordinates refer to the recorded detector dimensions. Scope and
consent labels come from the operator and are not verified authorization. stdout
contains only a completion count and mode. Outputs are sensitive biometric
artifacts. Do not commit, upload or retain them beyond the evaluation purpose.
File mode 0600 is requested on POSIX; Windows uses the parent directory ACL.
Choose an owner-private directory on either system.

The supervisor publishes via an exclusive link, never replacing an existing
output, and removes its temporary file on ordinary failures. Filesystems must
support hard links. Abrupt termination or power loss can leave a temporary file,
so keep the whole output directory private. No face crop or query image is saved.
Publication conflicts return `OUTPUT_ALREADY_EXISTS`; unsupported or denied
hard-link publication returns `OUTPUT_PUBLICATION_FAILED` with a directory hint.
Duplicate detection vectors fail with `DUPLICATE_DETECTION` rather than assigning
ambiguous face IDs. The evaluation operator must inspect and retry such inputs.
The `--internal-worker` entry point is an implementation detail, not a service or
a public API; the supported CLI supplies the process deadline.

Validation on the development laptop: a generated black 640x480 JPEG produced
zero faces in photo mode; reference mode rejected it with `REFERENCE_NO_FACE`
and created no output. Dependency-free tests cover parser limits, worker input,
native boundary stubs, normalization, stable/scoped IDs, publication and failure
handling. This establishes execution behavior only. It provides no real-face
accuracy evidence, does not activate a local provider in PicFind, and does not
remove the need for consented calibration, protected indexing and deletion.

## Encrypted local evaluation index

`local_index.py` stores validated photo extraction artifacts in a scope-bound
SQLite database. It uses the separately pinned `requirements-index.txt` packages;
OpenCV is unnecessary for index operations. Install once in the evaluation
environment:

```powershell
uv pip install --python artifacts/face-eval-venv/Scripts/python.exe --require-hashes --only-binary :all: -r scripts/face-runtime/requirements-index.lock
```

The input version pins live in `requirements-index.txt`; the committed lock
also pins SHA-256 hashes for the resolved packages. CI reinstalls and verifies
those wheels rather than trusting a preinstalled copy. Dependency installation
uses the network, while the tests use synthetic data without model downloads.
An unavailable package registry fails the check; it does not bypass verification.
Regenerate the lock deliberately when reviewing dependency updates:

```powershell
uv pip compile scripts/face-runtime/requirements-index.txt --python artifacts/face-eval-venv/Scripts/python.exe --generate-hashes --output-file scripts/face-runtime/requirements-index.lock
```

The index uses [PyCA authenticated encryption](https://cryptography.io/en/latest/hazmat/primitives/aead/)
with a 256-bit locally generated key and a new random nonce for each write.
Associated data binds the encrypted artifact to its database, scope, photo and
pipeline. The raw 32-byte key stays in a separate file. This is a local storage
key, not an AWS, paid service or hosted API credential. Losing it makes the
encrypted data unreadable. Keep key backups separate from database backups.

For real consented data, use an owner-private directory outside cloud-synced
folders and protect its ACL. This checkout is under OneDrive, so ignored
`artifacts/` is appropriate for generated fixtures, not a guarantee of
local-only storage. The commands below illustrate generated-fixture evaluation;
create their parent directories first. Neither file may already exist:

```powershell
artifacts/face-eval-venv/Scripts/python.exe scripts/face-runtime/local_index.py keygen --key-file artifacts/private-evaluation/index.key
artifacts/face-eval-venv/Scripts/python.exe scripts/face-runtime/local_index.py init --key-file artifacts/private-evaluation/index.key --database artifacts/private-evaluation/index.sqlite
artifacts/face-eval-venv/Scripts/python.exe scripts/face-runtime/local_index.py import --key-file artifacts/private-evaluation/index.key --database artifacts/private-evaluation/index.sqlite --scope-kind event --scope-id 55bda43c-4bde-4e1f-a9b5-16188acc9f00 --artifact artifacts/private-evaluation/photo-faces.json
artifacts/face-eval-venv/Scripts/python.exe scripts/face-runtime/local_index.py stats --key-file artifacts/private-evaluation/index.key --database artifacts/private-evaluation/index.sqlite --scope-kind event --scope-id 55bda43c-4bde-4e1f-a9b5-16188acc9f00
```

The importer requires the artifact's scope to match the explicit scope and
accepts only photo-mode artifacts from the current pinned extractor profile.
Reference images cannot populate the gallery index. One scope uses one pipeline.
The same artifact is an idempotent import. A changed extraction for an existing
photo requires `--expected-digest` with the current `artifact_digest` returned
by its earlier import. A stale digest fails instead of overwriting newer work.
Changed extractor/model profiles require a separate evaluation database.

Each scope allows 5,000 retained photo identifiers, including removed-photo
markers, and 20,000 live face vectors. An artifact is at most 512 KiB. Existing
database files over 2 GiB are rejected on open; this is a development safeguard,
not an operating-system disk quota. SQLite transaction locks serialize writers
across processes with a five-second busy timeout. No external database or API
key is needed.

Scope/photo IDs, pipeline and artifact digests, counts and removal markers remain
plaintext metadata. Face vectors, detection coordinates and consent references
are encrypted before entering SQLite or its journal. Encryption does not cover
the plaintext input artifact, an unlocked process, a compromised OS account or
backups that include both key and database. No values are uploaded or sent to
PicFind by these commands.

```powershell
artifacts/face-eval-venv/Scripts/python.exe scripts/face-runtime/local_index.py erase-photo --key-file artifacts/private-evaluation/index.key --database artifacts/private-evaluation/index.sqlite --scope-kind event --scope-id 55bda43c-4bde-4e1f-a9b5-16188acc9f00 --photo-id 6087f37f-a5c7-4db8-a905-11764fb343ac
artifacts/face-eval-venv/Scripts/python.exe scripts/face-runtime/local_index.py erase-scope --key-file artifacts/private-evaluation/index.key --database artifacts/private-evaluation/index.sqlite --scope-kind event --scope-id 55bda43c-4bde-4e1f-a9b5-16188acc9f00
```

Photo erasure clears ciphertext and retains its identifier, including an
as-yet-unimported photo in an existing scope when capacity permits. Scope erasure
also records a tombstone for an as-yet-uncreated scope. Later imports into those
identifiers are rejected. Rebuilding retired data is an explicit new-database
evaluation, not an automatic retry. These operations remove active index data;
they do not promise forensic erasure from SSDs, snapshots, backups or original
extraction artifacts. Retire and remove those separately under the evaluation
retention plan.

Tests use synthetic vectors and temporary keys to verify restart recovery,
scope isolation, authenticated reads, tamper rejection, transaction rollback,
concurrent imports, capacity and non-resurrection after erasure. The public CLI
prints counts, status and artifact/pipeline digests only. The internal
`read_scope` method is for the next scoped-search implementation; it is not an
HTTP endpoint. Production matching remains disabled pending calibrated search,
authenticated service integration, consent and operational lifecycle review.
