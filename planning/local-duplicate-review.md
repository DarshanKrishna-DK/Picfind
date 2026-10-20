# Local exact-duplicate review

Roadmap 81 gives photographers an explicit review before importing originals.
The existing saved upload queue silently collapses identical input bytes for one
destination. This separate workspace explains duplicate groups, lets the owner
choose which named copies to retain, and exports a portable decision report.

## Contract and state

Route `/app/duplicates` is in the signed-in studio. The review is local to the
current mounted account and tab. No file, hash, filename or decision is sent to
the API or stored in browser storage. Switching account, leaving or reloading
discards the review. CSV and JSON are explicit metadata-only downloads, not
backup copies, deletion instructions or automatic upload manifests.

Accept one through one hundred JPEG, PNG or WebP file entries, each at most
8 MiB, with a combined 256 MiB limit. Validate all metadata before reading bytes.
Read and SHA-256 hash one file at a time. Count progress only after each hash
finishes. Cancellation cannot interrupt a native read/hash already in flight,
but must suppress its result and prevent the next read. A failure or cancellation
publishes no partial review. All selected file references are released when
the asynchronous operation settles. No image decoding or preview is needed to
compare exact bytes, avoiding unbounded decoded-image memory.

States are empty, scanning, complete and error. A complete scan holds metadata
only. File names are display data, never identity. Each input position has a
stable row number so same-name files remain independently selectable.
Groups use byte length and SHA-256. Recompressed images and different EXIF
metadata may differ even when pixels look identical. MIME metadata restricts
the picker but is not a claim that the image decoded successfully.

All entries initially remain selected. The owner may keep one copy per group,
choose a different retained copy, restore individual copies or restore all.
Every group must retain at least one copy. Changes are reversible until the
review is discarded; originals are never changed. The interface reports bytes
excluded from the proposed selection, never disk space actually freed.
Replacing a completed review or clearing it requires explicit confirmation.

Export validates every row and the group-retention invariant. CSV cells are
quoted and formula-prefixed values escaped, including Unicode whitespace.
JSON preserves exact filenames and contains schema version, SHA-256 algorithm,
input row, byte length, MIME type, modified timestamp, digest and decision.
Neither export includes file content, account identifiers or absolute paths.

## Verification

Test known digests, same-name different-content files, differently named copies,
size/type/count/total limits before reads, sequential work, cancellation during
read/hash, failure without partial publication, immutable review decisions,
last-copy protection and safe export. Desktop/mobile browser flows must exercise
real Web Crypto, download content, replacement confirmation, account/navigation
cleanup and the absence of upload requests or persistent local metadata.
