# Recover byte-identical uploads at capacity

When an upload consumes the last photo slot but its reply is lost, retrying
currently hits the quota before existing-photo detection. The device uploader
also disables its retry button when the refreshed remaining count is zero.

Store a SHA-256 digest of the validated original upload bytes with each newly
created photo. After resolving current destination authority, a byte-identical
retry may return that available photo before decoding or quota checks. Scope the
lookup to the same owner, event and scan; exclude deletion tombstones and expired
photos. Re-read the matching record and event authority before returning it.
This does not reserve storage, upload another object, rename the photo or extend
retention. Different bytes still encounter capacity checks before image decoding.
Keep the existing optimized-image duplicate check for requests below capacity.

Return an explicit public upload metadata projection, including existing
ownership/contributor fields but excluding digests, face metadata and private
photo notes. Omit the new input digest from the owner's library response too.

Permit only the current component's failed-file retry list to run when capacity
is zero. New file selection stays disabled. The server remains authoritative:
an uncommitted file retried at zero capacity still fails with a useful error.
The retry list does not survive a page reload and does not retain files in
browser storage. This is recovery for byte-identical whole-file requests, not a
resumable chunk-upload protocol.

Legacy photos lack the original-input digest, so they retain the previous
optimized-image deduplication path while capacity is available. Do not invent
original hashes from re-encoded stored files. No schema or provider change is
required; old binaries ignore the optional digest. Existing access, billing and
compensation safeguards remain in force.

Validate a real last-slot upload followed by an identical retry, at both library
and event limits, without a second storage reservation or object write.
Also test new-file rejection, deletion/expiry exclusion, event authority changes,
scope isolation and private upload-response fields. Browser coverage reproduces
a committed upload with a failed response, refreshed zero capacity and a working
retry that leaves exactly one photo.
