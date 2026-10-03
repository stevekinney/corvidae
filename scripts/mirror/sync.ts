import { mkdir, rm } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

import { pushVerifiedCommit } from './authenticated-push.ts';
import { createGitHubApi, userTokenFromEnvironmentOrCli } from './github-api.ts';
import { assertInstallParity, readWorkflowInstalls, type InstallParity } from './install-parity.ts';
import { layoutFor } from './layout-map.ts';
import { assertNothingDeferred, runInstall } from './manifests.ts';
import { loadPackageSurface, missingBuildInputs } from './package-surface.ts';
import {
  assertSucceeded,
  assertTarballsPublishable,
  childProcessEnvironment,
  defaultToolsRoot,
  PackagingError,
  runCommand,
  type SmokeTestResult,
  type TarballReport,
} from './packaging.ts';
import { isManifestVersionOnlyChange } from './publication-history.ts';
import { collectPrunablePaths, versionConstants } from './source.ts';
import {
  assertPublishable,
  planSurface,
  type PrivateWorkspace,
  type PublishedPackage,
} from './surface.ts';
import { mirrorTargets, targetFor, type MirrorTarget } from './target-definitions.ts';
import {
  assertNoEmissionsIntoRetired,
  collectRetiredPaths,
  findTargetOwner,
  loadTargetOwnedPolicy,
  retiredDirectoriesFor,
  writeTransformOutput,
  type TargetOwnedPolicy,
} from './target-owned.ts';
import { buildVerifySteps, createLocalVerifyEnvironment, specifiersFor } from './verify-steps.ts';

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

export async function directPushEnvironment(
  remote: string,
  provider?: () => Promise<Record<string, string>>,
): Promise<Record<string, string>> {
  if (isAbsolute(remote)) return {};
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    throw new SyncError('Direct push requires an absolute local path or an HTTPS GitHub remote');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password
  )
    throw new SyncError('Direct push only supports GitHub HTTPS remotes without URL credentials');
  if (provider === undefined)
    throw new SyncError('Direct GitHub push requires a trusted account credential provider');
  return provider();
}

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

/**
 * The identity every mirror commit carries: the mirror App's own bot account, in the form GitHub
 * links to it (`<id>+<login>@users.noreply.github.com`). An invalid-domain placeholder was used
 * here first, and the first real sync (stevekinney/weft pull request 984) showed why it cannot
 * be: a commit GitHub can attribute to no account is an "unattributed change" under the target's
 * ruleset, which then demands an approving review the repository's sole human cannot give to a
 * pull request they opened. Attributed to the App, the commit is the App's, which is the truth.
 */
const mirrorIdentity = {
  name: 'lost-gradient-mirror-sync[bot]',
  email: '331123939+lost-gradient-mirror-sync[bot]@users.noreply.github.com',
} as const;

/**
 * Git environment for every command this module runs.
 *
 * The global and system configuration are neutralized so a developer's signing key, commit
 * template or hooks path cannot change what a sync produces, and the identity is supplied
 * explicitly rather than inherited: a mirror commit is authored by the mirror.
 *
 * `core.hooksPath` needs its own neutralization because husky writes it into the clone's **local**
 * configuration, which `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` do not reach. It is injected
 * through `GIT_CONFIG_COUNT` rather than passed as `-c` on one command so it covers every git
 * invocation this module makes: weft's checked-in hooks are `pre-commit`, `post-checkout` and
 * `post-merge` today, but the hook set is target-owned and a `pre-push` added upstream would
 * otherwise fire on the sync's push with nothing here to notice. This replaces `--ignore-scripts`
 * as the mechanism keeping the target's hooks out of the sync's way — that flag was suppressing
 * dependency build steps as a side effect (COR-1278), which is far too much collateral for a
 * problem that git configuration addresses directly.
 */
export function gitEnvironment(
  environment: Record<string, string | undefined> = Bun.env,
): Record<string, string | undefined> {
  // Appended to whatever `GIT_CONFIG_COUNT` the caller already set rather than assuming index 0
  // is free. Nothing sets those variables today, so hardcoding `COUNT=1` would work and would
  // keep working right up until something did, at which point it would silently drop that entry
  // and overwrite its key — the quiet kind of defect that only appears in an environment nobody
  // tested. Taking the environment as a parameter is `github-app.ts`'s convention for the same
  // reason it is here: a named read belongs to a registered environment boundary, and threading
  // the map through keeps this one testable without process-wide mutation.
  const inheritedCount = Number.parseInt(environment['GIT_CONFIG_COUNT'] ?? '', 10);
  const nextIndex = Number.isInteger(inheritedCount) && inheritedCount > 0 ? inheritedCount : 0;

  const mirrorEnvironment: Record<string, string | undefined> = {
    ...childProcessEnvironment(environment),
    GIT_AUTHOR_NAME: mirrorIdentity.name,
    GIT_AUTHOR_EMAIL: mirrorIdentity.email,
    GIT_COMMITTER_NAME: mirrorIdentity.name,
    GIT_COMMITTER_EMAIL: mirrorIdentity.email,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_COUNT: String(nextIndex + 1),
    [`GIT_CONFIG_KEY_${nextIndex}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${nextIndex}`]: '/dev/null',
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

/**
 * Compose `gitEnvironment` with a git credential environment (`GitHubApi`'s `pushEnvironment` or
 * `accountPushEnvironment` in `github-api.ts`), so the credential's own `GIT_CONFIG_COUNT` cannot
 * clobber the hook neutralization `gitEnvironment` appends.
 *
 * The two functions each produce a self-contained `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/
 * `GIT_CONFIG_VALUE_0` triple, because neither knows about the other. Spreading the credential
 * over an already-built `gitEnvironment()` result — `{ ...gitEnvironment(), ...credential }`,
 * which is what this replaced — overwrites index 0 and the count wholesale, silently discarding
 * the `core.hooksPath` entry `gitEnvironment` appended there and leaving a push made under this
 * environment able to run whatever `pre-push` hook a target committed, exactly the class of thing
 * `gitEnvironment`'s own docstring warns a hooks-path change would otherwise miss. Merging the
 * credential into the *base* environment first and calling `gitEnvironment` on the result is the
 * fix: `gitEnvironment` reads the inherited count off its own `environment` parameter and appends
 * after it, so the credential lands at index 0 and hooksPath lands at index 1, and git sees both.
 */
export function credentialedGitEnvironment(
  credential: Record<string, string>,
  environment: Record<string, string | undefined> = Bun.env,
): Record<string, string | undefined> {
  return gitEnvironment({ ...environment, ...credential });
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
    '--no-local',
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

/** GitHub squash merges append co-author metadata after the App's provenance paragraph. */
function squashMergeProvenance(message: string): string {
  const paragraphs = message.trimEnd().split(/\n\s*\n/);
  const finalParagraph = paragraphs.at(-1) ?? '';
  if (!finalParagraph.split('\n').every((line) => /^Co-authored-by: .+$/i.test(line))) return '';
  const provenance = paragraphs.at(-2)?.match(/^Corvidae-Commit: ([0-9a-f]{40})$/);
  return provenance?.[1] ?? '';
}

/** Every commit reachable from HEAD, newest first, with its provenance trailer. */
async function readHistory(directory: string): Promise<CommitRecord[]> {
  const head = await tryGit(directory, 'rev-parse', '--verify', 'HEAD');
  // An empty target has no HEAD to walk, which is a first sync rather than a failure.
  if (head.exitCode !== 0) return [];
  const format = `%H${unitSeparator}%s${unitSeparator}%(trailers:key=${provenanceTrailer},valueonly,separator=%x2C)${unitSeparator}%B${recordSeparator}`;
  const log = await git(directory, 'log', '--topo-order', `--format=${format}`);
  return log
    .split(recordSeparator)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = '', subject = '', trailer = '', message = ''] = record.split(unitSeparator);
      return { sha, subject, provenance: trailer.trim() || squashMergeProvenance(message) };
    });
}

/** Recover provenance when GitHub's squash button omitted the App's trailer entirely. */
async function pullRequestSquashProvenance(
  directory: string,
  { sha, subject }: CommitRecord,
  target: string,
): Promise<string> {
  const prefix = `Sync ${target} from corvidae (#`;
  if (!subject.startsWith(prefix) || !subject.endsWith(')')) return '';
  const number = subject.slice(prefix.length, -1);
  if (!/^[1-9][0-9]*$/.test(number)) return '';

  // The remote pull-request ref supplies the original App commit. Matching the complete tree
  // proves that GitHub's untrailered squash has exactly the bytes the App proposed; a subject
  // alone, an author name, or a similar-looking diff would not establish that ownership.
  const fetched = await tryGit(
    directory,
    'fetch',
    '--quiet',
    '--no-tags',
    'origin',
    `refs/pull/${number}/head`,
  );
  if (fetched.exitCode !== 0) return '';
  const originalSubjectOutput = await git(directory, 'log', '-1', '--format=%s', 'FETCH_HEAD');
  const originalSubject = originalSubjectOutput.trim();
  if (originalSubject !== `Sync ${target} from corvidae`) return '';
  const originalTreeOutput = await git(directory, 'rev-parse', 'FETCH_HEAD^{tree}');
  const squashTreeOutput = await git(directory, 'rev-parse', `${sha}^{tree}`);
  const originalTree = originalTreeOutput.trim();
  const squashTree = squashTreeOutput.trim();
  if (originalTree !== squashTree) return '';
  const trailerOutput = await git(
    directory,
    'log',
    '-1',
    `--format=%(trailers:key=${provenanceTrailer},valueonly)`,
    'FETCH_HEAD',
  );
  const trailer = trailerOutput.trim();
  return /^[0-9a-f]{40}$/.test(trailer) ? trailer : '';
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
export async function findForeignCommits(
  directory: string,
  ownership?: ForeignCommitOwnership,
): Promise<ForeignCommit[]> {
  const history = await readHistory(directory);
  if (ownership !== undefined) {
    for (const commit of history) {
      if (!commit.provenance)
        commit.provenance = await pullRequestSquashProvenance(directory, commit, ownership.target);
    }
  }
  const newestMirrored = history.findIndex((commit) => commit.provenance.length > 0);
  if (newestMirrored === -1) return [];
  const mirrorCommit = history[newestMirrored]!.sha;
  const ancestry = await git(directory, 'rev-list', '--ancestry-path', `${mirrorCommit}..HEAD`);
  const descendants = new Set(ancestry.trim().split('\n'));
  const candidates = history.filter(({ sha }) => descendants.has(sha));
  if (ownership === undefined) return candidates.map(({ sha, subject }) => ({ sha, subject }));
  const foreign: ForeignCommit[] = [];
  for (const { sha, subject } of candidates) {
    if (!(await isTargetOwnedCommit(directory, sha, mirrorCommit, ownership)))
      foreign.push({ sha, subject });
  }
  return foreign;
}

/** What decides whether a commit above the mirror's own is the target's to make. */
export interface ForeignCommitOwnership {
  policy: TargetOwnedPolicy;
  target: string;
  /** Declared version constants that a target release may update only to its manifest version. */
  versionConstantPaths?: ReadonlyMap<string, string> | undefined;
  /**
   * Target-relative files that are the target's own although no `target-owned.json` glob names
   * them: the declared build inputs (`requiredInputs` in `package-surface.json`, target-owned by
   * COR-1190's ruling), which the transform reads for presence and never writes.
   */
  targetOwnedFiles?: ReadonlySet<string> | undefined;
  /** Transform-owned manifest values freshly computed from the trusted source for this clone. */
  generatedManifestKeys?: ReadonlyMap<string, Readonly<Record<string, unknown>>> | undefined;
  /**
   * What this sync's plan writes, prunes and retires. A path outside all three is one the sync
   * leaves exactly as it is, so a hand change to it cannot be clobbered and is the target's own
   * (COR-1223's inversion, applied to the guard by COR-1198).
   */
  transform: TransformReach;
}

/** The paths a sync can overwrite or delete: its emitted files and the prefixes it prunes or retires. */
export interface TransformReach {
  files: ReadonlySet<string>;
  prefixes: readonly string[];
}

/** Whether a sync would write or delete this target-relative path. */
function transformReaches(reach: TransformReach, path: string): boolean {
  return (
    reach.files.has(path) ||
    reach.prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  );
}

/**
 * Whether every change a commit makes is one the transform preserves.
 *
 * COR-1192. After the first sync, every release bump is a hand commit above a mirror-authored
 * one: a manifest's `version` is target-owned and the transform never writes it, so the target
 * has to, and a guard that called that foreign would refuse every release. A commit is the
 * target's own when each path it touches is either target-owned by `target-owned.json`'s
 * enumeration — the changelog, the readme, the release workflow — or outside everything the sync
 * writes, prunes or retires (release tooling, a package README), or a manifest the transform
 * composes whose changed top-level keys are all outside the transform's own `manifestKeys`. A
 * manifest added or deleted outright is the transform's business, and so is any other path the
 * sync reaches: emitted source, a vendored tsconfig, the emitted workflow, a file inside a source
 * tree it prunes.
 */
async function isTargetOwnedCommit(
  directory: string,
  sha: string,
  mirrorCommit: string,
  ownership: ForeignCommitOwnership,
): Promise<boolean> {
  const parentRecord = await git(directory, 'rev-list', '--parents', '-n', '1', sha);
  const parents = parentRecord.trim().split(/\s+/).slice(1);
  let inspected = false;
  for (const parent of parents) {
    const ancestor = await tryGit(directory, 'merge-base', '--is-ancestor', mirrorCommit, parent);
    if (ancestor.exitCode === 1) continue;
    if (ancestor.exitCode !== 0)
      throw new SyncError(`Cannot inspect mirror ancestry: ${ancestor.stderr}`);
    inspected = true;
    if (!(await isTargetOwnedDelta(directory, parent, sha, ownership))) return false;
  }
  return inspected;
}

/** Compare every ancestry edge after the mirror; combined merge diffs can omit imported changes. */
async function isTargetOwnedDelta(
  directory: string,
  parent: string,
  sha: string,
  {
    policy,
    target,
    targetOwnedFiles,
    versionConstantPaths,
    generatedManifestKeys,
    transform,
  }: ForeignCommitOwnership,
): Promise<boolean> {
  // `--no-renames`: a rename is judged as the deletion of its old path plus the addition of its
  // new one, so moving an emitted file out of the sync's reach is still a deletion the sync would
  // undo. `-z`: paths arrive unquoted, so one git would escape still matches the plan's keys.
  const status = await git(directory, 'diff', '--name-status', '--no-renames', '-z', parent, sha);
  const fields = status.split('\0');
  const transformOwnedKeys = new Set(policy.insideFiles.manifestKeys.map((entry) => entry.key));
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const kind = (fields[index] ?? '').trim();
    const path = fields[index + 1] ?? '';
    if (findTargetOwner(policy, path, target) !== undefined) continue;
    if (targetOwnedFiles?.has(path)) continue;
    const versionDirectory = versionConstantPaths?.get(path);
    if (
      versionDirectory !== undefined &&
      kind.startsWith('M') &&
      (await isManifestVersionOnlyChange(
        directory,
        parent,
        sha,
        path,
        versionDirectory,
        runCommand,
      ))
    )
      continue;
    if (!transformReaches(transform, path)) continue;
    if (basename(path) !== 'package.json' || !kind.startsWith('M')) return false;
    const before = await git(directory, 'show', `${parent}:${path}`);
    const after = await git(directory, 'show', `${sha}:${path}`);
    const afterManifest = JSON.parse(after) as Record<string, unknown>;
    const generated = generatedManifestKeys?.get(path);
    for (const key of changedTopLevelKeys(before, after)) {
      if (
        transformOwnedKeys.has(key) &&
        (generated === undefined ||
          JSON.stringify(afterManifest[key]) !== JSON.stringify(generated[key]))
      )
        return false;
    }
  }
  return true;
}

/**
 * Every declared build input of the workspaces this target receives, as target-relative paths:
 * the files a hand commit may touch that no `target-owned.json` glob names.
 */
export async function declaredBuildInputs(target: string): Promise<Set<string>> {
  const surface = await loadPackageSurface();
  const files = new Set<string>();
  for (const [workspace, entry] of Object.entries(surface.packages)) {
    if (targetFor(workspace) !== target) continue;
    const layout = await layoutFor(workspace);
    if (!layout || layout.disposition === 'deferred') continue;
    for (const input of entry.build.requiredInputs) {
      files.add(`${layout.targetDirectory}/${input}`);
    }
  }
  return files;
}

/**
 * Everything the foreign-commit guard needs for one target, read against the clone as it arrived:
 * the enumeration, the declared build inputs, and the reach of the plan this sync would stage.
 */
export async function foreignCommitOwnership(options: {
  corvidaeRoot: string;
  target: MirrorTarget;
  clone: string;
}): Promise<ForeignCommitOwnership> {
  const policy = await loadTargetOwnedPolicy();
  const plan = await planSurface({
    corvidaeRoot: options.corvidaeRoot,
    target: options.target,
    targetDirectory: options.clone,
    policy,
  });
  return {
    policy,
    target: options.target,
    targetOwnedFiles: await declaredBuildInputs(options.target),
    generatedManifestKeys: new Map(
      Object.entries(plan.files)
        .filter(
          ([path, contents]) => basename(path) === 'package.json' && typeof contents === 'string',
        )
        .map(([path, contents]) => [
          path,
          JSON.parse(contents as string) as Record<string, unknown>,
        ]),
    ),
    versionConstantPaths: new Map(
      plan.published.flatMap((entry) => {
        const declared = versionConstants[entry.workspace];
        return declared === undefined
          ? []
          : [[`${entry.directory}/${declared}`, entry.directory] as const];
      }),
    ),
    transform: {
      files: new Set(Object.keys(plan.files)),
      prefixes: [...plan.source.ownedPrefixes, ...retiredDirectoriesFor(policy, options.target)],
    },
  };
}

/** Top-level keys whose serialized value differs between two JSON documents. */
function changedTopLevelKeys(before: string, after: string): string[] {
  const parse = (text: string): Record<string, unknown> => {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  };
  const previous = parse(before);
  const next = parse(after);
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...keys].filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
}

/** Throws `ForeignCommitError` naming every commit the mirror did not author. */
export async function assertNoForeignCommits(
  directory: string,
  ownership?: ForeignCommitOwnership,
): Promise<void> {
  const foreign = await findForeignCommits(directory, ownership);
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
  /**
   * What the verification install was compared against. An empty `checkedAgainst` means the
   * target carries no workflows to compare with, which is a gap in the evidence rather than a
   * clean result — recorded here so it is visible instead of reading as a pass.
   */
  installParity: InstallParity;
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
 *
 * COR-1286: the command list this function executes is `verify-steps.ts`'s `buildVerifySteps`,
 * not a hand-written sequence any more. `mirror-verify-workflow.ts` calls the same function to
 * render the workflow the transform now emits into the target, so the two can never drift out of
 * step — a step added here is a step the rendered workflow's next sync picks up automatically, and
 * vice versa. This function's own job shrinks to resolving the *local* environment
 * (`createLocalVerifyEnvironment`) and walking the resulting steps, reassembling their results
 * into the shapes `SyncResult` has always returned.
 */
export async function verifyTarget({
  toolsRoot,
  directory,
  published,
  privateWorkspaces = [],
  scratchDirectory,
  installArguments = [],
}: VerifyOptions): Promise<VerifyResult> {
  // This install is the one thing standing between the mirror and publishing a tree that does
  // not build, so it runs the way the target's own CI runs: no `--ignore-scripts`, from an empty
  // `node_modules`. Both halves are load-bearing and neither works alone.
  //
  // The flag used to be here to keep the target's husky `prepare` from arming hooks before the
  // sync's commit. It also suppressed every dependency's `install` script, which left
  // `better-sqlite3` present, requirable, and missing the compiled `better_sqlite3.node` it only
  // reaches for when a database is constructed — so the staged tree passed every check that
  // stopped at `require` and failed the one integration test that went further (COR-1278). Hooks
  // are now neutralized where they actually live, in `gitEnvironment`'s `core.hooksPath`.
  //
  // The wipe is what makes dropping the flag do anything. `stageTarget` has already installed
  // into this directory to regenerate the lockfile, and Bun does not re-run lifecycle scripts for
  // a package that is already linked: a second install over a populated tree leaves an unbuilt
  // binding exactly as unbuilt, whatever flags it carries. Removing `node_modules` first also
  // makes this a fresh-checkout install, which is what CI actually does. `bun install --force`
  // would rebuild too, but it is not a command any target runs, and answering "the harness
  // diverges from the real environment" with a second divergence is not an answer.
  const installCommand = ['bun', 'install', '--frozen-lockfile', ...installArguments];
  const installParity = assertInstallParity({
    command: installCommand,
    workflowInstalls: await readWorkflowInstalls(directory),
    allowedExtraFlags: installArguments,
  });
  await rm(join(directory, 'node_modules'), { recursive: true, force: true });

  // Checked before any step runs, exactly as before the refactor: a missing `typecheck` script is
  // reported over the whole set in one message, not discovered mid-walk after some steps already
  // ran.
  assertPrivateWorkspacesCheckable(privateWorkspaces);

  const environment = await createLocalVerifyEnvironment({
    directory,
    toolsRoot: toolsRoot ?? defaultToolsRoot,
    scratchDirectory,
  });
  const steps = buildVerifySteps(
    { installCommand, published, privateWorkspaces, installArguments },
    environment,
  );

  const reportsByPublicName = new Map<
    string,
    { tarball: string; publint?: TarballReport['publint'] }
  >();
  const reports: TarballReport[] = [];
  const privateTypechecks: string[] = [];
  let smokeTest: SmokeTestResult | undefined;

  for (const step of steps) {
    if (step.files) {
      await mkdir(step.cwd, { recursive: true });
      for (const [relativePath, contents] of Object.entries(step.files)) {
        await Bun.write(join(step.cwd, relativePath), contents);
      }
    }
    if (step.command.length === 0) continue;
    const result = await runCommand(step.command, { cwd: step.cwd });

    switch (step.kind) {
      case 'install': {
        assertSucceeded(result, 'verifying the staged lockfile satisfies the emitted manifests');
        break;
      }
      case 'build':
      case 'typecheck-published': {
        assertSucceeded(
          result,
          `running ${step.kind === 'build' ? 'build' : 'typecheck'} for ${step.publicName}`,
        );
        break;
      }
      case 'binary-size': {
        assertSucceeded(result, `verifying binary payload for ${step.publicName}`);
        break;
      }
      case 'pack': {
        assertSucceeded(result, `packing ${step.publicName}`);
        break;
      }
      case 'pack-relocate': {
        assertSucceeded(
          result,
          `staging ${step.publicName}'s packed tarball into the shared tarballs directory`,
        );
        break;
      }
      case 'readme': {
        assertSucceeded(result, `checking the packed README for ${step.publicName}`);
        break;
      }
      case 'publint': {
        assertSucceeded(result, `resolving publint for ${step.publicName}`);
        reportsByPublicName.set(step.publicName ?? '', {
          tarball: step.tarball ?? '',
          publint: result,
        });
        break;
      }
      case 'attw': {
        assertSucceeded(result, `resolving attw for ${step.publicName}`);
        const pending = reportsByPublicName.get(step.publicName ?? '');
        reports.push({
          publicName: step.publicName ?? '',
          tarball: step.tarball ?? '',
          publint: pending?.publint ?? result,
          typeResolution: result,
          readme: { ok: true },
        });
        break;
      }
      case 'prepack': {
        assertSucceeded(result, `running prepack for ${step.publicName}`);
        break;
      }
      case 'typecheck-private': {
        assertSucceeded(result, `running typecheck for ${step.publicName}`);
        if (step.publicName) privateTypechecks.push(step.publicName);
        break;
      }
      case 'build-private': {
        assertSucceeded(result, `running build for ${step.publicName}`);
        break;
      }
      case 'consumer-install': {
        assertSucceeded(result, 'installing the packed tarballs into the consumer project');
        break;
      }
      case 'consumer-run': {
        assertSucceeded(
          result,
          `importing specifier(s) from the packed tarballs (${step.description})`,
        );
        smokeTest = { directory: step.cwd, specifiers: specifiersFor(published) };
        break;
      }
      case 'consumer-run-node': {
        assertSucceeded(
          result,
          `importing specifier(s) from the packed tarballs under node (${step.description})`,
        );
        break;
      }
      case 'write-consumer-project': {
        // Unreachable: this step's `command` is always empty, so the `continue` above already
        // skipped it before the switch runs. Kept as an explicit case so the switch stays
        // exhaustive over `VerifyStepKind` rather than needing a `default` that could silently
        // swallow a real kind added later.
        break;
      }
    }
  }
  // `checkTarball`'s old two-command run is now two steps (`publint`, `attw`), but the *check* that
  // both succeed for every published package stays one call over the assembled reports — reusing
  // it is what keeps this function's own success criteria identical to before the refactor.
  assertTarballsPublishable(reports);
  if (smokeTest === undefined) {
    throw new PackagingError('The verification steps produced no consumer smoke test result');
  }

  return { reports, smokeTest, privateTypechecks, installParity };
}

export type SyncDecision = 'skip' | 'prepared' | 'pushed';

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
  /** Trusted account credentials for a direct GitHub push, resolved only after verification. */
  pushEnvironment?: (() => Promise<Record<string, string>>) | undefined;
  branch?: string | undefined;
  installArguments?: readonly string[] | undefined;
  /** The checkout whose devDependencies supply publint and attw; defaults to this one. */
  toolsRoot?: string | undefined;
  /**
   * Open a pull request instead of pushing straight to the branch that was cloned.
   *
   * COR-1195: a workflow dispatch syncs a real target this way so the target's own emitted
   * `mirror-verify.yaml` runs against the exact diff before anything reaches its default branch,
   * rather than being pushed there sight unseen. Supplying this turns the final push into a push
   * of a new branch under `pushEnvironment`'s credential, followed by `openPullRequest` — nothing
   * else in the pipeline changes: the same clone, the same foreign-commit guard (so a hand release
   * commit on the target's default branch is still permitted and still an ancestor of the sync
   * commit, exactly as it is on the direct-push path), the same stage and the same verification.
   */
  pullRequest?: PullRequestOptions | undefined;
  /** Verify and commit locally for publication on a separate, credentialed runner. */
  prepareBranch?: string | undefined;
}

export interface PullRequestOptions {
  /** The branch created for the sync commit and pushed; the target's default branch is untouched. */
  branch: string;
  /**
   * Resolves the credential the branch is pushed under. Composed with `gitEnvironment` through
   * `credentialedGitEnvironment` rather than used as-is, so hook neutralization survives the push.
   */
  pushEnvironment: () => Promise<Record<string, string>>;
  /** Opens the pull request once the branch has been pushed. */
  openPullRequest: (info: {
    branch: string;
    /** The target's default branch, read from the clone before the sync branch was created. */
    base: string;
    commit: string;
    changed: readonly string[];
  }) => Promise<{ number: number; htmlUrl: string }>;
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
  /** Present only when `SyncOptions.pullRequest` was supplied and something changed. */
  pullRequest?: { number: number; htmlUrl: string };
  /** The branch and commit the clone had before a sync branch was created. */
  baseBranch: string;
  baseCommit: string;
}

/** Refuse verification that changed the commit inputs after the transform was staged. */
export async function assertVerificationSnapshot(options: {
  expectedHead: string;
  expectedIndexTree: string;
  run: (arguments_: readonly string[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}): Promise<void> {
  const { expectedHead, expectedIndexTree, run } = options;
  const headResult = await run(['rev-parse', 'HEAD']);
  if (headResult.exitCode !== 0)
    throw new SyncError(`Could not read the target HEAD after verification: ${headResult.stderr}`);
  const currentHead = headResult.stdout.trim();
  if (currentHead !== expectedHead) {
    throw new SyncError(
      `The target HEAD changed during verification: expected ${expectedHead}, found ${currentHead}`,
    );
  }

  const indexResult = await run(['write-tree']);
  if (indexResult.exitCode !== 0)
    throw new SyncError(`Could not read the staged tree after verification: ${indexResult.stderr}`);
  const currentIndexTree = indexResult.stdout.trim();
  if (currentIndexTree !== expectedIndexTree) {
    throw new SyncError(
      `The staged tree changed during verification: expected ${expectedIndexTree}, found ${currentIndexTree}`,
    );
  }

  const workingTree = await run(['diff', '--quiet']);
  if (workingTree.exitCode !== 0) {
    throw new SyncError('The tracked working tree changed during verification');
  }
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
  if (options.prepareBranch !== undefined && options.pullRequest !== undefined)
    throw new SyncError('Prepare and pull-request modes are mutually exclusive');
  const clone = await cloneTarget({
    remote: options.remote,
    directory: options.directory,
    branch: options.branch,
  });
  await assertNoForeignCommits(
    clone,
    await foreignCommitOwnership({
      corvidaeRoot: options.corvidaeRoot,
      target: options.target,
      clone,
    }),
  );

  // Record the target branch before creating a local preparation or pull-request branch.
  let base: string | undefined;
  const baseCommit = await git(clone, 'rev-parse', 'HEAD');
  const baseCommitBeforeSync = baseCommit.trim();
  if (options.pullRequest !== undefined || options.prepareBranch !== undefined) {
    const currentBranch = await git(clone, 'rev-parse', '--abbrev-ref', 'HEAD');
    base = currentBranch.trim();
  }
  // Created after the guard and before the transform, so every hand commit already on the
  // target's default branch is an ancestor of the sync branch by construction, exactly as it
  // would be on the branch the direct-push path commits to.
  const syncBranch = options.prepareBranch ?? options.pullRequest?.branch;
  if (syncBranch !== undefined) await git(clone, 'checkout', '-b', syncBranch);

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
  const stagedTreeResult = await git(clone, 'write-tree');
  const stagedIndexTree = stagedTreeResult.trim();
  const stagedHead = baseCommitBeforeSync;

  const verification = await verifyTarget({
    toolsRoot: options.toolsRoot,
    directory: clone,
    published: plan.published,
    privateWorkspaces: plan.privateWorkspaces,
    scratchDirectory: options.scratchDirectory,
    installArguments: options.installArguments,
  });
  await assertVerificationSnapshot({
    expectedHead: stagedHead,
    expectedIndexTree: stagedIndexTree,
    run: (arguments_) => tryGit(clone, ...arguments_),
  });

  if (changed.length === 0) {
    const currentBranch = await git(clone, 'rev-parse', '--abbrev-ref', 'HEAD');
    return {
      decision: 'skip',
      target: options.target,
      directory: clone,
      changed,
      firstPublish: plan.firstPublish,
      seededFromPackageMap: plan.seededFromPackageMap,
      verification,
      baseBranch: base ?? currentBranch.trim(),
      baseCommit: baseCommitBeforeSync,
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

  if (options.prepareBranch !== undefined) {
    return {
      decision: 'prepared',
      target: options.target,
      directory: clone,
      changed,
      commit,
      firstPublish: plan.firstPublish,
      seededFromPackageMap: plan.seededFromPackageMap,
      verification,
      baseBranch: base ?? '',
      baseCommit: baseCommitBeforeSync,
    };
  }

  if (options.pullRequest) {
    const pullRequestOptions = options.pullRequest;
    await pushVerifiedCommit({
      directory: clone,
      remote: options.remote,
      commit,
      branch: options.pullRequest.branch,
      environment: gitEnvironment(),
      credentialEnvironment: async () =>
        credentialedGitEnvironment(await pullRequestOptions.pushEnvironment()),
    });
    const pullRequest = await options.pullRequest.openPullRequest({
      branch: options.pullRequest.branch,
      // `base` was read before the sync branch was created and is always set alongside
      // `options.pullRequest`; the `?? ''` only satisfies the type checker.
      base: base ?? '',
      commit,
      changed,
    });
    return {
      decision: 'pushed',
      target: options.target,
      directory: clone,
      changed,
      commit,
      firstPublish: plan.firstPublish,
      seededFromPackageMap: plan.seededFromPackageMap,
      verification,
      pullRequest,
      baseBranch: base ?? '',
      baseCommit: baseCommitBeforeSync,
    };
  }

  const currentBranch = await git(clone, 'rev-parse', '--abbrev-ref', 'HEAD');
  await pushVerifiedCommit({
    directory: clone,
    remote: options.remote,
    commit,
    branch: currentBranch.trim(),
    environment: gitEnvironment(),
    credentialEnvironment: async () =>
      directPushEnvironment(options.remote, options.pushEnvironment),
  });

  return {
    decision: 'pushed',
    target: options.target,
    directory: clone,
    changed,
    commit,
    firstPublish: plan.firstPublish,
    seededFromPackageMap: plan.seededFromPackageMap,
    verification,
    baseBranch: base ?? currentBranch.trim(),
    baseCommit: baseCommitBeforeSync,
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

/** Narrow a `--target` argument to a known target, so a third one needs no second literal here. */
function isMirrorTarget(value: string): value is MirrorTarget {
  return (mirrorTargets as readonly string[]).includes(value);
}

export async function runSyncCommand(argv: readonly string[]): Promise<number> {
  try {
    const target = required(argv, 'target');
    if (!isMirrorTarget(target)) {
      throw new SyncError(
        `Unknown --target "${target}"; expected one of ${mirrorTargets.join(', ')}`,
      );
    }
    const api = createGitHubApi({
      userToken: userTokenFromEnvironmentOrCli(),
      installationToken: async () => {
        throw new SyncError('Direct sync does not use an App installation credential');
      },
    });
    const result = await runSync({
      corvidaeRoot:
        readOption(argv, 'corvidae-root') ?? new URL('../../', import.meta.url).pathname,
      target,
      remote: required(argv, 'remote'),
      directory: required(argv, 'directory'),
      scratchDirectory: required(argv, 'scratch'),
      corvidaeCommit: required(argv, 'corvidae-commit'),
      branch: readOption(argv, 'branch'),
      pushEnvironment: () => api.accountPushEnvironment(),
    });
    process.stdout.write(
      result.decision === 'skip'
        ? `${target}: no change, skipping\n`
        : `${target}: pushed ${result.commit} with ${result.changed.length} changed path(s)\n`,
    );
    // Printed on every run, including a skip, because the interesting value is zero: a target
    // whose workflows the mirror could not read is one whose verification install was compared
    // against nothing. Recording that only in the returned object would leave the claim that it
    // is "visible" true of the type and false of the tool.
    const { installParity } = result.verification;
    process.stdout.write(
      installParity.checkedAgainst.length === 0
        ? `${target}: install parity UNVERIFIED — no workflow install found to compare \`${installParity.command}\` against\n`
        : `${target}: install parity checked against ${installParity.checkedAgainst.length} workflow install(s)\n`,
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
