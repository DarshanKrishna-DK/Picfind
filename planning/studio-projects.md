# Private photographer projects

Roadmap 64 connects the client directory and event work without copying private
galleries or client contact details into project records. `/app/projects` lets
the owner create and update a named project, choose an optional saved client,
link up to twenty owned events, and track its current stage.

Stages are inquiry, booked, shooting, editing, proofing, delivered and archived.
These are owner-entered work labels. They do not establish a signed contract,
payment, publication or actual file delivery. Moving backward, or restoring an
archived project, requires a short reason. Each stage change retains an actor,
time, previous/next stage and reason. Show up to the most recent thirty transitions,
with the total transition count so older omitted entries are explicit.
The history window also respects the metadata byte budget; long Unicode reasons
can shorten the retained window. The newest transition is always retained.

Use private `studio-project` job records with owner ID, stable UUID and a strict
versioned payload. Limit two hundred projects per owner and enforce a serialized
payload budget below the existing Appwrite metadata limit. All mutations use
the existing account lock, expected-account header, optimistic version and
create-only insert. Exact immediate retries must not add a transition.
Distributed CAS/uniqueness remains an activation requirement for multiple
API writers; this feature does not promise a new transaction primitive.

The API validates all newly selected client and event references against the
same owner, with at most four concurrent reference reads in each validation
pass. The second pass retains fresh reads after the first asynchronous batch;
it is not a distributed transaction. Unchanged references require no new
validation reads during a metadata-only edit.
Event moderators cannot attach an event they do not own. It stores
IDs only and resolves current names through safe owner projections. Deleted
contacts/events render as unavailable. A previously valid unavailable reference
may be removed or left unchanged so the owner can still finish or archive work;
it cannot be introduced in a new project. No guest or event member can read a
project through gallery, library or processing projections.
The picker returns at most two hundred client names and five hundred event
names. Already linked IDs remain visible even outside that choice window.

The editor keeps drafts during conflicts, provides explicit reload, supports
search and stage filtering, and shows actual recent transition history.
Account errors hide private data. Archived projects remain retained and
searchable; archiving never deletes event photos, invitations or contacts.
An explicit, versioned removal action deletes only an already archived project
record, allowing the owner to reclaim directory capacity without removing
linked contacts or events. Overcapacity reads remain bounded and state the total.

Acceptance includes cross-owner links, moderator denial, unavailable reference
handling, stale updates, retry idempotency, stage history bounds, backward-change
reasons, account isolation, persistence and browser create/edit/filter flows.
There is no public client portal, notification, invoice or deployment in this
slice.
