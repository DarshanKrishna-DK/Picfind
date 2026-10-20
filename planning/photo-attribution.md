# Photographer credit in galleries and downloaded archives

Roadmap D36 adds owner-controlled photo attribution. A retained photo stores a
versioned credit name, optional HTTPS website, explicit publication flag and
update time. Existing photos start with no credit. Account names and moderator
identities are never automatically published.

The owner edits credit from the photo detail panel. GET/PATCH
`/photos/:id/attribution` independently require photo ownership and available
retention. Event photos also require the same retained owner event. Reads may
inspect an archived event, but publishing requires an open event. Clearing or
withdrawing credit is an explicit save. Optimistic versions reject stale edits;
an exact retry of the immediately preceding change returns the saved state.
Existing process-local account locks remain a limitation for multiple writers.

Public gallery projections and collaborator views expose only a validated,
published credit name and website. Draft credit and revision metadata stay in
the owner editor. Invalid stored attribution is omitted from public output and
requires repair before editing. A safe HTTPS website has no embedded credentials;
the server never fetches it. External links use noreferrer and noopener.

Authorized photo delivery projects the latest published attribution into a
bounded encoded response header. It rechecks the photo identity and availability
before setting that header. ZIP assembly uses these delivered headers, not a
cached gallery credit, and adds a quoted, formula-neutralized `credits.csv` with
archive filename, photo ID, original filename, credit name and website. No
sidecar is produced if none of the downloaded photos has published attribution.
The sidecar counts toward the existing aggregate archive byte limit.

Original JPEG bytes remain unchanged. An individual JPEG download does not embed
credit into EXIF or pixels. Existing downloaded copies cannot be recalled after
withdrawal. The gallery detail shows the published credit; ZIP delivery provides
the portable attribution artifact.

Tests must cover ownership, moderator/guest denial, invalid names/URLs/versions,
retries and intervening edits, metadata preservation, withdrawal, private/public
projection, changing photo state, header encoding, malformed headers, duplicate
archive filenames, CSV safety, aggregate limits and cancellation. Browser
acceptance covers saved/reloaded credit, stale-edit recovery and a real ZIP
containing current published attribution.

The existing private Appwrite payload stores attribution without a schema
migration. No provider calls, billing plan changes or deployment are included.
