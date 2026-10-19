/**
 * A remote-mode activity's timeline entry names the task ledger record it was enqueued under
 * (`WorkflowTimelineEntry.taskOperationId`), set by the engine where it dispatches. A client reads
 * the ledger by that value and never rebuilds Weft's internal key from the entry's step: the
 * ledger key follows the activity's own counter, one below the timeline step.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { decodeRemoteTaskRecord } from '../task-ledger/task-ledger.ts';
import type { WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { Engine } from './index.ts';

let engine: Engine | undefined;
afterEach(() => {
  engine?.[Symbol.dispose]();
  engine = undefined;
});

async function queuedOperationIds(target: Engine): Promise<string[]> {
  const ids: string[] = [];
  for await (const [, value] of target.storage.scan('task-ledger:')) {
    const record = decodeRemoteTaskRecord(value);
    if (record !== null && record.state === 'queued') ids.push(record.operationId);
  }
  return ids;
}

async function completeEveryQueued(target: Engine, expected: number): Promise<void> {
  const completed: string[] = [];
  while (completed.length < expected) {
    await waitForCondition(
      async () => {
        const queued = await queuedOperationIds(target);
        return queued.some((id) => !completed.includes(id));
      },
      { timeoutMs: 3_000, intervalMs: 10, label: 'a queued remote task' },
    );
    for (const id of await queuedOperationIds(target)) {
      if (completed.includes(id)) continue;
      completed.push(id);
      await target.completeAsyncActivity(id, `done:${id}`);
    }
  }
}

async function ledgerActivityName(
  target: Engine,
  operationId: string,
): Promise<string | undefined> {
  for await (const [, value] of target.storage.scan('task-ledger:')) {
    const record = decodeRemoteTaskRecord(value);
    if (record?.operationId === operationId) return record.activityName;
  }
  return undefined;
}

const first = activity({ name: 'first', execute: async (_input: null) => 'local-first' });
const second = activity({ name: 'second', execute: async (_input: null) => 'local-second' });

describe('timeline entry taskOperationId', () => {
  it('names each of two sequential remote ctx.run() activities’ own ledger record', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    engine.register(
      workflow({ name: 'sequential-remote' })
        .activities({ first, second })
        .execute(async function* (context: WorkflowContext) {
          const a = yield* context.run(first, null);
          const b = yield* context.run(second, null);
          return [a, b];
        }),
    );
    const handle = await engine.start('sequential-remote', null, { id: 'sequential-remote-1' });
    await completeEveryQueued(engine, 2);
    await handle.result();

    const timeline = await engine.getTimeline('sequential-remote-1');
    const entries = timeline.filter((entry) => entry.operationType === 'activity');
    expect(entries.map((entry) => entry.operationLabel)).toEqual(['first', 'second']);
    const identities = entries.map((entry) => entry.taskOperationId);
    expect(new Set(identities).size).toBe(2);
    for (const entry of entries) {
      expect(entry.taskOperationId).toBeDefined();
      // Each identity resolves to the record for that very activity, not its neighbour's.
      expect(await ledgerActivityName(engine, entry.taskOperationId ?? '')).toBe(
        `sequential-remote.${entry.operationLabel}`,
      );
    }
  });

  it('is absent on entries that did not go through the task ledger', async () => {
    engine = new Engine();
    engine.register(
      workflow({ name: 'inline-only' })
        .activities({ first, second })
        .execute(async function* (context: WorkflowContext) {
          const a = yield* context.run(first, null);
          const b = yield* context.run(second, null);
          return [a, b];
        }),
    );
    const handle = await engine.start('inline-only', null, { id: 'inline-only-1' });
    await handle.result();

    const entries = await engine.getTimeline('inline-only-1');
    expect(entries.map((entry) => entry.operationLabel)).toEqual(['first', 'second']);
    for (const entry of entries) expect(entry).not.toHaveProperty('taskOperationId');
  });
});
