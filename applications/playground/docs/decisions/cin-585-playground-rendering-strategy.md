# Playground build costs and rendering strategy (CIN-585)

Status: measurement protocol and tooling ready; recorded results pending (Phase 2). Every _pending_ marker below is filled from the committed raw results before this decision is final.

## Decision

_Pending the recorded runs._ The selection rule below decides between retaining the baseline (per-page entry compilation, as merged at the source SHA in the environment table) and adopting the shared multi-entry candidate. This section will name:

- **Rendering and build strategy**: retain or adopt, with the rule's printed reasons.
- **CIN-588 mechanism**: the shared documentation graph mechanism CIN-588 should implement, or an explicit retention of the baseline.
- **CIN-589 contract**: the route-data, CSS, and loading contract progressive client-side navigation should use.

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
- **Load gate**: before every sample, including a warm sample that follows its cold one, the script waits while the one-minute load average exceeds three times the logical processor count (30 on this host). It polls every 30 s with no deadline and records the wait (threshold, checks, waited milliseconds, and the load at start) with the sample. A warm sample held by the gate starts later than "immediately", and its recorded wait says by how much.
- **`Bun.build` count**: derived from the source rather than intercepted. A static export makes one shell browser build, one page browser build per documentation route, one shell server-renderer build, one page server-renderer build, and one build per stylesheet (`documentation`, `landing`) inside the exporter process. It also makes one featured-example server build per featured render, and each of those runs in its own spawned `bun` process. Scenario and fixture builds are lazy, and the export never requests them. At the measured source, the smoke runs saw 211 documentation routes (212 sitemap routes including `/`) and 181 featured renders (182 pids observed in the exporter's tree). That gives 1 + 211 + 1 + 1 + 2 + 181 = 397 builds for the baseline, and 1 + 1 + 1 + 1 + 2 + 181 = 187 for the candidate, whose 211 page builds collapse into one. _Pending confirmation against the recorded run._ Emitted artifacts are counted from `build/` on disk, as files and bytes in total and as unique content by SHA-256.

### Selection rule

Each primary metric is weighed separately cold and warm:

- static-export duration;
- server spawn-to-ready duration;
- sampled process-tree peak RSS, for the static export and for the server until ready.

A baseline's variability band is its observed [min, max] across three samples. The candidate is selected only if at least one observation's candidate maximum is below its baseline minimum, while every other observation's candidate median is no greater than its baseline maximum. Otherwise the baseline is retained. There is no percentage target, no limit is raised, and payload budgets, assertions, and timeouts are unchanged; the exporter's own payload budget assertions still gate both runs. `compare` refuses results from different source SHAs, lockfiles, or route inventories, and refuses a baseline taken on a modified tree.

## Adaptations from the issue text

- **Preparation timing**: the cinder-era `tests/playground-documentation.playwright.ts` and `@cinder/testing`'s `test:playwright` were not ported. Preparation uses the Playground's own dev-server Playwright setup (`playwright.config.ts`, `test:browser`) against `tests/playground-shell-layout.playwright.ts`. Package prerequisite cost, server spawn-to-ready, and Playwright execution are reported separately.
- **The 16 functional and 8 visual matrix**: not applicable. Corvidae has no CI, and no such matrix exists.
- **CIN-404's sharded production gate (#185, not merged at this base)**: it has no fixed shard count, because `--shard i/n` is a run option. Each shard invocation starts exactly one static server over the existing `build/` and one Playwright run, after a preflight. It never compiles: no `Bun.build` and no exporter run. A full unsharded run is one static-server startup over about 846 cases, and _n_ shards cost _n_ static-server startups. That is the corvidae counterpart of the cinder matrix's repeated per-shard builds, and it was not run here.
- **Shared-entry experiment**: the candidate exists only as a scratch patch (`cin-585-shared-entry-experiment.patch`, SHA-256 `7aab234074e7d0da3099dd5ba06c82116944019a7b682d874b8c8f56f02417c7`), applied for the candidate runs and reverted afterwards. Every sample records `dirtyPaths` and the SHA-256 of `git diff HEAD`, and the candidate smoke samples recorded exactly this digest. The patch is excluded from the merged diff. It splits `compilePageBundleArtifacts` so the per-page entry and shim writing is reusable, then adds `compilePageBundleArtifactsTogether`. That function writes every page entry into one scratch directory and compiles them in one multi-entry `Bun.build` with the unchanged shared options. Each `page-<name>-<hash>.js` entry output publishes with every shared chunk, under the existing owners and the existing generation check. The server's eager prebuild calls it in place of the six-way bounded sweep, and the exporter calls it once before its crawl. An adapter-static prototype was not built, because no framework replacement is proposed; the comparison matrix gives the reason.
- **Retained artifact counts**: the probe reads the server's existing exported artifact owners (`build-artifacts-shared.ts`, `page-bundle.ts`, `shell-bundle.ts`, `scenario-bundle.ts`, `fixture-bundle.ts`, `manifest-cache.ts`) in the same process as the server. It adds no production code and patches nothing.
- **Observers and timers**: no owner boundary exposes them without patching. The probe records Chromium's DOM node, document, and JS event-listener counters (`Memory.getDOMCounters`) instead, and states that limit.

## Environment

Recorded by the smoke runs (the recorded runs restate them):

| Field | Value |
| --- | --- |
| Source SHA | `3ab0ee522eae2820af6a84d56f9db6f809cbcf7a` (contains #188 and #192) |
| `bun.lock` SHA-256 | `727e5e3f8e0cf7de983a273e4583a57913dc0d35fd73d005cf17f757e73f2a33` |
| Bun | 1.4.2 (`packageManager: bun@1.4.2`) |
| Svelte | 5.57.0 |
| Playwright | 1.63.0 |
| OS | darwin 27.0.0, arm64 |
| CPU | Apple M1 Max, 10 logical processors |
| Memory | 68,719,476,736 bytes; no container limit (no cgroup on darwin) |
| Routes | 212 sitemap routes: `/` and 211 `/page/<name>` documentation routes (181 sidebar components plus compound-family children); the full list is in the raw results |

Workspace package prerequisite cost is the `bun install --frozen-lockfile` preflight alone, reported separately in the raw results.

## Host load and variability

_Pending._ This host is shared with many agent sessions, and its load swings between about 20 and over 200 on its logical processors. A band taken under load is wide, and a narrow band does not mean a quiet host. Each band is read against the load recorded beside its samples, and a candidate is never selected on a difference smaller than the overlap the load allows.

## Results

_Pending: raw results committed beside this document, with every sample and each median._

### Static export

_Pending._

### Server readiness and Playwright

_Pending._

### Navigation cycles

_Pending._

### Edit/rebuild cycles

_Pending._

## Comparison matrix

| Candidate | Verdict | Evidence and reason |
| --- | --- | --- |
| Shared multi-entry page build | _pending_ | Selection rule on the recorded pairs. |
| Server-side rendering of documentation | _pending_ |  |
| Strict prerendering | _pending_ |  |
| Lazy route code | _pending_ |  |
| Native-link fallback | _pending_ |  |
| Intent preloading | _pending_ |  |
| Focus and announcements on navigation | _pending_ |  |
| Static hosting | _pending_ |  |
| Cross-shard artifact reuse | _pending_ | Stays retain/reject unless measurement proves a benefit and a separately scoped issue is approved. |
| Framework replacement (adapter-static) | _pending_ | A prototype is required only if this decision proposes a replacement. |

## Leaks

_Pending._ Any series that grows monotonically across the five cycles is reported with its owner and allocation evidence, a reproduction, and a failing check, and is filed as its own issue before this decision is complete. Growth is not labelled caching without evidence.
