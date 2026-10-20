# Collection invitations

An owner grants an existing, verified PicFind account read access to one named
collection for 1 to 30 days. The owner copies the invitation URL and sends it
through their chosen channel. Creating an invitation does not send email.
The URL is an identifier, not a bearer credential: the recipient must sign in
to the account resolved from the supplied email.

Each invitation is a private job record containing owner, event, collection,
recipient account ID, recipient email, creation/expiry timestamps and optional
revocation timestamp. It has no event membership or organizer authority.
An event can retain at most 100 invitation records. Expired/revoked invitations
remain visible to the owner; no automatic cleanup or unlimited history is claimed.

Owner routes list, create and revoke invitations under
`/events/:id/proofing-collections/:collectionId/invitations`.
Recipient routes read `/proofing-invitations/:invitationId` and its
`/photos/:photoId` endpoint. Responses project only collection title, event title,
invitation expiry and currently available selected photo metadata. Private notes,
face IDs, other collections, other clients and internal owner metadata are omitted.

Invitations refer to the current saved collection. Later owner edits change the
accessible set. Private event visibility and public passcodes do not block this
explicit account grant. Event archive, expiry or deletion, collection deletion,
invitation expiry/revocation and photo removal/expiry stop future access.
Every media request rechecks the grant and current photo membership after storage
reads, before returning bytes. Delivery uses the existing metered path; storage
egress already performed remains accounted if access is revoked during the read.
Downloaded or already displayed bytes cannot be recalled.

Create and revoke use the existing process-local owner lock. This is not a new
distributed transaction guarantee. Creation rechecks the event and collection
after account lookup. Event erasure removes invitation jobs through the existing
event cleanup. Rollback removes the new routes and UI, immediately disabling
recipient access without altering photos. No database schema migration is needed.

The owner collection card reveals an invitation panel on demand. The recipient
page survives sign-in and reload, shows a restricted gallery and explicit access
errors, and periodically revalidates access. Saved decisions, comments and final
submission are separate workflows.
