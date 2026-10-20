# Saved client proofing decisions

An invited client can mark each currently available collection photo Favorite,
Maybe or Reject, or clear the choice. Choices are drafts, not a final submission
or approval of purchased work. Each invitation owns its own decision set, so
clients cannot see or change another client's choices.

Decision entries, version and update timestamp live on the existing invitation
JSON record. An untouched invitation has version zero. A write includes the
last observed version and changes one photo. It executes under the owner's
existing process-local lock, rechecks active invitation and photo membership,
and increments the version. Revocation and decision writes share that lock.
No distributed compare-and-swap guarantee is introduced.

Recipient GET/PATCH routes use `/proofing-invitations/:invitationId/decisions`.
The client receives only currently selected, available photos and their choices.
The owner can read the same projection under the collection invitation's
`/decisions` route, including after invitation expiry/revocation, while the event
and collection still exist. Other recipients and moderators are denied.

Choices for photos removed from the collection or made unavailable are counted
but not exposed. The next successful change prunes those entries. Both views
explain this rule; there is no claim of immutable history. Each saved set is
bounded by the collection's 100-photo limit. Malformed stored choices or versions
fail closed with a repair error, rather than silently overwriting them.

The client page shows saved counts and a filter for undecided/favorite/maybe/
rejected photos. Each change waits for server confirmation. A stale version
returns a conflict, keeps the current server state intact and requires refresh
before retry. Access errors hide cached content. The photographer expands an
individual invitation to see current choices and filenames, with explicit
empty/unavailable states. No private photo notes enter either projection.

Rollback removes the decision routes and controls without changing photos.
Event erasure removes the parent invitation and therefore its decision data.
No external provider, credential, schema migration or deployment is required.
