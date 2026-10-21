# Reusable private coverage templates

## Outcome

Photographers can save the categories in a coverage draft as a reusable private
template and apply a reviewed template to another event. Templates contain
category labels, target counts and notes only. They never copy photo identities,
assignments, availability, event access or inferred completion.

## Model and authority

An owner-scoped `coverage-template` job stores a stable UUID, a server-generated
generation, numeric version, title, up to twenty ordered category definitions,
creation/update timestamps and exact-command digest. Limit each owner to thirty
templates and bound the complete UTF-8 payload below the storage limit.
Labels are unique after normalization. Empty templates are rejected.

Private list, save and delete routes live under `/studio/coverage-templates`.
Require the current session, trusted origin, expected-actor header on writes,
exact scope, version and generation. An immediate retry of a committed write
returns its saved generation/version. Deleting and recreating a UUID cannot
accept an old update or deletion command. Account erasure removes templates;
event removal keeps them because they are independent studio records.

Read failures and damaged metadata block selection instead of showing an empty
successful template library. Existing account locks serialize one application
process; they do not provide distributed compare-and-swap.

## Event editor

Place the template controls within the owner coverage editor. Saving a template
copies the current draft category definitions and requires an explicit name.
The existing event plan remains unchanged until its normal Save plan action.
Selecting a template shows its exact categories and targets before application.
Append is allowed only when the resulting draft passes existing coverage bounds
and label uniqueness. Replace requires confirmation and clears prior assignments
only in the local draft. Every imported category receives a fresh UUID and an
empty photo list. The owner must save the resulting event plan explicitly.

Keep template operations and event writes separate in the interface. Preserve
names and drafts on errors, block stale operations, abort pending work on
unmount and hide private records after an account change. Removing a template
does not alter any event that already used it.

## Verification

Test owner/session/origin/header boundaries, payload and quota limits, exact
retries, stale and recreated identities, damaged records, account cleanup,
event independence and zero file/provider calls. Desktop/mobile journeys cover
saving from a real coverage draft, applying to another event without copying
photo assignments, append conflicts, confirmed replacement, explicit event save,
template removal, failed refresh and account changes.

Before applying a selected template, re-read its exact owner-scoped record and
compare the reviewed generation/version/content. Lock the event draft during
that read so a delayed response cannot replace edits made meanwhile. A failed
or changed template read preserves the existing draft and requires refresh.

## Local evidence

The template and existing coverage APIs passed 47 tests. Their browser suites
passed 28 cases across desktop Chromium and mobile WebKit, including copying
definitions to a second event, independent explicit plan saves, confirmed
replacement, exact create/update retries, changed-read rejection and cancelled
application after navigation. Desktop/mobile template screenshots were
inspected. Fixtures use synthetic storage and images with actual API handlers.
The full application check passed with 149 test files and 2,467 tests, lint,
typecheck and both application builds.
No production deployment or external provider activation is implied.
