import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPooledBunTest } from './bun-test-pool.ts';
import { rootScriptEnvironment } from './environment-configuration.ts';
import { outcomeOf, rethrow } from './module-scope-scenario.test-support.ts';
import { memoryCeilingVariable, runawayExitCode, watchdogReportVariable } from './test-watchdog.ts';

/**
 * The watchdog against real `bun test` runs. Each scenario writes one test file into a scratch
 * directory and runs it through `runPooledBunTest` with a scratch pool, a ceiling or guard far
 * below the defaults, and a fast sample interval, then reads what the run returned and reported.
 * Nothing here measures a duration: a run that is not killed ends on its own, because each fixture
 * limits itself (the allocator stops at a gigabyte, the spinner after a fixed count of passes), and
 * the scenario then fails on the exit code. Scenarios run at module scope, where no per-test clock
 * applies (`scripts/module-scope-scenario.test-support.ts`).
 */
const scratchDirectories: string[] = [];

afterAll(async () => {
  for (const directory of scratchDirectories) await rm(directory, { recursive: true, force: true });
});

type Run = { readonly code: number; readonly reports: string[]; readonly heartbeatsLeft: string[] };

async function runFixture(
  source: string,
  options: {
    readonly ceilingBytes?: number;
    readonly stallGuardMilliseconds?: number;
    readonly environment?: Record<string, string>;
  },
): Promise<Run> {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-test-watchdog-'));
  scratchDirectories.push(directory);
  const heartbeats = join(directory, 'heartbeats');
  await mkdir(heartbeats);
  await writeFile(join(directory, 'fixture.test.ts'), source);
  const reports: string[] = [];
  const code = await runPooledBunTest({
    bunTestArguments: ['./fixture.test.ts'],
    cwd: directory,
    environment: {
      ...rootScriptEnvironment(),
      // The fixture's own failure output is not this run's.
      NO_COLOR: '1',
      // A developer measuring lanes has this set; only the scenario that reads the line keeps it.
      [watchdogReportVariable]: '',
      ...options.environment,
    },
    poolDirectory: join(directory, 'pool'),
    size: 1,
    report: (line) => reports.push(line),
    watchdog: {
      heartbeatParentDirectory: heartbeats,
      sampleIntervalMilliseconds: 50,
      ...(options.ceilingBytes === undefined ? {} : { ceilingBytes: options.ceilingBytes }),
      ...(options.stallGuardMilliseconds === undefined
        ? {}
        : { stallGuardMilliseconds: options.stallGuardMilliseconds }),
    },
  });
  return { code, reports, heartbeatsLeft: await readdir(heartbeats) };
}

// Touches every page it allocates, in a synchronous loop, and gives up at a gigabyte, so a run with
// no watchdog ends by itself.
const allocator = `import { test } from 'bun:test';
test('allocates until something stops it', () => {
  const held: Uint8Array[] = [];
  for (let megabytes = 0; megabytes < 1024; megabytes += 8) {
    const block = new Uint8Array(8 * 1024 * 1024);
    for (let index = 0; index < block.length; index += 1024) block[index] = (index >> 10) & 0xff;
    held.push(block);
    const until = performance.now() + 20;
    while (performance.now() < until);
  }
  if (held.length === 0) throw new Error('unreachable');
});
`;

// Never returns to the event loop until its count of passes is spent, far longer than the guard the
// scenario passes and far shorter than a real hang.
const spinner = `import { test } from 'bun:test';
test('spins without returning to the event loop', () => {
  let passes = 0;
  for (let outer = 0; outer < 4000; outer += 1) {
    const until = performance.now() + 5;
    while (performance.now() < until) passes += 1;
  }
  if (passes === 0) throw new Error('unreachable');
});
`;

const healthy = `import { expect, test } from 'bun:test';
test('one', () => { expect(1).toBe(1); });
test('two', async () => { await Bun.sleep(1); expect(2).toBe(2); });
`;

const killsAMemoryRunaway = await outcomeOf(async () => {
  const run = await runFixture(allocator, { ceilingBytes: 256 * 1024 ** 2 });
  expect(run.code).toBe(runawayExitCode);
  expect(run.reports).toHaveLength(1);
  const [line = ''] = run.reports;
  expect(line).toStartWith('bun-test-pool: killed the test run');
  expect(line).toContain('above the 0.3 GiB ceiling');
  expect(line).toContain('fixture.test.ts');
  expect(line).toContain('not a flake');
  expect(run.heartbeatsLeft).toEqual([]);
});

const readsTheCeilingFromTheEnvironment = await outcomeOf(async () => {
  const run = await runFixture(allocator, { environment: { [memoryCeilingVariable]: '256' } });
  expect(run.code).toBe(runawayExitCode);
  expect(run.reports.join('\n')).toContain(memoryCeilingVariable);
});

const killsABlockedEventLoop = await outcomeOf(async () => {
  const run = await runFixture(spinner, { stallGuardMilliseconds: 1500 });
  expect(run.code).toBe(runawayExitCode);
  expect(run.reports).toHaveLength(1);
  const [line = ''] = run.reports;
  expect(line).toContain('fixture.test.ts');
  expect(line).toContain('inside a test of');
  expect(line).toContain('the per-test deadline could not fire');
  expect(run.heartbeatsLeft).toEqual([]);
});

const leavesAHealthyRunAlone = await outcomeOf(async () => {
  const run = await runFixture(healthy, { environment: { [watchdogReportVariable]: '1' } });
  expect(run.code).toBe(0);
  expect(run.reports).toHaveLength(1);
  expect(run.reports[0]).toMatch(
    /^bun-test-pool: peak memory \d+\.\d GiB of the \d+\.\d GiB ceiling; 1 test process\(es\) reported heartbeats$/,
  );
  expect(run.heartbeatsLeft).toEqual([]);
});

test('kills a run whose memory passes the ceiling and says it is a runaway', () => {
  rethrow(killsAMemoryRunaway);
});

test('reads the ceiling from the environment', () => {
  rethrow(readsTheCeilingFromTheEnvironment);
});

test('kills a run whose test never returns to the event loop', () => {
  rethrow(killsABlockedEventLoop);
});

test('leaves a healthy run alone, with its test process reporting heartbeats', () => {
  rethrow(leavesAHealthyRunAlone);
});
