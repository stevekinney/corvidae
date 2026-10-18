/**
 * Run the official A2A Technology Compatibility Kit against a Weft A2A agent.
 *
 * `bun run --filter=@lostgradient/weft test:a2a-tck` clones the TCK at the pinned
 * commit into `packages/weft/.cache/a2a-tck`, starts `examples/a2a-workflow-agent.ts`
 * on a free port, and runs `uv run ./run_tck.py --sut-host <url> --transport jsonrpc`
 * at `--level must`, then `should`, then `may`. Each level's JUnit report is kept as
 * `reports/junit-<level>.xml` in the checkout. The run passes only when no report
 * holds a `failure` or `error` element; the TCK's `xfail` and `skipped` results do not
 * count against it.
 *
 * `--sut-host <url>` runs the same levels against an agent that is already running,
 * and starts nothing.
 *
 * Needs Python 3.11 or later, `uv`, and network access to clone the TCK.
 */

import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** The `a2aproject/a2a-tck` commit this repository conforms to. */
export const A2A_TCK_COMMIT = '263b9cfaf16a554bdfb166a7ba5b67716e946349';
export const A2A_TCK_REPOSITORY = 'https://github.com/a2aproject/a2a-tck.git';
export const A2A_TCK_LEVELS = ['must', 'should', 'may'] as const;
export type A2ATckLevel = (typeof A2A_TCK_LEVELS)[number];

const WEFT_ROOT = join(import.meta.dir, '..');
export const A2A_TCK_CHECKOUT = join(WEFT_ROOT, '.cache', 'a2a-tck');
const EXAMPLE_ENTRY = join(WEFT_ROOT, 'examples', 'a2a-workflow-agent.ts');
const LISTENING_PATTERN = /A2A agent listening at (\S+)/;

/** The counts one JUnit report holds. */
export type JUnitSummary = {
  readonly tests: number;
  readonly failures: number;
  readonly errors: number;
  readonly skipped: number;
};

/** The outcome of one command: its exit code. */
export type CommandRunner = (command: readonly string[], cwd: string) => Promise<number>;

/** A running system under test. */
export type SystemUnderTest = { readonly url: string; stop(): Promise<void> };

export type RunA2ATckDependencies = {
  readonly runCommand: CommandRunner;
  /** Clone or update the TCK checkout at {@link A2A_TCK_COMMIT}. */
  readonly ensureCheckout: (checkout: string) => Promise<void>;
  /** Start the example agent. */
  readonly startExample: () => Promise<SystemUnderTest>;
  readonly checkout: string;
  readonly log: (line: string) => void;
};

/** Read `--sut-host <url>` (or `--sut-host=<url>`) from the arguments. */
export function parseArguments(argv: readonly string[]): { readonly sutHost?: string } {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === '--sut-host') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--sut-host needs a URL.');
      }
      return { sutHost: value };
    }
    if (argument.startsWith('--sut-host='))
      return { sutHost: argument.slice('--sut-host='.length) };
    throw new Error(`Unknown argument: ${argument}`);
  }
  return {};
}

/** The TCK command for one level. */
export function tckCommand(sutHost: string, level: A2ATckLevel): string[] {
  return [
    'uv',
    'run',
    './run_tck.py',
    '--sut-host',
    sutHost,
    '--transport',
    'jsonrpc',
    '--level',
    level,
  ];
}

function countElements(xml: string, name: string): number {
  return xml.match(new RegExp(`<${name}[\\s/>]`, 'g'))?.length ?? 0;
}

/** Count a JUnit report's test cases and their `failure`, `error`, and `skipped` elements. */
export function summarizeJUnit(xml: string): JUnitSummary {
  return {
    tests: countElements(xml, 'testcase'),
    failures: countElements(xml, 'failure'),
    errors: countElements(xml, 'error'),
    skipped: countElements(xml, 'skipped'),
  };
}

/** The agent's base URL, from the line the example prints once it listens. */
export function listeningUrl(output: string): string | undefined {
  return LISTENING_PATTERN.exec(output)?.[1];
}

async function readReport(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Run every TCK level against the system under test and resolve with the exit code:
 * 0 only when every level produced a report with no failure and no error.
 */
export async function runA2ATck(
  argv: readonly string[],
  dependencies: RunA2ATckDependencies,
): Promise<number> {
  const { runCommand, checkout, log } = dependencies;
  const { sutHost } = parseArguments(argv);
  await dependencies.ensureCheckout(checkout);
  const reports = join(checkout, 'reports');
  const started = sutHost === undefined ? await dependencies.startExample() : undefined;
  const url = sutHost ?? (started as SystemUnderTest).url;
  let failed = false;
  try {
    // The TCK reads the card from `${sutHost}/.well-known/agent-card.json`; fail fast here.
    const card = await fetch(`${url.replace(/\/$/, '')}/.well-known/agent-card.json`);
    if (!card.ok)
      throw new Error(`The system under test at ${url} served no Agent Card (${card.status}).`);
    await rm(reports, { recursive: true, force: true });
    await mkdir(reports, { recursive: true });
    for (const level of A2A_TCK_LEVELS) {
      // Every level writes `junitreport.xml`; keep each one as `junit-<level>.xml`.
      await rm(join(reports, 'junitreport.xml'), { force: true });
      log(`A2A TCK ${A2A_TCK_COMMIT}: --level ${level} against ${url}`);
      const exitCode = await runCommand(tckCommand(url, level), checkout);
      const xml = await readReport(join(reports, 'junitreport.xml'));
      if (xml === undefined) {
        log(`  ${level}: no JUnit report (run_tck.py exited ${exitCode})`);
        failed = true;
        continue;
      }
      await Bun.write(join(reports, `junit-${level}.xml`), xml);
      const summary = summarizeJUnit(xml);
      const passed = summary.tests - summary.failures - summary.errors - summary.skipped;
      log(
        `  ${level}: ${summary.tests} tests, ${passed} passed, ${summary.skipped} skipped or xfailed, ${summary.failures} failures, ${summary.errors} errors`,
      );
      if (summary.failures > 0 || summary.errors > 0) failed = true;
    }
  } finally {
    await started?.stop();
  }
  return failed ? 1 : 0;
}

// The real process runners below run only under `test:a2a-tck`, which needs `git`, `uv`,
// Python, and the network; the tests run `runA2ATck` with stand-ins for each of them.

async function spawnAndWait(command: readonly string[], cwd: string): Promise<number> {
  return Bun.spawn([...command], { cwd, stdout: 'inherit', stderr: 'inherit' }).exited;
}

async function runGit(args: readonly string[], cwd: string, failure: string): Promise<void> {
  if ((await spawnAndWait(['git', ...args], cwd)) !== 0) throw new Error(failure);
}

async function ensureCheckout(checkout: string): Promise<void> {
  const head = Bun.spawnSync(['git', '-C', checkout, 'rev-parse', 'HEAD'], { stderr: 'ignore' });
  if (head.exitCode === 0 && head.stdout.toString().trim() === A2A_TCK_COMMIT) return;
  if (head.exitCode === 0) {
    await runGit(
      ['fetch', '--quiet', 'origin'],
      checkout,
      `Could not fetch ${A2A_TCK_REPOSITORY}.`,
    );
  } else {
    await rm(checkout, { recursive: true, force: true });
    await mkdir(join(checkout, '..'), { recursive: true });
    const clone = ['clone', '--quiet', A2A_TCK_REPOSITORY, checkout];
    await runGit(clone, WEFT_ROOT, `Could not clone ${A2A_TCK_REPOSITORY}.`);
  }
  const detach = ['checkout', '--quiet', '--detach', A2A_TCK_COMMIT];
  await runGit(detach, checkout, `Could not check out A2A TCK commit ${A2A_TCK_COMMIT}.`);
}

/** Start the example on a free port and resolve once it prints the URL it listens at. */
async function startExample(): Promise<SystemUnderTest> {
  const child = Bun.spawn(['bun', EXAMPLE_ENTRY], {
    cwd: WEFT_ROOT,
    env: { ...Bun.env, PORT: '0', A2A_EXAMPLE_TRUST_LOOPBACK_WEBHOOKS: '1' },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const stop = async (): Promise<void> => {
    child.kill('SIGTERM');
    await child.exited;
  };
  const chunks = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let output = '';
  for (let read = await chunks.read(); !read.done; read = await chunks.read()) {
    output += read.value;
    const url = listeningUrl(output);
    if (url === undefined) continue;
    // Keep reading what it prints, so the example never blocks on a full pipe.
    void (async () => {
      for (let rest = await chunks.read(); !rest.done; rest = await chunks.read());
    })();
    return { url, stop };
  }
  throw new Error(`The example exited before listening:\n${output}`);
}

const processDependencies = (): RunA2ATckDependencies => ({
  runCommand: spawnAndWait,
  ensureCheckout,
  startExample,
  checkout: A2A_TCK_CHECKOUT,
  log: console.info,
});

if (import.meta.main) process.exit(await runA2ATck(Bun.argv.slice(2), processDependencies()));
