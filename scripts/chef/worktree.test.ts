import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner } from './process-runner.ts';
import { branchOwner, createWorktree, parseWorktreeList, Refusal } from './worktree.ts';

describe('parseWorktreeList', () => {
  const listing = [
    'worktree /repo with space',
    'HEAD aaaa',
    'branch refs/heads/main',
    '',
    'worktree /roots/detached',
    'HEAD bbbb',
    'detached',
    '',
    'worktree /roots/feature',
    'HEAD cccc',
    'branch refs/heads/feature/x',
    '',
  ].join('\n');

  test('pairs each branch line with the worktree line of its own block', () => {
    const entries = parseWorktreeList(listing);
    expect(entries.map((entry) => entry.path)).toEqual([
      '/repo with space',
      '/roots/detached',
      '/roots/feature',
    ]);
    expect(entries[1]?.detached).toBe(true);
    expect(entries[1]?.branch).toBeUndefined();
    expect(branchOwner(entries, 'main')?.path).toBe('/repo with space');
    expect(branchOwner(entries, 'feature/x')?.path).toBe('/roots/feature');
    expect(branchOwner(entries, 'absent')).toBeUndefined();
  });

  test("a detached block does not lend its neighbour's branch to the wrong path", () => {
    const entries = parseWorktreeList(
      [
        'worktree /a',
        'HEAD 1',
        'detached',
        '',
        'worktree /b',
        'HEAD 2',
        'branch refs/heads/main',
        '',
      ].join('\n'),
    );
    expect(branchOwner(entries, 'main')?.path).toBe('/b');
  });
});

describe('createWorktree with a fake runner', () => {
  const owned = [
    'worktree /home/dev/corvidae',
    'HEAD aaaa',
    'branch refs/heads/main',
    '',
    'worktree /home/dev/other',
    'HEAD bbbb',
    'branch refs/heads/feature/x',
    '',
  ].join('\n');

  function withConfiguration<T>(body: (configPath: string) => T): T {
    const directory = mkdtempSync(join(tmpdir(), 'worktree-fast-'));
    try {
      const configPath = join(directory, 'config.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          repository: 'o/n',
          defaultBranch: 'main',
          worktreeRoots: { claude: join(directory, 'claude'), codex: join(directory, 'codex') },
          manifestName: 'demo',
          installCommand: 'true',
          gateCommand: 'true',
          affectedCheckCommand: 'true',
          mergeMethod: 'squash',
        }),
      );
      return body(configPath);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  test('resolves the main checkout from git and runs the ownership preflight there', () => {
    const calls: { command: string[]; cwd: string | undefined }[] = [];
    const runner: Runner = (command, options) => {
      calls.push({ command, cwd: options?.cwd });
      if (command.includes('--git-common-dir'))
        return { code: 0, stdout: '/home/dev/corvidae/.git\n', stderr: '' };
      return { code: 0, stdout: owned, stderr: '' };
    };
    withConfiguration((configPath) => {
      const attempt = () =>
        createWorktree(
          { configPath, provider: 'claude', name: 'copy', branch: 'main' },
          { runner },
        );
      expect(attempt).toThrow(Refusal);
      expect(attempt).toThrow('which /home/dev/corvidae already owns');
    });
    expect(calls[0]?.command).toEqual([
      'git',
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    const listing = calls.find((call) => call.command.includes('worktree'));
    expect(listing?.cwd).toBe('/home/dev/corvidae');
    // Refused before any fetch or add.
    expect(calls.some((call) => call.command.includes('fetch'))).toBe(false);
    expect(calls.some((call) => call.command.includes('add'))).toBe(false);
  });

  test('an injected checkout skips the lookup', () => {
    const calls: string[][] = [];
    const runner: Runner = (command) => {
      calls.push(command);
      return { code: 0, stdout: owned, stderr: '' };
    };
    withConfiguration((configPath) => {
      expect(() =>
        createWorktree(
          { configPath, provider: 'claude', name: 'copy', branch: 'main' },
          { runner, checkout: '/injected' },
        ),
      ).toThrow(Refusal);
    });
    expect(calls.some((command) => command.includes('--git-common-dir'))).toBe(false);
  });
});
