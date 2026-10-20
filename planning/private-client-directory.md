# Private photographer client directory

Roadmap 63 adds a personal client directory at `/app/clients`. A photographer
can create, edit, search, export and delete explicitly entered contacts. A
contact is organizational data, not a PicFind account, invitation, consent to
marketing, or permission to view an event. No messages are sent and no address
book is imported.

Each contact uses a private `job` metadata record with purpose `studio-client`,
an owner, a stable client-generated UUID, a creation time and a versioned strict
payload. Fields are name, optional email, phone and company. There are at most
200 contacts per owner; each field and serialized record are bounded. Contact
records never appear in ordinary library, processing, guest or member payloads.
Account cleanup already removes owner job records. Deleting a contact removes
the retained contact record without changing unrelated galleries or invitations.

`GET /studio/clients` returns only the authenticated owner's valid contacts.
`PUT /studio/clients/:id` creates at version zero or updates a matching current
version. An exact replay of the immediately preceding write returns that result.
`DELETE /studio/clients/:id` requires its current version. Requests never accept
an owner ID. Foreign IDs and records with another purpose are unavailable.
All mutations require the existing trusted-origin/session checks.

Email is optional. For nonempty addresses, case-insensitive equality detects a
duplicate within the current owner directory; name-only contacts may share a
name. The directory uses the existing account lock and create-only insert for
write serialization in the current single API process. It does not add a
distributed transaction guarantee. Multiple API writers require a database
uniqueness/CAS design before activation.

The editor preserves an unsaved draft on conflicts and offers an explicit reload.
Account changes remount the editor and cancel pending reads/downloads. Initial
read failures and account access errors hide directory data. Export reads the current authorized directory rather
than a cached list, uses fixed CSV columns and filename, and neutralizes formula
prefixes while quoting CSV syntax. Contacts remain private on the device once
exported, and deletion cannot revoke an already downloaded CSV.

The legacy development Drive import quota must count only imports, including
legacy jobs with no purpose, so private contact records do not consume it.
No Appwrite collection migration or new external provider is required.

Acceptance covers persistence across reads, cross-owner and wrong-purpose
denial, duplicate detection, concurrent edits, retry recovery, capacity,
malformed stored records, export authorization/escaping, deletion, and browser
create/edit/search/reload/conflict/export flows. Synthetic tests do not establish
production deployment or successful messaging integrations.
