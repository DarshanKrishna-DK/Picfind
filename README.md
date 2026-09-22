# PicFind

Photo discovery from existing collections and organizer-controlled event galleries. Source access is read-only; selected photos download to the user's device, never automatically back to Google Drive.

## Start on Windows

Install Node.js 24 LTS, then double-click `Start-PicFind.bat`. It installs locked dependencies when needed and starts the web app and API in one window. Keep that window open; Ctrl+C stops the development session.

- `Start-PicFind.bat -Safe`: disable all face-provider calls for development.
- `Start-PicFind.bat -NoBrowser`: start without opening a browser.
- Website: http://127.0.0.1:5173
- API liveness: http://127.0.0.1:3001/health
- Manual configuration and launch gates: [setup guide](docs/SETUP-AND-LAUNCH.md).

The local launcher is not an internet-facing production deployment. Missing cloud configuration is shown as unavailable, not simulated success.

## Commands

```powershell
npm.cmd ci
npm.cmd run dev
npm.cmd run dev:safe
npm.cmd run check
npm.cmd run test:e2e
npm.cmd run preflight
npm.cmd run setup
```

`dev` starts both processes with a matching origin. `dev:web` and `dev:api` are available for isolated work. Starting only the web process cannot provide authentication or a library. The `setup` command provisions the Appwrite library schema using configured credentials; it changes the configured cloud project.

## Layout

| Directory           | Responsibility                                                              |
| ------------------- | --------------------------------------------------------------------------- |
| `apps/web`          | Public website, authenticated Studio, guest galleries                       |
| `apps/api`          | Authentication, provider integrations, private data and processing controls |
| `packages/shared`   | Shared contracts, pricing and safe navigation                               |
| `scripts`           | Startup, explicit provider setup and opt-in live validation                 |
| `tests`             | Unit, integration and browser regression suites                             |
| `infra`             | Least-privilege policies and deployment configuration                       |
| `docs`              | Product, technical, operational and historical documentation                |
| `docs/reference`    | All original user-supplied planning documents, preserved locally            |
| `artifacts/private` | Ignored personal reference images; never public assets                      |
| `artifacts/reports` | Generated test reports and screenshots                                      |
| `artifacts/design`  | Generated design evidence and document integrity manifest                   |

There is no active root `benchmarks` folder, and benchmarks are not required to run PicFind. The three original planning documents are preserved in `docs/reference`; their saved SHA256 baseline is in `artifacts/design/reference-integrity.json`. Dependencies, tests, CI, infrastructure and agent configuration are not disposable simply because they are not deployed to the browser.

## Data and cost safety

- Google login and Google Drive authorization are separate integrations.
- Organizer libraries and secret-link guest galleries require an authenticated server session. Guests cannot mutate event photos; optional passcodes add another access check. There is no public event directory.
- Search selfies are not retained; face indexes are scoped to a collection, not a global identity graph.
- Similarity scores are not identity certainty. No accuracy guarantee is claimed.
- Current development safety limits remain enabled. Paid allowance activation requires the billing and concurrency workstream to pass its tests.
- Automated local tests use synthetic photos and provider doubles. Live provider validation is separately labeled and opt-in. Never run the live face-search script against an entire album as a smoke test.
- Keep originals: current image delivery uses optimized JPEG copies, not a RAW backup service.

## Project status

The active [launch design](docs/superpowers/specs/2026-09-21-launch-design.md) and [phase plan](docs/superpowers/plans/2026-09-21-studio-and-launch.md) distinguish implemented functionality, current tests and external activation gates. Passing a local build does not establish production readiness or competitor feature parity.

Use the [launch evidence ledger](docs/LAUNCH-READINESS.md) for dated implementation and verification checkpoints, and the [setup guide](docs/SETUP-AND-LAUNCH.md) for manual steps. `npm.cmd run preflight` reports configuration blockers without printing secrets, changing settings or contacting providers. External acceptance is reported separately even when configuration passes. Do not enable live billing or processing merely to clear a preflight warning.
