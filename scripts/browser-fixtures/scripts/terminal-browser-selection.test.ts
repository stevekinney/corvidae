import { describe, expect, test } from 'bun:test';

import {
  flattenReport,
  resultProblems,
  selectionProblems,
  TERMINAL_BEHAVIORAL_SPECS,
  TERMINAL_PROJECTS,
  TERMINAL_VISUAL_SPEC,
  type SelectedTest,
} from './terminal-browser-selection.ts';

const FIXTURES = 3;

function full(): SelectedTest[] {
  const tests: SelectedTest[] = [];
  for (const project of TERMINAL_PROJECTS) {
    for (const file of TERMINAL_BEHAVIORAL_SPECS) {
      for (const title of ['one', 'two']) {
        tests.push({ file, project, title, skipped: false, outcome: 'passed' });
      }
    }
  }
  for (let index = 0; index < 2 * 3 * FIXTURES + 1; index += 1) {
    tests.push({
      file: TERMINAL_VISUAL_SPEC,
      project: 'chromium',
      title: `cell ${index}`,
      skipped: false,
      outcome: 'passed',
    });
  }
  return tests;
}

describe('the required terminal selection', () => {
  test('the full matrix has no problems', () => {
    expect(selectionProblems(full(), FIXTURES)).toEqual([]);
  });

  test('a missing browser is named', () => {
    const tests = full().filter((candidate) => candidate.project !== 'webkit-terminal');
    const problems = selectionProblems(tests, FIXTURES);
    expect(problems).toContain('no test is selected for the webkit-terminal project');
    expect(problems.some((problem) => problem.includes('has no test in webkit-terminal'))).toBe(
      true,
    );
  });

  test('one spec missing from one browser is named', () => {
    const tests = full().filter(
      (candidate) =>
        !(
          candidate.file === 'terminal-input.playwright.ts' &&
          candidate.project === 'firefox-terminal'
        ),
    );
    expect(selectionProblems(tests, FIXTURES)).toContain(
      'terminal-input.playwright.ts has no test in firefox-terminal',
    );
  });

  test('uneven counts between browsers are a problem', () => {
    const tests = full();
    tests.splice(
      tests.findIndex(
        (candidate) =>
          candidate.file === 'terminal-vt.playwright.ts' && candidate.project === 'webkit-terminal',
      ),
      1,
    );
    expect(selectionProblems(tests, FIXTURES).join('\n')).toContain(
      'terminal-vt.playwright.ts selects different numbers of tests per browser: 2, 2, 1',
    );
  });

  test('a lost baseline cell, an extra browser for the baselines, and a skip are problems', () => {
    const lost = full();
    lost.pop();
    expect(selectionProblems(lost, FIXTURES).join('\n')).toContain('the matrix needs 19');
    const extra = [
      ...full(),
      {
        file: TERMINAL_VISUAL_SPEC,
        project: 'firefox-terminal',
        title: 'x',
        skipped: false,
        outcome: undefined,
      },
    ];
    expect(selectionProblems(extra, FIXTURES)).toContain(
      `${TERMINAL_VISUAL_SPEC} must not run in firefox-terminal`,
    );
    const skipped = full();
    skipped[0] = { ...skipped[0]!, skipped: true };
    expect(selectionProblems(skipped, FIXTURES).join('\n')).toContain('is skipped');
  });

  test('an unrelated spec is not part of the terminal selection', () => {
    const tests = [
      ...full(),
      {
        file: 'smoke.spec.ts',
        project: 'chromium',
        title: 'x',
        skipped: false,
        outcome: undefined,
      },
    ];
    expect(selectionProblems(tests, FIXTURES)).toContain(
      'smoke.spec.ts is selected but is not a terminal spec (chromium)',
    );
  });

  test('an empty selection fails', () => {
    expect(selectionProblems([], FIXTURES).length).toBeGreaterThan(0);
  });
});

describe('the terminal run', () => {
  test('every selected test must report a pass', () => {
    const selected = full();
    expect(resultProblems(selected, selected)).toEqual([]);
    const broken = selected.map((candidate, index) =>
      index === 0 ? { ...candidate, outcome: 'timedOut' } : candidate,
    );
    expect(resultProblems(selected, broken)[0]).toContain('ended as timedOut');
    expect(resultProblems(selected, selected.slice(1))[0]).toContain('were selected but');
  });
});

describe('flattenReport', () => {
  test('walks nested suites and reads the project, skip state and last result', () => {
    const tests = flattenReport({
      suites: [
        {
          file: 'tests/terminal-vt.playwright.ts',
          suites: [
            {
              specs: [
                {
                  title: 'a test',
                  file: 'tests/terminal-vt.playwright.ts',
                  tests: [
                    {
                      projectName: 'chromium',
                      expectedStatus: 'passed',
                      results: [{ status: 'failed' }, { status: 'passed' }],
                    },
                    { projectName: 'webkit-terminal', annotations: [{ type: 'skip' }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(tests).toEqual([
      {
        file: 'terminal-vt.playwright.ts',
        project: 'chromium',
        title: 'a test',
        skipped: false,
        outcome: 'passed',
      },
      {
        file: 'terminal-vt.playwright.ts',
        project: 'webkit-terminal',
        title: 'a test',
        skipped: true,
        outcome: undefined,
      },
    ]);
  });
});
