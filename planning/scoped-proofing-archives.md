# Scope proofing archive storage keys

Two invitation records can hold the same client-supplied current submission UUID.
The old reopen operation used that UUID as a global archive storage key. After
one invitation reopened, the other could not archive its own distinct snapshot.
This is a reproducible workflow failure, not a reason to combine the histories.

## Storage and compatibility

Derive new archive record keys from a domain-separated SHA-256 hash of the
invitation ID and submission ID, truncated to 32 hexadecimal characters. This
follows the existing internal deterministic record-key pattern. The submitted
UUID remains unchanged in public responses, retries, exports and reopening.
Validate the full owner/event/invitation/snapshot provenance on every existing
record; the derived key alone grants no access.

Read both legacy archive keys (the submission UUID) and new scoped keys. Keep
valid legacy records in place and reuse them when completing an interrupted old
reopen. Do not overwrite a conflicting scoped record or create a duplicate when
both formats already exist for the same invitation and snapshot.
An unrelated legacy key no longer blocks a new scoped archive.

Submission retries remain scoped to the invitation. Reject reusing a submission
UUID from an earlier archived round of that same invitation, including archives
stored under the new key. The shared history reader checks unique round numbers
and unique submitted UUIDs, and returns internal archive-key mappings only to
server callers. Comparison rechecks the actual stored archive key.

## Validation and rollout

Prove the original failure with two real API submissions using one UUID, then
reopen both independently, reload both histories, compare their archived rounds,
retry safely and deny same-invitation UUID reuse. Exercise legacy reads and
interrupted-reopen recovery, conflicting scoped keys, mismatched provenance,
both-format duplication, failed writes and event cleanup.

No Appwrite schema migration or new credentials are required. The application
must be upgraded consistently before writing scoped archives. Older application
versions cannot read the new archive keys, so rolling back to the previous
binary after new writes is unsafe without a reviewed data conversion. Existing
process-local locks do not become distributed transactions.
