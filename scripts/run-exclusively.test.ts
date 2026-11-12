import { describe, expect, test } from 'bun:test';

import {
  ancestorsOf,
  awaitMemory,
  describeMemory,
  memoryAdmittedVariable,
  memoryShortfall,
  parseDarwinMemory,
  parseLinuxMemory,
  watchForOrphaning,
  type MemoryReading,
} from './run-exclusively.ts';

const gibibyte = 1024 ** 3;

/** `sysctl` on this 32 GB host on 2026-11-12: swap mostly used, yet the kernel reports no pressure. */
const quietDarwinHost = [
  'kern.memorystatus_level: 59',
  'kern.memorystatus_vm_pressure_level: 1',
  'vm.swapusage: total = 12288.00M  used = 10599.06M  free = 1688.94M  (encrypted)',
  'hw.memsize: 34359738368',
].join('\n');

function darwinHost(level: number, pressure: number): string {
  return quietDarwinHost
    .replace('memorystatus_level: 59', `memorystatus_level: ${level}`)
    .replace('pressure_level: 1', `pressure_level: ${pressure}`);
}

describe('memory readings', () => {
  test('reads free memory, the pressure level and swap from sysctl', () => {
    const reading = parseDarwinMemory(quietDarwinHost);
    expect(reading).toEqual({
      totalBytes: 32 * gibibyte,
      availableBytes: Math.round(32 * gibibyte * 0.59),
      pressure: 'normal',
      swapUsedBytes: 10599.06 * 1024 ** 2,
      swapTotalBytes: 12288 * 1024 ** 2,
    });
    expect(describeMemory(reading as MemoryReading)).toBe(
      '18.9 GiB of 32.0 GiB free, pressure normal, swap 10.4 GiB of 12.0 GiB used',
    );
  });

  test('maps the dispatch pressure levels, and reads none it does not know', () => {
    expect(parseDarwinMemory(darwinHost(40, 2))?.pressure).toBe('warning');
    expect(parseDarwinMemory(darwinHost(40, 4))?.pressure).toBe('critical');
    expect(parseDarwinMemory(darwinHost(40, 3))?.pressure).toBeUndefined();
  });

  test('reads nothing from output that lacks the free level or the memory size', () => {
    expect(parseDarwinMemory('hw.memsize: 34359738368')).toBeUndefined();
    expect(parseDarwinMemory('kern.memorystatus_level: 59')).toBeUndefined();
    expect(parseDarwinMemory('')).toBeUndefined();
  });

  test('reads MemAvailable and swap from /proc/meminfo', () => {
    const reading = parseLinuxMemory(
      [
        'MemTotal:       16384000 kB',
        'MemFree:          100000 kB',
        'MemAvailable:    2048000 kB',
        'SwapTotal:       4096000 kB',
        'SwapFree:        1024000 kB',
      ].join('\n'),
    );
    expect(reading).toEqual({
      totalBytes: 16384000 * 1024,
      availableBytes: 2048000 * 1024,
      swapUsedBytes: 3072000 * 1024,
      swapTotalBytes: 4096000 * 1024,
    });
    expect(parseLinuxMemory('MemTotal: 1 kB')).toBeUndefined();
  });
});

describe('memory shortfall', () => {
  test('admits the quiet host even though most of its swap is in use', () => {
    expect(memoryShortfall(parseDarwinMemory(quietDarwinHost) as MemoryReading)).toBeUndefined();
  });

  test('names the kernel pressure level when it is warning or critical', () => {
    const reading = parseDarwinMemory(darwinHost(40, 4)) as MemoryReading;
    expect(memoryShortfall(reading)).toBe(
      'the kernel reports critical memory pressure (kern.memorystatus_vm_pressure_level)',
    );
  });

  test('names the free memory when it is below what a stage needs', () => {
    const reading = parseDarwinMemory(darwinHost(5, 1)) as MemoryReading;
    expect(memoryShortfall(reading)).toBe(
      '1.6 GiB of memory is free, below the 4.0 GiB a heavy stage needs',
    );
  });
});

describe('awaitMemory', () => {
  const short = parseDarwinMemory(darwinHost(40, 2)) as MemoryReading;
  const quiet = parseDarwinMemory(quietDarwinHost) as MemoryReading;

  function admission(readings: (MemoryReading | undefined)[], environment = {}) {
    const lines: string[] = [];
    const sleeps: number[] = [];
    let reads = 0;
    const result = awaitMemory({
      label: 'stage',
      environment,
      readMemory: () => {
        reads += 1;
        return readings.length > 1 ? readings.shift() : readings[0];
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      pollIntervalMs: 5_000,
      maximumWaitMs: 60_000,
      report: (line) => lines.push(line),
    });
    return { result, lines, sleeps, reads: () => reads };
  }

  test('admits at once when the host has memory', async () => {
    const run = admission([quiet]);
    expect(await run.result).toEqual({ admitted: true, reason: 'measured' });
    expect(run.sleeps).toEqual([]);
  });

  test('waits on the reading while the host is short, and starts once it recovers', async () => {
    const run = admission([short, short, quiet]);
    expect(await run.result).toEqual({ admitted: true, reason: 'measured' });
    expect(run.sleeps).toEqual([5_000, 5_000]);
    expect(run.lines).toEqual([
      'stage: waiting for memory before starting: the kernel reports warning memory pressure (kern.memorystatus_vm_pressure_level) (12.8 GiB of 32.0 GiB free, pressure warning, swap 10.4 GiB of 12.0 GiB used)',
    ]);
  });

  test('refuses with the measurement once it has waited its whole allowance', async () => {
    const run = admission([short]);
    const result = await run.result;
    expect(result.admitted).toBe(false);
    expect(run.sleeps).toHaveLength(12);
    expect(result).toMatchObject({
      message: expect.stringContaining(
        'stage: refused to start after waiting 1 minutes for memory: the kernel reports warning memory pressure',
      ),
    });
  });

  test('a stage its parent admitted, and a host whose memory cannot be read, start at once', async () => {
    const nested = admission([short], { [memoryAdmittedVariable]: '1' });
    expect(await nested.result).toEqual({ admitted: true, reason: 'nested' });
    expect(nested.reads()).toBe(0);
    const unread = admission([undefined]);
    expect(await unread.result).toEqual({ admitted: true, reason: 'unread' });
  });

  test('on CI it reads once, reports, and starts without waiting', async () => {
    const lines: string[] = [];
    const result = await awaitMemory({
      label: 'stage',
      environment: { CI: 'true' },
      readMemory: () => short,
      sleep: async () => {
        throw new Error('waited on CI');
      },
      report: (line) => lines.push(line),
    });
    expect(result).toEqual({ admitted: true, reason: 'measured' });
    expect(lines).toEqual([
      'stage: memory on CI, not waited for: 12.8 GiB of 32.0 GiB free, pressure warning, swap 10.4 GiB of 12.0 GiB used',
    ]);
  });

  test('under a test, with no reader passed, it admits without reading the host', async () => {
    expect(process.env['NODE_ENV']).toBe('test');
    const result = await awaitMemory({ label: 'stage', environment: {}, report: () => {} });
    expect(result).toEqual({ admitted: true, reason: 'unread' });
  });
});

describe('orphaned runs', () => {
  test('ancestors stop below pid 1 and survive a cycle in the table', () => {
    const parents = new Map([
      [40, 30],
      [30, 20],
      [20, 1],
      [50, 51],
      [51, 50],
    ]);
    expect(ancestorsOf(40, parents)).toEqual([30, 20]);
    expect(ancestorsOf(50, parents)).toEqual([51]);
    expect(ancestorsOf(99, parents)).toEqual([]);
  });

  test('once an ancestor exits, the run is ended after the hang guard, not before', () => {
    const alive = new Set([30, 20]);
    const events: string[] = [];
    let check: () => void = () => {};
    let elapse: () => void = () => {};
    const stop = watchForOrphaning({
      ancestors: [30, 20],
      isAlive: (pid) => alive.has(pid),
      every: (callback) => {
        check = callback;
        return () => events.push('stopped checking');
      },
      afterAwake: (milliseconds, onElapsed) => {
        events.push(`armed ${milliseconds}`);
        elapse = onElapsed;
        return () => events.push('disarmed');
      },
      onOrphaned: (gone) => events.push(`orphaned by ${gone}`),
      onExpired: () => events.push('ended'),
    });
    check();
    expect(events).toEqual([]);
    alive.delete(20);
    check();
    check();
    expect(events).toEqual(['stopped checking', 'orphaned by 20', 'armed 120000']);
    elapse();
    expect(events.at(-1)).toBe('ended');
    stop();
  });

  test('a run that finishes first disarms the guard', () => {
    const events: string[] = [];
    let check: () => void = () => {};
    const stop = watchForOrphaning({
      ancestors: [30],
      isAlive: () => false,
      every: (callback) => {
        check = callback;
        return () => {};
      },
      afterAwake: () => () => events.push('disarmed'),
      onOrphaned: () => events.push('orphaned'),
      onExpired: () => events.push('ended'),
    });
    check();
    stop();
    expect(events).toEqual(['orphaned', 'disarmed']);
  });
});
