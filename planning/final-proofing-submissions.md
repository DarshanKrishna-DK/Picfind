# Final client proofing submissions

Clients currently save draft decisions but cannot confirm the set that a
photographer should deliver. This change adds an explicit final submission and
owner-controlled reopening within each private collection invitation.

## Domain and states

- An untouched invitation starts at round 1. Submission copies the current
  favorite photo IDs, decision version, collection version, short client note,
  submission UUID and server timestamp into the invitation in one write.
- Submitted invitations reject decision edits. A submitted set is immutable,
  including when the photographer later changes the collection.
- The owner can reopen with a reason. First persist an immutable archive job
  whose ID is the submission UUID. Only after that succeeds clear the current
  submission, increment the round and decision version, and save the reason.
  Archive-first failure leaves the original locked. If the second write fails,
  retry verifies the existing archive before completing the reopening.
- At most 20 rounds are retained per invitation. Each set has at most 100 IDs.
  Separate archive jobs avoid putting all rounds into the 16,000-character
  library payload. Every changed invitation is checked against that budget.
- Existing invitations need no migration. New fields are optional, but present
  malformed metadata fails closed. Reverting the application without preserving
  the edit guard would unlock submitted decisions and is not a safe rollback.

## Routes and authority

Client GET/POST `/proofing-invitations/:invitationId/submission` requires the
actual invited account and an active event, collection and invitation. POST
requires the current decision and collection versions and a retry UUID. It
rejects unavailable favorites instead of silently changing the submitted set.
Zero favorites is allowed with explicit confirmation in the interface.

Owner GET/POST
`/events/:id/proofing-collections/:collectionId/invitations/:invitationId/submission`
reads retained history or reopens the current submission. Reopening requires
active access conditions and the expected submission ID. Moderators, other
clients and other owners cannot read or mutate this history. Revoked clients
cannot read it, while owners retain access to their event records.

History projects only submission metadata and currently available photo
filenames. Removed photos are counted as unavailable; their IDs remain in the
private stored snapshot. No internal photo notes, faces or account identifiers
are projected. Event deletion removes archive jobs through existing cleanup.

## Concurrency and acceptance

Use the existing owner process lock for decision writes, submission and
reopening. This is not a distributed compare-and-swap guarantee. Exact retries
return the saved outcome; conflicting UUID reuse or stale versions fail.
Reopening invalidates stale draft writes by incrementing the decision version.

Verify real API authorization, persistence, locked edits, stale versions,
idempotent retries, unavailable photos, corruption, the payload/round caps and
recovery from each failed write. Browser checks cover confirmation, reload,
locked controls, owner reopening and visible private history. This change does
not send notifications or claim production deployment.
