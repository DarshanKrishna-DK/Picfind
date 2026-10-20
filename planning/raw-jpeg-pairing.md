# Local RAW to event JPEG pairing

Roadmap C26 connects a photographer's local RAW filenames with already uploaded
event JPEGs. It does not decode, upload or deliver RAW files. The owner opens an
Editing tab, selects files or a folder and reviews a bounded metadata workspace.
The browser reads name, relative path, size and modification time only.

## Identity and decisions

Limit selection to 500 entries and retain at most 100 supported RAW entries.
Report unsupported, empty and invalid paths rather than silently discarding them.
Relative paths distinguish identical filenames in separate folders. Reject
duplicate paths instead of guessing which file was intended. No absolute paths,
parent traversal or control characters enter a manifest.

Suggest JPEGs using a Unicode-normalized, case-insensitive basename without its
extension. Only one RAW and one available JPEG for that basename yields a
suggestion. The owner explicitly applies suggestions or chooses another JPEG.
Repeated names, missing candidates and edited filename suffixes require a
manual decision. Each JPEG can map to one active RAW entry. A skipped entry is
explicitly omitted from export.

Decisions preserve both photo ID and observed filename. A missing or renamed
JPEG invalidates a saved decision until reviewed. Filename equality never grants
access or proves that RAW/JPEG contents correspond.

## Persistence, routes and access

The workspace stays in memory. Download a versioned JSON mapping to preserve it,
then restore that file after a reload. JSON contains local paths and file metadata,
account/event scope and decisions, but no image bytes. The UI states this clearly.
Import validates the entire bounded schema and exact scope before replacing the
workspace. Loading another file or clearing requires discarding unsaved work.

Use the existing owner-authenticated event gallery route for current JPEGs.
Validate owner role, owner ID and exact event ID in its response. Moderators and
guests do not get the Editing workspace. A client-side file never authorizes a
gallery read. Account/event changes remount the workspace and abort pending work.

Before CSV export, fetch the current authorized gallery again and recompute every
decision. Require all entries to be resolved or explicitly skipped, with at least
one valid mapping. Refuse export on duplicate targets, deleted/expired/renamed
JPEGs or access failure. Clear displayed remote photo data when access fails.
Export raw relative path, size, modified time, photo ID and JPEG filename with
CSV formula neutralization and quoting. A JSON mapping remains an editable local
draft, not evidence that a JPEG is still authorized or retained.

## Acceptance and limits

Cover duplicate basenames in different folders, case/Unicode matching, unsupported
files, repeated paths, manual mismatches, duplicate targets, stale mappings,
corrupt/foreign JSON and CSV injection. Browser tests must prove manual conflict
resolution, mapping download/restore, fresh export denial and no RAW uploads.
The browser uses selected File metadata and never invokes image decoding.

No backend schema, model, provider, billing or deployment changes are needed.
This mapping does not replace edited files, infer visual similarity, create
Lightroom catalogs or claim content-level RAW/JPEG verification.
