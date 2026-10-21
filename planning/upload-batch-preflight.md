# Read-only upload batch preflight

## User outcome

A photographer with a saved upload batch can check its current destination
before starting or resuming. The report distinguishes exact-input uploads
already committed in that destination from files that may need new photo slots.
This addresses lost acknowledgements and full-capacity retries without uploading
bytes, reserving storage, invoking image processing or changing queue state.

The existing queue already hashes supported local files and deduplicates
identical inputs. This feature consumes those fingerprints. It does not repeat
the local file picker inspection or claim to validate image contents remotely.

## Contract and authority

Add an authenticated read-only POST endpoint for a bounded batch of at most
100 unique item IDs, input SHA-256 fingerprints and byte sizes. Require an
expected-actor header and the existing trusted-origin checks. An event target
must be currently owned by that actor and open for imports. Personal targets
belong to the current actor. Cross-owner, scan and other-event photos never
count as reusable or disclose identities.

The report includes account and destination identity, checked-at time, request
fingerprint, per-item reuse/new classification, selected input byte totals and
current photo-slot limits. Use the same photo availability and safety-capacity
rules as actual upload. Re-fetch reusable candidates and the destination before
returning a report so stale list results do not report removed records as
recoverable. Propagate operational read failures rather than guessing.

Do not promise sufficient paid storage from original byte sizes. Server image
processing can change stored byte counts, and another upload can consume
capacity after the check. Explicitly mark output-byte requirements and billing
reservation as unverified. Exact-input reuse is the only confirmed reuse;
normalized-image duplicates require processing during the real upload.

No mutation, upload, provider call, billing reservation or queue completion
occurs in preflight. A report is informational, not an upload authorization.
Current upload checks remain authoritative.

## Interface and lifecycle

Provide one reusable batch-check component for saved direct and folder queues.
Submit unfinished queue items only. Bind the component to account, destination
and the complete inspected queue revision. Queue changes clear the report and
abort old requests. Account changes remount private state. Failed refreshes hide
old results. During active upload or another-tab queue work, disable inspection.

The report explains current photo-slot fit, exact-input retries, new candidates,
original input bytes and unverified final storage. It must not mark uploads
complete or bypass reselecting original files. Event collaborators can still use
the existing upload workflow; owner-only capacity inspection must explain an
authorization denial without exposing the event owner's private library totals.

## Verification

API cases cover owner/session/origin binding, malformed/oversized batches,
cross-destination isolation, expired/deleting photos, full-capacity replay,
mixed batches, stale candidate and event reads, read failures, and zero store/
file/billing mutations. Browser cases cover direct and folder queues, stable
results, stale revision cancellation, failed refresh, account changes and
continued normal upload behavior. Keep the feature below 5,000 changed lines.

## Implementation findings

Opening an already-saved direct queue exposed a startup lock race: React
remounting could let the disposed startup instance contend with its replacement
and incorrectly display another-tab ownership. The folder importer already
defers startup and checks the current controller. Apply that same lifecycle
guard to direct queues. Direct queues also refresh session identity on every
window focus, matching folder queues, so an external account change hides the
previous private batch and its preflight report promptly.

The focused API suite passes 24 cases, including deleted-account rejection and
production accounting failure. All 42 Chromium/mobile WebKit cases across
preflight, existing saved-upload queues and folder imports pass. Desktop and
mobile report screenshots were inspected. The endpoint performs no file read,
image processing, storage write, billing reservation or queue-state mutation.
Final output storage remains explicitly unverified.

The full application run passed lint, type checking, 146 test files and 2,387
tests. Its production API build then exposed an extensionless shared import
that had previously been used only by the browser. Adding the required `.js`
extension in the upload-queue module fixed Node ESM resolution. Both application
builds and the 43 affected preflight/upload-queue tests passed after that fix.
Existing nonfatal bundle-size and annotation warnings remain.
