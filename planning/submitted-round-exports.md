# Export submitted rounds for editing

An owner can read final client favorites, but transferring an exact submitted
round into an editor still requires copying filenames by hand. Add TXT and CSV
downloads to current and archived submitted rounds in the owner history panel.

The existing owner submission GET is the authority. Each export performs a fresh
request and finds the same immutable submission UUID in either the current round
or history. Do not export cached filenames, current draft decisions or a different
round. The filename includes the round number and submission UUID.

Use the existing filename serializer: CSV includes photo IDs, quotes filenames and
neutralizes spreadsheet formulas. TXT rejects filenames containing line breaks
and directs the owner to CSV. Duplicate filenames produce a warning. Only current
available photo projections enter the file. Notes, client identity, account IDs,
private instructions and face data are excluded.

If photos disappeared, report the omitted count. An empty or missing submission,
lost access, storage failure or a conflict produces no download. Recheck access
errors through the parent history query so stale history disappears. Cancel the
request on unmount and prevent duplicate export clicks while it runs.

No new persistence, server privilege or network destination is added. Client
submission pages do not expose the owner export controls. Browser verification
must inspect downloaded contents and cover archived rounds, refreshed availability,
special filenames, failures, denied access and interrupted navigation. Existing
serializer tests and API authorization tests remain in force.
