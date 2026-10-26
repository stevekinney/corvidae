/**
 * `observed` on a new task's receipt (COR-1661): the task's end is in its durable history, not
 * only in the task registry. A task whose terminal event failed to append reports `applied` until
 * the history is repaired, and `observed` after.
 */
import { createAgent } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { faultyStorage } from './a2a-faulty-storage.test-support.ts';
import { COMMAND_RECEIPTS_EXTENSION_URI } from './a2a-command-receipts.ts';
import { type Json, message, send } from './a2a-mount.test-support.ts';
import { openBureau } from './management/management-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const ACTIVE = { headers: { 'A2A-Extensions': COMMAND_RECEIPTS_EXTENSION_URI } };
const receiptOf = (sent: Json): string =>
  sent.body.result.task.metadata[COMMAND_RECEIPTS_EXTENSION_URI].receipt.state;

async function open(storage?: Awaited<ReturnType<typeof faultyStorage>>['storage']) {
  const opened = await openBureau({
    agents: {
      asker: createAgent({
        name: 'asker',
        generate: async () => ({ content: 'done', toolCalls: [] }),
      }),
    },
    publish: ['asker'],
    ...(storage === undefined ? { durableHistory: true } : { storage }),
    handlerOptions: { publicUrl: 'http://localhost' },
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

describe('a new task’s receipt over a durable history', () => {
  it('is observed once the terminal event is in the history', async () => {
    const opened = await open();
    const original = message('go');

    const first = await send(opened, 'asker', { message: original }, ACTIVE);
    const retry = await send(opened, 'asker', { message: original }, ACTIVE);

    expect([receiptOf(first), receiptOf(retry)]).toEqual(['observed', 'observed']);
  });

  it('is applied while the terminal event failed to append, and observed once the history is repaired', async () => {
    const { storage, faults } = await faultyStorage(cleanups);
    faults.failCompletions = 1;
    // The repair fails too, until maintenance retries it.
    faults.failResyncs = 1;
    const opened = await open(storage);
    const original = message('go');

    const first = await send(opened, 'asker', { message: original }, ACTIVE);
    const beforeRepair = await send(opened, 'asker', { message: original }, ACTIVE);
    expect(first.body.result.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(faults.failCompletions).toBe(0);
    await opened.bureau.runDurableMaintenance();
    const afterRepair = await send(opened, 'asker', { message: original }, ACTIVE);

    expect([receiptOf(first), receiptOf(beforeRepair), receiptOf(afterRepair)]).toEqual([
      'applied',
      'applied',
      'observed',
    ]);
  });
});
