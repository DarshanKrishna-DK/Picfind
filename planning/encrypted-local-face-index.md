# Encrypted local evaluation index

The local evaluation pipeline needs persistent photo-to-face mappings before
scoped search can be tested. A private SQLite database stores one authenticated
encrypted extraction artifact per photo. Scope kind/UUID, photo UUID, pipeline
digest, artifact digest, face count and removal markers remain metadata; face
vectors, detection coordinates and consent references are encrypted with
AES-256-GCM. No plaintext vectors enter SQLite or its journal.

The operator explicitly creates a 32-byte key file and database. Neither is
uploaded or committed. The key is read from a separate file, never passed as a
command-line value or printed. POSIX mode checks reject group/world-accessible
keys; Windows relies on an owner-private directory ACL. Encryption protects a
database copy without the key. It does not protect a compromised account, an
unlocked machine, plaintext extraction inputs, or a backup containing both files.

Each operation requires an explicit event/scan scope. Import accepts only bounded
photo-mode artifacts from the pinned extraction pipeline and verifies UUIDs,
digests, dimensions, stable face IDs and normalized finite vectors. Reference
artifacts cannot become gallery entries. One scope retains one pipeline.
Identical import is idempotent. Replacing a photo requires the current artifact
digest, so stale retries cannot overwrite a newer extraction. SQLite transactions
make each import/replacement atomic across processes and roll back failures.

Photo erasure clears its ciphertext and retains a tombstone. Scope erasure clears
all its ciphertext and marks the scope retired. Late imports cannot resurrect
either. A later intentional rebuild uses a separate new evaluation database.
Deletion is logical removal from the active index, not a forensic erasure claim;
filesystem snapshots, old backups, SSD behavior and plaintext source artifacts
need separate lifecycle handling. No rotation, backup service or production
retention policy is added.

The CLI exposes key creation, database initialization, import, scope counts,
photo erasure and scope erasure. It does not return vectors in terminal output,
perform face search, listen on a network port or change PicFind provider routing.
Library reads are scope-bound for the next calibrated-search step. Limits cap
photos/faces per scope and bound each artifact. Tests use synthetic vectors and
fresh temporary keys, including restart, isolation, tampering, wrong keys,
concurrency, stale replacement, rollback and non-resurrection after erasure.
