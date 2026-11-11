#!/usr/bin/env bun
// Chef text guards: run the root `lint:guards` script, one guard per process, on the exact tree of
// one commit, for `direct-merge.ts`.
//
// The guards run in a detached Git worktree of the commit, not in an extracted archive. An archive
// has no `.git`, and two guards need one: `check-plugin-identities` resolves `origin/main` as its
// baseline and fails when it cannot, and `check-load-sensitive-deadlines` reads its allowlist
// ratchet's baseline with `git show origin/main:...` and passes without checking when there is none.
// A linked worktree shares the repository's object store and remote-tracking refs, so both resolve
// `origin/main` exactly as they do in a normal checkout. Every guard finds its root from its own
// file's location (`import.meta.dir`), so each one checks the tree it is in.
//
// The worktree is always removed afterwards (`git worktree remove --force`, then the directory); a
// removal that fails is a failure of the step, named, because a leaked worktree is a defect and
// nothing irreversible has happened yet.
//
// Each guard is its own process, in the order `lint:guards` lists them, and every one runs even
// after a failure: the failing guard is known from which process exited non-zero, never from
// parsed text, and a failure can be called the base's own only once every failing guard is
// accounted for. The list is read from the `package.json` of the tree under test, so `lint:guards`
// stays the single source and a branch that adds a guard is held to it. A guard that fails on the
// tree is compared with the same guard on the base (`alreadyFailingOnBase`); only a finding the
// base lacks is the change's own.
//
// This module is a library; it has no command line.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { workspaceParentDirectories } from '../workspace-directories.ts';
import type { Runner, RunnerResult } from './process-runner.ts';

/** One guard of `lint:guards`. */
export interface GuardCommand {
  /** `check-<name>`, the script's file name without its extension. */
  name: string;
  command: string[];
}

/** One guard that failed, or a problem that kept the guards from running (`lint:guards`, `worktree`). */
export interface GuardFailure {
  guard: string;
  /** The normalized non-blank output lines: file path, line and message of each finding. */
  findings: string[];
  /** A short excerpt of the failure for the report. */
  output: string;
}

/** The outcome of the text guards on one tree. */
export interface GuardsResult {
  ok: boolean;
  /** Every guard that failed, in `lint:guards` order. Empty exactly when `ok`. */
  failures: GuardFailure[];
}

/** The pseudo-guard that names a failure to get the guards running at all. */
export const GUARD_SETUP = 'lint:guards';
/** The pseudo-guard that names a temporary worktree that could not be removed. */
export const GUARD_CLEANUP = 'worktree';

const GUARD_SEGMENT = /^bun (scripts\/check-[a-z0-9-]+\.ts)$/;

/**
 * The guards in `lint:guards` of a root `package.json`, or the reason the script cannot be read.
 * A segment that is not `bun scripts/check-*.ts` is an error, never skipped, so a guard cannot drop
 * out of the gate unnoticed.
 */
export function parseGuardList(packageJson: string): GuardCommand[] | string {
  let script: unknown;
  try {
    script = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts?.[
      'lint:guards'
    ];
  } catch {
    return 'package.json is not valid JSON';
  }
  if (typeof script !== 'string' || script.trim() === '')
    return 'package.json has no "lint:guards" script';
  const commands: GuardCommand[] = [];
  for (const segment of script.split('&&').map((part) => part.trim())) {
    const matched = GUARD_SEGMENT.exec(segment);
    if (matched?.[1] === undefined)
      return `"lint:guards" holds "${segment}", which is not "bun scripts/check-<name>.ts"`;
    commands.push({ name: basename(matched[1], '.ts'), command: ['bun', matched[1]] });
  }
  return commands;
}

/**
 * The findings in a guard's output: every non-blank line of standard output and standard error,
 * trimmed, with whitespace collapsed and `root` replaced so two runs in different directories agree.
 * The guards disagree about where findings go (most indent them under a prose header on standard
 * error, `check-tool-result-payload-reads` and `check-plugin-identities` print them unindented,
 * `check-hidden-labels` puts one on standard output), so no line is picked by its shape. The header
 * is the same text on every tree, which a subset comparison absorbs.
 */
export function findingsOf(result: RunnerResult, root: string): string[] {
  const lines = `${result.stdout}\n${result.stderr}`
    .split(root)
    .join('<root>')
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line !== '');
  return [...new Set(lines)];
}

/** The first lines of a failure, for the report. */
function excerpt(findings: string[]): string {
  return findings.slice(0, 3).join(' | ').slice(0, 300);
}

function setupFailure(output: string): GuardsResult {
  return { ok: false, failures: [{ guard: GUARD_SETUP, findings: [], output }] };
}

/**
 * Link each `node_modules` the source checkout has (the root's and every workspace's) into the same
 * place in `tree`, so the guards that import a plugin or `typescript` do not install anything. A
 * workspace link resolves through the source checkout's `packages/`, as it does in that checkout.
 */
export function linkNodeModules(source: string, tree: string): string[] {
  const directories = ['.', 'scripts/browser-fixtures'];
  for (const parent of workspaceParentDirectories) {
    if (!existsSync(join(source, parent))) continue;
    for (const child of readdirSync(join(source, parent))) directories.push(`${parent}/${child}`);
  }
  const links: string[] = [];
  for (const directory of directories) {
    const target = join(source, directory, 'node_modules');
    const link = join(tree, directory, 'node_modules');
    if (!existsSync(target) || !existsSync(join(tree, directory)) || existsSync(link)) continue;
    symlinkSync(target, link, 'dir');
    links.push(link);
  }
  return links;
}

/** Run each guard of the tree's `lint:guards` as its own process in `tree`. */
function runGuardsIn(runner: Runner, tree: string, only?: readonly string[]): GuardsResult {
  let guards: GuardCommand[] | string;
  try {
    guards = parseGuardList(readFileSync(join(tree, 'package.json'), 'utf8'));
  } catch (error) {
    guards = `package.json cannot be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (typeof guards === 'string') return setupFailure(guards);
  const failures: GuardFailure[] = [];
  for (const guard of guards) {
    if (only !== undefined && !only.includes(guard.name)) continue;
    const outcome = runner(guard.command, { cwd: tree });
    if (outcome.code === 0) continue;
    const findings = findingsOf(outcome, tree);
    failures.push({ guard: guard.name, findings, output: excerpt(findings) });
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Run the guards of `lint:guards` on the tree of `revision`, in a detached worktree of `worktree`'s
 * repository. `only` limits the run to the named guards (the comparison against the base needs only
 * the ones that failed on the branch).
 */
export function runTextGuards(
  runner: Runner,
  worktree: string,
  revision: string,
  only?: readonly string[],
): GuardsResult {
  const parent = mkdtempSync(join(tmpdir(), 'direct-merge-guards-'));
  const tree = join(parent, 'tree');
  let added = false;
  let links: string[] = [];
  let leftover: string | null = null;
  let result: GuardsResult;
  try {
    mkdirSync(tree);
    const created = runner(['git', 'worktree', 'add', '--detach', tree, revision], {
      cwd: worktree,
    });
    if (created.code !== 0) {
      result = setupFailure(
        `git worktree add for ${revision.slice(0, 12)} failed (exit ${created.code}): ${excerpt(findingsOf(created, tree))}`,
      );
    } else {
      added = true;
      links = linkNodeModules(worktree, tree);
      result = runGuardsIn(runner, tree, only);
    }
  } finally {
    for (const link of links) unlinkSync(link);
    if (added) {
      const removed = runner(['git', 'worktree', 'remove', '--force', tree], { cwd: worktree });
      if (removed.code !== 0) {
        leftover = `git worktree remove --force ${tree} failed (exit ${removed.code}): ${excerpt(findingsOf(removed, tree))}`;
        runner(['git', 'worktree', 'prune'], { cwd: worktree });
      }
    }
    rmSync(parent, { recursive: true, force: true });
  }
  if (leftover === null) return result;
  return {
    ok: false,
    failures: [...result.failures, { guard: GUARD_CLEANUP, findings: [], output: leftover }],
  };
}

/** A guard that fails on the base and, on the change's tree, with nothing the base lacks. */
export interface AlreadyFailingGuard {
  guard: string;
  /** How many output lines of the guard's failure on the change's tree the base's run also holds. */
  findings: number;
}

/**
 * Whether every guard that failed on a change's tree fails no worse on the base: it must also fail
 * on the base, with findings (so a guard that fails with no output cannot match) that are a subset
 * of the base's. Returns each such guard with its matched finding count, or `null` when a failure is
 * the change's own: a finding the base does not have, a guard the base passes, or a run that could
 * not be compared.
 */
export function alreadyFailingOnBase(
  change: GuardsResult,
  base: GuardsResult,
): AlreadyFailingGuard[] | null {
  // A base run that could not clean up after itself is not a reliable comparison.
  if (change.failures.length === 0 || base.failures.some((one) => one.guard === GUARD_CLEANUP))
    return null;
  const matched: AlreadyFailingGuard[] = [];
  for (const failure of change.failures) {
    const onBase = base.failures.find((candidate) => candidate.guard === failure.guard);
    if (onBase === undefined || failure.findings.length === 0) return null;
    const known = new Set(onBase.findings);
    if (!failure.findings.every((finding) => known.has(finding))) return null;
    matched.push({ guard: failure.guard, findings: failure.findings.length });
  }
  return matched;
}
