import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCommand, type CommandRunner } from './packaging.ts';
import { canonicalManifest, objectRecord, readGitJson } from './registry-manifest.ts';
import { collectDigestedFiles, type DigestScope, type DigestedFile } from './source-digest.ts';
import { findTargetOwner, loadTargetOwnedPolicy } from './target-owned.ts';

export async function requireGit(
  directory: string,
  arguments_: string[],
  runner: CommandRunner = runCommand,
): Promise<string> {
  const result = await runner(['git', ...arguments_], { cwd: directory });
  if (result.exitCode !== 0)
    throw new Error(`git ${arguments_.join(' ')} failed in ${directory}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Validate provenance before importing executable historical policy. */
export async function verifyHistoricalCheckout(options: {
  targetRoot: string;
  gitHead: string;
  mirrorCommit: string;
  sourceRoot: string;
  target: string;
  runner?: CommandRunner;
}): Promise<string> {
  const {
    targetRoot,
    gitHead,
    mirrorCommit: mirrored,
    sourceRoot,
    target,
    runner = runCommand,
  } = options;
  // This exact SHA comes from the coordinator's verified sync result, not a target message search.
  if (!/^[a-f0-9]{40}$/.test(mirrored))
    throw new Error('An exact verified mirror commit is required');
  await requireGit(targetRoot, ['merge-base', '--is-ancestor', mirrored, gitHead], runner);
  const identity = await requireGit(
    targetRoot,
    ['show', '-s', '--format=%s%n%an%n%ae', mirrored],
    runner,
  );
  if (
    identity !==
    `Sync ${target} from corvidae\nlost-gradient-mirror-sync[bot]\n331123939+lost-gradient-mirror-sync[bot]@users.noreply.github.com`
  )
    throw new Error('Mirror commit has an unexpected sync subject or author');
  const message = await requireGit(targetRoot, ['show', '-s', '--format=%B', mirrored], runner);
  const trailer = message.match(/^Corvidae-Commit:\s*([a-f0-9]{7,40})\s*$/m)?.[1];
  if (!trailer) throw new Error('Invalid Corvidae-Commit trailer');
  const sourceCommit = await requireGit(
    sourceRoot,
    ['rev-parse', '--verify', `${trailer}^{commit}`],
    runner,
  );
  const head = await requireGit(sourceRoot, ['rev-parse', 'HEAD'], runner);
  if (head !== sourceCommit)
    throw new Error(`Historical source HEAD must equal Corvidae-Commit ${sourceCommit}`);
  if (await requireGit(sourceRoot, ['status', '--porcelain'], runner))
    throw new Error('Historical source checkout must be clean');

  const policy = await loadTargetOwnedPolicy(join(sourceRoot, 'scripts/mirror/target-owned.json'));
  const releaseManifestKeys = new Set([
    'version',
    'scripts',
    'devDependencies',
    'description',
    'keywords',
    'homepage',
    'bugs',
    'repository',
    'license',
    'author',
    'contributors',
    'funding',
    'maintainers',
    'packageManager',
  ]);
  const commits = await requireGit(
    targetRoot,
    ['rev-list', '--reverse', '--first-parent', `${mirrored}..${gitHead}`],
    runner,
  );
  for (const commit of commits.split('\n').filter(Boolean)) {
    const paths = await requireGit(
      targetRoot,
      ['diff', '--name-only', '-z', `${commit}^`, commit],
      runner,
    );
    for (const path of paths.split('\0').filter(Boolean)) {
      if (path === 'package.json' || path.endsWith('/package.json')) {
        const before = await readGitJson(targetRoot, `${commit}^`, path, runner);
        const after = await readGitJson(targetRoot, commit, path, runner);
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (releaseManifestKeys.has(key)) continue;
          if (
            JSON.stringify(
              canonicalManifest(before[key], key === 'exports' || key === 'imports'),
            ) !==
            JSON.stringify(canonicalManifest(after[key], key === 'exports' || key === 'imports'))
          )
            throw new Error(
              `Intervening commit ${commit} changes source-owned manifest field ${path}:${key}`,
            );
        }
      } else if (!findTargetOwner(policy, path, target)) {
        throw new Error(`Intervening commit ${commit} changes non-target-owned path ${path}`);
      }
    }
  }
  return sourceCommit;
}

export type HistoricalCollector = (scope: DigestScope) => Promise<DigestedFile[]>;

/** All policy comes from the validated checkout, including pre-collector revisions. */
export async function historicalCollector(
  sourceRoot: string,
  workspace: string,
): Promise<HistoricalCollector> {
  const collectorPath = join(sourceRoot, 'scripts/mirror/source-digest.ts');
  if (await Bun.file(collectorPath).exists()) {
    const module: { collectDigestedFiles?: HistoricalCollector } = await import(
      pathToFileURL(collectorPath).href
    );
    if (typeof module.collectDigestedFiles !== 'function')
      throw new Error('Historical collector is missing collectDigestedFiles');
    return module.collectDigestedFiles;
  }
  const declarations: typeof import('./source.ts') = await import(
    pathToFileURL(join(sourceRoot, 'scripts/mirror/source.ts')).href
  );
  if (
    typeof declarations.sourceTree !== 'string' ||
    typeof declarations.isSourceFile !== 'function' ||
    !declarations.additionalSourceRoots ||
    !declarations.versionConstants
  )
    throw new Error('Historical source declarations are incomplete');
  const document = objectRecord(
    await Bun.file(join(sourceRoot, 'scripts/mirror/package-surface.json')).json(),
  );
  const entry = objectRecord(objectRecord(document['packages'])[workspace]);
  const files = entry['files'];
  if (Array.isArray(files) && files.some((path) => typeof path !== 'string'))
    throw new Error('Historical files allowlist is malformed');
  const versionConstant = declarations.versionConstants[workspace];
  return (scope) =>
    collectDigestedFiles({
      ...scope,
      policy: {
        sourceTree: declarations.sourceTree,
        isSourceFile: declarations.isSourceFile,
        additionalPaths: (declarations.additionalSourceRoots[workspace] ?? []).flatMap(
          (declaration) => declaration.paths,
        ),
        ...(versionConstant === undefined ? {} : { versionConstant }),
        ...(Array.isArray(files) ? { files } : {}),
      },
    });
}
