/**
 * The terminal command this host was launched with (COR-2009, `host:restart`). A restart that never
 * comes back leaves the page with one useful instruction: start Interborough again from the
 * terminal. The page cannot ask the host for that command once the host has stopped, so the
 * supervisor works it out once, when it starts, and hands it to every host it runs through
 * {@link LAUNCH_COMMAND_VARIABLE} and {@link LAUNCH_DIRECTORY_VARIABLE}. The host serves it on
 * `GET /host/restart`, which the page reads while the host still answers.
 *
 * The command is the one the person typed, as far as the process can tell:
 *
 * - Started through a package script (`bun run start`, `bun run dev --showcase`), Bun sets
 *   `npm_lifecycle_event` to the script's name and `npm_lifecycle_script` to its text. When that
 *   text is the command this process is running, the command is `bun run <script>` followed by any
 *   arguments given after the script's own, in the package's directory.
 * - Otherwise (`bun src/host/supervisor.ts serve`), it is Bun on the script, by its path from the
 *   working directory, with the arguments the process was given, in the working directory.
 *
 * Each argument that holds anything but plain characters is quoted for a POSIX shell, so the
 * command can be pasted as it is.
 *
 * @module launch-command
 */

import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type { BungalowEnvironment } from '@lostgradient/bungalow';

/** The environment variable the supervisor hands each host the launch command in. */
export const LAUNCH_COMMAND_VARIABLE = 'INTERBOROUGH_LAUNCH_COMMAND';

/** The environment variable the supervisor hands each host the launch command's directory in. */
export const LAUNCH_DIRECTORY_VARIABLE = 'INTERBOROUGH_LAUNCH_DIRECTORY';

/** The command that starts this host again, and the directory to run it in. */
export type LaunchCommand = {
  /** The command as a person types it, such as `bun run start`. */
  readonly command: string;
  /** The directory the command runs in: the package's for a package script, else the working directory. */
  readonly directory: string;
};

/** What {@link deriveLaunchCommand} reads: the process's environment, arguments and working directory. */
export type LaunchProcess = {
  /** The process environment, read for Bun's `npm_lifecycle_*` and `npm_package_json`. */
  readonly environment: BungalowEnvironment;
  /** The process's arguments as `process.argv` holds them: Bun, the script, then its arguments. */
  readonly argv: readonly string[];
  /** The working directory. */
  readonly cwd: string;
};

/** An argument as a POSIX shell reads it back: left alone when plain, else in single quotes. */
export function shellQuote(argument: string): string {
  if (/^[\w%+,./:=@-]+$/.test(argument)) return argument;
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

function present(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/**
 * `bun run <script>` with the arguments given after the script's own, when the package script Bun
 * reports is the command this process runs; `undefined` when there is none or it is another
 * process's (an outer script that ran this one directly).
 */
function packageScriptCommand(running: LaunchProcess): LaunchCommand | undefined {
  const event = present(running.environment['npm_lifecycle_event']);
  const script = present(running.environment['npm_lifecycle_script']);
  const packageJson = present(running.environment['npm_package_json']);
  const [, entry, ...given] = running.argv;
  if (event === undefined || script === undefined || packageJson === undefined) return undefined;
  if (entry === undefined) return undefined;
  const directory = dirname(packageJson);
  const [, scriptEntry, ...scriptArguments] = script.trim().split(/\s+/);
  if (scriptEntry === undefined || resolve(directory, scriptEntry) !== resolve(entry)) {
    return undefined;
  }
  if (scriptArguments.some((argument, index) => given[index] !== argument)) return undefined;
  const extra = given.slice(scriptArguments.length);
  return {
    command: ['bun', 'run', event, ...extra].map(shellQuote).join(' '),
    directory,
  };
}

/** The script's path from `cwd` when it lies under it, else the path as given. */
function scriptPath(entry: string, cwd: string): string {
  const fromCwd = relative(cwd, resolve(cwd, entry));
  return fromCwd === '' || fromCwd.startsWith('..') || isAbsolute(fromCwd) ? entry : fromCwd;
}

/** The command that starts the process described by `running` again. See the module comment. */
export function deriveLaunchCommand(running: LaunchProcess): LaunchCommand {
  const fromScript = packageScriptCommand(running);
  if (fromScript !== undefined) return fromScript;
  const [, entry, ...given] = running.argv;
  const script = entry === undefined ? [] : [scriptPath(entry, running.cwd)];
  return {
    command: ['bun', ...script, ...given].map(shellQuote).join(' '),
    directory: running.cwd,
  };
}

/** The variables that hand `launch` to a host, for the environment of the process that runs it. */
export function launchCommandEnvironment(launch: LaunchCommand): Record<string, string> {
  return {
    [LAUNCH_COMMAND_VARIABLE]: launch.command,
    [LAUNCH_DIRECTORY_VARIABLE]: launch.directory,
  };
}

/**
 * The launch command the supervisor handed this host, or `undefined` for a host no supervisor
 * started (a test, or `serve.ts` run by hand), which has no command to report.
 */
export function resolveLaunchCommand(environment: BungalowEnvironment): LaunchCommand | undefined {
  const command = present(environment[LAUNCH_COMMAND_VARIABLE]);
  const directory = present(environment[LAUNCH_DIRECTORY_VARIABLE]);
  return command === undefined || directory === undefined ? undefined : { command, directory };
}
