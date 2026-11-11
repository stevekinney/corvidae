#!/usr/bin/env bun
// Chef revert check: does a branch set any file back to the state it had before a recent commit on
// the base touched it? A worker that rebuilt its branch with `git reset --soft` onto a newer `main`,
// or restored a whole tree from an older commit, silently undoes merged work (2026-11-10: one
// worker reverted two merged pull requests that way). Run it before every push; the delivery
// path runs it again before a direct merge.
//
// Usage:
//   bun scripts/chef/revert-check.ts [<head>] [<base>] [--commits <n>] [--since <git date>] [--json]
//
// <head> defaults to HEAD and <base> to origin/main. The comparison point is the merge base of the
// two, so a branch that is merely behind the base is not a revert. For each file the branch changes,
// the last <n> (default 60) commits on the merge base's history since <since> (default "2 days
// ago") that touched it are read; a file whose content at <head> equals its content just before
// one of those commits is reported with the commit it undoes. Only recent commits count, so an
// intended deletion of an old file is not flagged.
//
// Exit codes: 0 no reverts found, 1 reverts found or a Git command failed, 2 invalid CLI usage.

import {
  defaultRunner,
  emitResult,
  parseOptions,
  type Runner,
  UsageError,
} from './process-runner.ts';

export { UsageError };

export interface RevertFinding {
  file: string;
  /** The base commit whose change the head undoes, abbreviated, with its subject. */
  undoes: string;
}

export interface RevertCheckOptions {
  head: string;
  base: string;
  commits?: number | undefined;
  since?: string | undefined;
  cwd?: string | undefined;
}

export interface RevertCheckReport {
  head: string;
  mergeBase: string;
  findings: RevertFinding[];
}

export class RevertCheckError extends Error {}

const ABSENT = 'ABSENT';

/** Run the check. Throws `RevertCheckError` when Git cannot answer. */
export function revertCheck(
  options: RevertCheckOptions,
  runner: Runner = defaultRunner,
): RevertCheckReport {
  const git = (...args: string[]) => runner(['git', ...args], { cwd: options.cwd });
  const required = (...args: string[]): string => {
    const result = git(...args);
    if (result.code !== 0)
      throw new RevertCheckError(
        `git ${args.join(' ')} failed: ${result.stderr.trim().split('\n')[0] ?? ''}`,
      );
    return result.stdout.trim();
  };
  /** The blob of `path` at `revision`, or `ABSENT` when the file does not exist there. */
  const blob = (revision: string, path: string): string => {
    const result = git('rev-parse', '-q', '--verify', `${revision}:${path}`);
    return result.code === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : ABSENT;
  };

  const mergeBase = required('merge-base', options.head, options.base);
  const files = required('diff', '--name-only', mergeBase, options.head)
    .split('\n')
    .filter((line) => line !== '');
  const findings: RevertFinding[] = [];
  for (const file of files) {
    const next = blob(options.head, file);
    if (next === blob(mergeBase, file)) continue;
    const touching = required(
      'log',
      '-n',
      String(options.commits ?? 60),
      `--since=${options.since ?? '2 days ago'}`,
      '--format=%H',
      mergeBase,
      '--',
      file,
    )
      .split('\n')
      .filter((line) => line !== '');
    for (const commit of touching) {
      if (blob(`${commit}^`, file) !== next) continue;
      findings.push({ file, undoes: required('log', '-1', '--format=%h %s', commit).slice(0, 80) });
      break;
    }
  }
  return { head: options.head, mergeBase, findings };
}

export function renderRevertCheck(report: RevertCheckReport): string {
  if (report.findings.length === 0) return 'no reverts found';
  return report.findings
    .map((finding) => `REVERT ${finding.file} undoes ${finding.undoes}`)
    .join('\n');
}

export function run(
  argv: string[],
  runner: Runner = defaultRunner,
): { code: number; output: string } {
  const parsed = parseOptions(argv, { values: ['commits', 'since'], flags: ['json'] });
  if (parsed.positionals.length > 2)
    throw new UsageError(`Unexpected argument ${parsed.positionals[2]}.`);
  const commits = parsed.values['commits'];
  if (commits !== undefined && !/^[1-9]\d*$/.test(commits))
    throw new UsageError(`--commits "${commits}" is not a positive number.`);
  const json = parsed.flags.has('json');
  try {
    const report = revertCheck(
      {
        head: parsed.positionals[0] ?? 'HEAD',
        base: parsed.positionals[1] ?? 'origin/main',
        commits: commits === undefined ? undefined : Number(commits),
        since: parsed.values['since'],
      },
      runner,
    );
    return {
      code: report.findings.length === 0 ? 0 : 1,
      output: json ? JSON.stringify(report) : renderRevertCheck(report),
    };
  } catch (error) {
    if (!(error instanceof RevertCheckError)) throw error;
    return { code: 1, output: json ? JSON.stringify({ error: error.message }) : error.message };
  }
}

if (import.meta.main) {
  try {
    const result = run(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), result);
    process.exitCode = result.code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
