/**
 * COR-1409 — a run parked on `requestHumanInput` survives the real death of
 * the process that parked it, over both durable backends.
 *
 * The in-process human-wait recovery tests (`human-input.test.ts`,
 * `human-wait-replay-park.test.ts`) simulate the crash by never disposing the
 * first Bureau. That leaves a second live engine on the store, which is not a
 * crash and, over LMDB, is a race of its own (COR-118, COR-1408). Here the
 * child SIGKILLs itself once its park is durable, so the recoverer shares
 * nothing with it but the bytes it left on disk.
 *
 * The one real-time wait is the claim-lapse wait, derived from the claim TTL
 * exactly as `process-crash-recovery.test.ts` does. Every other wait is
 * `child.exited`, the marker file, or a bounded condition poll with a tiny real
 * delay, because LMDB's completion callbacks starve under a zero-delay loop.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { HumanWaitParkedEvent } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import {
  expectScenarioPassed,
  type ScenarioScope,
  settleScenario,
  waitForBureauState,
} from './test/hoisted-scenario';
import {
  CLAIM_TTL_MS,
  createHarnessBureau,
  HUMAN_WAIT_PROMPT,
  HUMAN_WAIT_SIGNAL,
  SECOND_HUMAN_WAIT_PROMPT,
  SECOND_HUMAN_WAIT_SIGNAL,
} from './test/process-crash-work-integrity-fixtures';
import type { Bureau } from './types';
import { createLmdbStorageFixture, createSqliteStorageFixture } from './test/storage-fixtures';
import { readChildJson } from './test/child-output-file';

const CHILD = join(import.meta.dir, 'test', 'process-crash-child.ts');
const runtime = createDefaultRuntimeServices();

/**
 * The SIGKILLed child and the claim-lapse wait are real time and real processes, and the recovery
 * that follows boots durable engines over the child's store. None of that fits a per-test clock on
 * a loaded host, so each backend's scenario runs whole, once, at module scope (see
 * `test/hoisted-scenario.ts`); a failed assertion is captured there and rethrown by its test.
 */
async function humanWaitScenario(
  backend: Backend,
  scope: ScenarioScope,
  twoCalls: boolean,
): Promise<void> {
  const directory = createTemporaryDirectory(`corvidae-process-crash-human-wait-${backend}`);
  const storagePath = join(directory, 'bureau');
  const markerPath = join(directory, 'marker.json');
  // The child's store, opened here only once the child is gone.
  const store =
    backend === 'lmdb'
      ? createLmdbStorageFixture({ path: storagePath })
      : createSqliteStorageFixture({ path: storagePath });
  let recoverer: Bureau | undefined;
  // A hung scenario never reaches its `finally`, so what it owns is released from here.
  scope.onHang(async () => {
    await Promise.allSettled(recoverer === undefined ? [] : [recoverer.shutdown()]);
    await store.dispose();
    removeTemporaryPath(directory);
  });

  try {
    // Premise: the child died from SIGKILL and left its marker.
    const child = spawnWithHangGuard(
      [
        'bun',
        CHILD,
        twoCalls ? 'human-wait-two-calls-parked' : 'human-wait-parked',
        backend,
        storagePath,
        markerPath,
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    scope.onHang(() => child.kill());
    await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(child.signalCode ?? stderr).toBe('SIGKILL');
    expect(existsSync(markerPath)).toBe(true);
    const { runId, honoredSignal } = readChildJson<{
      runId: string;
      honoredSignal?: string;
    }>(markerPath);
    // COR-1578: of the two requests in one step, the child's live review names the honored one.
    const expectedSignal = twoCalls ? honoredSignal : HUMAN_WAIT_SIGNAL;
    const expectedPrompt =
      expectedSignal === SECOND_HUMAN_WAIT_SIGNAL ? SECOND_HUMAN_WAIT_PROMPT : HUMAN_WAIT_PROMPT;
    const otherSignal =
      expectedSignal === HUMAN_WAIT_SIGNAL ? SECOND_HUMAN_WAIT_SIGNAL : HUMAN_WAIT_SIGNAL;
    expect([HUMAN_WAIT_SIGNAL, SECOND_HUMAN_WAIT_SIGNAL]).toContain(expectedSignal as string);

    // The dead holder's claim lapses on Weft's own wall clock.
    await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, CLAIM_TTL_MS * 10));

    let generateCalls = 0;
    recoverer = await createHarnessBureau({
      storage: store.storage,
      generate: async () => {
        generateCalls += 1;
        return { content: 'resumed after the crash', toolCalls: [] };
      },
      toolbox: createToolbox([]),
    });
    const bureau = recoverer;
    const report = await bureau.recovery();
    expect(report.outcome).toBe('clean');
    expect(report.perRunFailures).toEqual([]);

    const reviewsFor = () => bureau.reviews.list().filter((review) => review.runId === runId);
    await waitForBureauState([bureau], () => reviewsFor().length > 0, { runIds: [runId] });
    await waitForBureauState(
      [bureau],
      () => bureau.tasks.detail(runId)?.liveness.status === 'waiting',
      {
        runIds: [runId],
      },
    );

    const reviews = reviewsFor();
    expect(reviews).toHaveLength(1);
    const [review] = reviews;
    if (review?.kind !== 'human-wait')
      throw new Error(`expected a human-wait review, got ${review?.kind}`);
    expect(review.signalName).toBe(expectedSignal as string);
    expect(review.prompt).toBe(expectedPrompt);
    expect(review.id).toBe(`human-wait:${runId}:${expectedSignal}:0`);
    if (twoCalls) {
      // The refused request left no park and no review behind.
      const parkedSignals = (bureau.internals.store.getRun(runId)?.actions ?? [])
        .filter((action) => action.type === HumanWaitParkedEvent.type)
        .map((action) => (action.detail as { signalName: string }).signalName);
      expect(parkedSignals).not.toContain(otherSignal);
      expect(reviewsFor().some((candidate) => candidate.id.includes(`:${otherSignal}:`))).toBe(
        false,
      );
    }
    const liveness = bureau.tasks.detail(runId)?.liveness;
    expect(liveness?.declaredWait?.reason).toBe('review');
    expect(liveness?.declaredWait?.dependency).toBe(expectedSignal as string);
    // The recovered run is parked, not looping: nothing generated before approval.
    expect(generateCalls).toBe(0);

    await bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'operator' });

    await waitForBureauState([bureau], () => bureau.tasks.detail(runId)?.status === 'completed', {
      runIds: [runId],
    });
    expect(generateCalls).toBe(1);
    expect(reviewsFor()).toHaveLength(0);
    expect(bureau.tasks.detail(runId)?.liveness.declaredWait).toBeUndefined();
    // Weft's own result waiter: it settles after the durable commit.
    const durableState = await bureau.tasks.wait(runId);
    expect(durableState?.status).toBe('completed');
  } finally {
    // allSettled never rejects, so the directory is always removed after shutdown.
    const reports = await Promise.allSettled(recoverer === undefined ? [] : [recoverer.shutdown()]);
    await store.dispose();
    removeTemporaryPath(directory);
    for (const report of reports) {
      expect(report.status).toBe('fulfilled');
      if (report.status === 'fulfilled') expect(report.value.unresolved).toBe(0);
    }
  }
}

type Backend = 'sqlite' | 'lmdb';
// The hang guard is the per-test timeout these tests carried before they were hoisted. It only
// stops a genuine hang; every wait for a state change is by event (`waitForBureauState`).
const HANG_GUARD_MILLISECONDS = 120_000;
const outcomes = {
  sqlite: await settleScenario(
    (scope) => humanWaitScenario('sqlite', scope, false),
    HANG_GUARD_MILLISECONDS,
  ),
  lmdb: await settleScenario(
    (scope) => humanWaitScenario('lmdb', scope, false),
    HANG_GUARD_MILLISECONDS,
  ),
};
// COR-1578: the same park step with a second, refused request in it.
const twoCallOutcomes = {
  sqlite: await settleScenario(
    (scope) => humanWaitScenario('sqlite', scope, true),
    HANG_GUARD_MILLISECONDS,
  ),
  lmdb: await settleScenario(
    (scope) => humanWaitScenario('lmdb', scope, true),
    HANG_GUARD_MILLISECONDS,
  ),
};

describe.each(['sqlite', 'lmdb'] as const)(
  'a human-wait park survives SIGKILL over %s',
  (backend) => {
    it('surfaces the recovered review, waits on it, and resumes exactly once when it is approved', () => {
      expectScenarioPassed(outcomes[backend]);
    });
  },
);

describe.each(['sqlite', 'lmdb'] as const)(
  'a two-request park step recovers parked on its first request over %s (COR-1578)',
  (backend) => {
    it('lists one review for the honored request, none for the refused one, and resumes once when it is approved', () => {
      expectScenarioPassed(twoCallOutcomes[backend]);
    });
  },
);
