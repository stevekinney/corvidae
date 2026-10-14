import { join } from 'node:path';

import {
  ChangesetError,
  listChangesetFiles,
  parseChangeset,
  targetOfChangeset,
} from './changesets.ts';
import { runCommand } from './packaging.ts';
import type { MirrorTarget } from './target-definitions.ts';

/**
 * Copy corvidae's pending changesets into the mirror that releases them.
 *
 * A corvidae changeset is release intent written next to the change it describes. The mirror's own
 * Changesets flow versions and publishes it, so the only job here is delivery: put each pending
 * file into the target's `.changeset/`, exactly once, under a name that cannot collide with
 * anything the target authored.
 *
 * "Exactly once" is the whole difficulty, because the sync is stateless by design (it compares
 * output, never input) and a changeset the target has already consumed disappears from the
 * target. Three independent things hold it together:
 *
 * - **Range.** A changeset is pending when it exists at corvidae HEAD and not at the trailer SHA,
 *   the corvidae commit the target's newest mirror commit records. Anything already present at
 *   the trailer was delivered by an earlier sync, whatever the target did with it since.
 * - **Name.** The emitted path carries the first twelve hex digits of the commit that added the
 *   file, so every add event owns a path: a reused file name, or two files with identical text,
 *   can neither be dropped nor collapse into each other, and a corvidae name cannot collide with a
 *   target-authored one.
 * - **History.** A path the target's base branch has ever contained is skipped. It is the backstop
 *   for a range recomputed from an older trailer, and it is why the target consuming (deleting) a
 *   changeset never makes the next sync resurrect it.
 *
 * No emitted path joins the plan's prune prefixes, so nothing under the target's `.changeset/` is
 * ever deleted, and `target-owned.json` narrows the glob to the two files the target alone owns.
 */

export class ChangesetEmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangesetEmissionError';
  }
}

export interface ChangesetEmissionOptions {
  corvidaeRoot: string;
  target: MirrorTarget;
  /** The target clone. Without one there is nothing to deliver into, so nothing is emitted. */
  targetDirectory: string | undefined;
  /**
   * The newest mirror provenance's corvidae SHA, or `null` for a target the mirror has never
   * written to (a first sync emits nothing). `undefined` means the caller did not resolve it,
   * which emits nothing as well; `sync.ts` resolves it once per run.
   */
  trailerSha: string | null | undefined;
  /**
   * Receives one human-readable line per skipped path. These lines are a report for whoever
   * reads the run's output; nothing parses them. Defaults to standard error.
   */
  log?: ((line: string) => void) | undefined;
}

const changesetDirectory = '.changeset';

/** Read-only git against a repository whose configuration must not change the answer. */
async function readGit(directory: string, arguments_: readonly string[]) {
  return runCommand(['git', ...arguments_], {
    cwd: directory,
    env: { ...Bun.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

async function requireGit(directory: string, arguments_: readonly string[]): Promise<string> {
  const result = await readGit(directory, arguments_);
  if (result.exitCode !== 0) {
    throw new ChangesetEmissionError(
      `git ${arguments_.join(' ')} failed in ${directory} (exit ${result.exitCode}): ${result.stderr}`,
    );
  }
  return result.stdout;
}

/** A blob's exact bytes; decoding to text would lose a byte-order mark. */
async function blobBytes(directory: string, revision: string, path: string): Promise<Uint8Array> {
  const spawned = Bun.spawn(['git', 'show', `${revision}:${path}`], {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...Bun.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  const [bytes, stderr, exitCode] = await Promise.all([
    new Response(spawned.stdout).bytes(),
    new Response(spawned.stderr).text(),
    spawned.exited,
  ]);
  if (exitCode !== 0) {
    throw new ChangesetEmissionError(`Cannot read ${path} at ${revision}: ${stderr}`);
  }
  return bytes;
}

/** `.changeset/<name>.md` paths at a revision, other than the README. */
async function changesetsAt(directory: string, revision: string): Promise<string[]> {
  const listing = await requireGit(directory, [
    'ls-tree',
    '--name-only',
    '-z',
    revision,
    `${changesetDirectory}/`,
  ]);
  return listing
    .split('\0')
    .filter((path) => /^\.changeset\/[^/]+\.md$/.test(path) && path !== '.changeset/README.md')
    .toSorted();
}

/** Throw unless the trailer names a corvidae commit that HEAD descends from. */
async function assertPlaceable(corvidaeRoot: string, trailerSha: string): Promise<void> {
  const known = await readGit(corvidaeRoot, ['cat-file', '-e', `${trailerSha}^{commit}`]);
  if (!/^[0-9a-f]{40}$/.test(trailerSha) || known.exitCode !== 0) {
    throw new ChangesetEmissionError(
      `The target's newest mirror commit records ${trailerSha}, which is not a commit in this corvidae checkout. Fetch the full history (fetch-depth: 0) or investigate the mirror; a sync never runs with release intent it cannot place.`,
    );
  }
  const ancestry = await readGit(corvidaeRoot, ['merge-base', '--is-ancestor', trailerSha, 'HEAD']);
  if (ancestry.exitCode !== 0) {
    throw new ChangesetEmissionError(
      `The target's newest mirror commit records ${trailerSha}, which is not an ancestor of corvidae HEAD (exit ${ancestry.exitCode}); a sync never runs with release intent it cannot place.`,
    );
  }
}

/** The newest corvidae commit in `(trailer, HEAD]` that added the path. */
async function addingCommit(
  corvidaeRoot: string,
  trailerSha: string,
  path: string,
): Promise<string> {
  // `--no-renames`: a rename must surface as an addition of its new path, or the file would have
  // no adding commit and the rename-before-sync case would have nowhere to take its name from.
  const output = await requireGit(corvidaeRoot, [
    'log',
    '--no-renames',
    '--diff-filter=A',
    '--format=%H',
    '-1',
    `${trailerSha}..HEAD`,
    '--',
    path,
  ]);
  const commit = output.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new ChangesetEmissionError(
      `${path} is pending but no commit in ${trailerSha}..HEAD adds it`,
    );
  }
  return commit;
}

/** The target a changeset's bytes name, or `undefined` when they cannot be read as a changeset. */
async function targetOfBytes(bytes: Uint8Array): Promise<MirrorTarget | undefined> {
  try {
    return await targetOfChangeset(parseChangeset(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof ChangesetError) return undefined;
    throw error;
  }
}

/** Each path's target at a revision; `undefined` marks a file that cannot be read as a changeset. */
async function targetsAt(
  corvidaeRoot: string,
  revision: string,
  paths: readonly string[],
): Promise<Map<string, MirrorTarget | undefined>> {
  const targets = new Map<string, MirrorTarget | undefined>();
  for (const path of paths) {
    targets.set(path, await targetOfBytes(await blobBytes(corvidaeRoot, revision, path)));
  }
  return targets;
}

/** Whether a resolved target is the one being synced; an unreadable file fails closed as a yes. */
const concerns = (owner: MirrorTarget | undefined, target: MirrorTarget): boolean =>
  owner === undefined || owner === target;

/**
 * The paths whose content, at the trailer or at HEAD, names this target or cannot be read.
 * A path counts when either end is relevant, so a name reused for a different mirror's
 * changeset is still caught for the mirror whose release it would swallow.
 *
 * Also refuses a retarget: a file present at both ends whose target changed, where either end
 * is this target. Delivery cannot be inferred from a file that was never pending here, so the
 * release would vanish silently.
 */
async function relevantPaths(options: {
  corvidaeRoot: string;
  target: MirrorTarget;
  trailerSha: string;
  syncedFiles: readonly string[];
  headFiles: readonly string[];
}): Promise<Set<string>> {
  const { corvidaeRoot, target, trailerSha, syncedFiles, headFiles } = options;
  const [atTrailer, atHead] = await Promise.all([
    targetsAt(corvidaeRoot, trailerSha, syncedFiles),
    targetsAt(corvidaeRoot, 'HEAD', headFiles),
  ]);
  const relevant = new Set<string>();
  for (const [path, owner] of [...atTrailer, ...atHead]) {
    if (concerns(owner, target)) relevant.add(path);
  }
  for (const [path, before] of atTrailer) {
    if (!atHead.has(path)) continue;
    const after = atHead.get(path);
    if (before !== after && (concerns(before, target) || concerns(after, target))) {
      throw new ChangesetEmissionError(
        `${path} named ${before ?? 'an unreadable target'} when the target last synced and names ${after ?? 'an unreadable target'} now. Delivery of a retargeted changeset cannot be inferred, so its release would be lost: write a new changeset file instead of retargeting.`,
      );
    }
  }
  return relevant;
}

/**
 * A name that existed at the trailer and was added again in `(trailer, HEAD]` was deleted in
 * between and rewritten. It is not pending (it exists at both ends), so emitting nothing would
 * lose that release silently. Refuse, and make the author pick a new name.
 */
async function assertNoReusedNames(
  corvidaeRoot: string,
  trailerSha: string,
  synced: ReadonlySet<string>,
): Promise<void> {
  const output = await requireGit(corvidaeRoot, [
    'log',
    '--no-renames',
    '--diff-filter=A',
    '--name-only',
    '-z',
    '--format=',
    `${trailerSha}..HEAD`,
    '--',
    `${changesetDirectory}/`,
  ]);
  const reused = [...new Set(output.split('\0').filter((path) => synced.has(path)))].toSorted();
  if (reused.length > 0) {
    throw new ChangesetEmissionError(
      `${reused.join(', ')} existed when the target last synced and was added again since, so its release cannot be told apart from the synced one. Never reuse a changeset file name; give the new changeset a new name.`,
    );
  }
}

/**
 * A rename whose source existed at the trailer is a rename of something already synced, whether
 * or not the file was edited with it. Emitting the destination would release it twice; skipping
 * it would guess. Git's own rename detection is the judge, so an edit cannot hide one.
 */
async function assertNoRenamedSyncedNames(
  corvidaeRoot: string,
  trailerSha: string,
  synced: ReadonlySet<string>,
  pending: ReadonlySet<string>,
): Promise<void> {
  const output = await requireGit(corvidaeRoot, [
    'log',
    '--find-renames',
    '--diff-filter=R',
    '--name-status',
    '-z',
    '--format=',
    `${trailerSha}..HEAD`,
    '--',
    `${changesetDirectory}/`,
  ]);
  const fields = output.split('\0').map((field) => field.replace(/^\n+/, ''));
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [status, from, to] = [fields[index]!, fields[index + 1]!, fields[index + 2]!];
    if (/^R\d*$/.test(status) && synced.has(from)) {
      throw new ChangesetEmissionError(
        `${to} is a rename of ${from}, which was already synced: emitting it would release it twice. Revert the rename; fix a synced changeset in the target's .changeset/ instead.`,
      );
    }
  }

  // Rename detection needs 50% similarity, and a changeset is a few lines long: rename one and
  // rewrite it and git reports a deletion and an addition. A commit that deletes a synced
  // changeset and adds a pending one is treated as the rename it most likely is.
  const history = await requireGit(corvidaeRoot, [
    'log',
    '--no-renames',
    '--name-status',
    '-z',
    '--format=%x01',
    `${trailerSha}..HEAD`,
    '--',
    `${changesetDirectory}/`,
  ]);
  for (const record of history.split('\u0001')) {
    const tokens = record
      .split('\0')
      .map((token) => token.replace(/^\n+/, ''))
      .filter((token) => token.length > 0);
    const deleted: string[] = [];
    const added: string[] = [];
    for (let index = 0; index + 1 < tokens.length; index += 2) {
      const [status, path] = [tokens[index]!, tokens[index + 1]!];
      if (status === 'D' && synced.has(path)) deleted.push(path);
      if (status === 'A' && pending.has(path)) added.push(path);
    }
    if (deleted.length > 0 && added.length > 0) {
      throw new ChangesetEmissionError(
        `${added.join(', ')} was added in the same commit that deleted ${deleted.join(', ')}, which was already synced: it looks like a rename, and emitting it would release it twice. Delete the synced changeset in a separate commit, or revert; fix a synced changeset in the target's .changeset/ instead.`,
      );
    }
  }
}

/** Whether the target's current history has ever contained the path. */
async function inTargetHistory(targetDirectory: string, path: string): Promise<boolean> {
  const output = await requireGit(targetDirectory, [
    'log',
    'HEAD',
    '--full-history',
    '--format=%H',
    '--',
    path,
  ]);
  return output.trim().length > 0;
}

/** The emitted target-relative path to bytes, or `{}` when nothing is pending for this target. */
export async function planChangesetEmission({
  corvidaeRoot,
  target,
  targetDirectory,
  trailerSha,
  log = (line) => void process.stderr.write(`${line}\n`),
}: ChangesetEmissionOptions): Promise<Record<string, Uint8Array>> {
  if (targetDirectory === undefined || trailerSha === null || trailerSha === undefined) return {};
  // A checkout with no changeset file has no release intent to place, so it needs neither the
  // history nor a trailer that resolves in it.
  const present = await listChangesetFiles(corvidaeRoot);
  if (present.length === 0) return {};

  await assertPlaceable(corvidaeRoot, trailerSha);
  const [headFiles, syncedFiles] = await Promise.all([
    changesetsAt(corvidaeRoot, 'HEAD'),
    changesetsAt(corvidaeRoot, trailerSha),
  ]);
  const synced = new Set(syncedFiles);
  const pending = headFiles.filter((path) => !synced.has(path));
  // Only changesets that belong to this target can have been delivered to it, or be released
  // twice into it. A file that cannot be read fails closed: it counts as this target's.
  const relevant = await relevantPaths({
    corvidaeRoot,
    target,
    trailerSha,
    syncedFiles,
    headFiles,
  });
  const relevantSynced = new Set(syncedFiles.filter((path) => relevant.has(path)));
  const relevantPending = new Set(pending.filter((path) => relevant.has(path)));
  await assertNoReusedNames(corvidaeRoot, trailerSha, relevantSynced);
  await assertNoRenamedSyncedNames(corvidaeRoot, trailerSha, relevantSynced, relevantPending);

  const mine: { path: string; bytes: Uint8Array }[] = [];
  for (const path of pending) {
    const bytes = await blobBytes(corvidaeRoot, 'HEAD', path);
    try {
      const owner = await targetOfChangeset(parseChangeset(new TextDecoder().decode(bytes)));
      if (owner === target) mine.push({ path, bytes });
    } catch (error) {
      if (error instanceof ChangesetError) throw new ChangesetError(`${path}: ${error.message}`);
      throw error;
    }
  }
  if (mine.length === 0) return {};

  if (!(await Bun.file(join(targetDirectory, changesetDirectory, 'config.json')).exists())) {
    throw new ChangesetEmissionError(
      `${target} has pending corvidae changesets but its clone has no ${changesetDirectory}/config.json, so nothing there would version them`,
    );
  }

  const emitted: Record<string, Uint8Array> = {};
  for (const { path, bytes } of mine) {
    const adding = await addingCommit(corvidaeRoot, trailerSha, path);
    const name = path.slice(changesetDirectory.length + 1, -'.md'.length);
    const emittedPath = `${changesetDirectory}/corvidae-${adding.slice(0, 12)}-${name}.md`;
    if (await inTargetHistory(targetDirectory, emittedPath)) {
      log(`${target}: skipping ${emittedPath}; the target's history already contains it`);
      continue;
    }
    emitted[emittedPath] = bytes;
  }
  return emitted;
}
