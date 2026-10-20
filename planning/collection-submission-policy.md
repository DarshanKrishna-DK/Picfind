# Collection submission policy

Photographers can set a minimum and maximum number of final favorites and an
optional deadline for each named collection. This completes the count/deadline
part of the proofing state machine without changing guest request rules.

## Contract and authority

- Store `submissionPolicy` on the existing private proofing collection job:
  `{ minimum, maximum, closesAt }`. The compatible default is 0 to 100 favorites,
  with no deadline. Counts are integers, minimum is 0 to 100, maximum is 1 to 100,
  minimum cannot exceed maximum or the unique selected photo count at save.
- A deadline is null or a canonical UTC ISO timestamp. A past deadline is allowed
  so the owner can close final submissions. The collection editor shows the
  device time zone and rejects invalid local times.
- Existing owner collection POST/PATCH routes accept the optional policy.
  Omission on PATCH preserves it. Every edit increments the collection version.
  Client accounts and event moderators cannot edit it.
- Existing submission GET projects the policy, server-relative window and current
  saved favorite count. Submission POST validates the current policy immediately
  before persistence, after availability and version checks. At the deadline,
  new final submissions fail. Exact successful retries remain idempotent.
- Draft choices and private discussion remain available after the deadline.
  Reopening preserves the earlier round and does not extend the deadline.
  The owner must edit the collection deadline to allow another final submission.
- Earlier immutable submissions and exports remain readable under their existing
  permissions. Corrupt stored policy fails closed. A valid owner replacement can
  repair policy metadata through the existing versioned update route.

## Verification and operating limits

Exercise owner persistence and omitted-field updates, invalid and corrupt
metadata, count boundaries, deadline boundaries and expiry during the request,
stale collection versions, exact retries after closure, authorization, browser
editing, refresh and deadline hints. Use the existing process-local account lock.
This does not introduce a distributed transaction or strengthen the underlying
store concurrency contract. No external service, migration or credential is
required. Removing the new UI leaves server enforcement active; removing server
enforcement would reopen submission rules and is not a safe production rollback.
