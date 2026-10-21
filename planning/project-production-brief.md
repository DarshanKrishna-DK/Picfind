# Private project production brief

Photographers need a portable view of a project's linked event names, dated
milestones and scheduled or cancelled appointments before a shoot or handoff.
Provide one owner-only review page and a fresh plain-text or JSON download.
This is a local copy, not an invitation, booking confirmation or shared link.

The projection includes project identity, creation identity, stage and check time.
It omits client contact details, stage-change actors, financial records, photos,
face metadata and storage references. Project summary, milestone notes and
appointment notes are excluded unless the owner explicitly enables private notes.
The default API response must omit these values, not just hide them in the UI.

Read the current owned project and its current associations. Milestones and
appointments use their existing project-ID association; the brief does not
invent evidence about historical project generations. Reject projects pending
removal. Validate source records with the existing parsers, bound the job scan
and each project section, and recheck selected rows plus the project before
returning. Missing/foreign linked events remain labelled unavailable, without
revealing their titles. Source errors or mid-read changes fail closed.
The account lock serializes the existing single-process writers; this is not a
distributed snapshot transaction.

Route: `/studio/projects/:id/brief`, with a strict notes query and session actor
header. Interface: `/app/projects/:id/brief`, linked from Projects. Account,
project and notes mode key the private query. Export performs another read with
the selected notes mode, aborts on navigation and displays errors without
downloading stale content. Notes mode is visible in both formats.

Validate owner isolation, unavailable links, note omission, bounded complete
sections, invalid metadata, source changes, removal and operational failures.
Browser tests cover the project link, mode changes, downloads, failure recovery,
fresh values, cancellation and account changes. Inspect desktop/mobile layouts.

Verification: 62 API cases passed across the brief, milestones and appointments.
All 12 Chromium/mobile WebKit browser cases passed, followed by two focused
layout checks after aligning the disclosure checkbox. Desktop/mobile screenshots
were inspected. The full suite passed 152 files and 2,503 tests. The initial
typecheck found a fixture field and tuple inference issue; both were corrected
before the final check. No production deployment or external delivery occurred.
