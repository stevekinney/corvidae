/**
 * A SQLite store that fails the next `faults.failCompletions` appends of a `run.completed`
 * (COR-1669), shared by the push and the A2A stream repair tests.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { type Storage } from '@lostgradient/storage';

import { createSqliteStorageFixture } from '../test/storage-fixtures';

type StoredOperation = { readonly key: string; readonly value?: Uint8Array | undefined };

/**
 * A SQLite store that fails the next `faults.failCompletions` appends of a `run.completed`, and the
 * next `faults.failResyncs` appends of a `task.resynced` (the repair of a lost append).
 */
export async function faultyStorage(cleanups: Array<() => Promise<void> | void>): Promise<{
  readonly storage: Storage;
  readonly faults: { failCompletions: number; failResyncs: number };
}> {
  const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
  const base = fixture.open();
  const faults = { failCompletions: 0, failResyncs: 0 };
  const isCompletion = (operation: StoredOperation): boolean =>
    operation.key.startsWith('fleet-event:') &&
    operation.value !== undefined &&
    new TextDecoder().decode(operation.value).includes('run.completed');
  const isResync = (operation: StoredOperation): boolean =>
    operation.key.startsWith('fleet-event:') &&
    operation.value !== undefined &&
    new TextDecoder().decode(operation.value).includes('task.resynced');
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
          if (faults.failResyncs > 0 && operations.some(isResync)) {
            faults.failResyncs -= 1;
            throw new Error('injected: the repair append failed');
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
  });
  cleanups.push(async () => {
    await (base as unknown as { dispose?: () => Promise<void> | void }).dispose?.();
    await fixture.dispose();
  });
  return { storage, faults };
}
