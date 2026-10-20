# Bounded local batch indexing

The local evaluation tools currently extract and import one photo at a time.
Add a trusted local CLI that indexes an explicit manifest of up to 100 JPEGs
through the existing pinned extraction worker and encrypted index.

## Inputs and authority

The manifest records schema version, the exact selected event/scan scope,
pipeline ID, pseudonymous consent reference and entries containing photo UUID,
relative input path, source SHA-256 and optional expected index artifact digest.
The command also requires an explicit source root, selected scope, model
directory, database, local key file and new report path.

Validate the entire manifest shape, unique IDs/paths and containment within the
source root before processing. No recursive discovery, symbolic-link escape,
UNC paths or implicit source deletion is allowed. Mapped network drives are not
supported. Paths and consent are
operator assertions, not verified participant authorization. Real data must use
a private, non-synced workspace, not this repository under OneDrive.

## State and resource bounds

Each photo independently becomes stored, unchanged or failed. Read and hash at
most the existing 10 MiB image limit. Reuse the existing native worker in a
supervised subprocess, one photo at a time, with its pixel/face/thread limits.
Keep returned vectors in memory until encrypted import; do not write plaintext
extraction files. Apply per-photo worker timeouts and a processing deadline
between photos and before imports. Filesystem/SQLite calls and report publication
are not hard real-time or OS memory guarantees.
Apply SQLite page limits when opening the index so a batch cannot grow the main
database beyond its existing 2 GiB ceiling. A full database rolls back the
individual import; source data and earlier committed photos remain intact.

Resume authenticates only the requested indexed photo. If source hash, pipeline
and consent reference agree, reimport the authenticated artifact idempotently
without repeating native inference. The write transaction still checks
tombstones and concurrent changes. Replacements require the explicit expected
artifact digest. Do not silently rewrite an incompatible pipeline.

Successful photo commits survive interruption or another photo failing. A retry
of the same manifest skips completed work safely. A partial report must identify
failure codes and never claim a complete index. Report publication is exclusive;
if publication fails after commits, the database remains the source of truth and
the operator retries with a new report destination.

## Output and acceptance

The private report includes photo IDs, outcomes, face counts, artifact digests,
manifest/pipeline provenance and completion counts. It excludes source paths,
filenames, consent values and vectors. stdout includes only aggregate status.
Production remains disabled. This does not activate an HTTP service, migrate
AWS collections or establish recognition accuracy.

Test structural validation, path containment, hash mismatch, resume after
restart, replacement conflicts, corrupt cached entries, scope/photo retirement,
worker failures/deadlines, partial progress and report races. Run a separate
native smoke using generated blank JPEGs and existing pinned models.
