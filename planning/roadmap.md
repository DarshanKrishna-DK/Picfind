# PicFind delivery roadmap

The delivery target is at least 70 substantive, reviewed and merged PRs, within
the previously agreed ceiling of 100. These are candidate slices, not implemented
features or event-credit claims. Combine overlapping items, remove items already
satisfied by current source, and prioritize customer evidence.
Each implementation PR includes its necessary contract, persistence, authorization,
interface and tests rather than separating those layers to increase the count.
Each PR must remain below 5,000 added plus deleted lines. Track merged-and-reviewed
PRs separately from the leaderboard's "Pushed after review" count. Follow-up commits
must make real improvements; do not introduce defects or empty commits for credit.

## Product and authorization design

| Domain             | Records and routes                                                                                              | Authority                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Event delivery     | Existing event/photo/job records; `/app/events/:id` and `/api/events/:id/*`                                     | Existing owner/member policy, explicit action capabilities                         |
| Client proofing    | Existing selection jobs; later separate collection/invite/decision/revision records; `/app/events/:id/proofing` | Owner manages; invited client only sees own collection and allowed photos          |
| Studio             | Workspace, membership, brand, client, project; `/app/studio/*`                                                  | Workspace owner/admin, assigned photographer; guests never see CRM                 |
| Face processing    | Scope, model manifest, index generation, photo mapping, consent                                                 | Internal worker authorization; attendee searches authorized event only             |
| New-photo delivery | Event subscription, consent version, delivery attempt, suppression                                              | Verified recipient; event-scoped opt-in; withdrawal stops future attempts          |
| Contributions      | Upload invitation, contribution, moderation decision                                                            | Contributor uploads own items; moderator approves; public sees approved items only |
| Commerce           | Offer, order, entitlement, fulfillment, refund                                                                  | Server-authoritative state and signed provider events; no checkout-return grants   |

State machines:

- Index: queued -> extracting -> ready or partial/failed; generation activation is
  atomic; deleted/revoked scopes cannot reactivate on retry.
- Proofing collection: draft -> open -> submitted -> locked; explicit reopening
  creates a new revision. Deadline and count rules are server-enforced.
- Photo revision: uploaded -> processed -> review -> published -> superseded.
  Preserve stable selection identity, verify authorization for every rendition.
- Subscription: pending verification -> active -> withdrawn/expired. Delivery:
  queued -> sending -> sent or retryable/permanent failure; recheck suppression
  before external send.
- Contribution: quarantined -> approved/rejected -> removed. Approval controls
  both gallery visibility and live-wall delivery.
- Studio project: inquiry -> qualified -> booked -> shooting -> editing ->
  proofing -> delivered -> archived. Transitions do not invent paid status.

New schemas need explicit migration, rollback and private permissions. Existing
events need compatible defaults. Review lock/transaction guarantees before adding
multi-worker writes. Feature flags represent real deployment capabilities, not
buttons wired to success placeholders.

## Acceptance policy

Every candidate must have a demonstrable user/operator outcome, negative access
tests where relevant, durable behavior where it stores state, and a rollback or
disable path. No blanket parity claim. No promises of numerical accuracy,
unlimited storage or instant delivery without measurements. New external delivery,
payment, domain and production activation requires its actual provider setup.

## Ordered candidates

Within each wave, dependencies precede consumers. Later waves may move earlier
when independent and justified.

### A. Evidence and matching foundation

| ID  | Outcome and acceptance                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------ |
| 01  | Research, tool selection and architecture: source-linked evidence separates verified public behavior from hypotheses.          |
| 02  | Local inference evaluation: pinned YuNet/SFace artifacts, bounded smoke run and machine resource report; no production switch. |
| 03  | Consented matching evaluation: identity-disjoint fixtures and reproducible false-match/miss reports.                           |
| 04  | Provider/version-aware scopes: reject incompatible model/index combinations and preserve existing AWS scopes.                  |
| 05  | Local extraction worker: bounded validated images, single-face references, stable per-photo face mappings.                     |
| 06  | Private local index persistence: event isolation, restart recovery and deletion verified.                                      |
| 07  | Scoped local search: calibrated cosine threshold, result caps and denied cross-event queries.                                  |
| 08  | Provider consent UX: correct processing location and explicit local-only behavior on failure.                                  |
| 09  | Reindex migration: resumable batches, atomic activation and rollback without partial gallery exposure.                         |
| 10  | Matching readiness dashboard: real model/index state and actionable failures, with restricted diagnostic details.              |

### B. Photographer proofing

| ID  | Outcome and acceptance                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------- |
| 11  | Selection filename export: authorized available photos export to editor-friendly TXT/CSV without private review notes. |
| 12  | Named proofing collections: persistent album/retouching rounds isolated within an event.                               |
| 13  | Client invitations: expiring/revocable collection access without granting organizer access.                            |
| 14  | Saved client decisions: favorites/maybe/rejected states survive reload and remain client-scoped.                       |
| 15  | Selection count rules: exact/min/max limits validated on submission, with useful remaining-count feedback.             |
| 16  | Proofing deadlines: server-authoritative closing/reopening with clear timezone display.                                |
| 17  | Photo comments: private client-photographer discussion bound to accessible photos.                                     |
| 18  | Final submission revision: immutable submitted set, explicit amendments and concurrent-edit handling.                  |
| 19  | Multi-client comparison: authorized overlap/difference view without sharing private comments between clients.          |
| 20  | Retouching fulfillment: track requested/completed/delivered photo revisions and audit changes.                         |

### C. Ingest and editing continuity

| ID  | Outcome and acceptance                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------ |
| 21  | Resumable direct uploads: interruption/retry does not duplicate storage or grants.                           |
| 22  | Folder hierarchy ingest: deliberate collection mapping and unsupported-file report.                          |
| 23  | Upload queue controls: pause/resume/cancel persists across safe restart.                                     |
| 24  | Photographer upload-only invitation: second shooter can contribute without reading client/billing data.      |
| 25  | Edited-file replacement: stable photo identity, version history and revoked old access where necessary.      |
| 26  | RAW/JPEG pairing: explicit filename mapping and ambiguous-pair resolution; RAW never delivered accidentally. |
| 27  | Local watched-folder helper: bounded, authenticated, deduplicated uploads with disconnect handling.          |
| 28  | Import dry-run: real counts, duplicates, access and estimated storage before commitment.                     |
| 29  | Source reconciliation: removed source files follow explicit retention rules without destructive surprises.   |
| 30  | Ingest recovery center: failed items can be retried or skipped without replaying completed work.             |

### D. Gallery delivery

| ID  | Outcome and acceptance                                                                             |
| --- | -------------------------------------------------------------------------------------------------- |
| 31  | Persistent gallery sections: order, cover and visibility enforced for media and exports.           |
| 32  | Brand profiles: reusable logo/color/contact identity, validated uploads and safe URLs.             |
| 33  | Watermarked previews: deterministic derivatives, original access independent of preview policy.    |
| 34  | Download permissions: separate preview/original/bulk rights enforced server-side.                  |
| 35  | Durable archive export: cancelable bounded ZIP jobs and expiring authorized download.              |
| 36  | Photographer attribution: contributor credit survives exports and revised photos.                  |
| 37  | Curated highlights: explicit public subset independent of private face matches.                    |
| 38  | Gallery expiry workflow: warnings, extension eligibility and immediate access denial after expiry. |
| 39  | Video delivery: bounded formats/transcoding/storage and supported accessible playback.             |
| 40  | Custom domain delivery: verified ownership, TLS, tenant routing and takeover prevention.           |

### E. Attendee experience

| ID  | Outcome and acceptance                                                                                |
| --- | ----------------------------------------------------------------------------------------------------- |
| 41  | Camera quality guidance: actionable single-face/lighting guidance without retaining rejected selfies. |
| 42  | Persistent opt-in receipts: event, purpose, provider/version and withdrawal path recorded.            |
| 43  | Event-only subscription: explicit retained-reference choice distinct from one-time search consent.    |
| 44  | Verified email delivery: ownership verification, scoped links, expiry and abuse limits.               |
| 45  | New-photo digest worker: idempotent notifications and suppression recheck before send.                |
| 46  | WhatsApp delivery adapter: verified templates, recipient opt-in and provider retry handling.          |
| 47  | Attendee privacy controls: remove subscription/reference and confirm actual cleanup state.            |
| 48  | False-match feedback: remove/report result privately and preserve minimal audit evidence.             |
| 49  | Accessible no-match recovery: recapture and manual help path without broadening gallery access.       |
| 50  | Event language support: localized core attendee flow with equivalent consent meaning.                 |

### F. Live event participation

| ID  | Outcome and acceptance                                                                             |
| --- | -------------------------------------------------------------------------------------------------- |
| 51  | Guest contribution invitations: scoped quotas, expiry and uploader receipt.                        |
| 52  | Contribution quarantine: validate files and hold them outside public galleries.                    |
| 53  | Moderation inbox: approve/reject/remove with auditable actor and race-safe visibility.             |
| 54  | Live photo wall: approved highlights only, reconnect and removal propagation.                      |
| 55  | Guest messages/captions: bounded sanitization, moderation and accessible display.                  |
| 56  | Event invitation page: persisted host information and theme choices with clear publication.        |
| 57  | RSVP flow: duplicate-safe responses and private organizer totals.                                  |
| 58  | Sponsor placements: labeled placements with event-specific authorization and expiry.               |
| 59  | Printable QR packs: correct reachable links, accessible fallback URL and scan verification.        |
| 60  | Event day readiness view: storage/import/matching/delivery status and useful intervention actions. |

### G. Photographer studio

| ID  | Outcome and acceptance                                                                         |
| --- | ---------------------------------------------------------------------------------------------- |
| 61  | Studio workspaces: private organization records and explicit ownership lifecycle.              |
| 62  | Workspace invitations/roles: least privilege and immediate removal effects.                    |
| 63  | Client directory: minimal contact records with deduplication and export/deletion.              |
| 64  | Studio projects: link clients, events and stage history without duplicating private galleries. |
| 65  | Lead enquiry form: spam controls, consent and durable inbox state.                             |
| 66  | Lead pipeline: assignments and conversion history with real counts.                            |
| 67  | Questionnaires: versioned schema, client-scoped response and export.                           |
| 68  | Proposals: versioned options and auditable acceptance without auto-granting payment rights.    |
| 69  | Scheduling: availability, timezone and double-booking prevention.                              |
| 70  | Studio work queue: overdue proofing, editing and delivery tasks based on real records.         |

### H. Sustainable commerce

| ID  | Outcome and acceptance                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------- |
| 71  | Photographer service invoices: explicit issuer/currency/tax inputs and immutable issued versions.                |
| 72  | Payment links for invoices: supported provider boundary and webhook reconciliation.                              |
| 73  | Income/expense ledger: source attribution and export without inventing accounting compliance.                    |
| 74  | Contract workflow: versioned document/signature evidence after legal/provider decision.                          |
| 75  | Digital photo offers: authorized price/rights definitions and preview separation.                                |
| 76  | Purchase entitlements: verified payment grants only, refund/revocation tested.                                   |
| 77  | Download fulfillment: order-bound access, retry and support history.                                             |
| 78  | Print provider feasibility/integration: catalog, order validation and real sandbox evidence before activation.   |
| 79  | Print fulfillment tracking: idempotent provider updates, failure handling and customer status.                   |
| 80  | Photographer payout/reconciliation: supported commercial arrangement and auditable money movement before launch. |

### I. Culling and intelligent assistance

| ID  | Outcome and acceptance                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------- |
| 81  | Exact duplicate assistant: hash-based groups with reversible selections, never automatic original deletion.            |
| 82  | Similar-shot groups: measured visual similarity and human override.                                                    |
| 83  | Blur suggestions: calibrated scores, explanations and opt-out on artistic images.                                      |
| 84  | Closed-eye suggestions: quality assistance only; no emotion/demographic inference.                                     |
| 85  | Culling review workspace: offline decisions and explicit export, bounded memory.                                       |
| 86  | Culling sensitivity presets: reproducible model/version settings and undo.                                             |
| 87  | Local-to-event handoff: selected upload manifest and duplicate-safe resume.                                            |
| 88  | Search by scene/object: licensed model evaluation, separate from identity matching.                                    |
| 89  | Photographer vendor sets: manually reviewable curated subsets with scoped links.                                       |
| 90  | Coverage assistance: missing delivery tasks/photo categories from explicit labels, no fabricated attendance inference. |

### J. Reliability and growth

| ID  | Outcome and acceptance                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------- |
| 91  | Measured delivery funnel: deduplicated events with privacy-aware aggregation and no inflated counters.               |
| 92  | Storage forecast: originals/derivatives/index/archive accounting and actionable quota warnings.                      |
| 93  | Provider cost budget: enforceable bounded work and estimates labeled as estimates.                                   |
| 94  | Cleanup recovery: deletion tombstones, retries and evidence after worker restart.                                    |
| 95  | Backup restore drill: isolated restoration with access/retention verification.                                       |
| 96  | Public API credentials: scoped keys, rotation, revocation and rate limits.                                           |
| 97  | Outbound webhooks: signed events, replay-safe retries and delivery inspection.                                       |
| 98  | Photographer portfolio: explicitly published selections and private defaults.                                        |
| 99  | Export/migration bundle: portable originals, metadata and client decisions under authorization.                      |
| 100 | Production capacity/release evidence: realistic load, accessibility, incident drill and documented activation gates. |

## Priority and metrics

Start with A01, B11 and A02. Then validate matching (A03-A10) and deepen proofing
(B12-B20) before large CRM or commerce expansion. Prioritize recovery over more
integrations if ingest evidence is weak.

Measure time from upload to usable delivery, failed jobs recovered, selected-photo
handoff time, verified attendee receipt, false-match reports and retained-data
cleanup. Do not treat page views or count of PRs as product quality.
