/**
 * Captures every page of Interborough for the design review (`.agents/skills/design-review`): every
 * route holding believable content (`tests/e2e/00-showcase.spec.ts`, at 375, 768 and 1280 pixels, the
 * data for layout, hierarchy and density) and the shell's chrome in each form it takes
 * (`tests/e2e/shell-chrome.spec.ts`: the sidebar, the rail, the drawer, 320 pixels, 200% text; `tests/e2e/shell-search.spec.ts`: the search palette), Home on a
 * fresh installation (`tests/e2e/first-run.spec.ts`), every route on every tab holding the stress seed's
 * 300-character words (`tests/e2e/responsive.spec.ts`, the same widths, the data for overflow and
 * truncation), and every view loading, empty, failed, forbidden and ready, plus Health's band
 * states and the not-found page (`tests/e2e/15-view-states.spec.ts`, at 375 and 1280 pixels), in
 * light and dark.
 *
 * It runs those three Playwright specifications with `INTERBOROUGH_DESIGN_REVIEW_CAPTURE` set, so they
 * screenshot each page once it holds its content (`tests/e2e/design-review-capture.ts`), and writes
 * `manifest.jsonl` (one line per capture) and `summary.json` (what ran and how it exited) beside
 * the screenshots, then holds what each page measured to the rubric's thresholds
 * (`scripts/design-review-geometry.ts`) and writes `geometry-report.md` and `geometry-findings.json`
 * there too. Every page of a capture runs at the sample world's "now", Monday, Nov 2, 2026,
 * 10:46 AM in America/Chicago (`fixtures/sample-now.ts`): the specifications' shared fixture
 * (`tests/e2e/fixtures.ts`) fixes the browser's `Date` there and sets its time zone while
 * `INTERBOROUGH_DESIGN_REVIEW_CAPTURE` is set. A specification's own assertion failing does not
 * lose its captures, which are taken before the assertions; the summary records the exit code so
 * the reviewer knows the run was not clean.
 *
 *   bun scripts/design-review-capture.ts [--out <dir>] [--scheme light|dark|both]
 *     [--data showcase|stress|both] [--specs all|responsive|states] [--grep <pattern>]
 *
 * `--data` chooses the content: `showcase` runs only the showcase specifications, `stress` runs the
 * responsive and view-states specifications, and `both` (the default) runs every one of them. `--specs`
 * narrows the stress data to one of its two specifications, so it means `--data stress` when
 * `--data` is not given, and is refused with `--data showcase`.
 *
 * `--grep` narrows to the tests whose titles match, for example `--grep '/agents'` for a sign-off on
 * the agent pages. The default output directory is `<repository>/tmp/design-review/<time stamp>`,
 * which Git ignores. Exit 0 when at least one capture was written, 1 when none was or when a listed
 * specification that captures a route the filter matches ran no test (its titles do not name the
 * route), 2 on bad usage or when the end-to-end port is already taken.
 *
 * Playwright reuses a server already listening on the end-to-end port outside CI, which on a shared
 * host can be another checkout's build, so the capture refuses to start when that port is taken
 * and asks for a free `INTERBOROUGH_E2E_PORT` instead of screenshotting someone else's tree.
 */
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withHostSlots, withMemoryAdmission, type HostSlots } from '../../../scripts/host-slots.ts';
import { runInProcessGroup } from '../../../scripts/run-exclusively.ts';
import { auditGeometry } from './design-review-geometry.ts';
import { endToEndPort } from './environment-configuration.ts';

const applicationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(applicationDirectory, '..', '..');

const SPECIFICATIONS = {
  responsive: 'tests/e2e/responsive.spec.ts',
  states: 'tests/e2e/15-view-states.spec.ts',
} as const;

/**
 * The specifications that hold believable content, which `--data showcase` runs alone: every route
 * on the sample world, the shell's chrome in each form it takes and each width it is drawn at, its
 * search, its not-found and forbidden pages, the restart flow (the failed dialog and the back-up
 * confirmations), Home on a fresh installation (`first-run.spec.ts`, whose own host holds no
 * provider, agent or chat), Home on the sample world in each state the HomeAndShell board draws
 * (`home.spec.ts`), the chat list in each of its states (`chat-list.spec.ts`), and an open chat with its approval,
 * details popover, Permissions select, and its loading, offline, denied and answered-in-Reviews states
 * (`chat-page.spec.ts`), Chat on a phone and a tablet and with no provider (`chat-responsive.spec.ts`), and a chat of
 * thirty tool calls (`chat-tool-call-turn.spec.ts`), and the chat states of the ChatStates board: ended by
 * a restart, no provider, held by a disabled plugin, failed partway, not found and ended on a tool call
 * (`chat-states.spec.ts`), and New chat with Assistant, with no provider and once Assistant is
 * chosen (`chat-new.spec.ts`), New chat loading, failing to load, with no agents and failing to start
 * (`chat-new-states.spec.ts`), and choosing an agent, typing, sending the first message, starting
 * from Workflows and the chat that came of it (`chat-new-workflows.spec.ts`), Duplicate on a
 * plugin's code agent with its confirmation of what the copy leaves out, and a copy's page with a
 * changed source and an unchanged one (`agent-duplicate.spec.ts`), a plugin's code agent edited in
 * place on its Settings and Access tabs with its versions and Restore, and the read-only tabs of an
 * agent whose plugin is disabled (`agent-plugin-editing.spec.ts`), and an open chat with no
 * message yet, one deleted while open, and both with no model provider (`chat-availability.spec.ts`),
 * and the workflow builder's step cards: a step of every kind, empty lists, the catalog loading and
 * failing, the add menu, and the read-only phone (`workflow-builder-cards.spec.ts`).
 */
const SHOWCASE_SPECIFICATIONS = [
  'tests/e2e/00-showcase.spec.ts',
  'tests/e2e/shell-chrome.spec.ts',
  'tests/e2e/shell-search.spec.ts',
  'tests/e2e/shell-states.spec.ts',
  'tests/e2e/schedules-list.spec.ts',
  'tests/e2e/schedules-states.spec.ts',
  'tests/e2e/schedules-new.spec.ts',
  'tests/e2e/schedules-edit.spec.ts',
  'tests/e2e/schedules-detail.spec.ts',
  'tests/e2e/health-overview.spec.ts',
  'tests/e2e/health-states.spec.ts',
  'tests/e2e/health-workers-states.spec.ts',
  'tests/e2e/health-storage.spec.ts',
  'tests/e2e/health-audit.spec.ts',
  'tests/e2e/health-audit-states.spec.ts',
  'tests/e2e/restart.spec.ts',
  'tests/e2e/settings-general.spec.ts',
  'tests/e2e/settings-allowed-models.spec.ts',
  'tests/e2e/settings-models.spec.ts',
  'tests/e2e/settings-a2a.spec.ts',
  'tests/e2e/settings-plugins.spec.ts',
  'tests/e2e/settings-data-and-retention.spec.ts',
  'tests/e2e/api-reference.spec.ts',
  'tests/e2e/first-run.spec.ts',
  'tests/e2e/home.spec.ts',
  // Home's two activity bands in each state their design rows name (COR-2227).
  'tests/e2e/home-activity.spec.ts',
  'tests/e2e/chat-list.spec.ts',
  'tests/e2e/chat-page.spec.ts',
  'tests/e2e/chat-responsive.spec.ts',
  'tests/e2e/chat-tool-call-turn.spec.ts',
  'tests/e2e/chat-states.spec.ts',
  'tests/e2e/chat-new.spec.ts',
  'tests/e2e/chat-new-states.spec.ts',
  'tests/e2e/chat-new-workflows.spec.ts',
  'tests/e2e/agent-duplicate.spec.ts',
  'tests/e2e/agent-plugin-editing.spec.ts',
  'tests/e2e/chat-availability.spec.ts',
  // An archived chat, the Archived chats row and view, and a refused archive.
  'tests/e2e/chat-archive.spec.ts',
  'tests/e2e/workflow-builder-cards.spec.ts',
  // The Runs list and the run page in the states the sample world does not hold, and the run page
  // in each state it does (COR-2423, COR-2424).
  'tests/e2e/runs-states.spec.ts',
  'tests/e2e/run-page-states.spec.ts',
  'tests/e2e/run-page-live-states.spec.ts',
  // A working goal, Start again held, and Start again pressed (COR-2425).
  'tests/e2e/goal-page-states.spec.ts',
  // Every view loading, empty, failed and forbidden, which a route filter (`--grep '/runs'`) reaches
  // through each title's address, and the goal check's loading states.
  'tests/e2e/15-view-states.spec.ts',
] as const;

type Scheme = 'light' | 'dark';

/** The parsed command line. */
interface Options {
  readonly out: string;
  readonly schemes: readonly Scheme[];
  readonly specifications: readonly string[];
  readonly grep: string | undefined;
}

/** Reads the command line, or answers the usage error to print. */
export function parseArguments(argv: readonly string[], now = new Date()): Options | string {
  let out = join(
    repositoryDirectory,
    'tmp',
    'design-review',
    now.toISOString().replaceAll(/[:.]/g, '-'),
  );
  let schemes: Scheme[] = ['light', 'dark'];
  let stress: string[] = Object.values(SPECIFICATIONS);
  let data: 'showcase' | 'stress' | 'both' | undefined;
  let specsGiven = false;
  let grep: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) return `${flag ?? ''} needs a value`;
    index += 1;
    switch (flag) {
      case '--out':
        out = resolve(value);
        break;
      case '--scheme':
        if (value === 'both') schemes = ['light', 'dark'];
        else if (value === 'light' || value === 'dark') schemes = [value];
        else return `--scheme must be light, dark or both, not "${value}"`;
        break;
      case '--data':
        if (value === 'showcase' || value === 'stress' || value === 'both') data = value;
        else return `--data must be showcase, stress or both, not "${value}"`;
        break;
      case '--specs':
        if (value === 'all') stress = Object.values(SPECIFICATIONS);
        else if (value === 'responsive' || value === 'states') stress = [SPECIFICATIONS[value]];
        else return `--specs must be all, responsive or states, not "${value}"`;
        specsGiven = true;
        break;
      case '--grep':
        grep = value;
        break;
      default:
        return `unknown flag ${flag ?? ''}`;
    }
  }
  if (specsGiven && data === undefined) data = 'stress';
  if (specsGiven && data === 'showcase') {
    return '--specs narrows the stress data, so it cannot be used with --data showcase';
  }
  // A specification both lists hold (the view states) runs once, where it is first listed.
  const specifications = [
    ...new Set([
      ...(data === 'stress' ? [] : SHOWCASE_SPECIFICATIONS),
      ...(data === 'showcase' ? [] : stress),
    ]),
  ];
  return { out, schemes, specifications, grep };
}

/** The showcase specifications, for the test that holds each one's titles to the routes it captures. */
export const SHOWCASE_SPECIFICATION_PATHS: readonly string[] = SHOWCASE_SPECIFICATIONS;

/** The routes a specification's source captures by a literal `route: '/…'`. */
export function capturedRoutes(source: string): string[] {
  return [...source.matchAll(/route:\s*'(\/[^']*)'/g)].map((match) => match[1]!);
}

/**
 * The captures a filtered run could never reach: each literal route a test captures that is in
 * neither the test's own title nor the title of the `test.describe` around it. Playwright's
 * `--grep` matches the whole title path, so a route the path does not name is skipped by a route
 * filter, and the capture silently runs nothing for it. Reads the source as text: each test is the
 * text from its `test(` to the next, and its describe is the last `test.describe(` before it.
 */
export function routesMissingFromTitles(source: string): { title: string; route: string }[] {
  const missing: { title: string; route: string }[] = [];
  for (const test of testsOf(source)) {
    for (const route of capturedRoutes(test.body)) {
      if (!test.path.includes(route)) missing.push({ title: test.title, route });
    }
  }
  return missing;
}

/**
 * Each test of a specification's source: its title, its title path (the `test.describe` around it,
 * then its own title, as Playwright's `--grep` matches them) and its text, from its `test(` to the
 * next. A title written as a template keeps its `${…}` placeholders.
 */
function testsOf(source: string): { title: string; path: string; body: string }[] {
  const markers = [
    ...source.matchAll(/\btest(\.describe)?\(\s*(`[^`]*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g),
  ].map((match) => ({
    index: match.index,
    describe: match[1] !== undefined,
    title: match[2]!.slice(1, -1),
  }));
  const tests: { title: string; path: string; body: string }[] = [];
  let describe = '';
  markers.forEach((marker, position) => {
    if (marker.describe) {
      describe = marker.title;
      return;
    }
    const end = markers[position + 1]?.index ?? source.length;
    tests.push({
      title: marker.title,
      path: `${describe} ${marker.title}`,
      body: source.slice(marker.index, end),
    });
  });
  return tests;
}

/** One file's suite in Playwright's JSON report, as far as counting its tests needs it. */
type ReportSuite = {
  readonly file?: string;
  readonly specs?: readonly unknown[];
  readonly suites?: readonly ReportSuite[];
};

function testsIn(suite: ReportSuite): number {
  return (
    (suite.specs?.length ?? 0) +
    (suite.suites ?? []).reduce((sum, inner) => sum + testsIn(inner), 0)
  );
}

/**
 * The listed specifications that ran no test, from Playwright's JSON report. With `--grep`, a
 * specification is expected to run only when the title path of one of its tests matches the filter;
 * without it, every listed specification is. A capture with such a specification exits 1, so a run
 * never silently drops a specification the filter reaches.
 */
export function specificationsThatRanNothing(
  report: { readonly suites?: readonly ReportSuite[] },
  specifications: readonly string[],
  grep: string | undefined,
  sourceOf: (specification: string) => string,
): string[] {
  // Playwright names a file by its path from the configuration's `testDir` (`./tests`, so
  // `e2e/00-showcase.spec.ts`), and the list names it from the application
  // (`tests/e2e/00-showcase.spec.ts`): a report file is the listed one when the list's path ends in it.
  const files = (report.suites ?? []).flatMap((suite) =>
    suite.file === undefined ? [] : [{ file: suite.file, tests: testsIn(suite) }],
  );
  const ranIn = (specification: string): number =>
    files
      .filter(({ file }) => specification === file || specification.endsWith(`/${file}`))
      .reduce((sum, { tests }) => sum + tests, 0);
  const filter = grep === undefined ? undefined : new RegExp(grep);
  return specifications.filter((specification) => {
    // A specification the filter should reach is one with a test whose title path it matches, as
    // Playwright's `--grep` matches: a capture of a matching route under a title that does not
    // name it is the titles test's to catch (`routesMissingFromTitles`), not this one's.
    const expected =
      filter === undefined ||
      testsOf(sourceOf(specification)).some((test) => filter.test(test.path));
    return expected && ranIn(specification) === 0;
  });
}

/** The probe accepts connections only to hold the port, so it ignores whatever a client sends. */
export const probeSocketHandlers = {
  data(): void {},
};

/** Whether nothing listens on `port` on the loopback address, so Playwright will start its own server. */
export function portIsFree(port: number): boolean {
  try {
    const probe = Bun.listen({ hostname: '127.0.0.1', port, socket: probeSocketHandlers });
    probe.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Counts the lines of the manifest, which is one capture each. */
export async function captureCount(out: string): Promise<number> {
  try {
    const text = await readFile(join(out, 'manifest.jsonl'), 'utf8');
    return text.split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
}

/** What a capture needs from the host it runs on, so a test can stand in for Playwright. */
export interface CaptureEnvironment {
  readonly standardOutput: (text: string) => void;
  readonly standardError: (text: string) => void;
  readonly portIsFree: (port: number) => boolean;
  /** Runs the capture command with the given environment variables added, answering its exit code. */
  readonly run: (command: readonly string[], variables: Record<string, string>) => Promise<number>;
}

/** The host the command line runs on: the real port probe and a real child process. */
export const hostEnvironment: CaptureEnvironment = {
  standardOutput: process.stdout.write.bind(process.stdout),
  standardError: process.stderr.write.bind(process.stderr),
  portIsFree,
  async run(command, variables) {
    const child = Bun.spawn([...command], {
      cwd: applicationDirectory,
      env: { ...process.env, ...variables },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    return child.exited;
  },
};

/** Captures what the command line names and answers the exit code. */
export async function captureDesignReview(
  argv: readonly string[] = process.argv.slice(2),
  environment: CaptureEnvironment = hostEnvironment,
): Promise<number> {
  const options = parseArguments(argv);
  if (typeof options === 'string') {
    environment.standardError(`${options}\n`);
    return 2;
  }
  const port = endToEndPort();
  if (!environment.portIsFree(port)) {
    environment.standardError(
      `design review: port ${port} is already in use, and Playwright would capture whatever server holds it. Set INTERBOROUGH_E2E_PORT to a free port (it uses that one and the six after it) and run again.\n`,
    );
    return 2;
  }
  await mkdir(options.out, { recursive: true });
  const runs: { scheme: Scheme; exitCode: number; ranNothing: string[] }[] = [];
  for (const scheme of options.schemes) {
    // The JSON report says how many tests each specification ran, so one that ran none is named.
    const report = join(options.out, `playwright-${scheme}.json`);
    const command = [
      'bun',
      '--bun',
      'playwright',
      'test',
      '--config',
      'playwright.config.ts',
      '--reporter=list,json',
      ...options.specifications,
      ...(options.grep === undefined ? [] : ['--grep', options.grep]),
    ];
    environment.standardOutput(`design review: capturing in ${scheme}: ${command.join(' ')}\n`);
    const exitCode = await environment.run(command, {
      INTERBOROUGH_DESIGN_REVIEW_CAPTURE: options.out,
      INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME: scheme,
      PLAYWRIGHT_JSON_OUTPUT_NAME: report,
    });
    // A run that wrote no report (it never started) is judged by its exit code alone.
    const written = await readReport(report);
    const ranNothing =
      written === undefined
        ? []
        : specificationsThatRanNothing(written, options.specifications, options.grep, (path) =>
            readSourceOf(path),
          );
    for (const specification of ranNothing) {
      environment.standardError(
        `design review: ${specification} ran no test in ${scheme}; its titles may not name the route the filter asks for\n`,
      );
    }
    runs.push({ scheme, exitCode, ranNothing });
  }
  const captures = await captureCount(options.out);
  const geometry = await auditGeometry(options.out);
  const ranNothing = runs.some((run) => run.ranNothing.length > 0);
  const summary = {
    out: options.out,
    captures,
    specifications: options.specifications,
    grep: options.grep ?? null,
    runs,
    clean: runs.every((run) => run.exitCode === 0) && !ranNothing,
    geometry,
  };
  await writeFile(join(options.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  if (geometry.measured > 0) {
    environment.standardOutput(
      `design review: ${geometry.findings} geometry findings from ${geometry.measured} measured captures: ${join(options.out, 'geometry-report.md')}\n`,
    );
  }
  environment.standardOutput(
    `design review: ${captures} captures in ${options.out}${summary.clean ? '' : ' (a specification failed; see summary.json)'}\n`,
  );
  return captures > 0 && !ranNothing ? 0 : 1;
}

/** Playwright's JSON report, or `undefined` when the run wrote none. */
async function readReport(path: string): Promise<{ suites?: ReportSuite[] } | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as { suites?: ReportSuite[] };
  } catch {
    return undefined;
  }
}

/** A listed specification's source, or nothing when it cannot be read. */
function readSourceOf(specification: string): string {
  try {
    return readFileSync(join(applicationDirectory, specification), 'utf8');
  } catch {
    return '';
  }
}

/**
 * {@link hostEnvironment}, running its commands under the run's host slots: in a process group of
 * their own, recorded in the slots, with the slots' environment, so a Playwright run and the server
 * it starts hold the slots while they live and end with an orphaned run (`scripts/host-slots.ts`).
 */
export function underHostSlots<Environment extends { run: CaptureEnvironment['run'] }>(
  environment: Environment,
  slots: HostSlots,
): Environment {
  return {
    ...environment,
    run: (command, variables) =>
      runInProcessGroup(command, {
        environment: { ...slots.environment, ...variables },
        cwd: applicationDirectory,
        recordProcessGroup: slots.recordProcessGroup,
        report: (line) => process.stderr.write(`${line}\n`),
      }),
  };
}

// The specifications run one Playwright worker, so one browser at a time: one host slot. The host
// is checked for memory before the capture starts (`documentation/repository/host-admission.md`).
if (import.meta.main) {
  process.exitCode = await withMemoryAdmission(() =>
    withHostSlots(1, (slots) =>
      captureDesignReview(undefined, underHostSlots(hostEnvironment, slots)),
    ),
  );
}
