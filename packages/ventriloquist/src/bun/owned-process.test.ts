import { describe, expect, test } from 'bun:test';

import { expectOk, SESSION_IDENTIFIER } from '../protocol/endpoint-pair.test-support.ts';
import { decodeFrame, encodeFrame } from '../protocol/frame-codec.ts';
import { createDeferred } from '../session/fixtures/deferred.ts';
import { ManualClock } from '../session/fixtures/manual-clock.ts';
import { flush } from '../session/session.test-support.ts';
import { OwnedProcess } from './owned-process.ts';
import type { ProcessGroupOperations, ProcessRecord } from './process-group.ts';
import type { SpawnedProcess } from './process-types.ts';

const LEADER = 4242;

type Harness = {
  readonly owned: OwnedProcess;
  readonly clock: ManualClock;
  readonly signals: string[];
  readonly tableReads: () => number;
  /** The leader ends; `groupEmpty` says whether any member outlived it. */
  endLeader(
    code: number,
    options?: { signal?: string | number; groupEmpty: boolean },
  ): Promise<void>;
  child: SpawnedProcess;
};

function harness(options: {
  /** What the process table holds when it is read, or `'unreadable'`. */
  table?: ProcessRecord[] | 'unreadable';
  /** The signal that empties the group and ends the leader; `never` leaves it standing. */
  endsOn?: 'SIGTERM' | 'SIGKILL' | 'never';
  /** Holds the process-table read open until the test releases it. */
  tableGate?: Promise<void>;
}): Harness {
  const exited = createDeferred<number>();
  const signals: string[] = [];
  let tableReads = 0;
  let empty = false;
  let signalCode: string | number | null = null;
  const endsOn = options.endsOn ?? 'SIGTERM';
  const operations: ProcessGroupOperations = {
    signal: (_group, signal) => {
      signals.push(signal);
      if (signal === endsOn) {
        empty = true;
        signalCode = signal;
        exited.resolve(128);
      }
    },
    exists: () => !empty,
  };
  const clock = new ManualClock();
  const owned = new OwnedProcess({
    operations,
    clock,
    graceMilliseconds: 100,
    observationMilliseconds: 300,
    readProcessTable: async () => {
      tableReads += 1;
      await options.tableGate;
      if (options.table === 'unreadable') throw new Error('no ps');
      return options.table ?? [];
    },
  });
  const child: SpawnedProcess = {
    pid: LEADER,
    exited: exited.promise,
    get signalCode() {
      return signalCode;
    },
    kill: () => undefined,
  };
  return {
    owned,
    clock,
    signals,
    tableReads: () => tableReads,
    child,
    endLeader: async (code, ended) => {
      empty = ended?.groupEmpty ?? true;
      signalCode = ended?.signal ?? null;
      exited.resolve(code);
      await flush();
    },
  };
}

const escapee: ProcessRecord = { pid: 5000, parentPid: LEADER, group: 5000 };

describe('OwnedProcess', () => {
  test('owns nothing until a process is adopted, and then has nothing to clean up', async () => {
    const { owned, signals, tableReads } = harness({});
    expect(owned.exit).toBeUndefined();
    expect(await owned.terminate()).toBe('complete');
    expect(signals).toEqual([]);
    expect(tableReads()).toBe(0);
  });

  test('records an exit code, and a terminating signal as a signal with no code', async () => {
    const coded = harness({});
    coded.owned.adopt(coded.child);
    await coded.endLeader(3);
    expect(await coded.owned.exit).toEqual({ exitCode: 3, signal: null });

    const signaled = harness({});
    signaled.owned.adopt(signaled.child);
    await signaled.endLeader(143, { signal: 'SIGTERM', groupEmpty: true });
    expect(await signaled.owned.exit).toEqual({ exitCode: null, signal: 'SIGTERM' });
  });

  test.each([
    ['a signal with no name of its own', 34, 'SIG34'],
    ['an empty signal name', '', 'SIGUNKNOWN'],
  ])('spells %s as a nonempty name the wire accepts', async (_label, signal, expected) => {
    const { owned, child, endLeader } = harness({});
    owned.adopt(child);
    await endLeader(137, { signal, groupEmpty: true });
    const exit = await owned.exit;
    expect(exit).toEqual({ exitCode: null, signal: expected });
    const encoded = expectOk(
      encodeFrame({
        kind: 'process-exit',
        sessionId: SESSION_IDENTIFIER,
        attachmentGeneration: 3,
        sequence: 7,
        exitCode: exit?.exitCode ?? null,
        signal: exit?.signal ?? null,
      }),
    );
    expect(expectOk(decodeFrame(encoded, 'client'))).toMatchObject({
      kind: 'process-exit',
      exitCode: null,
      signal: expected,
    });
  });

  test('does not signal a group whose leader exited, leaving it empty, while the process table was being read', async () => {
    const gate = createDeferred<void>();
    const { owned, child, endLeader, signals, tableReads } = harness({ tableGate: gate.promise });
    owned.adopt(child);
    const terminating = owned.terminate();
    await flush();
    expect(tableReads()).toBe(1);
    // The leader ends and its group empties while `ps` is still running: the number may now belong
    // to an unrelated group, so nothing may be signaled once the read returns.
    await endLeader(0);
    gate.resolve();
    expect(await terminating).toBe('complete');
    expect(signals).toEqual([]);
  });

  test('still signals a group that outlived its leader while the process table was being read', async () => {
    const gate = createDeferred<void>();
    const { owned, child, endLeader, signals } = harness({ tableGate: gate.promise });
    owned.adopt(child);
    const terminating = owned.terminate();
    await flush();
    await endLeader(0, { groupEmpty: false });
    gate.resolve();
    await flush();
    expect(signals).toEqual(['SIGTERM']);
    expect(await terminating).toBe('complete');
  });

  test('does not signal a group that was already empty when its leader exited', async () => {
    const { owned, child, endLeader, signals, tableReads } = harness({});
    owned.adopt(child);
    await endLeader(0);
    expect(await owned.terminate()).toBe('complete');
    expect(signals).toEqual([]);
    expect(tableReads()).toBe(0);
  });

  test('ends a live group with TERM, reaps the leader and reports complete', async () => {
    const { owned, child, signals, tableReads } = harness({});
    owned.adopt(child);
    expect(await owned.terminate()).toBe('complete');
    expect(signals).toEqual(['SIGTERM']);
    expect(tableReads()).toBe(1);
    expect(await owned.exit).toEqual({ exitCode: null, signal: 'SIGTERM' });
  });

  test('never signals again once a termination emptied a group that outlived its leader', async () => {
    const { owned, child, endLeader, signals, tableReads } = harness({ endsOn: 'SIGTERM' });
    owned.adopt(child);
    await endLeader(0, { groupEmpty: false });
    expect(await owned.terminate()).toBe('complete');
    expect(await owned.terminate()).toBe('complete');
    expect(signals).toEqual(['SIGTERM']);
    expect(tableReads()).toBe(1);
  });

  test('concurrent terminations share one signal sequence and one outcome', async () => {
    const { owned, child, signals } = harness({ table: [escapee] });
    owned.adopt(child);
    const outcomes = await Promise.all([owned.terminate(), owned.terminate()]);
    expect(outcomes).toEqual(['unknown', 'unknown']);
    expect(await owned.terminate()).toBe('unknown');
    expect(signals).toEqual(['SIGTERM']);
  });

  test('a termination that left the group standing may be tried again', async () => {
    const { owned, child, clock, signals } = harness({ endsOn: 'never' });
    owned.adopt(child);
    const first = owned.terminate();
    await flush();
    clock.advance(100);
    await flush();
    clock.advance(300);
    expect(await first).toBe('incomplete');
    const second = owned.terminate();
    await flush();
    clock.advance(100);
    await flush();
    clock.advance(300);
    expect(await second).toBe('incomplete');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL', 'SIGTERM', 'SIGKILL']);
  });

  test('a process adopted after an early terminate is still ended', async () => {
    const { owned, child, signals } = harness({});
    expect(await owned.terminate()).toBe('complete');
    owned.adopt(child);
    expect(await owned.terminate()).toBe('complete');
    expect(signals).toEqual(['SIGTERM']);
  });

  test('ends the members that outlived their leader', async () => {
    const { owned, child, endLeader, signals } = harness({ endsOn: 'SIGTERM' });
    owned.adopt(child);
    await endLeader(0, { groupEmpty: false });
    expect(await owned.terminate()).toBe('complete');
    expect(signals).toEqual(['SIGTERM']);
  });

  test('escalates to KILL for a group that ignores TERM', async () => {
    const { owned, child, clock, signals } = harness({ endsOn: 'SIGKILL' });
    owned.adopt(child);
    const outcome = owned.terminate();
    await flush();
    clock.advance(100);
    expect(await outcome).toBe('complete');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('a group that survives KILL is incomplete', async () => {
    const { owned, child, clock, signals } = harness({ endsOn: 'never' });
    owned.adopt(child);
    const outcome = owned.terminate();
    await flush();
    clock.advance(100);
    await flush();
    clock.advance(300);
    expect(await outcome).toBe('incomplete');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('a descendant that left the group is unknown, though the group itself ended', async () => {
    const { owned, child, signals } = harness({ table: [escapee] });
    owned.adopt(child);
    expect(await owned.terminate()).toBe('unknown');
    expect(signals).toEqual(['SIGTERM']);
  });

  test('a process table that cannot be read is unknown, though the group itself ended', async () => {
    const { owned, child, signals } = harness({ table: 'unreadable' });
    owned.adopt(child);
    expect(await owned.terminate()).toBe('unknown');
    expect(signals).toEqual(['SIGTERM']);
  });

  test('an escaped descendant outranks a group that did not empty', async () => {
    const { owned, child, clock } = harness({ table: [escapee], endsOn: 'never' });
    owned.adopt(child);
    const outcome = owned.terminate();
    await flush();
    clock.advance(100);
    await flush();
    clock.advance(300);
    expect(await outcome).toBe('unknown');
  });
});
