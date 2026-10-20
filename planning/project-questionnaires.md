# Client preparation questionnaires

## Outcome and authority

A photographer needs a structured preparation brief from a client before a shoot.
Add bounded project questionnaires addressed to an existing verified PicFind
account, using the same account-lookup capability as proofing invitations.
Copyable links require the assigned account to sign in. Creating a questionnaire
does not send a message or grant access to the project, client directory or photos.

This completes one workflow: the owner issues an immutable set of questions, the
client saves a private draft and explicitly submits it, the owner reads or exports
the submitted brief, and either side can end the relevant access or remove data.
Do not present the form as a contract, signature or identity verification.

## Domain and persistence

Use an owner-owned `studio-questionnaire` job linked to a studio project. Store a
title, introduction, 1 to 10 uniquely identified text questions with required
flags, assigned account ID and email, expiry, version, timestamps and a command
digest. Enforce a UTF-8 payload budget as well as individual text bounds. Limit
retained forms to 20 per project and 200 per owner. Creation uses a caller-stable
UUID and an exact retry digest. Questions and recipient remain immutable after
issue; use an explicit new questionnaire for corrected questions or another round.

Store answers in a separate `questionnaire-response` job owned by the recipient,
with a deterministic form/account ID, photographer/project/form references,
bounded answers, version, timestamps, draft/submitted state, command digest and
submission consent. Private drafts are visible only to the recipient. Owner
projections include answers only after an explicit final submission. Submitted
responses are immutable; withdrawal deletes the response.

Owning the answer record lets recipient account deletion remove their answers
through the existing owned-job cleanup. Photographer/project/form deletion must
also remove the corresponding recipient-owned response through a strictly scoped
cleanup helper. Never scan or delete unrelated records from the recipient account.

## State and lifecycle

Form: open -> expired or revoked -> removal pending -> removed.
An archived project closes new submissions but keeps retained owner review and
recipient withdrawal available. Removal intent is persisted before deleting a
response or form, so failures leave a retryable closed state.

Response: absent -> draft -> submitted, with explicit withdrawal from either
saved state. Required answers and a versioned sharing acknowledgment are enforced
on submit. A lost reply permits the identical immediate retry. Stale tabs cannot
overwrite or withdraw newer answers. After expiry/revocation, the assigned client
can still read and withdraw their retained response without gaining project data.

Each newly created response has a random generation identifier in addition to its
version. Writes and withdrawal compare both, so a stale tab cannot edit or delete
a replacement response whose version restarted after withdrawal. Recipient
account deletion removes their answers; the photographer retains the issued form
and assigned email until form, project or photographer account removal.

All form/response writes acquire the unique participating account IDs in a stable
sorted order. Never nest recipient locking under an already held owner lock:
two photographers can invite each other, and opposite acquisition orders would
deadlock. Extend the existing queue-backed locking primitive without changing its
single-account behavior.

Before project or photographer account cleanup, collect the affected form
recipients, then acquire the owner plus those recipients in sorted order. Reread
the form list inside the locks and refuse/retry if it introduces an unlocked
recipient. Only then persist removal intent or delete records. Scoped response
cleanup receives the already locked account set and never reacquires a lock.
Recipient account deletion removes its own response jobs normally.

Account cleanup runs its existing billing and credential guards under the owner
lock before any participant discovery read. It repeats these idempotent guards
inside the full sorted lock set, so a change during lock reacquisition cannot
skip the deletion checks. A rejected initial guard never begins library discovery.

Cleanup may lock an already deleted recipient account to remove its stale
references, but the acting owner must remain active. New creation/answer writes
must reject any deleted participating account. Test reciprocal invitations and
concurrent account/project removal directly. Account deletion guards, fresh
parent/form/response reads and final identity checks remain required. These
locks are process-local, not distributed database transactions.

## Routes and interface

Owner routes under `/studio/projects/:projectId/questionnaires` list, issue,
revoke and remove forms. The project editor links to a dedicated questionnaire
page. It includes question editing before issue, recipient/expiry validation,
copyable invitation links, retained statuses, explicit removal confirmation and
submitted-only review/export.

Recipient routes under `/questionnaires/:id` and `/questionnaires/:id/response`
require the assigned signed-in account and an expected-actor header. The browser
page preserves the full sign-in return path, keys all private state by account
and questionnaire, aborts on navigation, hides details after denial and confirms
discarding unsaved edits on reload. Explain that drafts are private and final
submission shares answers with the photographer. Warn against entering sensitive
personal details. Exports cannot be recalled after withdrawal.

No public form listing, account enumeration, external delivery or provider
activation is included. Rate-limit creation and recipient writes. Exclude both
new purposes from generic library job projections.

## Verification

Prove owner/recipient/other-account isolation and private-draft exclusion at the
API and interface. Test strict question/answer IDs, required answers, byte limits,
capacity recovery, exact retries, stale versions, expiry/revocation/archive races,
changed account headers and safe export escaping. Test deletion failures and
retry, recipient account deletion, photographer account deletion and durable
project cleanup with unrelated recipient records preserved. Exercise the full
issue, sign-in, draft, submit, owner review and withdrawal flow on desktop/mobile.

## Local evidence

Full lint, typecheck, 133 test files with 2,115 tests, and both builds passed.
All 20 focused Chromium and mobile WebKit cases passed. The full workflow then
passed again on both browsers with header-clearance and horizontal-overflow
assertions; the client and owner screenshots were inspected. Independent account,
billing and source-connection tests retain their original assertions. An initial
full run exposed discovery before deletion guards; the final implementation
restores those guards before reads and repeats them after acquiring all locks.

Locks coordinate one API process. These tests do not establish distributed
transactions, live Appwrite account lookup or a production deployment. Existing
non-fatal Zod annotation and frontend chunk-size build warnings remain.
