import { describe, expect, test } from 'bun:test';

import { HANG_GUARD_MILLISECONDS } from '../testing/testing/src/hang-guard.ts';
import { waitUntil } from '../testing/testing/src/wait-until.ts';
import type { ProcessEntry, ProcessTable } from './bun-test-pool.ts';
import { TEST_TIMEOUT_MILLISECONDS } from './test-deadlines.ts';
import {
  advanceStalls,
  defaultMemoryCeilingBytes,
  describeMemoryRunaway,
  describeStall,
  memoryCeilingBytes,
  memoryCeilingVariable,
  parseHeartbeat,
  parseLinuxProcessMemory,
  parseProcessorTime,
  processTreeOf,
  sampleTree,
  stallGuardMilliseconds,
  startTestWatchdog,
  type StallState,
} from './test-watchdog.ts';

function entry(parent: number, overrides: Partial<ProcessEntry> = {}): ProcessEntry {
  return { parent, processGroup: parent, startedAt: 'then', ...overrides };
}

describe('parseProcessorTime', () => {
  test('reads the forms ps prints on macOS and Linux', () => {
    expect(parseProcessorTime('0:00.01')).toBe(10);
    expect(parseProcessorTime('3:23.72')).toBe(203_720);
    expect(parseProcessorTime('1:02:03')).toBe(3_723_000);
    expect(parseProcessorTime('00:00:07')).toBe(7000);
    expect(parseProcessorTime('2-01:00:00.50')).toBe(2 * 86_400_000 + 3_600_000 + 500);
  });

  test('reads nothing from text that is not a time', () => {
    expect(parseProcessorTime('')).toBeUndefined();
    expect(parseProcessorTime('bun')).toBeUndefined();
    expect(parseProcessorTime('1:xx')).toBeUndefined();
  });
});

describe('parseLinuxProcessMemory', () => {
  test('adds swapped memory to resident memory', () => {
    const status = 'Name:\tbun\nVmRSS:\t  204800 kB\nRssAnon:\t 1000 kB\nVmSwap:\t  102400 kB\n';
    expect(parseLinuxProcessMemory(status)).toBe((204_800 + 102_400) * 1024);
  });

  test('reads resident memory alone when the kernel reports no swap line', () => {
    expect(parseLinuxProcessMemory('VmRSS:\t 10 kB\n')).toBe(10 * 1024);
  });

  test('reads nothing from a kernel thread, which has no memory lines', () => {
    expect(parseLinuxProcessMemory('Name:\tkthreadd\n')).toBeUndefined();
  });
});

describe('processTreeOf', () => {
  const table: ProcessTable = new Map([
    [1, entry(0)],
    [10, entry(1, { processGroup: 10 })],
    [11, entry(10, { processGroup: 10 })],
    // A Bun test worker leads a process group of its own.
    [12, entry(10, { processGroup: 12 })],
    [13, entry(12, { processGroup: 12 })],
    // Reparented, but still in the leader's process group.
    [14, entry(1, { processGroup: 10 })],
    [20, entry(1, { processGroup: 20 })],
    [21, entry(20, { processGroup: 20 })],
  ]);

  test('is the leader, its descendants, and its process group', () => {
    expect(processTreeOf(10, table).toSorted((a, b) => a - b)).toEqual([10, 11, 12, 13, 14]);
  });

  test('is empty once the leader and its group are gone', () => {
    expect(processTreeOf(99, table)).toEqual([]);
  });
});

describe('sampleTree', () => {
  const table: ProcessTable = new Map([
    [10, entry(1, { processGroup: 10, residentBytes: 100, cpuMilliseconds: 5 })],
    [11, entry(10, { processGroup: 10, residentBytes: 300, cpuMilliseconds: 7 })],
    [12, entry(10, { processGroup: 12, residentBytes: 50 })],
    [20, entry(1, { processGroup: 20, residentBytes: 9999 })],
  ]);

  test('counts the footprint where it can be read, since resident memory misses compressed pages', () => {
    const sample = sampleTree(10, table, (pid) => (pid === 11 ? 5000 : undefined));
    expect(sample.totalBytes).toBe(100 + 5000 + 50);
    expect(sample.processes.find((process) => process.pid === 11)?.memoryBytes).toBe(5000);
  });

  test('never counts less than the resident memory ps reports', () => {
    expect(sampleTree(10, table, () => 1).totalBytes).toBe(100 + 300 + 50);
  });

  test('counts nothing outside the tree', () => {
    expect(sampleTree(10, table, () => undefined).processes.map((process) => process.pid)).toEqual([
      10, 11, 12,
    ]);
  });
});

describe('memoryCeilingBytes', () => {
  test('is the default unless the variable is a positive whole number of megabytes', () => {
    expect(memoryCeilingBytes({})).toBe(defaultMemoryCeilingBytes);
    expect(memoryCeilingBytes({ [memoryCeilingVariable]: '512' })).toBe(512 * 1024 ** 2);
    for (const value of ['', '0', '-1', '1.5', 'lots']) {
      expect(memoryCeilingBytes({ [memoryCeilingVariable]: value })).toBe(
        defaultMemoryCeilingBytes,
      );
    }
  });
});

describe('parseHeartbeat', () => {
  test('reads the first line and ignores what an earlier, longer record left behind', () => {
    expect(parseHeartbeat('7\trunning\t/repository/a.test.ts\n-longer-record.test.ts\n')).toEqual({
      sequence: 7,
      state: 'running',
      file: '/repository/a.test.ts',
    });
  });

  test('reads nothing from a record that is not whole yet', () => {
    expect(parseHeartbeat('')).toBeUndefined();
    expect(parseHeartbeat('7\trunning\t/repository/a.test.ts')).toBeUndefined();
    expect(parseHeartbeat('x\trunning\ta\n')).toBeUndefined();
  });
});

describe('advanceStalls', () => {
  const guard = { milliseconds: 1000, processorShare: 0.5 };
  const observe = (sequence: number, cpuMilliseconds: number | undefined) => [
    { pid: 5, startedAt: 'then', sequence, file: 'a.test.ts', state: 'running', cpuMilliseconds },
  ];

  test('the stall guard is the per-test deadline plus the hang guard, never a new bound', () => {
    expect(stallGuardMilliseconds).toBe(TEST_TIMEOUT_MILLISECONDS + HANG_GUARD_MILLISECONDS);
  });

  test('reports a process that burns processor time for the whole guard without finishing a test', () => {
    const state: StallState = new Map();
    expect(advanceStalls(state, observe(1, 0), 250, guard)).toEqual([]);
    expect(advanceStalls(state, observe(1, 250), 250, guard)).toEqual([]);
    expect(advanceStalls(state, observe(1, 500), 250, guard)).toEqual([]);
    expect(advanceStalls(state, observe(1, 750), 250, guard)).toEqual([]);
    const stalled = advanceStalls(state, observe(1, 1000), 250, guard);
    expect(stalled).toEqual([
      { pid: 5, startedAt: 'then', file: 'a.test.ts', state: 'running', awakeMilliseconds: 1000 },
    ]);
  });

  test('starts over whenever a test starts or finishes', () => {
    const state: StallState = new Map();
    for (let tick = 0; tick < 20; tick += 1) {
      expect(advanceStalls(state, observe(tick, tick * 250), 250, guard)).toEqual([]);
    }
  });

  test('never reports an idle process: its own deadline can still fire', () => {
    const state: StallState = new Map();
    for (let tick = 0; tick < 20; tick += 1) {
      expect(advanceStalls(state, observe(1, 10), 250, guard)).toEqual([]);
    }
  });

  test('never reports a process whose processor time cannot be read', () => {
    const state: StallState = new Map();
    for (let tick = 0; tick < 20; tick += 1) {
      expect(advanceStalls(state, observe(1, undefined), 250, guard)).toEqual([]);
    }
  });

  test('counts only the awake time it is credited, so a host that slept trips nothing', () => {
    const state: StallState = new Map();
    advanceStalls(state, observe(1, 0), 0, guard);
    // The sampler credits one interval per tick, however long the gap was.
    expect(advanceStalls(state, observe(1, 5000), 250, guard)).toEqual([]);
  });

  test('forgets a process that is gone, and a recycled pid starts over', () => {
    const state: StallState = new Map();
    advanceStalls(state, observe(1, 0), 900, guard);
    advanceStalls(state, [], 900, guard);
    expect(state.size).toBe(0);
    advanceStalls(state, observe(1, 0), 900, guard);
    const recycled = [{ ...observe(1, 900)[0]!, startedAt: 'later' }];
    expect(advanceStalls(state, recycled, 900, guard)).toEqual([]);
  });
});

describe('startTestWatchdog', () => {
  const gigabyte = 1024 ** 3;
  const run = (startedAt: string, residentBytes: number): ProcessTable =>
    new Map([
      [10, entry(1, { processGroup: 10, startedAt, residentBytes })],
      [11, entry(10, { processGroup: 10, startedAt, residentBytes })],
    ]);

  function watch(tables: (look: number) => ProcessTable) {
    const sent: [number, NodeJS.Signals][] = [];
    let looks = 0;
    const watchdog = startTestWatchdog({
      leader: 10,
      readProcessTable: () => {
        looks += 1;
        return tables(looks);
      },
      ceilingBytes: gigabyte,
      run: 'src',
      sampleIntervalMilliseconds: 1,
      readFootprint: () => undefined,
      signal: (pid, name) => sent.push([pid, name]),
    });
    return { sent, watchdog, looks: () => looks };
  }

  test('kills the process group and each process of the tree once the tree passes the ceiling', async () => {
    const { sent, watchdog } = watch(() => run('then', gigabyte));
    const outcome = await watchdog.stop();
    expect(sent).toEqual([
      [-10, 'SIGKILL'],
      [10, 'SIGKILL'],
      [11, 'SIGKILL'],
    ]);
    expect(outcome.killed).toContain('above the 1.0 GiB ceiling');
    expect(outcome.peakBytes).toBe(2 * gigabyte);
  });

  test('never signals once the pid of the leader belongs to another process', async () => {
    // The run was small, and it is gone; a large process group now has its leader's pid.
    const { sent, watchdog, looks } = watch((look) =>
      look === 1 ? run('then', 1024) : run('later', gigabyte),
    );
    await waitUntil(() => looks() >= 3, { message: 'the watchdog looked again' });
    const outcome = await watchdog.stop();
    expect(sent).toEqual([]);
    expect(outcome.killed).toBeUndefined();
    expect(outcome.peakBytes).toBe(2048);
  });
});

describe('the lines a killed run prints', () => {
  test('a memory runaway names the files, the memory, the ceiling, and that it is no flake', () => {
    const line = describeMemoryRunaway({
      totalBytes: 3 * 1024 ** 3,
      ceilingBytes: 2 * 1024 ** 3,
      files: ['src/a.test.ts', 'src/b.test.ts'],
      run: 'src',
    });
    expect(line).toContain('3.0 GiB');
    expect(line).toContain('2.0 GiB ceiling');
    expect(line).toContain('src/a.test.ts, src/b.test.ts');
    expect(line).toContain('runaway');
    expect(line).toContain('not a flake');
    expect(line).toContain(memoryCeilingVariable);
    expect(line).not.toContain('\n');
  });

  test('a memory runaway before any test reported names the run instead', () => {
    const line = describeMemoryRunaway({
      totalBytes: 3 * 1024 ** 3,
      ceilingBytes: 2 * 1024 ** 3,
      files: [],
      run: '--parallel=4 src',
    });
    expect(line).toContain('--parallel=4 src');
  });

  test('a stall says the per-test deadline could not fire', () => {
    const line = describeStall({
      stalled: [
        {
          pid: 5,
          startedAt: 'then',
          file: 'a.test.ts',
          state: 'running',
          awakeMilliseconds: 360_000,
        },
      ],
      guardMilliseconds: 360_000,
    });
    expect(line).toContain('a.test.ts');
    expect(line).toContain('per-test deadline could not fire');
    expect(line).toContain('360 s');
    expect(line).toContain('not a flake');
    expect(line).not.toContain('\n');
  });
});
