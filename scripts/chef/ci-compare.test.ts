import { describe, expect, test } from 'bun:test';
import {
  compare,
  failingSteps,
  failingTests,
  matchFlakeIssues,
  renderComparison,
  run,
  type RunFailures,
} from './ci-compare.ts';
import type { LinearClient } from './linear.ts';
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
      'Tests (apps)\tRun bun test\t2026-11-17T00:10:25Z ##[group]src/schedule-detail.test.ts:',
      'Tests (apps)\tRun bun test\t2026-11-17T00:10:26Z (fail) ScheduleDetail > a current run [120111.22ms]',
      'Tests (apps)\tRun bun test\t2026-11-17T00:10:26Z (fail) ScheduleDetail > a current run [120111.22ms]',
      'Tests (apps)\tRun bun test\t2026-11-17T00:10:25Z (pass) storageGet > ok [0.62ms]',
      'Slow\tUNKNOWN STEP\t2026-11-16T22:59:14Z (fail) two hosts > B completes [5521.48ms]',
    ].join('\n');
    expect(failingTests(log)).toEqual(
      new Map([
        ['Tests (apps)', ['src/schedule-detail.test.ts › ScheduleDetail > a current run']],
        ['Slow', ['<unknown test file> › two hosts > B completes']],
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

  test('reads a Bun assertion without a fail summary by its owning file and expected assertion', () => {
    const log = [
      'Affected fast-lane tests\tUNKNOWN STEP\t2026-11-17T18:34:01.1149205Z ##[group]src/lib/components/chat/chat.test.ts:',
      'Affected fast-lane tests\tUNKNOWN STEP\t2026-11-17T18:34:01.1163486Z error: expect(received).toContain(expected)',
      'Affected fast-lane tests\tUNKNOWN STEP\t2026-11-17T18:34:01.1162773Z ',
      'Affected fast-lane tests\tUNKNOWN STEP\t2026-11-17T18:34:01.1162993Z Expected to contain: "const shift = approvalArrivalShift(cardBox, viewportBox);"',
    ].join('\n');
    expect(failingTests(log)).toEqual(
      new Map([
        [
          'Affected fast-lane tests',
          [
            'src/lib/components/chat/chat.test.ts › expect(received).toContain(expected) › "const shift = approvalArrivalShift(cardBox, viewportBox);"',
          ],
        ],
      ]),
    );
  });

  test('does not classify an unqualified generic error in a file group as a known test', () => {
    const log = [
      'Tests (components)\tRun bun test\t2026-11-17T19:21:40Z ##[group]src/lib/components/chat/chat.test.ts:',
      'Tests (components)\tRun bun test\t2026-11-17T19:21:40Z error: unexpected failure',
    ].join('\n');
    expect(failingTests(log)).toEqual(new Map());
  });

  test('qualifies identical Bun tests by their Turbo workspace across changed job topology', () => {
    const log = [
      'Affected fast-lane tests\tUNKNOWN STEP\t2026-11-17T18:21:19Z ##[group]@lostgradient/storage-lmdb:test',
      'Affected fast-lane tests\tUNKNOWN STEP\t2026-11-17T18:21:20Z ##[group]src/index.test.ts:',
      'Affected fast-lane tests\tUNKNOWN STEP\t2026-11-17T18:21:21Z (fail) package entry > exports the adapter [1ms]',
      'Affected fast-lane tests\tUNKNOWN STEP\t2026-11-17T18:21:22Z ##[group]@lostgradient/storage-postgres:test',
      'Affected fast-lane tests\tUNKNOWN STEP\t2026-11-17T18:21:23Z ##[group]src/index.test.ts:',
      'Affected fast-lane tests\tUNKNOWN STEP\t2026-11-17T18:21:24Z (fail) package entry > exports the adapter [1ms]',
    ].join('\n');
    expect(failingTests(log)).toEqual(
      new Map([
        [
          'Affected fast-lane tests',
          [
            '@lostgradient/storage-lmdb › src/index.test.ts › package entry > exports the adapter',
            '@lostgradient/storage-postgres › src/index.test.ts › package entry > exports the adapter',
          ],
        ],
      ]),
    );
  });

  test('retains each failed GitHub step independently from test evidence', () => {
    const log = [
      'Root checks\tUNKNOWN STEP\t2026-11-17T19:11:27Z ##[group]Run bun run lint:root',
      'Root checks\tUNKNOWN STEP\t2026-11-17T19:18:57Z error: script "audit" exited with code 1',
      'Root checks\tUNKNOWN STEP\t2026-11-17T19:18:57Z ##[error]Process completed with exit code 1.',
    ].join('\n');
    expect(failingSteps(log)).toEqual(new Map([['Root checks', ['bun run lint:root']]]));
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

  test('a new non-test step beside a known test remains new', () => {
    const result = compare(
      {
        id: '1',
        status: 'completed',
        conclusion: 'failure',
        jobs: [{ name: 'Unit', tests: ['known'], steps: ['lint'] }],
      },
      [
        {
          id: '2',
          status: 'completed',
          conclusion: 'failure',
          jobs: [{ name: 'Unit', tests: ['known'], steps: [] }],
        },
      ],
    );
    expect(result.hasNew).toBe(true);
    expect(result.jobs[0]?.steps[0]?.seenIn).toEqual([]);
  });

  test('a known failed step beside a new test remains new', () => {
    const result = compare(
      {
        id: '1',
        status: 'completed',
        conclusion: 'failure',
        jobs: [{ name: 'Unit', tests: ['new'], steps: ['lint'] }],
      },
      [
        {
          id: '2',
          status: 'completed',
          conclusion: 'failure',
          jobs: [{ name: 'Unit', tests: ['known'], steps: ['lint'] }],
        },
      ],
    );
    expect(result.hasNew).toBe(true);
    expect(result.jobs[0]?.steps[0]?.seenIn).toEqual(['2']);
  });

  test('a file-qualified test seen under a different control topology is known', () => {
    const result = compare(failures('1', [['E2E (4/4)', ['src/chat.test.ts › chat layout']]]), [
      failures('10', [['E2E (2/4)', ['src/chat.test.ts › chat layout']]]),
      ...main,
      failures('13', [['E2E (4/4)', ['other']]]),
    ]);
    expect(result.jobs[0]?.tests[0]?.seenIn).toEqual(['10']);
    expect(result.jobs[0]?.seenIn).toEqual(['10']);
    expect(result.hasNew).toBe(false);
  });

  test('a same-title test from a different Turbo workspace remains new', () => {
    const result = compare(
      failures('1', [
        ['Tests (new)', ['@lostgradient/storage-lmdb › src/index.test.ts › package entry']],
      ]),
      [
        failures('2', [
          ['Tests (main)', ['@lostgradient/storage-postgres › src/index.test.ts › package entry']],
        ]),
      ],
    );
    expect(result.hasNew).toBe(true);
  });

  test('a same workspace, file and title remains known when its display job changes', () => {
    const identity = '@lostgradient/storage-lmdb › src/index.test.ts › package entry';
    const result = compare(failures('1', [['Affected fast-lane tests', [identity]]]), [
      failures('2', [['Tests (components)', [identity]]]),
    ]);
    expect(result.hasNew).toBe(false);
    expect(result.jobs[0]?.tests[0]?.seenIn).toEqual(['2']);
  });

  test('a bare title under a different job remains new', () => {
    expect(compare(failures('1', [['E2E (4/4)', ['chat layout']]]), main).hasNew).toBe(true);
  });

  test('a run that failed or was cancelled with no failed job never passes', () => {
    for (const conclusion of ['startup_failure', 'cancelled']) {
      const result = compare({ id: '1', status: 'completed', conclusion, jobs: [] }, main);
      expect(result.hasNew).toBe(true);
      expect(renderComparison(result)).toContain('NO EVIDENCE');
    }
    expect(compare(failures('1', []), main).hasNew).toBe(false);
  });

  test('a run that has not finished never passes', () => {
    const result = compare(failures('1', [], 'in_progress'), main);
    expect(result.hasNew).toBe(true);
    expect(renderComparison(result)).toContain('NOT COMPLETE');
  });

  test('names a matching COR flake and reports its recurrence after a completed repair', async () => {
    const client: LinearClient = {
      async request(document) {
        if (document.includes('FlakeIssues'))
          return {
            issues: {
              nodes: [
                {
                  identifier: 'COR-2504',
                  description:
                    'The slow test "two hosts > B completes" failed again. COR-1906 made it deterministic before.',
                  state: { name: 'In Progress', type: 'started' },
                },
                {
                  identifier: 'COR-irrelevant',
                  description:
                    'A matching title is not enough without this test in the description.',
                  state: { name: 'Done', type: 'completed' },
                },
              ],
            },
          } as never;
        if (document.includes('FlakeFix'))
          return {
            issue: { identifier: 'COR-1906', state: { name: 'Done', type: 'completed' } },
          } as never;
        throw new Error(`unexpected request ${document}`);
      },
    };
    const result = await matchFlakeIssues(
      compare(failures('1', [['Slow', ['src/host.test.ts › two hosts > B completes']]]), main),
      client,
    );
    expect(result.jobs[0]?.tests[0]?.flakes).toEqual([
      { identifier: 'COR-2504', recursAfter: 'COR-1906' },
    ]);
    expect(renderComparison(result)).toContain('COR-2504 recurs after COR-1906 Done');
  });

  test("keeps CI's new-failure verdict when flake lookup is unavailable", async () => {
    const result = await matchFlakeIssues(
      compare(failures('1', [['Unit', ['src/x.test.ts › a failure']]]), main),
      { request: async () => Promise.reject(new Error('Linear offline')) },
    );
    expect(result.hasNew).toBe(true);
    expect(renderComparison(result)).toContain('FLAKE LOOKUP UNAVAILABLE: Linear offline');
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
    expect(result.output).toContain('NEW test <unknown test file> › brand new');
    expect(result.output).toContain('compared with 1 main run(s)');
    expect(calls.some((c) => c.includes('5'))).toBe(false);
    // Most completed main runs are replaced ones, so the listing reads well past the count.
    const list = calls.find((c) => c.includes('list')) ?? [];
    expect(list[list.indexOf('--limit') + 1]).toBe('100');
  });

  test('a run still in progress is judged not complete without asking for its failed logs', () => {
    const runner: Runner = (command) => {
      const joined = command.join(' ');
      if (joined.includes('--log-failed'))
        return { code: 1, stderr: 'run 1 is still in progress', stdout: '' };
      if (joined.includes('run list')) return { code: 0, stderr: '', stdout: '[]' };
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          status: 'in_progress',
          conclusion: '',
          jobs: [{ name: 'Chromium fixtures (1/4)', conclusion: 'failure' }],
        }),
      };
    };
    const result = run(['1'], runner);
    expect(result.code).toBe(1);
    expect(result.output).toContain('NOT COMPLETE');
  });

  test('a run ID that is not a number is a usage error', () => {
    expect(() => run(['abc'], () => ({ code: 0, stdout: '', stderr: '' }))).toThrow('Usage');
  });
});
