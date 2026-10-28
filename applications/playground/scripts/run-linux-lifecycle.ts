/**
 * Runs the static gate's lifecycle cases (`test:lifecycle`: the stand-in cases and the
 * real-Chromium case) on Linux, in two containers: once under `docker run --init`, where every
 * captured process must also have been reaped, and once without, where PID 1 is a shell.
 *
 *   bun applications/playground/scripts/run-linux-lifecycle.ts
 *
 * Each container starts from `mcr.microsoft.com/playwright:v1.63.0-noble` (matching the
 * installed `@playwright/test`), installs Bun 1.4.4 with its official installer, receives
 * `git archive HEAD` on stdin, runs `bun install --frozen-lockfile`, and runs the lifecycle
 * script. Only committed source reaches the container; the host's `node_modules` is never
 * mounted. The image digest, Bun version, and source SHA are printed for the evidence record.
 */
import { constants } from 'node:os';
import { join } from 'node:path';

import { exitedWithin } from './static-playground-processes.ts';

export const IMAGE = 'mcr.microsoft.com/playwright:v1.63.0-noble';
export const BUN_VERSION = '1.4.4';

const PLAYGROUND_ROOT = join(import.meta.dirname, '..');

export type ContainerMode = 'init' | 'no-init';

/** The shell program each container runs; the source tarball arrives on stdin. */
export function containerScript(): string {
  return [
    'set -euo pipefail',
    'mkdir /work && tar -x -C /work',
    'apt-get update -qq && apt-get install -y -qq unzip >/dev/null',
    `curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" >/dev/null`,
    'export PATH="$HOME/.bun/bin:$PATH"',
    'echo "[linux-lifecycle] bun $(bun --version) on $(uname -srm)"',
    'cd /work',
    'bun install --frozen-lockfile',
    'bun run --filter=@lostgradient/playground test:lifecycle',
  ].join('\n');
}

export function dockerArguments(mode: ContainerMode, name: string): string[] {
  return [
    'docker',
    'run',
    '--rm',
    '-i',
    '--name',
    name,
    // Chromium's shared memory needs more than Docker's default 64 MB /dev/shm.
    '--ipc=host',
    ...(mode === 'init' ? ['--init', '-e', 'PLAYGROUND_LIFECYCLE_REQUIRE_REAPED=1'] : []),
    IMAGE,
    'bash',
    '-c',
    containerScript(),
  ];
}

function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: PLAYGROUND_ROOT, stdout: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return result.stdout.toString().trim();
}

/** Ceilings no healthy run reaches; a run that hits one is stopped and fails. */
const PULL_MILLISECONDS = 15 * 60_000;
const MODE_MILLISECONDS = 30 * 60_000;

/** The process's SIGINT and SIGTERM, as the recipe observes them. */
export type SignalWatch = {
  received(): NodeJS.Signals | undefined;
  subscribe(listener: (signal: NodeJS.Signals) => void): () => void;
};

/** How long a step stopped by SIGTERM has to exit before it is killed. */
const STOP_GRACE_MILLISECONDS = 5_000;

/**
 * Run a preliminary step such as `docker pull`, stopping it as soon as a signal arrives instead of
 * letting it finish first: SIGTERM, then SIGKILL after the grace period. A step never starts once a
 * signal has arrived. The caller maps the signal to its exit status with {@link pullExitStatus}.
 */
export async function runInterruptibly(
  command: string[],
  milliseconds: number,
  signals: SignalWatch,
): Promise<number> {
  if (signals.received() !== undefined) return 1;
  const child = Bun.spawn(command, { stdio: ['ignore', 'inherit', 'inherit'] });
  let stopping = false;
  const unsubscribe = signals.subscribe(() => {
    if (stopping) return;
    stopping = true;
    child.kill('SIGTERM');
    void (async () => {
      if ((await exitedWithin(child, STOP_GRACE_MILLISECONDS)) === undefined) child.kill('SIGKILL');
    })();
  });
  try {
    const status = await exitedWithin(child, milliseconds);
    if (status !== undefined) return status;
    child.kill('SIGKILL');
    await child.exited;
    process.stderr.write(`[linux-lifecycle] ${command.join(' ')} exceeded ${milliseconds} ms\n`);
    return 1;
  } finally {
    unsubscribe();
  }
}

/**
 * The recipe's exit status after the image pull, or `undefined` to go on to the container modes:
 * `128 + n` when signal `n` arrived during the pull, as {@link recipeExitStatus} reports one during
 * a mode, and 1 when the pull itself failed.
 */
export function pullExitStatus(
  status: number,
  signal: NodeJS.Signals | undefined,
): number | undefined {
  if (signal !== undefined) return recipeExitStatus([], signal, 0);
  return status === 0 ? undefined : 1;
}

async function runMode(mode: ContainerMode): Promise<number> {
  const name = `static-playground-lifecycle-${mode}-${process.pid}`;
  const archive = Bun.spawn(['git', 'archive', '--format=tar', 'HEAD'], {
    cwd: git(['rev-parse', '--show-toplevel']),
    stdout: 'pipe',
  });
  const container = Bun.spawn(dockerArguments(mode, name), {
    stdin: archive.stdout,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const stop = () => {
    Bun.spawnSync(['docker', 'rm', '-f', name], { stdout: 'ignore', stderr: 'ignore' });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const [archiveStatus, status] = await Promise.all([
      exitedWithin(archive, MODE_MILLISECONDS),
      exitedWithin(container, MODE_MILLISECONDS),
    ]);
    if (archiveStatus === undefined || status === undefined) {
      stop();
      archive.kill('SIGKILL');
      process.stderr.write(`[linux-lifecycle] ${mode} exceeded ${MODE_MILLISECONDS} ms\n`);
      return 1;
    }
    return archiveStatus === 0 ? status : 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

export type ModeResult = [mode: ContainerMode, status: number];

/**
 * Run each container mode in turn, stopping before the next one once a signal has arrived. A
 * Ctrl-C during the first mode stops that container (see `runMode`) and must not then start the
 * second.
 */
export async function runContainerModes(
  modes: readonly ContainerMode[],
  runOne: (mode: ContainerMode) => Promise<number>,
  receivedSignal: () => NodeJS.Signals | undefined,
): Promise<ModeResult[]> {
  const results: ModeResult[] = [];
  for (const mode of modes) {
    if (receivedSignal() !== undefined) break;
    process.stdout.write(`[linux-lifecycle] running the lifecycle cases (${mode})\n`);
    results.push([mode, await runOne(mode)]);
  }
  return results;
}

/** `128 + n` when signal `n` interrupted the run, otherwise 0 only when every mode passed. */
export function recipeExitStatus(
  results: readonly ModeResult[],
  signal: NodeJS.Signals | undefined,
  expectedModes: number,
): number {
  if (signal !== undefined) return 128 + constants.signals[signal];
  return results.length === expectedModes && results.every(([, status]) => status === 0) ? 0 : 1;
}

async function main(): Promise<void> {
  let received: NodeJS.Signals | undefined;
  const listeners = new Set<(signal: NodeJS.Signals) => void>();
  const onSignal = (signal: NodeJS.Signals): void => {
    received ??= signal;
    for (const listener of listeners) listener(signal);
  };
  const signals: SignalWatch = {
    received: () => received,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const sha = git(['rev-parse', 'HEAD']);
  if (git(['status', '--porcelain']) !== '') {
    process.stderr.write('[linux-lifecycle] the tree is dirty; only HEAD is tested\n');
  }
  const pulled = await runInterruptibly(
    ['docker', 'pull', '--quiet', IMAGE],
    PULL_MILLISECONDS,
    signals,
  );
  const stopped = pullExitStatus(pulled, received);
  if (stopped !== undefined) {
    process.stderr.write(
      received === undefined
        ? '[linux-lifecycle] docker pull failed\n'
        : `[linux-lifecycle] interrupted by ${received} during docker pull; no mode ran\n`,
    );
    process.exitCode = stopped;
    return;
  }
  const digest = Bun.spawnSync(
    ['docker', 'image', 'inspect', '--format', '{{index .RepoDigests 0}}', IMAGE],
    { stdout: 'pipe' },
  )
    .stdout.toString()
    .trim();
  process.stdout.write(`[linux-lifecycle] source ${sha}, image ${digest}, bun ${BUN_VERSION}\n`);
  const modes = ['init', 'no-init'] as const;
  const results = await runContainerModes(modes, runMode, () => received);
  for (const [mode, status] of results) {
    process.stdout.write(`[linux-lifecycle] ${mode}: exit ${status}\n`);
  }
  if (received !== undefined) {
    process.stderr.write(`[linux-lifecycle] interrupted by ${received}; remaining modes skipped\n`);
  }
  process.exitCode = recipeExitStatus(results, received, modes.length);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
