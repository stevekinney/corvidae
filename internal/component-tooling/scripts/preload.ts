import { plugin } from 'bun';
import { afterEach } from 'bun:test';
import { resolve } from 'node:path';

import {
  configureAsyncUtilityDeadline,
  registerGlobalCleanup,
  setupHappyDom,
  sveltePlugin,
} from '@lostgradient/testing';

import { cinderSourceRoots } from './discover-component-directories.ts';

// The shared preload serves the package whose tests are running: `bun test` runs in its directory.
// Its tests may mount the fixtures of any Cinder package (core's tests mount every family's once
// the split extracts them), so each Cinder `src` is a fixture source too.
const sourceDirectories = [
  ...new Set([resolve(process.cwd(), 'src'), ...cinderSourceRoots()].map(normalize)),
];

function normalize(path: string): string {
  return path.replaceAll('\\', '/');
}

export function allowCinderTestStyleBlock(path: string): boolean {
  const normalizedPath = normalize(path);
  const sourceDirectory = sourceDirectories.find((directory) =>
    normalizedPath.startsWith(`${directory}/`),
  );
  if (sourceDirectory === undefined) return false;

  const relativePath = normalizedPath.slice(sourceDirectory.length + 1);
  return (
    relativePath.startsWith('test/fixtures/') ||
    // A component's examples (COR-2081) are documentation pages render; `examples.test.ts` mounts
    // them with their own styles, as the playground does.
    /(?:^|\/)examples\/[^/]+\.example\.svelte$/.test(relativePath) ||
    // Core's tests directory keeps the fixtures that mount several packages' components (COR-2091).
    /^(?:components|component-tests)\/[^/]+\/[^/]+\.fixture\.svelte$/.test(relativePath)
  );
}

// Install happy-dom DOM globals BEFORE any test file's static imports resolve.
// Two reasons:
//
//   1. Several test files (notably review-editor / editor integrations)
//      transitively import `decode-named-character-reference/index.dom.js`,
//      which reads `document` at module-init under the `browser` export
//      condition. Without globals installed at preload time, those imports
//      fail before any test body runs.
//
//   2. Pre-installing happy-dom lets every test file use a STATIC import for
//      `@testing-library/svelte` instead of a top-level `await import(...)`.
//      Bun's test runner deadlocks when many test files race to dynamically
//      import the same module at module-init time (a real reproducible bug
//      — banner + number-input alone hangs together). Static imports avoid
//      the race.
setupHappyDom();

await plugin(sveltePlugin({ generate: 'client', allowStyleBlock: allowCinderTestStyleBlock }));

// Register ONE global afterEach(cleanup) here, before any test file loads, so
// every component test's render() is unmounted without each file needing its
// own cleanup boilerplate. See register-global-cleanup.ts for the full why.
await registerGlobalCleanup(afterEach);

// Testing Library's asynchronous utilities wait up to the hang guard, not one second.
await configureAsyncUtilityDeadline();
