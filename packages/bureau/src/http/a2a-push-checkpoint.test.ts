import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import {
  A2A_PUSH_CHECKPOINT_KEY_PREFIX,
  type A2APushCheckpoint,
  A2APushCheckpointVersionError,
  createA2APushCheckpoints,
} from './a2a-push-checkpoint.ts';

const CHECKPOINT: A2APushCheckpoint = {
  recordVersion: 1,
  taskId: 'task-1',
  configId: 'config-1',
  cursor: '3',
  caller: { authenticated: true, userName: 'api-key:alice' },
};

async function advancedTo(
  checkpoints: ReturnType<typeof createA2APushCheckpoints>,
  cursor: string,
): Promise<string | undefined> {
  const stored = await checkpoints.advance('task-1', 'config-1', cursor);
  return stored?.cursor;
}

describe('the push checkpoint', () => {
  it('removes a pending checkpoint only for the install that wrote it', async () => {
    const checkpoints = createA2APushCheckpoints(textValueStore(new MemoryStorage()));
    await checkpoints.create({ ...CHECKPOINT, pending: true, installId: 'winner' });

    // A losing install, or a stale recovery, holds another generation.
    await checkpoints.removePending('task-1', 'config-1', 'loser');
    expect(await checkpoints.read('task-1', 'config-1')).toBeDefined();

    await checkpoints.confirm('task-1', 'config-1');
    await checkpoints.removePending('task-1', 'config-1', 'winner');
    const confirmed = await checkpoints.read('task-1', 'config-1');
    expect(confirmed?.pending).toBeUndefined();

    const fresh = createA2APushCheckpoints(textValueStore(new MemoryStorage()));
    await fresh.create({ ...CHECKPOINT, pending: true, installId: 'winner' });
    await fresh.removePending('task-1', 'config-1', 'winner');
    expect(await fresh.read('task-1', 'config-1')).toBeUndefined();
  });

  it('keeps the first checkpoint of a configuration and survives a restart', async () => {
    const kv = textValueStore(new MemoryStorage());
    await createA2APushCheckpoints(kv).create(CHECKPOINT);

    const restarted = createA2APushCheckpoints(kv);
    const again = await restarted.create({ ...CHECKPOINT, cursor: '9' });

    expect(again).toEqual(CHECKPOINT);
    expect(await restarted.read('task-1', 'config-1')).toEqual(CHECKPOINT);
  });

  it('advances forward only', async () => {
    const checkpoints = createA2APushCheckpoints(textValueStore(new MemoryStorage()));
    await checkpoints.create(CHECKPOINT);

    expect(await advancedTo(checkpoints, '7')).toBe('7');
    expect(await advancedTo(checkpoints, '5')).toBe('7');
    expect(await checkpoints.advance('task-1', 'missing', '9')).toBeUndefined();
  });

  it('lists the checkpoints of a task and the tasks that have one, and removes one', async () => {
    const checkpoints = createA2APushCheckpoints(textValueStore(new MemoryStorage()));
    await checkpoints.create(CHECKPOINT);
    await checkpoints.create({ ...CHECKPOINT, configId: 'config/2' });
    await checkpoints.create({ ...CHECKPOINT, taskId: 'task:2' });

    const listed = await checkpoints.listForTask('task-1');
    expect(listed.map((entry) => entry.configId).toSorted()).toEqual(['config-1', 'config/2']);
    const taskIds = await checkpoints.listTaskIds();
    expect(taskIds.toSorted()).toEqual(['task-1', 'task:2']);

    await checkpoints.remove('task-1', 'config-1');
    expect(await checkpoints.read('task-1', 'config-1')).toBeUndefined();
  });

  it('fails the read of a checkpoint with an unknown recordVersion with a typed error', async () => {
    const kv = textValueStore(new MemoryStorage());
    await kv.set(
      `${A2A_PUSH_CHECKPOINT_KEY_PREFIX}task-1:config-1`,
      JSON.stringify({ ...CHECKPOINT, recordVersion: 2 }),
    );

    const error = await rejectionOf(createA2APushCheckpoints(kv).read('task-1', 'config-1'));

    expect(error).toBeInstanceOf(A2APushCheckpointVersionError);
    expect((error as A2APushCheckpointVersionError).recordVersion).toBe(2);
  });
});
