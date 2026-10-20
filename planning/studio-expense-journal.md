# Private photographer expense journal

## Outcome

Photographers can record their own expenses and refunds, optionally link them
to a private studio project, filter by date/category/project, compare totals
within each currency and export all matching records for bookkeeping.
These are manually entered records. They do not prove a payment, calculate tax,
create invoices, change a project stage or connect to a bank.

## Domain and authority

An owner-owned `studio-expense` job stores title, merchant, category, incurred
date, expense/refund direction, currency, positive integer minor units, optional
project ID and a bounded note/reference. Four supported currencies use two
minor-unit digits. Never combine currencies or invent exchange rates.
Refunds reduce the displayed net cost within their own currency; they are
separate records rather than mutations of an earlier expense.

Record IDs are stable for uncertain-write recovery. Each created record has a
random generation, numeric version and monotonic timestamps. Updates and deletes
must match generation/version. Exact command digests acknowledge committed
retries without duplicating a cost. Reused IDs cannot accept old commands.
Each payload stays below the existing private-record storage budget.

Only the authenticated owner can list, write, export or remove a record.
Expected-account headers detect session changes without granting authority.
Generic library lists exclude the private job purpose. Account erasure removes
the journal. Project deletion leaves the expense record as studio bookkeeping,
with the missing project clearly labeled and no retained client contact data.
New or edited links must resolve to a current owner-owned project. Archived
projects may receive costs; projects being removed may not.

## Routes and state

GET `/studio/expenses` returns a bounded page, complete filtered per-currency
totals and owner project choices. GET `/studio/expenses/export` returns every
matching row, not just the visible page. PUT and DELETE `/studio/expenses/:id`
use owner locks, current identity checks and strict command schemas.
Retain up to 500 entries per owner, with read/export/removal recovery through
1,000 records and an explicit repair error beyond that ceiling.

Filter by direction, category, date interval, project and bounded text search.
Sort by incurred date, creation time and ID for deterministic paging. Empty
views show no totals. Dates are calendar dates without timezone conversion.
CSV includes exact minor units, direction, source IDs and available project
names; escape formulas and preserve quoted/multiline notes.

## Interface and verification

Expose Expenses in the studio sidebar. Show the manual-entry explanation,
per-currency totals, filters, list, create/edit form and explicit removal.
Keep failed/stale drafts, confirm discard, isolate account state and disable
mutations or cached adoption after failed reads. Abort pending actions on
navigation; do not trigger a late export download.

Validate authentication, strict amounts/dates, currency-separated arithmetic,
complete exports, record limits, version/generation races, lost replies,
foreign/removed project links and account cleanup. Run real-API browser flows
on desktop and mobile, inspect screenshots, then review and merge only after
the final checks pass. No provider keys or production activation are involved.

## Verification evidence

The full repository check passed 143 test files and 2,308 tests, lint, type
checking and both builds. All 23 expense API tests and 18 real-API desktop
Chromium/mobile WebKit cases passed. Both create/refund workflows passed again
after adjusting editor scrolling and mobile filter widths. Screenshots were
inspected. Browser exports verify every row beyond the first page, and delayed
exports cannot download after navigation. Existing nonfatal build annotation
and bundle-size warnings remain. This is local verification; production
deployment and external provider settings are unchanged.
