/**
 * What a build records about the source it was made from, and the check that refuses to serve a
 * build that no longer matches the checkout.
 *
 * `bun scripts/build.ts` writes `build-info.json` beside `index.html`: the commit of `HEAD` and a
 * digest of the uncommitted changes (edits to tracked files and the names of untracked ones). A
 * server the owner is pointed at calls {@link staleBuildProblem} before it starts, so a build made
 * from an older commit, or from a tree that has since changed, is refused instead of reviewed.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The file, in the build directory, that records the source the build was made from. */
export const BUILD_INFO_FILE = 'build-info.json';

/** The commit a build records when the checkout has no readable Git history. */
export const UNKNOWN_COMMIT = 'unknown';

/** The source a build was made from: the full commit, and a digest of the changes not committed. */
export type BuildInfo = {
  readonly commit: string;
  /** Empty when the tree matched `commit`; otherwise a digest of the edits on top of it. */
  readonly changes: string;
};

/**
 * The expression the build replaces with the text the page shows (`src/lib/build-commit.ts` reads
 * it), so the commit is compiled into the bundle and no request fetches it.
 */
export const BUILD_COMMIT_VARIABLE = 'INTERBOROUGH_BUILD_COMMIT';

/**
 * What the page shows for `source`: the short commit, with "(edited)" after it when the tree
 * carried uncommitted changes, and the empty string when the commit is unknown.
 */
export function displayedCommit(source: BuildInfo): string {
  if (source.commit === UNKNOWN_COMMIT) return '';
  const short = source.commit.slice(0, 7);
  return source.changes === '' ? short : `${short} (edited)`;
}

/** Runs `git` with `argumentsList` in `directory`: its output, or `undefined` when it failed. */
export type GitRunner = (directory: string, argumentsList: readonly string[]) => string | undefined;

/** The real `git`, for the command line and the server; a test supplies a stand-in. */
export const runGit: GitRunner = (directory, argumentsList) => {
  try {
    const result = Bun.spawnSync(['git', ...argumentsList], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    return result.exitCode === 0 ? result.stdout.toString() : undefined;
  } catch {
    return undefined;
  }
};

/** A digest of the file at `path`, or of its absence when it cannot be read (a file removed since the listing). */
function contentDigest(path: string): string {
  try {
    return Bun.hash(readFileSync(path)).toString(16);
  } catch {
    return 'unreadable';
  }
}

/** Read the checkout at `directory`: its `HEAD` commit and a digest of what is changed on top of it. */
export function readSourceInfo(directory: string, git: GitRunner = runGit): BuildInfo {
  const commit = git(directory, ['rev-parse', 'HEAD'])?.trim();
  if (commit === undefined || commit === '') return { commit: UNKNOWN_COMMIT, changes: '' };
  const edits = git(directory, ['diff', 'HEAD', '--no-ext-diff']) ?? '';
  const untracked = git(directory, ['ls-files', '--others', '--exclude-standard']) ?? '';
  // Each untracked, non-ignored file counts by path and by content, in sorted order, so editing
  // one changes the digest and a build made before the edit is stale.
  const untrackedDigest = untracked
    .split('\n')
    .filter((path) => path !== '')
    .toSorted()
    .map((path) => `${path}\0${contentDigest(join(directory, path))}`)
    .join('\n');
  const changes =
    edits === '' && untrackedDigest === ''
      ? ''
      : Bun.hash(`${edits}\n${untrackedDigest}`).toString(16);
  return { commit, changes };
}

/** Read the record in `buildDirectory`, or `undefined` when there is none or it is not a record. */
export function readBuildInfo(buildDirectory: string): BuildInfo | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(buildDirectory, BUILD_INFO_FILE), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const commit: unknown = Reflect.get(parsed, 'commit');
    const changes: unknown = Reflect.get(parsed, 'changes');
    return typeof commit === 'string' && typeof changes === 'string'
      ? { commit, changes }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Say why the build in `buildDirectory` is not the current source of the checkout at `source`, or
 * `undefined` when it is, or when the checkout has no Git history to compare against.
 */
export function staleBuildProblem(
  buildDirectory: string,
  source: string,
  git: GitRunner = runGit,
): string | undefined {
  const current = readSourceInfo(source, git);
  if (current.commit === UNKNOWN_COMMIT) return undefined;
  const recorded = readBuildInfo(buildDirectory);
  const rebuild = 'Run `bun run build` first.';
  if (recorded === undefined) {
    return `The build in ${buildDirectory} records no source commit, so it cannot be shown to match HEAD. ${rebuild}`;
  }
  if (recorded.commit !== current.commit) {
    return `The build in ${buildDirectory} was made from ${recorded.commit.slice(0, 7)} but HEAD is ${current.commit.slice(0, 7)}. ${rebuild}`;
  }
  if (recorded.changes !== current.changes) {
    return `The build in ${buildDirectory} does not match the uncommitted changes in the checkout at ${current.commit.slice(0, 7)}. ${rebuild}`;
  }
  return undefined;
}
