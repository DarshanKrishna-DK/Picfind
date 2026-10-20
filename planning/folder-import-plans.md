# Reviewable folder imports and deliberate collection mapping

## Outcome

Replace the immediate folder uploader with a reviewable, recoverable workflow.
Preserve relative paths, report unsupported and oversized files before sending
bytes, choose folders explicitly and optionally create private proofing
collections from acknowledged event photos. Equal filenames in different
folders remain distinct; equal bytes share an upload but retain all source paths.

## Domain and boundaries

Inspect at most 1,000 selected file descriptors. Reject unsafe, missing or
ambiguous relative paths. Report unsupported extensions, MIME mismatches, empty
files and files over 8 MiB. Select at most 100 supported files across at most
20 folders for one batch. Nothing uploads on folder selection or preparation.
Read one supported image at a time for SHA-256 using the existing queue controller.

A separate browser-local folder queue uses the existing account and destination
scope, Web Lock, original-byte retry, cancellation and storage guards. Extend the
version-one manifest compatibly with optional relative paths and explicit folder
mapping metadata. Existing saved queues still parse. Store only metadata and
acknowledgements, never original bytes or absolute paths. After reload, reselect
the folder; content matching restores unfinished files while retaining the
original plan. Clearing removes local metadata and keeps uploaded server photos.

Each selected folder has a stable caller-generated collection UUID, a bounded
title and an explicit create-collection choice. Personal library imports cannot
create collections. Event mappings operate only after the whole upload batch is
acknowledged. Every folder uses its exact acknowledged photo IDs, including an
upload shared by identical bytes across folders. Creating a collection does not
publish it or send an invitation.

Add owner-only PUT `/events/:id/proofing-collections/:collectionId/import`.
Require the expected upload actor, a UUID, title and distinct bounded photo IDs.
Reuse collection availability checks, capacity and account locking. Store an
exact import-command digest on the collection. Same command retries acknowledge
only the unchanged original version; changed commands or edited collections
conflict. Never overwrite existing collections or trust a caller-selected owner.
Recheck event and photo authority before creation and on every replay. Account
and event erasure already remove these ordinary collection records.
Collection mapping holds the same browser Web Lock as uploads and clearing.
It compares the complete saved manifest before each mapping request, so another
tab or a changed local plan cannot silently substitute the reviewed mapping.

## Interface and states

Selection -> descriptor report -> explicit folder choices -> prepared paused
queue -> running -> paused/cancelled/complete. Show source paths, counts, bytes
and exclusion reasons. Invalid selections remain reviewable without uploads.
The queue retains its plan and progress on reload. Collection creation is a
separate explicit action after upload completion, with exact title/count preview
and a recoverable result per folder. No automatic publication or external sends.

Account-key the panel. Abort pending requests on navigation or account changes.
Expected actor headers detect a changed server session without granting access.
Browser-local progress is not proof of current server photo retention.

## Acceptance

Verify path ambiguity, nested duplicate filenames, MIME and size reports,
selection limits, compatible old queues, same-byte multi-folder membership,
restart/reselection, stopped uploads, lost replies, stale tabs, mapping retries,
foreign photos, account switching and unavailable events. Test the complete
desktop and mobile plan/upload/map/reload workflow with real API authorization.
Keep the existing queue, upload and proofing-collection tests passing.

## Verified implementation

The full repository check passed: 137 test files, 2,173 tests, lint, type
checking and both builds. Focused folder, saved queue and collection checks
passed 85 tests. All 20 Chromium and mobile WebKit workflow cases passed,
including real API upload and mapping, restarted selection, paused committed
uploads, lost collection replies, account changes, stale manifests and a
second tab holding the queue lock. Startup now defers lock acquisition until
the current mounted instance is known, avoiding contention with a disposed
startup instance. Desktop and mobile layouts were inspected with horizontal
overflow checks. Existing nonfatal Zod annotation and bundle-size warnings
remain. No provider keys, infrastructure or production activation were added.

Post-review, folder paths validate their own components instead of appending a
placeholder basename that shortened the supported limit. Controllers and mapping
reads now require the expected folder/ordinary manifest kind, preserving legacy
ordinary queues while rejecting missing folder metadata. A vanished photo
returns a scoped conflict, and collection lookup also validates the returned
record identity. Creation returns 201; unchanged replay returns 200.

The reviewed workflow creates one new collection for each explicitly selected
folder; it does not merge folders into an existing collection. Unsafe or
ambiguous paths reject preparation and now identify the offending filename.
Refresh, cancel and explicit clear remain local recovery controls even after
an event closes. They never start uploads. Added evidence covers the full
512-character photo path, wrong-kind storage, same-folder duplicate bytes,
deleted photos, malformed lookup identities and closed-destination recovery.
All 90 focused tests passed after these changes, as did 30 desktop/mobile
browser cases covering both folder imports and the existing ordinary saved
queue. Type checking and focused lint passed.
