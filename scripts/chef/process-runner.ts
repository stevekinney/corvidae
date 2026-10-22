#!/usr/bin/env bun
// Chef process runner: the one injectable seam the chef plumbing scripts use for every external
// command (`git`, `gh`, `pgrep`, `lsof`, a repository's gate command). A script takes a `Runner`
// and defaults to `defaultRunner`, so its tests substitute a fake and never reach a real
// repository, host or process. The module also holds the pieces every script shares: the
// `UsageError` that maps to exit 2, a shell-quoting helper, a small option parser, the
// `describeError` that keeps a credential out of a failure message, and `emitResult`, which decides
// whether a script's result goes to standard output or standard error.
//
// This module is a library; it has no command line.

import { constants as osConstants } from 'node:os';
import { rootScriptEnvironment } from '../environment-configuration.ts';

export class UsageError extends Error {}

export interface RunnerOptions {
  cwd?: string | undefined;
  input?: string | undefined;
  env?: Record<string, string> | undefined;
}

export interface RunnerResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (command: string[], options?: RunnerOptions) => RunnerResult;

/** The environment without its unset entries, which `Bun.spawnSync` does not accept. */
function definedEntries(environment: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/**
 * The exit code and standard error of a finished process. One killed by a signal has no exit code;
 * reporting it as exit 1 with nothing on standard error made a killed `lsof` look like "no process
 * found", so it is the shell's `128 + signal` with the signal named.
 */
function exitStatus(result: {
  exitCode: number | null;
  signalCode?: string | null;
  stderr: { toString(): string };
}): { code: number; stderr: string } {
  const stderr = result.stderr.toString();
  if (result.exitCode !== null) return { code: result.exitCode, stderr };
  const signal = result.signalCode ?? 'unknown';
  const number = (osConstants.signals as Record<string, number | undefined>)[signal] ?? 0;
  return { code: 128 + number, stderr: `${stderr}terminated by signal ${signal}\n` };
}

/**
 * Run `command` to completion with `Bun.spawnSync`. A command that cannot start (a missing
 * program, a missing working directory) is reported as exit 127 with the reason in `stderr`
 * rather than thrown, so callers have one failure path.
 */
export const defaultRunner: Runner = (command, options = {}) => {
  try {
    const result = Bun.spawnSync(command, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined
        ? {}
        : { env: definedEntries({ ...rootScriptEnvironment(), ...options.env }) }),
      stdin: options.input === undefined ? 'ignore' : Buffer.from(options.input),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      ...exitStatus(result),
      stdout: result.stdout.toString(),
    };
  } catch (error) {
    // `Bun.spawnSync` can put a rejected environment value in its message, and `options.env` may
    // carry a credential, so the failure is reported by name and code only.
    return {
      code: 127,
      stdout: '',
      stderr: `could not start the command (${describeError(error)})`,
    };
  }
};

/**
 * A failure described without its message, which can carry a secret: Bun's `Header
 * 'Authorization' has invalid value: '<the whole value>'` and a rejected spawn environment both
 * echo the value they refused. Only the error's name and, when it has one, its string `code` are
 * kept. Use this for any error raised on a path that handles a credential.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)
    ? `${error.name} ${code}`
    : error.name;
}

export interface ResultStreams {
  stdout: { write: (text: string) => unknown };
  stderr: { write: (text: string) => unknown };
}

/** Whether `--json` appears among the options of `argv`, ignoring a wrapped command after `--`. */
export function wantsJson(argv: string[]): boolean {
  const separator = argv.indexOf('--');
  return (separator === -1 ? argv : argv.slice(0, separator)).includes('--json');
}

/**
 * Write a script's result. With `--json` the result object goes to standard output whatever the
 * exit code, so a caller that parses it can read a failure the same way as a success; without
 * `--json` a non-zero result is a diagnostic and goes to standard error. Usage errors never come
 * through here: they stay on standard error with exit 2.
 */
export function emitResult(
  argv: string[],
  result: { code: number; output: string },
  streams: ResultStreams = process,
): void {
  if (result.output === '') return;
  const stream = result.code === 0 || wantsJson(argv) ? streams.stdout : streams.stderr;
  stream.write(`${result.output}\n`);
}

/** Quote `value` as one POSIX shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface OptionSpecification {
  /** Options that take one value; a later occurrence replaces an earlier one. */
  values?: string[];
  /** Options that take one value and may repeat. */
  repeated?: string[];
  /** Options that take no value. */
  flags?: string[];
}

export interface ParsedOptions {
  positionals: string[];
  values: Record<string, string>;
  repeated: Record<string, string[]>;
  flags: Set<string>;
}

/** Parse `argv` against `specification`; an unknown `--option` or a missing value is a `UsageError`. */
export function parseOptions(argv: string[], specification: OptionSpecification): ParsedOptions {
  const parsed: ParsedOptions = { positionals: [], values: {}, repeated: {}, flags: new Set() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (!argument.startsWith('--')) {
      parsed.positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (specification.flags?.includes(name)) {
      parsed.flags.add(name);
    } else if (specification.values?.includes(name) || specification.repeated?.includes(name)) {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError(`${argument} needs a value.`);
      index += 1;
      if (specification.repeated?.includes(name)) (parsed.repeated[name] ??= []).push(value);
      else parsed.values[name] = value;
    } else {
      throw new UsageError(`Unknown option ${argument}.`);
    }
  }
  return parsed;
}

/** The value of a required option, or a `UsageError` naming it. */
export function requireOption(parsed: ParsedOptions, name: string): string {
  const value = parsed.values[name];
  if (value === undefined || value === '') throw new UsageError(`--${name} is required.`);
  return value;
}
