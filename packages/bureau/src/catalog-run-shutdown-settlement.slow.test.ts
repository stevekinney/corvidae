/**
 * COR-2005 — a catalog run's settlement writes nothing once the Bureau that followed it has shut
 * down.
 *
 * A shutdown waits for the settlements of runs that have ended, and for a bounded number of turns
 * for the runs that have not. A run whose agent ignores its abort ends after that: its end is
 * known only when the Bureau has already returned, and the host disposes the storage behind it.
 * Publishing that end would run every listener's reads and writes against closed storage (in the
 * Interborough host, `PostgresStorage pool has been disposed`; here, the Bureau's own fence).
 * The run is left for the next process, which settles its task from the durable state at boot.
 *
 * Slow lane: a process-local child that ignores its abort costs the shutdown's own two bounded
 * waits for aborted runs (a second each), which no test input shortens.
 */
import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import {
  createDiagnostics,
  createLatch,
  hangUntilAborted,
} from './testing/goal-fixtures.test-support';
import type { Bureau } from './types';

const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

function agentOf(name: string, generate: GenerateFunction) {
  return createAgent({ name, generate, stopWhen: stopWhen.noToolCalls() });
}

/** A parent task that stays running, and a process-local child of it whose agent ends when `gate` is released. */
async function childHeldBy(gate: ReturnType<typeof createLatch>) {
  const diagnostics = createDiagnostics();
  const reached = createLatch();
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      planner: agentOf('planner', hangUntilAborted),
      // Ignores the abort, as a provider call that does not honor its signal does.
      worker: agentOf('worker', async () => {
        reached.release();
        await gate.promise;
        return { content: 'done', toolCalls: [] };
      }),
    },
    storage: new MemoryStorage(),
    onDiagnostic: diagnostics.onDiagnostic,
  });
  bureaus.push(bureau);
  const parent = await bureau.tasks.start('planner', 'plan the work', { principal: 'alice' });
  const dispatched = await bureau.children.dispatch({
    parentRunId: parent.id,
    agentName: 'worker',
    input: 'do the work',
    principal: 'alice',
    childRunId: 'child-1',
  });
  if (dispatched.outcome !== 'started') throw new Error('expected a started child');
  await reached.promise;
  return { bureau, diagnostics, childId: dispatched.child.childRunId };
}

describe('a catalog run that ends after its Bureau has shut down', () => {
  for (const policy of ['detach', 'abort'] as const) {
    it(`publishes no settlement to listeners under the ${policy} policy`, async () => {
      const gate = createLatch();
      const { bureau, diagnostics } = await childHeldBy(gate);

      await bureau.shutdown({ policy });
      gate.release();
      // The run ends now; nothing it triggers may reach the closed storage.
      await quietFor(250);

      expect(diagnostics.scope('catalog-run-settlement').map(({ message }) => message)).toEqual([]);
    });
  }

  it('still settles the task of a run that ends before the shutdown', async () => {
    const gate = createLatch();
    const { bureau, diagnostics, childId } = await childHeldBy(gate);

    gate.release();
    await waitUntil(
      async () => {
        const task = await bureau.tasks.get(childId);
        return task?.status === 'completed';
      },
      { message: 'the child task to settle' },
    );
    await bureau.shutdown({ policy: 'detach' });

    expect(diagnostics.scope('catalog-run-settlement')).toEqual([]);
  });
});
