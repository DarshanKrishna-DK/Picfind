# Matching readiness acceptance

The event owner needs to distinguish saved face preparation from upload count,
current processing progress, and gallery access. A completed historical batch
does not prove that newly uploaded photos are searchable.

## Contract and access

`GET /api/events/:id/processing` adds an optional-compatible `readiness`
snapshot. Existing owner authorization runs before reading photos and jobs.
Guests, moderators, other owners and anonymous users do not gain access.
No new persistence, migration, provider request, file read or usage charge is
introduced. Counts derive from the current event photos, excluding personal
scans, expired photos and photos being deleted.

Prepared, no searchable faces, waiting, failed and needs review are disjoint
photo counts. Uncertain attempts are a subset, never another total. Ready
records need the existing provider and external-image mapping; incompatible
or incomplete records require review. Model versions are saved metadata,
not a compatibility guarantee or live provider health check.

Closed event states take precedence over matching readiness. Configured search
and background preparation are separate: a disabled worker does not erase
saved results. A private event can be fully prepared without allowing guests.
The dashboard explains these differences and refreshes through a read-only GET.
Failed refreshes hide stale diagnostics and disable preparation until recovery.
Photo-count changes and processing completion refresh the saved snapshot.

## Validation and limits

Unit tests cover state precedence, exclusive counts, uncertain retries, missing
metadata, runtime availability and scope/expiry/deletion exclusions. Integration
tests verify owner-only access, live metadata updates and no provider/file calls
on reads. Browser coverage verifies refresh, mobile fit, failure recovery and
zero processing submissions from readiness controls.

This is an operator snapshot. It does not measure recognition accuracy, guarantee
a guest match, enable local inference, or prove current remote-provider health.
