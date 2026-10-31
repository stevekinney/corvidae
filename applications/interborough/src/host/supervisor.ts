/**
 * The supervisor behind `start` and `dev`: it runs the host as a child process and starts it again
 * each time it exits with {@link RESTART_EXIT_CODE}, which is how `POST /host/restart` works. Any
 * other exit ends the supervisor with the child's own code, so a crash is a crash and a signal
 * stops the whole tree.
 *
 * ```sh
 * bun src/host/supervisor.ts serve   # bun --no-install src/host/serve.ts   (`start`)
 * bun src/host/supervisor.ts dev     # bun --no-install --watch src/host/dev.ts   (`dev`)
 * bun src/host/supervisor.ts dev --plugin ./my-plugin   # the same, loading that plugin folder (COR-1881)
 * ```
 *
 * `serve` refuses to start without `build/index.html` (or the directory
 * `INTERBOROUGH_BUILD_DIRECTORY` names) and tells the person to run `bun run build`. `dev` builds
 * for itself. Under `bun --watch` the child's exit code is the code the host exited with, so the
 * supervisor sees the same code in both modes. A source change restarts the host inside
 * `bun --watch` without involving the supervisor.
 *
 * SIGINT and SIGTERM go to the child, and the supervisor exits once it has gone. A supervisor that
 * is killed outright (SIGKILL) cannot forward anything and leaves its child running.
 *
 * @module supervisor
 */

import { existsSync } from 'node:fs';
import { constants } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import { DEVELOPMENT_PLUGIN_FLAG } from './development-plugin-flag.ts';
import { processEnvironment, resolveBuildDirectory } from './environment-configuration.ts';
import { RESTART_EXIT_CODE } from './restart.ts';

/** The two ways to run the host: `serve` for production, `dev` for the watching development host. */
export type SupervisorMode = 'serve' | 'dev';

const HOST_DIRECTORY = import.meta.dir;

const PACKAGE_DIRECTORY = join(HOST_DIRECTORY, '..', '..');

/**
 * The command that runs the host in `mode`: Bun on the mode's entry (`serve.ts` or `dev.ts`, or
 * `entry` instead). `--no-install` keeps Bun from installing anything at start, so an import that
 * nothing provides fails instead of reaching a registry, and `dev` adds `--watch` and passes each
 * of `pluginPaths` to the entry as `--plugin <path>`.
 */
export function hostCommand(
  mode: SupervisorMode,
  entry?: string,
  pluginPaths: readonly string[] = [],
): string[] {
  const script = entry ?? join(HOST_DIRECTORY, mode === 'dev' ? 'dev.ts' : 'serve.ts');
  return mode === 'dev'
    ? [
        process.execPath,
        '--no-install',
        '--watch',
        script,
        ...pluginPaths.flatMap((path) => [DEVELOPMENT_PLUGIN_FLAG, path]),
      ]
    : [process.execPath, '--no-install', script];
}

/** The part of `process` the supervisor listens on, so a test can stand another emitter in for it. */
export type SupervisorSignals = {
  /** Listen for `signal`. */
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  /** Stop listening with `listener`. */
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

/** What {@link supervise} runs, and how it reports. */
export type SuperviseOptions = {
  /** The child's command. */
  readonly command: readonly string[];
  /** The child's working directory. Defaults to the package root, where `bunfig.toml` is. */
  readonly cwd?: string;
  /**
   * Checked before every start, the first included. A message ends the supervisor with exit code 1
   * and nothing started; `undefined` lets the start go ahead.
   */
  readonly prepare?: () => string | undefined;
  /** Receives the supervisor's progress lines. Defaults to `console.info`. */
  readonly log?: (message: string) => void;
  /** Receives the supervisor's error lines. Defaults to `console.error`. */
  readonly error?: (message: string) => void;
  /** Where SIGINT and SIGTERM are heard. Defaults to the process. */
  readonly signals?: SupervisorSignals;
};

/** The number of the signal that ended a child, or 0 when none did. */
function signalNumber(signal: NodeJS.Signals | number | null): number {
  if (signal === null) return 0;
  return typeof signal === 'number' ? signal : constants.signals[signal];
}

/**
 * Run `options.command` as a child, starting it again each time it exits with
 * {@link RESTART_EXIT_CODE}, and resolve with the exit code the supervisor should end with: the
 * child's own for any other exit. A child that a signal ended is the code `128 + signal`.
 *
 * SIGINT and SIGTERM are forwarded to the running child and stop the loop: a child that then exits
 * 75 (a restart racing the signal) or by that signal is a clean stop, exit code 0.
 */
export async function supervise(options: SuperviseOptions): Promise<number> {
  const log = options.log ?? ((message) => console.info(message));
  const error = options.error ?? ((message) => console.error(message));
  const signals = options.signals ?? process;
  let stopping = false;
  let child: Bun.Subprocess | undefined;
  const forward = (signal: 'SIGINT' | 'SIGTERM') => () => {
    stopping = true;
    child?.kill(signal);
  };
  const handlers = { SIGINT: forward('SIGINT'), SIGTERM: forward('SIGTERM') } as const;
  signals.on('SIGINT', handlers.SIGINT);
  signals.on('SIGTERM', handlers.SIGTERM);
  try {
    for (;;) {
      if (stopping) return 0;
      const problem = options.prepare?.();
      if (problem !== undefined) {
        error(problem);
        return 1;
      }
      const running = Bun.spawn([...options.command], {
        cwd: options.cwd ?? PACKAGE_DIRECTORY,
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      });
      child = running;
      log(`Started the host (process ${running.pid}).`);
      await running.exited;
      child = undefined;
      const signal = running.signalCode;
      const code = running.exitCode ?? 128 + signalNumber(signal);
      if (stopping) return code === RESTART_EXIT_CODE || signal !== null ? 0 : code;
      if (code !== RESTART_EXIT_CODE) return code;
      log('The host asked to restart. Starting it again.');
    }
  } finally {
    signals.off('SIGINT', handlers.SIGINT);
    signals.off('SIGTERM', handlers.SIGTERM);
  }
}

const USAGE =
  'Usage: bun src/host/supervisor.ts <serve|dev> [--entry <path>] [--plugin <path>]… (--plugin is for dev only)';

/**
 * Run the supervisor for the command line `bun src/host/supervisor.ts <serve|dev> [--entry
 * <path>] [--plugin <path>]…` and resolve with its exit code. `--entry` runs another module in
 * place of the mode's own entry, which is how the tests run a host of their own under the real
 * supervisor. `--plugin` (dev only, repeatable) names a plugin folder the development host loads
 * as a development source; a relative path is taken from the directory the command ran in.
 */
export async function runSupervisor(argumentsList: readonly string[]): Promise<number> {
  const [mode, ...rest] = argumentsList;
  let entry: string | undefined;
  const pluginPaths: string[] = [];
  let understood = mode === 'serve' || mode === 'dev';
  for (let index = 0; understood && index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) understood = false;
    else if (flag === '--entry' && entry === undefined) entry = value;
    else if (flag === DEVELOPMENT_PLUGIN_FLAG && mode === 'dev' && value !== '') {
      pluginPaths.push(resolvePath(value));
    } else understood = false;
  }
  if (!understood || (mode !== 'serve' && mode !== 'dev')) {
    console.error(USAGE);
    return 2;
  }
  const environment = processEnvironment();
  const command = hostCommand(mode, entry, pluginPaths);
  if (mode === 'dev') return supervise({ command });
  return supervise({
    command,
    prepare: () => {
      const page = join(resolveBuildDirectory(environment), 'index.html');
      return existsSync(page)
        ? undefined
        : `Interborough has not been built: ${page} does not exist. Run \`bun run build\` first.`;
    },
  });
}

if (import.meta.main) {
  // `exitCode`, not `process.exit`: Bun truncates piped standard error when the process exits
  // while it still has output to flush.
  process.exitCode = await runSupervisor(process.argv.slice(2));
}
