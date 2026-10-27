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
import { createBureauHandler } from './create-bureau-handler.ts';
import { authentication, openBureau } from './management/management-fixtures.test-support.ts';

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
    await opened.bureau.maintain();
    const afterRepair = await send(opened, 'asker', { message: original }, ACTIVE);

    expect([receiptOf(first), receiptOf(beforeRepair), receiptOf(afterRepair)]).toEqual([
      'applied',
      'applied',
      'observed',
    ]);
  });

  it('is observed when the terminal event is there, whatever an earlier append left marked', async () => {
    const opened = await open();
    // An earlier, non-terminal append failed and its repair has not landed: the mark stays set.
    const marked = Object.create(opened.bureau, {
      internals: {
        value: {
          ...opened.bureau.internals,
          taskRegistry: new Proxy(opened.bureau.internals.taskRegistry, {
            get(target, property) {
              if (property !== 'record') return Reflect.get(target, property, target);
              return async (id: string) => {
                const record = await target.record(id);
                return record === undefined ? undefined : { ...record, resyncPending: true };
              };
            },
          }),
        },
      },
    });
    const handler = createBureauHandler(marked, {
      authentication,
      publish: ['asker'],
      publicUrl: 'http://localhost',
    });
    const original = message('go');

    const sent = await send({ ...opened, handler }, 'asker', { message: original }, ACTIVE);

    expect(receiptOf(sent)).toBe('observed');
  });
});
