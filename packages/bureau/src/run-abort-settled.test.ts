/**
 * `run.abort-settled` is the signal that an aborted run's teardown has finished. `abortRun` returns
 * first, and the run's terminal status can precede `activeRun.closed()` settling, so nothing else
 * announces the moment `internals.abortingTasks()` empties.
 */
import { stopWhen, createAgent } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { RunAbortSettledEvent } from './events';
import type { AgentDefinitions } from './agent-catalog';

it('announces that an aborted run has left listAbortingRuns()', async () => {
  const generating = Promise.withResolvers<void>();
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: ({ signal }) => {
          generating.resolve();
          const parked = Promise.withResolvers<never>();
          signal?.addEventListener('abort', () => parked.reject(signal.reason), { once: true });
          return parked.promise;
        },
        toolbox: createToolbox([]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
  });
  try {
    const run = await bureau.tasks.start('default', 'go');
    await generating.promise;
    const settled = Promise.withResolvers<{ runId: string; stillAborting: number }>();
    bureau.addEventListener(RunAbortSettledEvent.type, (event) => {
      settled.resolve({
        runId: event.runId,
        stillAborting: bureau.internals.abortingTasks().length,
      });
    });

    expect(bureau.abortRun(run.id).status).toBe('aborting');
    const announcement = await settled.promise;

    expect(announcement).toEqual({ runId: run.id, stillAborting: 0 });
  } finally {
    await bureau.dispose();
  }
});
