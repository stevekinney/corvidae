# Visual baselines

This is the operator's guide for the committed Linux visual baselines that `CINDER_VISUAL_DIFF=block` compares against. It covers where they live, which renderer is authoritative, how to check and regenerate them, and how a refresh is reviewed. The tooling was ported from cinder's `packages/testing` and adapted for corvidae in COR-1512.

## Where baselines live

The browser suite writes and reads baselines at `scripts/browser-fixtures/snapshots/{projectName}/{platform}/`. The committed set is the Chromium Linux tree, `snapshots/chromium/linux/`: 1,372 PNG files plus `provenance.json`. Each component's images are named `<theme>-<viewport>-<fixture>.png`, two themes by three viewports for every fixture in the manifest.

`provenance.json` records how the set was rendered: the source commit (`renderedSourceSha`), the Playwright version, the operating system codename, the architecture, and the renderer image tag. Only the update tooling writes it; never edit it by hand.

The comparison tolerance is `maxDiffPixels: 2` at `threshold: 0.1`, declared once as `SNAPSHOT_DIFF_OPTIONS` in `packages/testing/src/helpers/screenshot.ts`. Changing it is out of scope for a baseline refresh.

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

On a development host it exits non-zero and points at the Docker path. Inside the renderer it runs the suite with `--update-snapshots=all --retries=0`, because a retry-passing run is never authoritative, and then writes `provenance.json`.

## The Docker workflow

Two root scripts drive the renderer from the host:

```bash
bun run test:browser:visual:docker
bun run test:browser:update:docker
```

Both accept `--source <ref>` (default `HEAD`) and forward any other arguments to Playwright. Each run follows the same isolation rules:

- The exact commit enters the container as `git archive <sha>` on stdin. The host checkout and its `node_modules` are never mounted, so uncommitted changes cannot leak into a run. Commit first, then run.
- The container installs from the lockfile with `bun install --frozen-lockfile`.
- The only mount is an empty output directory under the temporary directory. The container copies the Linux baselines, the list of regenerated files, and Playwright's `test-results` into it, owned by the host user (`BASELINE_HOST_UID` and `BASELINE_HOST_GID`). The commit is passed as `BASELINE_SOURCE_SHA`, since the archive has no `.git`.
- The container runs as `corvidae-baselines-<run id>` with `--rm` and `--init`. On SIGINT or SIGTERM the wrapper runs `docker kill` on that name, waits for it to exit, and exits `128 + signal`.

`test:browser:visual:docker` runs the whole suite in block mode and exits with the suite's status. Every behavioural and screenshot case must pass; there is no screenshot-only filter. Failure artefacts stay in the printed output directory.

`test:browser:update:docker` regenerates the baselines, then:

- extracts the committed baselines from `git archive <sha>` (never the working tree) and compares them with the regenerated set;
- writes the review report described below into the run directory and prints its path;
- copies into the working tree only the baselines whose pixels changed, those whose dimensions changed, those that were added, and `provenance.json`. A baseline the update rewrote with identical pixels keeps its committed bytes, so history does not take a copy of unchanged images. `git status` then shows exactly what a refresh commits.

If the update run fails, nothing is applied.

## Host load

Host load never blocks a run. Each run records the 1-minute load average and the logical CPU count at its start and end, prints them, and the update run writes them into the review report. A behavioural timeout can then be read against the load it ran under; if the same failure reproduces against an `origin/main` control at the same time, it is not the refresh's blocker and is recorded as such. Suite timeouts are never raised to compensate.

## Refreshing the baselines

A refresh is two commits on one branch, then a control:

- Commit the change that needs new baselines (or the tooling itself). Call it T.
- Run `bun run test:browser:update:docker -- --source T`. Review the report, then commit the applied baselines and `provenance.json` as B. Provenance records `renderedSourceSha` T.
- Run `bun run test:browser:visual:docker -- --source B`. It must exit 0, with every behavioural and screenshot case passing.

After the pull request merges, run the same visual command against the merged commit and record the result. That run, not provenance, proves the set reproduces on `main`.

## The review report

`scripts/browser-fixtures/scripts/baseline-diff-report.ts` compares every regenerated baseline with the committed one it replaces and writes `baseline-diff-report.json`, `baseline-diff-report.md`, and a diff image per changed baseline:

- a changed pixel is one pixelmatch flags at the suite's `threshold: 0.1`, and the ratio is changed pixels over the new image's width times height;
- unchanged means pixel-identical, and byte-identical is a subset of it;
- a dimension change is reported as such, with no ratio;
- added baselines and orphaned ones (committed, but regenerated by no test) are listed separately. Orphans stay in place; deleting them is a separate change.

Every changed image above 1% gets one line in the pull request with one of three classifications:

- **rasterizer or toolchain drift**: the renderer changed (Playwright, Chromium, fonts, operating system, architecture) while the source did not;
- **intentional source change**: a component or style change that was never re-baselined. Cite the commit;
- **unintended regression**: anything else. It blocks the merge, gets its own COR issue as a native blocker, and needs Steve's sign-off before the refresh proceeds.

## Supporting scripts

All live in `scripts/browser-fixtures/scripts/`, each with a unit test:

- `docker-authenticity.ts`: the renderer checks above.
- `baseline-provenance.ts`: provenance read and write, the lockfile and `packageManager` pins, and the image tag.
- `update-snapshots.ts`: the in-container update entry point.
- `update-snapshots-docker.ts` and `run-browser-docker.ts`: the host entry points.
- `docker-baseline-runner.ts`: the shared host load record, image build, archive, container run, kill-on-signal, and apply step.
- `baseline-diff-report.ts`: the review report.
- `snapshot-change-detection.ts`: exits 0 when the working tree has baseline or provenance changes, 1 when it has none.
