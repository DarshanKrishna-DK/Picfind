# Photographer retouching checklist

Give the event owner a persistent work checklist for the exact favorite set in
one final client round. This covers the tracking part of roadmap B20. Uploading
edited revisions and delivering those files remain separate work. Marking a task
ready records the photographer's declaration; it does not create a rendition,
notify a client or grant download access.

## Contract and authority

The owner opens the checklist from a submitted round. GET and PATCH live below
`/events/:id/proofing-collections/:collectionId/invitations/:invitationId/submission/:submissionId/retouching`.
PATCH adds `/:photoId`. Authenticate the event owner before parsing mutations.
Clients, moderators and other owners cannot read the checklist or its notes.
Retained rounds remain readable after invitation revocation or event archival.
Archived or expired events are read-only. Invitation expiry does not prevent the
owner finishing their private work.

Resolve both current and archived rounds through the existing validated history
reader. A task belongs to owner, event, collection, invitation, submission UUID
and photo UUID. Derive its private job key from the invitation/submission/photo
tuple with a separate hash domain. Reopened rounds do not inherit completion.
Only available photos still selected in the collection are returned or editable.
Unavailable photos contribute only to an unavailable count.

## State and storage

Absent records mean queued, version zero and no audit history. Starting work
creates one private `retouching-task` job per photo. The progression is queued
to editing to ready. Editing can return to queued, and ready can return to
editing, with a nonempty explanation. Notes may change without a status change.
Exact retries are idempotent; stale different writes fail with 409.

Each change stores its status, note, version and server timestamp in the same
record as the current state. Retain at most 30 changes per photo per round.
At capacity, reject further changes before writing; do not truncate history.
Validate the complete scope, key, contiguous versions, transition sequence and
current state from history before reading or writing. Keep the existing 16,000
character payload guard. No new Appwrite collection or credentials are required.
Event deletion already removes event-bound jobs.

Use the existing account lock and recheck the grant, photo and task before a
write. These are process-local protections, not a distributed transaction.
GET reads the owner job list once after rechecking the invitation and collection.
PATCH reads it before and after asynchronous work to detect newly conflicting
task keys and changed submission archives. The existing owner job-list query is
retained; large multi-studio workloads
still need indexed scoped queries before a capacity claim.

## Interface and verification

The panel is opt-in for each owner-visible submitted round. Show filename and
photo identity, progress totals, per-photo status, private work note and history.
Load saved values on reopen. Lock controls during writes, clear private results
on failed refresh, and require refresh after a version conflict. Abort requests
on close and prevent responses from another round populating this panel.

Test actual submit-to-checklist workflows, independent rounds/invitations,
negative authority and scope cases, stale edits, lost-response retry, malformed
metadata, unavailable photos, failed writes, deletion and read-only events.
Browser coverage must exercise progress persistence, private notes, refresh,
conflict handling and denied access. Older applications ignore these job records;
rolling back disables the checklist without deleting its stored history.
