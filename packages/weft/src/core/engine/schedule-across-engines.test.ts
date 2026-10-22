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
import { rejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { encode } from '../codec.ts';
import type { Engine } from '../engine.ts';
import type { ScheduleState } from '../types.ts';
import { getInternals } from './internals.ts';
import { ScheduleStaleRevisionError } from './schedule-stale-revision-error.ts';
import {
  createEngine,
  drainEngine,
  registerWorkflow,
  START,
  tickEngine,
} from './schedule.test-support.ts';
import { recoverOrphanedScheduleTimers } from './schedules.ts';
import { createScheduleTimerId } from './state-utilities.ts';
import { decodeScheduleState } from './validation/schedule-decode.ts';

const SCHEDULE_ID = 'across-engines';

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

type Hold = { readonly reached: Promise<void>; release(): void };

/**
 * One engine's handle on the shared store. `holdScheduleWrite()` parks the next write that puts
 * the schedule key until `release()`; `failRunStarts` makes a write that creates a scheduled run
 * throw, as a storage fault does.
 */
function engineStorage(shared: Storage) {
  let armed:
    | {
        reached: () => void;
        open: Promise<void>;
        matches: (operations: readonly BatchOperation[]) => boolean;
      }
    | undefined;
  let failRunStarts = false;
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
      engine.updateSchedule(
        SCHEDULE_ID,
        '*/5 * * * *',
        expectedRevision === undefined ? {} : { expectedRevision },
      ),
  },
];

describe('two engines naming the same expectedRevision', () => {
  for (const transition of TRANSITIONS) {
    it(`${transition.name}: exactly one wins and the other is stale`, async () => {
      const { shared, a, engineA, engineB } = await openEngines();
      await transition.prepare?.(engineA);
      const { revision: before } = await stateOf(shared);
      const hold = a.holdScheduleWrite();

      const loser = transition.run(engineA, before);
      const rejection = rejectionOf(loser);
      await hold.reached;
      await transition.run(engineB, before);
      hold.release();
      const error = await rejection;

      expect(error).toBeInstanceOf(ScheduleStaleRevisionError);
      expect(error).toMatchObject({ expectedRevision: before, currentRevision: before + 1 });
      const { revision: after } = await stateOf(shared);
      expect(after).toBe(before + 1);
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

describe('a transition that read a schedule another engine has since changed', () => {
  for (const name of ['pause', 'cancel'] as const) {
    it(`${name}: removes no timer the other engine armed`, async () => {
      const { shared, a, engineA, engineB } = await openEngines();
      const hold = a.holdTimerRemoval();

      const stale = rejectionOf(
        name === 'pause'
          ? engineA.pauseSchedule(SCHEDULE_ID, { expectedRevision: 1 })
          : engineA.cancelSchedule(SCHEDULE_ID, { expectedRevision: 1 }),
      );
      await hold.reached;
      await engineB.updateSchedule(SCHEDULE_ID, '*/5 * * * *');
      hold.release();

      expect(await stale).toBeInstanceOf(ScheduleStaleRevisionError);
      const state = await stateOf(shared);
      expect(state.status).toBe('active');
      expect(await shared.get(`timer-idx:${createScheduleTimerId(SCHEDULE_ID)}`)).not.toBeNull();
    });
  }
});

/** Ticks engine B at the schedule's first occurrence; the tick resolves once its write is let go. */
async function tickB(clock: { now: number }, engineB: Engine, shared: Storage) {
  const { nextFireAt } = await stateOf(shared);
  clock.now = nextFireAt!;
  return engineB.scheduler.tick(clock.now);
}

describe('a timer tick on one engine while another changes the schedule', () => {
  it('does not write the schedule back to active after a pause', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines();
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

  it('still pauses a schedule that changed only in bytes while its failure was handled', async () => {
    const { clock, shared, b, engineB } = await openEngines();
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    try {
      b.failRunStarts();
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
      expect(state.status).toBe('paused');
      expect(state.revision).toBe(2);
    } finally {
      consoleError.mockRestore();
    }
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

describe('a timer recovered on one engine while another changes the schedule', () => {
  it('does not write a schedule that was paused after the scan back to active', async () => {
    const { shared, b, engineA, engineB } = await openEngines();
    // The timer is lost, as a crash between a schedule write and its timer leaves it.
    const { nextFireAt } = await stateOf(shared);
    await shared.batch([
      { type: 'delete', key: `timer-idx:${createScheduleTimerId(SCHEDULE_ID)}` },
      { type: 'delete', key: KEYS.scheduleTick(nextFireAt!, SCHEDULE_ID) },
    ]);
    const hold = b.holdScheduleWrite();

    const recovering = recoverOrphanedScheduleTimers(getInternals(engineB));
    await hold.reached;
    await engineA.pauseSchedule(SCHEDULE_ID);
    hold.release();
    await recovering;

    expect((await stateOf(shared)).status).toBe('paused');
    expect(await shared.get(`timer-idx:${createScheduleTimerId(SCHEDULE_ID)}`)).toBeNull();
  });
});

describe('a run that ends on one engine while another changes the schedule', () => {
  it('clears the current run on top of a pause instead of undoing it', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines();
    const { nextFireAt } = await stateOf(shared);
    await tickEngine(engineB, clock, nextFireAt!);
    const { currentWorkflowId: runId } = await stateOf(shared);
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
