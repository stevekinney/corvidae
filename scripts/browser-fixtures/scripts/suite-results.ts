/**
 * Summaries of Playwright's JSON report for the Docker baseline runs (COR-1512).
 *
 * The container writes the report to `/out/results.json`
 * (`PLAYWRIGHT_JSON_OUTPUT_FILE`). These helpers turn it into the failing test
 * titles a review needs, tell screenshot failures from behavioural ones, decide
 * whether an update run may be applied, and compare a run's failures with an
 * `origin/main` control.
 */

/** Container path the JSON reporter writes to, inside the mounted output directory. */
export const CONTAINER_RESULTS_PATH = '/out/results.json';
export const RESULTS_FILE_NAME = 'results.json';

export type FailedTest = {
  /** `file › describe › test`, the stable identity used to compare runs. */
  title: string;
  file: string;
  line: number;
  status: string;
  errors: string[];
  screenshot: boolean;
};

export type SuiteResults = {
  expected: number;
  unexpected: number;
  flaky: number;
  skipped: number;
  failures: FailedTest[];
  flakyTests: string[];
  /** Tests that never ran to completion because they were skipped. */
  skippedTests: { title: string; file: string }[];
};

/** A test that did not pass, and so may not have written its baseline. */
export type NonPassingTest = { title: string; file: string; reason: string };

/** Every failing or skipped test, with the reason a review should see. */
export function nonPassingTests(results: SuiteResults): NonPassingTest[] {
  return [
    ...results.failures.map((failure) => ({
      title: failure.title,
      file: failure.file,
      reason: failure.errors[0] ?? failure.status,
    })),
    ...results.skippedTests.map((test) => ({ ...test, reason: 'skipped' })),
  ];
}

type JsonResult = { status?: string; errors?: { message?: string }[] };
type JsonTest = { status?: string; results?: JsonResult[] };
type JsonSpec = { title?: string; file?: string; line?: number; tests?: JsonTest[] };
type JsonSuite = { title?: string; file?: string; specs?: JsonSpec[]; suites?: JsonSuite[] };
type JsonReport = {
  stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number };
  suites?: JsonSuite[];
};

const SCREENSHOT_FAILURE =
  /toHaveScreenshot|Screenshot comparison failed|screenshots? (?:are|is) different|snapshot doesn't exist|Visual-regression baseline missing|expected an image/i;

/** A failure is a screenshot failure when any of its errors comes from a pixel comparison. */
export function isScreenshotFailure(errors: readonly string[]): boolean {
  return errors.some((error) => SCREENSHOT_FAILURE.test(error));
}

const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function firstLine(message: string): string {
  // Strip ANSI colour codes Playwright embeds in error messages.
  return (
    message
      .replaceAll(ANSI_COLOUR, '')
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ''
  );
}

function walk(suite: JsonSuite, path: string[], visit: (spec: JsonSpec, path: string[]) => void) {
  const titled = suite.title && suite.title !== suite.file ? [...path, suite.title] : path;
  for (const spec of suite.specs ?? []) visit(spec, titled);
  for (const child of suite.suites ?? []) walk(child, titled, visit);
}

export function summarizePlaywrightResults(text: string): SuiteResults {
  const report = JSON.parse(text) as JsonReport;
  const failures: FailedTest[] = [];
  const flakyTests: string[] = [];
  const skippedTests: { title: string; file: string }[] = [];
  for (const root of report.suites ?? []) {
    const file = root.file ?? root.title ?? '';
    walk(root, [file], (spec, path) => {
      const title = [...path, spec.title ?? ''].join(' › ');
      for (const test of spec.tests ?? []) {
        if (test.status === 'flaky') flakyTests.push(title);
        if (test.status === 'skipped') skippedTests.push({ title, file: spec.file ?? file });
        if (test.status !== 'unexpected') continue;
        const errors = (test.results ?? []).flatMap((result) =>
          (result.errors ?? []).map((error) => firstLine(error.message ?? '')),
        );
        failures.push({
          title,
          file: spec.file ?? file,
          line: spec.line ?? 0,
          status: test.results?.at(-1)?.status ?? 'failed',
          errors,
          screenshot: isScreenshotFailure(
            (test.results ?? []).flatMap((result) =>
              (result.errors ?? []).map((error) => error.message ?? ''),
            ),
          ),
        });
      }
    });
  }
  return {
    expected: report.stats?.expected ?? 0,
    unexpected: report.stats?.unexpected ?? 0,
    flaky: report.stats?.flaky ?? 0,
    skipped: report.stats?.skipped ?? 0,
    failures: failures.toSorted((left, right) => left.title.localeCompare(right.title)),
    flakyTests: flakyTests.toSorted(),
    skippedTests: skippedTests.toSorted((left, right) => left.title.localeCompare(right.title)),
  };
}

export type ApplyDecision = { apply: boolean; reason: string };

/**
 * Whether an update run's baselines may be applied:
 * - a passing suite is applied;
 * - a suite that completed with failures (exit 1 and a JSON report) is applied
 *   only with `--accept-behavioural-failures`, and never when any failure is a
 *   screenshot failure;
 * - anything else (a crash, an interrupt, a missing report) is never applied.
 */
export function decideApply(
  exitCode: number,
  results: SuiteResults | undefined,
  acceptBehaviouralFailures: boolean,
): ApplyDecision {
  if (exitCode === 0) return { apply: true, reason: 'The suite passed.' };
  if (exitCode !== 1 || results === undefined) {
    return {
      apply: false,
      reason: `The run exited ${exitCode} without a completed Playwright report; nothing is applied.`,
    };
  }
  const screenshotFailures = results.failures.filter((failure) => failure.screenshot);
  if (screenshotFailures.length > 0) {
    return {
      apply: false,
      reason: `${screenshotFailures.length} screenshot case(s) failed; a screenshot failure is never accepted.`,
    };
  }
  if (!acceptBehaviouralFailures) {
    return {
      apply: false,
      reason: `${results.failures.length} behavioural case(s) failed. Pass --accept-behavioural-failures to apply after confirming each also fails on an origin/main control.`,
    };
  }
  return {
    apply: true,
    reason: `Applied with ${results.failures.length} accepted behavioural failure(s) (--accept-behavioural-failures).`,
  };
}

export type ControlComparison = {
  /** Failing in the run and in the control: pre-existing, not the change's blocker. */
  shared: string[];
  /** Failing only in the run: the change's blockers. */
  onlyInRun: string[];
  /** Failing only in the control. */
  onlyInControl: string[];
  screenshotFailuresInRun: string[];
  passes: boolean;
};

/**
 * The stability rule: no screenshot case fails, and every behavioural failure in
 * the run also fails in an `origin/main` control run in the same image under the
 * same conditions.
 */
export function compareWithControl(run: SuiteResults, control: SuiteResults): ControlComparison {
  const runTitles = new Set(run.failures.map((failure) => failure.title));
  const controlTitles = new Set(control.failures.map((failure) => failure.title));
  const screenshotFailuresInRun = run.failures
    .filter((failure) => failure.screenshot)
    .map((failure) => failure.title);
  const onlyInRun = [...runTitles].filter((title) => !controlTitles.has(title)).toSorted();
  return {
    shared: [...runTitles].filter((title) => controlTitles.has(title)).toSorted(),
    onlyInRun,
    onlyInControl: [...controlTitles].filter((title) => !runTitles.has(title)).toSorted(),
    screenshotFailuresInRun,
    passes: screenshotFailuresInRun.length === 0 && onlyInRun.length === 0,
  };
}

type StoredRun = { sha?: string; results?: SuiteResults | null };

function readStoredRun(path: string, text: string): SuiteResults {
  const stored = JSON.parse(text) as StoredRun;
  if (!stored.results) throw new Error(`${path} has no Playwright results.`);
  return stored.results;
}

/** Markdown for the stability rule's verdict, both failure sets included. */
export function renderControlComparison(
  comparison: ControlComparison,
  run: { label: string; results: SuiteResults },
  control: { label: string; results: SuiteResults },
): string {
  const list = (titles: readonly string[]) =>
    titles.length === 0 ? ['None.'] : titles.map((title) => `- \`${title}\``);
  return [
    '## Stability control',
    '',
    `Run ${run.label}: ${run.results.failures.length} failing. Control ${control.label}: ${control.results.failures.length} failing. Verdict: ${comparison.passes ? 'passes' : 'fails'} (no screenshot failure, and every behavioural failure also fails on the control).`,
    '',
    '### Screenshot failures in the run',
    '',
    ...list(comparison.screenshotFailuresInRun),
    '',
    '### Failing in the run and the control (pre-existing)',
    '',
    ...list(comparison.shared),
    '',
    '### Failing only in the run',
    '',
    ...list(comparison.onlyInRun),
    '',
    '### Failing only in the control',
    '',
    ...list(comparison.onlyInControl),
    '',
  ].join('\n');
}

if (import.meta.main) {
  const [command, runPath, controlPath] = process.argv.slice(2);
  if (command !== 'compare' || runPath === undefined || controlPath === undefined) {
    process.stderr.write(
      'usage: suite-results.ts compare <run suite-results.json> <control suite-results.json>\n',
    );
    process.exitCode = 2;
  } else {
    const run = readStoredRun(runPath, await Bun.file(runPath).text());
    const control = readStoredRun(controlPath, await Bun.file(controlPath).text());
    const comparison = compareWithControl(run, control);
    process.stdout.write(
      renderControlComparison(
        comparison,
        { label: runPath, results: run },
        { label: controlPath, results: control },
      ),
    );
    process.exitCode = comparison.passes ? 0 : 1;
  }
}
