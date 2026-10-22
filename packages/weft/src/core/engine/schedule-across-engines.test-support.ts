/**
 * Fixtures for the tests of a schedule's writes across engines that share a store (COR-1594): two
 * engines over one store, each behind a handle that can park one of its writes, and the reads and
 * ticks the tests make around them.
 */
import { BunSQLiteStorage } from '../../storage/bun-sql.ts';
import type { BatchOperation, Storage } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import type { Engine } from '../engine.ts';
import type { ScheduleState } from '../types.ts';
import { createEngine, registerWorkflow, START } from './schedule.test-support.ts';
import { decodeScheduleState } from './validation/schedule-decode.ts';

export const SCHEDULE_ID = 'across-engines';

/** Whether a write removes a timer, as a pause or a cancel of an active schedule does. */
function removesTimer(operations: readonly BatchOperation[]): boolean {
  return operations.some(
    (operation) => operation.type === 'delete' && operation.key.startsWith('timer-idx:'),
  );
}

/** What a held write is: the first one that puts the schedule's own key. */
function putsScheduleKey(operations: readonly BatchOperation[]): boolean {
  return operations.some(
    (operation) => operation.type === 'put' && operation.key === KEYS.schedule(SCHEDULE_ID),
  );
}

export type Hold = { readonly reached: Promise<void>; release(): void };

/**
 * One engine's handle on the shared store. `holdScheduleWrite()` parks the next write that puts
 * the schedule key until `release()`; `failRunStarts` makes a write that creates a scheduled run
 * throw, as a storage fault does. `capConditionalBatches` bounds a retry that would never end, so
 * a test of one fails instead of hanging.
 */
export function engineStorage(shared: Storage) {
  let armed:
    | {
        reached: () => void;
        open: Promise<void>;
        matches: (operations: readonly BatchOperation[]) => boolean;
      }
    | undefined;
  let failRunStarts = false;
  let conditionalBatchCap: number | undefined;
  let conditionalBatches = 0;
  const hold = (matches: (operations: readonly BatchOperation[]) => boolean): Hold => {
    const reached = Promise.withResolvers<void>();
    const open = Promise.withResolvers<void>();
    armed = { reached: reached.resolve, open: open.promise, matches };
    return { reached: reached.promise, release: open.resolve };
  };
  const storage = new Proxy(shared, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (typeof member !== 'function' || typeof property !== 'string') return member;
      return (...args: unknown[]) => {
        const call = () => (member as (...a: unknown[]) => unknown).apply(target, args);
        if (property !== 'batch' && property !== 'conditionalBatch') return call();
        if (property === 'conditionalBatch') {
          conditionalBatches += 1;
          if (conditionalBatchCap !== undefined && conditionalBatches > conditionalBatchCap) {
            return Promise.reject(new Error('conditional batch cap exceeded'));
          }
        }
        const operations = (property === 'batch' ? args[0] : args[1]) as BatchOperation[];
        if (
          failRunStarts &&
          operations.some(
            (operation) => operation.type === 'put' && operation.key.startsWith('schedule-run:'),
          )
        ) {
          return Promise.reject(new Error('simulated schedule start failure'));
        }
        if (armed?.matches(operations)) {
          const held = armed;
          armed = undefined;
          held.reached();
          return held.open.then(call);
        }
        return call();
      };
    },
  });
  return {
    storage,
    holdScheduleWrite(): Hold {
      return hold(putsScheduleKey);
    },
    holdTimerRemoval(): Hold {
      return hold(removesTimer);
    },
    failRunStarts(): void {
      failRunStarts = true;
    },
    /** Bounds a write that would otherwise retry without end: past `limit` batches it rejects. */
    capConditionalBatches(limit: number): void {
      conditionalBatchCap = limit;
    },
    get conditionalBatches(): number {
      return conditionalBatches;
    },
  };
}

const closers: Array<() => void> = [];

/** Disposes the engines the test opened; each test file passes it to `afterEach`. */
export function closeOpenedEngines(): void {
  for (const close of closers.splice(0)) close();
}

export async function openEngines(scheduleOptions: { backfill?: boolean } = {}) {
  const clock = { now: START };
  const shared = new BunSQLiteStorage(':memory:');
  const a = engineStorage(shared);
  const b = engineStorage(shared);
  const engineA = createEngine(clock, a.storage);
  const engineB = createEngine(clock, b.storage);
  closers.push(
    () => engineA[Symbol.dispose](),
    () => engineB[Symbol.dispose](),
  );
  for (const engine of [engineA, engineB]) {
    registerWorkflow(engine, 'across-workflow', async function* (ctx) {
      yield* ctx.waitForSignal('release');
      return 'done';
    });
  }
  await engineA.schedule('across-workflow', null, '* * * * *', {
    id: SCHEDULE_ID,
    ...scheduleOptions,
  });
  return { clock, shared, a, b, engineA, engineB };
}

export async function stateOf(shared: Storage): Promise<ScheduleState> {
  const bytes = await shared.get(KEYS.schedule(SCHEDULE_ID));
  const state = bytes === null ? null : decodeScheduleState(bytes);
  if (state === null) throw new Error('The schedule is missing.');
  return state;
}

/** Ticks engine B at the schedule's first occurrence; the tick resolves once its write is let go. */
export async function tickB(
  clock: { now: number },
  engineB: Engine,
  shared: Storage,
  lateByMilliseconds = 0,
) {
  const { nextFireAt } = await stateOf(shared);
  clock.now = nextFireAt! + lateByMilliseconds;
  return engineB.scheduler.tick(clock.now);
}
