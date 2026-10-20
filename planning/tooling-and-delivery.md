# PicFind tooling and delivery decisions

Recorded 2026-10-20 before feature implementation.

## Available tools and selected uses

Availability means exposed in this Codex session, not that every external account
is authenticated. The local catalog is broader than the tools needed for PicFind.

| MCP, connector, or tool                                                  | Intended use                                                                                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| REA (170 exposed tools)                                                  | Public browser DOM/accessibility evidence and static bundle analysis. Selected for competitor research.                              |
| GitHub                                                                   | Branch/PR metadata, PR creation, Shipwright comments and review threads. Selected.                                                   |
| PowerShell, Git, Node, Python through execution tools                    | Local source inspection, hardware inspection, implementation and verification. Selected.                                             |
| Web search, Firecrawl, Parallel Search                                   | Primary vendor documentation, model licenses and current technical references. Web search selected; Firecrawl available as fallback. |
| Playwright, Chrome DevTools, browser-act, unified browser control        | Public workflow observation and PicFind browser acceptance tests. Playwright selected.                                               |
| Appwrite                                                                 | Existing persistence/auth/storage provider. Use adapter code and targeted sandbox checks when needed.                                |
| Context7                                                                 | Version-specific library documentation when local code and primary docs leave uncertainty.                                           |
| Hugging Face                                                             | Model cards and artifact provenance. No remote GPU jobs without an identified need and cost decision.                                |
| Dodo payments and Dodo knowledge                                         | Existing PicFind billing boundary. Use for billing changes, not face inference.                                                      |
| Stitch, Mobbin, Color Designer, Canva, Supericons                        | Design references and accessible design tokens after domain and permissions are specified.                                           |
| Google Drive                                                             | Agent research only. Product imports continue through PicFind-owned OAuth.                                                           |
| Firebase, Supabase, Redis                                                | Available alternatives; no reason to migrate the existing Appwrite stack for this work.                                              |
| Vercel, Sites                                                            | Deployment capabilities available; no deployment destination change is part of this research.                                        |
| Gmail, Google Calendar, LinkedIn, Apna Jobs, Jobicy                      | Available, not relevant to the current build. No outreach planned.                                                                   |
| Notion, Coda, ChatGPT Space, document control, Google Docs/Sheets/Slides | Available collaboration/document tools. Repository Markdown is the reviewable source of truth here.                                  |
| Razorpay, Stripe, Typeform                                               | Available, not selected. Preserve existing billing and form boundaries.                                                              |
| Blender, to3D, Meshy, image generation, Remotion                         | Available visual/media tools, not needed for core delivery features.                                                                 |
| Pets, Safety Settings, Hotline                                           | Available, unrelated to this task.                                                                                                   |
| codex_tui, node_repl, sequential-thinking                                | Supporting execution tools, use only when they solve a concrete task.                                                                |
| Plugin Management                                                        | Discover missing capabilities if needed. No new plugin is needed now.                                                                |

The tool-search entry point returned an unsupported-call error. The session tool
registry exposed REA and GitHub schemas directly, and both were successfully
called. REA availability is verified by actual page evidence, not registration alone.

## Skills available and selection

| Available skill family                                                                            | Decision                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pdf:pdf`                                                                                         | Used to extract the supplied ShipWright guide.                                                              |
| `matt-skills-curated:domain-modeling`, `database-design`, `codebase-design`                       | Relevant for later studio/domain expansion. Existing contracts are inspected first.                         |
| `codebase-onboarding`, `onboard`, `matt-skills-curated:research`                                  | Available research/onboarding workflows; direct repository and primary-source inspection used in this pass. |
| `diagnosing-bugs`, `find-bugs`, `code-review`, `code-simplifier`                                  | Available for targeted debugging and review. Shipwright provides the requested external review loop.        |
| `frontend-design`, `redesign-existing-projects`, `design-research`, Stitch design, palette skills | Available for later interface work. Existing visual changes are preserved.                                  |
| `form-testing`, `auto-type-checking`, `gstack-workflows:qa`, `gstack-workflows:qa-only`           | Relevant validation workflows. Run existing Vitest/Playwright/build checks appropriate to each change.      |
| `commit`, `gstack-workflows:ship`, `gstack-workflows:review`                                      | Available release workflows. Follow the supplied Shipwright guide and scoped Git staging.                   |
| `appwrite-typescript`, `appwrite-cli`, other Appwrite language skills                             | TypeScript/CLI relevant when modifying Appwrite schema. Other languages not selected.                       |
| Dodo billing, checkout, subscriptions, webhooks, testing-and-go-live                              | Relevant only for subsequent commerce changes.                                                              |
| Hugging Face dataset/model/training/jobs skills, `ml-best-practices`                              | Model provenance and benchmarking relevant. Training from scratch is not selected.                          |
| browser-act, computer-use, gstack browse                                                          | Available UI workflows; direct Playwright plus REA sufficient here.                                         |
| Firebase, Redis, Supabase, Vercel, Sites skills                                                   | No stack migration selected.                                                                                |
| pstack principles, superpowers, planning/specification skills                                     | Available engineering guidance. No delegation needed for this initial pass.                                 |
| Documents, PDF, presentations, spreadsheets, Pages, Google Drive, Notion                          | Markdown plus the PDF reader sufficient for this deliverable.                                               |
| Skill creator/installer, create-rule/subagent, automation/goal/loop                               | Available workflow configuration. No global configuration changes planned.                                  |
| Image generation, Remotion, Meshy, anatomy, canvas                                                | Not needed for the current product slice.                                                                   |

These are capability selections, not a claim that every named skill was invoked.
The session-provided skill catalog remains authoritative for exact paths.

## Shipwright workflow

The local guide specifies same-repository branches, focused real changes,
non-draft PRs (or `/shipwright verify` for drafts), review, valid fixes, re-review,
and merge. Comments alone do not establish quality or leaderboard credit.

The live welcome issue is [PicFind #1](https://github.com/DarshanKrishna-DK/Picfind/issues/1).
It confirms installation and a ceiling of 100 reviewed PRs per repository.
The user explicitly accepted the ceiling and quality over count on 2026-10-20.
Do not manufacture findings, split trivial edits, or create empty PRs.

For each slice:

1. State the user problem, acceptance behavior and dependency.
2. Use a branch from the actual base, currently `feat/phase-0-foundation`.
3. Implement, validate and stage only that slice.
4. Open a ready PR with test evidence and limitations.
5. Request focused review through a GitHub conversation comment.
6. Read Shipwright findings, fix valid issues, or explain a disagreement with evidence.
7. Re-review changed commits. Record PR URL, review verdict, checks and unresolved gates.
8. Merge only when checks and required approvals support it.

The repository is private. Reviews can run, but the guide requires a public
repository for event leaderboard eligibility. Visibility has not been changed.
The user has said the event timeline does not matter. No leaderboard guarantee
is made.

The guide says diffs over 5,000 lines are skipped, whereas the live welcome issue
says 120,000. Keep feature PRs well below either threshold. Dependency/auth/payment
changes can request human approval. Treat actual check output as current evidence.

## Existing workspace

Base commit: `388a1a0b9a79da87acc10f99a6a7f235c6a6dc12`.
Existing edits in `apps/web/src/landing.css` and the untracked root `to-do` belong
to the current workspace and are excluded from new commits.
The entire `docs/` tree is ignored. New reviewable research lives in `planning/`;
the existing private documents and supplied PDF are not bulk-published.
