# Published invitation sharing

## User outcome and boundary

Hosts need printed material that opens the published invitation rather than the
protected gallery. Guests need a calendar reminder made from the published date,
time and location. Extend the existing QR pack workflow and add an invitation
calendar download. These are static copies, not subscriptions, admission tickets,
confirmed attendance or automatic calendar updates.

Only the published invitation supplies guest calendar content. Unsaved host drafts,
RSVP responses, browser receipt identifiers and gallery access codes never enter
the export. Existing gallery and highlight QR destinations keep their current
access rules. An invitation QR grants access only to the public invitation.

## Contract and state

No new persisted records or migration are needed. The existing publication is the
source of truth. Calendar generation parses the strict public projection and
binds it to the route event ID. It reads the publication immediately before
generation and again before downloading. Withdrawal, event closure, changed
publication or navigation prevents a new download. Existing downloaded copies
cannot be recalled.

Use stable event identity, publication revision and published timestamp in the
calendar. Reject revisions beyond the iCalendar sequence range. Escape text,
strip unsupported control characters, fold UTF-8 lines to 75 octets and use CRLF.
An independent calendar parser verifies the generated content.

For a date without a time, export an all-day date with an exclusive next-day end.
For a timed invitation, resolve the declared IANA timezone to UTC. Do not invent
an end time. This follows the event duration rules in
[RFC 5545 section 3.6.1](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.1).
A repeated daylight-saving local time requires an explicit choice
between its two occurrences; nonexistent local times remain invalid. Clearly
show the chosen UTC instant before generation.

## Interface and authorization

Add Published invitation to the owner QR destination selector. Require an active,
owned event and an actual published invitation at both authorization checks.
Use the invitation route in QR payloads and fallback links. Print instructions
must say that invitation details are public, without promising photo access or
requiring sign-in for this destination.

On the public invitation, offer Download calendar reminder, a date/time summary,
the daylight-saving choice when needed, cancellation and explicit stale-copy
guidance. Keep the control independent of guest RSVP state. Loading, failures
and changed publication never produce a success message or download.

## Verification

Check all-day/year boundaries, UTC conversion, repeated/gap local times, Unicode
folding and text injection with an independent iCalendar parser. Verify QR route
payloads and literal escaped print content. Browser tests cover publication
withdrawal and replacement between reads, cancellation/navigation, private-draft
exclusion, download parsing, owner/account denial and mobile controls. Existing
studio calendar and gallery/highlight QR tests must continue to pass.
