#!/usr/bin/env bun
// Chef repository configuration: loads and validates the per-repository JSON file the chef
// plumbing scripts share (`scripts/chef/repository.json`, the default of every `--config`), so
// each script reads one validated shape instead of re-checking fields. Every invalid field is a
// `UsageError` that names the file and the field. A leading `~` in a worktree root expands to the
// home directory, and the main checkout is never configured: `repository-locations.ts` asks Git.
//
// Usage:
//   bun scripts/chef/repository-config.ts [config.json]   prints the validated configuration
//
// Exit codes: 0 valid, 2 invalid configuration or usage.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { emitResult, UsageError } from './process-runner.ts';

export { UsageError };

/** The configuration every script's `--config` defaults to. */
export const DEFAULT_CONFIGURATION_PATH = join(import.meta.dir, 'repository.json');

export type Provider = 'claude' | 'codex';
export type MergeMethod = 'squash' | 'merge' | 'rebase';

export interface RepositoryConfig {
  /** `owner/name` on GitHub. */
  repository: string;
  defaultBranch: string;
  /** Absolute worktree root per provider. */
  worktreeRoots: Record<Provider, string>;
  /** The `name` a fresh worktree's root `package.json` must carry. */
  manifestName: string;
  installCommand: string;
  gateCommand: string;
  affectedCheckCommand: string;
  /**
   * The quick typecheck and lint `deliver.ts` runs after merging the default branch in, for the
   * workspaces both sides touched. `{filters}` is replaced by one `--filter=./<directory>` per
   * workspace. Omit to skip the command (the removed-names scan still runs).
   */
  fastCheckCommand?: string;
  /** The batch validate; `gate-run.ts run` records its result as main's health. Omit to record none. */
  batchCommand?: string;
  /** Command prefix for a gate run, such as `caffeinate -ims`; omit on a host without it. */
  gateWrapper?: string;
  /** Extended regular expression for `pgrep -f`; with none, no lock wait happens. */
  lockPattern?: string;
  mergeMethod: MergeMethod;
}

export const providers: Provider[] = ['claude', 'codex'];
const mergeMethods: MergeMethod[] = ['squash', 'merge', 'rebase'];
const knownFields = [
  'repository',
  'defaultBranch',
  'worktreeRoots',
  'manifestName',
  'installCommand',
  'gateCommand',
  'affectedCheckCommand',
  'fastCheckCommand',
  'batchCommand',
  'gateWrapper',
  'lockPattern',
  'mergeMethod',
];

function text(source: string, record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim() === '')
    throw new UsageError(`${source}: "${field}" must be a non-empty string.`);
  return value;
}

/** Expand a leading `~` to the home directory, so the committed file names no one's account. */
export function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  return value.startsWith('~/') ? join(home, value.slice(2)) : value;
}

function absolutePath(source: string, value: string, field: string, home: string): string {
  const expanded = expandHome(value, home);
  if (!isAbsolute(expanded))
    throw new UsageError(`${source}: "${field}" must be an absolute path.`);
  return expanded;
}

/** Validate an already-parsed configuration; `source` names it in error messages. */
export function validateRepositoryConfig(
  value: unknown,
  source = 'configuration',
  home = homedir(),
): RepositoryConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new UsageError(`${source}: a repository configuration is a JSON object.`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!knownFields.includes(key)) throw new UsageError(`${source}: unknown field "${key}".`);
  }
  const repository = text(source, record, 'repository');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new UsageError(`${source}: "repository" must look like owner/name.`);
  const roots = record['worktreeRoots'];
  if (roots === null || typeof roots !== 'object' || Array.isArray(roots))
    throw new UsageError(`${source}: "worktreeRoots" must be an object with a path per provider.`);
  const worktreeRoots = {} as Record<Provider, string>;
  for (const provider of providers) {
    worktreeRoots[provider] = absolutePath(
      source,
      text(source, roots as Record<string, unknown>, provider),
      `worktreeRoots.${provider}`,
      home,
    );
  }
  for (const key of Object.keys(roots)) {
    if (!providers.includes(key as Provider))
      throw new UsageError(`${source}: "worktreeRoots.${key}" is not a known provider.`);
  }
  const mergeMethod = text(source, record, 'mergeMethod');
  if (!mergeMethods.includes(mergeMethod as MergeMethod))
    throw new UsageError(`${source}: "mergeMethod" must be one of ${mergeMethods.join(', ')}.`);
  const config: RepositoryConfig = {
    repository,
    defaultBranch: text(source, record, 'defaultBranch'),
    worktreeRoots,
    manifestName: text(source, record, 'manifestName'),
    installCommand: text(source, record, 'installCommand'),
    gateCommand: text(source, record, 'gateCommand'),
    affectedCheckCommand: text(source, record, 'affectedCheckCommand'),
    mergeMethod: mergeMethod as MergeMethod,
  };
  if (record['fastCheckCommand'] !== undefined) {
    config.fastCheckCommand = text(source, record, 'fastCheckCommand');
    if (!config.fastCheckCommand.includes('{filters}'))
      throw new UsageError(`${source}: "fastCheckCommand" must hold the {filters} placeholder.`);
  }
  if (record['batchCommand'] !== undefined)
    config.batchCommand = text(source, record, 'batchCommand');
  if (record['gateWrapper'] !== undefined) config.gateWrapper = text(source, record, 'gateWrapper');
  if (record['lockPattern'] !== undefined) {
    config.lockPattern = text(source, record, 'lockPattern');
    try {
      void new RegExp(config.lockPattern);
    } catch (error) {
      throw new UsageError(
        `${source}: "lockPattern" is not a valid regular expression: ${String(error)}`,
      );
    }
  }
  return config;
}

/** Read and validate the repository configuration at `path`. */
export function loadRepositoryConfig(
  path: string = DEFAULT_CONFIGURATION_PATH,
  home = homedir(),
): RepositoryConfig {
  if (!existsSync(path)) throw new UsageError(`No such repository configuration: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UsageError(`${path}: not valid JSON: ${String(error)}`);
  }
  return validateRepositoryConfig(parsed, path, home);
}

export function run(argv: string[]): { code: number; output: string } {
  if (argv.length > 1 || (argv[0] ?? '').startsWith('--'))
    throw new UsageError('Usage: repository-config.ts [config.json]');
  return { code: 0, output: JSON.stringify(loadRepositoryConfig(argv[0]), null, 2) };
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
