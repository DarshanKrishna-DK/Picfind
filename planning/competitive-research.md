# PicFind competitive research

Research date: 2026-10-20. This is public product/workflow analysis, not access to
competitor source repositories, private APIs, accounts, or infrastructure.

## Evidence and limits

REA inspected the live DOM/accessibility of SnapShare home/pricing, Kwikpic Events,
Premagic photo distribution, Kululu, Pic-Time AI search and Pixieset. Evidence IDs,
capture windows and coverage limitations are in [rea-evidence.json](rea-evidence.json).
SnapShare static analysis parsed 27 scripts without parse failures. Next.js was
inferred with high confidence and React with medium confidence. `/getCountry`
is a static endpoint candidate. This does not establish their database, face model,
authorization behavior, performance, or backend architecture.

Only public flows and official documentation were inspected. Signed-in upload,
payment, notification and deletion behavior are unverified. Marketing accuracy,
speed, usage and compliance claims are not independent measurements.
The live pricing page includes Spark, unlike the search-index snapshot. Do not
encode transient plan names or unverified prices in PicFind.

## SnapShare feature coverage

The [pricing catalog](https://snapshare.ai/pricing) advertises:

| Area           | Advertised scope                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Galleries      | Full-resolution delivery, video storage/embeds, layouts, folder covers, analytics, subdomains, domain branding, download restrictions and face filtering.                   |
| Desktop ingest | Multiple folders, queued batches, wake prevention, pause/resume, retries, watched folders, compression and access controls.                                                 |
| Proofing       | Invitations, PIN/public collections, favorites/maybe, counts, deadlines, multiple clients, selected downloads, RAW sync and filename exports.                               |
| Invitations    | Theme/color choices, host details and attendance responses.                                                                                                                 |
| Studio         | Leads/forms, proposals, questionnaires, invoices, tracking and income/expense records.                                                                                      |
| Brand          | Brand profiles, logos, descriptions, contact information, portfolio galleries and enquiry forms.                                                                            |
| Delivery       | Face registration, matching subsequent uploads and new-photo alerts.                                                                                                        |
| Culling        | Similar images, blur, closed eyes, adjustable sensitivity, offline processing and suggested selections.                                                                     |
| Announced      | Lightroom integration, proofing comments, custom invitation websites, contracts, payment integration and website/portfolio builders have coming-soon labels in the catalog. |

Plan availability varies. An advertised capability is not a verified implementation.
The [culling page](https://snapshare.ai/ai-photo-culling) describes local folder input,
offline review and export back to a local folder or event. Photographer decisions
remain editable. The [events page](https://snapshare.ai/events) emphasizes rapid
delivery, engagement analytics and sponsor presence. The
[about page](https://snapshare.ai/about) mentions LinkedIn networking; this remains
an untested claim, not a reason to add attendee identity linking.

## Competitor and adjacent-tool comparison

| Platform and primary evidence                                                                                                                                                                                                         | Valuable workflow                                                                                             | PicFind decision                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Kwikpic Events](https://www.kwikpic.in/solutions/kwikpic-for-events)                                                                                                                                                                 | QR/selfie registration, sponsor branding, different gallery access roles.                                     | Keep private matching separate from deliberately shared highlights; give photographers controlled branding.                                               |
| [Premagic distribution guide](https://support.premagic.com/hc/home/articles/1781256786-how-ai-photo-distribution-works)                                                                                                               | Registration, uploaded selfie, desktop/Drive/Dropbox ingest, personalized delivery.                           | Build explicit event-only opt-in subscriptions with revocation and retryable delivery. Never imply current one-time consent authorizes stored references. |
| [Pic-Time AI](https://www.pic-time.com/features/ai-powered-gallery-search), [FAQ](https://help.pic-time.com/en/articles/8945250-pic-time-ai-faq)                                                                                      | Face/keyword discovery, vendor filters and sensitive-gallery settings.                                        | Keep discovery access-bound; evaluate semantic search separately after face matching. Publish a clear no-training policy only when enforced.              |
| [Pixieset Studio](https://help.pixieset.com/hc/en-us/articles/32870718673677-Getting-Started-with-Studio-Manager), [projects](https://help.pixieset.com/hc/en-us/articles/24724197072397-Using-projects-to-organize-your-client-work) | Booking, contacts, documents, communications and galleries linked to project stages.                          | A studio job should connect event delivery and client work. Do not overload an event record with an entire CRM.                                           |
| [Kululu](https://www.kululu.com/), [help](https://help.kululu.com/en/articles/11402245-what-is-kululu)                                                                                                                                | Guest photos/video/messages, QR access, moderation and live wall.                                             | Add a separately moderated contribution lane; never project private face results on the public wall.                                                      |
| [Samaro](https://www.samaro.ai/)                                                                                                                                                                                                      | Photographer galleries and delivery positioning.                                                              | Secondary comparator. Public page read; no authenticated workflow or REA capture yet.                                                                     |
| [PhotoDay](https://www.photoday.com/)                                                                                                                                                                                                 | Volume photography commerce and lab fulfillment.                                                              | Treat sales/fulfillment as a later bounded domain, with reconciliation and support obligations. Public page read only.                                    |
| FotoOwl                                                                                                                                                                                                                               | Earlier repository research covers event/gallery creation and QR delivery. Current homepage retrieval failed. | Retain as a follow-up competitor; do not present old findings as current verification.                                                                    |
| Aftershoot, Narrative Select, Lightroom, picdrop                                                                                                                                                                                      | Adjacent culling/editing/proofing candidates.                                                                 | Follow-up evaluation queue. No current feature-parity claims based on this pass.                                                                          |

## Direction and original product hypotheses

PicFind should connect the photographer, organizer and attendee around one
reliable delivery workflow. Face search alone is already common. These hypotheses
need customer validation and are not claims of market exclusivity:

1. **Private delivery with explicit access reasons.** Show why a gallery/photo is
   available, when access ends, and how an attendee clears their subscription.
2. **A delivery readiness view.** Surface failed ingest, unindexed photos,
   unfulfilled client selections and expiring galleries in one actionable queue.
3. **Preview-to-final continuity.** Replace an edited image while preserving its
   selection identity, attribution and appropriate delivery history.
4. **Local preparation with cloud delivery.** Cull and index on a bounded local
   worker when appropriate, then use durable server jobs and private storage.
5. **A collaboration boundary for second shooters.** Upload-only access and
   per-contributor status without granting client lists or billing access.
6. **Consent-respecting new-photo alerts.** Event-only subscriptions, minimum
   retained reference data, withdrawal, digesting and suppression after deletion.
7. **A useful handoff back to editing.** Export available selected filenames,
   identify ambiguous duplicates, retain client decisions and track fulfillment.

## Existing PicFind foundation

Current source already contains event/member authorization, source connections,
durable processing, folder sync, billing entitlements, gallery passcodes,
selection submission/review and selected-photo downloads. The old Phase 0 and
September audit documents substantially understate current implementation.
No current production readiness conclusion is inferred from their old test counts.

Initial work: research/architecture PR, selection filename-export PR, local model
evaluation PR. Further work follows [the roadmap](roadmap.md), subject to findings
and existing behavior. Every slice must add actual value beyond code already present.
