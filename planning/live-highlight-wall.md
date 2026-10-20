# Live highlight wall

Roadmap F54 adds a projection view for the owner's deliberately published
highlights. `/highlights/:eventId/wall` is a signed-in destination linked from
the highlights gallery. It uses the same highlight metadata and scoped photo
endpoint, so it grants no additional publication or photo access.

The wall begins paused. The viewer can start or pause a slideshow, select a
5, 10 or 15 second interval, move backwards or forwards, and request fullscreen
from an explicit button. Published photographer credit appears with the photo.
The interface displays the current position and a refresh action. It renders
one image at a time without prefetching the private event or other galleries.
It uses no image transitions or animation that require motion to follow.

Metadata refreshes every 15 seconds while visible. A failed refresh, offline
event, hidden document, expired freshness window or failed image load blanks
the photo and pauses playback. A successful refresh can restore the view but
never resumes a paused slideshow automatically. Returning to a visible tab
requires a fresh successful response before images are shown. An image load
failure requires a refresh before trying again.
Each metadata request aborts after ten seconds so an unresponsive connection
does not leave the refresh control disabled indefinitely.

The last successful metadata response is usable for at most 45 seconds, with
a local deadline independent of query-library offline retry behavior. This is
a bounded display freshness policy, not a promise of immediate revocation of
already downloaded pixels. Every new photo request still reauthorizes current
publication and selected-photo membership on the API. Withdrawal or removal
is reflected on the next successful refresh; denied refreshes hide old data.
The owner can withdraw the set through the existing editor.
The expiry timer updates React state, so it does not depend on a later fetch or
user interaction to hide stale content. Browser timers remain subject to
JavaScript scheduling; hidden tabs are blanked separately on visibility change.
The standalone wall owns a main landmark and back link instead of the public
navigation and footer.

Selection tracks photo identity across refreshed ordering. If the current
photo disappears, the first available selection is shown and playback pauses.
No selection produces an explicit empty state. Fullscreen failure leaves the
ordinary wall usable with an explanatory status. No persistent browser storage,
guest contribution upload, unreviewed-photo ingestion or deployment is added.

Browser acceptance must exercise slideshow start/pause, identity preservation,
removed-photo handling, failed and recovered refresh, offline/visibility
freshness, fullscreen failure and authentication return to the wall. Existing
API tests remain authoritative for publication and media access.
