/**
 * The push install protocol (COR-1669): the checkpoint is written ahead of its configuration, a
 * failed create is reconciled against the store before the checkpoint is released, and a
 * coalesced install keeps the earliest checkpoint.
 */
import type { TaskPushNotificationConfig } from '@a2a-js/sdk';
import type { ServerCallContext } from '@a2a-js/sdk/server';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import { A2APushConfigurationConflictError } from '@lostgradient/weft/a2a';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createA2APushCheckpoints } from './a2a-push-checkpoint.ts';
import { installPushConfiguration } from './a2a-push-install.ts';

const CALLER = { authenticated: true, userName: 'api-key:alice' };
const CONTEXT = {} as ServerCallContext;

function configuration(id = ''): TaskPushNotificationConfig {
  return { id, taskId: 'task-1', url: 'https://example.test/hook', token: '' } as never;
}

/** A store whose `create` and `get` the test scripts. */
function fakeStore(script: {
  create?: (input: TaskPushNotificationConfig) => Promise<TaskPushNotificationConfig>;
  check?: () => Promise<TaskPushNotificationConfig | undefined>;
}) {
  return {
    check: script.check ?? (async () => undefined),
    create: async (
      _taskId: string,
      _context: ServerCallContext,
      input: TaskPushNotificationConfig,
    ) => (script.create ?? (async (stored) => stored))(input),
  };
}

function setup(store: ReturnType<typeof fakeStore>) {
  const checkpoints = createA2APushCheckpoints(textValueStore(new MemoryStorage()));
  const watched: string[] = [];
  let next = 0;
  const install = (cursor: string, input = configuration()) =>
    installPushConfiguration(
      { store, checkpoints, watch: (id) => watched.push(id), newId: () => `id-${(next += 1)}` },
      { taskId: 'task-1', configuration: input, context: CONTEXT, caller: CALLER, cursor },
    );
  return { checkpoints, watched, install };
}

describe('the push install', () => {
  it('confirms the checkpoint and watches the task', async () => {
    const fixture = setup(fakeStore({}));
    const stored = await fixture.install('4');

    const checkpoint = await fixture.checkpoints.read('task-1', stored.id);
    expect(checkpoint?.cursor).toBe('4');
    expect(checkpoint?.pending).toBeUndefined();
    expect(fixture.watched).toEqual(['task-1']);
  });

  it('keeps a configuration whose create failed after it committed', async () => {
    const committed = configuration('id-1');
    const fixture = setup(
      fakeStore({
        create: async () => {
          throw new Error('the reply was lost');
        },
        check: async () => committed,
      }),
    );

    const stored = await fixture.install('4');

    expect(stored).toBe(committed);
    const checkpoint = await fixture.checkpoints.read('task-1', 'id-1');
    expect(checkpoint?.cursor).toBe('4');
    expect(checkpoint?.pending).toBeUndefined();
  });

  it('releases the checkpoint of a create that definitely wrote nothing', async () => {
    const fixture = setup(
      fakeStore({
        create: async () => {
          throw new Error('refused');
        },
      }),
    );

    expect(((await rejectionOf(fixture.install('4'))) as Error).message).toBe('refused');
    expect(await fixture.checkpoints.read('task-1', 'id-1')).toBeUndefined();
  });

  it('leaves the pending checkpoint for a restart when the read-back fails too', async () => {
    const fixture = setup(
      fakeStore({
        create: async () => {
          throw new Error('the reply was lost');
        },
        check: async () => {
          throw new Error('the store is down');
        },
      }),
    );

    expect(((await rejectionOf(fixture.install('4', configuration('cfg')))) as Error).message).toBe(
      'the reply was lost',
    );
    const checkpoint = await fixture.checkpoints.read('task-1', 'cfg');
    expect(checkpoint?.pending).toBe(true);
  });

  it('keeps the earliest checkpoint when a concurrent create of the same webhook won', async () => {
    const fixture = setup(
      fakeStore({
        create: async (input) => ({ ...input, id: 'winner' }),
      }),
    );
    // The winner's install checkpointed the configuration at an earlier cursor.
    await fixture.checkpoints.create({
      recordVersion: 1,
      taskId: 'task-1',
      configId: 'winner',
      cursor: '2',
      caller: CALLER,
      pending: true,
      installId: 'other',
    });

    const stored = await fixture.install('5');

    expect(stored.id).toBe('winner');
    const kept = await fixture.checkpoints.read('task-1', 'winner');
    expect(kept?.cursor).toBe('2');
    // The loser's own pending checkpoint is gone.
    expect(await fixture.checkpoints.read('task-1', 'id-1')).toBeUndefined();
  });

  it('releases its own checkpoint, and not the other install’s, when the id conflicts', async () => {
    const conflict = new A2APushConfigurationConflictError('task-1', 'same', 'different');
    const fixture = setup(
      fakeStore({
        create: async () => {
          throw conflict;
        },
        check: async () => {
          throw conflict;
        },
      }),
    );
    await fixture.checkpoints.create({
      recordVersion: 1,
      taskId: 'task-1',
      configId: 'same',
      cursor: '1',
      caller: CALLER,
      installId: 'winner',
    });

    expect(await rejectionOf(fixture.install('5', configuration('same')))).toBe(conflict);

    const survivor = await fixture.checkpoints.read('task-1', 'same');
    expect(survivor?.installId).toBe('winner');
  });

  it('replaces a failed install’s leftover for another webhook instead of confirming it', async () => {
    const fixture = setup(fakeStore({}));
    // A failed install of one webhook left its pending checkpoint, at a cursor from long ago.
    await fixture.install('1', configuration('cfg')).catch(() => undefined);
    await fixture.checkpoints.remove('task-1', 'cfg');
    await fixture.checkpoints.claim({
      recordVersion: 1,
      taskId: 'task-1',
      configId: 'cfg',
      cursor: '1',
      caller: CALLER,
      pending: true,
      installId: 'old',
      fingerprint: 'another-webhook',
    });

    await fixture.install('9', { ...configuration('cfg'), url: 'https://new.test/hook' });

    const checkpoint = await fixture.checkpoints.read('task-1', 'cfg');
    expect(checkpoint?.cursor).toBe('9');
    expect(checkpoint?.pending).toBeUndefined();
    expect(checkpoint?.installId).not.toBe('old');
  });

  it('ends with a confirmed checkpoint when another instance’s delete removed the pending one', async () => {
    let remove: () => Promise<void> = async () => undefined;
    const fixture = setup(
      fakeStore({
        create: async (input) => {
          // Instance B deletes the id between A's pending write and A's commit.
          await remove();
          return input;
        },
      }),
    );
    remove = () => fixture.checkpoints.remove('task-1', 'cfg');

    await fixture.install('6', configuration('cfg'));

    const checkpoint = await fixture.checkpoints.read('task-1', 'cfg');
    expect(checkpoint?.cursor).toBe('6');
    expect(checkpoint?.pending).toBeUndefined();
  });

  it('keys the stored fingerprint with a per-store secret, not a bare digest of the webhook', async () => {
    const input = { ...configuration('cfg'), token: 'hunter2' };
    const bytes = new TextEncoder().encode(JSON.stringify([input.url, input.token, null]));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const plain = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const first = setup(fakeStore({}));
    const second = setup(fakeStore({}));
    await first.install('1', input);
    await second.install('1', input);

    const oneCheckpoint = await first.checkpoints.read('task-1', 'cfg');
    const twoCheckpoint = await second.checkpoints.read('task-1', 'cfg');
    const one = oneCheckpoint?.fingerprint;
    const two = twoCheckpoint?.fingerprint;
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(one).not.toBe(plain);
    expect(one).not.toBe(two);
  });

  it('computes the same fingerprint across restarts of one store', async () => {
    const storage = new MemoryStorage();
    const before = await createA2APushCheckpoints(textValueStore(storage)).fingerprint(
      configuration(),
    );
    const after = await createA2APushCheckpoints(textValueStore(storage)).fingerprint(
      configuration(),
    );
    expect(after).toBe(before);
  });
});
