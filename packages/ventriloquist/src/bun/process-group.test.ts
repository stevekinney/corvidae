import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { describe, expect, test } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing';

import { ManualClock } from '../session/fixtures/manual-clock.ts';
import { systemClock } from '../session/session-clock.ts';
import { flush } from '../session/session.test-support.ts';
import { scenario, scenarioResult, settleScenarios } from './bun-process.test-support.ts';
import {
  createProcessGroupOperations,
  descendantsOutsideGroup,
  parseGroupMemberStates,
  parseProcessTable,
  processGroupOperations,
  readGroupMemberStates,
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
    await flush();
    clock.advance(20);
    await flush();
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

  test('never has two probes in flight, and the last look waits for the one that is', async () => {
    const clock = new ManualClock();
    const probes: { resolve(present: boolean): void }[] = [];
    let inFlight = 0;
    let overlapped = false;
    const done = terminateProcessGroup({
      ...termination(scriptedGroup(), clock),
      operations: {
        signal: () => undefined,
        exists: () =>
          new Promise<boolean>((resolve) => {
            inFlight += 1;
            overlapped ||= inFlight > 1;
            probes.push({
              resolve: (present) => {
                inFlight -= 1;
                resolve(present);
              },
            });
          }),
      },
    });
    await flush();
    // The first probe is still reading the process table when the grace passes.
    clock.advance(100);
    await flush();
    expect(probes).toHaveLength(1);
    probes[0]?.resolve(true);
    await flush();
    // Only now does the deadline look once more, and it sees the group gone.
    expect(probes).toHaveLength(2);
    probes[1]?.resolve(false);
    expect(await done).toBe('complete');
    expect(overlapped).toBe(false);
    expect(inFlight).toBe(0);
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

const scenario1 = scenario('signals a real group and sees it empty', async () => {
  const child = spawnWithHangGuard(['sleep', '7919'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  expect(await processGroupOperations.exists(child.pid)).toBe(true);
  processGroupOperations.signal(child.pid, 'SIGTERM');
  expect(await child.exited).toBe(143);
  expect(await processGroupOperations.exists(child.pid)).toBe(false);
});

describe('processGroupOperations', () => {
  test('a group that does not exist is absent, and signaling it is not an error', async () => {
    expect(await processGroupOperations.exists(NO_SUCH_GROUP)).toBe(false);
    expect(() => processGroupOperations.signal(NO_SUCH_GROUP, 'SIGTERM')).not.toThrow();
  });

  test('any other failure to signal is raised', () => {
    expect(() => processGroupOperations.signal(4242, 'SIGNOPE' as unknown as 'SIGTERM')).toThrow();
  });

  scenarioResult('signals a real group and sees it empty', scenario1);
});

/**
 * A process group whose only member is a zombie: a perl process forks a child that makes itself a
 * group leader and exits at once, and the parent, which sits outside that group, never waits for
 * it. The child is dead, but nothing reaps it until the parent ends, which is what a container's
 * init does to every orphan it never collects.
 */
async function startZombieGroup(): Promise<{ readonly group: number; end(): Promise<void> }> {
  const parent = spawnWithHangGuard(
    [
      'perl',
      '-e',
      '$|=1; my $pid = fork(); if (!$pid) { setpgrp(0, 0); exit 0 } print "$pid\\n"; sleep 60',
    ],
    {
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    },
  );
  const reader = parent.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  const group = Number(new TextDecoder().decode(first.value).trim());
  const end = async (): Promise<void> => {
    parent.kill('SIGKILL');
    await parent.exited;
  };
  // The child must have exited before it can be a zombie; wait until the table says so.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const states = (await readGroupMemberStates(group)) ?? [];
    // `Z` is the zombie state; ps may add flags to it, such as `N` for a niced process.
    if (states.length > 0 && states.every((state) => state.startsWith('Z'))) return { group, end };
    await Bun.sleep(10);
  }
  await end();
  throw new Error(`process group ${group} never became a zombie`);
}

const scenario2 = scenario('is empty, though kill(-group, 0) still reports it', async () => {
  const zombie = await startZombieGroup();
  try {
    // The premise: the operating system still answers for the group (EPERM on macOS, success on Linux).
    let signalable = true;
    try {
      process.kill(-zombie.group, 0);
    } catch (error) {
      signalable = (error as { code?: unknown }).code === 'EPERM';
    }
    expect(signalable).toBe(true);
    expect(await processGroupOperations.exists(zombie.group)).toBe(false);
  } finally {
    await zombie.end();
  }
});

const scenario3 = scenario(
  'is present while any member is not a zombie, and when its members cannot be read',
  async () => {
    const leader = spawnWithHangGuard(['sleep', '7919'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    try {
      const exists = (reading: readonly string[] | undefined): Promise<boolean> | boolean =>
        createProcessGroupOperations(() => reading).exists(leader.pid);
      expect(await exists(['Z', 'S'])).toBe(true);
      expect(await exists(['Z', 'Z'])).toBe(false);
      expect(await exists([])).toBe(false);
      expect(await exists(undefined)).toBe(true);
    } finally {
      leader.kill('SIGKILL');
      await leader.exited;
    }
  },
);

describe('a group whose only member is a zombie', () => {
  scenarioResult('is empty, though kill(-group, 0) still reports it', scenario2);

  scenarioResult(
    'is present while any member is not a zombie, and when its members cannot be read',
    scenario3,
  );
});

/** A kill that refuses every signal with EPERM, as macOS does for a group of nothing but zombies. */
function refusingKill(): never {
  throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
}

const scenario4 = scenario(
  'ends a group whose only member is an unreaped zombie as complete',
  async () => {
    const zombie = await startZombieGroup();
    try {
      const outcome = await terminateProcessGroup({
        group: zombie.group,
        operations: processGroupOperations,
        clock: systemClock,
        graceMilliseconds: 100,
        observationMilliseconds: 1_000,
        pollMilliseconds: 20,
      });
      expect(outcome).toBe('complete');
      await processGroupOperations.signal(zombie.group, 'SIGKILL');
    } finally {
      await zombie.end();
    }
  },
);

describe('terminating a group the host may not signal', () => {
  // The real shape of the failure: on macOS kill(-group) answers EPERM for a zombie-only group, so
  // a slow `ps` that still reports the group present let the KILL escalation throw, and cleanup
  // was reported incomplete for a process that was already dead.
  scenarioResult('ends a group whose only member is an unreaped zombie as complete', scenario4);

  test.each([
    ['only zombies', ['Z', 'Z+']],
    ['no members', []],
  ])('treats EPERM as gone when the group has %s', async (_label, states) => {
    const operations = createProcessGroupOperations(() => states, refusingKill);
    await operations.signal(4242, 'SIGKILL');
    const outcome = await terminateProcessGroup({
      group: 4242,
      operations,
      clock: new ManualClock(),
      graceMilliseconds: 100,
      observationMilliseconds: 300,
      pollMilliseconds: 20,
    });
    expect(outcome).toBe('complete');
  });

  test.each([
    ['a live member', ['Z', 'S']],
    ['members that cannot be read', undefined],
  ])('still reports EPERM as incomplete when the group has %s', async (_label, states) => {
    const operations = createProcessGroupOperations(() => states, refusingKill);
    const refusal = await rejectionOf(Promise.resolve(operations.signal(4242, 'SIGTERM')));
    expect((refusal as { code?: string }).code).toBe('EPERM');
    const outcome = await terminateProcessGroup({
      group: 4242,
      operations,
      clock: new ManualClock(),
      graceMilliseconds: 100,
      observationMilliseconds: 300,
      pollMilliseconds: 20,
    });
    expect(outcome).toBe('incomplete');
  });

  test('raises any other failure to signal at once', () => {
    const operations = createProcessGroupOperations(
      () => [],
      () => {
        throw Object.assign(new Error('invalid'), { code: 'EINVAL' });
      },
    );
    expect(() => operations.signal(4242, 'SIGTERM')).toThrow('invalid');
  });
});

const scenario5 = scenario('are read from the running host', async () => {
  const leader = spawnWithHangGuard(['sleep', '7919'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    expect(await readGroupMemberStates(leader.pid)).toEqual([expect.stringMatching(/^[A-Y]/)]);
  } finally {
    leader.kill('SIGKILL');
    await leader.exited;
  }
});

const scenario6 = scenario(
  'are unknown when the command fails, cannot run, or prints something unreadable',
  async () => {
    expect(await readGroupMemberStates(1, ['sh', '-c', 'exit 3'])).toBeUndefined();
    expect(await readGroupMemberStates(1, ['/nonexistent/ventriloquist-ps'])).toBeUndefined();
    expect(await readGroupMemberStates(1, ['echo', 'not a table'])).toBeUndefined();
  },
);

describe('the states of a group', () => {
  test('are read from rows of group and state, for the one group asked about', () => {
    expect(parseGroupMemberStates(' 10 Ss\n10 Z+\n 11 R\n\n', 10)).toEqual(['Ss', 'Z+']);
    expect(parseGroupMemberStates('', 10)).toEqual([]);
  });

  test.each(['10', '10 S extra', 'x S', '1.5 S'])('refuse the row %j', (row) => {
    expect(() => parseGroupMemberStates(row, 10)).toThrow('unreadable process state row');
  });

  scenarioResult('are read from the running host', scenario5);

  scenarioResult(
    'are unknown when the command fails, cannot run, or prints something unreadable',
    scenario6,
  );
});

const scenario7 = scenario('is read from the running host and includes this process', async () => {
  const table = await readProcessTable();
  expect(table).toContainEqual(expect.objectContaining({ pid: process.pid }));
});

const scenario8 = scenario('a failing command refuses the read rather than guessing', async () => {
  const failure = await rejectionOf(readProcessTable(['sh', '-c', 'exit 3']));
  expect((failure as Error).message).toBe('ps exited with 3');
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

  scenarioResult('is read from the running host and includes this process', scenario7);

  scenarioResult('a failing command refuses the read rather than guessing', scenario8);
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

await settleScenarios();
