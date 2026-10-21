# Load workflow code when its route is used

The growing studio currently enters through a single application bundle of about
990 kB before compression (PR #63 local production build). A visitor opening the
landing page should not download every private reporting, proofing and studio
editor implementation. Split route implementations with stable module-level
dynamic imports while retaining the existing route map and authorization.

Keep the public and studio shells available during route loading. Place loading
boundaries around their outlet content, with a boundary for the standalone wall.
Maintain the existing session gate and error recovery. Loading a code chunk
does not authorize a private API call. A failed chunk must lead to the existing
reload recovery rather than an endless spinner or fabricated page success.

Measure the actual production entry and emitted route chunks before and after.
Verify cold public-page requests do not eagerly load unrelated studio modules;
direct links, authenticated navigation, delayed chunks and failed chunk recovery
must work on desktop and mobile. Exercise public invitation/proofing routes as
well as studio routes because several modules export both owner and guest pages.
Do not claim measured real-user latency gains from bundle sizes alone.

Use [React lazy](https://react.dev/reference/react/lazy) at module scope so
component identities remain stable. A lazy import rejection reaches an error
boundary; [Suspense](https://react.dev/reference/react/Suspense) provides the
loading fallback. Verify output with the existing installed Vite build rather
than changing bundler versions or production hosting.

The production manifest measures 350,908 initial JavaScript bytes and 110,626
gzip bytes, including all transitive static imports and excluding deferred
routes. The preceding build reported 998.85 kB and 284.78 kB gzip for its
initial bundle. This is about a 65 percent raw-byte reduction, not a measured
page-load time improvement. The web build now fails above 600,000 initial
JavaScript bytes or 200,000 gzip bytes. Unit cases cover transitive imports,
cycles, duplicate files, deferred exclusions, malformed manifests and both
budget boundaries.

Verification: 72 Chromium/mobile WebKit cases passed across route loading,
budget draft navigation, questionnaires and proposals. A separate production
preview run passed 28 cases against the compiled brief/report pages. The first
cold-public-page assertion used the wrong existing privacy heading; correcting
the selector resolved it. The full suite passed 154 files and 2,525 tests,
lint and typecheck. Production smoke tests now run in each existing CI browser
job, with separate failure artifacts and a 25-minute browser-job limit.
