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
//       [--json]
//   bun scripts/chef/worktree.ts remove [--config <json>] [--provider claude|codex] --name <name>
//       [--keep-remote] [--retired] [--json]
//   bun scripts/chef/worktree.ts stale [--config <json>] [--remove] [--json]
// `--name` on `remove` is a worktree name or an absolute path. `--provider` is optional on `remove`:
// without it every provider's root is accepted. `stale` lists, read-only, every worktree under the
// accepted roots with its branch, age, cleanliness, lock, live processes and delivered state (the
// two tests, and their limits, are on `classifyDelivered`); `--remove` removes those that are clean,
// unlocked and delivered, never the main checkout or the worktree it runs from, and keeps the
// remote branches. It reads `origin/<default>` as last fetched (`--remove` fetches first). A live
// process in the listing is one whose working directory is inside the worktree, seen by one
// host-wide `lsof` that shows only the running user's processes. A worktree whose branch was
// squash-merged (`changes-in-default`) is finished, so `--remove` ends the processes left inside it
// (`endProcessesInside`); one whose tip is a commit of the default branch looks like a worktree a
// session has just created, so a live process keeps it. `--remove` re-checks open files. A branch
// with no commit of its own counts as delivered (its tip is in `origin/<default>`).
//
// `create` runs the default-branch ownership preflight (it never attaches the default branch),
// fetches the default branch, adds the worktree on a new branch from `--base` (default
// `origin/<default>`), checks the new worktree's `package.json` name equals `manifestName` before
// it installs, and runs the install command into a log (default `<root>/<name>-install.log`). It
// prints the path, HEAD and install exit code.
//
// `remove` refuses, changing nothing, when the worktree has uncommitted or untracked changes, when
// any process has its working directory or open files inside it (`deliver.ts` and `stale --remove`
// first end the processes whose working directory is inside, once nothing else refuses the
// removal; files held open from elsewhere still refuse it), when Git reports the worktree
// locked, or when it is not a worktree under the provider's root (`~/.agent-worktrees/<provider>/corvidae`)
// or under `<main checkout>/.claude/worktrees`, where Claude Code's Agent tool makes them. It also
// refuses, because the branch is deleted with `git branch -D` and
// the remote branch with `git push --delete`, unless the branch's work is delivered: its tip is an
// ancestor of `origin/<default branch>` (after a fetch), or `gh pr view <branch>` reports `MERGED`
// with a `headRefOid` equal to the local tip (a squash merge leaves the tip outside the default
// branch's history, so the pull request is the evidence), or the caller (`deliver.ts`) has just
// delivered exactly that tip (`deliveredTip`). A branch with an open pull request, an
// unpushed commit or a tip that differs from the merged head is refused. `--retired` states that the
// branch is deliberately abandoned and skips that check; nothing else does. Otherwise it removes the
// worktree, deletes its branch, and unless `--keep-remote` deletes the remote branch when one exists.
//
// With `--json` a refusal is printed as `{ ok: false, error }` on standard output.
//
// Exit codes: 0 done, 1 refused or a step failed, 2 invalid CLI usage.

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { ancestorsOf } from '../run-exclusively.ts';
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
  /** Git reports the worktree locked (`git worktree lock`), with or without a reason. */
  locked: boolean;
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
          locked: false,
        };
      } else if (entry !== undefined) {
        if (line.startsWith('HEAD ')) entry.head = line.slice('HEAD '.length);
        else if (line.startsWith('branch ')) entry.branch = line.slice('branch '.length);
        else if (line === 'detached') entry.detached = true;
        else if (line === 'bare') entry.bare = true;
        else if (line === 'locked' || line.startsWith('locked ')) entry.locked = true;
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
  /** How `endProcesses` signals and waits; tests substitute recorders. */
  endProcesses?: EndProcessesDependencies;
}

function resolveDependencies(
  partial: Partial<WorktreeDependencies>,
): Required<Omit<WorktreeDependencies, 'endProcesses'>> {
  const runner = partial.runner ?? defaultRunner;
  return {
    runner,
    checkout: partial.checkout ?? resolveMainCheckout(runner),
  };
}

function git(runner: Runner, cwd: string, ...args: string[]) {
  return runner(['git', ...args], { cwd });
}

function failure(step: string, result: { stdout: string; stderr: string; code: number }): Refusal {
  const detail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-3).join(' | ');
  return new Refusal(`${step} failed (exit ${result.code}): ${detail}`);
}

export function validateName(name: string, label: string, pattern: RegExp): string {
  if (!pattern.test(name) || name.includes('..') || name.endsWith('/') || name.endsWith('.lock'))
    throw new UsageError(`--${label} "${name}" is not a safe ${label}.`);
  return name;
}

/** Throws a `UsageError` unless `provider` is a known provider. */
export function validateProvider(provider: string): void {
  if (!providers.includes(provider as Provider))
    throw new UsageError(`--provider must be one of ${providers.join(', ')}.`);
}

function providerRoot(config: RepositoryConfig, provider: string): string {
  validateProvider(provider);
  return config.worktreeRoots[provider as Provider];
}

/** The roots a worktree may be removed from: the provider's (every provider's when none) and the Agent tool's. */
function acceptedRoots(
  config: RepositoryConfig,
  checkout: string,
  provider: string | undefined,
): string[] {
  const providerRoots =
    provider === undefined
      ? providers.map((item) => config.worktreeRoots[item])
      : [providerRoot(config, provider)];
  return [...providerRoots, join(checkout, '.claude', 'worktrees')];
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
}

export interface CreateResult {
  path: string;
  head: string;
  installCode: number;
  installLog: string;
}

/** Create a worktree; throws `Refusal` for a refused or failed step, `UsageError` for bad input. */
export function createWorktree(
  options: CreateOptions,
  partial: Partial<WorktreeDependencies> = {},
): CreateResult {
  const { runner, checkout } = resolveDependencies(partial);
  const config = loadRepositoryConfig(options.configPath);
  const root = providerRoot(config, options.provider);
  const name = validateName(options.name, 'name', /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  const branch = validateName(options.branch, 'branch', /^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
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

  // A relative --install-log is the caller's path, not the worktree's: the install runs inside the
  // worktree, where a relative log would land (or fail to) somewhere the caller never looks.
  const resolvedInstallLog = resolve(
    options.installLog ?? join(dirname(path), `${name}-install.log`),
  );
  const logExisted = existsSync(resolvedInstallLog);
  try {
    mkdirSync(dirname(resolvedInstallLog), { recursive: true });
    writeFileSync(resolvedInstallLog, '', { flag: 'a' });
    // Only a probe: a refusal before the install must not leave a log for an install that never ran.
    if (!logExisted) rmSync(resolvedInstallLog, { force: true });
  } catch (error) {
    throw new Refusal(
      `Cannot write the install log ${resolvedInstallLog}: ${error instanceof Error ? error.message : String(error)}. Nothing was created.`,
    );
  }

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
  const installLog = resolvedInstallLog;
  const install = runner(
    ['sh', '-c', `(${config.installCommand}) > ${shellQuote(installLog)} 2>&1`],
    { cwd: path },
  );

  return { path, head, installCode: install.code, installLog };
}

export interface RemoveOptions {
  configPath: string;
  /** Restricts the accepted roots to this provider's (plus the Agent tool's); absent accepts every root. */
  provider?: string | undefined;
  name: string;
  keepRemote: boolean;
  /** The branch is deliberately abandoned: skip the check that its work was delivered. */
  retired?: boolean;
  /**
   * The caller has just delivered exactly this commit (a squash or direct merge leaves the tip
   * outside the default branch's history). The delivered-branch check passes only while the local
   * tip still equals it; any other tip goes through the ordinary check.
   */
  deliveredTip?: string | undefined;
  /**
   * The branch (without `refs/heads/`) the caller saw at `deliveredTip`; `undefined` for a
   * detached head. `endProcesses` refuses unless the worktree's head is `deliveredTip` and, when this
   * key is given, its branch is this one (a delivery pins the head, not the local branch name),
   * so a path reused by a new session is never emptied of its processes.
   */
  deliveredBranch?: string | undefined;
  /**
   * End the processes whose working directory is inside the worktree once nothing else refuses
   * its removal, instead of refusing for them (`endProcessesInside`). Open files of processes
   * elsewhere still refuse it.
   */
  endProcesses?: boolean;
}

export interface RemoveResult {
  path: string;
  branch: string | undefined;
  remoteDeleted: boolean;
  /** The processes `endProcesses` signalled before the removal. */
  ended: WorkingDirectoryProcess[];
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
  const roots = acceptedRoots(config, checkout, options.provider);
  const listing = git(runner, checkout, 'worktree', 'list', '--porcelain');
  if (listing.code !== 0) throw failure('git worktree list', listing);
  const entries = parseWorktreeList(listing.stdout);
  // A name is looked up under the provider's root, then under the Agent tool's directory; an
  // absolute path is taken as given. Either way it must be a registered worktree under one of them.
  const candidates = isAbsolute(options.name)
    ? [options.name]
    : (() => {
        const name = validateName(options.name, 'name', /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
        return roots.map((root) => join(root, name));
      })();
  let path = candidates[0] ?? options.name;
  let entry: WorktreeEntry | undefined;
  for (const candidate of candidates) {
    const listed = entries.find((item) => realpath(item.path) === realpath(candidate));
    const resolved = realpath(candidate);
    if (listed !== undefined && roots.some((root) => isUnder(root, resolved))) {
      path = candidate;
      entry = listed;
      break;
    }
  }
  const reasons: string[] = [];
  if (entry === undefined) {
    throw new Refusal(`${path} is not a worktree under ${roots.join(' or ')}.`);
  }
  if (entry.locked) reasons.push('Git reports it locked (git worktree unlock it first)');
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
  const tipDelivered =
    options.deliveredTip !== undefined &&
    branch !== undefined &&
    git(runner, checkout, 'rev-parse', '--verify', `refs/heads/${branch}`).stdout.trim() ===
      options.deliveredTip;
  if (
    branch !== undefined &&
    branch !== config.defaultBranch &&
    options.retired !== true &&
    !tipDelivered
  ) {
    const undelivered = undeliveredReason(runner, checkout, config, branch);
    if (undelivered !== undefined) reasons.push(undelivered);
  }
  if (
    options.endProcesses === true &&
    (entry.head === undefined ||
      entry.head !== options.deliveredTip ||
      ('deliveredBranch' in options && branch !== options.deliveredBranch))
  ) {
    reasons.push(
      `its branch and head are not the ones recorded as delivered (${branch ?? 'detached'} at ${entry.head ?? 'unknown'}), so it may be a worktree reused since, and its processes are not ended`,
    );
  }
  let ended: WorkingDirectoryProcess[] = [];
  try {
    // Only once nothing else refuses the removal: a refused worktree keeps its processes.
    if (options.endProcesses === true && reasons.length === 0) {
      ended = endProcessesInside(path, runner, partial.endProcesses);
    }
    // Then every open file, not only working directories: an editor or a server holding a file
    // inside still refuses the removal.
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
  return { path, branch, remoteDeleted, ended };
}

/** A process and its working directory, from `lsof -d cwd`. */
export interface WorkingDirectoryProcess {
  pid: number;
  command: string;
  cwd: string;
}

/**
 * The processes whose working directory is `root` or inside it, less `exclude`. `root` must be
 * resolved, as `lsof` prints resolved paths. A sibling that only shares the prefix (`/w/a-1` beside
 * `/w/a-10`) is not inside.
 */
export function processesInside(
  root: string,
  processes: readonly WorkingDirectoryProcess[],
  exclude: ReadonlySet<number> = new Set(),
): WorkingDirectoryProcess[] {
  return processes.filter(
    (item) => !exclude.has(item.pid) && (item.cwd === root || item.cwd.startsWith(root + sep)),
  );
}

/** Every process's working directory, from one host-wide `lsof`; `undefined` when it failed. */
function workingDirectories(runner: Runner): WorkingDirectoryProcess[] | undefined {
  const open = runner(['lsof', '-w', '-a', '-d', 'cwd', '-F', 'pcn']);
  if (open.code !== 0 && open.stdout.trim() === '') return undefined;
  return [...lsofOpenFiles(open.stdout)].map((file) => ({
    pid: file.pid,
    command: file.command,
    cwd: file.name,
  }));
}

export interface EndProcessesDependencies {
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (milliseconds: number) => void;
  /** Never signalled; defaults to this process and its ancestors. */
  exclude?: ReadonlySet<number>;
  /**
   * The parents of every process, for finding this process's ancestors; `undefined` stands for an
   * unreadable process table. Absent, it is read with the runner's `ps`.
   */
  parents?: ReadonlyMap<number, number> | undefined;
}

const endGraceMs = 3000;
const endPollMs = 250;

/** The parents of every process from the runner's `ps`; `undefined` when `ps` fails. */
function readParentsWith(runner: Runner): Map<number, number> | undefined {
  const result = runner(['ps', '-A', '-o', 'pid=,ppid=']);
  if (result.code !== 0) return undefined;
  const parents = new Map<number, number>();
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match !== null) parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

/**
 * This process, its parent whatever the process table says, and its ancestors when `parents` can
 * name them: an unreadable table must never leave the caller's own session signalled.
 */
function thisProcessAndItsAncestors(parents: ReadonlyMap<number, number> | undefined): Set<number> {
  return new Set([process.pid, process.ppid, ...ancestorsOf(process.pid, parents ?? new Map())]);
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone, or not ours to signal; the re-check after the grace reports it.
  }
}

/**
 * Ends the processes whose working directory is inside `path` (COR-2404: a removed worktree's
 * `bun test` lived for ten hours): SIGTERM, then SIGKILL to whatever a fresh listing still shows
 * inside after a grace. Every signal goes only to a pid that the listing just taken shows inside,
 * and never to this process or its ancestors. Resolves to the processes it signalled; throws
 * `ProbeError` when `lsof` cannot list.
 */
export function endProcessesInside(
  path: string,
  runner: Runner,
  dependencies: EndProcessesDependencies = {},
): WorkingDirectoryProcess[] {
  const root = realpath(path);
  const exclude =
    dependencies.exclude ??
    thisProcessAndItsAncestors(
      'parents' in dependencies ? dependencies.parents : readParentsWith(runner),
    );
  const send = dependencies.signal ?? signalProcess;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => Bun.sleepSync(milliseconds));
  const inside = (): WorkingDirectoryProcess[] => {
    const all = workingDirectories(runner);
    if (all === undefined) throw new ProbeError(`lsof could not list working directories`);
    return processesInside(root, all, exclude);
  };
  const ended = new Map<number, WorkingDirectoryProcess>();
  let remaining = inside();
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (remaining.length === 0) break;
    for (const item of remaining) {
      ended.set(item.pid, item);
      send(item.pid, signal);
    }
    for (let waited = 0; waited < endGraceMs && remaining.length > 0; waited += endPollMs) {
      sleep(endPollMs);
      remaining = inside();
    }
  }
  return [...ended.values()];
}

/** How a worktree's branch was shown to be delivered: see `classifyDelivered`. */
export type DeliveredBy = 'ancestor' | 'changes-in-default' | 'none';

export interface StaleEntry {
  path: string;
  branch: string | undefined;
  tip: string | undefined;
  /** The committer date of the worktree's HEAD, ISO 8601; the worktree's age. */
  lastCommit: string | undefined;
  ageDays: number | undefined;
  /** `undefined` when `git status` failed. */
  clean: boolean | undefined;
  locked: boolean;
  /** Processes whose working directory is inside it; `undefined` when `lsof` could not answer. */
  processes: number | undefined;
  delivered: boolean;
  deliveredBy: DeliveredBy;
  /** The worktree this command runs from: never removed. */
  current: boolean;
  /** Why it is not removable; empty when `--remove` would remove it. */
  keep: string[];
}

export interface StaleOptions {
  configPath: string;
  remove: boolean;
  /** The directory the command runs from; its worktree is never removed. Defaults to the cwd. */
  currentDirectory?: string | undefined;
}

export interface StaleResult {
  entries: StaleEntry[];
  /** Filled only with `remove`: the worktrees removed, then those a re-check refused. */
  removed: { path: string; branch: string | undefined; ended: number }[];
  refused: { path: string; reason: string }[];
}

/** Every `n` (file name) line of an `lsof -F pcn` listing, with the pid and command that opened it. */
function* lsofOpenFiles(stdout: string): Generator<{ pid: number; command: string; name: string }> {
  let pid = 0;
  let command = '';
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('c')) command = line.slice(1);
    else if (line.startsWith('n')) yield { pid, command, name: line.slice(1) };
  }
}

/**
 * Whether `tip` is delivered into `base` (`origin/<default>`), by one of two tests and no other:
 *
 * - `ancestor`: `tip` is an ancestor of `base`. A branch with no commit of its own passes it.
 * - `changes-in-default`: a local branch whose `origin/<branch>` tracking ref is absent (it was
 *   never pushed, or its remote branch was deleted and pruned) and for which `git merge-tree
 *   --write-tree base tip` merges cleanly into exactly `base`'s own tree: merging the branch would
 *   change nothing, which is what a squash or direct merge leaves behind. It is a content test, not
 *   proof of provenance: a branch whose changes were also made independently counts. It is
 *   conservative the other way: a change `main` later reverted, or a conflict, reads as undelivered.
 *
 * Both read the local `origin/<default>` ref, which is as old as the last fetch.
 */
function classifyDelivered(
  runner: Runner,
  checkout: string,
  config: RepositoryConfig,
  tip: string,
  branch: string | undefined,
): DeliveredBy {
  const base = `origin/${config.defaultBranch}`;
  if (git(runner, checkout, 'merge-base', '--is-ancestor', tip, base).code === 0) return 'ancestor';
  if (branch === undefined) return 'none';
  const tracking = git(
    runner,
    checkout,
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${branch}`,
  );
  if (tracking.code === 0) return 'none';
  const merged = git(runner, checkout, 'merge-tree', '--write-tree', base, tip);
  const baseTree = git(runner, checkout, 'rev-parse', `${base}^{tree}`);
  if (merged.code !== 0 || baseTree.code !== 0) return 'none';
  return merged.stdout.trim().split('\n')[0] === baseTree.stdout.trim()
    ? 'changes-in-default'
    : 'none';
}

/**
 * Every worktree under the accepted roots (every provider's and `<main checkout>/.claude/worktrees`)
 * with its branch, age, cleanliness, lock, live processes and whether its branch is delivered. The
 * listing changes nothing. With `remove`, it first runs `git fetch --prune origin`, then removes
 * those that are clean, unlocked, without a process, delivered, not the current worktree and not the
 * main checkout, through `removeWorktree` (which checks each again) with `keepRemote`, so a bulk
 * removal never deletes a remote branch.
 */
export function staleWorktrees(
  options: StaleOptions,
  partial: Partial<WorktreeDependencies> = {},
): StaleResult {
  const { runner, checkout } = resolveDependencies(partial);
  const config = loadRepositoryConfig(options.configPath);
  const roots = acceptedRoots(config, checkout, undefined);
  if (options.remove) {
    const fetched = git(runner, checkout, 'fetch', '--prune', 'origin');
    if (fetched.code !== 0) throw failure('git fetch --prune origin', fetched);
  }
  const listing = git(runner, checkout, 'worktree', 'list', '--porcelain');
  if (listing.code !== 0) throw failure('git worktree list', listing);
  const here = realpath(options.currentDirectory ?? process.cwd());
  const candidates = parseWorktreeList(listing.stdout).filter(
    (entry) =>
      !entry.bare &&
      realpath(entry.path) !== realpath(checkout) &&
      roots.some((root) => isUnder(root, realpath(entry.path))),
  );

  // One `lsof` for the host, for working directories only, rather than one per worktree: a
  // directory scan of each worktree's `node_modules` takes minutes across hundreds of them, and a
  // host-wide listing of every open file about twenty seconds on a loaded host. `remove` re-checks
  // each candidate for open files with its own `+D` scan.
  const open = runner(['lsof', '-w', '-a', '-d', 'cwd', '-F', 'pcn']);
  const probed = open.code === 0 || open.stdout.trim() !== '';
  const holders = new Map<string, Set<number>>();
  if (probed) {
    const resolved = candidates.map((entry) => ({ entry, root: realpath(entry.path) }));
    for (const file of lsofOpenFiles(open.stdout)) {
      if (file.pid === process.pid) continue;
      for (const { entry, root } of resolved) {
        if (file.name === root || file.name.startsWith(root + sep)) {
          holders.set(entry.path, (holders.get(entry.path) ?? new Set()).add(file.pid));
          break;
        }
      }
    }
  }

  const now = Date.now();
  const entries = candidates.map((entry): StaleEntry => {
    const root = realpath(entry.path);
    const branch = entry.branch?.replace(/^refs\/heads\//, '');
    const date = git(runner, entry.path, 'log', '-1', '--format=%cI').stdout.trim();
    const status = git(runner, entry.path, 'status', '--porcelain');
    const deliveredBy =
      entry.head === undefined
        ? 'none'
        : classifyDelivered(runner, checkout, config, entry.head, branch);
    const stale: StaleEntry = {
      path: entry.path,
      branch,
      tip: entry.head,
      lastCommit: date === '' ? undefined : date,
      ageDays:
        date === '' || Number.isNaN(Date.parse(date))
          ? undefined
          : Math.floor((now - Date.parse(date)) / 86_400_000),
      clean: status.code === 0 ? status.stdout.trim() === '' : undefined,
      locked: entry.locked,
      processes: probed ? (holders.get(entry.path)?.size ?? 0) : undefined,
      delivered: deliveredBy !== 'none',
      deliveredBy,
      current: here === root || here.startsWith(root + sep),
      keep: [],
    };
    if (stale.current) stale.keep.push('it is the worktree this command runs from');
    if (stale.locked) stale.keep.push('locked');
    if (stale.clean === undefined) stale.keep.push('git status failed');
    else if (!stale.clean) stale.keep.push('uncommitted or untracked changes');
    // A worktree whose branch was squash-merged is finished, and `--remove` ends what is left
    // running inside it. One whose tip is a commit of the default branch looks the same as one a
    // session has just created, so its processes keep it.
    if (stale.processes === undefined) stale.keep.push('processes could not be checked');
    else if (stale.processes > 0 && deliveredBy !== 'changes-in-default') {
      stale.keep.push(
        `${stale.processes} live process(es), and its tip is a commit of ${config.defaultBranch}, as a worktree a session has just created is`,
      );
    }
    if (!stale.delivered) stale.keep.push('branch not delivered');
    if (branch === config.defaultBranch) stale.keep.push('default branch checked out');
    return stale;
  });

  const result: StaleResult = { entries, removed: [], refused: [] };
  if (!options.remove) return result;
  for (const entry of entries.filter((item) => item.keep.length === 0)) {
    try {
      const removed = removeWorktree(
        {
          configPath: options.configPath,
          name: entry.path,
          keepRemote: true,
          deliveredTip: entry.tip,
          deliveredBranch: entry.branch,
          // Never for a tip on the default branch: a session may have started there since the
          // listing, and the removal then refuses for its processes instead.
          endProcesses: entry.deliveredBy === 'changes-in-default',
        },
        partial,
      );
      result.removed.push({
        path: removed.path,
        branch: removed.branch,
        ended: removed.ended.length,
      });
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      result.refused.push({ path: entry.path, reason: error.message });
    }
  }
  return result;
}

export function renderStale(result: StaleResult, remove: boolean): string {
  const lines = result.entries.map((entry) => {
    const facts = [
      entry.branch ?? '(detached)',
      entry.ageDays === undefined ? 'age unknown' : `${entry.ageDays}d`,
      entry.clean === undefined ? 'status unknown' : entry.clean ? 'clean' : 'dirty',
      entry.locked ? 'locked' : 'unlocked',
      entry.processes === undefined ? 'processes unknown' : `${entry.processes} process(es)`,
      entry.delivered ? `delivered (${entry.deliveredBy})` : 'not delivered',
    ].join(', ');
    const outcome =
      entry.keep.length === 0
        ? remove
          ? ''
          : ' -> removable'
        : ` -> kept: ${entry.keep.join('; ')}`;
    return `${entry.path}: ${facts}${outcome}`;
  });
  const removable = result.entries.filter((entry) => entry.keep.length === 0).length;
  lines.push(
    `${result.entries.length} worktree(s): ${result.entries.filter((entry) => entry.delivered).length} delivered, ${removable} removable, ${result.entries.filter((entry) => entry.locked).length} locked`,
  );
  if (remove) {
    for (const item of result.removed)
      lines.push(
        `removed ${item.path}${item.branch === undefined ? '' : ` (${item.branch})`}${item.ended === 0 ? '' : `, ended ${item.ended} process(es) left inside it`}`,
      );
    for (const item of result.refused) lines.push(`kept ${item.path}: ${item.reason}`);
    lines.push(
      `removed ${result.removed.length}, kept ${result.entries.length - result.removed.length}`,
    );
  }
  return lines.join('\n');
}

export function run(
  argv: string[],
  dependencies: Partial<WorktreeDependencies> = {},
): { code: number; output: string } {
  const [command, ...rest] = argv;
  if (command !== 'create' && command !== 'remove' && command !== 'stale')
    throw new UsageError('Usage: worktree.ts create|remove|stale ...');
  const parsed = parseOptions(rest, {
    values: ['config', 'provider', 'name', 'branch', 'base', 'install-log'],
    flags: ['keep-remote', 'retired', 'json', 'remove'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const json = parsed.flags.has('json');
  const configPath = parsed.values['config'] ?? DEFAULT_CONFIGURATION_PATH;
  if (command === 'stale') {
    for (const option of ['provider', 'name', 'branch', 'base', 'install-log'])
      if (parsed.values[option] !== undefined)
        throw new UsageError(`--${option} does not apply to stale.`);
    const remove = parsed.flags.has('remove');
    try {
      const result = staleWorktrees({ configPath, remove }, dependencies);
      return { code: 0, output: json ? JSON.stringify(result) : renderStale(result, remove) };
    } catch (error) {
      if (error instanceof Refusal)
        return {
          code: 1,
          output: json ? JSON.stringify({ ok: false, error: error.message }) : error.message,
        };
      throw error;
    }
  }
  if (parsed.flags.has('remove')) throw new UsageError('--remove applies only to stale.');
  const provider = parsed.values['provider'];
  const name = requireOption(parsed, 'name');
  try {
    if (command === 'create') {
      const result = createWorktree(
        {
          configPath,
          provider: requireOption(parsed, 'provider'),
          name,
          branch: requireOption(parsed, 'branch'),
          base: parsed.values['base'],
          installLog: parsed.values['install-log'],
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
