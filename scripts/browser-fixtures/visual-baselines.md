# Visual baselines

This is the operator's guide for the committed Linux visual baselines that `CINDER_VISUAL_DIFF=block` compares against. It covers where they live, which renderer is authoritative, how to check and regenerate them, and how a refresh is reviewed. The tooling was ported from cinder's `testing/testing` and adapted for corvidae in COR-1512.

## Where baselines live

The browser suite writes and reads baselines at `scripts/browser-fixtures/snapshots/{projectName}/{platform}/`. The committed set is the Chromium Linux tree, `snapshots/chromium/linux/`, plus its `provenance.json`. Each component's images are named `<theme>-<viewport>-<fixture>.png`, two themes by three viewports for every fixture in the manifest.

`provenance.json` records how the set was rendered: the source commit (`renderedSourceSha`), the Playwright version, the operating system codename, the architecture, the renderer image tag, and the suite's exit code (`suiteExitCode`: 0 when every case passed, 1 when the run completed with failures). Only the update tooling writes it; never edit it by hand.

The top-level record always describes the last full run, so its `componentScope` is `"all"`. A refresh scoped by `CINDER_TEST_COMPONENTS` keeps that record and adds one entry per rendered component under `componentRenders`, keyed by slug, with that render's `renderedSourceSha` and `suiteExitCode` (COR-1574). The wrapper refuses a scoped render whose Playwright version, codename, architecture, or image tag differ from the full-run record's, because one record could not describe both; refresh the full set instead. The next full run writes a record without `componentRenders`. `baseline-provenance.test.ts` checks the top-level record and every component render against the lockfile's renderer.

The comparison tolerance is `maxDiffPixels: 2` at `threshold: 0.1`, declared once as `SNAPSHOT_DIFF_OPTIONS` in `testing/testing/src/helpers/screenshot.ts`. Changing it is out of scope for a baseline refresh.

## The authoritative renderer

Baselines reproduce only on the renderer that wrote them, so there is exactly one: native `linux/arm64` inside `mcr.microsoft.com/playwright:v<version>-jammy`, built from `scripts/browser-fixtures/Dockerfile` as `corvidae-browser-fixtures:<version>-jammy-arm64`.

This reverses cinder's rule, which required x64 to match its `ubuntu-latest` CI runner. Corvidae has no CI, and the host that maintains the baselines is Apple Silicon with no native amd64. Emulated amd64 ran about 17 tests a minute there and timed out behavioural specs, so it could not run the suite at all (COR-1512).

Both versions are derived, never typed:

- Playwright is the version `bun.lock` resolves for `@playwright/test`.
- Bun is the root `packageManager` pin.

The Docker wrapper passes both as build arguments. The image bakes `BASELINE_PLAYWRIGHT_VERSION` and `BASELINE_DOCKER=1`, and a unit test fails if the Dockerfile or the build arguments stop deriving from the repository.

## Why baselines are written only in the renderer

`bun run test:browser:update` runs `scripts/browser-fixtures/scripts/update-snapshots.ts`, which refuses unless every authenticity check passes:

- `/etc/os-release` names `jammy`;
- the installed `@playwright/test` matches `bun.lock`;
- the image baked the same Playwright version and `BASELINE_DOCKER=1`, which proves the container was built from this repository's Dockerfile rather than being any container with a flag set;
- `process.arch` is `arm64`. The Playwright base image is multi-arch, so an amd64 container passes the first three checks with a different rasterizer.

On a development host it exits non-zero and points at the Docker path. Inside the renderer it runs the suite with `--update-snapshots=all --retries=0`, because a retry-passing run is never authoritative. When Playwright completes, whether every case passed or some failed, it writes `provenance.json`; a crash or an interrupt writes none. It first reads the JSON report back from `PLAYWRIGHT_JSON_OUTPUT_FILE`, which it requires: a webServer or globalSetup failure also exits 1, so when the report is missing, unreadable, or shows the run did not complete normally (see below), it writes no provenance and exits 3.

## The Docker workflow

Two root scripts drive the renderer from the host:

```bash
bun run test:browser:visual:docker
bun run test:browser:update:docker
```

Both accept `--source <ref>` (default `HEAD`) and forward any other arguments to Playwright, after `--reporter=line,json`; the JSON report goes to `/out/results.json` (`PLAYWRIGHT_JSON_OUTPUT_FILE`). Each run follows the same isolation rules:

- The exact commit enters the container as `git archive <sha>` on stdin. The host checkout and its `node_modules` are never mounted, so uncommitted changes cannot leak into a run. Commit first, then run.
- The container installs from the lockfile with `bun install --frozen-lockfile`.
- The only mount is an empty output directory under the temporary directory. The container copies the Linux baselines, the list of regenerated files, the fixture manifest, the JSON report, and Playwright's `test-results` into it, owned by the host user (`BASELINE_HOST_UID` and `BASELINE_HOST_GID`). The commit is passed as `BASELINE_SOURCE_SHA`, since the archive has no `.git`.
- The container runs as `corvidae-baselines-<run id>` with `--rm` and `--init`. On SIGINT or SIGTERM the wrapper runs `docker kill` on that name, waits for it to exit, and exits `128 + signal`.

`test:browser:visual:docker` runs the whole suite in block mode, exits with the suite's status, and writes `suite-results.json` (every failing test, screenshot or behavioural) into its run directory. There is no screenshot-only filter. Failure artefacts stay in the printed output directory. A visual run that did not complete normally (see below) prints why on standard error and never exits 0.

`test:browser:update:docker` first deletes every Linux baseline inside the container, because `--update-snapshots=all` does not rewrite a baseline that already matches within tolerance; every baseline a test uses is then written fresh. After the run it:

- extracts the committed baselines from `git archive <sha>` (never the working tree) and compares them with the regenerated set;
- writes the review report described below into the run directory and prints its path;
- copies into the working tree only the baselines whose pixels changed, those whose dimensions changed, those that were added or renamed, and `provenance.json` (a full run's own record, or a scoped run's component renders merged into the working tree's record), and, after a full, unfiltered run, removes every orphan. A baseline the update rewrote with identical pixels keeps its committed bytes, so history does not take a copy of unchanged images. `git status` then shows exactly what a refresh commits.

A suite that completed with behavioural failures is applied only with `--accept-behavioural-failures`, after confirming each failure also occurs on an `origin/main` control. A screenshot failure is never accepted, and a run that crashed or was interrupted is never applied. The report records the suite's exit code and every failing test either way.

One failure is expected rather than accepted. `terminal-visual.playwright.ts` holds a guard, "the screenshot scope includes the terminal, so every cell captures an image", that fails whenever `CINDER_TEST_COMPONENTS` leaves the terminal out, so a leftover variable cannot silently skip the terminal's images. On a run scoped by `CINDER_TEST_COMPONENTS`, a suite whose only failure is that guard (matched by its file and exact title) is applied without `--accept-behavioural-failures` (COR-1574). On a full run, or next to any other failure, it blocks like every other failure.

### Incomplete runs fail closed

Because the container deletes every Linux baseline before the suite runs, a run that never reached a test leaves nothing regenerated, and every committed baseline then reads as an orphan. On 2026-10-15 a host load spike timed out Playwright's webServer at startup: no test ran, Playwright still exited 1 with a report, and the wrapper wrote nothing and deleted all 1,624 committed baselines from the working tree, which the operator restored before committing (COR-1537). The wrapper now refuses such a run before building a review report. It writes nothing, deletes nothing, prints why on standard error, and exits non-zero, whatever the exit code and whether or not `--accept-behavioural-failures` was passed. A run is incomplete when:

- it left no `results.json`, or one that does not parse (a crash mid-write);
- the report carries a top-level error, outside any test: a webServer timeout, a globalSetup failure, or a test file that failed to load;
- Playwright selected no tests, or no selected test executed;
- any selected test never ran. This uses Playwright's own "did not run": a test with no result, an interrupted result, or a skipped result on a test that did not skip itself. Tests that call `test.skip()` are not counted. The check is exact rather than a ratio, so one unreached test is enough to refuse.

Two further guards apply to a run that did complete. If it regenerated no baseline at all, the wrapper deletes nothing and exits 1. And orphans are deleted only after a full, unfiltered run: when `CINDER_TEST_COMPONENTS` scoped the run or any Playwright argument was forwarded (for example `--grep`), the wrapper still writes the changed baselines and provenance, but keeps every orphan and says how many it kept, because such a run never selected the tests that own them. Its report and summary then say "Kept orphans" and `kept N orphans`, never that orphans were deleted.

The stability comparison follows the same rule. `suite-results.ts compare` fails when either the run or the control did not complete normally, and lists why, because a run that executed nothing has no failures to compare.

## Host load

Host load never blocks a run. Each run records the 1-minute load average and the logical CPU count at its start and end, prints them, and the update run writes them into the review report. A behavioural timeout can then be read against the load it ran under; if the same failure reproduces against an `origin/main` control at the same time, it is not the refresh's blocker and is recorded as such. Suite timeouts are never raised to compensate.

## Refreshing the baselines

A refresh is two commits on one branch, then a control:

- Commit the change that needs new baselines (or the tooling itself). Call it T.
- Run `bun run test:browser:update:docker -- --source T`. Review the report, then commit the applied baselines, deletions, and `provenance.json` as B. Provenance records `renderedSourceSha` T.
- Run `bun run test:browser:visual:docker -- --source B`, and the same command against `origin/main` as a control in the same image under the same conditions. Then run `bun scripts/browser-fixtures/scripts/suite-results.ts compare <B suite-results.json> <main suite-results.json>`. The stability rule holds when no screenshot case fails and every behavioural failure in B also fails on the control; it prints both failure sets for the pull request.

After the pull request merges, run the same visual command against the merged commit and record the result. That run, not provenance, proves the set reproduces on `main`.

## The review report

`scripts/browser-fixtures/scripts/baseline-diff-report.ts` compares every regenerated baseline with the committed one it replaces and writes `baseline-diff-report.json`, `baseline-diff-report.md`, and a diff image per changed baseline:

- a changed pixel is one pixelmatch flags at the suite's `threshold: 0.1`, and the ratio is changed pixels over the new image's width times height;
- unchanged means pixel-identical, and byte-identical is a subset of it;
- a dimension change is reported as such, with no ratio;
- added baselines (no committed counterpart) are listed;
- a committed baseline that was not regenerated, but belongs to a test that failed or was skipped in the run, is restored: it keeps its committed bytes and is listed as "restored, not regenerated" with the failure reason, because that test may never have reached its screenshot. A sweep test owns the images its title names (and their `-resting` partners); any other spec owns the screenshot names it quotes;
- orphans (committed, regenerated by no test in a full, unfiltered run, and owned by no failing or skipped test) are deleted, because no test can ever compare against them. A scoped run keeps them and reports them under "Kept orphans" headings, and an incomplete run is refused before any report is written. A cinder-era `<theme>-<viewport>-default.png` whose `-assertion.png` counterpart was added is a rename: the report compares the pair pixel by pixel and lists it with its partner. Every other orphan is listed with the evidence that no current fixture or spec names it;
- the suite's exit code, every failing test, and the host load.

Every changed or renamed image above 1%, and every dimension change, gets one line in the pull request with one of three classifications:

- **rasterizer or toolchain drift**: the renderer changed (Playwright, Chromium, fonts, operating system, architecture) while the source did not;
- **intentional source change**: a component or style change that was never re-baselined. Cite the commit;
- **unintended regression**: anything else. It blocks the merge, gets its own COR issue as a native blocker, and needs Steve's sign-off before the refresh proceeds.

## Supporting scripts

All live in `scripts/browser-fixtures/scripts/`, each with a unit test:

- `docker-authenticity.ts`: the renderer checks above.
- `baseline-provenance.ts`: provenance read and write, the lockfile and `packageManager` pins, and the image tag.
- `update-snapshots.ts`: the in-container update entry point.
- `update-snapshots-docker.ts` and `run-browser-docker.ts`: the host entry points.
- `suite-results.ts`: summaries of Playwright's JSON report, the incomplete-run check, the apply decision, and the stability comparison (`compare` command).
- `docker-baseline-runner.ts`: the shared host load record, image build, archive, container run, kill-on-signal, and apply step.
- `baseline-diff-report.ts`: the review report.
- `snapshot-change-detection.ts`: exits 0 when the working tree has baseline or provenance changes, 1 when it has none.

## Terminal fixtures

The terminal's baselines (`snapshots/chromium/linux/terminal/`) come from the `terminal` fixture group, `src/fixtures/terminal.svelte` with its helpers in `src/fixtures/terminal/`, and are owned by `tests/terminal-visual.playwright.ts`; `components.playwright.ts` skips the `terminal` entry so each image has one writer. `bun run test:browser:terminal` runs the `terminal-*.playwright.ts` specs in Chromium, Firefox and WebKit (the `firefox-terminal` and `webkit-terminal` projects), lists its selection first and fails when a browser, a spec in one browser or a baseline cell is missing. It is not part of `bun run validate`. Choices a reader of those files will meet:

- **Fixture IDs**: one fixture per state or variant, because an ID is a file name and cannot hold a `/`: `loading` and `connecting`, `exited` and `disconnected`, `denied`, `failed` and `engine-load-failed` are separate. `lab` is the interactive fixture every behavioral spec drives; it has a resting baseline too.
- **Error states come from the `state` prop**, never from a real failure, because the shared sweep fails any page that logs an error. Real failures (a 404 for the engine, a Content Security Policy denial, a canceled initialization, a thrown handler) are in `terminal-failure.playwright.ts`.
- **Platform shim**: the emulated Chrome device sends a Windows user agent from whatever host runs it, while the engine reads `navigator.platform`. `installSideEffectRecorder` in `tests/terminal-support.ts` makes the two agree, so Chromium exercises the Shift selection modifier and Firefox and WebKit, which report a Mac, the Option one on a Mac host.
- **Input methods**: IME and dead keys are dispatched `CompositionEvent`s and key events, plus Chromium's `Input.imeSetComposition`; they are not operating-system input.
- **Server render**: `terminal-failure.playwright.ts` sets `NODE_ENV=test` before rendering on the server, because the render helper's child process compiles Svelte for development otherwise and cannot render a mix.
- **Pressed controls**: the `keyboard-capture` and `keyboard-mouse-reporting` fixtures turn capture on after the page is visible and again after the sweep's single blur, since a blur correctly releases it.
