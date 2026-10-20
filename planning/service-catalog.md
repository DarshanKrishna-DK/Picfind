# Private photographer service catalog

## Outcome

Let photographers maintain reusable session packages, their deliverables and
their own indicative prices. They can archive an old package without losing its
details and download a freshly authorized catalog for their own planning.
This prepares explicit package choices for later proposals. It does not create
a public offer, invoice, booking, payment, tax calculation or client acceptance.

## Domain and authorization

Each owner-owned `studio-service` job contains a UUID, title, description, up to
20 deliverables, optional session duration, pricing mode, currency and integer
minor-unit amount, archive flag, version and timestamps. Pricing modes are
fixed, starting at and request a quote. Quote-only packages store no amount.
Supported currencies are INR, USD, EUR and GBP, each with two minor-unit digits.
The entered amount has no implied tax treatment.

Limit each account to 200 retained services. Archived services count towards
that limit; owners can export and explicitly remove them to recover capacity.
Text and complete UTF-8 payload limits fit existing private Appwrite records.
No uploaded logo, external URL, provider credential or new storage is needed.

Owner GET `/studio/services` returns a paginated, filtered catalog with real
total/filtered counts. PUT `/studio/services/:id` creates or updates a service
using a numeric optimistic version and an exact retry digest. DELETE removes an
archived service at its current version. An expected actor header detects a
changed session, while server authentication remains the authority.

All writes take the existing account lock and recheck the current record before
mutation. Validate stored identities, purpose, timestamps and deletion markers.
Generic library lists exclude the private records, and account cleanup removes
them. The existing single-process lock is not a distributed transaction.

GET `/studio/services/export` returns the complete authorized filtered catalog
within the retained-record budget. CSV uses explicit currency, minor units,
pricing mode, archive state and version, escapes spreadsheet formulas, and
preserves quoted multiline descriptions and deliverables. Export never silently
uses a stale page or omits later pages.

## Interface and state

Add `/app/services` to the studio navigation. Include paginated active, archived
and all views, search, a new-service editor, editable deliverables, pricing mode
and duration. Parse decimal input without floating-point currency arithmetic.
Quote-only mode clears the amount before saving.

Preserve drafts after failed saves and refreshes. Show changed versions and
require explicit discard before loading latest or changing selection. Recover
lost write replies without duplicate records. Hide the entire private view on
denied access, abort on navigation and keep account-keyed state isolated.
Archiving is reversible; removal requires an archived record and confirmation.

## Verification

Exercise strict schemas, currency parsing, payload budgets, stale updates,
exact retries, malformed stored rows, account isolation, deletion, archive
capacity recovery, full filtered export, formula escaping and account erasure.
Browser coverage must include create/edit/reload, quote pricing, archive/restore,
lost replies, dirty navigation, stale/outage recovery, denied writes, pagination
and a real downloaded CSV on desktop and mobile.

## Verified implementation

The focused suite passes 91 currency, API and navigation tests. All 18 browser
cases pass across desktop Chromium and mobile WebKit, including archive/restore,
same-selection draft protection, uncertain saves, stale and failed reads,
changed accounts, complete multi-page CSV download and canceled late exports.
Both desktop and mobile editor screenshots were inspected.

Browser failures identified stale inactive-view caches after restoration and
late downloads during navigation. Mutations now invalidate every saved catalog
view for the account, and completion handlers verify their initiating location
before producing side effects. The regression cases pass with these fixes.

Full repository validation passes 140 test files with 2,239 tests, lint, type
checking and API/web builds. Existing nonfatal dependency annotation and bundle
size warnings remain. No production deployment or provider activation occurred.
