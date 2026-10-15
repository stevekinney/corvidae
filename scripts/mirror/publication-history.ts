import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCommand, type CommandRunner } from './packaging.ts';
import { canonicalManifest, objectRecord, readGitJson } from './registry-manifest.ts';
import { collectDigestedFiles, type DigestScope, type DigestedFile } from './source-digest.ts';
import { isSafeVersionConstant } from './source.ts';
import type { ForeignCommitOwnership } from './sync.ts';
import { findTargetOwner, loadTargetOwnedPolicy } from './target-owned.ts';
import { transformReaches } from './transform-reach.ts';

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

async function isAncestor(
  directory: string,
  ancestor: string,
  descendant: string,
  runner: CommandRunner,
): Promise<boolean> {
  const result = await runner(['git', 'merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: directory,
  });
  if (result.exitCode > 1)
    throw new Error(
      `git merge-base --is-ancestor ${ancestor} ${descendant} failed in ${directory}: ${result.stderr}`,
    );
  return result.exitCode === 0;
}

/**
 * Validate provenance before importing executable historical policy, then require every target
 * commit between the merged sync and the release's `gitHead` to change only paths that were the
 * target's own.
 *
 * A changed path is accepted when it is a `package.json` whose changed keys are all release keys,
 * the declared version constant changed only to the manifest's version, a pending changeset, or
 * target-owned under the historical `target-owned.json`. COR-1192 and the owner's ruling of
 * 2026-10-15 add the sync guard's own rule (`blockingDeltaChanges` in `sync.ts`): a path is also
 * the target's own when it is a declared build input, or lies outside everything the sync writes,
 * prunes or retires, such as release tooling the transform neither emits nor prunes. Reach comes
 * from the transform the HISTORICAL source plans for this target (`foreignCommitOwnership`,
 * imported from `sourceRoot`), so the decision uses the transform that sync actually ran.
 *
 * The guard's one further exception is deliberately not mirrored: it accepts an emitted file
 * modified to exactly the bytes the trusted source emits now, because the source already carries
 * that change. Here the trusted source is the historical checkout at the sync's `Corvidae-Commit`,
 * which cannot carry a later target edit, so such an edit would be published bytes the recorded
 * source does not produce. Every emitted or pruned path therefore stays refused.
 */
export async function verifyHistoricalCheckout(options: {
  targetRoot: string;
  gitHead: string;
  mirrorCommit: string;
  mergedMirrorCommit?: string;
  sourceRoot: string;
  target: string;
  workspace: string;
  targetDirectory: string;
  runner?: CommandRunner;
}): Promise<string> {
  const {
    targetRoot,
    gitHead,
    mirrorCommit: mirrored,
    mergedMirrorCommit,
    sourceRoot,
    target,
    workspace,
    targetDirectory,
    runner = runCommand,
  } = options;
  // This exact SHA comes from the coordinator's verified sync result, not a target message search.
  if (!/^[a-f0-9]{40}$/.test(mirrored))
    throw new Error('An exact verified mirror commit is required');
  const lineageStart = mergedMirrorCommit ?? mirrored;
  if (!/^[a-f0-9]{40}$/.test(lineageStart))
    throw new Error('An exact verified merged mirror commit is required');
  if (!(await isAncestor(targetRoot, lineageStart, gitHead, runner)))
    throw new Error(`Mirror commit ${lineageStart} is not an ancestor of ${gitHead}`);
  const identity = await requireGit(
    targetRoot,
    ['show', '-s', '--format=%s%n%an%n%ae', mirrored],
    runner,
  );
  const [subject, author, email] = identity.split('\n');
  const expectedSubject = `Sync ${target} from corvidae`;
  const squashSubject = subject?.match(/^(.*) \(#[1-9]\d*\)$/)?.[1];
  if (
    (subject !== expectedSubject && squashSubject !== expectedSubject) ||
    author !== 'lost-gradient-mirror-sync[bot]' ||
    email !== '331123939+lost-gradient-mirror-sync[bot]@users.noreply.github.com'
  )
    throw new Error('Mirror commit has an unexpected sync subject or author');
  const message = await requireGit(targetRoot, ['show', '-s', '--format=%B', mirrored], runner);
  const trailer = message.match(/^Corvidae-Commit:\s*([a-f0-9]{7,40})\s*$/m)?.[1];
  if (!trailer) throw new Error('Invalid Corvidae-Commit trailer');
  if (mergedMirrorCommit !== undefined) {
    const mergedSubject = await requireGit(
      targetRoot,
      ['show', '-s', '--format=%s', mergedMirrorCommit],
      runner,
    );
    if (mergedSubject.match(/^(.*) \(#[1-9]\d*\)$/)?.[1] !== expectedSubject)
      throw new Error('Merged mirror commit has an unexpected squash subject');
    const [appParents, mergedParents, appTree, mergedTree] = await Promise.all([
      requireGit(targetRoot, ['show', '-s', '--format=%P', mirrored], runner),
      requireGit(targetRoot, ['show', '-s', '--format=%P', mergedMirrorCommit], runner),
      requireGit(targetRoot, ['rev-parse', `${mirrored}^{tree}`], runner),
      requireGit(targetRoot, ['rev-parse', `${mergedMirrorCommit}^{tree}`], runner),
    ]);
    if (
      appParents.split(' ').length !== 1 ||
      mergedParents.split(' ').length !== 1 ||
      appParents !== mergedParents
    )
      throw new Error('Squash merge must share the App sync commit parent');
    if (appTree !== mergedTree) throw new Error('Squash tree differs from the App sync commit');
  }
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

  const sourceDeclarations = (await import(
    pathToFileURL(join(sourceRoot, 'scripts/mirror/source.ts')).href
  )) as typeof import('./source.ts');
  const declaredVersionPath = sourceDeclarations.versionConstants[workspace];
  const versionConstantPath =
    declaredVersionPath === undefined ? undefined : `${targetDirectory}/${declaredVersionPath}`;

  const policy = await loadTargetOwnedPolicy(join(sourceRoot, 'scripts/mirror/target-owned.json'));
  const releaseManifestKeys = new Set([
    'version',
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
  ]);
  let ownership: Promise<ForeignCommitOwnership> | undefined;
  // Loaded on first need: most histories are explained by the cheaper rules above.
  const historicalOwnership = (): Promise<ForeignCommitOwnership> => {
    ownership ??= loadHistoricalOwnership({
      sourceRoot,
      target,
      targetRoot,
      mirrored,
      sourceCommit,
    });
    return ownership;
  };
  const commits = await requireGit(
    targetRoot,
    ['rev-list', '--reverse', '--ancestry-path', `${lineageStart}..${gitHead}`],
    runner,
  );
  for (const commit of commits.split('\n').filter(Boolean)) {
    const parentList = await requireGit(targetRoot, ['show', '-s', '--format=%P', commit], runner);
    const parents = parentList.split(' ').filter(Boolean);
    const certifiedParents = [];
    for (const parent of parents) {
      if (await isAncestor(targetRoot, lineageStart, parent, runner)) certifiedParents.push(parent);
    }
    if (certifiedParents.length === 0)
      throw new Error(`Intervening commit ${commit} has no certified parent after ${lineageStart}`);
    for (const parent of certifiedParents) {
      const paths = await requireGit(
        targetRoot,
        ['diff', '--name-only', '-z', parent, commit],
        runner,
      );
      for (const path of paths.split('\0').filter(Boolean)) {
        if (path === 'package.json' || path.endsWith('/package.json')) {
          const before = await readGitJson(targetRoot, parent, path, runner);
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
        } else if (
          path === versionConstantPath &&
          (await isManifestVersionOnlyChange(
            targetRoot,
            parent,
            commit,
            path,
            targetDirectory,
            runner,
          ))
        ) {
          continue;
        } else if (isPendingChangesetPath(path)) {
          // COR-1433: a sync delivers corvidae's changesets and a Version Packages commit consumes
          // them. Neither touches source, and the history policy cannot name the paths because
          // it is whatever the historical checkout carried.
          continue;
        } else if (!findTargetOwner(policy, path, target)) {
          const { targetOwnedFiles, transform } = await historicalOwnership();
          if (targetOwnedFiles?.has(path) || !transformReaches(transform, path)) continue;
          throw new Error(`Intervening commit ${commit} changes non-target-owned path ${path}`);
        }
      }
    }
  }
  return sourceCommit;
}

/**
 * What the historical sync would write, prune or retire for this target, computed by the
 * historical source's own `foreignCommitOwnership` against the target clone.
 */
async function loadHistoricalOwnership(options: {
  sourceRoot: string;
  target: string;
  targetRoot: string;
  mirrored: string;
  sourceCommit: string;
}): Promise<ForeignCommitOwnership> {
  const path = join(options.sourceRoot, 'scripts/mirror/sync.ts');
  let module: { foreignCommitOwnership?: unknown };
  try {
    module = (await import(pathToFileURL(path).href)) as { foreignCommitOwnership?: unknown };
  } catch (error) {
    throw new Error(`Historical transform could not be loaded from ${path}`, { cause: error });
  }
  if (typeof module.foreignCommitOwnership !== 'function')
    throw new Error(`Historical transform ${path} does not export foreignCommitOwnership`);
  return (
    module.foreignCommitOwnership as (options: {
      corvidaeRoot: string;
      target: string;
      clone: string;
      provenance: { commit: string; trailerSha: string };
    }) => Promise<ForeignCommitOwnership>
  )({
    corvidaeRoot: options.sourceRoot,
    target: options.target,
    clone: options.targetRoot,
    provenance: { commit: options.mirrored, trailerSha: options.sourceCommit },
  });
}

/** A target-root `.changeset/<name>.md` other than the README. */
function isPendingChangesetPath(path: string): boolean {
  return /^\.changeset\/[^/]+\.md$/.test(path) && path !== '.changeset/README.md';
}

export async function isManifestVersionOnlyChange(
  targetRoot: string,
  parent: string,
  commit: string,
  path: string,
  targetDirectory: string,
  runner: CommandRunner,
): Promise<boolean> {
  const manifestPath = `${targetDirectory}/package.json`;
  const beforeManifest = await readGitJson(targetRoot, parent, manifestPath, runner);
  const afterManifest = await readGitJson(targetRoot, commit, manifestPath, runner);
  if (
    typeof beforeManifest['version'] !== 'string' ||
    typeof afterManifest['version'] !== 'string' ||
    !isSafeVersionConstant(beforeManifest['version']) ||
    !isSafeVersionConstant(afterManifest['version'])
  )
    return false;
  const [beforeTree, afterTree] = await Promise.all([
    requireGit(targetRoot, ['ls-tree', parent, '--', path], runner),
    requireGit(targetRoot, ['ls-tree', commit, '--', path], runner),
  ]);
  if (!beforeTree.startsWith('100644 blob ') || !afterTree.startsWith('100644 blob ')) return false;
  const before = await runner(['git', 'show', `${parent}:${path}`], { cwd: targetRoot });
  const after = await runner(['git', 'show', `${commit}:${path}`], { cwd: targetRoot });
  if (before.exitCode !== 0 || after.exitCode !== 0) return false;
  const versionShape = /^([\s\S]*?)export const VERSION = '([^']*)';\n$/;
  const match = versionShape.exec(before.stdout);
  return (
    match !== null &&
    match[2] === beforeManifest['version'] &&
    after.stdout === `${match[1]}export const VERSION = '${afterManifest['version']}';\n`
  );
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
