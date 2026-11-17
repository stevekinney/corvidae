import { describe, expect, test } from 'bun:test';

import type { Runner } from './process-runner.ts';
import { run, UsageError, type WaitDependencies } from './wait-run.ts';

interface Script {
  statuses: string[];
  /** One `remaining reset` line per rate limit read; the last repeats. */
  limits?: string[];
  outcome?: object;
}

function scripted(script: Script): {
  dependencies: WaitDependencies;
  calls: string[];
  sleeps: number[];
} {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const statuses = [...script.statuses];
  const limits = [...(script.limits ?? ['4000 9999'])];
  const runner: Runner = (command) => {
    const line = command.join(' ');
    calls.push(line);
    if (line.startsWith('gh api rate_limit')) {
      const limit = limits.length > 1 ? limits.shift() : limits[0];
      return { code: 0, stdout: `${limit}\n`, stderr: '' };
    }
    if (line.endsWith('--json status'))
      return { code: 0, stdout: JSON.stringify({ status: statuses.shift() }), stderr: '' };
    return {
      code: 0,
      stdout: JSON.stringify(
        script.outcome ?? {
          conclusion: 'failure',
          jobs: [
            { name: 'root', conclusion: 'success' },
            { name: 'browser', conclusion: 'failure' },
          ],
        },
      ),
      stderr: '',
    };
  };
  return {
    dependencies: {
      runner,
      sleep: async (seconds) => {
        sleeps.push(seconds);
      },
      now: () => 1000,
    },
    calls,
    sleeps,
  };
}

describe('wait-run', () => {
  test('polls status once per interval, then reads the conclusion and jobs once', async () => {
    const { dependencies, calls, sleeps } = scripted({
      statuses: ['queued', 'in_progress', 'completed'],
    });
    const result = await run(['123'], dependencies);
    expect(calls.filter((call) => call.endsWith('--json status'))).toHaveLength(3);
    expect(calls.filter((call) => call.includes('conclusion,jobs'))).toHaveLength(1);
    expect(sleeps).toEqual([180, 180]);
    expect(result.code).toBe(1);
    expect(result.output).toBe('run 123: failure\n  root: success\n  browser: failure');
  });

  test('exits 0 for a successful run', async () => {
    const { dependencies } = scripted({
      statuses: ['completed'],
      outcome: { conclusion: 'success', jobs: [] },
    });
    expect((await run(['7', '--interval-seconds', '60'], dependencies)).code).toBe(0);
  });

  test('sleeps until the reset, then polls, when fewer than 500 calls remain', async () => {
    const { dependencies, sleeps } = scripted({
      statuses: ['completed'],
      limits: ['120 1600', '4000 9999'],
    });
    await run(['9'], dependencies);
    expect(sleeps).toEqual([605]);
  });

  test('does not poll status while the limit is low', async () => {
    const { dependencies, calls } = scripted({
      statuses: ['completed'],
      limits: ['0 1010'],
    });
    await run(['9'], dependencies);
    // The low reading is followed by a sleep and then the poll, never a poll without the sleep.
    expect(calls[0]).toContain('rate_limit');
    expect(calls[1]).toContain('--json status');
  });

  test('refuses an interval under 60 seconds and a bad run id', async () => {
    const { dependencies } = scripted({ statuses: [] });
    await expect(run(['1', '--interval-seconds', '30'], dependencies)).rejects.toBeInstanceOf(
      UsageError,
    );
    await expect(run(['abc'], dependencies)).rejects.toBeInstanceOf(UsageError);
  });

  test('a rate limit that cannot be read does not stop the wait', async () => {
    const { dependencies, calls } = scripted({ statuses: ['completed'] });
    const original = dependencies.runner;
    dependencies.runner = (command, options) =>
      command[2] === 'rate_limit'
        ? { code: 1, stdout: '', stderr: 'offline' }
        : original(command, options);
    expect((await run(['5'], dependencies)).code).toBe(1);
    expect(calls.length).toBeGreaterThan(0);
  });
});
