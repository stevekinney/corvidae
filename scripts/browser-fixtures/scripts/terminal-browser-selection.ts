/**
 * What `bun run test:browser:terminal` must select and run (COR-474).
 *
 * Playwright already fails a run that selects nothing, but not one that quietly loses a browser or
 * one spec in one browser. These checks compare the selection, and then the results, with the
 * matrix the issue requires, so an absent cell fails the command instead of passing with fewer
 * tests. The functions are pure; `run-terminal-browser.ts` feeds them Playwright's JSON.
 */

export const TERMINAL_PROJECTS = ['chromium', 'firefox-terminal', 'webkit-terminal'] as const;

/**
 * The positional filter Playwright matches against a file's path as a regular expression. It is
 * anchored to a `tests` directory and the `terminal-*.playwright.ts` name, so a checkout path that
 * happens to contain `terminal-` selects nothing extra.
 */
export const TERMINAL_FILE_FILTER = String.raw`/tests/terminal-[^/]*\.playwright\.ts$`;

/** Specs every one of the three browsers must run. */
export const TERMINAL_BEHAVIORAL_SPECS = [
  'terminal-failure.playwright.ts',
  'terminal-input.playwright.ts',
  'terminal-inspection.playwright.ts',
  'terminal-layout.playwright.ts',
  'terminal-mouse.playwright.ts',
  'terminal-recovery.playwright.ts',
  'terminal-vt.playwright.ts',
] as const;

/** The baseline spec, which belongs to Chromium alone. */
export const TERMINAL_VISUAL_SPEC = 'terminal-visual.playwright.ts';

/** Themes and viewports in the harness; each visual fixture is swept across all of them. */
export const THEME_COUNT = 2;
export const VIEWPORT_COUNT = 3;

type ReportTest = {
  projectName?: string;
  status?: string;
  expectedStatus?: string;
  annotations?: Array<{ type?: string }>;
  results?: Array<{ status?: string }>;
};
type ReportSpec = { title?: string; file?: string; tests?: ReportTest[] };
type ReportSuite = { title?: string; file?: string; specs?: ReportSpec[]; suites?: ReportSuite[] };
export type PlaywrightReport = { suites?: ReportSuite[] };

export type SelectedTest = {
  file: string;
  project: string;
  title: string;
  skipped: boolean;
  /** Whether the run reported this test as having passed (or, in a listing, was not run). */
  outcome: string | undefined;
};

function baseName(file: string): string {
  return file.split('/').at(-1) ?? file;
}

/** Every test in a Playwright JSON report, listing or results, flattened. */
export function flattenReport(report: PlaywrightReport): SelectedTest[] {
  const found: SelectedTest[] = [];
  const visit = (suite: ReportSuite, inherited: string, path: string[]): void => {
    const file = suite.file ?? inherited;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        found.push({
          file: baseName(spec.file ?? file),
          project: test.projectName ?? '',
          title: [...path, spec.title ?? ''].join(' › '),
          skipped:
            test.expectedStatus === 'skipped' ||
            (test.annotations ?? []).some(
              (annotation) => annotation.type === 'skip' || annotation.type === 'fixme',
            ),
          outcome: test.results?.at(-1)?.status ?? test.status,
        });
      }
    }
    // A file's own suite is titled with its name; only describe blocks belong in a test's title.
    for (const child of suite.suites ?? []) {
      visit(child, file, child.title ? [...path, child.title] : path);
    }
  };
  for (const suite of report.suites ?? []) visit(suite, suite.file ?? '', []);
  return found;
}

/**
 * The problems with a selection, empty when it is the required matrix: every behavioral spec in
 * all three browsers with the same number of tests in each, the baselines in Chromium with every
 * fixture in both themes at every viewport, and nothing skipped.
 */
export function selectionProblems(
  tests: readonly SelectedTest[],
  fixtureCount: number,
  recorded?: TitleManifest,
): string[] {
  const problems: string[] = [];
  const count = (file: string, project: string) =>
    tests.filter((test) => test.file === file && test.project === project).length;

  for (const project of TERMINAL_PROJECTS) {
    if (!tests.some((test) => test.project === project)) {
      problems.push(`no test is selected for the ${project} project`);
    }
  }
  for (const file of TERMINAL_BEHAVIORAL_SPECS) {
    const counts = TERMINAL_PROJECTS.map((project) => count(file, project));
    TERMINAL_PROJECTS.forEach((project, index) => {
      if (counts[index] === 0) problems.push(`${file} has no test in ${project}`);
    });
    if (new Set(counts).size > 1) {
      problems.push(`${file} selects different numbers of tests per browser: ${counts.join(', ')}`);
    }
  }
  const sweep = tests.filter(
    (test) => test.file === TERMINAL_VISUAL_SPEC && test.project === 'chromium',
  ).length;
  const required = THEME_COUNT * VIEWPORT_COUNT * fixtureCount + 1;
  if (sweep !== required) {
    problems.push(
      `${TERMINAL_VISUAL_SPEC} selects ${sweep} chromium tests but the matrix needs ${required} (${fixtureCount} fixtures, both themes, three viewports, and the manifest check)`,
    );
  }
  for (const project of ['firefox-terminal', 'webkit-terminal']) {
    if (count(TERMINAL_VISUAL_SPEC, project) > 0) {
      problems.push(`${TERMINAL_VISUAL_SPEC} must not run in ${project}`);
    }
  }
  const unexpected = tests.filter(
    (test) =>
      !(TERMINAL_BEHAVIORAL_SPECS as readonly string[]).includes(test.file) &&
      test.file !== TERMINAL_VISUAL_SPEC,
  );
  for (const test of unexpected) {
    problems.push(`${test.file} is selected but is not a terminal spec (${test.project})`);
  }
  if (recorded !== undefined) problems.push(...manifestProblems(tests, recorded));
  for (const test of tests.filter((candidate) => candidate.skipped)) {
    problems.push(`${test.file} › ${test.title} (${test.project}) is skipped`);
  }
  return problems;
}

/** The expected test titles of each spec file, as recorded by `--write-manifest`. */
export type TitleManifest = Readonly<Record<string, readonly string[]>>;

/** The titles of every spec file in `tests`, from the Chromium project, sorted. */
export function titlesByFile(tests: readonly SelectedTest[]): Record<string, string[]> {
  const titles: Record<string, string[]> = {};
  for (const test of tests.filter((candidate) => candidate.project === 'chromium')) {
    (titles[test.file] ??= []).push(test.title);
  }
  for (const list of Object.values(titles)) list.sort();
  return titles;
}

/**
 * Each recorded title must be selected in every browser that runs its spec, and nothing unrecorded
 * may be selected, so removing a test from all three browsers fails the guard as surely as
 * removing it from one.
 */
export function manifestProblems(
  tests: readonly SelectedTest[],
  recorded: TitleManifest,
): string[] {
  const problems: string[] = [];
  for (const [file, titles] of Object.entries(recorded)) {
    const projects = file === TERMINAL_VISUAL_SPEC ? ['chromium'] : [...TERMINAL_PROJECTS];
    for (const project of projects) {
      const present = new Set(
        tests
          .filter((test) => test.file === file && test.project === project)
          .map((test) => test.title),
      );
      for (const title of titles) {
        if (!present.has(title)) problems.push(`${file} › ${title} is missing in ${project}`);
      }
      for (const title of present) {
        if (!titles.includes(title)) {
          problems.push(`${file} › ${title} (${project}) is not in the recorded manifest`);
        }
      }
    }
  }
  for (const file of [...TERMINAL_BEHAVIORAL_SPECS, TERMINAL_VISUAL_SPEC]) {
    if (!(file in recorded)) problems.push(`${file} has no entry in the recorded manifest`);
  }
  return problems;
}

/** The problems with a finished run, given what was selected: every selected test must have passed. */
export function resultProblems(
  selected: readonly SelectedTest[],
  ran: readonly SelectedTest[],
  options: { subset?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const key = (test: SelectedTest) => `${test.project} ${test.file} ${test.title}`;
  if (options.subset === true) {
    // Extra Playwright arguments narrowed the run: whatever ran must have been selected, must have
    // passed, and must not be nothing.
    const known = new Set(selected.map(key));
    if (ran.length === 0) problems.push('no test ran');
    for (const test of ran) {
      if (!known.has(key(test))) {
        problems.push(`${test.file} › ${test.title} (${test.project}) ran but was not selected`);
      }
    }
  } else if (ran.length !== selected.length) {
    problems.push(`${selected.length} tests were selected but ${ran.length} reported a result`);
  }
  for (const test of ran) {
    if (test.outcome !== 'passed') {
      problems.push(`${test.file} › ${test.title} (${test.project}) ended as ${test.outcome}`);
    }
  }
  return problems;
}
