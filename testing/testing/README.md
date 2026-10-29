# @lostgradient/testing

Shared source-level test utilities for Corvidae's [Svelte](https://svelte.dev/) packages and browser applications. Declare `"@lostgradient/testing": "workspace:*"` in a workspace's development dependencies and import helpers from `@lostgradient/testing`.

The package provides Svelte compilation and DOM setup for [Bun tests](https://bun.sh/docs/test), server rendering and hydration helpers, timer lifecycle assertions, fixture extraction, [Playwright](https://playwright.dev/) interactions, theme and focus checks, accessibility scans, and screenshot artifact utilities. Each consuming test suite owns its browser server, routes, and Playwright configuration.

## Deterministic test boundaries

The runtime ownership table and cleanup terminology used by these helpers are collected in [Runtime contracts across Corvidae](../../documentation/runtime-contracts.md).

The helpers in this package are intentionally small building blocks. They do not replace a package's lifecycle contract, hide an unfinished asynchronous operation, or make a visual assertion pass by changing its baseline. A useful test owns the resource it starts and asserts the observable boundary it promises.

For browser component tests, `setupHappyDom()` provides the DOM surface, `renderThenHydrate()` checks that server output and client hydration agree, and `trackTimers()` plus `expectNoLeakedTimers()` catches timers that outlive the test. The timer tracker must be created before the code under test schedules work:

```typescript
import { expectNoLeakedTimers, trackTimers } from '@lostgradient/testing';

const timers = trackTimers();
const handle = setTimeout(() => {}, 10);
clearTimeout(handle);
try {
  expectNoLeakedTimers(timers.active());
} finally {
  timers.release();
}
```

`trackTimers()` observes the host's `setTimeout`, `setInterval`, and matching clear calls for the current test process. It does not prove that a promise, event listener, browser animation, or server process has stopped. Pair it with the owning package's `dispose()`, `complete()`, or shutdown report when the fixture starts those resources.

## Live PostgreSQL

`@lostgradient/testing/postgres-server` gives a suite a real PostgreSQL. `postgresTestDatabase` resolves once at import: a `WEFT_TEST_POSTGRES_URL` wins, otherwise `initdb` and `pg_ctl` on `PATH` start a disposable cluster, otherwise it is `null` and the suite gates itself with `describe.skipIf(!postgresTestDatabase)`. A workspace whose Turborepo task is not given `WEFT_TEST_POSTGRES_URL` always uses the disposable cluster.

## In-process S3

`@lostgradient/testing/s3-server` starts a `Bun.serve` S3-compatible store on `127.0.0.1` and an ephemeral port, so a suite of S3 code needs no network, credentials, or container. It answers path-style `GET`, `HEAD`, `PUT`, and `DELETE` on objects and ListObjectsV2 (prefix, continuation tokens, pages of 1,000), returns quoted MD5 ETags, and gives conditional requests the statuses COR-1759 recorded from a real store: `412 PreconditionFailed` for a stale `If-Match` or an existing key under `If-None-Match`, `404 NoSuchKey` for `If-Match` on an absent key, and `204` for deleting an absent key. It accepts presigned and header-signed requests and checks neither signature, so it is a protocol double and never a security boundary.

`Bun.S3Client.write` cannot send a condition, so a test of a conditional write signs with `client.presign(key, { method })` and sends the header with `fetch`. `objects()` is a snapshot of the bucket and `put(key, bytes)` edits it directly; the server stops on `Symbol.asyncDispose`.

```typescript
import { createS3TestServer } from '@lostgradient/testing/s3-server';

await using server = createS3TestServer();
const client = new Bun.S3Client(server.clientOptions());
server.put('lock', 'owner-a');
const url = client.presign('lock', { method: 'PUT', expiresIn: 300 });
const response = await fetch(url, {
  method: 'PUT',
  headers: { 'If-None-Match': '*' },
  body: 'owner-b',
});
console.log(response.status, server.objects().size);
```

## Temporary paths

Name a test's temporary files with `@lostgradient/testing/temporary-path`, never with `process.pid`. The operating system reuses process ids, so a later run builds the path an earlier run used, opens the database that run left behind, and inherits its rows. `createTemporaryPath(label, extension)` returns a path inside a fresh `mkdtemp` directory, so a SQLite file and its `-wal` and `-shm` files share one owner, and `removeTemporaryPath(path)` removes that directory in a `finally` or an `afterEach`. A file that has to stay next to the source it imports, such as a compiled server-render module, takes `uniqueFileName(label, extension)`, which appends a `crypto.randomUUID()`.

```typescript
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';

const databasePath = createTemporaryPath('bureau-recovery', '.sqlite');
try {
  // Open the database at databasePath, exercise it, dispose of it.
} finally {
  removeTemporaryPath(databasePath);
}
```

`scripts/check-process-identifier-test-paths.ts`, part of `bun run lint:root`, fails when a test file passes the process id to `join` or `resolve`. Bureau's public storage fixtures cannot import this package at runtime, so Bureau owns its own `packages/bureau/src/test/temporary-path.ts`.

## Accessibility and visual evidence

`evaluateAxeGate()` turns the blocking `critical` and `serious` buckets from an axe scan into a binary decision. An allow-list entry may explain an intentional exception, but a new rule identifier still fails the gate. Keep the key stable so the failure identifies the same component, theme, viewport, and fixture in every run:

```typescript
import { evaluateAxeGate } from '@lostgradient/testing';

const decision = evaluateAxeGate(
  { slug: 'button', theme: 'light', viewport: 'desktop', fixture: 'default' },
  { critical: [], serious: [], moderate: [], minor: [] },
);

if (decision.status === 'fail') throw new Error(decision.message);
```

`loadManifest()` and `manifestDigest()` read the generated browser fixture manifest. The path must be explicit or supplied through `BROWSER_FIXTURE_MANIFEST`; a missing or malformed manifest is an error rather than an empty test set. The manifest's standard matrix is light and dark themes across mobile, tablet, and desktop viewports, but the consuming suite decides which entries it runs.

## Failure diagnosis

When a test reports a leaked timer, inspect the code that owns the timer and await its cleanup before asserting. When a browser test cannot load its manifest, run the owning application's manifest preparation command and check `BROWSER_FIXTURE_MANIFEST`. When a screenshot differs, compare the browser, operating system, fonts, viewport, and theme before updating a baseline. A passing interaction test and a matching screenshot answer different questions.

## Source checks

From `testing/testing`, run:

```bash
bun run lint
bun run typecheck
bun run test
```

From the Corvidae root, use `bunx turbo run lint typecheck test --filter=@lostgradient/testing` or `bun run validate` for the full repository. The package has no build or publishing step.

## Coverage ratchet and test isolation

The `test:coverage` script of `@lostgradient/terminal` passes `--parallel=1 --no-isolate`, and its `test` script stays isolated. Under isolation Bun gives each test file its own module instance and reports coverage for only one of them instead of merging, so a Svelte component loaded by several test files could lose lines that another file executes, and adding a test file could lower the measured ratio. Without isolation the counts merge. `@lostgradient/chat` already runs without isolation, and `@lostgradient/cinder` cannot adopt the flag yet because about 50 tests in about 30 files fail when files share a module registry (Carousel, VirtualList, `shikiHighlighter`, JsonSchemaEditor, Dropdown and others), so its Svelte ratio can still under-report. `scripts/bun-isolated-coverage-reproduction.ts` reproduces the defect, which is reported upstream as [oven-sh/bun#45301](https://github.com/oven-sh/bun/issues/45301).

Bun also ignores source maps from plugin output, so LCOV lines for `.svelte` files are compiled-output lines. The ratchet reads the `LF` and `LH` totals, so its percentages are unaffected.

## Browser fixtures

`scripts/browser-fixtures` owns the Cinder, Chat, and Editor interaction fixtures. From the repository root, install Chromium and run the development and production-preview suites:

```bash
bun --bun playwright install chromium
bun run test:browser
bun run test:browser:preview
```

Playwright starts the selected Bun server and uses separate development and preview ports. To run one test, pass its filename or a test-title filter:

```bash
bun run test:browser scripts/browser-fixtures/tests/comment-anchor-a11y.playwright.ts
bun run test:browser --grep 'CodeBlock'
```

The host generates its fixture manifest and lazy-import catalog before starting. Its ignored test results contain failure traces. Accessibility and screenshot helpers write artifacts using the paths defined in `src/helpers/artifact-path.ts`; consuming tests decide which accessibility findings fail a case.

## Preserved visual evidence

The browser suite owns baselines at `scripts/browser-fixtures/snapshots/{projectName}/{platform}/`. Playwright resolves both blocking comparisons and review reports through that configured path. The committed Linux Chromium baselines live under `snapshots/chromium/linux`, with their `provenance.json`; ordinary review screenshots are disposable output under `testing/testing/screenshots/`.

The Linux baselines have one authoritative renderer: native `linux/arm64` inside the pinned Playwright jammy image. `bun run test:browser:visual:docker` checks a commit against them and `bun run test:browser:update:docker` regenerates them, each from an exact `git archive` of the commit. `bun run test:browser:update` refuses to run outside that image. [`scripts/browser-fixtures/visual-baselines.md`](../../scripts/browser-fixtures/visual-baselines.md) documents the workflow, the host load record, the review report, and how changed images are classified. `bun run test:browser:visual` on a development host still requires matching baselines, so a different operating system or architecture fails it by design; ordinary test runs never create missing baselines.
