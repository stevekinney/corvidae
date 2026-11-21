#!/usr/bin/env bun
// Chef direct merge: squash a pushed branch straight into the default branch with no pull request
// (owner decision, 2026-11-11: a pull request is optional). It is the library behind
// `deliver.ts --branch`; it has no command line of its own.
//
// It runs no test gate, changes no working tree and never merges the default branch into the branch.
// The worker ran its focused checks before pushing; the text guards (`bun run lint:guards`) run here
// on the exact tree that is pushed, in a temporary worktree, and GitHub Actions' full suite on every
// push to `main` is the backstop (AGENTS.md "Gate on local checks").
//
// The steps run in order and stop at the first failure, which is named:
//   1. head       fetch `origin/<default>` and the branch; `origin/<branch>` must be exactly the head
//                 the coordinator accepted;
//   2. revert     `revert-check.ts` for that head against `origin/<default>` finds no file set back to
//                 the state it had before a recent commit on the base. A deletion or revert the
//                 caller intends is named by path (`intended`, `deliver.ts --intended <path>`): its
//                 finding is reported as accepted and does not fail the step, any other finding still
//                 does, and a named path with no finding is an error, so a stale flag cannot hide a
//                 later revert;
//   3. conflict   `git merge-tree --write-tree <base> <head>` builds the merged tree; a conflict is
//                 refused with its paths named and nothing is merged in: the worker merges the base
//                 in and returns a new head. A branch that changes nothing relative to the base is
//                 refused at `merge`. Main moving after the head's evidence is no reason to refuse
//                 (owner decision, 2026-11-21): when the merge is clean, `acceptMovedMain`
//                 (`moved-base.ts`) accepts the attested base and tree for the pushed ones, given
//                 that the attested base is an ancestor of main and the head merged onto it
//                 reproduces the attested tree, and the report's `mergedMainCommits` names the
//                 commits main gained. It runs inside the merge lock the push holds, so the
//                 decision and the push are one critical section;
//   4. guards     each guard of `lint:guards` runs as its own process on the tree that will be
//                 pushed (the one squash commit, in a temporary detached Git worktree that is
//                 always removed afterwards; `text-guards.ts` says why a worktree and not an
//                 archive). A failure names the guard whose process failed and refuses only when
//                 the squash commit has a finding `origin/<default>` does not: the failing guards
//                 are run on the base too, and a failure whose every finding the base's run of the
//                 same guard also holds is the base's own. It does not refuse; the report lists
//                 those guards and their finding counts as already failing on the base (this
//                 repository's default branch can fail a guard for a while, because a run lands
//                 code untested, and a change that adds nothing must not be held for it);
//   5. merge      `git push origin <commit>:refs/heads/<default>`, where the commit is ONE squash
//                 commit, `git commit-tree <tree> -p <base> -F <message file>`. A rejected push (the
//                 default branch moved after the fetch) changes nothing; run it again;
//   6. delete     the remote branch is deleted. A failure leaves `merged` true;
//   7. usage      optional spend record, as `merge-gate.ts` appends it, with the column that holds a
//                 pull request number there holding `branch:<name>` here.
//
// Merge lock: `directMerge` holds the same lock `merge-gate.ts` holds for a pull request
// merge (`withMergeLock`), from before step 1 to after step 7, so a direct merge and a pull request
// merge never interleave their pushes.
//
// A red `main` is a warning in the report, never a refusal. A branch merge has no `--fixes-main`: that
// flag declares a pull request a repair of a red `main`, which is keyed by pull request number, and the baseline comparison in step 4 no longer needs a declaration.
//
// This module is a library; it has no command line.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  isDeliveryMergeObservation,
  loadDeliveryVerification,
  recordDeliveryMergeObservation,
  validateDeliveryApproval,
  validateDeliveryCiEvidence,
  validateDeliveryVerification,
  withDeliveryAuthorityFences,
  type DeliveryVerification,
  type DeliveryVerificationDependencies,
} from './delivery-verification.ts';
import { readExecutionSnapshot } from './execution-state.ts';
import { fetchWithRetry } from './fetch-retry.ts';
import { validateLandingEvidence } from './landing-evidence.ts';
import { mainCiComparisonWarning, mainCiHealth, mainCiWarning } from './main-ci.ts';
import { withMergeLock } from './merge-gate.ts';
import { acceptMovedMain, describeConflicts, mergeHeadOnto } from './moved-base.ts';
import { defaultRunner, UsageError, type Runner } from './process-runner.ts';
import { loadRepositoryConfig } from './repository-config.ts';
import { revertCheck, RevertCheckError } from './revert-check.ts';
import {
  alreadyFailingOnBase,
  runTextGuards,
  type AlreadyFailingGuard,
  type GuardsResult,
} from './text-guards.ts';
import { totalUsage, type UsageTotals } from './transcript-usage.ts';

export interface DirectMergeOptions {
  configPath: string;
  /** The remote branch to merge; it is deleted after the merge. */
  branch: string;
  /** The head pinned at acceptance; the merge refuses unless `origin/<branch>` is exactly it. */
  head: string;
  /** The squash commit's message. */
  messageFile: string;
  /** Paths whose revert finding is intended (a deliberate deletion); each must have a finding. */
  intended?: string[] | undefined;
  /** A checkout of the repository, where the Git commands run; it is never modified. */
  worktree: string;
  /** Read main's health from the latest `main.yml` run. Library callers opt in; the command line does. */
  checkMainHealth?: boolean | undefined;
  lockDirectory?: string | undefined;
  lockPollIntervalMs?: number | undefined;
  /** Where to append the spend record after a successful merge; needs `transcripts`. */
  usageLog?: string | undefined;
  transcripts?: string[] | undefined;
  verification: DeliveryVerification;
}

export interface DirectMergeReport {
  branch: string;
  head: string;
  /** `origin/<default>` as fetched before the merge; the squash commit's parent. */
  base: string | null;
  merged: boolean;
  mergeCommit: string | null;
  /** Set when `main`'s latest `main.yml` run failed or could not be read; a warning, never a refusal. */
  mainHealthWarning?: string;
  /**
   * The guards that failed at step 4 with no finding the base lacks, each with its finding count:
   * already failing on `origin/<default>`, reported and not a refusal. Absent when none did.
   */
  guardsAlreadyFailing?: AlreadyFailingGuard[];
  /** The revert findings the caller named as intended, each file with the commit it undoes. */
  acceptedReverts?: string[];
  /**
   * The commits of `origin/<default>` that the head was merged onto after its evidence, oldest
   * first, so the landing comment can name them. Absent when `main` had not moved.
   */
  mergedMainCommits?: string[];
  failedStep: string | null;
  detail: string | null;
  usage?: UsageTotals;
}

export interface DirectMergeDependencies {
  runner: Runner;
  /**
   * Runs the text guards on the tree of one commit, only the named ones when `only` is given;
   * defaults to `runTextGuards`.
   */
  guards: (revision: string, only?: readonly string[]) => GuardsResult;
  usage: (paths: string[]) => UsageTotals;
  now: () => Date;
  sleep: (milliseconds: number) => void;
  verification: DeliveryVerificationDependencies;
}

/** The refusal's detail: the first failing guard by name, and the others that failed after it. */
function guardsDetail(result: GuardsResult): string {
  const [first, ...rest] = result.failures;
  if (first === undefined) return 'a text guard failed on the merged tree';
  const others = rest.length === 0 ? '' : ` (also: ${rest.map((one) => one.guard).join(', ')})`;
  return `${first.guard} failed on the merged tree: ${first.output}${others}`;
}

/** A branch name that is safe as a Git ref and cannot be read as an option. */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, 200);
}

function validateDirectInputs(
  options: DirectMergeOptions,
  partial: Partial<DirectMergeDependencies>,
) {
  const config = loadRepositoryConfig(options.configPath);
  const { defaultBranch } = config;
  if (!existsSync(options.worktree)) throw new UsageError(`No such worktree: ${options.worktree}`);
  const verification = loadDeliveryVerification(options.verification, partial.verification);
  if (config.repository !== verification.request.repository)
    throw new UsageError('repository differs from the coordinator-approved delivery');
  if (resolve(options.worktree) !== resolve(verification.request.worktree))
    throw new UsageError('worktree differs from the coordinator-approved ownership');
  if (!SAFE_BRANCH.test(options.branch) || options.branch.includes('..'))
    throw new UsageError(`"${options.branch}" is not a safe branch name.`);
  if (options.branch === defaultBranch)
    throw new UsageError(`--branch cannot be the default branch ${defaultBranch}.`);
  if (!/^[0-9a-f]{40}$/.test(options.head))
    throw new UsageError(`--head "${options.head}" is not a full commit SHA.`);
  if (!existsSync(options.messageFile))
    throw new UsageError(`No such message file: ${options.messageFile}`);
  if (readFileSync(options.messageFile, 'utf8').trim() === '')
    throw new UsageError(`${options.messageFile} is empty.`);
  const transcripts = options.transcripts ?? [];
  if ((options.usageLog === undefined) !== (transcripts.length === 0))
    throw new UsageError('--usage-log and --transcript go together.');
  for (const transcript of transcripts) {
    if (!existsSync(transcript)) throw new UsageError(`No such transcript: ${transcript}`);
  }

  return { config, verification, transcripts };
}

/** Run the steps while the public entrypoint holds both fences. */
async function directMergeCore(
  options: DirectMergeOptions,
  partial: Partial<DirectMergeDependencies> = {},
): Promise<DirectMergeReport> {
  const runner = partial.runner ?? defaultRunner;
  const { config, verification, transcripts } = validateDirectInputs(options, partial);
  const { defaultBranch } = config;
  const report: DirectMergeReport = {
    branch: options.branch,
    head: options.head,
    base: null,
    merged: false,
    mergeCommit: null,
    failedStep: null,
    detail: null,
  };
  const git = (...args: string[]) => runner(['git', ...args], { cwd: options.worktree });
  const fail = (step: string, detail: string): DirectMergeReport => {
    report.failedStep = step;
    report.detail = detail;
    return report;
  };
  const guards =
    partial.guards ?? ((revision, only) => runTextGuards(runner, options.worktree, revision, only));

  // 1. head
  const fetched = fetchWithRetry(() => git('fetch', 'origin', defaultBranch, options.branch), {
    sleep: partial.sleep,
  });
  if (fetched.code !== 0)
    return fail(
      'head',
      `git fetch origin ${defaultBranch} ${options.branch} failed (exit ${fetched.code}): ${firstLine(fetched.stderr)}`,
    );
  const branchHead = git('rev-parse', '--verify', `refs/remotes/origin/${options.branch}^{commit}`);
  if (branchHead.code !== 0 || branchHead.stdout.trim() !== options.head)
    return fail(
      'head',
      `origin/${options.branch} is ${branchHead.stdout.trim().slice(0, 12) || 'unreadable'}, not the head pinned at acceptance, ${options.head.slice(0, 12)}.`,
    );
  const baseResult = git('rev-parse', '--verify', `refs/remotes/origin/${defaultBranch}^{commit}`);
  const base = baseResult.stdout.trim();
  if (baseResult.code !== 0 || base === '')
    return fail('head', `could not read origin/${defaultBranch}: ${firstLine(baseResult.stderr)}`);
  report.base = base;

  // 2. revert
  try {
    const reverts = revertCheck({ head: options.head, base, cwd: options.worktree }, runner);
    const intended = options.intended ?? [];
    const unnamed = reverts.findings.filter((finding) => !intended.includes(finding.file));
    if (unnamed.length > 0)
      return fail(
        'revert',
        unnamed
          .map((finding) => `${finding.file} undoes ${finding.undoes}`)
          .join('; ')
          .slice(0, 400),
      );
    const stale = intended.filter((path) => !reverts.findings.some((one) => one.file === path));
    if (stale.length > 0)
      return fail(
        'revert',
        `--intended ${stale.join(', ')} names no revert finding: remove the stale flag.`,
      );
    const accepted = reverts.findings.map((finding) => `${finding.file} undoes ${finding.undoes}`);
    if (accepted.length > 0) report.acceptedReverts = accepted;
  } catch (error) {
    if (!(error instanceof RevertCheckError)) throw error;
    return fail('revert', error.message);
  }

  // 3. conflict
  const mergedTree = mergeHeadOnto(git, base, options.head);
  if ('failure' in mergedTree) return fail('conflict', mergedTree.failure);
  if ('conflicts' in mergedTree)
    return fail(
      'conflict',
      `${options.branch} conflicts with origin/${defaultBranch}${describeConflicts(mergedTree.conflicts)}; merge it in, resolve the conflict, and return the new head for acceptance.`,
    );
  const { tree } = mergedTree;
  const baseTree = git('rev-parse', `${base}^{tree}`).stdout.trim();
  if (tree === baseTree)
    return fail('merge', `${options.branch} changes nothing relative to origin/${defaultBranch}.`);
  // The identity the verification chain attests: the actual base and tree, or, when main moved
  // after the evidence and the head merged into it cleanly (above), the attested ones. A moved
  // base never needs a new evidence run: only a conflict refuses (owner decision, 2026-11-21).
  // Inside the merge lock the push holds, so the decision and the push are one critical section.
  let attested = { base, tree };
  let landed: { landedBase: string; landedTree: string } | undefined;
  const { request } = verification;
  if (base !== request.base) {
    const moved = acceptMovedMain(
      git,
      { base: request.base, tree: request.integrationTree },
      options.head,
      base,
      tree,
    );
    if ('problem' in moved) return fail('verification', moved.problem);
    if (moved.mergedIn.length > 0) report.mergedMainCommits = moved.mergedIn;
    attested = { base: request.base, tree: request.integrationTree };
    landed = { landedBase: base, landedTree: tree };
  }
  const verificationProblem = validateDeliveryVerification(
    verification,
    {
      repository: config.repository,
      revision: options.head,
      base: attested.base,
      integrationTree: attested.tree,
      route: 'branch',
      action: 'merge',
    },
    partial.verification,
  );
  if (verificationProblem !== undefined) return fail('verification', verificationProblem);
  const ciEvidenceProblem = await validateDeliveryCiEvidence(verification, partial.verification);
  if (ciEvidenceProblem !== undefined) return fail('verification', ciEvidenceProblem);
  const landingProblem = await validateLandingEvidence(
    verification,
    { route: 'branch', defaultBranch },
    {
      runner,
      ...(partial.verification?.ciProvider === undefined
        ? {}
        : { ciProvider: partial.verification.ciProvider }),
    },
  );
  if (landingProblem !== undefined) return fail('verification', landingProblem);

  const created = git('commit-tree', tree, '-p', base, '-F', options.messageFile);
  const commit = created.stdout.trim();
  if (created.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit))
    return fail(
      'merge',
      `git commit-tree failed (exit ${created.code}): ${firstLine(created.stderr)}`,
    );

  // main health: a warning in the report, never a refusal
  if (options.checkMainHealth === true) {
    const health = mainCiHealth(runner, config.repository, defaultBranch);
    const warning = mainCiWarning(health, defaultBranch);
    if (warning !== undefined)
      report.mainHealthWarning =
        health.red && health.run !== undefined
          ? `${warning}\n${mainCiComparisonWarning(runner, health.run, options.configPath)}`
          : warning;
  }

  // 4. guards, on the tree that will be pushed
  const checked = guards(commit);
  if (!checked.ok) {
    // Only the guards that failed on the squash tree are run on the base. The change is refused
    // when one of them has a finding the base does not, or does not fail there at all.
    const onBase = guards(
      base,
      checked.failures.map((failure) => failure.guard),
    );
    const known = alreadyFailingOnBase(checked, onBase);
    if (known === null) return fail('guards', guardsDetail(checked));
    report.guardsAlreadyFailing = known;
  }

  // 5. merge
  // The push is consequential. Persist the exact intended commit immediately before attempting it
  // so a lost response is reconciled, while a guard refusal remains a retryable non-mutation.
  await recordDeliveryMergeObservation(
    verification,
    {
      route: 'branch',
      branch: options.branch,
      reviewedHead: options.head,
      base: attested.base,
      integrationTree: attested.tree,
      ...landed,
      mergeCommit: commit,
      state: 'pending-provider-outcome',
    },
    'unknown',
    partial.verification,
  );

  const pushed = git('push', 'origin', `${commit}:refs/heads/${defaultBranch}`);
  if (pushed.code !== 0)
    return fail(
      'merge',
      `git push origin ${commit.slice(0, 12)}:refs/heads/${defaultBranch} did not confirm success (exit ${pushed.code}): ${firstLine(pushed.stderr)}. Delivery must inspect this prepared commit before any further action.`,
    );
  report.merged = true;
  report.mergeCommit = commit;

  const confirmed = git('fetch', 'origin', defaultBranch);
  const defaultHead = git('rev-parse', `origin/${defaultBranch}`).stdout.trim();
  const parent = git('rev-parse', `${commit}^`).stdout.trim();
  const committedTree = git('rev-parse', `${commit}^{tree}`).stdout.trim();
  if (confirmed.code !== 0 || defaultHead !== commit || parent !== base || committedTree !== tree)
    return fail(
      'confirm',
      'direct push returned success but its exact prepared commit could not be confirmed.',
    );
  await recordDeliveryMergeObservation(
    verification,
    {
      route: 'branch',
      branch: options.branch,
      reviewedHead: options.head,
      base: attested.base,
      integrationTree: attested.tree,
      ...landed,
      mergeCommit: commit,
      state: 'confirmed-merge',
    },
    'observed',
    partial.verification,
  );

  // 6. delete
  const deleted = git(
    'push',
    'origin',
    '--delete',
    options.branch,
    `--force-with-lease=refs/heads/${options.branch}:${options.head}`,
  );
  if (deleted.code !== 0)
    return fail(
      'delete',
      `merged as ${commit.slice(0, 12)}, but deleting origin/${options.branch} failed (exit ${deleted.code}): ${firstLine(deleted.stderr)}`,
    );

  // 7. usage (optional)
  if (options.usageLog !== undefined) {
    try {
      const totals = (partial.usage ?? totalUsage)(transcripts);
      mkdirSync(dirname(options.usageLog), { recursive: true });
      appendFileSync(
        options.usageLog,
        `${[
          (partial.now ?? (() => new Date()))().toISOString(),
          `branch:${options.branch}`,
          commit,
          totals.input,
          totals.cachedInput,
          totals.output,
        ].join('\t')}\n`,
      );
      report.usage = totals;
    } catch (error) {
      return fail(
        'usage',
        `merged, but the spend record was not written: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return report;
}

async function recoverDirectMerge(
  options: DirectMergeOptions,
  partial: Partial<DirectMergeDependencies>,
  verification: ReturnType<typeof loadDeliveryVerification>,
): Promise<DirectMergeReport | undefined> {
  const operation = readExecutionSnapshot(verification.state).operations[
    verification.request.operationId
  ];
  if (operation === undefined || operation.outcome === 'intent') return undefined;
  const approval = validateDeliveryApproval(
    verification,
    { route: 'branch', action: 'merge' },
    partial.verification,
  );
  if (approval !== undefined)
    return {
      branch: options.branch,
      head: options.head,
      base: null,
      merged: false,
      mergeCommit: null,
      failedStep: 'recovery',
      detail: approval,
    };
  if (
    !isDeliveryMergeObservation(operation.observed) ||
    operation.observed.route !== 'branch' ||
    operation.observed.branch !== options.branch ||
    options.head !== verification.request.revision ||
    operation.observed.reviewedHead !== verification.request.revision
  )
    return {
      branch: options.branch,
      head: options.head,
      base: null,
      merged: false,
      mergeCommit: null,
      failedStep: 'recovery',
      detail: 'delivery merge receipt is absent or does not name this branch and approved head.',
    };
  const receipt = operation.observed;
  const runner = partial.runner ?? defaultRunner;
  const git = (...args: string[]) => runner(['git', ...args], { cwd: options.worktree });
  const config = loadRepositoryConfig(options.configPath);
  const report: DirectMergeReport = {
    branch: options.branch,
    head: options.head,
    base: receipt.base,
    merged: false,
    mergeCommit: receipt.mergeCommit ?? null,
    failedStep: null,
    detail: null,
  };
  const fetched = git('fetch', 'origin', config.defaultBranch);
  const commit = receipt.mergeCommit;
  if (
    commit === undefined ||
    fetched.code !== 0 ||
    git('merge-base', '--is-ancestor', commit, `origin/${config.defaultBranch}`).code !== 0 ||
    git('rev-parse', `${commit}^`).stdout.trim() !== (receipt.landedBase ?? receipt.base) ||
    git('rev-parse', `${commit}^{tree}`).stdout.trim() !==
      (receipt.landedTree ?? receipt.integrationTree)
  )
    return {
      ...report,
      failedStep: 'recovery',
      detail: 'the original direct merge remains unconfirmed; it will not be attempted again.',
    };
  report.merged = true;
  await recordDeliveryMergeObservation(
    verification,
    { ...receipt, state: 'confirmed-merge' },
    'observed',
    partial.verification,
  );
  const deleted = git(
    'push',
    'origin',
    '--delete',
    options.branch,
    `--force-with-lease=refs/heads/${options.branch}:${receipt.reviewedHead}`,
  );
  // Git reports a missing remote ref as an error; the readback establishes that deletion is complete.
  if (deleted.code !== 0) {
    const absent = git('ls-remote', '--heads', 'origin', options.branch);
    if (absent.code !== 0 || absent.stdout.trim() !== '')
      return {
        ...report,
        failedStep: 'delete',
        detail: `merged, but deleting origin/${options.branch} failed (exit ${deleted.code}): ${firstLine(deleted.stderr)}`,
      };
  }
  if (options.usageLog !== undefined) {
    const existing = existsSync(options.usageLog) ? readFileSync(options.usageLog, 'utf8') : '';
    if (!existing.split('\n').some((line) => line.split('\t')[2] === commit)) {
      const totals = (partial.usage ?? totalUsage)(options.transcripts ?? []);
      mkdirSync(dirname(options.usageLog), { recursive: true });
      appendFileSync(
        options.usageLog,
        `${[
          (partial.now ?? (() => new Date()))().toISOString(),
          `branch:${options.branch}`,
          commit,
          totals.input,
          totals.cachedInput,
          totals.output,
        ].join('\t')}\n`,
      );
      report.usage = totals;
    }
  }
  return report;
}

/** Public consequential route: merge then provider authority fences surround the core transition. */
export async function directMerge(
  options: DirectMergeOptions,
  partial: Partial<DirectMergeDependencies> = {},
): Promise<DirectMergeReport> {
  const snapshot = structuredClone(options);
  const { verification: loaded } = validateDirectInputs(snapshot, partial);
  return withMergeLock(
    {
      worktree: snapshot.worktree,
      command: `direct-merge ${snapshot.branch}`,
      lockDirectory: snapshot.lockDirectory,
      lockPollIntervalMs: snapshot.lockPollIntervalMs,
    },
    () =>
      withDeliveryAuthorityFences(
        partial.verification?.state ?? loaded.state,
        loaded.request,
        async () =>
          (await recoverDirectMerge(snapshot, partial, loaded)) ??
          directMergeCore(snapshot, partial),
      ),
    partial.runner ?? defaultRunner,
  );
}
