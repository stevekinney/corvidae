import { describe, expect, test } from 'bun:test';

import { parseWrapperArguments } from './bun-test-junit.ts';
import {
  BUDGET_MILLISECONDS,
  STALE_FLOOR_MILLISECONDS,
  judgeDurations,
  laneProblems,
  parseJunit,
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
});

describe('laneProblems', () => {
  test('requires slow files to be ignored by test and run by test:slow', () => {
    expect(laneProblems('w', { test: 'bun test' }, true)).toHaveLength(2);
    expect(
      laneProblems(
        'w',
        {
          test: "bun x.ts --path-ignore-patterns='**/*.slow.test.ts'",
          'test:slow': 'bun test .slow.test.ts',
        },
        true,
      ),
    ).toEqual([]);
    expect(laneProblems('w', { test: 'bun test' }, false)).toEqual([]);
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
