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
  /** Receives one line per skipped path. Defaults to standard error, which reports never parse. */
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

/** Whether the target's current history has ever contained the path. */
async function inTargetHistory(targetDirectory: string, path: string): Promise<boolean> {
  const output = await requireGit(targetDirectory, ['log', 'HEAD', '--format=%H', '--', path]);
  return output.trim().length > 0;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(right);
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

  // A pending file byte-equal to a synced file that no longer exists is a rename of something the
  // target already has. Emitting it would release twice; skipping it would guess. Neither.
  const head = new Set(headFiles);
  for (const gone of syncedFiles.filter((path) => !head.has(path))) {
    const goneBytes = await blobBytes(corvidaeRoot, trailerSha, gone);
    const renamed = mine.find(({ bytes }) => sameBytes(bytes, goneBytes));
    if (renamed !== undefined) {
      throw new ChangesetEmissionError(
        `${renamed.path} has the same content as ${gone}, which was already synced and no longer exists: it looks like a rename of a synced changeset. Revert the rename; fix a synced changeset in the target's .changeset/ instead.`,
      );
    }
  }

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
