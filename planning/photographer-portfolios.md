# Explicit photographer portfolio publication

## Outcome

A photographer can prepare one private portfolio, select up to 24 photographs
from their owned event library, add captions and studio information, and
explicitly publish a shareable page. Visitors can view the published selection
without gaining access to the source galleries, face matches, clients or notes.
The portfolio does not claim verified credentials or fabricated testimonials.

## Records and authority

An owner-owned `studio-portfolio` job has a deterministic per-owner ID, private
draft fields, a separate immutable publication snapshot, numeric revision,
timestamps and command digest. Fields include display name, tagline, biography,
location text, optional HTTPS website, theme and ordered photo/caption pairs.
Validate complete UTF-8 budgets for both draft and stored snapshots.

Save affects only the draft. Publish copies the submitted draft into a new
public snapshot after an explicit permission-to-share acknowledgement. Withdraw
removes the publication while retaining the draft. Exact retries acknowledge
committed commands; stale versions cannot overwrite later changes. All owner
mutations use the existing account lock and fresh identity/source checks.

Photos must belong to the same owner, belong to an available owned event, have
no scan association or deletion markers, and satisfy photo/event retention.
Private face-search and scan images are never eligible. Publication is an
explicit public grant for only the selected processed library photographs.
Private source gallery access rules remain unchanged.

Anonymous reads return only the published profile, captions and available
selected photographs. No private draft, event title, internal filename, client
data, face IDs, notes or command digest appears in that projection. Source
ownership, expiry, archive, deletion and publication are rechecked for media
requests and after asynchronous file retrieval. Existing media delivery performs
egress accounting and current-photo validation; portfolio routes must reuse it.
The normal ingestion pipeline already creates processed JPEG files.

Withdrawn portfolios and denied media return a uniform unavailable response.
Photo removal or source-event closure immediately removes that image from
future portfolio reads. Account deletion removes the portfolio job. A browser
cannot revoke copies a visitor already downloaded, which the publish UI states.

## Routes and states

GET `/studio/portfolio` reads the private draft and current publication.
PUT `/studio/portfolio` accepts save, publish or withdraw at an expected
revision. GET `/studio/portfolio/photos` provides paginated eligible owner
choices with real totals and bounded text search.
GET `/public/portfolios/:id` serves the minimal publication projection.
GET `/public/portfolios/:id/photos/:photoId` authorizes only a currently selected
available image, including HEAD and download requests.

The editor at `/app/portfolio` previews the draft, supports ordering/removing
photos, shows unavailable selections, preserves failed/stale drafts and requires
confirmation before publishing or discarding changes. `/portfolio/:id` renders
the public snapshot and safe external links. Draft changes never silently alter
the live page.

## Verification

Test cross-account denial, explicit publication, private draft isolation,
caption ordering, safe URLs, source photo/event expiry and deletion, anonymous
media gating, final file-delivery races, lost replies and account cleanup.
Exercise owner and anonymous browser flows with the actual Express router.
Review the complete feature below 5,000 changed lines and merge only after
Shipwright review and final-head checks. No deployment or provider activation
is authorized by this implementation alone.

## Implementation evidence

The full repository check passed 144 test files and 2,334 tests, lint, type
checking and both builds. A final concurrent-writer regression then passed
with all 25 portfolio API tests. All 16 desktop Chromium/mobile WebKit cases
passed. The two publication workflows passed again with final layout and
horizontal-overflow assertions; editor and public-page screenshots inspected.

Coverage includes anonymous publication, private draft isolation, consent
reset after edits, lost publication replies, stale drafts, failed refreshes,
account changes, unavailable selections, paginated choices, withdrawal during
file retrieval, source ownership changes and account erasure. Public media
uses the existing accounted delivery helper and rejects attachment query
parameters that would expose private source filenames. No provider activation,
external messages or production deployment occurred.

Shipwright follow-up bounds selected-photo reads to batches of eight while
retaining both publication freshness passes and ordered results. Tests verify
the concurrency ceiling and all 24 selections. Initial storage authorization
denials now receive the same unavailable response on both anonymous routes;
operational storage failures remain visible as service failures.

The reported gap between initial media authorization and the route photo read
was tested directly. Withdrawal and expiry in that interval both return 404
before any file fetch, because the delivery helper authorizes again. Existing
tests also cover withdrawal and ownership changes during file retrieval.
All 31 portfolio API tests, all 16 desktop/mobile browser cases, type checking
and focused lint passed after these review improvements.
