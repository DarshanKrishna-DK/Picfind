# Curated event highlights

Roadmap D37 adds one ordered highlight set per event, independently published
from the full gallery. This is a deliberate photo subset, not a face match.
Owners choose up to 100 retained event photos, edit the title and order, and
explicitly save publication. The first available photo is the cover.

The stored record is a private library job with purpose `event-highlights`,
bound to the event and its owner by a deterministic record identifier. Its
strict versioned payload contains title, ordered unique photo IDs, publication
and update time. Absent state is a private empty draft at version zero.
GET/PATCH `/events/:id/highlights` require event ownership. Moderators cannot
publish. PATCH uses optimistic versions and exact immediate retry recovery.
Fresh event, photos and record state are checked before writing. Existing
process-local locks do not provide cross-process compare-and-swap guarantees.

States are empty draft, populated draft and published set. A published set
requires at least one selected photo. Archived or expired events cannot publish,
but an owner can withdraw publication. A save with unavailable selected photos
is rejected until those entries are removed, except withdrawal is always
possible for the existing set. The owner sees unavailable IDs explicitly.
Changing the full event visibility does not publish or withdraw highlights.

Signed-in guests use `/highlights/:eventId` and
GET `/public/highlights/:id`. The response includes only highlight title,
ordered currently available photo metadata, cover ID and published photographer
credits. It excludes the private event title, unselected IDs, faces, notes and
draft metadata. It never enables the full event or face-search routes.
Photo lookup reads only the selected IDs, in batches of at most eight concurrent
reads, instead of scanning the owner library. Missing photos are omitted;
storage outages fail the request rather than appearing as an empty gallery.

GET/HEAD `/public/highlights/:id/photos/:photoId` authorizes current membership
in the published set, same-owner event/photo scope, and event/photo retention.
It rechecks these rules after loading bytes through existing accounted image
delivery. The gallery and ZIP use this endpoint exclusively. Withdrawal,
removal from the set, deletion, archival or expiry deny new delivery. Previously
downloaded copies cannot be recalled. Metadata and object storage are not
transactional, and in-flight requests cannot be revoked after their final check.

The owner editor preserves draft changes on conflict and requires an explicit
reload before another save. Guests refresh on focus and every 30 seconds;
failed refreshes hide stale gallery content. No local persistence or provider
activation is introduced. API and browser tests cover saved order, publication,
private-event isolation, withdrawal, scoped file/ZIP delivery, stale updates,
invalid state, retention and changes during delivery.
