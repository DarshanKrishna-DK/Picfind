# Reusable photographer credits and bounded batch updates

## Outcome

Photographers currently edit attribution one photo at a time. Add a private
directory of reusable credit presets and a complete select, preview, apply and
retry workflow. Reuse the existing attribution fields, publication rules and
download manifests. This is attribution management, not a new gallery theme or
an automatic public profile.

## Domain, routes and authority

A `photographer-credit-preset` owner-owned job stores a UUID, label, credit name,
optional HTTPS website, version, timestamps and exact command digest. Keep at
most 20 presets per account. A preset never stores a publication setting and is
excluded from generic library job projections. Account deletion removes it with
other owned jobs. Deleting or changing a preset does not rewrite existing photos.

Owner-only `/studio/credit-presets` list/create/update/delete routes use current
versions, exact lost-reply retry and process-local account locks. Expected actor
headers detect account changes; the authenticated session remains authoritative.
Presets contain no secrets, third-party images or executable brand content.

Add a bounded `/photos/attribution-preview` read operation accepting 1 to 100
distinct photo IDs and the proposed credit fields. It returns current versions,
filenames and credits only after the existing owner/photo/event checks. Reuse
those checks and strict saved-credit parsing through a small shared access
module. Bound concurrent reads to four and recheck ownership before projecting.
Moderators, clients and public guests cannot manage these owner credits.

Existing per-photo PATCH remains the mutation boundary. Add optional expected
actor checking there and on its GET without changing current consumers. Every
write reauthorizes the photo and event, compares the saved version, and retains
the existing exact-value immediate retry. No bulk request bypasses that policy.

## Interface and states

Use `/app/credits` with navigation from the studio. Query and mutation state is
account-scoped. A preset editor supports create, update, explicit deletion and
reload without silently discarding unsaved edits.

The batch editor selects up to 100 current owned library photos, with event and
filename filters. Copying a preset fills name/website only. Publication is an
explicit separate choice, defaulting to private. Preserve existing nonempty
credits by default; replacing them requires an explicit option.

State: selection/draft -> preview -> applying -> complete, stopped or failed.
Preview shows exact filenames, current and proposed values, unchanged rows and
preserved rows. Changing inputs or selection invalidates preview. Applying locks
the controls and uses the previewed photo IDs and versions in a sequential,
bounded loop. Each success is recorded in visible progress. Failure stops the
loop, preserving the request for an explicit retry; committed writes are not
replayed unnecessarily. A lost reply can safely retry the same photo command.
Cancellation stops further requests and states that completed changes remain.
Navigation aborts pending requests and never applies late UI results.

No automatic changes on upload or preset save, no background processing, no
external communication, no new provider key and no infrastructure activation.
These account locks coordinate one process, not distributed transactions.

## Evidence required

Test owner/account isolation, private preset projection, capacity recovery,
stale versions, exact retries, account cleanup and invalid URLs. Keep all existing
single-photo attribution and download tests passing. Prove preview bounds,
ownership changes, event closure and corrupt metadata denial. Browser tests cover
preset persistence, default preservation, explicit replacement/publication,
preview invalidation, partial failure, lost replies, cancellation and account
changes on desktop and mobile.

## Verified implementation

The full repository check passed: 135 test files and 2,142 tests, lint,
type checking and both builds. The focused attribution, preset and navigation
checks passed 100 tests. All 20 Chromium and mobile WebKit workflow cases passed.
They include default preservation, explicit replacement, cancellation, partial
failure, a committed write with a lost reply, newer-edit conflicts, account
changes and navigation during a request. Desktop and mobile layouts were
inspected with horizontal overflow checks. Existing nonfatal bundle-size
warnings remain. No production provider or infrastructure was activated.

Shipwright questioned whether PUT coerces version strings while DELETE does
not. Both use strict `z.number()` validation. Three API regressions now verify
that string, null and boolean versions are rejected by both methods, leave
the saved preset unchanged, and still permit subsequent numeric updates and
deletion. No coercion mismatch was reproduced.
