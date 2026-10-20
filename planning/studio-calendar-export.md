# Private schedule calendar export

Extend scheduling with a complete manual handoff to calendar applications.
The owner downloads an `.ics` snapshot of saved appointments matching the current
search, project, status and local-date filters. Unsaved editor fields never
enter the file. Refresh the existing owner-only schedule endpoint on every
download, retain the expected-account header and reject mismatched accounts,
invalid responses or an incomplete over-capacity projection.

The export action captures filters and the private-note preference at click time.
Controls are disabled during the fresh read. Reapply those filters to the latest
saved response, show the actual exported count and preserve the current editor
draft. A stale editor must still encounter its normal version conflict when
saved. No cached fallback download is allowed after an access failure.
Cancellation through unmount/account change aborts the read and prevents download.

Use one shared filter implementation for the visible list and export. Dates
refer to each appointment's stored local calendar. The end instant is exclusive;
an appointment ending at midnight does not occupy the following day. An invalid
range produces no visible rows and cannot export. Search remains case-insensitive
across saved title, note and available project name.

The calendar file includes appointment titles, stable UUID-based UIDs, UTC start
and end, revision sequence, created/modified times, cancellation state and a
private classification. Descriptions retain the entered local times and timezone.
Project names and private appointment notes are opt-in together, off by default.
An unavailable project never contributes stale names. Owner-entered scheduled
records remain tentative calendar reservations, not client confirmations.

The file uses [RFC 5545](https://www.rfc-editor.org/info/rfc5545/) framing:
CRLF lines, UTF-8 folding at at most 75 octets, escaped text values, UTC timestamps
without TZID, a non-inclusive end and a bounded integer sequence. DTSTAMP reflects
the saved revision when no METHOD is supplied. Do not add attendees, organizer
addresses, alarms or a scheduling METHOD. Validate before serializing and use an
independent iCalendar parser in tests.

This is a file download, not calendar authorization, invitation delivery or
synchronization. Reimport behavior varies by calendar application. Choosing all
statuses includes cancellation records, but removing an appointment from PicFind
cannot remove an already imported copy. The interface must explain this boundary
and label opt-in private metadata before downloading.

Acceptance: independently parse UTC and repeated-DST-hour output; validate stable
UIDs and revisions, cancellation, control-character/text injection, Unicode
folding, note omission and opt-in, incomplete snapshots and no-match errors.
Browser tests exercise actual session-authorized API reads, fresh filtered
exports, preserved unsaved drafts, lost access, cancellation on unmount and
private-detail preference on desktop/mobile.
