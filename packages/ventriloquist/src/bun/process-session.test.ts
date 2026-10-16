import { describe, expect, test } from 'bun:test';

import { rejectionOf, SCENARIO_HANG_GUARD_MILLISECONDS } from '@lostgradient/testing';

import { systemClock } from '../session/session-clock.ts';
import {
  isAlive,
  scenario,
  scenarioResult,
  settleScenarios,
  waitUntilGone,
} from './bun-process.test-support.ts';
import { descendantsOutsideGroup, terminateProcessGroup } from './process-group.ts';
import {
  createSessionOf,
  createSessionOperations,
  parseProcessStates,
  readProcessStates,
  readSessionTable,
  sessionOfProcess,
  sessionOperations,
  UNREADABLE_SESSION,
  type ProcessState,
} from './process-session.ts';

const SESSION = 500;

type Call = { readonly pid: number; readonly signal: string };

/** A fake host: processes with a state and a session, a kill that records, and a table that can be unreadable. */
function fakeHost(
  processes: Record<number, { state?: string; session: number }>,
  options: { kill?: (pid: number, signal: string) => void } = {},
) {
  const calls: Call[] = [];
  const sessions = new Map(Object.entries(processes).map(([pid, p]) => [Number(pid), p.session]));
  const states: ProcessState[] | undefined = Object.entries(processes).map(([pid, p]) => ({
    pid: Number(pid),
    state: p.state ?? 'S',
  }));
  let table: ProcessState[] | undefined = states;
  const operations = createSessionOperations({
    readStates: () => table,
    sessionOf: (pid) => sessions.get(pid) ?? -1,
    kill: (pid, signal) => {
      options.kill?.(pid, signal);
      calls.push({ pid, signal });
    },
  });
  return {
    operations,
    calls,
    sessions,
    unreadable: () => {
      table = undefined;
    },
    setTable: (next: ProcessState[]) => {
      table = next;
    },
  };
}

function refusal(code: string): never {
  throw Object.assign(new Error(code), { code });
}

const scenario1 = scenario('are read from the running host and include this process', async () => {
  expect(await readProcessStates()).toContainEqual(expect.objectContaining({ pid: process.pid }));
});

const scenario2 = scenario(
  'are unknown when the command fails, cannot run, or prints something unreadable',
  async () => {
    expect(await readProcessStates(['sh', '-c', 'exit 3'])).toBeUndefined();
    expect(await readProcessStates(['/nonexistent/ventriloquist-ps'])).toBeUndefined();
    expect(await readProcessStates(['echo', 'not a table'])).toBeUndefined();
  },
);

describe('the process states', () => {
  test('are read from rows of pid and state', () => {
    expect(parseProcessStates(' 10 Ss\n11 Z+\n\n')).toEqual([
      { pid: 10, state: 'Ss' },
      { pid: 11, state: 'Z+' },
    ]);
    expect(parseProcessStates('')).toEqual([]);
  });

  test.each(['10', '10 S extra', 'x S', '1.5 S'])('refuse the row %j', (row) => {
    expect(() => parseProcessStates(row)).toThrow('unreadable process state row');
  });

  scenarioResult('are read from the running host and include this process', scenario1);

  scenarioResult(
    'are unknown when the command fails, cannot run, or prints something unreadable',
    scenario2,
  );
});

describe('session membership', () => {
  test('is exactly the live processes whose session is the one asked about', async () => {
    const host = fakeHost({
      500: { session: 500 },
      501: { session: 500 },
      502: { session: 900 },
      503: { session: 500, state: 'Z+' },
    });
    expect(await host.operations.exists(SESSION)).toBe(true);
    host.setTable([
      { pid: 502, state: 'S' },
      { pid: 503, state: 'Z' },
    ]);
    expect(await host.operations.exists(SESSION)).toBe(false);
    host.setTable([]);
    expect(await host.operations.exists(SESSION)).toBe(false);
  });

  test('is present when the table or a session cannot be read', async () => {
    const host = fakeHost({ 500: { session: 500 } });
    host.unreadable();
    expect(await host.operations.exists(SESSION)).toBe(true);
    const failing = createSessionOperations({
      readStates: () => [{ pid: 500, state: 'S' }],
      sessionOf: () => {
        throw new Error('no libc');
      },
    });
    expect(await failing.exists(SESSION)).toBe(true);
    expect(
      (await rejectionOf(Promise.resolve(failing.signal(SESSION, 'SIGTERM')))) as Error,
    ).toBeInstanceOf(Error);
  });

  test('a signal pass over an unreadable table raises, so cleanup is incomplete', async () => {
    const host = fakeHost({ 500: { session: 500 } });
    host.unreadable();
    const failure = await rejectionOf(Promise.resolve(host.operations.signal(SESSION, 'SIGKILL')));
    expect((failure as Error).message).toBe('the process table could not be read');
    expect(host.calls).toEqual([]);
  });
});

describe('signaling a session', () => {
  test('reaches every live member and nothing else, TERM followed by CONT for a stopped one', async () => {
    const host = fakeHost({
      500: { session: 500 },
      501: { session: 500, state: 'T' },
      502: { session: 900 },
      503: { session: 500, state: 'Z' },
    });
    await host.operations.signal(SESSION, 'SIGTERM');
    expect(host.calls).toEqual([
      { pid: 500, signal: 'SIGTERM' },
      { pid: 500, signal: 'SIGCONT' },
      { pid: 501, signal: 'SIGTERM' },
      { pid: 501, signal: 'SIGCONT' },
    ]);
  });

  test('KILL is not followed by CONT', async () => {
    const host = fakeHost({ 500: { session: 500 }, 501: { session: 500 } });
    await host.operations.signal(SESSION, 'SIGKILL');
    expect(host.calls.map((call) => call.signal)).toEqual(['SIGKILL', 'SIGKILL']);
  });

  test('re-reads a candidate right before signaling it, so a reused pid is never signaled', async () => {
    // Listed as a member, then exited and its pid went to a process in another session.
    const reads: number[] = [];
    const calls: Call[] = [];
    const operations = createSessionOperations({
      readStates: () => [{ pid: 777, state: 'S' }],
      sessionOf: (pid) => {
        reads.push(pid);
        return reads.length === 1 ? SESSION : 4242;
      },
      kill: (pid, signal) => {
        calls.push({ pid, signal });
      },
    });
    await operations.signal(SESSION, 'SIGKILL');
    expect(reads).toEqual([777, 777, 777]);
    expect(calls).toEqual([]);
  });

  test('chases a member that started during the pass, once, and stops when nothing new appears', async () => {
    const host = fakeHost({ 500: { session: 500 } });
    host.sessions.set(600, SESSION);
    let reads = 0;
    const calls: Call[] = [];
    const operations = createSessionOperations({
      readStates: () => {
        reads += 1;
        return reads === 1
          ? [{ pid: 500, state: 'S' }]
          : [
              { pid: 500, state: 'S' },
              { pid: 600, state: 'S' },
            ];
      },
      sessionOf: (pid) => host.sessions.get(pid) ?? -1,
      kill: (pid, signal) => {
        calls.push({ pid, signal });
      },
    });
    await operations.signal(SESSION, 'SIGKILL');
    expect(calls.map((call) => call.pid)).toEqual([500, 600]);
    expect(reads).toBe(3);
  });

  test('stops chasing a fork loop after a bounded number of passes', async () => {
    let next = 1_000;
    let reads = 0;
    const operations = createSessionOperations({
      readStates: () => {
        reads += 1;
        next += 1;
        return [{ pid: next, state: 'S' }];
      },
      sessionOf: () => SESSION,
      kill: () => undefined,
    });
    await operations.signal(SESSION, 'SIGKILL');
    expect(reads).toBe(4);
  });

  test('a process that exited before the signal is not an error', async () => {
    const host = fakeHost({ 500: { session: 500 } }, { kill: () => refusal('ESRCH') });
    await host.operations.signal(SESSION, 'SIGKILL');
  });

  test('a refusal for a process that became a zombie is gone, and for a live one is raised', async () => {
    const zombie = fakeHost({ 500: { session: 500 } }, { kill: () => refusal('EPERM') });
    // The first read lists a live member; the follow-up read finds it a zombie.
    let reads = 0;
    const turning = createSessionOperations({
      readStates: () => {
        reads += 1;
        return [{ pid: 500, state: reads === 1 ? 'S' : 'Z' }];
      },
      sessionOf: () => SESSION,
      kill: () => refusal('EPERM'),
    });
    await turning.signal(SESSION, 'SIGKILL');
    const live = await rejectionOf(Promise.resolve(zombie.operations.signal(SESSION, 'SIGKILL')));
    expect((live as { code?: string }).code).toBe('EPERM');

    const vanished = createSessionOperations({
      readStates: (() => {
        let count = 0;
        return () => (++count === 1 ? [{ pid: 500, state: 'S' }] : []);
      })(),
      sessionOf: () => SESSION,
      kill: () => refusal('EPERM'),
    });
    await vanished.signal(SESSION, 'SIGKILL');

    const unreadable = createSessionOperations({
      readStates: (() => {
        let count = 0;
        return () => (++count <= 2 ? [{ pid: 500, state: 'S' }] : undefined);
      })(),
      sessionOf: () => SESSION,
      kill: () => refusal('EPERM'),
    });
    expect(
      (
        (await rejectionOf(Promise.resolve(unreadable.signal(SESSION, 'SIGKILL')))) as {
          code?: string;
        }
      ).code,
    ).toBe('EPERM');
  });

  test('any other failure to signal is raised', async () => {
    const host = fakeHost({ 500: { session: 500 } }, { kill: () => refusal('EINVAL') });
    const failure = await rejectionOf(Promise.resolve(host.operations.signal(SESSION, 'SIGKILL')));
    expect((failure as { code?: string }).code).toBe('EINVAL');
  });
});

describe('hanging up the leader', () => {
  test('sends SIGHUP then SIGCONT to a leader that still leads the session', () => {
    const host = fakeHost({ 500: { session: 500 }, 501: { session: 500 } });
    host.operations.hangUp(SESSION);
    expect(host.calls).toEqual([
      { pid: 500, signal: 'SIGHUP' },
      { pid: 500, signal: 'SIGCONT' },
    ]);
  });

  test('sends nothing to a pid that is not the leader of the session, such as a reused one', () => {
    const host = fakeHost({ 500: { session: 900 } });
    host.operations.hangUp(SESSION);
    host.operations.hangUp(501);
    expect(host.calls).toEqual([]);
  });

  test.each(['ESRCH', 'EPERM'])('a leader that answers %s is gone, not an error', (code) => {
    const host = fakeHost({ 500: { session: 500 } }, { kill: () => refusal(code) });
    host.operations.hangUp(SESSION);
  });

  test('any other failure is raised', () => {
    const host = fakeHost({ 500: { session: 500 } }, { kill: () => refusal('EINVAL') });
    expect(() => host.operations.hangUp(SESSION)).toThrow('EINVAL');
  });
});

const scenario3 = scenario(
  'puts each process in its session, so the descendants that left it are found',
  async () => {
    const table = await readSessionTable(
      (pid) => (pid === 2 ? -1 : pid === 3 ? 900 : 500),
      async () => [
        { pid: 1, parentPid: 0, group: 1 },
        { pid: 2, parentPid: 1, group: 2 },
        { pid: 3, parentPid: 1, group: 3 },
        { pid: 4, parentPid: 1, group: 4 },
      ],
    );
    // 2 vanished between the table and its session being read: it is gone, not escaped.
    expect(table.map((record) => [record.pid, record.group])).toEqual([
      [1, 500],
      [3, 900],
      [4, 500],
    ]);
    expect(descendantsOutsideGroup(table, 1, 500).map((record) => record.pid)).toEqual([3]);
  },
);

const scenario4 = scenario(
  'is read from the running host: this process is in the session getsid reports',
  async () => {
    const table = await readSessionTable();
    expect(table).toContainEqual(
      expect.objectContaining({ pid: process.pid, group: sessionOfProcess(process.pid) }),
    );
  },
);

describe('the session table', () => {
  scenarioResult(
    'puts each process in its session, so the descendants that left it are found',
    scenario3,
  );

  scenarioResult(
    'is read from the running host: this process is in the session getsid reports',
    scenario4,
  );
});

describe('a session that cannot be read at signal time', () => {
  /** Listed as a member, then unreadable when it is about to be signaled; the follow-up read says what became of it. */
  function turning(afterwards: ProcessState[]) {
    let sessionReads = 0;
    let stateReads = 0;
    const kills: string[] = [];
    const operations = createSessionOperations({
      readStates: () => {
        stateReads += 1;
        return stateReads <= 2 ? [{ pid: 500, state: 'S' }] : afterwards;
      },
      sessionOf: () => {
        sessionReads += 1;
        if (sessionReads === 1) return SESSION;
        throw new Error('could not be read');
      },
      kill: (_pid, signal) => {
        kills.push(signal);
      },
    });
    return { operations, kills };
  }

  test('is gone when the process became a zombie meanwhile, and nothing is signaled', async () => {
    const { operations, kills } = turning([{ pid: 500, state: 'Z' }]);
    await operations.signal(SESSION, 'SIGKILL');
    expect(kills).toEqual([]);
  });

  test('fails the pass when the process is still live, and nothing is signaled', async () => {
    const { operations, kills } = turning([{ pid: 500, state: 'S' }]);
    const failure = await rejectionOf(Promise.resolve(operations.signal(SESSION, 'SIGKILL')));
    expect((failure as Error).message).toContain('could not be read');
    expect(kills).toEqual([]);
  });
});

describe('a session that cannot be read', () => {
  test('a process macOS is tearing down is gone, though it is not yet a zombie', async () => {
    const operations = createSessionOperations({
      readStates: () => [{ pid: 500, state: '?NEs' }],
      sessionOf: () => {
        throw new Error('could not be read');
      },
      kill: () => undefined,
    });
    expect(await operations.exists(SESSION)).toBe(false);
  });

  test('is not the same as a process that is gone: only ESRCH says gone', () => {
    const lookup = (getsidResult: number, killResult: 'ESRCH' | 'EPERM' | 'ok') =>
      createSessionOf(
        () => getsidResult,
        () => {
          if (killResult !== 'ok') refusal(killResult);
        },
      );
    expect(lookup(77, 'ok')(1)).toBe(77);
    expect(lookup(-1, 'ESRCH')(1)).toBe(-1);
    expect(() => lookup(-1, 'ok')(1)).toThrow('could not be read');
    expect(() => lookup(-1, 'EPERM')(1)).toThrow('could not be read');
  });

  test('a live process whose session cannot be read keeps the session present and fails a signal pass', async () => {
    const unreadable = createSessionOperations({
      readStates: () => [{ pid: 500, state: 'S' }],
      sessionOf: () => {
        throw new Error('could not be read');
      },
      kill: () => undefined,
    });
    expect(await unreadable.exists(SESSION)).toBe(true);
    const failure = await rejectionOf(Promise.resolve(unreadable.signal(SESSION, 'SIGKILL')));
    expect((failure as Error).message).toBe('the process table could not be read');
  });

  test('a process that became a zombie meanwhile is gone, not unreadable', async () => {
    let reads = 0;
    const operations = createSessionOperations({
      readStates: () => {
        reads += 1;
        return [{ pid: 500, state: reads === 1 ? 'S' : 'Z' }];
      },
      sessionOf: () => {
        throw new Error('could not be read');
      },
      kill: () => undefined,
    });
    expect(await operations.exists(SESSION)).toBe(false);
  });

  // spawn-free: the table and the process states are injected, so no process is started
  test('a process that exits while the table is read is dropped, and a live one is not clean', async () => {
    const table = [
      { pid: 1, parentPid: 0, group: 1 },
      { pid: 2, parentPid: 1, group: 2 },
    ];
    const lookup = (pid: number): number => {
      if (pid === 2) throw new Error('could not be read');
      return 500;
    };
    // Live in the first read and a zombie in the second: it was exiting, so it is gone.
    const reads = [
      [
        { pid: 1, state: 'S' },
        { pid: 2, state: 'S' },
      ],
      [
        { pid: 1, state: 'S' },
        { pid: 2, state: 'Z' },
      ],
    ];
    const exiting = await readSessionTable(
      lookup,
      async () => table,
      async () => reads.shift(),
    );
    expect(exiting.map((record) => record.pid)).toEqual([1]);
    // Live in both: its session is unknown, so as a descendant it is an escape, never a member.
    const live = [
      { pid: 1, state: 'S' },
      { pid: 2, state: 'S' },
    ];
    const unknown = await readSessionTable(
      lookup,
      async () => table,
      async () => live,
    );
    expect(unknown.map((record) => [record.pid, record.group])).toEqual([
      [1, 500],
      [2, UNREADABLE_SESSION],
    ]);
    expect(descendantsOutsideGroup(unknown, 1, 500).map((record) => record.pid)).toEqual([2]);
  });
});

describe('the host session lookup', () => {
  test('answers the session of a process, this one included, and -1 for none', () => {
    expect(sessionOfProcess(process.pid)).toBeGreaterThan(0);
    expect(sessionOfProcess(2_147_483_646)).toBe(-1);
  });
});

/** Start a session leader that has a job in a group of its own, and an unrelated process in another session. */
function startSessions() {
  const leader = Bun.spawn(['sh', '-c', 'set -m; sleep 7919 & printf "job=%s\\n" "$!"; wait'], {
    detached: true,
    stdout: 'pipe',
    stderr: 'ignore',
    stdin: 'ignore',
    timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
  });
  const unrelated = Bun.spawn(['sleep', '7919'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
  });
  return { leader, unrelated };
}

const scenario5 = scenario(
  'ends the leader and its job, and leaves a process in another session alone',
  async () => {
    const { leader, unrelated } = startSessions();
    const reader = leader.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    const job = Number(new TextDecoder().decode(first.value).match(/job=(\d+)/)?.[1]);
    try {
      expect(sessionOfProcess(job)).toBe(leader.pid);
      expect(sessionOfProcess(unrelated.pid)).not.toBe(leader.pid);
      sessionOperations.hangUp(leader.pid);
      const outcome = await terminateProcessGroup({
        group: leader.pid,
        operations: sessionOperations,
        clock: systemClock,
        graceMilliseconds: 200,
        observationMilliseconds: 2_000,
        pollMilliseconds: 20,
      });
      expect(outcome).toBe('complete');
      await leader.exited;
      await waitUntilGone(job);
      expect(unrelated.exitCode).toBeNull();
      expect(await sessionOperations.exists(leader.pid)).toBe(false);
    } finally {
      unrelated.kill('SIGKILL');
      leader.kill('SIGKILL');
      // Already gone when the termination worked: ESRCH is the expected answer.
      if (isAlive(job)) process.kill(job, 'SIGKILL');
    }
  },
);

describe('terminating a real session', () => {
  scenarioResult(
    'ends the leader and its job, and leaves a process in another session alone',
    scenario5,
  );
});

await settleScenarios();
