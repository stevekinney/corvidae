/**
 * Shared host-side machinery for the two Docker entry points
 * (`update-snapshots-docker.ts` and `run-browser-docker.ts`), COR-1512.
 *
 * Rewritten from cinder's mount-based wrapper for isolation: the exact commit
 * enters the container as a `git archive` on stdin, the host checkout and its
 * `node_modules` are never mounted, and the only mount is an empty output
 * directory the container copies its results into. See
 * `scripts/browser-fixtures/visual-baselines.md`.
 */
import { rmSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { constants, cpus, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { environmentConfiguration } from '../environment-configuration.ts';
import {
  BROWSER_FIXTURES_ROOT,
  LINUX_BASELINE_DIRECTORY,
  PROVENANCE_FILE_NAME,
  REPOSITORY_ROOT,
  REQUIRED_BASELINE_ARCHITECTURE,
  writeBaselineProvenance,
  type BaselineProvenance,
  type RepositoryPins,
} from './baseline-provenance.ts';

export const DOCKER_PLATFORM = `linux/${REQUIRED_BASELINE_ARCHITECTURE}`;
export const DOCKERFILE_PATH = resolve(BROWSER_FIXTURES_ROOT, 'Dockerfile');

// ---------------------------------------------------------------------------
// Host load record
// ---------------------------------------------------------------------------

/**
 * The 1-minute load average and logical CPU count at a moment of a run. Host
 * load never blocks a run; it is recorded with each run, in the output and the
 * review report, so a behavioural timeout can be read against the load it ran
 * under (COR-1512).
 */
export type HostLoadReading = { oneMinuteLoad: number; logicalCpus: number };

export function readHostLoad(
  read: () => number[] = loadavg,
  logicalCpus: number = cpus().length,
): HostLoadReading {
  return { oneMinuteLoad: read()[0] ?? 0, logicalCpus };
}

export function describeHostLoad(reading: HostLoadReading): string {
  return `1-minute load ${reading.oneMinuteLoad.toFixed(2)} on ${reading.logicalCpus} logical CPUs`;
}

// ---------------------------------------------------------------------------
// Docker commands
// ---------------------------------------------------------------------------

export type DockerRunner = (
  dockerArguments: readonly string[],
  options?: { stdin?: string },
) => Promise<number>;

/** Run `docker` (or a stub binary in tests) with inherited output. */
export function createDockerRunner(binary = 'docker'): DockerRunner {
  return async (dockerArguments, options = {}) => {
    const child = Bun.spawn([binary, ...dockerArguments], {
      cwd: REPOSITORY_ROOT,
      stdin: options.stdin === undefined ? 'ignore' : Bun.file(options.stdin),
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return child.exited;
  };
}

/** Docker's daemon architecture, normalized to Node's `process.arch` names. */
export function normalizeDockerArchitecture(architecture: string): string {
  const normalized = architecture.trim().toLowerCase();
  if (normalized === 'aarch64' || normalized === 'arm64') return 'arm64';
  if (normalized === 'x86_64' || normalized === 'amd64') return 'x64';
  return normalized;
}

export function readDockerArchitecture(): string | undefined {
  const result = Bun.spawnSync(['docker', 'info', '--format', '{{.Architecture}}']);
  if (result.exitCode !== 0) return undefined;
  const architecture = normalizeDockerArchitecture(result.stdout.toString());
  return architecture.length > 0 ? architecture : undefined;
}

/** The renderer is native arm64; an emulated daemon would render, and time out, differently. */
export function dockerArchitectureProblem(architecture: string | undefined): string | undefined {
  if (architecture === REQUIRED_BASELINE_ARCHITECTURE) return undefined;
  return `Refusing to start: the Docker daemon is ${architecture ?? '<unavailable>'}, but the baseline renderer is native ${REQUIRED_BASELINE_ARCHITECTURE} (COR-1512). Emulation renders different pixels and times out behavioural specs.`;
}

/** `docker build` arguments; the Dockerfile is the whole context, read from stdin. */
export function dockerBuildArguments(pins: RepositoryPins, imageTag: string): string[] {
  return [
    'build',
    '--platform',
    DOCKER_PLATFORM,
    '--build-arg',
    `PLAYWRIGHT_VERSION=${pins.playwrightVersion}`,
    '--build-arg',
    `BUN_VERSION=${pins.bunVersion}`,
    '--tag',
    imageTag,
    '-',
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export type ContainerMode = 'update' | 'visual';

export const PLAYWRIGHT_REPORTERS = '--reporter=line,json';

/**
 * The command the container runs. It unpacks the archived commit from stdin,
 * installs from the lockfile, runs the suite, and copies results into `/out`
 * owned by the host user. The suite's exit status is captured before the copy
 * and returned verbatim, so a red suite never exits 0.
 */
export function containerCommand(mode: ContainerMode, extraArguments: readonly string[]): string {
  const script = mode === 'update' ? 'test:browser:update' : 'test:browser:visual';
  // The JSON reporter writes to PLAYWRIGHT_JSON_OUTPUT_FILE (/out/results.json) so the
  // host can name each failure and tell screenshot failures from behavioural ones.
  const forwarded = ` -- ${[PLAYWRIGHT_REPORTERS, ...extraArguments].map(shellQuote).join(' ')}`;
  // `--update-snapshots=all` does not rewrite a baseline that already matches within
  // tolerance, so an update first removes every Linux baseline: each one a test uses is
  // then written fresh, and a committed baseline nothing writes is a true orphan.
  const wipe =
    mode === 'update' ? ` && find ${LINUX_BASELINE_DIRECTORY} -name '*.png' -delete` : '';
  return [
    `mkdir -p /work && cd /work && tar -x && bun install --frozen-lockfile${wipe} && touch /tmp/baseline-marker && bun run ${script}${forwarded}`,
    'status=$?',
    `find ${LINUX_BASELINE_DIRECTORY} -name '*.png' -newer /tmp/baseline-marker > /out/regenerated.txt 2>/dev/null`,
    `mkdir -p /out/linux && cp -R ${LINUX_BASELINE_DIRECTORY}/. /out/linux/ 2>/dev/null`,
    'if [ -d scripts/browser-fixtures/test-results ]; then cp -R scripts/browser-fixtures/test-results /out/test-results; fi',
    'cp scripts/browser-fixtures/.playwright/manifest.json /out/manifest.json 2>/dev/null',
    'chown -R "$BASELINE_HOST_UID:$BASELINE_HOST_GID" /out 2>/dev/null',
    'exit $status',
  ].join('; ');
}

export type DockerRunOptions = {
  containerName: string;
  imageTag: string;
  outputDirectory: string;
  command: string;
  environment: Readonly<Record<string, string | undefined>>;
};

export function dockerRunArguments(options: DockerRunOptions): string[] {
  const dockerArguments = [
    'run',
    '--interactive',
    '--rm',
    '--init',
    '--name',
    options.containerName,
    '--platform',
    DOCKER_PLATFORM,
  ];
  for (const [name, value] of Object.entries(options.environment)) {
    if (value !== undefined && value.length > 0) dockerArguments.push('--env', `${name}=${value}`);
  }
  dockerArguments.push(
    '--volume',
    `${options.outputDirectory}:/out`,
    options.imageTag,
    options.command,
  );
  return dockerArguments;
}

export function hostOwnershipEnvironment(
  processHandle: Pick<typeof process, 'getuid' | 'getgid'> = process,
): Record<string, string> {
  if (typeof processHandle.getuid !== 'function' || typeof processHandle.getgid !== 'function') {
    return {};
  }
  return {
    BASELINE_HOST_UID: String(processHandle.getuid()),
    BASELINE_HOST_GID: String(processHandle.getgid()),
  };
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

export type TerminationDependencies = {
  docker: DockerRunner;
  waitForRunExit: () => Promise<number>;
};

/**
 * On SIGINT or SIGTERM, kill the named container, wait for `docker run` to
 * exit, and return the conventional `128 + signal` status (130 or 143).
 */
export async function terminateContainer(
  signal: 'SIGINT' | 'SIGTERM',
  containerName: string,
  dependencies: TerminationDependencies,
): Promise<number> {
  await dependencies.docker(['kill', containerName]);
  await dependencies.waitForRunExit();
  return 128 + constants.signals[signal];
}

/**
 * Run a container. If this process receives SIGINT or SIGTERM meanwhile, kill
 * the container and return `128 + signal`, so the caller exits without
 * applying anything from an interrupted run.
 */
export async function runContainerWithCleanup(
  docker: DockerRunner,
  runArguments: readonly string[],
  containerName: string,
  stdinPath: string,
  signals: Pick<NodeJS.Process, 'once' | 'off'> = process,
): Promise<number> {
  const run = docker(runArguments, { stdin: stdinPath });
  let termination: Promise<number> | undefined;
  const handle = (signal: 'SIGINT' | 'SIGTERM') => {
    termination ??= terminateContainer(signal, containerName, {
      docker,
      waitForRunExit: () => run,
    });
  };
  const onInterrupt = () => handle('SIGINT');
  const onTerminate = () => handle('SIGTERM');
  signals.once('SIGINT', onInterrupt);
  signals.once('SIGTERM', onTerminate);
  try {
    const exitCode = await run;
    return termination === undefined ? exitCode : await termination;
  } finally {
    signals.off('SIGINT', onInterrupt);
    signals.off('SIGTERM', onTerminate);
  }
}

// ---------------------------------------------------------------------------
// Source archive and workspace
// ---------------------------------------------------------------------------

export function resolveCommit(reference: string): string {
  const result = Bun.spawnSync(['git', 'rev-parse', '--verify', `${reference}^{commit}`], {
    cwd: REPOSITORY_ROOT,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Cannot resolve ${reference} to a commit: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

/** Write `git archive <sha>` (optionally limited to paths) to a tar file. */
export function archiveCommit(sha: string, tarPath: string, paths: readonly string[] = []): void {
  const result = Bun.spawnSync(
    ['git', 'archive', '--format=tar', `--output=${tarPath}`, sha, ...paths],
    { cwd: REPOSITORY_ROOT },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git archive ${sha} failed: ${result.stderr.toString().trim()}`);
  }
}

export function extractArchive(tarPath: string, destination: string): void {
  const result = Bun.spawnSync(['tar', '-x', '-f', tarPath, '-C', destination]);
  if (result.exitCode !== 0) {
    throw new Error(`Extracting ${tarPath} failed: ${result.stderr.toString().trim()}`);
  }
}

/**
 * Extract `git archive <sha>` (limited to paths) into `destination` by way of `tarPath`, then
 * delete the tar file whether or not extraction succeeded. The run directory that holds it is kept
 * for review, and the archive is only an input.
 */
export function extractCommitArchive(
  sha: string,
  tarPath: string,
  paths: readonly string[],
  destination: string,
): void {
  try {
    archiveCommit(sha, tarPath, paths);
    extractArchive(tarPath, destination);
  } finally {
    rmSync(tarPath, { force: true });
  }
}

export async function createRunDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(environmentConfiguration().tmpdir ?? tmpdir(), prefix));
}

export function containerNameForRun(now: number = Date.now(), pid: number = process.pid): string {
  return `corvidae-baselines-${now}-${pid}`;
}

/**
 * Copy the refreshed baselines into the host tree, write `provenance`, and delete the
 * orphans the caller names (committed baselines no test regenerated). The caller decides
 * the provenance: a full run's own record, or the working tree's full-run record with a
 * scoped run's component renders merged in (COR-1574). Nothing else is touched.
 */
export async function applyBaselines(
  sourceDirectory: string,
  targetDirectory: string,
  relativePaths: readonly string[],
  deletions: readonly string[],
  provenance: BaselineProvenance,
): Promise<void> {
  for (const path of relativePaths) {
    const target = join(targetDirectory, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(sourceDirectory, path), target);
  }
  await writeBaselineProvenance(join(targetDirectory, PROVENANCE_FILE_NAME), provenance);
  for (const path of deletions) await rm(join(targetDirectory, path), { force: true });
}

/** Split the wrapper's own flags from the arguments forwarded to Playwright. */
export function parseWrapperArguments(dockerArguments: readonly string[]): {
  source: string;
  acceptBehaviouralFailures: boolean;
  forwarded: string[];
} {
  let source = 'HEAD';
  let acceptBehaviouralFailures = false;
  const forwarded: string[] = [];
  for (let index = 0; index < dockerArguments.length; index += 1) {
    const argument = dockerArguments[index] ?? '';
    if (argument === '--accept-behavioural-failures') acceptBehaviouralFailures = true;
    else if (argument === '--source') {
      const value = dockerArguments[index + 1];
      if (value === undefined) throw new Error('--source needs a commit reference.');
      source = value;
      index += 1;
    } else if (argument.startsWith('--source=')) source = argument.slice('--source='.length);
    else forwarded.push(argument);
  }
  return { source, acceptBehaviouralFailures, forwarded };
}
