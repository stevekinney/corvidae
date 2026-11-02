/**
 * Captures every page of Interborough for the design review (`.agents/skills/design-review`): every
 * route on every tab with seeded data (`tests/e2e/responsive.spec.ts`, at 375, 768 and 1280 pixels),
 * and every view loading, empty, failed, forbidden and ready, plus Health's band states and the
 * not-found page (`tests/e2e/15-view-states.spec.ts`, at 375 and 1280 pixels), in light and dark.
 *
 * It runs those two Playwright specifications with `INTERBOROUGH_DESIGN_REVIEW_CAPTURE` set, so they
 * screenshot each page once it holds its content (`tests/e2e/design-review-capture.ts`), and writes
 * `manifest.jsonl` (one line per capture) and `summary.json` (what ran and how it exited) beside
 * the screenshots. A specification's own assertion failing does not lose its captures, which are
 * taken before the assertions; the summary records the exit code so the reviewer knows the run was
 * not clean.
 *
 *   bun scripts/design-review-capture.ts [--out <dir>] [--scheme light|dark|both]
 *     [--specs all|responsive|states] [--grep <pattern>]
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
  let specifications: string[] = Object.values(SPECIFICATIONS);
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
      case '--specs':
        if (value === 'all') specifications = Object.values(SPECIFICATIONS);
        else if (value === 'responsive' || value === 'states')
          specifications = [SPECIFICATIONS[value]];
        else return `--specs must be all, responsive or states, not "${value}"`;
        break;
      case '--grep':
        grep = value;
        break;
      default:
        return `unknown flag ${flag ?? ''}`;
    }
  }
  return { out, schemes, specifications, grep };
}

/** Whether nothing listens on `port` on the loopback address, so Playwright will start its own server. */
export function portIsFree(port: number): boolean {
  try {
    const probe = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } });
    probe.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Counts the lines of the manifest, which is one capture each. */
async function captureCount(out: string): Promise<number> {
  try {
    const text = await readFile(join(out, 'manifest.jsonl'), 'utf8');
    return text.split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (typeof options === 'string') {
    process.stderr.write(`${options}\n`);
    process.exitCode = 2;
    return;
  }
  const port = endToEndPort();
  if (!portIsFree(port)) {
    process.stderr.write(
      `design review: port ${port} is already in use, and Playwright would capture whatever server holds it. Set INTERBOROUGH_E2E_PORT to a free port (it uses that one and the five after it) and run again.\n`,
    );
    process.exitCode = 2;
    return;
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
    process.stdout.write(`design review: capturing in ${scheme}: ${command.join(' ')}\n`);
    const child = Bun.spawn(command, {
      cwd: applicationDirectory,
      env: {
        ...process.env,
        INTERBOROUGH_DESIGN_REVIEW_CAPTURE: options.out,
        INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME: scheme,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    runs.push({ scheme, exitCode: await child.exited });
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
  process.stdout.write(
    `design review: ${captures} captures in ${options.out}${summary.clean ? '' : ' (a specification failed; see summary.json)'}\n`,
  );
  process.exitCode = captures > 0 ? 0 : 1;
}

if (import.meta.main) await main();
