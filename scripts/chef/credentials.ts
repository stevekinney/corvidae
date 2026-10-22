#!/usr/bin/env bun
// Chef credentials: finds a credential and hands it to a command without ever showing it, so a
// run needs no personal wrapper script and a teammate's machine behaves like the owner's.
//
// Lookup order for a variable NAME:
//   1. the environment;
//   2. the macOS Keychain (`security find-generic-password -s <service> -a NAME -w`), only on
//      macOS and only when `security` exists;
//   3. a `.env` file in the current worktree's root;
//   4. a `.env` file in the main checkout's root (the parent of Git's common directory);
//   5. unavailable.
//
// A value is usable only when it is printable ASCII with no whitespace and no control character.
// Anything else (a trailing newline, curly quotes pasted into a `.env`, a NUL) would make the HTTP
// or spawn layer reject it with an error message that quotes the whole value, so the resolver
// treats that source as holding nothing, goes on to the next one, and names only the source it
// rejected. No error raised on a path that handles a value reports its message (`describeError`).
//
// Bun loads `.env` from the current directory into `process.env` before any script runs, and no
// setting scoped to these scripts turns that off: `bun --no-env-file` is a flag of the `bun`
// command, and `env = false` in `bunfig.toml` would change every script in the repository. So a
// value that came from `./.env` is reported as `environment`, not `.env:<path>`, when the script
// runs from a directory that holds one. The value and its precedence are unchanged; only the label
// differs. Pass `--no-env-file` to `bun` (`bun --no-env-file scripts/chef/credentials.ts ...`) to
// see the true source.
//
// Usage:
//   bun scripts/chef/credentials.ts resolve <NAME> [--keychain-service <service>] [--json]
//   bun scripts/chef/credentials.ts exec <NAME> [--keychain-service <service>] -- <command...>
//
// `resolve` prints where the value comes from: `environment`, `keychain`, `.env:<path>` or
// `unavailable`. It never prints the value. `exec` sets NAME for the command that follows `--`,
// inherits its standard streams and exits with the command's code, or with 3 when the value is
// unavailable. The value never reaches an output line, an error message or a log.
//
// Default Keychain services: TYPESAFE_API_KEY -> typesafe-api, LINEAR_API_KEY -> linear-api,
// ANTHROPIC_API_KEY -> anthropic-api, TURBO_TOKEN -> turborepo-remote-cache. The account is the
// variable name.
//
// Exit codes: `resolve` 0 found, 1 not found; `exec` the command's code, or 3 when the value is
// unavailable; 2 invalid CLI usage.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rootScriptEnvironment } from '../environment-configuration.ts';
import {
  defaultRunner,
  describeError,
  emitResult,
  parseOptions,
  type Runner,
  UsageError,
} from './process-runner.ts';
import { resolveMainCheckout, resolveWorktreeRoot } from './repository-locations.ts';

export const defaultKeychainServices: Readonly<Record<string, string>> = {
  TYPESAFE_API_KEY: 'typesafe-api',
  LINEAR_API_KEY: 'linear-api',
  ANTHROPIC_API_KEY: 'anthropic-api',
  TURBO_TOKEN: 'turborepo-remote-cache',
};

/** `unavailable`, `environment`, `keychain`, or `.env:<path>`. */
export type CredentialSource = 'environment' | 'keychain' | 'unavailable' | `.env:${string}`;

export interface Resolution {
  source: CredentialSource;
  /** Held in memory for the caller to pass on; no function in this module prints or logs it. */
  value: string | undefined;
  /** Sources that held a value that is not printable ASCII and were skipped; absent when none. */
  rejected?: CredentialSource[];
}

/** Whether `value` is printable ASCII with no whitespace or control character: safe in a header. */
export function isUsableValue(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value);
}

export interface CredentialDependencies {
  environment: Record<string, string | undefined>;
  runner: Runner;
  platform: string;
  /** Whether the `security` program exists. */
  hasSecurity: () => boolean;
  /** The text of a file, or `undefined` when it cannot be read. */
  readFile: (path: string) => string | undefined;
  /** The current worktree's root and the main checkout; `undefined` outside a Git repository. */
  worktreeRoot: () => string | undefined;
  mainCheckout: () => string | undefined;
}

function attempt(find: () => string): string | undefined {
  try {
    return find();
  } catch (error) {
    if (error instanceof UsageError) return undefined;
    throw error;
  }
}

export function defaultCredentialDependencies(): CredentialDependencies {
  return {
    environment: rootScriptEnvironment(),
    runner: defaultRunner,
    platform: process.platform,
    hasSecurity: () => Bun.which('security') !== null,
    readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
    worktreeRoot: () => attempt(() => resolveWorktreeRoot()),
    mainCheckout: () => attempt(() => resolveMainCheckout()),
  };
}

/**
 * Parse a `.env` file: `KEY=value` and `export KEY=value` lines, `#` comment lines, single quotes
 * (literal), double quotes (with `\n`, `\"`, `\\` and `\$` escapes) and a trailing ` # comment`
 * after an unquoted value. A line that is none of these is skipped.
 */
export function parseEnvironmentFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const [, key, rest] = match as unknown as [string, string, string];
    values[key] = parseValue(rest);
  }
  return values;
}

function parseValue(rest: string): string {
  const quote = rest[0];
  if (quote === "'") {
    const end = rest.indexOf("'", 1);
    return end === -1 ? rest.slice(1) : rest.slice(1, end);
  }
  if (quote === '"') {
    let value = '';
    for (let index = 1; index < rest.length; index += 1) {
      const character = rest[index] ?? '';
      if (character === '"') return value;
      if (character === '\\' && index + 1 < rest.length) {
        index += 1;
        const escaped = rest[index] ?? '';
        value += escaped === 'n' ? '\n' : escaped;
      } else {
        value += character;
      }
    }
    return value;
  }
  // A comment starts at a `#` that begins the value or follows whitespace; `b#c` is one token.
  const comment = /(?:^|\s)#/.exec(rest);
  return (comment === null ? rest : rest.slice(0, comment.index)).trim();
}

function validateName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new UsageError(`${name} is not a valid environment variable name.`);
}

/** Look NAME up in the documented order. Never throws for an unavailable value. */
export function resolveCredential(
  name: string,
  options: { keychainService?: string | undefined } = {},
  partial: Partial<CredentialDependencies> = {},
): Resolution {
  validateName(name);
  const dependencies = { ...defaultCredentialDependencies(), ...partial };
  const rejected: CredentialSource[] = [];
  const extra = () => (rejected.length === 0 ? {} : { rejected });
  /** The value when it is usable; otherwise the source is recorded as rejected, by name only. */
  const usable = (source: CredentialSource, value: string | undefined): string | undefined => {
    if (value === undefined || value === '') return undefined;
    if (isUsableValue(value)) return value;
    rejected.push(source);
    return undefined;
  };

  const fromEnvironment = usable('environment', dependencies.environment[name]);
  if (fromEnvironment !== undefined)
    return { source: 'environment', value: fromEnvironment, ...extra() };

  const service = options.keychainService ?? defaultKeychainServices[name];
  if (service !== undefined && dependencies.platform === 'darwin' && dependencies.hasSecurity()) {
    const result = dependencies.runner([
      'security',
      'find-generic-password',
      '-s',
      service,
      '-a',
      name,
      '-w',
    ]);
    const value = usable('keychain', result.code === 0 ? result.stdout.trim() : undefined);
    if (value !== undefined) return { source: 'keychain', value, ...extra() };
  }

  const roots: string[] = [];
  for (const root of [dependencies.worktreeRoot(), dependencies.mainCheckout()]) {
    if (root !== undefined && !roots.includes(root)) roots.push(root);
  }
  for (const root of roots) {
    const path = join(root, '.env');
    const text = dependencies.readFile(path);
    if (text === undefined) continue;
    const source: CredentialSource = `.env:${path}`;
    const value = usable(source, parseEnvironmentFile(text)[name]);
    if (value !== undefined) return { source, value, ...extra() };
  }
  return { source: 'unavailable', value: undefined, ...extra() };
}

/** Why a resolution skipped sources, for a message: names the sources, never the values. */
export function describeRejected(resolution: Resolution): string {
  const sources = resolution.rejected ?? [];
  return sources.length === 0
    ? ''
    : `the value in ${sources.join(' and ')} is not printable ASCII without whitespace, so it was ignored`;
}

export interface CredentialRunDependencies extends CredentialDependencies {
  /** Run a command with the given extra environment and inherited streams; return its exit code. */
  execute: (command: string[], environment: Record<string, string>) => number;
}

type Spawn = (
  command: string[],
  options: Parameters<typeof Bun.spawnSync>[1],
) => { exitCode: number | null };

/**
 * Run a command with `environment` added to this process's, inheriting its streams. `Bun.spawnSync`
 * can quote a rejected environment value in the error it throws, so a failure is reported by the
 * error's name and code and the exit code is 127.
 */
export function createExecute(
  spawn: Spawn = (command, options) => Bun.spawnSync(command, options),
  writeError: (text: string) => unknown = (text) => process.stderr.write(text),
): (command: string[], environment: Record<string, string>) => number {
  return (command, environment) => {
    try {
      const result = spawn(command, {
        env: { ...rootScriptEnvironment(), ...environment },
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      });
      return result.exitCode ?? 1;
    } catch (error) {
      writeError(`could not run ${command[0] ?? 'the command'} (${describeError(error)})\n`);
      return 127;
    }
  };
}

const defaultExecute = createExecute();

export function run(
  argv: string[],
  partial: Partial<CredentialRunDependencies> = {},
): { code: number; output: string } {
  const [command, ...rest] = argv;
  if (command !== 'resolve' && command !== 'exec')
    throw new UsageError('Usage: credentials.ts resolve|exec <NAME> ...');
  const separator = rest.indexOf('--');
  if (command === 'resolve' && separator !== -1)
    throw new UsageError('resolve takes no command; use exec to run one.');
  if (command === 'exec' && separator === -1)
    throw new UsageError('exec needs `--` followed by the command to run.');
  const optionArguments = separator === -1 ? rest : rest.slice(0, separator);
  const parsed = parseOptions(optionArguments, {
    values: ['keychain-service'],
    flags: command === 'resolve' ? ['json'] : [],
  });
  const [name, ...extra] = parsed.positionals;
  if (name === undefined || extra.length > 0)
    throw new UsageError(`Usage: credentials.ts ${command} <NAME> [--keychain-service <service>]`);
  const keychainService = parsed.values['keychain-service'];
  const resolution = resolveCredential(name, { keychainService }, partial);

  if (command === 'resolve') {
    const found = resolution.source !== 'unavailable';
    const rejected = resolution.rejected ?? [];
    return {
      code: found ? 0 : 1,
      output: parsed.flags.has('json')
        ? JSON.stringify({
            name,
            source: resolution.source,
            found,
            ...(rejected.length === 0 ? {} : { rejected }),
          })
        : found || rejected.length === 0
          ? resolution.source
          : `${resolution.source} (${describeRejected(resolution)})`,
    };
  }

  const program = rest.slice(separator + 1);
  if (program.length === 0) throw new UsageError('exec needs a command after `--`.');
  if (resolution.value === undefined)
    return {
      code: 3,
      output: [
        `${name} is unavailable: checked the environment, the Keychain and .env files.`,
        describeRejected(resolution),
      ]
        .filter((line) => line !== '')
        .join(' '),
    };
  const execute = partial.execute ?? defaultExecute;
  return { code: execute(program, { [name]: resolution.value }), output: '' };
}

if (import.meta.main) {
  try {
    const { code, output } = run(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
