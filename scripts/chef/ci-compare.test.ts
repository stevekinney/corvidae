import { describe, expect, test } from 'bun:test';
import { compare, failingTests, renderComparison, run, type RunFailures } from './ci-compare.ts';
import type { Runner } from './process-runner.ts';

const failures = (id: string, jobs: [string, string[]][], status = 'completed'): RunFailures => ({
  id,
  status,
  conclusion: jobs.length === 0 ? 'success' : 'failure',
  jobs: jobs.map(([name, tests]) => ({ name, tests })),
});

describe('failingTests', () => {
  test('reads each (fail) line under its job, once, without the duration', () => {
    const log = [
      'Tests (apps)\tRun bun test\t2026-11-17T00:10:26Z (fail) ScheduleDetail > a current run [120111.22ms]',
      'Tests (apps)\tRun bun test\t2026-11-17T00:10:26Z (fail) ScheduleDetail > a current run [120111.22ms]',
      'Tests (apps)\tRun bun test\t2026-11-17T00:10:25Z (pass) storageGet > ok [0.62ms]',
      'Slow\tUNKNOWN STEP\t2026-11-16T22:59:14Z (fail) two hosts > B completes [5521.48ms]',
    ].join('\n');
    expect(failingTests(log)).toEqual(
      new Map([
        ['Tests (apps)', ['ScheduleDetail > a current run']],
        ['Slow', ['two hosts > B completes']],
      ]),
    );
  });

  test('reads Playwright failure headings, not the progress lines', () => {
    const log = [
      'E2E (4/4)\tUNKNOWN STEP\t2026-11-17T00:03:03Z [129/354] [chromium] › tests/e2e/settings.spec.ts:69:3 › draws a control',
      'E2E (4/4)\tUNKNOWN STEP\t2026-11-17T00:03:03Z   1) [chromium] › tests/e2e/settings.spec.ts:69:3 › draws a control ',
      'E2E (4/4)\tUNKNOWN STEP\t2026-11-17T00:03:03Z     Error: expect(locator).toBeVisible() failed',
    ].join('\n');
    expect(failingTests(log)).toEqual(
      new Map([['E2E (4/4)', ['tests/e2e/settings.spec.ts:69:3 › draws a control']]]),
    );
  });
});

describe('compare', () => {
  const main = [
    failures('10', [['E2E (2/4)', ['chat layout']]]),
    failures('11', [['Test durations', []]]),
  ];

  test('a job and its tests that failed on main are known; the verdict passes', () => {
    const result = compare(
      failures('1', [
        ['E2E (2/4)', ['chat layout']],
        ['Test durations', []],
      ]),
      main,
    );
    expect(result.hasNew).toBe(false);
    expect(result.jobs.map((job) => job.seenIn)).toEqual([['10'], ['11']]);
  });

  test('a test job whose log names no failing test is unknown, never known by its name', () => {
    const result = compare(failures('1', [['E2E (2/4)', []]]), main);
    expect(result.jobs[0]?.unknown).toBe(true);
    expect(result.hasNew).toBe(true);
    expect(renderComparison(result)).toContain('UNKNOWN job E2E (2/4)');
  });

  test('a non-test job is judged by its name', () => {
    expect(compare(failures('1', [['Test durations', []]]), main).hasNew).toBe(false);
    expect(
      compare(failures('1', [['Workspace lint and type-check', []]]), [
        failures('12', [['Workspace lint and type-check', []]]),
      ]).hasNew,
    ).toBe(false);
  });

  test('a job main never failed is new', () => {
    const result = compare(failures('1', [['Tests (apps)', ['ScheduleDetail']]]), main);
    expect(result.hasNew).toBe(true);
    expect(renderComparison(result)).toContain('NEW job Tests (apps)');
  });

  test('a new test inside a job that also fails on main is new', () => {
    const result = compare(failures('1', [['E2E (2/4)', ['chat layout', 'composer']]]), main);
    expect(result.hasNew).toBe(true);
    expect(result.jobs[0]?.tests.map((t) => t.seenIn.length)).toEqual([1, 0]);
  });

  test('a run that has not finished never passes', () => {
    const result = compare(failures('1', [], 'in_progress'), main);
    expect(result.hasNew).toBe(true);
    expect(renderComparison(result)).toContain('NOT COMPLETE');
  });
});

describe('run', () => {
  test('reads the run and main runs through gh and exits 1 on a new failure', () => {
    const calls: string[][] = [];
    const runner: Runner = (command) => {
      calls.push(command);
      const joined = command.join(' ');
      if (joined.includes('run list'))
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify([
            { databaseId: 5, conclusion: 'cancelled' },
            { databaseId: 7, conclusion: 'failure' },
          ]),
        };
      if (joined.includes('--log-failed'))
        return {
          code: 0,
          stderr: '',
          stdout: joined.includes(' 1 ') ? 'Unit\tstep\tt (fail) brand new [1ms]' : '',
        };
      const id = command[3];
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          status: 'completed',
          conclusion: 'failure',
          jobs: [{ name: id === '1' ? 'Unit' : 'Durations', conclusion: 'failure' }],
        }),
      };
    };
    const result = run(['1', '--main-runs', '3'], runner);
    expect(result.code).toBe(1);
    expect(result.output).toContain('NEW test brand new');
    expect(result.output).toContain('compared with 1 main run(s)');
    expect(calls.some((c) => c.includes('5'))).toBe(false);
  });

  test('a run ID that is not a number is a usage error', () => {
    expect(() => run(['abc'], () => ({ code: 0, stdout: '', stderr: '' }))).toThrow('Usage');
  });
});
