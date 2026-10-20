# Guest selection receipts

A signed-in guest can recover their own submitted favorites after a reload.
Each new selection stores `submittedById` from the authenticated session, separate
from the guest-supplied display name. Legacy requests without that identity stay
owner-only. Matching a name or email never grants access to an older request.

`GET /public/events/:id/my-selections` requires the existing session, active link
gallery and current passcode. A closed submission window does not hide receipts,
but archived, private, expired or deleting galleries do. Access is checked again
after asynchronous reads. Response caching is disabled.

The guest projection contains request ID, timestamp, their name and note,
original distinct-photo count, currently available photo IDs/filenames and an
unavailable count. It excludes organizer review status, private notes, internal
actor IDs and unavailable photo IDs/filenames. No email or message is sent.

Results are newest first, ordered by timestamp and ID. Each response contains at
most 25 receipts. The cursor must identify one of this guest's requests in this
event; invalid or foreign cursors return the same generic error. This bounds
responses, not storage reads: the existing adapter lists owner job records.
Event submissions already have a 1,000-request cap.

The interface loads history on demand, shows errors without claiming success,
supports more pages and refresh, and refreshes after a successful submission.
Query identity includes both event and signed-in account. Receipts are a record
of requests, not a photographer acceptance or fulfillment promise.
