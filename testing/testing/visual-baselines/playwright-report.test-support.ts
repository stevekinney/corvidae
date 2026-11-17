/**
 * Playwright JSON reports in the shapes Playwright 1.63's JSON reporter writes,
 * for the update tooling's fail-closed tests (COR-1537). No browser runs: each
 * report is the text a container run would leave in `/out/results.json`.
 */
import { TERMINAL_SCOPE_GUARD_FILE, TERMINAL_SCOPE_GUARD_TITLE } from './suite-results.ts';

type FixtureResult = { status: string; errors?: { message: string }[] };
type FixtureTest = {
  title: string;
  /** The spec file, relative to the tests directory; `components.playwright.ts` by default. */
  file?: string;
  expectedStatus?: string;
  results: FixtureResult[];
};

/**
 * A report holding the given tests, one top-level suite per file, with stats derived the way
 * Playwright derives them.
 */
export function playwrightReport(
  tests: readonly FixtureTest[],
  errors: readonly string[] = [],
): string {
  const stats = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
  const suites = new Map<string, { title: string; file: string; specs: unknown[] }>();
  for (const [index, test] of tests.entries()) {
    const status = outcome(test);
    stats[status] += 1;
    const file = test.file ?? 'components.playwright.ts';
    const suite = suites.get(file) ?? { title: file, file, specs: [] };
    suites.set(file, suite);
    suite.specs.push({
      title: test.title,
      file,
      line: index + 1,
      tests: [
        {
          expectedStatus: test.expectedStatus ?? 'passed',
          status,
          results: test.results.map((result) => ({ errors: [], ...result })),
        },
      ],
    });
  }
  return JSON.stringify({
    suites: [...suites.values()],
    errors: errors.map((message) => ({ message })),
    stats: { startTime: '2026-10-15T12:00:00.000Z', duration: 30_500, ...stats },
  });
}

/** Playwright's `computeTestCaseOutcome`, reduced to what these fixtures use. */
function outcome(test: FixtureTest): 'expected' | 'unexpected' | 'flaky' | 'skipped' {
  const expectedStatus = test.expectedStatus ?? 'passed';
  const ran = test.results.filter(
    (result) => result.status !== 'interrupted' && result.status !== 'skipped',
  );
  if (ran.length === 0) return 'skipped';
  const passed = ran.filter((result) => result.status === expectedStatus).length;
  if (passed === ran.length) return 'expected';
  return passed === 0 ? 'unexpected' : 'flaky';
}

export const WEB_SERVER_TIMEOUT = 'Error: Timed out waiting 30000ms from config.webServer.';

/**
 * The 2026-10-15 failure: the webServer plugin runs before Playwright loads any
 * test file, so its timeout leaves no suites, zeroed stats, and one top-level error.
 */
export const WEB_SERVER_TIMEOUT_REPORT = playwrightReport([], [WEB_SERVER_TIMEOUT]);

export const passed = (title: string): FixtureTest => ({
  title,
  results: [{ status: 'passed' }],
});

/** The terminal scope guard as a run scoped away from the terminal reports it (COR-1574). */
export const failedTerminalScopeGuard: FixtureTest = {
  title: TERMINAL_SCOPE_GUARD_TITLE,
  file: TERMINAL_SCOPE_GUARD_FILE,
  results: [
    {
      status: 'failed',
      errors: [{ message: 'Error: expect(received).toBe(expected) // Object.is equality' }],
    },
  ],
};
