/**
 * `promotion-signal`: issue or verify a release-promotion signal (COR-1352).
 *
 *   bun run --cwd testing/evaluation promotion-signal issue --gate <gateId> [--store <path>] [--actor <principal>]
 *   bun run --cwd testing/evaluation promotion-signal issue <gateDecisionRecordId> [--store <path>] [--actor <principal>]
 *   bun run --cwd testing/evaluation promotion-signal verify <signalId> [--store <path>]
 *
 * `issue --gate` issues from the newest decision of that gate, whatever its
 * outcome; `issue <id>` from one decision. Stdout is exactly one JSON
 * document, a `promotion-signal-report`; every human diagnostic goes to
 * stderr, and `$?` is authoritative: 0 issued or valid, 3 insufficient
 * evidence (a decision that is missing, did not pass, or expired, an override
 * it relied on that no longer stands, a signal that expired, or current
 * values that cannot be resolved), 5 stale (a bound value moved), 64 a usage
 * error, 65 a corrupt record.
 *
 * The current revision is `git rev-parse HEAD`. A package's source revision
 * is the git tree of its workspace directory at that revision, the
 * workspace found by name among the repository root's `workspaces`.
 *
 * A signal is evidence only. This command appends one `promotion-signal`
 * record when it issues and never writes otherwise; it publishes, tags,
 * syncs, and deploys nothing. A store file that does not exist reads as an
 * empty history rather than being created.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';

import { CorruptHistoricalRecordError, createEvaluationHistory } from '../src/history';
import {
  issuePromotionSignal,
  type IssuePromotionSignalOptions,
  latestGateDecision,
  PROMOTION_SIGNAL_EXIT_CODES,
  type PromotionContext,
  type PromotionIssueOutcome,
  type PromotionVerification,
  verifyPromotionSignal,
} from '../src/promotion';
import {
  EVALUATION_PACKAGE_DIRECTORY,
  type GateEvaluatorLoader,
  loadGateEvaluator,
} from '../src/release-gate';
import { DEFAULT_HISTORY_STORE } from './history';
import { type CommandOutput, gitHeadRevision } from './release-gate';

const USAGE = `Usage: bun run --cwd testing/evaluation promotion-signal issue --gate <gateId> [options]
       bun run --cwd testing/evaluation promotion-signal issue <gateDecisionRecordId> [options]
       bun run --cwd testing/evaluation promotion-signal verify <signalId> [--store <path>]

Issues a promotion signal from a passing gate decision, or verifies one, and prints one JSON report.
A signal is evidence only: nothing is published, tagged, synced, or deployed.

Options:
  --gate <gateId>       Issue from the newest decision of this gate.
  --store <path>        The SQLite history file (default: testing/evaluation/.cache/evaluation-history.sqlite).
  --actor <principal>   Who is issuing the signal (default: the current user).

Exit codes: 0 issued or valid, 3 insufficient evidence, 5 stale, 64 usage error, 65 corrupt record.
`;

export interface PromotionSignalCommandOptions {
  readonly output?: CommandOutput | undefined;
  /** The revision checked out now. Defaults to `git rev-parse HEAD`. */
  readonly currentRevision?: (() => string | undefined) | undefined;
  /** A workspace's source revision. Defaults to {@link gitPackageSourceRevision}. */
  readonly packageSourceRevision?: PromotionContext['packageSourceRevision'] | undefined;
  /** Loads an evaluator module by its absolute path. Defaults to `loadGateEvaluator`. */
  readonly loadEvaluator?: GateEvaluatorLoader | undefined;
  readonly now?: (() => number) | undefined;
  readonly createId?: IssuePromotionSignalOptions['createId'];
}

type Invocation =
  | {
      readonly command: 'issue';
      readonly selector: { readonly recordId: string } | { readonly gateId: string };
      readonly store: string;
      readonly actor: string;
    }
  | { readonly command: 'verify'; readonly signalId: string; readonly store: string };

type CommandOutcome =
  | PromotionIssueOutcome
  | PromotionVerification
  | {
      readonly result: 'insufficient-evidence';
      readonly gateId: string;
      readonly reason: 'decision-missing';
      readonly problem: string;
    }
  | { readonly result: 'corrupt-record'; readonly recordId: string; readonly problem: string }
  | { readonly result: 'usage-error'; readonly problem: string };

function git(args: readonly string[], cwd: string): string | undefined {
  const child = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return child.exitCode === 0 ? child.stdout.toString().trim() : undefined;
}

async function readManifest(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The directory, relative to `repositoryRoot`, of the workspace named `name`, or `undefined`. */
export async function workspaceDirectory(
  name: string,
  repositoryRoot: string,
): Promise<string | undefined> {
  const root = await readManifest(join(repositoryRoot, 'package.json'));
  const patterns: unknown[] = Array.isArray(root?.['workspaces']) ? root['workspaces'] : [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    const manifests = new Bun.Glob(`${pattern}/package.json`).scan({ cwd: repositoryRoot });
    for await (const path of manifests) {
      const manifest = await readManifest(join(repositoryRoot, path));
      if (manifest?.['name'] === name) return dirname(path);
    }
  }
  return undefined;
}

/**
 * The source revision of the workspace named `name` at `revision`: the git
 * tree of its directory, which moves only when the package's own files do.
 * `undefined` outside a repository, for an unknown workspace, or for a
 * revision that does not have the directory.
 */
export async function gitPackageSourceRevision(
  name: string,
  revision: string,
  cwd: string = import.meta.dir,
): Promise<string | undefined> {
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  if (root === undefined) return undefined;
  const directory = await workspaceDirectory(name, root);
  if (directory === undefined) return undefined;
  return git(['rev-parse', '--verify', '--quiet', `${revision}:${directory}`], root);
}

function parseInvocation(argv: readonly string[]): Invocation | string {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        gate: { type: 'string' },
        store: { type: 'string' },
        actor: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return (error as Error).message;
  }
  const { values, positionals } = parsed;
  const [command, ...operands] = positionals;
  const store = values.store ?? DEFAULT_HISTORY_STORE;
  if (command === 'issue') {
    const actor = values.actor ?? userInfo().username;
    if (actor.length === 0) return 'The --actor principal is empty.';
    if (values.gate !== undefined && operands.length === 0) {
      return { command, selector: { gateId: values.gate }, store, actor };
    }
    if (values.gate === undefined && operands.length === 1) {
      return { command, selector: { recordId: operands[0]! }, store, actor };
    }
    return 'issue takes one gate decision record id, or --gate <gateId>.';
  }
  if (command === 'verify') {
    if (values.gate === undefined && values.actor === undefined && operands.length === 1) {
      return { command, signalId: operands[0]!, store };
    }
    return 'verify takes one promotion signal id, and neither --gate nor --actor.';
  }
  return command === undefined
    ? 'Missing a command: issue or verify.'
    : `"${command}" is not a promotion-signal command.`;
}

async function issue(
  invocation: Extract<Invocation, { command: 'issue' }>,
  context: PromotionContext,
  createId: PromotionSignalCommandOptions['createId'],
): Promise<CommandOutcome> {
  const { selector, actor } = invocation;
  let recordId: string;
  if ('gateId' in selector) {
    const latest = await latestGateDecision(context.history, selector.gateId);
    if (latest === undefined) {
      return {
        result: 'insufficient-evidence',
        gateId: selector.gateId,
        reason: 'decision-missing',
        problem: `No gate decision for gate "${selector.gateId}"`,
      };
    }
    recordId = latest.record.id;
  } else {
    recordId = selector.recordId;
  }
  return issuePromotionSignal(recordId, { ...context, actor, createId });
}

function describe(outcome: CommandOutcome): string {
  switch (outcome.result) {
    case 'issued': {
      const { signal } = outcome;
      return `Issued promotion signal "${signal.signalId}" from gate decision "${signal.gateDecisionRecordId}": ${signal.package.name} at ${signal.sourceRevision}, valid until ${signal.expiresAt}`;
    }
    case 'valid':
      return `Promotion signal "${outcome.signal.signalId}" is valid until ${outcome.signal.expiresAt}`;
    case 'expired':
      return `Promotion signal "${outcome.signal.signalId}" expired at ${outcome.signal.expiresAt}`;
    case 'stale': {
      const subject =
        'signal' in outcome
          ? `Promotion signal "${outcome.signal.signalId}" is stale`
          : `Gate decision "${outcome.gateDecisionRecordId}" no longer matches the repository`;
      const fields = outcome.stale.map(
        ({ field, bound, current }) =>
          `  ${field}: bound ${JSON.stringify(bound)}, now ${JSON.stringify(current)}`,
      );
      return [`${subject}:`, ...fields].join('\n');
    }
    default:
      return outcome.problem;
  }
}

function print(
  command: Invocation['command'] | null,
  outcome: CommandOutcome,
  output: CommandOutput,
): number {
  const exitCode = PROMOTION_SIGNAL_EXIT_CODES[outcome.result];
  output.stdout.write(
    `${JSON.stringify(
      { kind: 'promotion-signal-report', schemaVersion: 1, command, exitCode, ...outcome },
      null,
      2,
    )}\n`,
  );
  output.stderr.write(
    `${describe(outcome)}\npromotion-signal: ${outcome.result} (exit ${exitCode})\n`,
  );
  return exitCode;
}

/** Runs one `promotion-signal` invocation and resolves with its exit code. */
export async function runPromotionSignalCommand(
  argv: readonly string[],
  options: PromotionSignalCommandOptions = {},
): Promise<number> {
  const { output = process } = options;
  const invocation = parseInvocation(argv);
  if (typeof invocation === 'string') {
    output.stderr.write(`${invocation}\n\n${USAGE}`);
    return print(null, { result: 'usage-error', problem: invocation }, output);
  }
  // Nothing is ever issued from an empty history, so a missing store is never created.
  const store = textValueStore(
    existsSync(invocation.store) ? new BunSQLiteStorage(invocation.store) : new MemoryStorage(),
  );
  const load = options.loadEvaluator ?? loadGateEvaluator;
  let outcome: CommandOutcome;
  try {
    const context: PromotionContext = {
      history: createEvaluationHistory(store),
      currentRevision: (options.currentRevision ?? (() => gitHeadRevision()))(),
      loadEvaluator: (module) => load(resolve(EVALUATION_PACKAGE_DIRECTORY, module)),
      packageSourceRevision: options.packageSourceRevision ?? gitPackageSourceRevision,
      now: options.now,
    };
    outcome =
      invocation.command === 'issue'
        ? await issue(invocation, context, options.createId)
        : await verifyPromotionSignal(invocation.signalId, context);
  } catch (error) {
    if (!(error instanceof CorruptHistoricalRecordError)) throw error;
    outcome = { result: 'corrupt-record', recordId: error.id, problem: error.message };
  } finally {
    await store.close();
  }
  return print(invocation.command, outcome, output);
}

if (import.meta.main) process.exitCode = await runPromotionSignalCommand(Bun.argv.slice(2));
