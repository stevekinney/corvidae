/**
 * COR-1717 — an approval whose resolution started but never committed is listed again after a
 * real process death, marked `interrupted`, and its tool is not run again by the restart.
 *
 * The child approves a gated tool call and SIGKILLs itself from inside the approved tool's body,
 * after the resolution-started marker is durable and before the decision commits. The parent boots
 * a Bureau over the same SQLite database and reads the review back.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { describe, expect, it } from 'bun:test';

import {
  CLAIM_TTL_MS,
  createHarnessBureau,
  createInterruptedApprovalToolbox,
  INTERRUPTED_APPROVAL_FILE,
} from './test/process-crash-work-integrity-fixtures';
import { expectScenarioPassed, type ScenarioScope, settleScenario } from './test/hoisted-scenario';
import type { Bureau } from './types';
import { createSqliteStorageFixture } from './test/storage-fixtures';

const CHILD = join(import.meta.dir, 'test', 'process-crash-child.ts');
const runtime = createDefaultRuntimeServices();

function lineCount(path: string): number {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).length;
}

async function interruptedApprovalScenario(scope: ScenarioScope): Promise<void> {
  {
    const directory = createTemporaryDirectory('corvidae-interrupted-approval');
    const storagePath = join(directory, 'bureau');
    const markerPath = join(directory, 'marker.json');
    const toolFile = join(directory, INTERRUPTED_APPROVAL_FILE);
    // The child's store, opened here only once the child is gone.
    const store = createSqliteStorageFixture({ path: storagePath });
    let recoverer: Bureau | undefined;
    scope.onHang(async () => {
      await Promise.allSettled(recoverer === undefined ? [] : [recoverer.shutdown()]);
      await store.dispose();
      removeTemporaryPath(directory);
    });
    try {
      const child = spawnWithHangGuard(
        ['bun', CHILD, 'approve-then-crash', 'sqlite', storagePath, markerPath],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      scope.onHang(() => child.kill());
      await child.exited;
      const stderr = await new Response(child.stderr).text();
      expect(child.signalCode ?? stderr).toBe('SIGKILL');
      const { reviewId } = JSON.parse(readFileSync(markerPath, 'utf8')) as { reviewId: string };
      const linesBeforeRestart = lineCount(toolFile);
      expect(linesBeforeRestart).toBe(1);

      await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, CLAIM_TTL_MS * 10));

      recoverer = await createHarnessBureau({
        storage: store.storage,
        generate: async () => ({ content: 'recovered', toolCalls: [] }),
        toolbox: createInterruptedApprovalToolbox(directory),
      });
      await recoverer.recovery();
      const bureau = recoverer;
      await waitUntil(() => bureau.reviews.list().some((candidate) => candidate.id === reviewId));
      const review = bureau.reviews.list().find((candidate) => candidate.id === reviewId);
      expect(review?.kind).toBe('tool-approval');
      if (review?.kind !== 'tool-approval') throw new Error('the review was not listed again');
      expect(review.interrupted).toBe(true);
      expect(typeof review.resolutionStartedAt).toBe('number');
      expect(existsSync(toolFile)).toBe(true);
      expect(lineCount(toolFile)).toBe(linesBeforeRestart);
    } finally {
      if (recoverer !== undefined) await Promise.allSettled([recoverer.shutdown()]);
      await store.dispose();
      removeTemporaryPath(directory);
    }
  }
}

// A real SIGKILLed child and a claim-lapse wait: run whole, once, at module scope.
const outcome = await settleScenario(interruptedApprovalScenario, 120_000);

describe('an approval interrupted mid-resolution (COR-1717)', () => {
  it('is listed again as interrupted after SIGKILL and does not re-run its tool', () => {
    expectScenarioPassed(outcome);
  });
});
