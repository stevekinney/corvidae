/**
 * COR-1598 — a run that fails and is then recovered after a crash fails the way a run that fails
 * without one does. Both end `run.error`, then `run.completed`, so the run record, the session,
 * and an attached AG-UI stream agree.
 *
 * Each reason has one injection point shared by both runs: a scripted model whose step 1 rejects
 * with the failure, after a step 0 that calls a tool. The recovered run is one that Bureau A
 * fails and never commits (the held terminal commit), so Bureau B over the same database file
 * replays its memoized steps, with no model call, and settles it from its stored summary.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventType } from '@ag-ui/core';
import {
  BudgetExceededError,
  ElicitationDeniedError,
  type GenerateFunction,
  GuardrailTripwireError,
} from '@lostgradient/operative';
import { resolveStorage } from '@lostgradient/weft';
import { createTool, createToolbox, type Tool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createMemoryAssetStorage } from './assets/storage';
import { createBureau } from './create-bureau';
import { attachRunRequest } from './http/ag-ui-fixtures.test-support';
import { readAgUiStream, typesOf } from './http/ag-ui-stream.test-support';
import { createBureauHandler } from './http/create-bureau-handler';
import { waitForCondition } from './test';
import { holdFirstTerminalRunCommit } from './test/held-terminal-commit';

type Bureau = Awaited<ReturnType<typeof createBureau>>;

const noopTool = createTool({
  name: 'noop',
  description: 'does nothing',
  input: z.object({}),
  execute: async () => ({}),
});

/** Step 0 calls a tool, so the failing step is 1 and no step number defaults to it. */
function generateThenFail(failure: unknown): GenerateFunction {
  return async ({ step }) =>
    step === 0
      ? { content: '', toolCalls: [{ name: 'noop', arguments: {} }] }
      : Promise.reject(failure);
}

const failures: Array<{
  reason: string;
  failure: () => Error;
  lifecycle: string[];
}> = [
  {
    reason: 'budget-exceeded',
    failure: () => new BudgetExceededError('token limit reached'),
    lifecycle: ['run.error', 'run.completed'],
  },
  {
    reason: 'tripwire',
    failure: () =>
      new GuardrailTripwireError('guardrail tripped', {
        guardrailName: 'no-secrets',
        category: 'secrets',
        phase: 'input',
        confidence: 0.9,
      }),
    lifecycle: ['run.error', 'run.tripwire', 'run.completed'],
  },
  {
    reason: 'elicitation-denied',
    failure: () => new ElicitationDeniedError(),
    lifecycle: ['run.error', 'run.completed'],
  },
];

const LIFECYCLE_EVENTS = new Set(['run.error', 'run.tripwire', 'run.completed', 'run.aborted']);

/** A restarted Bureau keeps its identifier, so a Bureau that persists is given one. */
const BUREAU_ID = 'recovered-run-failure-parity';

let databaseCounter = 0;

function databasePathFor(label: string): string {
  return join(
    tmpdir(),
    `bureau-recovered-failure-${label}-${process.pid}-${databaseCounter++}.sqlite`,
  );
}

async function removeDatabase(databasePath: string): Promise<void> {
  await rm(databasePath, { force: true });
  await rm(`${databasePath}-wal`, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
}

/** What a settled run left behind, read from the Bureau that settled it. */
type Settled = {
  readonly runId: string;
  readonly status: string | undefined;
  readonly lifecycle: string[];
  readonly lastRunStatus: unknown;
  readonly lastFinishReason: unknown;
  readonly lastError: unknown;
  /** The `run.error` records of the run's durable event history, as recorded. */
  readonly recordedRunErrors: unknown[];
  readonly bureau: Bureau;
};

async function settle(bureau: Bureau, runId: string, sessionId: string): Promise<Settled> {
  await waitForCondition(async () => {
    const session = await bureau.getSession(sessionId);
    return session?.metadata['lastRunStatus'] !== 'running';
  }, 'the run never settled');
  await waitForCondition(
    async () =>
      bureau.getRun(runId)?.events.some((event) => event.event === 'run.completed') === true,
    'the run never recorded its completion',
  );
  const run = bureau.getRun(runId)!;
  const session = (await bureau.getSession(sessionId))!;
  const history = await bureau.eventHistory({ kind: 'run', id: runId });
  const recorded = 'events' in history ? history.events : [];
  return {
    runId,
    bureau,
    status: run.status,
    lifecycle: run.events.map(({ event }) => event).filter((event) => LIFECYCLE_EVENTS.has(event)),
    lastRunStatus: session.metadata['lastRunStatus'],
    lastFinishReason: session.metadata['lastFinishReason'],
    lastError: session.metadata['lastError'],
    recordedRunErrors: recorded.filter((entry) => entry.kind === 'run.error').map((e) => e.payload),
  };
}

/** Runs the failure to the end in one Bureau. */
async function withFreshRun<T>(
  failure: unknown,
  inspect: (settled: Settled) => Promise<T>,
): Promise<T> {
  const databasePath = databasePathFor('fresh');
  const bureau = await createBureau({
    agents: {},
    generate: generateThenFail(failure),
    toolbox: createToolbox<readonly Tool[]>([noopTool]),
    storage: { type: 'sqlite', path: databasePath },
    durableExecution: true,
  });
  try {
    const run = await bureau.createRun({ message: 'Go.' });
    return await inspect(await settle(bureau, run.id, run.sessionId));
  } finally {
    await bureau.dispose();
    await removeDatabase(databasePath);
  }
}

/**
 * Crashes a run at the failure and recovers it in a second Bureau over the same database file.
 * Bureau A never learns the outcome, because its terminal commit is held; Bureau B replays the
 * memoized steps without calling `generate`.
 */
async function withRecoveredRun<T>(
  failure: unknown,
  inspect: (settled: Settled, calls: { generateCallsAfterRestart: number }) => Promise<T>,
  /** Runs once Bureau B holds the run, before its replay can settle: where a subscriber attaches. */
  beforeReplaySettles?: (bureau: Bureau, runId: string) => Promise<void> | void,
): Promise<T> {
  const databasePath = databasePathFor('recovered');
  const crashed = holdFirstTerminalRunCommit(
    await resolveStorage({ type: 'sqlite', path: databasePath }),
  );
  let replayed: ReturnType<typeof holdFirstTerminalRunCommit> | undefined;
  let bureauA: Bureau | undefined;
  let bureauB: Bureau | undefined;
  try {
    bureauA = await createBureau({
      agents: {},
      id: BUREAU_ID,
      generate: generateThenFail(failure),
      toolbox: createToolbox<readonly Tool[]>([noopTool]),
      storage: crashed.storage,
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
    });
    const run = await bureauA.createRun({ message: 'Go.' });
    await crashed.reached;
    replayed = holdFirstTerminalRunCommit(
      await resolveStorage({ type: 'sqlite', path: databasePath }),
    );
    const calls = { generateCallsAfterRestart: 0 };
    bureauB = await createBureau({
      agents: {},
      id: BUREAU_ID,
      generate: async (input) => {
        calls.generateCallsAfterRestart += 1;
        return generateThenFail(failure)(input);
      },
      toolbox: createToolbox<readonly Tool[]>([noopTool]),
      storage: replayed.storage,
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      // The AG-UI handler the stream test mounts serves the asset routes, so it needs the service.
      assets: { storage: createMemoryAssetStorage() },
    });
    await replayed.reached;
    await beforeReplaySettles?.(bureauB, run.id);
    replayed.release();
    return await inspect(await settle(bureauB, run.id, run.sessionId), calls);
  } finally {
    await bureauB?.dispose();
    // Disposed before any release: bureau A's held commit stays pending, as a dead process's would.
    await bureauA?.dispose();
    crashed.storage[Symbol.dispose]();
    replayed?.storage[Symbol.dispose]();
    await removeDatabase(databasePath);
  }
}

describe.each(failures)('a $reason run', ({ reason, failure, lifecycle }) => {
  it(`ends a recovered ${reason} run the way a fresh one ends`, async () => {
    const fresh = await withFreshRun(failure(), async (settled) => ({
      status: settled.status,
      lifecycle: settled.lifecycle,
      lastRunStatus: settled.lastRunStatus,
      lastFinishReason: settled.lastFinishReason,
      lastError: settled.lastError,
    }));
    const recovered = await withRecoveredRun(failure(), async (settled, calls) => {
      // The replay is the point: no model call, so only the stored summary says how it ended.
      expect(calls.generateCallsAfterRestart).toBe(0);
      return {
        status: settled.status,
        lifecycle: settled.lifecycle,
        lastRunStatus: settled.lastRunStatus,
        lastFinishReason: settled.lastFinishReason,
        lastError: settled.lastError,
      };
    });

    // The filter also catches a duplicated `run.error`.
    expect(fresh.lifecycle).toEqual(lifecycle);
    expect(recovered.lifecycle).toEqual(lifecycle);
    expect(fresh.status).toBe('error');
    expect(recovered.status).toBe('error');
    expect(recovered.lastRunStatus).toBe(fresh.lastRunStatus);
    expect(recovered.lastFinishReason).toBe(fresh.lastFinishReason);
    expect(recovered.lastFinishReason).toBe(reason);
    expect(recovered.lastError).toBeDefined();
  });

  it(`ends the AG-UI stream of a recovered ${reason} run with RUN_ERROR`, async () => {
    // The stream is attached while the replay is held, so it is the live stream of the recovery
    // and not the snapshot of a run that already ended.
    let streamed: Promise<Awaited<ReturnType<typeof readAgUiStream>>> | undefined;
    await withRecoveredRun(
      failure(),
      async () => {
        const stream = await streamed!;
        expect(typesOf(stream).at(-1)).toBe(EventType.RUN_ERROR);
        expect(typesOf(stream)).not.toContain(EventType.RUN_FINISHED);
      },
      async (bureau, runId) => {
        const handler = createBureauHandler(bureau, {
          unauthenticatedAccess: 'allow',
          publish: [],
          agUi: {},
        });
        streamed = readAgUiStream(await handler(attachRunRequest(runId)));
      },
    );
  });

  it('records reconstructed: true on a recovered run.error and omits it on a live one', async () => {
    const live = await withFreshRun(failure(), async (settled) => settled.recordedRunErrors);
    const recovered = await withRecoveredRun(
      failure(),
      async (settled) => settled.recordedRunErrors,
    );

    expect(live).toHaveLength(1);
    expect(Object.hasOwn(live[0] as object, 'reconstructed')).toBe(false);
    expect(
      recovered.some((payload) => (payload as { reconstructed?: unknown }).reconstructed === true),
    ).toBe(true);
  });
});
