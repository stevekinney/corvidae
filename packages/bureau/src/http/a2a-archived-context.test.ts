/**
 * COR-2285 — an A2A `SendMessage` that names an archived context starts no task in it. The refusal
 * is `UnsupportedOperationError` (-32004), whose message names the stable reason
 * `context-archived`, never the -32001 a missing or another owner's context answers, and the
 * context takes the same message once it is unarchived.
 */
import { describe, expect, it } from 'bun:test';

import { listHeldTasks } from '../test';
import { answering, message, send, sendForTask, withA2A } from './a2a-mount.test-support.ts';

describe('a message to an archived context over A2A', () => {
  it('is refused as unsupported, naming context-archived, and starts nothing until unarchived', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      const first = await sendForTask(opened, 'asker', {
        message: message('one', { contextId: 'ctx-archived' }),
      });
      expect(first.contextId).toBe('ctx-archived');
      expect(await opened.bureau.contexts.archive('ctx-archived')).toMatchObject({
        changed: true,
      });
      const held = listHeldTasks(opened.bureau).length;

      const refused = await send(opened, 'asker', {
        message: message('two', { contextId: 'ctx-archived' }),
      });

      expect(refused.body.error.code).toBe(-32004);
      expect(refused.body.error.message).toContain('context-archived');
      expect(listHeldTasks(opened.bureau)).toHaveLength(held);

      await opened.bureau.contexts.unarchive('ctx-archived');
      const again = await sendForTask(opened, 'asker', {
        message: message('two', { contextId: 'ctx-archived' }),
      });
      expect(again.contextId).toBe('ctx-archived');
      expect(again.id).not.toBe(first.id);
    });
  });

  it('answers another owner’s archived context as not found', async () => {
    await withA2A({ asker: answering('done') }, async (opened) => {
      await send(
        opened,
        'asker',
        { message: message('mine', { contextId: 'ctx-bob-archived' }) },
        { key: 'bob-key' },
      );
      await opened.bureau.contexts.archive('ctx-bob-archived');

      const stolen = await send(opened, 'asker', {
        message: message('yours', { contextId: 'ctx-bob-archived' }),
      });

      expect(stolen.body.error.code).toBe(-32001);
    });
  });
});
