import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { serializeJson } from './json-formatting.ts';
import { targetDirectoryFor } from './layout-map.ts';
import { discoverWorkspaces } from './manifests.ts';
import { loadPackageMap, type PackageMap } from './package-map.ts';
import { runCommand, type CommandRunner } from './packaging.ts';
import {
  collectDigestedFiles,
  hashDigestedFiles,
  isDigestExcluded,
  type DigestedFile,
} from './source-digest.ts';
import { versionConstants } from './source.ts';

/**
 * Records `package-map.json`'s `sourceDigest` for one published workspace, after verifying the
 * digest it is about to record against the *source* the registry says it published — not the
 * packed tarball.
 *
 * A digest recorded without that check would be exactly as trustworthy as no digest at all — it
 * would say "this is what got published" on nothing but corvidae's own say-so, which is the same
 * unverified claim `assertEdgeNotStale` (source-digest.ts) exists to refuse. The first version of
 * this module verified against the published tarball's `README.md`/`LICENSE` instead, which two
 * defects it turned out to have: a tarball never carries `src/`, so it could not see whether the
 * *code* matched, only two files the digest no longer even covers (COR-1196 round 11 dropped
 * README and LICENSE from the digest's scope); and a docs edit or a copyright-year bump could
 * refuse the verification for a package whose actual source had not moved. This version compares
 * corvidae's current digest scope against the *committed source* at the commit the registry says
 * `lastPublishedVersion` was actually published from — `npm view <name>@<version> gitHead` — read
 * out of a local clone of the workspace's own target repository.
 *
 *   bun scripts/mirror/record-source-digest.ts --workspace @lostgradient/operative --target-clone /path/to/clone
 *
 * Three ways this refuses before recording anything: the registry has no `gitHead` for that
 * version (published before npm recorded provenance, or published by hand outside CI); the commit
 * is not in the clone's history (a rewritten history, or a clone that has not fetched it); or the
 * commit exists but its source at the scoped paths does not match corvidae's current tree, named
 * file by file.
 */

export class RegistryVerificationError extends Error {}

/**
 * The commit `<name>@<version>` was published from, read with the real `npm view` CLI rather than
 * a registry HTTP call — the coordinator's own verification (`npm view conversationalist@1.2.0
 * gitHead`) is the source of truth this mirrors, and `npm view` already carries whatever auth and
 * registry configuration the environment has. `undefined` when the field is absent (npm prints
 * nothing and exits 0), which covers a version published before npm recorded provenance in
 * `gitHead`, or one published by hand outside a CI job that sets it.
 */
export async function fetchGitHead(
  name: string,
  version: string,
  runner: CommandRunner = runCommand,
): Promise<string | undefined> {
  const result = await runner(['npm', 'view', `${name}@${version}`, 'gitHead'], {
    cwd: process.cwd(),
  });
  if (result.exitCode !== 0) {
    throw new RegistryVerificationError(
      `${name}@${version}: \`npm view\` exited ${result.exitCode}\n${result.stdout}${result.stderr}`,
    );
  }
  const gitHead = result.stdout.trim();
  return gitHead.length > 0 ? gitHead : undefined;
}

/** Whether `commit` resolves to a real commit object in the git repository at `directory`. */
export async function commitExists(
  directory: string,
  commit: string,
  runner: CommandRunner = runCommand,
): Promise<boolean> {
  const result = await runner(['git', 'cat-file', '-e', `${commit}^{commit}`], { cwd: directory });
  return result.exitCode === 0;
}

/**
 * Extract `targetDirectory`'s tree at `commit` into `destination`, as two commands total
 * (`git archive`, then `tar -x`) rather than one subprocess per file.
 *
 * The first version of this comparison called `git show <commit>:<path>` once per corvidae file —
 * correct, but `operative` alone digests 381 files, and a real sync's `bun run test:self` timed
 * out a test built on it at bun's default 5-second per-test budget (198s CI total across a much
 * larger job's worth of contention wasn't the problem; ~380 sequential subprocess spawns for one
 * package was). Measured: `git archive` + `tar -x` for the same 321-file `operative@0.12.0` tree
 * takes under 100ms combined. `--format=tar` rather than piping `git archive`'s stdout directly
 * into `tar -x` is deliberate: `CommandRunner` is one argv array and a `cwd`, with no shell
 * pipeline between two spawns, so the archive is written to a file and extracted as a second,
 * independent step — still two subprocesses, not the hundreds this replaces.
 */
async function extractCommitDirectory(
  targetRepositoryDirectory: string,
  commit: string,
  targetDirectory: string,
  destination: string,
  runner: CommandRunner,
): Promise<void> {
  const archivePath = join(destination, 'commit.tar');
  const archiveResult = await runner(
    ['git', 'archive', '--format=tar', `--output=${archivePath}`, commit, '--', targetDirectory],
    { cwd: targetRepositoryDirectory },
  );
  if (archiveResult.exitCode !== 0) {
    throw new RegistryVerificationError(
      `git archive ${commit} -- ${targetDirectory} in ${targetRepositoryDirectory} exited ${archiveResult.exitCode}\n${archiveResult.stdout}${archiveResult.stderr}`,
    );
  }
  const extractResult = await runner(['tar', '-xf', archivePath, '-C', destination], {
    cwd: destination,
  });
  if (extractResult.exitCode !== 0) {
    throw new RegistryVerificationError(
      `extracting ${archivePath} exited ${extractResult.exitCode}\n${extractResult.stdout}${extractResult.stderr}`,
    );
  }
}

/** Every file under `root`, relative to it, in a stable order — a plain recursive directory walk. */
async function walkDirectory(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    files.push(relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'));
  }
  return files.toSorted();
}

export interface SourceComparison {
  /** In corvidae's current digest scope, absent from the commit's tree at the same path. */
  missingInCommit: string[];
  /** In the commit's tree under the workspace's `src/`, absent from corvidae's current digest scope. */
  extraInCommit: string[];
  /** Present on both sides, with different content. */
  differing: string[];
}

/** Whether a comparison found nothing worth refusing on. */
export function sourceComparisonIsClean(comparison: SourceComparison): boolean {
  return (
    comparison.missingInCommit.length === 0 &&
    comparison.extraInCommit.length === 0 &&
    comparison.differing.length === 0
  );
}

/**
 * Compare corvidae's current digest scope for one workspace against a commit's tree in the
 * workspace's own target repository, at `targetDirectory` (its target-relative package
 * directory, from `layout-map.json`).
 *
 * Two directions, because either one alone would miss a real edge: reading corvidae's known files
 * out of the commit catches a file that changed or that corvidae added since the publish; walking
 * the commit's own `src/` tree and diffing it against corvidae's set catches the opposite — a file
 * the commit carries that corvidae has since removed, which the first direction would never look
 * for since it only asks about paths corvidae already knows. The `src/`-only walk (not
 * `additionalSourceRoots`, which can point outside `src/`) is deliberate: it is the one directory
 * this module can enumerate wholesale from a commit's tree without also reading every other
 * top-level file a target's own tooling might keep beside the package, most of which are that
 * target's own and not this comparison's business.
 *
 * Both directions read from a single `extractCommitDirectory` extraction rather than one `git`
 * invocation per file, and compare raw bytes rather than decoded text — `extractCommitDirectory`'s
 * own doc comment has the reason (and the measurement) for the first change; the second follows
 * from it for free, since reading an extracted file off disk carries no text-decoding step the way
 * a subprocess's captured stdout did.
 */
export async function compareAgainstCommit(
  corvidaeFiles: readonly DigestedFile[],
  options: {
    targetRepositoryDirectory: string;
    targetDirectory: string;
    commit: string;
    runner?: CommandRunner;
    /**
     * Workspace-relative paths that never count as "extra" on the commit side, even though
     * `corvidaeFiles` does not carry them. `recordSourceDigest` passes the workspace's
     * `versionConstants` path here: `applyVersionConstants` rewrites that file's version literal
     * before anything publishes, so a commit legitimately carrying it while corvidae's own digest
     * scope excludes it (`collectDigestedFiles` excludes it the same way) is not a removed file —
     * it is the one already-accounted-for difference between corvidae's tree and what shipped.
     */
    excludedFromExtra?: ReadonlySet<string>;
  },
): Promise<SourceComparison> {
  const {
    targetRepositoryDirectory,
    targetDirectory,
    commit,
    runner = runCommand,
    excludedFromExtra = new Set<string>(),
  } = options;
  const missingInCommit: string[] = [];
  const differing: string[] = [];
  const corvidaePaths = new Set(corvidaeFiles.map((file) => file.path));

  const scratch = await mkdtemp(join(tmpdir(), 'corvidae-commit-extract-'));
  try {
    await extractCommitDirectory(
      targetRepositoryDirectory,
      commit,
      targetDirectory,
      scratch,
      runner,
    );
    const extractedRoot = join(scratch, targetDirectory);

    for (const file of corvidaeFiles) {
      const candidate = Bun.file(join(extractedRoot, file.path));
      if (!(await candidate.exists())) {
        missingInCommit.push(file.path);
        continue;
      }
      const committed = new Uint8Array(await candidate.arrayBuffer());
      if (Buffer.compare(Buffer.from(file.bytes), Buffer.from(committed)) !== 0) {
        differing.push(file.path);
      }
    }

    const srcAtCommit = await walkDirectory(join(extractedRoot, 'src'));
    const extraInCommit = srcAtCommit
      .map((path) => `src/${path}`)
      .filter(
        (path) =>
          !corvidaePaths.has(path) && !isDigestExcluded(path) && !excludedFromExtra.has(path),
      );

    return {
      missingInCommit: missingInCommit.toSorted(),
      extraInCommit: extraInCommit.toSorted(),
      differing: differing.toSorted(),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export interface RecordOptions {
  corvidaeRoot: string;
  /** The workspace's corvidae name, as `package-map.json` keys it — not its public npm name. */
  workspace: string;
  /** A local clone of the workspace's own target repository, already fetched to at least `commit`. */
  targetRepositoryDirectory: string;
  npmRunner?: CommandRunner;
  gitRunner?: CommandRunner;
  /**
   * `package-map.json`, overridden. Every production call (`run` below) omits this and reads the
   * committed file, so a real recording always resolves against what is actually there. Tests
   * accept the same override `dispositionFor` (package-map.ts) and `planManifests` (manifests.ts)
   * already do, so a test can exercise a workspace shape the live map no longer has — such as a
   * `publish-as` entry with no `lastPublishedVersion` — without pinning the assertion to whichever
   * real workspace happens to be unpublished today.
   */
  packageMap?: PackageMap | undefined;
}

export interface RecordResult {
  workspace: string;
  publicName: string;
  version: string;
  digest: string;
  previouslyRecorded: string | undefined;
  gitHead: string;
}

/**
 * Compute a workspace's current source digest and verify it against the committed source the
 * registry says was published, without writing anything. `run` below is what writes; this is the
 * part worth calling directly from a test or a report, since it never touches `package-map.json`.
 */
export async function recordSourceDigest({
  corvidaeRoot,
  workspace,
  targetRepositoryDirectory,
  npmRunner = runCommand,
  gitRunner = runCommand,
  packageMap,
}: RecordOptions): Promise<RecordResult> {
  const map = packageMap ?? (await loadPackageMap());
  const entry = map.workspaces[workspace];
  if (entry === undefined) {
    throw new RegistryVerificationError(`${workspace}: no entry in package-map.json`);
  }
  if (entry.disposition !== 'publish-as') {
    throw new RegistryVerificationError(
      `${workspace}: disposition is "${entry.disposition}", not "publish-as" — only a published workspace has a registry version to record a digest against`,
    );
  }
  if (entry.lastPublishedVersion === null) {
    throw new RegistryVerificationError(
      `${workspace}: lastPublishedVersion is null — publish ${entry.name} at least once before recording a digest for it`,
    );
  }

  const gitHead = await fetchGitHead(entry.name, entry.lastPublishedVersion, npmRunner);
  if (gitHead === undefined) {
    throw new RegistryVerificationError(
      `${workspace}: ${entry.name}@${entry.lastPublishedVersion} has no recorded gitHead on the registry, so there is no commit to verify corvidae's source against. Recording a digest without that verification is exactly the unverified claim this command exists to prevent.`,
    );
  }
  if (!(await commitExists(targetRepositoryDirectory, gitHead, gitRunner))) {
    throw new RegistryVerificationError(
      `${workspace}: ${entry.name}@${entry.lastPublishedVersion}'s gitHead ${gitHead} is not in ${targetRepositoryDirectory}'s history. Fetch it (a rewritten history or a stale clone would both explain this) before recording.`,
    );
  }

  const corvidaeDirectory = await directoryFor(corvidaeRoot, workspace);
  const targetDirectory = await targetDirectoryFor(workspace);
  const files = await collectDigestedFiles({ corvidaeRoot, corvidaeDirectory, workspace });
  const digest = hashDigestedFiles(files);

  const versionConstantPath = versionConstants[workspace];
  const comparison = await compareAgainstCommit(files, {
    targetRepositoryDirectory,
    targetDirectory,
    commit: gitHead,
    runner: gitRunner,
    ...(versionConstantPath ? { excludedFromExtra: new Set([versionConstantPath]) } : {}),
  });
  if (!sourceComparisonIsClean(comparison)) {
    const lines = [
      ...comparison.missingInCommit.map(
        (path) => `  ${path}: corvidae carries it, the commit does not`,
      ),
      ...comparison.extraInCommit.map(
        (path) => `  ${path}: the commit carries it, corvidae does not`,
      ),
      ...comparison.differing.map((path) => `  ${path}: content differs`),
    ];
    throw new RegistryVerificationError(
      `${workspace}: corvidae's current source does not match ${entry.name}@${entry.lastPublishedVersion}'s published commit (${gitHead}). Refusing to record a digest that claims a state the registry does not confirm; publish ${entry.name} from its own target first.\n${lines.join('\n')}`,
    );
  }

  return {
    workspace,
    publicName: entry.name,
    version: entry.lastPublishedVersion,
    digest,
    previouslyRecorded: entry.sourceDigest,
    gitHead,
  };
}

/** A workspace's corvidae directory, read from `discoverWorkspaces`' own view of the tree. */
async function directoryFor(corvidaeRoot: string, workspace: string): Promise<string> {
  const discovered = await discoverWorkspaces(corvidaeRoot);
  const found = discovered.find((candidate) => candidate.name === workspace);
  if (found === undefined) {
    throw new RegistryVerificationError(`${workspace}: no workspace directory found in corvidae`);
  }
  return found.directory;
}

function readOption(argv: readonly string[], name: string): string {
  const index = argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value) throw new RegistryVerificationError(`Missing required option --${name}`);
  return value;
}

/** Write the recorded digest into `package-map.json`, preserving every other byte the file carries. */
function withRecordedDigest(map: PackageMap, workspace: string, digest: string): PackageMap {
  const entry = map.workspaces[workspace];
  if (entry === undefined || entry.disposition !== 'publish-as') {
    throw new RegistryVerificationError(`${workspace}: not a publish-as entry`);
  }
  return {
    ...map,
    workspaces: { ...map.workspaces, [workspace]: { ...entry, sourceDigest: digest } },
  };
}

export async function run(argv: readonly string[]): Promise<number> {
  try {
    const workspace = readOption(argv, 'workspace');
    const targetRepositoryDirectory = readOption(argv, 'target-clone');
    const corvidaeRoot = new URL('../../', import.meta.url).pathname;
    const result = await recordSourceDigest({ corvidaeRoot, workspace, targetRepositoryDirectory });
    const mapFile = new URL('./package-map.json', import.meta.url);
    const current = JSON.parse(await Bun.file(mapFile).text()) as PackageMap;
    const updated = withRecordedDigest(current, workspace, result.digest);
    // Formatted the way the repository's prettier formats it, so recording a digest changes only
    // the digest rather than reflowing every array in the file.
    await Bun.write(
      mapFile,
      await serializeJson(updated, corvidaeRoot, 'scripts/mirror/package-map.json'),
    );
    process.stdout.write(
      `Recorded sourceDigest for ${workspace} (${result.publicName}@${result.version}, gitHead ${result.gitHead}): ${result.digest}\n` +
        (result.previouslyRecorded ? `Previous digest was ${result.previouslyRecorded}\n` : ''),
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await run(Bun.argv.slice(2)));
