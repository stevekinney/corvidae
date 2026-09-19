# @corvidae/testing

Shared source-level test utilities for Corvidae's [Svelte](https://svelte.dev/) packages and browser applications. Declare `"@corvidae/testing": "workspace:*"` in a workspace's development dependencies and import helpers from `@corvidae/testing`.

The package provides Svelte compilation and DOM setup for [Bun tests](https://bun.sh/docs/test), server rendering and hydration helpers, timer lifecycle assertions, fixture extraction, [Playwright](https://playwright.dev/) interactions, theme and focus checks, accessibility scans, and screenshot artifact utilities. Each consuming test suite owns its browser server, routes, and Playwright configuration.

## Source checks

From `packages/testing`, run:

```bash
bun run lint
bun run typecheck
bun run test
```

From the Corvidae root, use `bunx turbo run lint typecheck test --filter=@corvidae/testing` or `bun run validate` for the full repository. The package has no build or publishing step.

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

The browser suite owns baselines at `scripts/browser-fixtures/snapshots/{projectName}/{platform}/`. Playwright resolves both blocking comparisons and review reports through that configured path. The original Linux Chromium baselines are preserved under `snapshots/chromium/linux`; ordinary review screenshots are disposable output under `packages/testing/screenshots/`.

From the repository root, `bun run test:browser:visual` requires matching baselines. `bun run test:browser:update` explicitly authorizes creating or updating the current project and platform baselines. Ordinary test runs never create missing baselines. A passing interaction test does not establish pixel parity with preserved images. Compare images only with matching browser, operating system, fonts, viewport, and theme; do not overwrite baselines merely because a new host renders different pixels.
