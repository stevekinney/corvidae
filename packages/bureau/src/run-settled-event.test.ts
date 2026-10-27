import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
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
});
