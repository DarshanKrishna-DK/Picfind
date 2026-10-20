# Event day readiness

Roadmap 60 gives the owner one read-only event preparation view. It reports
current gallery access, photo/storage metadata, imports, face matching and
curated highlights without treating a private or incomplete event as ready
for guests. Each section links to the existing operation that can resolve it.

The owner-only `/events/:id/readiness` projection uses the current event,
available owned event photos, relevant import roots and saved processing jobs.
It must not expose faces, private notes, filenames, source URLs, passcode hashes,
client records, raw provider errors or internal request IDs. No provider calls,
indexing, imports, publication or quota mutations occur during a readiness read.
The request binds the expected account and rechecks event ownership after the
asynchronous reads. Moderators and guests cannot read this owner view.

Counts distinguish photos currently available from expired/deleting photos.
Storage is the sum of valid saved photo byte counts, with an explicit unknown
metadata count. It is not the billing provider's remaining allowance.
Imports distinguish saved running/complete/partial/failed records and unavailable
worker status. Read worker metadata once for the owner and scope it before use.
An outage must be visible, never translated into no active work or ready.

Reuse the existing matching readiness calculation and its provider/version
checks. Curated highlights must have valid current metadata and available
referenced photos before their delivery section can report publication.
Gallery sharing and highlights remain independent. A published highlight set
does not imply that the full gallery is public.

The UI is an owner event tab with explicit refresh, checked time, scoped actions
and accessible counts. Refetch on focus, abort old requests, and hide the old
snapshot during refresh, errors or account changes. No background notification,
production deployment or automatic remediation is included.

Acceptance covers empty and private events, expiry/archive/deletion, missing
photo bytes, mixed model versions, pending/failed imports, worker outages,
unavailable highlight photos, foreign rows, moderator denial and ownership
changes during reads. Browser tests verify actual API projections, refresh
failure, account changes and actions to the appropriate existing event sections.
