/**
 * COR-1577 — the module that derives a `bureau.run()` run's human-wait reviews, exercised with
 * fakes for the engine and the checkpoint, where a read can be made to fail on demand.
 */
import type { DurableRunDeps } from '@lostgradient/operative';
import type { RegistryAgnosticEngine } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createRunHumanWaits, type RunHumanWaitsDependencies } from './run-human-waits';
import type { DiagnosticSink } from './types';

type Diagnostic = Parameters<DiagnosticSink>[0];

const PARKED_STEP = {
  results: [
    {
      toolName: 'requestHumanInput',
      result: { parked: true, signalName: 'answer', prompt: 'Which environment?' },
    },
  ],
};

function build(engine: Pick<RegistryAgnosticEngine, 'get'>, clock = { now: 1_000 }) {
  const diagnostics: Diagnostic[] = [];
  const dependencies: RunHumanWaitsDependencies = {
    store: { getRun: () => undefined },
    catalogRunIds: new Set(),
    runAttribution: new Map(),
    engine: () => engine as RegistryAgnosticEngine,
    checkpointSteps: async () => [PARKED_STEP],
    now: () => clock.now,
    recordDecision: async () => undefined,
    createError: (message) => new Error(message),
    durableNotConfigured: () => new Error('no durable engine'),
    diagnose: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  };
  return { waits: createRunHumanWaits(dependencies), diagnostics };
}

/** The services of the run; `attach` gives them the emitter it hears the run's next parks on. */
const SERVICES = {} as DurableRunDeps;

describe('attach', () => {
  it('lists the park of a recovered run the engine still holds', async () => {
    const { waits } = build({
      get: async () => ({ status: 'suspended', waitingForSignals: ['answer'] }) as never,
    });

    await waits.attach('run-1', { agentName: 'asker' }, SERVICES);

    expect(waits.list()).toMatchObject([
      { id: 'human-wait:run-1:answer:0', runId: 'run-1', signalName: 'answer' },
    ]);
  });

  it('names the session of a schedule fire in the review it restores, and no session for a catalog run', async () => {
    const { waits } = build({
      get: async () => ({ status: 'suspended', waitingForSignals: ['answer'] }) as never,
    });

    await waits.attach(
      'fire-1',
      { agentName: 'asker', sessionId: 'sched-1-fire-1' },
      {} as DurableRunDeps,
    );
    await waits.attach('run-1', { agentName: 'asker' }, {} as DurableRunDeps);

    const reviews = waits.list();
    expect(reviews.find((review) => review.runId === 'fire-1')?.sessionId).toBe('sched-1-fire-1');
    expect(reviews.find((review) => review.runId === 'run-1')).not.toHaveProperty('sessionId');
  });

  it('does not fail the recovered run when the engine read fails; that review is not restored', async () => {
    const { waits, diagnostics } = build({
      get: async () => {
        throw new Error('storage read failed');
      },
    });

    await waits.attach('run-1', { agentName: 'asker' }, SERVICES);

    // The run itself recovers and stays parked in the engine; only its review is left unlisted,
    // and the next restart reads the engine again.
    expect(waits.list()).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ level: 'error', scope: 'recovery' });
    expect(diagnostics[0]?.message).toContain('run-1');
    expect(diagnostics[0]?.message).toContain('storage read failed');
  });
});

describe('rereadClosed', () => {
  const GRACE = 100;
  const stillParked = {
    get: async () => ({ status: 'suspended', waitingForSignals: ['answer'] }) as never,
  };

  it('asks again when the grace of a young park ends, and does not ask the engine before then', async () => {
    let engineReads = 0;
    const clock = { now: 1_000 };
    const { waits } = build(
      {
        get: async () => {
          engineReads += 1;
          return { status: 'suspended', waitingForSignals: ['answer'] } as never;
        },
      },
      clock,
    );
    await waits.attach('run-1', { agentName: 'asker' }, SERVICES);
    engineReads = 0;

    clock.now = 1_050;
    expect(await waits.rereadClosed('run-1', GRACE)).toEqual({ retryAt: 1_100 });
    expect(engineReads).toBe(0);
  });

  it('counts the exact end of the grace as ended, so the time it asked for reads the park', async () => {
    const clock = { now: 1_000 };
    const { waits } = build(stillParked, clock);
    await waits.attach('run-1', { agentName: 'asker' }, SERVICES);

    clock.now = 1_100;

    // Verified standing: neither a close nor another retry time.
    expect(await waits.rereadClosed('run-1', GRACE)).toEqual({});
  });

  it('names the park closed once the grace has ended and the engine no longer parks the run on it', async () => {
    const clock = { now: 1_000 };
    const engineState = { waitingForSignals: ['answer'] };
    const { waits } = build(
      { get: async () => ({ status: 'suspended', ...engineState }) as never },
      clock,
    );
    await waits.attach('run-1', { agentName: 'asker' }, SERVICES);
    engineState.waitingForSignals = [];

    clock.now = 1_100;

    expect(await waits.rereadClosed('run-1', GRACE)).toEqual({
      closed: 'human-wait:run-1:answer:0',
    });
  });

  it('has nothing to say of a run it holds no park for', async () => {
    const { waits } = build(stillParked);

    expect(await waits.rereadClosed('run-9', GRACE)).toEqual({});
  });
});
