import { plugin } from 'bun';
import { afterEach } from 'bun:test';
import { resolve } from 'node:path';

import { ensureCinderGenerated } from '../../../scripts/ensure-cinder-generated.ts';

import {
  configureAsyncUtilityDeadline,
  registerGlobalCleanup,
  setupHappyDom,
  sveltePlugin,
} from '@lostgradient/testing';

// The shared preload serves the package whose tests are running: `bun test` runs in its directory.
const sourceDirectory = resolve(process.cwd(), 'src').replaceAll('\\', '/');

export function allowCinderTestStyleBlock(path: string): boolean {
  const normalizedPath = path.replaceAll('\\', '/');
  if (!normalizedPath.startsWith(`${sourceDirectory}/`)) return false;

  const relativePath = normalizedPath.slice(sourceDirectory.length + 1);
  return (
    relativePath.startsWith('test/fixtures/') ||
    /^components\/[^/]+\/[^/]+\.fixture\.svelte$/.test(relativePath)
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

// Cinder's token artifacts are generated, not tracked, and a test imports them through its index.
// A direct `bun test` bypasses Turbo's `metadata` task, so make sure they exist before any test file
// loads (a no-op while they are present and fresh).
await ensureCinderGenerated();

await plugin(sveltePlugin({ generate: 'client', allowStyleBlock: allowCinderTestStyleBlock }));

// Register ONE global afterEach(cleanup) here, before any test file loads, so
// every component test's render() is unmounted without each file needing its
// own cleanup boilerplate. See register-global-cleanup.ts for the full why.
await registerGlobalCleanup(afterEach);

// Testing Library's asynchronous utilities wait up to the hang guard, not one second.
await configureAsyncUtilityDeadline();
