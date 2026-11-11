# Host admission for heavy work outside `bun test`

Two controls bound the work this repository puts on a development host. The host lock (`scripts/run-exclusively.ts`) serializes the heavy root stages, and the test slot pool (`scripts/bun-test-pool.ts`) bounds the Bun test workers on the host, whoever starts them. On 2026-11-11, with both in place, the 12-core, 32 GB host still ran at 0.3% idle CPU, with 34% system time and 11 GB of memory compressed. What it was running then: the Docker VM of a `corvidae-baselines-*` container at 137%, `chrome-headless-shell` at 118%, and several Cinder `preview-shard.ts` processes at 30 to 76% each (COR-2398). This document lists the entry points that start a browser, a container or a fan-out of worker processes outside `bun test` and outside the locked stages, and what admits each one.

## Inventory

How each was invoked, how many processes it runs at once and what bounds that, and whether it took a slot or the lock before COR-2398. Measurements were taken on 2026-11-11 on the busy 12-core, 32 GB host, with a one-minute load of about 15, running each entry point alone. A sampler read the process tree once a second and recorded the peak summed `%CPU` and resident memory. Such a sample misses short peaks, and `%CPU` is the kernel's decaying average. Runs longer than a couple of minutes, and every Docker run, were not measured, so the host would not carry them for long.

| Entry point | How it is invoked | Processes at once, and their bound | Measured alone | Slot or lock before COR-2398 |
| --- | --- | --- | --- | --- |
| `scripts/browser-fixtures/scripts/update-snapshots-docker.ts` | `bun run test:browser:update:docker`, by hand | `docker build`, then one `docker run` of the Playwright suite. The container had no `--cpus` limit, and Playwright in it starts half the Docker VM's processors as workers, each with a browser | Not measured: a full run takes many minutes in the Docker VM. The 2026-11-11 snapshot showed the VM at 137% | Neither |
| `scripts/browser-fixtures/scripts/run-browser-docker.ts` | `bun run test:browser:visual:docker`, by hand | The same container as above, running `bun run test:browser:visual` | Not measured, for the same reason | Neither |
| `scripts/browser-fixtures/scripts/update-snapshots.ts` | `bun run test:browser:update`, only inside the renderer container | Playwright inside the container | Not measured; it runs inside the container above | Bounded by the container |
| `scripts/browser-fixtures/scripts/capture-chat-stress.ts` | By hand, for the chat stress design review (`chat-stress-capture.md`) | One headless Chromium from the capture process, plus an in-process fixture server; one page at a time | One case at one profile: 7 s, peak 309% CPU, 1.1 GB | Neither |
| `components/cinder/scripts/design-system/build.ts` and `preview-shard.ts` | `bun run design-system:build` in `components/cinder`, by hand | Four `preview-shard.ts` processes at once (`SHARD_COUNT`), each running Bun's bundler. Then three phases of one headless Chromium each: static snapshots, the render check and the archetype check | Whole build: 314 s, peak 657% CPU, 3.3 GB over 8 processes | Neither |
| `applications/interborough/scripts/design-review-capture.ts` | `bun scripts/design-review-capture.ts` in `applications/interborough`, for every design review | `playwright test` with Interborough's configuration: one worker, so one browser, plus the web server Playwright starts | Not measured: a full capture runs every showcase, stress and state specification in both schemes | Neither |
| `applications/interborough/scripts/design-review-render-boards.ts` | By hand, to render design boards | One headless Chromium, one board at a time | Not measured: it needs a boards directory | Neither |
| Root `test:browser`, `test:browser:visual`, `test:browser:preview` | `bun run test:browser…`, by hand. The renderer container runs `test:browser:visual` too | `playwright test` with `scripts/browser-fixtures/playwright.config.ts`, which sets no `workers`: Playwright's default of half the processors, 6 here, each with a browser | Not measured: the full suite takes many minutes | Neither |
| Root `test:browser:terminal` (`run-terminal-browser.ts`) | By hand | The terminal files in Chromium, Firefox and WebKit, with the same default worker count | Not measured | Neither |
| Root `test:terminal-browser` (`scripts/terminal/browser-failure-regression.ts`) | By hand | One headless Chromium | Under a second: too short for the sampler | Neither |
| `test:browser` in `applications/interborough`, `applications/playground` and `applications/terminal-example` | `bun run test:browser` in the workspace, by hand | `playwright test` with `workers: 1`, plus the web server Playwright starts | Not measured | Neither |
| Root `test:browser:chromium`, `test:browser:interborough`, `validate:batch` | `bun run …` | Playwright with the default worker count; Interborough's gated suite has one worker | Not measured | The host lock |
| `applications/interborough/scripts/run-ui-shards.ts` | Interborough's `test` | Four serial `bun test` shards at once | Not measured | Test slots: each shard runs through `scripts/bun-test-junit.ts` |
| `applications/playground` `test:production` (`check-static-playground.ts`) | By hand, and by the lifecycle tests through `runStaticPlaygroundGate` | `playwright test` with `playwright-static.config.ts`, which is `fullyParallel` with the default worker count | Not measured | Test slots only when a test drives it |
| `applications/playground/scripts/run-linux-lifecycle.ts` | By the playground's isolated tests | Two `docker run` containers, one after the other | Not measured | Test slots, through the test that runs it |
| `applications/playground/scripts/measure-playground*.ts` | By hand | A Chromium probe and `playwright test` runs, one at a time | Not measured | Neither |
| `scripts/terminal/engine-probe.ts`, `scripts/terminal/resource-probe.ts` | By hand, for terminal engine research | Headless browsers, one probe at a time | Not measured | Neither |
| `components/cinder/scripts/memory-canary.ts` | `bun run test:memory-canary` in `components/cinder` | One `bun test --parallel=1` started directly, not through the pool's wrappers | Not measured | Neither |
| `applications/interborough/scripts/test-installed-release-browser.ts` | The release workflow, on a runner | One headless Chromium against the installed artifact | Not measured | Neither (runs on a CI runner) |
| `packages/weft` `test:benchmarks`, `packages/ventriloquist/scripts/pty-spawn-stress.ts`, the `test:a2a-tck` scripts of `packages/weft` and `packages/bureau` | By hand | Benchmark subprocesses, PTY stress children, or one external test kit, one run at a time | Not measured | Neither |
| `scripts/dev-container.ts` | By hand | The whole development container | Not measured | Neither |

## Admission

`scripts/host-slots.ts` admits the work in the table through the test slot pool, with no new mechanism. A run takes one slot for each process it keeps busy at once, from the same pool and through the same arrival-order queue as every `bun test` worker, so the pool bounds the two together. The pool's size, its admission rule for `bun test` and the host lock are unchanged.

- `withHostSlots(count, run)` holds `count` slots while an in-process `run` resolves, and tells `run` how many it holds. This process is the holder. If it is killed outright, the next waiter reclaims its slots, judged by pid and start time. A holder that leads its own process group (its pid is its process group id) also records that group, so its slots stay held while anything in the group, such as a browser or a shard it started, lives.
- `runWithHostSlots(count, argv)` and `bun scripts/host-slots.ts --slots=<n> -- <command>` run a command in a process group of their own while holding the slots, and record the group in them, as a pooled `bun test` does. A wrapper killed outright keeps its slots for as long as anything in the group lives, and frees them once the group is gone.
- A run started inside one that holds slots finds the holder's token in `CORVIDAE_TEST_SLOTS_TOKEN` and runs inside the holder's slots: the pool's nested-run rule. A command run under host slots gets the token, so a `bun test` or a wrapper it starts runs inside them too.
- A request above the pool's size is clamped to the pool, and the run is told so. Where there is no Git checkout, as inside the renderer container, the run warns and goes ahead without a slot.
- A slot holder never waits on the host lock, so the pool and the lock cannot deadlock. No wrapped command starts a locked stage.

What each entry point holds now:

- **Covered now.** `test:browser:update:docker` and `test:browser:visual:docker` hold 4 slots (`CONTAINER_CPUS`) through `scripts/host-slots.ts`, from `docker build` until the container exits. `docker run` gets `--cpus` of 4, or of the Docker VM's processor count when that is smaller. The slots are taken in `package.json`, not in the scripts themselves, because the browser-fixtures test task's cache inputs list every root file its scripts import, and that list lives in `turbo.json`, which this change leaves alone.
- **Covered now.** The Cinder design-system build holds 4 slots (`SHARD_COUNT`) while its preview shards run, and runs no more shards than it was granted. It then holds 1 slot for each of its three Chromium phases.
- **Covered now.** `bun run capture:chat-stress`, `design-review-capture.ts`, `design-review-render-boards.ts` and `test:terminal-browser` each hold 1 slot for the run, since each runs one browser at a time.
- **Covered now.** Root `test:browser` (and so `test:browser:visual`), `test:browser:preview` and `test:browser:terminal` hold 4 slots, and pin Playwright to `--workers=4`. In the renderer container they run without a slot, inside its `--cpus` limit.
- **Covered now.** The `test:browser` scripts of Interborough, the playground and the terminal example hold 1 slot each, matching their `workers: 1`.
- **Already covered.** The locked root stages hold the host lock, and Interborough's UI shards hold test slots. So do the lifecycle tests that drive `run-linux-lifecycle.ts` and `check-static-playground.ts`.
- **Not covered.** The playground's `test:production`, run by hand, is not covered: its `fullyParallel` run uses Playwright's default worker count, so holding a fixed number of slots needs the worker count pinned inside the gate the lifecycle tests share.
- **Not covered.** `memory-canary.ts` starts `bun test` directly, because it reads the child's peak memory from `resourceUsage()`. Routing it through the pool's runner means restructuring how it measures.
- **Not covered.** The playground measurement scripts, the terminal engine probes, the Weft benchmarks, the PTY stress script, the A2A test kits and `dev-container.ts` are research and diagnosis tools, run by hand one at a time. They are left for a change that has a reason to touch them.
- **Not covered.** `test-installed-release-browser.ts` runs on a CI runner, which has no other session to share with.

`scripts/host-slots.integration.test.ts` proves the behavior:

- A second holder waits while the first holds the pool, and proceeds when it releases.
- A nested run does not acquire again.
- A token that names no live holder does not bypass the pool.
- A holder killed outright has its slots reclaimed.
- A killed wrapper keeps its slots while its command group lives.
- Every Playwright script outside the host lock takes host slots.

## Still outside admission

- The browser-fixtures entry points run directly rather than through their `package.json` scripts: `update-snapshots-docker.ts`, `run-browser-docker.ts`, `capture-chat-stress.ts` and `run-terminal-browser.ts`. Each takes no slot that way. Moving the slots into the scripts means adding `scripts/host-slots.ts` to the inputs of the `//#test:browser-fixtures` task in `turbo.json`, which `scripts/task-cache.integration.test.ts` requires of any root file they import.
- A holder that only belongs to a group, as a script run from a non-interactive shell or from another process does, records no group, because that group may be a parent's and outlive the work for ever. If it is killed outright, its slots are reclaimed with its pid while a Playwright process or shard it started may still run. The Cinder design-system build, `design-review-capture.ts` and `design-review-render-boards.ts` are in-process holders of this kind unless started as a group leader.
- Work started by hand without the scripts: a bare `bunx playwright test`, `docker run` or `chromium` invocation takes no slot. Neither does any tool outside this repository: another repository's tests, a browser the developer uses, Spotlight and `fseventsd` indexing the worktrees.
- Work inside a container belongs to the Docker VM, which the slots bound only through `--cpus` on the renderer's `docker run`. A wrapper killed outright frees its slots once its own process is gone, while the container keeps running until `docker run --rm` ends or someone runs `docker kill`. A capture killed outright likewise frees its slot, while a browser it launched exits only when its pipe to the capture closes.
- A slot stands for one busy process, not one processor. The design-system build peaked at 657% while holding at most four slots, so a phase of it uses more processors than it holds; the sampler did not say which phase. The pool's size, left at processors minus two, absorbs part of that.
- Nothing times out a host-slot holder. A Docker renderer run holds 4 of the pool's slots for its whole length, and a hung capture keeps its slot until someone ends it. Waiters, `bun test` runs among them, wait that long.
- In update mode, the renderer container starts Playwright directly (`update-snapshots.ts`) with its default worker count, half the Docker VM's processors, under the 4-processor `--cpus` limit. Only the visual mode runs through `test:browser`, which pins 4 workers.
- Memory is not admitted separately. The pool's size already allows for 3 GiB per slot, but a browser suite's workers and its web server can use more.
