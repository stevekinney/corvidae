import { afterEach, describe, expect, it } from 'bun:test';

import type { Storage } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  collectKeys,
  flush,
  waitForWorkflowStatus,
} from '../../testing/storage-backends.test-support.ts';
import { encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import type { WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';
import type { UpdateHistoryEntry } from '../update-history.ts';
import { getInternals } from './internals.ts';
import { drainUpdateHistory, UPDATE_HISTORY_PURGE_CHUNK } from './purge-update-history.ts';
import { addUpdateDeleteKeys } from './purge-update-keys.ts';

const parked = workflow({ name: 'drain-subject' }).execute(async function* (ctx: WorkflowContext) {
  yield* ctx.waitForSignal('finish');
  return 'done';
});

async function completedRunWithHistory(
  storage: Storage,
  entries: number,
): Promise<{ engine: Engine; workflowId: string }> {
  const engine = new Engine({ storage });
  engine.register(parked);
  const handle = await engine.start('drain-subject', undefined);
  handle.result().catch(() => {});
  await waitForWorkflowStatus(engine, handle.id, 'running');
  for (let index = 0; index < entries; index += 1) {
    const updateId = `drain-update-${index}`;
    const entry: UpdateHistoryEntry = {
      updateId,
      name: 'seeded',
      receivedAt: 1_000 + index,
      outcome: 'completed',
      completedAt: 2_000 + index,
    };
    await storage.put(KEYS.updateHistory(handle.id, entry.receivedAt, updateId), encode(entry));
    await storage.put(
      KEYS.updateResponse(updateId),
      encode({ updateId, result: index, createdAt: Date.now() }),
    );
  }
  await engine.signal(handle.id, 'finish', undefined);
  await waitForWorkflowStatus(engine, handle.id, 'completed');
  await flush();
  return { engine, workflowId: handle.id };
}

describe('drainUpdateHistory', () => {
  let engine: Engine | undefined;

  afterEach(async () => {
    engine?.[Symbol.dispose]();
    await flush();
  });

  it('removes every entry and the response it names, across more than one chunk', async () => {
    const storage = new MemoryStorage();
    const count = UPDATE_HISTORY_PURGE_CHUNK * 2 + 5;
    const run = await completedRunWithHistory(storage, count);
    engine = run.engine;
    const state = await engine.get(run.workflowId);

    await drainUpdateHistory(getInternals(engine), state!);

    expect(await collectKeys(storage, 'uph:')).toEqual([]);
    expect(await collectKeys(storage, 'upr:')).toEqual([]);
  });

  it('leaves the history alone for a run record other than the one it was asked about', async () => {
    const storage = new MemoryStorage();
    const run = await completedRunWithHistory(storage, 3);
    engine = run.engine;
    const state = await engine.get(run.workflowId);

    // A same-id replacement carries another execution token, and shares this key prefix.
    await drainUpdateHistory(getInternals(engine), {
      ...state!,
      workflowExecutionToken: 'a-replacement-run',
    });

    expect(await collectKeys(storage, 'uph:')).toHaveLength(3);
    expect(await collectKeys(storage, 'upr:')).toHaveLength(3);
  });

  it('stops, removing nothing further, when the run record moved after it was read', async () => {
    const backing = new MemoryStorage();
    let fenceLost = false;
    const storage: Storage = {
      capabilities: () => backing.capabilities(),
      get: (key) => backing.get(key),
      put: (key, value) => backing.put(key, value),
      delete: (key) => backing.delete(key),
      scan: (prefix, options) => backing.scan(prefix, options),
      batch: (operations) => backing.batch(operations),
      // The record changed between the read and the chunk: the fence refuses.
      conditionalBatch: async (conditions, operations) =>
        fenceLost ? false : backing.conditionalBatch!(conditions, operations),
      [Symbol.dispose]: () => backing[Symbol.dispose](),
    };
    const run = await completedRunWithHistory(storage, 3);
    engine = run.engine;
    const state = await engine.get(run.workflowId);
    fenceLost = true;

    await drainUpdateHistory(getInternals(engine), state!);

    expect(await collectKeys(backing, 'uph:')).toHaveLength(3);
  });
});

describe('addUpdateDeleteKeys', () => {
  let engine: Engine | undefined;

  afterEach(async () => {
    engine?.[Symbol.dispose]();
    await flush();
  });

  it('still names whatever history is left when the purge batch is built, and the responses it names', async () => {
    const storage = new MemoryStorage();
    const run = await completedRunWithHistory(storage, 2);
    engine = run.engine;

    const keys = new Set<string>();
    await addUpdateDeleteKeys(storage, keys, run.workflowId);

    expect([...keys].toSorted()).toEqual(
      [
        ...(await collectKeys(storage, 'uph:')),
        KEYS.updateResponse('drain-update-0'),
        KEYS.updateResponse('drain-update-1'),
      ].toSorted(),
    );
  });
});
