import { describe, expect } from 'bun:test';

import { SCENARIO_HANG_GUARD_MILLISECONDS } from '@lostgradient/testing';

import { scenarioTest, settleScenarios } from './bun-process.test-support.ts';

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

describe('a run that selects tests by name', () => {
  scenarioTest(
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
});

await settleScenarios();
