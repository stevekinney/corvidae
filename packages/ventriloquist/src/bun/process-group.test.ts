import { describe, expect, test } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing';

import { ManualClock } from '../session/fixtures/manual-clock.ts';
import { flush } from '../session/session.test-support.ts';
import {
  descendantsOutsideGroup,
  parseProcessTable,
  processGroupOperations,
  readProcessTable,
  terminateProcessGroup,
  type ProcessGroupOperations,
  type ProcessRecord,
} from './process-group.ts';

const NO_SUCH_GROUP = 2_147_483_646;

type Script = {
  readonly operations: ProcessGroupOperations;
  readonly signals: string[];
  emptyAfter(signal: 'SIGTERM' | 'SIGKILL' | 'never'): void;
};

/** A group that empties once the scripted signal is sent, and records every signal. */
function scriptedGroup(): Script {
  const signals: string[] = [];
  let emptiesOn: string = 'never';
  let empty = false;
  return {
    signals,
    emptyAfter: (signal) => {
      emptiesOn = signal;
    },
    operations: {
      signal: (_group, signal) => {
        signals.push(signal);
        if (signal === emptiesOn) empty = true;
      },
      exists: () => !empty,
    },
  };
}

function termination(script: Script, clock: ManualClock) {
  return {
    group: 4242,
    operations: script.operations,
    clock,
    graceMilliseconds: 100,
    observationMilliseconds: 300,
    pollMilliseconds: 20,
  };
}

describe('terminateProcessGroup', () => {
  test('is complete as soon as TERM empties the group, and never sends KILL', async () => {
    const script = scriptedGroup();
    script.emptyAfter('SIGTERM');
    const clock = new ManualClock();
    expect(await terminateProcessGroup(termination(script, clock))).toBe('complete');
    expect(script.signals).toEqual(['SIGTERM']);
    expect(clock.pendingTimers).toBe(0);
  });

  test('keeps probing while the group drains inside the grace', async () => {
    const script = scriptedGroup();
    let probes = 0;
    const clock = new ManualClock();
    const done = terminateProcessGroup({
      ...termination(script, clock),
      operations: {
        signal: script.operations.signal,
        exists: () => ++probes < 3,
      },
    });
    clock.advance(20);
    clock.advance(20);
    expect(await done).toBe('complete');
    expect(script.signals).toEqual(['SIGTERM']);
    expect(probes).toBe(3);
  });

  test('escalates to KILL when the group outlasts the grace', async () => {
    const script = scriptedGroup();
    script.emptyAfter('SIGKILL');
    const clock = new ManualClock();
    const done = terminateProcessGroup(termination(script, clock));
    clock.advance(100);
    expect(await done).toBe('complete');
    expect(script.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(clock.pendingTimers).toBe(0);
  });

  test('is incomplete when the group is still there after the KILL window', async () => {
    const script = scriptedGroup();
    const clock = new ManualClock();
    const done = terminateProcessGroup(termination(script, clock));
    clock.advance(100);
    await flush();
    expect(script.signals).toEqual(['SIGTERM', 'SIGKILL']);
    clock.advance(300);
    expect(await done).toBe('incomplete');
    expect(clock.pendingTimers).toBe(0);
  });

  test('is incomplete when the group cannot be signaled', async () => {
    const clock = new ManualClock();
    const outcome = await terminateProcessGroup({
      ...termination(scriptedGroup(), clock),
      operations: {
        signal: () => {
          throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
        },
        exists: () => true,
      },
    });
    expect(outcome).toBe('incomplete');
  });
});

describe('processGroupOperations', () => {
  test('a group that does not exist is absent, and signaling it is not an error', () => {
    expect(processGroupOperations.exists(NO_SUCH_GROUP)).toBe(false);
    expect(() => processGroupOperations.signal(NO_SUCH_GROUP, 'SIGTERM')).not.toThrow();
  });

  test('any other failure to signal is raised', () => {
    expect(() => processGroupOperations.signal(4242, 'SIGNOPE' as unknown as 'SIGTERM')).toThrow();
  });

  test('signals a real group and sees it empty', async () => {
    const child = Bun.spawn(['sleep', '7919'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    expect(processGroupOperations.exists(child.pid)).toBe(true);
    processGroupOperations.signal(child.pid, 'SIGTERM');
    expect(await child.exited).toBe(143);
    expect(processGroupOperations.exists(child.pid)).toBe(false);
  });
});

describe('the process table', () => {
  test('is read from rows of pid, parent and group', () => {
    expect(parseProcessTable('  10   1  10\n\n 11 10 10 \n')).toEqual([
      { pid: 10, parentPid: 1, group: 10 },
      { pid: 11, parentPid: 10, group: 10 },
    ]);
    expect(parseProcessTable('')).toEqual([]);
  });

  test.each(['10 1', '10 1 10 4', 'a b c', '10 1 x', '1.5 1 1'])('refuses the row %j', (row) => {
    expect(() => parseProcessTable(row)).toThrow('unreadable process table row');
  });

  test('is read from the running host and includes this process', async () => {
    const table = await readProcessTable();
    expect(table).toContainEqual(expect.objectContaining({ pid: process.pid }));
  });

  test('a failing command refuses the read rather than guessing', async () => {
    const failure = await rejectionOf(readProcessTable(['sh', '-c', 'exit 3']));
    expect((failure as Error).message).toBe('ps exited with 3');
  });
});

describe('descendantsOutsideGroup', () => {
  const table: ProcessRecord[] = [
    { pid: 100, parentPid: 1, group: 100 },
    { pid: 101, parentPid: 100, group: 100 },
    { pid: 102, parentPid: 101, group: 102 },
    { pid: 103, parentPid: 102, group: 102 },
    { pid: 200, parentPid: 1, group: 200 },
    { pid: 201, parentPid: 200, group: 201 },
  ];

  test('finds descendants, at any depth, that left the owned group', () => {
    expect(descendantsOutsideGroup(table, 100, 100).map((record) => record.pid)).toEqual([
      102, 103,
    ]);
  });

  test('ignores descendants that stayed in the group and processes that are not descendants', () => {
    expect(descendantsOutsideGroup(table.slice(0, 2), 100, 100)).toEqual([]);
    expect(descendantsOutsideGroup(table, 300, 300)).toEqual([]);
  });

  test('does not loop on a table whose parent links form a cycle', () => {
    const cyclic: ProcessRecord[] = [
      { pid: 100, parentPid: 101, group: 100 },
      { pid: 101, parentPid: 100, group: 100 },
    ];
    expect(descendantsOutsideGroup(cyclic, 100, 100)).toEqual([]);
  });
});
