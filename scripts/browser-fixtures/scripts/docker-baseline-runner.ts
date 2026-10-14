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
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { constants, cpus, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { environmentConfiguration } from '../environment-configuration.ts';
import {
  BROWSER_FIXTURES_ROOT,
  LINUX_BASELINE_DIRECTORY,
  PROVENANCE_FILE_NAME,
  REPOSITORY_ROOT,
  REQUIRED_BASELINE_ARCHITECTURE,
  type RepositoryPins,
} from './baseline-provenance.ts';

export const DOCKER_PLATFORM = `linux/${REQUIRED_BASELINE_ARCHITECTURE}`;
export const DOCKERFILE_PATH = resolve(BROWSER_FIXTURES_ROOT, 'Dockerfile');
/** The host refuses to start a container above this multiple of its logical CPUs. */
export const LOAD_LIMIT_PER_CPU = 3;
export const LOAD_POLL_MILLISECONDS = 60_000;
export const LOAD_WAIT_LIMIT_MILLISECONDS = 3 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Host load gate
// ---------------------------------------------------------------------------

export type LoadReading = { load: number; limit: number; cpuCount: number };

export function readHostLoad(cpuCount: number = cpus().length): LoadReading {
  return { load: loadavg()[0] ?? 0, limit: cpuCount * LOAD_LIMIT_PER_CPU, cpuCount };
}

export type LoadGateDependencies = {
  readLoad: () => LoadReading;
  sleep: (milliseconds: number) => Promise<void>;
  log: (message: string) => void;
};

export type LoadGateResult =
  | { ok: true; waitedMilliseconds: number; reading: LoadReading }
  | { ok: false; waitedMilliseconds: number; reading: LoadReading; reason: string };

function describeLoad(reading: LoadReading): string {
  return `1-minute load ${reading.load.toFixed(2)} against a limit of ${reading.limit} (${LOAD_LIMIT_PER_CPU} x ${reading.cpuCount} logical CPUs)`;
}

/**
 * Refuse to start while the host is overloaded: a loaded host makes the suite's
 * behavioural timeouts fire for reasons unrelated to the code. Without
 * `wait`, refuse immediately. With it, poll every minute and give up (blocked)
 * after three hours. Suite timeouts are never raised instead.
 */
export async function waitForHostLoad(
  wait: boolean,
  dependencies: LoadGateDependencies,
): Promise<LoadGateResult> {
  let waited = 0;
  let reading = dependencies.readLoad();
  while (reading.load > reading.limit) {
    if (!wait) {
      return {
        ok: false,
        waitedMilliseconds: 0,
        reading,
        reason: `Refusing to start: ${describeLoad(reading)}. Retry later or pass --wait-for-load.`,
      };
    }
    if (waited >= LOAD_WAIT_LIMIT_MILLISECONDS) {
      return {
        ok: false,
        waitedMilliseconds: waited,
        reading,
        reason: `Blocked: the host stayed above the load limit for ${Math.round(waited / 60_000)} minutes (${describeLoad(reading)}).`,
      };
    }
    dependencies.log(`Waiting for host load: ${describeLoad(reading)}.`);
    await dependencies.sleep(LOAD_POLL_MILLISECONDS);
    waited += LOAD_POLL_MILLISECONDS;
    reading = dependencies.readLoad();
  }
  if (waited > 0) {
    dependencies.log(
      `Host load settled after ${Math.round(waited / 60_000)} minutes: ${describeLoad(reading)}.`,
    );
  }
  return { ok: true, waitedMilliseconds: waited, reading };
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

/**
 * The command the container runs. It unpacks the archived commit from stdin,
 * installs from the lockfile, runs the suite, and copies results into `/out`
 * owned by the host user. The suite's exit status is captured before the copy
 * and returned verbatim, so a red suite never exits 0.
 */
export function containerCommand(mode: ContainerMode, extraArguments: readonly string[]): string {
  const script = mode === 'update' ? 'test:browser:update' : 'test:browser:visual';
  const forwarded =
    extraArguments.length > 0 ? ` -- ${extraArguments.map(shellQuote).join(' ')}` : '';
  return [
    `mkdir -p /work && cd /work && tar -x && bun install --frozen-lockfile && touch /tmp/baseline-marker && bun run ${script}${forwarded}`,
    'status=$?',
    `find ${LINUX_BASELINE_DIRECTORY} -name '*.png' -newer /tmp/baseline-marker > /out/regenerated.txt 2>/dev/null`,
    `mkdir -p /out/linux && cp -R ${LINUX_BASELINE_DIRECTORY}/. /out/linux/ 2>/dev/null`,
    'if [ -d scripts/browser-fixtures/test-results ]; then cp -R scripts/browser-fixtures/test-results /out/test-results; fi',
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

export async function createRunDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(environmentConfiguration().tmpdir ?? tmpdir(), prefix));
}

export function containerNameForRun(now: number = Date.now(), pid: number = process.pid): string {
  return `corvidae-baselines-${now}-${pid}`;
}

/** Copy the refreshed baselines and provenance into the host tree; nothing else is touched. */
export async function applyBaselines(
  sourceDirectory: string,
  targetDirectory: string,
  relativePaths: readonly string[],
): Promise<void> {
  for (const path of [...relativePaths, PROVENANCE_FILE_NAME]) {
    const target = join(targetDirectory, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(sourceDirectory, path), target);
  }
}

/** Split the wrapper's own flags from the arguments forwarded to Playwright. */
export function parseWrapperArguments(dockerArguments: readonly string[]): {
  waitForLoad: boolean;
  source: string;
  forwarded: string[];
} {
  let waitForLoad = false;
  let source = 'HEAD';
  const forwarded: string[] = [];
  for (let index = 0; index < dockerArguments.length; index += 1) {
    const argument = dockerArguments[index] ?? '';
    if (argument === '--wait-for-load') waitForLoad = true;
    else if (argument === '--source') {
      const value = dockerArguments[index + 1];
      if (value === undefined) throw new Error('--source needs a commit reference.');
      source = value;
      index += 1;
    } else if (argument.startsWith('--source=')) source = argument.slice('--source='.length);
    else forwarded.push(argument);
  }
  return { waitForLoad, source, forwarded };
}
