# Bun optimization results

Measured on September 18, 2026. Keep workspace test concurrency at one: concurrency two reduced median runtime by 42.1%, but increased peak sampled memory by 43.2%, exceeding the agreed 25% allowance. All six runs passed the same 36,816 tests. Private libraries remain source-only.

## Validation changes

`validate` now runs lint, type checking, tests, builds, formatting, and dependency auditing in that order. Its duplicate trailing `test:self` invocation is removed; `test` still invokes root self-tests before workspace tests. The workspace contract test verifies this ordering, the single self-test invocation, and the non-mutating `bun audit --audit-level=high` gate. Package test flags, coverage behavior, and DOM setup are unchanged.

## Concurrency experiment

The host was a MacBookPro18,4 with 10 logical CPUs and 64 GiB RAM, running macOS 27.0, [Bun](https://bun.com/) 1.4.2 (`744846f84`), and [Turborepo](https://turborepo.com/) 2.10.13. The working tree was based on commit `4f08f50d7f8d79415145bc9777047fbacd09fa63` and included the completed environment-configuration and package-boundary changes. Both other tasks finished before measurement; no competing repository test or build jobs were running.

The commands ran in alternating order: `1, 2, 1, 2, 1, 2`.

```bash
bunx turbo run test test:browser-fixtures --concurrency=1 --cache=local:,remote:
bunx turbo run test test:browser-fixtures --concurrency=2 --cache=local:,remote:
```

Both local and remote task-cache reads and writes were disabled. Every run executed all 19 tasks with zero cache hits. Installed dependencies, generated inputs, the operating-system file cache, and Bun's transpiler cache were retained; these are warm-checkout measurements, not clean-install benchmarks. Package-level test arguments were identical between modes.

A temporary Bun harness measured wall-clock time from subprocess launch through exit. Every 500 ms it sampled `ps -axo pid=,ppid=,rss=`, recursively selected the command's descendants, and summed their resident memory. The table reports each run's largest sampled sum. RSS can count shared pages in multiple processes, and sampling can miss shorter peaks; it is not a measurement of unique physical memory. The timing includes the same sampling overhead in both modes. Test totals come from completed Bun test summaries, and success comes from process exit codes.

| Run | Concurrency | Elapsed seconds | Peak RSS, KiB | Passed | Failed | Exit |
| --- | ----------- | --------------- | ------------- | ------ | ------ | ---- |
| 1   | 1           | 835.910         | 5,366,448     | 36,816 | 0      | 0    |
| 2   | 2           | 489.034         | 8,132,784     | 36,816 | 0      | 0    |
| 3   | 1           | 834.541         | 5,678,704     | 36,816 | 0      | 0    |
| 4   | 2           | 484.038         | 7,339,616     | 36,816 | 0      | 0    |
| 5   | 1           | 838.799         | 5,543,152     | 36,816 | 0      | 0    |
| 6   | 2           | 484.004         | 7,943,600     | 36,816 | 0      | 0    |

Median elapsed time fell from 835.910 to 484.038 seconds. Comparing the maximum observed peak in each mode, memory rose from 5,678,704 KiB (5.42 GiB) to 8,132,784 KiB (7.76 GiB). Correctness and the minimum 10% speed improvement passed; the maximum 25% memory increase failed. The root test command therefore retains `--concurrency=1`.

Before and after every run, the harness hashed existing tracked and non-ignored untracked files, including symlink targets and excluding this report. All fingerprints matched `04601286a244a17b600cdcf67464be957cec074b76ae947860b91ec170f98b31`. Local experiment evidence is in `/tmp/corvidae-bun-optimization/`: `benchmark.ts`, `results.json`, six command logs, and six memory-sample files. Those temporary files are not repository tooling.

## Browser output

After benchmarking, I built both fixture hosts into fresh temporary directories using the existing `buildBrowser` helper with `development: false`, then ran `bun run --cwd applications/chat-room build`. The component fixture manifest was prepared first. These builds used existing application and fixture toolchains; no library build was added.

Sizes below are raw on-disk bytes, not compressed transfer sizes. Old development output directories contained retained hashed generations, so their directory totals were excluded. Fixture host output is test infrastructure and must not be counted as Chat-room's application payload. The Bun fixture helper does not request minification; the differing entrypoints and toolchains also make these totals unsuitable for a bundler performance comparison.

| Fresh output           | JavaScript files / bytes | CSS files / bytes | WASM files / bytes |
| ---------------------- | ------------------------ | ----------------- | ------------------ |
| Component fixture host | 725 / 16,346,237         | 13 / 3,472,230    | 1 / 466,610        |
| Weft UI fixture host   | 403 / 13,007,737         | 3 / 1,425,469     | 1 / 466,610        |
| Chat-room client       | 472 / 5,161,849          | 17 / 308,793      | 2 / 933,220        |

Each fixture HTML entry references one JavaScript file and one stylesheet: 1,443,172 + 847,909 bytes for component fixtures, and 1,070,195 + 517,094 bytes for Weft UI. Their entry modules expose 226 and eight dynamic import edges respectively; the remaining JavaScript chunks are outside those initial static entries. Several lazy stylesheets repeat shared Cinder inputs, so aggregate fixture output should not be mistaken for a single page's transfer size.

Raw files and metafile accounting are not identical: raw JavaScript exceeds the metafile totals by 67,365 bytes for component fixtures and 29,539 bytes for Weft UI. CSS totals match, and the emitted WASM file is absent from each metafile's output table. I used filesystem sizes for assets and metafile contributions for attribution; the accounting discrepancy's cause was not established.

### Largest assets and contributors

| Output | Kind | Asset | Bytes |
| --- | --- | --- | --- |
| Component fixtures | JavaScript | `chunk-vhwencaa.js` | 1,443,172 |
| Component fixtures | CSS | `chunk-27m9edc7.css` | 847,909 |
| Component fixtures | WASM | `onig.wasm.binary-5eqv42ec.wasm` | 466,610 |
| Weft UI fixtures | JavaScript | `chunk-n4ck65bb.js` | 1,070,195 |
| Weft UI fixtures | CSS | `chunk-m21wreh7.css` | 517,094 |
| Weft UI fixtures | WASM | `onig.wasm.binary-5eqv42ec.wasm` | 466,610 |
| Chat-room | JavaScript worker | `render-worker-DRR35SSM.js` | 1,231,484 |
| Chat-room | CSS | `src.Do9SbLNn.css` | 114,206 |
| Chat-room | WASM | `onig.Du5pRr7Y.wasm` and worker copy `onig-Du5pRr7Y.wasm` | 466,610 each |

The existing Bun metafiles expose module contributions without additional tooling. Summing `bytesInOutput` across outputs, the largest shared grammar contributors were [Shiki](https://shiki.style/) Emacs Lisp (779,869 bytes), C++ (402,343), Wolfram (262,401), and C++ macros (224,332). [KaTeX](https://katex.org/) contributed 456,908 bytes in the component fixture host. These are contributions across emitted chunks, not evidence that every grammar downloads on first render.

### Initial and lazy application assets

The [Vite](https://vite.dev/) client manifest marks route nodes as entries as well as the application bootstraps. Counting every `isEntry` record as initial output would incorrectly include all exercise routes. I followed static `imports` and CSS references from the two app/start bootstrap entries, then separately added root layout node 0 and homepage node 2. The generated [SvelteKit](https://svelte.dev/docs/kit) route map confirms `"/": [2]`.

| Static dependency closure             | JavaScript               | CSS                     |
| ------------------------------------- | ------------------------ | ----------------------- |
| App/start bootstrap                   | 7 files / 113,116 bytes  | 0                       |
| Bootstrap, root layout, and `/` route | 22 files / 676,872 bytes | 3 files / 197,226 bytes |

Route nodes and exercise pages are dynamically imported. In Chat-room, the 267,810-byte `rehype-katex` chunk is also a dynamic entry. The 338,767-byte `BuMaypUg.js` chunk is outside the homepage static closure. The rendering worker and its WASM asset live outside that manifest closure; runtime worker creation and dynamic imports can still trigger additional requests. These figures describe build-graph reachability, not a measured browser network waterfall.

The next useful bundle investigation would measure when the rendering worker, grammar chunks, and the two WASM URLs are actually requested. Artifact size alone does not justify removing supported languages, changing worker behavior, or adding size budgets. This change preserves those behaviors and the existing curated highlighter checks.

## Verification

The focused validation regression failed before the script change and passed afterward. Root self-tests passed with 109 tests. The six uncached workspace runs each passed 36,816 tests. The dedicated curated fixture verification passed in development and production modes, including actual browser highlighting, and Chat-room's stylesheet check found all seven required markers across 17 stylesheets.

All closing commands passed:

```bash
bun run test:self
bun run validate
bun scripts/browser-fixtures/scripts/verify-curated-build.ts
bun run --cwd applications/chat-room check:client-styles
```

The application build also emitted an informational plugin-timing diagnostic: Svelte compilation and SvelteKit's build hook dominated build time. No plugin checks, warnings, thresholds, retries, or timeout settings were suppressed or increased.
