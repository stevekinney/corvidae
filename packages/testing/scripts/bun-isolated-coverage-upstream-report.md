# Upstream report draft: coverage is not merged across isolated test files, and plugin source maps are ignored

This is a draft for the Bun issue tracker. It has not been filed. The reproduction is `scripts/bun-isolated-coverage-reproduction.ts`. Observed on Bun 1.4.2, macOS arm64.

## Summary

When a `Bun.plugin` `onLoad` hook returns generated JavaScript, `bun test --coverage --coverage-reporter=lcov` has two defects.

First, with `--parallel=N` (which implies `--isolate`), each test file gets its own module instance. The lcov report for the module reflects only one instance's counts, the one from the last file in sorted order, instead of summing the instances. A line executed by an earlier test file is reported as `DA:<line>,0`. Passing `--parallel=1 --no-isolate`, or omitting both flags, produces the merged result.

Second, the lcov `DA` line numbers are line numbers in the generated output. The `//# sourceMappingURL=` comment is ignored, whether it is an inline data URL returned from `onLoad` or a link to an on-disk `.js.map` beside an imported `.js` file. A 190-line `.svelte` file therefore gets `DA` records up to line 251.

## Reproduction

Run `bun packages/testing/scripts/bun-isolated-coverage-reproduction.ts`. It writes a plugin that prepends 10 generated lines and attaches a correct inline source map, plus two test files that each take a different branch of one function. It exits 1 when either defect is present.

Expected: both branches report nonzero hits under every flag combination, and every `DA` line is at most the authored file's length.

Actual with `--parallel=1`: only the branch taken by `b.test.ts` is nonzero. In every combination the `DA` lines are shifted by 10 and extend past the end of the authored file.

## Impact

Coverage thresholds that read lcov are unreliable for any module produced by a plugin, such as Svelte components. Adding a test file that loads a module can lower its reported coverage.
