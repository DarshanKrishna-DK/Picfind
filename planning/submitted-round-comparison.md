# Compare submitted proofing rounds

Photographers need to reconcile two clients' final album choices or compare
successive submitted rounds from one client. Draft decisions and guest selection
requests are separate workflows. This feature compares immutable submitted
snapshots within one named collection.

## Data, routes and permissions

- Reuse invitation records and immutable submission archives. Add no stored data.
- Owner-only GET
  `/events/:id/proofing-collections/:collectionId/submission-comparison`
  accepts two invitation IDs and two exact submission IDs. The owner may compare
  different rounds of one invitation, but cannot compare a submission with itself.
  Round identity is the invitation/submission pair. Current submissions can reuse
  a client-supplied UUID across different invitations; comparison must not assume
  global UUID uniqueness. Existing archive collision handling is unchanged.
- Resolve each chosen snapshot through the same validated history reader used by
  submission history. Match invitations to the event, owner and collection.
  Retained rounds remain available after invitation revocation or expiry, under
  the same owner permissions as existing history. Clients and moderators are denied.
- Read the photo inventory once and classify membership using stored photo IDs.
  Project only currently available collection photos. Duplicate filenames never
  collapse photo identity. Unavailable counts are per round, so a missing shared
  photo can be counted in both; do not sum them into a unique-photo claim.
- Return round identifiers, timestamps, counts and available photo IDs/filenames.
  Exclude emails, comments, final notes, face metadata and private photo notes.
  Reauthorize before returning; reject detectable collection, invitation or
  selected archive changes. Use the existing process-local owner lock, without
  claiming a distributed database snapshot.

## Interface and validation

The owner chooses an invitation and a submitted round for each side. The view
shows shared favorites, either-round-only photos or the union. Selecting a new
side clears the prior result. Comparison and CSV export perform fresh server
reads; denial removes displayed private results, and navigation aborts pending
work. CSV uses existing filename escaping and includes photo IDs.

Verify actual API authorization, retained history, snapshot identity, cross-event
and cross-collection denial, unavailable/deleting photos, duplicate names,
metadata corruption and changes during reads. Browser tests cover selection,
filters, reload, actual exported bytes, denied requests and cancellation.
There is no production deployment, new API key or database migration.
