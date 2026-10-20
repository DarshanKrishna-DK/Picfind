# Selection count rules

Photographers set a minimum and maximum number of unique photos per submission,
from 1 to 100. Equal values require an exact count. Existing events default to
1 through 100, and existing submissions remain unchanged.

The owner-only `PATCH /events/:id/selection-rules` endpoint persists optional
`selectionMinimum` and `selectionMaximum` metadata on the existing event record.
The production billing event transaction preserves the new metadata; the
Appwrite library stores it in the existing JSON payload. No new table, index,
credential or model is required.

The signed-in, passcode-protected gallery access response publishes only count
rules alongside existing presentation fields. Submission validates the current
event policy under the existing owner lock, after deduplicating requested photo
IDs and before storing the request. Gallery ownership, retention, passcode and
photo-membership checks continue to apply. Invalid persisted rules block guest
submissions while owner insights and policy repair remain available.

Guest controls show the required count and remaining/removal feedback. A policy
change discovered on submission refreshes the rules without clearing the
selection. These are per-request limits, not a verified per-person quota.
Owner updates follow the existing last-write-wins event settings contract.
Rules apply at server validation time; a policy change does not retroactively
invalidate a saved request. The owner must choose a minimum the gallery can
satisfy as photos are added, expire or are deleted.

Verification uses synthetic persistence and browser fixtures: unauthorized
updates, invalid ranges, unique-photo counting, changed rules, preserved old
requests, corrupted-policy repair, billing transaction persistence and reload.
