import { createGitHubApi, installationTokenFromApp, type GitHubApi } from './github-api.ts';
import { mirrorTargets, type MirrorTarget } from './manifests.ts';
import { scratchOwner } from './scratch-repository.ts';
import {
  assertNoForeignCommits,
  cloneTarget,
  foreignCommitOwnership,
  git,
  provenanceTrailer,
  runSync,
  stageSurface,
  SyncError,
  type SyncResult,
} from './sync.ts';

/**
 * The two entry points COR-1195's GitHub Actions workflow drives, one `bun` invocation per job:
 *
 * - `--mode report` (the weekly scheduled dry run) runs the whole transform for one target
 *   against a fresh clone and says whether it is behind, pushing nothing. `mirror-sync.yaml` runs
 *   this once per target in a matrix rather than looping all three in one process, so a target
 *   with a real problem fails its own job instead of aborting the other two.
 * - `--mode dispatch` (the manual `workflow_dispatch`) runs the same transform for one chosen
 *   target and, when it produced a change, opens a pull request in that target through the App
 *   installation rather than pushing straight to its default branch — `runSync`'s `pullRequest`
 *   option (COR-1195) does the branch-and-push-and-open, this module supplies the target's
 *   `owner/repo`, the branch name and the pull request body.
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
async function installationOnlyApi(): Promise<GitHubApi> {
  const token = await installationTokenFromApp()();
  delete Bun.env['MIRROR_APP_PRIVATE_KEY'];
  delete Bun.env['MIRROR_APP_PRIVATE_KEY_FILE'];
  return createGitHubApi({
    installationToken: async () => token,
    userToken: async () => {
      throw new MirrorSyncActionError(
        'The pull-request dispatch never creates or deletes a repository, so it carries no user credential. Something asked for one.',
      );
    },
  });
}

async function runDispatch(argv: readonly string[]): Promise<number> {
  const target = requiredTarget(argv);
  const corvidaeRoot = defaultCorvidaeRoot(argv);
  const workDirectory = required(argv, 'work');
  const scratchDirectory = required(argv, 'scratch');
  const suppliedCorvidaeCommit = readOption(argv, 'corvidae-commit');
  let corvidaeCommit = suppliedCorvidaeCommit;
  if (corvidaeCommit === undefined) {
    const head = await git(corvidaeRoot, 'rev-parse', 'HEAD');
    corvidaeCommit = head.trim();
  }
  const branch = pullRequestBranchFor(corvidaeCommit);
  const api = await installationOnlyApi();
  const fullName = targetRepositoryFullName(target);

  const result: SyncResult = await runSync({
    corvidaeRoot,
    target,
    remote: targetRemoteUrl(target),
    directory: `${workDirectory}/${target}`,
    scratchDirectory,
    corvidaeCommit,
    pullRequest: {
      branch,
      pushEnvironment: () => api.pushEnvironment(),
      openPullRequest: ({ base, changed }) =>
        api.createPullRequest({
          fullName,
          base,
          head: branch,
          title: `Sync ${target} from corvidae`,
          body: pullRequestBodyFor({ target, corvidaeCommit, changed }),
        }),
    },
  });

  if (result.decision === 'skip') {
    process.stdout.write(`${target}: no change, nothing to open\n`);
    return 0;
  }
  if (!result.pullRequest) {
    // Unreachable while `pullRequest` was supplied above and the decision is `pushed`, since
    // `runSync` only takes that branch when it opened one — kept explicit so a future change to
    // `runSync`'s pull-request contract fails loudly here instead of printing `undefined`.
    throw new SyncError(`${target}: pushed but no pull request was recorded`);
  }
  process.stdout.write(`${target}: opened ${result.pullRequest.htmlUrl}\n`);
  return 0;
}

export async function runMirrorSyncActionCommand(argv: readonly string[]): Promise<number> {
  try {
    const mode = required(argv, 'mode');
    if (mode === 'report') return await runReport(argv);
    if (mode === 'dispatch') return await runDispatch(argv);
    throw new MirrorSyncActionError(`Unknown --mode "${mode}"; expected "report" or "dispatch"`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await runMirrorSyncActionCommand(Bun.argv.slice(2)));
