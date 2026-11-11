import { describe, expect, test } from 'bun:test';
import type { Runner, RunnerResult } from './process-runner.ts';
import { renderRevertCheck, revertCheck, run, UsageError } from './revert-check.ts';

const ok = (stdout: string): RunnerResult => ({ code: 0, stdout, stderr: '' });
const missing: RunnerResult = { code: 1, stdout: '', stderr: '' };

/**
 * A scripted Git: `base` is the merge base; `a.ts` was changed on `main` by commit `m1` (blob
 * `old-a` before it, `new-a` after), and the head sets it back to `old-a`; `b.ts` is a real change.
 */
function scriptedGit(blobs: Record<string, string>, calls: string[][] = []): Runner {
  return (command) => {
    calls.push(command);
    const args = command.slice(1);
    const key = args.join(' ');
    if (args[0] === 'merge-base') return ok('base\n');
    if (key === 'diff --name-only base HEAD') return ok('a.ts\nb.ts\n');
    if (args[0] === 'rev-parse') {
      const blob = blobs[args.at(-1) ?? ''];
      return blob === undefined ? missing : ok(`${blob}\n`);
    }
    if (args[0] === 'log' && args[1] === '-1')
      return ok(`${args.at(-1)?.slice(0, 7)} Merged work\n`);
    if (args[0] === 'log') return ok(args.at(-1) === 'a.ts' ? 'm1\n' : 'm2\n');
    return { code: 128, stdout: '', stderr: `unexpected git ${key}` };
  };
}

const reverting = {
  'HEAD:a.ts': 'old-a',
  'base:a.ts': 'new-a',
  'm1^:a.ts': 'old-a',
  'HEAD:b.ts': 'mine-b',
  'base:b.ts': 'main-b',
  'm2^:b.ts': 'older-b',
};

describe('revertCheck', () => {
  test('reports a file the head sets back to its state before a recent base commit', () => {
    const report = revertCheck({ head: 'HEAD', base: 'origin/main' }, scriptedGit(reverting));
    expect(report.mergeBase).toBe('base');
    expect(report.findings).toEqual([{ file: 'a.ts', undoes: 'm1 Merged work' }]);
    expect(renderRevertCheck(report)).toBe('REVERT a.ts undoes m1 Merged work');
  });

  test('passes a branch whose changes undo nothing', () => {
    const report = revertCheck(
      { head: 'HEAD', base: 'origin/main' },
      scriptedGit({ ...reverting, 'HEAD:a.ts': 'mine-a' }),
    );
    expect(report.findings).toEqual([]);
    expect(renderRevertCheck(report)).toBe('no reverts found');
  });

  test('flags a deleted file that a recent base commit created', () => {
    const { 'HEAD:a.ts': _, 'm1^:a.ts': __, ...blobs } = reverting;
    const report = revertCheck({ head: 'HEAD', base: 'origin/main' }, scriptedGit(blobs));
    expect(report.findings.map((finding) => finding.file)).toEqual(['a.ts']);
  });

  test('compares against the merge base and reads only recent base commits', () => {
    const calls: string[][] = [];
    revertCheck(
      { head: 'HEAD', base: 'origin/main', commits: 5, since: '1 day ago' },
      scriptedGit(reverting, calls),
    );
    expect(calls[0]).toEqual(['git', 'merge-base', 'HEAD', 'origin/main']);
    expect(calls).toContainEqual([
      'git',
      'log',
      '-n',
      '5',
      '--since=1 day ago',
      '--format=%H',
      'base',
      '--',
      'a.ts',
    ]);
  });
});

describe('run', () => {
  test('exits 1 on a revert and 0 without one, defaulting to HEAD against origin/main', () => {
    expect(run([], scriptedGit(reverting))).toEqual({
      code: 1,
      output: 'REVERT a.ts undoes m1 Merged work',
    });
    expect(run(['HEAD', 'origin/main'], scriptedGit({ ...reverting, 'HEAD:a.ts': 'x' }))).toEqual({
      code: 0,
      output: 'no reverts found',
    });
  });

  test('reports a Git failure as exit 1 and bad usage as a UsageError', () => {
    const broken: Runner = () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' });
    expect(run(['--json'], broken)).toEqual({
      code: 1,
      output: JSON.stringify({
        error: 'git merge-base HEAD origin/main failed: fatal: not a git repository',
      }),
    });
    expect(() => run(['--commits', '0'], broken)).toThrow(UsageError);
    expect(() => run(['a', 'b', 'c'], broken)).toThrow(UsageError);
  });
});
