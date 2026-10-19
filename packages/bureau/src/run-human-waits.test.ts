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

function build(engine: Pick<RegistryAgnosticEngine, 'get'>) {
  const diagnostics: Diagnostic[] = [];
  const dependencies: RunHumanWaitsDependencies = {
    store: { getRun: () => undefined },
    catalogRunIds: new Set(),
    runAttribution: new Map(),
    engine: () => engine as RegistryAgnosticEngine,
    checkpointSteps: async () => [PARKED_STEP],
    now: () => 1_000,
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
