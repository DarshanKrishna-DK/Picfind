# Private event coverage plan

Roadmap 90 supports explicit photographer shot lists and delivery checks.
An owner defines up to twenty categories such as family portraits, venue details
or sponsor signage. Each has a stable ID, label, target count and optional private
note. The photographer assigns event photos manually. Counts describe those
assignments, never inferred attendance, image quality or recognition results.

## Domain and authorization

Store one versioned private `event-coverage` job per event using a deterministic
record ID, the organizer owner ID and root event ID. Existing event/account
cleanup includes this record. Keep at most fifty photo IDs per category and one
hundred references across the plan. A photo may intentionally serve multiple
categories. Category IDs and labels are unique; photo IDs within a category are
unique. Bound text and serialized UTF-8 payload size below the storage limit.

`GET /events/:id/coverage` returns the private plan, current available selected
photo IDs, account/event identity and whether the event is editable. Only the
session owner may read. Moderators and guests have no coverage endpoint.
`PUT` requires same-origin protection, the current version, a bounded strict
payload and an active owned event. Browser actor headers detect account changes
but never authorize requests. Recheck event ownership and newly assigned photo
access before persistence. Retained unavailable assignments may be removed or
kept for reference, but cannot count toward targets. A previously retained ID
moved into a different category is a new assignment and requires access again.

Use the existing account lock, version checks and create-only initial write.
An immediate identical retry at the next version returns the saved state.
Conflicting stale changes preserve the browser draft for inspection and require
an explicit reload. This is application-process serialization, not distributed
database CAS. Record timestamps do not move backward.

## Interface and state

Add an owner-only Coverage event tab. A saved snapshot has missing, partial and
target-met counts derived from currently available manually assigned photos.
The editor separates unsaved draft changes from saved status. Owners can create,
edit, select and remove categories, adjust targets/notes, assign/remove photos,
save the plan and reload. Category removal requires confirmation. Saving an
empty plan clears the checklist without deleting photos. Candidates support
search and bounded incremental rendering. Unavailable selected photos display
their identity without stale filenames and do not count toward coverage.

Loading, failure, archived/expired read-only state, stale-version conflict,
lost-reply retry and detected account changes have explicit UI behavior.
Abort requests on unmount. Refreshing availability reloads the saved plan and
requires confirmation if it discards unsaved changes. Changes never publish a
gallery, send a message, grant client access or enqueue face work.

## Acceptance

Verify owner/session/origin/header guards, corrupt metadata, all bounds,
exact retry, concurrent stale writes, event/photo ownership races, changed
photo availability, retained versus new unavailable assignments, archived event
reads and denied edits, private projection and cleanup. Desktop/mobile flows
use actual API handlers with isolated synthetic storage and cover complete
create/assign/save/reload/remove behavior, partial counts, stale drafts,
lost replies and account changes.
