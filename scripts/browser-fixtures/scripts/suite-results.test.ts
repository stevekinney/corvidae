import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compareWithControl,
  decideApply,
  isScreenshotFailure,
  nonPassingTests,
  renderControlComparison,
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
        { title: 'renders', file: 'tree.playwright.ts', line: 4, tests: [{ status: 'expected' }] },
        { title: 'scrolls', file: 'tree.playwright.ts', line: 9, tests: [{ status: 'skipped' }] },
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
              tests: [{ status: 'flaky' }],
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
};
const screenshot: SuiteResults = {
  ...behavioural,
  failures: [
    { title: 'b › shot', file: 'b', line: 1, status: 'failed', errors: ['diff'], screenshot: true },
  ],
};

describe('decideApply', () => {
  it('applies a passing suite', () => {
    expect(decideApply(0, undefined, false).apply).toBe(true);
  });

  it('refuses behavioural failures without the explicit flag, and names the flag', () => {
    const decision = decideApply(1, behavioural, false);
    expect(decision.apply).toBe(false);
    expect(decision.reason).toContain('--accept-behavioural-failures');
    expect(decideApply(1, behavioural, true).apply).toBe(true);
  });

  it('never accepts a screenshot failure, even with the flag', () => {
    const decision = decideApply(1, screenshot, true);
    expect(decision.apply).toBe(false);
    expect(decision.reason).toContain('never accepted');
  });

  it('never applies a run that did not complete', () => {
    expect(decideApply(1, undefined, true).apply).toBe(false);
    expect(decideApply(130, behavioural, true).apply).toBe(false);
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

  it('exits 0 from the compare command only when the rule holds', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'suite-results-'));
    const runPath = join(directory, 'run.json');
    const controlPath = join(directory, 'control.json');
    writeFileSync(runPath, JSON.stringify({ sha: 'b', results: behavioural }));
    writeFileSync(controlPath, JSON.stringify({ sha: 'main', results: behavioural }));
    const compare = (control: string) =>
      Bun.spawn(
        ['bun', join(import.meta.dirname, 'suite-results.ts'), 'compare', runPath, control],
        {
          stdout: 'pipe',
          stderr: 'pipe',
        },
      ).exited;
    expect(await compare(controlPath)).toBe(0);
    writeFileSync(
      controlPath,
      JSON.stringify({ sha: 'main', results: { ...behavioural, failures: [] } }),
    );
    expect(await compare(controlPath)).toBe(1);
  });
});
