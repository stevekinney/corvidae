import { mkdir } from 'node:fs/promises';

import {
  createGitHubApi,
  installationTokenFromApp,
  userTokenFromEnvironmentOrCli,
  type CheckRunRecord,
  type GitHubApi,
  type InstallationCoverage,
  type PullRequestRecord,
  type RepositoryRecord,
} from './github-api.ts';
import { installationSettingsUrl, mirrorAppId, mirrorInstallationId } from './github-app.ts';
import { mirrorTargets, type MirrorTarget } from './manifests.ts';
import { runCommand, type CommandResult, type CommandRunner } from './packaging.ts';
import { proveNpmPublishDryRun, type PublishProbe } from './publish-rehearsal.ts';
import {
  assertScratchName,
  assertScratchRepository,
  scratchDescription,
  ScratchGuardError,
  scratchOwner,
  scratchRepositoryName,
  scratchStamp,
} from './scratch-repository.ts';
import {
  assertNoForeignCommits,
  gitEnvironment,
  provenanceTrailer,
  stageSurface,
  type StageOptions,
  type StageOutcome,
} from './sync.ts';

/**
 * The throwaway round trip that proves the real GitHub path before it is pointed at a real
 * mirror: create a public scratch repository, seed it, run the existing transform into it, open a
 * pull request through the App, prove `npm publish --dry-run`, and delete the scratch repository
 * again.
 *
 * The delete is the dangerous half and the reason this module exists as its own thing.
 * `deleteScratchRepository` is irreversible and the account credential now carries `delete_repo`,
 * so every assertion that makes a delete safe lives *inside* that function, reading the
 * repository from GitHub itself. A later edit to a caller — a wrong variable, a copied line, an
 * argument threaded from somewhere else — cannot point the delete at a real repository, because
 * the caller does not get a say: it passes a name, and the name has to match a pattern no real
 * repository bears while the repository behind it has to carry a sentinel description no real
 * repository carries.
 */

export class DryRunError extends Error {}

/** A refusal to proceed because the App installation cannot reach the scratch repository. */
export class InstallationCoverageError extends DryRunError {}

/** A check run on the head commit reached a conclusion that is not a pass. */
export class CheckRunFailureError extends DryRunError {}

/**
 * CI never started, or never finished, inside the bound the run was willing to wait.
 *
 * Its own class rather than a flavour of `CheckRunFailureError` because the two diagnose
 * different things: a failure means CI ran and said no, and this means CI never got as far as
 * saying anything, which is a question about the workflows and the runners rather than about the
 * transform.
 */
export class CheckRunTimeoutError extends DryRunError {}

/** The base branch of the scratch repository. */
const baseBranch = 'main';

/** The orphan branch the seed commit is made on, which is pushed as the base branch. */
const seedBranch = 'mirror-dry-run-seed';

/**
 * Delete the scratch repository, or refuse loudly.
 *
 * Both assertions the issue requires are here rather than at any call site, and the description
 * is read from GitHub inside this function rather than accepted from the caller, so the only
 * thing a caller can influence is which name is checked.
 */
export async function deleteScratchRepository(api: GitHubApi, target: string): Promise<void> {
  assertScratchName(target);
  const repository = await api.readRepository(target);
  if (!repository) {
    throw new ScratchGuardError(
      `Refusing to delete ${target}: GitHub has no such repository, so there is nothing this run created to remove.`,
    );
  }
  assertScratchRepository(target, repository);
  await api.deleteRepository(target);
}

/**
 * Create the scratch repository, or adopt the one a previous phase created.
 *
 * Adoption exists because of the installation obstacle below: the owner has to add the scratch
 * repository to the App installation between creating it and using it, so the run that uses it
 * is not the run that made it. An adopted repository clears exactly the same assertions a delete
 * requires, so adoption can never pick up something that a later delete would refuse — or worse,
 * something a later delete would accept and should not.
 */
export async function ensureScratchRepository(
  api: GitHubApi,
  target: string,
): Promise<RepositoryRecord> {
  assertScratchName(target);
  const existing = await api.readRepository(target);
  if (existing) {
    assertScratchRepository(target, existing);
    return existing;
  }
  const created = await api.createRepository({ fullName: target, description: scratchDescription });
  assertScratchRepository(target, created);
  return created;
}

/**
 * Refuse to start unless the App installation can reach the scratch repository.
 *
 * This runs before anything else, including creating the repository, because everything the dry
 * run is trying to prove happens through the App: an installation scoped to selected
 * repositories cannot open a pull request in a repository it was never granted, and discovering
 * that after creating a public repository and pushing a transform into it wastes the run and
 * leaves a repository behind.
 *
 * There is a genuine ordering knot here and the message says so rather than papering over it: an
 * installation scoped to `selected` can only be granted a repository that already exists, so the
 * first run of this driver creates the repository, stops here, and waits for a browser step the
 * `gh` credential cannot perform.
 */
export async function assertInstallationCoverage(
  api: GitHubApi,
  target: string,
): Promise<InstallationCoverage> {
  const coverage = await api.readInstallationCoverage();
  if (coverage.repositorySelection === 'all') return coverage;
  if (coverage.repositories.includes(target)) return coverage;
  const reachable =
    coverage.repositories.length > 0 ? coverage.repositories.join(', ') : '(nothing)';
  throw new InstallationCoverageError(
    [
      `The mirror GitHub App (app ${mirrorAppId}, installation ${mirrorInstallationId}) cannot reach ${target}.`,
      `The installation is scoped to selected repositories and currently reaches: ${reachable}.`,
      `An installation token therefore cannot open a pull request in ${target}, and this driver will not fall back to the gh user token: proving the App path is the point of this run.`,
      `Resolve it in the browser at ${installationSettingsUrl} by adding ${target} to the installation (or switching the installation to all repositories), then re-run.`,
      `If ${target} does not exist yet, run this driver with --phase create first: an installation scoped to selected repositories can only be granted a repository that already exists.`,
      `The gh CLI token cannot do any of that itself — GET /user/installations answers 403 for it, because that token is not authorized for this App.`,
    ].join('\n'),
  );
}

/** How the transform is invoked, so a test can drive the driver without a real corvidae tree. */
export type StageTransform = (options: StageOptions) => Promise<StageOutcome>;

export interface DryRunOptions {
  api: GitHubApi;
  /** The corvidae checkout whose source is transformed. */
  corvidaeRoot: string;
  /** Which mirror's transform is rehearsed. */
  target: MirrorTarget;
  /** The public repository the scratch repository is seeded from; read, never written. */
  seedRemote?: string;
  /** A disposable working tree. */
  workDirectory: string;
  /** Where the publish probe's tarball goes; outside the clone, so git never sees it. */
  scratchDirectory: string;
  /** The corvidae commit recorded in the provenance trailer. */
  corvidaeCommit: string;
  scratchRepository?: string;
  /** Keep the scratch repository instead of deleting it, for a human to look at the run. */
  keep?: boolean;
  /** Which published package the publish dry run uses; the first one by default. */
  packageName?: string;
  /**
   * The version the publish probe rehearses instead of the target's own.
   *
   * A released package cannot be published over, so a rehearsal of one is a rehearsal of its next
   * version; see `publish-rehearsal.ts`. It is applied after the sync commit is pushed, so it
   * never reaches the pull request this run opened.
   */
  version?: string;
  now?: Date;
  run?: CommandRunner;
  stage?: StageTransform;
  /**
   * How the publish is proven. Injectable for the same reason `stage` is: the tests in this file
   * are about the order the driver puts the round trip in, and the probe builds, packs and lints
   * a real package, which is `publish-rehearsal.test.ts`'s subject rather than this one's.
   */
  probe?: typeof proveNpmPublishDryRun;
  installArguments?: readonly string[];
  /** Reads allowed before a head commit carrying no check run fails the run. */
  checkRunAppearanceAttempts?: number;
  /** Reads allowed in total before an unfinished CI run fails the run. */
  checkRunCompletionAttempts?: number;
  /** How long the poll waits between reads. */
  checkRunDelayMilliseconds?: number;
  /** How the poll waits between attempts. */
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface DryRunReport {
  scratchRepository: string;
  coverage: InstallationCoverage;
  repository: RepositoryRecord;
  branch: string;
  changed: number;
  pullRequest: PullRequestRecord;
  checkRuns: readonly CheckRunRecord[];
  publish: PublishProbe;
  deleted: boolean;
}

function scratchRemoteUrl(target: string): string {
  return `https://github.com/${target}.git`;
}

async function runGit(
  run: CommandRunner,
  directory: string,
  environment: Record<string, string | undefined>,
  ...arguments_: string[]
): Promise<CommandResult> {
  const result = await run(['git', ...arguments_], { cwd: directory, env: environment });
  if (result.exitCode !== 0) {
    throw new DryRunError(
      `git ${arguments_.join(' ')} failed in ${directory} (exit ${result.exitCode}):\n${result.stderr}${result.stdout}`,
    );
  }
  return result;
}

/**
 * Seed the scratch repository from the real mirror's tip.
 *
 * An empty repository is not a usable rehearsal. The transform's own build-input guard refuses a
 * target that is missing the target-owned files a mirror carries and corvidae does not — the
 * build script, the bundler configuration — so a transform into an empty repository fails on the
 * first gate and proves nothing about the ones after it. A depth-one clone of the real mirror
 * gives the scratch repository exactly the tree the transform will meet in production, without
 * copying a history nobody needs.
 *
 * The shallow tip is then re-committed as an orphan before it is pushed, and that is not
 * cosmetic. Pushing a shallow tip asks the receiving side to accept a commit whose parent it does
 * not have, which needs `receive.shallowUpdate`, and GitHub leaves that off: the push is rejected
 * with `shallow update not allowed`. An orphan commit of the same tree has no parent to be
 * missing, so the push carries a complete object graph. It also carries no provenance trailer,
 * which keeps the foreign-commit guard on its first-sync path rather than tripping it.
 */
export async function seedScratchRepository(options: {
  run: CommandRunner;
  api: GitHubApi;
  target: MirrorTarget;
  seedRemote: string;
  scratchRepository: string;
  workDirectory: string;
}): Promise<void> {
  const { run, workDirectory } = options;
  await mkdir(workDirectory, { recursive: true });
  const environment = gitEnvironment();
  await runGit(
    run,
    workDirectory,
    environment,
    'clone',
    '--depth',
    '1',
    '--quiet',
    options.seedRemote,
    workDirectory,
  );
  await runGit(
    run,
    workDirectory,
    environment,
    'remote',
    'set-url',
    'origin',
    scratchRemoteUrl(options.scratchRepository),
  );
  await runGit(run, workDirectory, environment, 'checkout', '--quiet', '--orphan', seedBranch);
  await runGit(run, workDirectory, environment, 'add', '--all');
  await runGit(
    run,
    workDirectory,
    environment,
    'commit',
    '--quiet',
    '--message',
    `Seed ${options.target} from ${options.seedRemote}`,
  );
  // As the account, not the App. The seed carries the target's own `.github/workflows/**`, and
  // GitHub refuses a workflow file pushed by an App without the `workflows` permission — which
  // this App deliberately does not hold, because `target-owned.json` reserves `.github/` for the
  // target and the transform never writes it. Only the seed needs this; the transform branch and
  // the pull request below still go through the App, which is what this whole run exists to prove.
  const pushEnvironment = { ...environment, ...(await options.api.accountPushEnvironment()) };
  await runGit(
    run,
    workDirectory,
    pushEnvironment,
    'push',
    'origin',
    `HEAD:refs/heads/${baseBranch}`,
  );
}

export interface TransformOutcome {
  branch: string;
  changed: number;
  pullRequest: PullRequestRecord;
  outcome: StageOutcome;
}

/** Run the transform on a branch, push it as the App, and open the pull request. */
export async function transformAndOpenPullRequest(options: {
  api: GitHubApi;
  run: CommandRunner;
  stage: StageTransform;
  corvidaeRoot: string;
  target: MirrorTarget;
  corvidaeCommit: string;
  scratchRepository: string;
  workDirectory: string;
  branch: string;
  installArguments?: readonly string[];
}): Promise<TransformOutcome> {
  const { run, workDirectory, branch } = options;
  const environment = gitEnvironment();
  // The existing guard, reused rather than restated, which means accepting that it runs git
  // itself instead of through the injected runner. On a freshly seeded tree it reads one orphan
  // commit with no provenance trailer and reports nothing foreign.
  await assertNoForeignCommits(workDirectory);
  await runGit(run, workDirectory, environment, 'checkout', '-b', branch);
  const outcome = await options.stage({
    corvidaeRoot: options.corvidaeRoot,
    target: options.target,
    directory: workDirectory,
    ...(options.installArguments ? { installArguments: options.installArguments } : {}),
  });
  await runGit(run, workDirectory, environment, 'add', '--all');
  const status = await runGit(run, workDirectory, environment, 'status', '--porcelain');
  const changed = status.stdout.split('\n').filter((line) => line.length > 0);
  if (changed.length === 0) {
    throw new DryRunError(
      `The transform produced no change against the seeded ${options.target} tree, so there is no pull request to open. The scratch repository is still there; remove it with --phase delete.`,
    );
  }
  await runGit(
    run,
    workDirectory,
    environment,
    'commit',
    '--quiet',
    '--message',
    `Mirror dry run for ${options.target}\n\n${provenanceTrailer}: ${options.corvidaeCommit}`,
  );
  const pushEnvironment = { ...environment, ...(await options.api.pushEnvironment()) };
  await runGit(run, workDirectory, pushEnvironment, 'push', 'origin', `HEAD:refs/heads/${branch}`);
  const pullRequest = await options.api.createPullRequest({
    fullName: options.scratchRepository,
    base: baseBranch,
    head: branch,
    title: `Mirror dry run for ${options.target}`,
    body: [
      `Rehearsal of the ${options.target} mirror transform against a throwaway repository.`,
      '',
      `${provenanceTrailer}: ${options.corvidaeCommit}`,
      '',
      `This repository is disposable: ${scratchDescription}.`,
    ].join('\n'),
  });
  return { branch, changed: changed.length, pullRequest, outcome };
}

/** How long the poll waits between reads of the check runs on the head commit. */
export const checkRunPollDelayMilliseconds = 10_000;

/**
 * How long a head commit may carry no check run at all before that is the answer.
 *
 * This bounds *did CI start*, which is a question about whether the target's workflows trigger on
 * this pull request. Workflows register within seconds of a pull request opening, so two minutes
 * is generous for the question being asked and short enough that a target whose workflows never
 * trigger fails quickly instead of occupying the completion bound.
 */
export const checkRunAppearanceAttempts = 12;

/**
 * How long every registered check run may stay unfinished before that is the answer.
 *
 * This bounds *did CI pass*, which is a different question, and thirty minutes is an estimate
 * rather than a measurement: the observed run registered twenty check runs — a build, a browser
 * smoke test, an end-to-end matrix, a Postgres suite, coverage — over a change touching 945
 * paths, and no live run has yet been watched to completion to say what that actually costs.
 * `--check-run-timeout-minutes` exists so the number can be set from an observed duration rather
 * than from this guess, and raising it is only correct when a target's CI genuinely takes longer:
 * a longer wait is not a repair for a check that is stuck.
 */
export const checkRunCompletionAttempts = 180;

/**
 * The conclusions that count as a pass.
 *
 * `success` is the obvious one. `skipped` and `neutral` join it because GitHub's own required
 * check semantics treat both as satisfying a required check, so refusing them here would make
 * this driver stricter than the branch protection it exists to rehearse. Every other conclusion
 * GitHub can report — `failure`, `cancelled`, `timed_out`, `action_required`, `stale` — fails, as
 * does a completed check run carrying no conclusion at all, because a run that finished without
 * saying how is not evidence that it passed.
 */
const passingConclusions = new Set(['success', 'skipped', 'neutral']);

/** Why the poll stopped. */
export type CheckRunWaitStop = 'completed' | 'never-appeared' | 'never-completed';

export interface CheckRunWait {
  stop: CheckRunWaitStop;
  checkRuns: readonly CheckRunRecord[];
  /** How long a live run would have spent waiting, which is what a timeout message reports. */
  waitedMilliseconds: number;
}

/**
 * Poll the check runs on the head commit until they settle, or until a bound says they will not.
 *
 * Two questions share this one poll and they are bounded separately, because they have different
 * right answers. *Has CI started* is answered by the first check run appearing, and a head commit
 * that still carries none after the appearance bound means the workflows did not trigger. *Did CI
 * finish* is answered by every registered check run reaching `completed`, and that is a CI run's
 * worth of waiting, not a handful of seconds.
 *
 * Neither bound elapsing is a shrug. This function reports which bound it hit and
 * `assertCheckRunsPassed` turns both into refusals: a driver that stops waiting and calls the
 * result a pass is the same false green as one that never looked at a conclusion.
 */
export async function waitForCheckRuns(options: {
  api: GitHubApi;
  scratchRepository: string;
  ref: string;
  /** Reads allowed before a head commit carrying no check run is the answer. */
  appearanceAttempts?: number;
  /** Reads allowed in total before an unfinished CI run is the answer. */
  completionAttempts?: number;
  delayMilliseconds?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<CheckRunWait> {
  const appearance = options.appearanceAttempts ?? checkRunAppearanceAttempts;
  // Never shorter than the appearance bound: a completion bound inside it would report "still
  // unfinished" about check runs the poll had not yet given itself time to see.
  const completion = Math.max(options.completionAttempts ?? checkRunCompletionAttempts, appearance);
  const delay = options.delayMilliseconds ?? checkRunPollDelayMilliseconds;
  const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  let latest: readonly CheckRunRecord[] = [];
  for (let attempt = 1; attempt <= completion; attempt += 1) {
    latest = await options.api.readCheckRuns(options.scratchRepository, options.ref);
    const waitedMilliseconds = (attempt - 1) * delay;
    if (latest.length > 0 && latest.every((check) => check.status === 'completed')) {
      return { stop: 'completed', checkRuns: latest, waitedMilliseconds };
    }
    if (latest.length === 0 && attempt >= appearance) {
      return { stop: 'never-appeared', checkRuns: latest, waitedMilliseconds };
    }
    if (attempt < completion) await sleep(delay);
  }
  return {
    stop: 'never-completed',
    checkRuns: latest,
    waitedMilliseconds: (completion - 1) * delay,
  };
}

function minutes(milliseconds: number): string {
  const value = milliseconds / 60_000;
  const rounded = Number.isInteger(value) ? value.toString() : value.toFixed(1);
  return `${rounded} minute(s)`;
}

/**
 * What a failing run leaves behind, said in the failure itself.
 *
 * Every refusal below throws out of `runDryRun` before the delete at the end of it, so the
 * repository survives — and a surviving repository nobody is told about is just litter. The pull
 * request URL is here because the acceptance criterion this driver serves is that a run URL is
 * recorded, and on the failing path this message is the only place it can be recorded: the
 * report is never built, so `describe` never prints it.
 */
function survivingRepository(
  scratchRepository: string,
  pullRequest: PullRequestRecord,
): readonly string[] {
  return [
    `The scratch repository was kept rather than deleted, because a failed run is exactly the one worth reading: ${pullRequest.htmlUrl}`,
    `Remove it once you have: bun scripts/mirror/dry-run.ts --phase delete --scratch-repository ${scratchRepository}`,
  ];
}

/**
 * Rule on what the poll saw, and refuse anything that is not a pass.
 *
 * This is the assertion the round trip was missing. `waitForCheckRuns` answers what CI said, and
 * without something reading the conclusions a run in which every check completed `failure` was
 * indistinguishable from one in which every check completed `success`: both returned a list, and
 * the driver stored the list on the report and carried on to delete the evidence.
 */
export function assertCheckRunsPassed(options: {
  wait: CheckRunWait;
  scratchRepository: string;
  pullRequest: PullRequestRecord;
}): void {
  const { wait, pullRequest } = options;
  const surviving = survivingRepository(options.scratchRepository, pullRequest);
  if (wait.stop === 'never-appeared') {
    throw new CheckRunTimeoutError(
      [
        `No check run appeared on ${pullRequest.htmlUrl} within ${minutes(wait.waitedMilliseconds)}, so this run cannot claim CI passed: nothing ran.`,
        `Either the target's workflows do not trigger on a pull request from this branch, or the App that opened it cannot dispatch them.`,
        ...surviving,
      ].join('\n'),
    );
  }
  if (wait.stop === 'never-completed') {
    const pending = wait.checkRuns.filter((check) => check.status !== 'completed');
    throw new CheckRunTimeoutError(
      [
        `${pending.length} of ${wait.checkRuns.length} check run(s) on ${pullRequest.htmlUrl} were still unfinished after ${minutes(wait.waitedMilliseconds)}, so this run cannot claim CI passed:`,
        ...pending.map((check) => `  ${check.name}: ${check.status}`),
        `Raise --check-run-timeout-minutes only if this target's CI genuinely takes longer than that. A check that is stuck does not finish because the wait got longer.`,
        ...surviving,
      ].join('\n'),
    );
  }
  const failed = wait.checkRuns.filter(
    (check) => !passingConclusions.has(check.conclusion ?? 'none'),
  );
  if (failed.length === 0) return;
  throw new CheckRunFailureError(
    [
      `${failed.length} of ${wait.checkRuns.length} check run(s) on ${pullRequest.htmlUrl} did not pass, so the transform this run produced does not build on the target's own CI:`,
      ...failed.map(
        (check) => `  ${check.name}: ${check.conclusion ?? 'completed without a conclusion'}`,
      ),
      ...surviving,
    ].join('\n'),
  );
}

/** The whole round trip, in the order the guards require. */
export async function runDryRun(options: DryRunOptions): Promise<DryRunReport> {
  const run = options.run ?? runCommand;
  const stage = options.stage ?? stageSurface;
  const now = options.now ?? new Date();
  const scratchRepository = options.scratchRepository ?? scratchRepositoryName(now);
  assertScratchName(scratchRepository);
  const coverage = await assertInstallationCoverage(options.api, scratchRepository);
  const repository = await ensureScratchRepository(options.api, scratchRepository);
  const seedRemote =
    options.seedRemote ?? `https://github.com/${scratchOwner}/${options.target}.git`;
  await seedScratchRepository({
    run,
    api: options.api,
    target: options.target,
    seedRemote,
    scratchRepository,
    workDirectory: options.workDirectory,
  });
  const transformed = await transformAndOpenPullRequest({
    api: options.api,
    run,
    stage,
    corvidaeRoot: options.corvidaeRoot,
    target: options.target,
    corvidaeCommit: options.corvidaeCommit,
    scratchRepository,
    workDirectory: options.workDirectory,
    branch: `mirror-dry-run-${scratchStamp(scratchRepository)}`,
    ...(options.installArguments ? { installArguments: options.installArguments } : {}),
  });
  const wait = await waitForCheckRuns({
    api: options.api,
    scratchRepository,
    ref: transformed.pullRequest.headSha,
    ...(options.checkRunAppearanceAttempts === undefined
      ? {}
      : { appearanceAttempts: options.checkRunAppearanceAttempts }),
    ...(options.checkRunCompletionAttempts === undefined
      ? {}
      : { completionAttempts: options.checkRunCompletionAttempts }),
    ...(options.checkRunDelayMilliseconds === undefined
      ? {}
      : { delayMilliseconds: options.checkRunDelayMilliseconds }),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  // Before the publish probe and, more to the point, before the delete below. Throwing here is
  // what keeps the scratch repository: the delete is the last statement of this function, so a
  // refusal never reaches it, and the pull request whose CI just failed is still there to read.
  assertCheckRunsPassed({ wait, scratchRepository, pullRequest: transformed.pullRequest });
  const publish = await (options.probe ?? proveNpmPublishDryRun)({
    run,
    workDirectory: options.workDirectory,
    outcome: transformed.outcome,
    scratchDirectory: options.scratchDirectory,
    ...(options.packageName ? { packageName: options.packageName } : {}),
    ...(options.version ? { version: options.version } : {}),
  });
  if (options.keep !== true) await deleteScratchRepository(options.api, scratchRepository);
  return {
    scratchRepository,
    coverage,
    repository,
    branch: transformed.branch,
    changed: transformed.changed,
    pullRequest: transformed.pullRequest,
    checkRuns: wait.checkRuns,
    publish,
    deleted: options.keep !== true,
  };
}

function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function required(argv: readonly string[], name: string): string {
  const value = readOption(argv, name);
  if (!value) throw new DryRunError(`Missing required option --${name}`);
  return value;
}

/**
 * `--check-run-timeout-minutes`, as a count of polls.
 *
 * The bound is expressed in minutes on the command line because that is the unit the thing being
 * bounded is measured in — how long this target's CI takes — and converted here rather than
 * asking whoever runs this to divide by the poll interval themselves.
 */
function checkRunCompletionAttemptsFrom(argv: readonly string[]): number | undefined {
  const supplied = readOption(argv, 'check-run-timeout-minutes');
  if (supplied === undefined) return undefined;
  const parsed = Number(supplied);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new DryRunError(
      `--check-run-timeout-minutes must be a positive number of minutes, not ${JSON.stringify(supplied)}`,
    );
  }
  return Math.ceil((parsed * 60_000) / checkRunPollDelayMilliseconds);
}

export const dryRunPhases = ['preflight', 'create', 'all', 'delete'] as const;

export type DryRunPhase = (typeof dryRunPhases)[number];

function liveApi(): GitHubApi {
  return createGitHubApi({
    userToken: userTokenFromEnvironmentOrCli(),
    installationToken: installationTokenFromApp(),
  });
}

/**
 * The report of a run that got here, which is only ever a run whose CI passed.
 *
 * There is no "no check runs reported yet" branch any more, and that absence is the point: the
 * only way past `assertCheckRunsPassed` is every check run completed with a passing conclusion,
 * so a summary describing anything else would be describing a state this function cannot be
 * reached in.
 */
function describe(report: DryRunReport): string {
  const checks = report.checkRuns
    .map((check) => `  check run: ${check.name} ${check.status} ${check.conclusion ?? ''}`)
    .join('\n');
  return [
    `${report.scratchRepository}: pull request #${report.pullRequest.number} ${report.pullRequest.htmlUrl}`,
    `  branch ${report.branch} with ${report.changed} changed path(s)`,
    `  ${report.checkRuns.length} check run(s) completed, all passing:`,
    checks,
    `  publish dry run: ${report.publish.publicName}@${report.publish.version} built (exit ${report.publish.buildExitCode}), linted by publint (exit ${report.publish.publintExitCode}) and attw (exit ${report.publish.typeResolutionExitCode}), then \`${report.publish.command}\` exited ${report.publish.exitCode} shipping ${report.publish.entries.length} file(s) covering ${report.publish.entryPoints.length} entry point(s)`,
    report.deleted
      ? `  scratch repository deleted`
      : `  scratch repository kept; remove it with --phase delete`,
  ].join('\n');
}

export async function runDryRunCommand(
  argv: readonly string[],
  api: GitHubApi = liveApi(),
): Promise<number> {
  try {
    const phase = (readOption(argv, 'phase') ?? 'preflight') as DryRunPhase;
    if (!dryRunPhases.includes(phase)) {
      throw new DryRunError(`Unknown --phase "${phase}"; expected ${dryRunPhases.join(', ')}`);
    }
    const scratchRepository = readOption(argv, 'scratch-repository') ?? scratchRepositoryName();
    if (phase === 'preflight') {
      const coverage = await assertInstallationCoverage(api, scratchRepository);
      process.stdout.write(
        `${scratchRepository}: the App installation reaches it (repository_selection=${coverage.repositorySelection})\n`,
      );
      return 0;
    }
    if (phase === 'create') {
      const repository = await ensureScratchRepository(api, scratchRepository);
      process.stdout.write(
        `${repository.fullName}: ready at ${repository.htmlUrl}\nAdd it to the App installation at ${installationSettingsUrl}, then run --phase all.\n`,
      );
      return 0;
    }
    if (phase === 'delete') {
      await deleteScratchRepository(api, scratchRepository);
      process.stdout.write(`${scratchRepository}: deleted\n`);
      return 0;
    }
    const target = required(argv, 'target');
    if (!mirrorTargets.includes(target as MirrorTarget)) {
      throw new DryRunError(`Unknown --target "${target}"; expected ${mirrorTargets.join(' or ')}`);
    }
    const seedRemote = readOption(argv, 'seed-remote');
    const packageName = readOption(argv, 'package');
    const version = readOption(argv, 'version');
    const completionAttempts = checkRunCompletionAttemptsFrom(argv);
    const report = await runDryRun({
      ...(completionAttempts === undefined
        ? {}
        : { checkRunCompletionAttempts: completionAttempts }),
      api,
      corvidaeRoot:
        readOption(argv, 'corvidae-root') ?? new URL('../../', import.meta.url).pathname,
      target: target as MirrorTarget,
      workDirectory: required(argv, 'work'),
      scratchDirectory: required(argv, 'scratch'),
      corvidaeCommit: required(argv, 'corvidae-commit'),
      scratchRepository,
      keep: argv.includes('--keep'),
      ...(seedRemote ? { seedRemote } : {}),
      ...(packageName ? { packageName } : {}),
      ...(version ? { version } : {}),
    });
    process.stdout.write(`${describe(report)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await runDryRunCommand(Bun.argv.slice(2)));
