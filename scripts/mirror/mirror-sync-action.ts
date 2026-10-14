import { pushVerifiedBundle } from './authenticated-push.ts';
import {
  createGitHubApi,
  installationTokenFromApp,
  type GitHubApi,
  type OpenPullRequestRecord,
} from './github-api.ts';
import { mirrorBotLogin } from './github-app.ts';
import { resolveReleaseWorkflowFile } from './install-parity.ts';
import {
  verifyPreparedSyncArtifact,
  writePreparedSyncArtifact,
  type PreparedSyncManifest,
} from './prepared-sync.ts';
import { scratchOwner } from './scratch-repository.ts';
import {
  assertNoForeignCommits,
  cloneTarget,
  foreignCommitOwnership,
  git,
  gitEnvironment,
  newestMirrorProvenance,
  provenanceTrailer,
  runSync,
  stageSurface,
  SyncError,
  tryGit,
  type SyncResult,
} from './sync.ts';
import { mirrorTargets, type MirrorTarget } from './target-definitions.ts';

/**
 * The two entry points COR-1195's GitHub Actions workflow drives, one `bun` invocation per job:
 *
 * - `--mode report` (the weekly scheduled dry run) runs the whole transform for one target
 *   against a fresh clone and says whether it is behind, pushing nothing. `mirror-sync.yaml` runs
 *   this once per target in a matrix rather than looping all three in one process, so a target
 *   with a real problem fails its own job instead of aborting the other two.
 * - `--mode prepare` (the manual dispatch's first job) runs the verified transform and writes a
 *   bundle-plus-manifest artifact, carrying no App private key at all.
 * - `--mode publish` (the manual dispatch's second job) verifies that artifact in a fresh job and
 *   then opens the pull request or snapshot dispatch through the App installation.
 *
 * Both reuse `sync.ts`'s pipeline outright: the same clone, the same ownership-aware
 * foreign-commit guard (so a hand release commit already on a target's default branch is
 * recognized rather than refused), the same `stageSurface`. Nothing here re-implements any of it.
 */

export class MirrorSyncActionError extends Error {}

/** The `owner/repo` GitHub full name for a mirror target, on the account every mirror lives under. */
export function targetRepositoryFullName(target: MirrorTarget): string {
  return `${scratchOwner}/${target}`;
}

/** The `https://` remote every clone in this module reads from. */
export function targetRemoteUrl(target: MirrorTarget): string {
  return `https://github.com/${targetRepositoryFullName(target)}.git`;
}

/** A fresh branch per attempt, so a retry never collides with an earlier partial push. */
export function pullRequestBranchFor(corvidaeCommit: string): string {
  return `mirror-sync-${corvidaeCommit.slice(0, 12)}-${crypto.randomUUID()}`;
}

export function snapshotDispatchFor(
  target: MirrorTarget,
  workflowFile: string,
  fullName: string,
  branch: string,
  result: Pick<SyncResult, 'decision' | 'commit' | 'baseBranch' | 'baseCommit' | 'pullRequest'>,
): {
  fullName: string;
  workflowFile: string;
  ref: string;
  inputs: { snapshot: 'true'; expected_sha: string };
} {
  const ref = result.decision === 'pushed' ? branch : result.baseBranch;
  if (result.decision === 'pushed' && result.pullRequest === undefined) {
    throw new MirrorSyncActionError(`${target}: snapshot dispatch requires a source pull request`);
  }
  const expectedSha = result.decision === 'pushed' ? result.commit : result.baseCommit;
  if (expectedSha === undefined) {
    throw new MirrorSyncActionError(
      `${target}: snapshot dispatch lacks the verified target commit`,
    );
  }
  return {
    fullName,
    workflowFile,
    ref,
    inputs: { snapshot: 'true', expected_sha: expectedSha },
  };
}

export async function dispatchSnapshotWorkflow(
  api: Pick<GitHubApi, 'dispatchWorkflow'>,
  target: MirrorTarget,
  fullName: string,
  branch: string,
  result: Pick<SyncResult, 'decision' | 'commit' | 'baseBranch' | 'baseCommit' | 'pullRequest'>,
  targetDirectory: string,
): Promise<void> {
  if (api.dispatchWorkflow === undefined) {
    throw new MirrorSyncActionError('The GitHub API does not support workflow dispatch');
  }
  const workflowFile = await resolveReleaseWorkflowFile(targetDirectory);
  await api.dispatchWorkflow(snapshotDispatchFor(target, workflowFile, fullName, branch, result));
}

/**
 * The pull request body, said once here rather than assembled inline so the wording COR-1195
 * requires — the source is corvidae, and review threads are answered there rather than on the
 * target's own pull request — is one string a test can pin.
 */
export function pullRequestBodyFor(options: {
  target: MirrorTarget;
  corvidaeCommit: string;
  changed: readonly string[];
}): string {
  return [
    `Mirrors ${options.target} from corvidae@${options.corvidaeCommit}, ${options.changed.length} changed path(s).`,
    '',
    `${provenanceTrailer}: ${options.corvidaeCommit}`,
    '',
    "This pull request is opened by corvidae's mirror sync (stevekinney/corvidae, scripts/mirror/). " +
      'The source of truth is corvidae: review threads on this diff are answered there, not here.',
  ].join('\n');
}

/** The corvidae commit a sync pull request was built from, read from its head commit's message. */
function trailerShaOf(message: string): string | undefined {
  const matches = [...message.matchAll(new RegExp(`^${provenanceTrailer}: ([0-9a-f]{40})$`, 'gm'))];
  return matches.length === 1 ? matches[0]![1] : undefined;
}

interface SyncCandidates {
  candidates: OpenPullRequestRecord[];
  trailers: Map<number, string | undefined>;
}

/**
 * The open sync pull requests this run is compared against: a `mirror-sync-` head, the App as
 * author, the same base, and not the run's own pull request. Each carries the corvidae SHA read
 * from its head commit, or `undefined` when there is no single parsable trailer.
 */
async function readSyncCandidates(options: {
  api: Pick<GitHubApi, 'listOpenPullRequests' | 'getCommitMessage'>;
  fullName: string;
  base: string;
  excludeNumber?: number | undefined;
}): Promise<SyncCandidates> {
  const { api, fullName, base, excludeNumber } = options;
  const open = await api.listOpenPullRequests(fullName);
  const candidates = open.filter(
    (pullRequest) =>
      pullRequest.number !== excludeNumber &&
      pullRequest.headRef.startsWith('mirror-sync-') &&
      pullRequest.author === mirrorBotLogin &&
      pullRequest.baseRef === base,
  );
  const trailers = new Map<number, string | undefined>();
  for (const candidate of candidates) {
    trailers.set(
      candidate.number,
      trailerShaOf(await api.getCommitMessage(fullName, candidate.headSha)),
    );
  }
  return { candidates, trailers };
}

/**
 * The first candidate whose corvidae SHA strictly descends from this run's: a dispatch from an
 * older corvidae ref can finish after a newer one already opened its pull request, and then
 * everything this run would publish is obsolete. Equal SHAs are not newer.
 */
async function findNewerCandidate(
  corvidaeRoot: string,
  corvidaeCommit: string,
  { candidates, trailers }: SyncCandidates,
): Promise<{ candidate: OpenPullRequestRecord; trailerSha: string } | undefined> {
  for (const candidate of candidates) {
    const trailerSha = trailers.get(candidate.number);
    if (trailerSha === undefined || trailerSha === corvidaeCommit) continue;
    const descends = await tryGit(
      corvidaeRoot,
      'merge-base',
      '--is-ancestor',
      corvidaeCommit,
      trailerSha,
    );
    if (descends.exitCode === 0) return { candidate, trailerSha };
  }
  return undefined;
}

/**
 * Close every candidate whose corvidae SHA is an ancestor of `newCorvidaeCommit`, commenting
 * with `commentFor`. A candidate the checkout cannot place is left open with a logged reason and
 * never fails the job; a failed close is collected and thrown once every candidate was tried.
 */
async function closeAncestorCandidates(options: {
  api: Pick<GitHubApi, 'createIssueComment' | 'closePullRequest'>;
  corvidaeRoot: string;
  fullName: string;
  found: SyncCandidates;
  newCorvidaeCommit: string;
  commentFor: (trailerSha: string) => string;
  closedLine: string;
  failureHeading: string;
  log: (line: string) => void;
}): Promise<{ closed: number[]; left: { number: number; reason: string }[] }> {
  const { api, corvidaeRoot, fullName, found, newCorvidaeCommit, log } = options;
  const { candidates, trailers } = found;
  const closed: number[] = [];
  const left: { number: number; reason: string }[] = [];
  const failures: string[] = [];
  const leave = (number: number, reason: string): void => {
    left.push({ number, reason });
    log(`${fullName}#${number}: left open; ${reason}`);
  };
  for (const candidate of candidates) {
    const trailerSha = trailers.get(candidate.number);
    if (trailerSha === undefined) {
      leave(
        candidate.number,
        `its head commit has no single parsable ${provenanceTrailer} trailer`,
      );
      continue;
    }
    const ancestry = await tryGit(
      corvidaeRoot,
      'merge-base',
      '--is-ancestor',
      trailerSha,
      newCorvidaeCommit,
    );
    if (ancestry.exitCode === 128) {
      leave(candidate.number, `${trailerSha} is not an object in the corvidae checkout`);
      continue;
    }
    if (ancestry.exitCode !== 0) {
      leave(
        candidate.number,
        ancestry.exitCode === 1
          ? `${trailerSha} is not an ancestor of ${newCorvidaeCommit}`
          : `git merge-base --is-ancestor exited ${ancestry.exitCode}: ${ancestry.stderr.trim()}`,
      );
      continue;
    }
    try {
      await api.createIssueComment({
        fullName,
        issueNumber: candidate.number,
        body: options.commentFor(trailerSha),
      });
      await api.closePullRequest(fullName, candidate.number);
      closed.push(candidate.number);
      log(`${fullName}#${candidate.number}: closed; ${options.closedLine}`);
    } catch (error) {
      failures.push(
        `#${candidate.number}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new MirrorSyncActionError(`${options.failureHeading}:\n${failures.join('\n')}`);
  }
  return { closed, left };
}

/**
 * Close the older sync pull requests a new one makes redundant.
 *
 * A sync pull request carries the whole target diff, so a newer one built from a descendant of an
 * older one's corvidae commit contains everything the older one proposed. Leaving the older ones
 * open means a stack of pull requests that each re-propose (and, once changesets are copied
 * across, each re-deliver) the same release intent. A candidate is closed only when it is
 * provably older: its trailer SHA is an ancestor of the new pull request's corvidae SHA, checked
 * in the corvidae checkout. Anything the checkout cannot place is left open with a logged reason
 * and never fails the job, because an unprovable pull request is a human's to judge. Only a
 * failure to close a pull request that was provably superseded fails the job, and it does so
 * after every other candidate has been tried.
 *
 * Snapshot pull requests are candidates too: they are sync pull requests whose release workflow
 * dispatch the newer one makes moot.
 */
export async function supersedeOlderPullRequests(options: {
  api: Pick<
    GitHubApi,
    'listOpenPullRequests' | 'getCommitMessage' | 'createIssueComment' | 'closePullRequest'
  >;
  corvidaeRoot: string;
  fullName: string;
  base: string;
  /** The pull request just created. Excluded explicitly, never closed, whatever its trailer says. */
  newPullRequest: { number: number; htmlUrl: string };
  /** The corvidae commit the new pull request was built from. */
  newCorvidaeCommit: string;
  /**
   * Runs once the new pull request is known not to be stale and before any older one is closed.
   * The snapshot dispatch hangs here so a stale dispatch can never publish.
   */
  beforeClosingOlder?: (() => Promise<void>) | undefined;
  log?: ((line: string) => void) | undefined;
}): Promise<{ closed: number[]; left: { number: number; reason: string }[] }> {
  const { api, corvidaeRoot, fullName, base, newPullRequest, newCorvidaeCommit } = options;
  const log = options.log ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const found = await readSyncCandidates({
    api,
    fullName,
    base,
    excludeNumber: newPullRequest.number,
  });
  // A dispatch from an older corvidae ref can finish after a newer one already opened its pull
  // request. Then the new pull request is the stale one: close it and touch nothing else.
  const newer = await findNewerCandidate(corvidaeRoot, newCorvidaeCommit, found);
  if (newer !== undefined) {
    await api.createIssueComment({
      fullName,
      issueNumber: newPullRequest.number,
      body: `Superseded by ${newer.candidate.htmlUrl}, which is already open and built from corvidae@${newer.trailerSha}, a descendant of the corvidae commit this pull request mirrors (${newCorvidaeCommit}).`,
    });
    await api.closePullRequest(fullName, newPullRequest.number);
    log(
      `${fullName}#${newPullRequest.number}: closed; superseded by newer ${newer.candidate.htmlUrl}`,
    );
    return { closed: [newPullRequest.number], left: [] };
  }

  await options.beforeClosingOlder?.();

  return closeAncestorCandidates({
    api,
    corvidaeRoot,
    fullName,
    found,
    newCorvidaeCommit,
    commentFor: (trailerSha) =>
      `Superseded by ${newPullRequest.htmlUrl}, which is built from corvidae@${newCorvidaeCommit}, a descendant of the corvidae commit this pull request mirrors (${trailerSha}).`,
    closedLine: `superseded by ${newPullRequest.htmlUrl}`,
    failureHeading: `${fullName}: ${newPullRequest.htmlUrl} is open, but these superseded pull requests could not be closed`,
    log,
  });
}

/**
 * Finish a run that found nothing to sync. Corvidae HEAD already matches the target, so any open
 * sync pull request built from an ancestor of this run's commit is obsolete and is closed, and a
 * requested snapshot is dispatched first. If a strictly newer sync pull request is open, this run
 * is the stale one: it dispatches nothing and closes nothing.
 */
export async function settleSkippedSync(options: {
  api: Pick<
    GitHubApi,
    | 'dispatchWorkflow'
    | 'listOpenPullRequests'
    | 'getCommitMessage'
    | 'createIssueComment'
    | 'closePullRequest'
  >;
  target: MirrorTarget;
  manifest: Pick<PreparedSyncManifest, 'baseBranch' | 'baseCommit' | 'workflowFile'>;
  snapshot: boolean;
  branch: string;
  corvidaeCommit: string;
  corvidaeRoot: string;
  log?: ((line: string) => void) | undefined;
}): Promise<string> {
  const { api, target, manifest, snapshot, branch, corvidaeCommit, corvidaeRoot } = options;
  const log = options.log ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const fullName = targetRepositoryFullName(target);
  if (snapshot) {
    if (manifest.workflowFile === undefined) {
      throw new MirrorSyncActionError(`${target}: snapshot artifact lacks a workflow file`);
    }
    if (api.dispatchWorkflow === undefined) {
      throw new MirrorSyncActionError('The GitHub API does not support workflow dispatch');
    }
  }
  const found = await readSyncCandidates({ api, fullName, base: manifest.baseBranch });
  const newer = await findNewerCandidate(corvidaeRoot, corvidaeCommit, found);
  if (newer !== undefined) {
    const reason = `${fullName}#${newer.candidate.number} is open and built from corvidae@${newer.trailerSha}, a descendant of this run's corvidae@${corvidaeCommit}`;
    log(`${target}: nothing dispatched or closed; ${reason}`);
    return `${target}: nothing dispatched or closed; ${reason}\n`;
  }
  let message = `${target}: no change, nothing to open\n`;
  if (snapshot) {
    await api.dispatchWorkflow!(
      snapshotDispatchFor(target, manifest.workflowFile!, fullName, branch, {
        decision: 'skip',
        baseBranch: manifest.baseBranch,
        baseCommit: manifest.baseCommit,
      }),
    );
    message = `${target}: snapshot workflow dispatched for ${fullName}@${manifest.baseBranch} (${manifest.baseCommit})\n`;
  }
  const outcome = await closeAncestorCandidates({
    api,
    corvidaeRoot,
    fullName,
    found,
    newCorvidaeCommit: corvidaeCommit,
    commentFor: (trailerSha) =>
      `Superseded: corvidae@${corvidaeCommit} already matches the target, so this pull request (built from corvidae@${trailerSha}) has nothing left to propose.`,
    closedLine: 'corvidae HEAD already matches the target',
    failureHeading: `${fullName}: these obsolete sync pull requests could not be closed`,
    log,
  });
  if (outcome.closed.length > 0) {
    message += `${target}: closed obsolete sync pull request(s) ${outcome.closed.map((number) => `#${number}`).join(', ')}; corvidae HEAD already matches the target\n`;
  }
  return message;
}

/**
 * Open the sync pull request, check that it is not stale, dispatch the snapshot workflow when
 * asked, then close the pull requests the new one supersedes. The order is the contract: the new pull request exists before
 * anything is closed, so a failure to close can never leave a target with no sync pull request.
 */
export async function openSyncPullRequest(options: {
  api: Pick<
    GitHubApi,
    | 'createPullRequest'
    | 'dispatchWorkflow'
    | 'listOpenPullRequests'
    | 'getCommitMessage'
    | 'createIssueComment'
    | 'closePullRequest'
  >;
  target: MirrorTarget;
  manifest: Pick<PreparedSyncManifest, 'baseBranch' | 'baseCommit' | 'changed' | 'workflowFile'> & {
    commit: string;
  };
  snapshot: boolean;
  branch: string;
  corvidaeCommit: string;
  corvidaeRoot: string;
  log?: ((line: string) => void) | undefined;
}): Promise<string> {
  const { api, target, manifest, snapshot, branch, corvidaeCommit, corvidaeRoot } = options;
  const fullName = targetRepositoryFullName(target);
  const pullRequest = await api.createPullRequest({
    fullName,
    base: manifest.baseBranch,
    head: branch,
    title: `Sync ${target} from corvidae`,
    body: pullRequestBodyFor({ target, corvidaeCommit, changed: manifest.changed }),
  });
  let message = `${target}: opened ${pullRequest.htmlUrl}\n`;
  const outcome = await supersedeOlderPullRequests({
    api,
    corvidaeRoot,
    fullName,
    base: manifest.baseBranch,
    newPullRequest: pullRequest,
    newCorvidaeCommit: corvidaeCommit,
    beforeClosingOlder: async () => {
      if (!snapshot) return;
      if (manifest.workflowFile === undefined) {
        throw new MirrorSyncActionError(`${target}: snapshot artifact lacks a workflow file`);
      }
      if (api.dispatchWorkflow === undefined) {
        throw new MirrorSyncActionError('The GitHub API does not support workflow dispatch');
      }
      await api.dispatchWorkflow(
        snapshotDispatchFor(target, manifest.workflowFile, fullName, branch, {
          ...manifest,
          decision: 'pushed',
          pullRequest,
        }),
      );
      message = `${target}: source pull request ${pullRequest.htmlUrl}; snapshot workflow dispatched for ${fullName}@${branch} (${manifest.commit})\n`;
    },
    log: options.log,
  });
  if (outcome.closed.includes(pullRequest.number)) {
    message = `${target}: ${pullRequest.htmlUrl} was opened and immediately closed as superseded by a newer open sync pull request; no snapshot was dispatched\n`;
  }
  return message;
}

function isMirrorTarget(value: string): value is MirrorTarget {
  return (mirrorTargets as readonly string[]).includes(value);
}

function requiredTarget(argv: readonly string[]): MirrorTarget {
  const value = required(argv, 'target');
  if (!isMirrorTarget(value)) {
    throw new MirrorSyncActionError(
      `Unknown --target "${value}"; expected one of ${mirrorTargets.join(', ')}`,
    );
  }
  return value;
}

function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function baseBranchOption(argv: readonly string[]): string | undefined {
  return readOption(argv, 'base-branch') || undefined;
}

function snapshotOption(argv: readonly string[]): boolean {
  const index = argv.indexOf('--snapshot');
  if (index === -1) return false;
  const value = argv[index + 1];
  if (value !== 'true' && value !== 'false') {
    throw new MirrorSyncActionError('--snapshot must be "true" or "false"');
  }
  return value === 'true';
}

function required(argv: readonly string[], name: string): string {
  const value = readOption(argv, name);
  if (!value) throw new MirrorSyncActionError(`Missing required option --${name}`);
  return value;
}

function defaultCorvidaeRoot(argv: readonly string[]): string {
  return readOption(argv, 'corvidae-root') ?? new URL('../../', import.meta.url).pathname;
}

export interface DriftReport {
  target: MirrorTarget;
  behind: boolean;
  /** `git status --porcelain` lines from the staged clone; empty when `behind` is `false`. */
  changed: readonly string[];
}

/**
 * Clone, guard, transform and diff one target, without committing or pushing anything.
 *
 * This is the whole of `runSync` up to and including the `git status --porcelain` read, reused
 * rather than restated: the same foreign-commit guard, so a target carrying a hand release commit
 * reports drift instead of refusing outright, and the same `stageSurface`, so "behind" means
 * exactly what the sync would have pushed. `stageSurface` already runs `bun install` to
 * regenerate the lockfile, which is why this needs no separate installArguments handling — the
 * target's own workflow install parity is a `runSync`/`verifyTarget` concern this function does
 * not reach, because it never calls `verifyTarget`: a drift report answers "would this change
 * anything", not "does the target still build", which is what the pull request's own
 * `mirror-verify.yaml` run and the dispatch path's `verifyTarget` call answer instead.
 */
export async function reportDrift(options: {
  corvidaeRoot: string;
  target: MirrorTarget;
  remote: string;
  directory: string;
}): Promise<DriftReport> {
  const clone = await cloneTarget({ remote: options.remote, directory: options.directory });
  const provenance = await newestMirrorProvenance(clone, options.target, { strict: true });
  await assertNoForeignCommits(
    clone,
    await foreignCommitOwnership({
      corvidaeRoot: options.corvidaeRoot,
      target: options.target,
      clone,
      provenance,
    }),
  );
  await stageSurface({
    corvidaeRoot: options.corvidaeRoot,
    target: options.target,
    directory: clone,
    provenance,
  });
  const porcelain = await git(clone, 'status', '--porcelain');
  const changed = porcelain.split('\n').filter((line) => line.length > 0);
  return { target: options.target, behind: changed.length > 0, changed };
}

async function runReport(argv: readonly string[]): Promise<number> {
  const target = requiredTarget(argv);
  const corvidaeRoot = defaultCorvidaeRoot(argv);
  const workDirectory = required(argv, 'work');
  const report = await reportDrift({
    corvidaeRoot,
    target,
    remote: targetRemoteUrl(target),
    directory: `${workDirectory}/${target}`,
  });
  if (!report.behind) {
    process.stdout.write(`${target}: up to date, no drift\n`);
    return 0;
  }
  process.stdout.write(
    `${target}: behind, ${report.changed.length} changed path(s):\n${report.changed
      .map((line) => `  ${line}`)
      .join('\n')}\n`,
  );
  // Non-zero on purpose: a scheduled job that always exits 0 is a scheduled job nobody ever
  // notices drift from. A green weekly run is invisible, and invisible is the wrong shape for
  // "this mirror now differs from corvidae and nothing has synced it yet."
  return 1;
}

/**
 * The `GitHubApi` a dispatch is allowed to use: the App installation token only.
 *
 * `userToken` throws rather than falling back to `gh auth token` the way the dry run's live API
 * does, because a workflow runner has no `gh` session and no account credential at all — this
 * mode creates and deletes nothing, so nothing it does should ever need one. Reaching this
 * function is itself a defect in this module, not a missing credential to source.
 */
function installationOnlyApi(): GitHubApi {
  return createGitHubApi({
    installationToken: installationTokenFromApp(),
    userToken: async () => {
      throw new MirrorSyncActionError(
        'The pull-request dispatch never creates or deletes a repository, so it carries no user credential. Something asked for one.',
      );
    },
  });
}

async function corvidaeCommitFor(argv: readonly string[], corvidaeRoot: string): Promise<string> {
  const suppliedCorvidaeCommit = readOption(argv, 'corvidae-commit');
  if (suppliedCorvidaeCommit !== undefined) return suppliedCorvidaeCommit;
  const head = await git(corvidaeRoot, 'rev-parse', 'HEAD');
  return head.trim();
}

async function runPrepare(argv: readonly string[]): Promise<number> {
  const target = requiredTarget(argv);
  const snapshot = snapshotOption(argv);
  const corvidaeRoot = defaultCorvidaeRoot(argv);
  const workDirectory = required(argv, 'work');
  const scratchDirectory = required(argv, 'scratch');
  const artifactDirectory = required(argv, 'artifact');
  const corvidaeCommit = await corvidaeCommitFor(argv, corvidaeRoot);
  const baseBranch = baseBranchOption(argv);
  const result: SyncResult = await runSync({
    corvidaeRoot,
    target,
    remote: targetRemoteUrl(target),
    directory: `${workDirectory}/${target}`,
    scratchDirectory,
    corvidaeCommit,
    branch: baseBranch,
    prepareBranch: `mirror-prepare-${target}-${corvidaeCommit.slice(0, 12)}`,
  });
  const workflowFile = snapshot ? await resolveReleaseWorkflowFile(result.directory) : undefined;
  const manifest = await writePreparedSyncArtifact({
    artifactDirectory,
    result,
    corvidaeCommit,
    snapshot,
    workflowFile,
  });
  process.stdout.write(preparedMessage(manifest));
  return 0;
}

function preparedMessage(manifest: PreparedSyncManifest): string {
  if (manifest.decision === 'skip') {
    return `${manifest.target}: verified no change; prepared publish artifact for ${manifest.baseBranch} (${manifest.baseCommit})\n`;
  }
  return `${manifest.target}: prepared verified commit ${manifest.commit} from ${manifest.changed.length} changed path(s)\n`;
}

async function runPublish(argv: readonly string[]): Promise<number> {
  const target = requiredTarget(argv);
  const snapshot = snapshotOption(argv);
  const corvidaeRoot = defaultCorvidaeRoot(argv);
  const artifactDirectory = required(argv, 'artifact');
  const corvidaeCommit = await corvidaeCommitFor(argv, corvidaeRoot);
  const baseBranch = baseBranchOption(argv);
  const { manifest, bundlePath } = await verifyPreparedSyncArtifact({
    artifactDirectory,
    corvidaeRoot,
    remote: targetRemoteUrl(target),
    expectedTarget: target,
    expectedCorvidaeCommit: corvidaeCommit,
    expectedSnapshot: snapshot,
    ...(baseBranch === undefined ? {} : { expectedBaseBranch: baseBranch }),
  });
  const branch = pullRequestBranchFor(corvidaeCommit);
  if (manifest.decision === 'skip') {
    process.stdout.write(
      await settleSkippedSync({
        api: installationOnlyApi(),
        target,
        manifest,
        snapshot,
        branch,
        corvidaeCommit,
        corvidaeRoot,
      }),
    );
    return 0;
  }
  if (bundlePath === undefined || manifest.commit === undefined) {
    throw new SyncError(`${target}: prepared artifact lacks a verified commit bundle`);
  }
  const api = installationOnlyApi();
  await pushVerifiedBundle({
    bundle: bundlePath,
    remote: targetRemoteUrl(target),
    commit: manifest.commit,
    branch,
    environment: gitEnvironment(),
    credentialEnvironment: () => api.pushEnvironment(),
  });
  process.stdout.write(
    await openSyncPullRequest({
      api,
      target,
      manifest: { ...manifest, commit: manifest.commit },
      snapshot,
      branch,
      corvidaeCommit,
      corvidaeRoot,
    }),
  );
  return 0;
}

export async function runMirrorSyncActionCommand(argv: readonly string[]): Promise<number> {
  try {
    const mode = required(argv, 'mode');
    if (mode === 'report') return await runReport(argv);
    if (mode === 'prepare') return await runPrepare(argv);
    if (mode === 'publish') return await runPublish(argv);
    throw new MirrorSyncActionError(
      `Unknown --mode "${mode}"; expected "report", "prepare" or "publish"`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await runMirrorSyncActionCommand(Bun.argv.slice(2)));
