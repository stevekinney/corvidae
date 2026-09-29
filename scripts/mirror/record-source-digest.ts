import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildCleanPublishedPackage } from './clean-package-build.ts';
import { serializeJson } from './json-formatting.ts';
import { discoverWorkspaces } from './manifests.ts';
import { loadPackageMap, type PackageMap } from './package-map.ts';
import { runCommand, type CommandRunner } from './packaging.ts';
import {
  historicalCollector,
  verifyHistoricalCheckout,
  type HistoricalCollector,
} from './publication-history.ts';
import {
  loadHistoricalPublicationRouting,
  type HistoricalPublicationRouting,
} from './publication-routing.ts';
import {
  committedWorkspaceVersions,
  fetchPublishedPackage,
  verifyRegistryManifest,
} from './registry-manifest.ts';
import {
  collectDigestedFiles,
  hashDigestedFiles,
  publicationInputContract,
  type DigestedFile,
  type PublishedSnapshot,
} from './source-digest.ts';

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
 * Extract the exact target commit into `destination`, as two commands total
 * (`git archive`, then `tar -x`) rather than one subprocess per file.
 *
 * This avoids one `git show` spawn per source file. `CommandRunner` has no shell pipeline,
 * so the archive is written to disk before the second command extracts it.
 */
async function extractCommitTree(
  targetRepositoryDirectory: string,
  commit: string,
  destination: string,
  runner: CommandRunner,
): Promise<void> {
  const archivePath = join(destination, 'commit.tar');
  const archiveResult = await runner(
    ['git', 'archive', '--format=tar', `--output=${archivePath}`, commit],
    { cwd: targetRepositoryDirectory },
  );
  if (archiveResult.exitCode !== 0) {
    throw new RegistryVerificationError(
      `git archive ${commit} in ${targetRepositoryDirectory} exited ${archiveResult.exitCode}\n${archiveResult.stdout}${archiveResult.stderr}`,
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

type EmittedFiles = Record<string, string | Uint8Array>;

export async function historicalEmittedFiles(
  publishedSourceRoot: string,
  workspace: string,
  corvidaeDirectory: string,
  routing: HistoricalPublicationRouting,
  targetCommitDirectory: string,
): Promise<EmittedFiles> {
  const mirror = join(publishedSourceRoot, 'scripts/mirror');
  const sourceModule = (await import(
    pathToFileURL(join(mirror, 'source.ts')).href
  )) as typeof import('./source.ts');
  const configurationModule = (await import(
    pathToFileURL(join(mirror, 'typescript-configuration.ts')).href
  )) as typeof import('./typescript-configuration.ts');
  const surfaceModule = (await import(
    pathToFileURL(join(mirror, 'package-surface.ts')).href
  )) as typeof import('./package-surface.ts');
  const surface = await surfaceModule.loadPackageSurface();
  const entry = surface.packages[workspace];
  if (!entry)
    throw new RegistryVerificationError(`${workspace}: historical package surface is missing`);
  const emitted = [
    { workspace, corvidaeDirectory, targetDirectory: routing.targetDirectory, entry },
  ];
  const source = await sourceModule.planSource(publishedSourceRoot, emitted, targetCommitDirectory);
  const configuration = await configurationModule.planTypeScriptConfiguration({
    corvidaeRoot: publishedSourceRoot,
    target: routing.target,
    configurationTarget: routing.configurationTarget,
    configurationDirectory: routing.configurationDirectory,
    workspaces: emitted,
    targetDirectory: targetCommitDirectory,
  });
  sourceModule.assertSingleOwner([
    { owner: 'historical source', paths: Object.keys(source.files) },
    { owner: 'historical TypeScript configuration', paths: Object.keys(configuration.files) },
  ]);
  return { ...source.files, ...configuration.files };
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
 * Both directions read from one exact commit extraction rather than one `git` invocation per
 * file. The recorder supplies the historical emitted plan so an intentional source transform is
 * compared to its published bytes; the separate historical/current digest still compares raw
 * source bytes. Direct callers without a plan compare their supplied bytes as before.
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
    /** Returns emitted files keyed by target-relative paths in the extracted commit tree. */
    expectedEmittedFiles?: (targetCommitDirectory: string) => Promise<EmittedFiles>;
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
    expectedEmittedFiles,
  } = options;
  const missingInCommit: string[] = [];
  const differing: string[] = [];
  const encoder = new TextEncoder();
  const corvidaePaths = new Set(corvidaeFiles.map((file) => file.path));

  const scratch = await mkdtemp(join(tmpdir(), 'corvidae-commit-extract-'));
  try {
    await extractCommitTree(targetRepositoryDirectory, commit, scratch, runner);
    const extractedRoot = join(scratch, targetDirectory);
    const emittedFiles = await expectedEmittedFiles?.(scratch);

    for (const file of corvidaeFiles) {
      const emitted = emittedFiles?.[`${targetDirectory}/${file.path}`];
      if (emittedFiles !== undefined && emitted === undefined) {
        throw new RegistryVerificationError(`${workspace}: no emitted plan file for ${file.path}`);
      }
      const candidate = Bun.file(join(extractedRoot, file.path));
      if (!(await candidate.exists())) {
        missingInCommit.push(file.path);
        continue;
      }
      const committed = new Uint8Array(await candidate.arrayBuffer());
      const expected =
        emitted === undefined
          ? file.bytes
          : typeof emitted === 'string'
            ? encoder.encode(emitted)
            : emitted;
      if (Buffer.compare(Buffer.from(expected), Buffer.from(committed)) !== 0) {
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
  buildPublishedPackage?: typeof buildCleanPublishedPackage;
  buildHistoricalSurface?: (
    publishedSourceRoot: string,
    workspace: string,
    corvidaeDirectory: string,
    routing: HistoricalPublicationRouting,
    targetCommitDirectory: string,
  ) => Promise<EmittedFiles>;
  bunExecutable?: string;
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
  buildPublishedPackage = buildCleanPublishedPackage,
  buildHistoricalSurface = historicalEmittedFiles,
  bunExecutable,
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
  const corvidaeDirectory = await directoryFor(corvidaeRoot, workspace);
  const historicalDirectory = await directoryFor(publishedSourceRoot, workspace);
  const historicalRouting = await loadHistoricalPublicationRouting(
    publishedSourceRoot,
    workspace,
    historicalDirectory,
  );
  const corvidaeCommit = await verifyHistoricalCheckout({
    targetRoot: targetRepositoryDirectory,
    gitHead,
    mirrorCommit,
    sourceRoot: publishedSourceRoot,
    target: historicalRouting.target,
    workspace,
    targetDirectory: historicalRouting.targetDirectory,
    runner: gitRunner,
  });
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
  const comparison = await compareAgainstCommit(historicalFiles, {
    workspace,
    targetRepositoryDirectory,
    targetDirectory: historicalRouting.targetDirectory,
    commit: gitHead,
    runner: gitRunner,
    collector,
    expectedEmittedFiles: (targetCommitDirectory) =>
      buildHistoricalSurface(
        publishedSourceRoot,
        workspace,
        historicalDirectory,
        historicalRouting,
        targetCommitDirectory,
      ),
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
    publishedWorkspaceVersions: await committedWorkspaceVersions(
      targetRepositoryDirectory,
      gitHead,
      gitRunner,
    ),
  });
  if (inputContract.digest !== historicalInputContract.digest)
    throw new RegistryVerificationError(
      `${workspace}: historical publication inputs differ from current source; publish the changed package first`,
    );
  const registryPackage = await fetchPublishedPackage(entry.name, version, registryRunner, fetcher);
  const cleanPackage = await buildPublishedPackage({
    targetRepositoryDirectory,
    gitHead,
    publishedSourceRoot,
    workspace,
    publicName: entry.name,
    targetDirectory: historicalRouting.targetDirectory,
    ...(bunExecutable === undefined ? {} : { bunExecutable }),
  });
  const registryManifestContract = verifyRegistryManifest(
    registryPackage.manifest,
    cleanPackage.manifest,
  );
  if (
    registryPackage.payload.digest !== cleanPackage.payload.digest ||
    JSON.stringify(registryPackage.payload.files) !== JSON.stringify(cleanPackage.payload.files)
  ) {
    throw new RegistryVerificationError(
      `${workspace}: registry payload differs from the clean build at ${gitHead}`,
    );
  }
  const snapshot: PublishedSnapshot = {
    schemaVersion: 1,
    version,
    gitHead,
    corvidaeCommit,
    source: { algorithm: 'sha256-files-v1', paths: files.map((file) => file.path), digest },
    publicationInputContract: inputContract,
    registryManifestContract,
    registryPayloadContract: registryPackage.payload,
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
    const bunExecutable = argv.includes('--bun-executable')
      ? readOption(argv, 'bun-executable')
      : undefined;
    const corvidaeRoot = new URL('../../', import.meta.url).pathname;
    const map = await loadPackageMap();
    const result = await recordSourceDigest({
      corvidaeRoot,
      workspace,
      targetRepositoryDirectory,
      publishedSourceRoot,
      mirrorCommit,
      packageMap: map,
      ...(bunExecutable === undefined ? {} : { bunExecutable }),
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
