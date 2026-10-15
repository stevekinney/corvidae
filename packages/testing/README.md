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

From `packages/testing`, run:

```bash
bun run lint
bun run typecheck
bun run test
```

From the Corvidae root, use `bunx turbo run lint typecheck test --filter=@lostgradient/testing` or `bun run validate` for the full repository. The package has no build or publishing step.

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

The browser suite owns baselines at `scripts/browser-fixtures/snapshots/{projectName}/{platform}/`. Playwright resolves both blocking comparisons and review reports through that configured path. The committed Linux Chromium baselines live under `snapshots/chromium/linux`, with their `provenance.json`; ordinary review screenshots are disposable output under `packages/testing/screenshots/`.

The Linux baselines have one authoritative renderer: native `linux/arm64` inside the pinned Playwright jammy image. `bun run test:browser:visual:docker` checks a commit against them and `bun run test:browser:update:docker` regenerates them, each from an exact `git archive` of the commit. `bun run test:browser:update` refuses to run outside that image. [`scripts/browser-fixtures/visual-baselines.md`](../../scripts/browser-fixtures/visual-baselines.md) documents the workflow, the host load record, the review report, and how changed images are classified. `bun run test:browser:visual` on a development host still requires matching baselines, so a different operating system or architecture fails it by design; ordinary test runs never create missing baselines.
