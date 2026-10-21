# Photographer event access planner

## Outcome

Photographers need one place to review upcoming event access deadlines across
their own events. Add a private planner with active, soon-expiring, expired,
archived and undated states derived from actual event records and a server
check time. Link to the existing event tools for review or eligible extension.
Do not imply that an access deadline is a guaranteed physical deletion time.

Offer a fresh downloadable calendar of the selected future active deadlines,
with stable event identifiers, UTC times and optional local calendar alarms.
The file is a copy for the owner to import into their calendar. PicFind does not
send reminders or silently update imported calendar copies.

Calendar alarm choices are none, one day before or seven days before. Omit an
alarm whose trigger would already be in the past at the fresh server check
time, and report how many were omitted. Calendar entries remain private,
transparent deadline markers with no attendees or organizer invitation fields.

## Authorization and data

Use an owner-only `/studio/event-deadlines` read projection. Moderated events
belonging to other accounts are excluded. Validate owned event identity and
expiration metadata, bound the snapshot, re-read candidates with bounded
concurrency and omit deleted or transferred records. A failed source read must
not become a successful empty plan. Apply no-store behavior and the existing
account deletion guard.

Return only event identity, title, archive state and explicit access deadline.
Do not return photos, face references, guest identities, private notes or
subscription information. Derive statuses from the returned check time rather
than browser clock assumptions. Bound the complete calendar export and escape
text according to the existing calendar implementation conventions.

## Interface and lifecycle

Expose the planner from the studio navigation. Filters search event titles and
select deadline states. Use accessible date labels, an explicit last-checked
time, a refresh action and links to existing event tools. Export performs a new
authorized read and applies the selected filters to that fresh snapshot.
Only future active events with explicit deadlines enter the calendar.

Cancel a pending export on navigation or account change. Clear old export
success messages when filters change and hide stale private data after access
denial. Show source failures instead of asserting that no deadlines exist.
No event is extended, archived, deleted or published by the planner.

## Validation

Cover owner and moderator isolation, expiry boundaries, invalid dates, missing
or transferred events during reads, archived exclusions, snapshot limits and
operational failures. Parse generated calendars with the existing calendar
parser to verify UTC instants, escaping, alarm values and stable identities.
Desktop/mobile tests cover real API projections, filters, refresh, authorized
fresh export, cancellation and account privacy.

Calendar format reference: [RFC 5545, sections 3.6.1, 3.6.6 and 3.8.6.3](https://www.rfc-editor.org/rfc/rfc5545.html).
A date-time event without an end property is an instant marker. Display alarms
use a description, display action and trigger relative to the event start.
Calendar applications may choose how to handle imported alarms, so the interface
must not promise delivery by a specific calendar application.

Verification: 21 API/calendar tests and 12 Chromium/mobile WebKit browser cases
passed. The initial mobile navigation test checked visibility before the page
loaded; waiting for the Events heading corrected the test. Desktop/mobile
screenshots were inspected. The full application check passed 151 test files
and 2,488 tests, lint, typecheck and both builds. No production deployment,
calendar-provider calls or messages were sent.
