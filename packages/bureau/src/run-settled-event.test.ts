import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { retireSettledTasks, SHORT_TASK_RETENTION } from './testing/run-retirement.test-support';
import type { AgentDefinitions } from './agent-catalog';

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

describe('run.settled', () => {
  it.each([false, true])('publishes once after a task settles (durable=%s)', async (durable) => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        worker: createAgent({ generate: async () => ({ content: 'done', toolCalls: [] }) }),
      },
      runtime: createManualRuntimeServices(),
      ...(durable ? { durable: true } : {}),
    });
    const settled: string[] = [];
    bureau.addEventListener('run.settled', (event) => settled.push(event.runId));
    try {
      const run = await bureau.tasks.start('worker', 'settle me');
      await run.result();
      await bureau.internals.taskRegistry.flush();
      const envelopes = await collect(bureau.internals.eventFeed.feed.replay());

      expect(settled).toEqual([run.id]);
      expect(envelopes.at(-1)).toMatchObject({ kind: 'run.settled', payload: { runId: run.id } });
      expect(bureau.internals.store.getRun(run.id)).toBeDefined();
      expect(bureau.internals.runEventFeeds.get(run.id)).toBeDefined();
    } finally {
      await bureau.dispose();
    }
  });

  it.each([false, true])(
    'publishes for an actual task cancellation (durable=%s)',
    async (durable) => {
      const gate = Promise.withResolvers<void>();
      const bureau = await createBureau<AgentDefinitions>({
        agents: {
          worker: createAgent({
            generate: async () => {
              await gate.promise;
              return { content: 'released', toolCalls: [] };
            },
          }),
        },
        ...(durable ? { durable: true } : {}),
      });
      const settled: string[] = [];
      bureau.addEventListener('run.settled', (event) => settled.push(event.runId));
      try {
        const run = await bureau.tasks.start('worker', 'cancel me');
        while (bureau.internals.store.getRun(run.id)?.status !== 'running') await Promise.resolve();
        const cancellation = await bureau.tasks.cancel(run.id);
        expect(cancellation?.receipt).toBe('cancel-requested');
        gate.resolve();
        await run.result();
        await bureau.internals.taskRegistry.flush();

        expect(settled).toEqual([run.id]);
      } finally {
        gate.resolve();
        await bureau.dispose();
      }
    },
  );

  it('does not delete a settled run, and retention later emits run.removed', async () => {
    const runtime = createManualRuntimeServices();
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        worker: createAgent({ generate: async () => ({ content: 'done', toolCalls: [] }) }),
      },
      runtime,
      ...SHORT_TASK_RETENTION,
    });
    const settled: string[] = [];
    const removed: string[] = [];
    bureau.addEventListener('run.settled', (event) => settled.push(event.runId));
    bureau.addEventListener('run.removed', (event) => removed.push(event.runId));
    try {
      const run = await bureau.tasks.start('worker', 'retain me');
      await run.result();
      await bureau.internals.taskRegistry.flush();
      expect(settled).toEqual([run.id]);
      expect(bureau.internals.store.getRun(run.id)).toBeDefined();

      await retireSettledTasks(bureau, runtime);

      expect(removed).toEqual([run.id]);
      expect(bureau.internals.store.getRun(run.id)).toBeUndefined();
    } finally {
      await bureau.dispose();
    }
  });
});
