import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { assertNothingDeferred, runInstall, type MirrorTarget } from './manifests.ts';
import { loadPackageSurface, missingBuildInputs } from './package-surface.ts';
import {
  assertSucceeded,
  assertTarballsPublishable,
  checkTarball,
  packWorkspace,
  runCommand,
  runConsumerSmokeTest,
  type SmokeTestResult,
  type TarballReport,
} from './packaging.ts';
import { collectPrunablePaths } from './source.ts';
import {
  assertPublishable,
  planSurface,
  type PrivateWorkspace,
  type PublishedPackage,
} from './surface.ts';
import {
  assertNoEmissionsIntoRetired,
  collectRetiredPaths,
  loadTargetOwnedPolicy,
  retiredDirectoriesFor,
  writeTransformOutput,
} from './target-owned.ts';

/**
 * The end-to-end mirror sync, runnable against a local bare repository so the whole pipeline can
 * be built and tested without a network, a GitHub account or a registry.
 *
 * The shape of a run is fixed by one decision: **change detection compares output, not input.**
 * Every run clones the target, transforms into the working tree, and asks git whether anything
 * differs. An empty `git status --porcelain` means skip; anything else means there is a pull
 * request to open. Diffing corvidae's own history instead would under-trigger three ways — a
 * change to the transform leaves source untouched while output differs, a shared input like the
 * root catalog affects every target and is easy to miss in a path map, and nothing about the
 * input can see a commit made directly to a mirror. Comparing output is correct regardless of
 * cause, and it catches target drift for free.
 *
 * The `Corvidae-Commit` trailer on every sync commit is provenance, and separately the authorship
 * record the foreign-commit guard reads. It is never the change-detection mechanism: a trailer is
 * state, and state written around a push that half-failed is state that lies.
 */

export class SyncError extends Error {}

/** Refusal to push over commits the mirror did not author. */
export class ForeignCommitError extends SyncError {
  readonly commits: readonly ForeignCommit[];

  constructor(commits: readonly ForeignCommit[]) {
    super(
      `The target has ${commits.length} commit(s) the mirror did not author; refusing to sync over them:\n${commits
        .map((commit) => `  ${commit.sha} ${commit.subject}`)
        .join('\n')}`,
    );
    this.name = 'ForeignCommitError';
    this.commits = commits;
  }
}

/** Refusal to build a target whose clone is missing a file the emitted build command reads. */
export class BuildInputError extends SyncError {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `The target clone is missing files the emitted build commands read:\n${missing
        .map((entry) => `  ${entry}`)
        .join(
          '\n',
        )}\nThese are target-owned build inputs that corvidae does not carry; the transform never writes them and never prunes them, so a clone without them cannot build.`,
    );
    this.name = 'BuildInputError';
    this.missing = missing;
  }
}

/** The trailer that records which corvidae commit produced a sync. */
export const provenanceTrailer = 'Corvidae-Commit';

const mirrorIdentity = {
  name: 'corvidae-mirror',
  email: 'mirror@corvidae.invalid',
} as const;

/**
 * Git environment for every command this module runs.
 *
 * The global and system configuration are neutralized so a developer's signing key, commit
 * template or hooks path cannot change what a sync produces, and the identity is supplied
 * explicitly rather than inherited: a mirror commit is authored by the mirror.
 */
export function gitEnvironment(): Record<string, string | undefined> {
  const mirrorEnvironment: Record<string, string | undefined> = {
    ...Bun.env,
    GIT_AUTHOR_NAME: mirrorIdentity.name,
    GIT_AUTHOR_EMAIL: mirrorIdentity.email,
    GIT_COMMITTER_NAME: mirrorIdentity.name,
    GIT_COMMITTER_EMAIL: mirrorIdentity.email,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  return mirrorEnvironment;
}

/** Run one git command, returning its result rather than throwing on a non-zero exit. */
export async function tryGit(
  directory: string,
  ...arguments_: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runCommand(['git', ...arguments_], { cwd: directory, env: gitEnvironment() });
}

/** Run one git command, throwing `SyncError` with both streams when it fails. */
export async function git(directory: string, ...arguments_: string[]): Promise<string> {
  const result = await tryGit(directory, ...arguments_);
  if (result.exitCode !== 0) {
    throw new SyncError(
      `git ${arguments_.join(' ')} failed in ${directory} (exit ${result.exitCode}):\n${result.stderr}${result.stdout}`,
    );
  }
  return result.stdout;
}

export interface CloneOptions {
  /** A path or URL. A local bare repository is what keeps a run offline. */
  remote: string;
  directory: string;
  branch?: string | undefined;
}

/** Clone the target into a working tree the transform can write into. */
export async function cloneTarget({ remote, directory, branch }: CloneOptions): Promise<string> {
  await mkdir(directory, { recursive: true });
  await git(
    directory,
    'clone',
    ...(branch ? ['--branch', branch] : []),
    '--quiet',
    remote,
    directory,
  );
  return directory;
}

export interface ForeignCommit {
  sha: string;
  subject: string;
}

// ASCII unit and record separators: byte values no commit subject or trailer can contain,
// written as character codes because a literal control byte in the source is unreadable.
const unitSeparator = String.fromCharCode(31);
const recordSeparator = String.fromCharCode(30);

interface CommitRecord extends ForeignCommit {
  provenance: string;
}

/** Every commit reachable from HEAD, newest first, with its provenance trailer. */
async function readHistory(directory: string): Promise<CommitRecord[]> {
  const head = await tryGit(directory, 'rev-parse', '--verify', 'HEAD');
  // An empty target has no HEAD to walk, which is a first sync rather than a failure.
  if (head.exitCode !== 0) return [];
  const format = `%H${unitSeparator}%s${unitSeparator}%(trailers:key=${provenanceTrailer},valueonly,separator=%x2C)${recordSeparator}`;
  const log = await git(directory, 'log', `--format=${format}`);
  return log
    .split(recordSeparator)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = '', subject = '', provenance = ''] = record.split(unitSeparator);
      return { sha, subject, provenance: provenance.trim() };
    });
}

/**
 * Commits the mirror did not author, newest first.
 *
 * Authorship is the presence of the provenance trailer, not the commit's author field, because
 * the author field is trivially settable by anyone committing to the target. Three cases: no
 * trailered commit anywhere means the mirror has never written here, so the target's whole
 * history is its own and a first sync is permitted; a trailered commit at HEAD means the mirror
 * wrote last and there is nothing foreign; otherwise everything after the newest trailered commit
 * arrived from somewhere else.
 *
 * A push that half-fails cannot make this lie. The clone is disposable, so a trailer only ever
 * becomes visible to a later run once the push carrying it succeeded. A commit made locally and
 * never pushed is discarded with the clone, and the next run re-derives the same output from
 * scratch.
 */
export async function findForeignCommits(directory: string): Promise<ForeignCommit[]> {
  const history = await readHistory(directory);
  const newestMirrored = history.findIndex((commit) => commit.provenance.length > 0);
  if (newestMirrored === -1) return [];
  return history.slice(0, newestMirrored).map(({ sha, subject }) => ({ sha, subject }));
}

/** Throws `ForeignCommitError` naming every commit the mirror did not author. */
export async function assertNoForeignCommits(directory: string): Promise<void> {
  const foreign = await findForeignCommits(directory);
  if (foreign.length > 0) throw new ForeignCommitError(foreign);
}

/**
 * Every `requiredInputs` entry the clone does not have, named as `package: file`.
 *
 * `package-surface.json` records these because corvidae carries none of them: the emitted `build`
 * script points at `scripts/build.ts`, `tsdown.config.ts` or `vite.config.ts`, all of which exist
 * only in the public repositories. That premise still holds now that the transform deletes, but
 * for a narrower reason than "the transform never prunes": it prunes only the paths it owns,
 * which are the source trees it emits, and a build input sits at the package root outside every
 * one of them. It is target-owned, and a target-owned path is never pruned. What was never
 * checked is whether the clone actually has one, so a clone missing it produced a manifest whose
 * build command could not run and the sync said nothing. This is that check, and it is a hard
 * failure: a build step quietly skipped is worse than a sync that stops.
 */
export function collectMissingBuildInputs(
  clone: string,
  published: readonly PublishedPackage[],
): string[] {
  return published.flatMap((entry) =>
    missingBuildInputs(entry.entry, join(clone, entry.directory)).map(
      (input) => `${entry.publicName}: ${entry.directory}/${input}`,
    ),
  );
}

/** Throws `BuildInputError` naming every missing build input. */
export function assertBuildInputsPresent(
  clone: string,
  published: readonly PublishedPackage[],
): void {
  const missing = collectMissingBuildInputs(clone, published);
  if (missing.length > 0) throw new BuildInputError(missing);
}

export interface StageOptions {
  corvidaeRoot: string;
  target: MirrorTarget;
  /** A clone of the target, already checked out. */
  directory: string;
  /** Extra `bun install` arguments for the lockfile-regenerating install. */
  installArguments?: readonly string[] | undefined;
}

export interface StageOutcome {
  plan: Awaited<ReturnType<typeof planSurface>>;
  written: string[];
  /** Target paths removed because corvidae no longer carries them. */
  deleted: string[];
  /** Target paths removed because `target-owned.json` retires the directory holding them. */
  retired: string[];
}

/**
 * Plan the target, clear both gates, write, and regenerate the lockfile.
 *
 * The order is load-bearing. `assertNothingDeferred` and `assertPublishable` run before anything
 * is written, so a target that would narrow a published surface, ship an exports entry with no
 * source, or receive a workspace nobody has placed is refused while the clone is still
 * byte-identical. The deletions are computed before the write as well, from the clone as it
 * arrived: a file corvidae dropped is a file the target loses, and the set is the target's own
 * source tree minus what this plan emits. The build-input check runs after the write because it
 * reads the clone, and the lockfile install runs last because `bun.lock` is target-owned: the
 * transform never writes one, it is produced by installing the manifests that were just written.
 *
 * The retirement is the second, narrower source of deletions and the only one not bounded by what
 * the plan emits. It removes a whole directory the target still carries, so it is read from
 * `target-owned.json`'s `retired` enumeration and never from the plan's silence — and it is
 * computed here, beside the prune, so both sets clear the same guard in the same call and a
 * refusal of either leaves the clone byte-identical. `assertNoEmissionsIntoRetired` runs first
 * because writes precede deletions downstream: a plan that emitted into a retired directory would
 * otherwise write a file and remove it in the same pass.
 */
export async function stageSurface({
  corvidaeRoot,
  target,
  directory,
  installArguments,
}: StageOptions): Promise<StageOutcome> {
  const policy = await loadTargetOwnedPolicy();
  const plan = await planSurface({ corvidaeRoot, target, targetDirectory: directory, policy });
  const surface = await loadPackageSurface();
  assertNothingDeferred(plan);
  assertPublishable(plan, surface.packages);
  assertNoEmissionsIntoRetired(policy, target, Object.keys(plan.files));
  const pruned = await collectPrunablePaths(directory, plan.source, Object.keys(plan.files));
  const retired = await collectRetiredPaths({
    policy,
    target,
    directory,
    directories: retiredDirectoriesFor(policy, target),
  });
  const deletions = [...new Set([...pruned, ...retired])].toSorted();
  const { written, deleted } = await writeTransformOutput({
    policy,
    target,
    directory,
    files: plan.files,
    deletions,
    executable: plan.source.executable,
  });
  assertBuildInputsPresent(directory, plan.published);
  await runInstall(directory, installArguments ?? []);
  return { plan, written, deleted, retired };
}

export interface VerifyOptions {
  /** The checkout whose devDependencies supply publint and attw; defaults to this one. */
  toolsRoot?: string | undefined;
  /** The staged clone. */
  directory: string;
  published: readonly PublishedPackage[];
  /** The workspaces this target receives but never publishes. Their source ships, so it is checked. */
  privateWorkspaces?: readonly PrivateWorkspace[] | undefined;
  /** Where tarballs and the consumer project go; outside the clone, so git never sees them. */
  scratchDirectory: string;
  installArguments?: readonly string[] | undefined;
}

export interface VerifyResult {
  reports: TarballReport[];
  smokeTest: SmokeTestResult;
  /** Private workspaces whose emitted source was type-checked, by public name. */
  privateTypechecks: string[];
}

/**
 * Refuse a target whose private workspaces ship TypeScript that nothing would check.
 *
 * A private workspace is never packed, so the packaging checks say nothing about it; `typecheck`
 * is the only thing that reads its source at all. Skipping one whose manifest happens to omit the
 * script would be a silent hole, and the hole would be invisible because the sync would pass.
 * Checked over the whole set before any of them runs, so the message names every offender.
 */
export function assertPrivateWorkspacesCheckable(
  privateWorkspaces: readonly PrivateWorkspace[],
): void {
  const unchecked = privateWorkspaces.filter((entry) => entry.emitsTypeScript && !entry.typechecks);
  if (unchecked.length > 0) {
    throw new SyncError(
      `These workspaces emit TypeScript the mirror would publish without checking it, because their manifests declare no typecheck script:\n${unchecked
        .map((entry) => `  ${entry.publicName} (${entry.directory})`)
        .join('\n')}`,
    );
  }
}

/**
 * Build, type-check, pack and inspect every package the target publishes.
 *
 * Each command runs in its own package directory rather than at the clone root. It used to be
 * that the root manifest carried no scripts at all, so there was no aggregate `build` to call;
 * since COR-1223 a target that already has a root manifest keeps its own scripts, and weft's root
 * does define `build`, `test` and `typecheck` as `turbo run` fan-outs. The per-package loop stays
 * anyway, for the reason it was written: a root fan-out would verify whatever the target's task
 * graph happens to include, which is the target's decision, whereas this loop verifies exactly
 * the packages this plan emits. Root tooling for a target that has none is still the class
 * `target-owned.json` records as unresolved. COR-1221 extended the loop instead: an emitted
 * private workspace is type-checked too. Nothing packs or publishes one, but its source ships to
 * the mirror now, and source nothing checks is source the mirror publishes blind.
 * `bun install --frozen-lockfile` at the root comes first and is a check in its own right: it
 * fails if the lockfile the staging install just produced does not satisfy the manifests the
 * transform just wrote.
 */
export async function verifyTarget({
  toolsRoot,
  directory,
  published,
  privateWorkspaces = [],
  scratchDirectory,
  installArguments = [],
}: VerifyOptions): Promise<VerifyResult> {
  // `--ignore-scripts` for the same reason the staging install uses it: both real targets
  // preserve a `prepare` hook running husky, and letting it install hooks here would arm a
  // pre-commit that fires on the sync's own commit, against a root manifest with no scripts.
  assertSucceeded(
    await runCommand(
      ['bun', 'install', '--frozen-lockfile', '--ignore-scripts', ...installArguments],
      { cwd: directory },
    ),
    'verifying the staged lockfile satisfies the emitted manifests',
  );

  const reports: TarballReport[] = [];
  const tarballs = join(scratchDirectory, 'tarballs');
  for (const entry of published) {
    const packageDirectory = join(directory, entry.directory);
    for (const script of ['build', 'typecheck'] as const) {
      assertSucceeded(
        await runCommand(['bun', 'run', script], { cwd: packageDirectory }),
        `running ${script} for ${entry.publicName}`,
      );
    }
    const tarball = await packWorkspace({ packageDirectory, destination: tarballs });
    reports.push(await checkTarball(entry.publicName, tarball, toolsRoot));
  }
  assertTarballsPublishable(reports);

  assertPrivateWorkspacesCheckable(privateWorkspaces);
  const privateTypechecks: string[] = [];
  for (const entry of privateWorkspaces) {
    // A workspace that emits no TypeScript has nothing for `tsc` to read: the shared configuration
    // package is three JSON files. Every other one was just checked to declare the script.
    if (!entry.emitsTypeScript) continue;
    assertSucceeded(
      await runCommand(['bun', 'run', 'typecheck'], { cwd: join(directory, entry.directory) }),
      `running typecheck for ${entry.publicName}`,
    );
    privateTypechecks.push(entry.publicName);
  }

  const smokeTest = await runConsumerSmokeTest({
    directory: scratchDirectory,
    packages: published.map((entry, index) => ({
      publicName: entry.publicName,
      tarball: reports[index]?.tarball ?? '',
      exports: entry.exports,
    })),
    installArguments,
  });
  return { reports, smokeTest, privateTypechecks };
}

export type SyncDecision = 'skip' | 'pushed';

export interface SyncOptions {
  corvidaeRoot: string;
  target: MirrorTarget;
  /** Path or URL of the target remote. A local bare repository keeps the run offline. */
  remote: string;
  /** Where the clone is made. Disposable: nothing is carried between runs. */
  directory: string;
  /** Where tarballs and the consumer project go, outside the clone. */
  scratchDirectory: string;
  /** The corvidae commit this sync transforms, recorded in the provenance trailer. */
  corvidaeCommit: string;
  branch?: string | undefined;
  installArguments?: readonly string[] | undefined;
  /** The checkout whose devDependencies supply publint and attw; defaults to this one. */
  toolsRoot?: string | undefined;
}

export interface SyncResult {
  decision: SyncDecision;
  target: MirrorTarget;
  directory: string;
  /** `git status --porcelain` lines, empty on a skip. */
  changed: string[];
  /** The sync commit, present only when something changed. */
  commit?: string;
  firstPublish: string[];
  /** COR-1229: public names seeded from `package-map.json`'s `lastPublishedVersion`, not `0.0.0`. */
  seededFromPackageMap: string[];
  verification: VerifyResult;
}

/**
 * One complete sync: clone, transform, decide, verify, and push when there is something to push.
 *
 * Change detection is captured immediately after the staging install and before anything is
 * built, so no build output, tarball or installed dependency can contaminate the answer. The
 * verification then runs on every sync, including one that will skip, because a target that
 * stopped building without its output changing is exactly the drift this pipeline exists to
 * notice.
 */
export async function runSync(options: SyncOptions): Promise<SyncResult> {
  const clone = await cloneTarget({
    remote: options.remote,
    directory: options.directory,
    branch: options.branch,
  });
  await assertNoForeignCommits(clone);

  const { plan } = await stageSurface({
    corvidaeRoot: options.corvidaeRoot,
    target: options.target,
    directory: clone,
    installArguments: options.installArguments,
  });

  const porcelain = await git(clone, 'status', '--porcelain');
  const changed = porcelain.split('\n').filter((line) => line.length > 0);
  // Staged before anything is built, so the commit can only contain what the transform and the
  // lockfile install changed. Staging afterwards would sweep build output — `dist/`, a
  // `tsconfig.tsbuildinfo`, a coverage directory — into the mirror whenever the target's
  // `.gitignore` did not happen to cover it.
  //
  // `--all` is what carries the transform's deletions: a source file corvidae dropped is removed
  // from the working tree by the staging step above, and only `--all` stages a removal. It was
  // incidental while the transform only ever wrote; it is load-bearing now.
  if (changed.length > 0) await git(clone, 'add', '--all');

  const verification = await verifyTarget({
    toolsRoot: options.toolsRoot,
    directory: clone,
    published: plan.published,
    privateWorkspaces: plan.privateWorkspaces,
    scratchDirectory: options.scratchDirectory,
    installArguments: options.installArguments,
  });

  if (changed.length === 0) {
    return {
      decision: 'skip',
      target: options.target,
      directory: clone,
      changed,
      firstPublish: plan.firstPublish,
      seededFromPackageMap: plan.seededFromPackageMap,
      verification,
    };
  }

  await git(
    clone,
    'commit',
    '--quiet',
    '--message',
    `Sync ${options.target} from corvidae\n\n${provenanceTrailer}: ${options.corvidaeCommit}`,
  );
  const head = await git(clone, 'rev-parse', 'HEAD');
  const commit = head.trim();
  await git(clone, 'push', 'origin', 'HEAD');

  return {
    decision: 'pushed',
    target: options.target,
    directory: clone,
    changed,
    commit,
    firstPublish: plan.firstPublish,
    seededFromPackageMap: plan.seededFromPackageMap,
    verification,
  };
}

function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function required(argv: readonly string[], name: string): string {
  const value = readOption(argv, name);
  if (!value) throw new SyncError(`Missing required option --${name}`);
  return value;
}

export async function runSyncCommand(argv: readonly string[]): Promise<number> {
  try {
    const target = required(argv, 'target');
    if (target !== 'weft' && target !== 'cinder') {
      throw new SyncError(`Unknown --target "${target}"; expected weft or cinder`);
    }
    const result = await runSync({
      corvidaeRoot:
        readOption(argv, 'corvidae-root') ?? new URL('../../', import.meta.url).pathname,
      target,
      remote: required(argv, 'remote'),
      directory: required(argv, 'directory'),
      scratchDirectory: required(argv, 'scratch'),
      corvidaeCommit: required(argv, 'corvidae-commit'),
      branch: readOption(argv, 'branch'),
    });
    process.stdout.write(
      result.decision === 'skip'
        ? `${target}: no change, skipping\n`
        : `${target}: pushed ${result.commit} with ${result.changed.length} changed path(s)\n`,
    );
    if (result.seededFromPackageMap.length > 0) {
      process.stdout.write(
        `${target}: seeded from package-map.json's lastPublishedVersion, target has no manifest yet: ${result.seededFromPackageMap.join(', ')}\n`,
      );
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await runSyncCommand(Bun.argv.slice(2)));
