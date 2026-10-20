# Published photographer enquiry form and private follow-up inbox

## Outcome and boundaries

Give a photographer a shareable enquiry form and a private, persistent inbox.
An enquiry is a contact request, not a booking, payment, contract or verified
customer. No email, SMS or other external message is sent by this feature.
Follow-up stages are manual records of work the photographer performs.

## Domain and authority

One owner-owned `studio-enquiry-form` job stores a stable ID, public studio
name, introduction, enabled flag, version and timestamps. The owner explicitly
publishes or closes it. No drafts or owner IDs appear in the public projection.
Publishing makes only the studio name, introduction and form version public.
Owner writes use an expected actor header, current version, exact retry digest
and account lock. A monotonically versioned form prevents stale submissions
after a change to the published details.

Each `studio-enquiry` job belongs to that photographer and contains a
caller-generated UUID, form ID/version, name, reply email, optional phone,
preferred date, session type, message, explicit contact-sharing consent,
received timestamp, version and bounded follow-up history. Contact details are
self-reported. They are never returned by a public read, generic library listing,
another account or an event guest route. The public submission response contains
only a reference ID and received timestamp.

Public input is bounded to 6,000 UTF-8 bytes, with rate-limited writes and a
200-enquiry account cap. Exact request replay can acknowledge a retained record
without creating another. A reused UUID with different details conflicts.
New intake also stops at 25 retained requests received in the previous hour for
the same photographer, independent of the submitting IP. This check uses stored
timestamps under the account lock and returns a retry interval. Exact retries
remain available. The throttle limits burst impact; anonymous intake is not
proof of a human visitor and this is not complete distributed abuse prevention.
Removing retained requests can free intake capacity.
Recheck publication and ownership under the photographer account lock before
storing or replaying a request. Existing account erasure removes form and inbox.

Routes: owner GET/PUT `/studio/enquiry-form`; public GET `/public/enquiries/:id`
and PUT `/public/enquiries/:id/:requestId`; owner GET `/studio/enquiries`,
PATCH/DELETE `/studio/enquiries/:id`. Owner status updates append bounded
timestamped transitions across new, contacted, qualified and closed, with
optimistic versions and exact immediate retries. A private note can accompany
the update. Explicit deletion removes the contact request and its private notes.
Replay deduplication applies while the enquiry record is retained; it is not a
permanent suppression list after explicit deletion.

## Interface and state

Studio `/app/enquiries` contains the publication editor and inbox. Preserve
failed or stale drafts until explicit reload. Show real counts and filters,
contact details, follow-up history, private notes and explicit removal.
Read-only contact actions are copyable text; this feature does not send replies.

Public `/enquire/:id` displays only the current published studio details.
Submission requires the current version and an unchecked consent control.
Keep the same request ID after uncertain failure so an exact retry can recover.
Do not store visitor contact fields in browser storage. On success, show the
saved reference and clearly state that the photographer has received a request,
without claiming a booking or promising a response time. Visitors can contact
the photographer for corrections; the owner can remove the retained request.

Account-key private state, abort requests on navigation, reject changed sessions
and preserve confirmed server results after a lost reply. No provider keys,
paid infrastructure or new deployment are needed. Existing account locks and
rate counters coordinate one process, not distributed workers.

## Acceptance

Test explicit publication, stale form versions, field limits and consent,
exact submission retry, cross-owner and public projection isolation, changed
ownership/publication during reads, capacity and deletion recovery, stale owner
updates, history limits and account erasure. Browser tests cover publish,
submit, private review, status and notes, reload, closure, uncertain replies,
failed writes and mobile controls. Keep diffs under 5,000 changed lines.

## Verified implementation

The real Express API fixture passes 19 integration cases. Twenty browser cases
pass across desktop Chromium and mobile WebKit, covering the complete publication,
anonymous submission, private follow-up, reload and removal flow, lost replies,
stale publication consent, draft retention, pagination, closure and changed
accounts. Desktop and mobile screenshots were inspected.

Full repository validation passed 138 test files and 2,198 tests, lint, type
checking and API/web builds. Existing nonfatal dependency annotation and bundle
size warnings remain. The source implements the feature; no production deployment
or external messaging service was activated.

Post-review verification adds photographer-wide recent-intake throttling,
explicit pending-refresh controls and a disabled load-latest action after a
failed form read. Twenty-one API cases pass, including exact replay at the
intake limit, recovery after the window and a near-limit submission with worst
escaped notes and full history below the configured 16,000-byte payload budget.
All 26 desktop/mobile browser cases passed, including actual background query
refetch with receipt persistence and a fresh UUID on a deliberate new page visit.
Type checking and focused lint passed after the review changes.
