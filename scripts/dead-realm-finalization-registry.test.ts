/**
 * Regression guard for the Bun 1.4.2 crash behind "worker process crashed before reporting
 * results" in `bun test --parallel` lanes.
 *
 * A `FinalizationRegistry` cleanup job that is already queued when its realm dies (a `node:vm`
 * context, or the global a `--isolate`/`--parallel` worker retires at a file boundary) ran against
 * a registry the sweep had freed, and the process trapped inside
 * `JSFinalizationRegistry::reconcileWeakReferencesAtGCEnd` (macOS crash reports of 2026-10-21
 * through 2026-10-27). Bun fixed it before 1.4.4 (oven-sh/bun#44279), and this repository pins 1.4.4.
 * The fixture is that pull request's reproduction: it segfaults on 1.4.2 every run and prints
 * `deadContextCleanups: 0` on a fixed Bun.
 */

import { expect, test } from 'bun:test';

import { runWithHangGuard } from '../testing/testing/src/hang-guard.ts';

const fixture = /* js */ `
  import vm from 'node:vm';
  import { edenGC, fullGC } from 'bun:jsc';

  const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
  const liveContextCleanedUp = Promise.withResolvers();
  let deadContextCleanups = 0;

  function setup() {
    // A collection sweeps the first 8 cells of a type itself and leaves the rest for later, so
    // these contexts are the ones whose registries a queued cleanup job can outlive.
    const swept = Array.from({ length: 8 }, () => vm.createContext({}));
    const contexts = Array.from({ length: 4 }, () =>
      vm.createContext({ onCleanup: () => deadContextCleanups++ }),
    );
    const liveContext = vm.createContext({ onCleanup: liveContextCleanedUp.resolve });
    contexts.push(liveContext);
    for (const context of contexts) {
      vm.runInContext('globalThis.registry = new FinalizationRegistry(onCleanup)', context);
    }
    edenGC();
    for (const context of contexts) for (let i = 0; i < 5; i++) context.registry.register({ i }, i);
  }

  await nextTurn().then(setup);
  await nextTurn();
  edenGC();
  fullGC();
  await liveContextCleanedUp.promise;
  await nextTurn();
  console.log(JSON.stringify({ deadContextCleanups }));
`;

test('a FinalizationRegistry cleanup job is dropped when its realm dies before the job runs', async () => {
  const completed = await runWithHangGuard([process.execPath, '-e', fixture]);
  expect({
    standardOutput: completed.stdout.toString().trim(),
    standardError: completed.stderr.toString(),
    exitCode: completed.exitCode,
  }).toEqual({
    standardOutput: '{"deadContextCleanups":0}',
    standardError: '',
    exitCode: 0,
  });
});
