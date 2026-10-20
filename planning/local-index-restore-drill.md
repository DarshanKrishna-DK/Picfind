# Authenticated local index backups and isolated restore drills

## Outcome and scope

The optional local face evaluation index needs recoverability evidence before
it can be considered for production use. Add a trusted local CLI that creates
an authenticated backup bundle and verifies it through an isolated temporary
restore. The drill reports integrity and aggregate counts, then removes its
temporary restored database. It never activates a provider or returns vectors.

This is not an AWS migration, an accuracy benchmark, a hosted backup service
or a complete production disaster-recovery policy. The existing production
provider remains unchanged. No API key or model download is needed; use the
existing local encryption key and pinned cryptography environment.

## Format and integrity

Create a consistent SQLite snapshot through the standard backup API using a
read-only source connection. Authenticate and validate the private snapshot
before packaging it. Use one uncompressed ZIP containing only `index.sqlite`
and `manifest.json`. The manifest includes format version, snapshot digest and
size, creation time and aggregate verified counts. Sign it with HMAC-SHA256
using a domain-separated key derived from the existing local key.

Do not include the key, source image files, plaintext extraction artifacts or
reference images. Existing face ciphertext remains encrypted. SQLite scope
identifiers and other index metadata remain plaintext inside the bundle, as
they do in the source index. The bundle therefore needs a private directory.

Publication uses a new destination only, with exclusive publication and no
replacement. Reject source/output aliases, symlinks and unsupported publication
filesystems. Keep temporary files private and clean them on ordinary failure.
An interrupted process can leave private temporary data that requires cleanup.

## Restore drill

Read a bounded manifest, authenticate it, require exactly the two expected
uncompressed archive entries, and stream the database into a private temporary
directory. Reject extra/duplicate paths, traversal, compressed payloads,
oversized entries, truncated archives, mismatched digests and wrong keys.

Open the temporary index read-only. Check SQLite integrity and foreign keys,
schema/version, authenticated database identity, scope IDs and pipelines,
record limits, every live encrypted artifact, and removal/retirement invariants.
Do not materialize a complete gallery of vectors in memory. Preserve and
verify tombstones from the snapshot rather than silently rebuilding them.
The signed manifest counts must agree with the restored snapshot.

An old backup cannot reveal revocations that occurred after it was taken.
For that reason this command is a verification-only drill and does not publish
a restored active database. A production restore would additionally require
current retention and consent reconciliation before activation.

## Resource and privacy boundaries

Default to a 256 MiB database budget, configurable up to the existing 2 GiB
ceiling. Account for the temporary database plus uncompressed bundle and
require adequate free space before work. Stream archive bytes and authenticate
one artifact at a time. Apply an operation deadline between chunks/records
and SQLite progress callbacks; it is not an operating-system hard I/O limit.
Bound scope enumeration as well as per-scope photo/vector counts.

Use an owner-private, non-synced directory for real data. This OneDrive checkout
is suitable only for generated fixtures. Windows directory ACLs remain the
operator's responsibility. Stdout and reports contain aggregate status only,
without paths, key values, consent references, face vectors or photo IDs.

## Verification

Test multi-scope recovery, live and retired photos/scopes, wrong keys, altered
bytes/manifests, duplicate/traversal entries, size/deadline boundaries, existing
output preservation, concurrent committed writes, source immutability and
temporary cleanup. Run all dependency-free/local-index tests using the pinned
environment and a synthetic restore drill. Keep the PR below 5,000 changed
lines and use Shipwright review plus final-head CI before merging.

Primary API references:
[SQLite backup](https://docs.python.org/3/library/sqlite3.html#sqlite3.Connection.backup)
and [ZIP archive handling](https://docs.python.org/3/library/zipfile.html).

## Implementation and local evidence

The implementation uses read-only source and validation connections, exclusive
same-filesystem hard-link publication, a bounded ZIP directory preflight and
HMAC authentication before temporary restore. It rejects compressed entries,
unexpected schema objects and invalid tombstones. Source WAL commits are
included without changing source database or WAL bytes.

The Windows test run caught a read-only file descriptor that could not be
synchronized with fsync. Opening the completed private bundle in update mode
before synchronization fixes the Windows behavior. A first WAL fixture closed
its active writer too early; the corrected fixture holds the writer open while
checking both source files before and after snapshot creation.

All fixtures use generated vectors and temporary indexes. No real participant
data, model download, recognition-quality evaluation or production restore was
performed. Windows symbolic-link cases require account privileges unavailable
locally; the Linux CI run covers those cases.

Final local validation: 118 Python tests passed with two Windows symbolic-link
skips, including independent CLI snapshot and drill processes. `npm run check`
passed 145 test files and 2,363 tests, lint, type checking and both builds.
Existing nonfatal bundle-size and annotation warnings remain.
