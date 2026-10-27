/**
 * A task started over another transport has no A2A record, so its first continuation over A2A
 * creates one (COR-1637): the continuation and the reply that follows it appear in the task's A2A
 * history instead of being dropped by an update to a record that does not exist.
 */
import type { GenerateFunction } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../test';
import { call, type Json, message, send, withA2A } from './a2a-mount.test-support.ts';
import { OWNER } from './management/management-fixtures.test-support.ts';

/** Holds its first step until released, so the task is still working when input reaches it. */
function gated(): { generate: GenerateFunction; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  return {
    release: () => release(),
    generate: async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { content: 'the reply', toolCalls: [] };
    },
  };
}

describe('the first A2A continuation of a task another transport started', () => {
  it('records the continuation and, once the task settles, its reply', async () => {
    const run = gated();
    await withA2A({ asker: run.generate }, async (opened) => {
      const started = await opened.bureau.tasks.start('asker', 'started natively', {
        principal: OWNER.alice,
      });

      const continued = await send(opened, 'asker', {
        message: message('continued over A2A', { taskId: started.id }),
        configuration: { returnImmediately: true },
      });
      expect(continued.body.error).toBeUndefined();
      run.release();
      await waitForCondition(async () => {
        const read = await call(opened, 'asker', 'GetTask', { id: started.id });
        const texts = JSON.stringify(read.body.result.history ?? []);
        return texts.includes('continued over A2A') && texts.includes('the reply');
      }, 'the continuation and the reply never reached the A2A history');
      const read = await call(opened, 'asker', 'GetTask', { id: started.id });
      const history: Json[] = read.body.result.history;
      expect(history.filter((entry) => JSON.stringify(entry).includes('the reply'))).toHaveLength(
        1,
      );
    });
  });
});
