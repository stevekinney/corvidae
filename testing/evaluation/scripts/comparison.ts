/**
 * `comparison`: runs one committed collaboration comparison suite, decides
 * admission under the suite's predeclared rule, and prints the evidence.
 *
 *   bun run --cwd testing/evaluation comparison --suite <suiteId> [--suites-dir <path>]
 *                                                [--report <path>] [--seeds <evidence.json>]
 *
 * A suite is `comparisons/<suiteId>.json`: the suite module (relative to the
 * file), whose default export builds the comparison (definition, plans,
 * dataset, evaluator, subjects, success heuristics, and runtime), and the
 * admission rule, committed beside it so it is declared before the run.
 * `--seeds` replays the seeds recorded in earlier evidence; a suite that
 * injects a deterministic runtime reproduces without it.
 *
 * Stdout is exactly one JSON document: the versioned evidence artifact, or a
 * `collaboration-comparison-failure`. `--report` writes the human-readable
 * Markdown report rendered from that same evidence. Diagnostics go to stderr,
 * and `$?` is authoritative, with the release gate's codes: 0 admit, 1
 * reject, 2 evaluator or comparison infrastructure failure, 3 insufficient
 * evidence, 64 invalid suite or usage.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/operative';
import { z } from 'zod';

import { admissionRuleSchema, decideAdmission } from '../src/admission';
import { runComparison, type RunComparisonOptions } from '../src/comparison';
import {
  comparisonEvidenceDigest,
  recordedSeeds,
  toComparisonEvidence,
  verifyComparisonEvidence,
} from '../src/comparison-evidence';
import { renderComparisonReport } from '../src/comparison-report';
import {
  type ConfigurationIssue,
  EvaluatorConfigurationError,
  toConfigurationIssues,
} from '../src/configuration';
import { gateIdSchema } from '../src/gate';
import { RELEASE_GATE_EXIT_CODES } from '../src/release-gate';

/** The committed suites, `testing/evaluation/comparisons/<suiteId>.json`. */
export const DEFAULT_SUITES_DIRECTORY = join(import.meta.dir, '..', 'comparisons');

const USAGE = `Usage: bun run --cwd testing/evaluation comparison --suite <suiteId> [options]

Runs comparisons/<suiteId>.json and prints its evidence as one JSON document.

Options:
  --suite <suiteId>        The suite to run.
  --suites-dir <path>      The suites directory (default: testing/evaluation/comparisons).
  --report <path>          Also write the Markdown comparison report here.
  --seeds <evidence.json>  Replay the seeds recorded in earlier evidence.

Exit codes: 0 admit, 1 reject, 2 infrastructure failure, 3 insufficient evidence,
64 invalid suite or usage.
`;

const suiteFileSchema = z.strictObject({
  description: z.string().min(1).optional(),
  /** The suite module, relative to the suite file. */
  suite: z.string().min(1),
  admissionRule: admissionRuleSchema,
});

/** What a suite module's default export builds. */
export type ComparisonSuite = RunComparisonOptions & {
  readonly runtime?: Pick<RuntimeServices, 'random' | 'monotonic' | 'clock'> | undefined;
};

interface Writable {
  write(text: string): unknown;
}

export interface CommandOutput {
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export interface ComparisonCommandOptions {
  readonly output?: CommandOutput | undefined;
  /** Imports a suite module. Defaults to a dynamic `import()`. */
  readonly loadSuite?: ((path: string) => Promise<unknown>) | undefined;
}

interface Invocation {
  readonly suite: string;
  readonly suitesDirectory: string;
  readonly report: string | undefined;
  readonly seeds: string | undefined;
}

type Failure = 'configuration-error' | 'infrastructure-failure';

/** A failure the command reports rather than a result it decided. */
class CommandFailure extends Error {
  constructor(
    readonly decision: Failure,
    readonly issues: readonly string[],
    readonly usage = false,
  ) {
    super(issues.join('; '));
  }
}

function configurationError(issues: readonly string[], usage = false): CommandFailure {
  return new CommandFailure('configuration-error', issues, usage);
}

function formatIssues(issues: readonly ConfigurationIssue[]): string[] {
  return issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`);
}

function parseInvocation(argv: readonly string[]): Invocation {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        suite: { type: 'string' },
        'suites-dir': { type: 'string' },
        report: { type: 'string' },
        seeds: { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (error) {
    throw configurationError([(error as Error).message], true);
  }
  if (values.suite === undefined) throw configurationError(['Name a suite with --suite.'], true);
  if (!gateIdSchema.safeParse(values.suite).success) {
    throw configurationError([`"${values.suite}" is not a suite id.`], true);
  }
  return {
    suite: values.suite,
    suitesDirectory: values['suites-dir'] ?? DEFAULT_SUITES_DIRECTORY,
    report: values.report,
    seeds: values.seeds,
  };
}

async function readJson(path: string, what: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw configurationError([`Cannot read ${what} at ${path}: ${(error as Error).message}`]);
  }
}

async function loadSuite(
  path: string,
  load: NonNullable<ComparisonCommandOptions['loadSuite']>,
): Promise<ComparisonSuite> {
  let module: unknown;
  try {
    module = await load(path);
  } catch (error) {
    throw configurationError([
      `Cannot load the suite module at ${path}: ${(error as Error).message}`,
    ]);
  }
  const build = (module as { readonly default?: unknown }).default;
  if (typeof build !== 'function') {
    throw configurationError([
      'The suite module has no default export that builds a comparison suite',
    ]);
  }
  try {
    return (await build()) as ComparisonSuite;
  } catch (error) {
    throw configurationError([`Cannot build the comparison suite: ${(error as Error).message}`]);
  }
}

/** Configuration errors from the library are the suite's fault; anything else is the machinery's. */
async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof EvaluatorConfigurationError) {
      throw configurationError(formatIssues(error.issues));
    }
    throw new CommandFailure('infrastructure-failure', [
      `The comparison itself failed: ${(error as Error).message}`,
    ]);
  }
}

async function execute(
  argv: readonly string[],
  options: ComparisonCommandOptions,
  output: CommandOutput,
): Promise<number> {
  const invocation = parseInvocation(argv);
  const suitePath = join(invocation.suitesDirectory, `${invocation.suite}.json`);
  const parsed = suiteFileSchema.safeParse(await readJson(suitePath, 'the suite file'));
  if (!parsed.success) throw configurationError(formatIssues(toConfigurationIssues(parsed.error)));
  const { suite: modulePath, admissionRule } = parsed.data;
  const load = options.loadSuite ?? ((path: string) => import(path) as Promise<unknown>);
  const suite = await loadSuite(resolve(dirname(suitePath), modulePath), load);
  let seeds: Awaited<ReturnType<typeof recordedSeeds>> | undefined;
  if (invocation.seeds !== undefined) {
    const recorded = await readJson(invocation.seeds, 'the recorded seeds');
    seeds = await guard(async () =>
      recordedSeeds(await verifyComparisonEvidence(recorded), suite.dataset),
    );
  }
  const comparison = await guard(() => runComparison({ ...suite, seeds }));
  const admission = await guard(() => decideAdmission(admissionRule, comparison));
  const clock = suite.runtime?.clock ?? createDefaultRuntimeServices().clock;
  const evidence = toComparisonEvidence({ comparison, admission, recordedAt: clock.nowISO() });
  const digest = await comparisonEvidenceDigest(evidence);

  output.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  const lines = [`evidence ${evidence.id} (digest ${digest})`];
  if (invocation.report !== undefined) {
    await mkdir(dirname(invocation.report), { recursive: true });
    await writeFile(invocation.report, `${renderComparisonReport(evidence, digest)}\n`);
    lines.push(`report written to ${invocation.report}`);
  }
  for (const finding of admission.findings) {
    lines.push(`  ${finding.gate}, ${finding.reason}: ${finding.detail}`);
  }
  lines.push(`comparison: ${admission.decision} (exit ${admission.exitCode})`);
  output.stderr.write(`${lines.join('\n')}\n`);
  return admission.exitCode;
}

/** Runs one `comparison` invocation and resolves with its exit code. */
export async function runComparisonCommand(
  argv: readonly string[],
  options: ComparisonCommandOptions = {},
): Promise<number> {
  const output = options.output ?? process;
  try {
    return await execute(argv, options, output);
  } catch (error) {
    const failure =
      error instanceof CommandFailure
        ? error
        : new CommandFailure('infrastructure-failure', [
            `The comparison itself failed: ${(error as Error).message}`,
          ]);
    const exitCode = RELEASE_GATE_EXIT_CODES[failure.decision];
    const usage = failure.usage ? `\n\n${USAGE}` : '';
    output.stderr.write(`${failure.issues.join('\n')}${usage}\n`);
    output.stdout.write(
      `${JSON.stringify(
        {
          kind: 'collaboration-comparison-failure',
          decision: failure.decision,
          exitCode,
          issues: failure.issues,
        },
        null,
        2,
      )}\n`,
    );
    return exitCode;
  }
}

if (import.meta.main) process.exitCode = await runComparisonCommand(Bun.argv.slice(2));
