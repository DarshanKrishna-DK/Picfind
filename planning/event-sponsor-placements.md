# Explicit sponsor placements for event highlights

## Outcome and domain

Event owners can prepare and deliberately publish a small ordered set of
sponsor credits on their curated highlights and live wall. This is the existing
roadmap's sponsor-placement outcome. It provides event-specific attribution
without a new advertising network, tracking service or payment workflow.

Use one private event-scoped job record with a draft, a separate published
snapshot, a bounded version and an exact-command retry digest. Up to six
placements contain a stable UUID, sponsor name, short caption and optional
validated HTTPS website. Every public placement is visibly labeled Sponsor.
There are no remote logos, pixels, scripts, autoplay or visitor identifiers.

The owner chooses gallery and wall visibility explicitly. Saving a draft keeps
the published snapshot unchanged. Publishing requires an explicit permission
confirmation for the currently reviewed draft. Withdrawal removes the published
snapshot while keeping the private draft available for repair.

## Authority and lifecycle

Owner-only GET/PUT routes under the event require a current authenticated actor,
the expected-actor header for writes, trusted origin, exact event ownership and
current version. Moderators and guests cannot inspect private drafts or publish.
Reject invalid or over-budget input before any write. Use the existing account
lock, with the documented process-local concurrency limit.

Public placements inherit the curated-highlights authorization boundary and
event availability. They are absent when highlights are unpublished, the event
is archived/expired/deleting, or the sponsor snapshot is withdrawn. Do not add a
separate public route that exposes credits for a closed event. Public projections
contain only published display fields and selected placement visibility.

Check source event and publication freshness before responding. Account and
event deletion remove the associated job through the existing cleanup path.
Existing highlight snapshots without sponsor records continue to work.
Public copies already saved by a viewer cannot be revoked. The live wall uses
its existing bounded refresh behavior to pick up withdrawals.

## Interface

Add an owner editor reachable from event tools, with reorder, add/remove,
explicit save/publish/withdraw and publication preview. Keep drafts when reads
fail or another version changes; block stale writes until the owner loads the
latest record. Hide private state on account or authorization changes.
Clear the permission confirmation when draft fields or placement settings change.

Render compact accessible sponsor cards in the public highlights view and wall,
using real links with safe external-link attributes. Do not imply that a sponsor
paid through PicFind or that a draft is publicly visible. Preserve empty and
photo-only highlight behavior.

## Validation

Cover owner/session/origin checks, draft/public separation, exact retries,
stale updates, data bounds, invalid websites, withdrawal and event/account
cleanup. Public tests cover expiry, archive, missing/corrupt records and changes
during reads. Browser tests cover publication, editing without republishing,
withdrawal, account changes and desktop/mobile layouts. No paid infrastructure
or production deployment is part of this feature.

## Implementation evidence

The owner editor, private draft, explicit publication snapshot and withdrawal
are implemented. Published credits appear after the selected photos in the
signed-in highlights gallery and on the existing freshness-gated wall.

Local validation passed: 60 sponsor/highlights API cases, 40 desktop Chromium
and mobile WebKit browser cases, and the full application check (147 test files,
2,409 tests, lint, typecheck and both application builds). Desktop/mobile
screenshots were inspected using synthetic fixture photos. These results do
not establish production provider readiness or deployment.
