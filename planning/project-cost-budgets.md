# Private project cost budgets

## Outcome

Photographers can save a planned cost ceiling for each supported currency and
compare it with the real expense/refund journal linked to the current project.
The report keeps currencies separate and shows expenses, refunds, net recorded
cost, remaining budget and over-budget amounts. It does not infer revenue,
profit, tax, payment status or accounting compliance.

One private project-scoped budget record stores up to four currency limits, a
short private note, a version, command digest and the source project's creation
identity. Zero is an intentional budget; an absent currency is unbudgeted.
No value is converted through an exchange rate. Reuse the existing exact
minor-unit parsing and currency definitions.

## Reference correctness

Expense records currently link projects by UUID. A deleted project UUID could
be recreated, so a financial summary must not silently attribute old expenses
to that new project. Bind new or explicitly updated expense links to the
project's server-read creation identity. Preserve that identity on subsequent
reads and exports. Current project names are shown only for a matching identity.

Legacy expense links without a creation identity remain visible in the journal
but require explicit review before they count against a current project budget.
The budget view reports their count separately. Do not silently rewrite old
records, discard expenses, assume a name match proves identity or change amounts.
The normal expense editor can confirm a reviewed current project link.

The implementation requires a separate explicit confirmation when an existing
expense retains the same project UUID but has an older or missing creation
identity. An unrelated edit cannot silently confirm that link. Exports retain
the recorded creation timestamp, and the journal continues to show historical
records even when they are excluded from a current budget.

## Authority and persistence

Owner-only project budget GET/PUT routes require an authenticated actor, trusted
origin and expected-actor header for writes. Validate current project ownership,
creation identity and removal state, bounded input and exact current version.
Use the existing account lock and document its process-local guarantee.
Exact retry of a committed command returns the committed version.

Read and validate the bounded expense journal, rejecting corrupt or over-limit
records instead of underreporting costs. Recheck project identity before
returning or saving. A read failure must not produce zero totals. Reports are
point-in-time snapshots, not transactions over multiple application instances.

Project deletion removes the private budget through the existing durable
project cleanup flow. Financial journal entries remain independent records;
their historical project identity is retained. Account erasure removes both.
A recreated UUID never inherits the old project's budget or verified costs.

## Interface and verification

Link a dedicated budget page from the project list. Show the project name,
per-currency comparison, unverified legacy-link count, current check time and a
link to the existing journal filtered to that project. Save budget limits and
notes explicitly. Preserve drafts after conflicts or failed reads and block
writes until refreshed; hide private state on account changes.

Cover exact minor-unit boundaries, refunds exceeding expenses, unbudgeted
currencies, stale updates, lost acknowledgements, project removal/recreation,
legacy links, foreign records, corrupt journal data and zero external provider
operations. Browser checks cover editing, reload, conflicts and account changes.
No billing provider changes, money movement or production deployment are included.

## Local evidence

The budget API and compatible expense journal passed 52 API tests. The budget
and expense browser suites passed 38 desktop Chromium/mobile WebKit cases.
The full application check passed with 148 test files and 2,439 tests, lint,
typecheck and both application builds.
Screenshots of the editor and currency comparison were inspected with synthetic
records. Tests use actual API handlers and isolated storage; no payment, storage
provider, face service or production deployment was activated.
