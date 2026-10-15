import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertChangesetFileName,
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
  // `--literal-pathspecs`: every path handed to git here is a file name, never a pattern, so
  // `fix[1].md` cannot also match `fix1.md`.
  return runCommand(['git', '--literal-pathspecs', ...arguments_], {
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

const immutableRemedy =
  'to replace a changeset, delete it in one pull request and add the replacement in a separate, later pull request; after sync, fix it in the target instead';

/**
 * Check 1, global for every target: a changeset on `main` is immutable until it is deleted.
 *
 * Delivery state is not inferred from content, name or mapping. Instead the history of each
 * changeset at HEAD must be a single commit, and none may have been created by a rename. One rule therefore covers an edit after the add, a retarget (which is an
 * edit), a rename git detects (50% similarity or more) and a delete followed by a re-add of the
 * same name. A squash-merged pull request contributes one commit, so edits within it pass.
 *
 * A second condition closes the gap rename detection leaves: no single commit may delete one
 * changeset and add another. That is exactly a replacement made in one pull request, which a
 * rename plus a rewrite of more than half would otherwise hide as a fresh file. The remedy is the
 * two pull requests the error spells out.
 */
export async function assertImmutable(
  corvidaeRoot: string,
  headFiles: readonly string[],
): Promise<void> {
  const present = new Set(headFiles);
  const replacements = await requireGit(corvidaeRoot, [
    'log',
    '--first-parent',
    '--no-renames',
    '--name-status',
    '--diff-merges=first-parent',
    '-z',
    '--format=%x01%H',
    '--',
    `${changesetDirectory}/`,
  ]);
  for (const record of replacements.split('\u0001')) {
    const tokens = record
      .split('\0')
      .map((token) => token.replace(/^\n+/, ''))
      .filter((token) => token.length > 0);
    const [hash, ...rest] = tokens;
    if (hash === undefined) continue;
    const deleted: string[] = [];
    const added: string[] = [];
    for (let index = 0; index + 1 < rest.length; index += 2) {
      const [status, path] = [rest[index]!, rest[index + 1]!];
      if (!/^\.changeset\/[^/]+\.md$/.test(path) || path === '.changeset/README.md') continue;
      if (status === 'D') deleted.push(path);
      if (status === 'A') added.push(path);
    }
    // A past mistake blocks only while the file it added is still here; a corrective pull request
    // that deletes it recovers the history.
    if (deleted.length > 0 && added.some((path) => present.has(path))) {
      throw new ChangesetEmissionError(
        `commit ${hash.slice(0, 12)} deletes ${deleted.join(', ')} and adds ${added.join(', ')}: ${immutableRemedy}.`,
      );
    }
  }
  // Renames git detects (50% similarity or more), as destination paths anywhere in history. This
  // is not `git log --follow`: follow also reports a new file as a copy of any similar existing
  // one, which would make two similar changesets from different pull requests block every sync.
  const renames = await requireGit(corvidaeRoot, [
    'log',
    '--first-parent',
    '--find-renames',
    '--diff-filter=R',
    '--name-status',
    '--diff-merges=first-parent',
    '-z',
    '--format=%x01',
    '--',
    `${changesetDirectory}/`,
  ]);
  const renamedTo = new Set<string>();
  for (const record of renames.split('\u0001')) {
    const tokens = record
      .split('\0')
      .map((token) => token.replace(/^\n+/, ''))
      .filter((token) => token.length > 0);
    for (let index = 0; index + 2 < tokens.length; index += 3) {
      if (/^R\d*$/.test(tokens[index]!)) renamedTo.add(tokens[index + 2]!);
    }
  }
  for (const path of headFiles) {
    if (renamedTo.has(path)) {
      throw new ChangesetEmissionError(
        `${path} was created by a rename. A changeset merged to main is immutable until deleted: ${immutableRemedy}.`,
      );
    }
    const output = await requireGit(corvidaeRoot, [
      'log',
      '--first-parent',
      '--diff-merges=first-parent',
      '--no-patch',
      '--format=%H',
      '--',
      path,
    ]);
    const commits = output.split('\n').filter((line) => line.length > 0);
    if (commits.length > 1) {
      throw new ChangesetEmissionError(
        `${path} has ${commits.length} commits in its history (an edit, a retarget or a re-added name). A changeset merged to main is immutable until deleted: ${immutableRemedy}.`,
      );
    }
  }
}

/** The mapping inputs: `targetFor` reads the first file and the validator's resolution the second. */
const mappingFiles = ['scripts/mirror/target-definitions.ts', 'scripts/mirror/package-map.json'];

/** A file at a revision, or `undefined` when it does not exist there. */
async function textAt(
  corvidaeRoot: string,
  revision: string,
  path: string,
): Promise<string | undefined> {
  const result = await readGit(corvidaeRoot, ['show', `${revision}:${path}`]);
  return result.exitCode === 0 ? result.stdout : undefined;
}

/** A package's mirror, or why it has none: nobody lists it, several mirrors do, or it is not published. */
type PackageOwner = MirrorTarget | 'unowned' | 'ambiguous' | 'not-published';

/**
 * Each `publish-as` package's npm name mapped to its mirror, under the mapping as it stood at a
 * revision. `target-definitions.ts` has no imports, so the historical file is loaded as a module
 * from a temporary copy (the way `publication-history.ts` loads historical policy) rather than
 * parsed. Anything unreadable throws: a mapping that cannot be resolved fails closed.
 */
async function packageTargetsAt(
  corvidaeRoot: string,
  revision: string,
): Promise<Map<string, PackageOwner>> {
  const [definitionsText, mapText] = await Promise.all(
    mappingFiles.map((path) => textAt(corvidaeRoot, revision, path)),
  );
  if (definitionsText === undefined || mapText === undefined) {
    throw new ChangesetEmissionError(
      `Cannot resolve the package-to-mirror mapping at ${revision}: ${mappingFiles.join(' and ')} must both exist there`,
    );
  }
  const directory = await mkdtemp(join(tmpdir(), 'changeset-mapping-'));
  try {
    const file = join(directory, 'target-definitions.ts');
    await Bun.write(file, definitionsText);
    const module = (await import(pathToFileURL(file).href)) as {
      targetDefinitions?: Record<string, { members?: readonly string[] }>;
    };
    const definitions = module.targetDefinitions;
    const map = JSON.parse(mapText) as {
      workspaces?: Record<string, { disposition?: string; name?: string }>;
    };
    if (definitions === undefined || map.workspaces === undefined) throw new Error('wrong shape');
    const packages = new Map<string, PackageOwner>();
    for (const [workspace, entry] of Object.entries(map.workspaces)) {
      if (entry.disposition !== 'publish-as' || entry.name === undefined) continue;
      const owners = Object.entries(definitions).filter(([, definition]) =>
        definition.members?.includes(workspace),
      );
      packages.set(
        entry.name,
        owners.length === 1
          ? (owners[0]![0] as MirrorTarget)
          : owners.length === 0
            ? 'unowned'
            : 'ambiguous',
      );
    }
    return packages;
  } catch (error) {
    if (error instanceof ChangesetEmissionError) throw error;
    throw new ChangesetEmissionError(
      `Cannot resolve the package-to-mirror mapping at ${revision}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The package names a changeset's bytes name, or `undefined` when they cannot be read. */
function packagesNamedBy(bytes: Uint8Array): string[] | undefined {
  try {
    return parseChangeset(new TextDecoder().decode(bytes)).bumps.map(({ name }) => name);
  } catch (error) {
    if (error instanceof ChangesetError) return undefined;
    throw error;
  }
}

/**
 * Check 2, global, deliberately blunt: a package named by a changeset at HEAD must be in the same
 * state at every inspected revision.
 *
 * Each target has its own trailer, so a changeset delivered to one mirror can later be pending
 * for another once its package moves, and one delivered before a package started publishing can
 * have been dropped. Rather than reason about which mirror saw what, the state of each named
 * package (its owning mirror, `unowned`, `ambiguous` or `not-published`) is read at the trailer,
 * at HEAD, and at every commit in `(trailer, HEAD]` that changes a mapping file together with
 * that commit's parent. Any difference between consecutive states throws for every target. The
 * price is that a brand-new package cannot carry a changeset until one sync has passed it.
 * Publication snapshots change neither disposition nor owner, so recording one is not a change.
 * A mapping that cannot be resolved at any revision fails closed.
 */
async function assertNoMovedPackages(
  corvidaeRoot: string,
  trailerSha: string,
  headFiles: readonly string[],
): Promise<void> {
  // `--first-parent`: follow main's integration history and compare each merge with its first
  // parent, so a topic-branch owner change that a merge discarded is not read as a move.
  const log = await requireGit(corvidaeRoot, [
    'log',
    '--first-parent',
    '--format=%H',
    '--reverse',
    `${trailerSha}..HEAD`,
    '--',
    ...mappingFiles,
  ]);
  const mappingCommits = log.split('\n').filter((line) => line.length > 0);
  if (mappingCommits.length === 0) return;

  const named = new Map<string, Set<string>>();
  let unreadable = false;
  for (const path of headFiles) {
    const names = packagesNamedBy(await blobBytes(corvidaeRoot, 'HEAD', path));
    if (names === undefined) unreadable = true;
    for (const name of names ?? []) named.set(name, (named.get(name) ?? new Set()).add(path));
  }

  const revisions = [
    trailerSha,
    ...mappingCommits.flatMap((commit) => [`${commit}^`, commit]),
    'HEAD',
  ];
  const mappings = new Map<string, Map<string, PackageOwner>>();
  for (const revision of revisions) {
    if (!mappings.has(revision))
      mappings.set(revision, await packageTargetsAt(corvidaeRoot, revision));
  }
  const universe = new Set<string>(named.keys());
  if (unreadable)
    for (const mapping of mappings.values()) for (const name of mapping.keys()) universe.add(name);

  const lines: string[] = [];
  for (const name of universe) {
    const chain: PackageOwner[] = [];
    for (const revision of revisions) {
      const state = mappings.get(revision)!.get(name) ?? 'not-published';
      if (chain.at(-1) !== state) chain.push(state);
    }
    if (chain.length < 2) continue;
    const paths = [...(named.get(name) ?? headFiles)].toSorted().join(', ');
    lines.push(`${name} went ${chain.join(' to ')}, and ${paths} names it`);
  }
  if (lines.length === 0) return;
  throw new ChangesetEmissionError(
    `${lines.join('; ')}: after moving a package between mirrors, or starting or stopping its publication, sync every affected mirror once before adding changesets that name it; delete existing ones first.`,
  );
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
  for (const path of headFiles) assertChangesetFileName(path);
  await assertImmutable(corvidaeRoot, headFiles);
  await assertNoMovedPackages(corvidaeRoot, trailerSha, headFiles);
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
