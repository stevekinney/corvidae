import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import {
  A2A_CONTEXT_INDEX_KEY_PREFIX,
  A2A_TASK_RECORD_KEY_PREFIX,
  type A2ATaskRecord,
  A2ATaskRecordVersionError,
  createA2ATaskRecords,
} from './a2a-task-record.ts';

const RECORD: A2ATaskRecord = {
  recordVersion: 1,
  taskId: 'task-1',
  contextId: 'context-1',
  incarnation: 'incarnation-1',
  history: [{ messageId: 'm-1', role: 'ROLE_USER', parts: [{ text: 'hi' }] }],
  replyRecorded: false,
};

describe('the A2A task record', () => {
  it('survives a restart over the same store, and a second create keeps the first', async () => {
    const kv = textValueStore(new MemoryStorage());
    await createA2ATaskRecords(kv).create(RECORD);

    const restarted = createA2ATaskRecords(kv);
    const again = await restarted.create({ ...RECORD, contextId: 'another' });

    expect(again).toEqual(RECORD);
    expect(await restarted.read('task-1')).toEqual(RECORD);
  });

  it('fails the read of a record with an unknown recordVersion with a typed error', async () => {
    const kv = textValueStore(new MemoryStorage());
    await kv.set(
      `${A2A_TASK_RECORD_KEY_PREFIX}task-1`,
      JSON.stringify({ ...RECORD, recordVersion: 2 }),
    );

    const error = await rejectionOf(createA2ATaskRecords(kv).read('task-1'));

    expect(error).toBeInstanceOf(A2ATaskRecordVersionError);
    expect((error as A2ATaskRecordVersionError).recordVersion).toBe(2);
  });

  it('applies concurrent updates one after another, losing neither', async () => {
    const records = createA2ATaskRecords(textValueStore(new MemoryStorage()));
    await records.create(RECORD);

    await Promise.all(
      ['m-2', 'm-3'].map((messageId) =>
        records.update('task-1', (current) => ({
          ...current,
          history: [...current.history, { messageId }],
        })),
      ),
    );

    const stored = await records.read('task-1');
    expect(stored?.history.map((entry) => entry['messageId']).toSorted()).toEqual([
      'm-1',
      'm-2',
      'm-3',
    ]);
  });

  it('writes nothing for an update to a task with no record, or one that changes nothing', async () => {
    const records = createA2ATaskRecords(textValueStore(new MemoryStorage()));
    expect(await records.update('missing', (current) => current)).toBeUndefined();
    await records.create(RECORD);
    expect(await records.update('task-1', () => undefined)).toEqual(RECORD);
    await records.remove('task-1');
    expect(await records.read('task-1')).toBeUndefined();
  });
});

describe('clearing a deleted context’s A2A history', () => {
  it('clears only the incarnation that was deleted, never one created under the same id', async () => {
    const records = createA2ATaskRecords(textValueStore(new MemoryStorage()));
    await records.create({ ...RECORD, taskId: 'old-task', incarnation: 'incarnation-1' });
    await records.create({ ...RECORD, taskId: 'new-task', incarnation: 'incarnation-2' });

    expect(await records.clearContext('context-1', 'incarnation-1')).toBe(1);

    const old = await records.read('old-task');
    const fresh = await records.read('new-task');
    expect(old?.history).toEqual([]);
    expect(fresh?.history).toEqual(RECORD.history);
    // The index entry of the incarnation that was not deleted is kept, so its own deletion
    // still finds the task.
    expect(await records.clearContext('context-1', 'incarnation-2')).toBe(1);
    const cleared = await records.read('new-task');
    expect(cleared?.history).toEqual([]);
  });
});

describe('sweeping the records of tasks that are gone', () => {
  it('deletes each record whose task no longer exists, and its context index entry', async () => {
    const kv = textValueStore(new MemoryStorage());
    const records = createA2ATaskRecords(kv);
    await records.create({ ...RECORD, taskId: 'kept' });
    await records.create({ ...RECORD, taskId: 'gone' });

    expect(await records.sweep(async (taskId) => taskId === 'kept')).toBe(1);

    expect(await records.read('gone')).toBeUndefined();
    expect(await records.read('kept')).toEqual({ ...RECORD, taskId: 'kept' });
    expect(await kv.list(A2A_CONTEXT_INDEX_KEY_PREFIX)).toHaveLength(1);
    expect(await records.clearContext('context-1', 'incarnation-1')).toBe(1);
  });
});
