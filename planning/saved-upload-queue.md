# Saved device upload queues

Roadmap C23 adds a recoverable batch beside the existing quick uploader. A
photographer can prepare up to 100 JPEG/PNG/WebP files, start, pause, resume,
cancel unfinished work and clear the saved queue. Each file remains bounded to
8 MiB. Processing is sequential to bound memory and storage requests.

## Persistence and identity

Persist a versioned manifest in browser localStorage, scoped to the signed-in
account and exact event or personal destination. Store filename, MIME type,
size, SHA-256 of original bytes, state, acknowledgement photo ID and bounded
failure text. Do not persist original image bytes, credentials or file handles.
The interface discloses what is saved and offers Clear saved queue.

After reload, reselect originals. Match by digest and size, including renamed
files; retain the saved upload filename. Completed items are never sent again.
An interrupted request returns to pending because aborting the browser does not
prove the server did not commit. The existing original-byte replay path recovers
that ambiguity without another storage reservation. Legacy server records still
have the documented replay limitation.

Creating a new batch requires clearing the previous manifest. Reject malformed
or mismatched persisted metadata without overwriting it. Storage failure stops
work before the next network request. A failed acknowledgement write leaves an
interrupted entry that can recover on reload.

## State machine and concurrency

Queue: paused -> running -> complete or paused. Cancel stops pending work and
retains completed acknowledgements. An explicit resume may restore cancelled
unfinished entries. File: pending -> uploading -> complete or failed; interrupted
uploading returns to pending. There is at most one uploading item.

Use a Web Lock per account/destination for every mutation and hold it across
the running batch. A second tab may inspect progress but cannot run or clear the
same queue. Recheck manifest ID/revision under the lock before acting on an
older interface. Storage events refresh idle views. Refresh can recover a
running marker after a crashed tab releases its lock.

The queue uses the current server session for every upload. Send the expected
actor ID in `X-PicFind-Upload-Actor`; the upload endpoint rejects a mismatch
before processing. This header grants no authority. Existing event access,
retention, membership and billing checks still govern the destination. A
session/access/closed-destination/quota failure pauses the batch rather than
continuing to send every remaining file.

Pause, cancel or closing the panel aborts the current browser request and stops
future requests. Cancellation never deletes an uploaded server photo. Queue
metadata remains browser-local and is not evidence of current server retention.

## Acceptance and limits

Verify persistence using a new controller and an actual browser reload. Test
content mismatch, duplicate input deduplication, one-at-a-time requests, aborted
ambiguous uploads, complete-item skipping, account/destination isolation,
stale revisions, cross-tab contention, storage failures and malformed manifests.
Browser tests cover prepare/start, pause/resume, cancel, reload/reselection,
clearing, private account changes and a blocked second tab. API tests prove
the expected-actor header cannot redirect work into another signed-in account.

No Appwrite schema migration, provider key or server upload queue is introduced.
Browsers without Web Locks or writable localStorage show an explicit saved-queue
error; quick upload remains available. This is resumable whole-file batch work,
not byte-range transfer resumption. Original file reads allocate at most one
8 MiB buffer at a time; the application retains only File references in memory
while the panel remains open.
