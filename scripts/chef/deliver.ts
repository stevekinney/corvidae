// Chef delivery: merge once, then resume durable ledger, member reports, and owned cleanup.
//
// Usage:
//   bun scripts/chef/deliver.ts --branch <branch> --head <sha> --worktree <path> --message-file <file> --verification-file <file> --verification-digest <sha256>
//       --run <id> [--project <linear-project>] [--config <file>] [--keep-worktree] [--usage-log <file> --transcript <file> ...] [--json] [--intended <path> ...]
//   bun scripts/chef/deliver.ts --pr <number> --head <sha> --worktree <path> --comment-file <file> --verification-file <file> --verification-digest <sha256>
//       --run <id> [--project <linear-project>] [--config <file>] [--keep-worktree] [--usage-log <file> --transcript <file> ...] [--json] [--fixes-main]
//
// Landing refuses (exit 1, failed step `lease` or `verification`) unless `--run` holds the Linear
// lease of `--project` (`linear.ts lease`) and the head carries its evidence (`landing-evidence.ts`).
//
// The coordinator-approved verification request owns each member's assignment, plan, tracking
// intent and requested close. Markdown is rendered from collected evidence, never accepted as proof.
// Exit 0: requested side effects finished; unmet member release gates remain explicitly open.
// Exit 1: named delivery or closeout failure. Exit 2: invalid CLI usage.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { closeDelivery } from './delivery-closeout.ts';
import { recordDelivery, type LedgerEntry } from './delivery-ledger.ts';
import type {
  DeliveryVerification,
  DeliveryVerificationDependencies,
} from './delivery-verification.ts';
import {
  isDeliveryMergeObservation,
  loadDeliveryVerification,
  validateDeliveryApproval,
  validateDeliveryMergeObservation,
} from './delivery-verification.ts';
import { directMerge, type DirectMergeOptions, type DirectMergeReport } from './direct-merge.ts';
import { readExecutionSnapshot } from './execution-state.ts';
import { createClient, readProject, type LinearClient } from './linear.ts';
import { mergeGate, type MergeGateOptions, type MergeGateReport } from './merge-gate.ts';
import { emitResult, parseOptions, requireOption, UsageError } from './process-runner.ts';
import { DEFAULT_CONFIGURATION_PATH, loadRepositoryConfig } from './repository-config.ts';
import { resolveMainCheckout } from './repository-locations.ts';
import { removeWorktree, type RemoveOptions, type RemoveResult } from './worktree.ts';

export { UsageError };

export interface DeliverOptions {
  configPath: string;
  /** The pull request to merge; exactly one of `pr` and `branch` is given. */
  pr?: number | undefined;
  /** The pushed remote branch to merge straight into the default branch, with no pull request. */
  branch?: string | undefined;
  worktree: string;
  /** The comment posted on the pull request; required with `pr`, refused with `branch`. */
  commentFile?: string | undefined;
  /** The squash commit's message; required with `branch`, refused with `pr`. */
  messageFile?: string | undefined;
  /** The head pinned at acceptance; required with `branch`, which merges exactly this head. */
  expectedHead?: string | undefined;
  /** Paths whose `revert` finding is intended; `branch` only. */
  intended?: string[] | undefined;
  /** Keep the delivered worktree instead of removing it. */
  keepWorktree?: boolean | undefined;
  usageLog?: string | undefined;
  transcripts?: string[] | undefined;
  /** Declares this pull request a repair of a red `main`; forwarded to the merge gate. Refused with `branch`. */
  fixesMain?: boolean | undefined;
  /** The chef run delivering; it must hold `project`'s Linear lease for a merge to start. */
  run: string;
  /** The Linear project (name, slug or id) whose lease `run` must hold. */
  project?: string | undefined;
  verification: DeliveryVerification;
}

/** The project's lease as `linear.ts lease` records it: `live` is held and renewed within 12 hours. */
export interface LeaseReading {
  run: string;
  live: boolean;
}

export interface DeliverReport {
  /** The pull request number, or `null` for a branch merge. */
  pr: number | null;
  /** The merged branch, or `null` for a pull request merge. */
  branch: string | null;
  merged: boolean;
  mergeCommit: string | null;
  /** GitHub's `mergeable` value at the last read; `null` when it was not read. */
  mergeable: string | null;
  /** Set when `main`'s latest `main.yml` run failed or could not be read: a warning, never a refusal. */
  mainHealthWarning: string | null;
  /**
   * Text guards that fail on the merged tree with only findings `main` already has (a branch merge
   * only): each guard and its finding count. Reported, not a refusal.
   */
  guardsAlreadyFailing: { guard: string; findings: number }[];
  failedStep: string | null;
  detail: string | null;
  /** The issues closed, in order, each with the Linear state it was left in. */
  issues: { identifier: string; state: string }[];
  /** The revert findings accepted because `--intended` named their path (a branch merge only). */
  acceptedReverts: string[];
  /**
   * The commits of main that the head was merged onto after its evidence, oldest first, so the
   * landing comment can name them (a branch merge only). Absent when main had not moved.
   */
  mergedMainCommits?: string[];
  /** The issues commented on whose state was left alone, in order. */
  leftOpen: string[];
  /** What happened to the delivered worktree; `null` when the step did not run. */
  worktree: { removed: boolean; detail: string } | null;
  /** Retained in the report shape while automatic sweeping is disabled. */
  swept: { removed: number; kept: number } | { failure: string } | null;
  /** Set when the delivered head could not be written to the ledger: a warning, never a failure. */
  ledgerWarning: string | null;
}

export interface DeliverDependencies {
  /** Merges through the merge gate, under the cross-session merge lock. */
  merge: (
    options: MergeGateOptions,
    verification?: DeliveryVerificationDependencies,
  ) => Promise<MergeGateReport>;
  /** Merges a branch straight into the default branch, under the same merge lock. */
  directMerge: (
    options: DirectMergeOptions,
    verification?: DeliveryVerificationDependencies,
  ) => Promise<DirectMergeReport>;
  /** The Linear client; the command line supplies `createClient()`, which reads the credentials. */
  client: LinearClient;
  /** Reads a project's lease, or `null` when it has none; the command line wraps `readProject`. */
  readLease: (project: string) => Promise<LeaseReading | null>;
  remove: (options: RemoveOptions) => RemoveResult;
  /** Appends a delivered head under closeout's existing provider-transition lock. */
  record: (entry: LedgerEntry) => void;
  verification: DeliveryVerificationDependencies;
}

/**
 * `path` resolved against this process's working directory. The merge runs `git commit-tree` from
 * the worktree, so a relative `--message-file` would otherwise be read from the wrong directory.
 */
function absolute(path: string | undefined): string | undefined {
  return path === undefined ? undefined : resolve(path);
}

/** Why `options.run` may not land for `options.project`, or `undefined` when it holds the lease. */
async function leaseRefusal(
  options: DeliverOptions,
  partial: Partial<DeliverDependencies>,
  project: string | undefined = options.project,
): Promise<string | undefined> {
  if (partial.readLease === undefined) return 'no lease reader was provided.';
  if (project === undefined) return undefined;
  let lease: LeaseReading | null;
  try {
    lease = await partial.readLease(project);
  } catch (error) {
    return `the lease of ${project} could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (lease === null) return `${project} has no lease; run ${options.run} does not hold it.`;
  if (lease.run !== options.run)
    return `${project} is leased to run ${lease.run}, not run ${options.run}.`;
  if (!lease.live) return `run ${options.run}'s lease on ${project} is released or expired.`;
  return undefined;
}

/** Run the lifecycle. Never throws for a failed step; the report names it. */
export async function deliver(
  options: DeliverOptions,
  partial: Partial<DeliverDependencies> = {},
): Promise<DeliverReport> {
  options = structuredClone(options);
  loadRepositoryConfig(options.configPath);
  if ((options.pr === undefined) === (options.branch === undefined))
    throw new UsageError('Give exactly one of --pr and --branch.');

  if (options.branch === undefined) {
    if (options.commentFile === undefined) throw new UsageError('--pr needs --comment-file.');
    if (options.messageFile !== undefined)
      throw new UsageError('--message-file applies only with --branch.');
  } else {
    if (options.messageFile === undefined) throw new UsageError('--branch needs --message-file.');
    if (options.expectedHead === undefined) throw new UsageError('--branch needs --head.');
    if (options.commentFile !== undefined)
      throw new UsageError('--comment-file applies only with --pr.');
    if (options.fixesMain === true)
      throw new UsageError(
        '--fixes-main applies only with --pr: a branch merge compares every guard failure with origin/main on its own.',
      );
  }
  if (options.branch === undefined && (options.intended ?? []).length > 0)
    throw new UsageError('--intended applies only with --branch.');
  if (!options.run) throw new UsageError('--run is required: the run that holds the lease.');
  const verification = loadDeliveryVerification(options.verification, partial.verification);
  if (resolve(options.worktree) !== resolve(verification.request.worktree))
    throw new UsageError('worktree differs from the coordinator-approved ownership');
  const approval = validateDeliveryApproval(
    verification,
    { route: options.branch === undefined ? 'pull-request' : 'branch', action: 'merge' },
    partial.verification,
  );
  if (approval !== undefined) throw new UsageError(approval);
  if (options.keepWorktree !== true) {
    for (const [label, path] of [
      ['verification file', options.verification.file],
      ['execution state', verification.state.stateDirectory],
      ['repository configuration', options.configPath],
    ] as const) {
      const inside = relative(resolve(options.worktree), resolve(path));
      if (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
        throw new UsageError(
          `${label} must survive owned worktree cleanup; store it outside that worktree`,
        );
    }
  }
  const report: DeliverReport = {
    pr: options.pr ?? null,
    branch: options.branch ?? null,
    merged: false,
    mergeCommit: null,
    mergeable: null,
    mainHealthWarning: null,
    guardsAlreadyFailing: [],
    failedStep: null,
    detail: null,
    issues: [],
    acceptedReverts: [],
    leftOpen: [],
    worktree: null,
    swept: null,
    ledgerWarning: null,
  };
  const fail = (step: string, detail: string): DeliverReport => {
    report.failedStep = step;
    report.detail = detail;
    return report;
  };

  const operation = readExecutionSnapshot(verification.state).operations[
    verification.request.operationId
  ];
  if (operation?.closeout?.routeComplete === true) {
    const observation = operation.observed;
    if (
      !isDeliveryMergeObservation(observation) ||
      observation.state !== 'confirmed-merge' ||
      observation.mergeCommit === undefined ||
      observation.route !== (options.branch === undefined ? 'pull-request' : 'branch') ||
      observation.branch !== options.branch ||
      observation.pullRequest !== options.pr
    )
      return fail('recovery', 'closeout has no matching original merge identity');
    validateDeliveryMergeObservation(observation, verification.request);
    report.merged = true;
    report.mergeCommit = observation.mergeCommit;
    return closeDelivery(verification, options, report, partial);
  }
  if (options.commentFile !== undefined && !existsSync(options.commentFile))
    throw new UsageError(`No such comment file: ${options.commentFile}`);
  if (options.messageFile !== undefined && !existsSync(options.messageFile))
    throw new UsageError(`No such message file: ${options.messageFile}`);
  if (!existsSync(options.worktree))
    return fail('worktree', 'delivery worktree is absent before closeout completed');
  // lease: only the coordinator run that holds the project's lease lands through here.
  const authorityProject = verification.request.authority.resource.startsWith('project:')
    ? verification.request.authority.resource.slice('project:'.length)
    : undefined;
  const leaseProblem = await leaseRefusal(options, partial, options.project ?? authorityProject);
  if (leaseProblem !== undefined) return fail('lease', leaseProblem);
  // merge
  const usageFields =
    options.usageLog === undefined
      ? {}
      : { usageLog: options.usageLog, transcripts: options.transcripts ?? [] };
  if (options.branch !== undefined) {
    const mergeBranch = partial.directMerge;
    if (mergeBranch === undefined) return fail('merge', 'no direct merge runner was provided.');
    const direct = await mergeBranch(
      {
        configPath: options.configPath,
        branch: options.branch,
        head: options.expectedHead ?? '',
        messageFile: options.messageFile ?? '',
        intended: options.intended ?? [],
        worktree: options.worktree,
        checkMainHealth: true,
        ...usageFields,
        verification: options.verification,
      },
      partial.verification,
    );
    report.merged = direct.merged;
    report.mergeCommit = direct.mergeCommit;
    report.mainHealthWarning = direct.mainHealthWarning ?? null;
    report.guardsAlreadyFailing = direct.guardsAlreadyFailing ?? [];
    report.acceptedReverts = direct.acceptedReverts ?? [];
    if (direct.mergedMainCommits !== undefined) report.mergedMainCommits = direct.mergedMainCommits;
    if (direct.failedStep !== null) {
      fail(direct.failedStep, direct.detail ?? '');
      return report.merged &&
        readExecutionSnapshot(verification.state).operations[verification.request.operationId]
          ?.outcome === 'observed'
        ? closeDelivery(verification, options, report, partial)
        : report;
    }
  } else {
    const merge = partial.merge;
    if (merge === undefined) return fail('merge', 'no merge runner was provided.');
    const merged = await merge(
      {
        configPath: options.configPath,
        pr: options.pr ?? 0,
        worktree: options.worktree,
        commentFile: options.commentFile ?? '',
        dryRun: false,
        checkMainHealth: true,
        expectedHead: options.expectedHead,
        fixesMain: options.fixesMain === true,
        ...usageFields,
        verification: options.verification,
      },
      partial.verification,
    );
    report.merged = merged.merged;
    report.mergeCommit = merged.mergeCommit;
    report.mergeable = merged.mergeable;
    report.mainHealthWarning = merged.mainHealthWarning ?? null;
    if (merged.failedStep !== null) {
      fail(merged.failedStep, merged.detail ?? '');
      return report.merged &&
        readExecutionSnapshot(verification.state).operations[verification.request.operationId]
          ?.outcome === 'observed'
        ? closeDelivery(verification, options, report, partial)
        : report;
    }
  }
  return closeDelivery(verification, options, report, partial);
}

export function renderDeliver(report: DeliverReport): string {
  const subject = report.branch === null ? `pr #${report.pr}` : `branch ${report.branch}`;
  const mergeable = report.branch === null ? ` mergeable=${report.mergeable ?? 'unread'}` : '';
  const lines = [
    `${subject} merged=${report.merged} mergeCommit=${report.mergeCommit?.slice(0, 12) ?? 'none'}${mergeable}`,
  ];
  if (report.worktree !== null)
    lines.push(
      `worktree ${report.worktree.removed ? 'removed' : 'kept'}: ${report.worktree.detail}`,
    );
  if (report.swept !== null)
    lines.push(
      'failure' in report.swept
        ? `swept: failed (${report.swept.failure})`
        : `swept: ${report.swept.removed} removed, ${report.swept.kept} kept`,
    );
  if (report.ledgerWarning !== null)
    lines.push(`WARNING delivery ledger: not written (${report.ledgerWarning})`);
  if (report.mainHealthWarning !== null)
    lines.push(`WARNING main health: ${report.mainHealthWarning}`);
  if (report.acceptedReverts.length > 0)
    lines.push(`revert accepted as intended: ${report.acceptedReverts.join('; ')}`);
  if (report.mergedMainCommits !== undefined)
    lines.push(
      `base moved, landed without a new run: merged onto main commits ${report.mergedMainCommits.map((sha) => sha.slice(0, 12)).join(', ')}`,
    );
  if (report.guardsAlreadyFailing.length > 0)
    lines.push(
      `WARNING guards: already failing on main, with no finding of this change's own: ${report.guardsAlreadyFailing.map((one) => `${one.guard} (${one.findings} output lines)`).join(', ')}`,
    );
  const closed = report.issues.map((one) => `${one.identifier} ${one.state}`).join(', ');
  if (report.issues.length > 0) lines.push(`issues: ${closed}`);
  if (report.leftOpen.length > 0)
    lines.push(
      `left open, state untouched: ${report.leftOpen.join(', ')} (required completion evidence or close intent is absent)`,
    );
  if (report.issues.length === 0 && report.leftOpen.length === 0)
    lines.push('no tracked member named in the approved delivery request');
  if (report.failedStep !== null)
    lines.push(`FAILED at ${report.failedStep}: ${report.detail ?? ''}`);
  return lines.join('\n');
}

/** The header's usage block (from `Usage:` to the first blank comment line after the options). */
export function usageText(): string {
  const lines = readFileSync(import.meta.path, 'utf8').split('\n');
  const start = lines.findIndex((line) => line === '// Usage:');
  const end = lines.findIndex((line, index) => index > start && line === '//');
  return lines
    .slice(start, end === -1 ? undefined : end)
    .map((line) => line.replace(/^\/\/ ?/, ''))
    .join('\n');
}

export async function run(
  argv: string[],
  dependencies: Partial<DeliverDependencies> = {},
): Promise<{ code: number; output: string }> {
  const parsed = parseOptions(argv, {
    values: [
      'config',
      'pr',
      'branch',
      'worktree',
      'comment-file',
      'message-file',
      'head',
      'run',
      'project',
      'usage-log',
      'verification-file',
      'verification-digest',
    ],
    repeated: ['transcript', 'intended'],
    flags: ['keep-worktree', 'fixes-main', 'json', 'help'],
  });
  if (parsed.flags.has('help')) return { code: 0, output: usageText() };
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const pr = parsed.values['pr'];
  const branch = parsed.values['branch'];
  if ((pr === undefined) === (branch === undefined))
    throw new UsageError('Give exactly one of --pr and --branch.');
  if (pr !== undefined && !/^[1-9]\d*$/.test(pr))
    throw new UsageError(`"${pr}" is not a pull request number.`);
  const expectedHead = parsed.values['head'];
  if (expectedHead !== undefined && !/^[0-9a-f]{40}$/.test(expectedHead))
    throw new UsageError(`--head "${expectedHead}" is not a full commit SHA.`);
  const usageLog = parsed.values['usage-log'];
  const transcripts = parsed.repeated['transcript'] ?? [];
  if ((usageLog === undefined) !== (transcripts.length === 0))
    throw new UsageError('--usage-log and --transcript go together.');
  const report = await deliver(
    {
      configPath: parsed.values['config'] ?? DEFAULT_CONFIGURATION_PATH,
      pr: pr === undefined ? undefined : Number(pr),
      branch,
      worktree: resolve(requireOption(parsed, 'worktree')),
      commentFile: absolute(parsed.values['comment-file']),
      messageFile: absolute(parsed.values['message-file']),
      expectedHead,
      run: requireOption(parsed, 'run'),
      ...(parsed.values['project'] === undefined ? {} : { project: parsed.values['project'] }),
      intended: parsed.repeated['intended'] ?? [],
      usageLog: absolute(usageLog),
      transcripts: transcripts.map((path) => resolve(path)),
      fixesMain: parsed.flags.has('fixes-main'),
      keepWorktree: parsed.flags.has('keep-worktree'),
      verification: {
        file: resolve(requireOption(parsed, 'verification-file')),
        digest: requireOption(parsed, 'verification-digest'),
      },
    },
    dependencies,
  );
  return {
    code: report.failedStep === null ? 0 : 1,
    output: parsed.flags.has('json') ? JSON.stringify(report) : renderDeliver(report),
  };
}

/** The real collaborators, built only by the command line so that tests never reach a process. */
function productionDependencies(): Partial<DeliverDependencies> {
  const client = createClient();
  return {
    readLease: async (project) => {
      const { data } = await readProject(client, project);
      const lease = data['lease'] as { run: string; live: boolean } | null;
      return lease === null ? null : { run: lease.run, live: lease.live };
    },
    merge: (options, verification) =>
      mergeGate(options, verification === undefined ? {} : { verification }),
    directMerge: (options, verification) =>
      directMerge(options, verification === undefined ? {} : { verification }),
    remove: (options) => removeWorktree(options),
    record: (entry) => recordDelivery(resolveMainCheckout(), entry),
    client,
  };
}

if (import.meta.main) {
  try {
    const { code, output } = await run(Bun.argv.slice(2), productionDependencies());
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
