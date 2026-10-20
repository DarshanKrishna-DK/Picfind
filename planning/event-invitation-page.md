# Published event invitation pages

An event host needs to share practical attendance information before photographs
are ready. Add a separate invitation page with explicit publication. Saving an
invitation draft must never publish it or grant access to event photographs.

## Domain and authorization

Store one `event-invitation-page` job per event, using a deterministic record ID,
owner ID and root event ID. Existing event/account cleanup includes the record.
The record holds a private draft and a nullable published snapshot. Both use the
same bounded fields: heading, host display name, local date, optional local time
and IANA timezone, venue name, address, guest instructions and one of three
predefined themes. No HTML, custom CSS, external media, contact database fields,
tracking pixels or arbitrary URLs are supported.

The owner can read and edit through `/api/events/:id/invitation-page`. A
versioned command performs `save`, `publish` or `withdraw`. Publishing copies
the submitted fields into both the draft and public snapshot. Saving updates
only the draft. Withdrawal clears the public snapshot while preserving the
saved draft and is allowed for archived or expired events. Exact immediate
retries recover a lost reply; stale commands fail with a conflict. Bound the
combined serialized state below the existing metadata storage limit.

Only an authenticated event owner may use the editor. Expected-account headers
detect account changes but do not confer authority. Reject moderators, guests,
other owners, deleted events and mismatched record ownership. Recheck the event
and version before writing under the existing process-local account lock.
This does not claim database compare-and-swap across application replicas.

`/api/public/invitations/:id` returns only the published fields,
publication revision and timestamp. It does not return the private draft,
owner identity, event description, photos, member list or client records.
Recheck publication and active event ownership immediately before responding.
Unpublished, withdrawn, archived, expired or deleted pages return unavailable.
Use the existing no-store response policy.

## Routes and interface

Add an owner event tab for invitation details and a public `/invite/:eventId`
route. The editor shows whether the saved draft differs from the published
version, separates local unsaved changes from saved state, and offers a local
preview. Publication requires an explicit confirmation that entered host and
venue information becomes readable by anyone with the link. Saving, publishing
and withdrawal report their actual resulting state.

The public page renders plain text, one predefined theme and the entered event
date/time with timezone. It offers no gallery bypass, RSVP promise or messaging
action. A published link does not enable gallery sharing. Withdrawal removes
server access immediately; already viewed or copied information cannot be
recalled. Refresh the public snapshot on focus and on a bounded interval, and
clear previously displayed information when the next read denies access.

The editor cancels pending operations when unmounted, clears private details
after access loss, preserves an unsaved draft after a version conflict and
requires confirmation before discarding changes on reload.

## Acceptance

Verify private-by-default behavior, saved draft isolation, explicit publication,
revision conflicts and identical retries, withdrawal on closed events, UTF-8
storage bounds, timezone/date validation, real moderator denial, ownership and
publication changes during reads, deletion cleanup and strict public projection.
Browser checks cover the owner-to-public workflow, local draft preview,
republication, withdrawal, denied access, stale drafts and account changes on
desktop and mobile. Inspect both public and editor layouts.

No production deployment, guest messaging, RSVP storage or automatic publication
is part of this feature.
