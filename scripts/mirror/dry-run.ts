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
  assertScratchName,
  assertScratchRepository,
  scratchDescription,
  ScratchGuardError,
  scratchOwner,
  scratchRepositoryName,
  scratchStamp,
} from './scratch-repository.ts';
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

/** A refusal to proceed because the App installation cannot reach the scratch repository. */
export class InstallationCoverageError extends DryRunError {}

/** The base branch of the scratch repository. */
const baseBranch = 'main';

/** The orphan branch the seed commit is made on, which is pushed as the base branch. */
const seedBranch = 'mirror-dry-run-seed';

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
  /** How many times the check runs are polled before the report takes what it has. */
  checkRunAttempts?: number;
  /** How the poll waits between attempts. */
  sleep?: (milliseconds: number) => Promise<void>;
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
 * copying a history nobody needs.
 *
 * The shallow tip is then re-committed as an orphan before it is pushed, and that is not
 * cosmetic. Pushing a shallow tip asks the receiving side to accept a commit whose parent it does
 * not have, which needs `receive.shallowUpdate`, and GitHub leaves that off: the push is rejected
 * with `shallow update not allowed`. An orphan commit of the same tree has no parent to be
 * missing, so the push carries a complete object graph. It also carries no provenance trailer,
 * which keeps the foreign-commit guard on its first-sync path rather than tripping it.
 */
export async function seedScratchRepository(options: {
  run: CommandRunner;
  api: GitHubApi;
  target: MirrorTarget;
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
  await runGit(run, workDirectory, environment, 'checkout', '--quiet', '--orphan', seedBranch);
  await runGit(run, workDirectory, environment, 'add', '--all');
  await runGit(
    run,
    workDirectory,
    environment,
    'commit',
    '--quiet',
    '--message',
    `Seed ${options.target} from ${options.seedRemote}`,
  );
  // As the account, not the App. The seed carries the target's own `.github/workflows/**`, and
  // GitHub refuses a workflow file pushed by an App without the `workflows` permission — which
  // this App deliberately does not hold, because `target-owned.json` reserves `.github/` for the
  // target and the transform never writes it. Only the seed needs this; the transform branch and
  // the pull request below still go through the App, which is what this whole run exists to prove.
  const pushEnvironment = { ...environment, ...(await options.api.accountPushEnvironment()) };
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
  // The existing guard, reused rather than restated, which means accepting that it runs git
  // itself instead of through the injected runner. On a freshly seeded tree it reads one orphan
  // commit with no provenance trailer and reports nothing foreign.
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

/**
 * Wait for the target's CI to say something about the head commit.
 *
 * A pull request opened a second ago has no check runs yet, so reading once and reporting
 * "none" would let a run claim CI was exercised when nothing had started. The poll is bounded at
 * five attempts and then reports whatever it has: a check that is still queued after five rounds
 * is a fact worth printing, not a reason to keep waiting.
 */
export async function waitForCheckRuns(options: {
  api: GitHubApi;
  scratchRepository: string;
  ref: string;
  attempts?: number;
  delayMilliseconds?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<readonly CheckRunRecord[]> {
  const attempts = options.attempts ?? 5;
  const delay = options.delayMilliseconds ?? 10_000;
  const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  let latest: readonly CheckRunRecord[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    latest = await options.api.readCheckRuns(options.scratchRepository, options.ref);
    const settled = latest.length > 0 && latest.every((check) => check.status === 'completed');
    if (settled) return latest;
    if (attempt < attempts) await sleep(delay);
  }
  return latest;
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
    target: options.target,
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
  const checkRuns = await waitForCheckRuns({
    api: options.api,
    scratchRepository,
    ref: transformed.pullRequest.headSha,
    ...(options.checkRunAttempts === undefined ? {} : { attempts: options.checkRunAttempts }),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
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
