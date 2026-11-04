/**
 * COR-1717 — an approval whose resolution started but never committed is listed again after a
 * real process death, marked `interrupted`, and its tool is not run again by the restart.
 *
 * The child approves a gated tool call and SIGKILLs itself from inside the approved tool's body,
 * after the resolution-started marker is durable and before the decision commits. The parent boots
 * a Bureau over the same SQLite database and reads the review back.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
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
  createPeerApprovalToolbox,
  INTERRUPTED_APPROVAL_FILE,
} from './test/process-crash-work-integrity-fixtures';
import { expectScenarioPassed, type ScenarioScope, settleScenario } from './test/hoisted-scenario';
import type { Bureau, RecoverableStartedApprovalInput } from './types';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { readChildJson } from './test/child-output-file';

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
      const { reviewId } = readChildJson<{ reviewId: string }>(markerPath);
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

async function peerApprovalRecoveryScenario(scope: ScenarioScope): Promise<void> {
  const directory = createTemporaryDirectory('corvidae-peer-approval-recovery');
  const storagePath = join(directory, 'bureau');
  const markerPath = join(directory, 'marker.json');
  const callbackPath = join(directory, 'attach-callbacks.txt');
  const toolRunsPath = join(directory, 'tool-runs.txt');
  const store = createSqliteStorageFixture({ path: storagePath });
  const secondStore = createSqliteStorageFixture({ path: storagePath });
  let recoverer: Bureau | undefined;
  let secondRecoverer: Bureau | undefined;
  scope.onHang(async () => {
    await Promise.allSettled(recoverer === undefined ? [] : [recoverer.shutdown()]);
    await Promise.allSettled(secondRecoverer === undefined ? [] : [secondRecoverer.shutdown()]);
    await store.dispose();
    await secondStore.dispose();
    removeTemporaryPath(directory);
  });
  try {
    const child = spawnWithHangGuard(
      ['bun', CHILD, 'peer-approval-then-crash', 'sqlite', storagePath, markerPath],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    scope.onHang(() => child.kill());
    await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(child.signalCode ?? stderr).toBe('SIGKILL');
    const marker = readChildJson<{
      runId: string;
      sessionId: string;
      reviewId: string;
      revision: string;
    }>(markerPath);
    const toolbox = createPeerApprovalToolbox(() => appendFileSync(toolRunsPath, 'ran\n', 'utf8'));
    const attach = {
      version: 1 as const,
      attach: async (input: RecoverableStartedApprovalInput) => {
        appendFileSync(callbackPath, `${input.journalEntry.taskId}\n`, 'utf8');
        return {
          callId: input.callId,
          toolCallId: input.callId,
          toolName: 'ask-peer',
          outcome: 'success' as const,
          content: 'peer answer',
          result: 'peer answer',
        };
      },
    };
    const options = {
      generate: async () => ({ content: 'recovered', toolCalls: [] }),
      toolbox,
      recoverableStartedApprovals: new Map([[marker.revision, attach]]),
    };
    [recoverer, secondRecoverer] = await Promise.all([
      createHarnessBureau({ ...options, storage: store.storage }),
      createHarnessBureau({ ...options, storage: secondStore.storage }),
    ]);
    await Promise.all([recoverer.recovery(), secondRecoverer.recovery()]);
    await waitUntil(
      () => existsSync(callbackPath) && readFileSync(callbackPath, 'utf8').trim() === 'peer-task-1',
    );
    expect(readFileSync(callbackPath, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(existsSync(toolRunsPath)).toBe(false);
    expect(recoverer.reviews.list().some((review) => review.id === marker.reviewId)).toBe(false);
    const session = await recoverer.contexts.get(marker.sessionId);
    expect(JSON.stringify(session?.conversationHistory)).toContain('peer answer');
    const audit = await recoverer.internals.auditTrail?.query({ runId: marker.runId });
    expect(audit?.filter((record) => record.type === 'review.tool-approval.approved')).toHaveLength(
      1,
    );
  } finally {
    if (recoverer !== undefined) await Promise.allSettled([recoverer.shutdown()]);
    if (secondRecoverer !== undefined) await Promise.allSettled([secondRecoverer.shutdown()]);
    await store.dispose();
    await secondStore.dispose();
    removeTemporaryPath(directory);
  }
}

// A real SIGKILLed child and a claim-lapse wait: run whole, once, at module scope.
const outcome = await settleScenario(interruptedApprovalScenario, 120_000);

describe('an approval interrupted mid-resolution (COR-1717)', () => {
  it('is listed again as interrupted after SIGKILL and does not re-run its tool', () => {
    expectScenarioPassed(outcome);
  });
});

describe('a journaled peer approval interrupted mid-resolution (COR-2051)', () => {
  it('attaches once after SIGKILL and commits the peer result without executing a tool', async () => {
    const outcome = await settleScenario(peerApprovalRecoveryScenario, 120_000);
    expectScenarioPassed(outcome);
  });
});
