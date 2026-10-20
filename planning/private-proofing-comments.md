# Private client photo discussion

Each invitation has its own client-photographer discussion. Messages are separate
private library jobs with owner, event, invitation, photo, author, role, text and
creation time. Internal photographer notes remain separate. No message is sent
by email or exposed through a public gallery, moderator view or another client's
invitation.

Client routes are `/proofing-invitations/:invitationId/comments`; owner routes
are `/events/:id/proofing-collections/:collectionId/invitations/:invitationId/comments`.
GET returns available collection photos and their messages. POST accepts a
client-generated message UUID, photo UUID and bounded plain text. Repeating the
same UUID and content returns the existing message; conflicting reuse fails.
DELETE `/:commentId` removes the author's own text, or lets the owner moderate
the discussion, retaining a minimal removed-message marker. Removal cannot be
undone by retrying an earlier create.

An active invitation and event are required to post. The actual invited account
can read and remove its own messages only while access remains active. Owners
can read retained discussion and remove text after invitation expiry/revocation.
Both views suppress unavailable or removed collection photos. Membership as an
event moderator grants no discussion access. Every operation resolves persisted
records and account identity; mutation authorization is rechecked inside the
existing account lock. The lock is process-local, not a distributed transaction.
Exclusive creation prevents two different messages from replacing one UUID.

Each invitation retains at most 100 messages, including removal markers, across
all its photos. Each message has at most 1,000 text characters and fits the
existing library payload budget. Photo removal hides discussion for that photo.
Collection deletion makes the invitation and discussion inaccessible. Existing
event deletion removes associated jobs; no new retention promise is introduced.

The interface loads discussion on demand, scopes queries and drafts to the signed
account and invitation, renders text without HTML, preserves drafts on ordinary
errors, and hides cached discussion after denied requests. A refresh fetches
persisted server state. There are no optimistic message or delivery claims.
Tests cover isolation, retries, limits, removal, revocation and browser reload.
