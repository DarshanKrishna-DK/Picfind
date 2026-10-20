# Private event RSVP responses

Hosts need an optional way to collect attendance intentions from the published
invitation. This feature records responses, not verified attendance, admission,
payments or identity checks. It sends no messages.

## Domain and privacy

The event owner explicitly enables RSVP collection and sets an optional closing
instant plus a party-size limit from one to ten. Collection is disabled by
default. Only an active event with a currently published invitation accepts new
or changed responses. Settings have version conflicts and exact retry recovery.

A response contains a guest-entered display name, going/maybe/not-going choice,
party size and an optional short private message. A not-going response has zero
party size. Require an explicit acknowledgment that these fields are shared with
the event host. Do not collect an email, phone, selfie or account identifier.
The host sees private response rows and totals derived from saved valid records.
No response or aggregate is included in the public invitation projection.

Each browser uses an event-scoped random receipt secret in an HttpOnly,
SameSite=Lax cookie, Secure with the existing production cookie configuration.
Generate it only when the guest starts the response workflow. Persist only its
SHA-256 digest. Derive a stable response ID from the event ID and secret digest.
The secret is never returned in JSON, URLs, logs or host projections. Existing
cookies for a different event cannot access this response.

The receipt authorizes reading, updating and withdrawing that response. It does
not prove the guest is a unique person. Clearing cookies or using another browser
may create another response and loses access to the old receipt. Explain this
before submission. Keep cookie scope and retention bounded to this workflow.
Provide `/invite/:eventId/response` as a separate receipt-management route so a
guest with the cookie can still inspect or withdraw their own response after the
public invitation is withdrawn. This route never reveals unpublished invitation
details and cannot start a new response while collection is unavailable.

Store response jobs under the event owner with the root event ID, so existing
event/owner cleanup removes them. No guest account is associated with these
records. Guest withdrawal deletes the response and clears the receipt after
successful removal; it remains available after collection closes or the invitation
is withdrawn while the event record still exists.

## Commands and concurrency

Use owner settings/read routes under `/events/:id/rsvp`. Public guest operations
use `/public/invitations/:id/rsvp`, with a separate prepare-session action.
The prepare action establishes or reuses the receipt cookie and returns a strict
snapshot with its opaque receipt ID. A write includes that expected ID, the saved
response version and the invitation publication revision the guest saw. Changed
cookies or invitation details force a reload before submission.

Serialize mutations under the existing owner account lock and recheck event
ownership, active publication, settings and stored response before writes.
Reject competing versions and recover identical immediate retries after a lost
reply. Respect the existing limitation that this lock is process-local, not a
distributed database transaction. Bound retained responses to 300 per event,
validate existing metadata before deriving totals and refuse incomplete or corrupt
projections rather than silently undercounting.

Rate-limit session preparation and writes without using caller-supplied identity
as authority. Use existing same-origin mutation protection. Owner routes reject
moderators and other owners. Public route responses contain only the requesting
receipt, current collection policy and required invitation revision.

## Interface and acceptance

The published invitation offers the optional response flow only when enabled.
Show the host-sharing notice, explicit acknowledgment, current saved response,
edit conflicts, closing state and withdrawal confirmation. A changed public page
or account context must not reveal another browser receipt. Abort pending reads
when leaving the route and prevent stale responses from reappearing.

The owner event RSVP panel shows enabled/closed state, deadline, party limit,
saved responses and real totals for going, maybe and not-going. Totals are labeled
as reported party sizes, not confirmed attendees. Filters must not change the
underlying total. Host removal is explicit and affects only the selected response.

Tests cover cookie attributes and event isolation, missing/wrong receipt secrets,
spoofed expected IDs, origin checks, literal text, explicit consent, replay and
competing changes, deadline/publication/ownership races, bounded capacity, corrupt
records, private host projection, withdrawal after closure and event cleanup.
Browser tests use real API handlers and cookies to verify persistence across
reloads, guest editing/withdrawal, owner totals, access denial and mobile layout.
The RSVP browser fixture serves the API and proxied Vite app from one local HTTP
origin. Cookie receipt and clearing therefore use browser-managed network
responses rather than intercepted response header simulation. The fixture checks
HttpOnly and SameSite on the actual response header and confirms persistence and
withdrawal in Chromium and mobile WebKit.
