# Changelog

## 2026-09-21 - Persistent renewal payment attribution

- Replaced current-subscription fallback for missing-cart renewals with bounded,
  customer/subscription/currency/product-filtered evidence and private receipts.
- Persisted succeeded-payment attribution only; replay preserves immutable payment
  identity without freezing current refund/dispute state or granting extra credits.
- Fixed two reproduced test failures: order namespace isolation and pending-payment
  handling. Ambiguous or unavailable evidence fails closed instead of selecting a plan.
- Full local check passed 572 tests across 50 files, lint/typecheck and both builds.
  Real Appwrite persistence and fresh-instance replay passed; three disposable rows
  were removed. No real Dodo or AWS calls and no frontend changes.
- Actual Dodo TEST historical-filter semantics, plan-change confirmation and
  authorized old/new allowance fulfillment remain unfinished. Live billing stays off.

## 2026-09-21 - Read-only renewal plan previews

- Connected Studio to an authenticated provider-backed monthly plan preview, using
  the saved subscription currency, strict ownership checks and explicit zero-charge
  next-renewal semantics. No plan-change confirmation or provider mutation is enabled.
- Added estimate expiry, selection reset and protection from stale browser responses.
- Prefer historical payment-cart product/quantity over today's subscription when a
  cart exists. Missing-cart subscription-period attribution remains a required next step.
- Full local check passed 539 tests across 48 files, lint/typecheck and both builds.
  All 15 new and 51 existing billing/account browser checks passed on Chromium,
  Firefox and mobile WebKit, without skips or retries.
- No real Dodo preview/payment/subscription action or AWS call. Billing remains off;
  complete plan switching and real-provider acceptance are not yet finished.

## 2026-09-21 - Scheduled billing recovery

- Added opt-in unattended reconciliation with bounded private account discovery,
  durable leases/heartbeats, restart-safe progress and per-account backoff.
- Reuses verified reads and idempotent grants; failed accounts do not block others.
  No automatic charge, refund, cancellation or AWS operation was introduced.
- Added separate sanitized billing health, structured failure events, index setup
  and an activation/rollback runbook. Production alert delivery remains a gate.
- Full local check passed 492 tests across 46 files, lint/typecheck and both builds.
  Two workers passed an isolated real-Appwrite metadata diagnostic; both disposable
  rows were removed. Real Dodo TEST/live acceptance and plan changes remain open.
- Existing billing activation and credentials were unchanged. No frontend changes.

## 2026-09-21 - Resumable billing history recovery

- Added account-bound Dodo payment history pages and authoritative detail reads for
  missed renewals, refunds and disputes, using the existing idempotent grant ledger.
- Persisted bounded progress across reload/restart and failed reads/checkpoints;
  original expiry and used allowances are preserved. Foreign accounts/orders and
  payment environments cannot grant credits through this path.
- Account deletion now stops while history recovery is incomplete. Studio exposes
  resumable progress rather than claiming a partial batch is a complete history check.
- Hardened authoritative payment/subscription ID and customer binding. A new browser
  race test found an obsolete continue-checking message; it now follows current state.
- Final local check passed 465 tests, lint/typecheck and both builds. All 51 related
  browser cases passed across Chromium, Firefox and mobile WebKit.
- No live payment, refund, cancellation or AWS calls. Billing activation was unchanged.
  Scheduled reconciliation, plan changes and real-provider acceptance remain open.

## 2026-09-21 - Organizer folders and client selection review

- Added private flat event folders, URL-persisted search/folder/visibility filters
  and sorting; public galleries do not expose folder labels.
- Added owner-only New/In progress/Completed reviews, private notes and optimistic
  version checks. Conflicting edits preserve the local draft until explicit reload.
- Added the client selection inbox, available-photo previews, cancellable device
  ZIPs and private review CSV columns. Missing/expired photos are reported honestly.
- Auxiliary event tools now reject deletion-in-progress; guest selection UI mirrors
  the server's 100-photo submission limit. Existing event deletion removes reviews.
- Removed the unused duplicate event list after browser testing exposed the routed
  component mismatch. Fixed a rapid reset/sort stale-URL race found in Firefox.
- Final local check passed 431 tests including 26 new organizer cases, lint/typecheck
  and both builds. Full browser regression passed 225 checks across three engines;
  three opt-in live-cloud cases were skipped. All 18 new organizer browser cases passed.
- Real Appwrite metadata persistence passed across fresh instances; both disposable
  rows were removed. Refreshed local API remains AWS-free and rejects anonymous review writes.
- No AWS face calls. Teams, moderation and remaining launch gates are not declared complete.

## 2026-09-21 - Paginated saved Google Drive imports

- Added metadata-only Drive root/folder browsing, explicit pagination, selection,
  event destinations and consented enqueue into the existing persistent import worker.
- Encrypted continuation tokens bind account, folder and connection generation;
  expired/changed tokens prompt re-browsing, without deleting saved import jobs.
- Drive authorization initiated in imports returns to imports after success or
  cancellation. Return paths are allowlisted and stored inside signed/encrypted state.
- Fixed malformed-link validation and the missing bounded JSON parser found by
  backend regression tests. Source files are never written back to Drive.
- Full local check passed 405 tests, lint/typecheck and both production builds.
  All 39 related browser checks passed in Chromium, Firefox and mobile WebKit.
- Restarted local API with Rekognition off; ready state and anonymous-route rejection
  passed. No live Google folder/image requests or AWS face calls were performed.
- Added the exact Drive flow and remaining provider acceptance to operations/setup docs.

## 2026-09-21 - Education organization and saved-import validation

- Transferred the existing Appwrite project to GitHub Student Organization;
  retained its ID, region, data resources and Google browser sign-in configuration.
- Real disposable connection and generated-image import diagnostics passed,
  including saved progress, duplicate prevention and cleanup.
- Added capacity-aware bulk cloud selection, empty-folder navigation, pagination
  deduplication and fresh consent after a second account change during resume.
- All 21 targeted browser cases passed, including isolated Firefox reruns.
  Lint/typecheck, 378 synthetic tests and both builds passed.
- Real Appwrite browser gallery smoke passed after transfer, including cleanup.
- Enabled local cloud imports after confirming the active queue was empty.
  Current face matching is disabled; no AWS face calls were made.
- Updated setup evidence. Full-product launch and real provider gates remain open.

## 2026-09-21 - Source expansion, organizer tools and planned pricing

- Removed the landing-page competitor / Find your fit section.
- Added planned INR/USD photo packs and monthly allowances, with a lowest-starting-price estimator; checkout remains disabled.
- Added read-only Dropbox, OneDrive and Box connector implementations with encrypted, owner-bound temporary OAuth cookies, folder browsing and selected-file imports. Live provider registration/validation remains pending.
- Added device-folder upload and library-photo Discover matching, with resumable search sessions and no cloud write-back.
- Added gallery passcodes, studio attribution/accent color, guest photo selections and organizer selection CSV export.
- Removed automatic event-upload indexing; added explicit preparation consent, cached no-face outcomes and persistent development processing guards.
- Made provider deletion retryable and added provider-aware account cleanup; paginated Appwrite record listing.
- Documented completed phases, source-policy restrictions, pricing assumptions and remaining non-payment launch work in docs/source-expansion-and-pricing.md.
- No live AWS image processing or production database migration was performed.

## 2026-09-21 - Mobile delivery and launch experience

- Added a shared mobile gallery for library, Discover, and event results, with individual, selected, and all-photo device downloads. The Drive connector remains read-only; no save-back flow was added.
- Added progress, cancellation, safe ZIP filenames, JPEG validation, a 64 MiB archive-input budget, mobile save guidance, and download fallback.
- Added viewer navigation, persistent selection while filtering, upload retries, dynamic event filters, native gallery sharing, and explicit empty match results instead of silently displaying the full gallery.
- Repeat selfie searches reuse the active prepared folder rather than indexing it again. Delete the current session to change folders. Durable session resume remains a follow-up.
- Used Stitch and frontend design skills for a silver/teal landing page with compressed artwork, static glass/chrome details, product explanation, sourced comparison, and FAQ. Removed the old homepage's active PlayCanvas import path.
- Fixed the API production build's shared-type root; start with `npm run start --workspace @picfind/api` after deployment configuration.
- Added synthetic browser and download-contract tests. No live Rekognition calls, full-album processing, Drive exports, production deployment, or payments were performed.
- Research, scope, tests, and outstanding launch gates: `docs/launch-experience-review.md`. The whole phase-wise product is not certified production-complete.

## 2026-09-17 - Face matching (AWS Rekognition)

- Added event-scoped and Discover face search behind `FaceMatchingProvider`. The live adapter is Amazon Rekognition (`IndexFaces` + `DetectFaces` + `SearchFacesByImage`). Azure Face remains unimplemented because Identify/Find Similar need Limited Access approval.
- Discover: signed-in users connect Google Drive in the product (OAuth `drive.readonly`), index one folder page, search with a selfie that is not stored, see ranked match scores, and delete the session. Cursor Drive MCP is not used by the web app.
- Event organizers can prepare a face index; public gallery visitors can search after consent. Organizers never receive attendee selfies.
- Automated tests use provider doubles and do not call AWS. Opt-in live script: `AWS_REKOGNITION_LIVE_TEST=1 npx tsx scripts/live-face-search.ts`.
- After Rekognition IAM was attached, a live search of 20 photos from the Pre-hack Drive folder against the local headshot returned two matches at threshold 80 (similarity 99.3 and 96.9). The temporary collection was deleted. The local API now reports `faceMatching: true` when AWS credentials from `aws login` can be exported.

## 2026-09-17 - Face-only identification scope

- Product language for “biometric identification” is now explicit: **face matching from photographs only**. Fingerprint, iris, voice, gait, and other modalities are out of scope. Recorded in the PRD, architecture ADRs, and privacy/retention design.

## 2026-09-14 - Gallery and event implementation

- Continued the non-biometric product foundation. The full reference-plan product is **not complete**; no phase is certified complete.
- Stitch MCP succeeded: project `15658961930722475220`, `PicFind - Photo library and event galleries`. Used Engineering Suite Stitch Design, wrote `DESIGN.md`, and implemented its paper/teal visual direction with the supplied PicFind logo and Clarvos-inspired section structure.
- Added responsive Home, Discover, Events, Pricing, Privacy, Terms, Contact and sign-in pages, plus lazy PlayCanvas photo-stack interaction with a static reduced-motion fallback.
- Added real authenticated library, photo upload, filename search/sort, viewer, selection, individual JPEG/ZIP downloads and metadata export.
- Added event creation/editing, private-by-default sharing, expiry, archive/restore, owner deletion, public gallery links and downloadable QR SVGs.
- Provisioned Appwrite TablesDB database `picfind-library`, table `records`, owner/kind index, and private bucket `picfind-photos`. No public table/bucket permissions were granted.
- Resolved setup failures by switching from legacy collection endpoints to current TablesDB endpoints and checking database existence before creation. API-key permissions were not expanded.
- Added strict image decoding, input/type/size/pixel limits, embedded metadata stripping, optimized JPEG storage, owner authorization and a hard **20-photo account limit**. Mutations are serialized in one API process.
- Optional Drive import reads only one API page and remaining slots out of 20. `GOOGLE_DRIVE_API_KEY` is absent, so the supplied folder was not imported. Direct upload works.
- **Zero AWS calls.** The supplied selfie was not processed. Face identification/matching is not exposed by the product and was not implemented or tested.
- Fixed the auth lint/type issues from the prior handoff. API production compilation follows the server entry-point graph and excludes the unused matching adapter.
- Validation: TypeScript, lint, production builds and all 24 integration tests passed. A real Appwrite browser test passed for registration, one synthetic non-person photo, event sharing, QR/ZIP downloads, access revocation, logout and cleanup. Five Chromium product checks passed. Firefox/WebKit initially could not launch because their runtimes were absent; cross-browser follow-up is recorded separately.
- Remaining: Google OAuth/recovery, Drive credentials, original-file retention, durable workers/exports/retention, full data model, account deletion, Dodo billing/country pricing, observability, approved policies/contact delivery, hosting and production review.
- Full routes, known limits and run instructions: `docs/gallery-development.md`. Local website: `http://localhost:5173` with `WEB_ORIGIN` matching that origin.
- All repository changes remain local; no commits or pushes were made.
- Cross-browser follow-up: installed the missing Firefox and WebKit test runtimes. All 15 public-product tests now pass across Chromium, Firefox and mobile WebKit. The separate live Appwrite gallery test also passed and cleaned up its temporary account/event/photo. Final frontend build passed; the optional lazy PlayCanvas chunk still produces a size warning.

## 2026-09-14

### Session handoff: PicFind continuity notes

- Repository is at: `C:\Users\darsh\OneDrive\Documents\GitHub\Picfind`
- User explicitly requested **no AWS/paid API calls yet** beyond setup; no production face-matching runs executed in this session.
- User preference: all changes local; do not push to GitHub.
- User preference: keep moving phases strictly from Reference_Docs phase plan.

#### What is currently implemented

- Appwrite-based authentication foundation is in place in API (Phase 0/1 groundwork):
  - Added `apps/api/src/auth.ts` with `/api/auth/register`, `/api/auth/session` POST/GET/DELETE routes.
  - Added `apps/api/src/adapters/appwrite-auth.ts` adapter for Appwrite-backed provider.
  - Added env/config wiring in `apps/api/src/config.ts` and `apps/api/src/server.ts`.
  - Added shared auth interfaces/types in `packages/shared/src/ports.ts`.
  - Added integration tests for auth and request validation in `tests/integration/auth.test.ts`.

- API baseline and docs updates:
  - API app now mounts `/api/auth` and has auth error handling in `apps/api/src/app.ts`.
  - OpenAPI additions in `docs/openapi.yaml` for auth endpoints and origin-cookie contract.
  - Docs added/updated: `docs/authentication.md`, `docs/appwrite-resources.md`, `docs/billing.md`.

- Environment/secrets context:
  - `.env` is present in workspace with Appwrite key and basic env values.
  - Appwrite project created: `picfind-development`.

- Project cleanup notes:
  - `.gitignore` was updated earlier to include `playwright-report`, `test-results`, and other temporary paths.
  - Irrelevant generated/non-required files removed except `Reference_Docs` retained.

#### Current known issue / status to resume from

- Local validation from earlier session found:
  - `apps/api/src/auth.ts` and `apps/api/src/app.ts` previously reported lint/type issues, and user has asked whether to proceed with fixes. Current state should be confirmed against current branch before continuing.
- `tests` and `typecheck` were previously run by user/agent and passed for auth logic in prior state, but this should be re-run after any new edits.

#### Stitch MCP configuration (critical)

- `.codex/config.toml` currently has Stitch configured as:
  - `[mcp_servers.stitch]`
  - `url = "https://stitch.googleapis.com/mcp"`
  - `[mcp_servers.stitch.env_http_headers]` with `X-Goog-Api-Key` present.
- Despite `/mcp` tool listing appearing in UI, MCP transport check from this session still returns:
  - `Transport send error ... unexpected server response: HTTP 404 ... {"result":{"resources":[]}}`
- Root cause likely transport-mode mismatch (tools vs resources response), not yet fully resolved here.

#### Open items / next actions (explicit)

1. Confirm/align Stitch config format for Codex in this environment (likely proxy-mode MCP adapter variant if required).
2. Resume implementation flow from phase plan.
3. Fix/re-verify auth lint/type state as requested.
4. Continue platform foundation work (private storage, source provider abstractions, discovery/job APIs) before enabling product matching.
5. Implement event model/API and billing gating only after phase order constraints are satisfied.

#### Notes for next agent

- If continuing this thread, prioritize:
  - preserving existing files already added by this agent,
  - re-running checks before changing behavior,
  - keeping any paid-provider calls disabled until the user explicitly provides authorization for a single real test,
  - and treating Stitch transport as “connected in UI, but not via `list_mcp_resources` in this environment” until fixed.

## 2026-09-14 (Stitch attempts)

- Attempted multiple `list_mcp_resources` checks for `stitch`; error persists as above.
- Confirmed direct Stitch endpoint responds to valid JSON-RPC when called manually with key, so service itself is reachable.
- No secrets were added to repo; key exists only in local config and was redacted/handled via session context as required.

Validation for the source-expansion phase: typecheck, lint, API/web builds and 87 unit/integration tests passed. Clean browser run: 84 passed, 3 opt-in live checks skipped. Test fixtures do not establish live provider or production readiness.

## September 21, 2026: Studio launch workstream (in progress)

- Added protected Studio overview, dedicated library, mobile navigation, consistent glass surfaces and anchored public sections.
- Replaced generic landing art with a compressed Stitch photo-discovery illustration and restrained reduced-motion-aware depth.
- Added on-page pricing, photo workflow comparison, PicFind PNG favicons and web manifest.
- Added single-window Windows launcher and combined API/web dev command; safe mode disables facial provider calls.
- Preserved all three reference documents under docs/reference with matching SHA256; moved personal headshot under artifacts/private; removed obsolete workbench runtime/model assets and generated root reports.
- Added OAuth return-path checks and new browser regressions. Live Google provider reports project_provider_disabled and requires Appwrite activation.
- Billing, additional production workflows and launch verification remain active workstreams; this entry is not a production-readiness claim.

## 2026-09-21 - Transactional billing foundation and launch verification

- Added Dodo hosted checkout/portal, raw signed webhooks, owned product mapping and an Appwrite transactional credit ledger with replay/refund/dispute protection.
- Added a protected Billing & usage Studio page and six price-checked TEST products; live billing remains disabled pending the documented engineering/provider gates.
- Verified 125 synthetic unit/integration tests, builds, the real disposable gallery flow, real Appwrite credit concurrency, and an unpaid Dodo checkout without AWS processing.
- Added one-click combined startup, billing setup/diagnostic scripts and the current setup/readiness documents.

### 2026-09-21: account isolation, retention and recovery

- Bound encrypted Google Drive grants to the PicFind account, purpose and origin; cleared app-owned connection cookies at account boundaries.
- Added expiry enforcement, retryable cloud/object cleanup, durable upload-cleanup intents, and upload commit reconciliation.
- Preserved uncertain cloud-index cleanup references and recovered lost metadata acknowledgements without repeating indexing.
- Added delivery reservation receipts and idempotent refunds for upstream HTTP failures and metadata mismatches.
- Added the private transactional processing-job foundation and synthetic/live-storage concurrency diagnostics; worker and Studio integration remains in progress.

## 2026-09-21 - Durable event processing and retry safety

- Added private Appwrite-backed event processing jobs, progress history, cancellation and the Studio processing panel.
- Prevented overlapping event batches and automatic repeats of uncertain paid requests; explicit retry authorization is bound to the affected photo snapshot.
- Added idempotent checkpoint recovery, pre-provider failure state preservation, irreversible event-deletion markers and truthful pending individual-photo cleanup.
- Added adaptive idle polling and cleared stale enqueue errors after job reconciliation.
- Validation: 213 local tests; 135 distinct browser checks across broad/targeted runs; real safe API and Appwrite storage/worker checks with generated images and no AWS face calls. Production provider/payment/deployment gates remain open.

## 2026-09-21 - Production capacity and immutable job snapshots

- Separated production capacity from the 20-photo development guard, retaining server-side allowance enforcement and fail-closed storage/delivery accounting.
- Added private, atomic manifest chunks for durable events of up to 10,000 photos, bounded progress/history payloads, legacy job migration and cleanup.
- Fixed production event-update gating, mismatched ingestion limits, and event PATCH defaults that overwrote omitted settings.
- Added Studio capacity presentation and a 21-file upload browser scenario. Real Appwrite metadata and synthetic-worker checks passed without Rekognition calls; full local suite reached 237 passing tests.

### Billing lifecycle safeguards

- Resume an exact saved checkout across reloads instead of opening an accidental duplicate purchase.
- Recover owned checkout/payment status and known subscription state from Dodo, without trusting checkout redirects.
- Add deliberate period-end/immediate cancellation and preserve paid allowance expiry without implying a refund.
- Gate account deletion on verified terminal billing state and persist a purchase fence before photo/job cleanup.
- Add stale-tab, provider-outage, cancellation-ownership, account-deletion and synthetic SDK regressions.

## 2026-09-21 - Durable library Discover

- Queue immutable library photo selections and prepare scan-specific copies in the background.
- Reopen progress, pause/resume remaining work, filter photos by filename/event, and bulk-select without rendering thousands of checkboxes.
- Reuse completed copies/indexes; require deliberate consent for uncertain paid retries; keep selfies and new-scan match lists out of persistent storage.
- Keep library access working during processing-store outages and prevent deleted scans from being recreated by stale requests.
- Fence stale worker claims before provider work and repair final checkpoint loss without duplicate paid indexing.
- Add 21 synthetic integration checks and a bounded real Appwrite Discover diagnostic. Full local code gate: 287 checks passed; zero AWS calls.

## 2026-09-21 - Persistent read-only cloud connections

- Complete development Google browser sign-in setup with owner approval, preserving existing OAuth credentials and callbacks. Verify a real return to the authenticated Studio.
- Enable persistent cloud connections locally, pass the restarted API smoke with a generated image and complete cleanup, and remove the explicitly confirmed disposable installer-output artifact blocking formatting.

- Add private AES-GCM encrypted Appwrite connections for Drive, Dropbox, OneDrive and Box, with restart reuse and transactional refresh claims.
- Preserve rotating tokens, reconcile lost commit acknowledgements, and require reconnect instead of retrying an uncertain provider exchange.
- Fence late refresh and OAuth callback responses against disconnects and newer authorization attempts.
- Disconnect grants before account cleanup and remove private connection records before deleting the account.
- Keep old-cookie fallback disabled in persistent mode, while retaining explicitly labeled legacy mode when persistence is off.
- Add setup and disposable real-storage diagnostic scripts, truthful import/privacy copy, 38 new synthetic regressions, and cross-browser connection tests.
- Full code gate: 325 checks plus lint/typecheck/build pass. Targeted browser matrix: 21 passes. Real Appwrite diagnostic passes with cleanup; no AWS or payment calls.
