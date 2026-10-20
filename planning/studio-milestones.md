# Dated studio milestones and work queue

Roadmap 70 builds an actionable owner work queue from persisted project
milestones. A photographer creates a named milestone for an owned, active
project, records a calendar due date and IANA timezone, and marks it complete
or reopens it. These are private work records, not client notifications or
proof that files were delivered.

A deadline is due through the end of the stated calendar day in its stored
timezone. It becomes overdue only when the local calendar date in that zone
advances past the due date. Evaluate dates with Intl timezone parts rather than
adding a fixed twenty-four-hour duration across daylight-saving changes.
The editor defaults to the device timezone and displays that choice explicitly.
Stored timezone and date survive a device or timezone change.

Use owner-only `studio-milestone` job records with a project ID, stable UUID,
strict bounded fields, optimistic version, creation/update times and completion
time. Keep at most thirty milestones per project and three hundred per account.
Creation and edits require the current owned, non-archived project. A completed
milestone can be reopened explicitly. Exact immediate retries must not duplicate
a record or change completion time.

`/app/work` supports open, overdue and completed filters, project filtering,
search, create/edit/complete/reopen and explicit removal. Counts come from the
authorized persisted projection. Archived projects suppress overdue alerts but
retain their milestone records; restore makes their current deadlines relevant
again. Missing/foreign project metadata must not expose another account's name.
New requests bind the expected browser account, and denied responses hide cached
private work.

Removing an archived project first revalidates its version and persists a
removal-started timestamp. This durable intent blocks edits and restoration,
and is visible as removal pending in Projects. Only then remove its owned
milestone records, checking the parent intent before each deletion. If child
cleanup fails, keep the marked parent so a retry can finish the remaining
cleanup. An already absent parent after an authorized removal is success,
not a misleading late conflict. Do not delete photos, contacts,
invitations or jobs of another purpose. Existing account cleanup continues to
cover all retained owner records.

The API uses the existing account lock and create-only insert. Multiple API
writers still require database CAS before activation. The UI must preserve
conflicting drafts and offer explicit reload. Overdue display refreshes at a
bounded interval and after focus/visibility changes; it is not a background
notification service.

Acceptance includes timezone midnight boundaries, DST dates, leap-day
validation, foreign/archived project denial, concurrent edits, exact retry,
complete/reopen lifecycle, cleanup failure recovery, quota, account changes and
desktop/mobile browser flows against actual API handlers with synthetic storage.
No external email, WhatsApp, calendar connection or production deployment is
part of this feature.
