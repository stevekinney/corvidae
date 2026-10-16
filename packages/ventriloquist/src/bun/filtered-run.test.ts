import { describe, expect, test } from 'bun:test';

import { SCENARIO_HANG_GUARD_MILLISECONDS } from '@lostgradient/testing';

import {
  expectSettled,
  scenario,
  scenarioResult,
  settleScenarios,
} from './bun-process.test-support.ts';

/** The pids of processes whose command line contains `needle`, found from the process table. */
function pidsRunning(needle: string): number[] {
  const table = Bun.spawnSync(['ps', '-A', '-o', 'pid=,command='], {
    stdout: 'pipe',
    timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
  }).stdout.toString();
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
    const run = Bun.spawn(
      [process.execPath, 'test', './scripts/filtered-run-fixture.ts', '-t', 'finishes at once'],
      {
        cwd: new URL('../..', import.meta.url).pathname,
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
      },
    );
    expect(await run.exited).toBe(0);
    const survivors = pidsRunning(`sleep ${token}`);
    // The run recorded its own token, so these are its processes and nobody else's.
    for (const pid of survivors) process.kill(pid, 'SIGKILL');
    expect(survivors).toEqual([]);
  },
);

/** Run a fixture under `bun test` and return how it ended and everything it printed. */
async function runFixture(file: string): Promise<{ exitCode: number; output: string }> {
  const run = Bun.spawn([process.execPath, 'test', file], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
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
