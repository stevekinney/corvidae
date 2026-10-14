# Playground build costs and rendering strategy (CIN-585)

Status: decided. The recorded runs, their raw results, and the comparison are committed beside this document in `cin-585-results/`.

## Decision

- **Rendering and build strategy: retain the baseline.** The selection rule, applied by `measure-playground.ts compare` to the recorded runs, retains per-page entry compilation. The shared multi-entry candidate cut every timing observation far below the baseline band. Static export fell from a 545.3 to 604.2 s band to 197.4 to 210.8 s, and server spawn-to-ready fell from a 101.7 to 123.5 s band to 8.8 to 9.1 s. But two resident-memory observations put its median above the baseline maximum:
  - static-export tree peak, warm: candidate median 5.42 GB against a baseline maximum of 5.19 GB;
  - server tree peak until ready, cold: candidate median 3.98 GB against a baseline maximum of 3.67 GB.

  The rule permits no trade between a faster build and a higher peak, so the baseline stands.

- **CIN-588 mechanism: a shared multi-entry page graph, built in garbage-collected batches, with a memory gate.** The single unbounded multi-entry `Bun.build` measured here is rejected. CIN-588 should keep its shared graph, which emits each shared module once, but build it in batches with a forced collection between them, and accept it only when `measure-playground.ts compare` selects it against a fresh baseline under this same rule. Restoring that batched collection is the first lever, because the experiment confounds two changes: it replaced the six-way per-page sweep with one build, and it dropped the sweep's forced collection every 24 completed builds (`releaseIncrementalPrebuildMemory`). The measured memory excess is therefore not yet attributable to sharing itself. The firm target is the server: its cold tree peak until ready had a candidate median of 3.975 GB against a baseline maximum of 3.672 GB, a 0.30 GB gap with bands that do not overlap (3.63 to 3.67 GB against 3.90 to 4.03 GB). The warm-export excess (5.42 against 5.19 GB) sits inside overlapping bands (4.80 to 5.19 against 5.02 to 5.61 GB), so it is a check, not a target. The reasons to pursue the graph are load-robust: exporter CPU time halves (1,044.8 to 1,074.8 s down to 504.1 to 517.7 s), emitted output shrinks from 4,220 files and 291.3 MB to 2,895 files and 63.7 MB, and server readiness drops by more than an order of magnitude. Cross-shard artifact reuse is not part of it (see the matrix).
- **CIN-589 contract: swap between prerendered documents, reconciling the head and unmounting the old page.** Fetch the target route's prerendered HTML (`/page/<name>`). It carries the server-rendered `#app` markup, the `__CINDER_EXAMPLES__` and `__CINDER_SIDEBAR__` data islands, the fingerprinted page entry URL, and a per-page `<head>`: the shared `documentation.css`, the component's own stylesheet links (`componentStylesheetLinks`, `src/playground-server.ts` around line 369, twelve links on the Chat page and none on Button), and the page's Svelte server `<head>` output (`ssrHead`, around lines 476 and 493, seven Svelte-scoped `<style>` blocks on the Chat page). Each swap must do four things, in order:
  - reconcile `<head>`: add the target's stylesheet links that are missing, remove the previous page's component links and rendered head, and wait for new stylesheets to load before revealing the new markup;
  - unmount the previous page's hydrated Svelte app and release what it owns (example mounts, live-reload stream, listeners) before importing the next entry;
  - replace `#app` and the islands, then `import()` the target's entry, which since #188 is one `import` of its content-hashed module, so it evaluates once and its chunks stay cached;
  - move focus to the new page and announce it.

  Keep a plain `<a href>` as the fallback for every link. The static `/api/documentation/<name>` and `/api/manifest/<name>` JSON routes remain available for data a document swap does not cover; CIN-589 should confirm the islands it needs before adding a new route-data format.

- **Leaks: none reproduced.** Every monotonic series is listed in Leaks with its owner-level evidence. The browser EventSource count was a tracking artifact (the server held one stream), and the rebuild memory growth is allocator behaviour: constant region count, a large reclaimable share, and a footprint that moves both ways. No issue is proposed.

## Context

The Playground (`applications/playground`, `@lostgradient/playground`) is a Bun server that compiles each documentation page with `Bun.build` and Svelte. `bun run build` drives the same request handler through `scripts/static-export.ts` and writes every route to `build/`, which Vercel serves as static files. Since #188, each stable entry URL (`/page-bundle/<name>.js`, `/shell-bundle/shell.js`) is a single `import` of its content-hashed entry, so every entry evaluates once.

The baseline compiles one browser bundle per documentation page: the server's eager prebuild runs those builds six at a time, and the static export builds each page lazily when the crawl requests it. The candidate tested here compiles every page entry in one multi-entry `Bun.build`, so modules shared across pages are parsed and emitted once.

## Measurement protocol

`applications/playground/scripts/measure-playground.ts` runs every measurement in fresh child processes. Its pure rules (statistics, the selection rule, tree sampling, inventory, result comparison) live in sibling `measure-playground-*.ts` modules with unit tests, and none of those tests asserts an upper bound on a duration.

```bash
bun scripts/measure-playground.ts run --label baseline --output <results.json>
git apply <scratch>/cin-585-shared-entry-experiment.patch
bun scripts/measure-playground.ts run --label candidate --phases static-export,server-ready --output <candidate.json>
git apply -R <scratch>/cin-585-shared-entry-experiment.patch
bun scripts/measure-playground.ts compare --baseline <results.json> --candidate <candidate.json>
```

Run the commands from `applications/playground`. The phases run in this order:

- **Prerequisites**: `bun install --frozen-lockfile` at the repository root, timed once. It is the `//#preflight` every turbo task runs. Workspace libraries export TypeScript source and have no build task, so no package prebuild exists to time.
- **Static export**: `bun run scripts/static-export.ts` with `PLAYGROUND_BASE_URL=https://cinder.website`, from spawn to successful exit, in three cold/warm pairs.
- **Server readiness**: `bun src/playground-server.ts`, from spawn to the first `GET /ready` answering `200 ready`, in three cold/warm pairs. The server writes its chosen port through `PLAYGROUND_PORT_FILE`, and the script polls every 100 ms.
- **Playwright execution**: the package's `test:browser` script on `tests/playground-shell-layout.playwright.ts` (Chromium, JSON reporter), after confirming port 5597 is free. Its own web server starts inside that run, so the readiness phase stands in for server startup, and the report's summed test durations give execution time without startup.
- **Navigation cycles**: `measure-playground-probe.ts navigation`. One warm-up cycle, then five recorded cycles through home, Button, Action Row, Chat, Modal, and Review Editor. Each component page opens and closes the Playground view, and each cycle returns home and waits for the network to go quiet and two frames to pass before its checkpoint.
- **Edit/rebuild cycles**: `measure-playground-probe.ts rebuild`. Five rewrites of a disposable example written beside Button's examples and deleted afterwards. Each cycle waits for the watcher's invalidation, re-requests the page and its bundle graph, and confirms the new source is served.

### Definitions

- **Cold sample**: this checkout's own `applications/playground/.tmp` is removed, and `BUN_RUNTIME_TRANSPILER_CACHE_PATH` points at a new, empty, run-owned directory. The exporter clears `build/` itself. No OS cache is flushed, and nothing outside this checkout and the run's work directory is deleted.
- **Warm sample**: immediately after the cold sample, a new process reuses the same transpiler cache directory against the same disk inputs.
- **Child peak RSS**: `Bun.Subprocess.resourceUsage().maxRSS`, in bytes on every platform (CIN-584), is one process's own high-water mark. `process.resourceUsage().maxRSS`, which the server logs, is in kibibytes, and no figure here mixes the two.
- **Sampled tree peak**: the largest sum of `ps` `rss` (kibibytes times 1024) across the child and all its descendants, sampled every 100 ms. One observer runs identically for baseline and candidate, and its own cost is one `ps` spawn per sample. This figure includes the short-lived `bun` processes the featured-example renderer spawns, which the exporter's own peak does not.
- **JS heap**: Chromium's `Runtime.getHeapUsage` through CDP after `HeapProfiler.collectGarbage`. It is never added to RSS.
- **Host load**: `uptime` load averages and the logical processor count, captured before and after every sample.
- **Memory pressure**: from `b68efe09`'s parent `f35758e1` on, every host-load reading also records `kern.memorystatus_level` (the percentage of memory the kernel counts as available) and `vm_stat` (free, active, inactive, wired, and compressor-occupied bytes, and the swap counters). The recorded decision runs predate this and carry no memory-pressure field.
- **Playground environment**: the pinned environment records the Playground's own configuration as its registered reader (`src/environment-configuration.ts`) sees it: `CINDER_TEST_COMPONENTS`, `PLAYGROUND_BASE_URL`, `PLAYGROUND_PORT_FILE`, `PORT`, and `NODE_ENV`. Children set the base URL, port, and port file explicitly, and from `f35758e1` on they also set `CINDER_TEST_COMPONENTS` to empty (the server's default of every component), so an inherited value cannot narrow a measured prebuild.
- **Load gate**: before every sample, including a warm sample that follows its cold one, the script waits while the one-minute load average exceeds three times the logical processor count (30 on this host). It polls every 30 s with no deadline and records the wait (threshold, checks, waited milliseconds, and the load at start) with the sample. A warm sample held by the gate starts later than "immediately", and its recorded wait says by how much.
- **`Bun.build` count**: derived from the source rather than intercepted. A static export makes one shell browser build, one page browser build per documentation route, one shell server-renderer build, one page server-renderer build, and one build per stylesheet (`documentation`, `landing`) inside the exporter process. It also makes one featured-example server build per featured render, and each of those runs in its own spawned `bun` process. Scenario and fixture builds are lazy, and the export never requests them. At the measured source, the smoke runs saw 211 documentation routes (212 sitemap routes including `/`) and 181 featured renders (182 pids observed in the exporter's tree). That gives 1 + 211 + 1 + 1 + 2 + 181 = 397 builds for the baseline, and 1 + 1 + 1 + 1 + 2 + 181 = 187 for the candidate, whose 211 page builds collapse into one. The recorded runs confirm both counts: 212 sitemap routes and 182 observed processes in every export sample. Emitted artifacts are counted from `build/` on disk, as files and bytes in total and as unique content by SHA-256.

### Selection rule

Each primary metric is weighed separately cold and warm:

- static-export duration;
- server spawn-to-ready duration;
- sampled process-tree peak RSS, for the static export and for the server until ready.

A baseline's variability band is its observed [min, max] across three samples. The candidate is selected only if at least one observation's candidate maximum is below its baseline minimum, while every other observation's candidate median is no greater than its baseline maximum. Otherwise the baseline is retained. There is no percentage target, no limit is raised, and payload budgets, assertions, and timeouts are unchanged; the exporter's own payload budget assertions still gate both runs. `compare` refuses results from different source SHAs, lockfiles, or route inventories, refuses a baseline taken on a modified tree, and refuses any failed static export or missed readiness. Playwright and probe failures are reported in the run summary but feed no primary metric.

## Adaptations from the issue text

- **Preparation timing**: the cinder-era `tests/playground-documentation.playwright.ts` and `@cinder/testing`'s `test:playwright` were not ported. Preparation uses the Playground's own dev-server Playwright setup (`playwright.config.ts`, `test:browser`) against `tests/playground-shell-layout.playwright.ts`. Package prerequisite cost, server spawn-to-ready, and Playwright execution are reported separately.
- **The 16 functional and 8 visual matrix**: not applicable. Corvidae has no CI, and no such matrix exists.
- **CIN-404's sharded production gate (#185, not merged at this base)**: it has no fixed shard count, because `--shard i/n` is a run option. Each shard invocation starts exactly one static server over the existing `build/` and one Playwright run, after a preflight. It never compiles: no `Bun.build` and no exporter run. A full unsharded run is one static-server startup over about 846 cases, and _n_ shards cost _n_ static-server startups. That is the corvidae counterpart of the cinder matrix's repeated per-shard builds, and it was not run here.
- **Shared-entry experiment**: the candidate exists only as a scratch patch (`cin-585-shared-entry-experiment.patch`, SHA-256 `7aab234074e7d0da3099dd5ba06c82116944019a7b682d874b8c8f56f02417c7`), applied for the candidate runs and reverted afterwards. Every sample records `dirtyPaths` and the SHA-256 of `git diff HEAD`, and the candidate smoke samples recorded exactly this digest. The patch is excluded from the merged diff. It splits `compilePageBundleArtifacts` so the per-page entry and shim writing is reusable, then adds `compilePageBundleArtifactsTogether`. That function writes every page entry into one scratch directory and compiles them in one multi-entry `Bun.build` with the unchanged shared options. Each `page-<name>-<hash>.js` entry output publishes with every shared chunk, under the existing owners and the existing generation check. The server's eager prebuild calls it in place of the six-way bounded sweep, and the exporter calls it once before its crawl. An adapter-static prototype was not built, because no framework replacement is proposed; the comparison matrix gives the reason.
- **Retained artifact counts**: the probe reads the server's existing exported artifact owners (`build-artifacts-shared.ts`, `page-bundle.ts`, `shell-bundle.ts`, `scenario-bundle.ts`, `fixture-bundle.ts`, `manifest-cache.ts`) in the same process as the server. It adds no production code and patches nothing.
- **Observers and timers**: no owner boundary exposes them without patching. The probe records Chromium's DOM node, document, and JS event-listener counters (`Memory.getDOMCounters`) instead, and states that limit.

## Environment

| Field | Value |
| --- | --- |
| Measured revision | `f165d12291077b319fdef857376125e9fb1bd66f`: base `3ab0ee522eae2820af6a84d56f9db6f809cbcf7a` (contains #188 and #192) plus only the measurement scripts and this document, so the Playground sources are the base's |
| Candidate | that revision plus the scratch patch, `git diff HEAD` SHA-256 `7aab234074e7d0da3099dd5ba06c82116944019a7b682d874b8c8f56f02417c7`, recorded in every candidate sample |
| `bun.lock` SHA-256 | `727e5e3f8e0cf7de983a273e4583a57913dc0d35fd73d005cf17f757e73f2a33` |
| Bun | 1.4.2 (`packageManager: bun@1.4.2`) |
| Svelte | 5.57.0 |
| Playwright | 1.63.0 |
| OS | darwin 27.0.0, arm64 |
| CPU | Apple M1 Max, 10 logical processors |
| Memory | 68,719,476,736 bytes; no container limit (no cgroup on darwin) |
| Routes | 212 sitemap routes, identical for baseline and candidate: `/` and 211 `/page/<name>` documentation routes (181 sidebar components plus compound-family children); the list is `routeInventory` in the raw results |

Workspace package prerequisite cost is the `bun install --frozen-lockfile` preflight alone: 46 ms, exit 0, with nothing to install. No workspace library has a build task.

The navigation and 20-cycle rebuild diagnostics ran at `591bf0e0`, which adds only the server live-reload subscriber count to the probe snapshot.

## Host load and variability

This host is shared with many agent sessions, and its load swung from about 10 to over 340 on 10 logical processors during this work. The smoke runs at load 90 to 290 took two to three times longer than the recorded runs and missed the server's existing 300 s readiness limit, so no sample was recorded above the load gate.

- **Gate waits**: baseline samples started at 1-minute load 10.5 to 30.0 (static exports and server readiness 16.8 to 30.0, Playwright 12.9 and 14.2, the probes 10.5 and 12.8) and the timed samples ended at 14.2 to 45.3. The gate held four baseline samples for 60, 60, 30, and 420 s (630 s in all). Candidate samples started at 9.0 to 24.9 and were never held. Before any of this, the Phase 1 gate rerun waited 6,996 s for load to settle; `cin-585-results/phase-1-gate-wait.json` records that wait with its log.
- **Effect on the bands**: the baseline ran under somewhat higher load than the candidate. That widens the baseline's timing bands and favours the candidate's wall times, so wall time alone is not trusted for the CIN-588 evidence. Exporter CPU time, which load inflates far less, tells the same story: 1,044.8 to 1,074.8 s for the baseline against 504.1 to 517.7 s for the candidate. Resident-memory peaks depend on the work, not the load, and the two observations that decided against the candidate are memory observations.
- **Spread**: within one configuration, timing spread reached 20.4 percent (baseline cold server readiness, 102.6 to 123.5 s; baseline cold export 10.8 percent, 545.3 to 604.2 s), and resident-memory spread reached 14.5 percent (candidate cold export tree, 4.79 to 5.48 GB). Bands that wide are why the rule compares a candidate's extremes with the baseline's band rather than medians alone.

## Results

The raw results are `cin-585-results/baseline.json`, `candidate.json`, and `comparison.json`, with every sample, its load wait, its host load before and after, its source state, and the per-process and sampled tree peaks. Every figure below is taken from them; the medians are of three samples.

### Static export

| Configuration | Temperature | Wall time (s): samples / min / median / max | Sampled tree peak (GB): samples / median | Exporter's own peak (GB): median | Exporter CPU (s): median |
| --- | --- | --- | --- | --- | --- |
| Baseline | cold | 604.2, 558.6, 545.3 / 545.3 / 558.6 / 604.2 | 4.78, 5.11, 5.40 / 5.11 | 4.40 | 1,045.3 |
| Baseline | warm | 600.0, 583.9, 598.7 / 583.9 / 598.7 / 600.0 | 4.90, 5.19, 4.80 / 4.90 | 4.19 | 1,060.7 |
| Candidate | cold | 197.4, 210.8, 201.7 / 197.4 / 201.7 / 210.8 | 5.18, 5.48, 4.79 / 5.18 | 4.46 | 510.7 |
| Candidate | warm | 198.1, 206.0, 206.9 / 198.1 / 206.0 / 206.9 | 5.02, 5.61, 5.42 / 5.42 | 4.71 | 515.8 |

- **Emitted artifacts**: the baseline wrote 4,220 files, 291.3 MB (4,130 unique by content, 289.9 MB) in every sample. The candidate wrote 2,895 files, 63.7 MB (2,881 unique, 62.4 MB). Per-page builds re-emit shared modules under page-specific chunk hashes, and the shared build emits them once. Both passed the exporter's unchanged payload budgets.
- **Processes**: every export sample's tree held the exporter and 181 short-lived `bun` processes, one per featured-example render. Those processes are the reason the tree peak exceeds the exporter's own peak.
- **Warm against cold**: warm samples are not faster. The transpiler cache is not where the time goes; `Bun.build` and the featured-example processes are.

### Server readiness and Playwright

| Configuration | Temperature | Spawn to ready (s): samples / median | Tree peak until ready (GB): samples / median | Server process own peak (GB): samples |
| --- | --- | --- | --- | --- |
| Baseline | cold | 123.5, 102.6, 107.1 / 107.1 | 3.63, 3.63, 3.67 / 3.63 | 3.63, 3.63, 3.67 |
| Baseline | warm | 103.8, 103.2, 101.7 / 103.2 | 3.62, 3.56, 4.03 / 3.62 | 3.62, 3.56, 4.03 |
| Candidate | cold | 9.1, 8.9, 9.1 / 9.1 | 3.90, 3.98, 4.03 / 3.98 | 3.90, 3.98, 4.03 |
| Candidate | warm | 8.8, 9.1, 8.8 / 8.8 | 3.79, 4.05, 3.99 / 3.99 | 3.79, 4.05, 3.99 |

Every recorded server reached ready inside the existing 300 s limit, and every page bundle prebuilt (181 of 181). The server is one process, so its own `resourceUsage().maxRSS` matches its sampled tree peak to two decimals. The baseline `test:browser` run on `tests/playground-shell-layout.playwright.ts` passed 17 of 17, cold and warm, in 108.7 s and 108.3 s. Of that, 9.97 s and 9.85 s was test execution; the rest is the web server's own startup, which the readiness phase measures. The tree peak, including Chromium, was 5.20 GB and 5.12 GB.

### Navigation cycles

The recorded baseline run (`baseline.json`, probe as of `f165d122`) went through one warm-up cycle and five recorded cycles over home, Button, Action Row, Chat, Modal, and Review Editor. Each cycle made 189 requests and transferred 2,992,016 encoded bytes, identically.

- **Hero visible (paint, not interactivity)**: the time from navigation start to a visible prerendered hero heading. Home took 26 to 38 ms. From the second recorded cycle on, component pages took 49 to 124 ms; the first recorded cycle reached 181 ms for Chat and 234 ms for Review Editor. The heading is server-rendered, so this measures first paint of the content, not when the page responds to input.
- **Playground view**: opening it took 50 to 165 ms and closing it 46 to 62 ms.
- **Counters at the cycle checkpoint**: example mount hosts, DOM nodes (2,622), JS event listeners (23), and documents (1) were identical in every cycle, the JS heap held at 1.76 MB, and the server's retained artifacts held at 2,647 entries and 369,993,933 bytes.

### What each navigation counter can observe

That probe took its only browser checkpoint on home, after a full document navigation. A full navigation discards the previous document, so the browser counters there could not show retention inside a component page; they are vacuous for that question. `f35758e1` changes the probe to close that gap and to time readiness properly:

- **Hydrated**: navigation start to `#app[data-playground-controls-hydrated]`, which `page-bundle.ts` sets when the page's controls are hydrated. This is the interactivity signal. Home's shell sets no hydration marker, so home reports hero-visible time only.
- **Component-page checkpoint**: taken on each component page after the Playground view has opened, settled, and closed, before navigating away. Across cycles, a series there can show retention inside a page that one open-and-close leaves behind.
- **Live example mounts**: `[id^="example-mount-"]` hosts with children. They count mounts present in the DOM, but cannot see a component instance that stays alive after its host is removed.
- **DOM nodes, documents, JS event listeners**: Chromium's `Memory.getDOMCounters` after a forced collection. Detached-but-retained nodes still count, but listeners on non-DOM targets do not.
- **Open EventSource streams**: from CDP network events. The ledger now forgets a document's streams when the main frame navigates, so the count is the current document's open streams. The server-side `liveReloadSubscribers` (`sseClients.size`) is the owner's own count and the check against it.
- **Observers and timers**: not observable at any owner boundary without patching, so not counted.
- **JS heap**: `Runtime.getHeapUsage` after `HeapProfiler.collectGarbage`; never added to RSS.

The gated five-cycle rerun with these counters (`diagnostic-navigation-2.json`) is pending: it runs only when the 1-minute load is at most 30, and the 30 s Playwright navigation default stays unchanged.

### Edit/rebuild cycles

Five rewrites of the disposable Button example each reached the watcher's invalidation in 121 to 122 ms and were rebuilt and served in 1.71 to 1.76 s. Retained artifacts held at 2,648 entries and 369,995,056 bytes throughout, with no build left in flight, and fell by one page artifact when the fixture was removed. The server holds about 366 MB of page JavaScript for 181 pages in its artifact maps. A hypothesis for CIN-588 to test, not a measured result: a shared graph that emits each shared module once should shrink that in-memory figure much as it shrank the exported bytes (291.3 MB to 63.7 MB). No candidate run here measured the server's retained artifact bytes.

## Comparison matrix

| Candidate | Verdict | Evidence and reason |
| --- | --- | --- |
| Shared multi-entry page build | Reject as measured; carry to CIN-588 with batched collection and a memory gate | Every timing observation improved beyond the baseline band, but two resident-memory medians exceeded the baseline maximum, so the rule retains the baseline. The experiment also dropped the sweep's periodic forced collection, which confounds the memory result. |
| Server-side rendering of documentation | Retain | Every exported page is server-rendered and asserted pre-rendered by the exporter; warmed component pages reach a visible hero in 49 to 234 ms. |
| Strict prerendering | Retain | The static export already prerenders all 212 routes and fails the build if any page is blank. |
| Lazy route code | Retain | Scenarios and the bare component already load on demand; opening the Playground view takes 50 to 165 ms warmed, with no growth across cycles. |
| Native-link fallback | Retain, and require it in CIN-589 | Every route is a complete static document, so a plain link always works. |
| Intent preloading | Reject for now | No measured navigation misses a target: after the first recorded cycle, component pages show their hero within 124 ms (234 ms in the first; paint, not hydration), and preloading would add requests to the 189 per cycle without a measured need. CIN-589 may revisit it with its own measurement. |
| Focus and announcements on navigation | Adopt as a CIN-589 requirement | A full document navigation resets focus natively; a client-side swap must do it itself. |
| Static hosting | Retain | The exported `build/` is the deployment, and CIN-404's gate serves that output without compiling. |
| Cross-shard artifact reuse | Reject | CIN-404's shards serve the existing `build/` and never compile, so there is no repeated build to reuse. The repeated cost measured here is inside one export. |
| Framework replacement (adapter-static) | Reject; no prototype built | The architecture is already a static site generated from prerendered routes. The costs measured here, per-page compilation and the per-render featured-example processes, are addressable inside it, as the candidate's halved CPU time shows. |

## Leaks

No leak was reproduced, and no issue is proposed. Every series the growth classifier marked `monotonic-growth` (never fell, ended higher) in any committed run is listed here with its owner-level evidence.

| Run | Series | Change | Owner-level evidence | Classification |
| --- | --- | --- | --- | --- |
| `baseline.json` navigation | `openEventSources` (browser) | 14 to 42, +7 per cycle | The server's `sseClients` held exactly one stream at every checkpoint (`diagnostic-navigation.json`) | CDP tracking artifact: a stream torn down with its document emits no close event. Fixed in `f35758e1`, which forgets a document's streams at each main-frame navigation. |
| `baseline.json` navigation | `jsHeapUsedBytes` | +768 bytes, once, in cycle 5 | DOM nodes, documents, and listeners identical in every cycle | Below any owner's resolution |
| `baseline.json` navigation | `probeResidentBytes` | +0.18 MB over five cycles (3,739.78 to 3,739.96 MB) | Retained server artifacts flat at 2,647 entries and 369,993,933 bytes | Below any owner's resolution |
| `baseline.json` rebuild | `probeResidentBytes` | +43.5 MB over five edits | JS heap and retained artifacts flat; attributed below | Bounded allocator behaviour |
| `diagnostic-navigation.json` | `openEventSources` (browser) | 14 to 42 | Server `sseClients` stayed at 1 | Same CDP artifact |
| `diagnostic-rebuild.json` | `pageArtifactBytes`, `totalArtifactBytes` | +2 bytes from cycle 10 | Entry and artifact counts flat | The fixture's own text: its cycle number gains a digit and appears twice |
| `diagnostic-rebuild.json` | `probeResidentBytes` | +31.4 MB over 22 readings | Never fell across all 22 readings; rose 0.85 MB over the last eight intervals (4,078.31 to 4,079.16 MB); JS heap 752 to 755 MB; artifacts flat | Bounded allocator behaviour, attributed below |
| `diagnostic-rebuild-footprint.json` | `footprint JS JIT Generated Code dirty` | 24 to 25 MB, one 1 MB step at edit 19 | JIT code is allocated in chunks; one step in 20 edits | Below the resolution of a 20-edit run |
| `diagnostic-rebuild-footprint.json` | `footprint Malloc Small dirty` | 1.83 to 1.88 MB, flat after edit 7 | System malloc small zone | Plateau |

### Allocation evidence for the rebuild growth

`diagnostic-rebuild-footprint.json` repeats the 20-edit rebuild at `b68efe09` with `footprint <pid>` read for the server's process at every checkpoint (before the edits, after each edit, and after the fixture is removed: 22 readings), each after a forced collection, and with host load and memory pressure recorded beside it.

It ran ungated, at 1-minute load 174 (start) and 180 to 196 (checkpoints), on the coordinator's instruction. Region attribution and retained counts do not depend on CPU load, and the gate had held the rerun for over an hour. Memory pressure was high: 63 to 67 percent available, 16.0 to 18.5 GB in the compressor. Under that pressure the kernel compresses idle pages, so this run's resident size (2,518 to 3,098 MB, fluctuating) cannot be compared with the gated run's 4,048 to 4,079 MB. `footprint` counts compressed dirty pages, so it is the attribution measure here.

- **Where the memory is**: one category, `App-Specific Tag 1`, is almost all of the server's footprint (1,032 to 1,662 MB dirty across the 22 readings). It is an application-tagged VM region: not a system malloc zone, a mapped file, or JIT code. `footprint` does not attribute it further, but it belongs to the process's own runtime allocator, not to any measured Playground owner. The next largest are `JS JIT Generated Code` (24 to 25 MB), `WebKit Malloc` (7.7 MB), and `WebAssembly Memory` (6.5 MB).
- **Why it is bounded**: across all 22 readings `App-Specific Tag 1` kept exactly 49 regions, so no new memory was mapped. It carried 1.24 to 2.04 GB marked reclaimable (freed by the allocator, not yet taken back by the kernel), and its dirty size moved both ways: 1,108 MB after the first edit, 1,390 MB at its highest, and 1,124 MB after the fixture was removed. The total footprint followed it (1,081 to 1,390 MB across the edits) and never trended upward. Retained artifacts held at 2,648 entries, and the JS heap stayed between 710 and 716 MB.
- **Reading of the gated run's rise**: the +31.4 MB resident rise in `diagnostic-rebuild.json` is smaller than the 300 MB swings the same allocator region shows from one edit to the next. That fits pages being reused and released lazily, not a retained owner.

Every series is bounded or allocator behaviour, so there is no owner to file against. If edit sessions grow far beyond 20 saves, a longer `footprint` run is the next check, and the JIT region is the one to watch.
