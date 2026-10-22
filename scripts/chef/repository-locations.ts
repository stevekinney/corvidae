#!/usr/bin/env bun
// Chef repository locations: where the current worktree and the main checkout are, asked of Git
// rather than written into a configuration file, so the same scripts work for every teammate and
// every worktree. The main checkout matters because a worktree's own `tmp/` and `.env` disappear
// with the worktree, while the main checkout's survive: run notes, the Jev decision record and the
// shared `.env` all live there.
//
// This module is a library; it has no command line.

import { basename, dirname } from 'node:path';
import { defaultRunner, type Runner, UsageError } from './process-runner.ts';

function gitOutput(runner: Runner, cwd: string, args: string[]): string {
  const result = runner(['git', ...args], { cwd });
  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n').slice(-1)[0] ?? '';
    throw new UsageError(`git ${args.join(' ')} failed in ${cwd} (exit ${result.code}): ${detail}`);
  }
  return result.stdout.trim();
}

/**
 * The main checkout: the parent of `git rev-parse --path-format=absolute --git-common-dir`, which
 * is the same from the main checkout and from every linked worktree. A bare repository has no
 * checkout to return, so it is a `UsageError`.
 */
export function resolveMainCheckout(runner: Runner = defaultRunner, cwd = process.cwd()): string {
  const commonDirectory = gitOutput(runner, cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (basename(commonDirectory) !== '.git')
    throw new UsageError(`${commonDirectory} is not a .git directory, so it has no main checkout.`);
  return dirname(commonDirectory);
}

/** The root of the worktree that contains `cwd`. */
export function resolveWorktreeRoot(runner: Runner = defaultRunner, cwd = process.cwd()): string {
  return gitOutput(runner, cwd, ['rev-parse', '--show-toplevel']);
}
