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
 * `manifest.jsonl` (one line per capture), `review-order.jsonl` (the same lines in the order a
 * review reads them: 1920 and 1280 first, then 768 and 375, light then dark, `reviewOrder`) and
 * `summary.json` (what ran and how it exited) beside the screenshots, then holds what each page measured to the rubric's thresholds
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
 *     [--shard <index>/<count>] [--expect <expected-captures.json>]
 *
 * `--shard` captures one shard of the specifications the other flags chose (`design-review-shards.ts`
 * plans them by weight, whole files each), so a runner takes a sixth of a sweep; the workflow runs
 * each scheme's shards in parallel and merges them (`design-review-merge.ts`). A shard the filter
 * does not reach exits 0 with nothing captured, since only the merge sees the whole run.
 *
 * Every capture at 1280 pixels is repeated at 1920, and every phone capture at 320 by 640; each
 * file is named for its specification, its world (sample world, stress, first run), its route,
 * tab and state, its width and its scheme, and the capture fails when two screens resolve to one name.
 *
 * `--expect` holds the capture to the states its design rows declare (`design-review-rows.ts
 * --manifest` writes the file from the issue's `rows.resolved.json`): after the run, each expected
 * route, state, width and scheme that `manifest.jsonl` does not show is named on standard error,
 * `summary.json` records the coverage, and the run exits 1. Without it nothing is held to a plan.
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

import { ensureCinderGenerated } from '../../../scripts/ensure-cinder-generated.ts';
import { withHostSlots, withMemoryAdmission, type HostSlots } from '../../../scripts/host-slots.ts';
import { runInProcessGroup } from '../../../scripts/run-exclusively.ts';
import { auditGeometry } from './design-review-geometry.ts';
import {
  describeMissing,
  missingCaptures,
  parseCaptureManifest,
  wideCaptureHint,
  type CapturedLine,
  type CaptureExpectation,
  type CaptureManifest,
} from './design-review-rows.ts';
import { parseShard, planShards } from './design-review-shards.ts';
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
 * failing, the add menu, and the read-only phone (`workflow-builder-cards.spec.ts`), and the hook
 * editor and its deliveries: a plugin hook, a default hook, a withdrawn one, the secret field, a
 * delivery with a receipt and a hook with a problem (`hooks.spec.ts`), and the Hooks list in each
 * state of its board (`hooks-states.spec.ts`), and a fault's remediation and Retry on the Hooks
 * list's failed state (`fault-remediation.spec.ts`).
 */
/**
 * Home's states that `home.spec.ts` holds only at 1280, which it captures at 1280 and at a phone,
 * 375 and so 320 (`captureForDesignReviewWithPhone`, COR-2489).
 */
export const HOME_STATES_CAPTURED_ON_A_PHONE = [
  'loading',
  'still loading',
  'one card fails',
  'nothing waiting',
  'something needs you',
] as const;

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
  'tests/e2e/settings-mcp.spec.ts',
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
  // The owner's Always approval with no arguments at three widths in both themes, and a refused
  // decision on one no longer waiting (COR-2438).
  'tests/e2e/chat-approval-wide.spec.ts',
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
  // The Checks page in each state of its design rows: first use, filtered to nothing, loading,
  // failing and a Load more that failed (COR-2114).
  'tests/e2e/checks-states.spec.ts',
  // Capabilities and Connect tools in the states the sample world does not hold (COR-2435, COR-2436).
  'tests/e2e/capabilities-states.spec.ts',
  // The Goals list while its goals are read (COR-2425, row 68k).
  'tests/e2e/goals-list-states.spec.ts',
  // The shared first-use state across every top-level list (COR-2431).
  'tests/e2e/list-empty-states.spec.ts',
  // Every view loading, empty, failed and forbidden, which a route filter (`--grep '/runs'`) reaches
  // through each title's address, and the goal check's loading states.
  'tests/e2e/15-view-states.spec.ts',
  // Disable and Enable of an agent and its read-only chat, Forgot with Undo, a memory whose chat was
  // deleted, Restore, skills and reference documents; Reviews loading, resolved elsewhere, a
  // workflow review, Denied and a Done list longer than a page (COR-2429, COR-2426).
  'tests/e2e/agents-reviews-design-states.spec.ts',
  'tests/e2e/hooks.spec.ts',
  'tests/e2e/hooks-states.spec.ts',
  // A fault's remediation and Retry on the Hooks list's failed state: a retryable fault with a
  // remediation, one that is not retryable, and one with no remediation (COR-2560).
  'tests/e2e/fault-remediation.spec.ts',
  // The schedule editor panel, a document in a sandboxed frame that no page capture sees, in each
  // state it draws (COR-2545). `--grep schedule-editor-states` selects it.
  'tests/panels/schedule-editor-states.spec.ts',
] as const;

type Scheme = 'light' | 'dark';

/** The parsed command line. */
interface Options {
  readonly out: string;
  readonly schemes: readonly Scheme[];
  readonly specifications: readonly string[];
  readonly grep: string | undefined;
  /** The shard this run captures, of the specifications the other flags chose, or `undefined` for all of them. */
  readonly shard: { readonly index: number; readonly count: number } | undefined;
  /** The expected-captures file (`design-review-rows.ts --manifest`) the capture is held to. */
  readonly expect?: string;
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
  let shard: Options['shard'];
  let expectFile: string | undefined;
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
      case '--shard': {
        const parsed = parseShard(value);
        if (typeof parsed === 'string') return parsed;
        shard = parsed;
        break;
      }
      case '--expect':
        expectFile = resolve(value);
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
  return {
    out,
    schemes,
    specifications:
      shard === undefined
        ? specifications
        : (planShards(specifications, shard.count)[shard.index - 1]?.specifications ?? []),
    grep,
    shard,
    ...(expectFile === undefined ? {} : { expect: expectFile }),
  };
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

/**
 * The order a review reads the captures in (owner, 2026-11-19): 1920 and 1280 first, then 768 and
 * 375, then any other width, each width in light then dark, and the routes in the order they were
 * captured within that. A width that is not listed comes last, widest first.
 */
export const REVIEW_WIDTH_ORDER = [1920, 1280, 768, 375] as const;

/** One capture, as far as the review order reads it. */
export interface ReviewOrderEntry {
  readonly width: number;
  readonly colorScheme: 'light' | 'dark';
}

/** `entries` in the order a review reads them; the input is left as it is. */
export function reviewOrder<Entry extends ReviewOrderEntry>(entries: readonly Entry[]): Entry[] {
  const rank = (width: number): number => {
    const at = (REVIEW_WIDTH_ORDER as readonly number[]).indexOf(width);
    return at >= 0 ? at : REVIEW_WIDTH_ORDER.length + 10_000 - width;
  };
  return entries
    .map((entry, index) => ({ entry, index }))
    .toSorted(
      (left, right) =>
        rank(left.entry.width) - rank(right.entry.width) ||
        Number(left.entry.colorScheme === 'dark') - Number(right.entry.colorScheme === 'dark') ||
        left.index - right.index,
    )
    .map(({ entry }) => entry);
}

/** Writes `review-order.jsonl` beside the manifest: the manifest's lines in the order a review reads them. */
export async function writeReviewOrder(out: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(join(out, 'manifest.jsonl'), 'utf8');
  } catch {
    return 0;
  }
  const entries = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ReviewOrderEntry);
  const ordered = reviewOrder(entries);
  await writeFile(
    join(out, 'review-order.jsonl'),
    ordered.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
  );
  return ordered.length;
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
  let expected: CaptureManifest | undefined;
  if (options.expect !== undefined) {
    const read = parseCaptureManifest(await readFile(options.expect, 'utf8').catch(() => ''));
    if (typeof read === 'string') {
      environment.standardError(`design review: ${options.expect}: ${read}\n`);
      return 2;
    }
    expected = read;
  }
  const port = endToEndPort();
  if (!environment.portIsFree(port)) {
    environment.standardError(
      `design review: port ${port} is already in use, and Playwright would capture whatever server holds it. Set INTERBOROUGH_E2E_PORT to a free port (it uses that one and the six after it) and run again.\n`,
    );
    return 2;
  }
  await mkdir(options.out, { recursive: true });
  // A shard the filter does not reach has nothing to capture, which is not a failure: the merge
  // judges the whole run, and Playwright would exit 1 with "No tests found" for it.
  if (options.shard !== undefined && !shardHasTests(options)) {
    environment.standardOutput(
      `design review: shard ${options.shard.index}/${options.shard.count} holds no test the filter reaches\n`,
    );
    await writeFile(
      join(options.out, 'summary.json'),
      `${JSON.stringify({ out: options.out, captures: 0, shard: options.shard, specifications: options.specifications, grep: options.grep ?? null, runs: [], clean: true }, null, 2)}\n`,
    );
    return 0;
  }
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
  await writeReviewOrder(options.out);
  const geometry = await auditGeometry(options.out);
  const ranNothing = runs.some((run) => run.ranNothing.length > 0);
  // Coverage comes before anything else counts: a declared state that no capture shows is named,
  // and the run exits 1 (`design-rounds.ts` counts only a capture whose coverage is complete).
  const coverage =
    expected === undefined ? undefined : await coverageOf(options.out, expected, environment);
  const summary = {
    out: options.out,
    captures,
    shard: options.shard ?? null,
    specifications: options.specifications,
    grep: options.grep ?? null,
    runs,
    clean: runs.every((run) => run.exitCode === 0) && !ranNothing,
    geometry,
    ...(coverage === undefined ? {} : { coverage }),
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
  if (captures > 0 && !ranNothing) return (coverage?.complete ?? true) ? 0 : 1;
  // A shard of a filtered run may hold none of the tests the filter matches (Playwright says "No
  // tests found" and exits 1). Its exit codes are in `summary.json`; whether the run captured
  // anything at all is the merge's verdict.
  if (options.shard !== undefined && options.grep !== undefined && captures === 0) return 0;
  return 1;
}

/** Whether any listed specification has a test whose title path the filter matches (all do without one). */
function shardHasTests(options: Options): boolean {
  if (options.grep === undefined) return options.specifications.length > 0;
  let filter: RegExp;
  try {
    filter = new RegExp(options.grep);
  } catch {
    // A pattern JavaScript cannot read is not ruled out here: Playwright runs and reports it.
    return options.specifications.length > 0;
  }
  // A title written as a template (`${view} is ${state}…`) is only known once it runs, so it may be
  // one the filter reaches: only a title that is plain text can be ruled out from the source.
  return options.specifications.some((specification) =>
    testsOf(readSourceOf(specification)).some(
      (test) => test.path.includes('${') || filter.test(test.path),
    ),
  );
}

/** What a capture covered of the captures a manifest expects. */
export interface Coverage {
  readonly expected: number;
  readonly missing: readonly CaptureExpectation[];
  readonly complete: boolean;
}

/** Holds the capture's `manifest.jsonl` to an expected-captures manifest, naming each one missing. */
async function coverageOf(
  out: string,
  manifest: CaptureManifest,
  environment: CaptureEnvironment,
): Promise<Coverage> {
  const text = await readFile(join(out, 'manifest.jsonl'), 'utf8').catch(() => '');
  const lines: CapturedLine[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      lines.push(JSON.parse(line) as CapturedLine);
    } catch {
      // A torn line shows nothing, so what it would have shown is reported missing.
    }
  }
  const missing = missingCaptures(manifest.captures, lines);
  for (const entry of missing)
    environment.standardError(`design review: ${describeMissing(entry)}\n`);
  const hint = wideCaptureHint(missing);
  if (hint !== undefined) environment.standardError(`design review: ${hint}\n`);
  return { expected: manifest.captures.length, missing, complete: missing.length === 0 };
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
  // The capture builds Interborough, which imports Cinder's generated files.
  ensureCinderGenerated();
  process.exitCode = await withMemoryAdmission(() =>
    withHostSlots(1, (slots) =>
      captureDesignReview(undefined, underHostSlots(hostEnvironment, slots)),
    ),
  );
}
