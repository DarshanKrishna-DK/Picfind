# Private project appointments

Roadmap 69 starts with the photographer's own durable schedule. A private
appointment links one owned active project, has a title, optional bounded note,
start/end instants, the timezone used to enter them, and scheduled/cancelled state.
This is an internal booking record, not a client confirmation or an external
calendar reservation.

Keep at most thirty retained appointments per project and three hundred per
account. Supported local dates run from 2000 through 2100, and an interval can
last at most seven days. This is a local-calendar bound: a valid timezone offset
may place the corresponding UTC instant in late 1999 or early 2101.
Record timestamps are nondecreasing server record times;
version is the ordering authority, not a claim of an independently verified clock.

An owner cannot save overlapping scheduled appointments. Use half-open intervals
so one booking may start exactly when another ends. Check all retained scheduled
records, including those whose projects were later archived, because archiving
the project does not cancel a real reservation. Explicit cancellation releases
the slot, including when the linked project becomes unavailable. That exception
permits only cancellation with unchanged appointment details. Restore checks
overlap and current project access again. Version checks, exact command retry and
the existing account lock apply; multi-writer activation still needs database CAS.
The cancel action uses saved details, not an unsaved editor draft. Both stored
and incoming fields use the same trimming rules before the cancellation-only
comparison. Invalid retained appointment metadata blocks overlap decisions:
silently ignoring it could admit a second reservation into an occupied slot.

Store UTC instants and the original IANA timezone. The editor accepts local date
and time in that zone. Nonexistent daylight-saving times are rejected. Ambiguous
times require choosing one of the valid UTC-offset occurrences rather than
silently selecting an hour. Display both the entered timezone and the resolved
instant before save. Date/time validation and conversion must be shared by API
and browser.

Use private job records with bounded counts, owner/account guards, project
authorization rechecks and explicit remove confirmation. Appointments cannot be
moved to another project after creation. A project pending removal cannot accept
new bookings. Confirmed project removal cleans up its appointments through the
existing durable removal intent; partial cleanup remains resumable.

The private schedule supports day/range and status filters, project selection,
create/edit/cancel/restore/remove, conflict-preserving drafts and explicit reload.
It does not send invitations, accept public bookings, infer photographer
availability beyond saved reservations or connect an external calendar.

Acceptance includes DST gaps and repeated hours, fractional timezone offsets,
adjacent and overlapping intervals, concurrency, cancellation/restore, exact
retry, unavailable projects, account changes, quota, cleanup recovery and actual
API browser flows on desktop and mobile.
