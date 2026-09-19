import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createGitHubApi,
  installationTokenFromApp,
  userTokenFromEnvironmentOrCli,
  type CheckRunRecord,
  type CommandRunner,
  type GitHubApi,
  type InstallationCoverage,
  type PullRequestRecord,
  type RepositoryRecord,
} from './github-api.ts';
import { installationSettingsUrl, mirrorAppId, mirrorInstallationId } from './github-app.ts';
import { mirrorTargets, type MirrorTarget } from './manifests.ts';
import { runCommand, type CommandResult } from './packaging.ts';
import {
  assertNoForeignCommits,
  gitEnvironment,
  provenanceTrailer,
  stageSurface,
  type StageOptions,
  type StageOutcome,
} from './sync.ts';

/**
 * The throwaway round trip that proves the real GitHub path before it is pointed at a real
 * mirror: create a public scratch repository, seed it, run the existing transform into it, open a
 * pull request through the App, prove `npm publish --dry-run`, and delete the scratch repository
 * again.
 *
 * The delete is the dangerous half and the reason this module exists as its own thing.
 * `deleteScratchRepository` is irreversible and the account credential now carries `delete_repo`,
 * so every assertion that makes a delete safe lives *inside* that function, reading the
 * repository from GitHub itself. A later edit to a caller — a wrong variable, a copied line, an
 * argument threaded from somewhere else — cannot point the delete at a real repository, because
 * the caller does not get a say: it passes a name, and the name has to match a pattern no real
 * repository bears while the repository behind it has to carry a sentinel description no real
 * repository carries.
 */

export class DryRunError extends Error {}

/** A refusal to create or delete something that is not provably the scratch repository. */
export class ScratchGuardError extends DryRunError {}

/** A refusal to proceed because the App installation cannot reach the scratch repository. */
export class InstallationCoverageError extends DryRunError {}

/** The account the scratch repository is created under, and the only one the guard accepts. */
export const scratchOwner = 'stevekinney';

/**
 * The description the guard matches, byte for byte.
 *
 * It is the second of the two independent facts a delete requires, and the stronger one: a name
 * can be made to match by typing it, whereas this has to have been written into the repository
 * by a run of this driver.
 */
export const scratchDescription = 'mirror dry run, safe to delete';

/**
 * The pinned name.
 *
 * Anchored at both ends, so a string that merely *contains* a scratch name — a real repository
 * with a matching suffix, a copy-paste that kept a prefix, a trailing newline off a shell — does
 * not match. Nothing is trimmed first: trimming normalizes a name that did not match into one
 * that does, and the whole purpose here is to refuse anything that is not exactly right.
 */
const scratchNamePattern = /^stevekinney\/mirror-dryrun-(\d{4})(\d{2})(\d{2})$/;

/** The base branch of the scratch repository. */
const baseBranch = 'main';

function twoDigits(value: number): string {
  return value.toString().padStart(2, '0');
}

/** `stevekinney/mirror-dryrun-YYYYMMDD` for the given instant, in UTC. */
export function scratchRepositoryName(now: Date = new Date()): string {
  const stamp = `${now.getUTCFullYear()}${twoDigits(now.getUTCMonth() + 1)}${twoDigits(now.getUTCDate())}`;
  return `${scratchOwner}/mirror-dryrun-${stamp}`;
}

/** The date stamp out of a name the guard has already accepted. */
function scratchStamp(target: string): string {
  const [, year = '', month = '', day = ''] = scratchNamePattern.exec(target) ?? [];
  return `${year}${month}${day}`;
}

/**
 * The name half of the guard: the pinned pattern, plus a real calendar date.
 *
 * The date check is what makes this "a name this driver could have produced" rather than "a name
 * shaped like one". `\d{8}` alone accepts `mirror-dryrun-00000000` and `mirror-dryrun-99999999`,
 * which no run ever generates, so accepting them would only ever mean accepting a typo.
 */
export function assertScratchName(target: string): void {
  const matched = scratchNamePattern.exec(target);
  if (!matched) {
    throw new ScratchGuardError(
      `Refusing to act on ${JSON.stringify(target)}: a scratch repository is named ${scratchOwner}/mirror-dryrun-YYYYMMDD and nothing else.`,
    );
  }
  const [, year = '', month = '', day = ''] = matched;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const roundTrips =
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(day);
  if (!roundTrips) {
    throw new ScratchGuardError(
      `Refusing to act on ${JSON.stringify(target)}: ${year}${month}${day} is not a calendar date, so no run of this driver produced that name.`,
    );
  }
}

/**
 * The repository half of the guard, against the record GitHub returned for the requested name.
 *
 * `fullName` is compared because GitHub follows a rename: ask for a repository that was renamed
 * and the API answers with the repository it became, under its new name. Without this, a scratch
 * name that once existed and was renamed onto something real would resolve to that real
 * repository and pass every other check on its behalf.
 */
export function assertScratchRepository(target: string, repository: RepositoryRecord): void {
  if (repository.fullName !== target) {
    throw new ScratchGuardError(
      `Refusing to act on ${target}: GitHub answered with ${JSON.stringify(repository.fullName)} instead, so that name now redirects to a different repository.`,
    );
  }
  if (repository.description !== scratchDescription) {
    throw new ScratchGuardError(
      `Refusing to act on ${target}: its description is ${JSON.stringify(repository.description)}, not ${JSON.stringify(scratchDescription)}.`,
    );
  }
  if (repository.private) {
    throw new ScratchGuardError(
      `Refusing to act on ${target}: it is private, and the scratch repository is public by construction, so this is a different repository.`,
    );
  }
}

/**
 * Delete the scratch repository, or refuse loudly.
 *
 * Both assertions the issue requires are here rather than at any call site, and the description
 * is read from GitHub inside this function rather than accepted from the caller, so the only
 * thing a caller can influence is which name is checked.
 */
export async function deleteScratchRepository(api: GitHubApi, target: string): Promise<void> {
  assertScratchName(target);
  const repository = await api.readRepository(target);
  if (!repository) {
    throw new ScratchGuardError(
      `Refusing to delete ${target}: GitHub has no such repository, so there is nothing this run created to remove.`,
    );
  }
  assertScratchRepository(target, repository);
  await api.deleteRepository(target);
}

/**
 * Create the scratch repository, or adopt the one a previous phase created.
 *
 * Adoption exists because of the installation obstacle below: the owner has to add the scratch
 * repository to the App installation between creating it and using it, so the run that uses it
 * is not the run that made it. An adopted repository clears exactly the same assertions a delete
 * requires, so adoption can never pick up something that a later delete would refuse — or worse,
 * something a later delete would accept and should not.
 */
export async function ensureScratchRepository(
  api: GitHubApi,
  target: string,
): Promise<RepositoryRecord> {
  assertScratchName(target);
  const existing = await api.readRepository(target);
  if (existing) {
    assertScratchRepository(target, existing);
    return existing;
  }
  const created = await api.createRepository({ fullName: target, description: scratchDescription });
  assertScratchRepository(target, created);
  return created;
}

/**
 * Refuse to start unless the App installation can reach the scratch repository.
 *
 * This runs before anything else, including creating the repository, because everything the dry
 * run is trying to prove happens through the App: an installation scoped to selected
 * repositories cannot open a pull request in a repository it was never granted, and discovering
 * that after creating a public repository and pushing a transform into it wastes the run and
 * leaves a repository behind.
 *
 * There is a genuine ordering knot here and the message says so rather than papering over it: an
 * installation scoped to `selected` can only be granted a repository that already exists, so the
 * first run of this driver creates the repository, stops here, and waits for a browser step the
 * `gh` credential cannot perform.
 */
export async function assertInstallationCoverage(
  api: GitHubApi,
  target: string,
): Promise<InstallationCoverage> {
  const coverage = await api.readInstallationCoverage();
  if (coverage.repositorySelection === 'all') return coverage;
  if (coverage.repositories.includes(target)) return coverage;
  const reachable =
    coverage.repositories.length > 0 ? coverage.repositories.join(', ') : '(nothing)';
  throw new InstallationCoverageError(
    [
      `The mirror GitHub App (app ${mirrorAppId}, installation ${mirrorInstallationId}) cannot reach ${target}.`,
      `The installation is scoped to selected repositories and currently reaches: ${reachable}.`,
      `An installation token therefore cannot open a pull request in ${target}, and this driver will not fall back to the gh user token: proving the App path is the point of this run.`,
      `Resolve it in the browser at ${installationSettingsUrl} by adding ${target} to the installation (or switching the installation to all repositories), then re-run.`,
      `If ${target} does not exist yet, run this driver with --phase create first: an installation scoped to selected repositories can only be granted a repository that already exists.`,
      `The gh CLI token cannot do any of that itself — GET /user/installations answers 403 for it, because that token is not authorized for this App.`,
    ].join('\n'),
  );
}

/** How the transform is invoked, so a test can drive the driver without a real corvidae tree. */
export type StageTransform = (options: StageOptions) => Promise<StageOutcome>;

export interface DryRunOptions {
  api: GitHubApi;
  /** The corvidae checkout whose source is transformed. */
  corvidaeRoot: string;
  /** Which mirror's transform is rehearsed. */
  target: MirrorTarget;
  /** The public repository the scratch repository is seeded from; read, never written. */
  seedRemote?: string;
  /** A disposable working tree. */
  workDirectory: string;
  /** The corvidae commit recorded in the provenance trailer. */
  corvidaeCommit: string;
  scratchRepository?: string;
  /** Keep the scratch repository instead of deleting it, for a human to look at the run. */
  keep?: boolean;
  /** Which published package the publish dry run uses; the first one by default. */
  packageName?: string;
  now?: Date;
  run?: CommandRunner;
  stage?: StageTransform;
  installArguments?: readonly string[];
}

export interface PublishProbe {
  publicName: string;
  version: string;
  /** The argument vector, so the report says exactly what was proven. */
  command: string;
  exitCode: number;
}

export interface DryRunReport {
  scratchRepository: string;
  coverage: InstallationCoverage;
  repository: RepositoryRecord;
  branch: string;
  changed: number;
  pullRequest: PullRequestRecord;
  checkRuns: readonly CheckRunRecord[];
  publish: PublishProbe;
  deleted: boolean;
}

function scratchRemoteUrl(target: string): string {
  return `https://github.com/${target}.git`;
}

async function runGit(
  run: CommandRunner,
  directory: string,
  environment: Record<string, string | undefined>,
  ...arguments_: string[]
): Promise<CommandResult> {
  const result = await run(['git', ...arguments_], { cwd: directory, env: environment });
  if (result.exitCode !== 0) {
    throw new DryRunError(
      `git ${arguments_.join(' ')} failed in ${directory} (exit ${result.exitCode}):\n${result.stderr}${result.stdout}`,
    );
  }
  return result;
}

/**
 * Seed the scratch repository from the real mirror's tip.
 *
 * An empty repository is not a usable rehearsal. The transform's own build-input guard refuses a
 * target that is missing the target-owned files a mirror carries and corvidae does not — the
 * build script, the bundler configuration — so a transform into an empty repository fails on the
 * first gate and proves nothing about the ones after it. A depth-one clone of the real mirror
 * gives the scratch repository exactly the tree the transform will meet in production, without
 * copying a history nobody needs, and the push that plants it is the first thing the App
 * credential does.
 */
export async function seedScratchRepository(options: {
  run: CommandRunner;
  api: GitHubApi;
  seedRemote: string;
  scratchRepository: string;
  workDirectory: string;
}): Promise<void> {
  const { run, workDirectory } = options;
  await mkdir(workDirectory, { recursive: true });
  const environment = gitEnvironment();
  await runGit(
    run,
    workDirectory,
    environment,
    'clone',
    '--depth',
    '1',
    '--quiet',
    options.seedRemote,
    workDirectory,
  );
  await runGit(
    run,
    workDirectory,
    environment,
    'remote',
    'set-url',
    'origin',
    scratchRemoteUrl(options.scratchRepository),
  );
  const pushEnvironment = { ...environment, ...(await options.api.pushEnvironment()) };
  await runGit(
    run,
    workDirectory,
    pushEnvironment,
    'push',
    'origin',
    `HEAD:refs/heads/${baseBranch}`,
  );
}

export interface TransformOutcome {
  branch: string;
  changed: number;
  pullRequest: PullRequestRecord;
  outcome: StageOutcome;
}

/** Run the transform on a branch, push it as the App, and open the pull request. */
export async function transformAndOpenPullRequest(options: {
  api: GitHubApi;
  run: CommandRunner;
  stage: StageTransform;
  corvidaeRoot: string;
  target: MirrorTarget;
  corvidaeCommit: string;
  scratchRepository: string;
  workDirectory: string;
  branch: string;
  installArguments?: readonly string[];
}): Promise<TransformOutcome> {
  const { run, workDirectory, branch } = options;
  const environment = gitEnvironment();
  await assertNoForeignCommits(workDirectory);
  await runGit(run, workDirectory, environment, 'checkout', '-b', branch);
  const outcome = await options.stage({
    corvidaeRoot: options.corvidaeRoot,
    target: options.target,
    directory: workDirectory,
    ...(options.installArguments ? { installArguments: options.installArguments } : {}),
  });
  await runGit(run, workDirectory, environment, 'add', '--all');
  const status = await runGit(run, workDirectory, environment, 'status', '--porcelain');
  const changed = status.stdout.split('\n').filter((line) => line.length > 0);
  if (changed.length === 0) {
    throw new DryRunError(
      `The transform produced no change against the seeded ${options.target} tree, so there is no pull request to open. The scratch repository is still there; remove it with --phase delete.`,
    );
  }
  await runGit(
    run,
    workDirectory,
    environment,
    'commit',
    '--quiet',
    '--message',
    `Mirror dry run for ${options.target}\n\n${provenanceTrailer}: ${options.corvidaeCommit}`,
  );
  const pushEnvironment = { ...environment, ...(await options.api.pushEnvironment()) };
  await runGit(run, workDirectory, pushEnvironment, 'push', 'origin', `HEAD:refs/heads/${branch}`);
  const pullRequest = await options.api.createPullRequest({
    fullName: options.scratchRepository,
    base: baseBranch,
    head: branch,
    title: `Mirror dry run for ${options.target}`,
    body: [
      `Rehearsal of the ${options.target} mirror transform against a throwaway repository.`,
      '',
      `${provenanceTrailer}: ${options.corvidaeCommit}`,
      '',
      `This repository is disposable: ${scratchDescription}.`,
    ].join('\n'),
  });
  return { branch, changed: changed.length, pullRequest, outcome };
}

/**
 * Prove `npm publish --dry-run` against one package of the transformed tree.
 *
 * Two things this rehearsal has to get right, both established by running the command rather than
 * by reading about it. A prerelease version is refused outright unless a tag is named — npm exits
 * 1 with "You must specify a tag using --tag when publishing a prerelease version" — so the tag
 * is chosen here from the version rather than left to npm's default. And `--ignore-scripts`
 * matches what the packing check already does for the same reason: two packages declare a
 * `prepack` gate whose inputs the transform does not carry, and this command is being used to
 * inspect the tarball npm would build, not to rehearse the gate.
 *
 * The result is judged by exit code. The output carries ANSI escapes, so a grep for an error
 * string reports a false green against output that plainly contains errors.
 */
export async function proveNpmPublishDryRun(options: {
  run: CommandRunner;
  workDirectory: string;
  outcome: StageOutcome;
  packageName?: string;
}): Promise<PublishProbe> {
  const published = options.outcome.plan.published.toSorted((left, right) =>
    left.publicName.localeCompare(right.publicName),
  );
  const chosen = options.packageName
    ? published.find((entry) => entry.publicName === options.packageName)
    : published.at(0);
  if (!chosen) {
    throw new DryRunError(
      options.packageName
        ? `No published package named ${options.packageName} in this target; it publishes ${published.map((entry) => entry.publicName).join(', ')}`
        : 'The transform planned no published package, so there is nothing to prove a publish against',
    );
  }
  const packageDirectory = join(options.workDirectory, chosen.directory);
  const manifest = (await Bun.file(join(packageDirectory, 'package.json')).json()) as {
    version?: string;
  };
  const version = manifest.version ?? '';
  const prerelease = version.includes('-');
  const command = [
    'npm',
    'publish',
    '--dry-run',
    '--ignore-scripts',
    '--tag',
    prerelease ? 'next' : 'latest',
  ];
  const result = await options.run(command, { cwd: packageDirectory });
  if (result.exitCode !== 0) {
    throw new DryRunError(
      `${chosen.publicName}: \`${command.join(' ')}\` exited ${result.exitCode}\n${result.stdout}${result.stderr}`,
    );
  }
  return {
    publicName: chosen.publicName,
    version,
    command: command.join(' '),
    exitCode: result.exitCode,
  };
}

/** The whole round trip, in the order the guards require. */
export async function runDryRun(options: DryRunOptions): Promise<DryRunReport> {
  const run = options.run ?? runCommand;
  const stage = options.stage ?? stageSurface;
  const now = options.now ?? new Date();
  const scratchRepository = options.scratchRepository ?? scratchRepositoryName(now);
  assertScratchName(scratchRepository);
  const coverage = await assertInstallationCoverage(options.api, scratchRepository);
  const repository = await ensureScratchRepository(options.api, scratchRepository);
  const seedRemote =
    options.seedRemote ?? `https://github.com/${scratchOwner}/${options.target}.git`;
  await seedScratchRepository({
    run,
    api: options.api,
    seedRemote,
    scratchRepository,
    workDirectory: options.workDirectory,
  });
  const transformed = await transformAndOpenPullRequest({
    api: options.api,
    run,
    stage,
    corvidaeRoot: options.corvidaeRoot,
    target: options.target,
    corvidaeCommit: options.corvidaeCommit,
    scratchRepository,
    workDirectory: options.workDirectory,
    branch: `mirror-dry-run-${scratchStamp(scratchRepository)}`,
    ...(options.installArguments ? { installArguments: options.installArguments } : {}),
  });
  const checkRuns = await options.api.readCheckRuns(
    scratchRepository,
    transformed.pullRequest.headSha,
  );
  const publish = await proveNpmPublishDryRun({
    run,
    workDirectory: options.workDirectory,
    outcome: transformed.outcome,
    ...(options.packageName ? { packageName: options.packageName } : {}),
  });
  if (options.keep !== true) await deleteScratchRepository(options.api, scratchRepository);
  return {
    scratchRepository,
    coverage,
    repository,
    branch: transformed.branch,
    changed: transformed.changed,
    pullRequest: transformed.pullRequest,
    checkRuns,
    publish,
    deleted: options.keep !== true,
  };
}

function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function required(argv: readonly string[], name: string): string {
  const value = readOption(argv, name);
  if (!value) throw new DryRunError(`Missing required option --${name}`);
  return value;
}

export const dryRunPhases = ['preflight', 'create', 'all', 'delete'] as const;

export type DryRunPhase = (typeof dryRunPhases)[number];

function liveApi(): GitHubApi {
  return createGitHubApi({
    userToken: userTokenFromEnvironmentOrCli(),
    installationToken: installationTokenFromApp(),
  });
}

function describe(report: DryRunReport): string {
  const checks =
    report.checkRuns.length === 0
      ? '  check runs: none reported yet on the head commit'
      : report.checkRuns
          .map((check) => `  check run: ${check.name} ${check.status} ${check.conclusion ?? ''}`)
          .join('\n');
  return [
    `${report.scratchRepository}: pull request #${report.pullRequest.number} ${report.pullRequest.htmlUrl}`,
    `  branch ${report.branch} with ${report.changed} changed path(s)`,
    checks,
    `  publish dry run: ${report.publish.publicName}@${report.publish.version} via \`${report.publish.command}\` exited ${report.publish.exitCode}`,
    report.deleted
      ? `  scratch repository deleted`
      : `  scratch repository kept; remove it with --phase delete`,
  ].join('\n');
}

export async function runDryRunCommand(
  argv: readonly string[],
  api: GitHubApi = liveApi(),
): Promise<number> {
  try {
    const phase = (readOption(argv, 'phase') ?? 'preflight') as DryRunPhase;
    if (!dryRunPhases.includes(phase)) {
      throw new DryRunError(`Unknown --phase "${phase}"; expected ${dryRunPhases.join(', ')}`);
    }
    const scratchRepository = readOption(argv, 'scratch-repository') ?? scratchRepositoryName();
    if (phase === 'preflight') {
      const coverage = await assertInstallationCoverage(api, scratchRepository);
      process.stdout.write(
        `${scratchRepository}: the App installation reaches it (repository_selection=${coverage.repositorySelection})\n`,
      );
      return 0;
    }
    if (phase === 'create') {
      const repository = await ensureScratchRepository(api, scratchRepository);
      process.stdout.write(
        `${repository.fullName}: ready at ${repository.htmlUrl}\nAdd it to the App installation at ${installationSettingsUrl}, then run --phase all.\n`,
      );
      return 0;
    }
    if (phase === 'delete') {
      await deleteScratchRepository(api, scratchRepository);
      process.stdout.write(`${scratchRepository}: deleted\n`);
      return 0;
    }
    const target = required(argv, 'target');
    if (!mirrorTargets.includes(target as MirrorTarget)) {
      throw new DryRunError(`Unknown --target "${target}"; expected ${mirrorTargets.join(' or ')}`);
    }
    const seedRemote = readOption(argv, 'seed-remote');
    const packageName = readOption(argv, 'package');
    const report = await runDryRun({
      api,
      corvidaeRoot:
        readOption(argv, 'corvidae-root') ?? new URL('../../', import.meta.url).pathname,
      target: target as MirrorTarget,
      workDirectory: required(argv, 'work'),
      corvidaeCommit: required(argv, 'corvidae-commit'),
      scratchRepository,
      keep: argv.includes('--keep'),
      ...(seedRemote ? { seedRemote } : {}),
      ...(packageName ? { packageName } : {}),
    });
    process.stdout.write(`${describe(report)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await runDryRunCommand(Bun.argv.slice(2)));
