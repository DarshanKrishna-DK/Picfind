# Photographer unavailable time

Appointments currently prevent overlap with other project appointments, but
photographers cannot reserve travel, leave or preparation time without creating
a fake project. Add a private owner-managed availability-block library and
enforce those blocks when saving scheduled appointments.

Each block has a title, private note, explicit timezone, local start/end and
selected UTC occurrences. Reuse the existing DST-aware interval validation.
Allow intervals up to 31 days, active or inactive status, version/generation
conflict detection and exact retry recovery. Limit retained blocks to 100 with
a bounded recovery read. Blocks are independent of project deletion and are
removed by account erasure.

Routes: owner-only `/studio/availability` and `/studio/availability/:id`.
UI: `/app/availability`, linked from Schedule. A saved active block cannot
overlap a scheduled appointment or another active block. Saving a scheduled
appointment must check active blocks. Adjacent half-open intervals are allowed.
Cancelled appointments and inactive blocks do not reserve time. Cancellation,
deactivation and deletion remain available when unrelated scheduling data is
damaged, so the owner can recover.

Both write paths use the same account lock and validate the complete bounded
set of reservations needed for conflict detection. This provides single-process
serialization, not a distributed transaction. Stored schedule failures must not
become an empty conflict set. All private values remain owner-only; creating a
block sends no notifications and makes no calendar-provider or booking claim.

The editor must preserve blocked drafts after conflicts or read failure,
require explicit discard on replacement, abort late responses after navigation,
hide data on account change, and make timezone ambiguity visible. Confirm
removal with the current version and generation. No automatic deletion or
cancellation of conflicting appointments.

Tests cover owner/session/origin boundaries, both overlap directions, adjacency,
disabled/cancelled exclusions, DST gaps and repeated hours, exact retries,
stale versions, bounded scans, concurrent appointment/block creation, corrupt
metadata and account erasure. Desktop/mobile tests exercise real persistence,
conflict recovery, deactivation/removal and private-state cancellation.

Implemented with a 2,000-job scan bound, 500-record recovery bounds, 100-block
creation limit and 12,000-byte complete-record ceiling. Conflict reads verify
listed block and appointment records in batches of eight. Deactivation-only
writes and deletion validate their selected record without requiring an
unrelated damaged schedule to be repaired first.
The directory names these limits separately as `creationLimit` and
`recoveryLimit`. A malformed peer encountered during a schedule scan returns
`SCHEDULE_METADATA_INVALID` rather than a selected-record 404, preserving the
editor recovery actions for a valid selected block.

Validation: 47 availability/appointment API and unit cases passed. All 18
availability desktop/mobile cases and 24 existing schedule cases passed.
Browser cases include lost-response retries, stale drafts, failed-read recovery,
DST ambiguity, account changes and navigation during a pending save. Populated
textarea and select locators were corrected to use accessible roles. Desktop
and mobile layouts were inspected. Lint and typecheck passed; the full
application test/build check is recorded separately in the PR.

The full check passed 155 files and 2,541 tests plus both production builds.
After review, all 37 availability/appointment API cases and 20 availability
desktop/mobile cases passed, along with typecheck and targeted lint. Added
evidence covers damaged peer markers, invalid saved timestamps, key ordering,
over-quota recovery, repeated-hour deactivation and the exact retry payload.

The first browser attempt failed from local memory pressure. The unused,
untracked legacy npm download cache was verified and cleared within this
workspace before sequential verification resumed. No source data, installed
dependencies, face models or saved index snapshots were removed.
