import {
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../interface.ts';

/** The synchronous reads and writes a SQLite adapter runs a conditional batch with, inside its transaction. */
export interface ConditionalBatchBodyHandlers {
  read(key: string): Uint8Array | null;
  put(key: string, value: Uint8Array): void;
  delete(key: string): void;
  now?(): number;
}

export class ConditionalBatchDeadlineExpired extends Error {}

/**
 * Check every condition through `handlers.read`, then apply the operations, returning whether the
 * batch committed. Runs inside the caller's transaction.
 */
export function runConditionalBatchBody(
  conditions: ConditionalBatchCondition[],
  operations: BatchOperation[],
  handlers: ConditionalBatchBodyHandlers,
  deadline?: number,
): boolean {
  for (const condition of conditions) {
    if (!storageValuesEqual(handlers.read(condition.key), condition.expectedValue)) {
      return false;
    }
  }

  if (deadline !== undefined && handlers.now!() >= deadline) return false;
  for (const operation of operations) {
    if (operation.type === 'put') {
      handlers.put(operation.key, operation.value);
    } else {
      handlers.delete(operation.key);
    }
  }

  if (deadline !== undefined && handlers.now!() >= deadline)
    throw new ConditionalBatchDeadlineExpired();

  return true;
}
