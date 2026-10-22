#!/usr/bin/env bun
// Chef process runner: the one injectable seam the chef plumbing scripts use for every external
// command (`git`, `gh`, `pgrep`, `lsof`, a repository's gate command). A script takes a `Runner`
// and defaults to `defaultRunner`, so its tests substitute a fake and never reach a real
// repository, host or process. The module also holds the pieces every script shares: the
// `UsageError` that maps to exit 2, a shell-quoting helper, and a small option parser.
//
// This module is a library; it has no command line.

export class UsageError extends Error {}

export interface RunnerOptions {
  cwd?: string;
  input?: string;
  env?: Record<string, string>;
}

export interface RunnerResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (command: string[], options?: RunnerOptions) => RunnerResult;

/**
 * Run `command` to completion with `Bun.spawnSync`. A command that cannot start (a missing
 * program, a missing working directory) is reported as exit 127 with the reason in `stderr`
 * rather than thrown, so callers have one failure path.
 */
export const defaultRunner: Runner = (command, options = {}) => {
  try {
    const result = Bun.spawnSync(command, {
      cwd: options.cwd,
      env: options.env === undefined ? undefined : { ...process.env, ...options.env },
      stdin: options.input === undefined ? 'ignore' : Buffer.from(options.input),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      code: result.exitCode ?? 1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } catch (error) {
    return { code: 127, stdout: '', stderr: String(error) };
  }
};

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
