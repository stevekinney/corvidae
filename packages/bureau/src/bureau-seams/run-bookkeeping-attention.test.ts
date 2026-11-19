/**
 * COR-2526 — how the Bureau watches the liveness of a run it holds: it writes the task record when
 * Operative's assessment of the run begins or leaves `alive-but-stalled`, and writes the first
 * snapshot too, so a run recovered from a dead holder clears the stall that holder left on the
 * record. The registry and the run are doubles: the test is about what is written, and when.
 */
import { describe, expect, it } from 'bun:test';

import type { BureauDiagnostic } from '../bureau-types/options.ts';
import { RunLoopingEvent, RunStalledEvent } from '../events.ts';
import { createRunBookkeeping } from './run-bookkeeping.ts';

type Observer = (snapshot: { readonly assessment: string }) => void;

/** A run whose snapshots the test sends, and which counts its subscribers. */
function fakeRun(initial: string) {
  let observer: Observer | undefined;
  let subscribers = 0;
  return {
    subscribers: () => subscribers,
    send: (assessment: string) => observer?.({ assessment }),
    activeRun: {
      subscribeSnapshot(next: Observer) {
        observer = next;
        subscribers += 1;
        next({ assessment: initial });
        return {
          unsubscribe() {
            if (observer === next) observer = undefined;
            subscribers -= 1;
          },
        };
      },
    },
  };
}

/** The writes the latest {@link bookkeeping} double was asked for. */
let pendingWrites: Promise<unknown>[] = [];

function bookkeeping(
  runs: Map<string, ReturnType<typeof fakeRun>['activeRun']>,
  outcomes: {
    stall: boolean[];
    looping: boolean[];
    reject?: boolean;
    /** How many of the first stall writes reject. */
    rejectFirst?: number;
  } = {
    stall: [],
    looping: [],
  },
) {
  const stalls: Array<[string, string | null]> = [];
  const loops: Array<[string, string]> = [];
  const dispatched: unknown[] = [];
  const diagnostics: BureauDiagnostic[] = [];
  let tick = 0;
  pendingWrites = [];
  const core = {
    store: { getRun: (runId: string) => ({ activeRun: runs.get(runId) }) },
    tasks: {
      recordStall: (runId: string, at: string | null) => {
        stalls.push([runId, at]);
        const write =
          outcomes.reject === true || stalls.length <= (outcomes.rejectFirst ?? 0)
            ? Promise.reject(new Error('The write failed.'))
            : Promise.resolve(outcomes.stall.shift() ?? true);
        pendingWrites.push(write);
        return write;
      },
      recordLooping: (runId: string, at: string) => {
        loops.push([runId, at]);
        const write = Promise.resolve(outcomes.looping.shift() ?? true);
        pendingWrites.push(write);
        return write;
      },
    },
    emitter: { dispatch: (event: unknown) => dispatched.push(event) },
    runtimeServices: {
      clock: { nowISO: () => `2026-11-19T12:00:0${(tick += 1)}.000Z` },
    },
    diagnose: (diagnostic: BureauDiagnostic) => diagnostics.push(diagnostic),
  };
  const seam = createRunBookkeeping(core as never, { stopLazyExpirySweepWhenNoneHeld: () => {} });
  return { seam, stalls, loops, dispatched, diagnostics };
}

/**
 * Waits for the writes the seam started to settle, and for what the seam does with each answer: the
 * seam's own reactions on a write's promise were attached before this one, so they have run when
 * this resumes, and the two hops cover the diagnosis of a rejection.
 */
async function settle(): Promise<void> {
  await Promise.allSettled(pendingWrites);
  await Promise.resolve();
  await Promise.resolve();
}

describe('watching a run’s liveness (COR-2526)', () => {
  it('writes the first snapshot, so a recovered run clears a stall its dead holder left', async () => {
    const run = fakeRun('healthy');
    const { seam, stalls, dispatched } = bookkeeping(new Map([['run-1', run.activeRun]]));

    seam.watchRunAttention('run-1');
    await settle();

    expect(stalls).toEqual([['run-1', null]]);
    expect(dispatched).toEqual([]);
  });

  it('writes a change of the assessment and nothing for a snapshot that repeats one', async () => {
    const run = fakeRun('healthy');
    const { seam, stalls, dispatched } = bookkeeping(new Map([['run-1', run.activeRun]]));
    seam.watchRunAttention('run-1');

    run.send('healthy');
    run.send('alive-but-stalled');
    run.send('alive-but-stalled');
    run.send('alive-but-stalled');
    run.send('legitimately-waiting');
    run.send('alive-but-stalled');
    run.send('terminal');
    await settle();

    expect(stalls.map(([, at]) => at === null)).toEqual([true, false, true, false, true]);
    // Each stall that began is announced once, with the instant it was recorded at.
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]).toBeInstanceOf(RunStalledEvent);
    expect(dispatched[0]).toMatchObject({ runId: 'run-1', since: stalls[1]![1] });
    expect(dispatched[1]).toMatchObject({ runId: 'run-1', since: stalls[3]![1] });
  });

  it('announces nothing for a stall the record already held, or one the settlement beat', async () => {
    const run = fakeRun('healthy');
    const { seam, dispatched } = bookkeeping(new Map([['run-1', run.activeRun]]), {
      stall: [false, false],
      looping: [],
    });
    seam.watchRunAttention('run-1');
    run.send('alive-but-stalled');
    await settle();
    expect(dispatched).toEqual([]);
  });

  it('watches a run once, and watches afresh a run id the store now holds another run under', async () => {
    const first = fakeRun('healthy');
    const second = fakeRun('alive-but-stalled');
    const runs = new Map([['run-1', first.activeRun]]);
    const { seam, stalls } = bookkeeping(runs);

    seam.watchRunAttention('run-1');
    seam.watchRunAttention('run-1');
    expect(first.subscribers()).toBe(1);

    runs.set('run-1', second.activeRun);
    seam.watchRunAttention('run-1');
    await settle();
    expect(first.subscribers()).toBe(0);
    expect(second.subscribers()).toBe(1);
    expect(stalls.map(([, at]) => at === null)).toEqual([true, false]);

    seam.unwatchRunAttention('run-1');
    expect(second.subscribers()).toBe(0);
  });

  it('diagnoses a write that fails, and goes on', async () => {
    const run = fakeRun('healthy');
    const { seam, diagnostics, stalls } = bookkeeping(new Map([['run-1', run.activeRun]]), {
      stall: [],
      looping: [],
      reject: true,
    });
    // The write rejects: the failure is diagnosed, never thrown into the run's own snapshots.
    expect(() => seam.watchRunAttention('run-1')).not.toThrow();
    expect(() => run.send('alive-but-stalled')).not.toThrow();
    await settle();
    expect(stalls).toHaveLength(2);
    expect(diagnostics.map((diagnostic) => diagnostic.scope)).toEqual([
      'task-registry',
      'task-registry',
    ]);
  });
});

describe('a write that did not land (COR-2526)', () => {
  it('asks again on the next snapshot after a write rejects, since nothing recorded the value', async () => {
    const run = fakeRun('healthy');
    const { seam, stalls, diagnostics } = bookkeeping(new Map([['run-1', run.activeRun]]), {
      stall: [],
      looping: [],
      rejectFirst: 1,
    });
    seam.watchRunAttention('run-1');
    await settle();
    expect(stalls).toHaveLength(1);
    expect(diagnostics).toHaveLength(1);

    // The same assessment arrives again: the first write never committed, so it is written now.
    run.send('healthy');
    await settle();
    expect(stalls.map(([, at]) => at)).toEqual([null, null]);
    expect(diagnostics).toHaveLength(1);

    // And once it has committed, a repeat writes nothing.
    run.send('healthy');
    await settle();
    expect(stalls).toHaveLength(2);
  });

  it('does not retry an answer of false, which the record, the settlement or a successor decided', async () => {
    const run = fakeRun('healthy');
    const { seam, stalls, dispatched } = bookkeeping(new Map([['run-1', run.activeRun]]), {
      stall: [true, false],
      looping: [],
    });
    seam.watchRunAttention('run-1');
    run.send('alive-but-stalled');
    run.send('alive-but-stalled');
    await settle();
    run.send('alive-but-stalled');
    await settle();

    expect(stalls).toHaveLength(2);
    expect(dispatched).toEqual([]);
  });
});

describe('a loop report (COR-2526)', () => {
  it('marks the task looping from a warning or a block, and announces only the first', async () => {
    const { seam, loops, dispatched } = bookkeeping(new Map(), {
      stall: [],
      looping: [true, false, false],
    });

    seam.recordTaskLoop({ runId: 'run-1', type: 'toolbox.loop-warning' });
    seam.recordTaskLoop({ runId: 'run-1', type: 'toolbox.loop-blocked' });
    seam.recordTaskLoop({ runId: 'run-1', type: 'toolbox.loop-blocked' });
    seam.recordTaskLoop({ runId: 'run-1', type: 'toolbox.executed' });
    await settle();

    expect(loops.map(([runId]) => runId)).toEqual(['run-1', 'run-1', 'run-1']);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toBeInstanceOf(RunLoopingEvent);
    expect(dispatched[0]).toMatchObject({ runId: 'run-1', level: 'warning' });
  });
});
