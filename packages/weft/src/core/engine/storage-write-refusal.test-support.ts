/**
 * A storage that refuses chosen engine writes, for the tests of the in-process retry of a refused
 * checkpoint or terminal write (COR-1626). It wraps a real {@link MemoryStorage}, starts disarmed
 * so a run can start and reach a known point first, and records every write attempt it sees once
 * armed, so a test asserts attempt counts from the storage's side and not from the engine's.
 */
import { KEYS, type BatchOperation, type Storage } from '../../storage/interface.ts';
import type { MemoryStorage } from '../../storage/memory.ts';
import { decode } from '../codec/api.ts';
import type { WorkflowState } from '../types.ts';

const WRITE_METHODS = new Set(['put', 'delete', 'batch', 'conditionalBatch']);

/** How a matching write is handled: refused outright, or applied and then reported as failed. */
export type WriteRefusalMode = 'refuse' | 'land-then-throw';

export type WriteRefusal = {
  /** Which writes the rule applies to, judged on the write's operations. */
  readonly matches: (operations: readonly BatchOperation[]) => boolean;
  readonly mode?: WriteRefusalMode;
  /** How many matching writes the rule handles before it lets them through. Default: all. */
  readonly times?: number;
};

export type WriteAttempt = {
  readonly method: string;
  readonly operations: readonly BatchOperation[];
  /** What the storage did with the attempt. */
  readonly outcome: 'refused' | 'land-then-throw' | 'passed';
};

export type RefusingStorage = {
  readonly storage: Storage;
  /** The real store underneath, which a recovering engine reads with the refusals lifted. */
  readonly base: MemoryStorage;
  /** Start applying the rules and recording attempts. */
  arm(): void;
  /** Add a rule; the first rule that matches a write and still has uses left handles it. */
  refuse(rule: WriteRefusal): void;
  /** Stop refusing, as a recovering engine over the same storage would find it. */
  disarm(): void;
  /** Every write attempt seen while armed, in order. */
  readonly attempts: readonly WriteAttempt[];
  /** Resolves once at least `count` write attempts matching `matches` have been seen while armed. */
  whenAttempts(
    count: number,
    matches: (operations: readonly BatchOperation[]) => boolean,
  ): Promise<void>;
  /** The attempts whose operations satisfy `matches`. */
  attemptsMatching(matches: (operations: readonly BatchOperation[]) => boolean): WriteAttempt[];
};

function operationsOf(method: string, args: readonly unknown[]): BatchOperation[] {
  if (method === 'put')
    return [{ type: 'put', key: String(args[0]), value: args[1] as Uint8Array }];
  if (method === 'delete') return [{ type: 'delete', key: String(args[0]) }];
  if (method === 'batch') return args[0] as BatchOperation[];
  return args[1] as BatchOperation[];
}

/** A put of `key`, whatever it writes. */
export function putsKey(key: string): (operations: readonly BatchOperation[]) => boolean {
  return (operations) =>
    operations.some((operation) => operation.type === 'put' && operation.key === key);
}

/** A write that puts the checkpoint record of `workflowId`: the checkpoint batch. */
export function putsCheckpoint(
  workflowId: string,
): (operations: readonly BatchOperation[]) => boolean {
  return putsKey(KEYS.checkpoint(workflowId));
}

/** A write that touches any event-log record of `workflowId`. */
export function touchesEventLog(
  workflowId: string,
): (operations: readonly BatchOperation[]) => boolean {
  const prefix = KEYS.eventPrefix(workflowId);
  return (operations) => operations.some((operation) => operation.key.startsWith(prefix));
}

/** A write that puts the workflow record of `workflowId` holding the given status. */
export function putsWorkflowStatus(
  workflowId: string,
  status: WorkflowState['status'] | 'any',
): (operations: readonly BatchOperation[]) => boolean {
  return (operations) =>
    operations.some(
      (operation) =>
        operation.type === 'put' &&
        operation.key === KEYS.workflow(workflowId) &&
        (status === 'any' || (decode(operation.value) as WorkflowState).status === status),
    );
}

/** The error a refused write throws. */
export const REFUSED_WRITE_MESSAGE = 'This storage write is refused.';

export function createRefusingStorage(base: MemoryStorage): RefusingStorage {
  const rules: Array<WriteRefusal & { remaining: number }> = [];
  const attempts: WriteAttempt[] = [];
  const attemptWaiters: Array<{ settled: () => boolean; resolve: () => void }> = [];
  let armed = false;

  const record = (attempt: WriteAttempt): void => {
    attempts.push(attempt);
    for (const waiter of attemptWaiters) {
      if (waiter.settled()) waiter.resolve();
    }
  };

  const storage = new Proxy(base, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== 'function') return member;
      const method = String(property);
      const call = (...args: unknown[]): unknown =>
        (member as (...rest: unknown[]) => unknown).apply(target, args);
      if (!WRITE_METHODS.has(method)) return call.bind(null);
      return async (...args: unknown[]) => {
        if (!armed) return call(...args);
        const operations = operationsOf(method, args);
        const rule = rules.find(
          (candidate) => candidate.remaining > 0 && candidate.matches(operations),
        );
        if (rule === undefined) {
          record({ method, operations, outcome: 'passed' });
          return call(...args);
        }
        rule.remaining -= 1;
        if (rule.mode === 'land-then-throw') {
          record({ method, operations, outcome: 'land-then-throw' });
          await call(...args);
        } else {
          record({ method, operations, outcome: 'refused' });
        }
        throw new Error(REFUSED_WRITE_MESSAGE);
      };
    },
  }) as unknown as Storage;

  return {
    storage,
    base,
    arm: () => {
      armed = true;
    },
    disarm: () => {
      armed = false;
    },
    refuse: (rule) => {
      rules.push({ ...rule, remaining: rule.times ?? Number.POSITIVE_INFINITY });
    },
    attempts,
    whenAttempts: (count, matches) => {
      const settled = (): boolean =>
        attempts.filter((attempt) => matches(attempt.operations)).length >= count;
      return settled()
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            attemptWaiters.push({ settled, resolve });
          });
    },
    attemptsMatching: (matches) => attempts.filter((attempt) => matches(attempt.operations)),
  };
}
