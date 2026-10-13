/**
 * Startup warmup stability: how a warmup attempt reads the rebuild generation, the watcher's
 * pending debounce, and source mtimes to decide whether its result can back readiness.
 *
 * Kept apart from `playground-server.test.ts` on purpose. These tests drive real
 * `scheduleRebuild` calls, whose `invalidateCachesForChange` resets the page-server renderer
 * memo and every generation-keyed build cache in the process. The route tests in that file
 * rely on a page renderer compiled once at module scope, outside Bun's per-test budget; an
 * invalidation in the same process would hand the next route test a cold compile on its clock.
 * `scripts/run-tests.ts` runs this file in its own process because it imports the server.
 */

import { describe, expect, it } from 'bun:test';
import { rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { scheduleRebuild, waitForPendingRebuild } from './file-watcher.ts';
import {
  isWarmupStable,
  runGenerationCheckedWarmup,
  warmupInstabilityReasons,
} from './playground-server.ts';
import { getRebuildGeneration } from './rebuild-generation.ts';
import {
  rendererWarmupAttemptDecision,
  rendererWarmupNeedsCacheInvalidation,
  rendererWarmupNeedsPrebuild,
} from './ssr-renderer.ts';

describe('startup warmup stability', () => {
  it('settles a pending rebuild before a retry can pre-build bundles', async () => {
    const generationAtStart = getRebuildGeneration();
    scheduleRebuild({ kind: 'components' });

    expect(getRebuildGeneration()).toBe(generationAtStart);
    const settledGeneration = await waitForPendingRebuild();

    expect(settledGeneration).toBe(generationAtStart + 1);
    expect(getRebuildGeneration()).toBe(settledGeneration);
  });

  it('captures the settled generation as a stable prebuild baseline', async () => {
    const generationBeforeDebounce = getRebuildGeneration();
    scheduleRebuild({ kind: 'components' });

    const generationAtStart = await waitForPendingRebuild();

    expect(generationAtStart).toBe(generationBeforeDebounce + 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isWarmupStable(generationAtStart, getRebuildGeneration(), 100, 100)).toBe(true);
  });

  it('rejects retry work when a rebuild settles before the work completes', async () => {
    const generationBeforeWork = getRebuildGeneration();
    const attempt = await runGenerationCheckedWarmup(async () => {
      scheduleRebuild({ kind: 'components' });
      await waitForPendingRebuild();
      return 'prebuilt';
    });

    expect(attempt.value).toBe('prebuilt');
    expect(attempt.instabilityReasons).toEqual([
      `rebuild generation changed (${generationBeforeWork} -> ${generationBeforeWork + 1})`,
    ]);
  });

  it('rejects retry work while rebuild invalidation is still pending', async () => {
    const attempt = await runGenerationCheckedWarmup(async () => {
      scheduleRebuild({ kind: 'components' });
      return 'prebuilt';
    });

    expect(attempt.value).toBe('prebuilt');
    expect(attempt.instabilityReasons).toEqual(['rebuild debounce is pending']);
    await waitForPendingRebuild();
  });

  it('rejects retry work when source changes before watcher invalidation starts', async () => {
    const temporarySourcePath = join(import.meta.dirname, '.warmup-source-mtime.test-fixture.ts');
    await rm(temporarySourcePath, { force: true });

    try {
      const attempt = await runGenerationCheckedWarmup(async () => {
        await writeFile(temporarySourcePath, 'export {};\n');
        const futureMtime = new Date(Date.now() + 5_000);
        await utimes(temporarySourcePath, futureMtime, futureMtime);
        return 'prebuilt';
      });

      expect(attempt.value).toBe('prebuilt');
      expect(
        attempt.instabilityReasons.some((reason) =>
          reason.startsWith('newest source mtime changed'),
        ),
      ).toBe(true);
    } finally {
      await rm(temporarySourcePath, { force: true });
    }
  });

  it('rejects a warmup when source changes before watcher validation', () => {
    expect(isWarmupStable(4, 4, 100, 101)).toBe(false);
    expect(isWarmupStable(4, 5, 100, 100)).toBe(false);
    expect(isWarmupStable(4, 4, 100, 100, true)).toBe(false);
    expect(isWarmupStable(4, 4, 100, 100)).toBe(true);
  });

  it('reports every condition that invalidated a warmup pass', () => {
    expect(warmupInstabilityReasons(4, 5, 100, 101, true)).toEqual([
      'rebuild generation changed (4 -> 5)',
      'newest source mtime changed (100 -> 101)',
      'rebuild debounce is pending',
    ]);
    expect(warmupInstabilityReasons(4, 4, 100, 100)).toEqual([]);
  });

  it('only requires a full page pre-build after invalidation or a source change', () => {
    expect(rendererWarmupNeedsPrebuild(false, false, false)).toBe(false);
    expect(rendererWarmupNeedsPrebuild(true, false, false)).toBe(true);
    expect(rendererWarmupNeedsPrebuild(false, true, false)).toBe(true);
    expect(rendererWarmupNeedsPrebuild(false, false, true)).toBe(true);
    expect(rendererWarmupNeedsCacheInvalidation(false, true, false)).toBe(true);
    expect(rendererWarmupNeedsCacheInvalidation(true, true, false)).toBe(true);
    expect(rendererWarmupNeedsCacheInvalidation(true, false, false)).toBe(false);
    expect(rendererWarmupNeedsCacheInvalidation(false, false, true)).toBe(true);
  });

  it('carries cache instability through a renderer fallback', () => {
    expect(rendererWarmupAttemptDecision(true, true, false, false)).toEqual({
      accepted: false,
      needsPrebuild: true,
    });
    expect(rendererWarmupAttemptDecision(true, false, false, false)).toEqual({
      accepted: false,
      needsPrebuild: false,
    });
    expect(rendererWarmupAttemptDecision(false, false, false, false)).toEqual({
      accepted: true,
      needsPrebuild: false,
    });
  });
});
