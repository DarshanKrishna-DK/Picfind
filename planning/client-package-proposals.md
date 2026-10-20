# Client package proposals with immutable options and recorded preferences

## Outcome and boundaries

A photographer can prepare a project proposal from their private service catalog,
share it with one registered client and receive a recorded option preference or
decline. The client sees the exact package snapshot that was issued, even if the
photographer later edits the catalog. A preference is not a booking, signature,
contract, invoice, tax decision or payment. PicFind sends no external messages.

## Domain and authority

An owner-owned `studio-proposal` job stores the project ID, recipient account ID,
title, introduction, up to three copied service options, issue/expiry timestamps
and optional withdrawal timestamp. Service snapshots include their source ID and
version, title, bounded description/deliverables, duration and pricing fields.
Validate the total serialized payload against the private record budget before
creation. Reject archived services and mixed currencies when issuing options.

Choose the recipient from the project's current client record, resolve its email
to a registered account and bind the proposal to that account ID. Later client
directory edits never silently redirect an issued proposal. The owner must own
an available, unarchived project. Creating a proposal is explicit issuance:
options cannot be edited afterwards. Corrections require withdrawing the old
proposal and issuing a new one with a new ID.
Issuance includes expected project/client versions and selected catalog versions,
so a stale preparation screen cannot silently change recipient or pricing.
Each issued proposal also has a random generation identifier; recipient writes
must match it even if a removed proposal ID is deliberately reused.

The recipient owns a deterministic `proposal-response` job linked to the proposal,
photographer and project. It records a selected option ID or decline, an optional
bounded note, a version and timestamps. The recipient can revise the response
while the proposal accepts responses. Exact command retries recover lost replies.
The photographer has only the explicit owner-authorized projection of that
response, never general access to the recipient's library.

Take sorted photographer and recipient locks for issuing and responding.
Recheck proposal identity, expiry, withdrawal, project state and recipient under
the locks before mutation. Reads also validate current access and return a
minimal projection. A copied link alone grants no access. Do not infer that a
self-reported name is a verified identity.

Use the existing account/project child-cleanup protocol for both participant
accounts. Project/photographer removal must remove the recipient-owned response
under the same participant locks. Recipient account deletion removes their own
response and prevents recreation through an old session. Preserve established
questionnaire cleanup behavior and regression evidence while extending the
protocol to another scoped child type.

## Routes and state

Owner GET/PUT `/studio/projects/:projectId/proposals[/:id]` lists or issues;
POST `/:id/withdraw` closes future responses. Owner views include current
response projection and a shareable sign-in-aware URL.
DELETE `/:id` removes an expired or withdrawn proposal and its recipient-owned
response, with a removal marker protecting retryable cleanup. Retain at most
20 proposals per project and 200 per owner. Combined questionnaire and proposal
cleanup may acquire at most 401 sorted account locks, covering their two existing
200-record account budgets plus the owner.
Recipient GET `/proposals/:id` reads the scoped snapshot; PUT
`/proposals/:id/response` saves a preference or decline at the current version.

States are issued, responded, withdrawn or expired, derived from persisted
records and current time. Project archive closes future responses immediately.
Existing responses remain visible to the authorized participants until cleanup.
Counts reflect records, not bookings or revenue.

## Interface and verification

Expose proposals from the project page. Show the intended recipient, source
versions, exact copied prices and expiry before issuance. Require confirmation
before sharing. The recipient page displays package comparisons, unselected
choices by default, a response note and a clear non-booking explanation.
Preserve failed drafts, guard stale revisions, isolate account state, abort
late actions and support desktop/mobile layouts and sign-in return paths.

Verify immutable snapshots, wrong-recipient denial, changed project/client
access, expiry/withdrawal, exact retries, version conflicts, payload limits,
capacity recovery and participant cleanup races. Exercise real API-backed owner
issuance and recipient response in browser tests. No public publication,
provider keys or new deployment are required.

## Verification evidence

The full repository check passed 142 test files and 2,276 tests, lint, type
checking and both application builds. All 18 real-API browser cases passed on
desktop Chromium and mobile WebKit, covering issuance, lost replies, revision
conflicts, recipient/catalog changes, denied access, closure and removal.
Focused participant-cleanup tests also verify queued recipient writes, identity
changes during removal, damaged content cleanup and missing locks. The existing
questionnaire cleanup tests remain green.

Desktop and mobile screenshots were inspected. Choice controls were adjusted to
keep their labels beside their inputs, and package revision numbers are visible
in photographer previews. This is local verification; production providers and
deployment settings are unchanged. Shared account locks remain process-local.
