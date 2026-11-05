/**
 * Captures every page of Interborough for the design review (`.agents/skills/design-review`): every
 * route holding believable content (`tests/e2e/showcase.spec.ts`, at 375, 768 and 1280 pixels, the
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
 * the screenshots. Every page of a capture runs at the sample world's "now", Monday, Nov 2, 2026,
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
 * confirmations), and Home on a fresh installation (`first-run.spec.ts`, whose own host holds no provider, agent or chat).
 */
const SHOWCASE_SPECIFICATIONS = [
  'tests/e2e/showcase.spec.ts',
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
  'tests/e2e/restart.spec.ts',
  'tests/e2e/first-run.spec.ts',
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
  const summary = {
    out: options.out,
    captures,
    specifications: options.specifications,
    grep: options.grep ?? null,
    runs,
    clean: runs.every((run) => run.exitCode === 0),
  };
  await writeFile(join(options.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  environment.standardOutput(
    `design review: ${captures} captures in ${options.out}${summary.clean ? '' : ' (a specification failed; see summary.json)'}\n`,
  );
  return captures > 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await captureDesignReview();
