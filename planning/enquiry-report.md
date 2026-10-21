# Private enquiry report

Add a complete, bounded owner report for retained session requests. Photographers
can filter by received date range (UTC calendar dates), follow-up stage and
session-type text, compare counts by stage and session type, and download the
matching rows as CSV. Counts describe enquiries, not unique people, bookings,
payments or a measured conversion funnel. Deleted enquiries are outside this
retained-record report.

Route `/studio/enquiry-report` accepts strict report filters and a contact
disclosure mode. Default responses contain enquiry ID, received/updated time,
requested session date, session type and current stage. Names, email and phone
are returned only after an explicit include-contacts choice. Messages, private
follow-up notes, consent evidence, handoff records and stage-history actors are
never part of this report.

Reuse the saved enquiry validation boundary. Bound source scanning and complete
retained enquiries to the existing recovery limit. Read and recheck selected
source records under the existing account lock, reject missing or changed
records rather than emit an incomplete successful report. Reject invalid dates,
reversed date ranges, duplicated identities and corrupted records. Foreign rows
never enter totals or exports. These checks do not provide a distributed
transaction across application processes.

Interface `/app/enquiry-report`, linked from the enquiry inbox. Account and
filters scope the query. Show generated time, retained total, matching count
and accessible count tables. Render a bounded page of row summaries while
exporting all matching records. Download performs another authorized read,
uses safe CSV escaping and formula neutralization, and cancels on navigation.
No external contact delivery, marketing subscription or CRM synchronization.

Validate date boundaries, report arithmetic, complete exports past the visible
page, default omission, explicit contact disclosure, formula-shaped input,
source failure/change, account isolation and export cancellation. Inspect the
report on desktop and mobile.

The initial browser run exposed a navigation timing race: a URL can change
before React unmount cleanup aborts an export. A shared URL-and-signal guard
now protects this report, project brief and event deadline downloads. A
deterministic regression changes the URL without triggering an unmount,
releases a held response and verifies that no file is saved and retry works.
The existing enquiry schema also now handles an empty damaged history as a
validation failure rather than throwing inside its refinement.

Verification: 35 report/enquiry API cases and 38 Chromium/mobile WebKit cases
across reports, production briefs and event deadlines passed. The full
application check passed lint, typecheck, 153 test files with 2,519 tests and
both builds. Desktop/mobile report screenshots were inspected. No production
deployment, external contact delivery or CRM synchronization occurred.
