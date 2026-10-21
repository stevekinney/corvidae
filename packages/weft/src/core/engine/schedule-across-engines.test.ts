/**
 * COR-1594: a schedule's writes hold across engines that share a store. Each case runs two engines
 * over one store, with engine A's (or B's) write to the schedule key parked between its read and
 * its write while the other engine commits. A write that is not conditioned on the bytes it read
 * lands on top of the other engine's change.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { BunSQLiteStorage } from '../../storage/bun-sql.ts';
import type { BatchOperation, Storage } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { encode } from '../codec.ts';
import type { Engine } from '../engine.ts';
import type { ScheduleState } from '../types.ts';
import { ScheduleStaleRevisionError } from './schedule-stale-revision-error.ts';
import {
  createEngine,
  drainEngine,
  registerWorkflow,
  START,
  tickEngine,
} from './schedule.test-support.ts';
import { createScheduleTimerId } from './state-utilities.ts';
import { decodeScheduleState } from './validation/schedule-decode.ts';

const SCHEDULE_ID = 'across-engines';

/** What a held write is: the first one that puts the schedule's own key. */
function putsScheduleKey(operations: readonly BatchOperation[]): boolean {
  return operations.some(
    (operation) => operation.type === 'put' && operation.key === KEYS.schedule(SCHEDULE_ID),
  );
}

type Hold = { readonly reached: Promise<void>; release(): void };

/**
 * One engine's handle on the shared store. `holdScheduleWrite()` parks the next write that puts
 * the schedule key until `release()`; `failRunStarts` makes a write that creates a scheduled run
 * throw, as a storage fault does.
 */
function engineStorage(shared: Storage) {
  let armed: { reached: () => void; open: Promise<void> } | undefined;
  let failRunStarts = false;
  const storage = new Proxy(shared, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (typeof member !== 'function' || typeof property !== 'string') return member;
      return (...args: unknown[]) => {
        const call = () => (member as (...a: unknown[]) => unknown).apply(target, args);
        if (property !== 'batch' && property !== 'conditionalBatch') return call();
        const operations = (property === 'batch' ? args[0] : args[1]) as BatchOperation[];
        if (
          failRunStarts &&
          operations.some(
            (operation) => operation.type === 'put' && operation.key.startsWith('schedule-run:'),
          )
        ) {
          return Promise.reject(new Error('simulated schedule start failure'));
        }
        if (armed !== undefined && putsScheduleKey(operations)) {
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
      const reached = Promise.withResolvers<void>();
      const open = Promise.withResolvers<void>();
      armed = { reached: reached.resolve, open: open.promise };
      return { reached: reached.promise, release: open.resolve };
    },
    failRunStarts(): void {
      failRunStarts = true;
    },
  };
}

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function openEngines() {
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
  await engineA.schedule('across-workflow', null, '* * * * *', { id: SCHEDULE_ID });
  return { clock, shared, a, b, engineA, engineB };
}

async function stateOf(shared: Storage): Promise<ScheduleState> {
  const bytes = await shared.get(KEYS.schedule(SCHEDULE_ID));
  const state = bytes === null ? null : decodeScheduleState(bytes);
  if (state === null) throw new Error('The schedule is missing.');
  return state;
}

type Transition = {
  readonly name: string;
  /** Changes the schedule before the race, so the transition has something to do. */
  readonly prepare?: (engine: Engine) => Promise<void>;
  readonly run: (engine: Engine, expectedRevision?: number) => Promise<void>;
};

const TRANSITIONS: readonly Transition[] = [
  {
    name: 'pause',
    run: (engine, expectedRevision) =>
      engine.pauseSchedule(SCHEDULE_ID, expectedRevision === undefined ? {} : { expectedRevision }),
  },
  {
    name: 'resume',
    prepare: (engine) => engine.pauseSchedule(SCHEDULE_ID),
    run: (engine, expectedRevision) =>
      engine.resumeSchedule(
        SCHEDULE_ID,
        expectedRevision === undefined ? {} : { expectedRevision },
      ),
  },
  {
    name: 'cancel',
    run: (engine, expectedRevision) =>
      engine.cancelSchedule(
        SCHEDULE_ID,
        expectedRevision === undefined ? {} : { expectedRevision },
      ),
  },
  {
    name: 'update',
    run: (engine, expectedRevision) =>
      engine.updateSchedule(SCHEDULE_ID, '*/5 * * * *', {
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
  },
];

describe('two engines naming the same expectedRevision', () => {
  for (const transition of TRANSITIONS) {
    it(`${transition.name}: exactly one wins and the other is stale`, async () => {
      const { shared, a, engineA, engineB } = await openEngines();
      await transition.prepare?.(engineA);
      const before = (await stateOf(shared)).revision;
      const hold = a.holdScheduleWrite();

      const loser = transition.run(engineA, before);
      const rejection = throwingRejectionOf(loser);
      await hold.reached;
      await transition.run(engineB, before);
      hold.release();
      const error = await rejection;

      expect(error).toBeInstanceOf(ScheduleStaleRevisionError);
      expect(error).toMatchObject({ expectedRevision: before, currentRevision: before + 1 });
      expect((await stateOf(shared)).revision).toBe(before + 1);
    });
  }
});

describe('a transition with no expectedRevision', () => {
  it('update: applies on top of the change that landed first, as the later of two', async () => {
    const { shared, a, engineA, engineB } = await openEngines();
    const hold = a.holdScheduleWrite();

    const first = engineA.updateSchedule(SCHEDULE_ID, '*/5 * * * *');
    await hold.reached;
    await engineB.updateSchedule(SCHEDULE_ID, '*/10 * * * *');
    hold.release();
    await first;

    const state = await stateOf(shared);
    expect(state.revision).toBe(3);
    expect(state.cronExpression).toBe('*/5 * * * *');
  });

  it('pause: finds the schedule paused after the retry and changes nothing', async () => {
    const { shared, a, engineA, engineB } = await openEngines();
    const hold = a.holdScheduleWrite();

    const first = engineA.pauseSchedule(SCHEDULE_ID);
    await hold.reached;
    await engineB.pauseSchedule(SCHEDULE_ID);
    hold.release();
    await first;

    const state = await stateOf(shared);
    expect(state.status).toBe('paused');
    expect(state.revision).toBe(2);
  });
});

/** Ticks engine B at the schedule's first occurrence; the tick resolves once its write is let go. */
async function tickB(clock: { now: number }, engineB: Engine, shared: Storage) {
  clock.now = (await stateOf(shared)).nextFireAt!;
  return engineB.scheduler.tick(clock.now);
}

describe('a timer tick on one engine while another changes the schedule', () => {
  it('does not write the schedule back to active after a pause', async () => {
    const { clock, shared, a, b, engineA, engineB } = await openEngines();
    const hold = b.holdScheduleWrite();

    const ticking = tickB(clock, engineB, shared);
    await hold.reached;
    await engineA.pauseSchedule(SCHEDULE_ID);
    hold.release();
    await ticking;
    await drainEngine();

    const state = await stateOf(shared);
    expect(state.status).toBe('paused');
    expect(state.revision).toBe(2);
    expect(await shared.get(`timer-idx:${createScheduleTimerId(SCHEDULE_ID)}`)).toBeNull();
  });

  it('commits its write when the schedule changed only in bytes, not in revision', async () => {
    const { clock, shared, b, engineB } = await openEngines();
    const hold = b.holdScheduleWrite();

    const ticking = tickB(clock, engineB, shared);
    await hold.reached;
    const current = await stateOf(shared);
    await shared.put(
      KEYS.schedule(SCHEDULE_ID),
      encode({ ...current, updatedAt: current.updatedAt + 5 }),
    );
    hold.release();
    await ticking;
    await drainEngine();

    const state = await stateOf(shared);
    expect(state.status).toBe('active');
    expect(state.lastFireAt).toBe(clock.now);
    expect(state.nextFireAt).toBeGreaterThan(clock.now);
  });

  it('does not pause over an update that landed while its failure was handled', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines();
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    try {
      b.failRunStarts();
      const hold = b.holdScheduleWrite();

      const ticking = tickB(clock, engineB, shared);
      await hold.reached;
      await engineA.updateSchedule(SCHEDULE_ID, '*/5 * * * *');
      hold.release();
      await ticking;
      await drainEngine();

      const state = await stateOf(shared);
      expect(state.status).toBe('active');
      expect(state.revision).toBe(2);
      expect(state.cronExpression).toBe('*/5 * * * *');
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('a run that ends on one engine while another changes the schedule', () => {
  it('clears the current run on top of a pause instead of undoing it', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines();
    await tickEngine(engineB, clock, (await stateOf(shared)).nextFireAt!);
    const runId = (await stateOf(shared)).currentWorkflowId;
    expect(runId).toBeDefined();
    const hold = b.holdScheduleWrite();

    const signalled = engineB.signal(runId!, 'release');
    await hold.reached;
    await engineA.pauseSchedule(SCHEDULE_ID);
    hold.release();
    await signalled;
    await drainEngine();
    await drainEngine();

    const state = await stateOf(shared);
    expect(state.status).toBe('paused');
    expect(state.currentWorkflowId).toBeUndefined();
    expect(state.revision).toBe(2);
  });
});
