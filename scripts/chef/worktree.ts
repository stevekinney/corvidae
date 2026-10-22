#!/usr/bin/env bun
// Chef worktree lifecycle: creates and removes the per-batch worktrees a coordinator hands to
// workers, with the checks that were hand-run before each step. It reads a repository
// configuration (see repository-config.ts, default `scripts/chef/repository.json`) for the
// provider's worktree root, the manifest name and the install command. The main checkout, where the
// branch and worktree commands run, is resolved from Git (`repository-locations.ts`).
//
// Usage:
//   bun scripts/chef/worktree.ts create [--config <json>] --provider claude|codex --name <name>
//       --branch <branch> [--base <ref>] [--install-log <file>]
//       [--scope-paths <p,p> --scope-output <json>] [--json]
//   bun scripts/chef/worktree.ts remove [--config <json>] --provider claude|codex --name <name>
//       [--keep-remote] [--retired] [--json]
//
// `create` runs the default-branch ownership preflight (it never attaches the default branch),
// fetches the default branch, adds the worktree on a new branch from `--base` (default
// `origin/<default>`), checks the new worktree's `package.json` name equals `manifestName` before
// it installs, runs the install command into a log (default `<root>/<name>-install.log`), and, when
// scope paths are given, captures a `worktree-scope.ts` baseline. It prints the path, HEAD, install
// exit code and `captureId`.
//
// `remove` refuses, changing nothing, when the worktree has uncommitted or untracked changes, when
// any process has its working directory or open files inside it, or when it is not a worktree
// under the provider's root. It also refuses, because the branch is deleted with `git branch -D` and
// the remote branch with `git push --delete`, unless the branch's work is delivered: its tip is an
// ancestor of `origin/<default branch>` (after a fetch), or `gh pr view <branch>` reports `MERGED`
// with a `headRefOid` equal to the local tip (a squash merge leaves the tip outside the default
// branch's history, so the pull request is the evidence). A branch with an open pull request, an
// unpushed commit or a tip that differs from the merged head is refused. `--retired` states that the
// branch is deliberately abandoned and skips that check; nothing else does. Otherwise it removes the
// worktree, deletes its branch, and unless `--keep-remote` deletes the remote branch when one exists.
//
// With `--json` a refusal is printed as `{ ok: false, error }` on standard output.
//
// Exit codes: 0 done, 1 refused or a step failed, 2 invalid CLI usage.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { findWorktreeProcesses, ProbeError } from './leftovers.ts';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  requireOption,
  type Runner,
  shellQuote,
  UsageError,
} from './process-runner.ts';
import {
  DEFAULT_CONFIGURATION_PATH,
  loadRepositoryConfig,
  type Provider,
  providers,
  type RepositoryConfig,
} from './repository-config.ts';
import { resolveMainCheckout } from './repository-locations.ts';

export { UsageError };

/** A step that must stop with exit 1: the operation was refused or a command failed. */
export class Refusal extends Error {}

export interface WorktreeEntry {
  path: string;
  head: string | undefined;
  /** A full ref such as `refs/heads/main`; `undefined` for a detached or bare worktree. */
  branch: string | undefined;
  detached: boolean;
  bare: boolean;
}

/**
 * Parse `git worktree list --porcelain` by block. Each block holds one worktree's `worktree`,
 * `HEAD` and `branch` lines, so a `branch` line pairs with the `worktree` line of its own block;
 * a detached worktree has no `branch` line at all, which fixed-offset line matching gets wrong.
 */
export function parseWorktreeList(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    let entry: WorktreeEntry | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) {
        entry = {
          path: line.slice('worktree '.length),
          head: undefined,
          branch: undefined,
          detached: false,
          bare: false,
        };
      } else if (entry !== undefined) {
        if (line.startsWith('HEAD ')) entry.head = line.slice('HEAD '.length);
        else if (line.startsWith('branch ')) entry.branch = line.slice('branch '.length);
        else if (line === 'detached') entry.detached = true;
        else if (line === 'bare') entry.bare = true;
      }
    }
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

/** The worktree that has `branch` checked out, if any. */
export function branchOwner(entries: WorktreeEntry[], branch: string): WorktreeEntry | undefined {
  return entries.find((entry) => entry.branch === `refs/heads/${branch}`);
}

export interface WorktreeDependencies {
  runner: Runner;
  /** The main checkout where branch and worktree commands run; resolved from Git when absent. */
  checkout?: string;
  /** Where `worktree-scope.ts` lives. */
  scriptDirectory: string;
}

function resolveDependencies(
  partial: Partial<WorktreeDependencies>,
): Required<WorktreeDependencies> {
  const runner = partial.runner ?? defaultRunner;
  return {
    runner,
    checkout: partial.checkout ?? resolveMainCheckout(runner),
    scriptDirectory: partial.scriptDirectory ?? import.meta.dir,
  };
}

function git(runner: Runner, cwd: string, ...args: string[]) {
  return runner(['git', ...args], { cwd });
}

function failure(step: string, result: { stdout: string; stderr: string; code: number }): Refusal {
  const detail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-3).join(' | ');
  return new Refusal(`${step} failed (exit ${result.code}): ${detail}`);
}

function validateName(name: string, label: string, pattern: RegExp): string {
  if (!pattern.test(name) || name.includes('..') || name.endsWith('/') || name.endsWith('.lock'))
    throw new UsageError(`--${label} "${name}" is not a safe ${label}.`);
  return name;
}

function providerRoot(config: RepositoryConfig, provider: string): string {
  if (!providers.includes(provider as Provider))
    throw new UsageError(`--provider must be one of ${providers.join(', ')}.`);
  return config.worktreeRoots[provider as Provider];
}

function realpath(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

function isUnder(root: string, path: string): boolean {
  const resolvedRoot = realpath(root);
  return path.startsWith(resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep);
}

export interface CreateOptions {
  configPath: string;
  provider: string;
  name: string;
  branch: string;
  base?: string | undefined;
  installLog?: string | undefined;
  scopePaths?: string[] | undefined;
  scopeOutput?: string | undefined;
}

export interface CreateResult {
  path: string;
  head: string;
  installCode: number;
  installLog: string;
  captureId: string | undefined;
}

/** Create a worktree; throws `Refusal` for a refused or failed step, `UsageError` for bad input. */
export function createWorktree(
  options: CreateOptions,
  partial: Partial<WorktreeDependencies> = {},
): CreateResult {
  const { runner, scriptDirectory, checkout } = resolveDependencies(partial);
  const config = loadRepositoryConfig(options.configPath);
  const root = providerRoot(config, options.provider);
  const name = validateName(options.name, 'name', /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  const branch = validateName(options.branch, 'branch', /^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
  if ((options.scopePaths === undefined) !== (options.scopeOutput === undefined))
    throw new UsageError('--scope-paths and --scope-output go together.');
  const base = options.base ?? `origin/${config.defaultBranch}`;
  const path = join(root, name);

  // Main-branch ownership preflight: a new worktree never gets the default branch.
  const listing = git(runner, checkout, 'worktree', 'list', '--porcelain');
  if (listing.code !== 0) throw failure('git worktree list', listing);
  if (branch === config.defaultBranch) {
    const owner = branchOwner(parseWorktreeList(listing.stdout), config.defaultBranch);
    throw new Refusal(
      `Refusing to attach the default branch "${config.defaultBranch}"${owner === undefined ? '' : `, which ${owner.path} already owns`}.`,
    );
  }
  if (existsSync(path)) throw new Refusal(`${path} already exists.`);

  const fetch = git(runner, checkout, 'fetch', 'origin', config.defaultBranch);
  if (fetch.code !== 0) throw failure(`git fetch origin ${config.defaultBranch}`, fetch);
  const add = git(runner, checkout, 'worktree', 'add', '-b', branch, path, base);
  if (add.code !== 0) throw failure('git worktree add', add);

  const manifestPath = join(path, 'package.json');
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Refusal(
      `Created ${path} but could not read ${manifestPath}: ${String(error)}. Not installed.`,
    );
  }
  const manifestName = (manifest as { name?: unknown } | null)?.name;
  if (manifestName !== config.manifestName)
    throw new Refusal(
      `Created ${path} but its package.json name is ${JSON.stringify(manifestName)}, not "${config.manifestName}". Not installed.`,
    );

  const head = git(runner, path, 'rev-parse', 'HEAD').stdout.trim();
  const installLog = options.installLog ?? join(dirname(path), `${name}-install.log`);
  const install = runner(
    ['sh', '-c', `(${config.installCommand}) > ${shellQuote(installLog)} 2>&1`],
    { cwd: path },
  );

  let captureId: string | undefined;
  if (options.scopePaths !== undefined && options.scopeOutput !== undefined) {
    const temporary = mkdtempSync(join(tmpdir(), 'worktree-scope-'));
    try {
      const configuration = join(temporary, 'configuration.json');
      writeFileSync(configuration, JSON.stringify({ root: path, paths: options.scopePaths }));
      const capture = runner([
        'bun',
        join(scriptDirectory, 'worktree-scope.ts'),
        'capture',
        '--configuration',
        configuration,
        '--output',
        options.scopeOutput,
      ]);
      if (capture.code !== 0) throw failure('worktree-scope capture', capture);
      try {
        captureId = (JSON.parse(capture.stdout) as { captureId?: string }).captureId;
      } catch {
        throw new Refusal('worktree-scope capture printed output that is not JSON.');
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  return { path, head, installCode: install.code, installLog, captureId };
}

export interface RemoveOptions {
  configPath: string;
  provider: string;
  name: string;
  keepRemote: boolean;
  /** The branch is deliberately abandoned: skip the check that its work was delivered. */
  retired?: boolean;
}

export interface RemoveResult {
  path: string;
  branch: string | undefined;
  remoteDeleted: boolean;
}

/**
 * Why `branch` cannot be shown to be delivered, or `undefined` when it is: its tip is an ancestor of
 * `origin/<default>` after a fetch, or its pull request is `MERGED` at exactly that tip.
 */
function undeliveredReason(
  runner: Runner,
  checkout: string,
  config: RepositoryConfig,
  branch: string,
): string | undefined {
  const base = `origin/${config.defaultBranch}`;
  const tipResult = git(runner, checkout, 'rev-parse', '--verify', `refs/heads/${branch}`);
  const tip = tipResult.stdout.trim();
  if (tipResult.code !== 0 || tip === '')
    return `its branch "${branch}" has no local tip to compare (${failure('git rev-parse', tipResult).message})`;
  const fetched = git(runner, checkout, 'fetch', 'origin', config.defaultBranch);
  if (fetched.code !== 0)
    return `it could not be checked against ${base} (${failure(`git fetch origin ${config.defaultBranch}`, fetched).message})`;
  const ancestor = git(runner, checkout, 'merge-base', '--is-ancestor', tip, base);
  if (ancestor.code === 0) return undefined;
  if (ancestor.code !== 1)
    return `it could not be checked against ${base} (${failure('git merge-base --is-ancestor', ancestor).message})`;
  const view = runner(
    ['gh', 'pr', 'view', branch, '--repo', config.repository, '--json', 'state,headRefOid'],
    { cwd: checkout },
  );
  let pullRequest: { state?: unknown; headRefOid?: unknown } | undefined;
  if (view.code === 0) {
    try {
      pullRequest = JSON.parse(view.stdout) as typeof pullRequest;
    } catch {
      pullRequest = undefined;
    }
  }
  if (pullRequest?.state === 'MERGED' && pullRequest.headRefOid === tip) return undefined;
  const found =
    pullRequest === undefined
      ? 'no pull request was found for it'
      : pullRequest.state === 'MERGED'
        ? `its pull request merged ${String(pullRequest.headRefOid).slice(0, 12)}, not the local tip ${tip.slice(0, 12)}`
        : `its pull request is ${String(pullRequest.state)}`;
  return `its branch "${branch}" (${tip.slice(0, 12)}) is not delivered: it is not in ${base} and ${found}; merge it, or pass --retired to discard it`;
}

/** Remove a worktree and its branch; throws `Refusal` listing every reason, changing nothing. */
export function removeWorktree(
  options: RemoveOptions,
  partial: Partial<WorktreeDependencies> = {},
): RemoveResult {
  const { runner, checkout } = resolveDependencies(partial);
  const config = loadRepositoryConfig(options.configPath);
  const root = providerRoot(config, options.provider);
  const name = validateName(options.name, 'name', /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  const path = join(root, name);

  const listing = git(runner, checkout, 'worktree', 'list', '--porcelain');
  if (listing.code !== 0) throw failure('git worktree list', listing);
  const resolvedPath = realpath(path);
  const entry = parseWorktreeList(listing.stdout).find(
    (item) => realpath(item.path) === resolvedPath,
  );
  const reasons: string[] = [];
  if (entry === undefined || !isUnder(root, resolvedPath)) {
    throw new Refusal(`${path} is not a worktree under the ${options.provider} root ${root}.`);
  }
  const branch = entry.branch?.replace(/^refs\/heads\//, '');
  if (branch === config.defaultBranch)
    reasons.push(`it has the default branch "${branch}" checked out`);
  const status = git(runner, path, 'status', '--porcelain');
  if (status.code !== 0) reasons.push(`git status failed: ${status.stderr.trim()}`);
  else if (status.stdout.trim() !== '') {
    reasons.push(
      `it has ${status.stdout.trim().split('\n').length} uncommitted or untracked path(s)`,
    );
  }
  try {
    const holders = findWorktreeProcesses(path, runner);
    if (holders.length > 0) {
      reasons.push(
        `processes are inside it: ${holders.map((item) => `${item.pid} ${item.command}`).join(', ')}`,
      );
    }
  } catch (error) {
    // An `lsof` that could not run proves nothing about the worktree, so it blocks the removal.
    if (!(error instanceof ProbeError)) throw error;
    reasons.push(`it could not be checked for processes (${error.message})`);
  }
  if (branch !== undefined && branch !== config.defaultBranch && options.retired !== true) {
    const undelivered = undeliveredReason(runner, checkout, config, branch);
    if (undelivered !== undefined) reasons.push(undelivered);
  }
  if (reasons.length > 0) throw new Refusal(`Refusing to remove ${path}: ${reasons.join('; ')}.`);

  const removed = git(runner, checkout, 'worktree', 'remove', path);
  if (removed.code !== 0) throw failure('git worktree remove', removed);
  let remoteDeleted = false;
  if (branch !== undefined) {
    const deleted = git(runner, checkout, 'branch', '-D', branch);
    if (deleted.code !== 0) throw failure(`git branch -D ${branch}`, deleted);
    if (!options.keepRemote) {
      const remote = git(runner, checkout, 'ls-remote', '--exit-code', '--heads', 'origin', branch);
      if (remote.code === 0) {
        const push = git(runner, checkout, 'push', 'origin', '--delete', branch);
        if (push.code !== 0) throw failure(`git push origin --delete ${branch}`, push);
        remoteDeleted = true;
      }
    }
  }
  return { path, branch, remoteDeleted };
}

export function run(
  argv: string[],
  dependencies: Partial<WorktreeDependencies> = {},
): { code: number; output: string } {
  const [command, ...rest] = argv;
  if (command !== 'create' && command !== 'remove')
    throw new UsageError('Usage: worktree.ts create|remove ...');
  const parsed = parseOptions(rest, {
    values: [
      'config',
      'provider',
      'name',
      'branch',
      'base',
      'install-log',
      'scope-paths',
      'scope-output',
    ],
    flags: ['keep-remote', 'retired', 'json'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const json = parsed.flags.has('json');
  const configPath = parsed.values['config'] ?? DEFAULT_CONFIGURATION_PATH;
  const provider = requireOption(parsed, 'provider');
  const name = requireOption(parsed, 'name');
  try {
    if (command === 'create') {
      const result = createWorktree(
        {
          configPath,
          provider,
          name,
          branch: requireOption(parsed, 'branch'),
          base: parsed.values['base'],
          installLog: parsed.values['install-log'],
          scopePaths: parsed.values['scope-paths']?.split(',').filter((item) => item !== ''),
          scopeOutput: parsed.values['scope-output'],
        },
        dependencies,
      );
      return {
        code: result.installCode === 0 ? 0 : 1,
        output: json
          ? JSON.stringify(result)
          : [
              `worktree: ${result.path}`,
              `head: ${result.head}`,
              `install: exit ${result.installCode} (log ${result.installLog})`,
              ...(result.captureId === undefined ? [] : [`captureId: ${result.captureId}`]),
            ].join('\n'),
      };
    }
    const result = removeWorktree(
      {
        configPath,
        provider,
        name,
        keepRemote: parsed.flags.has('keep-remote'),
        retired: parsed.flags.has('retired'),
      },
      dependencies,
    );
    return {
      code: 0,
      output: json
        ? JSON.stringify(result)
        : [
            `removed worktree ${result.path}`,
            result.branch === undefined
              ? 'no branch (detached)'
              : `deleted branch ${result.branch}`,
            result.remoteDeleted ? 'deleted the remote branch' : 'left the remote branch',
          ].join('\n'),
    };
  } catch (error) {
    if (error instanceof Refusal)
      return {
        code: 1,
        output: json ? JSON.stringify({ ok: false, error: error.message }) : error.message,
      };
    throw error;
  }
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
