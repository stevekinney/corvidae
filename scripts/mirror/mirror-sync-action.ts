import { pushVerifiedBundle } from './authenticated-push.ts';
import { createGitHubApi, installationTokenFromApp, type GitHubApi } from './github-api.ts';
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
  provenanceTrailer,
  runSync,
  stageSurface,
  SyncError,
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
  await assertNoForeignCommits(
    clone,
    await foreignCommitOwnership({
      corvidaeRoot: options.corvidaeRoot,
      target: options.target,
      clone,
    }),
  );
  await stageSurface({
    corvidaeRoot: options.corvidaeRoot,
    target: options.target,
    directory: clone,
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
  const result: SyncResult = await runSync({
    corvidaeRoot,
    target,
    remote: targetRemoteUrl(target),
    directory: `${workDirectory}/${target}`,
    scratchDirectory,
    corvidaeCommit,
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
  const { manifest, bundlePath } = await verifyPreparedSyncArtifact({
    artifactDirectory,
    corvidaeRoot,
    remote: targetRemoteUrl(target),
    expectedTarget: target,
    expectedCorvidaeCommit: corvidaeCommit,
    expectedSnapshot: snapshot,
  });
  const fullName = targetRepositoryFullName(target);
  const branch = pullRequestBranchFor(corvidaeCommit);
  if (manifest.decision === 'skip') {
    if (snapshot) {
      if (manifest.workflowFile === undefined) {
        throw new MirrorSyncActionError(`${target}: snapshot artifact lacks a workflow file`);
      }
      const api = installationOnlyApi();
      if (api.dispatchWorkflow === undefined) {
        throw new MirrorSyncActionError('The GitHub API does not support workflow dispatch');
      }
      await api.dispatchWorkflow(
        snapshotDispatchFor(target, manifest.workflowFile, fullName, branch, manifest),
      );
      process.stdout.write(
        `${target}: snapshot workflow dispatched for ${fullName}@${manifest.baseBranch} (${manifest.baseCommit})\n`,
      );
    } else {
      process.stdout.write(`${target}: no change, nothing to open\n`);
    }
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
  const pullRequest = await api.createPullRequest({
    fullName,
    base: manifest.baseBranch,
    head: branch,
    title: `Sync ${target} from corvidae`,
    body: pullRequestBodyFor({ target, corvidaeCommit, changed: manifest.changed }),
  });
  if (snapshot) {
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
    process.stdout.write(
      `${target}: source pull request ${pullRequest.htmlUrl}; snapshot workflow dispatched for ${fullName}@${branch} (${manifest.commit})\n`,
    );
    return 0;
  }
  process.stdout.write(`${target}: opened ${pullRequest.htmlUrl}\n`);
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
