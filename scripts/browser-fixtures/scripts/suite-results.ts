/**
 * Summaries of Playwright's JSON report for the Docker baseline runs (COR-1512).
 *
 * The container writes the report to `/out/results.json`
 * (`PLAYWRIGHT_JSON_OUTPUT_FILE`). These helpers turn it into the failing test
 * titles a review needs, tell screenshot failures from behavioural ones, decide
 * whether an update run may be applied, and compare a run's failures with an
 * `origin/main` control.
 *
 * A report is not proof that the suite ran. A webServer or globalSetup failure
 * still exits 1 and writes a report, with the failure in its top-level `errors`
 * and no test executed; an interrupted run lists the tests it never reached.
 * `incompleteRunReasons` reads both, and neither an update nor a stability
 * comparison accepts such a run (COR-1537).
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
  /** Errors outside any test: a webServer or globalSetup failure, a test file that failed to load. */
  globalErrors: string[];
  /** Every test the run selected, after `--grep`, projects, and the component scope. */
  selected: number;
  /** Selected tests that ran to a pass or a failure. */
  executed: number;
  /**
   * Selected tests Playwright never ran: no result at all, an interrupted result, or a
   * skipped result on a test that did not skip itself (Playwright's "did not run").
   */
  notRun: string[];
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
type JsonTest = { status?: string; expectedStatus?: string; results?: JsonResult[] };
type JsonSpec = { title?: string; file?: string; line?: number; tests?: JsonTest[] };
type JsonSuite = { title?: string; file?: string; specs?: JsonSpec[]; suites?: JsonSuite[] };
type JsonReport = {
  errors?: { message?: string }[];
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

/** Playwright's own "did not run": never started, interrupted, or skipped without asking to be. */
function neverRan(test: JsonTest): boolean {
  const statuses = (test.results ?? []).map((result) => result.status);
  return (
    statuses.length === 0 ||
    statuses.includes('interrupted') ||
    (statuses.includes('skipped') && test.expectedStatus !== 'skipped')
  );
}

function executed(test: JsonTest): boolean {
  return (test.results ?? []).some(
    (result) => result.status !== 'skipped' && result.status !== 'interrupted',
  );
}

export function summarizePlaywrightResults(text: string): SuiteResults {
  const report = JSON.parse(text) as JsonReport;
  const failures: FailedTest[] = [];
  const flakyTests: string[] = [];
  const skippedTests: { title: string; file: string }[] = [];
  const notRun: string[] = [];
  let selected = 0;
  let executedCount = 0;
  for (const root of report.suites ?? []) {
    const file = root.file ?? root.title ?? '';
    walk(root, [file], (spec, path) => {
      const title = [...path, spec.title ?? ''].join(' › ');
      for (const test of spec.tests ?? []) {
        selected += 1;
        if (neverRan(test)) notRun.push(title);
        else if (executed(test)) executedCount += 1;
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
    globalErrors: (report.errors ?? []).map((error) => firstLine(error.message ?? '')),
    selected,
    executed: executedCount,
    notRun: notRun.toSorted(),
  };
}

const LISTED_NOT_RUN = 5;

/**
 * Why a report does not describe a run that completed normally; empty when it does.
 * Any global error, an empty selection, no executed test, or any selected test that
 * never ran makes the run's output unusable: the baselines it did not write would
 * otherwise read as orphans.
 */
export function incompleteRunReasons(results: SuiteResults): string[] {
  const reasons: string[] = [];
  if (results.globalErrors.length > 0) {
    reasons.push(
      `Playwright reported ${results.globalErrors.length} error${results.globalErrors.length === 1 ? '' : 's'} outside any test: ${results.globalErrors.join('; ')}`,
    );
  }
  if (results.selected === 0) reasons.push('Playwright selected no tests.');
  if (results.executed === 0) reasons.push('No test executed.');
  if (results.notRun.length > 0) {
    const listed = results.notRun.slice(0, LISTED_NOT_RUN).join('; ');
    const more = results.notRun.length - LISTED_NOT_RUN;
    reasons.push(
      `${results.notRun.length} of ${results.selected} selected tests never ran (${listed}${more > 0 ? `; and ${more} more` : ''}).`,
    );
  }
  return reasons;
}

export type ApplyDecision = { apply: boolean; reason: string };

/** The spec that holds the terminal scope guard, relative to the tests directory. */
export const TERMINAL_SCOPE_GUARD_FILE = 'terminal-visual.playwright.ts';
/** The guard's exact title. It fails whenever `CINDER_TEST_COMPONENTS` leaves the terminal out. */
export const TERMINAL_SCOPE_GUARD_TITLE =
  'the screenshot scope includes the terminal, so every cell captures an image';

/** Whether a failure is the terminal scope guard: its file and its exact, top-level title. */
export function isTerminalScopeGuard(failure: Pick<FailedTest, 'file' | 'title'>): boolean {
  return (
    failure.file === TERMINAL_SCOPE_GUARD_FILE &&
    failure.title === `${TERMINAL_SCOPE_GUARD_FILE} › ${TERMINAL_SCOPE_GUARD_TITLE}`
  );
}

/**
 * Whether an update run's baselines may be applied:
 * - a run without a report, or whose report shows it did not complete normally
 *   (`incompleteRunReasons`), is never applied, whatever its exit code or flags;
 * - a passing suite is applied;
 * - a run scoped by `CINDER_TEST_COMPONENTS` whose only failure is the terminal
 *   scope guard (`isTerminalScopeGuard`) is applied: that guard fails by design
 *   whenever the scope leaves the terminal out (COR-1574). On a full run, or next
 *   to any other failure, it blocks like every other failure;
 * - a suite that completed with failures (exit 1 and a JSON report) is applied
 *   only with `--accept-behavioural-failures`, and never when any failure is a
 *   screenshot failure;
 * - anything else (a crash, an interrupt, a missing report) is never applied.
 */
export function decideApply(
  exitCode: number,
  results: SuiteResults | undefined,
  acceptBehaviouralFailures: boolean,
  componentScope: 'all' | readonly string[],
): ApplyDecision {
  if (results === undefined) {
    return {
      apply: false,
      reason: `The run exited ${exitCode} and left no Playwright report; nothing is applied or deleted.`,
    };
  }
  const incomplete = incompleteRunReasons(results);
  if (incomplete.length > 0) {
    return {
      apply: false,
      reason: `The Playwright run did not complete normally; nothing is applied or deleted. ${incomplete.join(' ')}`,
    };
  }
  if (exitCode === 0) return { apply: true, reason: 'The suite passed.' };
  if (exitCode !== 1) {
    return {
      apply: false,
      reason: `The run exited ${exitCode} without a completed Playwright report; nothing is applied.`,
    };
  }
  const [onlyFailure, ...otherFailures] = results.failures;
  if (
    componentScope !== 'all' &&
    onlyFailure !== undefined &&
    otherFailures.length === 0 &&
    isTerminalScopeGuard(onlyFailure)
  ) {
    return {
      apply: true,
      reason: `The run was scoped to ${componentScope.join(', ')}, and its one failure is the terminal scope guard, which fails by design when the scope leaves the terminal out.`,
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
  /** Why the run, or the control, did not complete normally: an incomplete run proves nothing. */
  incompleteRun: string[];
  incompleteControl: string[];
  passes: boolean;
};

/**
 * The stability rule: both runs completed normally, no screenshot case fails, and
 * every behavioural failure in the run also fails in an `origin/main` control run
 * in the same image under the same conditions.
 */
export function compareWithControl(run: SuiteResults, control: SuiteResults): ControlComparison {
  const runTitles = new Set(run.failures.map((failure) => failure.title));
  const controlTitles = new Set(control.failures.map((failure) => failure.title));
  const screenshotFailuresInRun = run.failures
    .filter((failure) => failure.screenshot)
    .map((failure) => failure.title);
  const onlyInRun = [...runTitles].filter((title) => !controlTitles.has(title)).toSorted();
  const incompleteRun = incompleteRunReasons(run);
  const incompleteControl = incompleteRunReasons(control);
  return {
    shared: [...runTitles].filter((title) => controlTitles.has(title)).toSorted(),
    onlyInRun,
    onlyInControl: [...controlTitles].filter((title) => !runTitles.has(title)).toSorted(),
    screenshotFailuresInRun,
    incompleteRun,
    incompleteControl,
    passes:
      incompleteRun.length === 0 &&
      incompleteControl.length === 0 &&
      screenshotFailuresInRun.length === 0 &&
      onlyInRun.length === 0,
  };
}

type StoredRun = { sha?: string; results?: SuiteResults | null };

function readStoredRun(path: string, text: string): SuiteResults {
  const stored = JSON.parse(text) as StoredRun;
  if (!stored.results) throw new Error(`${path} has no Playwright results.`);
  if (!Array.isArray(stored.results.notRun) || !Array.isArray(stored.results.globalErrors)) {
    throw new Error(
      `${path} does not record whether its run completed; re-run it with the current tooling.`,
    );
  }
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
  const bullets = (reasons: readonly string[]) => reasons.map((reason) => `- ${reason}`);
  return [
    '## Stability control',
    '',
    `Run ${run.label}: ${run.results.failures.length} failing. Control ${control.label}: ${control.results.failures.length} failing. Verdict: ${comparison.passes ? 'passes' : 'fails'} (both runs completed, no screenshot failure, and every behavioural failure also fails on the control).`,
    '',
    ...(comparison.incompleteRun.length > 0
      ? ['### The run did not complete normally', '', ...bullets(comparison.incompleteRun), '']
      : []),
    ...(comparison.incompleteControl.length > 0
      ? [
          '### The control did not complete normally',
          '',
          ...bullets(comparison.incompleteControl),
          '',
        ]
      : []),
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

/**
 * The `compare` command: prints the control comparison and returns 0 when the stability
 * rule holds, 1 when it does not, and 2 for a usage error.
 */
export async function runCompareCommand(
  argv: readonly string[],
  output: { stdout: (text: string) => void; stderr: (text: string) => void },
): Promise<number> {
  const [command, runPath, controlPath] = argv;
  if (command !== 'compare' || runPath === undefined || controlPath === undefined) {
    output.stderr(
      'usage: suite-results.ts compare <run suite-results.json> <control suite-results.json>\n',
    );
    return 2;
  }
  const run = readStoredRun(runPath, await Bun.file(runPath).text());
  const control = readStoredRun(controlPath, await Bun.file(controlPath).text());
  const comparison = compareWithControl(run, control);
  output.stdout(
    renderControlComparison(
      comparison,
      { label: runPath, results: run },
      { label: controlPath, results: control },
    ),
  );
  return comparison.passes ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await runCompareCommand(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
