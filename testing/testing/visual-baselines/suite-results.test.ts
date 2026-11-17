import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WEB_SERVER_TIMEOUT,
  WEB_SERVER_TIMEOUT_REPORT,
  failedTerminalScopeGuard,
  passed,
  playwrightReport,
} from './playwright-report.test-support.ts';
import {
  TERMINAL_SCOPE_GUARD_FILE,
  TERMINAL_SCOPE_GUARD_TITLE,
  compareWithControl,
  decideApply,
  decideVisualExit,
  incompleteRunReasons,
  isScreenshotFailure,
  isTerminalScopeGuard,
  nonPassingTests,
  renderControlComparison,
  runCompareCommand,
  summarizePlaywrightResults,
  type SuiteResults,
} from './suite-results.ts';

const ESCAPE = String.fromCharCode(27);

/** A Playwright JSON report: one passing, one behavioural failure, one screenshot failure, one flaky. */
const REPORT = JSON.stringify({
  stats: { expected: 1, unexpected: 2, flaky: 1, skipped: 0 },
  suites: [
    {
      title: 'tree.playwright.ts',
      file: 'tree.playwright.ts',
      specs: [
        {
          title: 'renders',
          file: 'tree.playwright.ts',
          line: 4,
          tests: [{ status: 'expected', results: [{ status: 'passed' }] }],
        },
        {
          title: 'scrolls',
          file: 'tree.playwright.ts',
          line: 9,
          tests: [
            { status: 'skipped', expectedStatus: 'skipped', results: [{ status: 'skipped' }] },
          ],
        },
      ],
      suites: [
        {
          title: 'Tree — virtualized',
          file: 'tree.playwright.ts',
          specs: [
            {
              title: 'keeps rows windowed',
              file: 'tree.playwright.ts',
              line: 26,
              tests: [
                {
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      errors: [
                        { message: `${ESCAPE}[31mError: row 5000 missing${ESCAPE}[39m\n  at x` },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      title: 'components.playwright.ts',
      file: 'components.playwright.ts',
      suites: [
        {
          title: 'button',
          file: 'components.playwright.ts',
          specs: [
            {
              title: 'light-desktop-primary',
              file: 'components.playwright.ts',
              line: 723,
              tests: [
                {
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      errors: [
                        { message: 'Error: expect(page).toHaveScreenshot(expected) failed\n' },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              title: 'dark-desktop-primary',
              file: 'components.playwright.ts',
              line: 723,
              tests: [{ status: 'flaky', results: [{ status: 'failed' }, { status: 'passed' }] }],
            },
          ],
        },
      ],
    },
  ],
});

describe('summarizePlaywrightResults', () => {
  it('lists unexpected tests with their title path, location, first error line and kind', () => {
    const results = summarizePlaywrightResults(REPORT);
    expect(results).toEqual({
      expected: 1,
      unexpected: 2,
      flaky: 1,
      skipped: 0,
      failures: [
        {
          title: 'components.playwright.ts › button › light-desktop-primary',
          file: 'components.playwright.ts',
          line: 723,
          status: 'failed',
          errors: ['Error: expect(page).toHaveScreenshot(expected) failed'],
          screenshot: true,
        },
        {
          title: 'tree.playwright.ts › Tree — virtualized › keeps rows windowed',
          file: 'tree.playwright.ts',
          line: 26,
          status: 'failed',
          errors: ['Error: row 5000 missing'],
          screenshot: false,
        },
      ],
      flakyTests: ['components.playwright.ts › button › dark-desktop-primary'],
      skippedTests: [{ title: 'tree.playwright.ts › scrolls', file: 'tree.playwright.ts' }],
      globalErrors: [],
      selected: 5,
      executed: 4,
      notRun: [],
    });
  });

  it('lists failing and skipped tests with the reason each may not have written a baseline', () => {
    expect(nonPassingTests(summarizePlaywrightResults(REPORT))).toEqual([
      {
        title: 'components.playwright.ts › button › light-desktop-primary',
        file: 'components.playwright.ts',
        reason: 'Error: expect(page).toHaveScreenshot(expected) failed',
      },
      {
        title: 'tree.playwright.ts › Tree — virtualized › keeps rows windowed',
        file: 'tree.playwright.ts',
        reason: 'Error: row 5000 missing',
      },
      { title: 'tree.playwright.ts › scrolls', file: 'tree.playwright.ts', reason: 'skipped' },
    ]);
  });

  it('recognizes screenshot failures by their comparison messages', () => {
    expect(isScreenshotFailure(['Screenshot comparison failed: 62 pixels'])).toBe(true);
    expect(
      isScreenshotFailure(['Visual-regression baseline missing (CINDER_VISUAL_DIFF=block):']),
    ).toBe(true);
    expect(isScreenshotFailure(['has 1 blocking axe violation(s)'])).toBe(false);
  });
});

const behavioural: SuiteResults = {
  expected: 10,
  unexpected: 1,
  flaky: 0,
  skipped: 0,
  failures: [
    { title: 'a › axe', file: 'a', line: 1, status: 'failed', errors: ['axe'], screenshot: false },
  ],
  flakyTests: [],
  skippedTests: [],
  globalErrors: [],
  selected: 11,
  executed: 11,
  notRun: [],
};
const screenshot: SuiteResults = {
  ...behavioural,
  failures: [
    { title: 'b › shot', file: 'b', line: 1, status: 'failed', errors: ['diff'], screenshot: true },
  ],
};

describe('decideApply', () => {
  it('applies a passing suite', () => {
    expect(
      decideApply(0, { ...behavioural, unexpected: 0, failures: [] }, false, 'all').apply,
    ).toBe(true);
  });

  it('never applies a run without a Playwright report, even one that exited 0', () => {
    const decision = decideApply(0, undefined, true, 'all');
    expect(decision.apply).toBe(false);
    expect(decision.reason).toContain('no Playwright report');
  });

  it('refuses behavioural failures without the explicit flag, and names the flag', () => {
    const decision = decideApply(1, behavioural, false, 'all');
    expect(decision.apply).toBe(false);
    expect(decision.reason).toContain('--accept-behavioural-failures');
    expect(decideApply(1, behavioural, true, 'all').apply).toBe(true);
  });

  it('never accepts a screenshot failure, even with the flag', () => {
    const decision = decideApply(1, screenshot, true, 'all');
    expect(decision.apply).toBe(false);
    expect(decision.reason).toContain('never accepted');
  });

  it('never applies a run that did not complete', () => {
    expect(decideApply(1, undefined, true, 'all').apply).toBe(false);
    expect(decideApply(130, behavioural, true, 'all').apply).toBe(false);
  });
});

describe('decideApply with a component scope (COR-1574)', () => {
  // The failure Playwright reports when CINDER_TEST_COMPONENTS leaves the terminal out.
  const guard = {
    title: `${TERMINAL_SCOPE_GUARD_FILE} › ${TERMINAL_SCOPE_GUARD_TITLE}`,
    file: TERMINAL_SCOPE_GUARD_FILE,
    line: 23,
    status: 'failed',
    errors: ['Error: expect(received).toBe(expected) // Object.is equality'],
    screenshot: false,
  };
  const withFailures = (...failures: SuiteResults['failures']): SuiteResults => ({
    ...behavioural,
    unexpected: failures.length,
    failures,
  });
  const otherFailure = behavioural.failures[0]!;

  it('blocks the terminal guard failure on a full run', () => {
    const decision = decideApply(1, withFailures(guard), false, 'all');
    expect(decision.apply).toBe(false);
    expect(decision.reason).toContain('--accept-behavioural-failures');
  });

  it('applies a scoped run whose only failure is the terminal guard', () => {
    const decision = decideApply(1, withFailures(guard), false, ['chat-conversation-list']);
    expect(decision.apply).toBe(true);
    expect(decision.reason).toContain('terminal scope guard');
  });

  it('blocks a scoped run with the terminal guard failure and any other failure', () => {
    for (const other of [otherFailure, screenshot.failures[0]!]) {
      expect(decideApply(1, withFailures(guard, other), false, ['button']).apply).toBe(false);
    }
  });

  it('blocks a scoped run with any other single failure', () => {
    for (const other of [otherFailure, screenshot.failures[0]!]) {
      expect(decideApply(1, withFailures(other), false, ['button']).apply).toBe(false);
    }
  });

  it('identifies the guard by its file and its exact title', () => {
    expect(isTerminalScopeGuard(guard)).toBe(true);
    expect(isTerminalScopeGuard({ ...guard, file: 'components.playwright.ts' })).toBe(false);
    expect(isTerminalScopeGuard({ ...guard, title: `${guard.title} again` })).toBe(false);
    expect(
      isTerminalScopeGuard({
        file: TERMINAL_SCOPE_GUARD_FILE,
        title: `${TERMINAL_SCOPE_GUARD_FILE} › terminal › ${TERMINAL_SCOPE_GUARD_TITLE}`,
      }),
    ).toBe(false);
  });

  it('reads the guard from a real report shape and still refuses an incomplete scoped run', () => {
    const results = summarizePlaywrightResults(
      playwrightReport([passed('button › light-desktop-primary'), failedTerminalScopeGuard]),
    );
    expect(results.failures.map(isTerminalScopeGuard)).toEqual([true]);
    expect(decideApply(1, results, false, ['button']).apply).toBe(true);
    expect(decideApply(1, results, false, 'all').apply).toBe(false);
    const incomplete = { ...results, notRun: ['components.playwright.ts › never ran'] };
    expect(decideApply(1, incomplete, true, ['button']).apply).toBe(false);
  });
});

describe('decideVisualExit with a component scope (COR-1575)', () => {
  const guard = {
    title: `${TERMINAL_SCOPE_GUARD_FILE} › ${TERMINAL_SCOPE_GUARD_TITLE}`,
    file: TERMINAL_SCOPE_GUARD_FILE,
    line: 23,
    status: 'failed',
    errors: ['Error: expect(received).toBe(expected) // Object.is equality'],
    screenshot: false,
  };
  const withFailures = (...failures: SuiteResults['failures']): SuiteResults => ({
    ...behavioural,
    unexpected: failures.length,
    failures,
  });
  const otherFailure = behavioural.failures[0]!;

  it('fails a full run whose only failure is the terminal guard', () => {
    expect(decideVisualExit(1, withFailures(guard), 'all')).toEqual({
      exitCode: 1,
      reason: undefined,
    });
  });

  it('passes a scoped run whose only failure is the terminal guard, and says why', () => {
    const decision = decideVisualExit(1, withFailures(guard), ['audio-player', 'text']);
    expect(decision.exitCode).toBe(0);
    expect(decision.reason).toContain('terminal scope guard');
    expect(decision.reason).toContain('audio-player, text');
  });

  it('fails a scoped run with the terminal guard failure and any other failure', () => {
    for (const other of [otherFailure, screenshot.failures[0]!]) {
      expect(decideVisualExit(1, withFailures(guard, other), ['button']).exitCode).toBe(1);
    }
  });

  it('fails a scoped run with any other single failure', () => {
    for (const other of [otherFailure, screenshot.failures[0]!]) {
      expect(decideVisualExit(1, withFailures(other), ['button']).exitCode).toBe(1);
    }
  });

  it('never passes an incomplete or reportless run, scoped or not', () => {
    const incomplete = {
      ...withFailures(guard),
      notRun: ['components.playwright.ts › never ran'],
    };
    expect(decideVisualExit(1, incomplete, ['button']).exitCode).toBe(1);
    expect(decideVisualExit(0, undefined, ['button']).exitCode).toBe(1);
    expect(decideVisualExit(0, undefined, 'all').reason).toContain('did not complete normally');
    expect(decideVisualExit(130, withFailures(guard), ['button']).exitCode).toBe(130);
  });

  it('passes a passing suite through', () => {
    expect(decideVisualExit(0, withFailures(), 'all')).toEqual({ exitCode: 0, reason: undefined });
  });
});

describe('a run that did not complete normally (COR-1537)', () => {
  it('reads a webServer timeout as a global error with nothing selected or executed', () => {
    const results = summarizePlaywrightResults(WEB_SERVER_TIMEOUT_REPORT);
    expect(results.globalErrors).toEqual([WEB_SERVER_TIMEOUT]);
    expect(results.selected).toBe(0);
    expect(results.executed).toBe(0);
    expect(results.failures).toEqual([]);
    expect(incompleteRunReasons(results)).toEqual([
      `Playwright reported 1 error outside any test: ${WEB_SERVER_TIMEOUT}`,
      'Playwright selected no tests.',
      'No test executed.',
    ]);
  });

  it('never applies a webServer timeout, whatever the exit code or the flag', () => {
    const results = summarizePlaywrightResults(WEB_SERVER_TIMEOUT_REPORT);
    for (const exitCode of [0, 1]) {
      for (const accept of [false, true]) {
        const decision = decideApply(exitCode, results, accept, 'all');
        expect(decision.apply).toBe(false);
        expect(decision.reason).toContain('did not complete normally');
        expect(decision.reason).toContain('config.webServer');
      }
    }
  });

  it('refuses a run in which no selected test executed', () => {
    const results = summarizePlaywrightResults(
      playwrightReport([
        { title: 'a', results: [] },
        { title: 'b', results: [] },
      ]),
    );
    expect(results.selected).toBe(2);
    expect(results.executed).toBe(0);
    const decision = decideApply(1, results, true, 'all');
    expect(decision.apply).toBe(false);
    expect(decision.reason).toContain('No test executed.');
    expect(decision.reason).toContain('2 of 2 selected tests never ran');
  });

  it('refuses a run in which some selected tests never ran, were interrupted, or did not run', () => {
    const results = summarizePlaywrightResults(
      playwrightReport([
        passed('ran'),
        { title: 'never started', results: [] },
        { title: 'interrupted', results: [{ status: 'interrupted' }] },
        { title: 'did not run', results: [{ status: 'skipped' }] },
      ]),
    );
    expect(results.executed).toBe(1);
    expect(results.notRun).toEqual([
      'components.playwright.ts › did not run',
      'components.playwright.ts › interrupted',
      'components.playwright.ts › never started',
    ]);
    const decision = decideApply(0, results, true, 'all');
    expect(decision.apply).toBe(false);
    expect(decision.reason).toContain('3 of 4 selected tests never ran');
    expect(decision.reason).toContain('components.playwright.ts › never started');
  });

  it('still applies a complete run whose skips were declared by the tests themselves', () => {
    const results = summarizePlaywrightResults(
      playwrightReport([
        passed('ran'),
        {
          title: 'skipped on purpose',
          expectedStatus: 'skipped',
          results: [{ status: 'skipped' }],
        },
      ]),
    );
    expect(incompleteRunReasons(results)).toEqual([]);
    expect(decideApply(0, results, false, 'all')).toEqual({
      apply: true,
      reason: 'The suite passed.',
    });
  });

  it('never lets an incomplete visual run or control pass the stability rule', () => {
    const empty = summarizePlaywrightResults(WEB_SERVER_TIMEOUT_REPORT);
    const comparison = compareWithControl(empty, behavioural);
    expect(comparison.passes).toBe(false);
    expect(comparison.incompleteRun).toContain('No test executed.');
    expect(compareWithControl(behavioural, empty).passes).toBe(false);
    const markdown = renderControlComparison(
      comparison,
      { label: 'B', results: empty },
      { label: 'main', results: behavioural },
    );
    expect(markdown).toContain('### The run did not complete normally\n\n- Playwright reported');
    expect(markdown).toContain('\n- No test executed.\n');
    expect(markdown).toContain('Verdict: fails');
  });
});

describe('compareWithControl', () => {
  it('passes when every run failure also fails on the control and none is a screenshot', () => {
    const control: SuiteResults = {
      ...behavioural,
      failures: [...behavioural.failures, ...screenshot.failures],
    };
    expect(compareWithControl(behavioural, control)).toEqual({
      shared: ['a › axe'],
      onlyInRun: [],
      onlyInControl: ['b › shot'],
      screenshotFailuresInRun: [],
      incompleteRun: [],
      incompleteControl: [],
      passes: true,
    });
  });

  it('fails on a run-only failure or any screenshot failure in the run', () => {
    expect(compareWithControl(behavioural, { ...behavioural, failures: [] }).passes).toBe(false);
    expect(compareWithControl(screenshot, screenshot).passes).toBe(false);
  });
});

describe('stability control comparison output', () => {
  it('renders both failure sets and the verdict', () => {
    const control: SuiteResults = { ...behavioural, failures: [...behavioural.failures] };
    const markdown = renderControlComparison(
      compareWithControl(behavioural, control),
      { label: 'B', results: behavioural },
      { label: 'main', results: control },
    );
    expect(markdown).toContain('Verdict: passes');
    expect(markdown).toContain(
      '### Failing in the run and the control (pre-existing)\n\n- `a › axe`',
    );
    expect(markdown).toContain('### Failing only in the run\n\nNone.');
  });

  it('returns 0 from the compare command only when the rule holds', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'suite-results-'));
    const runPath = join(directory, 'run.json');
    const controlPath = join(directory, 'control.json');
    writeFileSync(runPath, JSON.stringify({ sha: 'b', results: behavioural }));
    writeFileSync(controlPath, JSON.stringify({ sha: 'main', results: behavioural }));
    const printed: string[] = [];
    const output = { stdout: (text: string) => printed.push(text), stderr: () => {} };
    expect(await runCompareCommand(['compare', runPath, controlPath], output)).toBe(0);
    expect(printed.join('')).toContain('Verdict: passes');
    writeFileSync(
      controlPath,
      JSON.stringify({ sha: 'main', results: { ...behavioural, failures: [] } }),
    );
    expect(await runCompareCommand(['compare', runPath, controlPath], output)).toBe(1);
    expect(await runCompareCommand(['compare', runPath], output)).toBe(2);
  });
});
