# Named proofing collections

An event owner can save named photo sets for album planning or retouching rounds.
These are private working collections, separate from guest submissions. Creating,
renaming, changing photos or deleting a collection does not send invitations,
publish a gallery, alter photos or rewrite guest requests.

Collections are job records with purpose `proofing-collection`, an event ID,
owner ID, title, distinct selected photo IDs, version and update timestamp.
The existing JSON adapter persists them without a schema migration. Event erasure
already removes all event jobs, including these records.

Owner-only routes under `/events/:id/proofing-collections` support list, create,
read, update and delete. An event can contain at most 50 collections; each contains
1 to 100 available photos from that event. Names are trimmed and capped at 100
characters. Guest/moderator access and cross-event photo IDs are rejected.

Updates and deletion require the current version. Existing account locks bound
concurrent writes within one process; this adds no distributed transaction claim.
Unavailable photos remain in the saved selection identity and are reported as
unavailable. An editor must explicitly remove those IDs before saving a revised
set. Deleting a collection erases only its metadata.

The owner event page adds a Collections tab. It supports reload, filename search,
create, edit, conflict reload and confirmed deletion. Search shows at most 100
candidate photos per page with next/previous navigation and a selected-only filter.
Switching editors asks before discarding a dirty draft. Save/reload disables
collection switching until the request completes. Malformed stored versions fail
with an explicit metadata-repair error rather than returning an undefined version.
Account-bound client access is described in [Collection invitations](collection-invitations.md).
Collections remain private until an owner explicitly invites an account.
Per-client decisions and submitted/locked revisions remain separate future workflows.
