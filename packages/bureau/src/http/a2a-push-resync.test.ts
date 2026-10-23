/**
 * Push after a lost `run.completed` append (COR-1669, part 2b-3b): the Bureau repairs the history
 * with a `task.resynced`, and the push pump delivers that repair as the task's final status, so a
 * webhook still receives exactly one COMPLETED.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type { GenerateFunction } from '@lostgradient/operative';
import { resolveStorage, type Storage } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { createSqliteStorageFixture } from '../test/storage-fixtures';
import {
  call,
  eventually,
  message,
  openPushBureau,
  type PushFixture,
  webhook,
} from './a2a-push.test-support.ts';

type StoredOperation = { readonly key: string; readonly value?: Uint8Array | undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A SQLite store that fails the next `faults.failCompletions` appends of a `run.completed`. */
async function faultyStorage(): Promise<{
  readonly storage: Storage;
  readonly faults: { failCompletions: number };
}> {
  const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
  const base = await resolveStorage(fixture.configuration);
  const faults = { failCompletions: 0 };
  const isCompletion = (operation: StoredOperation): boolean =>
    operation.key.startsWith('fleet-event:') &&
    operation.value !== undefined &&
    new TextDecoder().decode(operation.value).includes('run.completed');
  const storage = new Proxy(base, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === 'conditionalBatch') {
        return async (
          conditions: unknown,
          operations: readonly StoredOperation[],
          ...rest: unknown[]
        ) => {
          if (faults.failCompletions > 0 && operations.some(isCompletion)) {
            faults.failCompletions -= 1;
            throw new Error('injected: the history append failed');
          }
          return (value as (...parameters: unknown[]) => unknown).call(
            target,
            conditions,
            operations,
            ...rest,
          );
        };
      }
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as Storage;
  cleanups.push(async () => {
    await (base as unknown as { dispose?: () => Promise<void> | void }).dispose?.();
    await fixture.dispose();
  });
  return { storage, faults };
}

const answering: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });

describe('push across a lost run.completed append', () => {
  it('delivers the repair as the final status: exactly one COMPLETED', async () => {
    const { storage, faults } = await faultyStorage();
    faults.failCompletions = 1;
    const fixture: PushFixture = await openPushBureau(answering, { bureauStorage: storage });
    cleanups.push(() => fixture.dispose());
    fixture.startDelivery();

    const sent = await call(fixture, 'SendMessage', {
      message: message('go'),
      configuration: { returnImmediately: true, taskPushNotificationConfig: webhook(fixture) },
    });
    expect(sent.error).toBeUndefined();

    await eventually(() => fixture.receiver.kinds().includes('status:TASK_STATE_COMPLETED'));
    // Give a second, wrongly duplicated delivery time to arrive.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      fixture.receiver.kinds().filter((kind) => kind === 'status:TASK_STATE_COMPLETED'),
    ).toHaveLength(1);
    expect(faults.failCompletions).toBe(0);
  });
});
