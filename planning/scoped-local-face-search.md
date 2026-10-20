# Calibrated local evaluation search

The local search CLI accepts an encrypted index, a single-face reference artifact,
an explicit event/scan scope and an operator-prepared calibration dataset. It
recomputes the candidate cutoff from the calibration partition, then evaluates
the unchanged cutoff on the identity-disjoint held-out partition. The dataset
must name the exact pipeline and recognizer checksum used by the query/index.
There is no default similarity cutoff and no conversion from AWS percentages.

The normal sample floor is 100 genuine and 1,000 impostor pairs in each partition.
An explicit small-evaluation option permits the tiny synthetic fixtures used by
tests. Neither floor establishes representative data, label correctness, consent,
statistical independence or production quality. Held-out false-match rates above
the requested target block search. Reject-all calibration returns no matches.
Production remains disabled even when these evaluation checks pass.

Search reads and authenticates one scope within a SQLite snapshot, rejects
retired scopes and incompatible pipelines, and never searches a global directory.
It compares normalized vectors by cosine similarity, applies the candidate cutoff
inclusively, takes the strongest qualifying face per photo, and returns a bounded
stable ranking. Results identify the exact snapshot and calibration dataset.
Deletion committed before the snapshot excludes those rows; concurrent writers
wait for the read transaction. The saved result is a historical evaluation
artifact, not a live access grant or a promise of present photo availability.

The exclusive private output contains photo UUIDs/scores and evaluation metadata,
not vectors, crops, identity labels or consent references. stdout reports counts
only. Reference and calibration source files remain operator-controlled and need
their own retention cleanup. All acceptance tests use synthetic vectors; no real
recognition accuracy, provider migration or production service is claimed.
