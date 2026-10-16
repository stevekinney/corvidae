import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { finishRun, parseWrapperArguments } from './bun-test-junit.ts';
import {
  BUDGET_MILLISECONDS,
  STALE_FLOOR_MILLISECONDS,
  budgetFailures,
  judgeDurations,
  laneProblems,
  parseJunit,
  verdict,
} from './check-test-durations.ts';

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="a.test.ts" file="a.test.ts">
    <testsuite name="outer &amp; more" file="a.test.ts" line="2">
      <testcase name="works &gt; fine" classname="outer &amp; more" time="2.5" file="a.test.ts" line="3" assertions="1" />
      <testcase name="works &gt; fine" classname="outer &amp; more" time="0.4" file="a.test.ts" line="3" assertions="1" />
    </testsuite>
    <testcase name="quick" classname="" time="0.001" file="a.test.ts" line="9" assertions="0" />
  </testsuite>
</testsuites>`;

describe('parseJunit', () => {
  test('keys each test by workspace, file, class and decoded name, keeping the slowest repeat', () => {
    expect(parseJunit('packages/x', xml)).toEqual([
      { key: 'packages/x :: a.test.ts :: outer & more :: works > fine', milliseconds: 2500 },
      { key: 'packages/x :: a.test.ts ::  :: quick', milliseconds: 1 },
    ]);
  });
});

describe('judgeDurations', () => {
  const slow = { key: 'w :: f.test.ts :: c :: slow', milliseconds: BUDGET_MILLISECONDS + 1 };
  const exactlyAtBudget = { key: 'w :: f.test.ts :: c :: edge', milliseconds: BUDGET_MILLISECONDS };
  const covered = new Set(['w']);

  test('fails a test over budget that is not allowlisted, and passes one exactly at budget', () => {
    const findings = judgeDurations([slow, exactlyAtBudget], [], covered);
    expect(findings.overBudget).toEqual([slow]);
    expect(findings.stale).toEqual([]);
  });

  test('passes an allowlisted test that is still over budget', () => {
    expect(judgeDurations([slow], [slow.key], covered)).toEqual({ overBudget: [], stale: [] });
  });

  test('fails an allowlisted entry whose test is gone', () => {
    const findings = judgeDurations([], [slow.key], covered);
    expect(findings.stale.map(({ key }) => key)).toEqual([slow.key]);
  });

  test('fails an allowlisted entry that is now well under budget, but not one in the hysteresis band', () => {
    const fast = { key: slow.key, milliseconds: STALE_FLOOR_MILLISECONDS - 1 };
    expect(judgeDurations([fast], [slow.key], covered).stale).toHaveLength(1);
    const inBand = { key: slow.key, milliseconds: STALE_FLOOR_MILLISECONDS };
    expect(judgeDurations([inBand], [slow.key], covered).stale).toEqual([]);
  });

  test('does not call an entry stale when its workspace produced no report', () => {
    expect(judgeDurations([], [slow.key], new Set()).stale).toEqual([]);
  });

  test('calls an entry stale when its workspace no longer exists, but not when it exists without a report', () => {
    const existing = new Set(['w']);
    expect(judgeDurations([], [slow.key], new Set(), existing).stale).toEqual([]);
    const gone = judgeDurations([], ['renamed :: f.test.ts :: c :: t'], new Set(), existing);
    expect(gone.stale).toEqual([
      { key: 'renamed :: f.test.ts :: c :: t', reason: 'its workspace no longer exists' },
    ]);
  });
});

describe('laneProblems', () => {
  test('requires slow files to be ignored by test and run by test:slow', () => {
    expect(laneProblems('w', { test: 'bun ../../scripts/bun-test-junit.ts' }, true)).toHaveLength(
      2,
    );
    expect(
      laneProblems(
        'w',
        {
          test: "bun ../../scripts/bun-test-junit.ts --path-ignore-patterns='**/*.slow.test.ts'",
          'test:slow': 'bun test .slow.test.ts',
        },
        true,
      ),
    ).toEqual([]);
    expect(laneProblems('w', { test: 'bun ../../scripts/bun-test-junit.ts' }, false)).toEqual([]);
  });

  test('accepts the playground runner, which splits lanes by file name itself', () => {
    expect(
      laneProblems(
        'applications/playground',
        { test: 'bun scripts/run-tests.ts', 'test:slow': 'bun scripts/run-tests.ts --slow' },
        true,
      ),
    ).toEqual([]);
  });
});

describe('bun-test-junit wrapper arguments', () => {
  test('defaults the report name and strips an explicit one', () => {
    expect(parseWrapperArguments(['--conditions', 'browser'])).toEqual({
      reportName: 'fast',
      bunTestArguments: ['--conditions', 'browser'],
    });
    expect(parseWrapperArguments(['--report-name=self', './a.test.ts'])).toEqual({
      reportName: 'self',
      bunTestArguments: ['./a.test.ts'],
    });
  });
});

describe('laneProblems for wrapping and coverage', () => {
  const wrapped = 'bun ../../scripts/bun-test-junit.ts';

  test('requires a fast test script to run through the JUnit wrapper or the playground runner', () => {
    expect(laneProblems('w', { test: 'bun test' }, false)).toEqual([
      expect.stringContaining('does not run through scripts/bun-test-junit.ts'),
    ]);
    expect(laneProblems('w', { test: wrapped }, false)).toEqual([]);
    expect(
      laneProblems('applications/playground', { test: 'bun scripts/run-tests.ts' }, false),
    ).toEqual([]);
    // The root workspace's `test` is a turbo fan-out; its own suites run through `test:self`.
    expect(laneProblems('.', { test: 'turbo run test:self test' }, false)).toEqual([]);
  });

  test('requires the coverage run to ignore slow files too, so they run only in test:slow', () => {
    const scripts = {
      test: `${wrapped} --path-ignore-patterns='**/*.slow.test.ts'`,
      'test:slow': 'bun test .slow.test.ts',
    };
    expect(laneProblems('w', { ...scripts, 'test:coverage': 'bun test --coverage' }, true)).toEqual(
      [expect.stringContaining('test:coverage')],
    );
    // A coverage run through the JUnit wrapper is still `bun test` underneath.
    expect(
      laneProblems('w', { ...scripts, 'test:coverage': `${wrapped} --coverage` }, true),
    ).toEqual([expect.stringContaining('test:coverage')]);
    expect(
      laneProblems(
        'w',
        {
          ...scripts,
          'test:coverage': "bun test --coverage --path-ignore-patterns='**/*.slow.test.ts'",
        },
        true,
      ),
    ).toEqual([]);
  });
});

describe('budgetFailures', () => {
  const report = (seconds: number) =>
    `<testsuite><testcase name="t" classname="c" time="${seconds}" file="f.test.ts" /></testsuite>`;

  test('names a test over budget that the allowlist does not list', () => {
    expect(budgetFailures('w', [report(2.5)], [])).toEqual([
      expect.stringContaining('w :: f.test.ts :: c :: t'),
    ]);
  });

  test('passes a test at budget and one the allowlist lists', () => {
    expect(budgetFailures('w', [report(2)], [])).toEqual([]);
    expect(budgetFailures('w', [report(9)], ['w :: f.test.ts :: c :: t'])).toEqual([]);
  });
});

describe('finishRun', () => {
  const slowReport =
    '<testsuite><testcase name="t" classname="c" time="3" file="f.test.ts" /></testsuite>';

  test('warns about an over-budget test in a passing run but never fails the run', () => {
    const messages: string[] = [];
    expect(finishRun('w', 0, [slowReport], [], (message) => messages.push(message))).toBe(0);
    expect(messages.join('')).toContain('w :: f.test.ts :: c :: t');
  });

  test('keeps the exit code of a run that already failed, and stays quiet on a clean report', () => {
    const messages: string[] = [];
    expect(finishRun('w', 7, [slowReport], [], (message) => messages.push(message))).toBe(7);
    expect(finishRun('w', 0, [], [], (message) => messages.push(message))).toBe(0);
    expect(
      finishRun('w', 0, [slowReport], ['w :: f.test.ts :: c :: t'], (message) =>
        messages.push(message),
      ),
    ).toBe(0);
    expect(messages).toEqual([]);
  });
});

describe('verdict', () => {
  const overBudget = ['over budget: 3000 ms — w :: f.test.ts :: c :: t'];
  const stale = ['stale allowlist entry (took 0 ms, under the 1000 ms floor): w :: f :: c :: t'];

  test('validate mode reports over-budget and stale findings as warnings and exits 0', () => {
    expect(verdict('report', [], overBudget, stale)).toMatchObject({ exitCode: 0 });
    expect(verdict('report', [], overBudget, stale).lines).toEqual([...overBudget, ...stale]);
  });

  test('enforcing mode exits 1 on the same findings, and on a stale entry alone', () => {
    expect(verdict('enforce', [], overBudget, stale)).toMatchObject({ exitCode: 1 });
    expect(verdict('enforce', [], [], stale)).toMatchObject({ exitCode: 1 });
  });

  test('wiring problems fail both modes, because they do not depend on host load', () => {
    const wiring = ['w: has .slow.test.ts files but defines no test:slow script'];
    expect(verdict('report', wiring, [], [])).toMatchObject({ exitCode: 1 });
    expect(verdict('enforce', wiring, [], [])).toMatchObject({ exitCode: 1 });
  });

  test('no findings exit 0 in both modes', () => {
    expect(verdict('report', [], [], [])).toMatchObject({ exitCode: 0, lines: [] });
    expect(verdict('enforce', [], [], [])).toMatchObject({ exitCode: 0, lines: [] });
  });
});

describe('turbo cache inputs for the wrapped test tasks', () => {
  const root = join(import.meta.dir, '..');
  const REQUIRED_INPUTS = [
    '$TURBO_ROOT$/scripts/bun-test-junit.ts',
    '$TURBO_ROOT$/scripts/check-test-durations.ts',
    '$TURBO_ROOT$/scripts/test-duration-allowlist.json',
  ];

  test('each workspace whose test script runs the wrapper hashes it, the budget module and the allowlist', async () => {
    const configuration = (await Bun.file(join(root, 'turbo.json')).json()) as {
      tasks: Record<string, { inputs?: string[] }>;
    };
    const unhashed: string[] = [];
    for await (const manifestPath of new Bun.Glob(
      '{applications,components,packages}/*/package.json',
    ).scan(root)) {
      const manifest = (await Bun.file(join(root, manifestPath)).json()) as {
        name: string;
        scripts?: Record<string, string>;
      };
      if (!manifest.scripts?.['test']?.includes('bun-test-junit.ts')) continue;
      const task = configuration.tasks[`${manifest.name}#test`] ?? configuration.tasks['test'];
      const inputs = task?.inputs ?? [];
      for (const required of REQUIRED_INPUTS) {
        if (!inputs.includes(required)) unhashed.push(`${manifest.name}: ${required}`);
      }
    }
    expect(unhashed).toEqual([]);
  });
});

describe('the on-demand check measures before it enforces', () => {
  const root = join(import.meta.dir, '..');

  test('check:test-durations first forces every task that writes a report, then enforces', async () => {
    const { scripts } = (await Bun.file(join(root, 'package.json')).json()) as {
      scripts: Record<string, string>;
    };
    const check = scripts['check:test-durations'] ?? '';
    expect(check).toStartWith('bun run measure:test-durations && ');
    const measure = scripts['measure:test-durations'] ?? '';
    expect(measure).toContain('--force');
    // Every root script that writes a JUnit report is a turbo task the measurement must run:
    // `test:self` and `test:browser-fixtures` write the root reports, and the package `test`
    // tasks write the rest.
    const reportingRootTasks = Object.entries(scripts)
      .filter(([, command]) => command.includes('bun-test-junit.ts --report-name='))
      .map(([name]) => name);
    expect(reportingRootTasks.toSorted()).toEqual(['test:browser-fixtures', 'test:self']);
    for (const task of [...reportingRootTasks, 'test']) {
      expect(measure, task).toMatch(new RegExp(`\\b${task}\\b(?!:)`));
    }
  });

  test('validate reports without forcing a second measurement', async () => {
    const { scripts } = (await Bun.file(join(root, 'package.json')).json()) as {
      scripts: Record<string, string>;
    };
    expect(scripts['validate']).toContain('bun run report:test-durations');
    expect(scripts['validate']).not.toContain('measure:test-durations');
    expect(scripts['report:test-durations']).not.toContain('--force');
  });
});
