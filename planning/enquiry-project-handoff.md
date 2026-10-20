# Recoverable enquiry-to-project handoff

## Outcome

An owner can turn a consented studio enquiry into a private project linked to
an existing client or a newly reviewed client contact. The owner reviews the
contact and project details before creation. The project starts at inquiry.
The operation never claims a booking, payment, contract or external message.

This completes the continuity between the existing enquiry inbox, client
directory and project workspace. It is one feature containing its persistence,
API, interface and recovery tests.

## State and authority

Keep a bounded handoff marker on the existing owner-owned enquiry record.
States are pending, completed and abandoned. Record a stable operation ID,
command digest, source fingerprint, planned client/project identities and
creation time. A completed or abandoned marker retains links and history
without permitting an accidental second conversion of the same enquiry.

Initial creation requires the exact source fingerprint from the preview and
the current enquiry revision. An existing client requires a complete reviewed
snapshot, current ownership and availability. A new client uses an owner-reviewed
name, email, phone and company with the existing email deduplication rules.
Project fields are a reviewed name and summary; no event access is added.

The owner account lock serializes supported writers. Store the pending marker
before creating either destination, use stable IDs and create-only writes, and
recover from failures after each write. A retry must recognize exactly the
planned existing record and never overwrite edits or recreate a deleted
destination silently. Enforce directory/project quotas before each new write.
Check the combined serialized enquiry and marker against the storage budget.

Recovery previews fingerprint the current marker and destination states.
Resuming requires that fingerprint. If a planned new record is missing, require
an explicit confirmation listing the missing destinations before creating it;
absence cannot distinguish an interrupted creation from a later deletion.
Never recreate a missing pre-existing client. Changed destinations require
abandonment and manual reconciliation. Exact completed-command retries return
the existing result without creating another revision or destination.

While pending, normal enquiry edits and removal are blocked with a recovery
message. The owner may resume or explicitly abandon the operation. Abandonment
retains any client/project already created and explains that those records
remain independently editable. Completed enquiry removal also preserves
legitimate client/project records. Account erasure removes all owned records.

Fresh source/marker identity checks precede each durable step. If a destination
was independently changed, fail closed with its current status and preserve
the new data. Do not delete created contacts or projects as an automatic
rollback. The underlying account locks remain process-local.

## Routes and interface

GET `/studio/enquiries/:id/handoff` returns an owner-only preview, source
fingerprint, client choices and any existing handoff state.
PUT on the same route accepts start, resume or abandon commands.

Expose the handoff from the selected enquiry and use a dedicated authenticated
page at `/app/enquiries/:id/handoff`. The preview shows the exact reviewed
contact and project fields. Preserve failed drafts, handle account changes,
offer explicit latest-data loading, and display pending recovery actions.
Completed/abandoned views link only to currently owned available destinations.

## Verification

Exercise foreign-source/client denial, stale source and client snapshots,
duplicate email and quotas, lost replies, failure after each durable write,
resume after reload, changed/deleted destinations, abandonment, source removal,
account cleanup and generic-library privacy. Browser tests use the actual API
for new/existing-client handoff and partial-write recovery. Keep the complete
PR below 5,000 changed lines, obtain Shipwright review and merge only after
final-head checks. No provider activation or deployment is part of this work.

## Verification evidence

The full repository check passed 145 test files and 2,361 tests, lint, type
checking and both builds. All 17 handoff API cases passed, including failures
before and after destination writes, explicit missing-record recovery, changed
destinations, quotas, combined storage budget and account erasure. The existing
enquiry and navigation suites passed alongside the handoff tests.

All 14 desktop Chromium/mobile WebKit cases passed. Four reuse/recovery cases
passed again after showing complete planned contact details; both creation
workflows passed with final layout assertions and screenshots inspected.
Formatting passes across every changed file. Existing nonfatal bundle-size
and build annotation warnings remain. This is local verification, not a
production activation or distributed transaction claim.
