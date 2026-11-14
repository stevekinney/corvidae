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
 * which Git ignores. Exit 0 when at least one capture was written, 1 when none was, 2 on bad usage
 * or when the end-to-end port is already taken.
 *
 * Playwright reuses a server already listening on the end-to-end port outside CI, which on a shared
 * host can be another checkout's build, so the capture refuses to start when that port is taken
 * and asks for a free `INTERBOROUGH_E2E_PORT` instead of screenshotting someone else's tree.
 */
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
 * message yet, one deleted while open, and both with no model provider (`chat-availability.spec.ts`).
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
  const specifications = [
    ...(data === 'stress' ? [] : SHOWCASE_SPECIFICATIONS),
    ...(data === 'showcase' ? [] : stress),
  ];
  return { out, schemes, specifications, grep };
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
  const runs: { scheme: Scheme; exitCode: number }[] = [];
  for (const scheme of options.schemes) {
    const command = [
      'bun',
      '--bun',
      'playwright',
      'test',
      '--config',
      'playwright.config.ts',
      ...options.specifications,
      ...(options.grep === undefined ? [] : ['--grep', options.grep]),
    ];
    environment.standardOutput(`design review: capturing in ${scheme}: ${command.join(' ')}\n`);
    runs.push({
      scheme,
      exitCode: await environment.run(command, {
        INTERBOROUGH_DESIGN_REVIEW_CAPTURE: options.out,
        INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME: scheme,
      }),
    });
  }
  const captures = await captureCount(options.out);
  const geometry = await auditGeometry(options.out);
  const summary = {
    out: options.out,
    captures,
    specifications: options.specifications,
    grep: options.grep ?? null,
    runs,
    clean: runs.every((run) => run.exitCode === 0),
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
  return captures > 0 ? 0 : 1;
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
