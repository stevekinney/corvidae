import { describe, expect, test } from 'bun:test';

import { runWithHangGuard, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';

import {
  callingFileOf,
  expectSettled,
  requireCallingFile,
  scenario,
  scenarioResult,
  settleScenarios,
} from './bun-process.test-support.ts';

/** The pids of processes whose command line contains `needle`, found from the process table. */
async function pidsRunning(needle: string): Promise<number[]> {
  const listing = await runWithHangGuard(['ps', '-A', '-o', 'pid=,command=']);
  const table = listing.stdout.toString();
  return table
    .split('\n')
    .filter((line) => line.includes(needle))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

const scenario1 = scenario(
  'ends every scenario it started, including those of tests it did not select',
  async () => {
    // The fixture names its process after the pid of the run that starts it, which is this one.
    const token = `7919.${process.pid}`;
    const run = spawnWithHangGuard(
      [process.execPath, 'test', './scripts/filtered-run-fixture.ts', '-t', 'finishes at once'],
      {
        cwd: new URL('../..', import.meta.url).pathname,
        stdout: 'ignore',
        stderr: 'ignore',
      },
    );
    expect(await run.exited).toBe(0);
    const survivors = await pidsRunning(`sleep ${token}`);
    // The run recorded its own token, so these are its processes and nobody else's.
    for (const pid of survivors) process.kill(pid, 'SIGKILL');
    expect(survivors).toEqual([]);
  },
);

/** Run a fixture under `bun test` and return how it ended and everything it printed. */
async function runFixture(file: string): Promise<{ exitCode: number; output: string }> {
  const run = spawnWithHangGuard([process.execPath, 'test', file], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, exitCode] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { exitCode, output: out + err };
}

const scenario2 = scenario('refuses a scenario defined inside a describe callback', async () => {
  const { exitCode, output } = await runFixture('./scripts/scenario-in-describe-fixture.ts');
  expect(exitCode).not.toBe(0);
  expect(output).toContain('scenario "defined too late" was started after settleScenarios()');
});

const scenario3 = scenario(
  'fails a test whose scenario had not settled when it began',
  async () => {
    const { exitCode, output } = await runFixture('./scripts/unsettled-scenario-fixture.ts');
    expect(exitCode).not.toBe(0);
    expect(output).toContain('scenario "never finishes" had not settled when its test began');
  },
);

describe('scenarios', () => {
  test('are not started or settled by a caller that cannot be identified', () => {
    expect(() => requireCallingFile('Error\n    at nowhere', 'scenario "x"')).toThrow(
      'scenario "x": could not identify the test file',
    );
    expect(requireCallingFile('Error\n    at f (/a/b.test.ts:1:2)', 'x')).toBe('/a/b.test.ts');
    expect(callingFileOf('Error\n    at f (/a/bun-process.test-support.ts:1:2)')).toBe('');
  });

  test('refuse to start once the file has settled, naming the scenario', () => {
    expect(() => scenario('late', () => undefined)).toThrow(
      'scenario "late" was started after settleScenarios()',
    );
  });

  test('are reported only once they have settled', () => {
    const running = {
      name: 'busy',
      outcome: new Promise<never>(() => undefined),
      settled: () => false,
    };
    expect(() => expectSettled(running)).toThrow('scenario "busy" had not settled');
    expect(() => expectSettled({ ...running, settled: () => true })).not.toThrow();
  });

  scenarioResult(scenario2.name, scenario2);
  scenarioResult(scenario3.name, scenario3);
});

describe('a run that selects tests by name', () => {
  scenarioResult(
    'ends every scenario it started, including those of tests it did not select',
    scenario1,
  );
});

await settleScenarios();
