import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serializeJson } from './json-formatting.ts';
import { targetDirectoryFor } from './layout-map.ts';
import { discoverWorkspaces, targetFor } from './manifests.ts';
import { loadPackageMap, type PackageMap } from './package-map.ts';
import { runCommand, type CommandRunner } from './packaging.ts';
import {
  collectDigestedFiles,
  hashDigestedFiles,
  publicationInputContract,
  type DigestedFile,
  type PublishedSnapshot,
} from './source-digest.ts';

import {
  historicalCollector,
  verifyHistoricalCheckout,
  type HistoricalCollector,
} from './publication-history.ts';
import {
  committedPublicationManifest,
  fetchPublishedManifest,
  verifyRegistryManifest,
} from './registry-manifest.ts';

/** Record only a source and publication contract proven against historical provenance and npm. */
export class RegistryVerificationError extends Error {}

/** Read the publishing commit through Bun; an absent field returns undefined. */
export async function fetchGitHead(
  name: string,
  version: string,
  runner: CommandRunner = runCommand,
): Promise<string | undefined> {
  const result = await runner(['bun', 'info', `${name}@${version}`, 'gitHead'], {
    cwd: process.cwd(),
  });
  if (result.exitCode !== 0) {
    throw new RegistryVerificationError(
      `${name}@${version}: \`bun info\` exited ${result.exitCode}\n${result.stdout}${result.stderr}`,
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
 * the commit with the same digest collector catches removed source and declared publication
 * roots. Both sides therefore apply the same README, surface, test and version exclusions.
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
    workspace: string;
    targetRepositoryDirectory: string;
    targetDirectory: string;
    commit: string;
    runner?: CommandRunner;
    collector?: HistoricalCollector;
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
    workspace,
    targetRepositoryDirectory,
    targetDirectory,
    commit,
    runner = runCommand,
    collector = collectDigestedFiles,
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

    const filesAtCommit = await collector({
      corvidaeRoot: scratch,
      corvidaeDirectory: targetDirectory,
      workspace,
    });
    const extraInCommit = filesAtCommit
      .map((file) => file.path)
      .filter((path) => !corvidaePaths.has(path) && !excludedFromExtra.has(path));

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
  workspace: string;
  targetRepositoryDirectory: string;
  publishedSourceRoot: string;
  mirrorCommit: string;
  registryRunner?: CommandRunner;
  gitRunner?: CommandRunner;
  fetcher?: typeof fetch;
  packageMap?: PackageMap;
}

export interface RecordResult {
  workspace: string;
  publicName: string;
  version: string;
  digest: string;
  previouslyRecorded: PublishedSnapshot | undefined;
  gitHead: string;
  snapshot: PublishedSnapshot;
}

export async function recordSourceDigest({
  corvidaeRoot,
  workspace,
  targetRepositoryDirectory,
  publishedSourceRoot,
  mirrorCommit,
  registryRunner = runCommand,
  gitRunner = runCommand,
  fetcher = fetch,
  packageMap,
}: RecordOptions): Promise<RecordResult> {
  const map = packageMap ?? (await loadPackageMap());
  const entry = map.workspaces[workspace];
  if (!entry) throw new RegistryVerificationError(`${workspace}: no entry in package-map.json`);
  if (entry.disposition !== 'publish-as')
    throw new RegistryVerificationError(
      `${workspace}: disposition is "${entry.disposition}", not "publish-as"`,
    );
  if (entry.lastPublishedVersion === null)
    throw new RegistryVerificationError(`${workspace}: lastPublishedVersion is null`);
  const version = entry.lastPublishedVersion;
  const gitHead = await fetchGitHead(entry.name, version, registryRunner);
  if (!gitHead)
    throw new RegistryVerificationError(
      `${workspace}: no recorded gitHead for ${entry.name}@${version}`,
    );
  if (
    !/^[a-f0-9]{40}$/.test(gitHead) ||
    !(await commitExists(targetRepositoryDirectory, gitHead, gitRunner))
  )
    throw new RegistryVerificationError(
      `${workspace}: ${gitHead} is not in ${targetRepositoryDirectory}'s history`,
    );
  if (!publishedSourceRoot)
    throw new RegistryVerificationError('A published source checkout is required');
  const target = targetFor(workspace);
  const corvidaeCommit = await verifyHistoricalCheckout({
    targetRoot: targetRepositoryDirectory,
    gitHead,
    mirrorCommit,
    sourceRoot: publishedSourceRoot,
    target,
    runner: gitRunner,
  });
  const corvidaeDirectory = await directoryFor(corvidaeRoot, workspace);
  const historicalDirectory = await directoryFor(publishedSourceRoot, workspace);
  const collector = await historicalCollector(publishedSourceRoot, workspace);
  const historicalFiles = await collector({
    corvidaeRoot: publishedSourceRoot,
    corvidaeDirectory: historicalDirectory,
    workspace,
  });
  const files = await collectDigestedFiles({ corvidaeRoot, corvidaeDirectory, workspace });
  const digest = hashDigestedFiles(files);
  if (
    hashDigestedFiles(historicalFiles) !== digest ||
    JSON.stringify(historicalFiles.map((file) => file.path)) !==
      JSON.stringify(files.map((file) => file.path))
  )
    throw new RegistryVerificationError(
      `${workspace}: historical source paths or bytes do not match current source`,
    );
  const targetDirectory = await targetDirectoryFor(workspace);
  const comparison = await compareAgainstCommit(historicalFiles, {
    workspace,
    targetRepositoryDirectory,
    targetDirectory,
    commit: gitHead,
    runner: gitRunner,
    collector,
  });
  if (!sourceComparisonIsClean(comparison))
    throw new RegistryVerificationError(
      `${workspace}: historical source does not match published commit ${gitHead}: ${JSON.stringify(comparison)}`,
    );
  const inputContract = await publicationInputContract({
    corvidaeRoot,
    corvidaeDirectory,
    workspace,
  });
  const historicalInputContract = await publicationInputContract({
    corvidaeRoot: publishedSourceRoot,
    corvidaeDirectory: historicalDirectory,
    workspace,
  });
  if (inputContract.digest !== historicalInputContract.digest)
    throw new RegistryVerificationError(
      `${workspace}: historical publication inputs differ from current source; publish the changed package first`,
    );
  const targetManifest = await committedPublicationManifest(
    targetRepositoryDirectory,
    gitHead,
    targetDirectory,
    gitRunner,
  );
  const registryManifest = await fetchPublishedManifest(
    entry.name,
    version,
    registryRunner,
    fetcher,
  );
  const registryManifestContract = verifyRegistryManifest(registryManifest, targetManifest);
  const snapshot: PublishedSnapshot = {
    schemaVersion: 1,
    version,
    gitHead,
    corvidaeCommit,
    source: { algorithm: 'sha256-files-v1', paths: files.map((file) => file.path), digest },
    publicationInputContract: inputContract,
    registryManifestContract,
  };
  return {
    workspace,
    publicName: entry.name,
    version,
    digest,
    previouslyRecorded: entry.publishedSnapshot,
    gitHead,
    snapshot,
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

export async function run(argv: readonly string[]): Promise<number> {
  try {
    const workspace = readOption(argv, 'workspace');
    const targetRepositoryDirectory = readOption(argv, 'target-clone');
    const publishedSourceRoot = readOption(argv, 'published-source-root');
    const mirrorCommit = readOption(argv, 'mirror-commit');
    const corvidaeRoot = new URL('../../', import.meta.url).pathname;
    const map = await loadPackageMap();
    const result = await recordSourceDigest({
      corvidaeRoot,
      workspace,
      targetRepositoryDirectory,
      publishedSourceRoot,
      mirrorCommit,
      packageMap: map,
    });
    const entry = map.workspaces[workspace];
    if (!entry || entry.disposition !== 'publish-as')
      throw new RegistryVerificationError('Published workspace disappeared');
    const updated: PackageMap = {
      ...map,
      workspaces: {
        ...map.workspaces,
        [workspace]: { ...entry, publishedSnapshot: result.snapshot },
      },
    };
    await Bun.write(
      new URL('./package-map.json', import.meta.url),
      await serializeJson(updated, corvidaeRoot, 'scripts/mirror/package-map.json'),
    );
    process.stdout.write(
      `Recorded publishedSnapshot for ${result.publicName}@${result.version}, target ${result.gitHead}, source ${result.snapshot.corvidaeCommit}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
