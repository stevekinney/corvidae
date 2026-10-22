import { describe, expect, test } from 'bun:test';
import { type Runner, UsageError } from './process-runner.ts';
import { resolveMainCheckout, resolveWorktreeRoot } from './repository-locations.ts';

function fake(code: number, stdout: string, stderr = ''): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: (command) => {
      calls.push(command);
      return { code, stdout, stderr };
    },
  };
}

describe('resolveMainCheckout', () => {
  test('is the parent of the absolute git common directory, asked of git in the given directory', () => {
    const { runner, calls } = fake(0, '/home/dev/corvidae/.git\n');
    expect(resolveMainCheckout(runner, '/home/dev/worktrees/a')).toBe('/home/dev/corvidae');
    expect(calls).toEqual([['git', 'rev-parse', '--path-format=absolute', '--git-common-dir']]);
  });

  test('refuses a bare repository and a failing git, naming the cause', () => {
    expect(() => resolveMainCheckout(fake(0, '/srv/corvidae.git\n').runner, '/x')).toThrow(
      UsageError,
    );
    expect(() =>
      resolveMainCheckout(fake(128, '', 'fatal: not a git repository').runner, '/x'),
    ).toThrow('not a git repository');
  });
});

describe('resolveWorktreeRoot', () => {
  test('is git show-toplevel', () => {
    const { runner, calls } = fake(0, '/home/dev/worktrees/a\n');
    expect(resolveWorktreeRoot(runner, '/home/dev/worktrees/a/src')).toBe('/home/dev/worktrees/a');
    expect(calls).toEqual([['git', 'rev-parse', '--show-toplevel']]);
  });
});
