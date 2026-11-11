import type { Subprocess } from 'bun';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWithHangGuard } from '../testing/testing/src/hang-guard.ts';
import { rejectionOf } from '../testing/testing/src/helpers/promise-outcome.ts';
import { waitUntil } from '../testing/testing/src/wait-until.ts';
import {
  acquireTestSlots,
  claimSlots,
  defaultPoolSize,
  describePool,
  heldSlotsTokenVariable,
  poolSize,
  readProcessTable,
  requestedWorkers,
  runPooledBunTest,
  slotDirectory,
  withWorkerCount,
  type AcquireTestSlotsOptions,
  type ProcessTable,
  type SlotOwner,
} from './bun-test-pool.ts';
import { acquireHostLock, ownerFileName, type HostLockHolder } from './run-exclusively.ts';

/**
 * The pool's scenarios. Each owns a scratch pool directory, never the real Git common directory.
 * Liveness comes from an injected process table where the scenario is about the pool's logic, and
 * from the real one where it is about real processes; waiting is on state, through `onWait`,
 * `report` and `waitUntil`, and a waiter's poll yields a turn instead of sleeping.
 */
const scratchDirectories: string[] = [];
const processGroups: number[] = [];

afterAll(async () => {
  for (const group of processGroups) killGroup(group);
  for (const directory of scratchDirectories) await rm(directory, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-test-slots-'));
  scratchDirectories.push(directory);
  return directory;
}

function holder(cwd: string, pid = process.pid): HostLockHolder {
  return { pid, command: 'test', cwd, acquiredAt: new Date(0).toISOString() };
}

/** A process table in which only this process is alive. */
const onlyThisProcess = (): ProcessTable =>
  new Map([[process.pid, { processGroup: process.pid, startedAt: 'this process' }]]);

/** A waiter's poll: one filesystem round trip, which lets every other waiter run, and no clock. */
const turn = async (): Promise<void> => {
  await stat(tmpdir());
};

const neverSleep = async (): Promise<void> => {
  throw new Error('the waiter waited');
};

function options(
  poolDirectory: string,
  size: number,
  slots: number,
  overrides: Partial<AcquireTestSlotsOptions> = {},
): AcquireTestSlotsOptions {
  return {
    poolDirectory,
    size,
    slots,
    holder: holder(poolDirectory),
    readProcessTable: onlyThisProcess,
    sleep: turn,
    ...overrides,
  };
}

async function heldSlots(poolDirectory: string): Promise<number> {
  const names = await readdir(poolDirectory).catch(() => [] as string[]);
  return names.filter((name) => /^slot-\d+$/.test(name)).length;
}

async function writeSlot(poolDirectory: string, index: number, contents: string): Promise<void> {
  await mkdir(slotDirectory(poolDirectory, index), { recursive: true });
  await writeFile(join(slotDirectory(poolDirectory, index), ownerFileName), contents);
}

function owner(poolDirectory: string, fields: Partial<SlotOwner>): string {
  return JSON.stringify({ ...holder(poolDirectory), token: 'other', slots: 1, ...fields });
}

function killGroup(processGroup: number): void {
  try {
    process.kill(-processGroup, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

function isGroupAlive(processGroup: number): boolean {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch {
    return false;
  }
}

async function exitedPid(): Promise<number> {
  const child = spawnWithHangGuard(['true']);
  await child.exited;
  return child.pid;
}

/** Starts a real pooled run of `sleep 30` with a pool of one, and resolves once its group is recorded. */
async function startPooledRun(
  poolDirectory: string,
): Promise<{ wrapper: Subprocess; processGroup: number }> {
  const fixture = join(poolDirectory, '..', 'pooled-run.ts');
  await writeFile(
    fixture,
    `import { runPooledBunTest } from ${JSON.stringify(join(import.meta.dir, 'bun-test-pool.ts'))};
process.exitCode = await runPooledBunTest({
  bunTestArguments: [],
  command: ['sh', '-c', 'sleep 30'],
  poolDirectory: process.argv[2],
  size: 1,
  pollIntervalMs: 5,
  report: () => {},
});
`,
  );
  const wrapper = spawnWithHangGuard([process.execPath, fixture, poolDirectory], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let processGroup: number | undefined;
  await waitUntil(
    async () => {
      const contents = await readFile(
        join(slotDirectory(poolDirectory, 0), ownerFileName),
        'utf8',
      ).catch(() => '');
      processGroup = contents === '' ? undefined : JSON.parse(contents).processGroup;
      return processGroup !== undefined;
    },
    { message: 'the pooled run recorded its process group' },
  );
  if (processGroup === undefined) throw new Error('unreachable');
  processGroups.push(processGroup);
  return { wrapper, processGroup };
}

describe('the pool size', () => {
  test('sizes the pool from processors and memory, and honours the override', () => {
    const gibibytes = (count: number) => count * 1024 ** 3;
    expect(defaultPoolSize({ processors: 12, totalMemoryBytes: gibibytes(32) })).toBe(10);
    expect(defaultPoolSize({ processors: 4, totalMemoryBytes: gibibytes(16) })).toBe(4);
    expect(defaultPoolSize({ processors: 64, totalMemoryBytes: gibibytes(32) })).toBe(10);
    expect(defaultPoolSize({ processors: 2, totalMemoryBytes: gibibytes(4) })).toBe(4);
    const host = { processors: 12, totalMemoryBytes: gibibytes(32) };
    expect(poolSize({ CORVIDAE_TEST_SLOTS: '3' }, host)).toBe(3);
    expect(poolSize({ CORVIDAE_TEST_SLOTS: '0' }, host)).toBe(10);
    expect(poolSize({ CORVIDAE_TEST_SLOTS: 'many' }, host)).toBe(10);
  });

  test('counts workers from --parallel, bare --parallel, and its absence', () => {
    expect(requestedWorkers(['src'], 12)).toBe(1);
    expect(requestedWorkers(['--parallel=1', 'src'], 12)).toBe(1);
    expect(requestedWorkers(['--parallel=4', '--parallel-delay=5'], 12)).toBe(4);
    expect(requestedWorkers(['--parallel'], 12)).toBe(12);
    expect(withWorkerCount(['--parallel', '--parallel-delay=5', 'src'], 3)).toEqual([
      '--parallel=3',
      '--parallel-delay=5',
      'src',
    ]);
  });
});

describe('acquiring slots', () => {
  test('three runs of four workers share a pool of eight two at a time', async () => {
    const pool = join(await scratch(), 'pool');
    const first = await acquireTestSlots(options(pool, 8, 4));
    const second = await acquireTestSlots(options(pool, 8, 4));
    const { promise: waiting, resolve: markWaiting } = Promise.withResolvers<void>();
    let thirdHeld = false;
    const third = acquireTestSlots(options(pool, 8, 4, { onWait: () => markWaiting() })).then(
      (held) => {
        thirdHeld = true;
        return held;
      },
    );
    await waiting;
    expect(thirdHeld).toBe(false);
    expect(await heldSlots(pool)).toBe(8);
    await first.release();
    const held = await third;
    expect(await heldSlots(pool)).toBe(8);
    await Promise.all([second.release(), held.release()]);
    expect(await heldSlots(pool)).toBe(0);
  });

  test('eight concurrent runs never hold more than the pool', async () => {
    const pool = join(await scratch(), 'pool');
    const size = 5;
    let held = 0;
    let mostHeld = 0;
    const observed: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const slots = 1 + (index % 4);
        const lease = await acquireTestSlots(options(pool, size, slots));
        held += slots;
        mostHeld = Math.max(mostHeld, held);
        observed.push(await heldSlots(pool));
        await turn();
        held -= slots;
        await lease.release();
      }),
    );
    expect(mostHeld).toBeLessThanOrEqual(size);
    expect(Math.max(...observed)).toBeLessThanOrEqual(size);
    expect(observed).toHaveLength(8);
    expect(await heldSlots(pool)).toBe(0);
  });

  test('grants slots in arrival order, so neither a large nor a small request starves', async () => {
    const pool = join(await scratch(), 'pool');
    const order: string[] = [];
    const holding = await acquireTestSlots(options(pool, 4, 3));
    const waitingLines: Record<string, string[]> = { large: [], small: [] };
    const start = async (name: 'large' | 'small', slots: number) => {
      const { promise: waiting, resolve } = Promise.withResolvers<void>();
      const lease = acquireTestSlots(
        options(pool, 4, slots, {
          onWait: (line) => {
            waitingLines[name]?.push(line);
            resolve();
          },
        }),
      ).then((held) => {
        order.push(name);
        return held;
      });
      await waiting;
      // Wrapped, because an async function that returns a promise waits for it.
      return { lease };
    };
    const large = await start('large', 4);
    // One slot is free, but the small request arrived after the large one and must wait its turn.
    const small = await start('small', 1);
    expect(waitingLines['small']?.[0]).toStartWith('queued behind');
    expect(order).toEqual([]);
    await holding.release();
    const largeLease = await large.lease;
    await largeLease.release();
    const smallLease = await small.lease;
    await smallLease.release();
    expect(order).toEqual(['large', 'small']);
  });

  test('two claims racing for the same slots never both hold them', async () => {
    const pool = join(await scratch(), 'pool');
    await mkdir(pool);
    const claimant = (token: string): SlotOwner => ({ ...holder(pool), token, slots: 2 });
    const results = await Promise.all([
      claimSlots(pool, [0, 1, 2], 2, claimant('a')),
      claimSlots(pool, [0, 1, 2], 2, claimant('b')),
    ]);
    const winners = results.filter((taken) => taken !== undefined);
    expect(winners).toHaveLength(1);
    expect(await heldSlots(pool)).toBe(2);
  });
});

describe('reclaiming slots', () => {
  test('reclaims a slot whose holder has exited without waiting', async () => {
    const pool = join(await scratch(), 'pool');
    await writeSlot(pool, 0, owner(pool, { pid: await exitedPid() }));
    const lease = await acquireTestSlots(options(pool, 1, 1, { sleep: neverSleep }));
    await lease.release();
  });

  test('does not mistake a recycled pid for a holder', async () => {
    const pool = join(await scratch(), 'pool');
    await writeSlot(pool, 0, owner(pool, { pidStartedAt: 'Thu Jan  1 00:00:00 1970' }));
    const lease = await acquireTestSlots(
      options(pool, 1, 1, { sleep: neverSleep, readProcessTable }),
    );
    await lease.release();
  });

  test('a killed wrapper keeps its slots until its process group is gone, then frees them', async () => {
    const pool = join(await scratch(), 'pool');
    const { wrapper, processGroup } = await startPooledRun(pool);
    wrapper.kill('SIGKILL');
    await wrapper.exited;
    const controller = new AbortController();
    const blocked = rejectionOf(
      acquireTestSlots(
        options(pool, 1, 1, {
          readProcessTable,
          signal: controller.signal,
          onWait: () => controller.abort(),
        }),
      ),
    );
    expect(await blocked).toBeInstanceOf(Error);
    killGroup(processGroup);
    const lease = await acquireTestSlots(options(pool, 1, 1, { readProcessTable }));
    await lease.release();
  });

  test('creates a missing pool directory', async () => {
    const pool = join(await scratch(), 'missing', 'pool');
    const lease = await acquireTestSlots(options(pool, 2, 2, { sleep: neverSleep }));
    expect(await heldSlots(pool)).toBe(2);
    await lease.release();
  });

  test('treats garbage in the pool as free slots', async () => {
    const pool = join(await scratch(), 'pool');
    await mkdir(join(pool, 'queue'), { recursive: true });
    await writeFile(slotDirectory(pool, 0), 'a stray file');
    await writeSlot(pool, 1, 'not json');
    await writeFile(join(pool, 'queue', 'stray.txt'), '');
    await writeFile(join(pool, 'queue', '0000000000000001-bad.json'), 'not json');
    const lease = await acquireTestSlots(options(pool, 2, 2, { sleep: neverSleep }));
    expect(lease.slots).toEqual([0, 1]);
    await lease.release();
    expect(await readdir(join(pool, 'queue'))).toEqual(['stray.txt']);
  });
});

describe('running a pooled bun test', () => {
  test('returns the exit code and releases the slots', async () => {
    const directory = await scratch();
    const pool = join(directory, 'pool');
    const groupFile = join(directory, 'group');
    const code = await runPooledBunTest({
      bunTestArguments: [],
      command: ['sh', '-c', `sleep 30 & echo $$ > '${groupFile}'; exit 3`],
      poolDirectory: pool,
      size: 2,
      report: () => {},
    });
    expect(code).toBe(3);
    expect(isGroupAlive(Number(await readFile(groupFile, 'utf8')))).toBe(false);
    expect(await heldSlots(pool)).toBe(0);
  });

  test('clamps a request above the pool to the pool and passes the clamped worker count', async () => {
    const directory = await scratch();
    const pool = join(directory, 'pool');
    const output = join(directory, 'output');
    const reports: string[] = [];
    const code = await runPooledBunTest({
      bunTestArguments: ['--parallel=8'],
      command: ['sh', '-c', `{ printf '%s\\n' "$@"; ls '${pool}'; } > '${output}'`, 'sh'],
      poolDirectory: pool,
      size: 4,
      report: (line) => reports.push(line),
    });
    expect(code).toBe(0);
    const written = await readFile(output, 'utf8');
    const lines = written.trim().split('\n');
    expect(lines[0]).toBe('--parallel=4');
    expect(lines.filter((line) => /^slot-\d+$/.test(line))).toHaveLength(4);
    expect(reports).toEqual(['bun-test-pool: running 4 workers, the size of the pool, not 8']);
  });

  test('a run started under a held slot reuses it instead of waiting on its parent', async () => {
    const directory = await scratch();
    const pool = join(directory, 'pool');
    await writeSlot(pool, 0, owner(pool, { token: 'parent' }));
    const code = await runPooledBunTest({
      bunTestArguments: [],
      command: ['sh', '-c', 'exit 7'],
      environment: { [heldSlotsTokenVariable]: 'parent' },
      poolDirectory: pool,
      size: 1,
      readProcessTable: onlyThisProcess,
      report: () => {},
    });
    expect(code).toBe(7);
    const recorded = JSON.parse(
      await readFile(join(slotDirectory(pool, 0), ownerFileName), 'utf8'),
    );
    expect(recorded.token).toBe('parent');
  });

  test('a token naming no live holder does not bypass the pool', async () => {
    const directory = await scratch();
    const pool = join(directory, 'pool');
    await writeSlot(pool, 0, owner(pool, { token: 'holder' }));
    const reports: string[] = [];
    const { promise: waiting, resolve: markWaiting } = Promise.withResolvers<void>();
    const running = runPooledBunTest({
      bunTestArguments: [],
      command: ['sh', '-c', 'exit 0'],
      environment: { [heldSlotsTokenVariable]: 'gone' },
      poolDirectory: pool,
      size: 1,
      pollIntervalMs: 1,
      readProcessTable: onlyThisProcess,
      report: (line) => {
        reports.push(line);
        markWaiting();
      },
    });
    await waiting;
    expect(reports[0]).toContain('waiting for 1 of 1 test slots');
    await rm(slotDirectory(pool, 0), { recursive: true });
    expect(await running).toBe(0);
  });

  test('exports its token to the tests it runs', async () => {
    const directory = await scratch();
    const output = join(directory, 'token');
    await runPooledBunTest({
      bunTestArguments: [],
      command: ['sh', '-c', `printf '%s' "$${heldSlotsTokenVariable}" > '${output}'`],
      poolDirectory: join(directory, 'pool'),
      size: 1,
      report: () => {},
    });
    const token = await readFile(output, 'utf8');
    expect(token.length).toBeGreaterThan(0);
  });

  test('runs without a slot, with a warning, when the pool cannot be used', async () => {
    const directory = await scratch();
    const blocked = join(directory, 'a-file');
    await writeFile(blocked, '');
    const reports: string[] = [];
    const code = await runPooledBunTest({
      bunTestArguments: [],
      command: ['sh', '-c', 'exit 5'],
      poolDirectory: join(blocked, 'pool'),
      size: 1,
      report: (line) => reports.push(line),
    });
    expect(code).toBe(5);
    expect(reports.join('\n')).toContain('bun-test-pool: running without a test slot');
  });

  test('a pooled run never waits on the host lock', async () => {
    const directory = await scratch();
    const lock = await acquireHostLock({
      lockDirectory: join(directory, 'host-lock'),
      holder: holder(directory),
    });
    try {
      const code = await runPooledBunTest({
        bunTestArguments: [],
        command: ['sh', '-c', 'exit 0'],
        poolDirectory: join(directory, 'pool'),
        size: 1,
        report: () => {},
      });
      expect(code).toBe(0);
    } finally {
      await lock.release();
    }
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    test(`a signal to the wrapper reaches the test process group and releases its slots (${signal})`, async () => {
      const pool = join(await scratch(), 'pool');
      const { wrapper, processGroup } = await startPooledRun(pool);
      wrapper.kill(signal);
      await wrapper.exited;
      expect(isGroupAlive(processGroup)).toBe(false);
      expect(await heldSlots(pool)).toBe(0);
    });
  }
});

describe('the boundary of the pool', () => {
  test('tsc, svelte-check and Playwright never take test slots', async () => {
    const manifests = ['package.json'];
    for await (const path of new Bun.Glob(
      '{applications,components,packages,testing,internal,plugins}/*/package.json',
    ).scan({ cwd: join(import.meta.dir, '..') })) {
      manifests.push(path);
    }
    const offenders: string[] = [];
    let checked = 0;
    for (const manifest of manifests) {
      const parsed: { scripts?: Record<string, string> } = await Bun.file(
        join(import.meta.dir, '..', manifest),
      ).json();
      const scripts = parsed.scripts ?? {};
      for (const [name, command] of Object.entries(scripts)) {
        if (!/\b(?:tsc|svelte-check)\b|playwright test/.test(command)) continue;
        checked += 1;
        if (/bun-test(?:-junit|-selected|-pool)?\.ts/.test(command)) {
          offenders.push(`${manifest} ${name}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});

describe('the status of the pool', () => {
  test('prints holders and free slots', async () => {
    const pool = join(await scratch(), 'pool');
    const record = {
      pid: process.pid,
      cwd: '/worktrees/one',
      command: '--parallel=4 src',
      acquiredAt: new Date(10_000).toISOString(),
    };
    await writeSlot(pool, 0, owner(pool, { ...record, token: 'run', slots: 2 }));
    await writeSlot(pool, 1, owner(pool, { ...record, token: 'run', slots: 2 }));
    const lines = await describePool(pool, 5, onlyThisProcess(), 25_000);
    expect(lines).toEqual([
      `test slot pool ${pool}: 2 of 5 held, 3 free, 0 waiting`,
      `  pid ${process.pid} holds 2 slot(s) for 15s in /worktrees/one: --parallel=4 src`,
    ]);
  });

  test('the status command exits 0', async () => {
    const pool = join(await scratch(), 'pool');
    const status = spawnWithHangGuard(
      [
        process.execPath,
        join(import.meta.dir, 'bun-test-pool.ts'),
        'status',
        '--pool',
        pool,
        '--size',
        '3',
      ],
      { stdout: 'pipe', stderr: 'inherit' },
    );
    const output = await new Response(status.stdout).text();
    expect(await status.exited).toBe(0);
    expect(output).toBe(`test slot pool ${pool}: 0 of 3 held, 3 free, 0 waiting\n`);
  });
});
